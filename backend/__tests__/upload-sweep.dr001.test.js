/**
 * SOL DR-001 — Non-photo document owners must be defended against the
 * CONFIRMED-orphan pass.
 *
 * The S3-7 sweep's pass 2 retires any `status='CONFIRMED' AND
 * bound_at IS NULL` intent past its 1h grace, on the assumption that
 * no record has claimed the bytes. SOL DR-001 surfaced the case where
 * that assumption is wrong for the three document-owner tables —
 * Drawing, ProjectAttachment, BillingCertification — whose blob
 * reference is a `blobPath` STRING, not a `ulid` FK column. After the
 * migration that added `upload_intent_ulid` to all three tables, the
 * defence has two halves (both required):
 *
 *   1. The new `uploadIntentUlid` column, populated by the route
 *      layer at create-time. New entities whose intent has been
 *      claimed are invisible to pass 2 via this column.
 *
 *   2. A legacy defence that selects the `blobPath` of every
 *      non-deleted Drawing / ProjectAttachment / BillingCertification
 *      row. Pre-deploy rows (and any future row whose intent claim
 *      fails for whatever reason) are still protected.
 *
 * These tests pin:
 *   - per-row defence: a CONFIRMED orphan intent is NOT deleted if
 *     either half of the defence finds a reference;
 *   - lookup failure on any of the five sources returns 503, never
 *     a silent pass-through;
 *   - the response payload exposes both halves' sizes
 *     (`photoReferencedCount` widened to include the new entities,
 *     new `referencedBlobPathCount`);
 *   - lifecycle exclusions: SUPERSEDED drawings, soft-deleted
 *     ProjectAttachment / BillingCertification rows do NOT count as
 *     references — the bytes are no longer in active use.
 *
 * Harness follows upload-sweep.dr002.test.js — extend the seed
 * helpers to also accept the new entity tables so each test names
 * exactly what it pins.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || 'test-internal-token';

const express = require('express');
const request = require('supertest');

let mockDeleteBlobCalls = [];

jest.mock('../src/lib/blobStorage', () => ({
  deleteBlob: jest.fn(async (container, blobPath) => {
    mockDeleteBlobCalls.push({ container, blobPath });
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

function buildPrisma({
  intents = [],
  dprPhotos = [],
  inspectionPhotos = [],
  drawings = [],
  projectAttachments = [],
  billingCertifications = [],
} = {}) {
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

  // The sweep calls `findMany({ where, select: { [field]: true } })`
  // for both halves of the defence. We honour `where` for the legacy
  // blobPath defence (the route filters out soft-deleted rows and
  // SUPERSEDED drawings) and ignore it for the uploadIntentUlid
  // pre-collect (the route does not filter those).
  const applyWhere = (rows, where) => {
    if (!where) return rows;
    return rows.filter((r) => {
      if (where.status !== undefined) {
        if (r.status !== where.status) return false;
      }
      if (where.deletedAt !== undefined) {
        if (where.deletedAt === null && r.deletedAt !== null) return false;
      }
      if (where.pdfBlobPath && where.pdfBlobPath.not === null) {
        if (r.pdfBlobPath == null) return false;
      }
      if (where.blobPath && where.blobPath.not === null) {
        if (r.blobPath == null) return false;
      }
      return true;
    });
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
    drawing: {
      findMany: jest.fn(async ({ where, select } = {}) => {
        const filtered = applyWhere(drawings, where);
        return filtered.map((d) => {
          const out = {};
          for (const k of Object.keys(select || {})) out[k] = d[k];
          return out;
        });
      }),
    },
    projectAttachment: {
      findMany: jest.fn(async ({ where, select } = {}) => {
        const filtered = applyWhere(projectAttachments, where);
        return filtered.map((d) => {
          const out = {};
          for (const k of Object.keys(select || {})) out[k] = d[k];
          return out;
        });
      }),
    },
    billingCertification: {
      findMany: jest.fn(async ({ where, select } = {}) => {
        const filtered = applyWhere(billingCertifications, where);
        return filtered.map((d) => {
          const out = {};
          for (const k of Object.keys(select || {})) out[k] = d[k];
          return out;
        });
      }),
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

const past = (ms) => new Date(Date.now() - ms);

const seed = (overrides) => ({
  id: `intent-${Math.random().toString(36).slice(2, 8)}`,
  employeeId: 'emp-dr001',
  container: 'dpr-documents',
  blobPath: `emp-dr001/${Math.random().toString(36).slice(2, 10)}.pdf`,
  contentType: 'application/pdf',
  createdAt: past(25 * 60 * 60 * 1000),
  boundType: null,
  boundAt: null,
  ...overrides,
});

beforeEach(() => {
  mockDeleteBlobCalls = [];
});

describe('SOL DR-001 — referenced-ulid defence covers Drawing/ProjectAttachment/BillingCertification', () => {
  it('Drawing.uploadIntentUlid preserves the intent', async () => {
    const intentUlid = 'ULIDDRAW1';
    const prisma = buildPrisma({
      intents: [
        seed({ ulid: intentUlid, status: 'CONFIRMED', confirmedAt: past(2 * 60 * 60 * 1000) }),
      ],
      drawings: [{ id: 'd-1', status: 'ACTIVE', uploadIntentUlid: intentUlid }],
    });
    const res = await postSweep(buildApp(prisma));

    expect(res.status).toBe(200);
    expect(res.body.expiredFromConfirmed).toBe(0);
    expect(res.body.blobsCleaned).toBe(0);
    expect(res.body.preservedByPhotoRef).toBeGreaterThanOrEqual(1);
    expect(mockDeleteBlobCalls).toHaveLength(0);
    // Row stays untouched
    expect(prisma._intents[0].status).toBe('CONFIRMED');
    expect(prisma._intents[0].boundAt).toBeNull();
  });

  it('ProjectAttachment.uploadIntentUlid preserves the intent', async () => {
    const intentUlid = 'ULIDATT1';
    const prisma = buildPrisma({
      intents: [
        seed({ ulid: intentUlid, status: 'CONFIRMED', confirmedAt: past(2 * 60 * 60 * 1000) }),
      ],
      projectAttachments: [
        { id: 'pa-1', deletedAt: null, uploadIntentUlid: intentUlid },
      ],
    });
    const res = await postSweep(buildApp(prisma));

    expect(res.status).toBe(200);
    expect(res.body.expiredFromConfirmed).toBe(0);
    expect(res.body.blobsCleaned).toBe(0);
    expect(res.body.preservedByPhotoRef).toBeGreaterThanOrEqual(1);
    expect(mockDeleteBlobCalls).toHaveLength(0);
    expect(prisma._intents[0].status).toBe('CONFIRMED');
  });

  it('BillingCertification.uploadIntentUlid preserves the intent', async () => {
    const intentUlid = 'ULIDBILL1';
    const prisma = buildPrisma({
      intents: [
        seed({ ulid: intentUlid, status: 'CONFIRMED', confirmedAt: past(2 * 60 * 60 * 1000) }),
      ],
      billingCertifications: [
        { id: 'bc-1', deletedAt: null, uploadIntentUlid: intentUlid },
      ],
    });
    const res = await postSweep(buildApp(prisma));

    expect(res.status).toBe(200);
    expect(res.body.expiredFromConfirmed).toBe(0);
    expect(res.body.blobsCleaned).toBe(0);
    expect(res.body.preservedByPhotoRef).toBeGreaterThanOrEqual(1);
    expect(mockDeleteBlobCalls).toHaveLength(0);
    expect(prisma._intents[0].status).toBe('CONFIRMED');
  });
});

describe('SOL DR-001 — referenced-blobPath legacy defence', () => {
  it('Drawing.pdfBlobPath preserves a pre-deploy intent whose uploadIntentUlid is NULL', async () => {
    const legacyBlobPath = 'emp-dr001/legacy-drawing.pdf';
    const prisma = buildPrisma({
      intents: [
        seed({
          ulid: 'LEGACY1',
          status: 'CONFIRMED',
          confirmedAt: past(2 * 60 * 60 * 1000),
          blobPath: legacyBlobPath,
        }),
      ],
      // The legacy drawing has a blobPath but no uploadIntentUlid — this
      // is exactly the pre-deploy row shape the audit warned about.
      drawings: [{ id: 'd-legacy', status: 'ACTIVE', pdfBlobPath: legacyBlobPath }],
    });
    const res = await postSweep(buildApp(prisma));

    expect(res.status).toBe(200);
    expect(res.body.expiredFromConfirmed).toBe(0);
    expect(res.body.blobsCleaned).toBe(0);
    expect(res.body.preservedByPhotoRef).toBeGreaterThanOrEqual(1);
    expect(mockDeleteBlobCalls).toHaveLength(0);
    expect(prisma._intents[0].status).toBe('CONFIRMED');
  });

  it('ProjectAttachment.blobPath preserves a pre-deploy intent', async () => {
    const legacyBlobPath = 'emp-dr001/legacy-attachment.pdf';
    const prisma = buildPrisma({
      intents: [
        seed({
          ulid: 'LEGACY2',
          status: 'CONFIRMED',
          confirmedAt: past(2 * 60 * 60 * 1000),
          blobPath: legacyBlobPath,
        }),
      ],
      projectAttachments: [
        { id: 'pa-legacy', deletedAt: null, blobPath: legacyBlobPath },
      ],
    });
    const res = await postSweep(buildApp(prisma));

    expect(res.status).toBe(200);
    expect(res.body.expiredFromConfirmed).toBe(0);
    expect(res.body.blobsCleaned).toBe(0);
    expect(mockDeleteBlobCalls).toHaveLength(0);
    expect(prisma._intents[0].status).toBe('CONFIRMED');
  });

  it('BillingCertification.blobPath preserves a pre-deploy intent', async () => {
    const legacyBlobPath = 'emp-dr001/legacy-bill.pdf';
    const prisma = buildPrisma({
      intents: [
        seed({
          ulid: 'LEGACY3',
          status: 'CONFIRMED',
          confirmedAt: past(2 * 60 * 60 * 1000),
          blobPath: legacyBlobPath,
        }),
      ],
      billingCertifications: [
        { id: 'bc-legacy', deletedAt: null, blobPath: legacyBlobPath },
      ],
    });
    const res = await postSweep(buildApp(prisma));

    expect(res.status).toBe(200);
    expect(res.body.expiredFromConfirmed).toBe(0);
    expect(res.body.blobsCleaned).toBe(0);
    expect(mockDeleteBlobCalls).toHaveLength(0);
    expect(prisma._intents[0].status).toBe('CONFIRMED');
  });
});

describe('SOL DR-001 — lifecycle exclusions on the legacy defence', () => {
  it('SUPERSEDED drawings do NOT preserve their intent (the successor is the active row)', async () => {
    const legacyBlobPath = 'emp-dr001/superseded.pdf';
    const prisma = buildPrisma({
      intents: [
        seed({
          ulid: 'SUPERSEDED1',
          status: 'CONFIRMED',
          confirmedAt: past(2 * 60 * 60 * 1000),
          blobPath: legacyBlobPath,
        }),
      ],
      // The drawing was superseded → its bytes are no longer in active
      // use by the stamp UI; a successor row carries the audit chain.
      drawings: [{ id: 'd-sup', status: 'SUPERSEDED', pdfBlobPath: legacyBlobPath }],
    });
    const res = await postSweep(buildApp(prisma));

    expect(res.status).toBe(200);
    // The bytes are fair game for the sweep now — the successor
    // drawing is what counts, and its pdfBlobPath points elsewhere.
    expect(res.body.expiredFromConfirmed).toBe(1);
    expect(res.body.blobsCleaned).toBe(1);
    expect(mockDeleteBlobCalls).toHaveLength(1);
  });

  it('soft-deleted ProjectAttachment does NOT preserve its intent', async () => {
    const archivedBlobPath = 'emp-dr001/archived.pdf';
    const prisma = buildPrisma({
      intents: [
        seed({
          ulid: 'ARCHIVED1',
          status: 'CONFIRMED',
          confirmedAt: past(2 * 60 * 60 * 1000),
          blobPath: archivedBlobPath,
        }),
      ],
      projectAttachments: [
        { id: 'pa-archived', deletedAt: past(60 * 60 * 1000), blobPath: archivedBlobPath },
      ],
    });
    const res = await postSweep(buildApp(prisma));

    expect(res.status).toBe(200);
    expect(res.body.expiredFromConfirmed).toBe(1);
    expect(res.body.blobsCleaned).toBe(1);
  });

  it('soft-deleted BillingCertification does NOT preserve its intent', async () => {
    const archivedBlobPath = 'emp-dr001/archived-bill.pdf';
    const prisma = buildPrisma({
      intents: [
        seed({
          ulid: 'ARCHIVED2',
          status: 'CONFIRMED',
          confirmedAt: past(2 * 60 * 60 * 1000),
          blobPath: archivedBlobPath,
        }),
      ],
      billingCertifications: [
        { id: 'bc-archived', deletedAt: past(60 * 60 * 1000), blobPath: archivedBlobPath },
      ],
    });
    const res = await postSweep(buildApp(prisma));

    expect(res.status).toBe(200);
    expect(res.body.expiredFromConfirmed).toBe(1);
    expect(res.body.blobsCleaned).toBe(1);
  });
});

describe('SOL DR-001 — response payload exposes both defence-set sizes', () => {
  it('reports photoReferencedCount (widened to new entities) and referencedBlobPathCount', async () => {
    const intentUlid = 'ULIDCOUNT';
    const legacyBlobPath = 'emp-dr001/counted.pdf';
    const prisma = buildPrisma({
      intents: [],
      dprPhotos: [{ ulid: 'ULIDA' }],
      inspectionPhotos: [{ ulid: 'ULIDB' }],
      drawings: [{ id: 'd-cnt', status: 'ACTIVE', uploadIntentUlid: intentUlid, pdfBlobPath: legacyBlobPath }],
      projectAttachments: [{ id: 'pa-cnt', deletedAt: null, uploadIntentUlid: 'ULIDPA' }],
      billingCertifications: [{ id: 'bc-cnt', deletedAt: null, uploadIntentUlid: 'ULIDBC', blobPath: 'emp-dr001/other.pdf' }],
    });
    const res = await postSweep(buildApp(prisma));

    expect(res.status).toBe(200);
    // photoReferencedCount = 2 (dpr_photo + inspection_photo) + 3 (the
    // three new entities' uploadIntentUlid columns). The widening is
    // intentional: the field name is kept for back-compat with DR-002
    // dashboards but it now covers all five reference sources.
    expect(res.body.photoReferencedCount).toBe(5);
    expect(res.body.referencedBlobPathCount).toBeGreaterThanOrEqual(2);
  });
});

describe('SOL DR-001 — fatal abort on lookup failure', () => {
  it('returns 503 when Drawing.findMany throws (must NEVER be a silent skip)', async () => {
    const prisma = buildPrisma({ intents: [] });
    prisma.drawing.findMany.mockRejectedValueOnce(new Error('db down'));
    const res = await postSweep(buildApp(prisma));

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('REFERENCED_ULID_LOOKUP_FAILED');
  });

  it('returns 503 when ProjectAttachment model is missing from prisma', async () => {
    const prisma = buildPrisma({ intents: [] });
    delete prisma.projectAttachment;
    const res = await postSweep(buildApp(prisma));

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('REFERENCED_ULID_LOOKUP_FAILED');
  });

  it('returns 503 when BillingCertification.findMany throws', async () => {
    const prisma = buildPrisma({ intents: [] });
    prisma.billingCertification.findMany.mockRejectedValueOnce(new Error('db down'));
    const res = await postSweep(buildApp(prisma));

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('REFERENCED_ULID_LOOKUP_FAILED');
  });

  it('returns 503 when the legacy blobPath defence lookup fails (Drawing.findMany)', async () => {
    // The uploadIntentUlid pre-collect succeeds for all five sources
    // (drawing returns []), but the legacy blobPath defence queries
    // Drawing with a `where` clause — a throw there must abort the
    // sweep with a distinct error code so an operator can tell which
    // half of the defence failed.
    const prisma = buildPrisma({ intents: [] });
    // First call = uploadIntentUlid pre-collect (returns []), second
    // call = blobPath pre-collect (must throw).
    let drawingCalls = 0;
    prisma.drawing.findMany = jest.fn(async () => {
      drawingCalls += 1;
      if (drawingCalls > 1) throw new Error('blobPath lookup down');
      return [];
    });
    const res = await postSweep(buildApp(prisma));

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('REFERENCED_BLOBPATH_LOOKUP_FAILED');
  });
});

describe('SOL DR-001 — happy path remains identical when defences are empty', () => {
  it('a CONFIRMED orphan with no references is still swept', async () => {
    const prisma = buildPrisma({
      intents: [
        seed({ ulid: 'ORPHAN1', status: 'CONFIRMED', confirmedAt: past(2 * 60 * 60 * 1000) }),
      ],
    });
    const res = await postSweep(buildApp(prisma));

    expect(res.status).toBe(200);
    expect(res.body.expiredFromConfirmed).toBe(1);
    expect(res.body.blobsCleaned).toBe(1);
    expect(mockDeleteBlobCalls).toHaveLength(1);
  });
});
