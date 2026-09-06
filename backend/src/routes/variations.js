// N2 (Phase C — ACS Portal): Variation Order routes.
//
// Wires the new `variation_order` table into the API surface so the
// frontend can:
//   - list variation orders (filtered by projectId, status, from/to, cursor)
//   - create a new variation order (any authenticated employee; raisedById
//     is server-set from req.employeeId)
//   - fetch one variation's detail (with project + reference RFI expanded)
//   - patch a DRAFT variation (title / description / deltaAmount /
//     clientApprovalRequired — NOT raiser, NOT status)
//   - submit (DRAFT → SUBMITTED) by the raiser or an admin
//   - approve (SUBMITTED → APPROVED) by an admin (fresh-admin re-read)
//   - reject (SUBMITTED → REJECTED) by an admin; requires rejected_reason
//
// Auth model
//   List / detail / create   — requireAuth
//   PATCH DRAFT              — raiser or admin
//   submit                   — raiser or admin
//   approve / reject         — requireFreshAdmin
//
// Status lifecycle
//   DRAFT → SUBMITTED → APPROVED | REJECTED. Terminal states
//   (APPROVED, REJECTED) are immutable — the route refuses any further
//   transition with 409 INVALID_TRANSITION, mirroring the dpr.js
//   terminal-state contract.

'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin, requireFreshAdmin } = require('../middleware/auth');
const { mapPrismaError, parseStrictISODate, toDateOnly } = require('../lib/errors');
const { hashIdentifier } = require('../lib/pii');
const { encodeCursor, decodeCursor, InvalidCursorError } = require('../lib/cursor');

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function getPrisma(req) { return req.app.get('prisma'); }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Lifecycle states. Mirrors the schema (model VariationOrder) status
// default + the migration header comment. One Set keeps the read AND
// the write paths in agreement — a typo'd status would otherwise
// persist because the column is a free-form String.
const ALLOWED_VARIATION_STATUSES = new Set(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED']);

// Per-action allowed source-status sets. Inline rather than a Map
// because the route uses a single fresh-admin / inline-admin re-read
// per state transition (no shared transaction). Encoded so a future
// "recall" action (SUBMITTED → DRAFT by the raiser) lands in one place.
const VARIATION_TRANSITIONS = {
  DRAFT: new Set(['SUBMITTED']),
  SUBMITTED: new Set(['APPROVED', 'REJECTED']),
  APPROVED: new Set(),
  REJECTED: new Set(),
};

// Field-length caps (mirror the migration header).
const VARIATION_FIELD_MAX = {
  title: 200,
  description: 4000,
  rejectedReason: 1000,
};

// deltaAmount upper bound matches Project.contractValue's
// NUMERIC(15,2) ceiling so a typo (e.g. 10^15) fails fast instead of
// silently saturating the column. Lower bound is -same ceiling (a
// variation can reduce scope — the "credit" case).
const DELTA_AMOUNT_MIN = -999999999999.99;
const DELTA_AMOUNT_MAX = 999999999999.99;

router.use(requireAuth);

// ─── GET /api/variations ────────────────────────────────────────────────────
//
// List variation orders with filters. Auth: any authenticated employee.
//
// Query params:
//   projectId   — UUID, exact match
//   status      — one of DRAFT, SUBMITTED, APPROVED, REJECTED
//   from / to   — YYYY-MM-DD; window on createdAt
//   cursor      — base64url JSON { date, id }
//   limit       — 1..100, default 20
//
// No `myOnly` flag for v1 — variations are org-visible by default. The
// raiser field is exposed on the row so the frontend can render
// "raised by <name>" without an extra round-trip.
router.get('/', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const {
    cursor, limit = '20',
    status: statusFilter,
    projectId: projectIdFilter,
    from, to,
  } = req.query;

  const take = Math.min(parseInt(limit) || 20, 100);

  let cursorWhere = {};
  if (cursor) {
    let decoded;
    try {
      decoded = decodeCursor(cursor);
    } catch (e) {
      if (e instanceof InvalidCursorError) {
        return res.status(400).json({ error: 'INVALID_CURSOR', message: e.message || 'Cursor is malformed' });
      }
      return res.status(400).json({ error: 'INVALID_CURSOR', message: 'Cursor could not be decoded' });
    }
    cursorWhere = {
      OR: [
        { createdAt: { lt: decoded.date } },
        { createdAt: decoded.date, id: { lt: decoded.id } },
      ],
    };
  }

  if (statusFilter !== undefined && !ALLOWED_VARIATION_STATUSES.has(String(statusFilter))) {
    return res.status(400).json({
      error: `status must be one of: ${[...ALLOWED_VARIATION_STATUSES].join(', ')}`,
      code: 'STATUS_INVALID',
    });
  }
  if (projectIdFilter !== undefined) {
    if (typeof projectIdFilter !== 'string' || !UUID_RE.test(projectIdFilter)) {
      return res.status(400).json({ error: 'projectId must be a UUID', code: 'INVALID_PROJECT_ID' });
    }
  }
  const dateFilter = {};
  if (from) {
    const d = parseStrictISODate(from);
    if (!d.ok) return res.status(400).json({ error: 'INVALID_FROM', message: 'from must be a valid YYYY-MM-DD date' });
    dateFilter.gte = d.date;
  }
  if (to) {
    const d = parseStrictISODate(to);
    if (!d.ok) return res.status(400).json({ error: 'INVALID_TO', message: 'to must be a valid YYYY-MM-DD date' });
    dateFilter.lte = d.date;
  }

  try {
    const where = {
      ...(statusFilter ? { status: String(statusFilter) } : {}),
      ...(projectIdFilter ? { projectId: projectIdFilter } : {}),
      ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}),
      ...(Object.keys(cursorWhere).length ? cursorWhere : {}),
    };

    const variations = await prisma.variationOrder.findMany({
      where,
      include: {
        project: { select: { id: true, name: true, code: true } },
        raisedBy: { select: { id: true, name: true, email: true } },
        approvedBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });

    const hasMore = variations.length > take;
    const items = (hasMore ? variations.slice(0, -1) : variations).map((v) => ({
      ...v,
      // Decimal columns serialize via toString() to preserve precision.
      // Same contract as projects.js serializeProject — a 15-digit
      // deltaAmount would silently lose precision through Number().
      deltaAmount: v.deltaAmount == null
        ? null
        : (typeof v.deltaAmount === 'string' || typeof v.deltaAmount === 'number')
          ? v.deltaAmount
          : (typeof v.deltaAmount.toString === 'function' ? v.deltaAmount.toString() : v.deltaAmount),
    }));

    const lastItem = items[items.length - 1];
    let nextCursor = null;
    if (hasMore && lastItem && lastItem.id) {
      try {
        nextCursor = encodeCursor(lastItem.createdAt, lastItem.id);
      } catch (e) {
        console.error('Variation cursor encode failed', { err: e.message });
        nextCursor = null;
      }
    }

    res.setHeader('X-Total-Count', items.length);
    res.setHeader('X-Has-More', hasMore ? 'true' : 'false');
    res.json({ variations: items, nextCursor });
  } catch (err) {
    console.error('Variation list error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to fetch variations' });
  }
}));

// ─── POST /api/variations ───────────────────────────────────────────────────
//
// Create a new variation order. Auth: any authenticated employee.
// raisedById is server-set from req.employeeId; the body cannot
// smuggle a different raiser in.
//
// projectId is REQUIRED (a variation must be project-anchored — the
// schema column is NOT NULL).
router.post('/', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const {
    projectId, title, description, deltaAmount,
    clientApprovalRequired,
  } = req.body || {};

  // typeof / required guards.
  if (typeof projectId !== 'string' || !UUID_RE.test(projectId)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'PROJECT_ID_REQUIRED', message: 'projectId is required and must be a UUID' });
  }
  if (typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'TITLE_REQUIRED', message: 'title is required' });
  }
  if (title.length > VARIATION_FIELD_MAX.title) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: `title exceeds ${VARIATION_FIELD_MAX.title} chars` });
  }
  if (description !== undefined && description !== null && description !== '') {
    if (typeof description !== 'string' || description.length > VARIATION_FIELD_MAX.description) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: `description exceeds ${VARIATION_FIELD_MAX.description} chars` });
    }
  }

  // deltaAmount: required (a variation without a monetary delta is a
  // scope change without budget impact — degenerate; reject). Accept
  // number, numeric string, or stringified Decimal.
  let resolvedDelta;
  if (deltaAmount === undefined || deltaAmount === null || deltaAmount === '') {
    return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'DELTA_AMOUNT_REQUIRED', message: 'deltaAmount is required' });
  }
  const n = typeof deltaAmount === 'string' ? Number(deltaAmount) : deltaAmount;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < DELTA_AMOUNT_MIN || n > DELTA_AMOUNT_MAX) {
    return res.status(400).json({
      error: `deltaAmount must be a finite number in [${DELTA_AMOUNT_MIN}, ${DELTA_AMOUNT_MAX}]`,
      code: 'INVALID_DELTA_AMOUNT',
    });
  }
  resolvedDelta = n;

  // clientApprovalRequired: optional, default true.
  let resolvedClientApproval = true;
  if (clientApprovalRequired !== undefined && clientApprovalRequired !== null) {
    if (typeof clientApprovalRequired !== 'boolean') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_CLIENT_APPROVAL', message: 'clientApprovalRequired must be boolean' });
    }
    resolvedClientApproval = clientApprovalRequired;
  }

  // (Round-29 — referenceRfiId is no longer accepted. The RFI feature was
  // removed entirely; VOs are now standalone work items. Any stale
  // referenceRfiId on the request is silently ignored to keep older
  // client payloads from erroring.)

  try {
    // Project existence + active check.
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, isActive: true },
    });
    if (!project) {
      return res.status(400).json({ error: 'PROJECT_NOT_FOUND', code: 'PROJECT_NOT_FOUND', message: 'Linked project does not exist' });
    }
    if (!project.isActive) {
      return res.status(400).json({ error: 'PROJECT_INACTIVE', code: 'PROJECT_INACTIVE', message: 'Linked project is archived' });
    }

    const created = await prisma.variationOrder.create({
      data: {
        projectId,
        title: title.trim(),
        description: (typeof description === 'string') ? description : null,
        deltaAmount: resolvedDelta,
        status: 'DRAFT',
        clientApprovalRequired: resolvedClientApproval,
        raisedById: req.employeeId,
      },
      include: {
        project: { select: { id: true, name: true, code: true } },
        raisedBy: { select: { id: true, name: true, email: true } },
        approvedBy: { select: { id: true, name: true, email: true } },
      },
    });

    // Serialize the Decimal as a string so the wire format doesn't
    // silently lose precision.
    res.status(201).json({
      ...created,
      deltaAmount: created.deltaAmount == null
        ? null
        : (typeof created.deltaAmount === 'string' || typeof created.deltaAmount === 'number')
          ? created.deltaAmount
          : (typeof created.deltaAmount.toString === 'function' ? created.deltaAmount.toString() : created.deltaAmount),
    });
  } catch (err) {
    console.error('Variation create error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to create variation' });
  }
}));

// ─── GET /api/variations/:id ────────────────────────────────────────────────
//
// Detail. Auth: any authenticated employee. Returns the row with the
// project + reference RFI + raiser + approver expanded.
router.get('/:id', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;

  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    return res.status(400).json({ error: 'id must be a UUID', code: 'INVALID_ID' });
  }

  try {
    const variation = await prisma.variationOrder.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, name: true, code: true } },
        raisedBy: { select: { id: true, name: true, email: true } },
        approvedBy: { select: { id: true, name: true, email: true } },
      },
    });
    if (!variation) {
      return res.status(404).json({ error: 'Variation not found', code: 'NOT_FOUND' });
    }

    res.json({
      ...variation,
      deltaAmount: variation.deltaAmount == null
        ? null
        : (typeof variation.deltaAmount === 'string' || typeof variation.deltaAmount === 'number')
          ? variation.deltaAmount
          : (typeof variation.deltaAmount.toString === 'function' ? variation.deltaAmount.toString() : variation.deltaAmount),
    });
  } catch (err) {
    console.error('Variation detail error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to fetch variation' });
  }
}));

// ─── PATCH /api/variations/:id ──────────────────────────────────────────────
//
// Partial update. Auth: raiser or admin. The route refuses PATCHes to
// rows in terminal states (APPROVED, REJECTED) with 409 — terminal is
// terminal, mirrors dpr.js.
//
// Mass-assignment allowlist: only the editable content fields
// (title, description, deltaAmount, clientApprovalRequired). Status
// transitions go through /submit, /approve, /reject — never PATCH
// (which would let a non-admin mark a variation APPROVED via a body
// of { status: 'APPROVED' }).
const ALLOWED_UPDATE_FIELDS = [
  'title', 'description', 'deltaAmount', 'clientApprovalRequired',
];

// Inline admin gate for DRAFT edits. requireFreshAdmin is reserved
// for the approve/reject mutations (where stale-JWT risk matters
// most). DRAFT edits by a non-admin raiser don't need a fresh-admin
// re-read; the inline isAdmin lookup is enough.
async function isCallerAdmin(prisma, employeeId) {
  const fresh = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { isAdmin: true },
  });
  return !!(fresh && fresh.isAdmin);
}

router.patch('/:id', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;

  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    return res.status(400).json({ error: 'id must be a UUID', code: 'INVALID_ID' });
  }

  const fields = req.body || {};
  const unknown = Object.keys(fields).filter((k) => !ALLOWED_UPDATE_FIELDS.includes(k));
  if (unknown.length) {
    return res.status(400).json({
      error: 'UNKNOWN_FIELDS',
      message: `Fields not allowed: ${unknown.join(', ')}`,
      fields: unknown,
    });
  }

  // Length + value caps.
  if (fields.title !== undefined && fields.title !== null) {
    if (typeof fields.title !== 'string' || fields.title.length > VARIATION_FIELD_MAX.title) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: `title must be a string ≤ ${VARIATION_FIELD_MAX.title} chars` });
    }
  }
  if (fields.description !== undefined && fields.description !== null) {
    if (typeof fields.description !== 'string' || fields.description.length > VARIATION_FIELD_MAX.description) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: `description must be a string ≤ ${VARIATION_FIELD_MAX.description} chars` });
    }
  }
  if (fields.deltaAmount !== undefined && fields.deltaAmount !== null) {
    const n = typeof fields.deltaAmount === 'string' ? Number(fields.deltaAmount) : fields.deltaAmount;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < DELTA_AMOUNT_MIN || n > DELTA_AMOUNT_MAX) {
      return res.status(400).json({
        error: `deltaAmount must be a finite number in [${DELTA_AMOUNT_MIN}, ${DELTA_AMOUNT_MAX}]`,
        code: 'INVALID_DELTA_AMOUNT',
      });
    }
    fields.deltaAmount = n;
  }
  if (fields.clientApprovalRequired !== undefined && fields.clientApprovalRequired !== null) {
    if (typeof fields.clientApprovalRequired !== 'boolean') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_CLIENT_APPROVAL', message: 'clientApprovalRequired must be boolean' });
    }
  }

  try {
    const existing = await prisma.variationOrder.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Variation not found', code: 'NOT_FOUND' });
    }

    // Auth: raiser or admin.
    const callerIsAdmin = await isCallerAdmin(prisma, req.employeeId);
    const isRaiser = existing.raisedById === req.employeeId;
    if (!callerIsAdmin && !isRaiser) {
      return res.status(403).json({ error: 'Only the raiser or an admin can edit a variation', code: 'FORBIDDEN' });
    }

    // DRAFT-only edits. Terminal states (APPROVED, REJECTED) and the
    // SUBMITTED state are immutable through PATCH — a SUBMITTED
    // variation is awaiting an admin decision; the raiser must
    // /recall (out of scope for v1) rather than edit silently.
    if (existing.status !== 'DRAFT') {
      return res.status(409).json({
        error: `Cannot edit a variation in status ${existing.status}`,
        code: 'INVALID_TRANSITION',
        currentStatus: existing.status,
      });
    }

    const updated = await prisma.variationOrder.update({
      where: { id },
      data: fields,
      include: {
        project: { select: { id: true, name: true, code: true } },
        raisedBy: { select: { id: true, name: true, email: true } },
        approvedBy: { select: { id: true, name: true, email: true } },
      },
    });

    res.json({
      ...updated,
      deltaAmount: updated.deltaAmount == null
        ? null
        : (typeof updated.deltaAmount === 'string' || typeof updated.deltaAmount === 'number')
          ? updated.deltaAmount
          : (typeof updated.deltaAmount.toString === 'function' ? updated.deltaAmount.toString() : updated.deltaAmount),
    });
  } catch (err) {
    console.error('Variation patch error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to update variation' });
  }
}));

// ─── POST /api/variations/:id/submit ────────────────────────────────────────
//
// State transition: DRAFT → SUBMITTED. Raiser or admin.
//
// This is a "soft lock" — once submitted, the raiser can no longer
// edit the row (terminal lock is the SUBMITTED → APPROVED/REJECTED
// decision; a future /recall action could unwind it).
router.post('/:id/submit', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;

  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    return res.status(400).json({ error: 'id must be a UUID', code: 'INVALID_ID' });
  }

  try {
    const existing = await prisma.variationOrder.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Variation not found', code: 'NOT_FOUND' });
    }
    const callerIsAdmin = await isCallerAdmin(prisma, req.employeeId);
    const isRaiser = existing.raisedById === req.employeeId;
    if (!callerIsAdmin && !isRaiser) {
      return res.status(403).json({ error: 'Only the raiser or an admin can submit a variation', code: 'FORBIDDEN' });
    }

    if (!VARIATION_TRANSITIONS[existing.status].has('SUBMITTED')) {
      return res.status(409).json({
        error: `Cannot move variation from ${existing.status} to SUBMITTED`,
        code: 'INVALID_TRANSITION',
        currentStatus: existing.status,
      });
    }

    const updated = await prisma.variationOrder.update({
      where: { id },
      data: {
        status: 'SUBMITTED',
        submittedAt: new Date(),
      },
      include: {
        project: { select: { id: true, name: true, code: true } },
        raisedBy: { select: { id: true, name: true, email: true } },
        approvedBy: { select: { id: true, name: true, email: true } },
      },
    });

    res.json({
      ...updated,
      deltaAmount: updated.deltaAmount == null
        ? null
        : (typeof updated.deltaAmount === 'string' || typeof updated.deltaAmount === 'number')
          ? updated.deltaAmount
          : (typeof updated.deltaAmount.toString === 'function' ? updated.deltaAmount.toString() : updated.deltaAmount),
    });
  } catch (err) {
    console.error('Variation submit error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to submit variation' });
  }
}));

// ─── POST /api/variations/:id/approve ───────────────────────────────────────
//
// State transition: SUBMITTED → APPROVED. Admin only. requireFreshAdmin
// re-reads isAdmin from the DB so a freshly demoted admin cannot
// approve via a stale JWT — same LPR-007 fix used by dpr.js.
router.post('/:id/approve', requireFreshAdmin, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;

  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    return res.status(400).json({ error: 'id must be a UUID', code: 'INVALID_ID' });
  }

  try {
    const existing = await prisma.variationOrder.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Variation not found', code: 'NOT_FOUND' });
    }
    if (!VARIATION_TRANSITIONS[existing.status].has('APPROVED')) {
      return res.status(409).json({
        error: `Cannot approve a variation in status ${existing.status}`,
        code: 'INVALID_TRANSITION',
        currentStatus: existing.status,
      });
    }

    const updated = await prisma.variationOrder.update({
      where: { id },
      data: {
        status: 'APPROVED',
        approvedById: req.employeeId,
        approvedAt: new Date(),
        rejectedAt: null,
        rejectedReason: null,
      },
      include: {
        project: { select: { id: true, name: true, code: true } },
        raisedBy: { select: { id: true, name: true, email: true } },
        approvedBy: { select: { id: true, name: true, email: true } },
      },
    });

    res.json({
      ...updated,
      deltaAmount: updated.deltaAmount == null
        ? null
        : (typeof updated.deltaAmount === 'string' || typeof updated.deltaAmount === 'number')
          ? updated.deltaAmount
          : (typeof updated.deltaAmount.toString === 'function' ? updated.deltaAmount.toString() : updated.deltaAmount),
    });
  } catch (err) {
    console.error('Variation approve error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to approve variation' });
  }
}));

// ─── POST /api/variations/:id/reject ────────────────────────────────────────
//
// State transition: SUBMITTED → REJECTED. Admin only. Requires a
// rejectedReason so the raiser knows what to revise. Mirrors the
// dpr.js /reject endpoint contract.
router.post('/:id/reject', requireFreshAdmin, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;

  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    return res.status(400).json({ error: 'id must be a UUID', code: 'INVALID_ID' });
  }

  const { reason } = req.body || {};
  if (typeof reason !== 'string' || !reason.trim()) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'REASON_REQUIRED', message: 'reason is required' });
  }
  if (reason.length > VARIATION_FIELD_MAX.rejectedReason) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: `reason exceeds ${VARIATION_FIELD_MAX.rejectedReason} chars` });
  }

  try {
    const existing = await prisma.variationOrder.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'Variation not found', code: 'NOT_FOUND' });
    }
    if (!VARIATION_TRANSITIONS[existing.status].has('REJECTED')) {
      return res.status(409).json({
        error: `Cannot reject a variation in status ${existing.status}`,
        code: 'INVALID_TRANSITION',
        currentStatus: existing.status,
      });
    }

    const updated = await prisma.variationOrder.update({
      where: { id },
      data: {
        status: 'REJECTED',
        approvedById: null,
        approvedAt: null,
        rejectedAt: new Date(),
        rejectedReason: reason.trim(),
      },
      include: {
        project: { select: { id: true, name: true, code: true } },
        raisedBy: { select: { id: true, name: true, email: true } },
        approvedBy: { select: { id: true, name: true, email: true } },
      },
    });

    res.json({
      ...updated,
      deltaAmount: updated.deltaAmount == null
        ? null
        : (typeof updated.deltaAmount === 'string' || typeof updated.deltaAmount === 'number')
          ? updated.deltaAmount
          : (typeof updated.deltaAmount.toString === 'function' ? updated.deltaAmount.toString() : updated.deltaAmount),
    });
  } catch (err) {
    console.error('Variation reject error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to reject variation' });
  }
}));

module.exports = router;
// expose the pure helpers for inline / unit-style tests
module.exports.ALLOWED_VARIATION_STATUSES = ALLOWED_VARIATION_STATUSES;
module.exports.VARIATION_TRANSITIONS = VARIATION_TRANSITIONS;
module.exports.VARIATION_FIELD_MAX = VARIATION_FIELD_MAX;
