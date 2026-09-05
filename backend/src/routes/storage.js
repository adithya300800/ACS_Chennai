/**
 * DR-017 — Admin storage health endpoint.
 *
 *   GET /api/admin/storage/orphans
 *     Admin-only read-only summary of orphan blob counts per required
 *     bucket. Cheap (HeadBucket + small per-bucket ListObjectsV2 with
 *     a strict page size) so it can be polled by a dashboard without
 *     hammering the S3 control plane.
 *
 *     Returns: {
 *       ok: bool,
 *       buckets: [
 *         { bucket, reachable, scanned, orphans, oldestAgeHours, totalBytes }
 *       ],
 *       thresholdHours: number,    // matches the sweep default (24)
 *       scannedAt: ISO string
 *     }
 *
 *     An "orphan" here is the same definition the nightly sweep uses:
 *     an R2 object shaped `${employeeId}/${ulid}.${ext}` whose ulid has
 *     no matching DPRPhoto or InspectionPhoto row. We cap the per-bucket
 *     scan to a fixed page size (1000) so a runaway bucket cannot cause
 *     the admin request to take more than a few seconds — operators
 *     looking for "how bad is it really" use the sweep script directly.
 *
 *   POST /api/admin/storage/orphans/sweep
 *     Admin-only trigger for an in-process orphan sweep (delegates to
 *     the same logic as `scripts/sweepOrphanUploads.js`). Returns the
 *     same summary shape. Intended for ops to run a one-shot cleanup
 *     without SSH'ing into the Render cron shell.
 *
 * Auth: requireAuth + requireFreshAdmin (admin claim alone is not safe
 * for storage mutations).
 */
'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requireFreshAdmin } = require('../middleware/auth');
const { getClient, REQUIRED_BUCKETS } = require('../lib/blobStorage');
const { ListObjectsV2Command, HeadBucketCommand } = require('@aws-sdk/client-s3');

const DEFAULT_THRESHOLD_HOURS = 24;
const ADMIN_SCAN_PAGE_SIZE = 1000; // bounded on purpose; full sweep is the cron job

// Match R2 key back to its DB row. Same regex as sweepOrphanUploads.js.
// Kept in sync intentionally — the admin endpoint and the cron job must
// classify a key identically or the admin will report orphans that the
// sweep would not delete (or vice versa).
async function findRowForKey(prisma, key) {
  const m = /^([^/]+)\/([0-9A-HJKMNP-TV-Z]{26})\.(jpg|png|webp)$/i.exec(key);
  if (!m) return null;
  const ulid = m[2];
  const dpr = await prisma.dPRPhoto.findFirst({ where: { ulid }, select: { id: true } });
  if (dpr) return true;
  const insp = await prisma.inspectionPhoto.findFirst({ where: { ulid }, select: { id: true } });
  return !!insp;
}

function getPrisma(req) { return req.app.get('prisma'); }

// GET /api/admin/storage/orphans
router.get('/orphans', requireAuth, requireFreshAdmin, async (req, res) => {
  const prisma = getPrisma(req);
  let client;
  try {
    client = getClient();
  } catch (err) {
    return res.status(503).json({
      ok: false,
      error: 'R2 client not configured',
      code: 'R2_NOT_CONFIGURED',
      message: err.message,
    });
  }

  const thresholdHours = DEFAULT_THRESHOLD_HOURS;
  const now = new Date();
  const buckets = [];

  for (const Bucket of REQUIRED_BUCKETS) {
    const entry = { bucket: Bucket, reachable: false };
    try {
      await client.send(new HeadBucketCommand({ Bucket }));
      entry.reachable = true;
    } catch (err) {
      entry.reachable = false;
      entry.error = err?.name || err?.Code || 'unknown';
      buckets.push(entry);
      continue;
    }

    let scanned = 0;
    let orphans = 0;
    let totalBytes = 0;
    let oldestAgeHours = null;
    let ContinuationToken = undefined;
    try {
      do {
        const resp = await client.send(new ListObjectsV2Command({
          Bucket,
          MaxKeys: ADMIN_SCAN_PAGE_SIZE,
          ...(ContinuationToken ? { ContinuationToken } : {}),
        }));
        for (const obj of (resp.Contents || [])) {
          scanned++;
          totalBytes += obj.Size || 0;
          const ageHours = (now.getTime() - (obj.LastModified instanceof Date ? obj.LastModified : new Date(obj.LastModified)).getTime()) / 3600000;
          if (oldestAgeHours === null || ageHours > oldestAgeHours) oldestAgeHours = ageHours;
          if (ageHours < thresholdHours) continue; // too young to count
          const matched = await findRowForKey(prisma, obj.Key);
          if (!matched) orphans++;
        }
        ContinuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
      } while (ContinuationToken);
    } catch (err) {
      entry.error = `list: ${err?.name || err?.Code || err?.message}`;
    }

    entry.scanned = scanned;
    entry.orphans = orphans;
    entry.totalBytes = totalBytes;
    entry.oldestAgeHours = oldestAgeHours;
    buckets.push(entry);
  }

  const anyUnreachable = buckets.some((b) => !b.reachable);
  res.status(anyUnreachable ? 207 : 200).json({
    ok: !anyUnreachable,
    buckets,
    thresholdHours,
    scannedAt: now.toISOString(),
  });
});

// POST /api/admin/storage/orphans/sweep
// Delegates to the same logic as scripts/sweepOrphanUploads.js. We
// require it lazily so the route file can still be required in tests
// that don't have DATABASE_URL set up.
router.post('/orphans/sweep', requireAuth, requireFreshAdmin, async (req, res) => {
  const prisma = getPrisma(req);
  let client;
  try {
    client = getClient();
  } catch (err) {
    return res.status(503).json({
      ok: false,
      error: 'R2 client not configured',
      code: 'R2_NOT_CONFIGURED',
    });
  }

  const { olderThanHours: rawOlder } = req.body || {};
  const olderThanHours = (typeof rawOlder === 'number' && rawOlder > 0 && rawOlder <= 168)
    ? rawOlder
    : DEFAULT_THRESHOLD_HOURS;
  const dryRun = !!(req.body && req.body.dryRun);

  let sweep;
  try {
    // DR-018: the core module ships at backend/scripts/_sweepOrphanUploadsCore.js.
    // From backend/src/routes/storage.js we have to climb out of `routes/` and
    // out of `src/` before reaching `scripts/`. The previous relative path
    // (`../scripts/_sweepOrphanUploadsCore`) resolved to
    // backend/src/scripts/_sweepOrphanUploadsCore — which does not exist —
    // so every dry-run AND every real sweep fell through to the 501
    // SWEEP_UNAVAILABLE fallback. Use `../../scripts/...` so we land on the
    // real file. The 501 catch stays as a safety net for partial deploys.
    sweep = require('../../scripts/_sweepOrphanUploadsCore');
  } catch {
    // The core module is shipped as scripts/_sweepOrphanUploadsCore.js so
    // this require stays stable even if scripts/README reorders. If the
    // file is missing (e.g. partial deploy), give the operator a clear
    // signal rather than a 500 stack trace.
    return res.status(501).json({
      ok: false,
      error: 'Orphan sweep core not available. Run scripts/sweepOrphanUploads.js from the cron shell.',
      code: 'SWEEP_UNAVAILABLE',
    });
  }

  try {
    const summaries = await sweep.runSweep({
      prisma,
      client,
      buckets: REQUIRED_BUCKETS,
      olderThanHours,
      dryRun,
      pageSize: ADMIN_SCAN_PAGE_SIZE,
      logger: (msg) => console.log(`[storage/sweep] ${msg}`),
    });
    res.json({
      ok: true,
      dryRun,
      thresholdHours: olderThanHours,
      buckets: summaries,
      scannedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[storage/sweep] failed', err && (err.stack || err.message));
    res.status(500).json({
      ok: false,
      error: 'Sweep failed',
      code: 'SWEEP_FAILED',
      message: err?.message?.split('\n')[0],
    });
  }
});

module.exports = router;
