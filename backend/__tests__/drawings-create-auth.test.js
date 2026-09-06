// Round-31 — POST /api/drawings auth posture.
//
// Prior posture: POST/PATCH/DELETE were all requireFreshAdmin. Round-31
// loosens POST to requireAuth so a field engineer can upload a fresh
// drawing PDF without bouncing to an admin. PATCH and DELETE stay
// requireFreshAdmin because editing metadata / archiving a drawing is
// curation (hides a revision from a future DPR's stamp picker).
//
// The auto-stamp behavior (issuedById defaults to req.employeeId when
// omitted) is also pinned — without it, employee-uploaded drawings
// would silently have issuedById=null, defeating the Round-30
// ?scope=assigned union for Drawing.issuedById.
//
// Coverage matrix:
//   1. POST as non-admin employee  → 201, issuedById auto-stamped
//   2. POST as non-admin with explicit issuedById === self → 201
//   3. POST as non-admin with explicit issuedById !== self → 403 CANNOT_ISSUE_ON_BEHALF
//   4. POST as admin → 201 (regression guard, still works)
//   5. POST without issuedById → 201 with issuedById = req.employeeId
//   6. PATCH /api/drawings/:id as non-admin → 401 or 403 (still admin-only)
//   7. DELETE /api/drawings/:id as non-admin → 401 or 403 (still admin-only)
//   8. PATCH as admin → 200 (regression guard)
//   9. DELETE as admin → 200 (soft-deletes to SUPERSEDED)

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
require('express-async-errors');

const drawingsRouter = require('../src/routes/drawings');

// All four need to be valid UUIDs because the drawings.js validator runs
// isValidUuid on projectId / supersedesId / issuedById before the handler
// ever sees the row. We use 4xxx for employee ids (RFC4122 random/v4) and
// 8xxx for fixed-resource ids (project / drawing fixtures).
const ADMIN_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '55555555-5555-4555-8555-555555555555';
const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DRAWING_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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

// The drawing route handler calls `prisma.$transaction(async (tx) => ...)`
// for the supersedes flip + new row insert. We make $transaction just call
// its callback with `tx` aliased to the same prisma surface — the create
// call hits the in-memory Map, the update flips status=SUPERSEDED on the
// seeded predecessor row. The auth middleware's requireFreshAdmin also
// hits `prisma.employee.findUnique` and reads `isAdmin` from the result.
function buildApp() {
  const app = express();
  app.use(express.json());
  const drawingRows = new Map();
  let createdSeq = 0;
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
        const id = `draw-${createdSeq}`;
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
    },
    employee: {
      // requireFreshAdmin calls .findUnique with select { id, isAdmin }.
      // We branch on the requested id: ADMIN_ID is admin, USER_ID isn't.
      findUnique: jest.fn(async ({ where, select }) => {
        const id = where.id;
        const isAdmin = id === ADMIN_ID;
        const out = { id, isAdmin };
        if (select && select.name) out.name = 'X';
        if (select && select.email) out.email = 'x@x';
        return out;
      }),
    },
    // Delegate $transaction(cb) so tx.drawing.create and tx.drawing.update
    // hit the same mocks above. The supersedes flip + new row insert are
    // both in-memory writes against drawingRows.
    $transaction: jest.fn(async (cb) => {
      return cb(prisma);
    }),
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

const baseBody = {
  projectId: PROJECT_ID,
  drawingNumber: 'ARCH-001',
  title: 'Floor plan L1',
  revision: '0',
};

// ─── POST loosened to requireAuth ───────────────────────────────────────────
describe('Round-31 — POST /api/drawings (loosened to requireAuth)', () => {
  it('1. POST as non-admin employee → 201 with issuedById auto-stamped', async () => {
    const { app, prisma } = buildApp();
    const res = await request(app)
      .post('/api/drawings')
      .set('Authorization', userJwt())
      .send(baseBody);
    expect(res.status).toBe(201);
    expect(res.body.issuedById).toBe(USER_ID);
    // The create call must include the auto-stamped id (not null).
    expect(prisma.drawing.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ issuedById: USER_ID }),
      }),
    );
  });

  it('2. POST as non-admin with explicit issuedById === self → 201', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/drawings')
      .set('Authorization', userJwt())
      .send({ ...baseBody, issuedById: USER_ID });
    expect(res.status).toBe(201);
    expect(res.body.issuedById).toBe(USER_ID);
  });

  it('3. POST as non-admin with explicit issuedById !== self → 403 CANNOT_ISSUE_ON_BEHALF', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/drawings')
      .set('Authorization', userJwt())
      .send({ ...baseBody, issuedById: ADMIN_ID });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CANNOT_ISSUE_ON_BEHALF');
  });

  it('4. POST as admin → 201 (regression guard, admin still works)', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/drawings')
      .set('Authorization', adminJwt())
      .send(baseBody);
    expect(res.status).toBe(201);
    expect(res.body.issuedById).toBe(ADMIN_ID);
  });

  it('5. POST without issuedById → server stamps req.employeeId', async () => {
    // The body intentionally OMITS issuedById. Both admin and non-admin
    // callers should see their own employeeId in the resulting row.
    const { app: appA, prisma: prismaA } = buildApp();
    const resA = await request(appA)
      .post('/api/drawings')
      .set('Authorization', userJwt())
      .send(baseBody);
    expect(resA.status).toBe(201);
    expect(prismaA.drawing.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ issuedById: USER_ID }),
      }),
    );

    const { app: appB, prisma: prismaB } = buildApp();
    const resB = await request(appB)
      .post('/api/drawings')
      .set('Authorization', adminJwt())
      .send(baseBody);
    expect(resB.status).toBe(201);
    expect(prismaB.drawing.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ issuedById: ADMIN_ID }),
      }),
    );
  });
});

// ─── PATCH + DELETE stay admin-only ─────────────────────────────────────────
describe('Round-31 — PATCH / DELETE still requireFreshAdmin', () => {
  it('6. PATCH as non-admin → 401 or 403 (still admin-only)', async () => {
    const { app, drawingRows } = buildApp();
    drawingRows.set(DRAWING_ID, {
      id: DRAWING_ID, projectId: PROJECT_ID, drawingNumber: 'X',
      title: 't', revision: '0', status: 'ACTIVE', issuedById: USER_ID,
      pdfBlobPath: null, supersedesId: null,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await request(app)
      .patch(`/api/drawings/${DRAWING_ID}`)
      .set('Authorization', userJwt())
      .send({ title: 'tampered' });
    expect([401, 403]).toContain(res.status);
  });

  it('7. DELETE as non-admin → 401 or 403 (still admin-only)', async () => {
    const { app, drawingRows } = buildApp();
    drawingRows.set(DRAWING_ID, {
      id: DRAWING_ID, projectId: PROJECT_ID, drawingNumber: 'X',
      title: 't', revision: '0', status: 'ACTIVE', issuedById: USER_ID,
      pdfBlobPath: null, supersedesId: null,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await request(app)
      .delete(`/api/drawings/${DRAWING_ID}`)
      .set('Authorization', userJwt());
    expect([401, 403]).toContain(res.status);
  });

  it('8. PATCH as admin → 200 (regression guard)', async () => {
    const { app, drawingRows } = buildApp();
    drawingRows.set(DRAWING_ID, {
      id: DRAWING_ID, projectId: PROJECT_ID, drawingNumber: 'X',
      title: 't', revision: '0', status: 'ACTIVE', issuedById: USER_ID,
      pdfBlobPath: null, supersedesId: null,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await request(app)
      .patch(`/api/drawings/${DRAWING_ID}`)
      .set('Authorization', adminJwt())
      .send({ title: 'edited by admin' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('edited by admin');
  });

  it('9. DELETE as admin → 200 (regression guard, soft-deletes to SUPERSEDED)', async () => {
    const { app, drawingRows } = buildApp();
    drawingRows.set(DRAWING_ID, {
      id: DRAWING_ID, projectId: PROJECT_ID, drawingNumber: 'X',
      title: 't', revision: '0', status: 'ACTIVE', issuedById: USER_ID,
      pdfBlobPath: null, supersedesId: null,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await request(app)
      .delete(`/api/drawings/${DRAWING_ID}`)
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    expect(drawingRows.get(DRAWING_ID).status).toBe('SUPERSEDED');
  });
});
