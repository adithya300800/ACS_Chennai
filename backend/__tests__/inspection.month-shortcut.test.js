/**
 * Round-27 — Inspection list `?month=YYYY-MM` query shortcut.
 *
 * Symmetric companion to dpr.month-shortcut.test.js — the All Inspection
 * Records admin page (InspectionAll.jsx) gets the same `?month=` shortcut
 * so its first-load UX matches All Daily Reports. The behaviour:
 *
 *   1. Valid `?month=2026-09` → findMany receives a [gte=Sep 1, lt=Oct 1)
 *      `reportDate` window via the mergedDate logic that AND-merges
 *      single-day `reportDate` with the range filter (inspection.js:481).
 *
 *   2. `?month=` combined with `from` or `to` → 400 MONTH_AND_RANGE_CONFLICT
 *      before any DB query. The inspection route accepts a wider date
 *      vocabulary (`reportDate` + `from` + `to`), so the conflict check
 *      must cover every combination.
 *
 *   3. `?month=` combined with `reportDate=YYYY-MM-DD` is allowed — the
 *      existing mergedDate logic AND-merges them, which the previous
 *      DR-028 round verified for `reportDate + from/to`. We pin the new
 *      end of that same combination.
 *
 *   4. Invalid `?month=2026-13` → 400 INVALID_MONTH, no DB query.
 *
 * Same prisma mock pattern as dpr.month-shortcut.test.js (jest.spy-able,
 * mounted real route).
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

// The inspection router imports blobStorage.js → @aws-sdk/client-s3, which
// ships ESM and breaks under Jest's default transformIgnorePatterns. Mock
// the import surface to the minimum the GET /api/inspection route uses.
// (Same pattern as inspection.upload.test.js.)
jest.mock('../src/lib/blobStorage', () => ({
  generateReadSASUrl: jest.fn(async () => ({ sasUrl: 'https://r2.example/sas', expiresAt: new Date(Date.now() + 3600 * 1000).toISOString() })),
  CONTENT_TYPE_EXT: { 'image/jpeg': 'jpg', 'image/png': 'png' },
}));

const inspectionRouter = require('../src/routes/inspection');

const EMPLOYEE_ID_ADMIN = 'test-admin-r27';
const dateOnly = (s) => new Date(`${s}T00:00:00.000Z`);
const records = [
  { id: 'insp-2026-08-31', reportDate: dateOnly('2026-08-31') },
  { id: 'insp-2026-09-01', reportDate: dateOnly('2026-09-01') },
  { id: 'insp-2026-09-15', reportDate: dateOnly('2026-09-15') },
  { id: 'insp-2026-09-30', reportDate: dateOnly('2026-09-30') },
  { id: 'insp-2026-10-01', reportDate: dateOnly('2026-10-01') },
];

// Mirrors inspection.js's `mergedDate` logic — pins the AND-merging of
// `reportDate` (single-day, half-open [gte,lt)) and `rangeFilter` (open
// or inclusive [gte, lte]). Mirrors applyReportDateFilter in
// dpr.month-shortcut.test.js but adds `equals` (single-day exact match).
function applyReportDateFilter(rows, args) {
  let out = rows;
  const reportDate = args.where && args.where.reportDate;
  if (reportDate) {
    if (reportDate.equals) {
      const t = new Date(reportDate.equals).getTime();
      out = out.filter((r) => r.reportDate.getTime() === t);
    }
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
  // Sort by reportDate DESC, id DESC — matches inspection.js:512.
  out = out.slice().sort((a, b) => {
    const dt = b.reportDate.getTime() - a.reportDate.getTime();
    if (dt !== 0) return dt;
    return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
  });
  if (typeof args.take === 'number') return out.slice(0, args.take);
  return out;
}

let lastFindManyArgs = null;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.set('prisma', {
    inspectionRecord: {
      findMany: async (args) => {
        lastFindManyArgs = args;
        return applyReportDateFilter(records, args);
      },
    },
    employee: {
      findUnique: async () => ({ id: EMPLOYEE_ID_ADMIN, isAdmin: true }),
    },
  });
  app.use('/api/inspection', inspectionRouter);
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

describe('Round-27 — Inspection list `?month=` shortcut', () => {
  const app = buildApp();

  beforeEach(() => {
    lastFindManyArgs = null;
  });

  it('expand month=2026-09 → half-open [gte=Sep 1, lt=Oct 1)', async () => {
    const res = await request(app)
      .get('/api/inspection?month=2026-09')
      .set('Authorization', authHeader());

    expect(res.status).toBe(200);
    expect(lastFindManyArgs.where.reportDate.gte).toEqual(dateOnly('2026-09-01'));
    expect(lastFindManyArgs.where.reportDate.lt).toEqual(dateOnly('2026-10-01'));
    expect(lastFindManyArgs.where.reportDate.lte).toBeUndefined();

    const ids = res.body.inspections.map((r) => r.id);
    // Sep 1, 15, 30 in; Aug 31, Oct 1 out.
    expect(ids).toEqual(['insp-2026-09-30', 'insp-2026-09-15', 'insp-2026-09-01']);
    expect(ids).not.toContain('insp-2026-08-31');
    expect(ids).not.toContain('insp-2026-10-01');
  });

  it('rejects month=2026-13 with 400 INVALID_MONTH before any DB query', async () => {
    const res = await request(app)
      .get('/api/inspection?month=2026-13')
      .set('Authorization', authHeader());

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH');
    expect(lastFindManyArgs).toBeNull();
  });

  it('rejects month combined with from with 400 MONTH_AND_RANGE_CONFLICT', async () => {
    const res = await request(app)
      .get('/api/inspection?month=2026-09&from=2026-09-15')
      .set('Authorization', authHeader());

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MONTH_AND_RANGE_CONFLICT');
    expect(lastFindManyArgs).toBeNull();
  });

  it('rejects month combined with to with 400 MONTH_AND_RANGE_CONFLICT', async () => {
    const res = await request(app)
      .get('/api/inspection?month=2026-09&to=2026-09-30')
      .set('Authorization', authHeader());

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MONTH_AND_RANGE_CONFLICT');
    expect(lastFindManyArgs).toBeNull();
  });

  it('month + single-day reportDate → existing mergedDate logic AND-merges both', async () => {
    // The mergedDate logic at inspection.js:495 was tested for
    // reportDate + from/to by DR-028 (round-20), but is the exact same
    // code path the new month shortcut flows through. Pin that the new
    // shortcut integrates correctly.
    const res = await request(app)
      .get('/api/inspection?month=2026-09&reportDate=2026-09-15')
      .set('Authorization', authHeader());

    expect(res.status).toBe(200);
    // mergedDate "max(gtes), min(ltes), min(lts)" rule applied across
    // month-range (gte Sep 1, lt Oct 1) + reportDate single-day
    // (gte Sep 15, lt Sep 16). gte = max(Sep 1, Sep 15) = Sep 15.
    // lt  = min(Oct 1, Sep 16) = Sep 16. lte comes from the month range
    // (rangeFilter.lte) = Oct 1.
    expect(lastFindManyArgs.where.reportDate.gte).toEqual(dateOnly('2026-09-15'));
    expect(lastFindManyArgs.where.reportDate.lt).toEqual(dateOnly('2026-09-16'));
    // The month shortcut sets rangeFilter.lt (not .lte) so an inclusive
    // upper bound isn't surfaced — only the half-open exclusive cap from
    // either source makes it through.
    expect(lastFindManyArgs.where.reportDate.lte).toBeUndefined();

    const ids = res.body.inspections.map((r) => r.id);
    expect(ids).toEqual(['insp-2026-09-15']);
  });

  it('no month param → falls through to the existing range/empty filter path', async () => {
    const res = await request(app)
      .get('/api/inspection')
      .set('Authorization', authHeader());

    expect(res.status).toBe(200);
    expect(lastFindManyArgs.where.reportDate).toBeUndefined();
    expect(res.body.inspections.length).toBe(5);
  });
});
