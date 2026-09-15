/**
 * TEMPORARY admin-gated diagnostic for the Sept-13/15 DPR photo
 * BLOB_GONE investigation — replaces the first-cut /api/admin/diag/photo-head
 * route (removed in commit 222c006) which had two gaps that this version
 * closes:
 *
 *   1. **Pagination cap** — the previous version called
 *      `listObjects(container, { MaxKeys: 1000 })` and did NOT follow
 *      `NextContinuationToken`. Any bucket with >1000 keys could hide
 *      matching bytes past position 1000. This version uses
 *      `listObjects(container)` which internally paginates fully.
 *   2. **Single-bucket scan** — the previous version only scanned
 *      `dpr-photos`. This version scans ALL R2 buckets (`dpr-photos`,
 *      `dpr-documents`, `inspection-photos`, `training-materials`,
 *      `db-backups`) so we catch "uploaded to the wrong bucket"
 *      mismatches.
 *
 * Endpoint:
 *   GET /api/admin/diag/photo-reconcile
 *     Query params (all optional):
 *       dprId   — limit scan to a single DPR
 *       limit   — cap rows scanned (default 100, max 500)
 *     Returns:
 *       {
 *         bucketSizes:   { [bucket]: number, ... },     // for context
 *         scannedRows:   number,
 *         atExpectedPath: [{ photoId, dprId, key }],     // bytes fine — no action
 *         foundElsewhere: [{ photoId, dprId, ulid, expectedKey, matches: [{ bucket, key, size, lastModified }] }],
 *         trulyMissing:   [{ photoId, dprId, ulid, expectedKey }], // no byte in any bucket
 *         errors:         [{ photoId, error }]
 *       }
 *
 * Read-only. NEVER mutates state. Admin-gated (`requireFreshAdmin` —
 * DB-backed claim, not JWT). Delete after the Sept-13/15 incident
 * closes (root cause identified + reconcile shipped or ruled out).
 */
const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { requireAuth, requireFreshAdmin } = require('../middleware/auth');
const {
  verifyBlobExists,
  listObjects,
  ALLOWED_R2_BUCKETS,
  CONTENT_TYPE_EXT,
} = require('../lib/blobStorage');

router.use(requireAuth);
router.use(requireFreshAdmin);

async function listAllKeys(bucket) {
  return listObjects(bucket); // paginates fully via ContinuationToken
}

async function findUlidAcrossBuckets(ulid) {
  const matches = [];
  for (const bucket of ALLOWED_R2_BUCKETS) {
    let all;
    try {
      all = await listAllKeys(bucket);
    } catch (e) {
      // bucket may not exist (e.g. db-backups before first cron)
      continue;
    }
    for (const obj of all) {
      if (obj.Key && obj.Key.includes(ulid)) {
        matches.push({
          bucket,
          key: obj.Key,
          size: obj.Size,
          lastModified: obj.LastModified instanceof Date
            ? obj.LastModified.toISOString()
            : obj.LastModified,
        });
      }
    }
  }
  return matches;
}

router.get('/photo-reconcile', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 500);
  const dprIdFilter = req.query.dprId || undefined;

  const where = dprIdFilter ? { dprId: dprIdFilter } : {};
  const rows = await prisma.dPRPhoto.findMany({
    where,
    include: {
      dpr: { select: { id: true, submittedById: true, deletedAt: true } },
    },
    orderBy: { uploadedAt: 'desc' },
    take: limit,
  });

  const report = {
    bucketSizes: {},
    scannedRows: 0,
    atExpectedPath: [],
    foundElsewhere: [],
    trulyMissing: [],
    errors: [],
  };

  // Bucket sizes for context (the previous diagnostic skipped this
  // — when bucket is small the 1000-key cap was irrelevant; when
  // large it was a real risk)
  for (const bucket of ALLOWED_R2_BUCKETS) {
    try {
      const all = await listAllKeys(bucket);
      report.bucketSizes[bucket] = all.length;
    } catch (e) {
      report.bucketSizes[bucket] = `error: ${e.message}`;
    }
  }

  for (const row of rows) {
    report.scannedRows++;
    try {
      const submittedById = row.dpr?.submittedById;
      const ext = CONTENT_TYPE_EXT[row.contentType] || 'bin';
      const expectedKey = `${submittedById}/${row.ulid}.${ext}`;
      const expectedPath = `${row.container}/${expectedKey}`;

      const head = await verifyBlobExists(row.container, expectedKey);

      if (head.exists) {
        report.atExpectedPath.push({
          photoId: row.id,
          dprId: row.dprId,
          key: expectedPath,
          size: head.contentLength,
          contentType: head.contentType,
        });
        continue;
      }

      const matches = await findUlidAcrossBuckets(row.ulid);
      if (matches.length === 0) {
        report.trulyMissing.push({
          photoId: row.id,
          dprId: row.dprId,
          ulid: row.ulid,
          expectedKey: expectedPath,
        });
      } else {
        report.foundElsewhere.push({
          photoId: row.id,
          dprId: row.dprId,
          ulid: row.ulid,
          expectedKey: expectedPath,
          matches,
        });
      }
    } catch (e) {
      report.errors.push({ photoId: row.id, error: e.message });
    }
  }

  return res.json(report);
});

module.exports = router;
