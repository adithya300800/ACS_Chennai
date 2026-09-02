#!/usr/bin/env node
/**
 * DR-017 — IaC script for R2 bucket provisioning + CORS policy application.
 *
 * Canonical replacement for the per-boot `applyR2Cors()` call in
 * src/lib/blobStorage.js. Run ONCE at deploy time (or whenever the bucket
 * set or CORS allowlist changes), NOT on every server boot.
 *
 * Why this exists:
 *   - The previous boot-time applyR2Cors() needed `s3:CreateBucket` and
 *     `s3:PutBucketCors` on the runtime IAM key. Moving the call to a
 *     one-shot script lets us narrow the runtime key to just
 *     `s3:PutObject` / `s3:GetObject` / `s3:DeleteObject` (least
 *     privilege, AppSec principle).
 *   - Boot-time control-plane calls can race / time out / 503 — running
 *     them out-of-band means `/ready` no longer reports healthy before
 *     the bucket policy is in place (a long-standing DR-017 finding).
 *   - Idempotent and safe to re-run; treat the script as a Terraform-
 *     style plan: it either succeeds per bucket or reports what went
 *     wrong so the operator can act.
 *
 * Usage:
 *   node scripts/provisionR2.js --bucket dpr-photos
 *   node scripts/provisionR2.js --bucket inspection-photos
 *   node scripts/provisionR2.js --bucket training-materials
 *   # Omit --bucket to provision every bucket in ALLOWED_R2_BUCKETS + REQUIRED_BUCKETS.
 *
 *   --origin <url>      (repeatable) add an extra AllowedOrigin (default: https://acschennai.com)
 *   --dry-run           print the planned actions without calling R2
 *   --no-create         skip CreateBucket (CORS-only mode)
 *
 * Required env:
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 *
 * Exit codes:
 *   0  — every requested bucket reached the desired state
 *   1  — at least one bucket failed (printed per-bucket failure)
 *   2  — bad CLI arguments / missing env
 */
'use strict';

const {
  S3Client,
  CreateBucketCommand,
  PutBucketCorsCommand,
  HeadBucketCommand,
} = require('@aws-sdk/client-s3');

function parseArgs(argv) {
  const args = {
    buckets: [],
    origins: [],
    dryRun: false,
    create: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--bucket') {
      const v = argv[++i];
      if (!v) throw new Error('--bucket requires a value');
      args.buckets.push(v);
    } else if (tok === '--origin') {
      const v = argv[++i];
      if (!v) throw new Error('--origin requires a value');
      args.origins.push(v);
    } else if (tok === '--dry-run') {
      args.dryRun = true;
    } else if (tok === '--no-create') {
      args.create = false;
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
    'Usage: node scripts/provisionR2.js [--bucket <name>...] [--origin <url>...] [--dry-run] [--no-create]',
    '',
    'Provisions R2 buckets (creates if missing) and applies the CORS policy',
    'so browser preflights to the presigned PUT URL succeed. Idempotent.',
    '',
    'Options:',
    '  --bucket <name>     Specific bucket to provision. Repeatable. Default: all ALLOWED + REQUIRED buckets.',
    '  --origin <url>      AllowedOrigin to add (repeatable). Default: https://acschennai.com',
    '  --dry-run           Print the plan without calling R2.',
    '  --no-create         Skip CreateBucket (CORS-only mode).',
    '  --help, -h          Print this message.',
    '',
  ].join('\n');
}

function buildClient() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'Missing R2 env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY are all required.'
    );
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

function defaultBuckets() {
  // Match the canonical bucket set used by the runtime. Import lazily so
  // the script can also be run with `--bucket <custom>` without pulling in
  // the blob-storage module (which validates JWT_SECRET at load time in
  // unrelated ways via middleware).
  try {
    const { ALLOWED_R2_BUCKETS, REQUIRED_BUCKETS } = require('../src/lib/blobStorage');
    // Union — provision every bucket the runtime might write to OR readiness
    // expects. De-dup.
    return [...new Set([...(ALLOWED_R2_BUCKETS || []), ...(REQUIRED_BUCKETS || [])])];
  } catch {
    // Fall back to env-driven defaults if the module refuses to load
    // (e.g. a CI sandbox without a JWT_SECRET).
    return [
      process.env.R2_BUCKET_DPR_PHOTOS || 'dpr-photos',
      process.env.R2_BUCKET_DPR_DOCUMENTS || 'dpr-documents',
      process.env.R2_BUCKET_INSPECTION_PHOTOS || 'inspection-photos',
      process.env.R2_BUCKET_TRAINING_MATERIALS || 'training-materials',
    ].filter(Boolean);
  }
}

function defaultOrigins() {
  const fromEnv = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
    : [];
  // Safe production default — mirrors the previous boot-time policy.
  return fromEnv.length > 0 ? fromEnv : ['https://acschennai.com'];
}

async function ensureBucket(client, Bucket, { create, dryRun }) {
  if (dryRun) {
    return { Bucket, action: create ? 'create+cors' : 'cors', dryRun: true };
  }
  if (create) {
    try {
      await client.send(new CreateBucketCommand({ Bucket }));
    } catch (err) {
      const code = err?.$metadata?.httpStatusCode;
      const name = err?.name || err?.Code || '';
      if (name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists' || code === 409) {
        // Already there — exactly what we wanted.
      } else {
        return { Bucket, ok: false, stage: 'create', error: `${code || name || err.message}` };
      }
    }
  } else {
    // CORS-only path: confirm the bucket exists first so a typo doesn't
    // silently create a new (empty) bucket.
    try {
      await client.send(new HeadBucketCommand({ Bucket }));
    } catch (err) {
      const code = err?.$metadata?.httpStatusCode;
      const name = err?.name || err?.Code || '';
      return { Bucket, ok: false, stage: 'head', error: `bucket not reachable: ${code || name || err.message}` };
    }
  }
  return { Bucket, ok: true, stage: create ? 'created' : 'existing' };
}

async function applyCors(client, Bucket, AllowedOrigins, { dryRun }) {
  const rules = [{
    AllowedOrigins,
    AllowedMethods: ['PUT', 'GET', 'HEAD'],
    AllowedHeaders: ['*'],
    ExposeHeaders: ['ETag'],
    MaxAgeSeconds: 300,
  }];
  if (dryRun) {
    return { Bucket, ok: true, dryRun: true, rules };
  }
  try {
    await client.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration: { CORSRules: rules } }));
    return { Bucket, ok: true };
  } catch (err) {
    const code = err?.$metadata?.httpStatusCode;
    const name = err?.name || err?.Code || '';
    return { Bucket, ok: false, stage: 'cors', error: `${code || name || err.message}` };
  }
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

  const buckets = args.buckets.length > 0 ? args.buckets : defaultBuckets();
  const origins = args.origins.length > 0 ? args.origins : defaultOrigins();

  if (buckets.length === 0) {
    console.error('error: no buckets to provision (pass --bucket or set R2_BUCKET_* env vars).');
    process.exit(2);
  }

  let client = null;
  if (!args.dryRun) {
    try {
      client = buildClient();
    } catch (e) {
      console.error(`error: ${e.message}`);
      process.exit(2);
    }
  }

  console.log(`[provisionR2] ${args.dryRun ? 'DRY RUN ' : ''}buckets=${buckets.length} origins=${JSON.stringify(origins)}`);
  const results = [];
  for (const Bucket of buckets) {
    const ensured = await ensureBucket(client, Bucket, { create: args.create, dryRun: args.dryRun });
    if (ensured.ok === false) {
      results.push(ensured);
      console.error(`[provisionR2] FAIL ${Bucket}: ${ensured.error}`);
      continue;
    }
    const cors = await applyCors(client, Bucket, origins, { dryRun: args.dryRun });
    results.push({ ...ensured, cors });
    if (cors.ok) {
      console.log(`[provisionR2] OK   ${Bucket} (${ensured.stage} → cors applied)`);
    } else {
      console.error(`[provisionR2] FAIL ${Bucket}: ${cors.error}`);
    }
  }

  const failed = results.filter((r) => r.ok === false || r.cors?.ok === false);
  if (failed.length > 0) {
    console.error(`[provisionR2] ${failed.length}/${results.length} bucket(s) failed.`);
    process.exit(1);
  }
  console.log(`[provisionR2] done. ${results.length}/${results.length} bucket(s) provisioned.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[provisionR2] uncaught:', err && (err.stack || err.message || err));
  process.exit(1);
});
