// DR-016 followup — POST /:id/cancel-correction.
//
// Operator escape hatch when a DRAFT correction is abandoned mid-flow.
// The endpoint transactionally restores the parent row's
// supersededAt = null (so the original reappears in the active set) and
// hard-deletes the correction row.
//
// Acceptance for this file:
//   1. Happy path: cert with parent → cancel-correction → parent reappears
//      (supersededAt cleared, version bumped), correction row gone.
//      Response envelope: { cancelled: true, restoredParentId: <id> }.
//   2. 404 CERTIFICATION_NOT_FOUND when cert id doesn't exist.
//   3. 400 NOT_A_CORRECTION when cert has no parentCertificationId
//      (never was a correction).
//   4. 401 when no Authorization header.
//   5. 403 ADMIN_REQUIRED when caller has a valid JWT but is not admin.
//   6. Idempotent: a second call on the same id returns 404 (the
//      correction row is gone).
//   7. Transaction rollback: if the hard-delete throws mid-tx, the
//      parent's supersededAt must NOT be cleared (the updateMany writes
//      are rolled back together).
//
// The fixture mirrors billing-certifications-dr019-versioning.test.js
// but adds a `delete` mock on billingCertification (the existing fixture
// never deletes).

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
require('express-async-errors');

const billingRouter = require('../src/routes/billingCertifications');

jest.mock('../src/lib/blobStorage', () => ({
  generateReadSASUrl: jest.fn(async (container, blobPath) => ({
    sasUrl: `https://r2.example/${container}/${blobPath}?X-Amz-Signature=stub`,
    container,
    blobPath,
  })),
  READ_URL_TTL_SECONDS: 3600,
}));

const ADMIN_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '55555555-5555-4555-8555-555555555555';
const PROJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CERT_ORIGINAL = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const CERT_DRAFT = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
const CERT_PLAIN = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';

function adminJwt() {
  return `Bearer ${jwt.sign(
    { employeeId: ADMIN_ID, email: 'admin@example.com', isAdmin: true },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  )}`;
}

function userJwt() {
  return `Bearer ${jwt.sign(
    { employeeId: USER_ID, email: 'user@example.com', isAdmin: false },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  )}`;
}

function buildApp({ txShouldThrow } = {}) {
  const app = express();
  app.use(express.json());

  const certRows = new Map();
  const projectRows = new Map();
  projectRows.set(PROJECT_A, { id: PROJECT_A, name: 'Alpha Site', code: 'ALPHA', isActive: true });

  const buildAssignedScopeFindMany = () => jest.fn(async () => []);

  // Mirrors dr019: apply a conditional WHERE clause to a row.
  const rowMatchesWhere = (r, where = {}) => {
    if (where.deletedAt === null && r.deletedAt) return false;
    if (where.status && r.status !== where.status) return false;
    if (where.id && r.id !== where.id) return false;
    if (where.version !== undefined && r.version !== where.version) return false;
    if (where.supersededAt === null && r.supersededAt) return false;
    if (where.supersededAt !== undefined && where.supersededAt !== null) {
      // updateMany conditional writes also see `supersededAt: { not: null }`.
      if (!r.supersededAt) return false;
    }
    if (where.parentCertificationId !== undefined) {
      if (r.parentCertificationId !== where.parentCertificationId) return false;
    }
    return true;
  };

  const prisma = {
    project: {
      findUnique: jest.fn(async ({ where }) => projectRows.get(where.id) || null),
    },
    dPR: { findMany: buildAssignedScopeFindMany() },
    inspectionRecord: { findMany: buildAssignedScopeFindMany() },
    boqItem: { findMany: buildAssignedScopeFindMany() },
    variationOrder: { findMany: buildAssignedScopeFindMany() },
    drawing: { findMany: buildAssignedScopeFindMany() },
    billingCertification: {
      findUnique: jest.fn(async ({ where }) => certRows.get(where.id) || null),
      count: jest.fn(async ({ where = {} } = {}) => {
        return Array.from(certRows.values()).filter((r) => rowMatchesWhere(r, where)).length;
      }),
      updateMany: jest.fn(async ({ where = {}, data }) => {
        const targets = Array.from(certRows.values()).filter((r) => rowMatchesWhere(r, where));
        let count = 0;
        for (const r of targets) {
          for (const [k, v] of Object.entries(data || {})) {
            if (v && typeof v === 'object' && 'increment' in v) {
              r[k] = (r[k] || 0) + v.increment;
            } else {
              r[k] = v;
            }
          }
          r.updatedAt = new Date();
          count += 1;
        }
        return { count };
      }),
      // Cancel-correction hard-deletes the correction row. The route pins
      // on `where: { id, parentCertificationId }` so a row whose parent
      // FK has been re-pointed is protected. When `txShouldThrow` is set
      // we throw mid-call so the outer $transaction can roll back.
      delete: jest.fn(async ({ where }) => {
        if (txShouldThrow) {
          const err = new Error('forced delete failure for tx rollback test');
          err.code = 'P2025';
          throw err;
        }
        const row = certRows.get(where.id);
        if (!row) {
          const err = new Error('not found');
          err.code = 'P2025';
          throw err;
        }
        // Honour the FK pin — refuse if parentCertificationId doesn't match.
        if (where.parentCertificationId !== undefined && row.parentCertificationId !== where.parentCertificationId) {
          const err = new Error('FK pin mismatch');
          err.code = 'P2025';
          throw err;
        }
        certRows.delete(where.id);
        return { ...row };
      }),
    },
    // $transaction mirrors dr019: open a tx scope that re-exposes the
    // same mock objects so updateMany / delete semantics carry through.
    // When `txShouldThrow` is set, the tx callback completes but the
    // inner delete throws — simulating a mid-tx failure that the
    // surrounding $transaction must roll back. Jest doesn't natively
    // roll back in-memory stores, so we snapshot the affected rows
    // before the callback runs and restore them in the catch block.
    $transaction: jest.fn(async (fn) => {
      const tx = {
        billingCertification: {
          updateMany: prisma.billingCertification.updateMany,
          findUnique: prisma.billingCertification.findUnique,
          delete: prisma.billingCertification.delete,
        },
      };
      // Snapshot rows that the transaction will touch so we can restore
      // them on failure (Jest's in-memory Map doesn't roll back). Each
      // row must be a shallow-copied object — Map() copies references, so
      // without the spread the updateMany mutation would leak into the
      // snapshot and our rollback would be a no-op.
      const snapshot = new Map();
      for (const [k, v] of certRows) snapshot.set(k, { ...v });
      try {
        return await fn(tx);
      } catch (err) {
        // Roll back: replace certRows contents with the snapshot.
        certRows.clear();
        for (const [k, v] of snapshot) certRows.set(k, { ...v });
        throw err;
      }
    }),
    employee: {
      findUnique: jest.fn(async ({ where }) => {
        if (where.id === ADMIN_ID) return { id: ADMIN_ID, isAdmin: true };
        if (where.id === USER_ID) return { id: USER_ID, isAdmin: false };
        return null;
      }),
    },
  };

  app.set('prisma', prisma);
  app.use('/api/billing-certifications', billingRouter);
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({
      error: err.message || 'INTERNAL_ERROR',
      code: err.code || 'INTERNAL',
    });
  });
  return { app, prisma, certRows, projectRows };
}

function seedOriginal(id, projectId, recordedById, overrides = {}) {
  return {
    id,
    projectId,
    contractorName: 'ACME Civil Contractors',
    billNumber: 'RA-001',
    billDate: new Date('2026-09-01'),
    invoiceNo: 'INV-001',
    poContractRef: 'PO-2026-001',
    claimedAmount: 100000,
    deductedAmount: 5000,
    certifiedAmount: 95000,
    gstAmount: 17100,
    poValue: 1000000,
    balanceValue: 905000,
    remarks: 'Initial certification',
    status: 'CERTIFIED',
    recordedById,
    certifiedById: recordedById,
    certifiedAt: new Date('2026-09-04'),
    disputedAt: null,
    disputeReason: null,
    blobPath: null,
    filename: null,
    contentType: null,
    sizeBytes: null,
    uploadedAt: null,
    uploadIntentUlid: null,
    deletedAt: null,
    version: 1,
    supersededAt: new Date('2026-09-05'),
    parentCertificationId: null,
    createdAt: new Date('2026-09-04'),
    updatedAt: new Date('2026-09-05'),
    ...overrides,
  };
}

function seedCorrectionDraft(id, projectId, recordedById, parentId, overrides = {}) {
  return {
    id,
    projectId,
    contractorName: 'ACME Civil Contractors',
    billNumber: 'RA-001',
    billDate: new Date('2026-09-01'),
    invoiceNo: 'INV-001',
    poContractRef: 'PO-2026-001',
    claimedAmount: 110000,
    deductedAmount: 5500,
    certifiedAmount: 104500,
    gstAmount: 18810,
    poValue: 1000000,
    balanceValue: 800500,
    remarks: 'Correction draft',
    status: 'DRAFT',
    recordedById,
    certifiedById: null,
    certifiedAt: null,
    disputedAt: null,
    disputeReason: null,
    blobPath: null,
    filename: null,
    contentType: null,
    sizeBytes: null,
    uploadedAt: null,
    uploadIntentUlid: null,
    deletedAt: null,
    version: 0,
    supersededAt: null,
    parentCertificationId: parentId,
    createdAt: new Date('2026-09-05'),
    updatedAt: new Date('2026-09-05'),
    ...overrides,
  };
}

describe('DR-016 followup — POST /:id/cancel-correction', () => {
  test('1. happy path — parent restored (supersededAt cleared, version bumped), correction deleted', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_ORIGINAL, seedOriginal(CERT_ORIGINAL, PROJECT_A, ADMIN_ID));
    certRows.set(CERT_DRAFT, seedCorrectionDraft(CERT_DRAFT, PROJECT_A, ADMIN_ID, CERT_ORIGINAL));

    const res = await request(app)
      .post(`/api/billing-certifications/${CERT_DRAFT}/cancel-correction`)
      .set('Authorization', adminJwt())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cancelled: true, restoredParentId: CERT_ORIGINAL });

    // Parent restored: supersededAt cleared, version bumped from 1 → 2.
    const parent = certRows.get(CERT_ORIGINAL);
    expect(parent.supersededAt).toBeNull();
    expect(parent.version).toBe(2);

    // Correction row hard-deleted.
    expect(certRows.has(CERT_DRAFT)).toBe(false);
  });

  test('2. 404 CERTIFICATION_NOT_FOUND when the correction id does not exist', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post(`/api/billing-certifications/${CERT_DRAFT}/cancel-correction`)
      .set('Authorization', adminJwt())
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CERTIFICATION_NOT_FOUND');
  });

  test('3. 400 NOT_A_CORRECTION when target row has no parentCertificationId', async () => {
    const { app, certRows } = buildApp();
    // CERT_PLAIN is a regular DRAFT row that was never forked from a parent.
    certRows.set(CERT_PLAIN, seedCorrectionDraft(CERT_PLAIN, PROJECT_A, ADMIN_ID, null));

    const res = await request(app)
      .post(`/api/billing-certifications/${CERT_PLAIN}/cancel-correction`)
      .set('Authorization', adminJwt())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_A_CORRECTION');
  });

  test('4. 401 when no Authorization header', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_ORIGINAL, seedOriginal(CERT_ORIGINAL, PROJECT_A, ADMIN_ID));
    certRows.set(CERT_DRAFT, seedCorrectionDraft(CERT_DRAFT, PROJECT_A, ADMIN_ID, CERT_ORIGINAL));

    const res = await request(app)
      .post(`/api/billing-certifications/${CERT_DRAFT}/cancel-correction`)
      .send({});

    expect(res.status).toBe(401);
  });

  test('5. 403 ADMIN_REQUIRED when caller has a valid JWT but is not admin', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_ORIGINAL, seedOriginal(CERT_ORIGINAL, PROJECT_A, ADMIN_ID));
    certRows.set(CERT_DRAFT, seedCorrectionDraft(CERT_DRAFT, PROJECT_A, ADMIN_ID, CERT_ORIGINAL));

    const res = await request(app)
      .post(`/api/billing-certifications/${CERT_DRAFT}/cancel-correction`)
      .set('Authorization', userJwt())
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_REQUIRED');
  });

  test('6. idempotent — second call returns 404 (the correction row is gone)', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_ORIGINAL, seedOriginal(CERT_ORIGINAL, PROJECT_A, ADMIN_ID));
    certRows.set(CERT_DRAFT, seedCorrectionDraft(CERT_DRAFT, PROJECT_A, ADMIN_ID, CERT_ORIGINAL));

    const first = await request(app)
      .post(`/api/billing-certifications/${CERT_DRAFT}/cancel-correction`)
      .set('Authorization', adminJwt())
      .send({});
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/billing-certifications/${CERT_DRAFT}/cancel-correction`)
      .set('Authorization', adminJwt())
      .send({});
    expect(second.status).toBe(404);
    expect(second.body.code).toBe('CERTIFICATION_NOT_FOUND');
  });

  test('7. transaction rollback — if delete fails mid-tx, parent supersededAt must NOT be cleared', async () => {
    const { app, certRows } = buildApp({ txShouldThrow: true });
    const originalSupersededAt = new Date('2026-09-05');
    certRows.set(
      CERT_ORIGINAL,
      seedOriginal(CERT_ORIGINAL, PROJECT_A, ADMIN_ID, { supersededAt: originalSupersededAt, version: 1 }),
    );
    certRows.set(CERT_DRAFT, seedCorrectionDraft(CERT_DRAFT, PROJECT_A, ADMIN_ID, CERT_ORIGINAL));

    const res = await request(app)
      .post(`/api/billing-certifications/${CERT_DRAFT}/cancel-correction`)
      .set('Authorization', adminJwt())
      .send({});

    // Surface as 409 VERSION_CONFLICT (the delete throws P2025).
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');

    // Parent must still be superseded — the updateMany write was rolled back.
    const parent = certRows.get(CERT_ORIGINAL);
    expect(parent.supersededAt).toEqual(originalSupersededAt);
    expect(parent.version).toBe(1);

    // Correction row must still exist — delete was rolled back.
    expect(certRows.has(CERT_DRAFT)).toBe(true);
  });
});
