// DR-024 (audit, 2026-09-24) — Certification draft editing sends keys the
// server explicitly forbids.
//
// Audit verdict (Code review by SOL/ACS-Portal-Fresh-Product-Audit-
// 2026-09-24-71f183a.md, lines 360-370):
//
//   "The common create/edit serializer always includes project, contractor,
//    bill number and bill date. PATCH forbids these immutable identity keys
//    even if the form disabled their inputs. A new zero-value DRAFT, with
//    certifiedAt: null, returned 400 UNKNOWN_FIELDS on a remarks-only edit."
//
// Acceptance for this round:
//   1. PATCH with only mutable fields (e.g. remarks) succeeds (200) and
//      the row is updated; this is the bug the client fix unblocks.
//   2. A crafted PATCH that re-includes one of the four immutable identity
//      keys (projectId / contractorName / billNumber / billDate) still
//      returns 400 UNKNOWN_FIELDS — the server allowlist is the safety
//      net and we MUST NOT loosen it.
//   3. Stale-version PATCH (correct identity, wrong pin) still returns
//      409 VERSION_CONFLICT — DR-015 safety net survives.
//
// This file deliberately exercises the *server* allowlist directly with
// supertest. The frontend fix (split create/edit payload builders in
// BillingCertificationsAdmin.jsx) is verified by construction —
// buildEditPayload() cannot emit the four forbidden keys.

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
const PROJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CERT_DRAFT = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';

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
  projectRows.set(PROJECT_B, { id: PROJECT_B, name: 'Bravo Site', code: 'BRAVO', isActive: true });

  const buildAssignedScopeFindMany = () => jest.fn(async () => []);

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
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async ({ where, include }) => {
        const row = certRows.get(where.id);
        if (!row) return null;
        if (!include) return row;
        return {
          ...row,
          project: include.project ? projectRows.get(row.projectId) || null : undefined,
          recordedBy: include.recordedBy ? { id: row.recordedById, name: 'Recorder', designation: null } : undefined,
          certifiedBy: include.certifiedBy ? (row.certifiedById
            ? { id: row.certifiedById, name: 'Certifier', designation: null }
            : null) : undefined,
        };
      }),
      count: jest.fn(async () => 0),
      groupBy: jest.fn(async () => []),
      create: jest.fn(async ({ data }) => {
        const row = { ...data, createdAt: new Date(), updatedAt: new Date(), deletedAt: null };
        certRows.set(row.id, row);
        return row;
      }),
      // Mirror billing-certifications-dr019-versioning.test.js's
      // updateMany semantics — respects the conditional WHERE so a
      // version mismatch surfaces as count !== 1 and bubbles out as
      // 409 VERSION_CONFLICT.
      updateMany: jest.fn(async ({ where = {}, data }) => {
        const targets = Array.from(certRows.values()).filter((r) => {
          if (where.id && r.id !== where.id) return false;
          if (where.version !== undefined && r.version !== where.version) return false;
          if (where.status && r.status !== where.status) return false;
          if (where.deletedAt === null && r.deletedAt) return false;
          if (where.supersededAt === null && r.supersededAt) return false;
          return true;
        });
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
      update: jest.fn(async ({ where, data }) => {
        const row = certRows.get(where.id);
        if (!row) { const e = new Error('not found'); e.code = 'P2025'; throw e; }
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
    },
    $transaction: jest.fn(async (fn) => fn(prisma)),
    employee: {
      findUnique: jest.fn(async ({ where }) => {
        if (where.id === ADMIN_ID) return { id: ADMIN_ID, isAdmin: true };
        return null;
      }),
    },
  };

  app.set('prisma', prisma);
  app.use('/api/billing-certifications', billingRouter);
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ error: err.message || 'INTERNAL_ERROR', code: err.code || 'INTERNAL' });
  });
  return { app, prisma, certRows };
}

function seedDraft(overrides = {}) {
  return {
    id: CERT_DRAFT,
    projectId: PROJECT_A,
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
    remarks: 'Initial remarks',
    status: 'DRAFT',
    recordedById: ADMIN_ID,
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
}

describe('DR-024 — client fix sends only mutable fields; server allowlist stays tight', () => {
  // ─── 1. The bug the client fix unblocks ──────────────────────────────
  test('PATCH remarks-only on a base DRAFT succeeds (200, remarks updates, bill identity unchanged)', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_DRAFT, seedDraft({ version: 0, remarks: 'old remarks' }));

    // Mirrors the post-fix client payload — no projectId / contractorName
    // / billNumber / billDate. Just the mutable field + version pin.
    const res = await request(app)
      .patch(`/api/billing-certifications/${CERT_DRAFT}`)
      .set('Authorization', adminJwt())
      .send({ remarks: 'remarks-only edit', expectedVersion: 0 });

    expect(res.status).toBe(200);
    expect(res.body.remarks).toBe('remarks-only edit');
    expect(res.body.version).toBe(1);
    // Bill identity untouched.
    expect(res.body.projectId).toBe(PROJECT_A);
    expect(res.body.contractorName).toBe('ACME Civil Contractors');
    expect(res.body.billNumber).toBe('RA-001');
  });

  // ─── 2. The safety net survives: a crafted PATCH with an immutable
  // identity key still returns 400 UNKNOWN_FIELDS. This is the explicit
  // requirement that we MUST NOT loosen the server allowlist.
  test.each([
    ['projectId', { projectId: PROJECT_B }],
    ['contractorName', { contractorName: 'New Contractor' }],
    ['billNumber', { billNumber: 'RA-002' }],
    ['billDate', { billDate: '2026-10-01' }],
  ])('PATCH that re-sends %s still returns 400 UNKNOWN_FIELDS (server allowlist unchanged)', async (field, body) => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_DRAFT, seedDraft({ version: 0 }));

    const res = await request(app)
      .patch(`/api/billing-certifications/${CERT_DRAFT}`)
      .set('Authorization', adminJwt())
      .send({ remarks: 'attempted identity swap', ...body });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UNKNOWN_FIELDS');
    expect(res.body.fields).toContain(field);
    // The malicious key must not have been applied to the row.
    const row = certRows.get(CERT_DRAFT);
    expect(row[field === 'projectId' ? 'projectId' : field]).not.toBe(
      field === 'projectId' ? PROJECT_B : (body[field])
    );
  });

  // ─── 3. DR-015 stale-edit safety net survives ─────────────────────────
  test('PATCH with stale expectedVersion still returns 409 VERSION_CONFLICT', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_DRAFT, seedDraft({ version: 5 }));

    const res = await request(app)
      .patch(`/api/billing-certifications/${CERT_DRAFT}`)
      .set('Authorization', adminJwt())
      .send({ remarks: 'Stale tab edit', expectedVersion: 2 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');
    expect(res.body.currentVersion).toBe(5);
  });

  // ─── 4. PATCH that omits expectedVersion still works (legacy callers)
  test('legacy PATCH (no expectedVersion) with only mutable fields still works', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_DRAFT, seedDraft({ version: 0 }));

    const res = await request(app)
      .patch(`/api/billing-certifications/${CERT_DRAFT}`)
      .set('Authorization', adminJwt())
      .send({ remarks: 'legacy caller remark' });

    expect(res.status).toBe(200);
    expect(res.body.remarks).toBe('legacy caller remark');
    expect(res.body.version).toBe(1);
  });

  // ─── 5. PATCH with an amount mutation on a base DRAFT (the full edit
  // happy path — what the form actually does on a typed amount change).
  test('PATCH amount + remarks on a base DRAFT succeeds; bill identity untouched', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_DRAFT, seedDraft({
      version: 0,
      claimedAmount: 100000,
      certifiedAmount: 95000,
      remarks: 'old',
    }));

    const res = await request(app)
      .patch(`/api/billing-certifications/${CERT_DRAFT}`)
      .set('Authorization', adminJwt())
      .send({
        claimedAmount: 110000,
        certifiedAmount: 105000,
        remarks: 'updated amounts',
        expectedVersion: 0,
      });

    expect(res.status).toBe(200);
    expect(res.body.claimedAmount).toBe(110000);
    expect(res.body.certifiedAmount).toBe(105000);
    expect(res.body.remarks).toBe('updated amounts');
    expect(res.body.version).toBe(1);
    // Identity preserved.
    expect(res.body.projectId).toBe(PROJECT_A);
    expect(res.body.billNumber).toBe('RA-001');
    // billDate is serialized as a YYYY-MM-DD string by the wire shape —
    // we only need to confirm the value didn't shift, not the exact
    // ISO timestamp form.
    expect(String(res.body.billDate).slice(0, 10)).toBe('2026-09-01');
  });
});