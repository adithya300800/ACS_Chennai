/**
 * [Payslips Stage 1 / AppSec checkpoint-2 fixup] Integration smoke test.
 *
 * Runs against the Docker throwaway DB (`postgresql://acs:acspw@localhost:55432/acs_portal`)
 * with REAL Prisma. R2 client is stubbed at the module boundary. The test
 * exercises the full payslip lifecycle against actual SQL:
 *
 *   1. seed 3 employees (admin + owner + attacker) + an UploadIntent row
 *   2. POST /api/admin/payslips/bind                        → draft row
 *   3. POST /api/admin/payslips/publish                     → published row
 *   4. GET   /api/portal/payslips  as owner                 → 1 row
 *   5. GET   /api/portal/payslips  as attacker              → 0 rows
 *   6. GET   /api/portal/payslips/:id/download as attacker  → 404
 *   7. GET   /api/portal/payslips/:id/download as owner     → 200 (PDF stream)
 *   8. POST  /api/admin/payslips/:id/revoke                 → revoked
 *   9. GET   /api/portal/payslips/:id/download as owner     → 404
 *  10. UPDATE payslip SET purged_at = NOW()                 → purged
 *  11. GET   /api/portal/payslips/:id/download as owner     → 404
 *
 * Skipped automatically when THROWAWAY_DATABASE_URL is not set (default
 * `npm test` should NOT require Docker to be running). The test is the
 * only consumer of the throwaway DB — the rest of the suite is in-memory.
 *
 * Privacy discipline (mirrors plan §C.4): dummy emails, dummy blob path,
 * no salary figures, no real employee data. The throwaway DB is a Docker
 * container; this test never touches the production Supabase project.
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.PII_LOG_SALT = process.env.PII_LOG_SALT || 'test-pii-salt-32-chars-min-deadbeef';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const THROW_AWAY_URL = process.env.THROW_AWAY_DATABASE_URL
  || 'postgresql://acs:acspw@localhost:55432/acs_portal';

const { Readable } = require('stream');
const mockDummyPdfBuffer = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'binary');

const mockSend = jest.fn(async (cmd) => {
  const ctor = cmd && cmd.constructor && cmd.constructor.name;
  if (ctor === 'GetObjectCommand') {
    return { Body: Readable.from([mockDummyPdfBuffer]), ContentType: 'application/pdf', ContentLength: mockDummyPdfBuffer.length, ETag: '"smoke-etag"' };
  }
  if (ctor === 'HeadObjectCommand') {
    return { ContentType: 'application/pdf', ContentLength: mockDummyPdfBuffer.length, ETag: '"smoke-etag"', LastModified: new Date() };
  }
  return {};
});

jest.mock('../src/lib/blobStorage', () => {
  const actual = jest.requireActual('../src/lib/blobStorage');
  return {
    ...actual,
    generateUploadSASUrl: jest.fn(async (container, employeeId, ulid, contentType, opts = {}) => {
      const pathPrefix = opts && opts.pathPrefix ? opts.pathPrefix.replace(/^\/+|\/+$/g, '') : null;
      const ext = actual.CONTENT_TYPE_EXT[contentType] || 'pdf';
      const blobName = pathPrefix ? `${pathPrefix}/${employeeId}/${ulid}.${ext}` : `${employeeId}/${ulid}.${ext}`;
      return {
        sasUrl: `https://r2.example/${container}/${blobName}?X-Amz-Signature=fake`,
        ulid,
        blobPath: blobName,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      };
    }),
    verifyBlobExists: jest.fn(async () => ({ outcome: 'present', exists: true, contentLength: mockDummyPdfBuffer.length, contentType: 'application/pdf' })),
    verifyBlobMagicBytes: jest.fn(async () => ({ ok: true, contentType: 'application/pdf', sizeBytes: mockDummyPdfBuffer.length, etag: '"smoke-etag"' })),
    deleteBlob: jest.fn(async () => ({ ok: true })),
    getClient: jest.fn(() => ({ send: mockSend })),
  };
});

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
require('express-async-errors');
const { PrismaClient } = require('@prisma/client');

// Mock the email transport so the publish flow's setImmediate drain does
// NOT actually attempt to send a Resend email (we have no API key in
// the test env, and the row's emailStatus race would otherwise flip
// PENDING → FAILED before the test can assert the publish contract).
// sendEmail is a no-op that returns { ok: true, id: 'smoke-test' }.
jest.mock('../src/lib/email', () => ({
  sendEmail: jest.fn(async () => ({ ok: true, id: 'smoke-test' })),
  escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
  isConfigured: () => true,
  getClient: () => null,
}));

const ADMIN_ID = '11111111-1111-1111-1111-1111111111a1';
const OWNER_ID = '11111111-1111-1111-1111-1111111111a2';
const ATTACKER_ID = '11111111-1111-1111-1111-1111111111a3';
const ULID_VAL = '01ARZ3NDEKTSV4RRFFQ69G5FA1';
const PAYSLIP_NAMESPACE_PREFIX = 'smoke-';

function jwtFor(employeeId, isAdmin) {
  return `Bearer ${jwt.sign(
    { employeeId, email: `${employeeId}@smoke.test`, isAdmin },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  )}`;
}

let prisma;
let canConnect = false;
let connectError;
let app;
let uploadIntentUlid;
let ownerPayslipId;

beforeAll(async () => {
  prisma = new PrismaClient({ datasources: { db: { url: THROW_AWAY_URL } } });
  try {
    await prisma.$queryRaw`SELECT 1`;
    canConnect = true;
  } catch (err) {
    canConnect = false;
    connectError = err;
    // eslint-disable-next-line no-console
    console.error('[integration smoke] cannot reach throwaway DB:', err.code || err.message);
  }
  // Build a minimal Express app that mounts only the three payslip routers.
  // The full src/index.js createApp() also wires email transport + rate
  // limiters + many other middleware — out of scope here. We use only the
  // routers + requireAuth/requireFreshAdmin middlewares, matching the
  // production wiring at src/index.js:472-475.
  if (canConnect) {
    const { requireAuth, requireFreshAdmin } = require('../src/middleware/auth');
    const payslipRoutes = require('../src/routes/payslip');
    app = express();
    app.set('prisma', prisma);
    app.use(express.json({ limit: '5mb' }));
    app.use('/api/admin/payslips/upload', requireAuth, requireFreshAdmin, payslipRoutes.adminUploadRouter);
    app.use('/api/admin/payslips', requireAuth, requireFreshAdmin, payslipRoutes.adminRouter);
    app.use('/api/portal/payslips', requireAuth, payslipRoutes.portalRouter);
  }
});

afterAll(async () => {
  if (canConnect) {
    // Tidy up the rows this test created. Cascade FKs from `payslip` keep
    // the employees alive (payslip.uploaded_by_id is ON DELETE RESTRICT),
    // so we delete the payslips FIRST, then the upload intents, then the
    // test employees.
    try {
      await prisma.payslip.deleteMany({ where: { employeeId: { in: [OWNER_ID, ATTACKER_ID] } } });
      await prisma.uploadIntent.deleteMany({ where: { employeeId: { in: [ADMIN_ID, OWNER_ID, ATTACKER_ID] } } });
      await prisma.employee.deleteMany({ where: { id: { in: [ADMIN_ID, OWNER_ID, ATTACKER_ID] } } });
    } catch (_e) { /* best effort */ }
    await prisma.$disconnect();
  }
});

// Always run the describe; gate inside the test() so the connect error
// is observable. When canConnect=false (no Docker), the test fails fast
// with the captured error.
describe('[integration smoke] payslip lifecycle against Docker throwaway Postgres', () => {
  beforeAll(async () => {
    if (!canConnect) return;
    await prisma.$queryRaw`SELECT 1`;
  });
  let ownerPayslipId;
  let uploadIntentUlid;

  it('full lifecycle: draft → publish → owner sees → attacker 404 → revoke 404 → purge 404', async () => {
    if (!canConnect) {
      throw new Error(`[integration smoke] cannot reach throwaway DB at ${THROW_AWAY_URL.replace(/:[^:@]+@/, ':***@')} — ${connectError ? (connectError.code || connectError.message) : 'connect check failed before tests ran'}`);
    }
    // ── Seed ────────────────────────────────────────────────────────────
    uploadIntentUlid = ULID_VAL;
    await prisma.employee.upsert({
      where: { id: ADMIN_ID },
      update: { isAdmin: true, email: `${ADMIN_ID}@smoke.test`, name: 'Smoke Admin' },
      create: { id: ADMIN_ID, email: `${ADMIN_ID}@smoke.test`, name: 'Smoke Admin', isAdmin: true },
    });
    await prisma.employee.upsert({
      where: { id: OWNER_ID },
      update: { email: `${OWNER_ID}@smoke.test`, name: 'Smoke Owner' },
      create: { id: OWNER_ID, email: `${OWNER_ID}@smoke.test`, name: 'Smoke Owner' },
    });
    await prisma.employee.upsert({
      where: { id: ATTACKER_ID },
      update: { email: `${ATTACKER_ID}@smoke.test`, name: 'Smoke Attacker' },
      create: { id: ATTACKER_ID, email: `${ATTACKER_ID}@smoke.test`, name: 'Smoke Attacker' },
    });

    // Pre-seed an UploadIntent in CONFIRMED status so /bind succeeds.
    // mountUploadRoutes keys intents by the UPLOADER's employeeId (here
    // ADMIN_ID, the admin running the request) — the bind helper
    // looks it up by `uploadedById` and verifies the recipient's id
    // is the path segment in blobPath. So: `employeeId: ADMIN_ID`,
    // `blobPath: payslips/OWNER_ID/ULID.pdf` — the recipient segment
    // stays OWNER_ID; the lookup key is the uploader.
    await prisma.uploadIntent.deleteMany({ where: { employeeId: { in: [ADMIN_ID, OWNER_ID] } } });
    await prisma.uploadIntent.create({
      data: {
        employeeId: ADMIN_ID,
        ulid: uploadIntentUlid,
        container: 'dpr-documents',
        blobPath: `payslips/${OWNER_ID}/${uploadIntentUlid}.pdf`,
        contentType: 'application/pdf',
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    // ── Step 1: admin /bind → draft row ─────────────────────────────────
    const bindRes = await request(app)
      .post('/api/admin/payslips/bind')
      .set('Authorization', jwtFor(ADMIN_ID, true))
      .send({ ulid: uploadIntentUlid, employeeId: OWNER_ID, year: 2026, month: 10 });
    expect(bindRes.status).toBe(201);
    ownerPayslipId = bindRes.body.id;
    // `id` is Prisma's @default(uuid()) — a 36-char UUID, NOT the ULID.
    // The ULID lives in its own `ulid` column (R2 key suffix + cross-system
    // identifier) and is verified via the DB row read below — the wire
    // serializer deliberately omits it (no UI surface needs it).
    expect(ownerPayslipId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // draft row has publishedAt NULL, emailStatus NULL (per the fixup commit)
    const draftRow = await prisma.payslip.findUnique({ where: { id: ownerPayslipId } });
    expect(draftRow.ulid).toBe(uploadIntentUlid);
    expect(draftRow.ulid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/i);
    expect(draftRow.publishedAt).toBeNull();
    expect(draftRow.emailStatus).toBeNull();
    expect(draftRow.deletedAt).toBeNull();
    expect(draftRow.purgedAt).toBeNull();

    // ── Step 2: admin /publish → published row + PENDING stamp ──────────
    // Stub the background email drain to a no-op so the row's emailStatus
    // stays PENDING (the publish contract) and the test can observe it
    // without racing the setImmediate drain. The drain itself is unit-
    // tested separately against sendPayslipEmail.
    const payslipLib = require('../src/lib/payslip');
    payslipLib.payslipTestOverrides.electronicallyDeliver = async () => {};
    const pubRes = await request(app)
      .post('/api/admin/payslips/publish')
      .set('Authorization', jwtFor(ADMIN_ID, true))
      .send({ payslipIds: [ownerPayslipId] });
    expect(pubRes.status).toBe(200);
    expect(pubRes.body.published).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: ownerPayslipId })]),
    );
    // publish sets publishedAt + publishedById; emailStatus was NULL → STAMPED PENDING.
    const pubRow = await prisma.payslip.findUnique({ where: { id: ownerPayslipId } });
    expect(pubRow.publishedAt).not.toBeNull();
    expect(pubRow.publishedById).toBe(ADMIN_ID);
    expect(pubRow.emailStatus).toBe('PENDING');

    // ── Step 3: owner GET /api/portal/payslips → 1 row ──────────────────
    const ownerList = await request(app)
      .get('/api/portal/payslips')
      .set('Authorization', jwtFor(OWNER_ID, false));
    expect(ownerList.status).toBe(200);
    expect(ownerList.body.payslips).toHaveLength(1);
    expect(ownerList.body.payslips[0].id).toBe(ownerPayslipId);

    // ── Step 4: attacker GET /api/portal/payslips → 0 rows ──────────────
    const attackerList = await request(app)
      .get('/api/portal/payslips')
      .set('Authorization', jwtFor(ATTACKER_ID, false));
    expect(attackerList.status).toBe(200);
    expect(attackerList.body.payslips).toHaveLength(0);

    // ── Step 5: attacker GET /download on owner's id → 404 (IDOR) ───────
    const attackerDownload = await request(app)
      .get(`/api/portal/payslips/${ownerPayslipId}/download`)
      .set('Authorization', jwtFor(ATTACKER_ID, false));
    expect(attackerDownload.status).toBe(404);
    expect(attackerDownload.body.code).toBe('NOT_FOUND');

    // ── Step 6: owner GET /download → 200 + PDF stream ──────────────────
    const ownerDownload = await request(app)
      .get(`/api/portal/payslips/${ownerPayslipId}/download`)
      .set('Authorization', jwtFor(OWNER_ID, false));
    expect(ownerDownload.status).toBe(200);
    expect(ownerDownload.headers['content-type']).toMatch(/^application\/pdf/);
    expect(ownerDownload.headers['content-disposition']).toMatch(/inline; filename="Payslip-2026-10\.pdf"/);
    expect(Buffer.from(ownerDownload.body).slice(0, 5).toString('ascii')).toBe('%PDF-');

    // ── Step 7: admin /revoke → soft-deleted ────────────────────────────
    const revokeRes = await request(app)
      .post(`/api/admin/payslips/${ownerPayslipId}/revoke`)
      .set('Authorization', jwtFor(ADMIN_ID, true))
      .send({ reason: 'smoke test revoke' });
    expect(revokeRes.status).toBe(200);
    const revokedRow = await prisma.payslip.findUnique({ where: { id: ownerPayslipId } });
    expect(revokedRow.deletedAt).not.toBeNull();
    expect(revokedRow.revokedAt).not.toBeNull();
    expect(revokedRow.revokedById).toBe(ADMIN_ID);

    // ── Step 8: revoked → owner /download → 404 (deletedAt predicate) ──
    const afterRevoke = await request(app)
      .get(`/api/portal/payslips/${ownerPayslipId}/download`)
      .set('Authorization', jwtFor(OWNER_ID, false));
    expect(afterRevoke.status).toBe(404);
    expect(afterRevoke.body.code).toBe('NOT_FOUND');

    // ── Step 9: simulate purge (set purged_at = now) ────────────────────
    await prisma.payslip.update({
      where: { id: ownerPayslipId },
      data: { purgedAt: new Date(), purgedById: ADMIN_ID, purgedReason: 'smoke test purge' },
    });

    // ── Step 10: purged → owner /download → 404 (purgedAt predicate) ────
    const afterPurge = await request(app)
      .get(`/api/portal/payslips/${ownerPayslipId}/download`)
      .set('Authorization', jwtFor(OWNER_ID, false));
    expect(afterPurge.status).toBe(404);
    expect(afterPurge.body.code).toBe('NOT_FOUND');

    // ── Final assertion: row is still in the table (soft delete only) ───
    const finalRow = await prisma.payslip.findUnique({ where: { id: ownerPayslipId } });
    expect(finalRow).not.toBeNull();
    expect(finalRow.deletedAt).not.toBeNull();
    expect(finalRow.purgedAt).not.toBeNull();
  }, 30000);

  // ────────────────────────────────────────────────────────────────────
  // Bug-A regression: admin binds a payslip for a DIFFERENT employee.
  // The intent is keyed by the uploader's employeeId (ADMIN_ID), the
  // recipient is OWNER_ID. The fix to bindPayslipToIntent looks up
  // the intent by uploadedById and verifies the recipient's id is the
  // path segment in blobPath. This test pins the contract end-to-end.
  // ────────────────────────────────────────────────────────────────────
  it('A. admin binds a payslip for a different employee (cross-employee upload) succeeds', async () => {
    if (!canConnect) {
      throw new Error(`[integration smoke] cannot reach throwaway DB at ${THROW_AWAY_URL.replace(/:[^:@]+@/, ':***@')} — ${connectError ? (connectError.code || connectError.message) : 'connect check failed before tests ran'}`);
    }
    // Re-seed ADMIN + OWNER + a fresh intent keyed by the uploader.
    await prisma.employee.upsert({
      where: { id: ADMIN_ID },
      update: { isAdmin: true, email: `${ADMIN_ID}@smoke.test`, name: 'Smoke Admin' },
      create: { id: ADMIN_ID, email: `${ADMIN_ID}@smoke.test`, name: 'Smoke Admin', isAdmin: true },
    });
    await prisma.employee.upsert({
      where: { id: OWNER_ID },
      update: { email: `${OWNER_ID}@smoke.test`, name: 'Smoke Owner' },
      create: { id: OWNER_ID, email: `${OWNER_ID}@smoke.test`, name: 'Smoke Owner' },
    });
    // Use a fresh ULID so this test does not collide with the lifecycle test.
    const crossUlid = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
    await prisma.uploadIntent.deleteMany({ where: { employeeId: ADMIN_ID, ulid: crossUlid } });
    await prisma.uploadIntent.create({
      data: {
        employeeId: ADMIN_ID,        // uploader
        ulid: crossUlid,
        container: 'dpr-documents',
        blobPath: `payslips/${OWNER_ID}/${crossUlid}.pdf`, // recipient is OWNER_ID
        contentType: 'application/pdf',
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    // Bind as ADMIN, recipient = OWNER.
    const res = await request(app)
      .post('/api/admin/payslips/bind')
      .set('Authorization', jwtFor(ADMIN_ID, true))
      .send({ ulid: crossUlid, employeeId: OWNER_ID, year: 2026, month: 9 });
    expect(res.status).toBe(201);
    expect(res.body.employeeId).toBe(OWNER_ID);
    // Cleanup: remove the new payslip so the lifecycle test isn't polluted.
    const newId = res.body.id;
    const newRow = await prisma.payslip.findUnique({ where: { id: newId } });
    expect(newRow.uploadedById).toBe(ADMIN_ID);
    expect(newRow.employeeId).toBe(OWNER_ID);
    await prisma.payslip.delete({ where: { id: newId } });
    await prisma.uploadIntent.deleteMany({ where: { employeeId: ADMIN_ID, ulid: crossUlid } });
  }, 30000);

  // ────────────────────────────────────────────────────────────────────
  // /bind is mounted on the admin router (requireFreshAdmin). A
  // non-admin caller must be rejected with 403 + ADMIN_REQUIRED before
  // bindPayslipToIntent runs.
  // ────────────────────────────────────────────────────────────────────
  it('B. non-admin cannot bind (requireFreshAdmin returns 403 ADMIN_REQUIRED)', async () => {
    if (!canConnect) {
      throw new Error(`[integration smoke] cannot reach throwaway DB — ${connectError ? (connectError.code || connectError.message) : 'connect check failed'}`);
    }
    const res = await request(app)
      .post('/api/admin/payslips/bind')
      .set('Authorization', jwtFor(OWNER_ID, false))
      .send({ ulid: '01ARZ3NDEKTSV4RRFFQ69G5FA1', employeeId: OWNER_ID, year: 2026, month: 11 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_REQUIRED');
  }, 30000);

  // ────────────────────────────────────────────────────────────────────
  // [fixup commit 2026-10-05] The bind path validator was loosened
  // from a strict `payslips/<body.employeeId>/<ulid>.pdf` shape check
  // to a prefix + suffix check (`payslips/` + `/<ulid>.pdf`). The
  // reason: the upload route's path builder keys by the UPLOADER's
  // id, not the recipient, so the strict shape check could never
  // match for a cross-employee upload. The path's middle segment is
  // now treated as opaque metadata; the recipient is the body.
  //
  // What this test pins: a tampered intent whose blobPath doesn't
  // start with `payslips/` IS rejected (defense in depth against
  // a compromised or hand-rolled intent row). The previous "path
  // middle segment must equal body.employeeId" assertion is no
  // longer part of the contract — that case is now the
  // happy path, exercised by the headline cross-employee test in
  // payslip-cross-employee-bind.test.js, not a failure mode.
  // ────────────────────────────────────────────────────────────────────
  it('C. path without payslips/ prefix is rejected (400 INVALID_BLOB_PATH)', async () => {
    if (!canConnect) {
      throw new Error(`[integration smoke] cannot reach throwaway DB — ${connectError ? (connectError.code || connectError.message) : 'connect check failed'}`);
    }
    const tamperUlid = '01ARZ3NDEKTSV4RRFFQ69G5FAB';
    await prisma.employee.upsert({
      where: { id: ADMIN_ID },
      update: { isAdmin: true, email: `${ADMIN_ID}@smoke.test`, name: 'Smoke Admin' },
      create: { id: ADMIN_ID, email: `${ADMIN_ID}@smoke.test`, name: 'Smoke Admin', isAdmin: true },
    });
    await prisma.employee.upsert({
      where: { id: OWNER_ID },
      update: { email: `${OWNER_ID}@smoke.test`, name: 'Smoke Owner' },
      create: { id: OWNER_ID, email: `${OWNER_ID}@smoke.test`, name: 'Smoke Owner' },
    });
    await prisma.uploadIntent.deleteMany({ where: { employeeId: ADMIN_ID, ulid: tamperUlid } });
    // Tampered blobPath: NOT in the payslips/ prefix. This must
    // be refused even though the lookup-by-(uploader, ulid) succeeds.
    await prisma.uploadIntent.create({
      data: {
        employeeId: ADMIN_ID,
        ulid: tamperUlid,
        container: 'dpr-documents',
        blobPath: `dpr-documents/${OWNER_ID}/${tamperUlid}.pdf`, // WRONG prefix
        contentType: 'application/pdf',
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const res = await request(app)
      .post('/api/admin/payslips/bind')
      .set('Authorization', jwtFor(ADMIN_ID, true))
      .send({ ulid: tamperUlid, employeeId: OWNER_ID, year: 2026, month: 11 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BLOB_PATH');
    const stray = await prisma.payslip.findFirst({ where: { ulid: tamperUlid } });
    expect(stray).toBeNull();
    await prisma.uploadIntent.deleteMany({ where: { employeeId: ADMIN_ID, ulid: tamperUlid } });
  }, 30000);

  // ────────────────────────────────────────────────────────────────────
  // Bug-B regression: GET /api/admin/payslips/coverage must NOT use
  // the nonexistent Employee.isActive column. The Prisma query in the
  // route is now `findMany` with no where filter; this test pins that
  // the endpoint returns 200 with the expected counts against REAL
  // Postgres (not the in-memory mock).
  // ────────────────────────────────────────────────────────────────────
  it('D. coverage returns 200 with correct counts (no Employee.isActive filter)', async () => {
    if (!canConnect) {
      throw new Error(`[integration smoke] cannot reach throwaway DB — ${connectError ? (connectError.code || connectError.message) : 'connect check failed'}`);
    }
    // Use the year/month from the lifecycle test's published row. Coverage
    // counts PUBLISHED + not-revoked rows per (year, month) for every
    // employee in the table — so we expect totalEmployees >= 1 and
    // coveredCount >= 0. The schema/contract is: response includes
    // `totalEmployees`, `coveredCount`, `missingCount`, and a `coverage`
    // array whose length equals `totalEmployees`.
    const res = await request(app)
      .get('/api/admin/payslips/coverage?year=2026&month=10')
      .set('Authorization', jwtFor(ADMIN_ID, true));
    expect(res.status).toBe(200);
    expect(res.body.year).toBe(2026);
    expect(res.body.month).toBe(10);
    expect(typeof res.body.totalEmployees).toBe('number');
    expect(typeof res.body.coveredCount).toBe('number');
    expect(typeof res.body.missingCount).toBe('number');
    expect(res.body.missingCount).toBe(res.body.totalEmployees - res.body.coveredCount);
    expect(Array.isArray(res.body.coverage)).toBe(true);
    expect(res.body.coverage.length).toBe(res.body.totalEmployees);
    // The lifecycle test's row was deleted (afterAll or the final step),
    // but other tests in this DB may have left rows. Assert each row's
    // shape (employeeId/name/email/payslip|{id,published,emailStatus,...}).
    for (const row of res.body.coverage) {
      expect(row).toHaveProperty('employeeId');
      expect(row).toHaveProperty('employeeName');
      expect(row).toHaveProperty('employeeEmail');
      if (row.payslip) {
        expect(row.payslip).toHaveProperty('id');
        expect(row.payslip).toHaveProperty('published');
        expect(row.payslip).toHaveProperty('emailStatus');
      }
    }
  }, 30000);
});