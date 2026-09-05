/**
 * SOL DR-002 regression coverage. The original sweep's CONFIRMED-orphan
 * pass retired any CONFIRMED + boundAt=null intent after a 1h grace, on the
 * assumption that any such row was a permanent orphan. SOL DR-002 surfaced
 * the case where that assumption was wrong: a pre-S3-7 upload that produced
 * a CONFIRMED intent ALSO produced a Photo row in dpr_photo or
 * inspection_photo. The migration backfill handles the one-time case; the
 * ongoing defence is in the sweep itself.
 *
 * These tests pin:
 *   - the referenced-ulid pre-collect (must abort the whole sweep on lookup
 *     failure rather than silently skip)
 *   - the per-row defence in pass 2 (a candidate whose ulid is still
 *     referenced must not be flipped or deleted)
 *   - dry-run mode (same counts as a real run, zero mutations)
 *
 * Harness mirrors upload-sweep.test.js.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || 'test-internal-token';

const express = require('express');
const request = require('supertest');

let mockDeleteBlobCalls = [];

jest.mock('../src/lib/blobStorage', () => ({
  deleteBlob: jest.fn(async () => {
    mockDeleteBlobCalls.push('called');
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

function buildPrisma({ intents = [], dprPhotos = [], inspectionPhotos = [] } = {}) {
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
    if (where.ulid !== undefined && where.ulid !== null) {
      if (where.ulid.notIn && where.ulid.notIn.includes(row.ulid)) return false;
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
      findMany: jest.fn(async ({ where }) =>
        intents.filter((r) => matches(r, where))
          .sort((a, b) => a.createdAt - b.createdAt)
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
    dPRPhoto: {
      findMany: jest.fn(async () => dprPhotos.map((p) => ({ ulid: p.ulid }))),
    },
    inspectionPhoto: {
      findMany: jest.fn(async () => inspectionPhotos.map((p) => ({ ulid: p.ulid }))),
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

const past = (ms) => new Date(Date.now() - ms);
const seed = (overrides) => ({
  id: `intent-${Math.random().toString(36).slice(2, 8)}`,
  employeeId: 'emp-dr002',
  container: 'dpr-photos',
  blobPath: `emp-dr002/${Math.random().toString(36).slice(2, 10)}.jpg`,
  contentType: 'image/jpeg',
  createdAt: past(25 * 60 * 60 * 1000),
  boundType: null,
  boundAt: null,
  ...overrides,
});

beforeEach(() => {
  mockDeleteBlobCalls = [];
});

describe('SOL DR-002 — referenced-ulid pre-collect', () => {
  it('aborts the sweep with 503 when a Photo table lookup fails', async () => {
    const prisma = buildPrisma({ intents: [] });
    // Force a failure on the dpr_photo lookup
    prisma.dPRPhoto.findMany.mockRejectedValueOnce(new Error('db down'));
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/upload/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN)
      .send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('REFERENCED_ULID_LOOKUP_FAILED');
  });

  it('aborts when a Photo model is absent from the prisma client (mock w/o Photo)', async () => {
    const prisma = buildPrisma({ intents: [] });
    delete prisma.dPRPhoto;
    delete prisma.inspectionPhoto;
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/upload/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN)
      .send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('REFERENCED_ULID_LOOKUP_FAILED');
  });

  it('reports photoReferencedCount in the response payload', async () => {
    const prisma = buildPrisma({
      intents: [],
      dprPhotos: [{ ulid: 'ULID1' }, { ulid: 'ULID2' }],
      inspectionPhotos: [{ ulid: 'ULID3' }],
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/upload/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.photoReferencedCount).toBe(3);
  });
});

describe('SOL DR-002 — pass 2 photo-referenced defence', () => {
  it('does NOT delete a CONFIRMED orphan whose ulid is still referenced by dpr_photo', async () => {
    const orphanUlid = 'ULIDORPHAN1';
    const prisma = buildPrisma({
      intents: [
        seed({ status: 'CONFIRMED', confirmedAt: past(2 * 60 * 60 * 1000), ulid: orphanUlid }),
      ],
      dprPhotos: [{ ulid: orphanUlid }], // a DPR photo still references it
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/upload/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.expiredFromConfirmed).toBe(0);
    expect(res.body.blobsCleaned).toBe(0);
    expect(res.body.preservedByPhotoRef).toBeGreaterThanOrEqual(1);
    expect(mockDeleteBlobCalls).toHaveLength(0);
    // And the row stays untouched
    expect(prisma._intents[0].status).toBe('CONFIRMED');
    expect(prisma._intents[0].boundAt).toBeNull();
  });

  it('does NOT delete a CONFIRMED orphan whose ulid is still referenced by inspection_photo', async () => {
    const orphanUlid = 'ULIDORPHAN2';
    const prisma = buildPrisma({
      intents: [
        seed({ status: 'CONFIRMED', confirmedAt: past(2 * 60 * 60 * 1000), ulid: orphanUlid, container: 'inspection-photos' }),
      ],
      inspectionPhotos: [{ ulid: orphanUlid }],
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/upload/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.expiredFromConfirmed).toBe(0);
    expect(res.body.preservedByPhotoRef).toBeGreaterThanOrEqual(1);
    expect(mockDeleteBlobCalls).toHaveLength(0);
  });

  it('still sweeps orphan rows whose ulid is NOT referenced by any Photo table', async () => {
    const orphanUlid = 'ULIDREALORPHAN';
    const prisma = buildPrisma({
      intents: [
        seed({ status: 'CONFIRMED', confirmedAt: past(2 * 60 * 60 * 1000), ulid: orphanUlid }),
      ],
      dprPhotos: [{ ulid: 'OTHER' }],
      inspectionPhotos: [],
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/upload/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.expiredFromConfirmed).toBe(1);
    expect(res.body.blobsCleaned).toBe(1);
    expect(mockDeleteBlobCalls).toHaveLength(1);
  });
});

describe('SOL DR-002 — dry-run mode', () => {
  it('returns the same counts as a real run without mutating or deleting', async () => {
    const rows = [
      seed({ status: 'PENDING', expiresAt: past(60_000), confirmedAt: null }),
      seed({ status: 'CONFIRMED', confirmedAt: past(2 * 60 * 60 * 1000) }),
    ];
    const prisma = buildPrisma({ intents: rows });
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/upload/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN)
      .send({ dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.expiredFromPending).toBe(1);
    expect(res.body.expiredFromConfirmed).toBe(1);
    expect(res.body.blobsWouldClean).toBe(2);
    // Critical: zero mutations and zero deletes
    expect(res.body.blobsCleaned).toBe(0);
    expect(mockDeleteBlobCalls).toHaveLength(0);
    for (const row of prisma._intents) {
      // The CONFIRMED one stays CONFIRMED, the PENDING one stays PENDING
      expect(row.status).not.toBe('EXPIRED');
      expect(row.boundAt).toBeNull();
    }
    expect(prisma.uploadIntent.updateMany).not.toHaveBeenCalled();
  });

  it('dry-run still honours the photo-reference defence', async () => {
    const orphanUlid = 'ULIDKEEP';
    const otherUlid = 'ULIDGO';
    const prisma = buildPrisma({
      intents: [
        seed({ status: 'CONFIRMED', confirmedAt: past(2 * 60 * 60 * 1000), ulid: orphanUlid }),
        seed({ status: 'CONFIRMED', confirmedAt: past(2 * 60 * 60 * 1000), ulid: otherUlid }),
      ],
      dprPhotos: [{ ulid: orphanUlid }],
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/upload/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN)
      .send({ dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.expiredFromConfirmed).toBe(1); // only the unreferenced one
    expect(res.body.blobsWouldClean).toBe(1);
    expect(res.body.preservedByPhotoRef).toBe(1);
  });
});
