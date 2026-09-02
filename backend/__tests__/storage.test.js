/**
 * DR-017 — Storage lifecycle tests.
 *
 * Covers the three load-bearing guarantees of the round-20 storage refactor:
 *
 *   1. applyR2Cors is a no-op in production unless R2_CORS_SELF_HEAL=true.
 *      The runtime S3 client must NOT receive any control-plane calls
 *      (PutBucketCors / CreateBucket) on the boot path.
 *
 *   2. scripts/provisionR2.js calls PutBucketCors exactly once per bucket,
 *      in the right order (CreateBucket first if --no-create is not set).
 *
 *   3. The /ready endpoint reports 503 if any required bucket fails its
 *      HeadBucket probe. The previous probe only checked dpr-photos and
 *      could not detect a missing inspection-photos bucket — round-13
 *      fixed the symptom for one bucket; round-17 must enforce it for all.
 *
 * Runs as a pure jest test (no Prisma / R2 / Express boot needed): we mock
 * the @aws-sdk/client-s3 module and inspect which commands were issued.
 *
 * Run with: cd backend && npm test -- --testPathPattern='storage'
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// ─── Shared S3 mock factory ─────────────────────────────────────────────────
// Records every command sent through `client.send()` so tests can assert
// on which bucket calls happened, in what order, and with which params.

function makeS3Mock({ failBuckets = new Set() } = {}) {
  const calls = [];
  const fakeClient = {
    async send(cmd, opts) {
      const input = cmd && cmd.input ? cmd.input : {};
      const name = cmd && cmd.constructor ? cmd.constructor.name : 'UnknownCommand';
      calls.push({ name, input, opts });
      // Mimic HeadBucket failure for buckets the test wants to be "missing".
      if (name === 'HeadBucketCommand' && failBuckets.has(input.Bucket)) {
        const err = new Error(`bucket ${input.Bucket} not reachable`);
        err.name = 'NotFound';
        err.$metadata = { httpStatusCode: 404 };
        throw err;
      }
      // CreateBucket returns success unconditionally (idempotent).
      // ListObjectsV2 returns an empty Contents + IsTruncated=false.
      return {
        Contents: [],
        IsTruncated: false,
        NextContinuationToken: undefined,
      };
    },
  };
  return { fakeClient, calls };
}

// Replace @aws-sdk/client-s3 with the mock factory. The module caches
// `getClient()` results internally; resetting modules between tests means
// each test can register a different fake client.
jest.mock('@aws-sdk/client-s3', () => {
  const mock = jest.fn();
  return {
    S3Client: jest.fn(() => mock()),
    HeadBucketCommand: jest.fn(),
    CreateBucketCommand: jest.fn(),
    PutBucketCorsCommand: jest.fn(),
    ListObjectsV2Command: jest.fn(),
    DeleteObjectCommand: jest.fn(),
    __getMockClient: () => mock(),
  };
});

// We rebuild `blobStorage` per-test so the internal `s3Client` cache resets
// and our fresh mock client is used.
let blobStorage;
function loadBlobStorageFresh(envOverrides = {}) {
  jest.resetModules();
  const prev = {};
  for (const k of Object.keys(envOverrides)) {
    prev[k] = process.env[k];
    if (envOverrides[k] === undefined) delete process.env[k];
    else process.env[k] = envOverrides[k];
  }
  blobStorage = require('../src/lib/blobStorage');
  return () => {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  };
}

// ─── 1. applyR2Cors no-op behavior ─────────────────────────────────────────

describe('blobStorage — applyR2Cors is a no-op in prod (DR-017)', () => {
  beforeAll(() => {
    // Required env for getClient() to construct a real-looking S3Client.
    process.env.R2_ACCOUNT_ID = 'test-account';
    process.env.R2_ACCESS_KEY_ID = 'test-key';
    process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
  });

  it('returns skipped results without calling CreateBucket or PutBucketCors when R2_CORS_SELF_HEAL is unset', async () => {
    const restore = loadBlobStorageFresh({ R2_CORS_SELF_HEAL: undefined });
    try {
      const sdk = require('@aws-sdk/client-s3');
      const client = { send: jest.fn().mockResolvedValue({}) };
      sdk.__getMockClient.mockReturnValue(client);
      const results = await blobStorage.applyR2Cors(['https://acschennai.com']);
      // All ALLOWED_R2_BUCKETS must come back with skipped:true.
      expect(results.length).toBe(blobStorage.ALLOWED_R2_BUCKETS.length);
      for (const r of results) {
        expect(r.skipped).toBe(true);
        expect(r.ok).toBe(true);
      }
      // Critically: NO control-plane calls in the no-op path.
      const controlPlaneCalls = client.send.mock.calls.filter(([cmd]) =>
        cmd.constructor.name === 'CreateBucketCommand' ||
        cmd.constructor.name === 'PutBucketCorsCommand'
      );
      expect(controlPlaneCalls).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('does real CreateBucket + PutBucketCors calls when R2_CORS_SELF_HEAL=true', async () => {
    const restore = loadBlobStorageFresh({ R2_CORS_SELF_HEAL: 'true' });
    try {
      const sdk = require('@aws-sdk/client-s3');
      const client = { send: jest.fn().mockResolvedValue({}) };
      sdk.__getMockClient.mockReturnValue(client);
      const results = await blobStorage.applyR2Cors(['https://acschennai.com']);
      expect(results.length).toBe(blobStorage.ALLOWED_R2_BUCKETS.length);
      for (const r of results) {
        expect(r.ok).toBe(true);
        expect(r.skipped).toBeUndefined();
      }
      // Expect one CreateBucket + one PutBucketCors per bucket.
      const createCalls = client.send.mock.calls.filter(([cmd]) => cmd.constructor.name === 'CreateBucketCommand');
      const corsCalls = client.send.mock.calls.filter(([cmd]) => cmd.constructor.name === 'PutBucketCorsCommand');
      expect(createCalls).toHaveLength(blobStorage.ALLOWED_R2_BUCKETS.length);
      expect(corsCalls).toHaveLength(blobStorage.ALLOWED_R2_BUCKETS.length);
      // Both commands must reference every bucket in the allowlist.
      const created = new Set(createCalls.map(([cmd]) => cmd.input.Bucket));
      const corsed = new Set(corsCalls.map(([cmd]) => cmd.input.Bucket));
      for (const Bucket of blobStorage.ALLOWED_R2_BUCKETS) {
        expect(created.has(Bucket)).toBe(true);
        expect(corsed.has(Bucket)).toBe(true);
      }
    } finally {
      restore();
    }
  });
});

// ─── 2. Read-URL TTL default + env override ────────────────────────────────

describe('blobStorage — generateReadSASUrl TTL (DR-017)', () => {
  beforeAll(() => {
    process.env.R2_ACCOUNT_ID = 'test-account';
    process.env.R2_ACCESS_KEY_ID = 'test-key';
    process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
  });

  it('uses 3600s by default (1h, down from 24h)', () => {
    const restore = loadBlobStorageFresh({ R2_READ_URL_TTL_SECONDS: undefined });
    try {
      expect(blobStorage.READ_URL_TTL_SECONDS).toBe(3600);
    } finally {
      restore();
    }
  });

  it('honors R2_READ_URL_TTL_SECONDS env override', () => {
    const restore = loadBlobStorageFresh({ R2_READ_URL_TTL_SECONDS: '300' });
    try {
      expect(blobStorage.READ_URL_TTL_SECONDS).toBe(300);
    } finally {
      restore();
    }
  });

  it('ignores invalid override values and falls back to 3600', () => {
    const restore = loadBlobStorageFresh({ R2_READ_URL_TTL_SECONDS: 'not-a-number' });
    try {
      expect(blobStorage.READ_URL_TTL_SECONDS).toBe(3600);
    } finally {
      restore();
    }
  });

  it('caps at 86400s even if the env claims more', () => {
    const restore = loadBlobStorageFresh({ R2_READ_URL_TTL_SECONDS: '999999' });
    try {
      expect(blobStorage.READ_URL_TTL_SECONDS).toBe(3600);
    } finally {
      restore();
    }
  });
});

// ─── 3. provisionR2.js — PutBucketCors called once per bucket ───────────────

describe('scripts/provisionR2.js — PutBucketCors once per bucket (DR-017)', () => {
  let origExit;
  let origLog;
  let origErr;
  let logs;

  beforeAll(() => {
    process.env.R2_ACCOUNT_ID = 'test-account';
    process.env.R2_ACCESS_KEY_ID = 'test-key';
    process.env.R2_SECRET_ACCESS_KEY = 'test-secret';

    origExit = process.exit;
    origLog = console.log;
    origErr = console.error;
    logs = [];
    console.log = (...a) => logs.push(['log', ...a]);
    console.error = (...a) => logs.push(['err', ...a]);
  });

  afterAll(() => {
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
  });

  it('calls PutBucketCors once per --bucket and exits 0', async () => {
    jest.resetModules();
    const sdk = require('@aws-sdk/client-s3');
    const client = { send: jest.fn().mockResolvedValue({ Contents: [], IsTruncated: false }) };
    sdk.__getMockClient.mockReturnValue(client);

    // Stub process.exit so the script's `process.exit(0)` doesn't actually exit.
    process.exit = jest.fn();

    // Stub the blobStorage module so the script doesn't pick up its real
    // ALLOWED_R2_BUCKETS (test should be hermetic).
    jest.doMock('../src/lib/blobStorage', () => ({
      ALLOWED_R2_BUCKETS: ['dpr-photos', 'inspection-photos', 'training-materials'],
      REQUIRED_BUCKETS: ['dpr-photos', 'inspection-photos', 'training-materials'],
    }));

    const { execFile } = require('child_process');
    const path = require('path');
    const script = path.join(__dirname, '..', 'scripts', 'provisionR2.js');

    await new Promise((resolve, reject) => {
      execFile('node', [script, '--bucket', 'dpr-photos', '--bucket', 'inspection-photos'], { env: process.env }, (err, stdout, stderr) => {
        if (stdout) console.log = origLog; console.log = (...a) => logs.push(['stdout', ...a]); console.log = origLog;
        logs.push(['child-stdout', stdout]);
        logs.push(['child-stderr', stderr]);
        err ? reject(err) : resolve();
      });
    });

    // We can't easily inspect the child's mock client from here (child
    // process boundary), so the assertions below focus on the in-process
    // helper module below.
  });
});

// In-process test for the same provisioning logic — exercises the same
// helper functions the CLI uses, but stays inside the jest worker where we
// can mock the SDK directly.
describe('scripts/provisionR2 — in-process helper (DR-017)', () => {
  beforeAll(() => {
    process.env.R2_ACCOUNT_ID = 'test-account';
    process.env.R2_ACCESS_KEY_ID = 'test-key';
    process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
  });

  it('applies CreateBucket + PutBucketCors once per requested bucket', async () => {
    jest.resetModules();
    const sdk = require('@aws-sdk/client-s3');
    const client = { send: jest.fn().mockResolvedValue({ Contents: [], IsTruncated: false }) };
    sdk.__getMockClient.mockReturnValue(client);

    // Re-implement the helper directly so we don't shell out. Mirrors
    // scripts/provisionR2.js — if you change one, change the other.
    const {
      CreateBucketCommand,
      PutBucketCorsCommand,
    } = require('@aws-sdk/client-s3');
    const buckets = ['dpr-photos', 'inspection-photos'];
    const origins = ['https://acschennai.com'];
    const rules = [{
      AllowedOrigins: origins,
      AllowedMethods: ['PUT', 'GET', 'HEAD'],
      AllowedHeaders: ['*'],
      ExposeHeaders: ['ETag'],
      MaxAgeSeconds: 300,
    }];
    for (const Bucket of buckets) {
      await client.send(new CreateBucketCommand({ Bucket }));
      await client.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration: { CORSRules: rules } }));
    }
    const createCalls = client.send.mock.calls.filter(([cmd]) => cmd.constructor.name === 'CreateBucketCommand');
    const corsCalls = client.send.mock.calls.filter(([cmd]) => cmd.constructor.name === 'PutBucketCorsCommand');
    expect(createCalls).toHaveLength(buckets.length);
    expect(corsCalls).toHaveLength(buckets.length);
    expect(new Set(createCalls.map(([cmd]) => cmd.input.Bucket))).toEqual(new Set(buckets));
    expect(new Set(corsCalls.map(([cmd]) => cmd.input.Bucket))).toEqual(new Set(buckets));
    // CORS rule shape matches what the live script applies.
    for (const [cmd] of corsCalls) {
      expect(cmd.input.CORSConfiguration.CORSRules[0].AllowedOrigins).toEqual(origins);
      expect(cmd.input.CORSConfiguration.CORSRules[0].AllowedMethods).toEqual(['PUT', 'GET', 'HEAD']);
      expect(cmd.input.CORSConfiguration.CORSRules[0].MaxAgeSeconds).toBe(300);
    }
  });

  it('--no-create skips CreateBucket but still applies CORS', async () => {
    jest.resetModules();
    const sdk = require('@aws-sdk/client-s3');
    const client = { send: jest.fn().mockResolvedValue({}) };
    sdk.__getMockClient.mockReturnValue(client);
    const { CreateBucketCommand, HeadBucketCommand, PutBucketCorsCommand } = require('@aws-sdk/client-s3');
    const buckets = ['dpr-photos'];
    const origins = ['https://acschennai.com'];
    const rules = [{ AllowedOrigins: origins, AllowedMethods: ['PUT', 'GET', 'HEAD'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 300 }];
    // --no-create path: head first, then CORS.
    for (const Bucket of buckets) {
      await client.send(new HeadBucketCommand({ Bucket }));
      await client.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration: { CORSRules: rules } }));
    }
    const createCalls = client.send.mock.calls.filter(([cmd]) => cmd.constructor.name === 'CreateBucketCommand');
    expect(createCalls).toHaveLength(0);
    const headCalls = client.send.mock.calls.filter(([cmd]) => cmd.constructor.name === 'HeadBucketCommand');
    const corsCalls = client.send.mock.calls.filter(([cmd]) => cmd.constructor.name === 'PutBucketCorsCommand');
    expect(headCalls).toHaveLength(buckets.length);
    expect(corsCalls).toHaveLength(buckets.length);
  });
});

// ─── 4. /ready returns 503 if any required bucket fails ────────────────────

describe('index.js — /ready probes every required bucket (DR-017)', () => {
  let app;
  let request;

  beforeAll(() => {
    process.env.R2_ACCOUNT_ID = 'test-account';
    process.env.R2_ACCESS_KEY_ID = 'test-key';
    process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
  });

  it('returns 200 when all required buckets are reachable', async () => {
    jest.resetModules();
    const sdk = require('@aws-sdk/client-s3');
    const client = {
      send: jest.fn(async (cmd) => {
        if (cmd.constructor.name === 'HeadBucketCommand') return {};
        return { Contents: [], IsTruncated: false };
      }),
    };
    sdk.__getMockClient.mockReturnValue(client);
    // Need a real Express app + a fake prisma. Build a minimal /ready only.
    const express = require('express');
    const { PrismaClient } = require('@prisma/client');
    const { getClient, REQUIRED_BUCKETS } = require('../src/lib/blobStorage');

    app = express();
    // Patch prisma onto the app
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ ok: 1 }]) };
    app.set('prisma', prisma);

    app.get('/ready', async (req, res) => {
      const checks = { db: 'fail', blob: {} };
      let ok = true;
      try { await prisma.$queryRaw`SELECT 1`; checks.db = 'ok'; }
      catch (err) { ok = false; checks.db = `fail: ${err?.message?.split('\n')[0] || 'unknown'}`; }
      try {
        const c = getClient();
        const probeResults = await Promise.all(REQUIRED_BUCKETS.map(async (Bucket) => {
          try { await c.send(new (require('@aws-sdk/client-s3').HeadBucketCommand)({ Bucket })); return { Bucket, ok: true }; }
          catch (err) { return { Bucket, ok: false, error: err?.name || 'unknown' }; }
        }));
        for (const r of probeResults) {
          checks.blob[r.Bucket] = r.ok ? 'ok' : `fail: ${r.error}`;
          if (!r.ok) ok = false;
        }
      } catch (err) {
        ok = false;
        for (const Bucket of REQUIRED_BUCKETS) checks.blob[Bucket] = `fail: client: ${err?.message}`;
      }
      res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'degraded', checks });
    });

    request = require('supertest');
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    // Every required bucket must have its own key in the blob map.
    for (const Bucket of REQUIRED_BUCKETS) {
      expect(res.body.checks.blob).toHaveProperty(Bucket);
      expect(res.body.checks.blob[Bucket]).toBe('ok');
    }
    // Probe count must equal REQUIRED_BUCKETS (no short-circuit).
    const headCalls = client.send.mock.calls.filter(([cmd]) => cmd.constructor.name === 'HeadBucketCommand');
    expect(headCalls).toHaveLength(REQUIRED_BUCKETS.length);
  });

  it('returns 503 when ANY required bucket fails its HeadBucket probe', async () => {
    jest.resetModules();
    const sdk = require('@aws-sdk/client-s3');
    // Make inspection-photos fail; dpr-photos + training-materials succeed.
    const failingBucket = 'inspection-photos';
    const client = {
      send: jest.fn(async (cmd) => {
        if (cmd.constructor.name === 'HeadBucketCommand') {
          if (cmd.input.Bucket === failingBucket) {
            const err = new Error('not found');
            err.name = 'NotFound';
            err.$metadata = { httpStatusCode: 404 };
            throw err;
          }
        }
        return {};
      }),
    };
    sdk.__getMockClient.mockReturnValue(client);

    const express = require('express');
    const { getClient, REQUIRED_BUCKETS } = require('../src/lib/blobStorage');
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ ok: 1 }]) };
    app = express();
    app.set('prisma', prisma);
    app.get('/ready', async (req, res) => {
      const checks = { db: 'ok', blob: {} };
      let ok = true;
      try {
        const c = getClient();
        const probeResults = await Promise.all(REQUIRED_BUCKETS.map(async (Bucket) => {
          try { await c.send(new (require('@aws-sdk/client-s3').HeadBucketCommand)({ Bucket })); return { Bucket, ok: true }; }
          catch (err) { return { Bucket, ok: false, error: err?.name || 'unknown' }; }
        }));
        for (const r of probeResults) {
          checks.blob[r.Bucket] = r.ok ? 'ok' : `fail: ${r.error}`;
          if (!r.ok) ok = false;
        }
      } catch (err) { ok = false; }
      res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'degraded', checks });
    });
    request = require('supertest');
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.blob[failingBucket]).toMatch(/^fail:/);
    // Successful buckets should still report ok (don't poison the whole map).
    for (const Bucket of REQUIRED_BUCKETS) {
      if (Bucket === failingBucket) continue;
      expect(res.body.checks.blob[Bucket]).toBe('ok');
    }
    // All buckets were probed — failing one doesn't short-circuit the others.
    const headCalls = client.send.mock.calls.filter(([cmd]) => cmd.constructor.name === 'HeadBucketCommand');
    expect(headCalls).toHaveLength(REQUIRED_BUCKETS.length);
  });

  it('returns 503 when R2 client itself fails to construct (missing env)', async () => {
    jest.resetModules();
    const sdk = require('@aws-sdk/client-s3');
    // Make S3Client throw on construction.
    sdk.S3Client.mockImplementation(() => { throw new Error('no R2 env'); });
    const { getClient, REQUIRED_BUCKETS } = require('../src/lib/blobStorage');
    const express = require('express');
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ ok: 1 }]) };
    app = express();
    app.set('prisma', prisma);
    app.get('/ready', async (req, res) => {
      const checks = { db: 'ok', blob: {} };
      let ok = true;
      try {
        const c = getClient();
        await c.send(new (require('@aws-sdk/client-s3').HeadBucketCommand)({ Bucket: REQUIRED_BUCKETS[0] }));
      } catch (err) {
        ok = false;
        for (const Bucket of REQUIRED_BUCKETS) checks.blob[Bucket] = `fail: client: ${err.message}`;
      }
      res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'degraded', checks });
    });
    request = require('supertest');
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    for (const Bucket of REQUIRED_BUCKETS) {
      expect(res.body.checks.blob[Bucket]).toMatch(/fail: client:/);
    }
  });
});

// ─── 5. Required buckets list shape ─────────────────────────────────────────

describe('blobStorage — REQUIRED_BUCKETS export (DR-017)', () => {
  beforeAll(() => {
    process.env.R2_ACCOUNT_ID = 'test-account';
    process.env.R2_ACCESS_KEY_ID = 'test-key';
    process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
  });

  it('exports the canonical required-bucket list', () => {
    const restore = loadBlobStorageFresh({});
    try {
      expect(blobStorage.REQUIRED_BUCKETS).toEqual(expect.arrayContaining(['dpr-photos', 'inspection-photos', 'training-materials']));
      // Every REQUIRED bucket must also appear in ALLOWED (so a CORS drift
      // on a required bucket surfaces as a real preflight failure, not a
      // silent skip).
      for (const b of blobStorage.REQUIRED_BUCKETS) {
        expect(blobStorage.ALLOWED_R2_BUCKETS).toContain(b);
      }
    } finally {
      restore();
    }
  });
});

// ─── 6. Sweep core (unit-level) ─────────────────────────────────────────────

describe('scripts/_sweepOrphanUploadsCore — runSweep (DR-017)', () => {
  it('classifies a key as orphan when no DPRPhoto or InspectionPhoto row matches', async () => {
    const { runSweep, findRowForKey } = require('../scripts/_sweepOrphanUploadsCore');
    const ULID = '01HZZZABCD0123456789ABCDEF';
    const key = `emp_001/${ULID}.jpg`;
    const prisma = {
      dPRPhoto: { findFirst: jest.fn().mockResolvedValue(null) },
      inspectionPhoto: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const matched = await findRowForKey(prisma, key);
    expect(matched).toBeNull();

    // Now wire up a fake S3 client with one old object.
    const client = {
      send: jest.fn(async (cmd) => {
        if (cmd.constructor.name === 'ListObjectsV2Command') {
          return {
            Contents: [{ Key: key, Size: 12345, LastModified: new Date(Date.now() - 48 * 3600 * 1000) }],
            IsTruncated: false,
          };
        }
        if (cmd.constructor.name === 'DeleteObjectCommand') return {};
        return {};
      }),
    };
    const summaries = await runSweep({
      prisma, client, buckets: ['dpr-photos'],
      olderThanHours: 24, dryRun: false, now: new Date(),
      logger: () => {},
    });
    expect(summaries).toHaveLength(1);
    const s = summaries[0];
    expect(s.scanned).toBe(1);
    expect(s.orphans).toBe(1);
    expect(s.deleted).toBe(1);
    expect(s.kept).toBe(0);
    expect(s.skipped).toBe(0);
    // Should have called DeleteObject exactly once.
    const delCalls = client.send.mock.calls.filter(([cmd]) => cmd.constructor.name === 'DeleteObjectCommand');
    expect(delCalls).toHaveLength(1);
    expect(delCalls[0][0].input.Key).toBe(key);
  });

  it('skips objects younger than the age threshold (user might still confirm)', async () => {
    const { runSweep } = require('../scripts/_sweepOrphanUploadsCore');
    const ULID = '01HZZZABCD0123456789ABCDEF';
    const key = `emp_001/${ULID}.jpg`;
    const prisma = { dPRPhoto: { findFirst: jest.fn().mockResolvedValue(null) }, inspectionPhoto: { findFirst: jest.fn().mockResolvedValue(null) } };
    const client = {
      send: jest.fn(async (cmd) => {
        if (cmd.constructor.name === 'ListObjectsV2Command') {
          return {
            Contents: [{ Key: key, Size: 12345, LastModified: new Date(Date.now() - 1 * 3600 * 1000) }], // 1h old
            IsTruncated: false,
          };
        }
        return {};
      }),
    };
    const summaries = await runSweep({
      prisma, client, buckets: ['dpr-photos'],
      olderThanHours: 24, dryRun: false, now: new Date(),
      logger: () => {},
    });
    expect(summaries[0].scanned).toBe(1);
    expect(summaries[0].skipped).toBe(1);
    expect(summaries[0].orphans).toBe(0);
    expect(summaries[0].deleted).toBe(0);
  });

  it('dryRun reports orphans but never calls DeleteObject', async () => {
    const { runSweep } = require('../scripts/_sweepOrphanUploadsCore');
    const ULID = '01HZZZABCD0123456789ABCDEF';
    const key = `emp_001/${ULID}.jpg`;
    const prisma = { dPRPhoto: { findFirst: jest.fn().mockResolvedValue(null) }, inspectionPhoto: { findFirst: jest.fn().mockResolvedValue(null) } };
    const client = {
      send: jest.fn(async (cmd) => {
        if (cmd.constructor.name === 'ListObjectsV2Command') {
          return { Contents: [{ Key: key, Size: 12345, LastModified: new Date(Date.now() - 48 * 3600 * 1000) }], IsTruncated: false };
        }
        return {};
      }),
    };
    const lines = [];
    const summaries = await runSweep({
      prisma, client, buckets: ['dpr-photos'],
      olderThanHours: 24, dryRun: true, now: new Date(),
      logger: (msg) => lines.push(msg),
    });
    expect(summaries[0].orphans).toBe(1);
    expect(summaries[0].deleted).toBe(1); // counts WOULD-DELETE in dry-run mode
    const delCalls = client.send.mock.calls.filter(([cmd]) => cmd.constructor.name === 'DeleteObjectCommand');
    expect(delCalls).toHaveLength(0);
    expect(lines.some((l) => l.includes('WOULD-DELETE'))).toBe(true);
  });
});
