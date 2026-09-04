/**
 * LPR-012 (round-26): durable UploadIntent handshake.
 *
 * Before this change, upload intents lived in a process-local Map. The SOL
 * production-readiness reassessment flagged that as not-durable, not
 * horizontally-scalable, and not safe against process restart. This test
 * pins the new contract: /sas-url writes a Prisma UploadIntent row, and
 * /confirm-upload validates ownership + flips status to CONFIRMED.
 *
 * Coverage:
 *   1. Round trip: /sas-url creates a PENDING intent → /confirm-upload
 *      flips it to CONFIRMED.
 *   2. Foreign-employee guard: a second employee cannot confirm someone
 *      else's intent — the lookup is scoped by (employeeId, ulid) and
 *      returns 404, leaving the original intent untouched.
 *   3. Idempotent re-confirm: a second /confirm-upload after the first
 *      succeeds returns 200 with `alreadyConfirmed: true`.
 *   4. Expired intent: an intent with expires_at in the past returns 410.
 *
 * The test uses a hand-rolled in-memory Prisma mock (Map-backed) so it
 * runs without a real DB. The contract under test is the *relationship*
 * between the route and the Prisma client, not Prisma itself.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const request = require('supertest');

// Mock blobStorage so we never touch R2.
jest.mock('../src/lib/blobStorage', () => {
  const actual = jest.requireActual('../src/lib/blobStorage');
  return {
    ...actual,
    generateUploadSASUrl: jest.fn(async (container, employeeId, ulid, contentType) => ({
      sasUrl: `https://r2.example/${container}/${employeeId}/${ulid}?X-Amz-Signature=fake`,
      ulid,
      blobPath: `${employeeId}/${ulid}.${actual.CONTENT_TYPE_EXT[contentType] || 'bin'}`,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    })),
    // Default to "blob exists + size matches". Individual tests can override.
    verifyBlobExists: jest.fn(async () => ({ exists: true, contentType: 'image/jpeg', contentLength: 100 })),
    deleteBlob: jest.fn(async () => ({ ok: true })),
    CONTENT_TYPE_EXT: actual.CONTENT_TYPE_EXT,
  };
});

const blobStorage = require('../src/lib/blobStorage');
const { mountUploadRoutes, pendingUploads } = require('../src/lib/uploadRoutes');

const EMPLOYEE_A = 'employee-A-uuid';
const EMPLOYEE_B = 'employee-B-uuid';

// ─── In-memory Prisma mock (Map-backed) ────────────────────────────────────
// Mirrors only the UploadIntent surface used by the route. Composite
// unique index handled manually because we can't rely on Prisma enforcing
// it in a mock.
function buildIntentStore() {
  const byKey = new Map();
  const keyOf = (employeeId, ulid) => `${employeeId}::${ulid}`;
  return {
    uploadIntent: {
      create: jest.fn(async ({ data }) => {
        const k = keyOf(data.employeeId, data.ulid);
        if (byKey.has(k)) {
          const err = new Error('Unique constraint failed');
          err.code = 'P2002';
          throw err;
        }
        const row = {
          id: `intent-${byKey.size + 1}`,
          status: 'PENDING',
          confirmedAt: null,
          createdAt: new Date(),
          ...data,
        };
        byKey.set(k, row);
        return row;
      }),
      findUnique: jest.fn(async ({ where: { employeeId_ulid } }) => {
        return byKey.get(keyOf(employeeId_ulid.employeeId, employeeId_ulid.ulid)) || null;
      }),
      update: jest.fn(async ({ where: { employeeId_ulid }, data }) => {
        const k = keyOf(employeeId_ulid.employeeId, employeeId_ulid.ulid);
        const existing = byKey.get(k);
        if (!existing) {
          const err = new Error('Record not found');
          err.code = 'P2025';
          throw err;
        }
        const next = { ...existing, ...data };
        byKey.set(k, next);
        return next;
      }),
      // For test assertions
      _get: (employeeId, ulid) => byKey.get(keyOf(employeeId, ulid)) || null,
      _size: () => byKey.size,
      _reset: () => byKey.clear(),
    },
  };
}

// Build an Express app that scopes auth by an `X-Test-Employee` header so
// we can simulate two different employees in one process.
function buildApp(prisma, employeeId) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.use((req, _res, next) => {
    // Allow per-request override via header (superagent), fall back to
    // the default employeeId captured at build time.
    req.employeeId = req.headers['x-test-employee'] || employeeId;
    next();
  });
  const router = express.Router();
  mountUploadRoutes(router, { container: 'inspection-photos' });
  app.use('/api/inspection', router);
  return app;
}

beforeEach(() => {
  blobStorage.generateUploadSASUrl.mockClear();
  blobStorage.verifyBlobExists.mockClear();
  blobStorage.verifyBlobExists.mockResolvedValue({ exists: true, contentType: 'image/jpeg', contentLength: 100 });
  blobStorage.deleteBlob.mockClear();
  pendingUploads.clear();
});

describe('LPR-012 — UploadIntent round trip', () => {
  it('creates a PENDING intent on /sas-url, flips it to CONFIRMED on /confirm-upload', async () => {
    const prisma = buildIntentStore();
    const app = buildApp(prisma, EMPLOYEE_A);

    const sas = await request(app)
      .post('/api/inspection/sas-url')
      .set('X-Test-Employee', EMPLOYEE_A)
      .send({ filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(sas.status).toBe(200);
    const { ulid, blobPath } = sas.body;

    // PENDING intent exists, owned by EMPLOYEE_A
    expect(prisma.uploadIntent._size()).toBe(1);
    const intent = prisma.uploadIntent._get(EMPLOYEE_A, ulid);
    expect(intent).not.toBeNull();
    expect(intent.status).toBe('PENDING');
    expect(intent.employeeId).toBe(EMPLOYEE_A);
    expect(intent.blobPath).toBe(blobPath);
    expect(intent.contentType).toBe('image/jpeg');
    expect(intent.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const confirm = await request(app)
      .post('/api/inspection/confirm-upload')
      .set('X-Test-Employee', EMPLOYEE_A)
      .send({ ulid, filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: 100 });
    expect(confirm.status).toBe(200);
    expect(confirm.body.verified).toBe(true);

    // Intent is now CONFIRMED with confirmedAt set
    const confirmed = prisma.uploadIntent._get(EMPLOYEE_A, ulid);
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.confirmedAt).toBeInstanceOf(Date);
  });
});

describe('LPR-012 — foreign-employee guard', () => {
  it('returns 404 when employee B tries to confirm employee A\'s intent', async () => {
    const prisma = buildIntentStore();
    const app = buildApp(prisma, EMPLOYEE_A);

    const sas = await request(app)
      .post('/api/inspection/sas-url')
      .set('X-Test-Employee', EMPLOYEE_A)
      .send({ filename: 'b.jpg', contentType: 'image/jpeg' });
    expect(sas.status).toBe(200);
    const { ulid } = sas.body;

    // Employee B cannot see Employee A's intent
    const intentAsB = prisma.uploadIntent._get(EMPLOYEE_B, ulid);
    expect(intentAsB).toBeNull();

    // /confirm-upload from employee B is rejected with 404
    const crossConfirm = await request(app)
      .post('/api/inspection/confirm-upload')
      .set('X-Test-Employee', EMPLOYEE_B)
      .send({ ulid, filename: 'b.jpg', contentType: 'image/jpeg', sizeBytes: 100 });
    expect(crossConfirm.status).toBe(404);
    expect(crossConfirm.body.error).toBe('BLOB_NOT_FOUND');

    // Original intent is still PENDING — the foreign attempt did not
    // mutate state.
    const stillPending = prisma.uploadIntent._get(EMPLOYEE_A, ulid);
    expect(stillPending.status).toBe('PENDING');
    expect(stillPending.confirmedAt).toBeNull();

    // And EMPLOYEE_A can still complete their own upload afterwards.
    const realConfirm = await request(app)
      .post('/api/inspection/confirm-upload')
      .set('X-Test-Employee', EMPLOYEE_A)
      .send({ ulid, filename: 'b.jpg', contentType: 'image/jpeg', sizeBytes: 100 });
    expect(realConfirm.status).toBe(200);
  });
});

describe('LPR-012 — re-confirm is idempotent', () => {
  it('returns 200 with alreadyConfirmed: true on a second /confirm-upload', async () => {
    const prisma = buildIntentStore();
    const app = buildApp(prisma, EMPLOYEE_A);

    const sas = await request(app)
      .post('/api/inspection/sas-url')
      .set('X-Test-Employee', EMPLOYEE_A)
      .send({ filename: 'c.jpg', contentType: 'image/jpeg' });
    const { ulid } = sas.body;

    const first = await request(app)
      .post('/api/inspection/confirm-upload')
      .set('X-Test-Employee', EMPLOYEE_A)
      .send({ ulid, filename: 'c.jpg', contentType: 'image/jpeg', sizeBytes: 100 });
    expect(first.status).toBe(200);
    expect(first.body.verified).toBe(true);
    expect(first.body.alreadyConfirmed).toBeUndefined();

    // Second attempt — bytes don't need to exist; the idempotency
    // guard fires before the verifyBlobExists call.
    blobStorage.verifyBlobExists.mockResolvedValueOnce({ exists: false });
    const second = await request(app)
      .post('/api/inspection/confirm-upload')
      .set('X-Test-Employee', EMPLOYEE_A)
      .send({ ulid, filename: 'c.jpg', contentType: 'image/jpeg', sizeBytes: 100 });
    expect(second.status).toBe(200);
    expect(second.body.alreadyConfirmed).toBe(true);
  });
});

describe('LPR-012 — expired intent', () => {
  it('returns 410 when the intent expires_at is in the past', async () => {
    const prisma = buildIntentStore();
    const app = buildApp(prisma, EMPLOYEE_A);

    const sas = await request(app)
      .post('/api/inspection/sas-url')
      .set('X-Test-Employee', EMPLOYEE_A)
      .send({ filename: 'd.jpg', contentType: 'image/jpeg' });
    const { ulid } = sas.body;

    // Backdate the intent's expiry
    const intent = prisma.uploadIntent._get(EMPLOYEE_A, ulid);
    intent.expiresAt = new Date(Date.now() - 1000);

    const confirm = await request(app)
      .post('/api/inspection/confirm-upload')
      .set('X-Test-Employee', EMPLOYEE_A)
      .send({ ulid, filename: 'd.jpg', contentType: 'image/jpeg', sizeBytes: 100 });
    expect(confirm.status).toBe(410);
    expect(confirm.body.error).toBe('INTENT_EXPIRED');
  });
});
