/**
 * N17 (round-29) — Project-level dashboard with KPI tiles.
 *
 * Coverage matrix:
 *   1. Auth: 401 on GET /api/projects (no token)
 *   2. POST /api/projects succeeds for admin
 *   3. POST /api/projects returns 403 for non-admin (requireFreshAdmin
 *      gate — DB re-read confirms isAdmin=true before allowing the write)
 *   4. GET /api/projects includes both curated rows AND names auto-
 *      discovered from DPR.projectName (the backward-compat behaviour)
 *   5. GET /api/projects/:idOrName/kpis returns DPR counts grouped by
 *      projectName (5 statuses, plus a "pendingReview" derived count)
 *   6. KPIs include Inspection counts grouped by projectName, with the
 *      OPEN-now tile sourced org-wide and the byType breakdown across
 *      the window
 *   7. KPIs tolerate a missing BoqItem model — when `prisma.boqItem`
 *      throws, the response carries zeros for boqVariance + a warning
 *      string, but the other roll-ups still render.
 *      (Round-29: the CubeTest roll-up was removed — the standalone
 *      cube_test feature is gone; cube testing is captured by the
 *      cube_casting / cube_testing InspectionRecord sub-types.)
 *   8. The `days` query parameter correctly bounds the window (default
 *      30, capped at 365)
 *   9. DELETE /api/projects/:id soft-deletes (isActive=false) for admin;
 *      second delete is idempotent (returns the row, not a 409)
 *
 * Pattern mirrors __tests__/inspection-fresh-admin.test.js — mounted
 * route with a stubbed Prisma. We avoid a live Postgres by mocking every
 * prisma method the route touches.
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const projectRouter = require('../src/routes/projects');

const ADMIN_ID = 'admin-1';
const USER_ID = 'user-1';

function adminJwt(employeeId = ADMIN_ID) {
  return `Bearer ${jwt.sign(
    { employeeId, email: 'admin@example.com', isAdmin: true },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  )}`;
}

function userJwt(employeeId = USER_ID) {
  return `Bearer ${jwt.sign(
    { employeeId, email: 'user@example.com', isAdmin: false },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  )}`;
}

// ─── Fixtures ───────────────────────────────────────────────────────────────
//
// Project row registered (id matches UUID regex so resolveProject hits
// the PK branch first). Two DPR rows with projectName="T-Nagar" (one
// matching the registered project, one extra for inspection groupBy).
const T_NAGAR_ID = '11111111-1111-4111-8111-111111111111';

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

const dprRows = [
  { id: 'dpr-1', projectName: 'T-Nagar', reportDate: new Date('2026-08-15T00:00:00.000Z'), status: 'DRAFT' },
  { id: 'dpr-2', projectName: 'T-Nagar', reportDate: new Date('2026-08-16T00:00:00.000Z'), status: 'SUBMITTED' },
  { id: 'dpr-3', projectName: 'T-Nagar', reportDate: new Date('2026-08-17T00:00:00.000Z'), status: 'UNDER_REVIEW' },
  { id: 'dpr-4', projectName: 'T-Nagar', reportDate: new Date('2026-08-18T00:00:00.000Z'), status: 'APPROVED' },
  { id: 'dpr-5', projectName: 'T-Nagar', reportDate: new Date('2026-08-19T00:00:00.000Z'), status: 'REJECTED' },
  { id: 'dpr-6', projectName: 'T-Nagar', reportDate: new Date('2026-08-20T00:00:00.000Z'), status: 'APPROVED' },
  // Out-of-window rows (>30 days back) — should NOT be counted by the
  // default window. Pre-seeded so we can prove the window predicate works.
  { id: 'dpr-old', projectName: 'T-Nagar', reportDate: new Date('2025-01-01T00:00:00.000Z'), status: 'APPROVED' },
  // Different project — proves the projectName filter excludes noise.
  { id: 'dpr-other', projectName: 'Anna Nagar', reportDate: new Date('2026-08-20T00:00:00.000Z'), status: 'APPROVED' },
];

const inspectionRows = [
  { id: 'insp-1', projectName: 'T-Nagar', inspectionType: 'cube_casting', status: 'OPEN', reportDate: new Date('2026-08-15T00:00:00.000Z') },
  { id: 'insp-2', projectName: 'T-Nagar', inspectionType: 'cube_casting', status: 'OPEN', reportDate: new Date('2026-08-20T00:00:00.000Z') },
  { id: 'insp-3', projectName: 'T-Nagar', inspectionType: 'material_inspection', status: 'CLOSED', reportDate: new Date('2026-08-16T00:00:00.000Z') },
  { id: 'insp-4', projectName: 'T-Nagar', inspectionType: 'ncr', status: 'OPEN', reportDate: new Date('2026-08-22T00:00:00.000Z') },
  { id: 'insp-other', projectName: 'Anna Nagar', inspectionType: 'cube_casting', status: 'OPEN', reportDate: new Date('2026-08-15T00:00:00.000Z') },
];

// ─── Prisma mock builder ────────────────────────────────────────────────────
// The defaults exercise every roll-up path. Per-test overrides flip a
// flag to simulate BoqItem throwing.
function makePrisma(opts = {}) {
  const { boqItemThrows = false } = opts;

  // Per-mock store for rows created during this test. The module-level
  // `projectRows` is read-only seed data shared across the file —
  // writing back into it pollutes subsequent GET /api/projects tests.
  // (Added in round-34 when POST/PATCH started wrapping writes in a
  // transaction + post-mutation re-fetch.)
  const createdRows = [];

  // Helper: filter DPR / Inspection rows by projectName + window predicate
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

  const prisma = {
    // $transaction: pass `prisma` itself as the tx callback's argument so
    // the route's `tx.<model>` calls resolve to the same mock functions.
    // The existing tests don't exercise rollback semantics — they just
    // need the callback to fire — so this shortcut is fine. (Added in
    // round-34 when POST/PATCH started wrapping writes in transactions
    // for the project_assignments feature.) The two-step const-then-
    // assign avoids the TDZ on `prisma` inside the arrow body.
    $transaction: null,
    project: {
      findMany: jest.fn(async () => projectRows.filter((p) => p.isActive).concat(createdRows.filter((p) => p.isActive))),
      findUnique: jest.fn(async ({ where }) => {
        if (where.id) {
          return projectRows.find((p) => p.id === where.id)
            || createdRows.find((p) => p.id === where.id)
            || null;
        }
        if (where.name) {
          return projectRows.find((p) => p.name === where.name)
            || createdRows.find((p) => p.name === where.name)
            || null;
        }
        return null;
      }),
      findFirst: jest.fn(async ({ where }) => {
        if (!where || !where.name) return null;
        const target = String(where.name.equals || '').toLowerCase();
        return projectRows.find((p) => p.name.toLowerCase() === target)
          || createdRows.find((p) => p.name.toLowerCase() === target)
          || null;
      }),
      create: jest.fn(async ({ data }) => {
        // [round-34] The new POST handler wraps the create in a
        // transaction + post-mutation re-fetch (`tx.project.findUnique`
        // with `include: { assignments: ... }`). The findUnique mock
        // looks up rows in `projectRows` + a per-mock `createdRows`
        // list, so the re-fetch finds the just-created row without
        // polluting the shared module-level `projectRows` array (which
        // would otherwise bleed into subsequent GET /api/projects tests).
        const row = {
          id: `proj-new-${createdRows.length + 1}`,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        createdRows.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }) => {
        const inSeed = projectRows.find((p) => p.id === where.id);
        const existing = inSeed || createdRows.find((p) => p.id === where.id);
        if (!existing) {
          const err = new Error('Not found');
          err.code = 'P2025';
          throw err;
        }
        Object.assign(existing, data, { updatedAt: new Date() });
        return existing;
      }),
    },
    dPR: {
      findMany: jest.fn(async ({ where } = {}) => {
        // [round-30 bugfix] The route filters on `submittedById` (the
        // real column on the DPR model), NOT `createdById` — earlier
        // code used `createdById`, which doesn't exist on DPR, and
        // Prisma's async validation error was swallowed by the inline
        // `.catch(() => [])`, silently returning zero DPR-discovered
        // names for every employee.
        let rows = [
          { projectName: 'T-Nagar', submittedById: USER_ID },
          { projectName: 'Anna Nagar', submittedById: USER_ID },
          { projectName: 'RESOLVE-TEST', submittedById: 'admin-other' },
        ];
        if (where && where.submittedById) {
          rows = rows.filter((r) => r.submittedById === where.submittedById);
        }
        return rows.map((r) => ({ projectName: r.projectName }));
      }),
      count: jest.fn(async ({ where }) => filterRows(dprRows, where).length),
    },
    inspectionRecord: {
      // Same scoping pattern as DPR — findMany uses submittedById.
      findMany: jest.fn(async ({ where } = {}) => {
        let rows = [
          { projectName: 'Anna Nagar', submittedById: USER_ID },
          { projectName: 'R17 Bulk Test', submittedById: 'admin-other' },
        ];
        if (where && where.submittedById) {
          rows = rows.filter((r) => r.submittedById === where.submittedById);
        }
        return rows.map((r) => ({ projectName: r.projectName }));
      }),
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
    cubeTest: undefined, // Round-29: removed — see project-kpi.test.js header comment
    boqItem: boqItemThrows ? {
      findMany: jest.fn(async () => { throw new Error('relation boq_item does not exist'); }),
    } : {
      findMany: jest.fn(async ({ where }) => {
        let rows = [
          { projectName: 'T-Nagar', quantity: 10, rate: 100, amount: 800, isActive: true },
          { projectName: 'T-Nagar', quantity: 5, rate: 200, amount: 1100, isActive: true },
          { projectName: 'Anna Nagar', quantity: 1, rate: 999, amount: 999, isActive: true },
        ];
        if (where.projectName) rows = rows.filter((r) => r.projectName === where.projectName);
        if (where.isActive !== undefined) rows = rows.filter((r) => r.isActive === where.isActive);
        return rows;
      }),
    },
    leaveRequest: {
      count: jest.fn(async () => ({ onLeave: 1, pending: 2, overdueTraining: 3 }[Symbol.for('case')] ?? 0)),
    },
    trainingEnrollment: {
      count: jest.fn(async () => 3),
    },
    employee: {
      findUnique: jest.fn(async ({ where }) => {
        if (where.id === ADMIN_ID) return { id: ADMIN_ID, isAdmin: true };
        if (where.id === USER_ID) return { id: USER_ID, isAdmin: false };
        return null;
      }),
    },
  };
  // Hook $transaction now that `prisma` is in scope — the closure can't
  // see `prisma` during the literal above (TDZ).
  prisma.$transaction = jest.fn(async (cb) => cb(prisma));
  return prisma;
}

function buildApp(prisma) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.use('/api/projects', projectRouter);
  return app;
}

// ─── 1. Auth gate ───────────────────────────────────────────────────────────
describe('N17 — auth gate', () => {
  it('1. rejects anonymous GET /api/projects with 401', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app).get('/api/projects');
    expect(res.status).toBe(401);
  });

  it('1b. rejects anonymous POST /api/projects with 401', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/projects')
      .send({ name: 'X' });
    expect(res.status).toBe(401);
  });
});

// ─── 2. Create project (admin success) ───────────────────────────────────────
describe('N17 — POST /api/projects', () => {
  it('2. admin can create a project (201, returned row has id+isActive)', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', adminJwt())
      .send({ name: 'Velachery Tower', code: 'VEL-01', client: 'ACS', location: 'Chennai' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Velachery Tower',
      code: 'VEL-01',
      client: 'ACS',
      isActive: true,
    });
    expect(prisma.employee.findUnique).toHaveBeenCalled();
    expect(prisma.project.create).toHaveBeenCalled();
  });

  it('2b. admin create with missing name returns 400', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', adminJwt())
      .send({ code: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  // 3. Non-admin: 403
  it('3. non-admin cannot create a project (403 ADMIN_REQUIRED)', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', userJwt())
      .send({ name: 'Should Fail' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_REQUIRED');
  });
});

// ─── 4. List projects includes auto-discovered names ─────────────────────────
describe('N17 — GET /api/projects', () => {
  it('4. returns curated rows + names auto-discovered from DPR.projectName', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app).get('/api/projects').set('Authorization', userJwt());
    expect(res.status).toBe(200);
    // Curated: T-Nagar registered
    expect(res.body.projects.map((p) => p.name)).toEqual(['T-Nagar']);
    // Default scope for non-admin is "mine" — only names the user filed
    // themselves appear in the discovered list.
    expect(res.body.scope).toBe('mine');
    const discoveredNames = res.body.discovered.map((d) => d.name);
    expect(discoveredNames).toEqual(['Anna Nagar']);
  });

  // Round-28 Bug 1+5 contract: admin can request ?scope=all to see
  // org-wide auto-discovered names (not just their own). Employee
  // requesting ?scope=all gets 403 ADMIN_REQUIRED.
  it('4a. admin ?scope=all returns org-wide discovered names', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .get('/api/projects?scope=all')
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('all');
    const discoveredNames = res.body.discovered.map((d) => d.name).sort();
    // Both the user's own and other people's project names should appear
    // because scope=all skips the createdById/submittedById filter.
    expect(discoveredNames).toEqual(['Anna Nagar', 'R17 Bulk Test', 'RESOLVE-TEST']);
  });

  it('4b. non-admin ?scope=all returns 403 ADMIN_REQUIRED', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .get('/api/projects?scope=all')
      .set('Authorization', userJwt());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_REQUIRED');
  });

  it('4c. invalid ?scope= value returns 400 INVALID_SCOPE', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .get('/api/projects?scope=banana')
      .set('Authorization', userJwt());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SCOPE');
  });
});

// ─── 5. KPI: DPR counts grouped by projectName ──────────────────────────────
describe('N17 — GET /api/projects/:idOrName/kpis', () => {
  it('5. KPI endpoint returns DPR counts grouped by projectName (and a derived pendingReview)', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    // Use the registered UUID so resolveProject hits the PK branch.
    const res = await request(app)
      .get(`/api/projects/${T_NAGAR_ID}/kpis`)
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    // 6 DPR rows within window for T-Nagar:
    //   DRAFT=1, SUBMITTED=1, UNDER_REVIEW=1, APPROVED=2, REJECTED=1
    // pendingReview = SUBMITTED + UNDER_REVIEW = 2
    expect(res.body.dpr).toEqual({
      submittedCount: 1,
      pendingReviewCount: 2,
      approvedCount: 2,
      rejectedCount: 1,
      draftCount: 1,
    });
  });

  // 6. KPI: Inspection counts + byType breakdown
  it('6. KPI endpoint returns Inspection counts + byType grouped by projectName', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .get(`/api/projects/${T_NAGAR_ID}/kpis`)
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    // 4 inspection rows for T-Nagar; 3 are OPEN org-wide; the Anna Nagar
    // row is filtered out by the projectName predicate.
    expect(res.body.inspections.totalCount).toBe(4);
    expect(res.body.inspections.openCount).toBe(3);
    expect(res.body.inspections.byType).toEqual({
      cube_casting: 2,
      material_inspection: 1,
      ncr: 1,
    });
  });

  // 7. KPI: tolerates BoqItem throwing — returns zeros + warnings
  // (Round-29: removed the CubeTest roll-up; the cube-test feature
  // is gone and the response no longer carries cubeTests.)
  it('7. KPI endpoint returns zeros + warning when BoqItem table is missing', async () => {
    const prisma = makePrisma({ boqItemThrows: true });
    const app = buildApp(prisma);
    const res = await request(app)
      .get(`/api/projects/${T_NAGAR_ID}/kpis`)
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    expect(res.body.boqVariance).toEqual({
      itemsCount: 0,
      totalContractValue: 0,
      totalExecutedValue: 0,
      variancePercent: 0,
    });
    expect(res.body.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/^boqVariance:/)])
    );
  });

  // 8. KPI: window derived from `days` query param
  it('8. KPI endpoint honours the days query param (default 30, clamped to [1,365])', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);

    // Default — should be 30 days
    const r1 = await request(app)
      .get(`/api/projects/${T_NAGAR_ID}/kpis`)
      .set('Authorization', userJwt());
    expect(r1.body.window.days).toBe(30);

    // Custom 7 days
    const r2 = await request(app)
      .get(`/api/projects/${T_NAGAR_ID}/kpis?days=7`)
      .set('Authorization', userJwt());
    expect(r2.body.window.days).toBe(7);

    // Clamped: 9999 → 365
    const r3 = await request(app)
      .get(`/api/projects/${T_NAGAR_ID}/kpis?days=9999`)
      .set('Authorization', userJwt());
    expect(r3.body.window.days).toBe(365);

    // Clamped: 0 → 1
    const r4 = await request(app)
      .get(`/api/projects/${T_NAGAR_ID}/kpis?days=0`)
      .set('Authorization', userJwt());
    expect(r4.body.window.days).toBe(1);
  });

  // 9a. KPI: was the cubeTests roll-up — removed in Round-29
  // (cube testing is now captured by InspectionRecord cube_casting /
  // cube_testing sub-types; no standalone cubeTests field in the
  // response anymore. Test intentionally omitted.)

  // 9b. KPI: BOQ variance calculation when present
  it('9b. KPI boqVariance roll-up computes contract / executed / variance', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .get(`/api/projects/${T_NAGAR_ID}/kpis`)
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    // T-Nagar rows: quantity=10 rate=100 amount=800; quantity=5 rate=200 amount=1100
    // totalContract = 10*100 + 5*200 = 1000 + 1000 = 2000
    // totalExecuted = 800 + 1100 = 1900
    // variancePercent = (1900 - 2000) / 2000 * 100 = -5%
    expect(res.body.boqVariance).toEqual({
      itemsCount: 2,
      totalContractValue: 2000,
      totalExecutedValue: 1900,
      variancePercent: -5,
    });
  });

  // 9c. KPI: works for a discovered project (name not yet in Project table)
  it('9c. KPI endpoint works for a discovered name (no Project row)', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .get('/api/projects/Anna%20Nagar/kpis')
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    expect(res.body.project).toEqual({ name: 'Anna Nagar', isRegistered: false, isActive: true });
    // Anna Nagar has 1 approved DPR within window
    expect(res.body.dpr.approvedCount).toBe(1);
  });

  // 9d. KPI: unknown project — 404
  it('9d. KPI endpoint returns 404 for an unknown UUID or name', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .get('/api/projects/99999999-9999-4999-8999-999999999999/kpis')
      .set('Authorization', userJwt());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PROJECT_NOT_FOUND');
  });
});

// ─── 10. Soft-delete project ─────────────────────────────────────────────────
describe('N17 — DELETE /api/projects/:id', () => {
  it('10. admin can soft-delete a project (isActive=false on the returned row)', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .delete(`/api/projects/${T_NAGAR_ID}`)
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
    expect(prisma.employee.findUnique).toHaveBeenCalled();
    expect(prisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: T_NAGAR_ID },
        data: { isActive: false },
      })
    );
  });

  it('10b. non-admin cannot delete a project (403)', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .delete(`/api/projects/${T_NAGAR_ID}`)
      .set('Authorization', userJwt());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_REQUIRED');
  });

  it('10c. DELETE on a non-UUID id returns 400', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .delete('/api/projects/not-a-uuid')
      .set('Authorization', adminJwt());
    expect(res.status).toBe(400);
  });
});
