// DR-015 (audit, 2026-09-08) — Financial versioning and approval-content
// boundaries. The audit found that `expectedVersion` (a transport-only
// optimistic-concurrency pin) was being spread into the Prisma `data`
// payload on the VO PATCH route even though it is NOT a model field.
// Real Prisma would throw `Unknown argument 'expectedVersion'`. The
// mock in variations-dr019-versioning.test.js accidentally tolerates
// the leak (it just sets `row.expectedVersion = v` without complaint),
// so this file uses a STRICT mock that rejects any unexpected key in
// the data payload.
//
// The other half of DR-015 is the COP PATCH gate: financial/PDF PATCH
// must be DRAFT-only. The audit calls out that a matching-version COP
// PATCH could rewrite CERTIFIED financial/PDF content while retaining
// the prior approval identity/time — preserving the wrong audit trail.
// The fix is a status gate (return 409 INVALID_TRANSITION) plus a
// status pin in the conditional WHERE (defense-in-depth against TOCTOU).
//
// Acceptance for this file:
//   1. VO PATCH with `expectedVersion` does NOT pass `expectedVersion`
//      into Prisma's `data` (otherwise Prisma would 500 with
//      `Unknown argument 'expectedVersion'`).
//   2. VO PATCH still respects the version pin (stale → 409, matching →
//      200 + increment) — the strip doesn't break the gate.
//   3. COP PATCH on a CERTIFIED row returns 409 INVALID_TRANSITION.
//   4. COP PATCH on a DISPUTED row returns 409 INVALID_TRANSITION.
//   5. COP PATCH on a DRAFT row still works (legacy callers, no version
//      pin) — the gate doesn't break in-flight edits.
//   6. COP PATCH WHERE pins status='DRAFT' (defense-in-depth TOCTOU
//      closure).

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
require('express-async-errors');

const variationsRouter = require('../src/routes/variations');
const billingRouter = require('../src/routes/billingCertifications');

jest.mock('../src/lib/blobStorage', () => ({
  generateReadSASUrl: jest.fn(async (container, blobPath) => ({
    sasUrl: `https://r2.example/${container}/${blobPath}?X-Amz-Signature=stub`,
    container,
    blobPath,
  })),
  READ_URL_TTL_SECONDS: 3600,
}));

const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RAISER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROJECT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const VARIATION_ID = '7e8d3f1a-1234-4abc-9def-02468ace1357';
const CERT_DRAFT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CERT_CERTIFIED = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CERT_DISPUTED = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

// Known VariationOrder model fields. Any key in Prisma's `data` spread
// outside this set should be rejected by real Prisma with
// `Unknown argument '<key>'`. The STRICT mock below enforces this —
// the legacy mocks in variations-dr019-versioning.test.js accept any
// key, which is why the bug went unnoticed.
const VARIATION_MODEL_FIELDS = new Set([
  'id', 'projectId', 'title', 'description', 'deltaAmount', 'status',
  'clientApprovalRequired', 'raisedById', 'approvedById', 'rejectedReason',
  'submittedAt', 'approvedAt', 'rejectedAt', 'version', 'createdAt',
  'updatedAt',
]);

const BILLING_MODEL_FIELDS = new Set([
  'id', 'projectId', 'contractorName', 'billNumber', 'billDate',
  'invoiceNo', 'poContractRef', 'claimedAmount', 'deductedAmount',
  'certifiedAmount', 'gstAmount', 'poValue', 'balanceValue', 'remarks',
  'status', 'recordedById', 'certifiedById', 'certifiedAt', 'disputedAt',
  'disputeReason', 'filename', 'contentType', 'sizeBytes', 'blobPath',
  'uploadedAt', 'deletedAt', 'uploadIntentUlid', 'version',
  'parentCertificationId', 'supersededAt', 'idempotencyKey',
  'createdAt', 'updatedAt',
]);

function strictDataSpy(getDataRef) {
  // Wraps a Prisma-style `data` payload inspection: tracks the LAST
  // data object passed to update/updateMany/update and records whether
  // any unknown (non-model) key leaked in. The test asserts `false`.
  return {
    lastData: null,
    leakDetected: false,
    inspect(data) {
      this.lastData = data;
      for (const k of Object.keys(data || {})) {
        if (!getDataRef().has(k)) {
          this.leakDetected = true;
          // Mirror real Prisma's failure mode so the route surfaces a
          // 500 rather than silently corrupting state.
          const err = new Error(`Unknown argument '${k}'`);
          err.code = 'P2009';
          throw err;
        }
      }
    },
  };
}

function buildVariationApp() {
  const app = express();
  app.use(express.json());
  const variations = {};

  const rowMatches = (row, where = {}) => {
    if (where.id && row.id !== where.id) return false;
    if (where.version !== undefined && row.version !== where.version) return false;
    if (where.status && row.status !== where.status) return false;
    return true;
  };

  const spy = strictDataSpy(() => VARIATION_MODEL_FIELDS);

  const prisma = {
    variationOrder: {
      findUnique: async ({ where }) => {
        const row = variations[where.id];
        if (!row) return null;
        return {
          ...row,
          project: { id: row.projectId, name: 'P', code: 'P-1' },
          raisedBy: { id: row.raisedById, name: 'R', email: 'r@example.com' },
          approvedBy: row.approvedById ? { id: row.approvedById, name: 'A', email: 'a@example.com' } : null,
        };
      },
      updateMany: async ({ where = {}, data }) => {
        spy.inspect(data);
        const targets = Object.values(variations).filter((r) => rowMatches(r, where));
        for (const row of targets) {
          for (const [k, v] of Object.entries(data || {})) {
            if (v && typeof v === 'object' && 'increment' in v) {
              row[k] = (row[k] || 0) + v.increment;
            } else if (k === 'deltaAmount') {
              row[k] = String(v);
            } else {
              row[k] = v;
            }
          }
        }
        return { count: targets.length };
      },
    },
    employee: {
      findUnique: async ({ where }) => {
        if (where.id === ADMIN_ID) return { id: ADMIN_ID, isAdmin: true };
        return { id: where.id, isAdmin: false };
      },
    },
  };

  app.set('prisma', prisma);
  app.use('/api/variations', variationsRouter);
  return { app, prisma, variations, spy };
}

function variationJwt(id = RAISER_ID) {
  return `Bearer ${jwt.sign(
    { employeeId: id, email: `${id}@example.com` },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  )}`;
}

function seedVariation(store, overrides = {}) {
  const row = {
    id: VARIATION_ID,
    projectId: PROJECT_ID,
    raisedById: RAISER_ID,
    status: 'DRAFT',
    title: 'Original',
    description: 'Original description',
    deltaAmount: '100000',
    clientApprovalRequired: true,
    submittedAt: null,
    approvedById: null,
    approvedAt: null,
    rejectedAt: null,
    rejectedReason: null,
    version: 0,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
  store[VARIATION_ID] = row;
  return row;
}

function buildBillingApp() {
  const app = express();
  app.use(express.json());
  const certRows = new Map();
  const projectRows = new Map();
  projectRows.set(PROJECT_ID, { id: PROJECT_ID, name: 'P', code: 'P-1', isActive: true });

  const rowMatches = (r, where = {}) => {
    if (where.deletedAt === null && r.deletedAt) return false;
    if (where.status && r.status !== where.status) return false;
    if (where.id && r.id !== where.id) return false;
    if (where.version !== undefined && r.version !== where.version) return false;
    if (where.supersededAt === null && r.supersededAt) return false;
    return true;
  };

  const whereSpy = { lastWhere: null };
  const dataSpy = strictDataSpy(() => BILLING_MODEL_FIELDS);

  const prisma = {
    project: {
      findUnique: async ({ where }) => projectRows.get(where.id) || null,
      findMany: async ({ where }) => (where?.id?.in || []).map((id) => projectRows.get(id)).filter(Boolean),
    },
    dPR: { findMany: async () => [] },
    inspectionRecord: { findMany: async () => [] },
    boqItem: { findMany: async () => [] },
    variationOrder: { findMany: async () => [] },
    drawing: { findMany: async () => [] },
    billingCertification: {
      findUnique: async ({ where, include }) => {
        const row = certRows.get(where.id);
        if (!row) return null;
        if (!include) return row;
        return {
          ...row,
          project: include.project ? projectRows.get(row.projectId) || null : undefined,
          recordedBy: include.recordedBy ? { id: row.recordedById, name: 'Rec', designation: null } : undefined,
          certifiedBy: include.certifiedBy ? (row.certifiedById ? { id: row.certifiedById, name: 'Cer', designation: null } : null) : undefined,
        };
      },
      create: async ({ data }) => {
        const row = {
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: data.deletedAt ?? null,
          version: data.version ?? 0,
          supersededAt: data.supersededAt ?? null,
          parentCertificationId: data.parentCertificationId ?? null,
          certifiedById: data.certifiedById ?? null,
          certifiedAt: data.certifiedAt ?? null,
          disputedAt: data.disputedAt ?? null,
          disputeReason: data.disputeReason ?? null,
        };
        certRows.set(row.id, row);
        return row;
      },
      updateMany: async ({ where = {}, data }) => {
        whereSpy.lastWhere = where;
        dataSpy.inspect(data);
        const targets = Array.from(certRows.values()).filter((r) => rowMatches(r, where));
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
      },
      update: async ({ where, data }) => {
        dataSpy.inspect(data);
        const row = certRows.get(where.id);
        if (!row) {
          const err = new Error('not found');
          err.code = 'P2025';
          throw err;
        }
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
    },
    $transaction: async (fn) => fn({
      billingCertification: {
        create: prisma.billingCertification.create,
        updateMany: prisma.billingCertification.updateMany,
        findUnique: prisma.billingCertification.findUnique,
      },
    }),
    employee: {
      findUnique: async ({ where }) => {
        if (where.id === ADMIN_ID) return { id: ADMIN_ID, isAdmin: true };
        return null;
      },
    },
  };

  app.set('prisma', prisma);
  app.use('/api/billing-certifications', billingRouter);
  return { app, prisma, certRows, whereSpy, dataSpy };
}

function adminJwt() {
  return `Bearer ${jwt.sign(
    { employeeId: ADMIN_ID, email: 'admin@example.com', isAdmin: true },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  )}`;
}

function seedCert(store, id, status, overrides = {}) {
  const row = {
    id,
    projectId: PROJECT_ID,
    contractorName: 'ACME',
    billNumber: 'RA-001',
    billDate: new Date('2026-09-01'),
    invoiceNo: 'INV-001',
    poContractRef: 'PO-001',
    claimedAmount: 100000,
    deductedAmount: 5000,
    certifiedAmount: 95000,
    gstAmount: 17100,
    poValue: 1000000,
    balanceValue: 905000,
    remarks: 'Initial',
    status,
    recordedById: ADMIN_ID,
    certifiedById: status === 'CERTIFIED' || status === 'DISPUTED' ? ADMIN_ID : null,
    certifiedAt: status === 'CERTIFIED' || status === 'DISPUTED' ? new Date('2026-09-02') : null,
    disputedAt: status === 'DISPUTED' ? new Date('2026-09-03') : null,
    disputeReason: status === 'DISPUTED' ? 'Need revision' : null,
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
  store.set(id, row);
  return row;
}

describe('DR-015 — financial versioning and approval-content boundaries', () => {
  describe('VO PATCH — strips transport-only expectedVersion from Prisma data', () => {
    test('PATCH with matching expectedVersion does NOT pass expectedVersion into Prisma data', async () => {
      const { app, variations, spy } = buildVariationApp();
      seedVariation(variations, { version: 2 });

      const res = await request(app)
        .patch(`/api/variations/${VARIATION_ID}`)
        .set('Authorization', variationJwt())
        .send({ title: 'Edited', expectedVersion: 2 });

      expect(res.status).toBe(200);
      // The audit's load-bearing assertion: the version pin still works,
      // but `expectedVersion` does not leak into Prisma's data payload.
      expect(spy.leakDetected).toBe(false);
      expect(variations[VARIATION_ID].expectedVersion).toBeUndefined();
      expect(variations[VARIATION_ID].title).toBe('Edited');
      expect(variations[VARIATION_ID].version).toBe(3);
    });

    test('PATCH with stale expectedVersion returns 409 and never touches Prisma data', async () => {
      const { app, variations, spy } = buildVariationApp();
      seedVariation(variations, { version: 5 });

      const res = await request(app)
        .patch(`/api/variations/${VARIATION_ID}`)
        .set('Authorization', variationJwt())
        .send({ title: 'Stale edit', expectedVersion: 2 });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('VERSION_CONFLICT');
      // Stale paths skip Prisma data composition entirely — but if a
      // refactor accidentally moves the strip AFTER the call site, the
      // spy still catches the leak.
      expect(spy.leakDetected).toBe(false);
      expect(variations[VARIATION_ID].title).toBe('Original');
    });

    test('legacy PATCH (no expectedVersion) still works for in-flight callers', async () => {
      const { app, variations, spy } = buildVariationApp();
      seedVariation(variations);

      const res = await request(app)
        .patch(`/api/variations/${VARIATION_ID}`)
        .set('Authorization', variationJwt())
        .send({ title: 'Legacy edit' });

      expect(res.status).toBe(200);
      expect(spy.leakDetected).toBe(false);
      expect(variations[VARIATION_ID].title).toBe('Legacy edit');
      expect(variations[VARIATION_ID].version).toBe(1);
    });
  });

  describe('COP PATCH — DRAFT-only gate (no financial/PDF rewrite on approved content)', () => {
    test('PATCH on CERTIFIED row returns 409 INVALID_TRANSITION', async () => {
      const { app, certRows, dataSpy } = buildBillingApp();
      seedCert(certRows, CERT_CERTIFIED, 'CERTIFIED', { version: 2 });

      const res = await request(app)
        .patch(`/api/billing-certifications/${CERT_CERTIFIED}`)
        .set('Authorization', adminJwt())
        .send({ remarks: 'Trying to overwrite approved content', expectedVersion: 2 });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVALID_TRANSITION');
      expect(res.body.currentStatus).toBe('CERTIFIED');
      // The audit's load-bearing assertion: no Prisma data was written.
      // The strict mock would also reject any unknown key, but here the
      // route returns 409 before reaching Prisma.
      expect(certRows.get(CERT_CERTIFIED).remarks).toBe('Initial');
    });

    test('PATCH on DISPUTED row returns 409 INVALID_TRANSITION', async () => {
      const { app, certRows } = buildBillingApp();
      seedCert(certRows, CERT_DISPUTED, 'DISPUTED', { version: 3 });

      const res = await request(app)
        .patch(`/api/billing-certifications/${CERT_DISPUTED}`)
        .set('Authorization', adminJwt())
        .send({ remarks: 'Trying to overwrite disputed content', expectedVersion: 3 });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVALID_TRANSITION');
      expect(res.body.currentStatus).toBe('DISPUTED');
      // Prior dispute identity preserved (no silent overwrite).
      expect(certRows.get(CERT_DISPUTED).disputeReason).toBe('Need revision');
      expect(certRows.get(CERT_DISPUTED).remarks).toBe('Initial');
    });

    test('PATCH on DRAFT row still works (200, version increments)', async () => {
      const { app, certRows, whereSpy } = buildBillingApp();
      seedCert(certRows, CERT_DRAFT, 'DRAFT', { version: 0 });

      const res = await request(app)
        .patch(`/api/billing-certifications/${CERT_DRAFT}`)
        .set('Authorization', adminJwt())
        .send({ remarks: 'Edited draft' });

      expect(res.status).toBe(200);
      expect(res.body.remarks).toBe('Edited draft');
      expect(certRows.get(CERT_DRAFT).version).toBe(1);
      // Defense-in-depth: the WHERE pins status='DRAFT' even when no
      // expectedVersion is supplied (the audit's "Pin observed state in
      // every write, including legacy compatibility paths" rule).
      expect(whereSpy.lastWhere).toEqual(expect.objectContaining({
        id: CERT_DRAFT,
        status: 'DRAFT',
        deletedAt: null,
        supersededAt: null,
      }));
    });

    test('PATCH on DRAFT row with matching expectedVersion — WHERE pins all observed state', async () => {
      const { app, certRows, whereSpy } = buildBillingApp();
      seedCert(certRows, CERT_DRAFT, 'DRAFT', { version: 4 });

      const res = await request(app)
        .patch(`/api/billing-certifications/${CERT_DRAFT}`)
        .set('Authorization', adminJwt())
        .send({ remarks: 'Edited draft v4', expectedVersion: 4 });

      expect(res.status).toBe(200);
      expect(whereSpy.lastWhere).toEqual(expect.objectContaining({
        id: CERT_DRAFT,
        version: 4,
        status: 'DRAFT',
        deletedAt: null,
        supersededAt: null,
      }));
    });

    test('legacy PATCH on DRAFT row (no expectedVersion) — WHERE still pins status/deletedAt/supersededAt', async () => {
      const { app, certRows, whereSpy } = buildBillingApp();
      seedCert(certRows, CERT_DRAFT, 'DRAFT');

      const res = await request(app)
        .patch(`/api/billing-certifications/${CERT_DRAFT}`)
        .set('Authorization', adminJwt())
        .send({ remarks: 'Legacy edit' });

      expect(res.status).toBe(200);
      // Audit: "Pin observed status/version/deleted/superseded state in
      // every write, including legacy compatibility paths." The legacy
      // branch must still pin status/deletedAt/supersededAt — only
      // `version` is omitted because no pin was supplied.
      expect(whereSpy.lastWhere).toEqual(expect.objectContaining({
        id: CERT_DRAFT,
        status: 'DRAFT',
        deletedAt: null,
        supersededAt: null,
      }));
      expect(whereSpy.lastWhere).not.toHaveProperty('version');
    });
  });
});