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
} = {}) {
  const app = express();
  app.use(express.json());

  const certRows = new Map();
  const projectRows = new Map();
  projectRows.set(PROJECT_A, { id: PROJECT_A, name: 'Alpha Site', code: 'ALPHA', isActive: true });
  projectRows.set(PROJECT_B, { id: PROJECT_B, name: 'Bravo Site', code: 'BRAVO', isActive: true });

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
    billingCertification: {
      findMany: jest.fn(async ({ where = {}, orderBy, take, include } = {}) => {
        let rows = Array.from(certRows.values()).filter((r) => {
          if (where.deletedAt === null && r.deletedAt) return false;
          if (where.projectId && r.projectId !== where.projectId) return false;
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
          if (where.projectId && r.projectId !== where.projectId) return false;
          if (where.status && r.status !== where.status) return false;
          return true;
        }).length;
      }),
      groupBy: jest.fn(async ({ where = {}, by, _count, _sum } = {}) => {
        let rows = Array.from(certRows.values()).filter((r) => {
          if (where.deletedAt === null && r.deletedAt) return false;
          if (where.projectId && r.projectId !== where.projectId) return false;
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

  it('3. requireFreshAdmin re-reads isAdmin — stale-JWT bypass rejected', async () => {
    // The JWT says isAdmin:true but the DB row says isAdmin:false. The
    // route's requireFreshAdmin gate re-reads Employee.isAdmin from the
    // DB on every request, so the stale claim can't carry forward
    // (round-20 / DR-005 invariant).
    const { app } = buildApp({ adminIsAdmin: false });
    const res = await request(app)
      .get('/api/billing-certifications')
      .set('Authorization', adminJwt());
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
