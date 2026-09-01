// Employee Training routes — Round-14.
//
// Endpoints:
//   GET    /api/training/courses                   — admin lists courses
//   POST   /api/training/courses                   — admin creates a course
//   GET    /api/training/courses/:id               — admin/owner reads a course + own enrollment
//   PUT    /api/training/courses/:id               — admin updates a course
//   POST   /api/training/enrollments               — admin bulk-assigns (courseId + employeeIds[])
//   GET    /api/training/enrollments/my            — employee's own enrollments
//   GET    /api/training/enrollments               — admin queue (filterable)
//   GET    /api/training/enrollments/:id           — owner or admin reads one
//   PUT    /api/training/enrollments/:id/progress  — employee pings watch progress (auto-completes at >=100)
//   PUT    /api/training/enrollments/:id/complete  — owner/admin manual mark-complete
//
// Auth model:
//   - requireAuth on all routes.
//   - Admin-only for: course CRUD + enrollment list + bulk assign + admin override complete.
//   - Owner-only for: progress pings + manual complete (admin can override complete).

'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { trainingWriteLimiter } = require('../middleware/rateLimit');
const {
  ALLOWED_PROVIDERS,
  ALLOWED_STATUSES,
  ALLOWED_PRIORITIES,
  validateCreateCourse,
  validateUpdateCourse,
  validateAssignEnrollments,
  validateProgressPayload,
  validateCompletePayload,
  canTransition,
  httpStatusForCode,
} = require('../lib/trainingRules');
const { mapPrismaError } = require('../lib/errors');
const { hashIdentifier } = require('../lib/pii');

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function getPrisma(req) { return req.app.get('prisma'); }

// ─── Serializers ─────────────────────────────────────────────────────────────
// Convert Prisma row → API response. Dates → ISO (timestamp) or YYYY-MM-DD
// (date-only). Employee → safe subset (id, name, email, department).

function toDateStr(d) {
  if (!(d instanceof Date)) return d;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function serializeCourse(row) {
  if (!row) return null;
  const { createdBy, enrollments, ...rest } = row;
  return {
    ...rest,
    createdAt: rest.createdAt instanceof Date ? rest.createdAt.toISOString() : rest.createdAt,
    updatedAt: rest.updatedAt instanceof Date ? rest.updatedAt.toISOString() : rest.updatedAt,
    createdBy: createdBy ? { id: createdBy.id, name: createdBy.name } : undefined,
    enrollmentCount: Array.isArray(enrollments) ? enrollments.length : undefined,
  };
}

function serializeEnrollment(row) {
  if (!row) return null;
  const { employee, assignedBy, course, ...rest } = row;
  return {
    ...rest,
    assignedAt: rest.assignedAt instanceof Date ? rest.assignedAt.toISOString() : rest.assignedAt,
    startedAt: rest.startedAt instanceof Date ? rest.startedAt.toISOString() : rest.startedAt,
    completedAt: rest.completedAt instanceof Date ? rest.completedAt.toISOString() : rest.completedAt,
    dueDate: rest.dueDate instanceof Date ? toDateStr(rest.dueDate) : rest.dueDate,
    createdAt: rest.createdAt instanceof Date ? rest.createdAt.toISOString() : rest.createdAt,
    updatedAt: rest.updatedAt instanceof Date ? rest.updatedAt.toISOString() : rest.updatedAt,
    employee: employee ? {
      id: employee.id,
      name: employee.name,
      email: employee.email,
      department: employee.department,
    } : undefined,
    assignedBy: assignedBy ? {
      id: assignedBy.id,
      name: assignedBy.name,
      email: assignedBy.email,
    } : undefined,
    course: course ? {
      id: course.id,
      title: course.title,
      description: course.description,
      externalUrl: course.externalUrl,
      provider: course.provider,
      category: course.category,
      durationHint: course.durationHint,
    } : undefined,
  };
}

// Re-check admin status from DB so a freshly-granted admin works without
// waiting for JWT refresh, and a freshly-revoked admin is blocked immediately.
// Mirrors the pattern at leave.js:233-234.
async function assertFreshAdmin(req, prisma) {
  const me = await prisma.employee.findUnique({
    where: { id: req.employeeId },
    select: { isAdmin: true },
  });
  return !!(me && me.isAdmin);
}

router.use(requireAuth);

// ─────────────────────────────────────────────────────────────────────────────
// Course CRUD (admin)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/training/courses — admin lists courses (filter ?isArchived=)
router.get('/courses', asyncHandler(async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin access required' });
  const prisma = getPrisma(req);
  const where = {};
  if (req.query.isArchived === 'true') where.isArchived = true;
  if (req.query.isArchived === 'false') where.isArchived = false;

  const rows = await prisma.trainingCourse.findMany({
    where,
    orderBy: [{ isArchived: 'asc' }, { createdAt: 'desc' }],
    take: 500,
    include: {
      createdBy: { select: { id: true, name: true } },
      enrollments: { select: { id: true } },
    },
  });
  res.json({ courses: rows.map(serializeCourse) });
}));

// POST /api/training/courses — admin creates a course
router.post('/courses', trainingWriteLimiter, asyncHandler(async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin access required' });
  const prisma = getPrisma(req);
  const result = validateCreateCourse(req.body);
  if (!result.ok) {
    return res.status(httpStatusForCode(result.code)).json({
      error: result.message,
      code: result.code,
    });
  }
  const v = result.value;

  try {
    const created = await prisma.trainingCourse.create({
      data: {
        title: v.title,
        description: v.description,
        externalUrl: v.externalUrl,
        provider: v.provider,
        category: v.category,
        durationHint: v.durationHint,
        createdById: req.employeeId,
      },
      include: {
        createdBy: { select: { id: true, name: true } },
        enrollments: { select: { id: true } },
      },
    });
    console.log('[training/course/create]', {
      actor: hashIdentifier(req.employeeId),
      courseId: created.id,
      provider: v.provider,
    });
    res.status(201).json(serializeCourse(created));
  } catch (err) {
    console.error('[training/course/create]', { prismaCode: err.code, message: err.message?.split('\n')[0] });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to create course' });
  }
}));

// GET /api/training/courses/:id — admin reads; employees can also read (for
// the player page sidebar / future catalog).
router.get('/courses/:id', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;
  const row = await prisma.trainingCourse.findUnique({
    where: { id },
    include: {
      createdBy: { select: { id: true, name: true } },
      enrollments: { select: { id: true } },
    },
  });
  if (!row) return res.status(404).json({ error: 'Course not found', code: 'NOT_FOUND' });
  // Employees only see non-archived courses; admins see all.
  if (!req.isAdmin && row.isArchived) {
    return res.status(404).json({ error: 'Course not found', code: 'NOT_FOUND' });
  }
  res.json(serializeCourse(row));
}));

// PUT /api/training/courses/:id — admin updates
router.put('/courses/:id', trainingWriteLimiter, asyncHandler(async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin access required' });
  const prisma = getPrisma(req);
  const { id } = req.params;
  const result = validateUpdateCourse(req.body);
  if (!result.ok) {
    return res.status(httpStatusForCode(result.code)).json({
      error: result.message,
      code: result.code,
      ...(result.code === 'UNKNOWN_FIELDS' ? { fields: Object.keys(req.body).filter((k) => !ALLOWED_PROVIDERS.has(k)) } : {}),
    });
  }

  const fresh = await assertFreshAdmin(req, prisma);
  if (!fresh) return res.status(403).json({ error: 'Admin access required' });

  try {
    const updated = await prisma.trainingCourse.update({
      where: { id },
      data: result.value,
      include: {
        createdBy: { select: { id: true, name: true } },
        enrollments: { select: { id: true } },
      },
    });
    console.log('[training/course/update]', {
      actor: hashIdentifier(req.employeeId),
      courseId: updated.id,
      fields: Object.keys(result.value),
    });
    res.json(serializeCourse(updated));
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Course not found', code: 'NOT_FOUND' });
    }
    console.error('[training/course/update]', { prismaCode: err.code, message: err.message?.split('\n')[0] });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to update course' });
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// Enrollment assignment (admin bulk)
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/training/enrollments — admin bulk-assigns a course to N employees
router.post('/enrollments', trainingWriteLimiter, asyncHandler(async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin access required' });
  const prisma = getPrisma(req);
  const result = validateAssignEnrollments(req.body);
  if (!result.ok) {
    return res.status(httpStatusForCode(result.code)).json({
      error: result.message,
      code: result.code,
    });
  }
  const { courseId, employeeIds, dueDate, priority } = result.value;

  const fresh = await assertFreshAdmin(req, prisma);
  if (!fresh) return res.status(403).json({ error: 'Admin access required' });

  // Verify course exists and is not archived.
  const course = await prisma.trainingCourse.findUnique({
    where: { id: courseId },
    select: { id: true, isArchived: true, title: true, externalUrl: true, provider: true },
  });
  if (!course) return res.status(404).json({ error: 'Course not found', code: 'NOT_FOUND' });
  if (course.isArchived) {
    return res.status(409).json({
      error: 'Cannot assign an archived course',
      code: 'COURSE_ARCHIVED',
    });
  }

  // Resolve valid employee ids (skip silently + report for any invalid IDs).
  const employees = await prisma.employee.findMany({
    where: { id: { in: employeeIds } },
    select: { id: true, name: true },
  });
  const foundIds = new Set(employees.map((e) => e.id));
  const invalidIds = employeeIds.filter((id) => !foundIds.has(id));

  // Create enrollments sequentially. The (courseId, employeeId) @@unique
  // makes this idempotent — a re-assign is a 409 we ignore for "already
  // assigned" and re-fetch the existing row.
  const created = [];
  const skipped = [];
  const notifiedIds = [];

  for (const employeeId of employees.map((e) => e.id)) {
    try {
      const enrollment = await prisma.trainingEnrollment.create({
        data: {
          courseId,
          employeeId,
          assignedById: req.employeeId,
          dueDate,
          priority,
          status: 'ASSIGNED',
        },
        include: {
          employee: { select: { id: true, name: true, email: true, department: true } },
          assignedBy: { select: { id: true, name: true, email: true } },
          course: {
            select: {
              id: true, title: true, description: true,
              externalUrl: true, provider: true, category: true, durationHint: true,
            },
          },
        },
      });
      created.push(enrollment);
      notifiedIds.push(employeeId);
    } catch (err) {
      if (err.code === 'P2002') {
        // Already assigned — silently skip and report.
        skipped.push(employeeId);
        continue;
      }
      throw err;
    }
  }

  // Best-effort notifications: one per newly-created enrollment.
  // Wrapped so a notification failure never unwinds the assignment.
  if (created.length > 0) {
    for (const enrollment of created) {
      try {
        await prisma.notification.create({
          data: {
            employeeId: enrollment.employeeId,
            type: 'TRAINING_ASSIGNED',
            trainingEnrollmentId: enrollment.id,
            message: `New training assigned: ${enrollment.course.title}`,
          },
        });
      } catch (notifyErr) {
        console.error('[training/assign] notification insert failed', {
          enrollmentId: enrollment.id,
          prismaCode: notifyErr.code,
        });
      }
    }
  }

  console.log('[training/assign]', {
    actor: hashIdentifier(req.employeeId),
    courseId,
    requested: employeeIds.length,
    created: created.length,
    skipped: skipped.length,
    invalid: invalidIds.length,
  });

  res.status(201).json({
    created: created.map(serializeEnrollment),
    skipped,
    invalidIds,
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// Enrollment reads (employee own + admin queue)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/training/enrollments/my — employee's own enrollments
router.get('/enrollments/my', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const where = { employeeId: req.employeeId };
  if (req.query.status && ALLOWED_STATUSES.has(req.query.status)) {
    where.status = req.query.status;
  }
  const rows = await prisma.trainingEnrollment.findMany({
    where,
    orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { assignedAt: 'desc' }],
    take: 200,
    include: {
      course: {
        select: {
          id: true, title: true, description: true,
          externalUrl: true, provider: true, category: true, durationHint: true,
        },
      },
    },
  });
  res.json({ enrollments: rows.map(serializeEnrollment) });
}));

// GET /api/training/enrollments — admin queue
router.get('/enrollments', asyncHandler(async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin access required' });
  const prisma = getPrisma(req);
  const where = {};
  if (req.query.status && ALLOWED_STATUSES.has(req.query.status)) where.status = req.query.status;
  if (req.query.employeeId) where.employeeId = String(req.query.employeeId);
  if (req.query.courseId) where.courseId = String(req.query.courseId);

  const rows = await prisma.trainingEnrollment.findMany({
    where,
    orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { assignedAt: 'desc' }],
    take: 500,
    include: {
      employee: { select: { id: true, name: true, email: true, department: true } },
      assignedBy: { select: { id: true, name: true, email: true } },
      course: {
        select: {
          id: true, title: true, description: true,
          externalUrl: true, provider: true, category: true, durationHint: true,
        },
      },
    },
  });
  res.json({ enrollments: rows.map(serializeEnrollment) });
}));

// GET /api/training/enrollments/:id — owner or admin
router.get('/enrollments/:id', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;
  const row = await prisma.trainingEnrollment.findUnique({
    where: { id },
    include: {
      employee: { select: { id: true, name: true, email: true, department: true } },
      assignedBy: { select: { id: true, name: true, email: true } },
      course: {
        select: {
          id: true, title: true, description: true,
          externalUrl: true, provider: true, category: true, durationHint: true,
        },
      },
    },
  });
  if (!row) return res.status(404).json({ error: 'Enrollment not found', code: 'NOT_FOUND' });
  if (row.employeeId !== req.employeeId && !req.isAdmin) {
    return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
  }
  res.json(serializeEnrollment(row));
}));

// ─────────────────────────────────────────────────────────────────────────────
// Progress pings (employee) + manual complete (employee/admin)
// ─────────────────────────────────────────────────────────────────────────────

// PUT /api/training/enrollments/:id/progress — employee watch progress
router.put('/enrollments/:id/progress', trainingWriteLimiter, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;

  const existing = await prisma.trainingEnrollment.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Enrollment not found', code: 'NOT_FOUND' });
  if (existing.employeeId !== req.employeeId) {
    return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
  }
  if (existing.status === 'COMPLETED') {
    // Idempotent — already done. Echo the existing row so the client can stop pinging.
    return res.json({
      ok: true,
      noop: true,
      enrollmentId: existing.id,
      status: existing.status,
      progressPct: existing.progressPct,
    });
  }

  const result = validateProgressPayload(req.body, existing.progressPct);
  if (!result.ok) {
    return res.status(httpStatusForCode(result.code)).json({
      error: result.message,
      code: result.code,
    });
  }
  const { progressPct, lastWatchedSec } = result.value;

  // Decide target status:
  //   100 → COMPLETED (auto), startedAt stays at first progress ping
  //   > 0 and < 100 → IN_PROGRESS (and stamp startedAt on first transition)
  //   0 (re-ping after a refresh) → keep current status, no startedAt update
  const now = new Date();
  const data = {
    progressPct,
    lastWatchedSec,
    status: progressPct >= 100 ? 'COMPLETED' : 'IN_PROGRESS',
  };
  if (progressPct >= 100) data.completedAt = now;
  if (existing.status === 'ASSIGNED' && progressPct > 0) data.startedAt = now;

  // Conditional UPDATE on status-not-completed so a racing "complete" call
  // can't double-write. P2025 means someone else (or this same call) just
  // completed it — treat as noop success.
  try {
    const updated = await prisma.trainingEnrollment.update({
      where: { id, status: { not: 'COMPLETED' } },
      data,
      include: {
        course: {
          select: {
            id: true, title: true, description: true,
            externalUrl: true, provider: true, category: true, durationHint: true,
          },
        },
      },
    });

    // Best-effort notifications on first IN_PROGRESS transition + COMPLETED.
    if (existing.status === 'ASSIGNED' && updated.status === 'IN_PROGRESS') {
      try {
        await prisma.notification.create({
          data: {
            employeeId: updated.employeeId,
            type: 'TRAINING_IN_PROGRESS',
            trainingEnrollmentId: updated.id,
            message: `You started: ${updated.course.title}`,
          },
        });
      } catch (notifyErr) {
        console.error('[training/progress] in-progress notification failed', {
          enrollmentId: updated.id,
          prismaCode: notifyErr.code,
        });
      }
    } else if (updated.status === 'COMPLETED' && existing.status !== 'COMPLETED') {
      try {
        await prisma.notification.create({
          data: {
            employeeId: updated.employeeId,
            type: 'TRAINING_COMPLETED',
            trainingEnrollmentId: updated.id,
            message: `Training completed: ${updated.course.title}`,
          },
        });
      } catch (notifyErr) {
        console.error('[training/progress] completed notification failed', {
          enrollmentId: updated.id,
          prismaCode: notifyErr.code,
        });
      }
    }

    console.log('[training/progress]', {
      actor: hashIdentifier(req.employeeId),
      enrollmentId: updated.id,
      pct: updated.progressPct,
      status: updated.status,
    });

    res.json(serializeEnrollment(updated));
  } catch (err) {
    if (err.code === 'P2025') {
      // Lost the race — treat as success and let client stop pinging.
      const fresh = await prisma.trainingEnrollment.findUnique({ where: { id } });
      return res.json({ ok: true, noop: true, ...serializeEnrollment(fresh) });
    }
    console.error('[training/progress]', { prismaCode: err.code, message: err.message?.split('\n')[0] });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to update progress' });
  }
}));

// PUT /api/training/enrollments/:id/complete — manual mark-complete
// (employee for non-trackable providers, or admin override)
router.put('/enrollments/:id/complete', trainingWriteLimiter, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;

  const existing = await prisma.trainingEnrollment.findUnique({
    where: { id },
    include: {
      course: {
        select: {
          id: true, title: true, description: true,
          externalUrl: true, provider: true, category: true, durationHint: true,
        },
      },
    },
  });
  if (!existing) return res.status(404).json({ error: 'Enrollment not found', code: 'NOT_FOUND' });

  const isOwner = existing.employeeId === req.employeeId;
  if (!isOwner && !req.isAdmin) {
    return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
  }
  if (existing.status === 'COMPLETED') {
    return res.status(409).json({
      error: 'Already completed',
      code: 'ENROLLMENT_LOCKED',
    });
  }

  const result = validateCompletePayload(req.body);
  if (!result.ok) {
    return res.status(httpStatusForCode(result.code)).json({
      error: result.message,
      code: result.code,
    });
  }

  // Admin override path: re-check admin in DB.
  if (!isOwner) {
    const fresh = await assertFreshAdmin(req, prisma);
    if (!fresh) return res.status(403).json({ error: 'Admin access required' });
  }

  const now = new Date();
  try {
    const updated = await prisma.trainingEnrollment.update({
      where: { id, status: { not: 'COMPLETED' } },
      data: {
        status: 'COMPLETED',
        progressPct: 100,
        completedAt: now,
        startedAt: existing.startedAt || now,
        employeeNote: result.value.note,
      },
      include: {
        employee: { select: { id: true, name: true, email: true, department: true } },
        assignedBy: { select: { id: true, name: true, email: true } },
        course: {
          select: {
            id: true, title: true, description: true,
            externalUrl: true, provider: true, category: true, durationHint: true,
          },
        },
      },
    });

    // Best-effort notification on COMPLETED.
    try {
      await prisma.notification.create({
        data: {
          employeeId: updated.employeeId,
          type: 'TRAINING_COMPLETED',
          trainingEnrollmentId: updated.id,
          message: `Training completed: ${updated.course.title}`,
        },
      });
    } catch (notifyErr) {
      console.error('[training/complete] notification failed', {
        enrollmentId: updated.id,
        prismaCode: notifyErr.code,
      });
    }

    console.log('[training/complete]', {
      actor: hashIdentifier(req.employeeId),
      enrollmentId: updated.id,
      isOwner,
    });

    res.json(serializeEnrollment(updated));
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(409).json({
        error: 'Already completed',
        code: 'ENROLLMENT_LOCKED',
      });
    }
    console.error('[training/complete]', { prismaCode: err.code, message: err.message?.split('\n')[0] });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to mark complete' });
  }
}));

module.exports = router;