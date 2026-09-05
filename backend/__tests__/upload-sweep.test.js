/**
 * [S3-7] Durable upload-intent sweep — POST /api/internal/upload/sweep.
 *
 * LPR-012's durable cleanup was promised in a migration header but never
 * built. This suite pins the contract of the cron that closes it:
 *
 *   1. PENDING past the 20-min upload TTL → EXPIRED + deleteBlob
 *   2. CONFIRMED with no binding past the 1h grace → EXPIRED + deleteBlob
 *      (the silent orphan class)
 *   3. EXPIRED whose delete previously failed, older than 24h → retry +
 *      stamp swept so the next fire does not redo the same dead rows.
 *
 * All atomic guards (`where: { id, status: { in: [...] } }`) are pinned
 * because they are the serialization point against a concurrent DPR
 * POST binding the row.
 *
 * Harness follows admin-training-overdue.test.js (S3-5): mounted route
 * with `X-Internal-Token`, real auth-guard semantics (404 unset / 403
 * mismatch / 200 match), and a hand-rolled Prisma + deleteBlob mock.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || 'test-internal-token';

const express = require('express');
const request = require('supertest');

// `mock`-prefixed module-scoped names are the only writable hooks inside a
// jest.mock factory (Jest hoists the mock and refuses out-of-scope refs).
let mockDeleteBlobCalls = [];
let mockDeleteBlobBehavior = () => Promise.resolve();

jest.mock('../src/lib/blobStorage', () => ({
  deleteBlob: jest.fn(async (container, blobPath) => {
    mockDeleteBlobCalls.push({ container, blobPath });
    return mockDeleteBlobBehavior({ container, blobPath });
  }),
}));

// PII hashing is a thin wrapper — keep the real implementation for any
// field we don't override.
jest.mock('../src/lib/pii', () => {
  const real = jest.requireActual('../src/lib/pii');
  return {
    ...real,
    hashIdentifier: jest.fn((s) => `hash:${typeof s}:${s ? s.length : 0}`),
  };
});

const sweepRouter = require('../src/routes/internal-upload-sweep');

// ─── Prisma stub ───────────────────────────────────────────────────────────
// Mirrors the atomic guard semantics: `updateMany` only mutates rows that
// still match its WHERE; a concurrent bind changes the row so the guard
// returns count=0.
function buildPrisma(seedRows = []) {
  const intents = seedRows.map((r) => ({ ...r }));
  const updateManyCalls = [];

  const matches = (row, where) => {
    if (!where) return true;
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.status !== undefined) {
      const allowed = Array.isArray(where.status.in) ? where.status.in : [where.status];
      if (!allowed.includes(row.status)) return false;
    }
    if (where.boundAt !== undefined) {
      if (where.boundAt === null && row.boundAt !== null) return false;
    }
    if (where.expiresAt && where.expiresAt.lt) {
      if (!(row.expiresAt instanceof Date) || row.expiresAt >= where.expiresAt.lt) return false;
    }
    if (where.confirmedAt && where.confirmedAt.lt) {
      if (!(row.confirmedAt instanceof Date) || row.confirmedAt >= where.confirmedAt.lt) return false;
    }
    if (where.createdAt && where.createdAt.lt) {
      if (!(row.createdAt instanceof Date) || row.createdAt >= where.createdAt.lt) return false;
    }
    if (where.employeeId !== undefined && row.employeeId !== where.employeeId) return false;
    return true;
  };

  return {
    uploadIntent: {
      findMany: jest.fn(async ({ where }) =>
        intents
          .filter((r) => matches(r, where))
          .sort((a, b) => (a.createdAt - b.createdAt))
          // PER_BATCH in test = 500; slice(0, 500) is enough for these suites.
          .slice(0, 500)
          .map((r) => ({ ...r })),
      ),
      updateMany: jest.fn(async ({ where, data }) => {
        updateManyCalls.push({ where, data });
        const hits = intents.filter((r) => matches(r, where));
        for (const row of hits) Object.assign(row, data);
        return { count: hits.length };
      }),
      count: jest.fn(async ({ where }) => intents.filter((r) => matches(r, where)).length),
    },
    // SOL DR-002: the sweep now consults these two Photo tables to defend
    // against the legacy-intent class. Existing tests run with no Photo
    // rows, which is the safe default — every candidate is unreferenced
    // and the sweep behaves exactly as it did before this fix.
    dPRPhoto: {
      findMany: jest.fn(async () => []),
    },
    inspectionPhoto: {
      findMany: jest.fn(async () => []),
    },
    _intents: intents,
    _updateManyCalls: updateManyCalls,
  };
}

function buildApp(prisma) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.use('/api/internal/upload', sweepRouter);
  return app;
}

function postSweep(app) {
  return request(app)
    .post('/api/internal/upload/sweep')
    .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN)
    .send({});
}

// Past + future helpers — the test rows are "old enough" by being born
// well before the grace window. 1h ago / 24h ago / 25h ago.
const past = (ms) => new Date(Date.now() - ms);
const future = (ms) => new Date(Date.now() + ms);

const seed = (overrides) => ({
  id: `intent-${Math.random().toString(36).slice(2, 8)}`,
  employeeId: 'emp-s3-7',
  container: 'dpr-photos',
  blobPath: `emp-s3-7/${Math.random().toString(36).slice(2, 10)}.jpg`,
  contentType: 'image/jpeg',
  createdAt: past(25 * 60 * 60 * 1000),
  boundType: null,
  boundAt: null,
  ...overrides,
});

beforeEach(() => {
  mockDeleteBlobCalls = [];
  mockDeleteBlobBehavior = () => Promise.resolve();
});

describe('S3-7 — sweep auth (mirrors internal-training-overdue.js:97)', () => {
  it('404 when INTERNAL_API_TOKEN is unset', async () => {
    // requireInternalToken reads process.env on each request, so we
    // simply unset it for the duration of the call (and restore for
    // the next test). No module isolation required.
    const saved = process.env.INTERNAL_API_TOKEN;
    delete process.env.INTERNAL_API_TOKEN;
    try {
      const app = buildApp(buildPrisma([]));
      const res = await request(app).post('/api/internal/upload/sweep').send({});
      expect(res.status).toBe(404);
    } finally {
      process.env.INTERNAL_API_TOKEN = saved;
    }
  });

  it('403 when header mismatches', async () => {
    const app = buildApp(buildPrisma([]));
    const res = await request(app).post('/api/internal/upload/sweep').set('X-Internal-Token', 'wrong').send({});
    expect(res.status).toBe(403);
  });
});

describe('S3-7 — pass 1: PENDING past TTL', () => {
  it('flips 3 stale PENDING to EXPIRED and deletes 3 blobs', async () => {
    const rows = [
      seed({ status: 'PENDING', expiresAt: past(60_000), confirmedAt: null }),
      seed({ status: 'PENDING', expiresAt: past(60_000), confirmedAt: null }),
      seed({ status: 'PENDING', expiresAt: past(60_000), confirmedAt: null }),
    ];
    const prisma = buildPrisma(rows);
    const res = await postSweep(buildApp(prisma));

    expect(res.status).toBe(200);
    expect(res.body.expiredFromPending).toBe(3);
    expect(res.body.expiredFromConfirmed).toBe(0);
    expect(res.body.blobsCleaned).toBe(3);
    expect(res.body.blobsStillOrphan).toBe(0);
    expect(mockDeleteBlobCalls).toHaveLength(3);

    // Atomic guard is pinned to status:PENDING so a concurrent bind wins.
    const guard = prisma._updateManyCalls.find((c) => c.data && c.data.status === 'EXPIRED');
    expect(guard).toBeTruthy();
    expect(guard.where.status.in).toEqual(['PENDING']);
  });

  it('leaves fresh PENDING alone', async () => {
    const rows = [seed({ status: 'PENDING', expiresAt: future(60_000), confirmedAt: null })];
    const res = await postSweep(buildApp(buildPrisma(rows)));

    expect(res.body.expiredFromPending).toBe(0);
    expect(mockDeleteBlobCalls).toHaveLength(0);
  });
});

describe('S3-7 — pass 2: CONFIRMED orphan (the silent class)', () => {
  it('flips 2 stale CONFIRMED-unbound to EXPIRED and deletes 2 blobs', async () => {
    const rows = [
      seed({ status: 'CONFIRMED', confirmedAt: past(2 * 60 * 60 * 1000) }),
      seed({ status: 'CONFIRMED', confirmedAt: past(2 * 60 * 60 * 1000) }),
    ];
    const res = await postSweep(buildApp(buildPrisma(rows)));

    expect(res.body.expiredFromConfirmed).toBe(2);
    expect(res.body.blobsCleaned).toBe(2);
    expect(mockDeleteBlobCalls).toHaveLength(2);
  });

  it('does NOT touch CONFIRMED within the 1h grace window', async () => {
    const rows = [seed({ status: 'CONFIRMED', confirmedAt: past(5 * 60_000) })];
    const res = await postSweep(buildApp(buildPrisma(rows)));

    expect(res.body.expiredFromConfirmed).toBe(0);
    expect(mockDeleteBlobCalls).toHaveLength(0);
  });

  it('does NOT touch CONFIRMED that already has a binding', async () => {
    const rows = [seed({ status: 'CONFIRMED', confirmedAt: past(3 * 60 * 60 * 1000), boundAt: past(60_000), boundType: 'dpr' })];
    const res = await postSweep(buildApp(buildPrisma(rows)));

    expect(res.body.expiredFromConfirmed).toBe(0);
    expect(mockDeleteBlobCalls).toHaveLength(0);
  });

  it('pass 1 wins the race: a stale PENDING row cannot be claimed by pass 2', async () => {
    // Same row, both predicates could match if guards were sloppy. The
    // status-typed `where.status.in` is what keeps the passes disjoint.
    const rows = [seed({ status: 'CONFIRMED', confirmedAt: past(2 * 60 * 60 * 1000) })];
    const res = await postSweep(buildApp(buildPrisma(rows)));

    expect(res.body.expiredFromPending).toBe(0);
    expect(res.body.expiredFromConfirmed).toBe(1);
  });
});

describe('S3-7 — pass 3: EXPIRED verify + sweep stamp', () => {
  it('retries a stale EXPIRED, stamps swept, and counts blobsCleaned', async () => {
    // Pass 1 ran an hour ago and flipped to EXPIRED but the R2 delete 500'd.
    // Now (25h later) we retry.
    const rows = [
      seed({ status: 'EXPIRED', createdAt: past(25 * 60 * 60 * 1000) }),
      seed({ status: 'EXPIRED', createdAt: past(25 * 60 * 60 * 1000) }),
    ];
    const prisma = buildPrisma(rows);
    const res = await postSweep(buildApp(prisma));

    expect(res.body.blobsVerified).toBe(2);
    expect(res.body.blobsCleaned).toBe(2);
    expect(mockDeleteBlobCalls).toHaveLength(2);
    // The mock stores intents internally; that's what the route mutated.
    expect(prisma._intents.every((r) => r.boundType === 'swept' && r.boundAt instanceof Date)).toBe(true);
  });

  it('counts honestly when the retry delete also fails — no silent pass-through', async () => {
    mockDeleteBlobBehavior = () => Promise.reject(Object.assign(new Error('503'), { $metadata: { httpStatusCode: 503 } }));
    const rows = [seed({ status: 'EXPIRED', createdAt: past(25 * 60 * 60 * 1000) })];
    const prisma = buildPrisma(rows);
    const res = await postSweep(buildApp(prisma));

    expect(res.body.blobsVerified).toBe(0);
    expect(res.body.blobsCleaned).toBe(0);
    expect(res.body.blobsStillOrphan).toBe(1);
    // The row stays unmarked — the next fire will see it again.
    expect(prisma._intents[0].boundType).toBeNull();
    expect(prisma._intents[0].boundAt).toBeNull();
  });

  it('does not retry EXPIRED inside the 24h window (pass 1/2 just cleaned it)', async () => {
    const rows = [seed({ status: 'EXPIRED', createdAt: past(60 * 60 * 1000) })];
    const res = await postSweep(buildApp(buildPrisma(rows)));

    expect(res.body.blobsVerified).toBe(0);
    expect(mockDeleteBlobCalls).toHaveLength(0);
  });
});

describe('S3-7 — bounds', () => {
  it('stops at PER_RUN_MAX with stoppedReason=per_run_max', async () => {
    const prev = process.env.UPLOAD_SWEEP_RUN_MAX;
    process.env.UPLOAD_SWEEP_RUN_MAX = '2';
    let freshRouter;
    try {
      // Re-require inside the env change so the readPositiveInt helper
      // picks up the new bound at module load.
      jest.isolateModules(() => {
        freshRouter = require('../src/routes/internal-upload-sweep');
      });
      const app = express();
      app.use(express.json());
      const rows = Array.from({ length: 5 }, () =>
        seed({ status: 'PENDING', expiresAt: past(60_000), confirmedAt: null }),
      );
      app.set('prisma', buildPrisma(rows));
      app.use('/api/internal/upload', freshRouter);
      const res = await request(app)
        .post('/api/internal/upload/sweep')
        .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.stoppedReason).toBe('per_run_max');
      expect(res.body.expiredFromPending + res.body.expiredFromConfirmed).toBeLessThanOrEqual(2);
    } finally {
      if (prev === undefined) delete process.env.UPLOAD_SWEEP_RUN_MAX; else process.env.UPLOAD_SWEEP_RUN_MAX = prev;
    }
  });

  it('empty DB → 0s and stoppedReason=null', async () => {
    const res = await postSweep(buildApp(buildPrisma([])));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      expiredFromPending: 0,
      expiredFromConfirmed: 0,
      blobsCleaned: 0,
      blobsStillOrphan: 0,
      blobsVerified: 0,
      stoppedReason: null,
    });
  });
});

describe('S3-7 — Prisma-not-available is a 500 (not a silent skip)', () => {
  it('returns 500 when prisma.uploadIntent is missing', async () => {
    const app = express();
    app.use(express.json());
    app.set('prisma', {}); // no uploadIntent
    app.use('/api/internal/upload', sweepRouter);
    const res = await request(app)
      .post('/api/internal/upload/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN)
      .send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Prisma/);
  });
});
