const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { requireAuth, requireFreshAdmin, requireAdmin } = require('../middleware/auth');
const { generateReadSASUrl, CONTENT_TYPE_EXT } = require('../lib/blobStorage');
const { mapPrismaError, parseStrictISODate, parseISODateTime, toDateOnly } = require('../lib/errors');
// Round-27: shared IST date helpers. The `month` query shortcut on the list
// endpoint uses `getMonthRangeUtc` to expand `?month=YYYY-MM` into a
// half-open [gte, lt) `reportDate` window aligned to the company's
// Asia/Kolkata calendar (see backend/src/lib/dateOnly.js).
const { getMonthRangeUtc, InvalidMonthRangeError } = require('../lib/dateOnly');
const { hashIdentifier } = require('../lib/pii');
const { encodeCursor, decodeCursor, InvalidCursorError } = require('../lib/cursor');
// Round-25: post-write email fan-out for the in-app notification system.
// The 13 notification.create call sites add a single `fanOutEmail(...)` line
// after their existing tx/SSE emit. fire-and-forget — never blocks the
// user-facing response, never throws (helper swallows its own errors).
const { fanOutEmail } = require('../lib/notify');
// Round-26: admin-targeted fan-out for the POST /api/dpr → submitted event.
// Admins get an immediate email per recipient, with per-admin preferences
// (emailEnabled + typeMutes) honoured by the helper.
const { fanOutToAdmins } = require('../lib/notify');
// DR-021 (round-20): shared upload routes (sas-url + confirm-upload) live
// in src/lib/uploadRoutes.js. DPR uses the "client-pick from allowlist"
// mode because the frontend can upload to dpr-photos, dpr-documents, or
// inspection-photos depending on whether the photo is the daily narrative,
// a generated PDF, or an inspection-record photo.
const { mountUploadRoutes } = require('../lib/uploadRoutes');
// [S3-7] Consumption half of LPR-012. `validatePhotoIntents` refuses any
// photo whose ulid has no CONFIRMED intent owned by the caller (closing
// both the no-intent-at-all gap and the cross-employee IDOR). [DR-006]
// The claim itself now runs INSIDE the create transaction via
// `assertPhotoIntentsBindable` + `bindPhotoIntentsTx`, so a sweep that
// retires a blob mid-request rolls the record back (409) instead of
// committing a report with missing evidence. See lib/uploadIntentBinding.js.
const {
  validatePhotoIntents,
  withRecordTransaction,
  assertPhotoIntentsBindable,
  bindPhotoIntentsTx,
  photoBindingLostResponse,
} = require('../lib/uploadIntentBinding');
// DR-027: parseStrictISODate only validates calendar shape, so a well-formed
// future date used to persist. rejectIfFutureReportDate is the authority.
const { rejectIfFutureReportDate } = require('../lib/reportDate');
// LPR-013: route the "today" window through the IST business-date helper
// instead of UTC midnight. The previous UTC-midnight window meant a DPR
// filed at 02:00 IST (20:30 UTC of the prior day) silently failed to
// count as "Submitted Today" between 00:00 and 02:00 IST, and an admin
// viewing the dashboard after 18:30 IST saw "tomorrow" entries already
// bucketed under "today". The canonical helper `getTodayBusinessDate`
// produces UTC midnight of the IST calendar day — same encoding as the
// `reportDate` `@db.Date` column, so the half-open [gte, lt) query
// semantics are preserved.
const { getTodayBusinessDate } = require('../lib/dateOnly');

// Tiny asyncHandler so unhandled rejections in async route handlers reach
// the global error handler instead of hanging the request or crashing the
// process. Express 4 doesn't auto-catch async errors without it. We can't
// add express-async-errors as a dep in this round, so this local wrapper
// does the same job for the routes we touch.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Round-12: validator for DPR.customSections — the user-added ad-hoc text
// and table blocks the engineer pastes via the "+ Add Section" button on
// the DPR form. Schema is enforced server-side so a malicious or buggy
// client can't poison the column with arbitrary JSON / HTML / huge blobs.
//
// Shape:
//   Array<{
//     id: string (≤64 chars),
//     type: 'text' | 'table',
//     title: string (1..120 chars),
//     // text only:
//     content?: string (≤5000 chars),
//     // table only:
//     columns?: string[] (1..6 entries, each ≤60 chars),
//     rows?: string[][] (≤200 rows; each row length must equal columns.length;
//                        each cell ≤500 chars),
//   }>
//
// The frontend assigns `id` via crypto.randomUUID() so a future reorder or
// rename doesn't lose the row the engineer typed.
function validateCustomSections(v) {
  if (v == null) return { ok: true };
  if (!Array.isArray(v)) return { ok: false, msg: 'customSections must be an array' };
  if (v.length > 20) return { ok: false, msg: 'customSections: max 20 sections per DPR' };
  const idSet = new Set();
  for (const [i, s] of v.entries()) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      return { ok: false, msg: `customSections[${i}] must be an object` };
    }
    if (typeof s.id !== 'string' || s.id.length === 0 || s.id.length > 64) {
      return { ok: false, msg: `customSections[${i}].id invalid (1..64 chars)` };
    }
    if (idSet.has(s.id)) return { ok: false, msg: `customSections[${i}].id duplicate` };
    idSet.add(s.id);
    if (s.type !== 'text' && s.type !== 'table') {
      return { ok: false, msg: `customSections[${i}].type must be 'text' or 'table'` };
    }
    if (typeof s.title !== 'string' || s.title.length === 0 || s.title.length > 120) {
      return { ok: false, msg: `customSections[${i}].title invalid (1..120 chars)` };
    }
    if (s.type === 'text') {
      if (s.content != null && (typeof s.content !== 'string' || s.content.length > 5000)) {
        return { ok: false, msg: `customSections[${i}].content invalid (≤5000 chars)` };
      }
      // Reject unknown keys on text sections so the column shape stays clean
      // and a frontend bug can't smuggle in `columns` / `rows` by accident.
      const allowed = new Set(['id', 'type', 'title', 'content']);
      for (const k of Object.keys(s)) {
        if (!allowed.has(k)) return { ok: false, msg: `customSections[${i}].${k} not allowed on text` };
      }
    } else { // table
      if (!Array.isArray(s.columns) || s.columns.length === 0 || s.columns.length > 6) {
        return { ok: false, msg: `customSections[${i}].columns must be array of 1..6` };
      }
      for (const [j, c] of s.columns.entries()) {
        if (typeof c !== 'string' || c.length === 0 || c.length > 60) {
          return { ok: false, msg: `customSections[${i}].columns[${j}] invalid (1..60 chars)` };
        }
      }
      if (!Array.isArray(s.rows)) {
        return { ok: false, msg: `customSections[${i}].rows must be array` };
      }
      if (s.rows.length > 200) {
        return { ok: false, msg: `customSections[${i}].rows: max 200 rows` };
      }
      for (const [j, r] of s.rows.entries()) {
        if (!Array.isArray(r) || r.length !== s.columns.length) {
          return { ok: false, msg: `customSections[${i}].rows[${j}] must have ${s.columns.length} cells` };
        }
        for (const [k, cell] of r.entries()) {
          if (typeof cell !== 'string' || cell.length > 500) {
            return { ok: false, msg: `customSections[${i}].rows[${j}][${k}] invalid (≤500 chars)` };
          }
        }
      }
      const allowed = new Set(['id', 'type', 'title', 'columns', 'rows']);
      for (const k of Object.keys(s)) {
        if (!allowed.has(k)) return { ok: false, msg: `customSections[${i}].${k} not allowed on table` };
      }
    }
  }
  return { ok: true };
}

// In-memory pending uploads now live in src/lib/uploadRoutes.js
// (DR-021 round-20). Both DPR and Inspection share one Map — entries
// are keyed by employeeId + server-generated ulid, so the two
// consumers cannot collide.

// ─── Idempotency-Key store ─────────────────────────────────────────────────
// Round-10: when a client retries a POST (mobile flaky network, browser
// refresh, double-click) with the same Idempotency-Key, return the cached
// response instead of creating a duplicate DPR. Capped at 5 min — long enough
// to ride out a slow mobile retry, short enough that the map can't grow
// unboundedly. Keyed by (employeeId, Idempotency-Key) so a leaked key from
// employee A can't replay employee B's response. The CORS Allow-Headers list
// (index.js) already exposes this header to the browser.
//
// DR-006 (round-20): the cache now stores a SHA-256 hash of the POST
// body alongside the response. A replay request with the SAME key but
// a DIFFERENT body returns 409 IDEMPOTENCY_MISMATCH instead of
// silently returning the first response — that's a security bug
// (an attacker who learned/leaked a key could probe arbitrary
// payloads against the cached slot). Same key + same body is the only
// valid replay. Canonical JSON via stable JSON.stringify (sorted
// keys, no whitespace) so {a:1,b:2} and {b:2,a:1} hash identically.
const idempotencyCache = new Map(); // key: `${employeeId}:${idempotencyKey}` → { status, body, bodyHash, savedAt }
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

function pruneIdempotency() {
  const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
  for (const [k, v] of idempotencyCache.entries()) {
    if (v.savedAt <= cutoff) idempotencyCache.delete(k);
  }
}

// Stable JSON stringify: sort object keys recursively so {a:1,b:2} and
// {b:2,a:1} produce identical output. Arrays preserve order.
function canonicalJsonStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJsonStringify(v)).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJsonStringify(value[k])).join(',') + '}';
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function getCachedIdempotent(employeeId, key) {
  const cacheKey = `${employeeId}:${key}`;
  const cached = idempotencyCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.savedAt > IDEMPOTENCY_TTL_MS) {
    idempotencyCache.delete(cacheKey);
    return null;
  }
  return cached;
}
function storeIdempotent(employeeId, key, status, body, bodyHash) {
  pruneIdempotency();
  idempotencyCache.set(`${employeeId}:${key}`, {
    status,
    body,
    bodyHash,
    savedAt: Date.now(),
  });
}

// SSE connections per employee
const sseConnections = new Map(); // employeeId -> Set<{res, lastNotificationId}>

// SSE ticket store — replaces the previous ?token= query-string auth.
// JWTs in URLs are dangerous because they end up in proxy/CDN access logs,
// browser history, and server-side request logs (AppSec #9). Instead the
// client first calls POST /api/dpr/notifications/ticket (authenticated via
// Bearer header), receives a short-lived opaque ticket, then opens the SSE
// stream with ?ticket=... — proxies only ever see the ticket.
const sseTickets = new Map(); // ticket -> { employeeId, expiresAt, lastSeenAt }
const TICKET_TTL_MS = 5 * 60 * 1000; // 5 min sliding window — survives mobile reconnects

function pruneTickets() {
  const now = Date.now();
  for (const [k, v] of sseTickets.entries()) {
    if (v.expiresAt <= now) sseTickets.delete(k);
  }
}
function createTicket(employeeId) {
  pruneTickets();
  const ticket = crypto.randomBytes(32).toString('base64url');
  sseTickets.set(ticket, {
    employeeId,
    expiresAt: Date.now() + TICKET_TTL_MS,
    lastSeenAt: Date.now(),
  });
  // Best-effort auto-cleanup at TTL
  setTimeout(() => {
    const entry = sseTickets.get(ticket);
    if (entry && entry.expiresAt <= Date.now()) sseTickets.delete(ticket);
  }, TICKET_TTL_MS).unref();
  return ticket;
}

// POST /api/dpr/notifications/ticket — must be authenticated via Bearer header.
// Returns a long-lived (5 min sliding) ticket for opening an SSE stream.
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
    // Preferred path — opaque ticket from POST /api/dpr/notifications/ticket.
    // Round-10 fix: sliding 5-min window, NOT single-use. Single-use tickets
    // break the EventSource auto-reconnect path — any mobile network blip
    // (subway, elevator, wifi handoff) reopens the stream with the same
    // ticket, and the previous impl 401'd on the second connect. Tickets
    // stay valid for the lifetime of an active connection; we refresh
    // lastSeenAt on every heartbeat so an idle/disconnected ticket ages out.
    const entry = sseTickets.get(ticket);
    if (!entry || entry.expiresAt <= Date.now()) {
      sseTickets.delete(ticket);
      return res.status(401).json({ error: 'Invalid or expired ticket' });
    }
    entry.lastSeenAt = Date.now();
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

// DR-021 (round-20): shared upload routes live in src/lib/uploadRoutes.js.
// DPR uses the "client-pick from allowlist" mode — the frontend can
// upload to dpr-photos (daily narrative), dpr-documents (generated
// PDFs), or inspection-photos (inspection-record photo referenced from
// a DPR). Mounted AFTER `router.use(requireAuth)` at line 256 below.
mountUploadRoutes(router, {
  // Round-12: 'inspection-photos' added for the Inspection & Compliance
  // page. The existing dpr-photos container is still used for DPR-level
  // photos; inspection photos get their own bucket so a single leaky
  // SAS can't cross between the two record types.
  allowedContainers: ['dpr-photos', 'dpr-documents', 'inspection-photos'],
});

// ─── POST /api/dpr ────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const prisma = getPrisma(req);

  // Round-10: Idempotency-Key replay protection. If the client retried
  // (mobile blip / refresh / accidental double-submit), return the cached
  // 201 response instead of creating a duplicate DPR row. The header is
  // exposed via CORS Allow-Headers (index.js:62) so the browser preflight
  // succeeds.
  //
  // DR-006: the cache is keyed on `(employeeId, key)` AND the SHA-256
  // hash of the request body. A replay with the same key but a
  // different body is a CLIENT BUG (the key should be regenerated for a
  // new submission) and now returns 409 IDEMPOTENCY_MISMATCH instead of
  // silently returning the first cached response — that silent-return
  // was the security hole (a leaked key let an attacker probe arbitrary
  // payloads against the cached slot).
  const idempotencyKey = req.headers['idempotency-key'];
  let bodyHash = null;
  if (idempotencyKey && typeof idempotencyKey === 'string' && idempotencyKey.length > 0 && idempotencyKey.length <= 200) {
    bodyHash = sha256Hex(canonicalJsonStringify(req.body || {}));
    const cached = getCachedIdempotent(req.employeeId, idempotencyKey);
    if (cached) {
      if (cached.bodyHash !== bodyHash) {
        // Same key, different body — refuse. The client should mint a
        // new key for a new submission; reusing a key across distinct
        // intents is a client bug.
        return res.status(409).json({
          error: 'Idempotency-Key was used for a different request body',
          code: 'IDEMPOTENCY_MISMATCH',
        });
      }
      // Replay — return the original response with a header so the client
      // can tell this is a replay (helps debug "did my second click create
      // a duplicate?" investigations).
      res.setHeader('Idempotent-Replay', 'true');
      return res.status(cached.status).json(cached.body);
    }
  }

  const {
    projectName, location, reportDate, weather, temperature,
    contractor, workType, notes, workEntries,
    // Round-12: 5 new daily-narrative PMC fields + the user-added ad-hoc
    // sections blob. workEntries is still accepted (legacy clients) but the
    // server silently drops it — the Inspection page owns that data now.
    workExecutedToday, workLocation, manpowerSummary,
    risksHindrances, materialsReceivedSummary, customSections,
    status, photos = [],
  } = req.body || {};

  // typeof guards (Code Reviewer P1-2): reject non-string types before they
  // reach Prisma where they would cause opaque 500s.
  if (typeof projectName !== 'string' || !projectName.trim() ||
      typeof location !== 'string' || !location.trim() ||
      typeof reportDate !== 'string') {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'projectName, location, reportDate required' });
  }

  // Length caps (P1-3) — keep the database tidy, prevent abuse. Round-12:
  // extended with caps for the 5 new daily-narrative PMC fields.
  const MAX = {
    projectName: 200, location: 200, weather: 80, temperature: 20, contractor: 200,
    notes: 5000,
    workExecutedToday: 1000, workLocation: 500, manpowerSummary: 1000,
    risksHindrances: 2000, materialsReceivedSummary: 1000,
  };
  for (const [k, cap] of Object.entries(MAX)) {
    if (req.body[k] != null && typeof req.body[k] === 'string' && req.body[k].length > cap) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: `${k} exceeds ${cap} chars` });
    }
  }

  // customSections shape guard — runs after the length caps so a giant blob
  // hits the cheaper cap check first. Validator returns 400 with a precise
  // path so the UI can highlight the offending field on round-trip.
  const sectionsCheck = validateCustomSections(customSections);
  if (!sectionsCheck.ok) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: sectionsCheck.msg, field: 'customSections' });
  }

  const validStatuses = ['DRAFT', 'SUBMITTED'];
  if (status !== undefined && !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid status' });
  }

  const validWorkTypes = ['MATERIAL_RECEIPT', 'QUALITY_TESTING', 'SITE_INSPECTION', 'EXCEPTIONS_SAFETY'];
  // P0-3: `workType` was previously optional and silently defaulted to
  // 'MATERIAL_RECEIPT' if missing. That masked a frontend-side wiring bug
  // (DprSubmit never sent the field) and corrupted every DPR's classification
  // — a payroll/audit-integrity defect. The new contract is loud:
  //   - missing / empty / non-string       → 400 WORKTYPE_REQUIRED
  //   - present but not in the allowlist   → 422 WORKTYPE_INVALID
  if (workType === undefined || workType === null || (typeof workType === 'string' && workType.trim() === '')) {
    return res.status(400).json({
      error: 'workType is required',
      code: 'WORKTYPE_REQUIRED',
    });
  }
  if (!validWorkTypes.includes(workType)) {
    return res.status(422).json({
      error: `workType must be one of: ${validWorkTypes.join(', ')}`,
      code: 'WORKTYPE_INVALID',
      allowed: validWorkTypes,
    });
  }

  // Strict date validation (P0-4) — silent rollover for 2026-02-30 etc.
  const dateParsed = parseStrictISODate(reportDate);
  if (!dateParsed.ok) {
    return res.status(400).json({ error: 'INVALID_REPORT_DATE', message: 'reportDate must be a valid YYYY-MM-DD date' });
  }
  const dateUTC = dateParsed.date;

  // DR-027: shape-valid but future dates were persisting. A tomorrow-dated
  // DPR reserves the legitimate (employee, day) key — the real report 409s as
  // a duplicate the next morning — and contaminates the admin review queue
  // with work that hasn't happened. The date picker already clamps this, but
  // the UI is a UX guard, not an authority. Admins may override (audited).
  if (rejectIfFutureReportDate(req, res, dateUTC, 'dpr.create')) return;

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

  // [S3-7] Every photo must be backed by a CONFIRMED upload intent owned
  // by THIS employee. The loop above only checks the ulid's 26-char
  // Crockford shape, which a client can trivially fabricate — before this
  // gate a DPR could reference a blob that never existed, or another
  // employee's blob. The lookup is scoped by req.employeeId, so a foreign
  // ulid and a nonexistent one produce the same 400 (no oracle).
  const intentErr = await validatePhotoIntents({
    prisma,
    employeeId: req.employeeId,
    photos,
    context: 'dpr.create',
  });
  if (intentErr) return res.status(intentErr.status).json(intentErr.body);

  try {
    // [DR-006] The create and the intent claim are ONE transaction. The
    // pre-flight `validatePhotoIntents` above is a fast rejection path, but
    // it cannot stop the durable sweep from retiring a blob in the gap
    // before the row lands — so we re-assert inside the tx, create, then
    // claim, and roll everything back if the claim comes up short.
    const dpr = await withRecordTransaction(prisma, 'dPR', async (db) => {
      await assertPhotoIntentsBindable({ tx: db, employeeId: req.employeeId, photos });

      const created = await db.dPR.create({
        data: {
          projectName: projectName.trim(),
          location: location.trim(),
          reportDate: dateUTC,
          weather: weather || null,
          temperature: temperature || null,
          contractor: contractor || null,
          // P0-3: `workType` is now validated upstream as required. No silent
          // default here — if the validator above let it through, it's a real
          // string and we pass it through verbatim.
          workType,
          notes: notes || null,
          // Round-12: write the 5 daily-narrative fields + customSections blob.
          // workEntries is intentionally NOT persisted — it's legacy from the
          // pre-refactor DPR and lives on the Inspection page now. Old rows
          // that already have it are untouched (column is nullable).
          workExecutedToday: workExecutedToday || null,
          workLocation: workLocation || null,
          manpowerSummary: manpowerSummary || null,
          risksHindrances: risksHindrances || null,
          materialsReceivedSummary: materialsReceivedSummary || null,
          customSections: customSections || null,
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
          inspections: { select: { id: true, inspectionType: true, status: true, severity: true } },
        },
      });

      // [S3-7 + DR-006] Claim the upload intents this DPR just took
      // ownership of, in the SAME transaction as the create. A short count
      // means the sweep retired a blob mid-request, so this throws and the
      // whole create rolls back — the client gets 409 PHOTO_BINDING_LOST and
      // can re-upload, instead of a "successful" report with missing
      // evidence and nothing but a log line to show for it.
      await bindPhotoIntentsTx({
        tx: db,
        employeeId: req.employeeId,
        photos,
        boundType: 'dpr',
        recordId: created.id,
      });

      return created;
    });

    if (idempotencyKey && typeof idempotencyKey === 'string' && bodyHash) {
      storeIdempotent(req.employeeId, idempotencyKey, 201, dpr, bodyHash);
    }

    res.status(201).json(dpr);

    // Round-26: fire admin-targeted fan-out for SUBMITTED DPRs (DRAFTs
    // don't trigger admin notifications — they're the employee's local
    // save state). Best-effort: any error is swallowed inside the helper.
    if (dpr.status === 'SUBMITTED') {
      try {
        await fanOutToAdmins(
          {
            type: 'ADMIN_DPR_SUBMITTED',
            message: `New DPR submitted by ${dpr.submittedBy?.name || 'an employee'} for ${dpr.projectName}`,
            meta: {
              employeeName: dpr.submittedBy?.name || 'an employee',
              projectName: dpr.projectName,
              reportDate: formatReportDate(dpr.reportDate),
              dprId: dpr.id,
            },
          },
          prisma,
        );
      } catch (adminErr) {
        // Defence in depth — fanOutToAdmins never throws, but if anything
        // escapes we MUST NOT poison the request lifecycle that already
        // returned 201.
        console.error('DPR admin fan-out error', {
          dprId: dpr.id,
          message: adminErr?.message?.split('\n')[0],
        });
      }
    }
  } catch (err) {
    // [DR-006] A lost photo claim is not a server fault — nothing was
    // written (the tx rolled back) and the client can recover by
    // re-uploading. 409, never 500, and never the generic prisma mapping.
    const bindingLost = photoBindingLostResponse(err);
    if (bindingLost) {
      console.warn('DPR create rolled back — photo binding lost', {
        employeeHash: hashIdentifier(req.employeeId),
        expected: err.expected,
        bound: err.bound,
      });
      return res.status(bindingLost.status).json(bindingLost.body);
    }
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
    // Round-10: removed debug leakage (debugMessage / debugCode / debugMeta /
    // debugName) — production clients must not see Prisma internals or stack
    // traces. The error is fully logged server-side with the hashed employee
    // identifier for correlation; the client gets a stable error code and
    // request id it can quote when reporting.
    const requestId = req.headers['x-request-id'] || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    res.setHeader('X-Request-Id', requestId);
    res.status(500).json({
      error: 'Failed to create DPR',
      code: 'DPR_SAVE_FAILED',
      requestId,
    });
  }
});

// ─── GET /api/dpr ─────────────────────────────────────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  // R22.5: `projectName` (case-insensitive substring) and `submittedById` are
  // optional query params used by the admin "All Daily Reports Records" page
  // (DprAll.jsx). Both feed into the where clause so a filter narrows the
  // result set server-side — a 500+ row org doesn't need to ship everything
  // to the browser just so the client can filter. submittedById is the
  // canonical cuid; projectName is a free-text contains search.
  const { cursor, limit = '20', status: statusFilter, from, to, my, projectName, submittedById: submittedByIdFilter, month } = req.query;

  const take = Math.min(parseInt(limit) || 20, 100);

  // Validate cursor. Reject malformed cursors instead of letting
  // `new Date('garbage')` produce Invalid Date and crash the query.
  // DR-008: use the unified cursor codec so encoder + decoder agree on
  // `base64url(JSON.stringify({ date: 'YYYY-MM-DD', id }))`.
  let cursorWhere = {};
  if (cursor) {
    let decoded;
    try {
      decoded = decodeCursor(cursor);
    } catch (e) {
      if (e instanceof InvalidCursorError) {
        return res.status(400).json({ error: 'INVALID_CURSOR', message: e.message || 'Cursor is malformed or expired' });
      }
      return res.status(400).json({ error: 'INVALID_CURSOR', message: 'Cursor could not be decoded' });
    }
    cursorWhere = {
      OR: [
        { reportDate: { lt: decoded.date } },
        { reportDate: decoded.date, id: { lt: decoded.id } },
      ],
    };
  }

  // Validate date-range filters (used by frontend list UI). Accept either
  // YYYY-MM-DD (parsed as a date) or a full ISO timestamp.
  //
  // Round-27: a `month=YYYY-MM` query shortcut expands to the canonical IST
  // half-open [gte, lt) window for that calendar month
  // (backend/src/lib/dateOnly.js: getMonthRangeUtc). Combining `month` with
  // `from`/`to` is a client mistake — both expand the same `reportDate`
  // predicate, so we reject with 400 rather than silently AND-merge and
  // produce an unexpected window. Leaving `month` empty + filling `from`/`to`
  // manually keeps the existing open-ended behaviour.
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

  if (month && (from || to)) {
    return res.status(400).json({
      error: 'month cannot be combined with from/to',
      code: 'MONTH_AND_RANGE_CONFLICT',
    });
  }
  if (month) {
    let monthRange;
    try {
      monthRange = getMonthRangeUtc(String(month));
    } catch (e) {
      if (e instanceof InvalidMonthRangeError) {
        return res.status(400).json({ error: e.message, code: 'INVALID_MONTH' });
      }
      throw e;
    }
    // Half-open [gte, lt) so the upper bound is exclusive — avoids the
    // off-by-one risk of inclusive `lte` against a UTC-midnight end of
    // month (matches the attendance-export endpoint convention).
    dateFilter.gte = monthRange.startDate;
    dateFilter.lt = monthRange.endDate;
  } else {
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
      ...(submittedByIdFilter && !restrictToSelf ? { submittedById: submittedByIdFilter } : {}),
      ...(projectName ? { projectName: { contains: projectName, mode: 'insensitive' } } : {}),
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

    // R22.5 (round-22 follow-up): DPR queue cards (DprDashboard.jsx) render
    // photos directly from the list response. The single-record GET has
    // always generated `readUrl` (signed R2 GET SAS) for each photo, but the
    // list GET omitted the field — so every queue card showed a placeholder
    // icon and the <a href> was dead. We now mirror the single-record path:
    // for each photo, derive the same `${employeeId}/${ulid}.${ext}` blob
    // name the upload wrote under (blobStorage.js:66) and generate a fresh
    // 1-hour read SAS. Errors on a single URL don't fail the whole list —
    // the photo just renders without a usable src and the placeholder path
    // takes over (PhotoThumb in DprDashboard.jsx falls back gracefully).
    //
    // Latency budget: N+1 SAS generations per page, parallel via Promise.all.
    // For a 20-row page with 2 photos each = 40 calls × ~30 ms = ~1.2 s
    // worst-case added. Acceptable for an admin-only queue.
    const enriched = await Promise.all(dprs.map(async (d) => {
      if (!d.photos || d.photos.length === 0) return d;
      const photosWithUrls = await Promise.all(d.photos.map(async (p) => {
        try {
          const ext = CONTENT_TYPE_EXT[p.contentType];
          const blobName = ext
            ? `${d.submittedById}/${p.ulid}.${ext}`
            : `${d.submittedById}/${p.ulid}`;
          const { sasUrl } = await generateReadSASUrl(p.container, blobName);
          return { ...p, readUrl: sasUrl };
        } catch (e) {
          // Don't fail the whole list if one URL fails — the placeholder
          // path in PhotoThumb handles missing readUrl.
          return { ...p, readUrl: null };
        }
      }));
      return { ...d, photos: photosWithUrls };
    }));

    const hasMore = enriched.length > take;
    const items = hasMore ? enriched.slice(0, -1) : enriched;
    // SOL DR-004: normalize `reportDate` to strict YYYY-MM-DD on every list
    // row so client list/table components can render the date column
    // directly without re-parsing an ISO datetime string. The enriched
    // rows already hold a copy of the Date object, so this is a shallow
    // overwrite — `lastItem` below is taken AFTER normalization so the
    // cursor encoder sees the same value the client received.
    items.forEach((d) => { d.reportDate = toDateOnly(d.reportDate); });
    const lastItem = items[items.length - 1];
    // reportDate is @db.Date in Postgres — Prisma sometimes returns it as
    // a "YYYY-MM-DD" string rather than a JS Date (depends on column type
    // and Prisma client version). Coerce defensively so cursor building
    // doesn't throw "reportDate.toISOString is not a function" and turn a
    // >20-row result set into a 500 (Code Reviewer P2-3).
    // DR-008: route the encoder through the unified cursor codec so the
    // wire format round-trips through the same decoder.
    let nextCursor = null;
    if (hasMore && lastItem && lastItem.reportDate != null && lastItem.id) {
      try {
        nextCursor = encodeCursor(lastItem.reportDate, lastItem.id);
      } catch (e) {
        console.error('DPR cursor encode failed', { err: e.message });
        nextCursor = null;
      }
    }

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

// ─── GET /api/dpr/stats ────────────────────────────────────────────────────
// DR-029 (round-20): explicit aggregate counts for the admin dashboard.
//
// Before this endpoint existed, the DprDashboard read four paginated lists
// (limit=20) and used the response length as the count. With more than 20
// records the numbers were silently capped at 20; the labels claimed "Today"
// / "Approved" / "Total Active" but the request had no date or status scope,
// so the counts were whatever 20 records happened to come back.
//
// This endpoint runs six targeted COUNT queries against indexed columns
// (reportDate, status) using an explicit [today UTC, tomorrow UTC) window so
// the count matches the user-visible label. Counts run in parallel.
//
// Admin-only — a non-admin can derive similar numbers via /api/dpr with
// submittedById=me, but the admin dashboard tiles are scope-less and the
// wider org totals are not something a regular engineer should be able to
// scrape. requireFreshAdmin is used (falls back to requireAdmin if the
// import was unavailable in older builds) so a demoted admin can't read
// org totals from a stale JWT.
//
// Response shape is the documented contract — see docs/dashboard-metrics.md.
// Any change here MUST be mirrored there so the labels stay honest.
// requireFreshAdmin is exported from middleware/auth.js; if a future build
// drops it (or tests mount this module without it) we fall back to
// requireAdmin — both reject non-admin tokens, only requireFreshAdmin
// re-reads isAdmin from the DB on each call.
const dprStatsAdminGuard = requireFreshAdmin || requireAdmin;

// LIVE-DISCOVERED (round-20): /stats MUST be registered BEFORE /:id or
// Express routes GET /api/dpr/stats through :id with id='stats', which
// runs `prisma.dPR.findUnique({where:{id:'stats'}})` → null → 404. That
// 404 was firing on every poll cycle from the admin DPR dashboard, which
// surfaced as a "NOT_FOUND" toast-spam storm on /portal/admin/dpr. The
// old location (after /:id) was load-bearing-broken in production.
// Inspection routes need the same fix (see inspection.js).
//
// We use a single [start, end) UTC window for "today". reportDate is
// @db.Date in Postgres, so the comparison is on the date portion only.
// start = today UTC midnight; end = tomorrow UTC midnight. Anything dated
// earlier than today but transitioned today (APPROVED, REJECTED) is counted
// in the *Today variants via the transition timestamps on the same row.
// Mounted AFTER `router.use(requireAuth)` at line 256, so the token is
// already verified by the time this handler runs — dprStatsAdminGuard
// only needs to confirm the admin claim.
router.get('/stats', dprStatsAdminGuard, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  // Build the [start, end) window for "today" once and reuse for all six
  // counts.
  //
  // LPR-013: window is now derived from the IST business date, not from
  // UTC midnight. `getTodayBusinessDate()` returns the UTC midnight of
  // the IST calendar day (`2026-09-03T00:00:00.000Z` for an instant
  // inside IST day 2026-09-03) — same shape the `reportDate` `@db.Date`
  // column is stored under, so the half-open [gte, lt) query semantics
  // land on the correct calendar day for an India-based workforce.
  // The previous `setUTCHours(0,0,0,0)` was wrong: between 00:00 and
  // 05:29 IST (= 18:30–00:00 UTC of the prior day) a DPR filed in IST
  // was being counted under yesterday's UTC bucket; between 18:30 UTC
  // and midnight UTC (= 00:00–05:30 IST the next day) a tomorrow-filed
  // IST DPR was already counted under today. The IST helper closes both
  // windows.
  const startOfToday = getTodayBusinessDate();
  const endOfToday = new Date(startOfToday);
  endOfToday.setUTCDate(endOfToday.getUTCDate() + 1);

  // Count queries run in parallel — each is a single COUNT() against an
  // indexed column. Worst case: six tiny aggregates, ~tens of ms total.
  // `transition` timestamps use `gte`/`lt` against today, not the date
  // column — those are DateTime columns, so the equality semantics differ.
  const [
    submittedToday,
    approvedToday,
    rejectedToday,
    pendingReview,
    draftCount,
    totalActive,
  ] = await Promise.all([
    // submittedToday: reportDate = today AND status = SUBMITTED.
    // reportDate is a Date column, so { gte: today, lt: tomorrow } matches
    // the whole day.
    prisma.dPR.count({
      where: {
        status: 'SUBMITTED',
        reportDate: { gte: startOfToday, lt: endOfToday },
      },
    }),
    // approvedToday: rows that TRANSITIONED to APPROVED today. The
    // transition timestamp is approvedAt, not reportDate — a DPR filed last
    // week can be approved today, and a DPR filed today can be approved
    // tomorrow. Matching the label "Approved Today" requires the
    // transition timestamp.
    prisma.dPR.count({
      where: {
        status: 'APPROVED',
        approvedAt: { gte: startOfToday, lt: endOfToday },
      },
    }),
    // rejectedToday: rows transitioned to REJECTED today (reviewedAt is
    // the terminal transition timestamp for both APPROVED and REJECTED —
    // the reject path sets reviewedAt alongside status=REJECTED).
    prisma.dPR.count({
      where: {
        status: 'REJECTED',
        reviewedAt: { gte: startOfToday, lt: endOfToday },
      },
    }),
    // pendingReview: anything not in a terminal state. Counts every DPR in
    // the org that an admin could still pick up — SUBMITTED + UNDER_REVIEW.
    prisma.dPR.count({
      where: { status: { in: ['SUBMITTED', 'UNDER_REVIEW'] } },
    }),
    // draftCount: drafts in the org (engineers still typing).
    prisma.dPR.count({ where: { status: 'DRAFT' } }),
    // totalActive: every non-terminal DPR (DRAFT + SUBMITTED + UNDER_REVIEW).
    // The dashboard label is "Total Active DPRs" — terminal rows (APPROVED /
    // REJECTED) are excluded because they're done.
    prisma.dPR.count({
      where: { status: { in: ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW'] } },
    }),
  ]);

  res.json({
    submittedToday,
    approvedToday,
    rejectedToday,
    pendingReview,
    draftCount,
    totalActive,
    window: {
      // Echo back the window so the client can render "as of <ts>" if it
      // wants to — useful for diagnosing clock-skew between server and DB.
      // LPR-013: timezone is now the IST business day (was 'UTC'). The
      // instant values are unchanged shape — UTC midnights of consecutive
      // IST calendar days — but the label tells the reader which day
      // boundary is in effect so a future debugger doesn't have to
      // re-derive it.
      start: startOfToday.toISOString(),
      end: endOfToday.toISOString(),
      timezone: 'Asia/Kolkata',
    },
  });
}));

// ─── GET /api/dpr/:id ────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;

  try {
    const dpr = await prisma.dPR.findUnique({
      where: { id },
      include: {
        // P0-1: include the parent DPR's submittedById on each photo so the
        // read-SAS can rebuild the `${employeeId}/${ulid}.${ext}` tenant
        // prefix that the upload (blobStorage.js:66) wrote under. Without
        // this, every photo GET 404s and we lose the primary business
        // value (DPR photos).
        photos: {
          include: { dpr: { select: { submittedById: true } } },
        },
        submittedBy: { select: { id: true, name: true, email: true } },
        reviewedBy: { select: { id: true, name: true, email: true } },
        approvedBy: { select: { id: true, name: true, email: true } },
        revisions: {
          orderBy: { version: 'desc' },
          select: { id: true, version: true, changedAt: true, changedById: true },
        },
        // Round-12: linked Inspection & Compliance records (FK dprId). The
        // list/detail UI uses this to render the summary card on the DPR
        // and the "Linked Inspections" section on the detail modal.
        inspections: {
          select: { id: true, inspectionType: true, status: true, severity: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
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
    //
    // P0-1: The blob name must mirror the upload shape exactly
    // (blobStorage.js:66: `${employeeId}/${ulid}.${ext}`). The DPR owner
    // is `dpr.submittedById`; we fall back to it from `p.dpr.submittedById`
    // because the include above pulls it onto each photo row.
    const dprOwnerId = dpr.submittedById;
    const photosWithUrls = await Promise.all(dpr.photos.map(async p => {
      const ext = CONTENT_TYPE_EXT[p.contentType];
      const employeeId = (p.dpr && p.dpr.submittedById) || dprOwnerId;
      const blobName = ext
        ? `${employeeId}/${p.ulid}.${ext}`
        : `${employeeId}/${p.ulid}`;
      const { sasUrl } = await generateReadSASUrl(p.container, blobName);
      // Strip the helper join before sending to the client
      const { dpr: _dprJoin, ...photoForClient } = p;
      return { ...photoForClient, readUrl: sasUrl };
    }));

    // SOL DR-004: normalize the `reportDate` field to strict YYYY-MM-DD so
    // the frontend's `<input type="date">` accepts the value directly.
    // Previously this emitted `Date.toJSON()` ("2026-09-01T00:00:00.000Z"),
    // which the input rejected as malformed and the user had to retype the
    // date by hand. Matches the PUT validator's `parseStrictISODate`.
    const responseBody = {
      ...dpr,
      reportDate: toDateOnly(dpr.reportDate),
      photos: photosWithUrls,
    };

    res.json(responseBody);
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
//
// LPR-008: the conditional update WHERE (below) pins the CLIENT-supplied
// `version` (taken from `req.body`), not the just-read `existing.version`.
// The previous predicate was self-defeating: a client whose fresh view of
// the row shows version=N could send {version: N, ...edits}. We read the
// row, saw it was at version=N (matching), then conditionally updated
// WHERE version = existing.version (= N). If no one else mutated in
// between, the update succeeded — silently overwriting a row that another
// writer had ALREADY advanced past us, but that hadn't yet written when
// our read happened. Pinning the client version rejects that stale
// reader's update with P2025 → 409 VERSION_CONFLICT.
//
// The status pin in the same WHERE clause is the older DR-006 race fix:
// a concurrent admin /review can move DRAFT → UNDER_REVIEW between our
// read and our update, and without the status pin we'd silently land on
// top of the in-review row. Same wire code (409 VERSION_CONFLICT) for
// both races; both signal "the row moved, refetch and retry".
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
  // Round-12: extended with the 5 daily-narrative PMC fields + customSections.
  const ALLOWED_UPDATE_FIELDS = [
    'projectName', 'location', 'reportDate', 'weather', 'temperature',
    'contractor', 'workType', 'notes', 'workEntries',
    'workExecutedToday', 'workLocation', 'manpowerSummary',
    'risksHindrances', 'materialsReceivedSummary', 'customSections',
  ];
  const unknown = Object.keys(fields).filter(k => !ALLOWED_UPDATE_FIELDS.includes(k));
  if (unknown.length) {
    return res.status(400).json({
      error: 'UNKNOWN_FIELDS',
      message: `Fields not allowed: ${unknown.join(', ')}`,
      fields: unknown,
    });
  }

  // Length caps on the allowed fields too. Same caps as POST.
  const MAX = {
    projectName: 200, location: 200, weather: 80, temperature: 20, contractor: 200,
    notes: 5000,
    workExecutedToday: 1000, workLocation: 500, manpowerSummary: 1000,
    risksHindrances: 2000, materialsReceivedSummary: 1000,
  };
  for (const [k, cap] of Object.entries(MAX)) {
    if (fields[k] != null && typeof fields[k] === 'string' && fields[k].length > cap) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: `${k} exceeds ${cap} chars` });
    }
  }

  // customSections shape guard on PUT — same validator as POST. Setting it
  // to `null` (clearing all sections) is allowed and stored as DB NULL.
  if (fields.customSections !== undefined) {
    const sectionsCheck = validateCustomSections(fields.customSections);
    if (!sectionsCheck.ok) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: sectionsCheck.msg, field: 'customSections' });
    }
  }

  // reportDate must be strict YYYY-MM-DD if present
  if (fields.reportDate !== undefined) {
    const dp = parseStrictISODate(fields.reportDate);
    if (!dp.ok) return res.status(400).json({ error: 'INVALID_REPORT_DATE', message: 'reportDate must be YYYY-MM-DD' });
    fields.reportDate = dp.date;
    // DR-027: same no-future rule as POST — otherwise an edit is a trivial
    // bypass of the create-time check (submit today's DPR, then PUT it to
    // tomorrow). This route is owner-gated rather than admin-gated, so the
    // override only ever applies when the owner is themselves an admin;
    // `req.isAdmin` comes from the JWT claim set by requireAuth.
    if (rejectIfFutureReportDate(req, res, fields.reportDate, 'dpr.update')) return;
  }

  // Only owner can update
  const existing = await prisma.dPR.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'DPR not found' });
  }
  if (existing.submittedById !== req.employeeId) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only owner can update' });
  }

  // DR-006 (round-20): terminal states are immutable. APPROVED and
  // REJECTED represent decisions an admin made on the submitted DPR —
  // the owner editing them afterwards would silently rewrite the audit
  // trail (the photos / notes / reportDate that were on file when the
  // admin decided). Status transitions are the only legal way out of a
  // terminal state, and they go through /approve, /reject, /review —
  // not PUT.
  if (existing.status === 'APPROVED' || existing.status === 'REJECTED') {
    return res.status(409).json({
      error: `Cannot edit a DPR in status ${existing.status}`,
      code: 'INVALID_TRANSITION',
      currentStatus: existing.status,
    });
  }

  try {
    // DR-006 (round-20) + LPR-008: tighten the conditional update WHERE
    // to pin the CLIENT-supplied `version` (so a stale reader's update
    // is rejected with P2025 → 409 VERSION_CONFLICT instead of silently
    // overwriting a row that another writer has already advanced) AND
    // the status we read (a concurrent admin /review could move status
    // DRAFT → UNDER_REVIEW between our read and our update; pinning both
    // makes that race safe too). Same wire code (VERSION_CONFLICT) for
    // both races — both signal "the row moved, refetch and retry".
    const updated = await prisma.dPR.update({
      where: {
        id,
        version,
        status: existing.status,
      },
      data: {
        ...fields,
        version: { increment: 1 },
        updatedAt: new Date(),
      },
      include: {
        photos: true,
        submittedBy: { select: { id: true, name: true, email: true } },
        inspections: { select: { id: true, inspectionType: true, status: true, severity: true } },
      },
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

// ─── DELETE /api/dpr/:id ────────────────────────────────────────────────────
// SOL-P0#4: owners can delete their own DRAFT DPRs (no admin involvement).
// Terminal/submitted states are immutable: deleting an in-review or already-
// approved record would rewrite the audit trail. Cascade through DPRPhoto +
// DPRRevision (per schema) and null the dprId on linked InspectionRecord rows
// (so they survive but lose the draft linkage).
router.delete('/:id', async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;

  const existing = await prisma.dPR.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'NOT_FOUND', message: 'DPR not found' });
  if (existing.submittedById !== req.employeeId) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only owner can delete' });
  }
  if (existing.status !== 'DRAFT') {
    return res.status(409).json({
      error: 'INVALID_TRANSITION',
      code: 'INVALID_TRANSITION',
      message: `Only DRAFT DPRs can be deleted (current status: ${existing.status}).`,
      currentStatus: existing.status,
    });
  }

  try {
    await prisma.$transaction([
      // Null the dprId on any inspections that referenced this draft so they
      // survive as standalone records (their own photo cascade handles itself).
      prisma.inspectionRecord.updateMany({
        where: { dprId: id },
        data: { dprId: null },
      }),
      prisma.dPR.delete({ where: { id } }),
    ]);
    res.json({ deleted: true, id });
  } catch (err) {
    console.error('DPR delete error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) {
      return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    }
    res.status(500).json({ error: 'Failed to delete DPR' });
  }
});

// ─── POST /api/dpr/:id/review ───────────────────────────────────────────────
// ─── Admin state-machine helpers (round-7 hardening) ──────────────────────────
//
// Three fixes baked into the helpers below:
//
//   1. ATOMICITY: revision-snapshot + status-update + owner-notification run
//      inside prisma.$transaction so a DB blip can't leave a partial state.
//   2. RACE-SAFETY: the status update is CONDITIONAL on the status+version
//      we read; if a concurrent admin click or user edit changed it, Prisma
//      throws P2025 which we translate to 409 VERSION_CONFLICT.
//   3. STATE MACHINE: explicit allowed-source-status sets prevent silent
//      REJECTED → APPROVED transitions (which previously broke the audit
//      trail when a stale admin view re-clicked "Approve" on a re-loaded row).
//
// SSE emitNotification stays OUTSIDE the transaction — SSE is a side effect,
// not a DB write; firing it inside the txn would couple the listener's
// delivery to the DB commit.
//
// Admin status is taken from the JWT (req.isAdmin), set by requireAuth.
// requireAdmin middleware would also gate this, but we keep inline checks
// so the route still reads self-evidently.

const APPROVABLE_FROM = new Set(['DRAFT', 'SUBMITTED', 'UNDER_REVIEW']);
const REVIEWABLE_FROM = new Set(['DRAFT', 'SUBMITTED', 'UNDER_REVIEW']);
const REJECTABLE_FROM = new Set(['DRAFT', 'SUBMITTED', 'UNDER_REVIEW']);

const DPR_INCLUDE = {
  photos: true,
  submittedBy: { select: { id: true, name: true, email: true } },
};

const formatReportDate = (d) => {
  // Defensive: reportDate may deserialize as Date or "YYYY-MM-DD" string
  // depending on Prisma client version + column type.
  if (d instanceof Date) return d.toISOString().split('T')[0];
  return String(d);
};

// LPR-007: review is a mutation, so requireFreshAdmin re-reads
// Employee.isAdmin from the database instead of trusting the JWT's
// req.isAdmin claim (which can be up to 15 minutes stale). Inline
// `if (!req.isAdmin)` checks below are no longer needed — the
// middleware rewrites req.isAdmin and 403s first.
router.post('/:id/review', requireFreshAdmin, async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;
  const { adminNotes } = req.body || {};

  try {
    const dpr = await prisma.dPR.findUnique({
      where: { id },
      include: DPR_INCLUDE,
    });
    if (!dpr) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'DPR not found' });
    }

    if (!REVIEWABLE_FROM.has(dpr.status)) {
      return res.status(409).json({
        error: 'INVALID_TRANSITION',
        message: `Cannot move DPR from ${dpr.status} to UNDER_REVIEW`,
        code: 'INVALID_TRANSITION',
      });
    }

    // Round-25d fix: hoist `notifMessage` to outer scope so the fanOutEmail
    // call below can read it. It is assigned inside the `$transaction` async
    // callback but referenced after the tx resolves. A `const` declared inside
    // the tx callback would be out of scope by the time fanOutEmail runs
    // (ReferenceError: notifMessage is not defined). Same pattern repeats in
    // /:id/approve, /:id/reject, and /bulk-review — the outer `let` +
    // inner bare assignment is the minimum-diff fix that keeps the existing
    // message-building logic exactly where it was.
    let notifMessage;

    const updated = await prisma.$transaction(async (tx) => {
      const conditionalUpdate = await tx.dPR.update({
        where: { id, status: dpr.status, version: dpr.version },
        data: {
          status: 'UNDER_REVIEW',
          reviewedById: req.employeeId,
          reviewedAt: new Date(),
          version: { increment: 1 },
        },
      });
      // If the WHERE didn't match, P2025 fires; we map it to VERSION_CONFLICT.
      if (!conditionalUpdate) throw Object.assign(new Error('version conflict'), { code: 'P2025' });

      await tx.dPRRevision.create({
        data: {
          dprId: id,
          version: dpr.version,
          snapshot: dpr,
          changedById: req.employeeId,
        },
      });

      notifMessage = `Your DPR for ${dpr.projectName} on ${formatReportDate(dpr.reportDate)} was reviewed. ${adminNotes || ''}`.trim();
      await tx.notification.create({
        data: {
          employeeId: dpr.submittedById,
          type: 'DPR_REVIEWED',
          dprId: id,
          message: notifMessage,
        },
      });

      return tx.dPR.findUnique({
        where: { id },
        include: {
          photos: true,
          submittedBy: { select: { id: true, name: true, email: true } },
          reviewedBy: { select: { id: true, name: true, email: true } },
        },
      });
    });

    emitNotification(dpr.submittedById, 'notification', {
      id: Date.now(),
      type: 'DPR_REVIEWED',
      dprId: id,
      message: `Your DPR for ${dpr.projectName} was reviewed`,
      createdAt: new Date().toISOString(),
    });
    fanOutEmail({
      id: null, // tx-row id not returned by the create; EmailLog.notificationId is SetNull-able
      employeeId: dpr.submittedById,
      type: 'DPR_REVIEWED',
      dprId: id,
      message: notifMessage,
    }, prisma, { projectName: dpr.projectName, reportDate: formatReportDate(dpr.reportDate) });

    res.json(updated);
  } catch (err) {
    console.error('DPR review error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    if (err.code === 'P2025') {
      return res.status(409).json({
        error: 'DPR was modified by another action. Please refresh and try again.',
        code: 'VERSION_CONFLICT',
      });
    }
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to review DPR' });
  }
});

// ─── POST /api/dpr/:id/approve ───────────────────────────────────────────────
// Terminal state: DRAFT|SUBMITTED|UNDER_REVIEW -> APPROVED. Admin only.
//
// LPR-007: approval is a mutation; requireFreshAdmin re-reads isAdmin
// from the DB so a freshly demoted admin can't push approvals until
// their JWT expires.
router.post('/:id/approve', requireFreshAdmin, async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;
  const { adminNotes } = req.body || {};

  try {
    const dpr = await prisma.dPR.findUnique({
      where: { id },
      include: DPR_INCLUDE,
    });
    if (!dpr) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'DPR not found' });
    }

    if (!APPROVABLE_FROM.has(dpr.status)) {
      return res.status(409).json({
        error: 'INVALID_TRANSITION',
        message: `Cannot approve a DPR in status ${dpr.status}`,
        code: 'INVALID_TRANSITION',
      });
    }

    // Round-25d: hoist `notifMessage` to outer scope. See /:id/review for the
    // full explanation — this handler bit a live user on 2026-09-04 (Render
    // log: `DPR approve error { message: 'notifMessage is not defined' }`).
    let notifMessage;

    const updated = await prisma.$transaction(async (tx) => {
      const conditionalUpdate = await tx.dPR.update({
        where: { id, status: dpr.status, version: dpr.version },
        data: {
          status: 'APPROVED',
          approvedById: req.employeeId,
          approvedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (!conditionalUpdate) throw Object.assign(new Error('version conflict'), { code: 'P2025' });

      await tx.dPRRevision.create({
        data: {
          dprId: id,
          version: dpr.version,
          snapshot: dpr,
          changedById: req.employeeId,
        },
      });

      notifMessage = `Your DPR for ${dpr.projectName} on ${formatReportDate(dpr.reportDate)} was approved. ${adminNotes || ''}`.trim();
      await tx.notification.create({
        data: {
          employeeId: dpr.submittedById,
          type: 'DPR_APPROVED',
          dprId: id,
          message: notifMessage,
        },
      });

      return tx.dPR.findUnique({
        where: { id },
        include: {
          photos: true,
          submittedBy: { select: { id: true, name: true, email: true } },
          approvedBy: { select: { id: true, name: true, email: true } },
        },
      });
    });

    emitNotification(dpr.submittedById, 'notification', {
      id: Date.now(),
      type: 'DPR_APPROVED',
      dprId: id,
      message: `Your DPR for ${dpr.projectName} was approved`,
      createdAt: new Date().toISOString(),
    });
    fanOutEmail({
      id: null,
      employeeId: dpr.submittedById,
      type: 'DPR_APPROVED',
      dprId: id,
      message: notifMessage,
    }, prisma, { projectName: dpr.projectName, reportDate: formatReportDate(dpr.reportDate) });

    res.json(updated);
  } catch (err) {
    console.error('DPR approve error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    if (err.code === 'P2025') {
      return res.status(409).json({
        error: 'DPR was modified by another action. Please refresh and try again.',
        code: 'VERSION_CONFLICT',
      });
    }
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to approve DPR' });
  }
});

// ─── POST /api/dpr/:id/reject ────────────────────────────────────────────────
// Terminal state: DRAFT|SUBMITTED|UNDER_REVIEW -> REJECTED. Admin only.
// Requires a reason so the owner knows what to fix.
//
// LPR-007: reject is a mutation; requireFreshAdmin re-reads isAdmin
// from the DB so a demoted admin cannot reject on a stale JWT.
router.post('/:id/reject', requireFreshAdmin, async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;
  const { reason, adminNotes } = req.body || {};

  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    return res.status(400).json({ error: 'REASON_REQUIRED', message: 'A reason is required to reject a DPR' });
  }
  if (reason.length > 1000) {
    return res.status(400).json({ error: 'REASON_TOO_LONG', message: 'Reason must be <= 1000 chars' });
  }
  if (adminNotes && typeof adminNotes === 'string' && adminNotes.length > 2000) {
    return res.status(400).json({ error: 'NOTES_TOO_LONG', message: 'adminNotes must be <= 2000 chars' });
  }

  try {
    const dpr = await prisma.dPR.findUnique({
      where: { id },
      include: DPR_INCLUDE,
    });
    if (!dpr) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'DPR not found' });
    }

    if (!REJECTABLE_FROM.has(dpr.status)) {
      return res.status(409).json({
        error: 'INVALID_TRANSITION',
        message: `Cannot reject a DPR in status ${dpr.status}`,
        code: 'INVALID_TRANSITION',
      });
    }

    // Round-25d: hoist `notifMessage` to outer scope. See /:id/review for the
    // full explanation — same scope bleed across the $transaction callback.
    let notifMessage;

    const updated = await prisma.$transaction(async (tx) => {
      const conditionalUpdate = await tx.dPR.update({
        where: { id, status: dpr.status, version: dpr.version },
        data: {
          status: 'REJECTED',
          reviewedById: req.employeeId,
          reviewedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (!conditionalUpdate) throw Object.assign(new Error('version conflict'), { code: 'P2025' });

      await tx.dPRRevision.create({
        data: {
          dprId: id,
          version: dpr.version,
          snapshot: dpr,
          changedById: req.employeeId,
        },
      });

      const combinedNotes = [reason.trim(), adminNotes].filter(Boolean).join('\n\n');
      notifMessage = `Your DPR for ${dpr.projectName} on ${formatReportDate(dpr.reportDate)} was rejected: ${reason.trim()}${adminNotes ? `\n${adminNotes}` : ''}`.trim();
      await tx.notification.create({
        data: {
          employeeId: dpr.submittedById,
          type: 'DPR_REJECTED',
          dprId: id,
          message: notifMessage,
        },
      });

      const result = await tx.dPR.findUnique({
        where: { id },
        include: {
          photos: true,
          submittedBy: { select: { id: true, name: true, email: true } },
          reviewedBy: { select: { id: true, name: true, email: true } },
        },
      });
      // Attach the combined notes for the response so the admin UI doesn't
      // need a separate fetch.
      return { ...result, _combinedNotes: combinedNotes };
    });

    const { _combinedNotes, ...dprForClient } = updated;
    emitNotification(dpr.submittedById, 'notification', {
      id: Date.now(),
      type: 'DPR_REJECTED',
      dprId: id,
      message: `Your DPR for ${dpr.projectName} was rejected`,
      reason: _combinedNotes,
      createdAt: new Date().toISOString(),
    });
    fanOutEmail({
      id: null,
      employeeId: dpr.submittedById,
      type: 'DPR_REJECTED',
      dprId: id,
      message: notifMessage,
    }, prisma, { projectName: dpr.projectName, reportDate: formatReportDate(dpr.reportDate), reason: _combinedNotes });

    res.json(dprForClient);
  } catch (err) {
    console.error('DPR reject error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    if (err.code === 'P2025') {
      return res.status(409).json({
        error: 'DPR was modified by another action. Please refresh and try again.',
        code: 'VERSION_CONFLICT',
      });
    }
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to reject DPR' });
  }
});

// ─── POST /api/dpr/bulk-review (Round-17 B-06) ──────────────────────────────
//
// Fan out an admin action (APPROVE | REJECT | UNDER_REVIEW) over a list of
// DPR IDs. Per-ID transaction so one failure doesn't roll back the rest of
// the batch — the admin UI shows per-row success/failure.
//
// Each ID goes through the SAME status-machine + version-conditional update
// as the single endpoint above, so the audit trail (DPRRevision +
// Notification rows) is identical whether the action came from the per-row
// menu or this batch.
//
// Cap: 100 IDs per call. A larger batch is a UI mistake (the queue never
// renders 100 rows on one screen) and would tie up a request for too long.

const BULK_ALLOWED_ACTIONS = new Set(['APPROVE', 'REJECT', 'UNDER_REVIEW']);
const BULK_MAX_IDS = 100;

// LPR-007: bulk-review is a mutation; requireFreshAdmin re-reads
// Employee.isAdmin from the DB once per request so a freshly demoted
// admin cannot flood in stale-JWT decisions across a batch.
router.post('/bulk-review', requireFreshAdmin, async (req, res) => {
  const prisma = getPrisma(req);
  const { ids, action, reason, adminNotes } = req.body || {};

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'ids must be a non-empty array' });
  }
  if (ids.length > BULK_MAX_IDS) {
    return res.status(400).json({
      error: 'BATCH_TOO_LARGE',
      message: `Cannot process more than ${BULK_MAX_IDS} IDs in a single batch`,
    });
  }
  if (ids.some((id) => typeof id !== 'string' || !id.trim())) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'All ids must be non-empty strings' });
  }
  if (!BULK_ALLOWED_ACTIONS.has(action)) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: `action must be one of: ${[...BULK_ALLOWED_ACTIONS].join(', ')}`,
    });
  }
  if (action === 'REJECT') {
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({ error: 'REASON_REQUIRED', message: 'A reason is required to reject DPRs' });
    }
    if (reason.length > 1000) {
      return res.status(400).json({ error: 'REASON_TOO_LONG', message: 'Reason must be <= 1000 chars' });
    }
  }
  if (adminNotes && (typeof adminNotes !== 'string' || adminNotes.length > 2000)) {
    return res.status(400).json({ error: 'NOTES_TOO_LONG', message: 'adminNotes must be <= 2000 chars' });
  }

  // De-duplicate the input — same ID listed twice would double-fire notifications.
  const uniqueIds = [...new Set(ids)];

  const succeeded = [];
  const failed = [];

  // Per-ID transaction. We don't wrap the whole batch in one $transaction
  // because a single failure (e.g. one record already REJECTED) shouldn't
  // roll back 99 successful updates.
  for (const id of uniqueIds) {
    try {
      // Round-25d: hoist `notifMessage` to outer scope so the fanOutEmail
      // call below the tx can read what the if/else branches assigned inside
      // the tx. Same scope-bleed fix as the single-record handlers.
      let notifMessage;

      const result = await prisma.$transaction(async (tx) => {
        const dpr = await tx.dPR.findUnique({ where: { id }, include: DPR_INCLUDE });
        if (!dpr) {
          throw Object.assign(new Error('DPR not found'), { _code: 'NOT_FOUND', _status: 404 });
        }

        let allowedFrom;
        let nextStatus;
        let updateData;
        let notifType;
        // notifMessage now declared OUTSIDE the tx callback (above) — assigned below.

        if (action === 'APPROVE') {
          allowedFrom = APPROVABLE_FROM;
          nextStatus = 'APPROVED';
          updateData = {
            status: 'APPROVED',
            approvedById: req.employeeId,
            approvedAt: new Date(),
            version: { increment: 1 },
          };
          notifType = 'DPR_APPROVED';
          notifMessage = `Your DPR for ${dpr.projectName} on ${formatReportDate(dpr.reportDate)} was approved. ${adminNotes || ''}`.trim();
        } else if (action === 'REJECT') {
          allowedFrom = REJECTABLE_FROM;
          nextStatus = 'REJECTED';
          updateData = {
            status: 'REJECTED',
            reviewedById: req.employeeId,
            reviewedAt: new Date(),
            version: { increment: 1 },
          };
          notifType = 'DPR_REJECTED';
          notifMessage = `Your DPR for ${dpr.projectName} on ${formatReportDate(dpr.reportDate)} was rejected: ${reason.trim()}${adminNotes ? `\n${adminNotes}` : ''}`.trim();
        } else {
          // UNDER_REVIEW
          allowedFrom = REVIEWABLE_FROM;
          nextStatus = 'UNDER_REVIEW';
          updateData = {
            status: 'UNDER_REVIEW',
            reviewedById: req.employeeId,
            reviewedAt: new Date(),
            version: { increment: 1 },
          };
          notifType = 'DPR_REVIEWED';
          notifMessage = `Your DPR for ${dpr.projectName} on ${formatReportDate(dpr.reportDate)} was reviewed. ${adminNotes || ''}`.trim();
        }

        if (!allowedFrom.has(dpr.status)) {
          throw Object.assign(
            new Error(`Cannot move DPR from ${dpr.status} to ${nextStatus}`),
            { _code: 'INVALID_TRANSITION', _status: 409 }
          );
        }

        const conditionalUpdate = await tx.dPR.update({
          where: { id, status: dpr.status, version: dpr.version },
          data: updateData,
        });
        if (!conditionalUpdate) {
          throw Object.assign(new Error('version conflict'), { _code: 'VERSION_CONFLICT', _status: 409 });
        }

        await tx.dPRRevision.create({
          data: {
            dprId: id,
            version: dpr.version,
            snapshot: dpr,
            changedById: req.employeeId,
          },
        });

        await tx.notification.create({
          data: {
            employeeId: dpr.submittedById,
            type: notifType,
            dprId: id,
            message: notifMessage,
          },
        });

        return { id, newStatus: nextStatus, submittedById: dpr.submittedById, projectName: dpr.projectName };
      });

      // SSE emit outside the transaction.
      emitNotification(result.submittedById, 'notification', {
        id: Date.now(),
        type: `DPR_${result.newStatus === 'UNDER_REVIEW' ? 'REVIEWED' : result.newStatus}`,
        dprId: result.id,
        message: `Your DPR for ${result.projectName} was ${result.newStatus.toLowerCase().replace('_', ' ')}`,
        createdAt: new Date().toISOString(),
      });
      // Email fan-out mirrors the SSE payload. The actual notification row
      // id was created inside the tx and isn't returned, so we pass null —
      // EmailLog.notificationId is nullable (SetNull on delete) so audit
      // trails remain valid even when the underlying notification is pruned.
      fanOutEmail({
        id: null,
        employeeId: result.submittedById,
        type: `DPR_${result.newStatus === 'UNDER_REVIEW' ? 'REVIEWED' : result.newStatus}`,
        dprId: result.id,
        message: notifMessage,
      }, prisma, { projectName: result.projectName });

      succeeded.push({ id: result.id, newStatus: result.newStatus });
    } catch (err) {
      // Distinguish Prisma P2025 (conditional update missed) from our
      // pre-thrown tagged errors (NOT_FOUND / INVALID_TRANSITION).
      const code = err._code || (err.code === 'P2025' ? 'VERSION_CONFLICT' : 'INTERNAL');
      const status = err._status || (err.code === 'P2025' ? 409 : 500);
      failed.push({
        id,
        error: err.message?.split('\n')[0] || 'Unknown error',
        code,
        status,
      });
    }
  }

  res.json({
    total: uniqueIds.length,
    succeededCount: succeeded.length,
    failedCount: failed.length,
    succeeded,
    failed,
  });
});

// ─── GET /api/dpr/notifications/list ───────────────────────────────────────
// P0-2: Frontend NotificationBell calls `api.getNotifications(...)` which
// hits `GET /api/dpr/notifications?lastNotificationId=...` expecting a JSON
// body — but that path is mounted as a `text/event-stream` SSE handler. The
// JSON parser then throws inside a catch the bell treats as non-fatal and
// the bell silently shows "0 unread" forever.
//
// We KEEP the SSE stream at `/notifications` for the live feed (don't break
// the bell's push channel) and ADD this sibling JSON-list endpoint. The
// frontend is being patched separately to point `getNotifications` here.
router.get('/notifications/list', async (req, res) => {
  const prisma = getPrisma(req);
  const lastId = req.query.lastId;

  try {
    // Cursor pagination — `lastId` is the createdAt+id cursor from the
    // previous page. We bound it to 50 per page so a runaway client can't
    // pull the whole table.
    const where = { employeeId: req.employeeId };
    if (lastId) {
      // Defensive: lastId is "<ISO createdAt>|<notificationId>". Anything
      // malformed returns 400 instead of silently returning everything.
      const decoded = Buffer.from(String(lastId), 'base64').toString();
      const [cTs, cId] = decoded.split('|');
      const cDate = new Date(cTs);
      if (!cId || isNaN(cDate.getTime())) {
        return res.status(400).json({ error: 'INVALID_CURSOR', message: 'lastId is malformed or expired' });
      }
      where.OR = [
        { createdAt: { lt: cDate } },
        { createdAt: cDate, id: { lt: cId } },
      ];
    }

    const notifications = await prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        type: true,
        dprId: true,
        message: true,
        isRead: true,
        createdAt: true,
      },
    });

    const last = notifications[notifications.length - 1];
    const nextCursor = last
      ? Buffer.from(`${last.createdAt instanceof Date ? last.createdAt.toISOString() : new Date(last.createdAt).toISOString()}|${last.id}`).toString('base64')
      : null;

    res.json({ notifications, nextCursor });
  } catch (err) {
    console.error('Notifications list error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to list notifications' });
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
// Round-7: PDF generation is not yet implemented — the previous handler did a
// full DPR fetch + auth check then returned a placeholder JSON. That's
// misleading (200 OK suggests success) and wastes a DB roundtrip. Return
// 501 Not Implemented per RFC 7231 §6.6.2. Auth middleware has already run
// upstream (`requireAuth`), so we don't need to re-check permissions here —
// a logged-in user hitting this gets a clear "not built yet" signal.
//
// When PDF generation is built, replace this with the real handler.
router.post('/:id/pdf', (req, res) => {
  res.status(501).json({
    error: 'NOT_IMPLEMENTED',
    code: 'PDF_GENERATION_PENDING',
    message: 'PDF generation is not yet implemented. ' +
             'See backend/src/lib/pdfGenerator.js for the planned integration.',
  });
});


module.exports = router;
