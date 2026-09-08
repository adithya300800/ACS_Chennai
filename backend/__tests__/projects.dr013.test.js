/**
 * DR-013 — Project dashboard KPI day-bucket boundary uses IST, not UTC.
 *
 * Audit-confirmed: at 04:42 IST on 8 September 2026 the test project had a
 * same-day DPR draft and three inspections. The Project Dashboard window
 * ended at 8 September, yet Drafts = 0, Inspection Total = 0 and no type
 * records. The all-date OPEN backlog correctly showed 1.
 *
 * Root cause: the kpiHandler picked the UTC calendar day from
 * `new Date()` and used `< 2026-09-08T00:00:00Z` as the upper bound. At
 * 04:42 IST on Sept 8 the UTC date is still Sept 7, so the upper bound
 * became `2026-09-08T00:00:00Z` — and DPRs / inspections with
 * `reportDate` stored as `2026-09-08T00:00:00Z` (the canonical encoding
 * for the IST day of Sept 8) fell on the wrong side of the half-open
 * range. At 05:30 IST the UTC calendar day catches up and the bug
 * silently disappears without anyone mutating the report.
 *
 * Fix: compute the window from the IST business day via the canonical
 * helper `getTodayBusinessDate(now)` (lib/dateOnly.js) — the same one
 * attendance / dpr / inspection routes already use. The two endpoints
 * become UTC midnights of (toDay - days) and (toDay + 1), where `toDay`
 * is IST today.
 *
 * Acceptance (this file pins):
 *   04:42, 05:29:59, 05:30:00 and 05:30:01 IST all yield
 *     - toDayExclusive = 2026-09-09T00:00:00.000Z (inclusive of IST Sept 8)
 *     - fromDay       = 2026-09-08T00:00:00.000Z (days=1 window)
 *   And a DPR / inspection with reportDate = 2026-09-08T00:00:00.000Z is
 *   counted by the roll-up at all four instants.
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const projectRouter = require('../src/routes/projects');
const { computeKpiWindow } = require('../src/routes/projects');

const T_NAGAR_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = 'admin-1';

function adminJwt() {
  return `Bearer ${jwt.sign(
    { employeeId: ADMIN_ID, email: 'admin@example.com', isAdmin: true },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  )}`;
}

// ─── Unit-level pin: computeKpiWindow collapses the IST/UTC boundary ───────
//
// Each of these instants is a different IST time on the same IST day
// (8 September 2026) but straddles the UTC date flip at 05:30 IST. The
// pre-fix code returned three DIFFERENT window upper-bounds for these
// four instants; the fix returns one.
const IST_SEPT_8_INSTANTS = [
  ['2026-09-07T23:12:00.000Z', '04:42 IST 2026-09-08 (pre-boundary)'],
  ['2026-09-08T00:00:00.000Z', '05:30 IST 2026-09-08 (UTC midnight flip)'],
  ['2026-09-08T00:00:01.000Z', '05:30:01 IST 2026-09-08 (post-boundary)'],
  ['2026-09-08T18:29:59.000Z', '23:59:59 IST 2026-09-08 (late day)'],
];

describe('DR-013 — computeKpiWindow uses IST business day, not UTC', () => {
  it.each(IST_SEPT_8_INSTANTS)(
    'at %s (%s) the upper bound is the UTC midnight of IST Sept 9',
    (isoInstant) => {
      const { toDayExclusive } = computeKpiWindow(new Date(isoInstant), 1);
      expect(toDayExclusive.toISOString()).toBe('2026-09-09T00:00:00.000Z');
    },
  );

  it.each(IST_SEPT_8_INSTANTS)(
    'at %s (%s) days=1 window is exactly one IST day wide',
    (isoInstant) => {
      const { fromDay, toDayExclusive } = computeKpiWindow(new Date(isoInstant), 1);
      // fromDay = UTC midnight of IST Sept 7 (days=1 means "yesterday + today").
      // toDayExclusive = UTC midnight of IST Sept 9.
      expect(fromDay.toISOString()).toBe('2026-09-07T00:00:00.000Z');
      expect(toDayExclusive.toISOString()).toBe('2026-09-09T00:00:00.000Z');
    },
  );

  it.each(IST_SEPT_8_INSTANTS)(
    'at %s (%s) a record with reportDate = IST Sept 8 is included in the [gte, lt) range',
    (isoInstant) => {
      const { fromDay, toDayExclusive } = computeKpiWindow(new Date(isoInstant), 1);
      const reportDate = new Date('2026-09-08T00:00:00.000Z'); // canonical IST Sept 8
      expect(reportDate.getTime()).toBeGreaterThanOrEqual(fromDay.getTime());
      expect(reportDate.getTime()).toBeLessThan(toDayExclusive.getTime());
    },
  );

  it('at 23:12 UTC on Sept 7 (04:42 IST Sept 8) the OLD UTC formula would have excluded IST Sept 8', () => {
    // Regression pin: lock the failure mode so a future UTC reversion
    // is detected, not silently re-introduced.
    const instant = new Date('2026-09-07T23:12:00.000Z');
    const toDate = instant;
    const oldToDayExclusive = new Date(Date.UTC(
      toDate.getUTCFullYear(), toDate.getUTCMonth(), toDate.getUTCDate() + 1,
    ));
    expect(oldToDayExclusive.toISOString()).toBe('2026-09-08T00:00:00.000Z');
    // IST Sept 8 (= 2026-09-08T00:00:00Z) is NOT less than the OLD bound,
    // so the OLD code excluded it. The new helper does not.
    const istSept8 = new Date('2026-09-08T00:00:00.000Z');
    expect(istSept8.getTime() < oldToDayExclusive.getTime()).toBe(false);

    const { toDayExclusive } = computeKpiWindow(instant, 1);
    expect(istSept8.getTime() < toDayExclusive.getTime()).toBe(true);
  });
});

// ─── Integration pin: kpiHandler counts today's IST reports under fake clock ─
//
// Mocks `Date` so the route's `new Date()` returns 04:42 IST Sept 8, the
// exact instant from the audit repro. The DPR + inspection rows are
// dated `2026-09-08T00:00:00.000Z` — the canonical @db.Date encoding for
// "IST Sept 8". Pre-fix this returned Drafts=0, Inspection Total=0;
// post-fix it returns Drafts=1, Inspection Total=3.
describe('DR-013 — kpiHandler counts today-IST records under fake clock', () => {
  const projectRows = [
    {
      id: T_NAGAR_ID,
      name: 'T-Nagar',
      code: 'T-NAGAR',
      client: 'ACS',
      location: 'Chennai',
      isActive: true,
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      expectedEndDate: new Date('2026-12-31T00:00:00.000Z'),
      createdById: ADMIN_ID,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  ];

  // Rows dated the IST day of 8 Sept 2026 — the canonical @db.Date
  // encoding is `2026-09-08T00:00:00.000Z`. Pre-fix, kpiHandler's UTC
  // upper bound `lt 2026-09-08T00:00:00.000Z` excluded all of these.
  // Mirrors the audit's "same fixtures" acceptance: Drafts=1,
  // Total inspections=3, OPEN=1.
  const istToday = new Date('2026-09-08T00:00:00.000Z');
  const dprRows = [
    { id: 'dpr-today', projectName: 'T-Nagar', reportDate: istToday, status: 'DRAFT' },
  ];
  const inspectionRows = [
    { id: 'insp-1', projectName: 'T-Nagar', inspectionType: 'cube_casting', status: 'CLOSED', reportDate: istToday },
    { id: 'insp-2', projectName: 'T-Nagar', inspectionType: 'cube_casting', status: 'CLOSED', reportDate: istToday },
    { id: 'insp-3', projectName: 'T-Nagar', inspectionType: 'material_inspection', status: 'OPEN', reportDate: istToday },
  ];

  function filterRows(rows, where = {}) {
    let r = rows;
    if (where.projectName) r = r.filter((row) => row.projectName === where.projectName);
    if (where.status) {
      if (typeof where.status === 'string') {
        r = r.filter((row) => row.status === where.status);
      }
    }
    if (where.reportDate) {
      if (where.reportDate.gte) {
        const t = new Date(where.reportDate.gte).getTime();
        r = r.filter((row) => row.reportDate.getTime() >= t);
      }
      if (where.reportDate.lt) {
        const t = new Date(where.reportDate.lt).getTime();
        r = r.filter((row) => row.reportDate.getTime() < t);
      }
    }
    return r;
  }

  function makePrisma() {
    return {
      project: {
        findMany: jest.fn(async () => projectRows),
        findUnique: jest.fn(async ({ where }) => {
          if (where.id === T_NAGAR_ID) return projectRows[0];
          if (where.name === 'T-Nagar') return projectRows[0];
          return null;
        }),
        findFirst: jest.fn(async ({ where }) => {
          if (!where || !where.name) return null;
          const target = String(where.name.equals || '').toLowerCase();
          return projectRows.find((p) => p.name.toLowerCase() === target) || null;
        }),
        create: jest.fn(),
        update: jest.fn(),
      },
      dPR: {
        findMany: jest.fn(async () => []),
        count: jest.fn(async ({ where }) => filterRows(dprRows, where).length),
      },
      inspectionRecord: {
        findMany: jest.fn(async () => []),
        count: jest.fn(async ({ where }) => filterRows(inspectionRows, where).length),
        groupBy: jest.fn(async ({ where }) => {
          const filtered = filterRows(inspectionRows, where);
          const map = {};
          for (const row of filtered) {
            map[row.inspectionType] = (map[row.inspectionType] || 0) + 1;
          }
          return Object.keys(map).map((inspectionType) => ({
            inspectionType,
            _count: { _all: map[inspectionType] },
          }));
        }),
      },
      boqItem: { findMany: jest.fn(async () => []) },
      leaveRequest: { count: jest.fn(async () => 0) },
      trainingEnrollment: { count: jest.fn(async () => 0) },
      employee: {
        findUnique: jest.fn(async ({ where }) => {
          if (where.id === ADMIN_ID) return { id: ADMIN_ID, isAdmin: true };
          return null;
        }),
      },
    };
  }

  function buildApp(prisma) {
    const app = express();
    app.use(express.json());
    app.set('prisma', prisma);
    app.use('/api/projects', projectRouter);
    return app;
  }

  // The four instants from the audit acceptance criterion.
  const fakeClocks = [
    ['2026-09-07T23:12:00.000Z', '04:42 IST 2026-09-08'],
    ['2026-09-07T23:59:59.000Z', '05:29:59 IST 2026-09-08'],
    ['2026-09-08T00:00:00.000Z', '05:30:00 IST 2026-09-08'],
    ['2026-09-08T00:00:01.000Z', '05:30:01 IST 2026-09-08'],
  ];

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each(fakeClocks)(
    'at %s (%s) the kpi endpoint returns Drafts=1, Total inspections=3, OPEN=1',
    async (isoInstant) => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date(isoInstant));
      const prisma = makePrisma();
      const app = buildApp(prisma);
      const res = await request(app)
        .get(`/api/projects/${T_NAGAR_ID}/kpis?days=1`)
        .set('Authorization', adminJwt());
      expect(res.status).toBe(200);
      expect(res.body.dpr.draftCount).toBe(1);
      expect(res.body.inspections.totalCount).toBe(3);
      // OPEN is org-wide + unwindowed; the fixture has exactly 1 OPEN
      // inspection (insp-3 material_inspection).
      expect(res.body.inspections.openCount).toBe(1);
      // Window advertised in the response: from = IST Sept 7, to = IST Sept 9.
      // (to is exclusive — represents the day after the upper bound.)
      expect(res.body.window.from).toBe('2026-09-07');
      expect(res.body.window.to).toBe('2026-09-09');
    },
  );
});