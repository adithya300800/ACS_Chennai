// Round-26: Admin-targeted training-overdue sweep cron handler.
//
// Endpoint:
//   POST /api/internal/training/overdue/sweep
//     Header: X-Internal-Token: <INTERNAL_API_TOKEN>
//     Optional: ?date=YYYY-MM-DD  (for backfill / dry-runs; default = today IST)
//
// Architecture:
//   cron-admin-emails.yml fires this endpoint at 00:30 UTC (= 06:00 IST)
//   every day. We find every TrainingEnrollment with status IN
//   (ASSIGNED, IN_PROGRESS) and dueDate < todayIST, flip the status to
//   OVERDUE, and fire one admin email per flipped row.
//
// [S3-5] Backlog-bounded sweep — the original implementation loaded every
//   candidate in a single `findMany` with no `take:` limit and processed
//   them in a single loop. With N overdue rows × A admins that produces
//   N×A Resend HTTPS calls per cron fire, easily enough to:
//     - saturate the 180s curl timeout on cron-admin-emails.yml (which
//       then aborts and reports a false failure to GH Actions)
//     - exceed the 5-minute GH Actions job timeout
//     - trip Resend's per-second rate limiter (silent per-row failure)
//     - balloon EmailLog writes (≈ N×A rows in one DB transaction stream)
//   Worse, because we flipped-then-emailed in the same loop, a curl
//   timeout mid-loop left the DB in a half-flipped state (rows already
//   OVERDUE but never notified). Re-running the next day would skip
//   those rows via the atomic guard and they would never get notified.
//   This is the same shape of bug as S3-6 — partially addressed there by
//   the per-flipped-row audit, fully fixed here by bounding the loop.
//
//   The fix is a bounded-batch loop with a per-run cap and a soft time
//   budget. Default bounds (env-overridable):
//
//     TRAINING_OVERDUE_BATCH          = 500   // findMany take per batch
//     TRAINING_OVERDUE_RUN_MAX_FLIPS  = 1000  // total flips per cron fire
//     TRAINING_OVERDUE_RUN_BUDGET_MS  = 110000 // 110s, leaves 70s slack
//                                             // for the 180s curl timeout
//                                             // + network egress
//
//   A cron fire that hits the cap or the time budget returns 200 with
//   `stoppedReason: 'per_run_max' | 'time_budget'` and a
//   `remainingEstimate` count of rows still in (ASSIGNED, IN_PROGRESS).
//   The next day's fire (or an operator's manual workflow_dispatch)
//   picks up the rest — idempotent because the atomic guard
//   `where: { id, status: { in: [...] } }` skips already-OVERDUE rows.
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

// [S3-5] Bounds — read once at route definition. Env-tunable so an operator
// can lower them for a noisy day without a code change. Defaults are sized
// for the production cron window: 110s budget × ~6 rows/s Resend throughput
// ≈ 660 row-flips achievable before the budget trips. 1000-flip cap is
// the hard ceiling; pick whichever fires first.
const PER_BATCH = (() => {
  const v = parseInt(process.env.TRAINING_OVERDUE_BATCH || '500', 10);
  return Number.isFinite(v) && v > 0 ? v : 500;
})();
const PER_RUN_MAX_FLIPS = (() => {
  const v = parseInt(process.env.TRAINING_OVERDUE_RUN_MAX_FLIPS || '1000', 10);
  return Number.isFinite(v) && v > 0 ? v : 1000;
})();
const RUN_BUDGET_MS = (() => {
  const v = parseInt(process.env.TRAINING_OVERDUE_RUN_BUDGET_MS || '110000', 10);
  return Number.isFinite(v) && v > 0 ? v : 110000;
})();

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
    perBatch: PER_BATCH,
    perRunMaxFlips: PER_RUN_MAX_FLIPS,
    runBudgetMs: RUN_BUDGET_MS,
  });

  // [S3-5] Bounded-batch sweep. Loops findMany(...,{ take: PER_BATCH }) →
  // per-row updateMany → per-row fan-out until one of:
  //   - findMany returns 0 rows (drained)
  //   - PER_RUN_MAX_FLIPS reached (hard cap)
  //   - RUN_BUDGET_MS elapsed (soft time budget)
  // On non-drain stop the route still returns 200 with `stoppedReason` so
  // cron-admin-emails.yml sees a clean POST and the next day's fire picks
  // up the rest (idempotent via the per-row atomic guard).
  const startTime = Date.now();
  let flipped = 0;
  let skipped = 0;
  let batches = 0;
  let stoppedReason = null;
  const flippedEnrollmentIds = [];

  outer: while (true) {
    if (flipped >= PER_RUN_MAX_FLIPS) {
      stoppedReason = 'per_run_max';
      break;
    }
    if (Date.now() - startTime >= RUN_BUDGET_MS) {
      stoppedReason = 'time_budget';
      break;
    }

    batches += 1;

    // Find up to PER_BATCH oldest-due ASSIGNED|IN_PROGRESS enrollments
    // whose dueDate is strictly before today IST.
    //
    // `orderBy: dueDate asc` makes batching deterministic: each cron fire
    // processes the same rows first across days, so a row that's been
    // stuck for a week gets priority over one that's been stuck for a day.
    const candidates = await prisma.trainingEnrollment.findMany({
      where: {
        status: { in: ['ASSIGNED', 'IN_PROGRESS'] },
        dueDate: { lt: todayIstUtc },
      },
      include: {
        employee: { select: { id: true, name: true } },
        course: { select: { id: true, title: true } },
      },
      orderBy: { dueDate: 'asc' },
      take: PER_BATCH,
    });

    if (candidates.length === 0) {
      // Drained — no more rows match the where-clause.
      break;
    }

    for (const row of candidates) {
      // Re-check the bounds at the top of each row so we don't overshoot
      // a partial batch when we hit the cap or budget mid-batch.
      if (flipped >= PER_RUN_MAX_FLIPS) {
        stoppedReason = 'per_run_max';
        break outer;
      }
      if (Date.now() - startTime >= RUN_BUDGET_MS) {
        stoppedReason = 'time_budget';
        break outer;
      }

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
      flippedEnrollmentIds.push(row.id);

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

    // Short-circuit: if this batch was smaller than the take we requested,
    // there are no more rows to fetch on a subsequent iteration.
    if (candidates.length < PER_BATCH) {
      break;
    }
  }

  // [S3-5] Remaining estimate — count of rows still in (ASSIGNED,
  // IN_PROGRESS) with dueDate < today. After a non-drain stop this is the
  // backlog for the next fire; after a drain it should be 0. Counting is
  // O(N) on the index but cheap relative to the sweep we just ran, and
  // gives operators a single number to alert on.
  let remainingEstimate = 0;
  try {
    remainingEstimate = await prisma.trainingEnrollment.count({
      where: {
        status: { in: ['ASSIGNED', 'IN_PROGRESS'] },
        dueDate: { lt: todayIstUtc },
      },
    });
  } catch (err) {
    console.warn('[internal-training-overdue] remaining-estimate count failed', {
      message: err?.message?.split('\n')[0],
    });
  }

  console.log('[internal-training-overdue] sweep done', {
    date: targetDateStr,
    flipped,
    skipped,
    batches,
    stoppedReason,
    remainingEstimate,
    elapsedMs: Date.now() - startTime,
  });

  res.json({
    date: targetDateStr,
    todayIstUtc: todayIstUtc.toISOString(),
    candidates: flippedEnrollmentIds.length,
    flipped,
    skipped,
    batches,
    remainingEstimate,
    stoppedReason,
    flippedEnrollmentIds,
  });
}));

module.exports = router;
