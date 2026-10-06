/**
 * [fix/payslip-bind-path 2026-10-05] Real-Postgres integration test for the
 * cross-employee bind contract.
 *
 * Unlike `payslip-integration-smoke.test.js` (which stubs
 * `generateUploadSASUrl` entirely and re-implements the path builder
 * inside the mock), THIS test exercises the REAL
 * `lib/uploadRoutes.js` path-building pipeline end-to-end. Only the
 * S3/R2 network boundary is stubbed: `getSignedUrl` returns a fake
 * URL, and `client.send` returns canned HeadObject / GetObject /
 * PutObject responses. Everything else (Prisma, the payslip router,
 * the upload sub-router, `lib/payslip.bindPayslipToIntent`) is the
 * actual production code.
 *
 * This test is what catches the class of bug the previous fixup
 * (canonical-shape check) failed to detect: the upload route's path
 * builder keys by the UPLOADER, and the bind step must accept a
 * DIFFERENT recipient from the path's middle segment.
 *
 * Skipped automatically when THROWAWAY_DATABASE_URL is not set. The
 * test uses its own schema-isolated employees (UUIDs prefixed
 * `xc-`) so it does not collide with the integration-smoke suite.
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.PII_LOG_SALT = process.env.PII_LOG_SALT || 'test-pii-salt-32-chars-min-deadbeef';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';
// Set the R2 env vars so the real `getClient()` in `lib/blobStorage.js`
// doesn't throw "R2 Storage not configured" at module load. The actual
// S3 client is overridden via the `getClient` mock below.
process.env.R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || 'test-r2-account';
process.env.R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || 'test-r2-key';
process.env.R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || 'test-r2-secret';
process.env.R2_BUCKET_DPR_DOCUMENTS = process.env.R2_BUCKET_DPR_DOCUMENTS || 'test-dpr-bucket';
process.env.R2_ENDPOINT = process.env.R2_ENDPOINT || 'https://test-r2.example.com';

const THROW_AWAY_URL = process.env.THROW_AWAY_DATABASE_URL
  || 'postgresql://acs:acspw@localhost:55432/acs_portal';

// ─── Real PDF bytes (the production magic-bytes check is real too) ──
const REAL_PDF = Buffer.from(
  '%PDF-1.4\n' +
  '%\xE2\xE3\xCF\xD3\n' +
  '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
  '2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj\n' +
  '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\n' +
  'xref\n0 4\n0000000000 65535 f \n0000000010 00000 n \n0000000053 00000 n \n0000000100 00000 n \n' +
  'trailer << /Size 4 /Root 1 0 R >>\nstartxref\n170\n%%EOF\n',
  'binary',
);

// ─── R2 boundary stub: only the network call is mocked. We mock the
// ─── S3Client constructor at the @aws-sdk level so that ANY code path
// ─── inside lib/blobStorage.js (verifyBlobExists, verifyBlobMagicBytes,
// ─── generateReadSASUrl, generateUploadSASUrl's internal client.send
// ─── during mock setup, etc.) that calls `new S3Client(...)` gets our
// ─── stub. The real `getClient()` function in blobStorage.js still
// ─── runs (so its config-validation path is exercised) but it
// ─── returns our stub client instead of opening a real R2 connection.
const mockSend = jest.fn(async (cmd) => {
  const ctor = cmd && cmd.constructor && cmd.constructor.name;
  if (ctor === 'GetObjectCommand') {
    return {
      Body: require('stream').Readable.from([REAL_PDF]),
      ContentType: 'application/pdf',
      ContentLength: REAL_PDF.length,
      ETag: '"xc-etag"',
    };
  }
  if (ctor === 'HeadObjectCommand') {
    return {
      ContentType: 'application/pdf',
      ContentLength: REAL_PDF.length,
      ETag: '"xc-etag"',
      LastModified: new Date(),
    };
  }
  if (ctor === 'PutObjectCommand') {
    return { ETag: '"xc-etag"' };
  }
  return {};
});

jest.mock('@aws-sdk/client-s3', () => {
  const real = jest.requireActual('@aws-sdk/client-s3');
  // Replace the S3Client constructor with a stub that returns our
  // fake { send } object. The Command classes (HeadObjectCommand,
  // GetObjectCommand, etc.) are kept as the real implementations so
  // instanceof / constructor.name checks in the real code still work.
  function StubS3Client(_config) {
    return { send: mockSend };
  }
  return { ...real, S3Client: StubS3Client };
});

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(async (_client, _command, _opts) => 'https://r2.example/fake-sas-url?X-Amz-Signature=fake'),
}));

// We do NOT mock lib/blobStorage. The REAL getClient() runs and calls
// `new S3Client(...)` which our @aws-sdk/client-s3 mock above returns
// the stub. generateUploadSASUrl, verifyBlobExists, verifyBlobMagicBytes
// are all real production code, so the magic-byte check, the head-match
// check, and the path-builder all execute against the real database +
// the stubbed R2 client. This is the point of the test.

// Email transport: no-op so the publish drain doesn't race the test.
jest.mock('../src/lib/email', () => ({
  sendEmail: jest.fn(async () => ({ ok: true, id: 'xc-test' })),
  escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
  isConfigured: () => true,
  getClient: () => null,
}));

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
require('express-async-errors');
const { PrismaClient } = require('@prisma/client');

const ADMIN_ID   = 'cccccccc-1111-1111-1111-ccccccccccc1';
const RECIP_ID   = 'cccccccc-1111-1111-1111-ccccccccccc2'; // the employee the admin uploads FOR
const OTHER_ID   = 'cccccccc-1111-1111-1111-ccccccccccc3'; // a second employee (must not see the row)
const ADMIN2_ID  = 'cccccccc-1111-1111-1111-ccccccccccc4'; // a second admin (must not bind admin1's intent)

function jwtFor(employeeId, isAdmin) {
  return `Bearer ${jwt.sign(
    { employeeId, email: `${employeeId}@xc.test`, isAdmin },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  )}`;
}

let prisma;
let canConnect = false;
let connectError;
let app;

beforeAll(async () => {
  prisma = new PrismaClient({ datasources: { db: { url: THROW_AWAY_URL } } });
  try {
    await prisma.$queryRaw`SELECT 1`;
    canConnect = true;
  } catch (err) {
    canConnect = false;
    connectError = err;
    // eslint-disable-next-line no-console
    console.error('[xc-bind] cannot reach throwaway DB:', err.code || err.message);
  }

  if (canConnect) {
    const { requireAuth, requireFreshAdmin } = require('../src/middleware/auth');
    const {
      payslipUploadLimiter,
      payslipAdminLimiter,
      payslipDownloadLimiter,
    } = require('../src/middleware/rateLimit');
    const payslipRoutes = require('../src/routes/payslip');
    app = express();
    app.set('prisma', prisma);
    app.use(express.json({ limit: '5mb' }));
    // Mount exactly like src/index.js:472-475, with the production
    // rate limiters (payslipUploadLimiter, payslipAdminLimiter,
    // payslipDownloadLimiter) inline so the test exercises the real
    // limit contract and CodeQL sees rate-limited routes.
    app.use('/api/admin/payslips/upload', requireAuth, requireFreshAdmin, payslipUploadLimiter, payslipRoutes.adminUploadRouter);
    app.use('/api/admin/payslips', requireAuth, requireFreshAdmin, payslipAdminLimiter, payslipRoutes.adminRouter);
    app.use('/api/portal/payslips', requireAuth, payslipDownloadLimiter, payslipRoutes.portalRouter);
  }
});

afterAll(async () => {
  if (canConnect) {
    try {
      // Clean up everything we created. payslip cascades from
      // employee ON DELETE RESTRICT for uploaded_by_id, so payslips
      // first, then intents, then employees.
      await prisma.payslip.deleteMany({ where: { employeeId: { in: [ADMIN_ID, RECIP_ID, OTHER_ID, ADMIN2_ID] } } });
      await prisma.uploadIntent.deleteMany({ where: { employeeId: { in: [ADMIN_ID, ADMIN2_ID] } } });
      await prisma.employee.deleteMany({ where: { id: { in: [ADMIN_ID, RECIP_ID, OTHER_ID, ADMIN2_ID] } } });
    } catch (_e) { /* best effort */ }
    await prisma.$disconnect();
  }
});

function requireThrowaway() {
  if (!canConnect) {
    const msg = connectError ? (connectError.code || connectError.message) : 'connect check failed before tests ran';
    throw new Error(`[xc-bind] cannot reach throwaway DB at ${THROW_AWAY_URL.replace(/:[^:@]+@/, ':***@')} — ${msg}`);
  }
}

describe('[xc-bind] real-uploadRoutes cross-employee bind contract', () => {
  beforeAll(async () => {
    requireThrowaway();
    // Stub the publish-drain to a no-op so the row's emailStatus
    // stays PENDING (the contract we want to assert).
    const payslipLib = require('../src/lib/payslip');
    payslipLib.payslipTestOverrides.electronicallyDeliver = async () => {};

    await prisma.employee.upsert({
      where: { id: ADMIN_ID }, update: { isAdmin: true, name: 'XC Admin1' },
      create: { id: ADMIN_ID, email: `${ADMIN_ID}@xc.test`, name: 'XC Admin1', isAdmin: true },
    });
    await prisma.employee.upsert({
      where: { id: RECIP_ID }, update: { isAdmin: false, name: 'XC Recipient' },
      create: { id: RECIP_ID, email: `${RECIP_ID}@xc.test`, name: 'XC Recipient', isAdmin: false },
    });
    await prisma.employee.upsert({
      where: { id: OTHER_ID }, update: { isAdmin: false, name: 'XC Other' },
      create: { id: OTHER_ID, email: `${OTHER_ID}@xc.test`, name: 'XC Other', isAdmin: false },
    });
    await prisma.employee.upsert({
      where: { id: ADMIN2_ID }, update: { isAdmin: true, name: 'XC Admin2' },
      create: { id: ADMIN2_ID, email: `${ADMIN2_ID}@xc.test`, name: 'XC Admin2', isAdmin: true },
    });
  });

  beforeEach(() => {
    requireThrowaway();
  });

  // 1. ─── /sas-url with REAL path builder ──────────────────────────────
  it('1. admin /sas-url mints payslips/<ADMIN>/<ulid>.pdf (uploader-keyed path, NOT recipient)', async () => {
    const res = await request(app)
      .post('/api/admin/payslips/upload/sas-url')
      .set('Authorization', jwtFor(ADMIN_ID, true))
      .send({
        container: 'dpr-documents',
        filename: 'xc-oct.pdf',
        contentType: 'application/pdf',
        sizeBytes: REAL_PDF.length,
        pathPrefix: 'payslips',
      });
    expect(res.status).toBe(200);
    expect(res.body.blobPath).toBe(`payslips/${ADMIN_ID}/${res.body.ulid}.pdf`);
    // The path's middle segment is the UPLOADER (ADMIN_ID), NOT the
    // eventual recipient — this is the core invariant the new bind
    // contract relies on.
    expect(res.body.blobPath).not.toContain(RECIP_ID);
    // The intent row was created, keyed by uploader.
    const intent = await prisma.uploadIntent.findUnique({
      where: { employeeId_ulid: { employeeId: ADMIN_ID, ulid: res.body.ulid } },
    });
    expect(intent).not.toBeNull();
    expect(intent.blobPath).toBe(res.body.blobPath);
    expect(intent.status).toBe('PENDING');
    // Cache the ULID for the rest of the suite.
    global.__xcUlid = res.body.ulid;
  });

  // 2. ─── /confirm-upload verifies the blob ─────────────────────────────
  it('2. /confirm-upload flips PENDING → CONFIRMED', async () => {
    const ulid = global.__xcUlid;
    const res = await request(app)
      .post('/api/admin/payslips/upload/confirm-upload')
      .set('Authorization', jwtFor(ADMIN_ID, true))
      .send({
        ulid,
        filename: 'xc-oct.pdf',
        contentType: 'application/pdf',
        sizeBytes: REAL_PDF.length,
        container: 'dpr-documents',
        pathPrefix: 'payslips',
      });
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    const intent = await prisma.uploadIntent.findUnique({
      where: { employeeId_ulid: { employeeId: ADMIN_ID, ulid } },
    });
    expect(intent.status).toBe('CONFIRMED');
  });

  // 3. ─── /bind for a DIFFERENT employee (the headline case) ─────────────
  it('3. /bind for a DIFFERENT employee succeeds (cross-employee bind)', async () => {
    const ulid = global.__xcUlid;
    const res = await request(app)
      .post('/api/admin/payslips/bind')
      .set('Authorization', jwtFor(ADMIN_ID, true))
      .send({ ulid, employeeId: RECIP_ID, year: 2026, month: 10 });
    expect(res.status).toBe(201);
    // The Payslip row's employeeId is the RECIPIENT, not the uploader.
    expect(res.body.employeeId).toBe(RECIP_ID);
    const row = await prisma.payslip.findUnique({ where: { id: res.body.id } });
    expect(row.employeeId).toBe(RECIP_ID);
    expect(row.uploadedById).toBe(ADMIN_ID);
    // The blobPath on the row is the server-recorded one from the
    // intent — its middle segment is the UPLOADER, not the recipient.
    expect(row.blobPath).toBe(`payslips/${ADMIN_ID}/${ulid}.pdf`);
    expect(row.blobPath).not.toContain(RECIP_ID);
    global.__xcPayslipId = res.body.id;
  });

  // 4. ─── Retried /bind does NOT create a second row ────────────────────
  it('4. retried /bind for the same ulid+recipient+month does NOT create a second row', async () => {
    const ulid = global.__xcUlid;
    const before = await prisma.payslip.count({ where: { employeeId: RECIP_ID, year: 2026, month: 10 } });
    const res = await request(app)
      .post('/api/admin/payslips/bind')
      .set('Authorization', jwtFor(ADMIN_ID, true))
      .send({ ulid, employeeId: RECIP_ID, year: 2026, month: 10 });
    // The intent was already claimed by step 3, so the bind helper's
    // CONFIRMED check trips — and the partial-unique index on
    // (employeeId, year, month) where deletedAt IS NULL would also
    // catch a duplicate. Either surface yields a 4xx, never a 201.
    expect(res.status).toBeGreaterThanOrEqual(400);
    const after = await prisma.payslip.count({ where: { employeeId: RECIP_ID, year: 2026, month: 10 } });
    expect(after).toBe(before);
  });

  // 5. ─── /publish transitions to PUBLISHED ─────────────────────────────
  it('5. admin /publish transitions the cross-employee row to PUBLISHED', async () => {
    const payslipId = global.__xcPayslipId;
    const res = await request(app)
      .post('/api/admin/payslips/publish')
      .set('Authorization', jwtFor(ADMIN_ID, true))
      .send({ payslipIds: [payslipId] });
    expect(res.status).toBe(200);
    const row = await prisma.payslip.findUnique({ where: { id: payslipId } });
    expect(row.publishedAt).not.toBeNull();
    expect(row.publishedById).toBe(ADMIN_ID);
    expect(row.emailStatus).toBe('PENDING');
  });

  // 6. ─── The recipient employee sees and downloads the row ────────────
  it('6. RECIPIENT lists and downloads the row; bytes start with %PDF and match the upload', async () => {
    const payslipId = global.__xcPayslipId;
    const list = await request(app)
      .get('/api/portal/payslips')
      .set('Authorization', jwtFor(RECIP_ID, false));
    expect(list.status).toBe(200);
    expect(list.body.payslips.map((p) => p.id)).toContain(payslipId);
    const dl = await request(app)
      .get(`/api/portal/payslips/${payslipId}/download`)
      .set('Authorization', jwtFor(RECIP_ID, false));
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toMatch(/^application\/pdf/);
    expect(dl.headers['content-disposition']).toMatch(/inline; filename="Payslip-2026-10\.pdf"/);
    expect(Buffer.from(dl.body).slice(0, 5).toString('ascii')).toBe('%PDF-');
    expect(Buffer.from(dl.body).length).toBe(REAL_PDF.length);
  });

  // 7. ─── A second, unrelated employee gets 404 ────────────────────────
  it('7. OTHER employee (not the recipient, not the uploader) gets 404 on the download', async () => {
    const payslipId = global.__xcPayslipId;
    const dl = await request(app)
      .get(`/api/portal/payslips/${payslipId}/download`)
      .set('Authorization', jwtFor(OTHER_ID, false));
    expect(dl.status).toBe(404);
    expect(dl.body.code).toBe('NOT_FOUND');
    const list = await request(app)
      .get('/api/portal/payslips')
      .set('Authorization', jwtFor(OTHER_ID, false));
    expect(list.status).toBe(200);
    expect(list.body.payslips).toHaveLength(0);
  });

  // 8. ─── Non-admin cannot bind (already gated by requireFreshAdmin) ────
  it('8. non-admin caller is 403 on /bind even when their id is the recipient', async () => {
    // We need a fresh intent (the original is already claimed). Mint
    // a SAS URL, confirm, then attempt /bind as RECIP_ID (a non-admin
    // employee) with body.employeeId = RECIP_ID.
    const sas = await request(app)
      .post('/api/admin/payslips/upload/sas-url')
      .set('Authorization', jwtFor(ADMIN_ID, true))
      .send({
        container: 'dpr-documents',
        filename: 'xc-nov.pdf',
        contentType: 'application/pdf',
        sizeBytes: REAL_PDF.length,
        pathPrefix: 'payslips',
      });
    const ulid2 = sas.body.ulid;
    await request(app)
      .post('/api/admin/payslips/upload/confirm-upload')
      .set('Authorization', jwtFor(ADMIN_ID, true))
      .send({
        ulid: ulid2,
        filename: 'xc-nov.pdf',
        contentType: 'application/pdf',
        sizeBytes: REAL_PDF.length,
        container: 'dpr-documents',
      });
    const res = await request(app)
      .post('/api/admin/payslips/bind')
      .set('Authorization', jwtFor(RECIP_ID, false)) // non-admin
      .send({ ulid: ulid2, employeeId: RECIP_ID, year: 2026, month: 11 });
    expect(res.status).toBe(403);
    // Cleanup
    await prisma.uploadIntent.deleteMany({ where: { employeeId: ADMIN_ID, ulid: ulid2 } });
  });

  // 9. ─── A different admin cannot bind admin1's intent ────────────────
  it('9. a different admin cannot bind admin1\'s intent (uploader-keyed lookup)', async () => {
    // Use the original (claimed) intent's ulid and attempt a bind
    // for the same recipient + month — but as ADMIN2 instead of
    // ADMIN. The lookup is keyed by uploader, so ADMIN2 finds no
    // intent under their own employeeId, regardless of the body.
    const ulid = global.__xcUlid;
    const res = await request(app)
      .post('/api/admin/payslips/bind')
      .set('Authorization', jwtFor(ADMIN2_ID, true))
      .send({ ulid, employeeId: RECIP_ID, year: 2026, month: 12 });
    // 404 UPLOAD_NOT_CONFIRMED — no intent for (ADMIN2, ulid).
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('UPLOAD_NOT_CONFIRMED');
    // Cleanup: confirm no stray payslip was created by ADMIN2.
    const stray = await prisma.payslip.count({ where: { uploadedById: ADMIN2_ID, employeeId: RECIP_ID } });
    expect(stray).toBe(0);
  });
}, 60000);
