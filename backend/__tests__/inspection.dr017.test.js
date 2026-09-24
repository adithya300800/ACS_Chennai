// SOL DR-017 — Resuming an already-linked inspection draft must NOT
// clear its DPR link.
//
// Audit evidence (ACS-Portal-Fresh-Product-Audit-2026-09-24-71f183a.md,
// DR-017 lines 274-284): the SPA's InspectionSubmit resume flow sends
//   editPayload.dprId = queryDprId || null
// and most resumes don't carry a `?dpr=` deep-link (the resume URL is
// just `?draftId=<id>`). Every save therefore PUTs `dprId: null` and
// the data spread silently nulled the FK on every save, breaking
// supported cross-engineer associations.
//
// Minimal implementation: the PUT handler now ignores a stray
// `dprId: null` unless the explicit `unlinkDpr: true` sentinel is
// also present. A legitimate relink still works (UUID + existence
// validation). An explicit unlink also still works. The existing
// dprId is preserved on a plain resume save.
//
// Acceptance (audit): "Resume a linked draft without a `dpr` query
// parameter, edit weather or notes, save, and retain its original DPR
// link."

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const inspectionRouter = require('../src/routes/inspection');

const OWNER_ID = 'emp-dr017-owner';

// Shared in-memory store. The route runs its PUT inside a transaction
// (withRecordTransaction), so the update mock must mutate the same
// object the test reads.
let records = {};

function seedRecord({ id, dprId = null, status = 'DRAFT' } = {}) {
  records[id] = {
    id,
    projectName: 'Site X',
    projectId: null,
    location: 'Chennai',
    reportDate: new Date('2026-09-04T00:00:00.000Z'),
    weather: 'Sunny',
    contractor: null,
    dprId,
    inspectionType: 'material_inspection',
    data: { qty: 100 },
    severity: null,
    submittedById: OWNER_ID,
    status,
    photos: [],
    submittedBy: { id: OWNER_ID, name: 'Owner', email: 'o@example.com' },
    dpr: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return records[id];
}

function buildApp() {
  const app = express();
  app.use(express.json());

  const store = {
    inspectionRecord: {
      findUnique: async ({ where: { id } }) => records[id] || null,
      update: async ({ where, data }) => {
        const rec = records[where.id];
        if (!rec) {
          const e = new Error('not found');
          e.code = 'P2025';
          throw e;
        }
        Object.assign(rec, data);
        return rec;
      },
    },
  };

  const prisma = {
    inspectionRecord: {
      findUnique: store.inspectionRecord.findUnique,
      update: store.inspectionRecord.update,
    },
    employee: {
      findUnique: async () => ({ id: OWNER_ID, isAdmin: false }),
    },
    // DPR existence check for "set a new link" path. Returns a row
    // only for the seeded UUID so tests can exercise both branches.
    dPR: {
      findUnique: async ({ where }) => {
        if (where.id === 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') {
          return { id: where.id };
        }
        return null;
      },
    },
    boqItem: { findUnique: async () => null },
    project: { findUnique: async () => null, findFirst: async () => null },
    drawing: { findUnique: async () => null, findFirst: async () => null },
    $transaction: async (fn) => fn(store),
  };
  app.set('prisma', prisma);
  app.use('/api/inspection', inspectionRouter);
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({
      error: err.message || 'INTERNAL_ERROR',
      code: err.code || 'INTERNAL',
    });
  });
  return app;
}

function authHeader() {
  const token = jwt.sign(
    { employeeId: OWNER_ID, email: 'o@example.com' },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  );
  return `Bearer ${token}`;
}

beforeEach(() => {
  records = {};
});

describe('SOL DR-017 — Resume preserves the existing dprId link', () => {
  const LINKED_DPR_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  it('PUT without dprId preserves the existing linked DPR (audit acceptance)', async () => {
    const id = 'dr017-resume-preserve';
    seedRecord({ id, dprId: LINKED_DPR_ID, status: 'DRAFT' });
    const app = buildApp();
    // Resume flow: no dprId in body, edit weather only.
    const res = await request(app)
      .put(`/api/inspection/${id}`)
      .set('Authorization', authHeader())
      .send({ weather: 'Cloudy' });
    expect(res.status).toBe(200);
    // The existing link MUST still be present.
    expect(records[id].dprId).toBe(LINKED_DPR_ID);
    expect(records[id].weather).toBe('Cloudy');
  });

  it('PUT with dprId:null (no unlinkDpr) preserves the existing link — the audit\'s exact resume path', async () => {
    const id = 'dr017-resume-null';
    seedRecord({ id, dprId: LINKED_DPR_ID, status: 'DRAFT' });
    const app = buildApp();
    // The audit's exact wire shape: SPA sends dprId: null because
    // there's no ?dpr= deep-link on the resume URL.
    const res = await request(app)
      .put(`/api/inspection/${id}`)
      .set('Authorization', authHeader())
      .send({ weather: 'Cloudy', dprId: null });
    expect(res.status).toBe(200);
    expect(records[id].dprId).toBe(LINKED_DPR_ID);
  });

  it('PUT with empty-string dprId (no unlinkDpr) also preserves the existing link', async () => {
    const id = 'dr017-resume-empty';
    seedRecord({ id, dprId: LINKED_DPR_ID, status: 'OPEN' });
    const app = buildApp();
    const res = await request(app)
      .put(`/api/inspection/${id}`)
      .set('Authorization', authHeader())
      .send({ dprId: '' });
    expect(res.status).toBe(200);
    expect(records[id].dprId).toBe(LINKED_DPR_ID);
  });

  it('unlinkDpr:true clears the link', async () => {
    const id = 'dr017-explicit-unlink';
    seedRecord({ id, dprId: LINKED_DPR_ID, status: 'DRAFT' });
    const app = buildApp();
    const res = await request(app)
      .put(`/api/inspection/${id}`)
      .set('Authorization', authHeader())
      .send({ unlinkDpr: true });
    expect(res.status).toBe(200);
    expect(records[id].dprId).toBeNull();
  });

  it('unlinkDpr:true with a non-null dprId is rejected (contradictory intent)', async () => {
    const id = 'dr017-unlink-conflict';
    seedRecord({ id, dprId: LINKED_DPR_ID, status: 'DRAFT' });
    const app = buildApp();
    const res = await request(app)
      .put(`/api/inspection/${id}`)
      .set('Authorization', authHeader())
      .send({ unlinkDpr: true, dprId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('DPR_UNLINK_CONFLICT');
    expect(records[id].dprId).toBe(LINKED_DPR_ID);
  });

  it('PUT with a valid dprId UUID replaces the link (relink path still works)', async () => {
    const id = 'dr017-relink';
    seedRecord({ id, dprId: LINKED_DPR_ID, status: 'DRAFT' });
    const app = buildApp();
    const NEW_DPR = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const res = await request(app)
      .put(`/api/inspection/${id}`)
      .set('Authorization', authHeader())
      .send({ dprId: NEW_DPR });
    expect(res.status).toBe(200);
    expect(records[id].dprId).toBe(NEW_DPR);
  });

  it('PUT with a non-existent dprId is rejected with 404 DPR_NOT_FOUND', async () => {
    const id = 'dr017-relink-missing';
    seedRecord({ id, dprId: LINKED_DPR_ID, status: 'DRAFT' });
    const app = buildApp();
    const res = await request(app)
      .put(`/api/inspection/${id}`)
      .set('Authorization', authHeader())
      .send({ dprId: 'cccccccc-cccc-cccc-cccc-cccccccccccc' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('DPR_NOT_FOUND');
    expect(records[id].dprId).toBe(LINKED_DPR_ID);
  });

  it('PUT with a malformed dprId is rejected with 400 VALIDATION_ERROR', async () => {
    const id = 'dr017-relink-malformed';
    seedRecord({ id, dprId: LINKED_DPR_ID, status: 'DRAFT' });
    const app = buildApp();
    const res = await request(app)
      .put(`/api/inspection/${id}`)
      .set('Authorization', authHeader())
      .send({ dprId: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect(records[id].dprId).toBe(LINKED_DPR_ID);
  });

  it('unlinkDpr is not persisted as a column on the row (control field stripped)', async () => {
    const id = 'dr017-control-strip';
    seedRecord({ id, dprId: LINKED_DPR_ID, status: 'DRAFT' });
    const app = buildApp();
    const res = await request(app)
      .put(`/api/inspection/${id}`)
      .set('Authorization', authHeader())
      .send({ unlinkDpr: true });
    expect(res.status).toBe(200);
    // If unlinkDpr leaked into the data spread, Prisma would have
    // thrown on an unknown column. The 200 + dprId:null confirms
    // the field was treated as a control and stripped.
    expect(records[id].dprId).toBeNull();
    expect('unlinkDpr' in records[id]).toBe(false);
  });
});