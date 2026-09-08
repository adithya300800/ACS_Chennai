// SOL DR-006 regression coverage. The audit caught a server-side
// owner-attribution bug: a pre-FK DPR row whose `submittedById` is
// NULL (a legacy import, a broken FK, or a draft created before the
// schema added the submittedBy constraint) was returned to whichever
// employee happened to hit `?draftId=<id>` first. Their subsequent
// save attributed the row to themselves — silently rebinding a draft
// to a new owner with no audit trail.
//
// Acceptance (audit, lines 128-138 of the 2026-09-08 review):
//   - GET /api/dpr/:id where `submittedById === null` and requester is
//     a non-admin → 404 (the row is quarantined; the existence of the
//     id is hidden so other employees cannot probe for unattributed
//     drafts).
//   - GET /api/dpr/:id where `submittedById === null` and requester is
//     an admin → 200 (admins are the recovery path — they can re-bind
//     the row via the dashboard tools).
//   - GET /api/dpr/:id where `submittedById` is a real id and the
//     requester is the owner → 200 (control case; nothing regressed).
//   - Same quarantine applies to GET /api/inspection/:id
//     (mirrored at inspection.dr006.test.js).

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

const dprRouter = require('../src/routes/dpr');

const OWNER_ID = 'emp-dr006-owner';
const ADMIN_ID = 'emp-dr006-admin';
const PROBE_ID = 'emp-dr006-probe';

let dprs = {};

function seedDpr({
  id,
  submittedById = OWNER_ID,
  status = 'DRAFT',
  projectName = 'Legacy Site',
  projectId = null,
  reportDate = '2026-09-04',
} = {}) {
  dprs[id] = {
    id,
    submittedById,
    status,
    version: 1,
    projectName,
    projectId,
    location: 'Chennai',
    reportDate,
    workType: 'SITE_INSPECTION',
    notes: null,
    customSections: null,
    workExecutedToday: null,
    workLocation: null,
    manpowerSummary: null,
    risksHindrances: null,
    materialsReceivedSummary: null,
    weather: null,
    temperature: null,
    contractor: null,
    drawingId: null,
    drawingRev: null,
    boqItemId: null,
    submittedAt: null,
    submittedBy: submittedById ? { id: submittedById, name: 'Owner', email: 'o@example.com' } : null,
    reviewedBy: null,
    approvedBy: null,
    photos: [],
    inspections: [],
    boqItem: null,
    project: null,
    drawing: null,
    revisions: [],
  };
  return dprs[id];
}

function buildApp({ isAdmin = false, employeeId = PROBE_ID } = {}) {
  const app = express();
  app.use(express.json());

  const prisma = {
    dPR: {
      findUnique: async ({ where }) => {
        const row = dprs[where.id];
        if (!row) return null;
        return { ...row };
      },
    },
    employee: {
      // Allow per-test override of the requesting employee's id + admin
      // status by closing over a local closure variable. The audit's
      // quarantine contract only requires the requester's identity, so
      // a single findUnique that returns both is enough.
      findUnique: async () => ({ id: employeeId, isAdmin }),
    },
  };

  app.set('prisma', prisma);
  app.use('/api/dpr', dprRouter);
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
  dprs = {};
});

describe('SOL DR-006 — quarantine ownerless legacy DPR drafts', () => {
  test('non-admin GET on ownerless draft returns 404 (existence hidden)', async () => {
    seedDpr({ id: 'orphan-1', submittedById: null });
    const app = buildApp({ isAdmin: false, employeeId: PROBE_ID });
    const res = await request(app)
      .get('/api/dpr/orphan-1')
      .set('Authorization', `Bearer ${authHeader(PROBE_ID)}`);
    expect(res.status).toBe(404);
    // The body should look like the canonical NOT_FOUND envelope so a
    // client distinguishing 404 from 403 doesn't accidentally surface
    // the orphan's existence to the user.
    expect(res.body).toMatchObject({ error: 'NOT_FOUND' });
  });

  test('admin GET on ownerless draft still returns 200 (recovery path)', async () => {
    seedDpr({ id: 'orphan-2', submittedById: null });
    const app = buildApp({ isAdmin: true, employeeId: ADMIN_ID });
    const res = await request(app)
      .get('/api/dpr/orphan-2')
      .set('Authorization', `Bearer ${authHeader(ADMIN_ID)}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('orphan-2');
    expect(res.body.submittedById).toBeNull();
  });

  test('non-admin GET on owned draft returns 200 (control case)', async () => {
    seedDpr({ id: 'owned-1', submittedById: OWNER_ID });
    const app = buildApp({ isAdmin: false, employeeId: OWNER_ID });
    const res = await request(app)
      .get('/api/dpr/owned-1')
      .set('Authorization', `Bearer ${authHeader(OWNER_ID)}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('owned-1');
  });

  test('non-admin GET on someone else\'s draft returns 403 (not 404)', async () => {
    // This pre-existing 403 path must NOT regress into a 404. Ownerless
    // quarantine is a strict superset of the existing auth boundary —
    // a real owned-but-foreign draft should still leak the existence
    // signal (403) so legitimate owner-vs-probe confusion surfaces in
    // logs.
    seedDpr({ id: 'foreign-1', submittedById: OWNER_ID });
    const app = buildApp({ isAdmin: false, employeeId: PROBE_ID });
    const res = await request(app)
      .get('/api/dpr/foreign-1')
      .set('Authorization', `Bearer ${authHeader(PROBE_ID)}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'FORBIDDEN' });
  });

  test('non-existent id returns 404 (control case)', async () => {
    const app = buildApp({ isAdmin: false, employeeId: PROBE_ID });
    const res = await request(app)
      .get('/api/dpr/does-not-exist')
      .set('Authorization', `Bearer ${authHeader(PROBE_ID)}`);
    expect(res.status).toBe(404);
  });
});