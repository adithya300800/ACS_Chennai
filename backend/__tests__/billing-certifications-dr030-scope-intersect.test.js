// DR-030: Billing Certifications — scope filter must intersect the
// requested projectId, not replace it.
//
// Bug: applyScopeFilter previously returned
//   { ...where, projectId: { in: ids } }
// which silently overwrote any caller-supplied projectId. A reader
// allowed A+B who requests `?projectId=A` got both A and B (misleading
// totals), and a reader requesting an unrelated C got the full allowed
// set instead of an empty list.
//
// Fix: pin both predicates with AND so neither is lost. An
// out-of-scope requested project naturally yields zero rows through
// the conjunction.
//
// Pattern: in-memory Prisma mock + small Express app, full router
// under test, error handler at the bottom — same shape as
// billing-certifications-dr018-scope.test.js so the existing test
// infrastructure (adminJwt / userJwt / seed / buildApp) carries over.

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
const PROJECT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROJECT_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CERT_A1 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const CERT_B1 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';

function adminJwt() {
  return `Bearer ${jwt.sign(
    { employeeId: ADMIN_ID, email: 'admin@example.com', isAdmin: true },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  )}`;
}
function userJwt(employeeId = USER_ID) {
  return `Bearer ${jwt.sign(
    { employeeId, email: 'user@example.com', isAdmin: false },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  )}`;
}

// Match helper that mirrors the route's where-clause shape. DR-030
// adds AND-form clauses so two predicates on `projectId` can coexist.
// The AND list must be satisfied conjunctively (every clause must hold)
// to model the intersection correctly.
function matchProjectClause(r, clause) {
  if (clause === undefined || clause === null) return true;
  if (typeof clause === 'string') return r.projectId === clause;
  if (clause.in && Array.isArray(clause.in)) {
    if (clause.in.length === 0) return false;
    return clause.in.includes(r.projectId);
  }
  return true;
}

function matchesAndClauses(r, andClauses) {
  if (!Array.isArray(andClauses)) return true;
  for (const c of andClauses) {
    if (!matchProjectClause(r, c.projectId)) return false;
  }
  return true;
}

function buildApp({
  adminIsAdmin = true,
  userIsAdmin = false,
  assignment = { dpr: [], inspection: [], boq: [], variation: [], drawing: [] },
} = {}) {
  const app = express();
  app.use(express.json());

  const certRows = new Map();
  const projectRows = new Map();
  projectRows.set(PROJECT_A, { id: PROJECT_A, name: 'Alpha Site', code: 'ALPHA', isActive: true });
  projectRows.set(PROJECT_B, { id: PROJECT_B, name: 'Bravo Site', code: 'BRAVO', isActive: true });
  projectRows.set(PROJECT_C, { id: PROJECT_C, name: 'Charlie Site', code: 'CHARLIE', isActive: true });

  const buildScopeFindMany = (rows) => jest.fn(async ({ where }) => {
    if (!where) return [];
    const empId = where.submittedById || where.createdById || where.raisedById || where.issuedById;
    if (empId !== USER_ID) return [];
    return (rows || [])
      .filter((r) => r.projectId != null)
      .map((r) => ({ projectId: r.projectId }));
  });

  // Filter helper that mirrors the route's where-clause shape. The
  // DR-030 fix adds AND clauses so two projectId predicates can coexist
  // — every AND clause must hold.
  const filterRows = (r, where = {}) => {
    if (where.deletedAt === null && r.deletedAt) return false;
    // [DR-030] AND clauses (route now emits
    //   { AND: [{ projectId: 'A' }, { projectId: { in: ids } }] })
    // are conjunctively satisfied.
    if (!matchesAndClauses(r, where.AND)) return false;
    if (!matchProjectClause(r, where.projectId)) return false;
    if (where.status && r.status !== where.status) return false;
    if (where.billDate) {
      const { gte, lte } = where.billDate;
      const ts = r.billDate instanceof Date ? r.billDate.getTime() : new Date(r.billDate).getTime();
      if (gte && ts < (gte instanceof Date ? gte.getTime() : new Date(gte).getTime())) return false;
      if (lte && ts > (lte instanceof Date ? lte.getTime() : new Date(lte).getTime())) return false;
    }
    return true;
  };

  const prisma = {
    project: {
      findUnique: jest.fn(async ({ where }) => {
        if (!where?.id) return null;
        return projectRows.get(where.id) || null;
      }),
      findMany: jest.fn(async ({ where }) => {
        const ids = (where?.id?.in || []);
        return ids.map((id) => projectRows.get(id)).filter(Boolean);
      }),
    },
    dPR: { findMany: buildScopeFindMany(assignment.dpr) },
    inspectionRecord: { findMany: buildScopeFindMany(assignment.inspection) },
    boqItem: { findMany: buildScopeFindMany(assignment.boq) },
    variationOrder: { findMany: buildScopeFindMany(assignment.variation) },
    drawing: { findMany: buildScopeFindMany(assignment.drawing) },
    billingCertification: {
      findMany: jest.fn(async ({ where = {}, take } = {}) => {
        let rows = Array.from(certRows.values()).filter((r) => filterRows(r, where));
        rows.sort((a, b) => {
          const at = a.billDate instanceof Date ? a.billDate.getTime() : 0;
          const bt = b.billDate instanceof Date ? b.billDate.getTime() : 0;
          if (at !== bt) return bt - at;
          return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
        });
        if (typeof take === 'number') rows = rows.slice(0, take);
        return rows.map((r) => ({
          ...r,
          project: projectRows.get(r.projectId) || null,
          recordedBy: { id: r.recordedById, name: 'Recorder', designation: null },
          certifiedBy: r.certifiedById
            ? { id: r.certifiedById, name: 'Certifier', designation: null }
            : null,
        }));
      }),
      findUnique: jest.fn(async ({ where }) => {
        const row = certRows.get(where.id);
        if (!row) return null;
        return {
          ...row,
          project: projectRows.get(row.projectId) || null,
          recordedBy: { id: row.recordedById, name: 'Recorder', designation: null },
          certifiedBy: row.certifiedById
            ? { id: row.certifiedById, name: 'Certifier', designation: null }
            : null,
        };
      }),
      count: jest.fn(async ({ where = {} } = {}) => {
        return Array.from(certRows.values()).filter((r) => filterRows(r, where)).length;
      }),
      groupBy: jest.fn(async ({ where = {}, by } = {}) => {
        const rows = Array.from(certRows.values()).filter((r) => filterRows(r, where));
        const buckets = new Map();
        for (const r of rows) {
          const key = by.map((k) => r[k]).join('||');
          const existing = buckets.get(key) || {
            count: 0,
            values: {},
            sumCertified: 0,
            sumClaimed: 0,
            sumDeducted: 0,
          };
          existing.count += 1;
          for (const k of by) existing.values[k] = r[k];
          existing.sumCertified += r.certifiedAmount || 0;
          existing.sumClaimed += r.claimedAmount || 0;
          existing.sumDeducted += r.deductedAmount || 0;
          buckets.set(key, existing);
        }
        return Array.from(buckets.values()).map((b) => {
          const out = {
            _count: { _all: b.count },
            _sum: {
              certifiedAmount: b.sumCertified,
              claimedAmount: b.sumClaimed,
              deductedAmount: b.sumDeducted,
            },
          };
          for (const k of by) out[k] = b.values[k];
          return out;
        });
      }),
    },
    employee: {
      findUnique: jest.fn(async ({ where }) => {
        if (where.id === ADMIN_ID) return { id: ADMIN_ID, isAdmin: adminIsAdmin };
        if (where.id === USER_ID) return { id: USER_ID, isAdmin: userIsAdmin };
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
  return { app, prisma, certRows };
}

function seed({ id, projectId, status = 'DRAFT' }) {
  return {
    id, projectId,
    contractorName: 'Ponni Constructions',
    billNumber: 'RAB 01',
    billDate: new Date('2026-09-05T00:00:00Z'),
    invoiceNo: null, poContractRef: null,
    claimedAmount: 100000, deductedAmount: 0, certifiedAmount: 100000,
    gstAmount: null, poValue: null, balanceValue: null, remarks: null,
    status,
    recordedById: USER_ID, certifiedById: null, certifiedAt: null,
    disputedAt: null, disputeReason: null,
    filename: null, contentType: null, sizeBytes: null, blobPath: null, uploadedAt: null,
    deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
  };
}

describe('DR-030 — Billing Certifications: scope filter must intersect requested projectId', () => {
  it('1. non-admin allowed A+B requesting ?projectId=A sees only A (intersect, not replace)', async () => {
    // The bug: the previous code did
    //   { ...where, projectId: { in: ids } }
    // overwriting the requested projectId and returning both A and B.
    // After the fix, the conjunction must narrow to A only.
    const { app, certRows } = buildApp({
      userIsAdmin: false,
      assignment: { dpr: [{ projectId: PROJECT_A }, { projectId: PROJECT_B }] },
    });
    certRows.set(CERT_A1, seed({ id: CERT_A1, projectId: PROJECT_A }));
    certRows.set(CERT_B1, seed({
      id: CERT_B1, projectId: PROJECT_B,
      billDate: new Date('2026-09-06'),
    }));
    const res = await request(app)
      .get(`/api/billing-certifications?projectId=${PROJECT_A}`)
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    expect(res.body.certifications).toHaveLength(1);
    expect(res.body.certifications[0].projectId).toBe(PROJECT_A);
    expect(res.body.total).toBe(1);
  });

  it('2. non-admin allowed A+B requesting unrelated C gets empty (NOT the allowed set)', async () => {
    // The bug: requesting C returned the full allowed set A+B. The
    // fix makes the intersection naturally yield zero rows for any
    // projectId outside the assigned set.
    const { app, certRows } = buildApp({
      userIsAdmin: false,
      assignment: { dpr: [{ projectId: PROJECT_A }, { projectId: PROJECT_B }] },
    });
    certRows.set(CERT_A1, seed({ id: CERT_A1, projectId: PROJECT_A }));
    certRows.set(CERT_B1, seed({
      id: CERT_B1, projectId: PROJECT_B,
      billDate: new Date('2026-09-06'),
    }));
    const res = await request(app)
      .get(`/api/billing-certifications?projectId=${PROJECT_C}`)
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    expect(res.body.certifications).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  it('3. non-admin without ?projectId still gets the allowed set (no requested filter)', async () => {
    // No caller-supplied projectId → the original scope-only path stays
    // active and returns A+B. This is the DR-018 baseline; the fix
    // must not regress it.
    const { app, certRows } = buildApp({
      userIsAdmin: false,
      assignment: { dpr: [{ projectId: PROJECT_A }, { projectId: PROJECT_B }] },
    });
    certRows.set(CERT_A1, seed({ id: CERT_A1, projectId: PROJECT_A }));
    certRows.set(CERT_B1, seed({
      id: CERT_B1, projectId: PROJECT_B,
      billDate: new Date('2026-09-06'),
    }));
    const res = await request(app)
      .get('/api/billing-certifications')
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    const ids = res.body.certifications.map((c) => c.projectId).sort();
    expect(ids).toEqual([PROJECT_A, PROJECT_B].sort());
    expect(res.body.total).toBe(2);
  });

  it('4. aggregates endpoint: requesting A returns only A, never A+B', async () => {
    // Same bug shape on /aggregates — the per-project roll-up must
    // honour the requested projectId intersect. Otherwise the
    // dashboard would mis-totals across projects the employee never
    // asked about.
    const { app, certRows } = buildApp({
      userIsAdmin: false,
      assignment: { dpr: [{ projectId: PROJECT_A }, { projectId: PROJECT_B }] },
    });
    certRows.set(CERT_A1, seed({ id: CERT_A1, projectId: PROJECT_A, certifiedAmount: 50000 }));
    certRows.set(CERT_B1, seed({
      id: CERT_B1, projectId: PROJECT_B,
      billDate: new Date('2026-09-06'),
      certifiedAmount: 75000,
    }));
    const res = await request(app)
      .get(`/api/billing-certifications/aggregates?projectId=${PROJECT_A}`)
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    const ids = res.body.projects.map((p) => p.projectId);
    expect(ids).toEqual([PROJECT_A]);
    expect(res.body.projects[0].totals.count).toBe(1);
  });

  it('5. aggregates endpoint: requesting unrelated C returns empty projects list', async () => {
    const { app, certRows } = buildApp({
      userIsAdmin: false,
      assignment: { dpr: [{ projectId: PROJECT_A }, { projectId: PROJECT_B }] },
    });
    certRows.set(CERT_A1, seed({ id: CERT_A1, projectId: PROJECT_A }));
    certRows.set(CERT_B1, seed({
      id: CERT_B1, projectId: PROJECT_B,
      billDate: new Date('2026-09-06'),
    }));
    const res = await request(app)
      .get(`/api/billing-certifications/aggregates?projectId=${PROJECT_C}`)
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    expect(res.body.projects).toEqual([]);
  });

  it('6. count + groupBy use the same scope-intersected WHERE (totals match the rows)', async () => {
    // The audit pinned: "counts/sums match the same predicate". A list
    // request that asks for A must report `total: 1`, not `total: 2`.
    const { app, certRows } = buildApp({
      userIsAdmin: false,
      assignment: { dpr: [{ projectId: PROJECT_A }, { projectId: PROJECT_B }] },
    });
    certRows.set(CERT_A1, seed({ id: CERT_A1, projectId: PROJECT_A }));
    certRows.set(CERT_B1, seed({
      id: CERT_B1, projectId: PROJECT_B,
      billDate: new Date('2026-09-06'),
    }));
    const res = await request(app)
      .get(`/api/billing-certifications?projectId=${PROJECT_A}`)
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    expect(res.body.certifications).toHaveLength(1);
    expect(res.body.total).toBe(1);
    // The all-status context totals are also narrowed to A — sum of
    // certified amounts should be only the A row (100000), not A+B.
    expect(res.body.summary.totalCertifiedAllStatus).toBe(100000);
  });

  it('7. admin requesting a specific projectId is unaffected (no scope narrowing)', async () => {
    // Admins ignore the scope param entirely. The intersect fix
    // applies only to non-admins — the admin path is unchanged.
    const { app, certRows } = buildApp({ adminIsAdmin: true });
    certRows.set(CERT_A1, seed({ id: CERT_A1, projectId: PROJECT_A }));
    certRows.set(CERT_B1, seed({
      id: CERT_B1, projectId: PROJECT_B,
      billDate: new Date('2026-09-06'),
    }));
    const res = await request(app)
      .get(`/api/billing-certifications?projectId=${PROJECT_A}`)
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    expect(res.body.certifications).toHaveLength(1);
    expect(res.body.certifications[0].projectId).toBe(PROJECT_A);
  });

  it('8. source-text pin: applyScopeFilter composes an AND conjunction for requested+scope', () => {
    // Structural test — grep the route source for the conjunction
    // token so the intersection can't be silently regressed to a
    // replacement. The fix splits projectId off the WHERE and adds
    // it under an AND list together with the scope's {in: ids}.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'routes', 'billingCertifications.js'),
      'utf8',
    );
    // The function name pin (so a future rename doesn't drift silently).
    expect(src).toMatch(/async\s+function\s+applyScopeFilter\s*\(/);
    // The intersection shape — when a projectId was supplied, both the
    // original predicate AND the scope's {in: ids} must be present in
    // the constructed AND list. Pinning both literal tokens closes the
    // "regress to overwrite" path.
    expect(src).toMatch(/\{\s*projectId:\s*requestedProjectId\s*\}/);
    expect(src).toMatch(/\{\s*projectId:\s*\{\s*in:\s*ids\s*\}\s*\}/);
    // The AND key the route now emits to express the conjunction.
    expect(src).toMatch(/AND:\s*\[\s*\.\.\.[^,]+,\s*\{\s*projectId:\s*requestedProjectId/);
  });
});
