// Round-26: Admin-targeted training-overdue sweep cron handler.
//
// Endpoint:
//   POST /api/internal/training/overdue/sweep
//     Header: X-Internal-Token: <INTERNAL_API_TOKEN>
//     Optional: ?date=YYYY-MM-DD  (for backfill / dry-runs; default = today IST)
//
// Architecture:
//   The Render Cron Job fires this endpoint at 00:30 UTC (= 06:00 IST) every
//   day. We find every TrainingEnrollment with status IN (ASSIGNED, IN_PROGRESS)
//   and dueDate < todayIST, flip the status to OVERDUE, and fire one admin
//   email per flipped row.
//
// Idempotency:
//   - Rows already in OVERDUE are excluded by the where-clause (no re-flip).
//   - Each update uses an atomic guard `where: { id, status: { in:
//     ['ASSIGNED', 'IN_PROGRESS'] } }` so a concurrent admin unassign
//     (CANCELLED) or employee self-complete (PLAYER_OBSERVED_COMPLETED)
//     racing the cron lands as `update.count = 0`. We skip those rows.
//
// Transition note:
//   `canTransition('ASSIGNED', 'OVERDUE')` is FALSE — the training state
//   machine treats OVERDUE→CANCELLED as the only transition out of OVERDUE,
//   and there is no public path INTO OVERDUE from the other states. The
//   cron is the only writer for ASSIGNED|IN_PROGRESS → OVERDUE, so we use a
//   direct status update guarded by the where-clause race protection above.

'use strict';

const express = require('express');
const router = express.Router();
const { fanOutToAdmins } = require('../lib/notify');
const { hashIdentifier } = require('../lib/pii');
const { getIstDateString, getIstDateLabel, istMidnightUtcFromDateString } = require('../lib/dateOnly');

function getPrisma(req) { return req.app.get('prisma'); }

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Mirror internal-digest.js:105 — 404 when unset, 403 when mismatched.
function requireInternalToken(req, res, next) {
  const expected = process.env.INTERNAL_API_TOKEN;
  if (!expected) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (req.headers['x-internal-token'] !== expected) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

router.post('/sweep', requireInternalToken, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma) {
    return res.status(500).json({ error: 'Prisma not available' });
  }

  const dateParam = typeof req.query.date === 'string' ? req.query.date : null;
  const now = new Date();
  const targetDateStr = dateParam || getIstDateString(now);
  let todayIstUtc;
  try {
    todayIstUtc = istMidnightUtcFromDateString(targetDateStr);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  console.log('[internal-training-overdue] sweep start', {
    date: targetDateStr,
    todayIstUtc: todayIstUtc.toISOString(),
  });

  // 1. Find every ASSIGNED | IN_PROGRESS enrollment with dueDate strictly
  //    before today IST. The half-open comparison `< todayIstUtc` (= start
  //    of today, exclusive) means an enrollment with `dueDate = today`
  //    is NOT flipped yet — exactly the user-facing semantics of "due today".
  const candidates = await prisma.trainingEnrollment.findMany({
    where: {
      status: { in: ['ASSIGNED', 'IN_PROGRESS'] },
      dueDate: { lt: todayIstUtc },
    },
    include: {
      employee: { select: { id: true, name: true } },
      course: { select: { id: true, title: true } },
    },
  });

  let flipped = 0;
  let skipped = 0;
  const flippedRows = [];

  for (const row of candidates) {
    // Atomic guard: only update if the row is still in an open status.
    // If a concurrent employee completion or admin cancel flipped the
    // status between the findMany and here, update.count = 0 → skipped.
    const updated = await prisma.trainingEnrollment.updateMany({
      where: {
        id: row.id,
        status: { in: ['ASSIGNED', 'IN_PROGRESS'] },
      },
      data: { status: 'OVERDUE' },
    });

    if (updated.count === 0) {
      skipped += 1;
      continue;
    }
    flipped += 1;
    flippedRows.push(row);

    // Fire one admin-targeted email per flipped row. fanOutToAdmins never
    // throws, but a per-row failure must not stop the rest of the sweep.
    try {
      const dueDateLabel = row.dueDate instanceof Date
        ? getIstDateLabel(row.dueDate)
        : 'unknown';
      const daysOverdue = row.dueDate instanceof Date
        ? Math.max(1, Math.floor((todayIstUtc.getTime() - row.dueDate.getTime()) / (24 * 60 * 60 * 1000)))
        : null;

      await fanOutToAdmins(
        {
          type: 'ADMIN_TRAINING_OVERDUE',
          message: `Training overdue: ${row.course?.title || 'a course'} for ${row.employee?.name || 'an employee'}`,
          meta: {
            employeeName: row.employee?.name || 'an employee',
            courseTitle: row.course?.title || 'Untitled course',
            dueDate: dueDateLabel,
            daysOverdue,
            enrollmentId: row.id,
          },
        },
        prisma,
      );
    } catch (err) {
      console.error('[internal-training-overdue] admin fan-out failed', {
        enrollmentId: row.id,
        recipient: row.employee?.id ? hashIdentifier(row.employee.id) : null,
        message: err?.message?.split('\n')[0],
      });
    }
  }

  console.log('[internal-training-overdue] sweep done', {
    date: targetDateStr,
    candidates: candidates.length,
    flipped,
    skipped,
  });

  res.json({
    date: targetDateStr,
    todayIstUtc: todayIstUtc.toISOString(),
    candidates: candidates.length,
    flipped,
    skipped,
    flippedEnrollmentIds: flippedRows.map((r) => r.id),
  });
}));

module.exports = router;
