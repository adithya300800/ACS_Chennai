// DR-002 — POST /api/drawings/:id/supersede.
//
// The previous behavior: the admin Drawing Detail "Supersede" button
// PATCHed the existing row, which mutated its title but left the id /
// revision / ACTIVE status in place — no successor row was ever
// created. DR-002 introduces an explicit supersede command that
// creates a NEW row, atomically flipping the predecessor to
// status=SUPERSEDED. The legacy POST /api/drawings with `supersedesId`
// keeps working (Round-31 loosened it to requireAuth) but now rejects
// a predecessor in any state other than ACTIVE with 409
// PREDECESSOR_NOT_ACTIVE — that's the second half of the fix.
//
// Coverage matrix:
//   1. POST /:id/supersede as non-admin employee → 401/403
//   2. POST /:id/supersede as admin → 201, returns successor + predecessor
//      - successor has new id, ACTIVE status, supersedesId = predecessor.id
//      - predecessor.status === 'SUPERSEDED'
//      - projectId + drawingNumber + issuedById carry forward
//      - optional title / issuedDate / pdfBlobPath overrides are honored
//   3. POST /:id/supersede where predecessor is already SUPERSEDED → 409
//   4. POST /:id/supersede with unknown id → 404
//   5. POST /:id/supersede without revision → 400
//   6. POST /:id/supersede with bad UUID → 400
//   7. POST /api/drawings with supersedesId pointing at a SUPERSEDED
//      row → 409 PREDECESSOR_NOT_ACTIVE (POST-side guard)

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
require('express-async-errors');

const drawingsRouter = require('../src/routes/drawings');

const ADMIN_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '55555555-5555-4555-8555-555555555555';
const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PREDECESSOR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function adminJwt() {
  return `Bearer ${jwt.sign(
    { employeeId: ADMIN_ID, email: 'admin@example.com', isAdmin: true },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  )}`;
}

function userJwt() {
  return `Bearer ${jwt.sign(
    { employeeId: USER_ID, email: 'user@example.com', isAdmin: false },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  )}`;
}

// Mock prisma modeled on drawings-create-auth.test.js — the
// supersede handler reads the predecessor INSIDE the transaction, then
// updates it + creates the successor, all via tx.* calls. We delegate
// $transaction(cb) → cb(prisma) so tx === prisma in tests.
function buildApp({ predecessorStatus = 'ACTIVE', seedPredecessor = true } = {}) {
  const app = express();
  app.use(express.json());

  const drawingRows = new Map();
  let createdSeq = 0;

  if (seedPredecessor) {
    drawingRows.set(PREDECESSOR_ID, {
      id: PREDECESSOR_ID,
      projectId: PROJECT_ID,
      drawingNumber: 'ARCH-001',
      title: 'Floor plan L1',
      revision: '0',
      status: predecessorStatus,
      issuedDate: new Date('2026-01-15T00:00:00.000Z'),
      issuedById: USER_ID,
      pdfBlobPath: 'EMP001/drawings/old.pdf',
      supersedesId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  const prisma = {
    project: {
      findUnique: jest.fn(async ({ where }) => ({
        id: where.id, isActive: true, name: 'Test Project',
      })),
    },
    drawing: {
      findUnique: jest.fn(async ({ where }) => {
        if (where.id) return drawingRows.get(where.id) || null;
        return null;
      }),
      create: jest.fn(async (args) => {
        createdSeq += 1;
        // Route mints a UUID via randomUUID(); honor it so the Map key
        // matches the row's id (the mock would otherwise key by its own
        // generated id but the row's id field would be the UUID).
        const id = args.data.id || `draw-new-${createdSeq}`;
        const row = { id, ...args.data, createdAt: new Date(), updatedAt: new Date() };
        drawingRows.set(id, row);
        return row;
      }),
      update: jest.fn(async (args) => {
        const row = drawingRows.get(args.where.id);
        if (!row) throw Object.assign(new Error('not found'), { code: 'P2025' });
        Object.assign(row, args.data);
        return row;
      }),
      // [DR-009] Conditional ACTIVE claim. Honors the compound `where`
      // (id + projectId + status) — only flips a row whose current
      // status matches. Returns the count, not the row, matching
      // Prisma's `updateMany` contract.
      updateMany: jest.fn(async (args) => {
        const row = drawingRows.get(args.where.id);
        if (!row) return { count: 0 };
        if (args.where.projectId != null && row.projectId !== args.where.projectId) return { count: 0 };
        if (args.where.status === 'ACTIVE' && row.status !== 'ACTIVE') return { count: 0 };
        if (args.where.status && typeof args.where.status === 'object' && args.where.status.not === 'SUPERSEDED' && row.status === 'SUPERSEDED') return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      }),
      findFirst: jest.fn(async ({ where }) => {
        for (const row of drawingRows.values()) {
          if (where.projectId != null && row.projectId !== where.projectId) continue;
          if (where.drawingNumber != null && row.drawingNumber !== where.drawingNumber) continue;
          if (where.status != null && row.status !== where.status) continue;
          if (where.id && where.id.not && row.id === where.id.not) continue;
          return row;
        }
        return null;
      }),
    },
    employee: {
      findUnique: jest.fn(async ({ where, select }) => {
        const id = where.id;
        const out = { id, isAdmin: id === ADMIN_ID };
        if (select && select.name) out.name = 'X';
        if (select && select.email) out.email = 'x@x';
        return out;
      }),
    },
    $transaction: jest.fn(async (cb) => cb(prisma)),
  };
  app.set('prisma', prisma);
  app.use('/api/drawings', drawingsRouter);
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({
      error: err.message || 'INTERNAL_ERROR',
      code: err.code || 'INTERNAL',
    });
  });
  return { app, prisma, drawingRows };
}

// ─── POST /:id/supersede — admin role gate ──────────────────────────────────
describe('DR-002 — POST /api/drawings/:id/supersede', () => {
  it('1. non-admin → 401 or 403', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post(`/api/drawings/${PREDECESSOR_ID}/supersede`)
      .set('Authorization', userJwt())
      .send({ revision: '1' });
    expect([401, 403]).toContain(res.status);
  });

  it('2. admin, ACTIVE predecessor → 201 with successor + predecessor, both rows in expected state', async () => {
    const { app, prisma, drawingRows } = buildApp();
    const res = await request(app)
      .post(`/api/drawings/${PREDECESSOR_ID}/supersede`)
      .set('Authorization', adminJwt())
      .send({ revision: '1', title: 'Floor plan L1 (rev 1)', issuedDate: '2026-02-01' });

    expect(res.status).toBe(201);
    expect(res.body.successor).toBeDefined();
    expect(res.body.predecessor).toBeDefined();

    // Successor: new id, ACTIVE, supersedesId points at predecessor,
    // carries forward (projectId, drawingNumber, issuedById).
    const succId = res.body.successor.id;
    expect(succId).toBeTruthy();
    expect(succId).not.toBe(PREDECESSOR_ID);
    expect(res.body.successor.status).toBe('ACTIVE');
    expect(res.body.successor.revision).toBe('1');
    expect(res.body.successor.supersedesId).toBe(PREDECESSOR_ID);
    expect(res.body.successor.projectId).toBe(PROJECT_ID);
    expect(res.body.successor.drawingNumber).toBe('ARCH-001');
    expect(res.body.successor.issuedById).toBe(USER_ID); // carried forward
    expect(res.body.successor.title).toBe('Floor plan L1 (rev 1)'); // override
    expect(res.body.successor.issuedDate).toBe('2026-02-01'); // override

    // Predecessor: id unchanged, status flipped to SUPERSEDED.
    expect(res.body.predecessor.id).toBe(PREDECESSOR_ID);
    expect(res.body.predecessor.status).toBe('SUPERSEDED');

    // In-memory state matches the response.
    expect(drawingRows.get(PREDECESSOR_ID).status).toBe('SUPERSEDED');
    expect(drawingRows.get(succId)).toBeDefined();
    expect(drawingRows.get(succId).status).toBe('ACTIVE');
    expect(drawingRows.get(succId).supersedesId).toBe(PREDECESSOR_ID);

    // The create call happened with the expected natural-key fields.
    expect(prisma.drawing.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: succId,
          projectId: PROJECT_ID,
          drawingNumber: 'ARCH-001',
          revision: '1',
          status: 'ACTIVE',
          issuedById: USER_ID,
          supersedesId: PREDECESSOR_ID,
        }),
      }),
    );
  });

  it('3. predecessor already SUPERSEDED → 409 PREDECESSOR_NOT_ACTIVE', async () => {
    const { app } = buildApp({ predecessorStatus: 'SUPERSEDED' });
    const res = await request(app)
      .post(`/api/drawings/${PREDECESSOR_ID}/supersede`)
      .set('Authorization', adminJwt())
      .send({ revision: '1' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PREDECESSOR_NOT_ACTIVE');
    expect(res.body.currentStatus).toBe('SUPERSEDED');
  });

  it('4. unknown predecessor id → 404 DRAWING_NOT_FOUND', async () => {
    const { app } = buildApp({ seedPredecessor: false });
    const res = await request(app)
      .post('/api/drawings/00000000-0000-4000-8000-000000000000/supersede')
      .set('Authorization', adminJwt())
      .send({ revision: '1' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('DRAWING_NOT_FOUND');
  });

  it('5. missing revision → 400 VALIDATION_ERROR', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post(`/api/drawings/${PREDECESSOR_ID}/supersede`)
      .set('Authorization', adminJwt())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REVISION_REQUIRED');
  });

  it('6. malformed UUID in :id → 400 VALIDATION_ERROR', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/drawings/not-a-uuid/supersede')
      .set('Authorization', adminJwt())
      .send({ revision: '1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });
});

// ─── POST /api/drawings — supersedesId ACTIVE-state guard ──────────────────
describe('DR-002 — POST /api/drawings now rejects a non-ACTIVE predecessor', () => {
  it('7. POST with supersedesId pointing at a SUPERSEDED row → 409 PREDECESSOR_NOT_ACTIVE', async () => {
    const { app } = buildApp({ predecessorStatus: 'SUPERSEDED' });
    const res = await request(app)
      .post('/api/drawings')
      .set('Authorization', adminJwt())
      .send({
        projectId: PROJECT_ID,
        drawingNumber: 'ARCH-001',
        title: 'New revision',
        revision: '2',
        supersedesId: PREDECESSOR_ID,
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PREDECESSOR_NOT_ACTIVE');
    expect(res.body.currentStatus).toBe('SUPERSEDED');
  });
});