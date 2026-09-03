/**
 * DR-021 (round-20): shared upload routes contract.
 *
 * The src/lib/uploadRoutes.js module is consumed by BOTH dpr.js and
 * inspection.js. This test pins the shared contract — if a refactor
 * breaks parity, the test catches it before either consumer drifts.
 *
 * Two modes are tested:
 *   1. "hardcoded container" (Inspection): server picks the container;
 *      client doesn't send it.
 *   2. "client-pick container" (DPR): client must send `container`,
 *      server validates against an allowlist.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

// Mock blobStorage before requiring the route module.
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
const { mountUploadRoutes } = require('../src/lib/uploadRoutes');

const EMPLOYEE_ID = 'test-employee-1';

function buildHardcodedApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.employeeId = EMPLOYEE_ID; next(); });
  const router = express.Router();
  mountUploadRoutes(router, { container: 'inspection-photos' });
  app.use('/api/inspection', router);
  return app;
}

function buildClientPickApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.employeeId = EMPLOYEE_ID; next(); });
  const router = express.Router();
  mountUploadRoutes(router, {
    allowedContainers: ['dpr-photos', 'dpr-documents', 'inspection-photos'],
  });
  app.use('/api/dpr', router);
  return app;
}

beforeEach(() => {
  blobStorage.generateUploadSASUrl.mockClear();
  blobStorage.verifyBlobExists.mockClear();
  blobStorage.deleteBlob.mockClear();
});

describe('DR-021 — mountUploadRoutes shared contract', () => {
  it('mounts /sas-url and /confirm-upload on the supplied router', async () => {
    const app = buildHardcodedApp();
    const sas = await request(app)
      .post('/api/inspection/sas-url')
      .send({ filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(sas.status).toBe(200);

    const confirm = await request(app)
      .post('/api/inspection/confirm-upload')
      .send({ ulid: sas.body.ulid, filename: 'a.jpg', contentType: 'image/jpeg', sizeBytes: 100 });
    // verifyBlobExists mock returns {exists:false} → 404 BLOB_NOT_UPLOADED,
    // which proves the route was mounted and exercised.
    expect(confirm.status).toBe(404);
    expect(confirm.body.error).toBe('BLOB_NOT_UPLOADED');
  });

  it('rejects when neither container nor allowedContainers is configured', () => {
    expect(() => mountUploadRoutes(express.Router(), {})).toThrow(/requires/);
  });

  it('rejects when BOTH container and allowedContainers are configured', () => {
    expect(() =>
      mountUploadRoutes(express.Router(), { container: 'a', allowedContainers: ['b'] })
    ).toThrow(/not both/);
  });
});

describe('DR-021 — "hardcoded container" mode (Inspection)', () => {
  const app = buildHardcodedApp();

  it('issues SAS without requiring client to send container', async () => {
    const res = await request(app)
      .post('/api/inspection/sas-url')
      .send({ filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    // The blob path in the SAS reflects the hardcoded container.
    expect(res.body.blobPath).toMatch(/^test-employee-1\/.+\.jpg$/);
    // generateUploadSASUrl was called with the hardcoded container, not
    // anything from the client.
    expect(blobStorage.generateUploadSASUrl).toHaveBeenCalledWith(
      'inspection-photos',
      expect.any(String),
      expect.any(String),
      'image/jpeg',
    );
  });

  it('ignores any client-supplied container (server always wins)', async () => {
    const res = await request(app)
      .post('/api/inspection/sas-url')
      .send({
        filename: 'a.jpg',
        contentType: 'image/jpeg',
        container: 'dpr-photos', // attempt to escape the namespace
      });

    expect(res.status).toBe(200);
    // Server still uses 'inspection-photos', not 'dpr-photos'.
    expect(blobStorage.generateUploadSASUrl).toHaveBeenCalledWith(
      'inspection-photos',
      expect.any(String),
      expect.any(String),
      'image/jpeg',
    );
  });
});

describe('DR-021 — "client-pick from allowlist" mode (DPR)', () => {
  const app = buildClientPickApp();

  it('rejects /sas-url with no container', async () => {
    const res = await request(app)
      .post('/api/dpr/sas-url')
      .send({ filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('rejects /sas-url with a non-allowlisted container', async () => {
    const res = await request(app)
      .post('/api/dpr/sas-url')
      .send({
        filename: 'a.jpg',
        contentType: 'image/jpeg',
        container: 'totally-not-allowed',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('accepts each allowlisted container', async () => {
    for (const container of ['dpr-photos', 'dpr-documents', 'inspection-photos']) {
      const res = await request(app)
        .post('/api/dpr/sas-url')
        .send({ filename: 'a.jpg', contentType: 'image/jpeg', container });
      expect(res.status).toBe(200);
      expect(blobStorage.generateUploadSASUrl).toHaveBeenLastCalledWith(
        container,
        expect.any(String),
        expect.any(String),
        'image/jpeg',
      );
    }
  });
});

describe('DR-021 — both modes share MAX_PHOTO_SIZE ceiling', () => {
  const hardcodedApp = buildHardcodedApp();
  const clientPickApp = buildClientPickApp();

  it('hardcoded mode rejects oversized sizeBytes at /sas-url', async () => {
    const res = await request(hardcodedApp)
      .post('/api/inspection/sas-url')
      .send({
        filename: 'big.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 50 * 1024 * 1024,
      });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('PHOTO_TOO_LARGE');
  });

  it('client-pick mode rejects oversized sizeBytes at /sas-url', async () => {
    const res = await request(clientPickApp)
      .post('/api/dpr/sas-url')
      .send({
        filename: 'big.jpg',
        contentType: 'image/jpeg',
        container: 'dpr-photos',
        sizeBytes: 50 * 1024 * 1024,
      });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('PHOTO_TOO_LARGE');
  });
});