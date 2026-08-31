// Inspection & Compliance Records — Round-12
//
// New resource that owns the 15 structured sub-work types formerly nested
// inside DPR.workEntries (material receipt, cube test, water quality,
// waterproofing inspection, villa inspection, NCR, safety violation, etc.).
// Each record has its own photos, FK back to its DPR (nullable — for
// filings on holidays / Sundays), and progresses through a workflow status.
//
// Auth model: same as DPR — any authenticated employee can create + view their
// own records; admins see all. Owner-only updates; status transitions for
// NCR / safety_violation are out of scope for this round (PMC expert
// recommended a full state machine — deferred per plan).

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const {
  generateULID, generateUploadSASUrl, generateReadSASUrl,
  verifyBlobExists, CONTENT_TYPE_EXT,
} = require('../lib/blobStorage');
const { mapPrismaError, parseStrictISODate, parseISODateTime } = require('../lib/errors');
const { hashIdentifier } = require('../lib/pii');

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function getPrisma(req) {
  return req.app.get('prisma');
}

// Mirror of the frontend SUB_WORK_TYPE_OPTIONS values in
// src/pages/portal/DprWorkTypes.jsx. Server is the source of truth — a
// client can't POST an unknown inspectionType and get past validation.
// `data` payload shape per type is defined by WORK_TYPE_FIELDS on the
// frontend; server-side we only enforce "must be a non-null object with
// no oversized string values" (full per-field validation is the
// frontend's job at submit time, plus shape-cap abuse prevention here).
const ALLOWED_INSPECTION_TYPES = new Set([
  // MATERIAL_RECEIPT
  'material_inspection', 'cement_receipt', 'steel_receipt',
  'bulk_materials', 'concrete_receipt', 'other_bulk_materials',
  // QUALITY_TESTING
  'water_quality', 'cube_casting', 'cube_testing',
  // SITE_INSPECTION
  'villa_inspection', 'day_activity_inspection', 'waterproofing_inspection',
  // EXCEPTIONS_SAFETY
  'major_deviation', 'ncr', 'safety_violation',
]);

const ALLOWED_STATUSES = new Set([
  'OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'PENDING_VERIFICATION', 'CLOSED', 'REJECTED',
]);

const ALLOWED_SEVERITIES = new Set(['MINOR', 'MAJOR', 'CRITICAL', null]);

// Walk an arbitrary JSON object and cap every string value at `max` chars.
// Stops a malicious client from POSTing { data: { someField: '<2GB string>' } }
// and blowing up the row. Returns a list of violation paths so the error
// message is actionable (frontend can highlight the offending cell).
function findOversizedStrings(node, path, max, out = []) {
  if (node == null) return out;
  if (typeof node === 'string') {
    if (node.length > max) out.push(`${path} (${node.length} chars > ${max})`);
    return out;
  }
  if (Array.isArray(node)) {
    // Cap row count at 1000 and per-element string length — protects against
    // a giant `data.checklist` or `data.testResults` array.
    if (node.length > 1000) out.push(`${path} (array length ${node.length} > 1000)`);
    for (let i = 0; i < Math.min(node.length, 1000); i++) {
      findOversizedStrings(node[i], `${path}[${i}]`, max, out);
    }
    return out;
  }
  if (typeof node === 'object') {
    const keys = Object.keys(node);
    if (keys.length > 200) out.push(`${path} (object keys ${keys.length} > 200)`);
    for (const k of keys.slice(0, 200)) {
      findOversizedStrings(node[k], `${path}.${k}`, max, out);
    }
  }
  return out;
}

// ─── Pending-upload registry (mirror of dpr.js) ────────────────────────────
// In-memory ulid → { employeeId, container, filename } so confirm-upload can
// verify ownership. Same TTL as dpr.js (20 min) — long enough for a slow
// mobile upload, short enough that the map can't grow unboundedly.
const pendingUploads = new Map();

// ─── POST /api/inspection/sas-url ───────────────────────────────────────────
router.post('/sas-url', async (req, res) => {
  const { filename, contentType } = req.body;

  if (!filename || !contentType) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'filename, contentType required' });
  }

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowedTypes.includes(contentType)) {
    return res.status(400).json({ error: 'INVALID_CONTENT_TYPE', message: 'Only image/jpeg, image/png, image/webp allowed' });
  }

  const ulid = generateULID();
  const container = 'inspection-photos';

  const { sasUrl, blobPath, expiresAt } = await generateUploadSASUrl(
    container, req.employeeId, ulid, contentType
  );

  pendingUploads.set(`${req.employeeId}:${ulid}`, {
    employeeId: req.employeeId,
    container,
    filename,
    contentType,
  });
  setTimeout(() => {
    pendingUploads.delete(`${req.employeeId}:${ulid}`);
  }, 20 * 60 * 1000).unref();

  res.json({ sasUrl, ulid, blobPath, expiresAt });
});

// ─── POST /api/inspection/confirm-upload ────────────────────────────────────
router.post('/confirm-upload', async (req, res) => {
  const { ulid, filename, contentType, sizeBytes } = req.body;

  if (!ulid || !filename || !contentType || sizeBytes === undefined) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'All fields required' });
  }

  const MAX_PHOTO_SIZE = 10 * 1024 * 1024;
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

  try {
    const ext = CONTENT_TYPE_EXT[contentType];
    const blobName = `${req.employeeId}/${ulid}.${ext}`;
    const props = await verifyBlobExists('inspection-photos', blobName);
    if (!props.exists) {
      return res.status(404).json({ error: 'BLOB_NOT_UPLOADED', message: 'Photo bytes not found in storage' });
    }
    if (props.contentType && props.contentType !== contentType) {
      return res.status(400).json({ error: 'CONTENT_TYPE_MISMATCH', message: 'Uploaded content-type does not match request' });
    }
    if (Math.abs((props.contentLength || 0) - sizeBytes) > 1024) {
      return res.status(400).json({ error: 'SIZE_MISMATCH', message: 'Uploaded size does not match declared size' });
    }
  } catch (err) {
    console.error('Inspection blob verification failed', {
      employeeHash: hashIdentifier(req.employeeId),
      ulid,
      errMessage: err.message?.split('\n')[0],
    });
    return res.status(502).json({ error: 'BLOB_VERIFICATION_FAILED', message: 'Could not verify upload' });
  }

  pendingUploads.delete(pendingKey);
  res.json({ verified: true });
});

// All routes below require auth.
router.use(requireAuth);

// ─── POST /api/inspection ────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const prisma = getPrisma(req);
  const {
    projectName, location, reportDate, weather, contractor,
    dprId, inspectionType, data, severity, status, photos = [],
  } = req.body || {};

  // typeof guards (mirror dpr.js P1-2 — reject non-string types before Prisma).
  if (typeof projectName !== 'string' || !projectName.trim() ||
      typeof location !== 'string' || !location.trim() ||
      typeof reportDate !== 'string') {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'projectName, location, reportDate required' });
  }

  // Length caps (mirror dpr.js MAX map).
  const MAX = { projectName: 200, location: 200, weather: 80, contractor: 200 };
  for (const [k, cap] of Object.entries(MAX)) {
    if (req.body[k] != null && typeof req.body[k] === 'string' && req.body[k].length > cap) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: `${k} exceeds ${cap} chars` });
    }
  }

  // inspectionType allowlist — server is source of truth.
  if (!inspectionType || !ALLOWED_INSPECTION_TYPES.has(inspectionType)) {
    return res.status(422).json({
      error: `inspectionType must be one of: ${[...ALLOWED_INSPECTION_TYPES].join(', ')}`,
      code: 'INSPECTION_TYPE_INVALID',
      allowed: [...ALLOWED_INSPECTION_TYPES],
    });
  }

  // date validation — same strict YYYY-MM-DD parser as dpr.js.
  const dateParsed = parseStrictISODate(reportDate);
  if (!dateParsed.ok) {
    return res.status(400).json({ error: 'INVALID_REPORT_DATE', message: 'reportDate must be a valid YYYY-MM-DD date' });
  }
  const dateUTC = dateParsed.date;

  // severity — nullable, allowlist
  if (severity !== undefined && severity !== null && !ALLOWED_SEVERITIES.has(severity)) {
    return res.status(422).json({
      error: `severity must be one of: MINOR, MAJOR, CRITICAL`,
      code: 'SEVERITY_INVALID',
    });
  }

  // status — defaults to OPEN
  const finalStatus = status || 'OPEN';
  if (!ALLOWED_STATUSES.has(finalStatus)) {
    return res.status(422).json({
      error: `status must be one of: ${[...ALLOWED_STATUSES].join(', ')}`,
      code: 'STATUS_INVALID',
    });
  }

  // data — must be a non-null object; cap string values to prevent abuse.
  // Per-field validation (required-ness) is the frontend's job (mirrors how
  // DPR.workEntries was handled pre-refactor).
  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'data must be a JSON object' });
  }
  const oversized = findOversizedStrings(data, 'data', 5000);
  if (oversized.length) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: `data has oversized string fields: ${oversized.slice(0, 3).join('; ')}`,
      field: 'data',
    });
  }

  // dprId — optional, but if provided must be a valid UUID that exists.
  // The DPR doesn't have to belong to the submitter — site engineers may file
  // an inspection against another engineer's DPR (e.g. NCR during weekend).
  let dprConnect = undefined;
  if (dprId !== undefined && dprId !== null && dprId !== '') {
    if (typeof dprId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dprId)) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'dprId must be a UUID' });
    }
    const exists = await prisma.dPR.findUnique({ where: { id: dprId }, select: { id: true } });
    if (!exists) {
      return res.status(404).json({ error: 'DPR_NOT_FOUND', message: 'Linked DPR does not exist' });
    }
    dprConnect = { connect: { id: dprId } };
  }

  // photos — same shape as DPR photos but container must be 'inspection-photos'.
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
    if (p.container !== 'inspection-photos') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: `photos[${i}].container must be inspection-photos` });
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
    const record = await prisma.inspectionRecord.create({
      data: {
        projectName: projectName.trim(),
        location: location.trim(),
        reportDate: dateUTC,
        weather: weather || null,
        contractor: contractor || null,
        dprId: dprId || null,
        inspectionType,
        data,
        status: finalStatus,
        severity: severity || null,
        submittedById: req.employeeId,
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
        dpr: { select: { id: true, reportDate: true, projectName: true } },
      },
    });

    res.status(201).json(record);
  } catch (err) {
    console.error('Inspection create error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to create inspection record' });
  }
});

// ─── GET /api/inspection ────────────────────────────────────────────────────
// Supports filters: dprId, reportDate (YYYY-MM-DD or full ISO), inspectionType,
// status, severity, cursor (base64(reportDate|id)), limit (max 100).
// Non-admins are restricted to their own records; admins see all unless
// `my=true` is passed.
router.get('/', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { cursor, limit = '20', dprId, reportDate, inspectionType, status, severity, my } = req.query;

  const take = Math.min(parseInt(limit) || 20, 100);

  // Cursor: base64(reportDate|id)
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
    } catch {
      return res.status(400).json({ error: 'INVALID_CURSOR', message: 'Cursor could not be decoded' });
    }
  }

  // reportDate filter — accept exact YYYY-MM-DD or full ISO; falls back to Date.parse.
  let reportDateFilter = undefined;
  if (reportDate) {
    const strict = parseStrictISODate(reportDate);
    if (strict.ok) {
      // Match the whole day in UTC.
      const next = new Date(strict.date);
      next.setUTCDate(next.getUTCDate() + 1);
      reportDateFilter = { gte: strict.date, lt: next };
    } else {
      const dt = new Date(reportDate);
      if (isNaN(dt.getTime())) {
        return res.status(400).json({ error: 'INVALID_REPORT_DATE', message: 'reportDate must be a valid date' });
      }
      reportDateFilter = dt;
    }
  }

  try {
    const employee = await prisma.employee.findUnique({ where: { id: req.employeeId } });
    const isAdmin = employee && employee.isAdmin;
    const restrictToSelf = !isAdmin || my === 'true';

    const where = {
      ...(restrictToSelf ? { submittedById: req.employeeId } : {}),
      ...(dprId ? { dprId } : {}),
      ...(inspectionType ? { inspectionType } : {}),
      ...(status ? { status } : {}),
      ...(severity ? { severity } : {}),
      ...(reportDateFilter ? { reportDate: reportDateFilter } : {}),
      ...(cursor ? cursorWhere : {}),
    };

    const records = await prisma.inspectionRecord.findMany({
      where,
      include: {
        photos: { select: { id: true, caption: true, contentType: true, ulid: true, container: true } },
        submittedBy: { select: { id: true, name: true, email: true } },
        dpr: { select: { id: true, reportDate: true, projectName: true } },
      },
      orderBy: [{ reportDate: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });

    const hasMore = records.length > take;
    const items = hasMore ? records.slice(0, -1) : records;
    const lastItem = items[items.length - 1];
    const lastDate = lastItem && (lastItem.reportDate instanceof Date
      ? lastItem.reportDate
      : new Date(lastItem.reportDate));
    const nextCursor = hasMore && lastItem && lastDate && !isNaN(lastDate.getTime())
      ? Buffer.from(`${lastDate.toISOString()}|${lastItem.id}`).toString('base64')
      : null;

    res.setHeader('X-Total-Count', items.length);
    res.setHeader('X-Has-More', hasMore ? 'true' : 'false');
    res.json({ inspections: items, nextCursor });
  } catch (err) {
    console.error('Inspection list error', {
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to fetch inspections' });
  }
}));

// ─── GET /api/inspection/:id ────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;

  try {
    const record = await prisma.inspectionRecord.findUnique({
      where: { id },
      include: {
        // Same trick as dpr.js: include the parent record's submittedById on
        // each photo so read-SAS can rebuild the `${employeeId}/${ulid}.${ext}`
        // tenant prefix the upload wrote under.
        photos: {
          include: { inspection: { select: { submittedById: true } } },
        },
        submittedBy: { select: { id: true, name: true, email: true } },
        dpr: { select: { id: true, reportDate: true, projectName: true } },
      },
    });

    if (!record) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Inspection record not found' });
    }

    const employee = await prisma.employee.findUnique({ where: { id: req.employeeId } });
    const isAdmin = employee && employee.isAdmin;
    if (record.submittedById !== req.employeeId && !isAdmin) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Not authorized' });
    }

    // Generate read SAS URLs for photos — mirror dpr.js logic.
    const inspectionOwnerId = record.submittedById;
    const photosWithUrls = await Promise.all(record.photos.map(async p => {
      const ext = CONTENT_TYPE_EXT[p.contentType];
      const employeeId = (p.inspection && p.inspection.submittedById) || inspectionOwnerId;
      const blobName = ext
        ? `${employeeId}/${p.ulid}.${ext}`
        : `${employeeId}/${p.ulid}`;
      const { sasUrl } = await generateReadSASUrl(p.container, blobName);
      const { inspection: _join, ...photoForClient } = p;
      return { ...photoForClient, readUrl: sasUrl };
    }));

    res.json({ ...record, photos: photosWithUrls });
  } catch (err) {
    console.error('Inspection get error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to fetch inspection record' });
  }
});

// ─── PUT /api/inspection/:id ────────────────────────────────────────────────
// Owner-only update; only allowed while status = OPEN (locked once
// acknowledged or progressed). Same mass-assignment allowlist pattern as
// dpr.js P0-1 — explicit allowlist prevents IDOR on submittedById etc.
router.put('/:id', async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;
  const { version, ...fields } = req.body || {};

  if (!Number.isInteger(version) || version < 1) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'version must be a positive integer' });
  }

  const ALLOWED_UPDATE_FIELDS = [
    'projectName', 'location', 'reportDate', 'weather', 'contractor',
    'inspectionType', 'data', 'severity', 'status', 'dprId',
  ];
  const unknown = Object.keys(fields).filter(k => !ALLOWED_UPDATE_FIELDS.includes(k));
  if (unknown.length) {
    return res.status(400).json({
      error: 'UNKNOWN_FIELDS',
      message: `Fields not allowed: ${unknown.join(', ')}`,
      fields: unknown,
    });
  }

  // Length caps on string fields
  const MAX = { projectName: 200, location: 200, weather: 80, contractor: 200 };
  for (const [k, cap] of Object.entries(MAX)) {
    if (fields[k] != null && typeof fields[k] === 'string' && fields[k].length > cap) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: `${k} exceeds ${cap} chars` });
    }
  }

  if (fields.reportDate !== undefined) {
    const dp = parseStrictISODate(fields.reportDate);
    if (!dp.ok) return res.status(400).json({ error: 'INVALID_REPORT_DATE', message: 'reportDate must be YYYY-MM-DD' });
    fields.reportDate = dp.date;
  }

  if (fields.inspectionType !== undefined && !ALLOWED_INSPECTION_TYPES.has(fields.inspectionType)) {
    return res.status(422).json({ error: 'inspectionType not allowed', code: 'INSPECTION_TYPE_INVALID' });
  }
  if (fields.severity !== undefined && fields.severity !== null && !ALLOWED_SEVERITIES.has(fields.severity)) {
    return res.status(422).json({ error: 'severity not allowed', code: 'SEVERITY_INVALID' });
  }
  if (fields.status !== undefined && !ALLOWED_STATUSES.has(fields.status)) {
    return res.status(422).json({ error: 'status not allowed', code: 'STATUS_INVALID' });
  }
  if (fields.data !== undefined) {
    if (fields.data == null || typeof fields.data !== 'object' || Array.isArray(fields.data)) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'data must be a JSON object' });
    }
    const oversized = findOversizedStrings(fields.data, 'data', 5000);
    if (oversized.length) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: `data has oversized string fields: ${oversized.slice(0, 3).join('; ')}`,
        field: 'data',
      });
    }
  }

  // Owner check
  const existing = await prisma.inspectionRecord.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'Inspection record not found' });
  }
  if (existing.submittedById !== req.employeeId) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only owner can update' });
  }
  // Lock once the record leaves OPEN — status transitions need a dedicated
  // endpoint (out of scope for round-12 per the PMC expert's state-machine
  // recommendation deferred).
  if (existing.status !== 'OPEN') {
    return res.status(409).json({
      error: 'INSPECTION_LOCKED',
      code: 'INSPECTION_LOCKED',
      message: `Cannot edit a record in status ${existing.status}`,
    });
  }

  try {
    const updated = await prisma.inspectionRecord.update({
      where: { id, version: existing.version },
      data: {
        ...fields,
        version: { increment: 1 },
        updatedAt: new Date(),
      },
      include: {
        photos: true,
        submittedBy: { select: { id: true, name: true, email: true } },
        dpr: { select: { id: true, reportDate: true, projectName: true } },
      },
    });

    res.json(updated);
  } catch (err) {
    console.error('Inspection update error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    if (err.code === 'P2025') {
      return res.status(409).json({ error: 'VERSION_CONFLICT', code: 'VERSION_CONFLICT' });
    }
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to update inspection record' });
  }
});

module.exports = router;
