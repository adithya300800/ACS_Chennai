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
//   S3-6 addresses the silent-notification half; S3-5 addresses the
//   runaway-volume half. The S3-6 retry pass added below depends on
//   the S3-5 bounded loop staying bounded — a runaway retry pass would
//   defeat the purpose.
//
// [S3-6] Notification retry — the original flip-then-email flow had a
//   silent-miss window. `fanOutToAdmins` is best-effort: it returns
//   { sent: 0 } when every admin has the type muted, when no admins
//   exist, when Resend is unreachable, or when the HTTP call fails.
//   Because the row was already flipped to OVERDUE before fan-out ran,
//   and the next day's sweep skips OVERDUE rows via the atomic guard,
//   the admin never learned about the overdue state — silent miss.
//
//   The fix is two halves:
//     1. Record `overdueNotifiedAt = now()` ONLY when fan-out returns
//        `sent > 0`. Rows that flip but produce zero sends stay with
//        `overdueNotifiedAt = NULL`.
//     2. Add a second pass (after the flip pass) that finds OVERDUE
//        rows with stale/null `overdueNotifiedAt` and re-attempts the
//        fan-out. Because these rows are already OVERDUE we do NOT
//        re-flip — we just retry the email side-effect.
//
//   Both halves share the per-run time budget, so an admin-side outage
//   cannot starve tomorrow's flip pass.
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
      // throws and always returns { sent, skipped, failed } — `sent > 0`
      // means at least one admin actually received the email; `sent === 0`
      // (with skipped/failed accounting for the rest) means nobody got it.
      // [S3-6] We record `overdueNotifiedAt = now()` only on `sent > 0`
      // so the retry pass below can find rows that flipped but never got
      // a notification (Resend outage, all admins muted, no admins, etc.).
      let fanoutResult = null;
      try {
        const dueDateLabel = row.dueDate instanceof Date
          ? getIstDateLabel(row.dueDate)
          : 'unknown';
        const daysOverdue = row.dueDate instanceof Date
          ? Math.max(1, Math.floor((todayIstUtc.getTime() - row.dueDate.getTime()) / (24 * 60 * 60 * 1000)))
          : null;

        fanoutResult = await fanOutToAdmins(
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

        if (fanoutResult && fanoutResult.sent > 0) {
          // Mark the row as notified. Surviving the catch below so a
          // throw doesn't leave us with "notified=true, sent=0".
          await prisma.trainingEnrollment.update({
            where: { id: row.id },
            data: { overdueNotifiedAt: new Date() },
          });
        } else {
          console.warn('[internal-training-overdue] admin fan-out produced zero sends', {
            enrollmentId: row.id,
            sent: fanoutResult?.sent ?? 0,
            skipped: fanoutResult?.skipped ?? 0,
            failed: fanoutResult?.failed ?? 0,
            // The row is now OVERDUE but with overdueNotifiedAt IS NULL —
            // the retry pass below (or tomorrow's cron) will re-attempt.
          });
        }
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

  // [S3-6] Retry pass — find OVERDUE rows that flipped but never got a
  // successful admin notification (Resend outage at 00:30 IST, all admins
  // had the type muted on the day the flip happened, etc.) and re-attempt
  // the fan-out. Distinct from the flip pass because:
  //   - these rows are already OVERDUE — we must NOT re-flip, just retry
  //     the side-effect (the email). The atomic guard is wrong here.
  //   - the predicate is `overdueNotifiedAt IS NULL OR < threshold`, not
  //     `status IN [ASSIGNED, IN_PROGRESS]`.
  //
  // We bound this pass against the SAME time budget so a Resend outage
  // doesn't let retries starve tomorrow's flip pass. There is no per-run
  // flip cap on retries because retries do not flip rows; the budget
  // alone is the right bound.
  let retriedNotified = 0;
  let retriedStillPending = 0;
  let retryBatches = 0;
  const NOTIFICATION_STALENESS_MS = 24 * 60 * 60 * 1000; // retry once per day

  retryLoop: while (Date.now() - startTime < RUN_BUDGET_MS) {
    retryBatches += 1;
    const staleRows = await prisma.trainingEnrollment.findMany({
      where: {
        status: 'OVERDUE',
        OR: [
          { overdueNotifiedAt: null },
          { overdueNotifiedAt: { lt: new Date(Date.now() - NOTIFICATION_STALENESS_MS) } },
        ],
      },
      include: {
        employee: { select: { id: true, name: true } },
        course: { select: { id: true, title: true } },
      },
      orderBy: { overdueNotifiedAt: { sort: 'asc', nulls: 'first' } },
      take: PER_BATCH,
    });

    if (staleRows.length === 0) break;

    for (const row of staleRows) {
      if (Date.now() - startTime >= RUN_BUDGET_MS) {
        stoppedReason = 'time_budget';
        break retryLoop;
      }
      try {
        const dueDateLabel = row.dueDate instanceof Date
          ? getIstDateLabel(row.dueDate)
          : 'unknown';
        const daysOverdue = row.dueDate instanceof Date
          ? Math.max(1, Math.floor((todayIstUtc.getTime() - row.dueDate.getTime()) / (24 * 60 * 60 * 1000)))
          : null;

        const fanoutResult = await fanOutToAdmins(
          {
            type: 'ADMIN_TRAINING_OVERDUE',
            message: `Training overdue: ${row.course?.title || 'a course'} for ${row.employee?.name || 'an employee'} (retry)`,
            meta: {
              employeeName: row.employee?.name || 'an employee',
              courseTitle: row.course?.title || 'Untitled course',
              dueDate: dueDateLabel,
              daysOverdue,
              enrollmentId: row.id,
              retry: true,
            },
          },
          prisma,
        );
        if (fanoutResult && fanoutResult.sent > 0) {
          await prisma.trainingEnrollment.update({
            where: { id: row.id },
            data: { overdueNotifiedAt: new Date() },
          });
          retriedNotified += 1;
        } else {
          retriedStillPending += 1;
        }
      } catch (err) {
        console.error('[internal-training-overdue] retry fan-out failed', {
          enrollmentId: row.id,
          recipient: row.employee?.id ? hashIdentifier(row.employee.id) : null,
          message: err?.message?.split('\n')[0],
        });
        retriedStillPending += 1;
      }
    }

    if (staleRows.length < PER_BATCH) break;
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

  // [S3-6] Un-notified estimate — count of OVERDUE rows with no recent
  // admin notification. After a healthy run this should be 0; if it's
  // large (>0 sustained) it means the retry pass can't catch up, and an
  // operator should investigate the admin-side delivery chain (muted
  // prefs, Resend outage, etc.).
  let unnotifiedEstimate = 0;
  try {
    unnotifiedEstimate = await prisma.trainingEnrollment.count({
      where: {
        status: 'OVERDUE',
        OR: [
          { overdueNotifiedAt: null },
          { overdueNotifiedAt: { lt: new Date(Date.now() - NOTIFICATION_STALENESS_MS) } },
        ],
      },
    });
  } catch (err) {
    console.warn('[internal-training-overdue] un-notified estimate count failed', {
      message: err?.message?.split('\n')[0],
    });
  }

  console.log('[internal-training-overdue] sweep done', {
    date: targetDateStr,
    flipped,
    skipped,
    batches,
    retryBatches,
    retriedNotified,
    retriedStillPending,
    stoppedReason,
    remainingEstimate,
    unnotifiedEstimate,
    elapsedMs: Date.now() - startTime,
  });

  res.json({
    date: targetDateStr,
    todayIstUtc: todayIstUtc.toISOString(),
    candidates: flippedEnrollmentIds.length,
    flipped,
    skipped,
    batches,
    retryBatches,
    retriedNotified,
    retriedStillPending,
    remainingEstimate,
    unnotifiedEstimate,
    stoppedReason,
    flippedEnrollmentIds,
  });
}));

module.exports = router;
