/**
 * DR-003 (round-20): Inspection upload routes hardening.
 *
 * Three findings the audit caught:
 *
 *   1. /sas-url and /confirm-upload were mounted BEFORE requireAuth, so
 *      any anonymous caller could mint a presigned R2 PUT URL and upload
 *      up to 5GB to the inspection-photos bucket. Now both routes live
 *      after router.use(requireAuth).
 *
 *   2. /sas-url had no size ceiling. The MAX_PHOTO_SIZE check lived only
 *      on /confirm-upload against the client-declared sizeBytes — a
 *      forgeable value. The fix rejects oversized declarations at
 *      SAS-issue time.
 *
 *   3. Orphaned R2 blobs. If a user minted a SAS URL but never called
 *      /confirm-upload, the 20-min TTL removed the in-memory pending
 *      entry but left the bytes in R2 forever (paying for storage with
 *      no DB reference). Now the TTL handler attempts a best-effort
 *      delete of the blob; 404 is treated as "user never uploaded".
 *
 * DPR upload routes have the same fixes (same pattern, same audit
 * findings); this file exercises Inspection. A separate dpr.upload
 * test could mirror these assertions.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

// Mock the blobStorage module so the test doesn't actually call R2.
// We replace generateUploadSASUrl, verifyBlobExists, and deleteBlob with
// in-process fakes that record calls and simulate the success/failure
// shapes the route expects.
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
    verifyBlobExists: jest.fn(async () => ({ exists: false })),
    deleteBlob: jest.fn(async () => ({ ok: true })),
    CONTENT_TYPE_EXT: actual.CONTENT_TYPE_EXT,
  };
});

const blobStorage = require('../src/lib/blobStorage');
const inspectionRouter = require('../src/routes/inspection');

const EMPLOYEE_ID = 'test-employee-1';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.set('prisma', {}); // not needed for /sas-url and /confirm-upload
  app.use('/api/inspection', inspectionRouter);
  return app;
}

function authHeader() {
  const token = jwt.sign(
    { employeeId: EMPLOYEE_ID, email: 'test@example.com' },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  );
  return `Bearer ${token}`;
}

beforeEach(() => {
  blobStorage.generateUploadSASUrl.mockClear();
  blobStorage.verifyBlobExists.mockClear();
  blobStorage.deleteBlob.mockClear();
});

describe('DR-003 — /sas-url auth gate', () => {
  const app = buildApp();

  it('rejects anonymous POST /sas-url with 401', async () => {
    const res = await request(app)
      .post('/api/inspection/sas-url')
      .send({ filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(401);
    expect(blobStorage.generateUploadSASUrl).not.toHaveBeenCalled();
  });

  it('accepts an authenticated POST /sas-url', async () => {
    const res = await request(app)
      .post('/api/inspection/sas-url')
      .set('Authorization', authHeader())
      .send({ filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('sasUrl');
    expect(res.body).toHaveProperty('ulid');
    expect(blobStorage.generateUploadSASUrl).toHaveBeenCalledTimes(1);
  });

  it('rejects anonymous POST /confirm-upload with 401', async () => {
    const res = await request(app)
      .post('/api/inspection/confirm-upload')
      .send({ ulid: 'abc', filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: 100 });

    expect(res.status).toBe(401);
    expect(blobStorage.verifyBlobExists).not.toHaveBeenCalled();
  });
});

describe('DR-003 — /sas-url byte ceiling', () => {
  const app = buildApp();

  it('rejects oversized sizeBytes with 413 PHOTO_TOO_LARGE', async () => {
    const res = await request(app)
      .post('/api/inspection/sas-url')
      .set('Authorization', authHeader())
      .send({
        filename: 'big.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 50 * 1024 * 1024, // 50 MB, exceeds 10 MB cap
      });

    expect(res.status).toBe(413);
    expect(res.body.error).toBe('PHOTO_TOO_LARGE');
    expect(blobStorage.generateUploadSASUrl).not.toHaveBeenCalled();
  });

  it('rejects zero sizeBytes with 400 INVALID_SIZE', async () => {
    const res = await request(app)
      .post('/api/inspection/sas-url')
      .set('Authorization', authHeader())
      .send({ filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_SIZE');
    expect(blobStorage.generateUploadSASUrl).not.toHaveBeenCalled();
  });

  it('rejects negative sizeBytes with 400 INVALID_SIZE', async () => {
    const res = await request(app)
      .post('/api/inspection/sas-url')
      .set('Authorization', authHeader())
      .send({ filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: -1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_SIZE');
    expect(blobStorage.generateUploadSASUrl).not.toHaveBeenCalled();
  });

  it('rejects non-number sizeBytes with 400 INVALID_SIZE', async () => {
    const res = await request(app)
      .post('/api/inspection/sas-url')
      .set('Authorization', authHeader())
      .send({ filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: 'huge' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_SIZE');
  });

  it('accepts exactly the ceiling (10 MB) — boundary OK', async () => {
    const res = await request(app)
      .post('/api/inspection/sas-url')
      .set('Authorization', authHeader())
      .send({
        filename: 'ten.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 10 * 1024 * 1024,
      });

    expect(res.status).toBe(200);
    expect(blobStorage.generateUploadSASUrl).toHaveBeenCalledTimes(1);
  });

  it('accepts sizeBytes omitted (legacy clients without size hint)', async () => {
    const res = await request(app)
      .post('/api/inspection/sas-url')
      .set('Authorization', authHeader())
      .send({ filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
  });
});

describe('DR-003 — /confirm-upload byte ceiling (unchanged)', () => {
  const app = buildApp();

  it('rejects oversized sizeBytes at /confirm-upload too (defense in depth)', async () => {
    // First mint a SAS URL so we have a pending upload.
    const sas = await request(app)
      .post('/api/inspection/sas-url')
      .set('Authorization', authHeader())
      .send({ filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(sas.status).toBe(200);
    const { ulid } = sas.body;

    const res = await request(app)
      .post('/api/inspection/confirm-upload')
      .set('Authorization', authHeader())
      .send({
        ulid,
        filename: 'a.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 50 * 1024 * 1024,
      });

    expect(res.status).toBe(413);
    expect(res.body.error).toBe('PHOTO_TOO_LARGE');
    expect(blobStorage.verifyBlobExists).not.toHaveBeenCalled();
  });
});

describe('DR-003 — /sas-url content-type allowlist (unchanged)', () => {
  const app = buildApp();

  it('rejects non-image content-type with 400 INVALID_CONTENT_TYPE', async () => {
    const res = await request(app)
      .post('/api/inspection/sas-url')
      .set('Authorization', authHeader())
      .send({ filename: 'evil.exe', contentType: 'application/octet-stream' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_CONTENT_TYPE');
  });
});