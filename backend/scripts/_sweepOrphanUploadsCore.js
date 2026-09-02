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

  const out = [];
  for (const Bucket of buckets) {
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
