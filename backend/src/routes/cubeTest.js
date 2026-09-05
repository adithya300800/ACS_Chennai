// Cube-test integration routes — N5 (round-29).
//
// Wires the new `cube_test` table into the API surface so the frontend can:
//   - list cube tests (filtered by status, dprId, castingRecordId, dueBefore)
//   - create a new cube-test row tied to a cube_casting inspection + a pour DPR
//   - fetch one cube-test row's detail
//   - patch a cube-test row to record 7d / 28d results (status auto-derives)
//   - find tests whose 28-day due-date lands in the next N days (admin dashboard)
//   - get the pour-summary view per DPR (count cast / passed / pending)
//
// Auth model:
//   - All routes require auth (`requireAuth`).
//   - List + due-soon + pour-summary: any authenticated employee.
//   - Detail: submitter, the dpr submitter, OR an admin.
//   - Create: any employee, but must reference an inspection or dpr they own.
//   - Patch: submitter or admin.
//
// The status lifecycle is computed inside the patch handler — passing a
// `status` field in the body is NOT honoured. Source of truth for pass/fail
// is the `result >= expectedStrength` comparison; the status column is just a
// cached derivation so list views can filter without a join. If the caller
// submits a 7d or 28d result, the route sets `status` to the appropriate
// PASSED / FAILED enum value (or leaves it PENDING if the field is omitted).
//
// Date handling: castDate is parsed via parseDateOnlyToUtc so a string like
// "2026-09-05" becomes a UTC midnight Date that round-trips cleanly through
// Prisma's @db.Date encoding. The 7d / 28d due dates are computed in the
// route (castDate + 7d / castDate + 28d, both @ UTC midnight) so they line
// up exactly with the castDate column on read-back. This matches the
// dateOnly.js contract used by attendance / leave / DPR.

'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin, requireFreshAdmin } = require('../middleware/auth');
const { mapPrismaError, parseStrictISODate } = require('../lib/errors');
const { parseDateOnlyToUtc, dateOnlyToUtc, InvalidDateOnlyError } = require('../lib/dateOnly');
const { hashIdentifier } = require('../lib/pii');

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function getPrisma(req) { return req.app.get('prisma'); }

// Lifecycle states. PENDING is the default on create; the rest are derived
// from result-vs-expected comparisons inside the patch handler.
const ALLOWED_STATUSES = new Set([
  'PENDING',
  'SEVEN_DAY_PASSED',
  'SEVEN_DAY_FAILED',
  'TWENTY_EIGHT_DAY_PASSED',
  'TWENTY_EIGHT_DAY_FAILED',
  'OVERDUE',
]);

// The free-text fields are capped to keep the column widths sane and stop
// a malicious client from POSTing a 200MB location string.
const MAX = {
  pourLocation: 200,
  concreteGrade: 40,
  notes: 2000,
};

// Plain UUID guard — the FKs reference inspection_record.id, dpr.id, and
// employees.id, all of which are server-generated UUIDs.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Parse a date-only string into a UTC midnight Date using the canonical
// dateOnly helper. Returns null + sets a side-channel `error` so the route
// can return a 400 with a useful code without throwing.
function parseDate(value) {
  try {
    return parseDateOnlyToUtc(value);
  } catch (e) {
    if (e instanceof InvalidDateOnlyError) {
      return { error: e.message };
    }
    throw e;
  }
}

// Compute the status field from current results + expectedStrength. The
// seven-day result is informational; only the twenty-eight-day result is
// the spec-acceptance signal. PENDING is the default when neither result
// is set. The route never sets OVERDUE here — that comes from a separate
// cron sweep that the next round will introduce; this handler just keeps
// the result-driven states up to date.
function deriveStatus({ sevenDayResult, twentyEightDayResult, expectedStrength }) {
  if (twentyEightDayResult != null) {
    return twentyEightDayResult >= expectedStrength ? 'TWENTY_EIGHT_DAY_PASSED' : 'TWENTY_EIGHT_DAY_FAILED';
  }
  if (sevenDayResult != null) {
    return sevenDayResult >= expectedStrength ? 'SEVEN_DAY_PASSED' : 'SEVEN_DAY_FAILED';
  }
  return 'PENDING';
}

// All routes below require auth. `requireAuth` reads the JWT + revocation
// table; nothing else gates beyond this.
router.use(requireAuth);

// LIVE-DISCOVERED (inspection.js parity): register /due-soon BEFORE /:id
// so Express doesn't route GET /api/cube-tests/due-soon through :id with
// id='due-soon'. Same for /pour-summary/:dprId (it has a path segment but
// /due-soon does not, so the registration order matters here too).

// ─── GET /api/cube-tests/due-soon?days=N ────────────────────────────────────
// Admin dashboard: cube tests whose twenty-eight-day test is due in the next
// N calendar days (default 7). Status is intentionally NOT filtered —
// admins want to see PASSED / FAILED tests too (for the 28-day compliance
// roll-up). The frontend filters the rendered list by status client-side.
//
// `days` is clamped to [1, 90] so an accidental ?days=10000 from a buggy
// UI doesn't return every row in the table. The window is computed in UTC
// (dateOnly.js is the canonical UTC-midnight helper); admins in IST see
// a small offset, but since due-date is calendar-day-only, the bucket is
// still correct on a per-day basis.
router.get('/due-soon', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const rawDays = req.query.days;
  let days = 7;
  if (rawDays != null) {
    const parsed = Number(rawDays);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 90) {
      return res.status(400).json({
        error: 'days must be an integer in [1, 90]',
        code: 'INVALID_DAYS',
      });
    }
    days = parsed;
  }
  // today + (days) calendar days, inclusive. computed at UTC midnight
  // (dateOnly.js convention). The endDate is exclusive — see dateOnly
  // header for the half-open [gte, lt) rationale.
  const startDate = parseDateOnlyToUtc(new Date().toISOString().slice(0, 10));
  const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + days);

  try {
    const tests = await prisma.cubeTest.findMany({
      where: {
        twentyEightDayDueDate: { gte: startDate, lt: endDate },
      },
      include: {
        castingRecord: { select: { id: true, projectName: true, reportDate: true, inspectionType: true } },
        dpr: { select: { id: true, projectName: true, reportDate: true, location: true } },
        submittedBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: [{ twentyEightDayDueDate: 'asc' }, { id: 'asc' }],
    });

    res.json({ tests, window: { days, startDate, endDate } });
  } catch (err) {
    console.error('CubeTest due-soon error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to fetch due-soon cube tests' });
  }
}));

// ─── GET /api/cube-tests/pour-summary/:dprId ─────────────────────────────────
// Pour-summary view: counts of cube tests on a single DPR grouped by status.
// Always returns the full status-bucket shape (cast count, passed count,
// pending count, failed count, overdue count) even if a bucket is empty,
// so the frontend can render a stable grid without per-key null checks.
//
// Auth: any authenticated employee. The dprId is required and must be a
// valid UUID — a malformed id is 400 (not 404) so a typo'd URL is loud.
router.get('/pour-summary/:dprId', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { dprId } = req.params;

  if (typeof dprId !== 'string' || !UUID_RE.test(dprId)) {
    return res.status(400).json({ error: 'dprId must be a UUID', code: 'INVALID_DPR_ID' });
  }

  try {
    // Existence check — return 404 if the dpr is gone. Cheaper than
    // returning an empty pour-summary for a non-existent parent.
    const dpr = await prisma.dPR.findUnique({
      where: { id: dprId },
      select: { id: true, projectName: true, reportDate: true, location: true },
    });
    if (!dpr) {
      return res.status(404).json({ error: 'DPR not found', code: 'DPR_NOT_FOUND' });
    }

    const tests = await prisma.cubeTest.findMany({
      where: { dprId },
      include: {
        castingRecord: { select: { id: true, projectName: true, reportDate: true, inspectionType: true } },
        submittedBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: [{ castDate: 'asc' }, { id: 'asc' }],
    });

    // Aggregate counts. Bucket shape is stable across all responses so
    // the client can render without null guards:
    //   cast      — total cube-test rows on this DPR
    //   passed    — tests where status ends in _PASSED (7d OR 28d)
    //   failed    — tests where status ends in _FAILED (7d OR 28d)
    //   pending   — tests still awaiting results
    //   overdue   — tests that are explicitly OVERDUE (cron-set, future round)
    // billingStatus mirrors what billing / acceptance paperwork needs:
    //   READY      — every cube on the pour has a 28d result recorded
    //   IN_PROGRESS — at least one cube still has no 28d result
    let passed = 0;
    let failed = 0;
    let pending = 0;
    let overdue = 0;
    for (const t of tests) {
      if (t.status === 'PENDING') pending += 1;
      else if (t.status === 'OVERDUE') overdue += 1;
      else if (t.status.endsWith('_PASSED')) passed += 1;
      else if (t.status.endsWith('_FAILED')) failed += 1;
    }

    const billingStatus = tests.length > 0 && pending === 0 && overdue === 0
      ? 'READY'
      : 'IN_PROGRESS';

    res.json({
      dpr,
      billingStatus,
      counts: {
        cast: tests.length,
        passed,
        failed,
        pending,
        overdue,
      },
      tests,
    });
  } catch (err) {
    console.error('CubeTest pour-summary error', {
      employeeHash: hashIdentifier(req.employeeId),
      dprId,
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to fetch pour-summary' });
  }
}));

// ─── GET /api/cube-tests ────────────────────────────────────────────────────
// List cube tests with filters. Auth: any employee. Optional filters:
//   status            — exact match (one of ALLOWED_STATUSES)
//   dprId             — exact match
//   castingRecordId   — exact match
//   dueBefore         — YYYY-MM-DD; tests with twentyEightDayDueDate <= this
//
// Results ordered by twentyEightDayDueDate asc + id asc — oldest due first,
// so a queue view naturally surfaces the tests that need attention NOW.
// Hard cap 100 (matches the inspection list endpoint).
router.get('/', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { status, dprId, castingRecordId, dueBefore } = req.query;

  if (status !== undefined && !ALLOWED_STATUSES.has(String(status))) {
    return res.status(422).json({
      error: `status must be one of: ${[...ALLOWED_STATUSES].join(', ')}`,
      code: 'STATUS_INVALID',
    });
  }
  if (dprId !== undefined && (typeof dprId !== 'string' || !UUID_RE.test(dprId))) {
    return res.status(400).json({ error: 'dprId must be a UUID', code: 'INVALID_DPR_ID' });
  }
  if (castingRecordId !== undefined && (typeof castingRecordId !== 'string' || !UUID_RE.test(castingRecordId))) {
    return res.status(400).json({ error: 'castingRecordId must be a UUID', code: 'INVALID_CASTING_RECORD_ID' });
  }
  let dueBeforeDate = undefined;
  if (dueBefore !== undefined) {
    const parsed = parseDate(dueBefore);
    if (parsed && parsed.error) {
      return res.status(400).json({
        error: 'dueBefore must be a valid YYYY-MM-DD date',
        code: 'INVALID_DUE_BEFORE',
      });
    }
    dueBeforeDate = parsed;
  }

  try {
    const where = {};
    if (status) where.status = String(status);
    if (dprId) where.dprId = String(dprId);
    if (castingRecordId) where.castingRecordId = String(castingRecordId);
    if (dueBeforeDate) where.twentyEightDayDueDate = { lte: dueBeforeDate };

    const tests = await prisma.cubeTest.findMany({
      where,
      include: {
        castingRecord: { select: { id: true, projectName: true, reportDate: true, inspectionType: true } },
        dpr: { select: { id: true, projectName: true, reportDate: true, location: true } },
        submittedBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: [{ twentyEightDayDueDate: 'asc' }, { id: 'asc' }],
      take: 100,
    });

    res.json({ tests });
  } catch (err) {
    console.error('CubeTest list error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to fetch cube tests' });
  }
}));

// ─── POST /api/cube-tests ───────────────────────────────────────────────────
// Create a cube-test row. Auth: any employee, but:
//   - if castingRecordId is provided, the inspection must be cube_casting
//     AND must be owned by the caller
//   - if dprId is provided, the DPR must be owned by the caller
//   - if BOTH are provided, BOTH ownership checks must pass
//
// A standalone filing (no FK at all) is allowed and produces an
// unattached cube-test row. This is the "filed Sunday, link later"
// escape hatch the data model docs call out.
//
// castDate drives sevenDayDueDate / twentyEightDayDueDate (castDate + 7d /
// +28d at UTC midnight). Both are stored on the row so the list endpoint
// can sort by them without re-computing on every read.
router.post('/', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const {
    castingRecordId, dprId, pourLocation, concreteGrade, castDate,
    expectedStrength, notes,
  } = req.body || {};

  // typeof guards (mirror the inspection route's strict-shape pattern).
  if (typeof pourLocation !== 'string' || !pourLocation.trim()) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'pourLocation required' });
  }
  if (typeof concreteGrade !== 'string' || !concreteGrade.trim()) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'concreteGrade required' });
  }
  if (typeof castDate !== 'string') {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'castDate required (YYYY-MM-DD)' });
  }
  // expectedStrength: required, finite, positive, <= 200 N/mm². The cap is
  // a typo-guard (3000 N/mm² is a misread decimal) — real characteristic
  // strengths for construction-grade concrete top out around 80 N/mm².
  if (typeof expectedStrength !== 'number' || !Number.isFinite(expectedStrength) || expectedStrength <= 0 || expectedStrength > 200) {
    return res.status(400).json({
      error: 'expectedStrength must be a finite number in (0, 200]',
      code: 'INVALID_EXPECTED_STRENGTH',
    });
  }
  if (pourLocation.length > MAX.pourLocation) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: `pourLocation exceeds ${MAX.pourLocation} chars` });
  }
  if (concreteGrade.length > MAX.concreteGrade) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: `concreteGrade exceeds ${MAX.concreteGrade} chars` });
  }
  if (notes !== undefined && notes !== null) {
    if (typeof notes !== 'string' || notes.length > MAX.notes) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: `notes exceeds ${MAX.notes} chars` });
    }
  }

  // castDate → strict YYYY-MM-DD. parseDateOnlyToUtc throws on malformed
  // input; we catch and translate to 400.
  let castDateUTC;
  try {
    castDateUTC = parseDateOnlyToUtc(castDate);
  } catch (e) {
    if (e instanceof InvalidDateOnlyError) {
      return res.status(400).json({
        error: 'castDate must be a valid YYYY-MM-DD date',
        code: 'INVALID_CAST_DATE',
      });
    }
    throw e;
  }
  const sevenDayDueDate = new Date(castDateUTC);
  sevenDayDueDate.setUTCDate(sevenDayDueDate.getUTCDate() + 7);
  const twentyEightDayDueDate = new Date(castDateUTC);
  twentyEightDayDueDate.setUTCDate(twentyEightDayDueDate.getUTCDate() + 28);

  // UUID shape on FKs (if provided). Both FKs are optional, so a missing
  // value is fine — only a malformed value gets the 400.
  if (castingRecordId !== undefined && castingRecordId !== null && castingRecordId !== '') {
    if (typeof castingRecordId !== 'string' || !UUID_RE.test(castingRecordId)) {
      return res.status(400).json({ error: 'castingRecordId must be a UUID', code: 'INVALID_CASTING_RECORD_ID' });
    }
  }
  if (dprId !== undefined && dprId !== null && dprId !== '') {
    if (typeof dprId !== 'string' || !UUID_RE.test(dprId)) {
      return res.status(400).json({ error: 'dprId must be a UUID', code: 'INVALID_DPR_ID' });
    }
  }

  try {
    // Ownership / type checks for the (optional) FKs.
    //
    // The castingRecordId must reference a row whose inspectionType is
    // 'cube_casting' (this is the only kind of inspection that PRODUCES
    // cubes — a material receipt or NCR isn't a cube-cast event).
    // The check runs BEFORE the insert so a typo'd id never produces a
    // garbage row that the next day's data sweeper has to clean up.
    if (castingRecordId) {
      const inspection = await prisma.inspectionRecord.findUnique({
        where: { id: castingRecordId },
        select: { id: true, inspectionType: true, submittedById: true },
      });
      if (!inspection) {
        return res.status(404).json({ error: 'Casting inspection not found', code: 'CASTING_INSPECTION_NOT_FOUND' });
      }
      if (inspection.inspectionType !== 'cube_casting') {
        return res.status(400).json({
          error: `castingRecordId must reference a cube_casting inspection (got: ${inspection.inspectionType})`,
          code: 'INSPECTION_TYPE_INVALID',
          currentType: inspection.inspectionType,
        });
      }
      // Owner-only: an employee cannot attach their cube-test row to
      // another employee's cube_casting inspection. Admins can override
      // this — the route uses requireAuth + a fresh-admin inline read
      // (same pattern as inspection.js's create-status gate).
      if (inspection.submittedById !== req.employeeId) {
        const fresh = await prisma.employee.findUnique({
          where: { id: req.employeeId },
          select: { isAdmin: true },
        });
        if (!fresh || !fresh.isAdmin) {
          return res.status(403).json({
            error: 'Only the casting-inspection owner or an admin can attach a cube-test row to it',
            code: 'NOT_OWNER',
          });
        }
      }
    }
    if (dprId) {
      const dpr = await prisma.dPR.findUnique({
        where: { id: dprId },
        select: { id: true, submittedById: true },
      });
      if (!dpr) {
        return res.status(404).json({ error: 'DPR not found', code: 'DPR_NOT_FOUND' });
      }
      if (dpr.submittedById !== req.employeeId) {
        const fresh = await prisma.employee.findUnique({
          where: { id: req.employeeId },
          select: { isAdmin: true },
        });
        if (!fresh || !fresh.isAdmin) {
          return res.status(403).json({
            error: 'Only the DPR owner or an admin can attach a cube-test row to it',
            code: 'NOT_OWNER',
          });
        }
      }
    }

    const created = await prisma.cubeTest.create({
      data: {
        castingRecordId: castingRecordId || null,
        dprId: dprId || null,
        pourLocation: pourLocation.trim(),
        concreteGrade: concreteGrade.trim(),
        castDate: castDateUTC,
        sevenDayDueDate,
        twentyEightDayDueDate,
        expectedStrength,
        status: 'PENDING',
        submittedById: req.employeeId,
        notes: notes || null,
      },
      include: {
        castingRecord: { select: { id: true, projectName: true, reportDate: true, inspectionType: true } },
        dpr: { select: { id: true, projectName: true, reportDate: true, location: true } },
        submittedBy: { select: { id: true, name: true, email: true } },
      },
    });

    res.status(201).json(created);
  } catch (err) {
    console.error('CubeTest create error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to create cube test' });
  }
}));

// ─── GET /api/cube-tests/:id ────────────────────────────────────────────────
// Detail. Owner, dpr-submitter, or admin can read. Mirror the inspection
// detail route's auth model — the row is small, the body has no PII beyond
// the submitter's name + email which the caller is allowed to see.
router.get('/:id', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;

  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    return res.status(400).json({ error: 'id must be a UUID', code: 'INVALID_ID' });
  }

  try {
    const test = await prisma.cubeTest.findUnique({
      where: { id },
      include: {
        castingRecord: { select: { id: true, projectName: true, reportDate: true, inspectionType: true, submittedById: true } },
        dpr: { select: { id: true, projectName: true, reportDate: true, location: true, submittedById: true } },
        submittedBy: { select: { id: true, name: true, email: true } },
      },
    });
    if (!test) {
      return res.status(404).json({ error: 'Cube test not found', code: 'NOT_FOUND' });
    }

    // Auth: submitter, dpr-submitter, or admin. Re-read the caller from
    // the DB so a demoted admin can't keep reading via a stale JWT.
    const fresh = await prisma.employee.findUnique({
      where: { id: req.employeeId },
      select: { isAdmin: true },
    });
    const isAdmin = fresh && fresh.isAdmin;
    const isSubmitter = test.submittedById === req.employeeId;
    const isDprSubmitter = test.dpr && test.dpr.submittedById === req.employeeId;
    if (!isAdmin && !isSubmitter && !isDprSubmitter) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Not authorized' });
    }

    res.json(test);
  } catch (err) {
    console.error('CubeTest detail error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to fetch cube test' });
  }
}));

// ─── PATCH /api/cube-tests/:id ──────────────────────────────────────────────
// Patch a cube-test row. Used to record 7d / 28d lab results and update
// status (status is auto-derived, not accepted from the client).
//
// Auth: submitter or admin. The dpr-submitter is NOT a writer — a pour
// engineer's cube results are NOT the responsibility of the pour-logger;
// the lab QA or the cube-test submitter updates the row.
//
// PATCH is partial — only the fields present in the body are touched.
// Mass-assignment allowlist prevents IDOR via submittedById / id / etc.
//
// status transitions are derived from the comparison result >=
// expectedStrength. If both 7d and 28d results are set in the same patch,
// 28d wins (it's the spec-acceptance signal).
router.patch('/:id', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;
  const fields = req.body || {};

  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    return res.status(400).json({ error: 'id must be a UUID', code: 'INVALID_ID' });
  }

  // Mass-assignment allowlist. `status` is intentionally omitted — the
  // route derives it from the results. `castingRecordId` / `dprId` are
  // intentionally omitted — the test is filed against a specific pour and
  // re-parenting a test row is a data-integrity hazard.
  const ALLOWED_UPDATE_FIELDS = [
    'sevenDayResult', 'sevenDayTestedAt',
    'twentyEightDayResult', 'twentyEightDayTestedAt',
    'expectedStrength', 'notes',
  ];
  const unknown = Object.keys(fields).filter((k) => !ALLOWED_UPDATE_FIELDS.includes(k));
  if (unknown.length) {
    return res.status(400).json({
      error: 'UNKNOWN_FIELDS',
      message: `Fields not allowed: ${unknown.join(', ')}`,
      fields: unknown,
    });
  }

  // Result validation. Results, when present, must be finite numbers in
  // (0, 200] N/mm² — same cap as expectedStrength on create.
  for (const f of ['sevenDayResult', 'twentyEightDayResult', 'expectedStrength']) {
    if (fields[f] !== undefined && fields[f] !== null) {
      const v = fields[f];
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 200) {
        return res.status(400).json({
          error: `${f} must be a finite number in (0, 200]`,
          code: 'INVALID_RESULT',
        });
      }
    }
  }
  // testedAt timestamps: accept ISO strings or null (null clears the
  // timestamp but keeps the result, which is a useful "this result was
  // recorded but the exact time isn't known" state). parseISODateTime
  // returns null on bad input — we treat null as invalid for a fresh
  // timestamp and accept null as an explicit clear.
  for (const f of ['sevenDayTestedAt', 'twentyEightDayTestedAt']) {
    if (fields[f] !== undefined && fields[f] !== null) {
      const d = new Date(fields[f]);
      if (isNaN(d.getTime())) {
        return res.status(400).json({
          error: `${f} must be a valid ISO datetime`,
          code: 'INVALID_TESTED_AT',
        });
      }
      fields[f] = d;
    }
  }
  if (fields.notes !== undefined && fields.notes !== null) {
    if (typeof fields.notes !== 'string' || fields.notes.length > MAX.notes) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: `notes exceeds ${MAX.notes} chars` });
    }
  }

  // Cross-field sanity: setting a result without a testedAt is allowed
  // (lab may report only the number; the timestamp is back-filled later),
  // but setting a testedAt without a result is rejected — a time without a
  // value is meaningless and usually a client bug.
  if (fields.sevenDayTestedAt && fields.sevenDayResult === undefined) {
    return res.status(400).json({
      error: 'sevenDayTestedAt requires sevenDayResult',
      code: 'TESTED_AT_WITHOUT_RESULT',
    });
  }
  if (fields.twentyEightDayTestedAt && fields.twentyEightDayResult === undefined) {
    return res.status(400).json({
      error: 'twentyEightDayTestedAt requires twentyEightDayResult',
      code: 'TESTED_AT_WITHOUT_RESULT',
    });
  }

  try {
    const existing = await prisma.cubeTest.findUnique({
      where: { id },
      select: {
        id: true,
        submittedById: true,
        sevenDayResult: true,
        twentyEightDayResult: true,
        expectedStrength: true,
      },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Cube test not found', code: 'NOT_FOUND' });
    }
    // Auth: submitter or admin. Use the fresh-admin inline read so a
    // demoted admin cannot keep mutating via a stale JWT.
    const fresh = await prisma.employee.findUnique({
      where: { id: req.employeeId },
      select: { isAdmin: true },
    });
    const isAdmin = fresh && fresh.isAdmin;
    if (!isAdmin && existing.submittedById !== req.employeeId) {
      return res.status(403).json({ error: 'Only the submitter or an admin can update a cube test', code: 'FORBIDDEN' });
    }

    // Derive the new status from the merged result-set. Reading the row
    // first and merging the patch on top gives a single source of truth
    // for the comparison — Prisma does the actual write.
    const mergedSevenDay = fields.sevenDayResult !== undefined ? fields.sevenDayResult : existing.sevenDayResult;
    const mergedTwentyEightDay = fields.twentyEightDayResult !== undefined ? fields.twentyEightDayResult : existing.twentyEightDayResult;
    const mergedExpected = fields.expectedStrength !== undefined ? fields.expectedStrength : existing.expectedStrength;
    const newStatus = deriveStatus({
      sevenDayResult: mergedSevenDay,
      twentyEightDayResult: mergedTwentyEightDay,
      expectedStrength: mergedExpected,
    });

    const updated = await prisma.cubeTest.update({
      where: { id },
      data: {
        ...fields,
        status: newStatus,
        updatedAt: new Date(),
      },
      include: {
        castingRecord: { select: { id: true, projectName: true, reportDate: true, inspectionType: true } },
        dpr: { select: { id: true, projectName: true, reportDate: true, location: true } },
        submittedBy: { select: { id: true, name: true, email: true } },
      },
    });

    res.json(updated);
  } catch (err) {
    console.error('CubeTest patch error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to update cube test' });
  }
}));

module.exports = router;
