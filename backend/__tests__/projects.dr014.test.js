/**
 * DR-014 — Project dashboard drill panel contract for "Pending Review".
 *
 * Audit verdict: "Pending counts include SUBMITTED + UNDER_REVIEW while the
 * drill requests only UNDER_REVIEW without the matching dates". The
 * "Pending Review" KPI tile reads as a count of 5 (e.g. 3 SUBMITTED + 2
 * UNDER_REVIEW) but the drill panel under the same tile only fetched
 * UNDER_REVIEW rows, so the panel showed 2 rows against a tile that
 * said 5 — the user reads that as "the page is blank".
 *
 * The frontend fix (ProjectDashboard.jsx, TILE_META['dpr.pendingReview'])
 * now makes the drill loader fetch BOTH statuses in parallel. This test
 * pins the backend contract the loader relies on: `pendingReviewCount`
 * MUST equal `submitted + underReview` for any window. If a future
 * change ever splits that count (e.g. "Queue Size" vs "Under Review"),
 * the test catches the divergence between the KPI and the drill.
 *
 * Pattern mirrors projects.dr013.test.js: mounted route with a stubbed
 * Prisma so we don't need a live database.
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const projectRouter = require('../src/routes/projects');
const { getTodayBusinessDate } = require('../src/lib/dateOnly');

const T_NAGAR_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = 'admin-1';

function adminJwt() {
  return `Bearer ${jwt.sign(
    { employeeId: ADMIN_ID, email: 'admin@example.com', isAdmin: true },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  )}`;
}

describe('DR-014 — KPI pendingReviewCount = SUBMITTED + UNDER_REVIEW (drill contract)', () => {
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

  // Fixture: 3 SUBMITTED + 2 UNDER_REVIEW + 1 APPROVED + 1 REJECTED +
  // 1 DRAFT — all dated the same IST day inside the 30-day window.
  // Pre-fix, the drill loader would have shown only 2 rows under a tile
  // that reads "5" — this fixture pins the sum contract.
  //
  // The date MUST be derived, not hard-coded. The KPI window is computed
  // from the wall clock (`toDate = new Date()`), so a fixture pinned to a
  // fixed calendar date silently ages out of the 30-day window: every
  // count collapses to 0 and the suite fails on an unrelated day. (That
  // is exactly what happened to this file — it was pinned to 2026-09-08
  // and started failing once "today" moved past 2026-09-25.) Use the same
  // helper the route uses, one business day back, so the rows land
  // inside the window on any date the suite runs — the window is
  // [toDay - days, toDay + 1), i.e. 31 calendar days wide, so a row
  // dated yesterday can never fall out of it.
  const istToday = new Date(
    getTodayBusinessDate(new Date()).getTime() - 24 * 60 * 60 * 1000
  );
  // One row deliberately OUTSIDE the window (45 days back) so the suite
  // proves the date filter is actually applied — otherwise a future
  // "fix" that dropped the window filter would still pass.
  const outsideWindow = new Date(
    getTodayBusinessDate(new Date()).getTime() - 45 * 24 * 60 * 60 * 1000
  );
  const dprRows = [
    { id: 'dpr-1', projectName: 'T-Nagar', reportDate: istToday, status: 'SUBMITTED' },
    { id: 'dpr-2', projectName: 'T-Nagar', reportDate: istToday, status: 'SUBMITTED' },
    { id: 'dpr-3', projectName: 'T-Nagar', reportDate: istToday, status: 'SUBMITTED' },
    { id: 'dpr-4', projectName: 'T-Nagar', reportDate: istToday, status: 'UNDER_REVIEW' },
    { id: 'dpr-5', projectName: 'T-Nagar', reportDate: istToday, status: 'UNDER_REVIEW' },
    { id: 'dpr-6', projectName: 'T-Nagar', reportDate: istToday, status: 'APPROVED' },
    { id: 'dpr-7', projectName: 'T-Nagar', reportDate: istToday, status: 'REJECTED' },
    { id: 'dpr-8', projectName: 'T-Nagar', reportDate: istToday, status: 'DRAFT' },
    { id: 'dpr-old', projectName: 'T-Nagar', reportDate: outsideWindow, status: 'SUBMITTED' },
  ];

  function filterRows(rows, where = {}) {
    let r = rows;
    if (where.projectName) r = r.filter((row) => row.projectName === where.projectName);
    if (where.status) r = r.filter((row) => row.status === where.status);
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
        count: jest.fn(async () => 0),
        groupBy: jest.fn(async () => []),
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

  it('reports pendingReviewCount = submitted + underReview so the drill panel can match it', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .get(`/api/projects/${T_NAGAR_ID}/kpis?days=30`)
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    // Fixture has 3 SUBMITTED + 2 UNDER_REVIEW → pendingReviewCount must be 5.
    expect(res.body.dpr.submittedCount).toBe(3);
    expect(res.body.dpr.approvedCount).toBe(1);
    expect(res.body.dpr.rejectedCount).toBe(1);
    expect(res.body.dpr.draftCount).toBe(1);
    // This is the contract the DR-014 drill loader relies on.
    expect(res.body.dpr.pendingReviewCount).toBe(
      res.body.dpr.submittedCount + 2, // 2 UNDER_REVIEW in the fixture
    );
    expect(res.body.dpr.pendingReviewCount).toBe(5);
  });

  it('pendingReviewCount collapses to 0 when the project has no SUBMITTED or UNDER_REVIEW', async () => {
    // Empty fixture — only APPROVED + DRAFT. Both ends of the sum
    // contribute 0; the tile reads 0 and the drill panel shows "No
    // items in this bucket." No false-positive queue.
    const prisma = makePrisma();
    prisma.dPR.count = jest.fn(async () => 0);
    const app = buildApp(prisma);
    const res = await request(app)
      .get(`/api/projects/${T_NAGAR_ID}/kpis?days=30`)
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    expect(res.body.dpr.pendingReviewCount).toBe(0);
  });

  it('excludes DPRs dated outside the window from the counts', async () => {
    // The fixture carries a 4th SUBMITTED row dated 45 days back. It must
    // not be counted — otherwise the KPI tile drifts from the drill
    // panel's date-scoped query (the DR-028 window contract).
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .get(`/api/projects/${T_NAGAR_ID}/kpis?days=30`)
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    expect(res.body.dpr.submittedCount).toBe(3);
    expect(res.body.dpr.pendingReviewCount).toBe(5);
  });

  it('keeps the fixture inside the window the endpoint reports', async () => {
    // Guards the rot this file actually hit: the window is computed from
    // the wall clock, so a fixture dated outside it counts as zero and
    // the suite fails on an unrelated day. Assert the fixture's own day
    // sits inside the window the endpoint returns.
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .get(`/api/projects/${T_NAGAR_ID}/kpis?days=30`)
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    const from = new Date(`${res.body.window.from}T00:00:00.000Z`).getTime();
    const to = new Date(`${res.body.window.to}T00:00:00.000Z`).getTime();
    const inWindow = dprRows[0].reportDate.getTime();
    const outOfWindow = dprRows[dprRows.length - 1].reportDate.getTime();
    expect(inWindow).toBeGreaterThanOrEqual(from);
    expect(inWindow).toBeLessThan(to);
    expect(outOfWindow).toBeLessThan(from);
  });
});
