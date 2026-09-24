// DR-016 followup + DR-025 (audit 2026-09-24) — POST /:id/cancel-correction.
//
// Operator escape hatch when a DRAFT correction is abandoned mid-flow.
// The endpoint transactionally transitions the correction row
// DRAFT → CANCELLED (preserving the audit row — the chain stays
// walkable via parent FK) and restores the parent row's
// supersededAt = null (so the original reappears in the active set).
//
// Acceptance for this file:
//   1. Happy path: DRAFT correction with parent → cancel-correction →
//      correction row stays with status=CANCELLED + version +1, parent
//      reappears (supersededAt cleared, version bumped). Response
//      envelope: { cancelled: true, restoredParentId: <id> }.
//   2. 404 CERTIFICATION_NOT_FOUND when cert id doesn't exist.
//   3. 400 NOT_A_CORRECTION when cert has no parentCertificationId
//      (never was a correction).
//   4. 401 when no Authorization header.
//   5. 403 ADMIN_REQUIRED when caller has a valid JWT but is not admin.
//   6. Second call after CANCELLED returns 409 ALREADY_TERMINAL (the row
//      is still in the table, just no longer in DRAFT — we can see it).
//   7. Transaction rollback: if the parent restore throws mid-tx, the
//      correction's status must NOT flip to CANCELLED (the updateMany
//      writes are rolled back together).
//   8. expectedVersion is REQUIRED — missing / non-integer → 400
//      VALIDATION_ERROR.
//   9. 409 STALE_VERSION when expectedVersion doesn't match the live
//      version (DR-025 literal verdict text).
//  10. 409 ALREADY_TERMINAL when the correction is CERTIFIED (history
//      cannot be destroyed).
//  11. 409 ALREADY_TERMINAL when the correction is DISPUTED (same).
//  12. 409 HAS_SUCCESSOR when the correction has a non-deleted successor
//      (cancel would orphan the descendant's parent FK — the admin's
//      escape hatch is to open the successor and cancel THAT instead).
//
// The fixture mirrors billing-certifications-dr019-versioning.test.js
// plus DR-025 additions: no `delete` mock (correction rows are never
// hard-deleted in this revision) and a `findFirst` mock for the leaf
// guard.

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
const CERT_SUCCESSOR = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4';

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
      // [DR-025] Leaf guard — does this correction have a non-deleted
      // successor whose parentCertificationId points at it? Return the
      // first match (the route only needs to know IF one exists; the
      // successorId is forwarded to the client for the "open the
      // successor instead" affordance).
      findFirst: jest.fn(async ({ where = {} } = {}) => {
        for (const r of certRows.values()) {
          if (where.deletedAt === null && r.deletedAt) continue;
          if (where.parentCertificationId && r.parentCertificationId !== where.parentCertificationId) continue;
          return { id: r.id, status: r.status, version: r.version };
        }
        return null;
      }),
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
    },
    // $transaction mirrors dr019: open a tx scope that re-exposes the
    // same mock objects so updateMany semantics carry through. When
    // `txShouldThrow` is set, the inner updateMany that restores the
    // parent throws — simulating a mid-tx failure that the surrounding
    // $transaction must roll back. Jest doesn't natively roll back
    // in-memory stores, so we snapshot the affected rows before the
    // callback runs and restore them in the catch block.
    $transaction: jest.fn(async (fn) => {
      const tx = {
        billingCertification: {
          updateMany: prisma.billingCertification.updateMany,
          findUnique: prisma.billingCertification.findUnique,
          findFirst: prisma.billingCertification.findFirst,
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
        const result = await fn(tx);
        if (txShouldThrow) {
          // Simulate the parent-restore updateMany throwing mid-tx.
          // The correction row has just been flipped to CANCELLED by the
          // earlier updateMany — throw AFTER the flip but BEFORE the
          // parent restore, which is the failure mode DR-025's atomicity
          // requirement targets.
          throw Object.assign(new Error('forced parent restore failure for tx rollback test'), { code: 'P2025' });
        }
        return result;
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

describe('DR-025 — POST /:id/cancel-correction (versioned, leaf-DRAFT, audit-preserving)', () => {
  test('1. happy path — correction flipped DRAFT → CANCELLED (row retained), parent restored', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_ORIGINAL, seedOriginal(CERT_ORIGINAL, PROJECT_A, ADMIN_ID));
    certRows.set(CERT_DRAFT, seedCorrectionDraft(CERT_DRAFT, PROJECT_A, ADMIN_ID, CERT_ORIGINAL));

    const res = await request(app)
      .post(`/api/billing-certifications/${CERT_DRAFT}/cancel-correction`)
      .set('Authorization', adminJwt())
      .send({ expectedVersion: 0 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cancelled: true, restoredParentId: CERT_ORIGINAL });

    // Correction row RETAINED (audit history preserved) — status now
    // CANCELLED, version bumped 0 → 1.
    const correction = certRows.get(CERT_DRAFT);
    expect(correction).toBeDefined();
    expect(correction.status).toBe('CANCELLED');
    expect(correction.version).toBe(1);
    expect(correction.parentCertificationId).toBe(CERT_ORIGINAL);

    // Parent restored: supersededAt cleared, version bumped from 1 → 2.
    const parent = certRows.get(CERT_ORIGINAL);
    expect(parent.supersededAt).toBeNull();
    expect(parent.version).toBe(2);
  });

  test('2. 404 CERTIFICATION_NOT_FOUND when the correction id does not exist', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post(`/api/billing-certifications/${CERT_DRAFT}/cancel-correction`)
      .set('Authorization', adminJwt())
      .send({ expectedVersion: 0 });

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
      .send({ expectedVersion: 0 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_A_CORRECTION');
  });

  test('4. 401 when no Authorization header', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_ORIGINAL, seedOriginal(CERT_ORIGINAL, PROJECT_A, ADMIN_ID));
    certRows.set(CERT_DRAFT, seedCorrectionDraft(CERT_DRAFT, PROJECT_A, ADMIN_ID, CERT_ORIGINAL));

    const res = await request(app)
      .post(`/api/billing-certifications/${CERT_DRAFT}/cancel-correction`)
      .send({ expectedVersion: 0 });

    expect(res.status).toBe(401);
  });

  test('5. 403 ADMIN_REQUIRED when caller has a valid JWT but is not admin', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_ORIGINAL, seedOriginal(CERT_ORIGINAL, PROJECT_A, ADMIN_ID));
    certRows.set(CERT_DRAFT, seedCorrectionDraft(CERT_DRAFT, PROJECT_A, ADMIN_ID, CERT_ORIGINAL));

    const res = await request(app)
      .post(`/api/billing-certifications/${CERT_DRAFT}/cancel-correction`)
      .set('Authorization', userJwt())
      .send({ expectedVersion: 0 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_REQUIRED');
  });

  test('6. second call after CANCELLED returns 409 ALREADY_TERMINAL (the row stays in the table)', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_ORIGINAL, seedOriginal(CERT_ORIGINAL, PROJECT_A, ADMIN_ID));
    certRows.set(CERT_DRAFT, seedCorrectionDraft(CERT_DRAFT, PROJECT_A, ADMIN_ID, CERT_ORIGINAL));

    const first = await request(app)
      .post(`/api/billing-certifications/${CERT_DRAFT}/cancel-correction`)
      .set('Authorization', adminJwt())
      .send({ expectedVersion: 0 });
    expect(first.status).toBe(200);

    // After cancel: correction has version=1, status=CANCELLED.
    // A second call passes expectedVersion=1 (the bumped live version)
    // but the status guard refuses non-DRAFT → 409 ALREADY_TERMINAL.
    const second = await request(app)
      .post(`/api/billing-certifications/${CERT_DRAFT}/cancel-correction`)
      .set('Authorization', adminJwt())
      .send({ expectedVersion: 1 });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('ALREADY_TERMINAL');
    expect(second.body.status).toBe('CANCELLED');
  });

  test('7. transaction rollback — if parent restore fails mid-tx, correction must NOT be flipped to CANCELLED', async () => {
    const { app, certRows } = buildApp({ txShouldThrow: true });
    certRows.set(
      CERT_ORIGINAL,
      seedOriginal(CERT_ORIGINAL, PROJECT_A, ADMIN_ID, {
        supersededAt: new Date('2026-09-05'),
        version: 1,
      }),
    );
    certRows.set(
      CERT_DRAFT,
      seedCorrectionDraft(CERT_DRAFT, PROJECT_A, ADMIN_ID, CERT_ORIGINAL, { version: 0, status: 'DRAFT' }),
    );

    const res = await request(app)
      .post(`/api/billing-certifications/${CERT_DRAFT}/cancel-correction`)
      .set('Authorization', adminJwt())
      .send({ expectedVersion: 0 });

    // Surface as 409 STALE_VERSION (the parent-restore updateMany throws
    // P2025).
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STALE_VERSION');

    // Correction must still be DRAFT (the cancel updateMany was rolled
    // back together with the parent restore).
    const correction = certRows.get(CERT_DRAFT);
    expect(correction.status).toBe('DRAFT');
    expect(correction.version).toBe(0);

    // Parent must still be superseded (the restore updateMany was rolled
    // back).
    const parent = certRows.get(CERT_ORIGINAL);
    expect(parent.supersededAt).toEqual(new Date('2026-09-05'));
    expect(parent.version).toBe(1);
  });

  test('8. 400 VALIDATION_ERROR when expectedVersion is missing (DR-025 literal contract)', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_ORIGINAL, seedOriginal(CERT_ORIGINAL, PROJECT_A, ADMIN_ID));
    certRows.set(CERT_DRAFT, seedCorrectionDraft(CERT_DRAFT, PROJECT_A, ADMIN_ID, CERT_ORIGINAL));

    const res = await request(app)
      .post(`/api/billing-certifications/${CERT_DRAFT}/cancel-correction`)
      .set('Authorization', adminJwt())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.message).toMatch(/expectedVersion/);
  });

  test('8b. 400 VALIDATION_ERROR when expectedVersion is a non-integer string', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_ORIGINAL, seedOriginal(CERT_ORIGINAL, PROJECT_A, ADMIN_ID));
    certRows.set(CERT_DRAFT, seedCorrectionDraft(CERT_DRAFT, PROJECT_A, ADMIN_ID, CERT_ORIGINAL));

    const res = await request(app)
      .post(`/api/billing-certifications/${CERT_DRAFT}/cancel-correction`)
      .set('Authorization', adminJwt())
      .send({ expectedVersion: 'three' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('9. 409 STALE_VERSION when expectedVersion doesn\'t match live version (DR-025 literal verdict text)', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_ORIGINAL, seedOriginal(CERT_ORIGINAL, PROJECT_A, ADMIN_ID));
    certRows.set(
      CERT_DRAFT,
      seedCorrectionDraft(CERT_DRAFT, PROJECT_A, ADMIN_ID, CERT_ORIGINAL, { version: 0 }),
    );

    // Caller passes version=5 but the row is still at version=0.
    const res = await request(app)
      .post(`/api/billing-certifications/${CERT_DRAFT}/cancel-correction`)
      .set('Authorization', adminJwt())
      .send({ expectedVersion: 5 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STALE_VERSION');
    expect(res.body.currentVersion).toBe(0);

    // No side effects: correction still DRAFT, parent still superseded.
    const correction = certRows.get(CERT_DRAFT);
    expect(correction.status).toBe('DRAFT');
    expect(correction.version).toBe(0);
    const parent = certRows.get(CERT_ORIGINAL);
    expect(parent.supersededAt).not.toBeNull();
    expect(parent.version).toBe(1);
  });

  test('10. 409 ALREADY_TERMINAL when correction is CERTIFIED (history cannot be destroyed)', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_ORIGINAL, seedOriginal(CERT_ORIGINAL, PROJECT_A, ADMIN_ID));
    certRows.set(
      CERT_DRAFT,
      seedCorrectionDraft(CERT_DRAFT, PROJECT_A, ADMIN_ID, CERT_ORIGINAL, {
        status: 'CERTIFIED',
        version: 1,
        certifiedById: ADMIN_ID,
        certifiedAt: new Date('2026-09-06'),
      }),
    );

    const res = await request(app)
      .post(`/api/billing-certifications/${CERT_DRAFT}/cancel-correction`)
      .set('Authorization', adminJwt())
      .send({ expectedVersion: 1 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_TERMINAL');
    expect(res.body.status).toBe('CERTIFIED');

    // No side effects.
    const correction = certRows.get(CERT_DRAFT);
    expect(correction.status).toBe('CERTIFIED');
    expect(correction.version).toBe(1);
    const parent = certRows.get(CERT_ORIGINAL);
    expect(parent.supersededAt).not.toBeNull();
  });

  test('11. 409 ALREADY_TERMINAL when correction is DISPUTED', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_ORIGINAL, seedOriginal(CERT_ORIGINAL, PROJECT_A, ADMIN_ID));
    certRows.set(
      CERT_DRAFT,
      seedCorrectionDraft(CERT_DRAFT, PROJECT_A, ADMIN_ID, CERT_ORIGINAL, {
        status: 'DISPUTED',
        version: 1,
        disputedAt: new Date('2026-09-06'),
        disputeReason: 'client pushback',
      }),
    );

    const res = await request(app)
      .post(`/api/billing-certifications/${CERT_DRAFT}/cancel-correction`)
      .set('Authorization', adminJwt())
      .send({ expectedVersion: 1 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_TERMINAL');
    expect(res.body.status).toBe('DISPUTED');

    // No side effects.
    const correction = certRows.get(CERT_DRAFT);
    expect(correction.status).toBe('DISPUTED');
    expect(correction.version).toBe(1);
  });

  test('12. 409 HAS_SUCCESSOR when correction already has a non-deleted successor', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_ORIGINAL, seedOriginal(CERT_ORIGINAL, PROJECT_A, ADMIN_ID));
    // A second-generation correction whose parent points at the DRAFT
    // correction we're trying to cancel. Cancelling the parent would
    // orphan CERT_SUCCESSOR's parent FK — admin's escape hatch is to
    // cancel CERT_SUCCESSOR instead.
    certRows.set(CERT_DRAFT, seedCorrectionDraft(CERT_DRAFT, PROJECT_A, ADMIN_ID, CERT_ORIGINAL));
    certRows.set(
      CERT_SUCCESSOR,
      seedCorrectionDraft(CERT_SUCCESSOR, PROJECT_A, ADMIN_ID, CERT_DRAFT, {
        status: 'DRAFT',
        version: 0,
        supersededAt: null,
      }),
    );

    const res = await request(app)
      .post(`/api/billing-certifications/${CERT_DRAFT}/cancel-correction`)
      .set('Authorization', adminJwt())
      .send({ expectedVersion: 0 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('HAS_SUCCESSOR');
    expect(res.body.successorId).toBe(CERT_SUCCESSOR);
    expect(res.body.successorStatus).toBe('DRAFT');

    // No side effects — neither row was touched.
    const correction = certRows.get(CERT_DRAFT);
    expect(correction.status).toBe('DRAFT');
    expect(correction.version).toBe(0);
    const parent = certRows.get(CERT_ORIGINAL);
    expect(parent.supersededAt).not.toBeNull();
  });
});
