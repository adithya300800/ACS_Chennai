// DR-021 (audit, 2026-09-08) — Decouple paging totals from cursor.
//
// Audit verdict (Code review by SOL/ACS-Portal-Workflow-Completeness-
// Review-2026-09-08-5c61cd8.md, lines 324-334):
//
//   "The cursor predicate is reused for count and sums while the UI
//    appends rows but replaces its summary. With 60 records and a 50-row
//    page, Load more can display 60 rows with a total/sum covering only
//    the remaining ten. Project totals can also remain stale after
//    creation."
//
// Repair / acceptance:
//   - Separate the full filtered population from the seek predicate.
//   - Totals must stay invariant as pages load and refresh after
//     mutations.
//   - Label all-status context separately from certified liability
//     and disputed amounts.
//
// This file pins the wire contract:
//
//   1. With 60 seeded rows + ?limit=50, the FIRST page returns 50 rows
//      and total: 60 (full population, not 50). The cursor predicate
//      MUST NOT appear in the count() / groupBy() `where` shape — a
//      test inspects the recorded mock calls to enforce this.
//   2. Following the returned cursor, the SECOND page returns the
//      remaining 10 rows AND total: 60. The audit's specific failure
//      mode was "60 rows + 50/page + Load more shows total: 10" —
//      that must no longer happen.
//   3. The summary block exposes three top-level figures:
//      totalCertifiedAllStatus (sum across statuses, the "all status
//      context" label), totalCertifiedLiability (CERTIFIED only, the
//      payable liability), and totalCertifiedDisputed (DISPUTED only).
//   4. POST + a fresh non-cursor list call reflects the new row in
//      total + the per-status count + sums.

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

  // Helper: does a row satisfy a Prisma `where` shape? Mirrors the
  // legacy mock so the existing tests still pass; the new behaviour
  // we test is what `where` looks like on the count / groupBy calls,
  // not how the mock interprets it.
  const rowMatchesWhere = (r, where = {}) => {
    if (where.deletedAt === null && r.deletedAt) return false;
    if (where.supersededAt === null && r.supersededAt) return false;
    if (where.status && r.status !== where.status) return false;
    if (where.projectId) {
      if (typeof where.projectId === 'string' && r.projectId !== where.projectId) return false;
      if (where.projectId.in && !where.projectId.in.includes(r.projectId)) return false;
    }
    if (where.billDate) {
      const { gte, lte } = where.billDate;
      const ts = r.billDate instanceof Date ? r.billDate.getTime() : new Date(r.billDate).getTime();
      if (gte && ts < (gte instanceof Date ? gte.getTime() : new Date(gte).getTime())) return false;
      if (lte && ts > (lte instanceof Date ? lte.getTime() : new Date(lte).getTime())) return false;
    }
    // Cursor OR-predicate — present when the seek predicate bleeds
    // into count / groupBy. The audit's bug surface is "this branch
    // is matched by count() / groupBy() when it shouldn't be".
    if (where.OR && Array.isArray(where.OR)) {
      const rowTs = r.billDate instanceof Date ? r.billDate.getTime() : new Date(r.billDate).getTime();
      const matches = where.OR.some((branch) => {
        if (branch.billDate?.lt) {
          const cursorTs = branch.billDate.lt instanceof Date
            ? branch.billDate.lt.getTime()
            : new Date(branch.billDate.lt).getTime();
          return rowTs < cursorTs;
        }
        if (branch.billDate && branch.id?.lt) {
          const cursorTs = branch.billDate instanceof Date
            ? branch.billDate.getTime()
            : new Date(branch.billDate).getTime();
          return rowTs === cursorTs && r.id < branch.id.lt;
        }
        return false;
      });
      if (!matches) return false;
    }
    return true;
  };

  const prisma = {
    project: {
      findUnique: jest.fn(async ({ where }) => projectRows.get(where?.id) || null),
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
      findMany: jest.fn(async ({ where = {}, orderBy, take, include } = {}) => {
        let rows = Array.from(certRows.values()).filter((r) => rowMatchesWhere(r, where));
        rows.sort((a, b) => {
          const at = a.billDate instanceof Date ? a.billDate.getTime() : 0;
          const bt = b.billDate instanceof Date ? b.billDate.getTime() : 0;
          if (at !== bt) return bt - at;
          return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
        });
        if (typeof take === 'number') rows = rows.slice(0, take);
        if (include) {
          rows = rows.map((r) => ({
            ...r,
            project: include.project ? projectRows.get(r.projectId) || null : undefined,
            recordedBy: include.recordedBy ? {
              id: r.recordedById, name: r.recordedByName || 'Recorder', designation: null,
            } : undefined,
            certifiedBy: include.certifiedBy ? (r.certifiedById ? {
              id: r.certifiedById, name: r.certifiedByName || 'Certifier', designation: null,
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
            id: row.recordedById, name: row.recordedByName || 'Recorder', designation: null,
          } : undefined,
          certifiedBy: include.certifiedBy ? (row.certifiedById ? {
            id: row.certifiedById, name: row.certifiedByName || 'Certifier', designation: null,
          } : null) : undefined,
        };
      }),
      // [DR-021] The count + groupBy mocks now apply the full `where`
      // (including the OR/cursor predicate if present). Combined with
      // the test assertions below — which check that the route calls
      // count + groupBy WITHOUT an OR predicate — this means a
      // regression that re-injects the cursor into count will be
      // caught both by the spy assertion AND by the response shape.
      count: jest.fn(async ({ where = {} } = {}) => {
        return Array.from(certRows.values()).filter((r) => rowMatchesWhere(r, where)).length;
      }),
      groupBy: jest.fn(async ({ where = {}, by, _count, _sum } = {}) => {
        let rows = Array.from(certRows.values()).filter((r) => rowMatchesWhere(r, where));
        const buckets = new Map();
        for (const r of rows) {
          const key = by.map((k) => r[k]).join('||');
          const existing = buckets.get(key) || {
            key, count: 0, claimedAmount: 0, deductedAmount: 0, certifiedAmount: 0, values: {},
          };
          existing.count += 1;
          existing.claimedAmount += Number(r.claimedAmount || 0);
          existing.deductedAmount += Number(r.deductedAmount || 0);
          existing.certifiedAmount += Number(r.certifiedAmount || 0);
          for (const k of by) existing.values[k] = r[k];
          buckets.set(key, existing);
        }
        return Array.from(buckets.values()).map((b) => {
          const out = { _count: { _all: b.count }, _sum: {} };
          for (const k of by) out[k] = b.values[k];
          out._sum.claimedAmount = b.claimedAmount;
          out._sum.deductedAmount = b.deductedAmount;
          out._sum.certifiedAmount = b.certifiedAmount;
          return out;
        });
      }),
      create: jest.fn(async ({ data }) => {
        const row = {
          ...data, createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
        };
        certRows.set(row.id, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }) => {
        const row = certRows.get(where.id);
        if (!row) { const err = new Error('not found'); err.code = 'P2025'; throw err; }
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
      updateMany: jest.fn(async ({ where = {}, data }) => {
        const row = certRows.get(where.id);
        if (!row) return { count: 0 };
        Object.assign(row, data, { updatedAt: new Date() });
        return { count: 1 };
      }),
    },
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
    res.status(err.status || 500).json({
      error: err.message || 'INTERNAL_ERROR',
      code: err.code || 'INTERNAL',
    });
  });
  return { app, prisma, certRows, projectRows };
}

// Seed with a mix of statuses so the three summary figures have distinct
// values to assert on. billDate is staggered so the (billDate desc, id
// desc) ordering is deterministic and the cursor advances through them.
function seedRow(i, overrides = {}) {
  const id = `dddddddd-dddd-4ddd-8ddd-${String(i).padStart(12, '0')}`;
  return {
    id, projectId: PROJECT_A,
    contractorName: `Contractor ${i}`,
    billNumber: `RAB ${String(i).padStart(3, '0')}`,
    billDate: new Date(`2026-09-${String((i % 28) + 1).padStart(2, '0')}`),
    invoiceNo: 'PCDPL/25-26/021',
    poContractRef: 'LLPL/2387/25-26',
    claimedAmount: 1000, deductedAmount: 0, certifiedAmount: 1000,
    gstAmount: null, poValue: null, balanceValue: null,
    remarks: null,
    status: 'CERTIFIED',
    recordedById: ADMIN_ID, certifiedById: ADMIN_ID, certifiedAt: new Date(),
    disputedAt: null, disputeReason: null,
    filename: null, contentType: null, sizeBytes: null, blobPath: null, uploadedAt: null,
    deletedAt: null, supersededAt: null, parentCertificationId: null,
    createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  };
}

describe('DR-021 — cursor predicate is decoupled from count + sums', () => {
  it('1. First page: 50 rows returned, total: 60 (full population, not page slice)', async () => {
    const { app, certRows } = buildApp();
    // Seed 60 rows with a deterministic mix: 30 CERTIFIED, 20 DRAFT, 10 DISPUTED.
    for (let i = 1; i <= 60; i += 1) {
      const status = i <= 30 ? 'CERTIFIED' : i <= 50 ? 'DRAFT' : 'DISPUTED';
      certRows.set(`dddddddd-dddd-4ddd-8ddd-${String(i).padStart(12, '0')}`, seedRow(i, { status }));
    }
    const res = await request(app)
      .get('/api/billing-certifications?limit=50')
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    expect(res.body.certifications).toHaveLength(50);
    expect(res.body.nextCursor).toBeTruthy();
    expect(res.body.total).toBe(60); // FULL population, not 50
    expect(res.body.summary.byStatus.CERTIFIED.count).toBe(30);
    expect(res.body.summary.byStatus.DRAFT.count).toBe(20);
    expect(res.body.summary.byStatus.DISPUTED.count).toBe(10);
  });

  it('2. Following cursor: total + sums stay invariant as page 2 loads', async () => {
    const { app, certRows, prisma } = buildApp();
    for (let i = 1; i <= 60; i += 1) {
      const status = i <= 30 ? 'CERTIFIED' : i <= 50 ? 'DRAFT' : 'DISPUTED';
      certRows.set(`dddddddd-dddd-4ddd-8ddd-${String(i).padStart(12, '0')}`, seedRow(i, { status }));
    }
    const first = await request(app)
      .get('/api/billing-certifications?limit=50')
      .set('Authorization', adminJwt());
    expect(first.body.total).toBe(60);
    expect(first.body.nextCursor).toBeTruthy();

    // Page 2 — the audit's failure mode was "60 rows + 50/page + Load
    // more shows total: 10". We must still see 60.
    const second = await request(app)
      .get(`/api/billing-certifications?limit=50&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .set('Authorization', adminJwt());
    expect(second.status).toBe(200);
    expect(second.body.certifications.length).toBeGreaterThan(0);
    expect(second.body.certifications.length + first.body.certifications.length).toBe(60);
    expect(second.body.total).toBe(60); // invariant — full population, not 10
    // Per-status counts must remain stable across pages.
    expect(second.body.summary.byStatus.CERTIFIED.count).toBe(30);
    expect(second.body.summary.byStatus.DRAFT.count).toBe(20);
    expect(second.body.summary.byStatus.DISPUTED.count).toBe(10);
    // Sums must remain stable across pages.
    expect(second.body.summary.byStatus.CERTIFIED.totalCertified).toBe(30 * 1000);

    // [DR-021] The audit's root cause was that count() + groupBy() were
    // called with the cursor predicate in their `where`. Inspect the
    // recorded calls — every count() + groupBy() invocation MUST have
    // a where object that does NOT contain an `OR` key.
    const cursorCalls = prisma.billingCertification.count.mock.calls.filter(
      ([args]) => args && args.where && args.where.OR,
    );
    expect(cursorCalls).toHaveLength(0);
    const cursorGroupCalls = prisma.billingCertification.groupBy.mock.calls.filter(
      ([args]) => args && args.where && args.where.OR,
    );
    expect(cursorGroupCalls).toHaveLength(0);
  });

  it('3. Summary exposes three distinct top-level figures (all-status vs liability vs disputed)', async () => {
    const { app, certRows } = buildApp();
    // 2 CERTIFIED @ 10000, 1 DISPUTED @ 5000, 1 DRAFT @ 8000.
    certRows.set('dddddddd-dddd-4ddd-8ddd-0000000000001', seedRow(1, {
      status: 'CERTIFIED', certifiedAmount: 10000, claimedAmount: 10000,
    }));
    certRows.set('dddddddd-dddd-4ddd-8ddd-0000000000002', seedRow(2, {
      status: 'CERTIFIED', certifiedAmount: 10000, claimedAmount: 10000,
      billDate: new Date('2026-09-02'),
    }));
    certRows.set('dddddddd-dddd-4ddd-8ddd-0000000000003', seedRow(3, {
      status: 'DISPUTED', certifiedAmount: 5000, claimedAmount: 5000,
      billDate: new Date('2026-09-03'),
    }));
    certRows.set('dddddddd-dddd-4ddd-8ddd-0000000000004', seedRow(4, {
      status: 'DRAFT', certifiedAmount: 8000, claimedAmount: 8000,
      billDate: new Date('2026-09-04'),
    }));

    const res = await request(app)
      .get('/api/billing-certifications')
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    // All-status context: sum across every status.
    expect(res.body.summary.totalCertifiedAllStatus).toBe(10000 + 10000 + 5000 + 8000);
    // Certified liability: CERTIFIED sum only.
    expect(res.body.summary.totalCertifiedLiability).toBe(10000 + 10000);
    // Disputed amounts: DISPUTED sum only.
    expect(res.body.summary.totalCertifiedDisputed).toBe(5000);
  });

  it('4. POST + fresh list reflects the new row in total + sums', async () => {
    const { app, certRows } = buildApp();
    // Seed 5 existing CERTIFIED rows.
    for (let i = 1; i <= 5; i += 1) {
      certRows.set(`dddddddd-dddd-4ddd-8ddd-${String(i).padStart(12, '0')}`, seedRow(i, {
        status: 'CERTIFIED', certifiedAmount: 1000 * i,
      }));
    }
    const before = await request(app)
      .get('/api/billing-certifications')
      .set('Authorization', adminJwt());
    expect(before.body.total).toBe(5);
    expect(before.body.summary.byStatus.CERTIFIED.count).toBe(5);
    const beforeLiability = before.body.summary.totalCertifiedLiability;

    // POST a new DRAFT row.
    const created = await request(app)
      .post('/api/billing-certifications')
      .set('Authorization', adminJwt())
      .send({
        projectId: PROJECT_A,
        contractorName: 'New Vendor',
        billNumber: 'RAB-NEW',
        billDate: '2026-09-30',
        claimedAmount: 7777,
        certifiedAmount: 7777,
      });
    expect(created.status).toBe(201);

    // Fresh non-cursor list call — totals must include the new row.
    const after = await request(app)
      .get('/api/billing-certifications')
      .set('Authorization', adminJwt());
    expect(after.body.total).toBe(6);
    expect(after.body.summary.byStatus.DRAFT.count).toBe(1);
    expect(after.body.summary.byStatus.CERTIFIED.count).toBe(5);
    // The new row is a DRAFT, so CERTIFIED liability is unchanged.
    expect(after.body.summary.totalCertifiedLiability).toBe(beforeLiability);
    // All-status context grew by the new DRAFT amount.
    expect(after.body.summary.totalCertifiedAllStatus)
      .toBe(before.body.summary.totalCertifiedAllStatus + 7777);
  });

  it('5. Status filter narrows count + sums consistently across pages', async () => {
    // A regression in the cursor-decoupling wiring could surface here:
    // the filter narrows the full population correctly on page 1, but
    // if the cursor bleeds into count on page 2, the totals would
    // change.
    const { app, certRows } = buildApp();
    // 30 CERTIFIED + 30 DISPUTED + 30 DRAFT = 90 total, 30 per status.
    for (let i = 1; i <= 90; i += 1) {
      const status = i <= 30 ? 'CERTIFIED' : i <= 60 ? 'DISPUTED' : 'DRAFT';
      certRows.set(`dddddddd-dddd-4ddd-8ddd-${String(i).padStart(12, '0')}`, seedRow(i, { status }));
    }
    const first = await request(app)
      .get('/api/billing-certifications?status=CERTIFIED&limit=20')
      .set('Authorization', adminJwt());
    expect(first.body.total).toBe(30); // filter narrows to CERTIFIED, page = 20
    expect(first.body.summary.byStatus.CERTIFIED.count).toBe(30);
    expect(first.body.summary.byStatus.DRAFT.count).toBe(0);
    expect(first.body.summary.byStatus.DISPUTED.count).toBe(0);

    const second = await request(app)
      .get(`/api/billing-certifications?status=CERTIFIED&limit=20&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .set('Authorization', adminJwt());
    expect(second.body.total).toBe(30); // invariant under cursor
    expect(second.body.summary.byStatus.CERTIFIED.count).toBe(30);
    expect(second.body.summary.byStatus.DISPUTED.count).toBe(0);
  });
});
