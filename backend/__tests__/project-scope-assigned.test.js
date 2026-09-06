/**
 * Round-30 — `?scope=assigned` for GET /api/projects.
 *
 * Coverage matrix:
 *   1. ?scope=assigned returns ONLY curated projects the employee has
 *      personally touched via DPR.submittedById, InspectionRecord.submittedById,
 *      BoqItem.createdById, VariationOrder.raisedById, or Drawing.issuedById
 *      — NOT the full org-wide curated list.
 *   2. ?scope=assigned returns the union — an employee who filed a DPR
 *      against project A and an Inspection against project B sees both.
 *   3. ?scope=assigned discovered list is scoped the same as ?scope=mine
 *      (employee-only names from DPR + Inspection).
 *   4. ?scope=mine regression — still returns ALL curated projects (the
 *      previous behavior, used by DprSubmit / InspectionSubmit / etc.).
 *   5. [bugfix round-30] The DPR `where` clause uses `submittedById`, NOT
 *      `createdById` (which doesn't exist on the model). The earlier
 *      code silently swallowed Prisma's async validation error and
 *      returned zero DPR-discovered names for every employee.
 *   6. Invalid scope value returns 400 INVALID_SCOPE (now accepts
 *      "mine" / "all" / "assigned").
 *
 * Pattern mirrors project-kpi.test.js — mounted route with a stubbed
 * Prisma. We avoid a live Postgres by mocking every prisma method the
 * new scope branch touches.
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

// Curated projects. Two are touched by the user via child records, one
// is touched only via `createdById` (the employee created it via the
// typeahead/resolveProject flow but hasn't filed any child records
// yet), one is fully untouched.
const TOUCHED_A = '11111111-1111-4111-8111-aaaaaaaaaaaa';
const TOUCHED_B = '22222222-2222-4222-8222-bbbbbbbbbbbb';
const CREATED_BY_USER = '44444444-4444-4444-8444-dddddddddddd';
const UNTOUCHED = '33333333-3333-4333-8333-cccccccccccc';

const projectRows = [
  {
    id: TOUCHED_A,
    name: 'Alpha Tower',
    code: 'ALPHA',
    isActive: true,
    createdById: ADMIN_ID,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  },
  {
    id: TOUCHED_B,
    name: 'Beta Mall',
    code: 'BETA',
    isActive: true,
    createdById: ADMIN_ID,
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
    updatedAt: new Date('2026-02-01T00:00:00.000Z'),
  },
  {
    // The user created this project themselves via the typeahead
    // (createdById=USER_ID) but hasn't filed any DPR/Inspection/Boq/
    // Variation/Drawing records against it yet. Must still appear in
    // the assigned list — otherwise the picker would lose projects the
    // employee just created.
    id: CREATED_BY_USER,
    name: 'Delta Self-Created',
    code: 'DELTA',
    isActive: true,
    createdById: USER_ID,
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    updatedAt: new Date('2026-04-01T00:00:00.000Z'),
  },
  {
    id: UNTOUCHED,
    name: 'Gamma HQ',
    code: 'GAMMA',
    isActive: true,
    createdById: ADMIN_ID,
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
    updatedAt: new Date('2026-03-01T00:00:00.000Z'),
  },
];

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

function makePrisma() {
  return {
    project: {
      findMany: jest.fn(async ({ where } = {}) => {
        let rows = projectRows;
        if (where && where.isActive === true) {
          rows = rows.filter((p) => p.isActive);
        }
        return rows;
      }),
    },
    // DPR auto-discovery — the route now filters on `submittedById` (the
    // real column), NOT `createdById`. The mock returns only the user's
    // own rows when the where clause has submittedById; an unknown
    // column (e.g. createdById) would have returned empty via Prisma's
    // async rejection — which is the bug we're guarding against.
    dPR: {
      findMany: jest.fn(async ({ where } = {}) => {
        let rows = [
          // USER filed a DPR against Alpha Tower.
          { projectName: 'Alpha Tower', projectId: TOUCHED_A, submittedById: USER_ID, createdById: USER_ID },
          // A name the user filed, but with no Project row (discovered).
          { projectName: 'Discovered X', projectId: null, submittedById: USER_ID, createdById: USER_ID },
        ];
        if (where && where.submittedById) {
          rows = rows.filter((r) => r.submittedById === where.submittedById);
        }
        if (where && where.createdById) {
          // Simulates the old code path that would have silently returned
          // empty because `createdById` is not a real DPR column. The
          // route no longer uses this column.
          rows = [];
        }
        if (where && where.projectId && where.projectId.not === null) {
          rows = rows.filter((r) => r.projectId != null);
        }
        if (where && where.distinct) {
          // Distinct is fine — return rows; caller doesn't dedupe in test.
        }
        // Return shape the route actually uses: { projectName }
        return rows.map((r) => ({ projectName: r.projectName, projectId: r.projectId }));
      }),
    },
    inspectionRecord: {
      findMany: jest.fn(async ({ where } = {}) => {
        let rows = [
          // USER filed an Inspection against Beta Mall.
          { projectName: 'Beta Mall', projectId: TOUCHED_B, submittedById: USER_ID },
        ];
        if (where && where.submittedById) {
          rows = rows.filter((r) => r.submittedById === where.submittedById);
        }
        if (where && where.projectId && where.projectId.not === null) {
          rows = rows.filter((r) => r.projectId != null);
        }
        return rows.map((r) => ({ projectName: r.projectName, projectId: r.projectId }));
      }),
    },
    boqItem: {
      findMany: jest.fn(async ({ where } = {}) => {
        // USER created a BoqItem against Beta Mall.
        const rows = [
          { projectId: TOUCHED_B, createdById: USER_ID },
        ];
        if (where && where.createdById) {
          return rows.filter((r) => r.createdById === where.createdById);
        }
        return rows;
      }),
    },
    variationOrder: {
      findMany: jest.fn(async ({ where } = {}) => {
        // No VOs from USER — used to prove an empty result for one of the
        // five child queries doesn't break the union.
        return [];
      }),
    },
    drawing: {
      findMany: jest.fn(async ({ where } = {}) => {
        // No drawings from USER.
        return [];
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

// ─── 1. ?scope=assigned narrows curated list ────────────────────────────────
describe('Round-30 — GET /api/projects?scope=assigned', () => {
  it('1. ?scope=assigned returns ONLY curated projects the employee touched (not all)', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .get('/api/projects?scope=assigned')
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('assigned');
    const names = res.body.projects.map((p) => p.name).sort();
    // USER filed against Alpha (DPR) and Beta (Inspection + Boq) via
    // child records, AND created Delta via the typeahead. Gamma was
    // never touched and was created by the admin → must NOT appear.
    expect(names).toEqual(['Alpha Tower', 'Beta Mall', 'Delta Self-Created']);
    expect(names).not.toContain('Gamma HQ');
  });

  it('2. ?scope=assigned unions touched projects across all 5 child queries', async () => {
    // Assert each child query was called with the right scope.
    const prisma = makePrisma();
    const app = buildApp(prisma);
    await request(app)
      .get('/api/projects?scope=assigned')
      .set('Authorization', userJwt());
    // DPR + Inspection + BoqItem are touched; VO + Drawing are empty
    // but still queried.
    expect(prisma.dPR.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ submittedById: USER_ID }),
      })
    );
    expect(prisma.inspectionRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ submittedById: USER_ID }),
      })
    );
    expect(prisma.boqItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ createdById: USER_ID }),
      })
    );
    expect(prisma.variationOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ raisedById: USER_ID }),
      })
    );
    expect(prisma.drawing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ issuedById: USER_ID }),
      })
    );
  });

  it('3. ?scope=assigned discovered list is scoped to the employee (same as mine)', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .get('/api/projects?scope=assigned')
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    // "Discovered X" exists as the user's DPR.projectName but has no
    // Project row → surfaces in `discovered`.
    const discoveredNames = res.body.discovered.map((d) => d.name);
    expect(discoveredNames).toContain('Discovered X');
    // "Alpha Tower" and "Beta Mall" are already curated → should NOT
    // appear as discovered (the route subtracts curated names).
    expect(discoveredNames).not.toContain('Alpha Tower');
    expect(discoveredNames).not.toContain('Beta Mall');
  });
});

// ─── 2. ?scope=mine regression guard ────────────────────────────────────────
describe('Round-30 — GET /api/projects?scope=mine (regression)', () => {
  it('4. ?scope=mine still returns ALL curated projects (backward compat)', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .get('/api/projects?scope=mine')
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('mine');
    // ALL curated active projects, regardless of employee touching them.
    const names = res.body.projects.map((p) => p.name).sort();
    expect(names).toEqual(['Alpha Tower', 'Beta Mall', 'Delta Self-Created', 'Gamma HQ']);
  });
});

// ─── 3. Bugfix guard: DPR uses submittedById, NOT createdById ───────────────
describe('Round-30 — DPR scope uses submittedById (bugfix)', () => {
  it('5. DPR scope=mine filters on submittedById (the real column, not createdById)', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    await request(app)
      .get('/api/projects?scope=mine')
      .set('Authorization', userJwt());
    // The DPR findMany call must filter by submittedById. If the
    // route ever regresses to `createdById`, the mock's `createdById`
    // branch returns [] — and the discovered list loses the user's
    // own names. Pin the contract here.
    expect(prisma.dPR.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ submittedById: USER_ID }),
      })
    );
    // And must NOT filter on the non-existent createdById column.
    const calls = prisma.dPR.findMany.mock.calls;
    const allWhereKeys = calls.flatMap((c) => Object.keys((c[0] || {}).where || {}));
    expect(allWhereKeys).not.toContain('createdById');
  });
});

// ─── 4. Scope validation accepts the new value ─────────────────────────────
describe('Round-30 — scope validator', () => {
  it('6a. ?scope=assigned is accepted (no longer INVALID_SCOPE)', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .get('/api/projects?scope=assigned')
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('assigned');
  });

  it('6b. invalid scope still returns 400 INVALID_SCOPE', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .get('/api/projects?scope=banana')
      .set('Authorization', userJwt());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SCOPE');
  });

  it('6c. admin ?scope=assigned works (no admin gate on assigned)', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .get('/api/projects?scope=assigned')
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    // Admin hasn't filed any child records but DID create Alpha/Beta/
    // Gamma (createdById=ADMIN_ID) → those surface via the createdById
    // branch. Delta (createdById=USER_ID) does NOT appear — proves the
    // scoping still pins to the requesting employee's id.
    const names = res.body.projects.map((p) => p.name).sort();
    expect(names).toEqual(['Alpha Tower', 'Beta Mall', 'Gamma HQ']);
    expect(names).not.toContain('Delta Self-Created');
  });
});
