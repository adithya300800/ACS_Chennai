#!/usr/bin/env node
/**
 * DR-017 — Nightly orphan-blob sweeper.
 *
 * CLI entrypoint. The actual work lives in scripts/_sweepOrphanUploadsCore.js
 * so the same logic can be triggered from the admin POST /api/admin/storage/
 * orphans/sweep route without duplicating the delete criteria.
 *
 * Walks every required R2 bucket, lists every object, then compares
 * against the `DPRPhoto` and `InspectionPhoto` tables. Any object older
 * than 24 hours whose `${employeeId}/${ulid}.${ext}` key has no matching
 * DB row is DELETED — these are uploads the user started (presigned PUT
 * was issued) but never confirmed, or whose DPR/Inspection record was
 * deleted out from under the blob.
 *
 * Without this sweep, R2 accumulates dead bytes forever and the bill
 * creeps up silently. The previous `deleteBlob()` helper had no caller.
 *
 * Why 24 hours: presigned PUT URLs are valid for 15 minutes and the
 * confirm-upload path runs server-side blob verification (round-13). 24
 * hours is the safe floor — a user who closed the tab at upload time
 * gets a full day to come back, retry, and confirm before the bytes are
 * reclaimed.
 *
 * Usage:
 *   node scripts/sweepOrphanUploads.js                  # sweep every bucket, 24h threshold
 *   node scripts/sweepOrphanUploads.js --dry-run        # report only, no deletes
 *   node scripts/sweepOrphanUploads.js --older-than-hours 6
 *   node scripts/sweepOrphanUploads.js --bucket dpr-photos
 *
 * Exit codes:
 *   0  — sweep completed (with or without deletions)
 *   1  — fatal error (R2 unreachable, DB unreachable, etc.)
 *   2  — bad CLI args / missing env
 */
'use strict';

const { PrismaClient } = require('@prisma/client');
const { getClient, REQUIRED_BUCKETS } = require('../src/lib/blobStorage');
const { runSweep } = require('./_sweepOrphanUploadsCore');

function parseArgs(argv) {
  const args = {
    buckets: [],
    olderThanHours: 24,
    dryRun: false,
    pageSize: 1000,
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--bucket') {
      const v = argv[++i];
      if (!v) throw new Error('--bucket requires a value');
      args.buckets.push(v);
    } else if (tok === '--older-than-hours') {
      const v = argv[++i];
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new Error('--older-than-hours requires a positive number');
      args.olderThanHours = n;
    } else if (tok === '--dry-run') {
      args.dryRun = true;
    } else if (tok === '--page-size') {
      const v = argv[++i];
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new Error('--page-size requires a positive number');
      args.pageSize = Math.min(n, 5000);
    } else if (tok === '--help' || tok === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${tok}`);
    }
  }
  return args;
}

function help() {
  return [
    'Usage: node scripts/sweepOrphanUploads.js [options]',
    '',
    'Deletes R2 objects whose key has no matching DPRPhoto or InspectionPhoto row,',
    'older than --older-than-hours. Idempotent. Safe to re-run.',
    '',
    'Options:',
    '  --bucket <name>           Specific bucket to sweep. Repeatable. Default: every REQUIRED_BUCKET.',
    '  --older-than-hours <n>    Age threshold (default 24).',
    '  --dry-run                 Print plan + report without deleting.',
    '  --page-size <n>           ListObjectsV2 MaxKeys (default 1000, max 5000).',
    '  --help, -h                Print this message.',
    '',
  ].join('\n');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${e.message}`);
    console.error(help());
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(help());
    process.exit(0);
  }

  const buckets = args.buckets.length > 0 ? args.buckets : REQUIRED_BUCKETS;
  if (buckets.length === 0) {
    console.error('error: no buckets to sweep (pass --bucket or set R2_BUCKET_* env vars).');
    process.exit(2);
  }

  const prisma = new PrismaClient();
  let client;
  try {
    client = getClient();
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(2);
  }

  const now = new Date();
  console.log(`[sweep] start ${args.dryRun ? 'DRY RUN ' : ''}buckets=${buckets.length} olderThanHours=${args.olderThanHours}`);

  let summaries;
  try {
    summaries = await runSweep({
      prisma,
      client,
      buckets,
      olderThanHours: args.olderThanHours,
      dryRun: args.dryRun,
      pageSize: args.pageSize,
      now,
      logger: (msg) => console.log(`[sweep] ${msg}`),
    });
  } catch (err) {
    console.error(`[sweep] fatal: ${err && (err.stack || err.message || err)}`);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  }

  await prisma.$disconnect().catch(() => {});

  const fatal = summaries.some((s) => s.errors && s.errors.some((e) => e.stage === 'list'));
  if (fatal) {
    console.error(`[sweep] one or more buckets failed.`);
    process.exit(1);
  }
  for (const s of summaries) {
    console.log(`[sweep] ${s.Bucket}: scanned=${s.scanned} orphans=${s.orphans} deleted=${s.deleted} kept=${s.kept} skipped=${s.skipped} oldest=${s.oldestAgeHours !== null ? s.oldestAgeHours.toFixed(1) + 'h' : '-'}`);
  }
  const totalDeleted = summaries.reduce((a, s) => a + (s.deleted || 0), 0);
  console.log(`[sweep] done. totalDeleted=${totalDeleted} across ${summaries.length} bucket(s).`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[sweep] uncaught:', err && (err.stack || err.message || err));
  process.exit(1);
});
