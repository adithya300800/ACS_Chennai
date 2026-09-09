/**
 * DR-032 (round-35.5): Discovered list is tightened to TRUE orphans only.
 *
 * Background: the discovered list (the "Discovered" section in
 * /portal/admin/projects) was previously computed as `SELECT DISTINCT
 * projectName FROM dPR` with NO projectId filter. A stale non-orphan row
 * (projectId=<other-target>, projectName=<source>) kept the source name
 * alive in Discovered even after a merge cleared every orphan row with
 * that name — admins saw a "ghost" discovered entry that no merge could
 * remove. The merge endpoint (projects.merge-orphan-source) and the
 * discovered list now share the same `projectId: null` lock so a
 * successful merge genuinely removes the source from Discovered.
 *
 * Coverage matrix:
 *   1. scope=all: a name that lives ONLY on non-orphan rows is excluded.
 *   2. scope=all: a name that lives on orphan rows IS included.
 *   3. After a merge clears all orphan rows with the source name, the
 *      source disappears from Discovered (regression guard for the bug).
 *   4. Non-orphan + orphan variants of the same name → only orphan matters.
 *      (Case-sensitivity in the merge uses `mode: 'insensitive'`, but
 *      PostgreSQL `DISTINCT` is case-sensitive, so "T-NAGAR" and "T-Nagar"
 *      are two distinct names from the list query's perspective.)
 *   5. scope=mine still scopes by submittedById AND now projectId:null.
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
const OTHER_USER = 'user-2';
const TARGET_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function adminJwt() {
  return `Bearer ${jwt.sign(
    { employeeId: ADMIN_ID, email: 'admin@example.com', isAdmin: true },
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

function makePrisma({ projectRows = [], dprs = [], inspections = [] } = {}) {
  // Hold the live arrays on the prisma object so test code can mutate
  // them in place to simulate a merge. Mocks read from `this.<name>`
  // rather than capturing the array in a closure — that way reassigning
  // `prisma.dprs = [...]` between requests actually changes the data
  // the next request sees (this is what test 4 needs to model the
  // post-merge state).
  const prisma = {
    projectRows,
    dprs,
    inspections,
    project: {
      findMany: jest.fn(async function ({ where } = {}) {
        const rows = prisma.projectRows;
        if (where && Object.keys(where).length === 0) return rows;
        return rows.filter((p) => {
          if (where.isActive !== undefined && p.isActive !== where.isActive) return false;
          if (where.id && where.id.in && !where.id.in.includes(p.id)) return false;
          return true;
        });
      }),
      findFirst: jest.fn(async () => null),
    },
    dPR: {
      // Auto-discovery: scope=all → where { projectId: null }.
      findMany: jest.fn(async function ({ where, distinct, select } = {}) {
        let rows = prisma.dprs;
        if (where) {
          if ('projectId' in where && where.projectId === null) {
            rows = rows.filter((r) => r.projectId === null);
          } else if ('projectId' in where && where.projectId && typeof where.projectId === 'object' && 'not' in where.projectId) {
            rows = rows.filter((r) => r.projectId !== where.projectId.not);
          }
          if (where.submittedById) {
            rows = rows.filter((r) => r.submittedById === where.submittedById);
          }
        }
        if (distinct && distinct.includes('projectName') && select && select.projectName) {
          const names = Array.from(new Set(rows.map((r) => r.projectName))).sort();
          return names.map((projectName) => ({ projectName }));
        }
        return rows;
      }),
    },
    inspectionRecord: {
      findMany: jest.fn(async function ({ where, distinct, select } = {}) {
        let rows = prisma.inspections;
        if (where) {
          if ('projectId' in where && where.projectId === null) {
            rows = rows.filter((r) => r.projectId === null);
          }
          if (where.submittedById) {
            rows = rows.filter((r) => r.submittedById === where.submittedById);
          }
        }
        if (distinct && distinct.includes('projectName') && select && select.projectName) {
          const names = Array.from(new Set(rows.map((r) => r.projectName))).sort();
          return names.map((projectName) => ({ projectName }));
        }
        return rows;
      }),
    },
    // The list endpoint reads these for the assignments / VO / Drawing
    // union. They must return [] so the test focuses on the discovered
    // list behaviour.
    projectAssignment: { findMany: jest.fn(async () => []) },
    boqItem: { findMany: jest.fn(async () => []) },
    variationOrder: { findMany: jest.fn(async () => []) },
    drawing: { findMany: jest.fn(async () => []) },
    // requireFreshAdmin never runs for GET (requireAuth only), but we
    // include this for safety in case the route adds a stricter check.
    employee: {
      findUnique: jest.fn(async ({ where } = {}) => {
        if (where.id === ADMIN_ID) return { id: ADMIN_ID, isAdmin: true };
        return { id: where.id, isAdmin: false };
      }),
    },
  };
  return prisma;
}

function buildApp(prisma) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.use('/api/projects', projectRouter);
  return app;
}

// Helper: build the standard fixture for a discovered-list test.
//   - TARGET_UUID is the curated project ("Alpha Towers").
//   - "T-NAGAR" orphan: 1 DPR + 1 Inspection (projectId=null) — eligible for merge.
//   - "GHOST" stale: 1 DPR + 1 Inspection (projectId=TARGET_UUID) but
//     projectName still "GHOST". This is the data-quality case the
//     tightened query is meant to fix.
function defaultFixture() {
  return {
    projectRows: [
      { id: TARGET_UUID, name: 'Alpha Towers', code: 'AT', isActive: true, createdById: ADMIN_ID, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') },
    ],
    dprs: [
      { id: 'd1', projectId: null, projectName: 'T-NAGAR', submittedById: USER_ID },
      { id: 'd2', projectId: TARGET_UUID, projectName: 'GHOST', submittedById: USER_ID },
    ],
    inspections: [
      { id: 'i1', projectId: null, projectName: 'T-NAGAR', submittedById: USER_ID },
      { id: 'i2', projectId: TARGET_UUID, projectName: 'GHOST', submittedById: USER_ID },
    ],
  };
}

// ─── 1. Non-orphan rows do NOT keep a name alive in Discovered ──────────────
describe('GET /api/projects — discovered list tightened to projectId:null', () => {
  it('1. a name that exists ONLY on non-orphan rows is excluded from Discovered', async () => {
    const prisma = makePrisma(defaultFixture());
    const app = buildApp(prisma);
    const res = await request(app)
      .get('/api/projects?scope=all')
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    const names = res.body.discovered.map((d) => d.name);
    // "GHOST" lives only on rows already pointing at TARGET_UUID — the
    // tightened query filters those out.
    expect(names).not.toContain('GHOST');
    // "T-NAGAR" lives on a true orphan row — must still appear.
    expect(names).toContain('T-NAGAR');
  });

  it('2. Discovered is built from BOTH DPR and Inspection orphan rows (union)', async () => {
    const prisma = makePrisma(defaultFixture());
    const app = buildApp(prisma);
    const res = await request(app)
      .get('/api/projects?scope=all')
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    // Both DPR and Inspection queries were called with projectId: null.
    expect(prisma.dPR.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ projectId: null }) })
    );
    expect(prisma.inspectionRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ projectId: null }) })
    );
  });

  it('3. distinct projectName queries are scoped to projectId:null for scope=all', async () => {
    const prisma = makePrisma(defaultFixture());
    const app = buildApp(prisma);
    await request(app)
      .get('/api/projects?scope=all')
      .set('Authorization', adminJwt());
    // Find the auto-discovery call (the one with distinct: ['projectName']).
    const dprCall = prisma.dPR.findMany.mock.calls.find(
      (c) => c[0] && c[0].distinct && c[0].distinct.includes('projectName')
    );
    expect(dprCall).toBeDefined();
    expect(dprCall[0].where.projectId).toBe(null);
    const inspCall = prisma.inspectionRecord.findMany.mock.calls.find(
      (c) => c[0] && c[0].distinct && c[0].distinct.includes('projectName')
    );
    expect(inspCall).toBeDefined();
    expect(inspCall[0].where.projectId).toBe(null);
  });

  it('4. after a merge clears all orphan rows with the source name, Discovered drops it (regression)', async () => {
    // First call: source "T-NAGAR" is in Discovered (orphan DPR + Inspection).
    const prisma = makePrisma(defaultFixture());
    const app = buildApp(prisma);
    const before = await request(app)
      .get('/api/projects?scope=all')
      .set('Authorization', adminJwt());
    expect(before.body.discovered.map((d) => d.name)).toContain('T-NAGAR');

    // Simulate the merge: rewrite all orphan rows with projectName="T-NAGAR"
    // to projectId=TARGET_UUID, projectName="Alpha Towers". This is exactly
    // what merge-orphan-source's updateMany does in production.
    prisma.dprs = [
      { id: 'd1', projectId: TARGET_UUID, projectName: 'Alpha Towers', submittedById: USER_ID },
      { id: 'd2', projectId: TARGET_UUID, projectName: 'GHOST', submittedById: USER_ID },
    ];
    prisma.inspections = [
      { id: 'i1', projectId: TARGET_UUID, projectName: 'Alpha Towers', submittedById: USER_ID },
      { id: 'i2', projectId: TARGET_UUID, projectName: 'GHOST', submittedById: USER_ID },
    ];

    // Second call: T-NAGAR should NOT appear because no row has it
    // anywhere now (orphan rows rewritten, non-orphan rows never had it).
    const after = await request(app)
      .get('/api/projects?scope=all')
      .set('Authorization', adminJwt());
    expect(after.status).toBe(200);
    expect(after.body.discovered.map((d) => d.name)).not.toContain('T-NAGAR');
    // GHOST is still on a non-orphan row but the tightened query drops it.
    expect(after.body.discovered.map((d) => d.name)).not.toContain('GHOST');
  });
});

// ─── 2. Scope=mine / scope=assigned also tightens ───────────────────────────
describe('GET /api/projects — scope=mine also locks projectId:null', () => {
  it('5. scope=mine distinct query carries both submittedById AND projectId:null', async () => {
    const prisma = makePrisma(defaultFixture());
    const app = buildApp(prisma);
    await request(app)
      .get('/api/projects?scope=mine')
      .set('Authorization', userJwt());
    const dprCall = prisma.dPR.findMany.mock.calls.find(
      (c) => c[0] && c[0].distinct && c[0].distinct.includes('projectName')
    );
    expect(dprCall).toBeDefined();
    expect(dprCall[0].where).toEqual(
      expect.objectContaining({ projectId: null, submittedById: USER_ID })
    );
  });

  it('6. a name on a row belonging to another user does not surface in scope=mine', async () => {
    const fixture = defaultFixture();
    // Add an orphan row for OTHER_USER — should not surface to USER_ID.
    fixture.dprs.push({ id: 'd3', projectId: null, projectName: 'OTHER-USER-ORPHAN', submittedById: OTHER_USER });
    const prisma = makePrisma(fixture);
    const app = buildApp(prisma);
    const res = await request(app)
      .get('/api/projects?scope=mine')
      .set('Authorization', userJwt());
    const names = res.body.discovered.map((d) => d.name);
    expect(names).not.toContain('OTHER-USER-ORPHAN');
  });
});
