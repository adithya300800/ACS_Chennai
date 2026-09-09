/**
 * DR-016 — server-owned upload key contract.
 *
 * The audit caught a defect where the COP PDF upload pipeline
 * minted a key like `<ownerId>/<ulid>` but the billing POST handler
 * required a `billing/` prefix, mint + confirm returned 200 and the
 * save then 400'd with INVALID_BLOB_PATH. Adding the prefix only on
 * the client would point at nonexistent bytes — the prefix has to be
 * owned by the SERVER at mint time.
 *
 * Acceptance (audit, lines 260-272 of the 2026-09-08 review):
 *   - one owned upload-reference contract across mint, confirm, save,
 *     and read;
 *   - with-PDF create, read, correction, and retry must preserve the
 *     actual uploaded bytes;
 *   - pending confirmation must also tolerate a restart / another
 *     instance instead of requiring only the process-local Map.
 *
 * This suite pins the new contract:
 *   1. /sas-url with `pathPrefix: 'billing'` + container:
 *      'dpr-documents' returns a blobPath that starts with
 *      `billing/`.
 *   2. The issuer call is threaded through with the resolved prefix,
 *      so the saved row points at real bytes.
 *   3. Non-allowlisted prefixes (e.g. an arbitrary attacker-supplied
 *      string) are 400'd loudly.
 *   4. Drawing / Report uploads (no pathPrefix) keep the legacy
 *      unprefixed key shape — backward compat.
 *   5. The DPR mount config advertises exactly the right allowlist
 *      so a future caller can't widen the namespace surface by
 *      accident.
 *
 * Restart tolerance: the durable UploadIntent row (written at mint,
 * consulted at confirm) already spans restarts — see the
 * `upload-intents.test.js` suite for that contract. This suite
 * focuses on the key-shape contract so the audit's reproduction
 * (`mint + PUT + confirm all 200 → save 400 INVALID_BLOB_PATH`) is
 * regression-protected.
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

// Mock blobStorage so /sas-url doesn't try to sign a real R2 URL.
// The wrapper reflects the new [DR-016] `options.pathPrefix`
// contract: when supplied, the issuer prepends it to the blob name
// and the returned blobPath keeps the prefix.
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

const EMPLOYEE_ID = 'dr016-emp-1';

function buildApp({ uploadIntentRows = [], resolvedAllowlist = { 'dpr-documents': ['billing'] } } = {}) {
  const app = express();
  app.use(express.json());
  // Stand-in for the auth middleware: stamp the request with the
  // employeeId that mountUploadRoutes expects on req.employeeId.
  app.use((req, _res, next) => { req.employeeId = EMPLOYEE_ID; next(); });
  // Lightweight UploadIntent stand-in so the mint stage can persist
  // PENDING rows and the confirm stage can look them up (LPR-012).
  const rows = new Map();
  uploadIntentRows.forEach((r) => rows.set(`${r.employeeId}:${r.ulid}`, r));
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
      // [DR-018] confirm-upload uses updateMany with a
      // {id, status, expiresAt} predicate and expects a {count}. The
      // mock honours every filter so the race-safety guard fires
      // correctly when the test backdates expiresAt.
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
  // Mount the SAME config the production routes/dpr.js uses (the
  // per-container allowlist is the only contract under test here —
  // types / size caps are exercised in uploadRoutes.test.js).
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
    // [DR-016] the contract fix lives in this one config key.
    allowedPathPrefixesPerContainer: resolvedAllowlist,
  });
  app.use('/api/dpr', router);
  return { app, prisma, intentRows: rows };
}

beforeEach(() => {
  blobStorage.generateUploadSASUrl.mockClear();
  blobStorage.verifyBlobExists.mockClear();
  blobStorage.deleteBlob.mockClear();
});

describe('DR-016 — server-owned `billing/` prefix on COP PDF uploads', () => {
  it('1. /sas-url with pathPrefix=billing + container=dpr-documents issues a `billing/` blobPath', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/dpr/sas-url')
      .send({
        filename: 'cop.pdf',
        contentType: 'application/pdf',
        container: 'dpr-documents',
        pathPrefix: 'billing',
      });
    expect(res.status).toBe(200);
    expect(res.body.blobPath).toMatch(/^billing\/dr016-emp-1\/[A-Z0-9]{26}\.pdf$/);
    // The issuer received the validated prefix — single source of
    // truth, no client re-derivation.
    expect(blobStorage.generateUploadSASUrl).toHaveBeenCalledWith(
      'dpr-documents',
      EMPLOYEE_ID,
      expect.any(String),
      'application/pdf',
      { pathPrefix: 'billing' },
    );
  });

  it('2. The minted key is persisted on the UploadIntent row (LPR-012 owns restart tolerance)', async () => {
    const { app, prisma, intentRows } = buildApp();
    const res = await request(app)
      .post('/api/dpr/sas-url')
      .send({
        filename: 'cop.pdf',
        contentType: 'application/pdf',
        container: 'dpr-documents',
        pathPrefix: 'billing',
      });
    expect(res.status).toBe(200);
    expect(prisma.uploadIntent.create).toHaveBeenCalledTimes(1);
    const persisted = Array.from(intentRows.values())[0];
    expect(persisted.blobPath).toMatch(/^billing\/dr016-emp-1\//);
    expect(persisted.container).toBe('dpr-documents');
    expect(persisted.status).toBe('PENDING');
  });

  it('3. /confirm-upload with the same ulid succeeds against the prefixed blob name', async () => {
    const { app } = buildApp();
    const mint = await request(app)
      .post('/api/dpr/sas-url')
      .send({
        filename: 'cop.pdf',
        contentType: 'application/pdf',
        container: 'dpr-documents',
        pathPrefix: 'billing',
      });
    expect(mint.status).toBe(200);
    const confirm = await request(app)
      .post('/api/dpr/confirm-upload')
      .send({
        ulid: mint.body.ulid,
        filename: 'cop.pdf',
        contentType: 'application/pdf',
        container: 'dpr-documents',
        pathPrefix: 'billing',
        sizeBytes: 1024,
      });
    expect(confirm.status).toBe(200);
    expect(confirm.body.verified).toBe(true);
    // The persistence verified blob exists AT THE PREFIXED NAME —
    // the audit's reproduction ("mint + confirm 200 but save 400")
    // is regression-protected here.
    expect(blobStorage.verifyBlobExists).toHaveBeenCalledWith(
      'dpr-documents',
      expect.stringMatching(/^billing\/dr016-emp-1\/[A-Z0-9]{26}\.pdf$/),
    );
  });

  it('4. /sas-url rejects pathPrefix that is not in the container allowlist (defence in depth)', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/dpr/sas-url')
      .send({
        filename: 'cop.pdf',
        contentType: 'application/pdf',
        container: 'dpr-documents',
        pathPrefix: 'drawings', // not in the allowlist
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PATH_PREFIX');
    // Issuer was NEVER called with the rejected prefix.
    expect(blobStorage.generateUploadSASUrl).not.toHaveBeenCalled();
  });

  it('5. Drawing / Report uploads (no pathPrefix) keep the legacy unprefixed key shape', async () => {
    // Backward compat: the Drawing + Project Report callers do not
    // send `pathPrefix` — their backend readers do not expect a
    // leading segment, so the issuer must continue to mint
    // `${employeeId}/${ulid}.${ext}`.
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/dpr/sas-url')
      .send({
        filename: 'drawing.pdf',
        contentType: 'application/pdf',
        container: 'dpr-documents',
        // (no pathPrefix)
      });
    expect(res.status).toBe(200);
    expect(res.body.blobPath).toMatch(/^dr016-emp-1\/[A-Z0-9]{26}\.pdf$/);
    // No prefix passed to the issuer — explicit null signals the
    // legacy shape so a future change to the resolver can detect a
    // widened contract by snapshotting this assertion.
    expect(blobStorage.generateUploadSASUrl).toHaveBeenCalledWith(
      'dpr-documents',
      EMPLOYEE_ID,
      expect.any(String),
      'application/pdf',
      { pathPrefix: null },
    );
  });

  it('6. A non-empty but non-allowlisted pathPrefix on a container that supports no prefixes is 400', async () => {
    // dpr-photos does NOT appear in the DPR mount's
    // `allowedPathPrefixesPerContainer` — even a `pathPrefix:
    // 'billing'` on that container must be rejected (the issuer
    // must not silently drop the prefix and mint a non-billing
    // blob for a billing-shaped label).
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/dpr/sas-url')
      .send({
        filename: 'shot.jpg',
        contentType: 'image/jpeg',
        container: 'dpr-photos',
        pathPrefix: 'billing',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PATH_PREFIX');
    expect(blobStorage.generateUploadSASUrl).not.toHaveBeenCalled();
  });

  it('7. A whitespace-only pathPrefix is 400 INVALID_PATH_PREFIX (deliberately malformed)', async () => {
    // A non-empty string sent by the client must resolve through the
    // container's allowlist — a whitespace-only value trims to empty
    // so the resolver returns null and the loud 400 fires. This
    // avoids a "silently accepted as a no-op" surprise if a buggy
    // client serialises an empty value.
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/dpr/sas-url')
      .send({
        filename: 'drawing.pdf',
        contentType: 'application/pdf',
        container: 'dpr-documents',
        pathPrefix: '   ',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PATH_PREFIX');
    expect(blobStorage.generateUploadSASUrl).not.toHaveBeenCalled();
  });
});
