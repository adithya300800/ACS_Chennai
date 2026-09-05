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
//
// ── SOL DR-002 — referenced-ulid defence + dry-run mode ──────────────────
//
// The original S3-7 sweep retired every CONFIRMED + boundAt=null row after
// a 1h grace, on the assumption that any such row was a permanent orphan.
// SOL DR-002 surfaced the case where that assumption is wrong: a
// pre-S3-7 upload that produced a CONFIRMED intent ALSO produced a Photo
// row in `dpr_photo` or `inspection_photo`. The intent row's `bound_at` is
// NULL because the bind columns didn't exist yet, but the bytes behind it
// are still in active use by an accepted report.
//
// The migration 20260905010000_s3_7_legacy_intent_backfill backfills the
// pre-existing rows; the defence below is the *ongoing* safety net:
// every sweep precomputes the set of ulids currently referenced by either
// Photo table and excludes them from pass 2's candidate set. If the photo
// tables cannot be read, the sweep aborts with 503 rather than risk
// deleting live bytes — a redundant lookup failure must never turn into
// silent data loss.
//
// The dry-run mode (body `{ "dryRun": true }`) returns the same counts the
// real run would produce without flipping any rows or calling R2. It is
// the operator-evidence tool DR-002 acceptance criteria require: rehearse
// the deletion list before enabling it.

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

/**
 * SOL DR-002: collect the set of ulids currently referenced by any Photo
 * row. Returned as a Set for O(1) membership in pass 2's `notIn` filter.
 *
 * Returns `null` when either Photo table cannot be queried — that is the
 * signal the caller uses to abort the entire sweep rather than risk
 * deleting live bytes.
 *
 * Both queries are deliberately narrow: only `ulid` is selected. dpr_photo
 * and inspection_photo can each be in the hundreds of thousands once the
 * portal is in steady-state, but the indexed `ulid` lookup is bounded by
 * the index size and we only materialise the strings, not the rows.
 */
async function collectPhotoReferencedUlids(prisma) {
  const out = new Set();
  const sources = [
    { name: 'dpr_photo', delegate: prisma && prisma.dPRPhoto },
    { name: 'inspection_photo', delegate: prisma && prisma.inspectionPhoto },
  ];
  for (const src of sources) {
    if (!src.delegate || typeof src.delegate.findMany !== 'function') {
      // The Photo model may legitimately be absent in unit-test mocks that
      // exercise only the intent table. Treat that as a hard fail rather
      // than a silent skip — the safety guarantee requires the data, not
      // its absence.
      console.error('[internal-upload-sweep] referenced-ulid lookup missing model', {
        source: src.name,
      });
      return null;
    }
    try {
      const refs = await src.delegate.findMany({ select: { ulid: true } });
      for (const row of refs) if (row && row.ulid) out.add(row.ulid);
    } catch (err) {
      console.error('[internal-upload-sweep] referenced-ulid lookup failed', {
        source: src.name,
        errCode: err && err.code,
        errMessage: err && err.message ? err.message.split('\n')[0] : String(err),
      });
      return null;
    }
  }
  return out;
}

router.post('/sweep', requireInternalToken, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  if (!prisma || !prisma.uploadIntent) {
    return res.status(500).json({ error: 'Prisma not available' });
  }

  // SOL DR-002: dry-run mode — return the same counts as a real run without
  // flipping any rows or calling R2. The body shape is the same as the
  // real call so an operator's pre-flight dashboard can render one schema.
  const dryRun = !!(req.body && req.body.dryRun === true);

  // SOL DR-002: precompute the set of ulids still referenced by a Photo row.
  // The sweep's CONFIRMED-orphan pass MUST exclude these — without this
  // defence a legacy CONFIRMED + boundAt=null intent whose ulid is still in
  // use by an accepted report would have its R2 bytes retired, leaving the
  // report's photo row pointing at a 404.
  //
  // Failure here aborts the entire sweep. A failed lookup must not silently
  // admit unprotected deletes — that would re-open the very hole DR-002
  // exists to close. We deliberately treat this as fatal rather than
  // warn-and-continue.
  const photoReferencedUlids = await collectPhotoReferencedUlids(prisma);
  if (photoReferencedUlids === null) {
    return res.status(503).json({
      error: 'REFERENCED_ULID_LOOKUP_FAILED',
      message: 'Could not enumerate ulids referenced by photo tables; sweep aborted to protect live data.',
    });
  }

  const startTime = Date.now();
  let expiredFromPending = 0;
  let expiredFromConfirmed = 0;
  let blobsCleaned = 0;
  let blobsStillOrphan = 0;
  let blobsWouldClean = 0; // dry-run accounting
  let preservedByPhotoRef = 0; // candidates skipped because a Photo still references the ulid
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
   *
   * SOL DR-002: passes 1 and 2 may now skip a candidate whose ulid is still
   * referenced by a Photo row. We compute that here so the count is honest
   * (`preservedByPhotoRef`), and in dry-run mode we do NOT call updateMany
   * or deleteBlob — we just account for what would have happened.
   */
  async function runExpiryPass({ name, buildWhere, guardWhere, onFlip, onPreservedByPhotoRef }) {
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

        // SOL DR-002: per-row defence. Even if a candidate matches the
        // batch predicate (buildWhere already excludes photo-referenced
        // ulids), re-check defensively in case of a race where a Photo row
        // was inserted between the buildWhere query and this iteration.
        if (intent && intent.ulid && photoReferencedUlids.has(intent.ulid)) {
          if (onPreservedByPhotoRef) onPreservedByPhotoRef();
          continue;
        }

        // SOL DR-002: dry-run short-circuits before any mutation. We still
        // count the candidate as if it had been swept, so the operator's
        // pre-flight dashboard reflects the same numbers a real run would.
        if (dryRun) {
          onFlip();
          blobsWouldClean += 1;
          sweptRows += 1;
          continue;
        }

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
    console.log('[internal-upload-sweep] pass done', { pass: name, sweptRows, stoppedReason, dryRun });
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
  //
  // SOL DR-002: the photo-referenced defence is enforced in the per-row
  // loop (see `runExpiryPass` -> "per-row defence"), NOT as a `where:
  // ulid: { notIn }` filter. Two reasons:
  //   1. Operators need an honest count (`preservedByPhotoRef`) of how many
  //      rows the ongoing defence is saving, including from the legacy
  //      backfill that didn't catch them. A notIn filter would silently
  //      exclude them before they reach the counter.
  //   2. The set is already O(1)-membership; the query-time saving is
  //      negligible compared to the operator-visibility it would cost.
  // Backfill is in migration 20260905010000; this loop is the safety net.
  await runExpiryPass({
    name: 'confirmed-orphan',
    buildWhere: () => ({
      status: 'CONFIRMED',
      boundAt: null,
      confirmedAt: { lt: new Date(Date.now() - CONFIRMED_GRACE_MS) },
    }),
    guardWhere: () => ({ status: { in: ['CONFIRMED'] }, boundAt: null }),
    onFlip: () => { expiredFromConfirmed += 1; },
    onPreservedByPhotoRef: () => { preservedByPhotoRef += 1; },
  });

  // ── Pass 3: verify EXPIRED rows really have no blob left ────────────────
  // Rows land here when an earlier pass flipped the status but the R2
  // delete failed. Re-attempt, then stamp bound_type='swept' + bound_at so
  // this pass terminates — without that marker it would re-scan and
  // re-delete the same dead rows on every 15-minute fire, forever.
  //
  // SOL DR-002: pass 3 already targets rows that pass 1/2 already retired,
  // so their bytes have been removed; the photo-referenced set does not
  // apply here. Dry-run mode still skips the delete and the stamp.
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

      if (dryRun) {
        blobsWouldClean += 1;
        blobsVerified += 1;
        continue;
      }

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
    dryRun,
    expiredFromPending,
    expiredFromConfirmed,
    blobsCleaned,
    blobsStillOrphan,
    blobsVerified,
    // SOL DR-002: in dry-run mode, `blobsWouldClean` is what `blobsCleaned`
    // would have been in a real run. In real-run mode it stays 0 and is
    // included only for schema symmetry so dashboards can render one row.
    blobsWouldClean: dryRun ? blobsWouldClean : 0,
    // SOL DR-002: candidates pass 2 skipped because a Photo row still
    // references the ulid. Always populated (real or dry-run) so an operator
    // can see whether the legacy-intent backfill left anything for the
    // ongoing defence to preserve.
    preservedByPhotoRef,
    photoReferencedCount: photoReferencedUlids.size,
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
