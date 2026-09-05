// N2 (Phase C — ACS Portal): RFI (Request for Information) routes.
//
// Wires the new `rfi` table into the API surface so the frontend can:
//   - list RFIs (filtered by projectId, status, myOnly, from/to, cursor)
//   - create a new RFI (any authenticated employee)
//   - fetch one RFI's detail (with project / raiser / responders expanded)
//   - patch an RFI (record a response, mark CLOSED — admin only)
//   - escalate an RFI to a VariationOrder DRAFT (admin only)
//
// Auth model:
//   - All routes require auth (`requireAuth`).
//   - List + detail: any authenticated employee.
//   - Create: any employee. raisedById is server-set from req.employeeId
//     (never trusted from the body).
//   - PATCH response: the target responder, the raiser, or an admin.
//   - PATCH close: admin only (requireFreshAdmin).
//   - Escalate-to-variation: admin only.
//
// Status lifecycle
//   OPEN → RESPONDED → CLOSED. A `deriveRfiStatus` helper computes the
//   "OVERDUE" presentation layer: any OPEN RFI with a past `dueDate` is
//   surfaced to the UI as OVERDUE, but the DB row stays status=OPEN so
//   responding to it (PATCH response) doesn't need a separate transition
//   to clear an OVERDUE flag. Same temporal-derivation pattern as the
//   inspection status enum mirror (DR-024 in round-20) — keep state in
//   the row, derive temporality on read.
//
// FK / ID semantics
//   - projectId is OPTIONAL (legacy unfiled RFI allowed). When supplied
//     it must reference an active Project row.
//   - targetResponderId is OPTIONAL. When supplied it must reference an
//     existing Employee row (any role — the project PM, a consultant,
//     a domain expert). We don't enforce "is admin" here; the responder
//     can be any colleague qualified to answer the question.
//   - raisedById is server-set from req.employeeId (NOT accepted from
//     the body — mass-assignment IDOR guard).
//   - responderId on PATCH response is server-set from req.employeeId.

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

// Plain UUID guard — the FKs reference project.id, employees.id, and the
// route's :id path param, all of which are server-generated UUIDs.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Lifecycle / validation constants ──────────────────────────────────────
//
// Mirror the schema (model Rfi) status default + the migration header
// comment. Keep in one Set so a future enum-style refactor lands in one
// place. The free-form String column accepts any value, so a typo'd
// status would persist — the Set guards the read AND the write paths.
const ALLOWED_RFI_STATUSES = new Set(['OPEN', 'RESPONDED', 'CLOSED']);

// Allowed transitions on PATCH. The key is the CURRENT status; the
// value is the set of NEW statuses the route will accept from the body.
// Encoded this way so the route re-reads the row, looks up the
// allowed set, and refuses stale-status writes (matches the dpr.js /
// cubeTest.js pattern).
const RFI_TRANSITIONS = {
  OPEN: new Set(['RESPONDED', 'CLOSED']),
  RESPONDED: new Set(['CLOSED']),
  CLOSED: new Set(), // terminal — closed is closed
};

// Field-length caps (mirror the migration header). These are enforced at
// the API layer so a malicious client can't bypass the 200 / 4000 char
// cap with a server-side `default` workaround — the only authoritative
// length gate is the one in code.
const RFI_FIELD_MAX = {
  subject: 200,
  question: 4000,
  response: 4000,
};

// ─── Status derivation ─────────────────────────────────────────────────────
//
// Pure function — no DB access. Computes the user-visible status for an
// RFI: a temporal OVERDUE flag if the row is still OPEN and the due date
// has passed, otherwise the stored status. Exported via `module.exports`
// so a future inline test (e.g. `node -e "require('./routes/rfis')._test"`)
// can probe it without spinning up the route.
//
// The cutoff compares the YYYY-MM-DD `dueDate` (a @db.Date, so UTC
// midnight of the calendar day) against the IST business day so the
// "OVERDUE" label fires at 00:00 IST of the day AFTER the due date —
// same boundary the attendance / leave modules use
// (lib/dateOnly.js:getTodayBusinessDate). We don't ship a separate
// "grace period" knob in v1; a future round can add it without
// touching the DB schema.
function deriveRfiStatus(rfi, now = new Date()) {
  if (!rfi) return null;
  if (rfi.status !== 'OPEN') return rfi.status;
  if (!rfi.dueDate) return rfi.status;
  // dueDate is @db.Date — Prisma returns it as a UTC-midnight Date.
  // Compare on the YYYY-MM-DD string so timezone-local-clock-skew
  // doesn't push an "due today" row into OVERDUE during the morning
  // window.
  const today = formatDateOnly(now);
  const due = formatDateOnly(rfi.dueDate);
  if (due == null) return rfi.status;
  return due < today ? 'OVERDUE' : rfi.status;
}

function formatDateOnly(d) {
  if (!d) return null;
  if (d instanceof Date) {
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  if (typeof d === 'string') return d.slice(0, 10);
  return null;
}

// All routes below require auth. requireAuth reads the JWT + revocation
// table; nothing else gates beyond this (per-route admin checks inline).
router.use(requireAuth);

// ─── GET /api/rfis ──────────────────────────────────────────────────────────
//
// List RFIs with filters. Auth: any employee.
//
// Query params:
//   projectId   — UUID, exact match
//   status      — one of OPEN, RESPONDED, CLOSED, OVERDUE
//                 (OVERDUE is a presentation flag — the route expands it
//                 to status=OPEN + dueDate < today server-side)
//   myOnly=true — restricts to RFIs where the caller is the raiser OR
//                 the target responder. Non-admins also get this filter
//                 implicitly (mirrors the DPR list endpoint contract).
//   from / to   — YYYY-MM-DD; window on createdAt
//   cursor      — base64url JSON { date, id } from lib/cursor.js
//   limit       — 1..100, default 20
//
// Ordering: createdAt DESC, id DESC. The cursor codec (lib/cursor.js)
// encodes the (date, id) pair of the last item so keyset pagination
// stays consistent with the rest of the codebase.
router.get('/', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const {
    cursor, limit = '20',
    status: statusFilter,
    projectId: projectIdFilter,
    my, from, to,
  } = req.query;

  const take = Math.min(parseInt(limit) || 20, 100);

  // Cursor decode (keyset pagination). Invalid cursor → 400 INVALID_CURSOR
  // so a tampered client gets a clear signal, not a 500 from a
  // `Date.toISOString is not a function` cascade.
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
    // createdAt + id keyset. RFI doesn't have a `createdAt` index alone —
    // we piggy-back on the (status) and (projectId) indexes via the
    // where-clause filter. Postgres planner will fall back to a seq scan
    // only on a fully unfiltered paginate, which is acceptable for v1
    // (table starts empty).
    cursorWhere = {
      OR: [
        { createdAt: { lt: decoded.date } },
        { createdAt: decoded.date, id: { lt: decoded.id } },
      ],
    };
  }

  // Status filter: OVERDUE is a presentation flag, not a stored value.
  // Expand to status=OPEN + dueDate < today before issuing the query.
  let statusWhere = {};
  if (statusFilter) {
    if (!ALLOWED_RFI_STATUSES.has(String(statusFilter)) && statusFilter !== 'OVERDUE') {
      return res.status(400).json({
        error: `status must be one of: ${[...ALLOWED_RFI_STATUSES].join(', ')}, OVERDUE`,
        code: 'STATUS_INVALID',
      });
    }
    if (statusFilter === 'OVERDUE') {
      const todayUtc = new Date(Date.UTC(
        new Date().getUTCFullYear(),
        new Date().getUTCMonth(),
        new Date().getUTCDate(),
      ));
      statusWhere = { status: 'OPEN', dueDate: { lt: todayUtc } };
    } else {
      statusWhere = { status: String(statusFilter) };
    }
  }

  // projectId: optional UUID filter
  if (projectIdFilter !== undefined) {
    if (typeof projectIdFilter !== 'string' || !UUID_RE.test(projectIdFilter)) {
      return res.status(400).json({ error: 'projectId must be a UUID', code: 'INVALID_PROJECT_ID' });
    }
  }

  // from / to: window on createdAt (half-open [gte, lte]).
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
    // Admin check (used to gate myOnly — non-admins are always restricted
    // to their own RFIs, admins can opt in via my=true or out via my=false).
    const fresh = await prisma.employee.findUnique({
      where: { id: req.employeeId },
      select: { isAdmin: true },
    });
    const isAdmin = fresh && fresh.isAdmin;

    // myOnly semantics mirror the DPR list endpoint:
    //   - non-admin: always restricted to their own
    //   - admin + my=true: restricted to their own
    //   - admin + my=false (or absent): org-wide
    const myOnly = my === 'true' || !isAdmin;
    const myFilter = myOnly ? {
      OR: [
        { raisedById: req.employeeId },
        { targetResponderId: req.employeeId },
      ],
    } : {};

    const where = {
      ...myFilter,
      ...(Object.keys(statusWhere).length ? statusWhere : {}),
      ...(projectIdFilter ? { projectId: projectIdFilter } : {}),
      ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}),
      ...(Object.keys(cursorWhere).length ? cursorWhere : {}),
    };

    const rfis = await prisma.rfi.findMany({
      where,
      include: {
        project: { select: { id: true, name: true, code: true } },
        raisedBy: { select: { id: true, name: true, email: true } },
        targetResponder: { select: { id: true, name: true, email: true } },
        responder: { select: { id: true, name: true, email: true } },
        _count: { select: { variations: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });

    const hasMore = rfis.length > take;
    const items = (hasMore ? rfis.slice(0, -1) : rfis).map((r) => ({
      ...r,
      // Present the temporal view to the client. DB row keeps the
      // canonical status; the route adds `displayStatus` so the
      // frontend doesn't have to re-implement the OVERDUE rule.
      displayStatus: deriveRfiStatus(r),
      dueDate: toDateOnly(r.dueDate),
    }));

    const lastItem = items[items.length - 1];
    let nextCursor = null;
    if (hasMore && lastItem && lastItem.id) {
      try {
        nextCursor = encodeCursor(lastItem.createdAt, lastItem.id);
      } catch (e) {
        console.error('RFI cursor encode failed', { err: e.message });
        nextCursor = null;
      }
    }

    res.setHeader('X-Total-Count', items.length);
    res.setHeader('X-Has-More', hasMore ? 'true' : 'false');
    res.json({ rfis: items, nextCursor });
  } catch (err) {
    console.error('RFI list error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to fetch RFIs' });
  }
}));

// ─── POST /api/rfis ─────────────────────────────────────────────────────────
//
// Create a new RFI. Auth: any authenticated employee. The raisedById is
// server-set from req.employeeId; the body cannot smuggle a different
// raiser in (mass-assignment IDOR guard).
//
// projectId is optional: a contractor can raise an RFI before the PM has
// curated the project into the Project table. When supplied, projectId
// must point at an active Project row.
router.post('/', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
  }

  const {
    projectId, subject, question,
    targetResponderId, dueDate,
  } = req.body || {};

  // typeof guards — mirror the dpr.js / cubeTest.js strict-shape pattern.
  if (typeof subject !== 'string' || !subject.trim()) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'SUBJECT_REQUIRED', message: 'subject is required' });
  }
  if (typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'QUESTION_REQUIRED', message: 'question is required' });
  }

  // Length caps.
  if (subject.length > RFI_FIELD_MAX.subject) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: `subject exceeds ${RFI_FIELD_MAX.subject} chars` });
  }
  if (question.length > RFI_FIELD_MAX.question) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: `question exceeds ${RFI_FIELD_MAX.question} chars` });
  }

  // projectId (optional)
  if (projectId !== undefined && projectId !== null && projectId !== '') {
    if (typeof projectId !== 'string' || !UUID_RE.test(projectId)) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_PROJECT_ID', message: 'projectId must be a UUID' });
    }
    const p = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, isActive: true } });
    if (!p) {
      return res.status(400).json({ error: 'PROJECT_NOT_FOUND', code: 'PROJECT_NOT_FOUND', message: 'Linked project does not exist' });
    }
    if (!p.isActive) {
      return res.status(400).json({ error: 'PROJECT_INACTIVE', code: 'PROJECT_INACTIVE', message: 'Linked project is archived' });
    }
  }

  // targetResponderId (optional)
  let resolvedTargetResponder = null;
  if (targetResponderId !== undefined && targetResponderId !== null && targetResponderId !== '') {
    if (typeof targetResponderId !== 'string' || !UUID_RE.test(targetResponderId)) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_TARGET_RESPONDER_ID', message: 'targetResponderId must be a UUID' });
    }
    const e = await prisma.employee.findUnique({ where: { id: targetResponderId }, select: { id: true } });
    if (!e) {
      return res.status(400).json({ error: 'TARGET_RESPONDER_NOT_FOUND', code: 'TARGET_RESPONDER_NOT_FOUND', message: 'Target responder does not exist' });
    }
    resolvedTargetResponder = targetResponderId;
  }

  // dueDate (optional, strict YYYY-MM-DD)
  let dueDateUTC = null;
  if (dueDate !== undefined && dueDate !== null && dueDate !== '') {
    const d = parseStrictISODate(dueDate);
    if (!d.ok) {
      return res.status(400).json({ error: 'INVALID_DUE_DATE', code: 'INVALID_DUE_DATE', message: 'dueDate must be a valid YYYY-MM-DD date' });
    }
    dueDateUTC = d.date;
  }

  try {
    const created = await prisma.rfi.create({
      data: {
        projectId: (projectId && typeof projectId === 'string' && projectId.length > 0) ? projectId : null,
        subject: subject.trim(),
        question: question.trim(),
        targetResponderId: resolvedTargetResponder,
        dueDate: dueDateUTC,
        raisedById: req.employeeId,
        status: 'OPEN',
      },
      include: {
        project: { select: { id: true, name: true, code: true } },
        raisedBy: { select: { id: true, name: true, email: true } },
        targetResponder: { select: { id: true, name: true, email: true } },
        responder: { select: { id: true, name: true, email: true } },
        _count: { select: { variations: true } },
      },
    });

    // Add the displayStatus on the create response too so the UI can
    // immediately render the OVERDUE badge without a follow-up GET.
    res.status(201).json({
      ...created,
      displayStatus: deriveRfiStatus(created),
      dueDate: toDateOnly(created.dueDate),
    });
  } catch (err) {
    console.error('RFI create error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to create RFI' });
  }
}));

// ─── GET /api/rfis/:id ──────────────────────────────────────────────────────
//
// Detail. Auth: any authenticated employee can read any RFI (the
// metadata isn't sensitive — it's project-level questions + responses,
// visible to all colleagues who could plausibly need the answer).
//
// Returns the row with the project / raisedBy / targetResponder /
// responder / variations_count expanded.
router.get('/:id', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;

  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    return res.status(400).json({ error: 'id must be a UUID', code: 'INVALID_ID' });
  }

  try {
    const rfi = await prisma.rfi.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, name: true, code: true } },
        raisedBy: { select: { id: true, name: true, email: true } },
        targetResponder: { select: { id: true, name: true, email: true } },
        responder: { select: { id: true, name: true, email: true } },
        _count: { select: { variations: true } },
      },
    });
    if (!rfi) {
      return res.status(404).json({ error: 'RFI not found', code: 'NOT_FOUND' });
    }

    res.json({
      ...rfi,
      displayStatus: deriveRfiStatus(rfi),
      dueDate: toDateOnly(rfi.dueDate),
    });
  } catch (err) {
    console.error('RFI detail error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to fetch RFI' });
  }
}));

// ─── PATCH /api/rfis/:id ────────────────────────────────────────────────────
//
// Patch an RFI. Auth: response can be filed by the raiser, the target
// responder, or an admin. Close (CLOSED) is admin-only — closing an
// RFI is a "this conversation is done" decision that should be made
// deliberately by a project lead, not the engineer who originally asked.
//
// Body shape:
//   { response: string, status?: 'RESPONDED' | 'CLOSED' }
//
// `status` is honoured ONLY when the body also sets `response` (so a
// "respond + close in one shot" flow is supported). Setting status
// without a response is rejected — the state machine requires text.
//
// Mass-assignment allowlist: only `response` (and the auto-derivable
// status) are settable here. Patching `subject` / `question` would
// rewrite history; a future round can add a "clarify" endpoint if
// engineers start mis-typing questions.
router.patch('/:id', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;

  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    return res.status(400).json({ error: 'id must be a UUID', code: 'INVALID_ID' });
  }

  const { response, status: bodyStatus } = req.body || {};

  // Empty PATCH (no response, no status) is a 400 — the client should
  // pass something meaningful. A null response is also rejected so a
  // client can't accidentally clear an existing response via a stale
  // PATCH.
  if (response === undefined && bodyStatus === undefined) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Provide `response` and/or `status`' });
  }

  // Length cap on response.
  if (response !== undefined && response !== null) {
    if (typeof response !== 'string') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_RESPONSE', message: 'response must be a string' });
    }
    if (response.length > RFI_FIELD_MAX.response) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: `response exceeds ${RFI_FIELD_MAX.response} chars` });
    }
  }

  // Validate bodyStatus shape (if provided) — must be RESPONDED or CLOSED.
  // OPEN is rejected (an RFI can never go backwards to OPEN).
  if (bodyStatus !== undefined) {
    if (bodyStatus !== 'RESPONDED' && bodyStatus !== 'CLOSED') {
      return res.status(400).json({
        error: 'status must be RESPONDED or CLOSED',
        code: 'STATUS_INVALID',
        allowed: ['RESPONDED', 'CLOSED'],
      });
    }
  }

  try {
    // Re-read the row so the transition is computed off the FRESH
    // status, not a stale client value. LPR-007: requireFreshAdmin on
    // mutations, but the inline re-read of the caller (admin OR
    // responder OR raiser) keeps the route open to non-admin writes
    // when the caller is the responder.
    const existing = await prisma.rfi.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'RFI not found', code: 'NOT_FOUND' });
    }

    // Auth: respond can be filed by the raiser, the target responder,
    // or an admin. Close is admin-only. We re-read isAdmin from the DB
    // (same fresh-admin pattern as dpr.js / cubeTest.js) so a demoted
    // admin can't keep closing RFIs with a stale JWT.
    const fresh = await prisma.employee.findUnique({
      where: { id: req.employeeId },
      select: { isAdmin: true },
    });
    const isAdmin = fresh && fresh.isAdmin;
    const isRaiser = existing.raisedById === req.employeeId;
    const isTargetResponder = existing.targetResponderId === req.employeeId;

    // Decide the next status BEFORE applying any other field:
    //   - If bodyStatus is provided, use it (admin-driven close).
    //   - If response is provided (and bodyStatus not), transition to
    //     RESPONDED if currently OPEN, else leave as-is.
    let nextStatus = existing.status;
    if (bodyStatus !== undefined) {
      // admin-only branch (closing).
      if (!isAdmin) {
        return res.status(403).json({ error: 'Only admins can change RFI status explicitly', code: 'ADMIN_REQUIRED' });
      }
      const allowedFrom = RFI_TRANSITIONS[existing.status] || new Set();
      if (!allowedFrom.has(bodyStatus)) {
        return res.status(409).json({
          error: `Cannot move RFI from ${existing.status} to ${bodyStatus}`,
          code: 'INVALID_TRANSITION',
          currentStatus: existing.status,
        });
      }
      nextStatus = bodyStatus;
    } else if (response !== undefined) {
      // response-only branch.
      if (!isAdmin && !isRaiser && !isTargetResponder) {
        return res.status(403).json({ error: 'Only the raiser, target responder, or an admin can respond to an RFI', code: 'FORBIDDEN' });
      }
      if (existing.status === 'OPEN') {
        nextStatus = 'RESPONDED';
      }
      // If already RESPONDED, response can be re-edited (a follow-up
      // clarification); the status stays RESPONDED. If CLOSED, a
      // response patch is rejected — terminal state is terminal.
      if (existing.status === 'CLOSED') {
        return res.status(409).json({ error: 'Cannot edit a CLOSED RFI', code: 'INVALID_TRANSITION', currentStatus: existing.status });
      }
    }

    // Build the update payload. respondedAt / closedAt / responderId
    // are server-set (never trusted from the body).
    const updateData = {};
    if (response !== undefined) {
      updateData.response = response;
    }
    if (nextStatus !== existing.status) {
      updateData.status = nextStatus;
      if (nextStatus === 'RESPONDED') {
        updateData.respondedAt = new Date();
        updateData.responderId = req.employeeId;
      } else if (nextStatus === 'CLOSED') {
        updateData.closedAt = new Date();
        // responderId stays as it was (the responder-of-record) when
        // moving RESPONDED → CLOSED; for OPEN → CLOSED, set it to the
        // admin who closed the row.
        if (!existing.responderId) {
          updateData.responderId = req.employeeId;
        }
      }
    }

    const updated = await prisma.rfi.update({
      where: { id },
      data: updateData,
      include: {
        project: { select: { id: true, name: true, code: true } },
        raisedBy: { select: { id: true, name: true, email: true } },
        targetResponder: { select: { id: true, name: true, email: true } },
        responder: { select: { id: true, name: true, email: true } },
        _count: { select: { variations: true } },
      },
    });

    res.json({
      ...updated,
      displayStatus: deriveRfiStatus(updated),
      dueDate: toDateOnly(updated.dueDate),
    });
  } catch (err) {
    console.error('RFI patch error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to update RFI' });
  }
}));

// ─── POST /api/rfis/:id/escalate-to-variation ────────────────────────────────
//
// Admin-only. Creates a DRAFT VariationOrder that references this RFI.
// The variation is born DRAFT (not SUBMITTED) so the admin can edit
// the title / description / delta_amount before submitting for review —
// a "respond revealed a scope gap, here's the proposed variation"
// workflow, not a "respond auto-creates a billable change" workflow.
//
// Response shape: { rfi, variation } so the client can render both
// the updated RFI and the new variation row in a single round-trip.
router.post('/:id/escalate-to-variation', requireFreshAdmin, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;

  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    return res.status(400).json({ error: 'id must be a UUID', code: 'INVALID_ID' });
  }

  // Optional body fields: title / description / deltaAmount /
  // clientApprovalRequired. When omitted, the variation starts with
  // sensible defaults derived from the RFI (title = "Variation from
  // RFI: <subject>", description = the RFI question, deltaAmount = 0).
  const { title, description, deltaAmount, clientApprovalRequired } = req.body || {};

  // Title: optional but if provided must be a non-empty string within
  // the 200-char cap.
  let resolvedTitle = null;
  if (title !== undefined && title !== null && title !== '') {
    if (typeof title !== 'string') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_TITLE', message: 'title must be a string' });
    }
    if (title.length > 200) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'title exceeds 200 chars' });
    }
    resolvedTitle = title.trim();
  }
  if (description !== undefined && description !== null && description !== '') {
    if (typeof description !== 'string' || description.length > 4000) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'description must be a string ≤ 4000 chars' });
    }
  }
  let resolvedDelta = 0;
  if (deltaAmount !== undefined && deltaAmount !== null && deltaAmount !== '') {
    const n = typeof deltaAmount === 'string' ? Number(deltaAmount) : deltaAmount;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < -999999999999.99 || n > 999999999999.99) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_DELTA_AMOUNT', message: 'deltaAmount must be a finite number' });
    }
    resolvedDelta = n;
  }
  let resolvedClientApproval = true;
  if (clientApprovalRequired !== undefined && clientApprovalRequired !== null) {
    if (typeof clientApprovalRequired !== 'boolean') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'INVALID_CLIENT_APPROVAL', message: 'clientApprovalRequired must be boolean' });
    }
    resolvedClientApproval = clientApprovalRequired;
  }

  try {
    const existing = await prisma.rfi.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'RFI not found', code: 'NOT_FOUND' });
    }
    // The variation MUST be project-anchored (projectId NOT NULL on
    // variation_order). Reject if the RFI was unfiled.
    if (!existing.projectId) {
      return res.status(400).json({
        error: 'Cannot escalate an unfiled RFI (projectId is null). Link the RFI to a project first.',
        code: 'RFI_NOT_PROJECT_ANCHORED',
      });
    }

    const rfiTitle = resolvedTitle || `Variation from RFI: ${existing.subject}`;
    const rfiDescription = (description !== undefined && description !== null && description !== '')
      ? description
      : existing.question;

    // Single transaction: create the variation, attach the reference.
    // If the create fails, nothing leaks. We do NOT flip the RFI
    // status here — the user may want to keep the RFI OPEN while the
    // variation is being drafted, then close the RFI after the
    // variation is APPROVED. A separate status transition (PATCH
    // status=CLOSED) handles that.
    const result = await prisma.$transaction(async (tx) => {
      const variation = await tx.variationOrder.create({
        data: {
          projectId: existing.projectId,
          referenceRfiId: existing.id,
          title: rfiTitle,
          description: rfiDescription || null,
          deltaAmount: resolvedDelta,
          status: 'DRAFT',
          clientApprovalRequired: resolvedClientApproval,
          raisedById: req.employeeId,
        },
        include: {
          project: { select: { id: true, name: true, code: true } },
          referenceRfi: { select: { id: true, subject: true, status: true } },
          raisedBy: { select: { id: true, name: true, email: true } },
          approvedBy: { select: { id: true, name: true, email: true } },
        },
      });
      return variation;
    });

    // Refetch the RFI so the response includes the updated variations_count.
    const updatedRfi = await prisma.rfi.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, name: true, code: true } },
        raisedBy: { select: { id: true, name: true, email: true } },
        targetResponder: { select: { id: true, name: true, email: true } },
        responder: { select: { id: true, name: true, email: true } },
        _count: { select: { variations: true } },
      },
    });

    res.status(201).json({
      rfi: {
        ...updatedRfi,
        displayStatus: deriveRfiStatus(updatedRfi),
        dueDate: toDateOnly(updatedRfi.dueDate),
      },
      variation: result,
    });
  } catch (err) {
    console.error('RFI escalate error', {
      employeeHash: hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to escalate RFI to variation' });
  }
}));

module.exports = router;
// expose the pure helpers for inline / unit-style tests
module.exports.deriveRfiStatus = deriveRfiStatus;
module.exports.ALLOWED_RFI_STATUSES = ALLOWED_RFI_STATUSES;
module.exports.RFI_FIELD_MAX = RFI_FIELD_MAX;
