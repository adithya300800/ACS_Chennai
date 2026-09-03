// Leave Request routes — Round-13.
//
// Standard leave workflow:
//   POST   /api/leave                  — submit (employee)
//   GET    /api/leave/my               — list own requests
//   GET    /api/leave                  — admin queue (filterable by status/employee)
//   GET    /api/leave/:id              — fetch one (owner or admin)
//   POST   /api/leave/:id/approve      — admin approve (with optional notes)
//   POST   /api/leave/:id/reject       — admin reject (notes required, 1..500)
//   POST   /api/leave/:id/cancel       — owner cancels PENDING
//
// Auth model:
//   - requireAuth on all routes.
//   - Admin-only for: list-all, approve, reject.
//   - Owner-only for: cancel. Read for: owner or admin.
//   - Round-20 (DR-005): approve/reject mutate, so they use requireFreshAdmin
//     (live Employee.isAdmin read). The read-only admin queue keeps the cached
//     JWT claim — a 15-minute-stale claim can only over-share a listing, not
//     let a demoted admin decide someone's leave.

'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requireFreshAdmin } = require('../middleware/auth');
const { leaveCreateLimiter } = require('../middleware/rateLimit');
const {
  ALLOWED_LEAVE_STATUSES,
  parseLeaveDate,
  rangesOverlap,
  validateCreatePayload,
  canTransition,
  inclusiveDayCount,
  httpStatusForCode,
} = require('../lib/leaveRules');
const { mapPrismaError } = require('../lib/errors');
const { hashIdentifier } = require('../lib/pii');
// Round-25: email fan-out hook for the existing in-app notification. The
// 13 sites across dpr/leave/inspection/training add one fire-and-forget
// `fanOutEmail(...)` call after their notification.create. The helper
// swallows its own errors so a misconfigured SMTP transport can't 500 the
// admin's approve/reject.
const { fanOutEmail } = require('../lib/notify');

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function getPrisma(req) { return req.app.get('prisma'); }

function serializeLeave(row) {
  if (!row) return null;
  const { employee, reviewedBy, ...rest } = row;
  return {
    ...rest,
    startDate: rest.startDate instanceof Date ? toDateStr(rest.startDate) : rest.startDate,
    endDate: rest.endDate instanceof Date ? toDateStr(rest.endDate) : rest.endDate,
    reviewedAt: rest.reviewedAt instanceof Date ? rest.reviewedAt.toISOString() : rest.reviewedAt,
    cancelledAt: rest.cancelledAt instanceof Date ? rest.cancelledAt.toISOString() : rest.cancelledAt,
    createdAt: rest.createdAt instanceof Date ? rest.createdAt.toISOString() : rest.createdAt,
    updatedAt: rest.updatedAt instanceof Date ? rest.updatedAt.toISOString() : rest.updatedAt,
    employee: employee ? {
      id: employee.id,
      name: employee.name,
      email: employee.email,
      department: employee.department,
    } : undefined,
    reviewedBy: reviewedBy ? {
      id: reviewedBy.id,
      name: reviewedBy.name,
      email: reviewedBy.email,
    } : null,
  };
}

function toDateStr(d) {
  if (!(d instanceof Date)) return d;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

router.use(requireAuth);

// ─── POST /api/leave ─────────────────────────────────────────────────────────
// Submit a new leave request. Status defaults to PENDING.
router.post('/', leaveCreateLimiter, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const result = validateCreatePayload(req.body);
  if (!result.ok) {
    return res.status(httpStatusForCode(result.code)).json({
      error: result.message,
      code: result.code,
    });
  }

  const { startDate, endDate, leaveType, reason } = result.value;

  // Overlap check: any existing PENDING or APPROVED leave for this employee
  // that overlaps [startDate, endDate] blocks the new submission.
  //
  // We do this application-side too because it produces better error messages
  // (which request conflicts, by id + dates + status) than the raw exclusion
  // constraint violation can. The CONSTRAINT is the authority though — see
  // prisma/migrations/20260902220220_dr009_leave_overlap_constraint/. Two
  // near-simultaneous submits that both pass this precheck will still be
  // stopped at the DB layer; the try/catch below turns the raw constraint
  // violation into the same 409 LEAVE_OVERLAP the precheck would have
  // produced.
  //
  // The precheck AND the constraint both filter to PENDING / APPROVED
  // (excluding REJECTED / CANCELLED), so a previously-rejected leave in the
  // same window does not block a fresh submission.
  const overlapping = await prisma.leaveRequest.findMany({
    where: {
      employeeId: req.employeeId,
      status: { in: ['PENDING', 'APPROVED'] },
      startDate: { lte: endDate },
      endDate: { gte: startDate },
    },
    select: { id: true, startDate: true, endDate: true, status: true },
  });

  if (overlapping.length > 0) {
    return res.status(409).json({
      error: 'A leave request for an overlapping date range already exists',
      code: 'LEAVE_OVERLAP',
      conflicts: overlapping.map((o) => ({
        id: o.id,
        startDate: toDateStr(o.startDate),
        endDate: toDateStr(o.endDate),
        status: o.status,
      })),
    });
  }

  try {
    const created = await prisma.leaveRequest.create({
      data: {
        employeeId: req.employeeId,
        startDate,
        endDate,
        leaveType,
        reason,
        status: 'PENDING',
      },
      include: {
        employee: { select: { id: true, name: true, email: true, department: true } },
      },
    });

    console.log('[leave/create]', {
      requester: hashIdentifier(req.employeeId),
      leaveId: created.id,
      days: inclusiveDayCount(startDate, endDate),
      leaveType,
    });

    res.status(201).json(serializeLeave(created));
  } catch (err) {
    // DR-009: the PostgreSQL exclusion constraint `no_overlap_leave` is the
    // authority for "no two overlapping PENDING/APPROVED leaves for the same
    // employee". The precheck above usually catches overlaps, but a concurrent
    // submission can slip past it. Prisma surfaces the raw constraint
    // violation as P2010 (raw query failed) with the constraint name in
    // err.meta.constraint or the message body. Re-map it to the same 409
    // LEAVE_OVERLAP the precheck would have produced so clients see one
    // consistent error path.
    if (isLeaveOverlapConstraintError(err)) {
      console.warn('[leave/create] overlap rejected by no_overlap_leave constraint', {
        requester: hashIdentifier(req.employeeId),
        startDate: toDateStr(startDate),
        endDate: toDateStr(endDate),
      });
      return res.status(409).json({
        error: 'This leave overlaps an existing request',
        code: 'LEAVE_OVERLAP',
      });
    }
    console.error('[leave/create]', { prismaCode: err.code, message: err.message?.split('\n')[0] });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to create leave request' });
  }
}));

// Detect the EXCLUDE constraint violation by Prisma error code (P2010 = raw
// query failed) and the constraint name in either err.meta or the message
// body. We accept either signal because different Prisma versions surface
// the constraint name in different places.
function isLeaveOverlapConstraintError(err) {
  if (!err || err.code !== 'P2010') return false;
  const metaConstraint = typeof err.meta === 'object' && err.meta
    ? (err.meta.constraint || err.meta.constraintName)
    : null;
  if (typeof metaConstraint === 'string' && metaConstraint.includes('no_overlap_leave')) {
    return true;
  }
  const msg = typeof err.message === 'string' ? err.message : '';
  return msg.includes('no_overlap_leave');
}

// ─── GET /api/leave/my ──────────────────────────────────────────────────────
// Employee's own leave requests. Newest first.
router.get('/my', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const rows = await prisma.leaveRequest.findMany({
    where: { employeeId: req.employeeId },
    orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
    take: 100,
  });
  res.json({ requests: rows.map(serializeLeave) });
}));

// ─── GET /api/leave ─────────────────────────────────────────────────────────
// Admin queue. Filters: status, employeeId, from, to.
router.get('/', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!req.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { status, employeeId, from, to } = req.query;
  const where = {};
  if (status && ALLOWED_LEAVE_STATUSES.has(status)) where.status = status;
  if (employeeId) where.employeeId = String(employeeId);

  // DR-009: admin date-range filter. Two ranges overlap iff
  //   a.start <= b.end AND b.start <= a.end
  // — the same predicate the per-employee precheck uses. The previous
  // implementation OR'd these together, which let through any record that
  // touched the range on either end (e.g. a leave ending 2026-09-08 was
  // returned when the filter ended 2026-09-15, and a leave starting
  // 2026-09-20 was returned when the filter started 2026-09-15). Both are
  // leaves that are entirely OUTSIDE the requested window.
  //
  // Validate inputs before touching the where clause: reject reversed
  // ranges (from > to) and malformed dates with a 400, not a silently
  // empty result set.
  if (from || to) {
    let fromDate = null;
    let toDate = null;
    if (from !== undefined) {
      fromDate = parseLeaveDate(from);
      if (!fromDate) {
        return res.status(400).json({
          error: 'from must be a valid YYYY-MM-DD',
          code: 'INVALID_FROM_DATE',
        });
      }
    }
    if (to !== undefined) {
      toDate = parseLeaveDate(to);
      if (!toDate) {
        return res.status(400).json({
          error: 'to must be a valid YYYY-MM-DD',
          code: 'INVALID_TO_DATE',
        });
      }
    }
    if (fromDate && toDate && fromDate > toDate) {
      return res.status(400).json({
        error: 'from must be on or before to',
        code: 'INVALID_DATE_RANGE',
      });
    }
    // Interval overlap predicate: leave [startDate, endDate] intersects the
    // filter window [fromDate, toDate] iff startDate <= toDate AND
    // endDate >= fromDate. Apply only the bound(s) the client supplied —
    // a missing bound means "no constraint on that side".
    if (fromDate) where.endDate = { gte: fromDate };
    if (toDate) where.startDate = { lte: toDate };
  }

  const rows = await prisma.leaveRequest.findMany({
    where,
    include: {
      employee: { select: { id: true, name: true, email: true, department: true } },
      reviewedBy: { select: { id: true, name: true, email: true } },
    },
    orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
    take: 500,
  });

  res.json({ requests: rows.map(serializeLeave) });
}));

// ─── GET /api/leave/:id ─────────────────────────────────────────────────────
router.get('/:id', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;
  const row = await prisma.leaveRequest.findUnique({
    where: { id },
    include: {
      employee: { select: { id: true, name: true, email: true, department: true } },
      reviewedBy: { select: { id: true, name: true, email: true } },
    },
  });
  if (!row) return res.status(404).json({ error: 'Leave request not found', code: 'NOT_FOUND' });
  if (row.employeeId !== req.employeeId && !req.isAdmin) {
    return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
  }
  res.json(serializeLeave(row));
}));

// ─── POST /api/leave/:id/approve ───────────────────────────────────────────
// Round-20 (DR-005): admin status is enforced by requireFreshAdmin (a live
// Employee.isAdmin read) rather than the JWT claim. This replaces the inline
// re-check that used to sit below the payload validation — same guarantee, but
// it now runs BEFORE we touch the request body, and it is the same middleware
// every other admin mutation uses instead of a copy-pasted two-liner.
router.post('/:id/approve', requireFreshAdmin, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);

  const { id } = req.params;
  const { reviewNotes } = req.body || {};
  const noteText = typeof reviewNotes === 'string' ? reviewNotes.trim() : '';
  if (noteText.length > 500) {
    return res.status(400).json({ error: 'reviewNotes too long (max 500)', code: 'REASON_TOO_LONG' });
  }

  // Admin status already re-read from the DB by requireFreshAdmin.
  const existing = await prisma.leaveRequest.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Leave request not found', code: 'NOT_FOUND' });
  if (!canTransition(existing.status, 'APPROVED')) {
    return res.status(409).json({
      error: `Cannot approve leave in status ${existing.status}`,
      code: 'LEAVE_ALREADY_DECIDED',
    });
  }
  // Compliance default: admins cannot approve their own leave.
  if (existing.employeeId === req.employeeId) {
    return res.status(409).json({
      error: 'You cannot approve your own leave request',
      code: 'SELF_APPROVAL',
    });
  }

  try {
    const updated = await prisma.leaveRequest.update({
      where: { id, status: 'PENDING' },
      data: {
        status: 'APPROVED',
        reviewedById: req.employeeId,
        reviewedAt: new Date(),
        reviewNotes: noteText || null,
      },
      include: {
        employee: { select: { id: true, name: true, email: true, department: true } },
        reviewedBy: { select: { id: true, name: true, email: true } },
      },
    });

    // Best-effort notification. Insert is wrapped so a notification failure
    // (FK constraint, etc.) doesn't unwind the leave approval.
    let notifRow;
    try {
      notifRow = await prisma.notification.create({
        data: {
          employeeId: updated.employeeId,
          type: 'LEAVE_DECIDED',
          leaveRequestId: updated.id,
          message: `Your leave request for ${toDateStr(updated.startDate)} to ${toDateStr(updated.endDate)} was approved.`,
        },
      });
    } catch (notifyErr) {
      console.error('[leave/approve] notification insert failed', {
        leaveId: updated.id,
        prismaCode: notifyErr.code,
      });
    }
    // Round-25: fire-and-forget email fan-out. We need a notification-row
    // id for the EmailLog FK, so fan-out runs only if the insert succeeded
    // (otherwise pass null — EmailLog.notificationId is nullable).
    if (notifRow) {
      fanOutEmail(notifRow, prisma);
    }

    console.log('[leave/approve]', {
      reviewer: hashIdentifier(req.employeeId),
      leaveId: updated.id,
      employee: hashIdentifier(updated.employeeId),
    });

    res.json(serializeLeave(updated));
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(409).json({ error: 'Leave already decided', code: 'LEAVE_ALREADY_DECIDED' });
    }
    console.error('[leave/approve]', { prismaCode: err.code, message: err.message?.split('\n')[0] });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to approve leave' });
  }
}));

// ─── POST /api/leave/:id/reject ────────────────────────────────────────────
// Round-20 (DR-005): see the note on /approve — requireFreshAdmin replaces both
// the JWT-claim check and the inline DB re-check.
router.post('/:id/reject', requireFreshAdmin, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);

  const { id } = req.params;
  const { reviewNotes } = req.body || {};
  const noteText = typeof reviewNotes === 'string' ? reviewNotes.trim() : '';
  if (noteText.length < 5) {
    return res.status(400).json({ error: 'reviewNotes required (5..500 chars)', code: 'REASON_TOO_SHORT' });
  }
  if (noteText.length > 500) {
    return res.status(400).json({ error: 'reviewNotes too long (max 500)', code: 'REASON_TOO_LONG' });
  }

  const existing = await prisma.leaveRequest.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Leave request not found', code: 'NOT_FOUND' });
  if (!canTransition(existing.status, 'REJECTED')) {
    return res.status(409).json({
      error: `Cannot reject leave in status ${existing.status}`,
      code: 'LEAVE_ALREADY_DECIDED',
    });
  }
  if (existing.employeeId === req.employeeId) {
    return res.status(409).json({
      error: 'You cannot reject your own leave request',
      code: 'SELF_APPROVAL',
    });
  }

  try {
    const updated = await prisma.leaveRequest.update({
      where: { id, status: 'PENDING' },
      data: {
        status: 'REJECTED',
        reviewedById: req.employeeId,
        reviewedAt: new Date(),
        reviewNotes: noteText,
      },
      include: {
        employee: { select: { id: true, name: true, email: true, department: true } },
        reviewedBy: { select: { id: true, name: true, email: true } },
      },
    });

    try {
      const notifRow = await prisma.notification.create({
        data: {
          employeeId: updated.employeeId,
          type: 'LEAVE_DECIDED',
          leaveRequestId: updated.id,
          message: `Your leave request for ${toDateStr(updated.startDate)} to ${toDateStr(updated.endDate)} was rejected.${noteText ? ` Reason: ${noteText}` : ''}`,
        },
      });
      // Round-25: email fan-out (fire-and-forget). Pass the inserted row so
      // EmailLog can FK back to the notification id.
      fanOutEmail(notifRow, prisma);
    } catch (notifyErr) {
      console.error('[leave/reject] notification insert failed', {
        leaveId: updated.id,
        prismaCode: notifyErr.code,
      });
    }

    console.log('[leave/reject]', {
      reviewer: hashIdentifier(req.employeeId),
      leaveId: updated.id,
      employee: hashIdentifier(updated.employeeId),
    });

    res.json(serializeLeave(updated));
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(409).json({ error: 'Leave already decided', code: 'LEAVE_ALREADY_DECIDED' });
    }
    console.error('[leave/reject]', { prismaCode: err.code, message: err.message?.split('\n')[0] });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to reject leave' });
  }
}));

// ─── POST /api/leave/:id/cancel ────────────────────────────────────────────
// Owner cancels a PENDING request. Approved/Rejected/Cancelled leaves are
// terminal — contact admin to cancel an approved leave.
router.post('/:id/cancel', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;

  const existing = await prisma.leaveRequest.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Leave request not found', code: 'NOT_FOUND' });
  if (existing.employeeId !== req.employeeId) {
    return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
  }
  if (existing.status !== 'PENDING') {
    return res.status(409).json({
      error: `Cannot cancel leave in status ${existing.status}`,
      code: 'LEAVE_NOT_PENDING',
    });
  }

  try {
    const updated = await prisma.leaveRequest.update({
      where: { id, status: 'PENDING' },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
      include: {
        employee: { select: { id: true, name: true, email: true, department: true } },
        reviewedBy: { select: { id: true, name: true, email: true } },
      },
    });
    console.log('[leave/cancel]', {
      requester: hashIdentifier(req.employeeId),
      leaveId: updated.id,
    });
    res.json(serializeLeave(updated));
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(409).json({ error: 'Leave already decided', code: 'LEAVE_ALREADY_DECIDED' });
    }
    console.error('[leave/cancel]', { prismaCode: err.code, message: err.message?.split('\n')[0] });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to cancel leave' });
  }
}));

module.exports = router;
