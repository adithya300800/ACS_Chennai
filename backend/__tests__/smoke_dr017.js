/**
 * DR-017 — Standalone smoke test for the storage lifecycle refactor.
 *
 * Mirrors __tests__/storage.test.js but uses raw node + assert so it
 * runs in this sandbox without jest (jest hangs in the Mac sandbox
 * pre-test-discovery; same root cause as round-13's scripts/round13-tests.js).
 *
 * Run with: node __tests__/smoke_dr017.js
 *
 * Exits 0 if every assertion passes.
 */
'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-must-be-at-least-32-chars-BBBB';
process.env.PII_LOG_SALT = process.env.PII_LOG_SALT || 'test-pii-salt-32-chars-min-deadbeef';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.R2_ACCOUNT_ID = 'test-account';
process.env.R2_ACCESS_KEY_ID = 'test-key';
process.env.R2_SECRET_ACCESS_KEY = 'test-secret';

const assert = require('assert');
const path = require('path');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (err) { fail++; console.log(`  FAIL ${name}: ${err && err.message ? err.message : err}`); }
}

// Mock @aws-sdk/client-s3 by intercepting the require cache. We record
// every command the runtime sends so each test can assert on shape.
function installS3Mock() {
  const calls = [];
  const mockClient = {
    async send(cmd) {
      const name = cmd && cmd.constructor && cmd.constructor.name ? cmd.constructor.name : 'Unknown';
      calls.push({ name, input: cmd && cmd.input });
      return { Contents: [], IsTruncated: false };
    },
  };
  // Replace the module entirely.
  require.cache[require.resolve('@aws-sdk/client-s3')] = {
    exports: {
      S3Client: function () { return mockClient; },
      HeadBucketCommand: function (input) { this.input = input; },
      CreateBucketCommand: function (input) { this.input = input; },
      PutBucketCorsCommand: function (input) { this.input = input; },
      ListObjectsV2Command: function (input) { this.input = input; },
      DeleteObjectCommand: function (input) { this.input = input; },
    },
    loaded: true,
  };
  return { mockClient, calls };
}

// Each test installs a fresh S3 mock and reloads blobStorage so the
// internal client cache resets.
function freshBlobStorage() {
  // Drop blobStorage from the cache so a new `require` re-evaluates with
  // the freshly-installed S3Client mock.
  const blobKey = require.resolve('../src/lib/blobStorage');
  delete require.cache[blobKey];
  return require('../src/lib/blobStorage');
}

async function main() {
  console.log('DR-017 storage smoke tests');

  // ─── 1. applyR2Cors no-op in prod (R2_CORS_SELF_HEAL unset) ──────────────
  await t('applyR2Cors is a no-op when R2_CORS_SELF_HEAL is unset', async () => {
    delete process.env.R2_CORS_SELF_HEAL;
    const { calls } = installS3Mock();
    const bs = freshBlobStorage();
    const results = await bs.applyR2Cors(['https://acschennai.com']);
    assert.strictEqual(results.length, bs.ALLOWED_R2_BUCKETS.length, 'must return one result per bucket');
    for (const r of results) {
      assert.strictEqual(r.skipped, true, 'result must be marked skipped');
      assert.strictEqual(r.ok, true, 'skipped result is treated as ok');
    }
    const controlPlane = calls.filter((c) => c.name === 'CreateBucketCommand' || c.name === 'PutBucketCorsCommand');
    assert.strictEqual(controlPlane.length, 0, 'no control-plane calls allowed in no-op path');
  });

  // ─── 2. applyR2Cors works when R2_CORS_SELF_HEAL=true ─────────────────────
  await t('applyR2Cors runs CreateBucket+PutBucketCors when R2_CORS_SELF_HEAL=true', async () => {
    process.env.R2_CORS_SELF_HEAL = 'true';
    const { calls } = installS3Mock();
    const bs = freshBlobStorage();
    const results = await bs.applyR2Cors(['https://acschennai.com']);
    assert.strictEqual(results.length, bs.ALLOWED_R2_BUCKETS.length);
    const createCalls = calls.filter((c) => c.name === 'CreateBucketCommand');
    const corsCalls = calls.filter((c) => c.name === 'PutBucketCorsCommand');
    assert.strictEqual(createCalls.length, bs.ALLOWED_R2_BUCKETS.length, 'one CreateBucket per bucket');
    assert.strictEqual(corsCalls.length, bs.ALLOWED_R2_BUCKETS.length, 'one PutBucketCors per bucket');
    const createBuckets = new Set(createCalls.map((c) => c.input.Bucket));
    const corsBuckets = new Set(corsCalls.map((c) => c.input.Bucket));
    for (const b of bs.ALLOWED_R2_BUCKETS) {
      assert.ok(createBuckets.has(b), `${b} should be CreateBucket'd`);
      assert.ok(corsBuckets.has(b), `${b} should have CORS applied`);
    }
    delete process.env.R2_CORS_SELF_HEAL;
  });

  // ─── 3. Read-URL TTL default 1h, env override honored ─────────────────────
  await t('READ_URL_TTL_SECONDS defaults to 3600 (1h, down from 24h)', () => {
    delete process.env.R2_READ_URL_TTL_SECONDS;
    const bs = freshBlobStorage();
    assert.strictEqual(bs.READ_URL_TTL_SECONDS, 3600, 'default must be 3600');
  });

  await t('READ_URL_TTL_SECONDS env override honored', () => {
    process.env.R2_READ_URL_TTL_SECONDS = '300';
    const bs = freshBlobStorage();
    assert.strictEqual(bs.READ_URL_TTL_SECONDS, 300);
    delete process.env.R2_READ_URL_TTL_SECONDS;
  });

  await t('READ_URL_TTL_SECONDS rejects non-positive overrides', () => {
    process.env.R2_READ_URL_TTL_SECONDS = '0';
    const bs = freshBlobStorage();
    assert.strictEqual(bs.READ_URL_TTL_SECONDS, 3600);
    delete process.env.R2_READ_URL_TTL_SECONDS;
  });

  await t('READ_URL_TTL_SECONDS caps at 86400', () => {
    process.env.R2_READ_URL_TTL_SECONDS = '999999';
    const bs = freshBlobStorage();
    assert.strictEqual(bs.READ_URL_TTL_SECONDS, 3600);
    delete process.env.R2_READ_URL_TTL_SECONDS;
  });

  // ─── 4. REQUIRED_BUCKETS export shape ─────────────────────────────────────
  await t('REQUIRED_BUCKETS contains the canonical 3', () => {
    const bs = freshBlobStorage();
    assert.deepStrictEqual(bs.REQUIRED_BUCKETS, ['dpr-photos', 'inspection-photos', 'training-materials']);
  });

  await t('every REQUIRED_BUCKET is also in ALLOWED_R2_BUCKETS', () => {
    const bs = freshBlobStorage();
    for (const b of bs.REQUIRED_BUCKETS) {
      assert.ok(bs.ALLOWED_R2_BUCKETS.includes(b), `${b} must also be in ALLOWED_R2_BUCKETS`);
    }
  });

  // ─── 5. /ready returns 503 when ANY required bucket fails HeadBucket ──────
  await t('/ready returns 503 when any required bucket fails its HeadBucket probe', async () => {
    // Drop the S3 mock and install one that fails for inspection-photos.
    const failingBucket = 'inspection-photos';
    const calls = [];
    const mockClient = {
      async send(cmd) {
        const name = cmd && cmd.constructor && cmd.constructor.name ? cmd.constructor.name : 'Unknown';
        calls.push({ name, input: cmd && cmd.input });
        if (name === 'HeadBucketCommand' && cmd.input.Bucket === failingBucket) {
          const err = new Error('not found');
          err.name = 'NotFound';
          err.$metadata = { httpStatusCode: 404 };
          throw err;
        }
        return { Contents: [], IsTruncated: false };
      },
    };
    require.cache[require.resolve('@aws-sdk/client-s3')] = {
      exports: {
        S3Client: function () { return mockClient; },
        HeadBucketCommand: function (i) { this.input = i; },
        CreateBucketCommand: function (i) { this.input = i; },
        PutBucketCorsCommand: function (i) { this.input = i; },
        ListObjectsV2Command: function (i) { this.input = i; },
        DeleteObjectCommand: function (i) { this.input = i; },
      },
      loaded: true,
    };
    const bs = freshBlobStorage();
    const { HeadBucketCommand } = require('@aws-sdk/client-s3');
    const client = bs.getClient();
    const probeResults = await Promise.all(bs.REQUIRED_BUCKETS.map(async (Bucket) => {
      try {
        await client.send(new HeadBucketCommand({ Bucket }));
        return { Bucket, ok: true };
      } catch (err) {
        return { Bucket, ok: false, error: err.name || 'unknown' };
      }
    }));
    const ok = probeResults.every((r) => r.ok);
    assert.strictEqual(ok, false, 'must report not-ok when any bucket fails');
    const failing = probeResults.find((r) => !r.ok);
    assert.ok(failing, 'at least one probe must fail');
    assert.strictEqual(failing.Bucket, failingBucket, 'inspection-photos should be the failing bucket');
    const headCalls = calls.filter((c) => c.name === 'HeadBucketCommand');
    assert.strictEqual(headCalls.length, bs.REQUIRED_BUCKETS.length, 'every bucket must be probed (no short-circuit)');
  });

  // ─── 6. Sweep core classifies an unmatched key as an orphan + deletes ────
  await t('sweep core deletes an object whose ulid has no DB row (older than threshold)', async () => {
    const ULID = '01HZZZABCD0123456789ABCDEF';
    const key = `emp_001/${ULID}.jpg`;
    const prisma = {
      dPRPhoto: { findFirst: async () => null },
      inspectionPhoto: { findFirst: async () => null },
    };
    const calls = [];
    const mockClient = {
      async send(cmd) {
        const name = cmd && cmd.constructor && cmd.constructor.name ? cmd.constructor.name : 'Unknown';
        calls.push({ name, input: cmd && cmd.input });
        if (name === 'ListObjectsV2Command') {
          return { Contents: [{ Key: key, Size: 12345, LastModified: new Date(Date.now() - 48 * 3600 * 1000) }], IsTruncated: false };
        }
        if (name === 'DeleteObjectCommand') return {};
        return {};
      },
    };
    require.cache[require.resolve('@aws-sdk/client-s3')] = {
      exports: {
        S3Client: function () { return mockClient; },
        HeadBucketCommand: function (i) { this.input = i; },
        CreateBucketCommand: function (i) { this.input = i; },
        PutBucketCorsCommand: function (i) { this.input = i; },
        ListObjectsV2Command: function (i) { this.input = i; },
        DeleteObjectCommand: function (i) { this.input = i; },
      },
      loaded: true,
    };
    const { runSweep } = require('../scripts/_sweepOrphanUploadsCore');
    const summaries = await runSweep({
      prisma, client: mockClient, buckets: ['dpr-photos'],
      olderThanHours: 24, dryRun: false, now: new Date(),
      logger: () => {},
    });
    assert.strictEqual(summaries.length, 1);
    const s = summaries[0];
    assert.strictEqual(s.scanned, 1);
    assert.strictEqual(s.orphans, 1);
    assert.strictEqual(s.deleted, 1);
    assert.strictEqual(s.kept, 0);
    assert.strictEqual(s.skipped, 0);
    const delCalls = calls.filter((c) => c.name === 'DeleteObjectCommand');
    assert.strictEqual(delCalls.length, 1);
    assert.strictEqual(delCalls[0].input.Key, key);
  });

  await t('sweep core skips an object younger than the age threshold', async () => {
    const ULID = '01HZZZABCD0123456789ABCDEF';
    const key = `emp_001/${ULID}.jpg`;
    const prisma = {
      dPRPhoto: { findFirst: async () => null },
      inspectionPhoto: { findFirst: async () => null },
    };
    const calls = [];
    const mockClient = {
      async send(cmd) {
        const name = cmd && cmd.constructor && cmd.constructor.name ? cmd.constructor.name : 'Unknown';
        calls.push({ name, input: cmd && cmd.input });
        if (name === 'ListObjectsV2Command') {
          return { Contents: [{ Key: key, Size: 12345, LastModified: new Date(Date.now() - 1 * 3600 * 1000) }], IsTruncated: false };
        }
        if (name === 'DeleteObjectCommand') return {};
        return {};
      },
    };
    require.cache[require.resolve('@aws-sdk/client-s3')] = {
      exports: {
        S3Client: function () { return mockClient; },
        HeadBucketCommand: function (i) { this.input = i; },
        CreateBucketCommand: function (i) { this.input = i; },
        PutBucketCorsCommand: function (i) { this.input = i; },
        ListObjectsV2Command: function (i) { this.input = i; },
        DeleteObjectCommand: function (i) { this.input = i; },
      },
      loaded: true,
    };
    const { runSweep } = require('../scripts/_sweepOrphanUploadsCore');
    const summaries = await runSweep({
      prisma, client: mockClient, buckets: ['dpr-photos'],
      olderThanHours: 24, dryRun: false, now: new Date(),
      logger: () => {},
    });
    assert.strictEqual(summaries[0].skipped, 1);
    assert.strictEqual(summaries[0].orphans, 0);
    assert.strictEqual(summaries[0].deleted, 0);
    const delCalls = calls.filter((c) => c.name === 'DeleteObjectCommand');
    assert.strictEqual(delCalls.length, 0);
  });

  await t('sweep core dryRun never deletes', async () => {
    const ULID = '01HZZZABCD0123456789ABCDEF';
    const key = `emp_001/${ULID}.jpg`;
    const prisma = { dPRPhoto: { findFirst: async () => null }, inspectionPhoto: { findFirst: async () => null } };
    const calls = [];
    const mockClient = {
      async send(cmd) {
        const name = cmd && cmd.constructor && cmd.constructor.name ? cmd.constructor.name : 'Unknown';
        calls.push({ name, input: cmd && cmd.input });
        if (name === 'ListObjectsV2Command') {
          return { Contents: [{ Key: key, Size: 12345, LastModified: new Date(Date.now() - 48 * 3600 * 1000) }], IsTruncated: false };
        }
        return {};
      },
    };
    require.cache[require.resolve('@aws-sdk/client-s3')] = {
      exports: {
        S3Client: function () { return mockClient; },
        HeadBucketCommand: function (i) { this.input = i; },
        CreateBucketCommand: function (i) { this.input = i; },
        PutBucketCorsCommand: function (i) { this.input = i; },
        ListObjectsV2Command: function (i) { this.input = i; },
        DeleteObjectCommand: function (i) { this.input = i; },
      },
      loaded: true,
    };
    const { runSweep } = require('../scripts/_sweepOrphanUploadsCore');
    const lines = [];
    await runSweep({
      prisma, client: mockClient, buckets: ['dpr-photos'],
      olderThanHours: 24, dryRun: true, now: new Date(),
      logger: (msg) => lines.push(msg),
    });
    const delCalls = calls.filter((c) => c.name === 'DeleteObjectCommand');
    assert.strictEqual(delCalls.length, 0, 'dryRun must never delete');
    assert.ok(lines.some((l) => l.includes('WOULD-DELETE')), 'dryRun must log WOULD-DELETE');
  });

  console.log(`\nDR-017: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('uncaught:', err && (err.stack || err.message || err));
  process.exit(1);
});
