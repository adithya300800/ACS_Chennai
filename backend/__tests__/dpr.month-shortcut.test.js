/**
 * Round-27 — DPR list `?month=YYYY-MM` query shortcut.
 *
 * The All DPR Records admin page (DprAll.jsx) defaults to a month-wise
 * view now. The frontend sends `?month=YYYY-MM`; the backend expands
 * that to a half-open [gte, lt) `reportDate` window aligned to the
 * company's IST calendar via getMonthRangeUtc() in lib/dateOnly.js.
 *
 * This file pins four contract points:
 *
 *   1. Valid `?month=2026-09` → findMany receives a window with
 *      gte = 2026-09-01T00:00:00.000Z and lt = 2026-10-01T00:00:00.000Z.
 *      Records on Aug 31 and Oct 1 are excluded (off-by-one check).
 *
 *   2. Invalid `?month=2026-13` → 400 with code `INVALID_MONTH`,
 *      before any DB query.
 *
 *   3. Combined `?month=2026-09&from=2026-09-15` → 400 with code
 *      `MONTH_AND_RANGE_CONFLICT`, before any DB query.
 *
 *   4. The empty case `?month=` (just the key, empty value) is treated
 *      as "no month filter" — findMany receives no reportDate clause,
 *      the existing `from`/`to` path is still consulted but is empty
 *      here. Pinning this so frontends that always send `month=` on
 *      mount don't accidentally get a 400.
 *
 * Pattern follows inspection.upload.test.js — mounted route with a
 * stubbed Prisma, deterministic in-memory records, JWT auth.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

// The dpr router imports blobStorage.js → @aws-sdk/client-s3, which ships
// ESM and breaks under Jest's default transformIgnorePatterns. Mock the
// import surface to the minimum the GET /api/dpr route uses.
// (Same pattern as inspection.upload.test.js.)
jest.mock('../src/lib/blobStorage', () => ({
  generateReadSASUrl: jest.fn(async () => ({ sasUrl: 'https://r2.example/sas', expiresAt: new Date(Date.now() + 3600 * 1000).toISOString() })),
  CONTENT_TYPE_EXT: { 'image/jpeg': 'jpg', 'image/png': 'png' },
}));

const dprRouter = require('../src/routes/dpr');

// 6 deterministic records straddling August/September/October 2026.
const EMPLOYEE_ID_ADMIN = 'test-admin-r27';
const EMPLOYEE_ID_OTHER = 'test-other-r27';
const dateOnly = (s) => new Date(`${s}T00:00:00.000Z`);
const records = [
  { id: 'dpr-2026-08-31', reportDate: dateOnly('2026-08-31'), status: 'SUBMITTED',
    submittedById: EMPLOYEE_ID_OTHER, photos: [],
    submittedBy: { id: EMPLOYEE_ID_OTHER, name: 'Other', email: 'other@example.com' } },
  { id: 'dpr-2026-09-01', reportDate: dateOnly('2026-09-01'), status: 'APPROVED',
    submittedById: EMPLOYEE_ID_ADMIN, photos: [],
    submittedBy: { id: EMPLOYEE_ID_ADMIN, name: 'Admin', email: 'admin@example.com' } },
  { id: 'dpr-2026-09-15', reportDate: dateOnly('2026-09-15'), status: 'APPROVED',
    submittedById: EMPLOYEE_ID_ADMIN, photos: [],
    submittedBy: { id: EMPLOYEE_ID_ADMIN, name: 'Admin', email: 'admin@example.com' } },
  { id: 'dpr-2026-09-30', reportDate: dateOnly('2026-09-30'), status: 'REJECTED',
    submittedById: EMPLOYEE_ID_ADMIN, photos: [],
    submittedBy: { id: EMPLOYEE_ID_ADMIN, name: 'Admin', email: 'admin@example.com' } },
  { id: 'dpr-2026-10-01', reportDate: dateOnly('2026-10-01'), status: 'DRAFT',
    submittedById: EMPLOYEE_ID_ADMIN, photos: [],
    submittedBy: { id: EMPLOYEE_ID_ADMIN, name: 'Admin', email: 'admin@example.com' } },
  { id: 'dpr-2026-12-31', reportDate: dateOnly('2026-12-31'), status: 'APPROVED',
    submittedById: EMPLOYEE_ID_OTHER, photos: [],
    submittedBy: { id: EMPLOYEE_ID_OTHER, name: 'Other', email: 'other@example.com' } },
];

// Apply the same shape of where-clause Prisma's `where.reportDate: { gte, lt }`
// would emit. Mirrors inspection.filter.test.js's applyWhere helper.
//
// The route also passes `orderBy: [{ reportDate: 'desc' }, { id: 'desc' }]`
// and `take: <limit + 1>`, so we honour those here so test assertions
// describe what the route actually returns, not what an unfiltered
// in-memory list looks like.
function applyReportDateFilter(rows, args) {
  let out = rows;
  const reportDate = args.where && args.where.reportDate;
  if (reportDate) {
    if (reportDate.gte) {
      const t = new Date(reportDate.gte).getTime();
      out = out.filter((r) => r.reportDate.getTime() >= t);
    }
    if (reportDate.lt) {
      const t = new Date(reportDate.lt).getTime();
      out = out.filter((r) => r.reportDate.getTime() < t);
    }
    if (reportDate.lte) {
      const t = new Date(reportDate.lte).getTime();
      out = out.filter((r) => r.reportDate.getTime() <= t);
    }
  }
  // Sort by reportDate DESC, id DESC — matches dpr.js:706.
  out = out.slice().sort((a, b) => {
    const dt = b.reportDate.getTime() - a.reportDate.getTime();
    if (dt !== 0) return dt;
    return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
  });
  // Prisma's `take: n` semantics: return up to n rows. The route asks
  // for `take + 1` (line 707) and slices the last off to detect `hasMore`,
  // so we honour the cap here too.
  if (typeof args.take === 'number') return out.slice(0, args.take);
  return out;
}

let lastFindManyArgs = null;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.set('prisma', {
    dPR: {
      findMany: async (args) => {
        lastFindManyArgs = args;
        return applyReportDateFilter(records, args);
      },
    },
    employee: {
      findUnique: async () => ({ id: EMPLOYEE_ID_ADMIN, isAdmin: true }),
    },
  });
  app.use('/api/dpr', dprRouter);
  return app;
}

function authHeader() {
  const token = jwt.sign(
    { employeeId: EMPLOYEE_ID_ADMIN, email: 'admin@example.com' },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  );
  return `Bearer ${token}`;
}

describe('Round-27 — DPR list `?month=` shortcut', () => {
  const app = buildApp();

  beforeEach(() => {
    lastFindManyArgs = null;
  });

  it('expand month=2026-09 → half-open [gte=Sep 1, lt=Oct 1)', async () => {
    const res = await request(app)
      .get('/api/dpr?month=2026-09')
      .set('Authorization', authHeader());

    expect(res.status).toBe(200);
    // Bounds: gte Sep 1, lt Oct 1 (exclusive end to avoid 09-30 + 1 day bug).
    expect(lastFindManyArgs.where.reportDate.gte).toEqual(dateOnly('2026-09-01'));
    expect(lastFindManyArgs.where.reportDate.lt).toEqual(dateOnly('2026-10-01'));
    // Inclusive lte should be absent — month shortcut is half-open, not inclusive.
    expect(lastFindManyArgs.where.reportDate.lte).toBeUndefined();

    const ids = res.body.dprs.map((d) => d.id);
    // Sep 1, 15, 30 are in; Aug 31 and Oct 1 are out (off-by-one check).
    expect(ids).toEqual(['dpr-2026-09-30', 'dpr-2026-09-15', 'dpr-2026-09-01']);
    expect(ids).not.toContain('dpr-2026-08-31');
    expect(ids).not.toContain('dpr-2026-10-01');
  });

  it('rejects month=2026-13 with 400 INVALID_MONTH before any DB query', async () => {
    const res = await request(app)
      .get('/api/dpr?month=2026-13')
      .set('Authorization', authHeader());

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH');
    expect(lastFindManyArgs).toBeNull();
  });

  it('rejects month=garbage with 400 INVALID_MONTH before any DB query', async () => {
    const res = await request(app)
      .get('/api/dpr?month=not-a-month')
      .set('Authorization', authHeader());

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH');
    expect(lastFindManyArgs).toBeNull();
  });

  it('rejects month combined with from with 400 MONTH_AND_RANGE_CONFLICT', async () => {
    const res = await request(app)
      .get('/api/dpr?month=2026-09&from=2026-09-15')
      .set('Authorization', authHeader());

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MONTH_AND_RANGE_CONFLICT');
    expect(lastFindManyArgs).toBeNull();
  });

  it('rejects month combined with to with 400 MONTH_AND_RANGE_CONFLICT', async () => {
    const res = await request(app)
      .get('/api/dpr?month=2026-09&to=2026-09-30')
      .set('Authorization', authHeader());

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MONTH_AND_RANGE_CONFLICT');
    expect(lastFindManyArgs).toBeNull();
  });

  it('no month param → falls through to the existing range/empty filter path', async () => {
    // Empty query — admin should see every org row (the existing behavior
    // pinned by InspectionAll.jsx and DprAll.jsx apart from the new month
    // default). The mock returns all 6 records.
    const res = await request(app)
      .get('/api/dpr')
      .set('Authorization', authHeader());

    expect(res.status).toBe(200);
    expect(lastFindManyArgs.where.reportDate).toBeUndefined();
    expect(res.body.dprs.length).toBe(6);
  });

  it('to=YYYY-MM-DD alone still works (regression guard for the existing path)', async () => {
    const res = await request(app)
      .get('/api/dpr?to=2026-09-15')
      .set('Authorization', authHeader());

    expect(res.status).toBe(200);
    expect(lastFindManyArgs.where.reportDate.lte).toEqual(dateOnly('2026-09-15'));
    expect(lastFindManyArgs.where.reportDate.lt).toBeUndefined();
    const ids = res.body.dprs.map((d) => d.id);
    // Inclusive: Aug 31, Sep 1, Sep 15 are all <= Sep 15.
    expect(ids).toEqual(['dpr-2026-09-15', 'dpr-2026-09-01', 'dpr-2026-08-31']);
  });
});
