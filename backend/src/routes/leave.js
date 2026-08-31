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

'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
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
  // that overlaps [startDate, endDate] blocks the new submission. We do this
  // application-side because the overlap test is range math, not equality,
  // and GiST/btree exclusion constraints aren't enabled on this column.
  // Two near-simultaneous submits that both pass this check would race the
  // DB insert; we mitigate with a try/catch + 409 on P2002 below.
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
    console.error('[leave/create]', { prismaCode: err.code, message: err.message?.split('\n')[0] });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to create leave request' });
  }
}));

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
  if (from || to) {
    where.OR = [];
    if (from) {
      const fp = parseLeaveDate(from);
      if (fp) where.OR.push({ endDate: { gte: fp } });
    }
    if (to) {
      const tp = parseLeaveDate(to);
      if (tp) where.OR.push({ startDate: { lte: tp } });
    }
    if (where.OR.length === 0) delete where.OR;
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
router.post('/:id/approve', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!req.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { id } = req.params;
  const { reviewNotes } = req.body || {};
  const noteText = typeof reviewNotes === 'string' ? reviewNotes.trim() : '';
  if (noteText.length > 500) {
    return res.status(400).json({ error: 'reviewNotes too long (max 500)', code: 'REASON_TOO_LONG' });
  }

  // Re-check admin status from DB so a freshly-granted admin works.
  const me = await prisma.employee.findUnique({ where: { id: req.employeeId }, select: { isAdmin: true } });
  if (!me || !me.isAdmin) return res.status(403).json({ error: 'Admin access required' });

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
    try {
      await prisma.notification.create({
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
router.post('/:id/reject', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!req.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { id } = req.params;
  const { reviewNotes } = req.body || {};
  const noteText = typeof reviewNotes === 'string' ? reviewNotes.trim() : '';
  if (noteText.length < 5) {
    return res.status(400).json({ error: 'reviewNotes required (5..500 chars)', code: 'REASON_TOO_SHORT' });
  }
  if (noteText.length > 500) {
    return res.status(400).json({ error: 'reviewNotes too long (max 500)', code: 'REASON_TOO_LONG' });
  }

  const me = await prisma.employee.findUnique({ where: { id: req.employeeId }, select: { isAdmin: true } });
  if (!me || !me.isAdmin) return res.status(403).json({ error: 'Admin access required' });

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
      await prisma.notification.create({
        data: {
          employeeId: updated.employeeId,
          type: 'LEAVE_DECIDED',
          leaveRequestId: updated.id,
          message: `Your leave request for ${toDateStr(updated.startDate)} to ${toDateStr(updated.endDate)} was rejected.${noteText ? ` Reason: ${noteText}` : ''}`,
        },
      });
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
