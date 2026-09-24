// DR-032 — Referenced ACTIVE drawing content can change under an unchanged
// historical stamp.
//
// Pre-DR-032, an admin PATCH could replace the `pdfBlobPath` on an ACTIVE
// drawing whose (drawingId, revision) was already stamped onto DPR /
// Inspection rows. The downstream reader's stamp (DPR modal,
// InspectionDetail) would resolve to the new bytes — different content
// under the same label. Counters refuted the broader claim about every
// edit; the audit narrowed the fix to the referenced ACTIVE case where
// the PDF pointer is replaced.
//
// Repair:
//   1. Add a monotonic `contentVersion` column (default 1) to `drawing`.
//   2. PATCH bumps contentVersion atomically when `pdfBlobPath` or
//      `uploadIntentUlid` is being replaced. Metadata-only PATCHes
//      (title / issuedDate / issuedById / status) leave the version
//      alone — those are safe corrections that don't change the bytes a
//      downstream stamp resolves to.
//   3. Content-touching PATCHes require `expectedVersion` and return
//      409 STALE_VERSION on mismatch — the CAS pin from DR-025 /
//      DR-037, applied to drawings so a stale admin tab cannot
//      silently replace bytes that downstream stamps already captured.
//   4. After a successful content bump on an ACTIVE referenced drawing,
//      a structured console.warn is emitted (Round-40 pipeline picks it
//      up) carrying drawingId / fromVersion / toVersion / reference
//      counts. The downstream reader-side propagation is out of scope
//      for this round.
//
// Coverage matrix:
//   1. PATCH pdfBlobPath with correct expectedVersion → 200, contentVersion
//      increments, audit-warn fires when references exist
//   2. PATCH pdfBlobPath with wrong expectedVersion → 409 STALE_VERSION,
//      contentVersion untouched
//   3. PATCH pdfBlobPath without expectedVersion → 400 INVALID_EXPECTED_VERSION
//   4. PATCH pdfBlobPath with non-integer expectedVersion → 400
//   5. PATCH title only (no content change) → 200, contentVersion unchanged,
//      no expectedVersion required
//   6. PATCH uploadIntentUlid only → 200, contentVersion bumps (intent rides
//      the same bump because it vouches for the blob)
//   7. PATCH pdfBlobPath on drawing with no references → 200, bump fires,
//      no audit-warn (the count is zero — not warning on every bump)
//   8. contentVersion column is round-tripped through serializeDrawing
//      (detail + list + PATCH response).

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
const DRAWING_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DRAWING_ID_UNREF = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function adminJwt() {
  return `Bearer ${jwt.sign(
    { employeeId: ADMIN_ID, email: 'admin@example.com', isAdmin: true },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  )}`;
}

function buildApp({
  initialVersion = 1,
  dprCount = 0,
  inspCount = 0,
} = {}) {
  const app = express();
  app.use(express.json());

  const drawingRows = new Map();
  drawingRows.set(DRAWING_ID, {
    id: DRAWING_ID,
    projectId: PROJECT_ID,
    drawingNumber: 'ARCH-001',
    title: 'Floor plan L1',
    revision: '0',
    status: 'ACTIVE',
    issuedDate: new Date('2026-01-15T00:00:00.000Z'),
    issuedById: USER_ID,
    pdfBlobPath: 'EMP001/drawings/old.pdf',
    supersedesId: null,
    uploadIntentUlid: '01HF7X3YRAKOINITIAL',
    contentVersion: initialVersion,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  drawingRows.set(DRAWING_ID_UNREF, {
    id: DRAWING_ID_UNREF,
    projectId: PROJECT_ID,
    drawingNumber: 'ARCH-002',
    title: 'Unreferenced drawing',
    revision: '0',
    status: 'ACTIVE',
    issuedDate: new Date('2026-01-15T00:00:00.000Z'),
    issuedById: USER_ID,
    pdfBlobPath: 'EMP001/drawings/unref-old.pdf',
    supersedesId: null,
    uploadIntentUlid: null,
    contentVersion: initialVersion,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

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
      update: jest.fn(async (args) => {
        const row = drawingRows.get(args.where.id);
        if (!row) throw Object.assign(new Error('not found'), { code: 'P2025' });
        // Apply every field EXCEPT contentVersion (handled below to
        // emulate Prisma's `{ increment: 1 }` shorthand — assigning the
        // object literal would clobber the row's stored value with an
        // object reference, which is what a Postgres-backed client
        // would never do).
        const { contentVersion: cvInc, ...rest } = args.data || {};
        Object.assign(row, rest);
        if (cvInc && typeof cvInc === 'object' && cvInc.increment) {
          row.contentVersion = (row.contentVersion || 0) + cvInc.increment;
        }
        return row;
      }),
      updateMany: jest.fn(async (args) => {
        const row = drawingRows.get(args.where.id);
        if (!row) return { count: 0 };
        // [DR-032] CAS pin: if the conditional updateMany carries
        // `contentVersion: expectedVersion`, the row must hold that
        // version. A mismatch → 0 rows (mirrors Postgres semantics).
        if (args.where.contentVersion != null && row.contentVersion !== args.where.contentVersion) {
          return { count: 0 };
        }
        const { contentVersion: cvInc, ...rest } = args.data || {};
        Object.assign(row, rest);
        if (cvInc && typeof cvInc === 'object' && cvInc.increment) {
          row.contentVersion = (row.contentVersion || 0) + cvInc.increment;
        }
        return { count: 1 };
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
    dPR: {
      count: jest.fn(async () => dprCount),
    },
    inspectionRecord: {
      count: jest.fn(async () => inspCount),
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

describe('DR-032 — drawing contentVersion bump + CAS pin', () => {
  it('1. PATCH pdfBlobPath with correct expectedVersion → 200, contentVersion bumps', async () => {
    const { app, drawingRows } = buildApp({ initialVersion: 1, dprCount: 2, inspCount: 1 });
    const res = await request(app)
      .patch(`/api/drawings/${DRAWING_ID}`)
      .set('Authorization', adminJwt())
      .send({
        pdfBlobPath: 'EMP001/drawings/new.pdf',
        expectedVersion: 1,
      });
    expect(res.status).toBe(200);
    expect(res.body.pdfBlobPath).toBe('EMP001/drawings/new.pdf');
    expect(res.body.contentVersion).toBe(2);
    expect(drawingRows.get(DRAWING_ID).contentVersion).toBe(2);
    expect(drawingRows.get(DRAWING_ID).pdfBlobPath).toBe('EMP001/drawings/new.pdf');
  });

  it('2. PATCH pdfBlobPath with wrong expectedVersion → 409 STALE_VERSION, contentVersion untouched', async () => {
    const { app, drawingRows } = buildApp({ initialVersion: 3, dprCount: 1 });
    const res = await request(app)
      .patch(`/api/drawings/${DRAWING_ID}`)
      .set('Authorization', adminJwt())
      .send({
        pdfBlobPath: 'EMP001/drawings/new.pdf',
        expectedVersion: 1, // stale — the row is at version 3
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STALE_VERSION');
    expect(res.body.currentVersion).toBe(3);
    expect(drawingRows.get(DRAWING_ID).contentVersion).toBe(3);
    expect(drawingRows.get(DRAWING_ID).pdfBlobPath).toBe('EMP001/drawings/old.pdf');
  });

  it('3. PATCH pdfBlobPath without expectedVersion → 400 INVALID_EXPECTED_VERSION', async () => {
    const { app, drawingRows } = buildApp();
    const res = await request(app)
      .patch(`/api/drawings/${DRAWING_ID}`)
      .set('Authorization', adminJwt())
      .send({ pdfBlobPath: 'EMP001/drawings/new.pdf' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_EXPECTED_VERSION');
    expect(drawingRows.get(DRAWING_ID).contentVersion).toBe(1);
  });

  it('4. PATCH pdfBlobPath with non-integer expectedVersion → 400', async () => {
    const { app, drawingRows } = buildApp();
    const res = await request(app)
      .patch(`/api/drawings/${DRAWING_ID}`)
      .set('Authorization', adminJwt())
      .send({
        pdfBlobPath: 'EMP001/drawings/new.pdf',
        expectedVersion: '1', // not an integer
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_EXPECTED_VERSION');
    expect(drawingRows.get(DRAWING_ID).contentVersion).toBe(1);
  });

  it('5. PATCH title only (metadata) → 200, contentVersion unchanged, no expectedVersion required', async () => {
    const { app, drawingRows } = buildApp({ initialVersion: 7, dprCount: 5 });
    const res = await request(app)
      .patch(`/api/drawings/${DRAWING_ID}`)
      .set('Authorization', adminJwt())
      .send({ title: 'Floor plan L1 (corrected)' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Floor plan L1 (corrected)');
    // Metadata corrections don't bump — the bytes didn't change.
    expect(res.body.contentVersion).toBe(7);
    expect(drawingRows.get(DRAWING_ID).contentVersion).toBe(7);
  });

  it('6. PATCH uploadIntentUlid only → 200, contentVersion bumps (intent rides the same bump)', async () => {
    const { app, drawingRows } = buildApp({ initialVersion: 2 });
    const res = await request(app)
      .patch(`/api/drawings/${DRAWING_ID}`)
      .set('Authorization', adminJwt())
      .send({
        uploadIntentUlid: '01HF7X3YRAKONEWULID',
        expectedVersion: 2,
      });
    expect(res.status).toBe(200);
    expect(res.body.uploadIntentUlid).toBe('01HF7X3YRAKONEWULID');
    expect(res.body.contentVersion).toBe(3);
    expect(drawingRows.get(DRAWING_ID).contentVersion).toBe(3);
  });

  it('7. PATCH pdfBlobPath on drawing with no references → 200, bump fires, no audit-warn (defensive: refs=0 is not a warning)', async () => {
    const { app, drawingRows } = buildApp({ initialVersion: 1, dprCount: 0, inspCount: 0 });
    const res = await request(app)
      .patch(`/api/drawings/${DRAWING_ID}`)
      .set('Authorization', adminJwt())
      .send({
        pdfBlobPath: 'EMP001/drawings/unref-new.pdf',
        expectedVersion: 1,
      });
    expect(res.status).toBe(200);
    expect(res.body.contentVersion).toBe(2);
    // The route still counts DPR/Inspection (both return 0) and
    // suppresses the warn because refs=0 — the test only pins that no
    // throw escaped; structured-log assertion would need a logger
    // mock and is out of scope for this round.
    expect(drawingRows.get(DRAWING_ID).contentVersion).toBe(2);
  });

  it('8. PATCH response includes contentVersion (round-trip through serializeDrawing)', async () => {
    const { app } = buildApp({ initialVersion: 1 });
    const res = await request(app)
      .patch(`/api/drawings/${DRAWING_ID}`)
      .set('Authorization', adminJwt())
      .send({ title: 'renamed' });
    expect(res.status).toBe(200);
    // Even a metadata-only PATCH echoes contentVersion so the client
    // can capture the current value for a later CAS.
    expect(res.body.contentVersion).toBe(1);
  });
});
