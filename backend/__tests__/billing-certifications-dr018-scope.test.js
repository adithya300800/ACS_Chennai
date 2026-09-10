// DR-018: Billing Certifications — Commercial read scope must be mandatory.
//
// Bug: the list (`GET /`) and aggregates (`GET /aggregates`) endpoints
// allowed an authenticated employee to fetch the cross-org COP registry
// simply by omitting `?scope=assigned`. The detail endpoint (line 686
// of billingCertifications.js) already enforced the scope filter, but
// list/aggregate only did so when the param was explicitly passed.
//
// Fix: `applyScopeFilter` now defaults to `scope=assigned` for any
// non-admin caller when the param is absent or empty. Admins continue
// to ignore the param. This file pins the new behavior so the bypass
// can't reappear silently.
//
// Pattern: in-memory Prisma mock + small Express app, full router
// under test, error handler at the bottom — same shape as
// billing-certifications.test.js (R37) so the existing test
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
const CERT_A1 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const CERT_B1 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4';

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

// Build the same in-memory Prisma as the R37 suite. The
// `getAssignedProjectIds` helper in the route hits
// dPR/inspectionRecord/boqItem/variationOrder/drawing findMany with a
// submittedById/createdById/raisedById/issuedById where-clause; the mock
// only returns rows whose employeeId matches USER_ID so a non-admin
// caller gets the scope the test seed describes.
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

  const buildScopeFindMany = (rows) => jest.fn(async ({ where }) => {
    if (!where) return [];
    const empId = where.submittedById || where.createdById || where.raisedById || where.issuedById;
    if (empId !== USER_ID) return [];
    return (rows || [])
      .filter((r) => r.projectId != null)
      .map((r) => ({ projectId: r.projectId }));
  });

  // Filter helper that mirrors the route's where-clause shape. The
  // DR-018 fix narrows `where.projectId` to `{ in: ids }` for non-admins
  // — the filter must accept BOTH the bare-UUID form and the {in:[..]}
  // form so the new path doesn't silently leak rows.
  //
  // [DR-030] Also intersect with any top-level AND clause the route
  // builds. The fix moved the authorized-scope predicate out of
  // `where.projectId` and into a top-level AND array so a caller's
  // projectId AND the scope are both honoured (previously the scope
  // overwrote the caller's projectId, widening disclosure).
  const matchProject = (r, whereProject) => {
    if (!whereProject) return true;
    if (typeof whereProject === 'string') return r.projectId === whereProject;
    if (whereProject.in && Array.isArray(whereProject.in)) {
      // The "__none__" sentinel forces an empty result regardless of
      // what rows exist — DR-018 has to preserve that contract.
      if (whereProject.in.length === 0) return false;
      return whereProject.in.includes(r.projectId);
    }
    return true;
  };
  const matchAndClauses = (r, andClauses) => {
    if (!Array.isArray(andClauses) || andClauses.length === 0) return true;
    // AND semantics: every clause must match for the row to survive.
    return andClauses.every((clause) => matchProject(r, clause.projectId));
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
        let rows = Array.from(certRows.values()).filter((r) => {
          if (where.deletedAt === null && r.deletedAt) return false;
          if (!matchProject(r, where.projectId)) return false;
          if (where.status && r.status !== where.status) return false;
          return true;
        });
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
        return Array.from(certRows.values()).filter((r) => {
          if (where.deletedAt === null && r.deletedAt) return false;
          if (!matchProject(r, where.projectId)) return false;
          if (where.status && r.status !== where.status) return false;
          return true;
        }).length;
      }),
      groupBy: jest.fn(async ({ where = {}, by } = {}) => {
        const rows = Array.from(certRows.values()).filter((r) => {
          if (where.deletedAt === null && r.deletedAt) return false;
          if (!matchProject(r, where.projectId)) return false;
          if (where.billDate) {
            const { gte, lte } = where.billDate;
            const ts = r.billDate instanceof Date ? r.billDate.getTime() : new Date(r.billDate).getTime();
            if (gte && ts < (gte instanceof Date ? gte.getTime() : new Date(gte).getTime())) return false;
            if (lte && ts > (lte instanceof Date ? lte.getTime() : new Date(lte).getTime())) return false;
          }
          return true;
        });
        const buckets = new Map();
        for (const r of rows) {
          const key = by.map((k) => r[k]).join('||');
          const existing = buckets.get(key) || { count: 0, values: {} };
          existing.count += 1;
          for (const k of by) existing.values[k] = r[k];
          buckets.set(key, existing);
        }
        return Array.from(buckets.values()).map((b) => {
          const out = { _count: { _all: b.count }, _sum: { certifiedAmount: 0, claimedAmount: 0, deductedAmount: 0 } };
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

describe('DR-018 — Billing Certifications: scope=assigned is mandatory for non-admins', () => {
  it('1. non-admin WITHOUT ?scope=assigned defaults to assigned scope (list)', async () => {
    // The bug: omitting the param previously widened scope to the org
    // registry. With DR-018 the default is 'assigned' for non-admins,
    // so the employee only sees COPs against their own projects.
    const { app, certRows } = buildApp({
      userIsAdmin: false,
      assignment: { dpr: [{ projectId: PROJECT_A }] },
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
    expect(res.body.certifications).toHaveLength(1);
    expect(res.body.certifications[0].projectId).toBe(PROJECT_A);
    expect(res.body.total).toBe(1);
  });

  it('2. non-admin WITH ?scope=assigned still returns only assigned projects (unchanged)', async () => {
    const { app, certRows } = buildApp({
      userIsAdmin: false,
      assignment: { dpr: [{ projectId: PROJECT_A }] },
    });
    certRows.set(CERT_A1, seed({ id: CERT_A1, projectId: PROJECT_A }));
    certRows.set(CERT_B1, seed({
      id: CERT_B1, projectId: PROJECT_B,
      billDate: new Date('2026-09-06'),
    }));
    const res = await request(app)
      .get('/api/billing-certifications?scope=assigned')
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    expect(res.body.certifications).toHaveLength(1);
    expect(res.body.certifications[0].projectId).toBe(PROJECT_A);
  });

  it('3. non-admin with ?scope=all still 400 INVALID_SCOPE (validator unchanged)', async () => {
    // Validator runs before applyScopeFilter, so the bypass path doesn't
    // even reach the scope-defaulting branch. Confirm the existing 400
    // envelope is preserved.
    const { app } = buildApp({
      userIsAdmin: false,
      assignment: { dpr: [{ projectId: PROJECT_A }] },
    });
    const res = await request(app)
      .get('/api/billing-certifications?scope=all')
      .set('Authorization', userJwt());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SCOPE');
  });

  it('4. admin WITHOUT ?scope=assigned still returns the full org registry', async () => {
    // Admins are unrestricted regardless of the param — the cross-
    // project Records-group ledger is their use case.
    const { app, certRows } = buildApp({ adminIsAdmin: true });
    certRows.set(CERT_A1, seed({ id: CERT_A1, projectId: PROJECT_A }));
    certRows.set(CERT_B1, seed({
      id: CERT_B1, projectId: PROJECT_B,
      billDate: new Date('2026-09-06'),
    }));
    const res = await request(app)
      .get('/api/billing-certifications')
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    expect(res.body.certifications).toHaveLength(2);
    expect(res.body.total).toBe(2);
  });

  it('5. admin WITH ?scope=assigned still ignores the param and returns everything', async () => {
    const { app, certRows } = buildApp({ adminIsAdmin: true });
    certRows.set(CERT_A1, seed({ id: CERT_A1, projectId: PROJECT_A }));
    certRows.set(CERT_B1, seed({
      id: CERT_B1, projectId: PROJECT_B,
      billDate: new Date('2026-09-06'),
    }));
    const res = await request(app)
      .get('/api/billing-certifications?scope=assigned')
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    expect(res.body.certifications).toHaveLength(2);
  });

  it('6. non-admin WITHOUT ?scope=assigned on /aggregates also defaults to assigned scope', async () => {
    // Same fix applies to the aggregates endpoint — without DR-018 an
    // employee would see per-project roll-ups across the whole org.
    const { app, certRows } = buildApp({
      userIsAdmin: false,
      assignment: { dpr: [{ projectId: PROJECT_A }] },
    });
    certRows.set(CERT_A1, seed({ id: CERT_A1, projectId: PROJECT_A }));
    certRows.set(CERT_B1, seed({
      id: CERT_B1, projectId: PROJECT_B,
      billDate: new Date('2026-09-06'),
    }));
    const res = await request(app)
      .get('/api/billing-certifications/aggregates')
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    const ids = res.body.projects.map((p) => p.projectId);
    expect(ids).toContain(PROJECT_A);
    expect(ids).not.toContain(PROJECT_B);
  });

  it('7. non-admin with empty ?scope= (scope=&) is treated the same as omitting the param', async () => {
    // An attacker probing with scope= (empty value) shouldn't get a
    // different answer than omitting the param — both default to assigned.
    const { app, certRows } = buildApp({
      userIsAdmin: false,
      assignment: { dpr: [{ projectId: PROJECT_A }] },
    });
    certRows.set(CERT_A1, seed({ id: CERT_A1, projectId: PROJECT_A }));
    certRows.set(CERT_B1, seed({
      id: CERT_B1, projectId: PROJECT_B,
      billDate: new Date('2026-09-06'),
    }));
    const res = await request(app)
      .get('/api/billing-certifications?scope=')
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    expect(res.body.certifications).toHaveLength(1);
    expect(res.body.certifications[0].projectId).toBe(PROJECT_A);
  });
});