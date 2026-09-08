// SOL DR-006 regression coverage for the inspection route. Mirrors the
// dpr.dr006.test.js quarantine contract: a pre-FK inspection record
// whose `submittedById` is NULL is hidden from non-admins with a 404
// instead of being silently attributed to whoever loads ?draftId=
// first. Admins retain the 200 recovery path.
//
// Same acceptance criteria as dpr.dr006.test.js:
//   - GET /api/inspection/:id, submittedById=null, non-admin → 404
//   - GET /api/inspection/:id, submittedById=null, admin → 200
//   - GET /api/inspection/:id, owner GETs own → 200
//   - GET /api/inspection/:id, probe GETs foreign → 403 (not regressed)

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

jest.mock('../src/lib/blobStorage', () => ({
  generateUploadSASUrl: jest.fn(),
  verifyBlobExists: jest.fn(async () => ({ exists: false })),
  deleteBlob: jest.fn(async () => ({ ok: true })),
  generateReadSASUrl: jest.fn(async () => ({ sasUrl: 'https://r2.example/fake' })),
  CONTENT_TYPE_EXT: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' },
  uploadIntentBinding: { bindPhotoIntents: jest.fn(async () => null) },
}));

const inspectionRouter = require('../src/routes/inspection');

const OWNER_ID = 'emp-dr006i-owner';
const ADMIN_ID = 'emp-dr006i-admin';
const PROBE_ID = 'emp-dr006i-probe';

let records = {};

function seedRecord({
  id,
  submittedById = OWNER_ID,
  status = 'DRAFT',
  inspectionType = 'material_inspection',
  data = { qty: 100 },
} = {}) {
  records[id] = {
    id,
    projectName: 'Site Y',
    location: 'Chennai',
    reportDate: new Date('2026-09-04T00:00:00.000Z'),
    weather: 'Sunny',
    contractor: null,
    dprId: null,
    inspectionType,
    data,
    severity: null,
    submittedById,
    status,
    photos: [],
    submittedBy: submittedById ? { id: submittedById, name: 'Owner', email: 'o@example.com' } : null,
    dpr: null,
    boqItem: null,
    project: null,
    drawing: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return records[id];
}

function buildApp({ isAdmin = false, employeeId = PROBE_ID } = {}) {
  const app = express();
  app.use(express.json());

  const prisma = {
    inspectionRecord: {
      findUnique: async ({ where }) => {
        const row = records[where.id];
        if (!row) return null;
        return { ...row };
      },
    },
    employee: {
      findUnique: async () => ({ id: employeeId, isAdmin }),
    },
  };

  app.set('prisma', prisma);
  app.use('/api/inspection', inspectionRouter);
  return app;
}

function authHeader(employeeId) {
  return jwt.sign(
    { employeeId, email: `${employeeId}@example.com` },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  );
}

beforeEach(() => {
  records = {};
});

describe('SOL DR-006 — quarantine ownerless legacy inspection drafts', () => {
  test('non-admin GET on ownerless draft returns 404 (existence hidden)', async () => {
    seedRecord({ id: 'orphan-i', submittedById: null });
    const app = buildApp({ isAdmin: false, employeeId: PROBE_ID });
    const res = await request(app)
      .get('/api/inspection/orphan-i')
      .set('Authorization', `Bearer ${authHeader(PROBE_ID)}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'NOT_FOUND' });
  });

  test('admin GET on ownerless draft still returns 200 (recovery path)', async () => {
    seedRecord({ id: 'orphan-admin', submittedById: null });
    const app = buildApp({ isAdmin: true, employeeId: ADMIN_ID });
    const res = await request(app)
      .get('/api/inspection/orphan-admin')
      .set('Authorization', `Bearer ${authHeader(ADMIN_ID)}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('orphan-admin');
    expect(res.body.submittedById).toBeNull();
  });

  test('non-admin GET on owned draft returns 200 (control case)', async () => {
    seedRecord({ id: 'owned-i', submittedById: OWNER_ID });
    const app = buildApp({ isAdmin: false, employeeId: OWNER_ID });
    const res = await request(app)
      .get('/api/inspection/owned-i')
      .set('Authorization', `Bearer ${authHeader(OWNER_ID)}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('owned-i');
  });

  test('non-admin GET on someone else\'s draft returns 403 (not 404)', async () => {
    seedRecord({ id: 'foreign-i', submittedById: OWNER_ID });
    const app = buildApp({ isAdmin: false, employeeId: PROBE_ID });
    const res = await request(app)
      .get('/api/inspection/foreign-i')
      .set('Authorization', `Bearer ${authHeader(PROBE_ID)}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'FORBIDDEN' });
  });
});