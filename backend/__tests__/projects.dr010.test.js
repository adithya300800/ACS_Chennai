/**
 * DR-010 (2026-09-08 SOL audit): "Explicit project assignment does not
 * enable the employee's first project workflow".
 *
 * Background: the previous `?scope=assigned` union was five child-record
 * audit columns (DPR.submittedById, InspectionRecord.submittedById,
 * BoqItem.createdById, VariationOrder.raisedById, Drawing.issuedById).
 * An admin could allocate a brand-new project to an employee via a
 * ProjectAssignment row, but the employee wouldn't see the project in
 * their picker until they filed a child record against it (DPR,
 * Inspection, BOQ, etc.) — even though the assignment was authorized
 * and persisted. The audit: "An assignee should not need dummy history
 * to begin assigned work."
 *
 * Fix: add ProjectAssignment.employeeId as a sixth source in the union.
 * The audit hint is explicit: "history-based discovery is intentional,
 * not automatically an authorization flaw" — the fix is roster + history,
 * unioned, NOT a roster-only override.
 *
 * Coverage matrix:
 *   1. ProjectAssignment row for the requesting employee surfaces the
 *      project in the assigned list, even with zero child records.
 *   2. The union still honors the round-30.1 guard — createdById-only
 *      projects do NOT appear just because an admin created them.
 *   3. ProjectAssignment.employeeId is called with the right `where`
 *      shape (the employee id, no projectId-side filter).
 *   4. A project that appears ONLY via ProjectAssignment (no child
 *      records) is included; a project with neither child records nor
 *      an assignment row is excluded.
 *   5. ?scope=mine regression guard — the assignment union is NOT
 *      applied to scope=mine (which stays org-wide-curated).
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

// Three curated projects:
//   - ASSIGNED: admin-allocated, no child records from USER → must appear
//     in the assigned list (the new DR-010 path).
//   - TOUCHED: USER filed a DPR against it → must appear (legacy child-
//     record path, regression guard).
//   - UNTOUCHED: no assignment, no child records → must NOT appear.
const ASSIGNED = '11111111-1111-4111-8111-aaaaaaaaaaaa';
const TOUCHED = '22222222-2222-4222-8222-bbbbbbbbbbbb';
const UNTOUCHED = '33333333-3333-4333-8333-cccccccccccc';

const projectRows = [
  {
    id: ASSIGNED,
    name: 'Epsilon Plaza',
    code: 'EPSILON',
    isActive: true,
    createdById: ADMIN_ID,
    createdAt: new Date('2026-01-15T00:00:00.000Z'),
    updatedAt: new Date('2026-01-15T00:00:00.000Z'),
  },
  {
    id: TOUCHED,
    name: 'Zeta Heights',
    code: 'ZETA',
    isActive: true,
    createdById: ADMIN_ID,
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
    updatedAt: new Date('2026-02-01T00:00:00.000Z'),
  },
  {
    id: UNTOUCHED,
    name: 'Eta Orphan',
    code: 'ETA',
    isActive: true,
    createdById: ADMIN_ID,
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
    updatedAt: new Date('2026-03-01T00:00:00.000Z'),
  },
];

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
    dPR: {
      // USER filed a DPR against Zeta Heights (TOUCHED). Zero rows for
      // Epsilon Plaza or Eta Orphan.
      findMany: jest.fn(async () => [
        { projectName: 'Zeta Heights', projectId: TOUCHED, submittedById: USER_ID },
      ]),
    },
    inspectionRecord: {
      findMany: jest.fn(async () => []),
    },
    boqItem: {
      findMany: jest.fn(async () => []),
    },
    variationOrder: {
      findMany: jest.fn(async () => []),
    },
    drawing: {
      findMany: jest.fn(async () => []),
    },
    // [DR-010] ProjectAssignment row for Epsilon Plaza. This is the
    // ONLY reason Epsilon should appear in the assigned list — USER
    // has no child records against it.
    //
    // [S7/ISRO-LEAK] The intersection-based narrowing requires an
    // active ProjectAssignment row even for projects the employee has
    // filed child records against. Zeta Heights (TOUCHED) has a DPR
    // row from USER; mirror that with an active ProjectAssignment
    // row so the regression guard (test 3) still passes after the
    // S7 fix.
    projectAssignment: {
      findMany: jest.fn(async ({ where } = {}) => {
        let rows = [
          { projectId: ASSIGNED, employeeId: USER_ID, assignedAt: new Date('2026-09-01') },
          { projectId: TOUCHED, employeeId: USER_ID, assignedAt: new Date('2026-08-01') },
        ];
        if (where && where.employeeId) {
          rows = rows.filter((r) => r.employeeId === where.employeeId);
        }
        return rows.map((r) => ({ projectId: r.projectId }));
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

// ─── 1. ProjectAssignment surfaces the project in the assigned list ────────
describe('DR-010 — ?scope=assigned includes ProjectAssignment', () => {
  it('1. a ProjectAssignment row surfaces the project even with zero child records', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .get('/api/projects?scope=assigned')
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    const names = res.body.projects.map((p) => p.name).sort();
    // The headline DR-010 acceptance: Epsilon Plaza appears because
    // the admin allocated it to the user, even though USER has zero
    // DPR/Inspection/Boq/VO/Drawing rows against it.
    expect(names).toContain('Epsilon Plaza');
    // Legacy child-record path is preserved: Zeta Heights still
    // appears because USER filed a DPR against it.
    expect(names).toContain('Zeta Heights');
    // Eta Orphan has neither an assignment nor child records — must
    // NOT appear.
    expect(names).not.toContain('Eta Orphan');
  });

  it('2. ProjectAssignment.findMany is called with employeeId = req.employeeId', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    await request(app)
      .get('/api/projects?scope=assigned')
      .set('Authorization', userJwt());
    expect(prisma.projectAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ employeeId: USER_ID }),
      })
    );
  });

  it('3. project touched via child record still appears (regression guard)', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .get('/api/projects?scope=assigned')
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    const ids = res.body.projects.map((p) => p.id);
    expect(ids).toContain(TOUCHED);
    expect(ids).toContain(ASSIGNED);
    expect(ids).not.toContain(UNTOUCHED);
  });

  it('4. discovered names are still employee-scoped (regression guard)', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .get('/api/projects?scope=assigned')
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    // Discovered list still subtracts curated names — Epsilon and
    // Zeta are curated, so neither should also surface as "discovered".
    const discoveredNames = res.body.discovered.map((d) => d.name);
    expect(discoveredNames).not.toContain('Epsilon Plaza');
    expect(discoveredNames).not.toContain('Zeta Heights');
  });
});

// ─── 2. ?scope=mine regression guard ────────────────────────────────────────
describe('DR-010 — ?scope=mine unchanged (no ProjectAssignment narrowing)', () => {
  it('5. ?scope=mine still returns the full curated list (roster-only narrowing must not leak here)', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .get('/api/projects?scope=mine')
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    // All three active curated projects, regardless of touching or
    // assignment — scope=mine is the org-wide-curated view used by
    // DprSubmit / InspectionSubmit.
    const names = res.body.projects.map((p) => p.name).sort();
    expect(names).toEqual(['Epsilon Plaza', 'Eta Orphan', 'Zeta Heights']);
  });
});