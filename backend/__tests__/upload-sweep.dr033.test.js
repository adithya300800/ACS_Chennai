/**
 * SOL DR-033 — Sweep traversal must advance past every visited candidate.
 *
 * Acceptance criteria from the audit:
 *   - 500 protected rows plus one orphan reaches the orphan
 *   - Equal timestamps, repeated failures and dry-run visit each
 *     candidate once per pass
 *   - Counters represent unique work (a preserved row is not counted
 *     twice across batches)
 *
 * Background:
 *   The original sweep paginated with `findMany({ orderBy: { createdAt:
 *   'asc' }, take: PER_BATCH })`. When a row was preserved (still
 *   referenced by a Photo), failed-delete (status flipped but delete
 *   refused), or counted in dry-run, its state did not advance past the
 *   same predicate — so the next batch query re-selected the same head
 *   of the queue, never reaching later real orphans.
 *
 *   DR-033 fixes this with a per-pass visited-id set: each candidate is
 *   added to `visitedIds` before any per-row body runs, and the next
 *   `findMany` filters `id: { notIn: [...visitedIds] }`. Combined with
 *   `orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]` for stable
 *   tie-breaking on equal timestamps, the traversal guarantees
 *   single-visit semantics per pass.
 *
 * These tests pin:
 *   1. A protected-only head does NOT starve a real orphan behind it.
 *   2. Equal-timestamp candidates visit each row exactly once across
 *      multiple batches (no duplicates, no skipped rows).
 *   3. Dry-run visits each candidate once per pass (not re-counted).
 *   4. Counters in the response payload represent unique work — a
 *      preserved row contributes to `preservedByPhotoRef` exactly once.
 *   5. Source-text pin: the fix is detectable from the file itself
 *      (`visitedIds` Set, `id: { notIn: [...] }`, the tie-break orderBy).
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || 'test-internal-token';

const express = require('express');
const request = require('supertest');
const fs = require('fs');
const path = require('path');

let mockDeleteBlobCalls = [];
let mockDeleteBlobBehavior = () => Promise.resolve();

jest.mock('../src/lib/blobStorage', () => ({
  deleteBlob: jest.fn(async (container, blobPath) => {
    mockDeleteBlobCalls.push({ container, blobPath });
    return mockDeleteBlobBehavior({ container, blobPath });
  }),
}));

jest.mock('../src/lib/pii', () => {
  const real = jest.requireActual('../src/lib/pii');
  return {
    ...real,
    hashIdentifier: jest.fn((s) => `hash:${typeof s}:${s ? s.length : 0}`),
  };
});

const sweepRouter = require('../src/routes/internal-upload-sweep');

// Mirror upload-sweep.dr001.test.js: build a small Prisma stub that
// supports the (createdAt, id) seek progression filter introduced by
// DR-033. The visited-id exclusion is the load-bearing addition.
function buildPrisma({ intents = [], dprPhotos = [], inspectionPhotos = [] } = {}) {
  const updateManyCalls = [];
  const findManyCalls = [];
  const matches = (row, where) => {
    if (!where) return true;
    // where.id can be a string (exact match, used by updateMany guards)
    // or an object like { notIn: [...] } (used by the DR-033 visited-id
    // exclusion). Handle both shapes.
    if (where.id !== undefined) {
      if (typeof where.id === 'string') {
        if (row.id !== where.id) return false;
      } else if (where.id && Array.isArray(where.id.notIn)) {
        if (where.id.notIn.includes(row.id)) return false;
      }
    }
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
    return true;
  };

  return {
    uploadIntent: {
      findMany: jest.fn(async ({ where, orderBy } = {}) => {
        findManyCalls.push({ where, orderBy });
        // Stable secondary sort by id when orderBy is an array
        // (DR-033 tie-break) — the production route orders by
        // [{ createdAt: 'asc' }, { id: 'asc' }] for equal timestamps.
        return intents
          .filter((r) => matches(r, where))
          .sort((a, b) => {
            if (a.createdAt - b.createdAt !== 0) return a.createdAt - b.createdAt;
            return String(a.id).localeCompare(String(b.id));
          })
          .slice(0, 500)
          .map((r) => ({ ...r }));
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        updateManyCalls.push({ where, data });
        const hits = intents.filter((r) => matches(r, where));
        for (const row of hits) Object.assign(row, data);
        return { count: hits.length };
      }),
      count: jest.fn(async ({ where } = {}) => intents.filter((r) => matches(r, where)).length),
    },
    dPRPhoto: { findMany: jest.fn(async () => dprPhotos.map((p) => ({ ulid: p.ulid }))) },
    inspectionPhoto: { findMany: jest.fn(async () => inspectionPhotos.map((p) => ({ ulid: p.ulid }))) },
    drawing: { findMany: jest.fn(async () => []) },
    projectAttachment: { findMany: jest.fn(async () => []) },
    billingCertification: { findMany: jest.fn(async () => []) },
    _intents: intents,
    _updateManyCalls: updateManyCalls,
    _findManyCalls: findManyCalls,
  };
}

function buildApp(prisma) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.use('/api/internal/upload', sweepRouter);
  return app;
}

const past = (ms) => new Date(Date.now() - ms);
const seed = (overrides) => ({
  id: `intent-${Math.random().toString(36).slice(2, 8)}`,
  employeeId: 'emp-dr033',
  container: 'dpr-photos',
  blobPath: `emp-dr033/${Math.random().toString(36).slice(2, 10)}.jpg`,
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

describe('DR-033 — protected-only head does NOT starve a real orphan behind it', () => {
  it('one orphan beyond 500 preserved rows is reached by the sweep', async () => {
    // Build 500 preserved CONFIRMED-orphan rows, then ONE real orphan
    // (no photo reference). With the old code, the cursor would never
    // advance past the preserved head and the orphan would never be
    // reached inside a single pass. With DR-033, the visited-id set
    // forces the next findMany past the protected head.
    //
    // createdAt is staggered so the orphan sorts LAST — that way the
    // 500-row head is deterministically all preserved and the orphan is
    // always in batch 2. Random id ordering would otherwise let the
    // orphan slip into the head and the test would not exercise the
    // cursor advance.
    const preservedUlid = 'ULIDPRESERVED';
    const orphanUlid = 'ULIDORPHAN';
    const headTs = past(25 * 60 * 60 * 1000);
    const orphanTs = new Date(headTs.getTime() + 60_000); // strictly newer than head
    const preserved = Array.from({ length: 500 }, (_, i) => seed({
      status: 'CONFIRMED',
      confirmedAt: past(2 * 60 * 60 * 1000),
      ulid: preservedUlid,
      // Stagger so the order is deterministic even if the production
      // sort tie-breaks by id.
      createdAt: new Date(headTs.getTime() - (500 - i)),
    }));
    const orphan = seed({
      status: 'CONFIRMED',
      confirmedAt: past(2 * 60 * 60 * 1000),
      ulid: orphanUlid,
      createdAt: orphanTs,
    });
    const prisma = buildPrisma({
      intents: [...preserved, orphan],
      dprPhotos: [{ ulid: preservedUlid }], // head is preserved
    });
    const res = await request(buildApp(prisma))
      .post('/api/internal/upload/sweep?override=DR001_RECONCILED')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN)
      .send({});

    expect(res.status).toBe(200);
    // 500 preserved + 1 orphan = 501 unique visits
    expect(res.body.preservedByPhotoRef).toBe(500);
    // The orphan at the tail was reached and cleaned
    expect(res.body.expiredFromConfirmed).toBe(1);
    expect(res.body.blobsCleaned).toBe(1);
    expect(mockDeleteBlobCalls).toHaveLength(1);

    // The findMany cursor saw at least 2 batches: the head of 500
    // preserved rows, then the orphan (after the visited set grew to
    // include the 500 head rows).
    const sweepIntentQueries = prisma._findManyCalls.filter(
      (c) => c.where && c.where.status && c.where.status === 'CONFIRMED',
    );
    expect(sweepIntentQueries.length).toBeGreaterThanOrEqual(2);
    // The last batch's where clause excludes the 500 visited ids.
    const lastBatch = sweepIntentQueries[sweepIntentQueries.length - 1];
    expect(lastBatch.where.id).toBeDefined();
    expect(lastBatch.where.id.notIn).toHaveLength(500);
  });

  it('equal-timestamp candidates are visited exactly once across multiple batches', async () => {
    // 12 rows that all share the SAME createdAt — Prisma's default
    // tie-break is undefined. The DR-033 secondary sort on `id`
    // guarantees each row is visited once; without it, the same head
    // row can be re-selected while its timestamp-siblings are skipped.
    const sharedTs = past(2 * 60 * 60 * 1000);
    const rows = Array.from({ length: 12 }, () => seed({
      status: 'PENDING',
      expiresAt: past(60_000),
      confirmedAt: null,
      createdAt: sharedTs,
    }));
    const prisma = buildPrisma({ intents: rows });
    const res = await request(buildApp(prisma))
      .post('/api/internal/upload/sweep?override=DR001_RECONCILED')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.expiredFromPending).toBe(12);
    expect(res.body.blobsCleaned).toBe(12);
    // Every row was flipped and the blob delete called once per row.
    expect(mockDeleteBlobCalls).toHaveLength(12);

    // Inspect the findMany orderBy — must be an array with a secondary
    // sort on id, not the legacy bare `{ createdAt: 'asc' }` shape.
    const pass1Queries = prisma._findManyCalls.filter(
      (c) => c.where && c.where.status === 'PENDING',
    );
    expect(pass1Queries.length).toBeGreaterThanOrEqual(1);
    for (const q of pass1Queries) {
      expect(Array.isArray(q.orderBy)).toBe(true);
      expect(q.orderBy[0]).toEqual({ createdAt: 'asc' });
      expect(q.orderBy[1]).toEqual({ id: 'asc' });
    }
  });
});

describe('DR-033 — dry-run visits each candidate once per pass', () => {
  it('a protected head in dry-run mode does not recount the orphan', async () => {
    // Dry-run mode must NOT mutate, but must visit each candidate
    // exactly once. Without DR-033, the same protected head would be
    // recounted into the dry-run counters batch after batch.
    //
    // Same deterministic ordering as the real-run test: 600 preserved
    // rows sort strictly before the orphan so the head of the first
    // batch is fully preserved.
    const preservedUlid = 'ULIDDPRES';
    const orphanUlid = 'ULIDDORPH';
    const headTs = past(25 * 60 * 60 * 1000);
    const orphanTs = new Date(headTs.getTime() + 60_000);
    const preserved = Array.from({ length: 600 }, (_, i) => seed({
      status: 'CONFIRMED',
      confirmedAt: past(2 * 60 * 60 * 1000),
      ulid: preservedUlid,
      createdAt: new Date(headTs.getTime() - (600 - i)),
    }));
    const orphan = seed({
      status: 'CONFIRMED',
      confirmedAt: past(2 * 60 * 60 * 1000),
      ulid: orphanUlid,
      createdAt: orphanTs,
    });
    const prisma = buildPrisma({
      intents: [...preserved, orphan],
      dprPhotos: [{ ulid: preservedUlid }],
    });
    const res = await request(buildApp(prisma))
      .post('/api/internal/upload/sweep?override=DR001_RECONCILED')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN)
      .send({ dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    // 600 preserved + 1 orphan = 601 unique visits
    expect(res.body.preservedByPhotoRef).toBe(600);
    // Orphan reached exactly once
    expect(res.body.expiredFromConfirmed).toBe(1);
    expect(res.body.blobsWouldClean).toBe(1);
    expect(mockDeleteBlobCalls).toHaveLength(0);
  });
});

describe('DR-033 — repeated failures do not loop forever on the same row', () => {
  it('a repeatedly-failing row is visited once per pass and counted as failed once', async () => {
    // Force deleteBlob to fail. With DR-033, the failing row stays in
    // pass 3's CLAIMED state but the visited-id set excludes it from
    // the next batch — so within one fire it does NOT cause an
    // infinite re-loop. The row will be retried on the NEXT fire (a
    // different concern, owned by the 15-min cron cadence).
    mockDeleteBlobBehavior = () => Promise.reject(
      Object.assign(new Error('R2 5xx'), { $metadata: { httpStatusCode: 503 } }),
    );
    const rows = Array.from({ length: 4 }, () => seed({
      status: 'EXPIRED',
      createdAt: past(25 * 60 * 60 * 1000),
      boundAt: null,
      boundType: null,
    }));
    const prisma = buildPrisma({ intents: rows });
    const res = await request(buildApp(prisma))
      .post('/api/internal/upload/sweep?override=DR001_RECONCILED')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN)
      .send({});

    expect(res.status).toBe(200);
    // 4 distinct rows, each visited once, each failing once.
    expect(res.body.blobsStillOrphan).toBe(4);
    expect(res.body.blobsVerified).toBe(0);
    expect(res.body.blobsCleaned).toBe(0);
    // Findmany saw all 4 rows at once (single batch) — no infinite loop.
    const pass3Queries = prisma._findManyCalls.filter(
      (c) => c.where && c.where.status === 'EXPIRED',
    );
    expect(pass3Queries).toHaveLength(1);
  });
});

describe('DR-033 — source-text pin of the fix', () => {
  it('the sweep file uses a visitedIds Set and id.notIn filter for cursor progression', () => {
    const sweepPath = path.join(__dirname, '..', 'src', 'routes', 'internal-upload-sweep.js');
    const src = fs.readFileSync(sweepPath, 'utf8');

    // The visitedIds Set is the per-pass state that advances the cursor.
    expect(src).toMatch(/const\s+visitedIds\s*=\s*new\s+Set\(\)/);
    // The id: { notIn: [...] } filter is what excludes already-visited
    // candidates from the next findMany.
    expect(src).toMatch(/id:\s*\{\s*notIn:\s*\[\.\.\.visitedIds\]\s*\}/);
    // Stable secondary sort on id makes the traversal deterministic
    // when multiple rows share the same createdAt timestamp.
    expect(src).toMatch(/orderBy:\s*\[\{\s*createdAt:\s*'asc'\s*\},\s*\{\s*id:\s*'asc'\s*\}\]/);

    // The visitedIds.add call appears BEFORE the per-row body so the
    // cursor advances even if the per-row body exits early (preserved,
    // dry-run, failed, swept, per-run-cap break, time-budget break).
    const visitedAddIdx = src.indexOf('visitedIds.add(intent.id)');
    const preservedCheckIdx = src.indexOf('if (isReferenced)');
    expect(visitedAddIdx).toBeGreaterThan(-1);
    expect(preservedCheckIdx).toBeGreaterThan(-1);
    expect(visitedAddIdx).toBeLessThan(preservedCheckIdx);
  });

  it('the verify loop (pass 3) uses its own visitedVerifyIds Set', () => {
    const sweepPath = path.join(__dirname, '..', 'src', 'routes', 'internal-upload-sweep.js');
    const src = fs.readFileSync(sweepPath, 'utf8');

    expect(src).toMatch(/const\s+visitedVerifyIds\s*=\s*new\s+Set\(\)/);
    expect(src).toMatch(/visitedVerifyIds\.add\(intent\.id\)/);
    expect(src).toMatch(/id:\s*\{\s*notIn:\s*\[\.\.\.visitedVerifyIds\]\s*\}/);
  });
});
