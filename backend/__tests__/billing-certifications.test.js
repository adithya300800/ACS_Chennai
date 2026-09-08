// R37: Billing Certifications — /api/billing-certifications.
//
// Mounted at /api/billing-certifications in backend/src/index.js.
// Admin-only cross-project ledger of contractor RA-bill (COP)
// certifications. Mirrors the admin-reports pattern: in-memory Prisma
// mock + a small Express app, full router under test, error handler at
// the bottom that surfaces thrown errors as JSON 500s.
//
// Coverage matrix (kept minimal per the user's "minimum blast radius"):
//   Auth gates
//     1. 401 without token (GET list)
//     2. 403 for non-admin employee (POST create)
//     3. requireFreshAdmin re-reads isAdmin from DB so a stale JWT
//        claim can't carry forward (round-20 / DR-005 invariant)
//   List / filters
//     4. ?status=DRAFT / CERTIFIED / DISPUTED filter honored
//     5. ?contractorName case-insensitive filter honored
//     6. ?from / ?to date range honored
//     7. ?projectId=<uuid> scopes to one project
//     8. Soft-deleted rows excluded
//   Pagination
//     9. ?limit=2 + cursor returns next page; cursor is base64url JSON
//   State transitions
//    10. POST /:id/certify   — DRAFT → CERTIFIED stamps certifiedBy/At
//    11. POST /:id/certify   — already-CERTIFIED is idempotent
//    12. POST /:id/dispute   — CERTIFIED → DISPUTED requires reason
//    13. POST /:id/dispute   — DRAFT → DISPUTED is 409 INVALID_TRANSITION
//    14. POST /:id/dispute   — already-DISPUTED is 409 ALREADY_DISPUTED
//   Soft-delete
//    15. DELETE /:id — soft-deletes via deletedAt
//    16. DELETE /:id — already-deleted is 404 CERTIFICATION_NOT_FOUND
//   Misc
//    17. POST /api/billing-certifications — rejects unknown blobPath prefix
//    18. GET /:id — detail joins project + recordedBy + certifiedBy

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
require('express-async-errors');

const billingRouter = require('../src/routes/billingCertifications');

// Mock blobStorage.generateReadSASUrl so /:id/read-sas doesn't try to
// sign a real R2 URL. The wrapper just echoes the blobPath with a
// stub prefix so the test can assert the call shape.
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
const CERT_A2 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
const CERT_A3 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
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

// In-memory state for the mock Prisma. The route hits several surfaces:
//   - prisma.billingCertification.findMany / findUnique / count / create / update / groupBy
//   - prisma.project.findUnique + findMany (aggregates + create validation)
//   - prisma.employee.findUnique (requireFreshAdmin gate)
function buildApp({
  adminIsAdmin = true,
  userIsAdmin = false,
  employeeExists = true,
  // ?scope=assigned derivation — what projects does this user have
  // personal context on (filed DPR/Inspection/BOQ item/VO/Drawing)?
  // Default = empty array (admin sees everything, no narrowing).
  // R37.1 employee tests pass `{ dpr: [PROJECT_A] }` etc. to simulate a
  // site engineer assigned to one project. Mirrors the R30 projects.js
  // ?scope=assigned union of audit columns.
  assignment = { dpr: [], inspection: [], boq: [], variation: [], drawing: [] },
} = {}) {
  const app = express();
  app.use(express.json());

  const certRows = new Map();
  const projectRows = new Map();
  projectRows.set(PROJECT_A, { id: PROJECT_A, name: 'Alpha Site', code: 'ALPHA', isActive: true });
  projectRows.set(PROJECT_B, { id: PROJECT_B, name: 'Bravo Site', code: 'BRAVO', isActive: true });

  // R37.1: build a fast look-up the route's `getAssignedProjectIds`
  // helper can hit. Each model exposes `findMany({ where: { submittedById,
  // ... }, select: { projectId } })`. We map the per-model "field the
  // route uses" (submittedById / createdById / raisedById / issuedById)
  // to whatever seed the test provides.
  const buildAssignedScopeFindMany = (rows) => jest.fn(async ({ where }) => {
    if (!where || !where.submittedById && !where.createdById && !where.raisedById && !where.issuedById) {
      return [];
    }
    const empId = where.submittedById || where.createdById || where.raisedById || where.issuedById;
    if (empId !== USER_ID) return [];
    // Tests may pass `assignment: { dpr: [...] }` and omit the other
    // model keys — those come back as undefined. Guard with `|| []` so
    // the union survives a partial seed instead of throwing a TypeError
    // that gets swallowed by the route's .catch(() => []) and silently
    // yields an empty scope.
    return (rows || [])
      .filter((r) => r.projectId != null)
      .map((r) => ({ projectId: r.projectId }));
  });

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
    // R37.1: the five audit-column sources the route's
    // getAssignedProjectIds() union queries against. The default
    // `assignment` is empty; tests pass `{ dpr: [{ projectId: ... }] }`
    // etc. to seed "this user has filed against project X". submittedById
    // is the audit column for DPR/Inspection; createdById for BOQ;
    // raisedById for VariationOrder; issuedById for Drawing.
    dPR: {
      findMany: buildAssignedScopeFindMany(assignment.dpr),
    },
    inspectionRecord: {
      findMany: buildAssignedScopeFindMany(assignment.inspection),
    },
    boqItem: {
      findMany: buildAssignedScopeFindMany(assignment.boq),
    },
    variationOrder: {
      findMany: buildAssignedScopeFindMany(assignment.variation),
    },
    drawing: {
      findMany: buildAssignedScopeFindMany(assignment.drawing),
    },
    billingCertification: {
      findMany: jest.fn(async ({ where = {}, orderBy, take, include } = {}) => {
        let rows = Array.from(certRows.values()).filter((r) => {
          if (where.deletedAt === null && r.deletedAt) return false;
          // `where.projectId` may be a plain UUID string OR
          // `{ in: [...] }` (when R37.1's ?scope=assigned narrows the
          // list to the requesting employee's assigned project set).
          if (where.projectId) {
            if (typeof where.projectId === 'string' && r.projectId !== where.projectId) return false;
            if (where.projectId.in && !where.projectId.in.includes(r.projectId)) return false;
          }
          if (where.status && r.status !== where.status) return false;
          if (where.contractorName?.equals &&
              typeof r.contractorName === 'string' &&
              r.contractorName.toLowerCase() !== String(where.contractorName.equals).toLowerCase()) return false;
          if (where.billDate) {
            const { gte, lte } = where.billDate;
            const ts = r.billDate instanceof Date ? r.billDate.getTime() : new Date(r.billDate).getTime();
            if (gte && ts < (gte instanceof Date ? gte.getTime() : new Date(gte).getTime())) return false;
            if (lte && ts > (lte instanceof Date ? lte.getTime() : new Date(lte).getTime())) return false;
          }
          // Keyset cursor predicate for (billDate desc, id desc) ordering.
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
        });
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
        return Array.from(certRows.values()).filter((r) => {
          if (where.deletedAt === null && r.deletedAt) return false;
          // Mirror the findMany `projectId` shape handling — string OR
          // `{ in: [...] }` for the R37.1 ?scope=assigned narrowing.
          if (where.projectId) {
            if (typeof where.projectId === 'string' && r.projectId !== where.projectId) return false;
            if (where.projectId.in && !where.projectId.in.includes(r.projectId)) return false;
          }
          if (where.status && r.status !== where.status) return false;
          return true;
        }).length;
      }),
      groupBy: jest.fn(async ({ where = {}, by, _count, _sum } = {}) => {
        let rows = Array.from(certRows.values()).filter((r) => {
          if (where.deletedAt === null && r.deletedAt) return false;
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
          return true;
        });
        const buckets = new Map();
        for (const r of rows) {
          // The route calls groupBy with `by: ['status']` for the list
          // summary AND `by: ['projectId', 'status']` for aggregates.
          // Build a key from whichever fields are in `by`.
          const key = by.map((k) => r[k]).join('||');
          const existing = buckets.get(key) || {
            key,
            count: 0,
            claimedAmount: 0,
            deductedAmount: 0,
            certifiedAmount: 0,
            values: {},
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
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        };
        certRows.set(row.id, row);
        return row;
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
    employee: {
      findUnique: jest.fn(async ({ where }) => {
        if (!employeeExists) return null;
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
  return { app, prisma, certRows, projectRows };
}

// Seed a certification row with sensible defaults.
function seed({
  id, projectId, contractorName = 'Ponni Constructions',
  billNumber = 'RAB 01', billDate = new Date('2026-09-05T00:00:00Z'),
  status = 'DRAFT', claimedAmount = 100000, deductedAmount = 0, certifiedAmount = 100000,
  recordedById = USER_ID, certifiedById = null, certifiedAt = null,
  blobPath = null, deletedAt = null,
}) {
  return {
    id, projectId, contractorName, billNumber, billDate,
    invoiceNo: 'PCDPL/25-26/021', poContractRef: 'LLPL/2387/25-26',
    claimedAmount, deductedAmount, certifiedAmount,
    gstAmount: null, poValue: null, balanceValue: null,
    remarks: null,
    status,
    recordedById, certifiedById, certifiedAt,
    disputedAt: null, disputeReason: null,
    filename: null, contentType: null, sizeBytes: null, blobPath, uploadedAt: null,
    deletedAt, createdAt: new Date(), updatedAt: new Date(),
  };
}

describe('R37 — Billing Certifications: auth gates', () => {
  it('1. 401 without token (GET list)', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/billing-certifications');
    expect(res.status).toBe(401);
  });

  it('2. 403 for non-admin employee (POST create)', async () => {
    const { app } = buildApp({ userIsAdmin: false });
    const res = await request(app)
      .post('/api/billing-certifications')
      .set('Authorization', userJwt())
      .send({
        projectId: PROJECT_A,
        contractorName: 'X',
        billNumber: 'RAB 01',
        billDate: '2026-09-05',
        claimedAmount: 1,
        certifiedAmount: 1,
      });
    expect(res.status).toBe(403);
  });

  it('3. requireFreshAdmin re-reads isAdmin — stale-JWT bypass rejected on writes', async () => {
    // The JWT says isAdmin:true but the DB row says isAdmin:false. The
    // write handlers (POST/PATCH/DELETE/certify/dispute) still mount
    // requireFreshAdmin, which re-reads Employee.isAdmin from the DB on
    // every request — so the stale claim can't carry forward
    // (round-20 / DR-005 invariant). The stale admin gets 403 on their
    // very next mutating request.
    //
    // R37.1: GET handlers were loosened to requireAuth-only so employees
    // can read their assigned projects' COPs. This test now points at a
    // write endpoint to verify the fresh-admin gate still applies where
    // it matters (mutations).
    const { app } = buildApp({ adminIsAdmin: false });
    const res = await request(app)
      .post('/api/billing-certifications')
      .set('Authorization', adminJwt())
      .send({
        projectId: PROJECT_A,
        contractorName: 'X',
        billNumber: 'RAB-STALE-01',
        billDate: '2026-09-05',
        claimedAmount: 1,
        certifiedAmount: 1,
      });
    expect(res.status).toBe(403);
  });
});

describe('R37 — Billing Certifications: list + filters', () => {
  it('4. ?status= filter honored', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_A1, seed({ id: CERT_A1, projectId: PROJECT_A, status: 'DRAFT' }));
    certRows.set(CERT_A2, seed({ id: CERT_A2, projectId: PROJECT_A, status: 'CERTIFIED' }));
    const res = await request(app)
      .get('/api/billing-certifications?status=DRAFT')
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    expect(res.body.certifications).toHaveLength(1);
    expect(res.body.certifications[0].status).toBe('DRAFT');
  });

  it('5. ?contractorName case-insensitive filter honored', async () => {
    const { app, certRows } = buildApp();
    // Prisma's `equals` with mode:'insensitive' is a case-insensitive
    // EXACT match, not a substring search. Seed two rows that differ
    // only by case so the case-insensitive match can find one and the
    // strict match would skip the other.
    certRows.set(CERT_A1, seed({ id: CERT_A1, projectId: PROJECT_A, contractorName: 'Ponni' }));
    certRows.set(CERT_A2, seed({ id: CERT_A2, projectId: PROJECT_A, contractorName: 'PONNI Constructions' }));
    const res = await request(app)
      .get('/api/billing-certifications?contractorName=ponni')
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    expect(res.body.certifications).toHaveLength(1);
    expect(res.body.certifications[0].contractorName).toBe('Ponni');
  });

  it('6. ?from / ?to date range honored', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_A1, seed({ id: CERT_A1, projectId: PROJECT_A, billDate: new Date('2026-09-01') }));
    certRows.set(CERT_A2, seed({ id: CERT_A2, projectId: PROJECT_A, billDate: new Date('2026-09-15') }));
    certRows.set(CERT_A3, seed({ id: CERT_A3, projectId: PROJECT_A, billDate: new Date('2026-09-30') }));
    const res = await request(app)
      .get('/api/billing-certifications?from=2026-09-10&to=2026-09-20')
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    expect(res.body.certifications).toHaveLength(1);
    expect(res.body.certifications[0].id).toBe(CERT_A2);
  });

  it('7. ?projectId=<uuid> scopes to one project', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_A1, seed({ id: CERT_A1, projectId: PROJECT_A }));
    certRows.set(CERT_B1, seed({ id: CERT_B1, projectId: PROJECT_B }));
    const res = await request(app)
      .get(`/api/billing-certifications?projectId=${PROJECT_A}`)
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    expect(res.body.certifications).toHaveLength(1);
    expect(res.body.certifications[0].projectId).toBe(PROJECT_A);
  });

  it('8. Soft-deleted rows excluded', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_A1, seed({ id: CERT_A1, projectId: PROJECT_A, status: 'DRAFT' }));
    certRows.set(CERT_A2, seed({
      id: CERT_A2, projectId: PROJECT_A,
      billDate: new Date('2026-09-06'),
      status: 'CERTIFIED', deletedAt: new Date(),
    }));
    const res = await request(app)
      .get('/api/billing-certifications')
      .set('Authorization', adminJwt());
    expect(res.body.certifications).toHaveLength(1);
    expect(res.body.certifications[0].id).toBe(CERT_A1);
    expect(res.body.total).toBe(1);
  });

  it('9. Cursor pagination: ?limit=2 + cursor returns next page', async () => {
    const { app, certRows } = buildApp();
    for (let i = 0; i < 4; i += 1) {
      const id = `dddddddd-dddd-4ddd-8ddd-00000000000${i}`;
      certRows.set(id, seed({
        id, projectId: PROJECT_A,
        billDate: new Date(`2026-09-0${i + 1}`),
        billNumber: `RAB 0${i + 1}`,
      }));
    }
    const first = await request(app)
      .get('/api/billing-certifications?limit=2')
      .set('Authorization', adminJwt());
    expect(first.status).toBe(200);
    expect(first.body.certifications).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await request(app)
      .get(`/api/billing-certifications?limit=2&cursor=${first.body.nextCursor}`)
      .set('Authorization', adminJwt());
    expect(second.status).toBe(200);
    expect(second.body.certifications).toHaveLength(2);
    // No row appears in both pages.
    const ids = new Set(first.body.certifications.map((r) => r.id));
    for (const r of second.body.certifications) expect(ids.has(r.id)).toBe(false);
  });
});

describe('R37 — Billing Certifications: state transitions', () => {
  it('10. POST /:id/certify — DRAFT → CERTIFIED stamps certifiedBy/At', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_A1, seed({ id: CERT_A1, projectId: PROJECT_A, status: 'DRAFT' }));
    const res = await request(app)
      .post(`/api/billing-certifications/${CERT_A1}/certify`)
      .set('Authorization', adminJwt())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CERTIFIED');
    expect(res.body.certifiedById).toBe(ADMIN_ID);
    expect(res.body.certifiedAt).toBeTruthy();
  });

  it('11. POST /:id/certify — already-CERTIFIED is idempotent', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_A1, seed({
      id: CERT_A1, projectId: PROJECT_A, status: 'CERTIFIED',
      certifiedById: ADMIN_ID, certifiedAt: new Date('2026-09-04T10:00:00Z'),
    }));
    const res = await request(app)
      .post(`/api/billing-certifications/${CERT_A1}/certify`)
      .set('Authorization', adminJwt())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CERTIFIED');
    // The original certifiedAt is preserved (not re-stamped).
    expect(new Date(res.body.certifiedAt).toISOString()).toBe('2026-09-04T10:00:00.000Z');
  });

  it('12. POST /:id/dispute — CERTIFIED → DISPUTED requires reason', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_A1, seed({ id: CERT_A1, projectId: PROJECT_A, status: 'CERTIFIED' }));
    const noReason = await request(app)
      .post(`/api/billing-certifications/${CERT_A1}/dispute`)
      .set('Authorization', adminJwt())
      .send({});
    expect(noReason.status).toBe(400);
    expect(noReason.body.code).toBe('REASON_REQUIRED');
    const ok = await request(app)
      .post(`/api/billing-certifications/${CERT_A1}/dispute`)
      .set('Authorization', adminJwt())
      .send({ reason: 'PO value exceeded' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('DISPUTED');
    expect(ok.body.disputeReason).toBe('PO value exceeded');
    expect(ok.body.disputedAt).toBeTruthy();
  });

  it('13. POST /:id/dispute — DRAFT → DISPUTED is 409 INVALID_TRANSITION', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_A1, seed({ id: CERT_A1, projectId: PROJECT_A, status: 'DRAFT' }));
    const res = await request(app)
      .post(`/api/billing-certifications/${CERT_A1}/dispute`)
      .set('Authorization', adminJwt())
      .send({ reason: 'cannot dispute a draft' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_TRANSITION');
  });

  it('14. POST /:id/dispute — already-DISPUTED is 409 ALREADY_DISPUTED', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_A1, seed({
      id: CERT_A1, projectId: PROJECT_A, status: 'DISPUTED',
      disputedAt: new Date(), disputeReason: 'old reason',
    }));
    const res = await request(app)
      .post(`/api/billing-certifications/${CERT_A1}/dispute`)
      .set('Authorization', adminJwt())
      .send({ reason: 'new reason' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_DISPUTED');
  });
});

describe('R37 — Billing Certifications: soft-delete + reads', () => {
  it('15. DELETE /:id — soft-deletes via deletedAt', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_A1, seed({ id: CERT_A1, projectId: PROJECT_A, status: 'CERTIFIED' }));
    const res = await request(app)
      .delete(`/api/billing-certifications/${CERT_A1}`)
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    expect(res.body.deletedAt).toBeTruthy();
    // Soft-deleted row excluded from list.
    const list = await request(app)
      .get('/api/billing-certifications')
      .set('Authorization', adminJwt());
    expect(list.body.certifications).toHaveLength(0);
  });

  it('16. DELETE /:id — already-deleted is 404 CERTIFICATION_NOT_FOUND', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_A1, seed({
      id: CERT_A1, projectId: PROJECT_A, status: 'CERTIFIED',
      deletedAt: new Date(),
    }));
    const res = await request(app)
      .delete(`/api/billing-certifications/${CERT_A1}`)
      .set('Authorization', adminJwt());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CERTIFICATION_NOT_FOUND');
  });

  it('17a. POST — accepts the server-owned `billing/` blobPath minted by /sas-url [DR-016]', async () => {
    // [DR-016] Fix the audit's reproduction. The client never types
    // the `billing/` prefix itself — /api/dpr/sas-url with
    // `pathPrefix: 'billing'` mints the key
    // `billing/<employeeId>/<ulid>.pdf` server-side, and the
    // confirm-upload + DB UploadIntent row record the same shape.
    // This test simulates that end-to-end by feeding a realistically
    // minted blobPath into the POST and asserting 201.
    const { app, certRows } = buildApp();
    const adminEmployeeId = ADMIN_ID;
    const res = await request(app)
      .post('/api/billing-certifications')
      .set('Authorization', adminJwt())
      .send({
        projectId: PROJECT_A,
        contractorName: 'Ponni Constructions',
        billNumber: 'RAB 02',
        billDate: '2026-09-07',
        claimedAmount: 250000,
        certifiedAmount: 240000,
        filename: 'cop.pdf',
        contentType: 'application/pdf',
        sizeBytes: 102400,
        blobPath: `billing/${adminEmployeeId}/0123456789ABCDEFGHJKMNPQR.pdf`,
      });
    expect(res.status).toBe(201);
    expect(res.body.blobPath).toBe(`billing/${adminEmployeeId}/0123456789ABCDEFGHJKMNPQR.pdf`);
    // Round-trip: the row persists the exact blobPath that the
    // mint stage issued (no normalization, no stripping).
    expect(certRows.get(res.body.id).blobPath).toBe(`billing/${adminEmployeeId}/0123456789ABCDEFGHJKMNPQR.pdf`);
  });

  it('17. POST — rejects unknown blobPath prefix', async () => {
    // The server enforces `billing/` as the namespace prefix on any
    // attachment metadata so the bucket-wide listing still
    // distinguishes billing-cert blobs from drawings / reports that
    // share the dpr-documents container.
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/billing-certifications')
      .set('Authorization', adminJwt())
      .send({
        projectId: PROJECT_A,
        contractorName: 'X',
        billNumber: 'RAB 01',
        billDate: '2026-09-05',
        claimedAmount: 100,
        certifiedAmount: 100,
        filename: 'evil.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
        blobPath: 'employee-1/evil.pdf',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BLOB_PATH');
  });

  it('18. GET /:id — detail joins project + recordedBy + certifiedBy', async () => {
    const { app, certRows } = buildApp();
    certRows.set(CERT_A1, seed({
      id: CERT_A1, projectId: PROJECT_A, status: 'CERTIFIED',
      certifiedById: ADMIN_ID, certifiedAt: new Date('2026-09-04T10:00:00Z'),
    }));
    const res = await request(app)
      .get(`/api/billing-certifications/${CERT_A1}`)
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    expect(res.body.project.id).toBe(PROJECT_A);
    expect(res.body.recordedBy).toBeTruthy();
    expect(res.body.certifiedBy.id).toBe(ADMIN_ID);
  });
});

// ─── R37.1 — Billing Certifications: employee read access ──────────────────
// Read endpoints (GET /, GET /:id, GET /:id/read-sas, GET /aggregates) are
// open to any authenticated employee. The list + aggregates honour
// ?scope=assigned so an employee only sees COPs against projects they
// have personal context on (filed DPR/Inspection/BOQ/VO/Drawing). Detail +
// read-sas auto-scope on the row's projectId — an employee can't access a
// COP for a project they're not on, and the response is 404 (not 403)
// so we don't leak the row's existence.
//
// Mutations (POST/PATCH/DELETE/certify/dispute) still mount
// requireFreshAdmin — site engineers can READ but never WRITE the COP
// register.
describe('R37.1 — Billing Certifications: employee read access', () => {
  it('19. employee GET list with ?scope=assigned returns only assigned projects\' COPs', async () => {
    const { app, certRows } = buildApp({
      userIsAdmin: false,
      // Site engineer has filed one DPR on PROJECT_A and one BOQ item on
      // PROJECT_A — assignment union includes PROJECT_A only.
      assignment: { dpr: [{ projectId: PROJECT_A }], boq: [{ projectId: PROJECT_A }] },
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
    expect(res.body.total).toBe(1);
    // Summary aggregates must respect the same scope.
    expect(res.body.summary.byStatus.DRAFT.count).toBe(1);
    expect(res.body.summary.byStatus.CERTIFIED.count).toBe(0);
    expect(res.body.summary.byStatus.DISPUTED.count).toBe(0);
  });

  it('20. employee without any assigned projects gets total: 0 (forced-empty)', async () => {
    const { app, certRows } = buildApp({
      userIsAdmin: false,
      assignment: { dpr: [], inspection: [], boq: [], variation: [], drawing: [] },
    });
    certRows.set(CERT_A1, seed({ id: CERT_A1, projectId: PROJECT_A }));
    certRows.set(CERT_B1, seed({ id: CERT_B1, projectId: PROJECT_B }));
    const res = await request(app)
      .get('/api/billing-certifications?scope=assigned')
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    expect(res.body.certifications).toHaveLength(0);
    expect(res.body.total).toBe(0);
    expect(res.body.summary.byStatus.DRAFT.count).toBe(0);
  });

  it('21. invalid scope value returns 400 INVALID_SCOPE', async () => {
    const { app } = buildApp({ userIsAdmin: false });
    const res = await request(app)
      .get('/api/billing-certifications?scope=all')
      .set('Authorization', userJwt());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SCOPE');
    expect(res.body.message).toMatch(/assigned/);
  });

  it('22. employee can GET detail of COP for an assigned project (200)', async () => {
    const { app, certRows } = buildApp({
      userIsAdmin: false,
      assignment: { inspection: [{ projectId: PROJECT_A }] },
    });
    certRows.set(CERT_A1, seed({ id: CERT_A1, projectId: PROJECT_A }));
    const res = await request(app)
      .get(`/api/billing-certifications/${CERT_A1}`)
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(CERT_A1);
  });

  // The detail endpoint hides rows from employees who aren't on the
  // project's site. The response is 404 — not 403 — so we don't leak the
  // row's existence (an attacker probing IDs gets no signal that the
  // row exists but is out of scope).
  it('23. employee can\'t GET detail of COP for a non-assigned project (404)', async () => {
    const { app, certRows } = buildApp({
      userIsAdmin: false,
      assignment: { dpr: [{ projectId: PROJECT_A }] },
    });
    certRows.set(CERT_B1, seed({ id: CERT_B1, projectId: PROJECT_B }));
    const res = await request(app)
      .get(`/api/billing-certifications/${CERT_B1}`)
      .set('Authorization', userJwt());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CERTIFICATION_NOT_FOUND');
  });

  // Same scope guard on the read-sas endpoint — an employee who guesses
  // a COP id for an unassigned project must NOT be able to mint a SAS
  // for the underlying PDF blob.
  it('24. employee can\'t mint read-sas for a non-assigned project\'s COP (404)', async () => {
    const { app, certRows } = buildApp({
      userIsAdmin: false,
      assignment: { dpr: [{ projectId: PROJECT_A }] },
    });
    certRows.set(CERT_B1, seed({
      id: CERT_B1, projectId: PROJECT_B,
      blobPath: 'billing/01HQX/test.pdf',
    }));
    const res = await request(app)
      .get(`/api/billing-certifications/${CERT_B1}/read-sas`)
      .set('Authorization', userJwt());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CERTIFICATION_NOT_FOUND');
  });

  // The five mutation endpoints (POST/PATCH/DELETE/certify/dispute) still
  // gate on requireFreshAdmin — site engineers have READ-only access to
  // the COP register. Even an employee with admin scope on the row
  // (PROJECT_A in the assignment) can't write.
  it('25. employee POST/PATCH/DELETE/certify/dispute all 403 (write endpoints stay admin-only)', async () => {
    const { app, certRows } = buildApp({
      userIsAdmin: false,
      assignment: { dpr: [{ projectId: PROJECT_A }] },
    });
    certRows.set(CERT_A1, seed({ id: CERT_A1, projectId: PROJECT_A, status: 'DRAFT' }));

    const auth = () => userJwt();

    const post = await request(app)
      .post('/api/billing-certifications')
      .set('Authorization', auth())
      .send({
        projectId: PROJECT_A,
        contractorName: 'X',
        billNumber: 'RAB-EMP-01',
        billDate: '2026-09-05',
        claimedAmount: 1,
        certifiedAmount: 1,
      });
    expect(post.status).toBe(403);

    const patch = await request(app)
      .patch(`/api/billing-certifications/${CERT_A1}`)
      .set('Authorization', auth())
      .send({ remarks: 'employee trying to edit' });
    expect(patch.status).toBe(403);

    const certify = await request(app)
      .post(`/api/billing-certifications/${CERT_A1}/certify`)
      .set('Authorization', auth())
      .send({});
    expect(certify.status).toBe(403);

    const dispute = await request(app)
      .post(`/api/billing-certifications/${CERT_A1}/dispute`)
      .set('Authorization', auth())
      .send({ reason: 'employee trying to dispute' });
    expect(dispute.status).toBe(403);

    const del = await request(app)
      .delete(`/api/billing-certifications/${CERT_A1}`)
      .set('Authorization', auth());
    expect(del.status).toBe(403);
  });

  // Admins ignore ?scope=assigned — they continue to see the cross-
  // project registry, same behaviour as the existing /api/projects
  // ?scope=assigned contract. This is the difference between the admin
  // Records-group "Billing Certifications" entry and the employee My
  // Reports-group "My Certifications" entry.
  it('26. admin GET list with ?scope=assigned ignores the param and returns all', async () => {
    const { app, certRows } = buildApp({ adminIsAdmin: true });
    certRows.set(CERT_A1, seed({ id: CERT_A1, projectId: PROJECT_A }));
    certRows.set(CERT_B1, seed({ id: CERT_B1, projectId: PROJECT_B }));
    const res = await request(app)
      .get('/api/billing-certifications?scope=assigned')
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    expect(res.body.certifications).toHaveLength(2);
    expect(res.body.total).toBe(2);
  });

  // The /aggregates endpoint must honour the same scope — an employee
  // should not see OTHER projects' COPs rolled up in the totals.
  it('27. employee GET /aggregates with ?scope=assigned returns only assigned projects', async () => {
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
      .get('/api/billing-certifications/aggregates?scope=assigned')
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    const ids = res.body.projects.map((p) => p.projectId);
    expect(ids).toContain(PROJECT_A);
    expect(ids).not.toContain(PROJECT_B);
  });
});
