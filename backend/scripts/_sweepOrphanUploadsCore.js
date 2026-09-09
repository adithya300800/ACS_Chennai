/**
 * DR-017 — Shared sweep core for the orphan-blob cleanup job.
 *
 * Both `scripts/sweepOrphanUploads.js` (cron / CLI) and
 * `src/routes/storage.js` (admin POST /api/admin/storage/orphans/sweep)
 * call this. Keeping the logic in one module ensures the script and
 * the route report identical counts and apply identical deletion
 * criteria — if they diverged, the admin dashboard would lie to ops
 * about what the nightly sweep is actually doing.
 *
 * NOT mounted in any router. The leading underscore on the filename
 * signals "library, not entrypoint" — the cron entrypoint is
 * `scripts/sweepOrphanUploads.js`.
 */
'use strict';

const { ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');

// DR-001 containment: drawing / report / COP / billing / certification /
// attachment buckets MUST NOT be eligible for generic orphan cleanup. Their
// keys are PDF / Office blobs whose `${employeeId}/${ulid}.${ext}` shape
// does NOT match the photo regex below, so a sweep against any of these
// buckets would treat every object as an orphan and delete it. Only the
// uploadIntent + blobPath defences in the upload-sweep route know which of
// these bytes are in active use; the generic object scanner does not.
//
// Matched by name pattern, NOT by env-var whitelist, because:
//   1. Some operators rename the bucket (R2_BUCKET_DPR_DOCUMENTS) — the
//      pattern must follow the role, not the default string.
//   2. Future document buckets that share the same shape (e.g. a separate
//      `cop-documents`) inherit the exclusion without a code change.
//   3. Photo / video buckets (dpr-photos, inspection-photos, training-
//      materials) do not match any pattern, so they remain sweepable.
const DOCUMENT_BUCKET_PATTERNS = [
  /document/i,
  /drawing/i,
  /report/i,
  /\bcop\b/i,
  /billing/i,
  /certification/i,
  /attachment/i,
];
function isDocumentBucket(name) {
  return typeof name === 'string' && DOCUMENT_BUCKET_PATTERNS.some((re) => re.test(name));
}

// Match R2 key back to its DB row.
//
// R2 keys for photos look like `${employeeId}/${ulid}.${ext}` (see
// blobStorage.js generateUploadSASUrl). `ext` is derived from the
// contentType whitelist (jpg/png/webp) so we can reverse-map without
// trusting the filename.
async function findRowForKey(prisma, key) {
  const m = /^([^/]+)\/([0-9A-HJKMNP-TV-Z]{26})\.(jpg|png|webp)$/i.exec(key);
  if (!m) return null;
  const ulid = m[2];
  const dpr = await prisma.dPRPhoto.findFirst({ where: { ulid }, select: { id: true } });
  if (dpr) return true;
  const insp = await prisma.inspectionPhoto.findFirst({ where: { ulid }, select: { id: true } });
  return !!insp;
}

/**
 * Run a single sweep pass.
 *
 * @param {object} args
 * @param {import('@prisma/client').PrismaClient} args.prisma  Prisma client.
 * @param {import('@aws-sdk/client-s3').S3Client} args.client R2 client.
 * @param {string[]} args.buckets                            Bucket names.
 * @param {number}   args.olderThanHours                     Age threshold in hours.
 * @param {boolean}  args.dryRun                             If true, do not delete.
 * @param {number}   [args.pageSize]                         ListObjectsV2 MaxKeys (default 1000, capped at 5000).
 * @param {function(string):void} [args.logger]              Optional line logger.
 * @param {Date}    [args.now]                               Override "now" (for tests).
 * @returns {Promise<Array<{Bucket, scanned, orphans, deleted, kept, skipped, oldestAgeHours, errors}>>}
 */
async function runSweep({
  prisma,
  client,
  buckets,
  olderThanHours,
  dryRun = false,
  pageSize = 1000,
  logger = () => {},
  now = new Date(),
}) {
  const safePageSize = Math.min(Math.max(1, Math.floor(pageSize) || 1000), 5000);
  const cutoff = new Date(now.getTime() - olderThanHours * 3600 * 1000);

  // DR-001 containment: destructive orphan cleanup is disabled until
  // ownership / history reconciliation is complete. We refuse before any
  // DB or R2 work — no list, no per-key DB lookup, no delete — because
  // every other step would risk touching bytes that turn out to be in
  // active use by a Drawing / ProjectAttachment / BillingCertification row
  // the scanner has no way to cross-reference.
  //
  // The flag is intentionally an explicit env var, not an argument: a cron
  // entrypoint cannot accidentally pass it, and a future migration that
  // completes the reconciliation can flip it on without code review.
  // Truthy values are "1" or "true" — anything else (including unset) is
  // treated as not reconciled. Dry-run also returns early so the
  // operator's pre-flight dashboard reports the same zeroed-out shape the
  // real run would, and so an over-eager --dry-run does not silently
  // allow partial progress against an unsafe bucket list.
  const reconciledRaw = process.env.DR001_RECONCILED;
  const reconciled = reconciledRaw === '1' || reconciledRaw === 'true';
  if (!reconciled) {
    console.warn('[sweep] DR-001 containment — orphan sweep blocked', {
      reason: 'DR001_RECONCILED env var not set to "1" or "true"',
      dryRun,
      bucketCount: Array.isArray(buckets) ? buckets.length : 0,
    });
    const stamp = { scanned: 0, orphans: 0, deleted: 0, kept: 0, skipped: 'DR-001 containment', visited: 0, oldestAgeHours: null, errors: [], dr001Contained: true };
    return (Array.isArray(buckets) ? buckets : []).map((Bucket) => ({ Bucket, ...stamp }));
  }

  const out = [];
  for (const Bucket of buckets) {
    // DR-001 / architectural: even with DR001_RECONCILED=1, the generic
    // object scanner MUST NOT touch drawing / report / COP / billing /
    // certification / attachment buckets. The keys inside are PDF / Office
    // blobs whose `${employeeId}/${ulid}.${ext}` shape does not match the
    // photo regex below — every object in those buckets would be treated
    // as an orphan. Only the uploadIntent + blobPath defences in
    // internal-upload-sweep.js know which bytes are in active use.
    if (isDocumentBucket(Bucket)) {
      console.warn('[sweep] DR-001 — skipping document bucket', { bucket: Bucket });
      out.push({
        Bucket,
        scanned: 0,
        orphans: 0,
        deleted: 0,
        kept: 0,
        skipped: 'document_bucket_excluded',
        visited: 0,
        oldestAgeHours: null,
        errors: [],
      });
      continue;
    }
    const summary = { Bucket, scanned: 0, orphans: 0, deleted: 0, kept: 0, skipped: 0, oldestAgeHours: null, errors: [] };
    let ContinuationToken = undefined;
    try {
      do {
        const resp = await client.send(new ListObjectsV2Command({
          Bucket,
          MaxKeys: safePageSize,
          ...(ContinuationToken ? { ContinuationToken } : {}),
        }));
        for (const obj of (resp.Contents || [])) {
          summary.scanned++;
          const lm = obj.LastModified instanceof Date ? obj.LastModified : new Date(obj.LastModified);
          const ageHours = (now.getTime() - lm.getTime()) / 3600000;
          if (summary.oldestAgeHours === null || ageHours > summary.oldestAgeHours) {
            summary.oldestAgeHours = ageHours;
          }
          if (ageHours < olderThanHours) {
            summary.skipped++; // too young — user might still confirm
            continue;
          }
          try {
            const matched = await findRowForKey(prisma, obj.Key);
            if (matched) {
              summary.kept++;
              continue;
            }
            summary.orphans++;
            if (dryRun) {
              logger(`${Bucket} WOULD-DELETE ${obj.Key} (age=${ageHours.toFixed(1)}h, size=${obj.Size})`);
              summary.deleted++;
              continue;
            }
            await client.send(new DeleteObjectCommand({ Bucket, Key: obj.Key }));
            logger(`${Bucket} deleted ${obj.Key} (age=${ageHours.toFixed(1)}h, size=${obj.Size})`);
            summary.deleted++;
          } catch (err) {
            summary.errors.push({ key: obj.Key, message: err && err.message ? err.message : String(err) });
          }
        }
        ContinuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
      } while (ContinuationToken);
    } catch (err) {
      summary.errors.push({ stage: 'list', message: err && err.message ? err.message : String(err) });
    }
    out.push(summary);
  }
  return out;
}

module.exports = { runSweep, findRowForKey };
