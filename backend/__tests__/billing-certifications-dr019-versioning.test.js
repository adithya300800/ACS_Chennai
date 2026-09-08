// DR-019 (audit, 2026-09-08) — Version-pinned billing certifications + correction history.
//
// Audit verdict (Code review by SOL/ACS-Portal-Workflow-Completeness-Review-
// 2026-09-08-5c61cd8.md, lines 300-310):
//
//   "No-PDF draft -> CERTIFIED -> DISPUTED worked. There was no draft/
//    correction editor; disputed offered recertification rather than a
//    correction workflow. Source permits certified amounts/PDF to change
//    while retaining prior approval metadata. Competing VO/COP decisions
//    and stale edits read state first and later update by ID alone — no
//    version pin."
//
// Acceptance for this round:
//   1. PATCH with the wrong `expectedVersion` returns 409 VERSION_CONFLICT
//      (stale tab cannot silently overwrite an approved row).
//   2. PATCH with the correct `expectedVersion` returns 200, version
//      increments by 1.
//   3. POST /:id/correct on a CERTIFIED row creates a NEW DRAFT row
//      whose `parentCertificationId` points at the original, and stamps
//      `supersededAt` on the original in the same transaction. Prior
//      amounts / reasons / actors are preserved verbatim on the original.
//   4. POST /:id/certify with the wrong `expectedVersion` returns 409.
//   5. POST /:id/dispute on a superseded row returns 409 SUPERSEDED.
//   6. POST /:id/correct on an already-superseded row returns 409 SUPERSEDED.
//   7. List endpoint excludes supersededAt != null rows by default
//      (the active row only — the correction chain is reachable via
//      the detail endpoint + the parentCertificationId FK).
//
// The test fixture mirrors billing-certifications.test.js but adds:
//   - `supersededAt` field on seed rows (default null)
//   - `version` field on seed rows (default 0)
//   - `updateMany` support on the prisma mock (the new PATCH / /certify /
//     /dispute / /correct handlers all use updateMany for conditional
//     writes; the legacy update path remains for legacy callers).
//   - `$transaction` support (the /correct handler opens a transaction so
//     the correction + supersede stamp commit atomically).

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

function adminJwt() {
  return `Bearer ${jwt.sign(
    { employeeId: ADMIN_ID, email: 'admin@example.com', isAdmin: true },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  )}`;
}

function buildApp() {
  const app = express();
  app.use(express.json());

  const certRows = new Map();
  const projectRows = new Map();
  projectRows.set(PROJECT_A, { id: PROJECT_A, name: 'Alpha Site', code: 'ALPHA', isActive: true });

  const buildAssignedScopeFindMany = () => jest.fn(async () => []);

  // Helper: apply a conditional WHERE clause to a row.
  const rowMatchesWhere = (r, where = {}) => {
    if (where.deletedAt === null && r.deletedAt) return false;
    if (where.status && r.status !== where.status) return false;
    if (where.id && r.id !== where.id) return false;
    if (where.version !== undefined && r.version !== where.version) return false;
    if (where.supersededAt === null && r.supersededAt) return false;
    if (where.supersededAt !== undefined && where.supersededAt !== null) {
      // Route may check `supersededAt: null` (filter) — handled above.
      // For updateMany conditional writes we also see explicit
      // supersededAt values when looking up a "must still be active"
      // pin; treat any non-null row as a mismatch.
      if (r.supersededAt) return false;
    }
    if (where.parentCertificationId !== undefined) {
      if (r.parentCertificationId !== where.parentCertificationId) return false;
    }
    return true;
  };

  const prisma = {
    project: {
      findUnique: jest.fn(async ({ where }) => projectRows.get(where.id) || null),
      findMany: jest.fn(async ({ where }) => {
        const ids = (where?.id?.in || []);
        return ids.map((id) => projectRows.get(id)).filter(Boolean);
      }),
    },
    dPR: { findMany: buildAssignedScopeFindMany() },
    inspectionRecord: { findMany: buildAssignedScopeFindMany() },
    boqItem: { findMany: buildAssignedScopeFindMany() },
    variationOrder: { findMany: buildAssignedScopeFindMany() },
    drawing: { findMany: buildAssignedScopeFindMany() },
    billingCertification: {
      findMany: jest.fn(async ({ where = {}, include, take } = {}) => {
        let rows = Array.from(certRows.values()).filter((r) => rowMatchesWhere(r, where));
        if (typeof take === 'number') rows = rows.slice(0, take);
        if (include) {
          rows = rows.map((r) => ({
            ...r,
            project: include.project ? projectRows.get(r.projectId) || null : undefined,
            recordedBy: include.recordedBy ? {
              id: r.recordedById,
              name: r.recordedByName || 'Recorder',
              designation: null,
            } : undefined,
            certifiedBy: include.certifiedBy ? (r.certifiedById ? {
              id: r.certifiedById,
              name: r.certifiedByName || 'Certifier',
              designation: null,
            } : null) : undefined,
          }));
        }
        return rows;
      }),
      findUnique: jest.fn(async ({ where, include }) => {
        const row = certRows.get(where.id);
        if (!row) return null;
        if (!include) return row;
        return {
          ...row,
          project: include.project ? projectRows.get(row.projectId) || null : undefined,
          recordedBy: include.recordedBy ? {
            id: row.recordedById,
            name: row.recordedByName || 'Recorder',
            designation: null,
          } : undefined,
          certifiedBy: include.certifiedBy ? (row.certifiedById ? {
            id: row.certifiedById,
            name: row.certifiedByName || 'Certifier',
            designation: null,
          } : null) : undefined,
        };
      }),
      count: jest.fn(async ({ where = {} } = {}) => {
        return Array.from(certRows.values()).filter((r) => rowMatchesWhere(r, where)).length;
      }),
      groupBy: jest.fn(async () => []),
      create: jest.fn(async ({ data }) => {
        const row = {
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: data.deletedAt ?? null,
          // version / supersededAt / parentCertificationId default to the
          // schema defaults when omitted; surface them on the seeded row
          // so the route's `existing.version` check matches real DB
          // semantics.
          version: data.version ?? 0,
          supersededAt: data.supersededAt ?? null,
          parentCertificationId: data.parentCertificationId ?? null,
          // Mirror Prisma's "not provided → null" for nullable columns —
          // the route's serializer passes the value through verbatim, so
          // an undefined on the seed row surfaces as undefined on the
          // wire (when the route tests expect null). Default the common
          // ones explicitly.
          certifiedById: data.certifiedById ?? null,
          certifiedAt: data.certifiedAt ?? null,
          disputedAt: data.disputedAt ?? null,
          disputeReason: data.disputeReason ?? null,
        };
        certRows.set(row.id, row);
        return row;
      }),
      // DR-019: updateMany is the conditional-write workhorse — the
      // route pins (id, version, supersededAt, status) on the WHERE
      // and increments version on SET. We replicate that exactly so a
      // version mismatch surfaces as `count !== 1`.
      updateMany: jest.fn(async ({ where = {}, data }) => {
        const targets = Array.from(certRows.values()).filter((r) => rowMatchesWhere(r, where));
        let count = 0;
        for (const r of targets) {
          // Apply data. If `version: { increment: 1 }` was passed,
          // resolve it to the increment.
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
      update: jest.fn(async ({ where, data }) => {
        const row = certRows.get(where.id);
        if (!row) {
          const err = new Error('not found');
          err.code = 'P2025';
          throw err;
        }
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
    },
    // /correct opens a $transaction to atomically stamp supersededAt +
    // create the new row. Reuse the same client surface — pass-through
    // to the same mock objects so the count semantics from updateMany
    // carry through inside the tx callback.
    $transaction: jest.fn(async (fn) => {
      const tx = {
        billingCertification: {
          create: prisma.billingCertification.create,
          updateMany: prisma.billingCertification.updateMany,
          findUnique: prisma.billingCertification.findUnique,
        },
      };
      return await fn(tx);
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

// Seed a DRAFT certification row.
function seedDraft(id, projectId, recordedById, overrides = {}) {
  const row = {
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
    parentCertificationId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  return row;
}

describe('DR-019 — version-pinned billing certifications + correction history', () => {
  describe('PATCH /:id with expectedVersion pin', () => {
    test('rejects PATCH with stale version (409 VERSION_CONFLICT)', async () => {
      const { app, certRows } = buildApp();
      certRows.set(CERT_DRAFT, seedDraft(CERT_DRAFT, PROJECT_A, ADMIN_ID, { version: 3 }));

      const res = await request(app)
        .patch(`/api/billing-certifications/${CERT_DRAFT}`)
        .set('Authorization', adminJwt())
        .send({ remarks: 'Stale edit', expectedVersion: 1 });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('VERSION_CONFLICT');
      expect(res.body.currentVersion).toBe(3);
    });

    test('accepts PATCH with matching version (200, version increments)', async () => {
      const { app, certRows } = buildApp();
      certRows.set(CERT_DRAFT, seedDraft(CERT_DRAFT, PROJECT_A, ADMIN_ID, { version: 2 }));

      const res = await request(app)
        .patch(`/api/billing-certifications/${CERT_DRAFT}`)
        .set('Authorization', adminJwt())
        .send({ remarks: 'Updated remark', expectedVersion: 2 });

      expect(res.status).toBe(200);
      expect(res.body.version).toBe(3);
      expect(res.body.remarks).toBe('Updated remark');
    });

    test('legacy PATCH (no expectedVersion) still works for in-flight clients', async () => {
      const { app, certRows } = buildApp();
      certRows.set(CERT_DRAFT, seedDraft(CERT_DRAFT, PROJECT_A, ADMIN_ID));

      const res = await request(app)
        .patch(`/api/billing-certifications/${CERT_DRAFT}`)
        .set('Authorization', adminJwt())
        .send({ remarks: 'Legacy client' });

      expect(res.status).toBe(200);
      expect(res.body.remarks).toBe('Legacy client');
      expect(res.body.version).toBe(1);
    });
  });

  describe('POST /:id/certify with version pin', () => {
    test('rejects certify on a row whose version moved underneath the caller', async () => {
      const { app, certRows } = buildApp();
      certRows.set(CERT_DRAFT, seedDraft(CERT_DRAFT, PROJECT_A, ADMIN_ID, {
        version: 5,
        status: 'DRAFT',
      }));

      const res = await request(app)
        .post(`/api/billing-certifications/${CERT_DRAFT}/certify`)
        .set('Authorization', adminJwt())
        .send({ expectedVersion: 4 });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('VERSION_CONFLICT');
      expect(res.body.currentVersion).toBe(5);
    });

    test('certifies with matching version + increments', async () => {
      const { app, certRows } = buildApp();
      certRows.set(CERT_DRAFT, seedDraft(CERT_DRAFT, PROJECT_A, ADMIN_ID, {
        version: 0,
        status: 'DRAFT',
      }));

      const res = await request(app)
        .post(`/api/billing-certifications/${CERT_DRAFT}/certify`)
        .set('Authorization', adminJwt())
        .send({ expectedVersion: 0 });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('CERTIFIED');
      expect(res.body.version).toBe(1);
      expect(res.body.certifiedById).toBe(ADMIN_ID);
    });
  });

  describe('POST /:id/dispute on a superseded row', () => {
    test('rejects dispute with 409 SUPERSEDED when the row has been superseded', async () => {
      const { app, certRows } = buildApp();
      const supersededAt = new Date('2026-09-05');
      certRows.set(CERT_DRAFT, seedDraft(CERT_DRAFT, PROJECT_A, ADMIN_ID, {
        status: 'CERTIFIED',
        version: 2,
        supersededAt,
        certifiedById: ADMIN_ID,
        certifiedAt: new Date('2026-09-04'),
      }));

      const res = await request(app)
        .post(`/api/billing-certifications/${CERT_DRAFT}/dispute`)
        .set('Authorization', adminJwt())
        .send({ reason: 'Stale dispute attempt' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SUPERSEDED');
    });
  });

  describe('POST /:id/correct (DR-019 correction flow)', () => {
    test('creates a new DRAFT row pointing at the original + stamps supersededAt', async () => {
      const { app, certRows, prisma } = buildApp();
      certRows.set(CERT_ORIGINAL, seedDraft(CERT_ORIGINAL, PROJECT_A, ADMIN_ID, {
        status: 'CERTIFIED',
        version: 1,
        certifiedById: ADMIN_ID,
        certifiedAt: new Date('2026-09-04'),
      }));

      const res = await request(app)
        .post(`/api/billing-certifications/${CERT_ORIGINAL}/correct`)
        .set('Authorization', adminJwt())
        .send({ expectedVersion: 1 });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('DRAFT');
      expect(res.body.parentCertificationId).toBe(CERT_ORIGINAL);
      expect(res.body.version).toBe(0);
      expect(res.body.certifiedById).toBeNull();
      expect(res.body.certifiedAt).toBeNull();
      // Prior amounts are carried forward verbatim.
      expect(res.body.claimedAmount).toBe(100000);
      expect(res.body.certifiedAmount).toBe(95000);
      expect(res.body.gstAmount).toBe(17100);

      // Original row retains its prior metadata + gets supersededAt stamped.
      const original = certRows.get(CERT_ORIGINAL);
      expect(original.supersededAt).toBeInstanceOf(Date);
      expect(original.certifiedById).toBe(ADMIN_ID);
      expect(original.certifiedAmount).toBe(95000);
      expect(original.version).toBe(2);

      // The transactional create + supersede happened.
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    test('rejects correction on an already-superseded row', async () => {
      const { app, certRows } = buildApp();
      certRows.set(CERT_ORIGINAL, seedDraft(CERT_ORIGINAL, PROJECT_A, ADMIN_ID, {
        status: 'CERTIFIED',
        version: 2,
        supersededAt: new Date('2026-09-05'),
      }));

      const res = await request(app)
        .post(`/api/billing-certifications/${CERT_ORIGINAL}/correct`)
        .set('Authorization', adminJwt())
        .send({ expectedVersion: 2 });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SUPERSEDED');
    });

    test('rejects correction with stale expectedVersion', async () => {
      const { app, certRows } = buildApp();
      certRows.set(CERT_ORIGINAL, seedDraft(CERT_ORIGINAL, PROJECT_A, ADMIN_ID, {
        status: 'CERTIFIED',
        version: 5,
      }));

      const res = await request(app)
        .post(`/api/billing-certifications/${CERT_ORIGINAL}/correct`)
        .set('Authorization', adminJwt())
        .send({ expectedVersion: 3 });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('VERSION_CONFLICT');
      expect(res.body.currentVersion).toBe(5);
    });
  });

  describe('list endpoint excludes superseded rows by default', () => {
    test('GET / excludes rows with supersededAt set (the active correction only)', async () => {
      const { app, certRows } = buildApp();
      // Seed the original (superseded) + the active correction. The
      // correction should be in the list; the original should not.
      certRows.set(CERT_ORIGINAL, seedDraft(CERT_ORIGINAL, PROJECT_A, ADMIN_ID, {
        status: 'CERTIFIED',
        version: 2,
        supersededAt: new Date('2026-09-05'),
      }));
      certRows.set('cccccccc-cccc-4ccc-8ccc-ccccccccccc3', seedDraft(
        'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
        PROJECT_A,
        ADMIN_ID,
        {
          status: 'DRAFT',
          parentCertificationId: CERT_ORIGINAL,
        },
      ));

      const res = await request(app)
        .get('/api/billing-certifications')
        .set('Authorization', adminJwt());

      expect(res.status).toBe(200);
      const ids = res.body.certifications.map((c) => c.id);
      expect(ids).toContain('cccccccc-cccc-4ccc-8ccc-ccccccccccc3');
      expect(ids).not.toContain(CERT_ORIGINAL);
    });
  });
});
