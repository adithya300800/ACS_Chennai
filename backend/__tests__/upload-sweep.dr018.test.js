/**
 * DR-018 — Failed-delete rows must NOT be silently excluded from
 * future sweep passes.
 *
 * The audit caught that the original sweep stamped `boundAt` at the
 * same atomic flip that turned a row from PENDING/CONFIRMED into
 * EXPIRED, then called R2. If the R2 delete failed (transient 5xx,
 * bucket outage, network blip), the row landed in a state that pass
 * 3 — the EXPIRED-verify pass — never looks at:
 *
 *   status = EXPIRED   (flipped, sweep claimed it)
 *   boundAt = <set>    (stamped at flip time)
 *   boundType = null   (delete failed; we never wrote the sentinel)
 *
 * Pass 3's `where` was `boundAt: null` to skip already-swept rows, so
 * the failed-delete row was invisible. The blob stayed in R2 forever
 * with no record of the sweep ever having tried.
 *
 * The fix introduces a three-state model on the upload_intent row:
 *   1. OWNED     — original PENDING/CONFIRMED row (or bound by a DPR
 *                  / Inspection handler). Not the sweep's concern.
 *   2. CLAIMED   — status=EXPIRED + boundAt=null. The sweep intends
 *                  to delete the blob but has not yet verified it
 *                  is gone. Pass 3 will revisit rows that stay here.
 *   3. SWEPT     — status=EXPIRED + boundAt=set + boundType='swept'.
 *                  R2 delete verified. Terminal — pass 3 ignores.
 *
 * These tests pin the three transitions.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || 'test-internal-token';

const express = require('express');
const request = require('supertest');

let mockNextDeleteResult = 'success'; // 'success' | 'fail'

jest.mock('../src/lib/blobStorage', () => ({
  deleteBlob: jest.fn(async () => {
    if (mockNextDeleteResult === 'fail') {
      const err = new Error('R2 5xx');
      err.$metadata = { httpStatusCode: 503 };
      throw err;
    }
    // success path
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

// In-memory prisma. Mirrors upload-sweep.dr002.test.js but with a
// per-intent history so we can introspect every updateMany and verify
// the three-state model.
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
    if (where.boundType !== undefined) {
      if (where.boundType && where.boundType.not && row.boundType === where.boundType.not) {
        return false;
      }
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
      findMany: jest.fn(async ({ where } = {}) =>
        intents
          .filter((r) => matches(r, where))
          .sort((a, b) => a.createdAt - b.createdAt)
          .slice(0, 500)
          .map((r) => ({ ...r }))
      ),
      updateMany: jest.fn(async ({ where, data }) => {
        updateManyCalls.push({ where, data });
        const hits = intents.filter((r) => matches(r, where));
        for (const row of hits) Object.assign(row, data);
        return { count: hits.length };
      }),
      count: jest.fn(async ({ where } = {}) => intents.filter((r) => matches(r, where)).length),
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
  employeeId: 'emp-dr018',
  container: 'dpr-photos',
  blobPath: `emp-dr018/${Math.random().toString(36).slice(2, 10)}.jpg`,
  contentType: 'image/jpeg',
  createdAt: past(25 * 60 * 60 * 1000),
  boundType: null,
  boundAt: null,
  ...overrides,
});

beforeEach(() => {
  mockNextDeleteResult = 'success';
  // Reset the shared mock so a previous test's blob-deletions don't
  // bleed into the call count for S5.
  require('../src/lib/blobStorage').deleteBlob.mockClear();
});

describe('DR-018 — three-state model on the upload_intent row', () => {
  it('S1. Pass 2 success path: row ends SWEPT (status=EXPIRED, boundAt=set, boundType="swept")', async () => {
    const intent = seed({
      status: 'CONFIRMED',
      confirmedAt: past(2 * 60 * 60 * 1000),
      ulid: 'ULIDSWEPT1',
    });
    const prisma = buildPrisma({ intents: [intent] });
    const app = buildApp(prisma);

    const res = await request(app)
      .post('/api/internal/upload/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.blobsCleaned).toBe(1);
    expect(res.body.blobsStillOrphan).toBe(0);

    // Three updateMany calls expected for one successful pass-2 row:
    //   (a) flip status=PENDING/CONFIRMED → EXPIRED  (atomic guard)
    //   (b) stamp boundAt + boundType='swept'        (post-delete sentinel)
    expect(prisma._updateManyCalls.length).toBeGreaterThanOrEqual(2);
    const last = prisma._updateManyCalls[prisma._updateManyCalls.length - 1];
    expect(last.data.boundType).toBe('swept');
    expect(last.data.boundAt).toBeInstanceOf(Date);

    // Final row state: SWEPT
    expect(intent.status).toBe('EXPIRED');
    expect(intent.boundAt).toBeInstanceOf(Date);
    expect(intent.boundType).toBe('swept');
  });

  it('S2. Pass 2 fail path: row stays CLAIMED (status=EXPIRED, boundAt=null) so Pass 3 can retry', async () => {
    // createdAt must be within the past 24h so Pass 3's verify window
    // does NOT pick up the row in this same fire — we want to assert
    // Pass 2 alone left the row in the CLAIMED state.
    const intent = seed({
      status: 'CONFIRMED',
      confirmedAt: past(2 * 60 * 60 * 1000),
      createdAt: past(2 * 60 * 60 * 1000),
      ulid: 'ULIDCLAIMED1',
    });
    const prisma = buildPrisma({ intents: [intent] });
    mockNextDeleteResult = 'fail';

    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/upload/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.blobsCleaned).toBe(0);
    expect(res.body.blobsStillOrphan).toBe(1);

    // The flip happened (status=EXPIRED) but boundAt MUST still be null
    // and boundType MUST still be null. If either was set, the row is
    // invisible to pass 3 and the audit's bug recurs.
    expect(intent.status).toBe('EXPIRED');
    expect(intent.boundAt).toBeNull();
    expect(intent.boundType).toBeNull();

    // The single updateMany was the flip. There must NOT be a second
    // updateMany that stamps boundAt/boundType='swept' on a row whose
    // delete never succeeded.
    const sweepStamps = prisma._updateManyCalls.filter(
      (c) => c.data && c.data.boundType === 'swept',
    );
    expect(sweepStamps).toHaveLength(0);
  });

  it('S3. Pass 3 picks up a CLAIMED row (failed Pass 2) and promotes it to SWEPT on success', async () => {
    // A row that was flipped to EXPIRED by a previous fire but whose
    // delete failed — i.e. exactly the audit's "stuck" state.
    // It is now 25h old (past the EXPIRED verify window) and Pass 3
    // should pick it up, delete the blob, and stamp swept.
    const stuckRow = seed({
      id: 'stuck-1',
      status: 'EXPIRED',
      boundAt: null,
      boundType: null,
      createdAt: past(25 * 60 * 60 * 1000),
      ulid: 'ULIDSTUCK',
    });
    const prisma = buildPrisma({ intents: [stuckRow] });
    const app = buildApp(prisma);

    const res = await request(app)
      .post('/api/internal/upload/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN)
      .send({});

    expect(res.status).toBe(200);
    // Pass 3 processed the stuck row.
    expect(res.body.blobsCleaned).toBe(1);
    expect(res.body.blobsVerified).toBe(1);
    expect(res.body.blobsStillOrphan).toBe(0);

    // After Pass 3 success: row is SWEPT (terminal).
    expect(stuckRow.status).toBe('EXPIRED');
    expect(stuckRow.boundType).toBe('swept');
    expect(stuckRow.boundAt).toBeInstanceOf(Date);
  });

  it('S4. Pass 3 picks up a CLAIMED row but the retry also fails — row stays CLAIMED for next fire', async () => {
    const stuckRow = seed({
      id: 'stuck-2',
      status: 'EXPIRED',
      boundAt: null,
      boundType: null,
      createdAt: past(25 * 60 * 60 * 1000),
      ulid: 'ULIDSTUCKAGAIN',
    });
    const prisma = buildPrisma({ intents: [stuckRow] });
    mockNextDeleteResult = 'fail';

    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/upload/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN)
      .send({});

    expect(res.status).toBe(200);
    // Pass 3 looked at the row and the delete failed: blobsVerified
    // counts only rows that pass 3 successfully cleaned; the failed
    // retry is captured in blobsStillOrphan instead.
    expect(res.body.blobsCleaned).toBe(0);
    expect(res.body.blobsStillOrphan).toBe(1);

    // Row must remain CLAIMED — Pass 3 must NOT mark it swept when the
    // delete failed, otherwise the audit's bug recurs with a different
    // failure mode.
    expect(stuckRow.status).toBe('EXPIRED');
    expect(stuckRow.boundAt).toBeNull();
    expect(stuckRow.boundType).toBeNull();
  });

  it('S5. SWEPT rows are invisible to Pass 3 (terminal sentinel)', async () => {
    // A SWEPT row should be ignored by pass 3 — no second delete,
    // no extra stamp.
    const sweptRow = seed({
      id: 'swept-1',
      status: 'EXPIRED',
      boundAt: past(2 * 60 * 60 * 1000), // swept 2h ago
      boundType: 'swept',
      createdAt: past(25 * 60 * 60 * 1000),
      ulid: 'ULIDSWEPT2',
    });
    const prisma = buildPrisma({ intents: [sweptRow] });
    const app = buildApp(prisma);

    const res = await request(app)
      .post('/api/internal/upload/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.blobsVerified).toBe(0);
    expect(res.body.blobsCleaned).toBe(0);
    // The deleteBlob mock was never called for the SWEPT row.
    expect(require('../src/lib/blobStorage').deleteBlob).not.toHaveBeenCalled();
  });

  it('S6. After two failed passes the response shape makes the stuck state observable', async () => {
    // Operator dashboard must be able to see "we tried N times and
    // the blob is still there" — that's what blobsStillOrphan counts.
    const stuckRow = seed({
      id: 'stuck-3',
      status: 'EXPIRED',
      boundAt: null,
      boundType: null,
      createdAt: past(48 * 60 * 60 * 1000),
      ulid: 'ULIDLONGSTUCK',
    });
    const prisma = buildPrisma({ intents: [stuckRow] });
    mockNextDeleteResult = 'fail';

    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/upload/sweep')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.blobsStillOrphan).toBeGreaterThanOrEqual(1);
    expect(res.body.remainingEstimate).toBeGreaterThanOrEqual(1);
  });
});
