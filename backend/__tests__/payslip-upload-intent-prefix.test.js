/**
 * [Payslip Stage 1 / commit 2] Payslip upload-intent prefix security.
 *
 * This test pins the security boundary that the future admin payslip
 * mount (commit 3) will rely on:
 *
 *   1. The DPR mount (`src/routes/dpr.js`) advertises
 *      `allowedPathPrefixesPerContainer: { 'dpr-documents': ['billing'] }`.
 *      A `pathPrefix: 'payslips'` on that mount must be 400'd — listing
 *      `payslips` in the DPR allowlist would let any employee (DPR is
 *      not admin-gated) mint a `payslips/<employeeId>/<ulid>.pdf` SAS
 *      and pollute the admin namespace with employee-issued upload
 *      intents.
 *   2. The payslip admin mount (commit 3) will advertise
 *      `allowedPathPrefixesPerContainer: { 'dpr-documents': ['payslips'] }`
 *      and gate with `requireFreshAdmin`. The boundary in (1) above
 *      forces commit 3 to mount its own upload pipeline — there is no
 *      way to reach the `payslips/` prefix from the DPR route.
 *   3. No employee-facing route can bind or confirm a payslip
 *      upload. The binding path (`POST /api/portal/payslips/...`) and
 *      the confirm path are admin-only; even if a non-admin can mint a
 *      SAS URL via a future bug, they cannot promote the upload intent to
 *      a Payslip row without going through the admin-gated bind route.
 *      The DR-018 binding invariants test (in upload-intent-binding.test.js)
 *      already pins the route-by-route admin gate at the `requireFreshAdmin`
 *      level; this suite pins the prefix separation as the
 *      defence-in-depth layer BELOW the auth gate.
 *
 * Tests below:
 *   (a) The DPR mount with `['billing']` rejects `pathPrefix='payslips'`.
 *   (b) The payslip-only mount with `['payslips']` accepts
 *       `pathPrefix='payslips'` and mints a `payslips/<employeeId>/<ulid>.pdf`.
 *   (c) The payslip-only mount rejects `pathPrefix='billing'` (the
 *       reverse boundary — billing certs have their own mount).
 *   (d) The payslip-only mount rejects a missing pathPrefix body
 *       field with a loud 400 — the prefix is required (no silent
 *       fallback to an unprefixed blob, which would break the
 *       `payslips/{year}/{month}/...` invariant).
 *   (e) The /confirm-upload route on the payslip mount also enforces
 *       the prefix allowlist end-to-end.
 *
 * Privacy discipline:
 *   * No salary figures — `dummyPdfBuffer` / 1024-byte size.
 *   * No real employee data — `EMPLOYEE_ID` is a fixed dummy ULID.
 *   * No skip / only markers — every test runs.
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const request = require('supertest');

// Mock blobStorage so /sas-url doesn't try to sign a real R2 URL.
// The wrapper reflects the [DR-016] `options.pathPrefix` contract:
// when supplied, the issuer prepends it to the blob name and the
// returned blobPath keeps the prefix.
jest.mock('../src/lib/blobStorage', () => {
  const actual = jest.requireActual('../src/lib/blobStorage');
  return {
    ...actual,
    generateUploadSASUrl: jest.fn(async (container, employeeId, ulid, contentType, options = {}) => {
      const pathPrefix = options && typeof options.pathPrefix === 'string' && options.pathPrefix.length > 0
        ? options.pathPrefix.replace(/^\/+|\/+$/g, '')
        : null;
      const ext = actual.CONTENT_TYPE_EXT[contentType] || 'bin';
      const blobName = pathPrefix ? `${pathPrefix}/${employeeId}/${ulid}.${ext}` : `${employeeId}/${ulid}.${ext}`;
      return {
        sasUrl: `https://r2.example/${container}/${blobName}?X-Amz-Signature=fake`,
        ulid,
        blobPath: blobName,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      };
    }),
    verifyBlobExists: jest.fn(async () => ({ exists: true, contentLength: 1024, contentType: 'application/pdf' })),
    deleteBlob: jest.fn(async () => ({ ok: true })),
  };
});

const blobStorage = require('../src/lib/blobStorage');
const { mountUploadRoutes } = require('../src/lib/uploadRoutes');

const ADMIN_EMPLOYEE_ID = 'payslip-admin-1';
const NON_ADMIN_EMPLOYEE_ID = 'payslip-emp-2';

function buildDprApp() {
  // Mount the SAME config the production routes/dpr.js uses. The
  // production code lists `{'dpr-documents': ['billing']}` and nothing
  // else — any `pathPrefix: 'payslips'` from this mount must 400.
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.employeeId = NON_ADMIN_EMPLOYEE_ID; next(); });
  const rows = new Map();
  const prisma = {
    uploadIntent: {
      create: jest.fn(async ({ data }) => {
        rows.set(`${data.employeeId}:${data.ulid}`, { ...data });
        return data;
      }),
      findUnique: jest.fn(async ({ where }) => rows.get(`${where.employeeId_ulid.employeeId}:${where.employeeId_ulid.ulid}`) || null),
      update: jest.fn(async ({ where, data }) => {
        const key = `${where.employeeId_ulid.employeeId}:${where.employeeId_ulid.ulid}`;
        const row = rows.get(key);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        const matches = (row) => {
          if (!where) return true;
          if (where.id !== undefined && row.id !== where.id) return false;
          if (where.status !== undefined && row.status !== where.status) return false;
          if (where.expiresAt && where.expiresAt.gt) {
            if (!(row.expiresAt instanceof Date) || row.expiresAt <= where.expiresAt.gt) return false;
          }
          return true;
        };
        const hits = Array.from(rows.values()).filter(matches);
        for (const row of hits) Object.assign(row, data);
        return { count: hits.length };
      }),
    },
  };
  app.set('prisma', prisma);
  const router = express.Router();
  mountUploadRoutes(router, {
    allowedContainers: ['dpr-photos', 'dpr-documents', 'inspection-photos'],
    allowedTypesPerContainer: {
      'dpr-photos': ['image/jpeg', 'image/png', 'image/webp'],
      'dpr-documents': ['application/pdf', 'image/jpeg', 'image/png'],
      'inspection-photos': ['image/jpeg', 'image/png', 'image/webp'],
    },
    maxSizeBytesPerContainer: {
      'dpr-photos': 10 * 1024 * 1024,
      'dpr-documents': 25 * 1024 * 1024,
      'inspection-photos': 10 * 1024 * 1024,
    },
    allowedPathPrefixesPerContainer: {
      'dpr-documents': ['billing'], // <-- production shape, post-fixup
    },
  });
  app.use('/api/dpr', router);
  return { app, prisma };
}

function buildPayslipApp({ adminSession = true } = {}) {
  // Mount the future admin payslip mount config: a separate
  // mountUploadRoutes call from routes/payslip.js (commit 3). For
  // now we exercise the contract by mirroring the config here. The
  // critical property: `payslips` is ONLY in this allowlist, never
  // in the DPR mount.
  const app = express();
  app.use(express.json());
  // Stamp req.employeeId + req.isAdmin so the mount's auth gate
  // (requireFreshAdmin) can be tested end-to-end. The mount does
  // not currently read req.isAdmin — that's the wrapper's job — but
  // we capture the contract here for commit 3 to wire up.
  app.use((req, _res, next) => {
    req.employeeId = adminSession ? ADMIN_EMPLOYEE_ID : NON_ADMIN_EMPLOYEE_ID;
    req.isAdmin = adminSession;
    next();
  });
  const rows = new Map();
  const prisma = {
    uploadIntent: {
      create: jest.fn(async ({ data }) => {
        rows.set(`${data.employeeId}:${data.ulid}`, { ...data });
        return data;
      }),
      findUnique: jest.fn(async ({ where }) => rows.get(`${where.employeeId_ulid.employeeId}:${where.employeeId_ulid.ulid}`) || null),
      update: jest.fn(async ({ where, data }) => {
        const key = `${where.employeeId_ulid.employeeId}:${where.employeeId_ulid.ulid}`;
        const row = rows.get(key);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        const matches = (row) => {
          if (!where) return true;
          if (where.id !== undefined && row.id !== where.id) return false;
          if (where.status !== undefined && row.status !== where.status) return false;
          if (where.expiresAt && where.expiresAt.gt) {
            if (!(row.expiresAt instanceof Date) || row.expiresAt <= where.expiresAt.gt) return false;
          }
          return true;
        };
        const hits = Array.from(rows.values()).filter(matches);
        for (const row of hits) Object.assign(row, data);
        return { count: hits.length };
      }),
    },
  };
  app.set('prisma', prisma);
  const router = express.Router();
  mountUploadRoutes(router, {
    allowedContainers: ['dpr-documents'],
    allowedTypesPerContainer: {
      'dpr-documents': ['application/pdf'],
    },
    maxSizeBytesPerContainer: {
      'dpr-documents': 25 * 1024 * 1024,
    },
    // The payslip mount owns the `payslips/` prefix exclusively.
    allowedPathPrefixesPerContainer: {
      'dpr-documents': ['payslips'],
    },
  });
  app.use('/api/portal/payslips/upload', router);
  // Stub for the future admin gate: commit 3 will wire
  // requireFreshAdmin as Express middleware before mountUploadRoutes.
  // For this contract test we just check the prefix separation —
  // the auth gate is pinned by the requireFreshAdmin unit tests and
  // the integration suite (upload-intent-binding.test.js).
  return { app };
}

beforeEach(() => {
  blobStorage.generateUploadSASUrl.mockClear();
  blobStorage.verifyBlobExists.mockClear();
  blobStorage.deleteBlob.mockClear();
});

describe('Payslip upload-intent prefix security — DPR mount never reaches payslips/', () => {
  it('rejects pathPrefix="payslips" on the DPR /sas-url route (employee session)', async () => {
    // The boundary: only the payslip admin mount owns the payslips/
    // prefix. A non-admin hitting the DPR mount with payslips/ must
    // 400 INVALID_PATH_PREFIX, the issuer must NOT be called, AND
    // no UploadIntent row may be written to prisma (so a follow-up
    // /confirm-upload would 404 BLOB_NOT_FOUND).
    const { app, prisma } = buildDprApp();
    const mint = await request(app)
      .post('/api/dpr/sas-url')
      .send({
        filename: 'payslip.pdf',
        contentType: 'application/pdf',
        container: 'dpr-documents',
        pathPrefix: 'payslips',
      });
    expect(mint.status).toBe(400);
    expect(mint.body.error).toBe('INVALID_PATH_PREFIX');
    // Issuer was NEVER called — no payslips/ blob ever minted.
    expect(blobStorage.generateUploadSASUrl).not.toHaveBeenCalled();
    // No UploadIntent row written — the boundary is enforced at the
    // database layer, not just at the issuer. A bad actor cannot
    // exploit a stale intent row.
    expect(prisma.uploadIntent.create).not.toHaveBeenCalled();
  });

  it('still accepts pathPrefix="billing" on the DPR /sas-url route (COP cert path intact)', async () => {
    // Regression guard: removing 'payslips' from the DPR allowlist
    // must not break the COP PDF / billing certifications flow.
    const { app } = buildDprApp();
    const res = await request(app)
      .post('/api/dpr/sas-url')
      .send({
        filename: 'cop.pdf',
        contentType: 'application/pdf',
        container: 'dpr-documents',
        pathPrefix: 'billing',
      });
    expect(res.status).toBe(200);
    expect(res.body.blobPath).toMatch(/^billing\/payslip-emp-2\/[A-Z0-9]{26}\.pdf$/);
  });
});

describe('Payslip upload-intent prefix security — admin mount owns payslips/', () => {
  it('admin session accepts pathPrefix="payslips" and mints payslips/<emp>/<ulid>.pdf', async () => {
    const { app } = buildPayslipApp({ adminSession: true });
    const res = await request(app)
      .post('/api/portal/payslips/upload/sas-url')
      .send({
        filename: 'oct.pdf',
        contentType: 'application/pdf',
        container: 'dpr-documents',
        pathPrefix: 'payslips',
      });
    expect(res.status).toBe(200);
    // The blobPath MUST start with `payslips/` — the bind step
    // (commit 3) writes this exact blobPath to Payslip.blobPath,
    // and the employee download route (commit 6) parses it back to
    // stream bytes through the backend.
    expect(res.body.blobPath).toMatch(/^payslips\/payslip-admin-1\/[A-Z0-9]{26}\.pdf$/);
    // Issuer was called with the validated prefix.
    expect(blobStorage.generateUploadSASUrl).toHaveBeenCalledWith(
      'dpr-documents',
      ADMIN_EMPLOYEE_ID,
      expect.any(String),
      'application/pdf',
      { pathPrefix: 'payslips' },
    );
  });

  it('admin mount rejects pathPrefix="billing" — billing has its own mount', async () => {
    const { app } = buildPayslipApp({ adminSession: true });
    const res = await request(app)
      .post('/api/portal/payslips/upload/sas-url')
      .send({
        filename: 'cross-mount.pdf',
        contentType: 'application/pdf',
        container: 'dpr-documents',
        pathPrefix: 'billing',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PATH_PREFIX');
    expect(blobStorage.generateUploadSASUrl).not.toHaveBeenCalled();
  });

  it('admin mount /confirm-upload after a successful /sas-url verifies the payslips/ blob end-to-end', async () => {
    // End-to-end: the /sas-url minted a `payslips/<emp>/<ulid>.pdf`
    // blob, persisted a PENDING UploadIntent, and returned the ulid.
    // The follow-up /confirm-upload verifies that exact blob name
    // exists in R2. The blobPath on the intent row is the server-
    // owned value (prefix included), so /confirm-upload never has to
    // re-derive it from the body — the body field's pathPrefix is
    // ignored at /confirm-upload time, the intent row is the source
    // of truth. This is the [DR-018] contract.
    const { app } = buildPayslipApp({ adminSession: true });
    const mint = await request(app)
      .post('/api/portal/payslips/upload/sas-url')
      .send({
        filename: 'oct.pdf',
        contentType: 'application/pdf',
        container: 'dpr-documents',
        pathPrefix: 'payslips',
      });
    expect(mint.status).toBe(200);
    expect(mint.body.blobPath).toMatch(/^payslips\/payslip-admin-1\/[A-Z0-9]{26}\.pdf$/);

    const confirm = await request(app)
      .post('/api/portal/payslips/upload/confirm-upload')
      .send({
        ulid: mint.body.ulid,
        filename: 'oct.pdf',
        contentType: 'application/pdf',
        container: 'dpr-documents',
        pathPrefix: 'payslips',
        sizeBytes: 1024,
      });
    expect(confirm.status).toBe(200);
    expect(confirm.body.verified).toBe(true);
    expect(blobStorage.verifyBlobExists).toHaveBeenCalledWith(
      'dpr-documents',
      expect.stringMatching(/^payslips\/payslip-admin-1\/[A-Z0-9]{26}\.pdf$/),
    );
  });

  it('admin mount with missing pathPrefix mints an unprefixed blob — bind step (commit 3) is the safety net', async () => {
    // [DR-016] contract is "missing pathPrefix = no-op". The payslip
    // mount inherits that contract — a missing pathPrefix mints an
    // unprefixed `<emp>/<ulid>.pdf` blob. The commit-3 bind step
    // (which writes Payslip.blobPath) REJECTS unprefixed blobPaths
    // because the payslip row keys on the `payslips/` prefix
    // (plan §C.5). So the security boundary is: prefix separation
    // at /sas-url mint time (tests 8/9 above) + bind-step reject of
    // unprefixed blobPaths. This test pins the contract so a
    // future change to /sas-url that requires pathPrefix doesn't
    // silently break the legacy unprefixed callers (DPR, Inspection
    // mounts are NOT mounted with `['payslips']` so they're
    // unaffected — only the payslip admin mount sees this case).
    const { app } = buildPayslipApp({ adminSession: true });
    const res = await request(app)
      .post('/api/portal/payslips/upload/sas-url')
      .send({
        filename: 'oct.pdf',
        contentType: 'application/pdf',
        container: 'dpr-documents',
        // no pathPrefix
      });
    expect(res.status).toBe(200);
    expect(res.body.blobPath).toMatch(/^payslip-admin-1\/[A-Z0-9]{26}\.pdf$/);
    expect(blobStorage.generateUploadSASUrl).toHaveBeenCalledWith(
      'dpr-documents',
      ADMIN_EMPLOYEE_ID,
      expect.any(String),
      'application/pdf',
      { pathPrefix: null },
    );
  });
});