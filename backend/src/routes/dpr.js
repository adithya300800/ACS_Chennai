const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { generateULID, generateUploadSASUrl, generateReadSASUrl, verifyBlobExists } = require('../lib/blobStorage');

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

// SSE /notifications route — auth via ticket ONLY (no JWT in URL).
router.get('/notifications', async (req, res) => {
  const { ticket, lastNotificationId } = req.query;

  if (!ticket) {
    return res.status(401).json({ error: 'Ticket required' });
  }

  const entry = sseTickets.get(ticket);
  if (!entry || entry.expiresAt <= Date.now()) {
    sseTickets.delete(ticket);
    return res.status(401).json({ error: 'Invalid or expired ticket' });
  }

  // Single-use: delete immediately so the ticket can't be replayed.
  sseTickets.delete(ticket);
  const employeeId = entry.employeeId;

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
    console.error('Blob verification failed:', err);
    return res.status(502).json({ error: 'BLOB_VERIFICATION_FAILED', message: 'Could not verify upload' });
  }

  pendingUploads.delete(pendingKey);

  res.json({ verified: true });
});

// ─── POST /api/dpr ────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const prisma = getPrisma(req);
  const { projectName, location, reportDate, weather, temperature, contractor, workType, notes, workEntries, status, photos = [] } = req.body;

  if (!projectName || !location || !reportDate) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'projectName, location, reportDate required' });
  }

  const validStatuses = ['DRAFT', 'SUBMITTED'];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid status' });
  }

  const validWorkTypes = ['MATERIAL_RECEIPT', 'QUALITY_TESTING', 'SITE_INSPECTION', 'EXCEPTIONS_SAFETY'];
  if (workType && !validWorkTypes.includes(workType)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid workType' });
  }

  try {
    // Parse reportDate
    const [year, month, day] = reportDate.split('-').map(Number);
    const dateUTC = new Date(Date.UTC(year, month - 1, day));

    const dpr = await prisma.dPR.create({
      data: {
        projectName,
        location,
        reportDate: dateUTC,
        weather: weather || null,
        temperature: temperature || null,
        contractor: contractor || null,
        workType: workType || 'MATERIAL_RECEIPT',
        notes: notes || null,
        workEntries: workEntries || null,
        status: status || 'DRAFT',
        submittedById: req.employeeId,
        submittedAt: new Date(),
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
    console.error('DPR create error:', err);
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'DPR already exists for this date', code: 'DUPLICATE_DPR' });
    }
    res.status(500).json({ error: 'Failed to create DPR' });
  }
});

// ─── GET /api/dpr ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
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
      const parsedDate = new Date(cDate);
      if (!cId || isNaN(parsedDate.getTime())) {
        return res.status(400).json({ error: 'INVALID_CURSOR', message: 'Cursor is malformed or expired' });
      }
      cursorWhere = {
        OR: [
          { reportDate: { lt: parsedDate } },
          { reportDate: parsedDate, id: { lt: cId } },
        ],
      };
    } catch (e) {
      return res.status(400).json({ error: 'INVALID_CURSOR', message: 'Cursor could not be decoded' });
    }
  }

  // Validate date-range filters (used by frontend list UI)
  const dateFilter = {};
  if (from) {
    const d = new Date(from);
    if (isNaN(d.getTime())) {
      return res.status(400).json({ error: 'INVALID_FROM', message: 'from must be an ISO date' });
    }
    dateFilter.gte = d;
  }
  if (to) {
    const d = new Date(to);
    if (isNaN(d.getTime())) {
      return res.status(400).json({ error: 'INVALID_TO', message: 'to must be an ISO date' });
    }
    dateFilter.lte = d;
  }

  // Check if admin
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

  try {
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
    const nextCursor = hasMore && lastItem
      ? Buffer.from(`${lastItem.reportDate.toISOString()}|${lastItem.id}`).toString('base64')
      : null;

    res.setHeader('X-Total-Count', items.length);
    res.setHeader('X-Has-More', hasMore ? 'true' : 'false');
    res.json({ dprs: items, nextCursor });
  } catch (err) {
    console.error('DPR list error:', err);
    res.status(500).json({ error: 'Failed to fetch DPRs' });
  }
});

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

    // Generate read SAS URLs for photos
    const photosWithUrls = await Promise.all(dpr.photos.map(async p => {
      const { sasUrl } = await generateReadSASUrl(p.container, `${p.ulid}.${p.filename.split('.').pop()}`);
      return { ...p, readUrl: sasUrl };
    }));

    res.json({ ...dpr, photos: photosWithUrls });
  } catch (err) {
    console.error('DPR get error:', err);
    res.status(500).json({ error: 'Failed to fetch DPR' });
  }
});

// ─── PUT /api/dpr/:id ────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;
  const { version, ...fields } = req.body;

  if (version === undefined) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'version required for optimistic locking' });
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
    if (err.code === 'P2025') {
      return res.status(409).json({ error: 'VERSION_CONFLICT', message: 'DPR was modified by another request' });
    }
    console.error('DPR update error:', err);
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
    console.error('DPR review error:', err);
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
    console.error('DPR approve error:', err);
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
    console.error('DPR reject error:', err);
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
    console.error('Mark read error:', err);
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
