// Employee Training routes — Round-14 + Round-20 (DR-010).
//
// Endpoints:
//   GET    /api/training/courses                       — admin lists courses
//   POST   /api/training/courses                       — admin creates a course
//   GET    /api/training/courses/:id                   — admin/owner reads a course + own enrollment
//   PUT    /api/training/courses/:id                   — admin updates a course
//   POST   /api/training/enrollments                   — admin bulk-assigns (courseId + employeeIds[])
//   GET    /api/training/enrollments/my                — employee's own enrollments
//   GET    /api/training/enrollments                   — admin queue (filterable)
//   GET    /api/training/enrollments/:id               — owner or admin reads one
//   PUT    /api/training/enrollments/:id/progress      — employee pings watch progress (auto-completes at >=100 for player-observable providers, requires session payload)
//   PUT    /api/training/enrollments/:id/complete      — owner manual mark-complete (defaults to SELF_ATTESTED) or admin PLAYER_OBSERVED rewrite
//   POST   /api/training/enrollments/:id/admin-override — admin-only override (ADMIN_OVERRIDE_COMPLETED)
//   GET    /api/training/reports/completion            — completion rollup with optional ?evidenceClass= filter
//
// Auth model:
//   - requireAuth on all routes.
//   - Admin-only for: course CRUD + enrollment list + bulk assign + admin override complete + reports.
//   - Owner-only for: progress pings + manual complete (admin can override complete).

'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requireFreshAdmin } = require('../middleware/auth');
const { trainingWriteLimiter } = require('../middleware/rateLimit');
const {
  ALLOWED_PROVIDERS,
  ALLOWED_STATUSES,
  EVIDENCE_CLASSES,
  EVIDENCE_TO_STATUS,
  STATUS_TO_EVIDENCE,
  validateCreateCourse,
  validateUpdateCourse,
  validateAssignEnrollments,
  validateProgressPayload,
  validateCompletePayload,
  validateCancelPayload,
  canTransition,
  canAutoCompleteFromPlayer,
  isCompleted,
  markComplete,
  httpStatusForCode,
} = require('../lib/trainingRules');
const { mapPrismaError } = require('../lib/errors');
const { hashIdentifier } = require('../lib/pii');
// Round-25: email fan-out hook for the existing in-app notification. The
// 6 training notification.create sites add one fire-and-forget
// `fanOutEmail(...)` call after their insert succeeds.
const { fanOutEmail } = require('../lib/notify');

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
    // Round-20 (DR-010): expose evidenceClass as the human-meaningful
    // column (one of SELF_ATTESTED / PLAYER_OBSERVED / PROVIDER_VERIFIED /
    // ADMIN_OVERRIDE) instead of leaking the enum-suffix to the client.
    evidenceClass: rest.evidenceClass || (STATUS_TO_EVIDENCE[rest.status] || null),
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
//
// Round-20 (DR-005): requireFreshAdmin instead of the `req.isAdmin` JWT claim.
// Assigning training is a mutation, so it re-reads Employee.isAdmin from the
// database — a demoted admin loses the ability to assign immediately rather
// than when their access token happens to expire.
router.post('/enrollments', trainingWriteLimiter, requireFreshAdmin, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const result = validateAssignEnrollments(req.body);
  if (!result.ok) {
    return res.status(httpStatusForCode(result.code)).json({
      error: result.message,
      code: result.code,
    });
  }
  const { courseId, employeeIds, employeeEmails, dueDate, priority } = result.value;

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

  // Resolve employees: either by id (when employeeIds was supplied) OR by
  // email (when employeeEmails was supplied). The UI uses the email form
  // because admins don't have ids handy in a paste-emails textarea.
  let employees;
  let invalidInputs;
  if (employeeEmails) {
    const lowered = employeeEmails.map((e) => e.toLowerCase());
    employees = await prisma.employee.findMany({
      where: { email: { in: lowered } },
      select: { id: true, name: true, email: true },
    });
    const foundEmails = new Set(employees.map((e) => e.email.toLowerCase()));
    invalidInputs = employeeEmails.filter((e) => !foundEmails.has(e.toLowerCase()));
  } else {
    employees = await prisma.employee.findMany({
      where: { id: { in: employeeIds } },
      select: { id: true, name: true, email: true },
    });
    const foundIds = new Set(employees.map((e) => e.id));
    invalidInputs = employeeIds.filter((id) => !foundIds.has(id));
  }

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
        const notifRow = await prisma.notification.create({
          data: {
            employeeId: enrollment.employeeId,
            type: 'TRAINING_ASSIGNED',
            trainingEnrollmentId: enrollment.id,
            message: `New training assigned: ${enrollment.course.title}`,
          },
        });
        // Round-25: email fan-out. courseTitle in context lets the
        // template render "New training assigned: <course>" without a
        // follow-up lookup. dueDate is included so the email body can
        // surface the deadline.
        fanOutEmail(notifRow, prisma, {
          courseTitle: enrollment.course.title,
          dueDate: enrollment.dueDate
            ? new Date(enrollment.dueDate).toISOString().slice(0, 10)
            : null,
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
    requested: (employeeEmails || employeeIds).length,
    created: created.length,
    skipped: skipped.length,
    invalid: invalidInputs.length,
  });

  res.status(201).json({
    created: created.map(serializeEnrollment),
    skipped,
    invalidInputs,
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
  if (existing.employeeId !== req.employeeId) {
    return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
  }
  // DR-010 (round-20): once a row hits any of the four completed-states, the
  // progress route is a noop (we don't auto-downgrade). Idempotent echo so
  // the player can stop pinging.
  if (isCompleted(existing.status) || existing.status === 'CANCELLED' || existing.status === 'OVERDUE') {
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
  const { progressPct, lastWatchedSec, evidenceMetadata } = result.value;

  // DR-010 (round-20): when the player reports progressPct >= 100, only the
  // PLAYER_OBSERVED path may auto-flip to a completed-state, and ONLY for
  // providers with a working IFrame API (YOUTUBE / VIMEO). For everything
  // else (LinkedIn Learning / Coursera / Udemy / OTHER), the client must
  // not be able to claim "I watched to the end" — the course must be
  // completed via the manual PUT /complete endpoint (SELF_ATTESTED) or the
  // admin override endpoint (ADMIN_OVERRIDE).
  //
  // We additionally require the client to send a session payload proving
  // it really did hook into the player API. A tampered client that just
  // fakes `progressPct: 100` with no `evidenceMetadata.sessionId` will be
  // rejected with PLAYER_DATA_REQUIRED.
  const now = new Date();
  const data = {
    progressPct,
    lastWatchedSec,
  };
  if (progressPct >= 100) {
    if (!canAutoCompleteFromPlayer(existing.course.provider)) {
      return res.status(400).json({
        error: `Provider ${existing.course.provider} is not player-observable; use PUT /complete (SELF_ATTESTED) or POST /admin-override instead.`,
        code: 'PLAYER_DATA_REQUIRED',
      });
    }
    if (!evidenceMetadata || typeof evidenceMetadata !== 'object' || !evidenceMetadata.sessionId) {
      return res.status(400).json({
        error: 'progressPct >= 100 from a player-observable provider requires evidenceMetadata.sessionId (the IFrame session token).',
        code: 'PLAYER_DATA_REQUIRED',
      });
    }
    data.status = 'PLAYER_OBSERVED_COMPLETED';
    data.completedAt = now;
    data.startedAt = existing.startedAt || now;
    data.evidenceClass = 'PLAYER_OBSERVED';
    data.completedBy = existing.employeeId;
    data.evidenceMetadata = evidenceMetadata;
  } else if (progressPct > 0) {
    data.status = 'IN_PROGRESS';
    if (existing.status === 'ASSIGNED') data.startedAt = now;
  } else {
    // 0% re-ping — keep current status, just update the timestamp.
    data.status = existing.status;
  }

  // Conditional UPDATE on status-not-completed so a racing "complete" call
  // can't double-write. P2025 means someone else (or this same call) just
  // completed it — treat as noop success.
  try {
    const updated = await prisma.trainingEnrollment.update({
      where: { id, status: { notIn: [
        'SELF_ATTESTED_COMPLETED',
        'PLAYER_OBSERVED_COMPLETED',
        'PROVIDER_VERIFIED_COMPLETED',
        'ADMIN_OVERRIDE_COMPLETED',
        'CANCELLED',
      ] } },
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

    // Best-effort notifications on first IN_PROGRESS transition + completed.
    if (existing.status === 'ASSIGNED' && updated.status === 'IN_PROGRESS') {
      try {
        const notifRow = await prisma.notification.create({
          data: {
            employeeId: updated.employeeId,
            type: 'TRAINING_IN_PROGRESS',
            trainingEnrollmentId: updated.id,
            message: `You started: ${updated.course.title}`,
          },
        });
        fanOutEmail(notifRow, prisma, { courseTitle: updated.course.title });
      } catch (notifyErr) {
        console.error('[training/progress] in-progress notification failed', {
          enrollmentId: updated.id,
          prismaCode: notifyErr.code,
        });
      }
    } else if (isCompleted(updated.status) && !isCompleted(existing.status)) {
      try {
        const notifRow = await prisma.notification.create({
          data: {
            employeeId: updated.employeeId,
            type: 'TRAINING_COMPLETED',
            trainingEnrollmentId: updated.id,
            message: `Training completed: ${updated.course.title}`,
          },
        });
        fanOutEmail(notifRow, prisma, { courseTitle: updated.course.title });
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
      evidenceClass: updated.evidenceClass,
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

// PUT /api/training/enrollments/:id/complete — manual mark-complete.
// Owner defaults to SELF_ATTESTED; admin defaults to ADMIN_OVERRIDE.
// Caller can pass `{ evidenceClass: 'PLAYER_OBSERVED', evidenceMetadata: { sessionId } }`
// to rewrite a row that was previously completed via the progress route.
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
  if (isCompleted(existing.status)) {
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

  // Decide evidence class:
  //   - explicit (caller-passed) wins
  //   - owner → SELF_ATTESTED (no player data on this path)
  //   - admin on non-owner → ADMIN_OVERRIDE
  // PLAYER_OBSERVED cannot be set from this endpoint — the player path is
  // exclusive to PUT /progress so we have a single canonical writer for
  // each evidence class.
  let evidenceClass = result.value.evidenceClass;
  if (!evidenceClass) {
    evidenceClass = isOwner ? 'SELF_ATTESTED' : 'ADMIN_OVERRIDE';
  } else if (evidenceClass === 'PLAYER_OBSERVED' || evidenceClass === 'PROVIDER_VERIFIED') {
    return res.status(400).json({
      error: `${evidenceClass} can only be set via the player or provider path, not manual mark-complete`,
      code: 'EVIDENCE_REQUIRED',
    });
  }

  // PLAYER_OBSERVED requires player payload — refuse to set without it.
  if (evidenceClass === 'PLAYER_OBSERVED' && (!result.value.evidenceMetadata || !result.value.evidenceMetadata.sessionId)) {
    return res.status(400).json({
      error: 'PLAYER_OBSERVED requires evidenceMetadata.sessionId',
      code: 'PLAYER_DATA_REQUIRED',
    });
  }

  const patch = markComplete(existing, {
    evidenceClass,
    completedBy: isOwner ? existing.employeeId : req.employeeId,
    evidenceMetadata: result.value.evidenceMetadata,
  }, req.employeeId);
  if (result.value.note) patch.employeeNote = result.value.note;

  try {
    const updated = await prisma.trainingEnrollment.update({
      where: {
        id,
        // Locking guard: if someone else already completed between the read
        // and the write, refuse — the client will re-fetch and observe the
        // winning state.
        status: { notIn: [
          'SELF_ATTESTED_COMPLETED',
          'PLAYER_OBSERVED_COMPLETED',
          'PROVIDER_VERIFIED_COMPLETED',
          'ADMIN_OVERRIDE_COMPLETED',
        ] },
      },
      data: patch,
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

    // Best-effort notification on completed transition.
    try {
      const notifRow = await prisma.notification.create({
        data: {
          employeeId: updated.employeeId,
          type: 'TRAINING_COMPLETED',
          trainingEnrollmentId: updated.id,
          message: `Training completed: ${updated.course.title}`,
        },
      });
      fanOutEmail(notifRow, prisma, { courseTitle: updated.course.title });
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
      evidenceClass: updated.evidenceClass,
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

// POST /api/training/enrollments/:id/admin-override — admin-only override.
// Always sets evidenceClass = ADMIN_OVERRIDE, completedBy = the acting
// admin. Use this when the auto-capture missed (browser killed mid-play)
// or for non-trackable providers where the employee forgot to click.
router.post('/enrollments/:id/admin-override', trainingWriteLimiter, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;

  if (!req.isAdmin) return res.status(403).json({ error: 'Admin access required' });
  const fresh = await assertFreshAdmin(req, prisma);
  if (!fresh) return res.status(403).json({ error: 'Admin access required' });

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

  if (isCompleted(existing.status)) {
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

  // Always ADMIN_OVERRIDE here — refuse if caller tries to set something else.
  if (result.value.evidenceClass && result.value.evidenceClass !== 'ADMIN_OVERRIDE') {
    return res.status(400).json({
      error: `admin-override endpoint always sets evidenceClass=ADMIN_OVERRIDE (got ${result.value.evidenceClass})`,
      code: 'EVIDENCE_REQUIRED',
    });
  }

  const patch = markComplete(existing, {
    evidenceClass: 'ADMIN_OVERRIDE',
    completedBy: req.employeeId,
    evidenceMetadata: result.value.evidenceMetadata,
  }, req.employeeId);
  if (result.value.note) patch.employeeNote = result.value.note;

  try {
    const updated = await prisma.trainingEnrollment.update({
      where: {
        id,
        status: { notIn: [
          'SELF_ATTESTED_COMPLETED',
          'PLAYER_OBSERVED_COMPLETED',
          'PROVIDER_VERIFIED_COMPLETED',
          'ADMIN_OVERRIDE_COMPLETED',
        ] },
      },
      data: patch,
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

    // Best-effort notification on override.
    try {
      const notifRow = await prisma.notification.create({
        data: {
          employeeId: updated.employeeId,
          type: 'TRAINING_COMPLETED',
          trainingEnrollmentId: updated.id,
          message: `Training completed: ${updated.course.title}`,
        },
      });
      fanOutEmail(notifRow, prisma, { courseTitle: updated.course.title });
    } catch (notifyErr) {
      console.error('[training/admin-override] notification failed', {
        enrollmentId: updated.id,
        prismaCode: notifyErr.code,
      });
    }

    console.log('[training/admin-override]', {
      actor: hashIdentifier(req.employeeId),
      enrollmentId: updated.id,
      reason: result.value.reason,
    });

    res.json(serializeEnrollment(updated));
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(409).json({
        error: 'Already completed',
        code: 'ENROLLMENT_LOCKED',
      });
    }
    console.error('[training/admin-override]', { prismaCode: err.code, message: err.message?.split('\n')[0] });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to admin-override enrollment' });
  }
}));

// POST /api/training/enrollments/:id/cancel — admin-only unassign.
//
// Round-24 follow-up to edit/reassign/archive: the per-row "cancel" half of
// the enrollment lifecycle. The admin can pull back an ASSIGNED,
// IN_PROGRESS, or OVERDUE row — anything that's still in flight. Once a
// row is in any *_COMPLETED state, this endpoint refuses with 409
// (use the existing override-completed route if you really need to flip
// a completed row). Already-CANCELLED rows are 409 too (idempotent re-cancel
// is reasonable but the UI already hides the button after cancellation, so
// a 409 surfaces obvious races and double-clicks).
//
// Body: { note?: string <= 500 chars } — optional, stored in employeeNote
// as a plain-text audit trail. There is no dedicated `cancelledAt` /
// `cancelledBy` column on TrainingEnrollment (round-22 deliberately avoided
// a migration during the deploy hardening sequence); the row's `updatedAt`
// is Prisma's automatic write and serves as the "when" timestamp.
//
// Response: 200 with the updated enrollment serialized via
// serializeEnrollment(), same shape as admin-override returns.
router.post('/enrollments/:id/cancel', trainingWriteLimiter, requireFreshAdmin, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;

  if (!req.isAdmin) return res.status(403).json({ error: 'Admin access required' });
  const fresh = await assertFreshAdmin(req, prisma);
  if (!fresh) return res.status(403).json({ error: 'Admin access required' });

  const result = validateCancelPayload(req.body);
  if (!result.ok) {
    return res.status(httpStatusForCode(result.code)).json({
      error: result.message,
      code: result.code,
    });
  }

  // Read the existing row so we can:
  //   - 404 if missing
  //   - 409 if already CANCELLED or already in a completed state
  //   - surface a useful error if the state machine would refuse the
  //     transition we intended (defence-in-depth — the WHERE clause below
  //     already locks this, so this is purely a clearer error message).
  const existing = await prisma.trainingEnrollment.findUnique({
    where: { id },
    include: {
      course: { select: { id: true, title: true, isArchived: true } },
      employee: { select: { id: true, name: true, email: true } },
    },
  });
  if (!existing) return res.status(404).json({ error: 'Enrollment not found', code: 'NOT_FOUND' });
  if (existing.status === 'CANCELLED') {
    return res.status(409).json({ error: 'Already cancelled', code: 'ENROLLMENT_CANCELLED' });
  }
  if (isCompleted(existing.status)) {
    return res.status(409).json({ error: 'Cannot cancel a completed enrollment', code: 'ENROLLMENT_LOCKED' });
  }
  if (!canTransition(existing.status, 'CANCELLED')) {
    return res.status(409).json({
      error: `Cannot cancel an enrollment in state ${existing.status}`,
      code: 'INVALID_TRANSITION',
    });
  }

  // `where: { id, status: existing.status }` is the atomic guard. If two
  // admins click Cancel at the same instant, only one updateMany/update
  // will match — the other raises P2025 (no rows matched) and we 409.
  // This mirrors the concurrency lock admin-override uses
  // (`status: { notIn: completed-states }`) but is tighter: it locks
  // against the exact status we read, not a notIn set.
  try {
    const data = { status: 'CANCELLED' };
    if (result.value.note) data.employeeNote = result.value.note;

    const updated = await prisma.trainingEnrollment.update({
      where: { id, status: existing.status },
      data,
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

    // Best-effort: drop a notification so the employee (and the assigner)
    // see that the row was pulled back. Same pattern as admin-override —
    // wrapped in try/catch so a notification failure doesn't downgrade the
    // 200 to a 500.
    try {
      const notifRow = await prisma.notification.create({
        data: {
          employeeId: updated.employeeId,
          type: 'TRAINING_CANCELLED',
          trainingEnrollmentId: updated.id,
          message: `Training unassigned: ${updated.course.title}${result.value.note ? ` — ${result.value.note}` : ''}`,
        },
      });
      fanOutEmail(notifRow, prisma, {
        courseTitle: updated.course.title,
        note: result.value.note,
      });
    } catch (notifyErr) {
      console.error('[training/cancel] notification failed', {
        enrollmentId: updated.id,
        prismaCode: notifyErr.code,
      });
    }

    console.log('[training/cancel]', {
      actor: hashIdentifier(req.employeeId),
      enrollmentId: updated.id,
      courseId: updated.courseId,
      priorStatus: existing.status,
      noteLen: result.value.note ? result.value.note.length : 0,
    });

    res.json(serializeEnrollment(updated));
  } catch (err) {
    if (err.code === 'P2025') {
      // The atomic guard failed — someone else flipped the row between
      // our read and our write. Surface as 409 ENROLLMENT_LOCKED so the
      // UI can re-fetch and decide what to do.
      return res.status(409).json({
        error: 'Enrollment changed during cancel; refresh and retry',
        code: 'ENROLLMENT_LOCKED',
      });
    }
    console.error('[training/cancel]', { prismaCode: err.code, message: err.message?.split('\n')[0] });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to cancel enrollment' });
  }
}));

// GET /api/training/reports/completion — admin-only completion rollup.
//
// Query params:
//   evidenceClass  filter to one of SELF_ATTESTED | PLAYER_OBSERVED |
//                   PROVIDER_VERIFIED | ADMIN_OVERRIDE
//   courseId       optional — narrow to one course
//   employeeId     optional — narrow to one employee
//   since          optional ISO date — only count completedAt >= since
//
// Returns:
//   { totals: { byEvidenceClass, byCourse, byEmployee }, rows: [...] }
router.get('/reports/completion', asyncHandler(async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin access required' });
  const prisma = getPrisma(req);

  let evidenceClassFilter = null;
  if (req.query.evidenceClass) {
    if (!EVIDENCE_CLASSES.has(req.query.evidenceClass)) {
      return res.status(400).json({
        error: `evidenceClass must be one of: ${[...EVIDENCE_CLASSES].join(', ')}`,
        code: 'INVALID_EVIDENCE_CLASS',
      });
    }
    evidenceClassFilter = req.query.evidenceClass;
  }

  const where = { evidenceClass: evidenceClassFilter || { not: null } };
  if (req.query.courseId) where.courseId = String(req.query.courseId);
  if (req.query.employeeId) where.employeeId = String(req.query.employeeId);
  if (req.query.since) {
    const since = new Date(req.query.since);
    if (Number.isNaN(since.getTime())) {
      return res.status(400).json({ error: 'since must be an ISO date', code: 'INVALID_SINCE' });
    }
    where.completedAt = { gte: since };
  }

  const rows = await prisma.trainingEnrollment.findMany({
    where,
    orderBy: { completedAt: 'desc' },
    take: 1000,
    include: {
      employee: { select: { id: true, name: true, email: true, department: true } },
      course: { select: { id: true, title: true, provider: true } },
    },
  });

  // Roll up the four counts even when filtered — useful for "out of N
  // completed, how many were player-observed vs self-attested".
  const byEvidenceClass = Object.fromEntries(
    [...EVIDENCE_CLASSES].map((k) => [k, 0])
  );
  const byCourse = {};
  const byEmployee = {};
  for (const r of rows) {
    if (r.evidenceClass) byEvidenceClass[r.evidenceClass] = (byEvidenceClass[r.evidenceClass] || 0) + 1;
    if (r.course?.id) byCourse[r.course.id] = byCourse[r.course.id] || { title: r.course.title, count: 0 };
    if (r.course?.id) byCourse[r.course.id].count += 1;
    if (r.employee?.id) byEmployee[r.employee.id] = byEmployee[r.employee.id] || { name: r.employee.name, count: 0 };
    if (r.employee?.id) byEmployee[r.employee.id].count += 1;
  }

  res.json({
    totals: {
      byEvidenceClass,
      byCourse,
      byEmployee,
      total: rows.length,
    },
    rows: rows.map((r) => ({
      id: r.id,
      status: r.status,
      evidenceClass: r.evidenceClass,
      completedBy: r.completedBy,
      completedAt: r.completedAt instanceof Date ? r.completedAt.toISOString() : r.completedAt,
      employee: r.employee ? { id: r.employee.id, name: r.employee.name, email: r.employee.email } : null,
      course: r.course ? { id: r.course.id, title: r.course.title, provider: r.course.provider } : null,
    })),
  });
}));

module.exports = router;