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
const { requireAuth, requireFreshAdmin, requireAdmin } = require('../middleware/auth');
const {
  generateReadSASUrl,
  CONTENT_TYPE_EXT,
} = require('../lib/blobStorage');
const { mapPrismaError, parseStrictISODate, parseISODateTime } = require('../lib/errors');
const { mountUploadRoutes } = require('../lib/uploadRoutes');
// [S3-7] Consumption half of LPR-012 — same contract as dpr.js. Photos
// must carry a CONFIRMED intent owned by the caller, and the created
// record stamps boundType/boundAt so the durable sweep leaves the blobs
// alone. See lib/uploadIntentBinding.js for the full rationale.
const { validatePhotoIntents, bindPhotoIntents } = require('../lib/uploadIntentBinding');
const { encodeCursor, decodeCursor, InvalidCursorError } = require('../lib/cursor');
// DR-027: parseStrictISODate only validates calendar shape, so a well-formed
// future date used to persist. rejectIfFutureReportDate is the authority.
const { rejectIfFutureReportDate, assertNotFutureReportDate } = require('../lib/reportDate');
// LPR-013: dashboard "today" stats now derive from the IST business-day
// helper (matches how Attendance.date and DPR.reportDate are keyed) instead
// of UTC midnight of `new Date()`. Half-open [gte, lt) range is unchanged.
const { getTodayBusinessDate, getMonthRangeUtc, InvalidMonthRangeError } = require('../lib/dateOnly');
// Round-25: email fan-out for in-app notifications. Fire-and-forget —
// the helper swallows its own errors and never throws to the caller.
// Invoked inside the tx callback AFTER the notification row is created so
// the email leaves after (or concurrently with) the row commit; a failed
// tx rolls back the notification row AND the email send in-flight.
const { fanOutEmail } = require('../lib/notify');
// Round-26: admin-targeted fan-out for the POST /api/inspection → opened
// event. Admins get an immediate email per recipient, with per-admin
// preferences honoured. Guarded on `record.status === 'OPEN'` — admin-set
// non-OPEN statuses (e.g. ACKNOWLEDGED) are not the "first signal" admins
// need an email for.
const { fanOutToAdmins } = require('../lib/notify');

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

// SOL-P2#13: human-readable labels for the enums that show up in
// notifications. Keep in sync with src/pages/portal/WorkTypes.jsx —
// frontend mirrors the same display name so users see one copy.
const INSPECTION_TYPE_LABELS = {
  material_inspection: 'Material Inspection',
  cement_receipt: 'Cement Receipt',
  steel_receipt: 'Steel Receipt (with MTC)',
  bulk_materials: 'Bulk Materials (ITP)',
  concrete_receipt: 'Concrete Receipt',
  other_bulk_materials: 'Other Bulk Materials',
  water_quality: 'Water Quality (ITP)',
  cube_casting: 'Cube Casting',
  cube_testing: 'Cube Testing',
  villa_inspection: 'Villa/Unit Inspection',
  day_activity_inspection: 'Day Activity Inspection',
  waterproofing_inspection: 'Waterproofing Inspection',
  major_deviation: 'Major Deviation',
  ncr: 'Non-Conformity Report',
  safety_violation: 'Safety Violation',
};
function labelizeInspectionType(t) {
  return INSPECTION_TYPE_LABELS[t] || String(t || '').replace(/_/g, ' ');
}

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

// All routes below require auth.
router.use(requireAuth);

// DR-021 (round-20): upload routes (sas-url + confirm-upload) are now
// shared with dpr.js via src/lib/uploadRoutes.js. The shared module
// owns the auth gate (mount after router.use(requireAuth)), MAX_PHOTO_SIZE
// ceiling, content-type allowlist, pendingUploads registry, and orphan-
// blob cleanup. Hardcoded container 'inspection-photos' — backend
// chooses, not the client.
mountUploadRoutes(router, {
  container: 'inspection-photos',
});

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

  // DR-027: mirror of the dpr.js create guard. A future-dated inspection sits
  // in the admin queue (OPEN) for a site visit that hasn't happened, and
  // back-fills the linked DPR's day bucket. Admins may override (audited).
  if (rejectIfFutureReportDate(req, res, dateUTC, 'inspection.create')) return;

  // severity — nullable, allowlist
  if (severity !== undefined && severity !== null && !ALLOWED_SEVERITIES.has(severity)) {
    return res.status(422).json({
      error: `severity must be one of: MINOR, MAJOR, CRITICAL`,
      code: 'SEVERITY_INVALID',
    });
  }

  // DR-004 (round-20): owner-create is restricted to status OPEN. The
  // other 5 statuses (ACKNOWLEDGED, IN_PROGRESS, PENDING_VERIFICATION,
  // CLOSED, REJECTED) are admin-only workflow states reached through
  // /acknowledge, /close, /reject, and the bulk-review endpoint. The
  // previous implementation accepted ANY of the 6 — an employee could
  // POST an inspection with `status: 'CLOSED'` and skip the entire
  // admin review queue.
  //
  // Admins creating inspections on behalf of a workflow (rare, but
  // legitimate for back-filling NCRs) use the same route with the
  // admin status explicitly — gated below by req.isAdmin.
  const requestedStatus = status === undefined ? 'OPEN' : status;
  if (!ALLOWED_STATUSES.has(requestedStatus)) {
    return res.status(422).json({
      error: `status must be one of: ${[...ALLOWED_STATUSES].join(', ')}`,
      code: 'STATUS_INVALID',
    });
  }
  if (requestedStatus !== 'OPEN') {
    // S3-9 (round-27): do NOT trust req.isAdmin from the JWT. A user demoted
    // from admin via the team page keeps a valid token for up to
    // JWT_TTL_MINUTES; trusting the cached claim would let them POST a
    // CLOSED inspection and skip the review queue for that window.
    // Inline DB re-read mirrors the assertFreshAdmin pattern at
    // training.js:716. Cost: one indexed PK read per non-OPEN POST.
    const fresh = await prisma.employee.findUnique({
      where: { id: req.employeeId },
      select: { isAdmin: true },
    });
    if (!fresh || !fresh.isAdmin) {
      return res.status(403).json({
        error: 'Only admins can create inspections in a non-OPEN status',
        code: 'STATUS_ADMIN_ONLY',
        currentStatus: requestedStatus,
      });
    }
  }
  const finalStatus = requestedStatus;

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

  // [S3-7] Mirror of the dpr.js gate: every photo must map to a CONFIRMED
  // upload intent owned by THIS employee. The loop above only validates
  // the ulid's shape, so without this a client could attach a fabricated
  // ulid — or another employee's — to an inspection record.
  const intentErr = await validatePhotoIntents({
    prisma,
    employeeId: req.employeeId,
    photos,
    context: 'inspection.create',
  });
  if (intentErr) return res.status(intentErr.status).json(intentErr.body);

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

    // [S3-7] Consume the upload intents this record just took ownership
    // of, before the 201 — same contract as dpr.js. Best-effort: the
    // record exists, so a bind failure is logged (PII-hashed) rather than
    // turned into a 500.
    await bindPhotoIntents({
      prisma,
      employeeId: req.employeeId,
      photos,
      boundType: 'inspection',
      recordId: record.id,
    });

    res.status(201).json(record);

    // Round-26: fire admin-targeted fan-out for newly-OPENED inspections.
    // Guard on `record.status === 'OPEN'` — admin-set non-OPEN statuses
    // (e.g. ACKNOWLEDGED) are not the "first signal" admins need an email
    // for. Best-effort: any error is swallowed inside the helper.
    if (record.status === 'OPEN') {
      try {
        await fanOutToAdmins(
          {
            type: 'ADMIN_INSPECTION_OPENED',
            message: `New inspection opened by ${record.submittedBy?.name || 'an employee'}: ${record.inspectionType || 'inspection'}`,
            meta: {
              employeeName: record.submittedBy?.name || 'an employee',
              recordTitle: record.projectName || record.inspectionType || 'an inspection',
              inspectionType: record.inspectionType || '',
              inspectionId: record.id,
            },
          },
          prisma,
        );
      } catch (adminErr) {
        console.error('Inspection admin fan-out error', {
          inspectionId: record.id,
          message: adminErr?.message?.split('\n')[0],
        });
      }
    }
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
// Supports filters: dprId, reportDate (YYYY-MM-DD or full ISO), from/to
// (YYYY-MM-DD range — DR-028), inspectionType, status, severity, cursor
// (base64(reportDate|id)), limit (max 100).
//
// Non-admins are restricted to their own records; admins see all unless
// `my=true` is passed.
//
// DR-028: the admin dashboard has always sent `from`/`to` range
// parameters, but the route previously ignored them — `filterFrom`/`filterTo`
// in InspectionDashboard.jsx were dead UI. We now parse them through the
// same `parseStrictISODate` helper as the single-day `reportDate` filter
// and merge them as an inclusive `gte`/`lte` range (calendar-day
// semantics on @db.Date — same as the leave admin queue).
//
// Filter precedence:
//   1. `reportDate` (exact day) → exclusive range over the day
//   2. `from` + `to` (inclusive range)
//   3. `from` only / `to` only (one-sided open range)
//
// Sending both `reportDate` and `from`/`to` returns the intersection
// (record-date matches BOTH), which is the most useful semantics — a
// caller looking at "exactly Sept 4 within the Sept 1..Sept 7 window"
// gets that record and nothing else.
router.get('/', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { cursor, limit = '20', dprId, reportDate, from, to, inspectionType, status, severity, my, month } = req.query;

  const take = Math.min(parseInt(limit) || 20, 100);

  // Cursor: base64url(JSON.stringify({ date: 'YYYY-MM-DD', id })).
  // DR-008: use the unified cursor codec so encoder + decoder agree.
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

  // DR-028: from/to range filter. Both bounds are inclusive calendar-day
  // matches against the @db.Date `reportDate` column (UTC midnight).
  // Each bound is parsed independently so a missing bound means "no
  // constraint on that side". A reversed range (from > to) is a client
  // bug — return 400 rather than silently returning an empty set.
  let rangeFilter = undefined;
  if (from || to) {
    let fromDate = null;
    let toDate = null;
    if (from !== undefined) {
      const parsed = parseStrictISODate(String(from));
      if (!parsed.ok) {
        return res.status(400).json({
          error: 'from must be a valid YYYY-MM-DD',
          code: 'INVALID_FROM_DATE',
        });
      }
      fromDate = parsed.date;
    }
    if (to !== undefined) {
      const parsed = parseStrictISODate(String(to));
      if (!parsed.ok) {
        return res.status(400).json({
          error: 'to must be a valid YYYY-MM-DD',
          code: 'INVALID_TO_DATE',
        });
      }
      toDate = parsed.date;
    }
    if (fromDate && toDate && fromDate > toDate) {
      return res.status(400).json({
        error: 'from must be on or before to',
        code: 'INVALID_DATE_RANGE',
      });
    }
    rangeFilter = {};
    if (fromDate) rangeFilter.gte = fromDate;
    if (toDate) rangeFilter.lte = toDate;
  }

  // Round-27: `month=YYYY-MM` query shortcut on the list endpoint. Same
  // contract as dpr.js — half-open [gte, lt) window aligned to the IST
  // business calendar (see backend/src/lib/dateOnly.js). Combining `month`
  // with `from`/`to` would expand the same `reportDate` predicate twice
  // and risk an unexpected intersection, so we reject explicitly with 400.
  // (Also rejected by dpr.js via MONTH_AND_RANGE_CONFLICT for symmetry.)
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
    // Same shape as a manually-typed from/to range so the existing
    // mergedDate logic below (which AND-merges reportDate + rangeFilter)
    // picks it up without a separate branch.
    rangeFilter = { gte: monthRange.startDate, lt: monthRange.endDate };
  }

  try {
    const employee = await prisma.employee.findUnique({ where: { id: req.employeeId } });
    const isAdmin = employee && employee.isAdmin;
    const restrictToSelf = !isAdmin || my === 'true';

    // DR-028: merge `reportDate` (single day, half-open [gte,lt)) and
    // `from`/`to` (inclusive range, [gte,lte]) into one `reportDate`
    // clause by combining per-bound keys. Prisma's per-field filter
    // AND-combines its members, so we just take the tighter bound on
    // each side:
    //   gte = max(reportDateFilter.gte, rangeFilter.gte)  (whichever is
    //         larger — both must be satisfied)
    //   lt  = reportDateFilter.lt  (single-day only)
    //   lte = rangeFilter.lte       (range only)
    // When neither is supplied, `reportDate` is omitted entirely.
    const mergedDate = {};
    if (reportDateFilter) {
      if (reportDateFilter.gte) mergedDate.gte = reportDateFilter.gte;
      if (reportDateFilter.lt) mergedDate.lt = reportDateFilter.lt;
      if (reportDateFilter.equals) mergedDate.equals = reportDateFilter.equals;
    }
    if (rangeFilter) {
      if (rangeFilter.gte && (!mergedDate.gte || rangeFilter.gte > mergedDate.gte)) {
        mergedDate.gte = rangeFilter.gte;
      }
      if (rangeFilter.lte) mergedDate.lte = rangeFilter.lte;
      // Round-27: half-open `lt` (exclusive upper bound) — currently set
      // only by `?month=` (rangeFilter.lt) and by single-day `reportDate`
      // (reportDateFilter.lt). When both are present, take the tighter
      // one so the merged window can never be wider than either source.
      if (rangeFilter.lt && (!mergedDate.lt || rangeFilter.lt < mergedDate.lt)) {
        mergedDate.lt = rangeFilter.lt;
      }
    }
    const reportDateWhere = Object.keys(mergedDate).length > 0 ? mergedDate : undefined;

    const where = {
      ...(restrictToSelf ? { submittedById: req.employeeId } : {}),
      ...(dprId ? { dprId } : {}),
      ...(inspectionType ? { inspectionType } : {}),
      ...(status ? { status } : {}),
      ...(severity ? { severity } : {}),
      ...(reportDateWhere ? { reportDate: reportDateWhere } : {}),
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
    // DR-008: route the encoder through the unified cursor codec so the
    // wire format round-trips through the same decoder.
    let nextCursor = null;
    if (hasMore && lastItem && lastItem.reportDate != null && lastItem.id) {
      try {
        nextCursor = encodeCursor(lastItem.reportDate, lastItem.id);
      } catch (e) {
        console.error('Inspection cursor encode failed', { err: e.message });
        nextCursor = null;
      }
    }

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

// ─── GET /api/inspection/stats ──────────────────────────────────────────────
// DR-029 (round-20): explicit aggregate counts for the admin inspection
// dashboard. Mirrors the /api/dpr/stats shape so the frontend treats both
// endpoints uniformly.
//
// Before this endpoint existed, InspectionDashboard sent three requests
// with limit=1 and used response length as the count. That meant "Open",
// "Filed Today", and "Closed" could never display more than 1, and "Total
// Visible" never more than 2. Same anti-pattern as DPR but worse because
// limit=1 made it obviously broken at scale (admin at the live portal
// testing round-19 reported "the dashboard says 1 open inspection when
// there are clearly more in the queue").
//
// Six targeted COUNT queries against indexed columns (reportDate, status),
// all in parallel. Admin-only via requireFreshAdmin (falls back to
// requireAdmin in older builds). See docs/dashboard-metrics.md.
//
// LIVE-DISCOVERED (round-20): /stats MUST be registered BEFORE /:id or
// Express routes GET /api/inspection/stats through :id with id='stats',
// triggering a prisma.inspectionRecord.findUnique miss and a 404. Mirror
// of the dpr.js fix above.
const inspectionStatsAdminGuard = requireFreshAdmin || requireAdmin;

router.get('/stats', inspectionStatsAdminGuard, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  // LPR-013: same IST-day window convention as /api/dpr/stats — derive
  // "today" via getTodayBusinessDate() so the bucket lands on the correct
  // calendar day for an India-based workforce. The previous
  // `setUTCHours(0,0,0,0)` was wrong: between 00:00 and 05:29 IST an
  // inspection filed in IST was being counted under yesterday's UTC bucket
  // and between 18:30 UTC and midnight UTC (= 00:00–05:30 IST the next day)
  // a tomorrow-filed IST inspection was already counted under today.
  // reportDate is @db.Date so { gte: today, lt: tomorrow } covers the full
  // day; updatedAt (used by closedToday) is a DateTime column but we want
  // the same wall-clock-day definition, so we share the helper.
  const startOfToday = getTodayBusinessDate();
  const endOfToday = new Date(startOfToday);
  endOfToday.setUTCDate(endOfToday.getUTCDate() + 1);

  const [
    openNow,
    filedToday,
    closedToday,
    acknowledged,
    pendingReview,
    totalActive,
  ] = await Promise.all([
    // openNow: every OPEN record across the org (no date window — this is
    // the "how big is the current queue" tile).
    prisma.inspectionRecord.count({ where: { status: 'OPEN' } }),
    // filedToday: any record whose reportDate is today, regardless of
    // status. "Filed Today" means "engineer submitted today" — once it's
    // filed, even if it transitions to CLOSED later, it counts here.
    prisma.inspectionRecord.count({
      where: { reportDate: { gte: startOfToday, lt: endOfToday } },
    }),
    // closedToday: rows that TRANSITIONED to CLOSED today. Inspection
    // records don't have a dedicated closedAt column; we use updatedAt as
    // the best proxy because the close transition sets status='CLOSED' +
    // updatedAt=now inside a $transaction. (A re-edit on a CLOSED row
    // would bump updatedAt again — acceptable; the label is "Closed Today"
    // not "Closed and not edited today".)
    prisma.inspectionRecord.count({
      where: {
        status: 'CLOSED',
        updatedAt: { gte: startOfToday, lt: endOfToday },
      },
    }),
    // acknowledged: org-wide count of records an admin has explicitly
    // ACK'd. Status 'ACKNOWLEDGED' is the entry-point state for review
    // (vs OPEN which is the engineer's submission state).
    prisma.inspectionRecord.count({ where: { status: 'ACKNOWLEDGED' } }),
    // pendingReview: rows an admin can still pick up. Inspection reviewable
    // states (matching B-06's REVIEWABLE_STATUSES) are
    // OPEN / IN_PROGRESS / PENDING_VERIFICATION. ACKNOWLEDGED is the
    // "I've seen it" state — it's no longer pending action from the admin
    // until it moves to IN_PROGRESS.
    prisma.inspectionRecord.count({
      where: { status: { in: ['OPEN', 'IN_PROGRESS', 'PENDING_VERIFICATION'] } },
    }),
    // totalActive: every non-terminal record. Terminal states are CLOSED
    // and REJECTED — same model as DPR's totalActive.
    prisma.inspectionRecord.count({
      where: { status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'PENDING_VERIFICATION'] } },
    }),
  ]);

  res.json({
    openNow,
    filedToday,
    closedToday,
    acknowledged,
    pendingReview,
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
//
// DR-004 (round-20): two bugs the audit caught:
//   1. The previous ALLOWED_UPDATE_FIELDS included `status`. The owner
//      could send `status: 'CLOSED'` via PUT and silently mark a
//      record as admin-decided without going through the admin queue.
//      `status` is removed from the owner allowlist — the dedicated
//      /acknowledge /close /reject endpoints (and bulk-review) are
//      the only legal way out of OPEN.
//   2. The handler required a `version` field in the body and used
//      `where: { id, version: existing.version }` on the conditional
//      update — but InspectionRecord has NO version column in the
//      schema (see prisma/schema.prisma: model InspectionRecord). The
//      WHERE clause never matched and every PUT 409'd with
//      VERSION_CONFLICT. We now accept a plain PUT body without a
//      version field and update by `id`.
//
// LPR-008: read-time status check (below) plus a `status: 'OPEN'` pin
// on the WHERE makes the owner PUT race-safe against a concurrent admin
// transition. Scenario: owner reads row at OPEN, admin /acknowledge
// moves it to ACKNOWLEDGED in between, owner PUT lands. Without the
// WHERE pin the update would silently overwrite the acknowledged row;
// now the conditional WHERE matches no row, Prisma throws P2025, and
// the catch translates that to a 409 INSPECTION_LOCKED — same wire
// shape the read-time check uses, so clients only see one error.
router.put('/:id', async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;
  const fields = req.body || {};

  // `version` was a phantom — reject explicitly so any client still
  // sending it gets a clear 400 instead of silently working (or, as
  // before, silently 409'ing on the dead WHERE clause).
  if ('version' in fields) {
    return res.status(400).json({
      error: 'version is not a valid field on inspection records',
      code: 'VERSION_FIELD_INVALID',
    });
  }

  const ALLOWED_UPDATE_FIELDS = [
    'projectName', 'location', 'reportDate', 'weather', 'contractor',
    'inspectionType', 'data', 'severity', 'dprId',
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
    // DR-027: without this, PUT is a trivial bypass of the create-time check.
    if (rejectIfFutureReportDate(req, res, fields.reportDate, 'inspection.update')) return;
  }

  if (fields.inspectionType !== undefined && !ALLOWED_INSPECTION_TYPES.has(fields.inspectionType)) {
    return res.status(422).json({ error: 'inspectionType not allowed', code: 'INSPECTION_TYPE_INVALID' });
  }
  if (fields.severity !== undefined && fields.severity !== null && !ALLOWED_SEVERITIES.has(fields.severity)) {
    return res.status(422).json({ error: 'severity not allowed', code: 'SEVERITY_INVALID' });
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
    // LPR-008: pin `status: 'OPEN'` on the WHERE so a concurrent admin
    // ack/close/reject between our read and our update cannot be
    // silently overwritten. If Prisma rejects with P2025, the catch
    // below maps it to 409 INSPECTION_LOCKED (same wire shape as the
    // read-time check) so clients only see one error code.
    const updated = await prisma.inspectionRecord.update({
      where: { id, status: 'OPEN' },
      data: {
        ...fields,
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
    // LPR-008: a P2025 from the conditional WHERE means the row's
    // status drifted off OPEN between our read and our write (an admin
    // ack/close/reject landed in between). Translate to the same
    // 409 INSPECTION_LOCKED the read-time check uses, so the client
    // only sees one error code for the same condition. mapPrismaError
    // would otherwise surface this as a generic 404 NOT_FOUND, which
    // is the wrong wire shape.
    if (err.code === 'P2025') {
      return res.status(409).json({
        error: 'INSPECTION_LOCKED',
        code: 'INSPECTION_LOCKED',
        message: 'Inspection moved out of OPEN during edit; refetch and retry',
      });
    }
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to update inspection record' });
  }
});

// ─── Admin state-machine helpers (Round-17 B-06) ────────────────────────────
//
// Inspection & Compliance Records use a String `status` column (no version
// column). The DPR bulk-review's `status + version` conditional update can't
// be applied verbatim — we fall back to a `status`-only conditional update,
// which still gives race-safe behavior for the admin operation window
// (two concurrent admins clicking on the same row: one wins, the other gets
// P2025 → we translate to VERSION_CONFLICT).
//
// Mirrors the round-17 DPR bulk-review pattern:
//   - Per-ID prisma.$transaction (one failure doesn't roll back the rest)
//   - Tagged error throws ({ _code, _status }) so the per-row bucket is precise
//   - DB notification row written in-txn; no SSE emit here because
//     inspection.js doesn't own the SSE plumbing — bell refresh picks up new
//     rows on the next /api/dpr/notifications/list call. Message includes
//     the inspection id so the owner has context (the Notification table has
//     no inspectionId FK — schema is frozen by the B-06 constraint).
//   - adminNotes persisted on the inspection row so admins can leave an
//     audit-visible note alongside each ack/close/reject.

const ACK_FROM = new Set(['OPEN']);
const CLOSE_FROM = new Set(['ACKNOWLEDGED', 'IN_PROGRESS', 'PENDING_VERIFICATION']);
const REJECT_FROM = new Set(['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'PENDING_VERIFICATION']);

const INSPECTION_INCLUDE = {
  photos: true,
  submittedBy: { select: { id: true, name: true, email: true } },
  dpr: { select: { id: true, reportDate: true, projectName: true } },
};

// Shared per-record transition helper used by both the single-record endpoints
// and the bulk-review loop. Throws tagged errors on failure so callers can
// branch on _code / _status without re-implementing the state-machine logic.
async function transitionInspectionRecord(prisma, id, action, payload, actorEmployeeId, options = {}) {
  const { allowAdminOverride = false } = options;

  // DR-027: none of the three transition endpoints accepts a reportDate today
  // — they only move `status` and append `_adminNotes`. This guard exists so
  // that if a future transition ever carries a date correction through
  // `payload`, it cannot slip past the no-future rule the way create/update
  // did. All callers here are `req.isAdmin`-gated, so they pass
  // allowAdminOverride:true and a deliberate future date is audit-logged
  // rather than rejected.
  if (payload && payload.reportDate !== undefined) {
    assertNotFutureReportDate(payload.reportDate, {
      allowAdminOverride,
      actor: actorEmployeeId,
      resource: `inspection.${String(action).toLowerCase()}`,
    });
  }

  const allowedFrom =
    action === 'ACKNOWLEDGE' ? ACK_FROM
    : action === 'CLOSE' ? CLOSE_FROM
    : action === 'REJECT' ? REJECT_FROM
    : null;
  if (!allowedFrom) {
    throw Object.assign(new Error(`Unknown action ${action}`), { _code: 'UNKNOWN_ACTION', _status: 400 });
  }

  let nextStatus;
  let notifType;
  if (action === 'ACKNOWLEDGE') { nextStatus = 'ACKNOWLEDGED'; notifType = 'INSPECTION_ACKNOWLEDGED'; }
  else if (action === 'CLOSE') { nextStatus = 'CLOSED'; notifType = 'INSPECTION_CLOSED'; }
  else { nextStatus = 'REJECTED'; notifType = 'INSPECTION_REJECTED'; }

  return prisma.$transaction(async (tx) => {
    const record = await tx.inspectionRecord.findUnique({
      where: { id },
      include: INSPECTION_INCLUDE,
    });
    if (!record) {
      throw Object.assign(new Error('Inspection record not found'), { _code: 'NOT_FOUND', _status: 404 });
    }

    if (!allowedFrom.has(record.status)) {
      throw Object.assign(
        new Error(`Cannot move inspection from ${record.status} to ${nextStatus}`),
        { _code: 'INVALID_TRANSITION', _status: 409 }
      );
    }

    // Schema-driven update — no `data` allowlist (no submittedById /
    // submittedAt / etc. on InspectionRecord to mass-assign). We only set
    // columns we control here, and adminNotes lives on a JSON-ish payload
    // merged into the inspection record's `data` JSON.
    const dataPatch = {
      status: nextStatus,
    };
    if (payload.adminNotes && typeof payload.adminNotes === 'string') {
      // Park adminNotes inside the existing JSON `data` blob under a reserved
      // key. Don't surface this in the inspector UI — it's audit-visible only.
      dataPatch.data = {
        ...(record.data || {}),
        _adminNotes: [...(((record.data || {})._adminNotes) || []), {
          by: actorEmployeeId,
          action,
          notes: payload.adminNotes,
          at: new Date().toISOString(),
        }],
      };
    }

    // Race-safe conditional update on `status` (no version column on this
    // model). A concurrent admin action that already flipped status will
    // throw P2025 from Prisma; we translate that to a tagged VERSION_CONFLICT.
    const conditionalUpdate = await tx.inspectionRecord.update({
      where: { id, status: record.status },
      data: dataPatch,
    }).catch((err) => {
      if (err.code === 'P2025') {
        throw Object.assign(new Error('version conflict'), { _code: 'VERSION_CONFLICT', _status: 409 });
      }
      throw err;
    });
    if (!conditionalUpdate) {
      throw Object.assign(new Error('version conflict'), { _code: 'VERSION_CONFLICT', _status: 409 });
    }

    // SOL-P2#13: human-readable label for the inspection type so the
    // bell/toast reads "Cube Testing" instead of "cube_testing", and the
    // raw cuid is no longer dumped into the message body (employees were
    // seeing a 24-char id appended to every notification).
    const messageParts = [
      `Your ${labelizeInspectionType(record.inspectionType)} for ${record.projectName} on ${formatInspectionReportDate(record.reportDate)} was ${action.toLowerCase()}d.`,
    ];
    if (action === 'REJECT' && payload.reason) messageParts.push(`Reason: ${payload.reason.trim()}`);
    if (payload.adminNotes) messageParts.push(`Notes: ${payload.adminNotes}`);
    await tx.notification.create({
      data: {
        employeeId: record.submittedById,
        type: notifType,
        message: messageParts.join('\n'),
      },
    });

    // Round-25: schedule email fan-out AFTER the notification row insert.
    // The helper is fire-and-forget so the tx callback returns
    // immediately, but the send runs once the row is durable (the send
    // happens in the same tick of the event loop as the tx commit because
    // the tx awaits here). For REJECT, pass the reason so the email can
    // surface it in the body.
    fanOutEmail({
      id: null, // tx-row id not returned; EmailLog.notificationId is nullable
      employeeId: record.submittedById,
      type: notifType,
      message: messageParts.join('\n'),
    }, prisma, {
      reason: action === 'REJECT' ? payload.reason?.trim() : null,
    });

    return tx.inspectionRecord.findUnique({
      where: { id },
      include: INSPECTION_INCLUDE,
    });
  });
}

// Defensive: reportDate may deserialize as Date or "YYYY-MM-DD" string.
function formatInspectionReportDate(d) {
  if (d instanceof Date) return d.toISOString().split('T')[0];
  return String(d);
}

// ─── POST /api/inspection/:id/acknowledge ───────────────────────────────────
// OPEN → ACKNOWLEDGED. Admin only.
//
// LPR-007: ack is a mutation; requireFreshAdmin re-reads isAdmin
// from the DB instead of trusting the up-to-15-minute-old JWT claim.
router.post('/:id/acknowledge', requireFreshAdmin, async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;
  const { adminNotes } = req.body || {};

  if (adminNotes !== undefined && (typeof adminNotes !== 'string' || adminNotes.length > 2000)) {
    return res.status(400).json({ error: 'NOTES_TOO_LONG', message: 'adminNotes must be <= 2000 chars' });
  }

  try {
    const updated = await transitionInspectionRecord(
      prisma,
      id,
      'ACKNOWLEDGE',
      { adminNotes },
      req.employeeId,
      { allowAdminOverride: true } // DR-027: route is req.isAdmin-gated above
    );
    res.json(updated);
  } catch (err) {
    return inspectionHandleTransitionError(req, res, err, 'acknowledge');
  }
});

// ─── POST /api/inspection/:id/close ─────────────────────────────────────────
// ACKNOWLEDGED|IN_PROGRESS|PENDING_VERIFICATION → CLOSED. Admin only.
//
// LPR-007: close is a mutation; requireFreshAdmin re-reads isAdmin
// from the DB instead of trusting the up-to-15-minute-old JWT claim.
router.post('/:id/close', requireFreshAdmin, async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;
  const { adminNotes } = req.body || {};

  if (adminNotes !== undefined && (typeof adminNotes !== 'string' || adminNotes.length > 2000)) {
    return res.status(400).json({ error: 'NOTES_TOO_LONG', message: 'adminNotes must be <= 2000 chars' });
  }

  try {
    const updated = await transitionInspectionRecord(
      prisma,
      id,
      'CLOSE',
      { adminNotes },
      req.employeeId,
      { allowAdminOverride: true } // DR-027: route is req.isAdmin-gated above
    );
    res.json(updated);
  } catch (err) {
    return inspectionHandleTransitionError(req, res, err, 'close');
  }
});

// ─── POST /api/inspection/:id/reject ─────────────────────────────────────────
// OPEN|ACKNOWLEDGED|IN_PROGRESS|PENDING_VERIFICATION → REJECTED. Admin only.
// Reason is required so the owner knows what to fix.
//
// LPR-007: reject is a mutation; requireFreshAdmin re-reads isAdmin
// from the DB instead of trusting the up-to-15-minute-old JWT claim.
router.post('/:id/reject', requireFreshAdmin, async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;
  const { reason, adminNotes } = req.body || {};

  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    return res.status(400).json({ error: 'REASON_REQUIRED', message: 'A reason is required to reject an inspection' });
  }
  if (reason.length > 1000) {
    return res.status(400).json({ error: 'REASON_TOO_LONG', message: 'Reason must be <= 1000 chars' });
  }
  if (adminNotes !== undefined && (typeof adminNotes !== 'string' || adminNotes.length > 2000)) {
    return res.status(400).json({ error: 'NOTES_TOO_LONG', message: 'adminNotes must be <= 2000 chars' });
  }

  try {
    const updated = await transitionInspectionRecord(
      prisma,
      id,
      'REJECT',
      { reason, adminNotes },
      req.employeeId,
      { allowAdminOverride: true } // DR-027: route is req.isAdmin-gated above
    );
    res.json(updated);
  } catch (err) {
    return inspectionHandleTransitionError(req, res, err, 'reject');
  }
});

// Single-error handler for the three single-record transition endpoints.
function inspectionHandleTransitionError(req, res, err, action) {
  console.error(`Inspection ${action} error`, {
    employeeHash: hashIdentifier(req.employeeId),
    prismaCode: err.code,
    message: err.message?.split('\n')[0],
  });
  if (err._status) {
    return res.status(err._status).json({
      error: err.message?.split('\n')[0] || 'Transition failed',
      code: err._code,
    });
  }
  if (err.code === 'P2025') {
    return res.status(409).json({
      error: 'Inspection was modified by another action. Please refresh and try again.',
      code: 'VERSION_CONFLICT',
    });
  }
  const mapped = mapPrismaError(err);
  if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
  res.status(500).json({ error: `Failed to ${action} inspection` });
}

// ─── POST /api/inspection/bulk-review (Round-17 B-06) ───────────────────────
//
// Fan out an admin action (ACKNOWLEDGE | CLOSE | REJECT) over a list of
// inspection IDs. Per-ID transaction so one failure doesn't roll back the
// rest — admin UI shows per-row success/failure.
//
// Each ID goes through the SAME state-machine + per-ID tx as the single
// endpoint above, so the audit trail (adminNotes + Notification row) is
// identical whether the action came from the per-row menu or this batch.
//
// Cap: 100 IDs per call. Larger batches tie up the request for too long and
// aren't a realistic UI selection.

const INSPECTION_BULK_ACTIONS = new Set(['ACKNOWLEDGE', 'CLOSE', 'REJECT']);
const INSPECTION_BULK_MAX_IDS = 100;

// LPR-007: bulk-review is a mutation; requireFreshAdmin re-reads
// Employee.isAdmin from the DB once per request so a freshly demoted
// admin cannot flood in stale-JWT decisions across a batch.
router.post('/bulk-review', requireFreshAdmin, async (req, res) => {
  const prisma = getPrisma(req);
  const { ids, action, reason, adminNotes } = req.body || {};

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'ids must be a non-empty array' });
  }
  if (ids.length > INSPECTION_BULK_MAX_IDS) {
    return res.status(400).json({
      error: 'BATCH_TOO_LARGE',
      message: `Cannot process more than ${INSPECTION_BULK_MAX_IDS} IDs in a single batch`,
    });
  }
  if (ids.some((id) => typeof id !== 'string' || !id.trim())) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'All ids must be non-empty strings' });
  }
  if (!INSPECTION_BULK_ACTIONS.has(action)) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: `action must be one of: ${[...INSPECTION_BULK_ACTIONS].join(', ')}`,
    });
  }
  if (action === 'REJECT') {
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({ error: 'REASON_REQUIRED', message: 'A reason is required to reject inspections' });
    }
    if (reason.length > 1000) {
      return res.status(400).json({ error: 'REASON_TOO_LONG', message: 'Reason must be <= 1000 chars' });
    }
  }
  if (adminNotes && (typeof adminNotes !== 'string' || adminNotes.length > 2000)) {
    return res.status(400).json({ error: 'NOTES_TOO_LONG', message: 'adminNotes must be <= 2000 chars' });
  }

  // De-duplicate input — same ID twice would double-fire notifications.
  const uniqueIds = [...new Set(ids)];
  const succeeded = [];
  const failed = [];

  for (const id of uniqueIds) {
    try {
      const record = await transitionInspectionRecord(
        prisma,
        id,
        action,
        { reason, adminNotes },
        req.employeeId,
        { allowAdminOverride: true } // DR-027: route is req.isAdmin-gated above
      );
      succeeded.push({ id: record.id, newStatus: record.status });
    } catch (err) {
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


module.exports = router;
