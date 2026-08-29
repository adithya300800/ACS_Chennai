const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { generateULID, generateUploadSASUrl, generateReadSASUrl, verifyBlobExists, CONTENT_TYPE_EXT } = require('../lib/blobStorage');
const { mapPrismaError, parseStrictISODate, parseISODateTime } = require('../lib/errors');
const { hashIdentifier } = require('../lib/pii');

// Tiny asyncHandler so unhandled rejections in async route handlers reach
// the global error handler instead of hanging the request or crashing the
// process. Express 4 doesn't auto-catch async errors without it. We can't
// add express-async-errors as a dep in this round, so this local wrapper
// does the same job for the routes we touch.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// In-memory pending uploads (ulid -> { employeeId, container, filename })
const pendingUploads = new Map();

// SSE connections per employee
const sseConnections = new Map(); // employeeId -> Set<{res, lastNotificationId}>

// SSE ticket store — replaces the previous ?token= query-string auth.
// JWTs in URLs are dangerous because they end up in proxy/CDN access logs,
// browser history, and server-side request logs (AppSec #9). Instead the
// client first calls POST /api/dpr/notifications/ticket (authenticated via
// Bearer header), receives a short-lived opaque ticket, then opens the SSE
// stream with ?ticket=... — proxies only ever see the ticket.
const sseTickets = new Map(); // ticket -> { employeeId, expiresAt }
const TICKET_TTL_MS = 60 * 1000; // 60 seconds — enough for the EventSource to connect

function pruneTickets() {
  const now = Date.now();
  for (const [k, v] of sseTickets.entries()) {
    if (v.expiresAt <= now) sseTickets.delete(k);
  }
}
function createTicket(employeeId) {
  pruneTickets();
  const ticket = crypto.randomBytes(32).toString('base64url');
  sseTickets.set(ticket, { employeeId, expiresAt: Date.now() + TICKET_TTL_MS });
  // Auto-expire after TTL
  setTimeout(() => sseTickets.delete(ticket), TICKET_TTL_MS).unref();
  return ticket;
}

// POST /api/dpr/notifications/ticket — must be authenticated via Bearer header.
// Returns a single-use 60-second ticket for opening an SSE stream.
router.post('/notifications/ticket', requireAuth, (req, res) => {
  const ticket = createTicket(req.employeeId);
  res.json({ ticket, expiresIn: TICKET_TTL_MS / 1000 });
});

// SSE /notifications route — auth via ticket (preferred) OR legacy ?token=.
// The token path is a temporary fallback for the live frontend bundle which
// hasn't been migrated to the ticket flow yet. It logs a deprecation
// warning on every connect so we know when to drop it.
// TODO(frontend): migrate to ticket pattern, then remove the token branch.
router.get('/notifications', async (req, res) => {
  const { ticket, token, lastNotificationId } = req.query;

  let employeeId = null;

  if (ticket) {
    // Preferred path — opaque ticket from POST /api/dpr/notifications/ticket
    const entry = sseTickets.get(ticket);
    if (!entry || entry.expiresAt <= Date.now()) {
      sseTickets.delete(ticket);
      return res.status(401).json({ error: 'Invalid or expired ticket' });
    }
    // Single-use: delete immediately so the ticket can't be replayed.
    sseTickets.delete(ticket);
    employeeId = entry.employeeId;
  } else if (token) {
    // LEGACY FALLBACK — JWT in URL. Works for the current frontend bundle but
    // leaks JWTs to proxies/CDNs. Will be removed once the frontend migrates.
    console.warn('[sse] legacy ?token= auth used — frontend has not migrated to ticket pattern yet');
    try {
      const jwt = require('jsonwebtoken');
      const { getJwtSecret } = require('../middleware/auth');
      const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
      employeeId = decoded.employeeId;
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  } else {
    return res.status(401).json({ error: 'Ticket or token required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if behind a proxy
  res.flushHeaders();

  // Send initial connection ack
  res.write(`event: connected\ndata: ${JSON.stringify({ connected: true })}\n\n`);

  // Add this connection to the set
  if (!sseConnections.has(employeeId)) {
    sseConnections.set(employeeId, new Set());
  }
  const connection = { res, lastNotificationId: lastNotificationId || '0' };
  sseConnections.get(employeeId).add(connection);

  // Send heartbeat every 30s
  const heartbeat = setInterval(() => {
    try {
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
    } catch (e) {
      // connection closed
    }
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const conns = sseConnections.get(employeeId);
    if (conns) {
      conns.delete(connection);
      if (conns.size === 0) sseConnections.delete(employeeId);
    }
  });
});

// All other routes require auth
router.use(requireAuth);

// Helper: emit SSE event to all connections for an employee
function emitNotification(employeeId, eventName, data) {
  const connections = sseConnections.get(employeeId);
  if (!connections) return;
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const conn of connections) {
    try {
      conn.res.write(payload);
    } catch (e) {
      // Connection may be closed
    }
  }
}

// Helper: get Prisma
function getPrisma(req) {
  return req.app.get('prisma');
}

// ─── POST /api/dpr/sas-url ────────────────────────────────────────────────────
router.post('/sas-url', async (req, res) => {
  const { filename, contentType, container } = req.body;

  if (!filename || !contentType || !container) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'filename, contentType, container required' });
  }

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  const allowedContainers = ['dpr-photos', 'dpr-documents'];

  if (!allowedTypes.includes(contentType)) {
    return res.status(400).json({ error: 'INVALID_CONTENT_TYPE', message: 'Only image/jpeg, image/png, image/webp allowed' });
  }
  if (!allowedContainers.includes(container)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid container' });
  }

  const ulid = generateULID();

  // Generate real SAS URL. Blob is scoped under `${employeeId}/${ulid}.${ext}`
  // so a leaked SAS cannot cross tenants. Extension is derived from validated
  // contentType — NEVER from the user-supplied filename.
  const { sasUrl, blobPath, expiresAt } = await generateUploadSASUrl(
    container,
    req.employeeId,
    ulid,
    contentType
  );

  // Track pending upload for owner-scoped lookup on confirm
  pendingUploads.set(`${req.employeeId}:${ulid}`, {
    employeeId: req.employeeId,
    container,
    filename,
    contentType,
  });

  // Auto-expire pending uploads after 20 min (SAS is 15 min) to bound memory
  setTimeout(() => {
    pendingUploads.delete(`${req.employeeId}:${ulid}`);
  }, 20 * 60 * 1000).unref();

  res.json({ sasUrl, ulid, blobPath, expiresAt });
});

// ─── POST /api/dpr/confirm-upload ──────────────────────────────────────────
router.post('/confirm-upload', async (req, res) => {
  const { ulid, container, filename, contentType, sizeBytes } = req.body;

  if (!ulid || !container || !filename || !contentType || sizeBytes === undefined) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'All fields required' });
  }

  const MAX_PHOTO_SIZE = 10 * 1024 * 1024; // 10 MB
  if (sizeBytes <= 0 || sizeBytes > MAX_PHOTO_SIZE) {
    return res.status(413).json({ error: 'PHOTO_TOO_LARGE', message: `Photo must be 1 byte – ${MAX_PHOTO_SIZE} bytes` });
  }

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowedTypes.includes(contentType)) {
    return res.status(400).json({ error: 'INVALID_CONTENT_TYPE', message: 'Only image/jpeg, image/png, image/webp allowed' });
  }

  const pendingKey = `${req.employeeId}:${ulid}`;
  const pending = pendingUploads.get(pendingKey);
  if (!pending || pending.employeeId !== req.employeeId) {
    return res.status(404).json({ error: 'BLOB_NOT_FOUND', message: 'Upload not found or unauthorized' });
  }

  // Server-side blob verification — derive the same scoped blob name and
  // confirm the bytes actually landed with the claimed size + content-type.
  try {
    const ext = require('../lib/blobStorage').CONTENT_TYPE_EXT[contentType];
    const blobName = `${req.employeeId}/${ulid}.${ext}`;
    const props = await verifyBlobExists(container, blobName);
    if (!props.exists) {
      return res.status(404).json({ error: 'BLOB_NOT_UPLOADED', message: 'Photo bytes not found in storage' });
    }
    if (props.contentType && props.contentType !== contentType) {
      return res.status(400).json({ error: 'CONTENT_TYPE_MISMATCH', message: 'Uploaded content-type does not match request' });
    }
    if (Math.abs((props.contentLength || 0) - sizeBytes) > 1024) {
      // 1 KB tolerance for chunked-upload finalization
      return res.status(400).json({ error: 'SIZE_MISMATCH', message: 'Uploaded size does not match declared size' });
    }
  } catch (err) {
    console.error('Blob verification failed', {
      employeeHash: hashIdentifier(req.employeeId),
      container, ulid,
      errMessage: err.message?.split('\n')[0],
    });
    return res.status(502).json({ error: 'BLOB_VERIFICATION_FAILED', message: 'Could not verify upload' });
  }

  pendingUploads.delete(pendingKey);

  res.json({ verified: true });
});

// ─── POST /api/dpr ────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const prisma = getPrisma(req);
  const {
    projectName, location, reportDate, weather, temperature,
    contractor, workType, notes, workEntries, status, photos = [],
  } = req.body || {};

  // typeof guards (Code Reviewer P1-2): reject non-string types before they
  // reach Prisma where they would cause opaque 500s.
  if (typeof projectName !== 'string' || !projectName.trim() ||
      typeof location !== 'string' || !location.trim() ||
      typeof reportDate !== 'string') {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'projectName, location, reportDate required' });
  }

  // Length caps (P1-3) — keep the database tidy, prevent abuse
  const MAX = { projectName: 200, location: 200, weather: 80, temperature: 20, contractor: 200, notes: 5000 };
  for (const [k, cap] of Object.entries(MAX)) {
    if (req.body[k] != null && typeof req.body[k] === 'string' && req.body[k].length > cap) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: `${k} exceeds ${cap} chars` });
    }
  }

  const validStatuses = ['DRAFT', 'SUBMITTED'];
  if (status !== undefined && !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid status' });
  }

  const validWorkTypes = ['MATERIAL_RECEIPT', 'QUALITY_TESTING', 'SITE_INSPECTION', 'EXCEPTIONS_SAFETY'];
  if (workType !== undefined && !validWorkTypes.includes(workType)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid workType' });
  }

  // Strict date validation (P0-4) — silent rollover for 2026-02-30 etc.
  const dateParsed = parseStrictISODate(reportDate);
  if (!dateParsed.ok) {
    return res.status(400).json({ error: 'INVALID_REPORT_DATE', message: 'reportDate must be a valid YYYY-MM-DD date' });
  }
  const dateUTC = dateParsed.date;

  // Photos validation (P1-5). Server-side enforcement of every constraint
  // that /sas-url already enforces — the POST handler used to trust the
  // client, which is an IDOR vector (P0-2).
  const allowedContainers = ['dpr-photos', 'dpr-documents'];
  if (!Array.isArray(photos) || photos.length > 50) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'photos must be an array (max 50)' });
  }
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    if (!p || typeof p !== 'object') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: `photos[${i}] must be an object` });
    }
    if (typeof p.ulid !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(p.ulid)) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: `photos[${i}].ulid invalid` });
    }
    if (!allowedContainers.includes(p.container)) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: `photos[${i}].container invalid` });
    }
    if (!CONTENT_TYPE_EXT[p.contentType]) {
      return res.status(400).json({ error: 'INVALID_CONTENT_TYPE', message: `photos[${i}].contentType invalid` });
    }
    const sb = Number(p.sizeBytes);
    if (!Number.isFinite(sb) || sb <= 0 || sb > 10 * 1024 * 1024) {
      return res.status(413).json({ error: 'PHOTO_TOO_LARGE', message: `photos[${i}].sizeBytes must be 1..${10 * 1024 * 1024}` });
    }
    if (typeof p.filename !== 'string' || p.filename.length > 255 || p.filename.includes('\0') || p.filename.includes('..')) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: `photos[${i}].filename invalid` });
    }
    if (p.takenAt !== undefined && p.takenAt !== null) {
      const td = parseISODateTime(p.takenAt);
      if (td === null) return res.status(400).json({ error: 'VALIDATION_ERROR', message: `photos[${i}].takenAt invalid` });
    }
  }

  try {
    const dpr = await prisma.dPR.create({
      data: {
        projectName: projectName.trim(),
        location: location.trim(),
        reportDate: dateUTC,
        weather: weather || null,
        temperature: temperature || null,
        contractor: contractor || null,
        workType: workType || 'MATERIAL_RECEIPT',
        notes: notes || null,
        workEntries: workEntries || null,
        status: status || 'DRAFT',
        submittedById: req.employeeId,
        // P2-3: DRAFT saves don't have a submittedAt timestamp
        submittedAt: status === 'SUBMITTED' ? new Date() : null,
        photos: {
          create: photos.map(p => ({
            ulid: p.ulid,
            container: p.container,
            filename: p.filename,
            contentType: p.contentType,
            sizeBytes: p.sizeBytes,
            caption: p.caption || null,
            location: p.location || null,
            takenAt: p.takenAt ? new Date(p.takenAt) : null,
          })),
        },
      },
      include: {
        photos: true,
        submittedBy: { select: { id: true, name: true, email: true } },
      },
    });

    res.status(201).json(dpr);
  } catch (err) {
    // Log the Prisma error code + meta only — never the full request body
    // (P1-7). Then map the error to a meaningful HTTP status (P1-1).
    console.error('DPR create error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      meta: err.meta,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) {
      // Specialize the duplicate message for the DPR case
      if (mapped.code === 'DUPLICATE') {
        return res.status(409).json({
          error: 'DPR already exists for this date',
          code: 'DUPLICATE_DPR',
        });
      }
      return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    }
    res.status(500).json({ error: 'Failed to create DPR', requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
  }
});

// ─── GET /api/dpr ─────────────────────────────────────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { cursor, limit = '20', status: statusFilter, from, to, my } = req.query;

  const take = Math.min(parseInt(limit) || 20, 100);

  // Validate cursor: base64(reportDate|id). Reject malformed cursors instead
  // of letting `new Date('garbage')` produce Invalid Date and crash the query.
  let cursorWhere = {};
  if (cursor) {
    try {
      const decoded = Buffer.from(cursor, 'base64').toString();
      const [cDate, cId] = decoded.split('|');
      const dp = parseStrictISODate(cDate);
      if (!cId || !dp.ok) {
        return res.status(400).json({ error: 'INVALID_CURSOR', message: 'Cursor is malformed or expired' });
      }
      cursorWhere = {
        OR: [
          { reportDate: { lt: dp.date } },
          { reportDate: dp.date, id: { lt: cId } },
        ],
      };
    } catch (e) {
      return res.status(400).json({ error: 'INVALID_CURSOR', message: 'Cursor could not be decoded' });
    }
  }

  // Validate date-range filters (used by frontend list UI). Accept either
  // YYYY-MM-DD (parsed as a date) or a full ISO timestamp.
  const dateFilter = {};
  const parseFilterDate = (v) => {
    if (!v) return null;
    // Try strict YYYY-MM-DD first
    const strict = parseStrictISODate(v);
    if (strict.ok) return strict.date;
    // Fall back to full ISO datetime
    const dt = new Date(v);
    return isNaN(dt.getTime()) ? null : dt;
  };
  if (from) {
    const d = parseFilterDate(from);
    if (!d) return res.status(400).json({ error: 'INVALID_FROM', message: 'from must be a valid ISO date' });
    dateFilter.gte = d;
  }
  if (to) {
    const d = parseFilterDate(to);
    if (!d) return res.status(400).json({ error: 'INVALID_TO', message: 'to must be a valid ISO date' });
    dateFilter.lte = d;
  }

  try {
    // Check if admin (moved inside try/catch so DB errors here don't become
    // unhandled rejections — Code Reviewer P0-2).
    const employee = await prisma.employee.findUnique({ where: { id: req.employeeId } });
    const isAdmin = employee && employee.isAdmin;

    // `my=true` forces ownership filter even for admins; otherwise non-admins
    // are always restricted to their own DPRs.
    const restrictToSelf = !isAdmin || my === 'true';

    const where = {
      ...(restrictToSelf ? { submittedById: req.employeeId } : {}),
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(Object.keys(dateFilter).length ? { reportDate: dateFilter } : {}),
      ...(cursor ? cursorWhere : {}),
    };

    const dprs = await prisma.dPR.findMany({
      where,
      include: {
        photos: { select: { id: true, caption: true, contentType: true, ulid: true, container: true } },
        submittedBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: [{ reportDate: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });

    const hasMore = dprs.length > take;
    const items = hasMore ? dprs.slice(0, -1) : dprs;
    const lastItem = items[items.length - 1];
    // reportDate is @db.Date in Postgres — Prisma sometimes returns it as
    // a "YYYY-MM-DD" string rather than a JS Date (depends on column type
    // and Prisma client version). Coerce defensively so cursor building
    // doesn't throw "reportDate.toISOString is not a function" and turn a
    // >20-row result set into a 500 (Code Reviewer P2-3).
    const lastDate = lastItem && (lastItem.reportDate instanceof Date
      ? lastItem.reportDate
      : new Date(lastItem.reportDate));
    const nextCursor = hasMore && lastItem && lastDate && !isNaN(lastDate.getTime())
      ? Buffer.from(`${lastDate.toISOString()}|${lastItem.id}`).toString('base64')
      : null;

    res.setHeader('X-Total-Count', items.length);
    res.setHeader('X-Has-More', hasMore ? 'true' : 'false');
    res.json({ dprs: items, nextCursor });
  } catch (err) {
    console.error('DPR list error', { prismaCode: err.code, message: err.message?.split('\n')[0] });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to fetch DPRs' });
  }
}));

// ─── GET /api/dpr/:id ────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;

  try {
    const dpr = await prisma.dPR.findUnique({
      where: { id },
      include: {
        photos: true,
        submittedBy: { select: { id: true, name: true, email: true } },
        reviewedBy: { select: { id: true, name: true, email: true } },
        approvedBy: { select: { id: true, name: true, email: true } },
        revisions: {
          orderBy: { version: 'desc' },
          select: { id: true, version: true, changedAt: true, changedById: true },
        },
      },
    });

    if (!dpr) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'DPR not found' });
    }

    // Auth: owner or admin
    const employee = await prisma.employee.findUnique({ where: { id: req.employeeId } });
    const isAdmin = employee && employee.isAdmin;
    if (dpr.submittedById !== req.employeeId && !isAdmin) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Not authorized' });
    }

    // Generate read SAS URLs for photos. P2-1: derive the blob extension
    // from the validated contentType (not the user-supplied filename which
    // may have the wrong case or no extension at all — leading to 404s on
    // the image fetch).
    const photosWithUrls = await Promise.all(dpr.photos.map(async p => {
      const ext = CONTENT_TYPE_EXT[p.contentType];
      const blobName = ext ? `${p.ulid}.${ext}` : p.ulid;
      const { sasUrl } = await generateReadSASUrl(p.container, blobName);
      return { ...p, readUrl: sasUrl };
    }));

    res.json({ ...dpr, photos: photosWithUrls });
  } catch (err) {
    console.error('DPR get error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to fetch DPR' });
  }
});

// ─── PUT /api/dpr/:id ────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;
  const { version, ...fields } = req.body || {};

  // Strict version check
  if (!Number.isInteger(version) || version < 1) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'version must be a positive integer' });
  }

  // P0-1 PUT mass-assignment IDOR: explicit allowlist. A client must NOT be
  // able to set submittedById (transfer ownership), status, reviewedById,
  // approvedById, or any of the audit timestamps via PUT. Status transitions
  // go through /review, /approve, /reject endpoints only.
  const ALLOWED_UPDATE_FIELDS = [
    'projectName', 'location', 'reportDate', 'weather', 'temperature',
    'contractor', 'workType', 'notes', 'workEntries',
  ];
  const unknown = Object.keys(fields).filter(k => !ALLOWED_UPDATE_FIELDS.includes(k));
  if (unknown.length) {
    return res.status(400).json({
      error: 'UNKNOWN_FIELDS',
      message: `Fields not allowed: ${unknown.join(', ')}`,
      fields: unknown,
    });
  }

  // Length caps on the allowed fields too
  const MAX = { projectName: 200, location: 200, weather: 80, temperature: 20, contractor: 200, notes: 5000 };
  for (const [k, cap] of Object.entries(MAX)) {
    if (fields[k] != null && typeof fields[k] === 'string' && fields[k].length > cap) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: `${k} exceeds ${cap} chars` });
    }
  }

  // reportDate must be strict YYYY-MM-DD if present
  if (fields.reportDate !== undefined) {
    const dp = parseStrictISODate(fields.reportDate);
    if (!dp.ok) return res.status(400).json({ error: 'INVALID_REPORT_DATE', message: 'reportDate must be YYYY-MM-DD' });
    fields.reportDate = dp.date;
  }

  // Only owner can update
  const existing = await prisma.dPR.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'DPR not found' });
  }
  if (existing.submittedById !== req.employeeId) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only owner can update' });
  }

  try {
    const updated = await prisma.dPR.update({
      where: {
        id,
        version: existing.version,
      },
      data: {
        ...fields,
        version: { increment: 1 },
        updatedAt: new Date(),
      },
      include: { photos: true, submittedBy: { select: { id: true, name: true, email: true } } },
    });

    res.json(updated);
  } catch (err) {
    // PII redaction (P1-7) — log Prisma code only
    console.error('DPR update error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) {
      if (mapped.code === 'NOT_FOUND') {
        // P2025 from the version-conditional update → conflict
        return res.status(409).json({ error: 'VERSION_CONFLICT', code: 'VERSION_CONFLICT' });
      }
      return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    }
    res.status(500).json({ error: 'Failed to update DPR' });
  }
});

// ─── POST /api/dpr/:id/review ───────────────────────────────────────────────
router.post('/:id/review', async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;
  const { corrections, adminNotes } = req.body;

  // Admin check
  const employee = await prisma.employee.findUnique({ where: { id: req.employeeId } });
  if (!employee || !employee.isAdmin) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Admin access required' });
  }

  const dpr = await prisma.dPR.findUnique({
    where: { id },
    include: { photos: true, submittedBy: true },
  });
  if (!dpr) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'DPR not found' });
  }

  try {
    // Create revision snapshot
    await prisma.dPRRevision.create({
      data: {
        dprId: id,
        version: dpr.version,
        snapshot: dpr,
        changedById: req.employeeId,
      },
    });

    // Update DPR status to UNDER_REVIEW
    const updated = await prisma.dPR.update({
      where: { id },
      data: {
        status: 'UNDER_REVIEW',
        reviewedById: req.employeeId,
        reviewedAt: new Date(),
        version: { increment: 1 },
      },
      include: {
        photos: true,
        submittedBy: { select: { id: true, name: true, email: true } },
        reviewedBy: { select: { id: true, name: true, email: true } },
      },
    });

    // Create notification for DPR owner
    await prisma.notification.create({
      data: {
        employeeId: dpr.submittedById,
        type: 'DPR_REVIEWED',
        dprId: id,
        message: `Your DPR for ${dpr.projectName} on ${dpr.reportDate.toISOString().split('T')[0]} was reviewed by ${employee.name}. ${adminNotes || ''}`.trim(),
      },
    });

    // Emit SSE notification
    emitNotification(dpr.submittedById, 'notification', {
      id: Date.now(),
      type: 'DPR_REVIEWED',
      dprId: id,
      message: `Your DPR for ${dpr.projectName} was reviewed`,
      createdAt: new Date().toISOString(),
    });

    res.json(updated);
  } catch (err) {
    console.error('DPR review error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to review DPR' });
  }
});

// ─── POST /api/dpr/:id/approve ───────────────────────────────────────────────
// Terminal state: DRAFT|SUBMITTED|UNDER_REVIEW -> APPROVED. Admin only.
router.post('/:id/approve', async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;
  const { adminNotes } = req.body || {};

  const employee = await prisma.employee.findUnique({ where: { id: req.employeeId } });
  if (!employee || !employee.isAdmin) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Admin access required' });
  }

  const dpr = await prisma.dPR.findUnique({
    where: { id },
    include: { photos: true, submittedBy: true },
  });
  if (!dpr) return res.status(404).json({ error: 'NOT_FOUND', message: 'DPR not found' });

  if (dpr.status === 'APPROVED') {
    return res.status(409).json({ error: 'ALREADY_APPROVED', message: 'DPR is already approved' });
  }

  try {
    // Snapshot the pre-approval state for audit trail
    await prisma.dPRRevision.create({
      data: {
        dprId: id,
        version: dpr.version,
        snapshot: dpr,
        changedById: req.employeeId,
      },
    });

    const updated = await prisma.dPR.update({
      where: { id },
      data: {
        status: 'APPROVED',
        approvedById: req.employeeId,
        approvedAt: new Date(),
        version: { increment: 1 },
      },
      include: {
        photos: true,
        submittedBy: { select: { id: true, name: true, email: true } },
        approvedBy: { select: { id: true, name: true, email: true } },
      },
    });

    await prisma.notification.create({
      data: {
        employeeId: dpr.submittedById,
        type: 'DPR_APPROVED',
        dprId: id,
        message: `Your DPR for ${dpr.projectName} on ${dpr.reportDate.toISOString().split('T')[0]} was approved by ${employee.name}. ${adminNotes || ''}`.trim(),
      },
    });

    emitNotification(dpr.submittedById, 'notification', {
      id: Date.now(),
      type: 'DPR_APPROVED',
      dprId: id,
      message: `Your DPR for ${dpr.projectName} was approved`,
      createdAt: new Date().toISOString(),
    });

    res.json(updated);
  } catch (err) {
    console.error('DPR approve error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to approve DPR' });
  }
});

// ─── POST /api/dpr/:id/reject ────────────────────────────────────────────────
// Terminal state: any -> REJECTED. Admin only. Requires a reason so the owner
// knows what to fix (Codebase Architect #33 — UI was a lie).
router.post('/:id/reject', async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;
  const { reason, adminNotes } = req.body || {};

  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    return res.status(400).json({ error: 'REASON_REQUIRED', message: 'A reason is required to reject a DPR' });
  }
  if (reason.length > 1000) {
    return res.status(400).json({ error: 'REASON_TOO_LONG', message: 'Reason must be <= 1000 chars' });
  }

  const employee = await prisma.employee.findUnique({ where: { id: req.employeeId } });
  if (!employee || !employee.isAdmin) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Admin access required' });
  }

  const dpr = await prisma.dPR.findUnique({
    where: { id },
    include: { photos: true, submittedBy: true },
  });
  if (!dpr) return res.status(404).json({ error: 'NOT_FOUND', message: 'DPR not found' });

  if (dpr.status === 'REJECTED') {
    return res.status(409).json({ error: 'ALREADY_REJECTED', message: 'DPR is already rejected' });
  }

  try {
    await prisma.dPRRevision.create({
      data: {
        dprId: id,
        version: dpr.version,
        snapshot: dpr,
        changedById: req.employeeId,
      },
    });

    const updated = await prisma.dPR.update({
      where: { id },
      data: {
        status: 'REJECTED',
        reviewedById: req.employeeId,
        reviewedAt: new Date(),
        version: { increment: 1 },
      },
      include: {
        photos: true,
        submittedBy: { select: { id: true, name: true, email: true } },
        reviewedBy: { select: { id: true, name: true, email: true } },
      },
    });

    const combinedNotes = [reason.trim(), adminNotes].filter(Boolean).join('\n\n');
    await prisma.notification.create({
      data: {
        employeeId: dpr.submittedById,
        type: 'DPR_REJECTED',
        dprId: id,
        message: `Your DPR for ${dpr.projectName} on ${dpr.reportDate.toISOString().split('T')[0]} was rejected by ${employee.name}: ${reason.trim()}${adminNotes ? `\n${adminNotes}` : ''}`.trim(),
      },
    });

    emitNotification(dpr.submittedById, 'notification', {
      id: Date.now(),
      type: 'DPR_REJECTED',
      dprId: id,
      message: `Your DPR for ${dpr.projectName} was rejected`,
      reason: combinedNotes,
      createdAt: new Date().toISOString(),
    });

    res.json(updated);
  } catch (err) {
    console.error('DPR reject error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to reject DPR' });
  }
});

// ─── PUT /api/dpr/notifications/read-all ───────────────────────────────────
router.put('/notifications/read-all', async (req, res) => {
  const prisma = getPrisma(req);

  try {
    const result = await prisma.notification.updateMany({
      where: { employeeId: req.employeeId, isRead: false },
      data: { isRead: true },
    });

    res.json({ updated: result.count });
  } catch (err) {
    console.error('Mark read error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to mark notifications read' });
  }
});

// ─── POST /api/dpr/:id/pdf ──────────────────────────────────────────────────
router.post('/:id/pdf', async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;

  const dpr = await prisma.dPR.findUnique({
    where: { id },
    include: {
      photos: true,
      submittedBy: { select: { name: true, email: true } },
      reviewedBy: { select: { name: true } },
      approvedBy: { select: { name: true } },
    },
  });

  if (!dpr) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'DPR not found' });
  }

  // Auth check
  const employee = await prisma.employee.findUnique({ where: { id: req.employeeId } });
  const isAdmin = employee && employee.isAdmin;
  if (dpr.submittedById !== req.employeeId && !isAdmin) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Not authorized' });
  }

  // In production: render Handlebars template + Puppeteer -> PDF buffer -> upload to blob
  // For now, return a placeholder response
  res.json({
    pdfUrl: `/api/dpr/pdf-placeholder/${id}`,
    message: 'PDF generation not yet configured - requires Azure Blob + Puppeteer setup',
  });
});

module.exports = router;
