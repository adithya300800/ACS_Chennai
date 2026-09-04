// [S3-7] Durable upload-intent sweep — the cron LPR-012 promised but never built.
//
// Endpoint:
//   POST /api/internal/upload/sweep
//     Header: X-Internal-Token: <INTERNAL_API_TOKEN>
//
// ── Why this exists ──────────────────────────────────────────────────────
//
// The LPR-012 migration header promised an orphan-cleanup cron and even
// created `upload_intent_status_expires_at_idx` for it. No such job was
// ever written. Cleanup still depended entirely on the in-process
// `setTimeout` + `pendingUploads` Map in `lib/uploadRoutes.js`, which does
// not survive a restart — a redeploy, an OOM, or Render's free-tier
// spin-down silently drops every scheduled cleanup on the floor. That is
// exactly the failure LPR-012 was raised to fix, so the finding stayed
// open.
//
// This endpoint is the durable replacement. The Map cleanup is deliberately
// LEFT IN PLACE as a hot-path cache eviction (it is faster than waiting up
// to 15 minutes for the cron, and costs nothing when it works); the DB row
// is the source of truth and this sweep is the guarantee.
//
// ── The three passes ─────────────────────────────────────────────────────
//
//   1. PENDING-expire      status='PENDING' AND expires_at < now()
//      The client got a presigned URL and never confirmed. Bytes may or
//      may not have landed in R2 — delete is best-effort, 404 is success.
//
//   2. CONFIRMED-orphan    status='CONFIRMED' AND bound_at IS NULL
//                          AND confirmed_at < now() - grace
//      The bytes are verified in R2 but no DPR or Inspection ever claimed
//      them. THIS is the permanent-orphan class S3-7 is about: LPR-012
//      never swept CONFIRMED rows because it assumed they were referenced,
//      and nothing ever recorded whether they actually were. The grace
//      window (default 1h) exists so a user who attaches photos and then
//      spends twenty minutes filling in the form is never penalised.
//
//   3. EXPIRED-blob-verify status='EXPIRED' AND bound_at IS NULL
//                          AND created_at < now() - 24h
//      Belt-and-braces for rows whose blob delete failed in pass 1 or 2
//      (R2 outage, transient 5xx). Re-attempts the delete and stamps
//      bound_type='swept' + bound_at so the pass terminates instead of
//      re-scanning the same dead rows every 15 minutes forever.
//
// ── Race safety ──────────────────────────────────────────────────────────
//
// Every pass flips the row status FIRST, with an atomic guard, and only
// deletes the blob when `count === 1`. The ordering is load-bearing: if we
// deleted first, a DPR POST that binds the intent between our findMany and
// our update would end up referencing a blob we had already destroyed.
// Flipping first makes the guarded update the serialization point — a
// concurrent bind sets `bound_at`, our `bound_at: null` guard misses, we
// skip the row and the blob survives. The inverse race (sweep flips
// between the DPR handler's validation and its bind) is bounded by the
// grace window and shows up as a `[upload/intent] partial bind` warning.
//
// ── Bounds ───────────────────────────────────────────────────────────────
//
// Mirrors internal-training-overdue.js (S3-5). Env-tunable:
//
//   UPLOAD_SWEEP_BATCH             = 500     // findMany take per batch
//   UPLOAD_SWEEP_RUN_MAX           = 2000    // total actions per fire
//   UPLOAD_SWEEP_RUN_BUDGET_MS     = 110000  // 110s, leaves slack under
//                                            // the 180s curl timeout
//   UPLOAD_SWEEP_CONFIRMED_GRACE_MS = 3600000 // 1h grace for pass 2
//
// A run that hits the cap or the budget returns 200 (not 5xx) with
// `stoppedReason: 'per_run_max' | 'time_budget'` plus a `remainingEstimate`,
// matching the S3-5 contract — the next fire 15 minutes later picks up the
// rest, idempotently, via the same atomic guards.

'use strict';

const express = require('express');
const router = express.Router();
const { deleteBlob } = require('../lib/blobStorage');
const { hashIdentifier } = require('../lib/pii');

function getPrisma(req) { return req.app.get('prisma'); }

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Mirror internal-training-overdue.js:97 exactly — 404 when unset, 403
// when mismatched. The cron's auth expectations must not drift between
// sibling internal routes.
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

function readPositiveInt(envValue, fallback) {
  const v = parseInt(envValue || '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const PER_BATCH = readPositiveInt(process.env.UPLOAD_SWEEP_BATCH, 500);
const PER_RUN_MAX = readPositiveInt(process.env.UPLOAD_SWEEP_RUN_MAX, 2000);
const RUN_BUDGET_MS = readPositiveInt(process.env.UPLOAD_SWEEP_RUN_BUDGET_MS, 110000);
const CONFIRMED_GRACE_MS = readPositiveInt(process.env.UPLOAD_SWEEP_CONFIRMED_GRACE_MS, 60 * 60 * 1000);
const EXPIRED_VERIFY_AFTER_MS = readPositiveInt(process.env.UPLOAD_SWEEP_EXPIRED_VERIFY_MS, 24 * 60 * 60 * 1000);

/**
 * Best-effort blob delete. A 404 from R2 means the bytes never landed (or
 * a previous pass already removed them) — that is success, not failure.
 * Anything else is an honest failure and is counted as such: the response
 * must never claim storage was reclaimed when it was not.
 */
async function tryDeleteBlob(intent) {
  try {
    await deleteBlob(intent.container, intent.blobPath);
    return { cleaned: true };
  } catch (err) {
    if (err && err.$metadata && err.$metadata.httpStatusCode === 404) {
      return { cleaned: true, alreadyGone: true };
    }
    console.warn('[internal-upload-sweep] blob delete failed', {
      employeeHash: intent.employeeId ? hashIdentifier(intent.employeeId) : null,
      ulid: intent.ulid,
      container: intent.container,
      errMessage: err && err.message ? err.message.split('\n')[0] : String(err),
    });
    return { cleaned: false };
  }
}

router.post('/sweep', requireInternalToken, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma || !prisma.uploadIntent) {
    return res.status(500).json({ error: 'Prisma not available' });
  }

  const startTime = Date.now();
  let expiredFromPending = 0;
  let expiredFromConfirmed = 0;
  let blobsCleaned = 0;
  let blobsStillOrphan = 0;
  let skipped = 0;       // atomic-guard misses (row changed under us)
  let batches = 0;
  let stoppedReason = null;

  // Actions = state transitions we performed. Both the per-run cap and the
  // time budget are checked against this single counter so one pathological
  // pass cannot starve the others.
  const actions = () => expiredFromPending + expiredFromConfirmed;

  console.log('[internal-upload-sweep] sweep start', {
    perBatch: PER_BATCH,
    perRunMax: PER_RUN_MAX,
    runBudgetMs: RUN_BUDGET_MS,
    confirmedGraceMs: CONFIRMED_GRACE_MS,
  });

  /**
   * Shared bounded-batch driver for passes 1 and 2. Each pass differs only
   * in its where-clause, its atomic guard, and which counter it increments;
   * keeping one driver means a future bound change can't apply to one pass
   * and silently miss the other.
   */
  async function runExpiryPass({ name, buildWhere, guardWhere, onFlip }) {
    let sweptRows = 0;
    outer: while (true) {
      if (actions() >= PER_RUN_MAX) { stoppedReason = 'per_run_max'; break; }
      if (Date.now() - startTime >= RUN_BUDGET_MS) { stoppedReason = 'time_budget'; break; }

      batches += 1;
      const candidates = await prisma.uploadIntent.findMany({
        where: buildWhere(),
        // Oldest first: a row that has been orphaned for a week is
        // reclaimed before one orphaned for an hour, so a persistent
        // backlog drains in age order across fires instead of starving.
        orderBy: { createdAt: 'asc' },
        take: PER_BATCH,
      });

      if (candidates.length === 0) break;

      for (const intent of candidates) {
        if (actions() >= PER_RUN_MAX) { stoppedReason = 'per_run_max'; break outer; }
        if (Date.now() - startTime >= RUN_BUDGET_MS) { stoppedReason = 'time_budget'; break outer; }

        // Atomic guard FIRST, blob delete second. See "Race safety" above —
        // a concurrent DPR/Inspection bind sets bound_at, this update
        // matches 0 rows, and we leave the blob alone.
        //
        // `boundAt` is stamped at the same moment so pass 3 (EXPIRED verify)
        // doesn't re-process rows we already deleted. Without this, a 25h-
        // old seed row passes 1, gets flipped to EXPIRED, and on the SAME
        // fire pass 3 sees an EXPIRED + boundAt=null + 25h-old row and
        // deletes the (already-gone) blob twice — counting as
        // blobsCleaned=2 for what was really one sweep.
        const updated = await prisma.uploadIntent.updateMany({
          where: { id: intent.id, ...guardWhere() },
          data: { status: 'EXPIRED', boundAt: new Date() },
        });
        if (!updated || updated.count === 0) {
          skipped += 1;
          continue;
        }

        onFlip();
        sweptRows += 1;

        const result = await tryDeleteBlob(intent);
        if (result.cleaned) blobsCleaned += 1;
        else blobsStillOrphan += 1;
      }

      // Partial batch means the predicate is drained — no point re-querying.
      if (candidates.length < PER_BATCH) break;
    }
    console.log('[internal-upload-sweep] pass done', { pass: name, sweptRows, stoppedReason });
    return sweptRows;
  }

  // ── Pass 1: PENDING rows past their 20-minute upload TTL ────────────────
  await runExpiryPass({
    name: 'pending-expire',
    buildWhere: () => ({ status: 'PENDING', expiresAt: { lt: new Date() } }),
    // `{ in: ['PENDING'] }` rather than a bare equality to match the
    // multi-status guard shape used by the S3-5 sweep — a future pass that
    // needs to accept two source statuses edits one literal, not the shape.
    guardWhere: () => ({ status: { in: ['PENDING'] } }),
    onFlip: () => { expiredFromPending += 1; },
  });

  // ── Pass 2: CONFIRMED bytes that no record ever claimed ─────────────────
  // The S3-7 orphan class. `boundAt: null` is what makes this safe now that
  // the DPR/Inspection POST handlers stamp it.
  await runExpiryPass({
    name: 'confirmed-orphan',
    buildWhere: () => ({
      status: 'CONFIRMED',
      boundAt: null,
      confirmedAt: { lt: new Date(Date.now() - CONFIRMED_GRACE_MS) },
    }),
    guardWhere: () => ({ status: { in: ['CONFIRMED'] }, boundAt: null }),
    onFlip: () => { expiredFromConfirmed += 1; },
  });

  // ── Pass 3: verify EXPIRED rows really have no blob left ────────────────
  // Rows land here when an earlier pass flipped the status but the R2
  // delete failed. Re-attempt, then stamp bound_type='swept' + bound_at so
  // this pass terminates — without that marker it would re-scan and
  // re-delete the same dead rows on every 15-minute fire, forever.
  let blobsVerified = 0;
  verifyLoop: while (true) {
    if (actions() + blobsVerified >= PER_RUN_MAX) { stoppedReason = stoppedReason || 'per_run_max'; break; }
    if (Date.now() - startTime >= RUN_BUDGET_MS) { stoppedReason = stoppedReason || 'time_budget'; break; }

    batches += 1;
    const stale = await prisma.uploadIntent.findMany({
      where: {
        status: 'EXPIRED',
        boundAt: null,
        createdAt: { lt: new Date(Date.now() - EXPIRED_VERIFY_AFTER_MS) },
      },
      orderBy: { createdAt: 'asc' },
      take: PER_BATCH,
    });
    if (stale.length === 0) break;

    for (const intent of stale) {
      if (actions() + blobsVerified >= PER_RUN_MAX) { stoppedReason = stoppedReason || 'per_run_max'; break verifyLoop; }
      if (Date.now() - startTime >= RUN_BUDGET_MS) { stoppedReason = stoppedReason || 'time_budget'; break verifyLoop; }

      const result = await tryDeleteBlob(intent);
      if (!result.cleaned) {
        // Still failing. Do NOT mark it swept — an honest count means this
        // row comes back on the next fire rather than being written off.
        blobsStillOrphan += 1;
        continue;
      }
      blobsCleaned += 1;
      blobsVerified += 1;
      await prisma.uploadIntent.updateMany({
        where: { id: intent.id, status: { in: ['EXPIRED'] }, boundAt: null },
        data: { boundType: 'swept', boundAt: new Date() },
      });
    }

    if (stale.length < PER_BATCH) break;
  }

  // Remaining backlog across all three predicates. After a drained run this
  // should be 0; a sustained non-zero value means the 15-minute cadence
  // can't keep up and the bounds need raising (or R2 is failing deletes).
  let remainingEstimate = 0;
  try {
    const [pendingLeft, confirmedLeft, expiredLeft] = await Promise.all([
      prisma.uploadIntent.count({ where: { status: 'PENDING', expiresAt: { lt: new Date() } } }),
      prisma.uploadIntent.count({
        where: { status: 'CONFIRMED', boundAt: null, confirmedAt: { lt: new Date(Date.now() - CONFIRMED_GRACE_MS) } },
      }),
      prisma.uploadIntent.count({
        where: { status: 'EXPIRED', boundAt: null, createdAt: { lt: new Date(Date.now() - EXPIRED_VERIFY_AFTER_MS) } },
      }),
    ]);
    remainingEstimate = pendingLeft + confirmedLeft + expiredLeft;
  } catch (err) {
    console.warn('[internal-upload-sweep] remaining-estimate count failed', {
      message: err && err.message ? err.message.split('\n')[0] : String(err),
    });
  }

  const payload = {
    expiredFromPending,
    expiredFromConfirmed,
    blobsCleaned,
    blobsStillOrphan,
    blobsVerified,
    skipped,
    batches,
    stoppedReason,
    remainingEstimate,
    elapsedMs: Date.now() - startTime,
  };

  console.log('[internal-upload-sweep] sweep done', payload);
  res.json(payload);
}));

module.exports = router;
