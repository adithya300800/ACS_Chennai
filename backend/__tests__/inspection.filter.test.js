/**
 * DR-028 (round-20): inspection list filter integration test.
 *
 * The admin dashboard has always sent `from` and `to` query params, but
 * the route previously ignored them — `filterFrom`/`filterTo` in
 * InspectionDashboard.jsx were dead UI. This test pins the new contract:
 *
 *   - `from` alone     → gte bound, no upper
 *   - `to` alone       → lte bound, no lower
 *   - `from` + `to`    → inclusive [gte, lte] range
 *   - `reportDate`     → exclusive half-open [gte, lt) window for the day
 *   - reportDate + range → AND of both; record must match BOTH bounds
 *   - reversed range (from > to) → 400 INVALID_DATE_RANGE
 *   - malformed from/to → 400 INVALID_FROM_DATE / INVALID_TO_DATE
 *
 * Pattern mirrors __tests__/dpr.cursor.test.js — mounted route with a
 * stubbed Prisma. Records are deterministic; we assert against the
 * filter args passed to `findMany` (proving the AND-merging) AND the
 * response body (proving the route doesn't drop or duplicate records).
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const EMPLOYEE_ID_ADMIN = 'test-admin-1';

// 8 deterministic records spread across a week in September 2026. Each
// id encodes its calendar day so failure messages are easy to read.
const dateOnly = (s) => new Date(`${s}T00:00:00.000Z`);
const records = [
  { id: 'insp-2026-09-01', reportDate: dateOnly('2026-09-01') },
  { id: 'insp-2026-09-03', reportDate: dateOnly('2026-09-03') },
  { id: 'insp-2026-09-04', reportDate: dateOnly('2026-09-04') },
  { id: 'insp-2026-09-05', reportDate: dateOnly('2026-09-05') },
  { id: 'insp-2026-09-07', reportDate: dateOnly('2026-09-07') },
  { id: 'insp-2026-09-08', reportDate: dateOnly('2026-09-08') },
  { id: 'insp-2026-09-10', reportDate: dateOnly('2026-09-10') },
  { id: 'insp-2026-09-15', reportDate: dateOnly('2026-09-15') },
];

const inspectionRouter = require('../src/routes/inspection');

// Apply the Prisma where filter against our in-memory list. Mirrors the
// `where: { reportDate: { gte, lte, lt, equals } }` shape Prisma uses.
function applyWhere(rows, where = {}) {
  let r2 = rows;
  if (where.submittedById) r2 = r2.filter((r) => r.submittedById === where.submittedById);
  if (where.status) r2 = r2.filter((r) => r.status === where.status);
  if (where.severity) r2 = r2.filter((r) => r.severity === where.severity);
  if (where.inspectionType) r2 = r2.filter((r) => r.inspectionType === where.inspectionType);
  if (where.dprId) r2 = r2.filter((r) => r.dprId === where.dprId);
  if (where.reportDate) {
    if (where.reportDate.equals) {
      r2 = r2.filter((r) => r.reportDate.getTime() === new Date(where.reportDate.equals).getTime());
    }
    if (where.reportDate.gte) {
      const t = new Date(where.reportDate.gte).getTime();
      r2 = r2.filter((r) => r.reportDate.getTime() >= t);
    }
    if (where.reportDate.lte) {
      const t = new Date(where.reportDate.lte).getTime();
      r2 = r2.filter((r) => r.reportDate.getTime() <= t);
    }
    if (where.reportDate.lt) {
      const t = new Date(where.reportDate.lt).getTime();
      r2 = r2.filter((r) => r.reportDate.getTime() < t);
    }
  }
  return r2;
}

// Capture every findMany call so tests can assert on the WHERE shape.
let lastFindManyArgs = null;

function buildApp() {
  const app = express();
  app.use(express.json());
  const prisma = {
    inspectionRecord: {
      findMany: async (args) => {
        lastFindManyArgs = args;
        return applyWhere(records, args.where);
      },
    },
    employee: {
      findUnique: async () => ({ id: EMPLOYEE_ID_ADMIN, isAdmin: true }),
    },
  };
  app.set('prisma', prisma);
  app.use('/api/inspection', inspectionRouter);
  return app;
}

function authHeader() {
  const token = jwt.sign(
    { employeeId: EMPLOYEE_ID_ADMIN, email: 'test@example.com' },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  );
  return `Bearer ${token}`;
}

describe('DR-028 — inspection list from/to range filter', () => {
  const app = buildApp();

  beforeEach(() => {
    lastFindManyArgs = null;
  });

  it('admin sends from=2026-09-04&to=2026-09-08 → returns the inclusive range', async () => {
    const res = await request(app)
      .get('/api/inspection?from=2026-09-04&to=2026-09-08')
      .set('Authorization', authHeader());

    expect(res.status).toBe(200);
    const ids = res.body.inspections.map((r) => r.id);
    // Records touching the window inclusive of both endpoints.
    expect(ids).toEqual(['insp-2026-09-08', 'insp-2026-09-07', 'insp-2026-09-05', 'insp-2026-09-04']);

    // The route emitted a [gte, lte] range on the @db.Date column.
    expect(lastFindManyArgs.where.reportDate.gte).toEqual(dateOnly('2026-09-04'));
    expect(lastFindManyArgs.where.reportDate.lte).toEqual(dateOnly('2026-09-08'));
    // No `lt` (single-day filter not active here).
    expect(lastFindManyArgs.where.reportDate.lt).toBeUndefined();
  });

  it('from-only (no to) → open-ended lower bound', async () => {
    const res = await request(app)
      .get('/api/inspection?from=2026-09-05')
      .set('Authorization', authHeader());

    expect(res.status).toBe(200);
    const ids = res.body.inspections.map((r) => r.id);
    expect(ids).toEqual(['insp-2026-09-15', 'insp-2026-09-10', 'insp-2026-09-08', 'insp-2026-09-07', 'insp-2026-09-05']);
    expect(lastFindManyArgs.where.reportDate.gte).toEqual(dateOnly('2026-09-05'));
    expect(lastFindManyArgs.where.reportDate.lte).toBeUndefined();
  });

  it('to-only (no from) → open-ended upper bound', async () => {
    const res = await request(app)
      .get('/api/inspection?to=2026-09-04')
      .set('Authorization', authHeader());

    expect(res.status).toBe(200);
    const ids = res.body.inspections.map((r) => r.id);
    expect(ids).toEqual(['insp-2026-09-04', 'insp-2026-09-03', 'insp-2026-09-01']);
    expect(lastFindManyArgs.where.reportDate.gte).toBeUndefined();
    expect(lastFindManyArgs.where.reportDate.lte).toEqual(dateOnly('2026-09-04'));
  });

  it('reportDate (single day) AND from/to range → AND-merged filter', async () => {
    // Both filters active: record must match BOTH. The single-day filter
    // pins Sept 4; the range filter is [Sept 4, Sept 7]. Only Sept 4
    // satisfies both.
    const res = await request(app)
      .get('/api/inspection?reportDate=2026-09-04&from=2026-09-04&to=2026-09-07')
      .set('Authorization', authHeader());

    expect(res.status).toBe(200);
    const ids = res.body.inspections.map((r) => r.id);
    expect(ids).toEqual(['insp-2026-09-04']);

    // Merged: gte from range (the larger of reportDate's gte and range's
    // gte — both are Sept 4 here, so gte = Sept 4); lt from single-day
    // (Sept 5); lte from range (Sept 7).
    expect(lastFindManyArgs.where.reportDate.gte).toEqual(dateOnly('2026-09-04'));
    expect(lastFindManyArgs.where.reportDate.lt).toEqual(dateOnly('2026-09-05'));
    expect(lastFindManyArgs.where.reportDate.lte).toEqual(dateOnly('2026-09-07'));
  });

  it('rejects reversed range (from > to) with 400 INVALID_DATE_RANGE', async () => {
    const res = await request(app)
      .get('/api/inspection?from=2026-09-08&to=2026-09-04')
      .set('Authorization', authHeader());

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE_RANGE');
    expect(lastFindManyArgs).toBeNull(); // no DB query
  });

  it('rejects malformed `from` with 400 INVALID_FROM_DATE', async () => {
    const res = await request(app)
      .get('/api/inspection?from=not-a-date')
      .set('Authorization', authHeader());

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FROM_DATE');
    expect(lastFindManyArgs).toBeNull();
  });

  it('rejects malformed `to` with 400 INVALID_TO_DATE', async () => {
    const res = await request(app)
      .get('/api/inspection?to=2026-13-99')
      .set('Authorization', authHeader());

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TO_DATE');
    expect(lastFindManyArgs).toBeNull();
  });

  it('rejects out-of-range `from` (year < 1 or month > 12) with 400', async () => {
    const res = await request(app)
      .get('/api/inspection?from=2026-13-01')
      .set('Authorization', authHeader());

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FROM_DATE');
  });

  it('omitting from/to leaves reportDate unfiltered (backward compatibility)', async () => {
    const res = await request(app)
      .get('/api/inspection')
      .set('Authorization', authHeader());

    expect(res.status).toBe(200);
    expect(res.body.inspections).toHaveLength(records.length);
    expect(lastFindManyArgs.where.reportDate).toBeUndefined();
  });
});
