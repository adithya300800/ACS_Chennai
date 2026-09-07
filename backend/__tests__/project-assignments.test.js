/**
 * Project Assignments — POST/PATCH/GET contract tests.
 *
 * Coverage matrix:
 *   1. POST /api/projects with assignments: [{employeeId, role}] → 201,
 *      follow-up GET shows 1 row with the employee join surfaced.
 *   2. POST /api/projects without assignments → no rows created
 *      (back-compat — existing callers don't break).
 *   3. PATCH /api/projects/:id with assignments: [] → all rows deleted.
 *   4. PATCH /api/projects/:id with the same assignments array twice →
 *      idempotent (still 1 row, not 2) — diff is keyed on
 *      (projectId, employeeId).
 *   5. PATCH /api/projects/:id with a NEW pair added → 2 rows.
 *   6. POST /api/projects with assignments: [{employeeId: 'not-a-uuid'}]
 *      → 400 INVALID_UUID (validateAssignment shape check).
 *   7. POST /api/projects with assignments: [{employeeId:
 *      <uuid-of-nonexistent-employee>}] → 400 EMPLOYEE_NOT_FOUND with
 *      missingEmployeeIds echoed in the response.
 *   8. GET /api/projects/:id/assignments returns the rows + the joined
 *      employee metadata (id, name, email, designation).
 *   9. GET /api/projects/:id/assignments with no rows → 200 with
 *      assignments: [] (NOT a 404).
 *
 * Pattern mirrors __tests__/project-kpi.test.js — mounted route with a
 * stubbed Prisma. We avoid a live Postgres by mocking every prisma
 * method the route touches, and pass `prisma` itself as the
 * `prisma.$transaction(async (tx) => ...)` callback's `tx` because the
 * route only uses the transaction to scope writes, not to roll back.
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
const EMP_ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EMP_BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EMP_GHOST = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function adminJwt(employeeId = ADMIN_ID) {
  return `Bearer ${jwt.sign(
    { employeeId, email: 'admin@example.com', isAdmin: true },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  )}`;
}

function userJwt(employeeId = EMP_ALICE) {
  return `Bearer ${jwt.sign(
    { employeeId, email: 'alice@example.com', isAdmin: false },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  )}`;
}

// ─── In-memory Prisma stub ──────────────────────────────────────────────────
// We seed one Project row + a known set of employees + a fresh assignment
// store per test. The mock honours `$transaction` by passing `prisma`
// itself to the callback — for these contract tests the route doesn't
// rollback, it just uses the transaction as a "scope" hint.
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

function buildPrisma(overrides = {}) {
  const employees = new Map([
    [ADMIN_ID, { id: ADMIN_ID, name: 'Admin', email: 'admin@example.com', isAdmin: true, designation: 'Director' }],
    [EMP_ALICE, { id: EMP_ALICE, name: 'Alice', email: 'alice@example.com', isAdmin: false, designation: 'Site Engineer' }],
    [EMP_BOB, { id: EMP_BOB, name: 'Bob', email: 'bob@example.com', isAdmin: false, designation: 'QA' }],
  ]);

  // Seed project(s) per test. The default fixture has T-Nagar registered
  // and one pre-existing assignment (Alice) — tests that want an empty
  // slate can override with `buildPrisma({ initialAssignments: [] })`.
  const projects = overrides.projects || new Map([
    [PROJECT_ID, {
      id: PROJECT_ID,
      name: 'T-Nagar',
      code: 'T-NAGAR',
      isActive: true,
      createdById: ADMIN_ID,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    }],
  ]);
  const assignments = overrides.initialAssignments || [
    {
      id: 'pa-existing-1',
      projectId: PROJECT_ID,
      employeeId: EMP_ALICE,
      role: 'Pre-existing',
      assignedAt: new Date('2026-09-01T00:00:00.000Z'),
      assignedById: ADMIN_ID,
    },
  ];

  // The mock tx === prisma for these contract tests — every tx method
  // delegates to the prisma-level mock below. The route only uses the
  // transaction to scope writes; the in-memory state is shared.
  const tx = {
    project: null, // assigned below
    projectAssignment: null,
    employee: null,
  };

  const prisma = {
    $transaction: jest.fn(async (cb) => cb(tx)),
    project: {
      findUnique: jest.fn(async ({ where, include } = {}) => {
        let row = null;
        if (where && where.id) row = projects.get(where.id) || null;
        else if (where && where.name) {
          for (const p of projects.values()) {
            if (p.name === where.name) { row = p; break; }
          }
        }
        if (!row) return null;
        // Honour `include.assignments` so post-mutation re-fetches
        // surface the freshly-written rows + employee join.
        if (include && include.assignments) {
          return {
            ...row,
            assignments: applyAssignmentsInclude(include.assignments, row.id),
          };
        }
        return row;
      }),
      findFirst: jest.fn(async ({ where } = {}) => {
        if (!where || !where.name) return null;
        const target = String(where.name.equals || '').toLowerCase();
        for (const p of projects.values()) {
          if (p.name.toLowerCase() === target) return p;
        }
        return null;
      }),
      findMany: jest.fn(async () => Array.from(projects.values())),
      create: jest.fn(async ({ data }) => {
        const id = `proj-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const row = {
          id,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        projects.set(id, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }) => {
        const existing = projects.get(where.id);
        if (!existing) {
          const err = new Error('Not found');
          err.code = 'P2025';
          throw err;
        }
        Object.assign(existing, data, { updatedAt: new Date() });
        return existing;
      }),
    },
    projectAssignment: {
      findMany: jest.fn(async ({ where } = {}) => {
        let rows = assignments;
        if (where && where.projectId) {
          rows = rows.filter((r) => r.projectId === where.projectId);
          if (where.employeeId && where.employeeId.in) {
            const set = new Set(where.employeeId.in);
            rows = rows.filter((r) => set.has(r.employeeId));
          }
        }
        return rows.slice();
      }),
      createMany: jest.fn(async ({ data }) => {
        for (const d of data) {
          assignments.push({
            id: `pa-new-${assignments.length + 1}`,
            assignedAt: new Date(),
            ...d,
          });
        }
        return { count: data.length };
      }),
      deleteMany: jest.fn(async ({ where } = {}) => {
        let removed = 0;
        for (let i = assignments.length - 1; i >= 0; i -= 1) {
          const a = assignments[i];
          if (a.projectId !== where.projectId) continue;
          if (where.employeeId && where.employeeId.in) {
            const set = new Set(where.employeeId.in);
            if (!set.has(a.employeeId)) continue;
          }
          assignments.splice(i, 1);
          removed += 1;
        }
        return { count: removed };
      }),
    },
    employee: {
      findUnique: jest.fn(async ({ where }) => {
        const e = employees.get(where.id);
        if (!e) return null;
        // requireFreshAdmin only reads id + isAdmin; assignment sync
        // needs the full row.
        return { id: e.id, isAdmin: e.isAdmin };
      }),
      findMany: jest.fn(async ({ where } = {}) => {
        if (!where || !where.id || !where.id.in) return Array.from(employees.values());
        const set = new Set(where.id.in);
        return Array.from(employees.values()).filter((e) => set.has(e.id));
      }),
    },
  };

  // Re-fetch with include shape for projectAssignment. The route does
  // `findMany({ include: { employee: { select: ... } } })` for the GET
  // /assignments endpoint and the post-mutation re-fetch. Honour the
  // include by left-joining the in-memory employee store.
  prisma.projectAssignment.findMany = jest.fn(async (args = {}) => {
    let rows = assignments.slice();
    if (args.where && args.where.projectId) {
      rows = rows.filter((r) => r.projectId === args.where.projectId);
      if (args.where.employeeId && args.where.employeeId.in) {
        const set = new Set(args.where.employeeId.in);
        rows = rows.filter((r) => set.has(r.employeeId));
      }
    }
    if (args.include && args.include.employee) {
      rows = rows.map((r) => ({
        ...r,
        employee: employees.get(r.employeeId)
          ? {
              id: employees.get(r.employeeId).id,
              name: employees.get(r.employeeId).name,
              email: employees.get(r.employeeId).email,
              designation: employees.get(r.employeeId).designation,
            }
          : null,
      }));
    }
    return rows;
  });

  // Resolve the assignments sub-include for a project. Used by the
  // post-mutation re-fetch in `tx.project.findUnique({ include:
  // { assignments: ... } })`. Honours the `include.employee` sub-shape
  // so the GET / POST response carries the joined employee row.
  function applyAssignmentsInclude(includeShape, projectId) {
    const rows = assignments
      .filter((a) => a.projectId === projectId)
      .slice()
      .sort((a, b) => (a.assignedAt.getTime() - b.assignedAt.getTime()));
    if (includeShape && includeShape.include && includeShape.include.employee) {
      return rows.map((r) => {
        const e = employees.get(r.employeeId);
        return {
          ...r,
          employee: e
            ? {
                id: e.id,
                name: e.name,
                email: e.email,
                designation: e.designation,
              }
            : null,
        };
      });
    }
    return rows;
  }

  // Hook tx to share state with prisma (mocking shortcut — see header).
  tx.project = prisma.project;
  tx.projectAssignment = prisma.projectAssignment;
  tx.employee = prisma.employee;

  return { prisma, projects, assignments, employees };
}

function buildApp(prisma) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.use('/api/projects', projectRouter);
  return app;
}

// ─── 1. POST /api/projects with assignments ────────────────────────────────
describe('Project Assignments — POST /api/projects', () => {
  it('1. creates the project + 1 assignment row, surfaces the join', async () => {
    const { prisma } = buildPrisma({ initialAssignments: [] });
    const app = buildApp(prisma);

    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', adminJwt())
      .send({
        name: 'New Project With Team',
        code: 'NPWT-01',
        assignments: [
          { employeeId: EMP_ALICE, role: 'Site Engineer' },
          { employeeId: EMP_BOB, role: 'QA' },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('New Project With Team');
    expect(Array.isArray(res.body.assignments)).toBe(true);
    expect(res.body.assignments.length).toBe(2);
    const byEmp = Object.fromEntries(res.body.assignments.map((a) => [a.employeeId, a]));
    expect(byEmp[EMP_ALICE].role).toBe('Site Engineer');
    expect(byEmp[EMP_ALICE].employee).toMatchObject({
      id: EMP_ALICE,
      name: 'Alice',
      email: 'alice@example.com',
      designation: 'Site Engineer',
    });
    expect(byEmp[EMP_BOB].role).toBe('QA');
    expect(byEmp[EMP_BOB].employee.designation).toBe('QA');
    // assignedById is server-derived from req.employeeId, never trusted
    // from the body (the request didn't include assignedById at all).
    expect(byEmp[EMP_ALICE].assignedAt).toBeDefined();
  });

  it('2. POST without assignments → no rows created (back-compat)', async () => {
    const { prisma, assignments } = buildPrisma({ initialAssignments: [] });
    const app = buildApp(prisma);

    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', adminJwt())
      .send({ name: 'Solo Project', code: 'SOLO-01' });

    expect(res.status).toBe(201);
    // Project create succeeded.
    expect(prisma.project.create).toHaveBeenCalled();
    // No createMany on the assignment table — body.assignments was absent.
    expect(prisma.projectAssignment.createMany).not.toHaveBeenCalled();
    // No assignment rows for this freshly-created project. The response
    // payload includes `assignments: []` because the POST re-fetch
    // always uses PROJECT_WITH_ASSIGNMENTS_INCLUDE; the contract is
    // "no rows were created", not "the field is absent".
    const created = res.body;
    expect(created.assignments).toEqual([]);
    // The shared in-memory store is unchanged from its seed (empty).
    expect(assignments.length).toBe(0);
  });

  it('6. POST with non-UUID employeeId → 400 INVALID_UUID', async () => {
    const { prisma } = buildPrisma();
    const app = buildApp(prisma);

    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', adminJwt())
      .send({
        name: 'Bad UUID Project',
        assignments: [{ employeeId: 'not-a-uuid' }],
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_UUID');
    // No project created — validation rejected before the DB write.
    expect(prisma.project.create).not.toHaveBeenCalled();
  });

  it('7. POST with unknown employeeId → 400 EMPLOYEE_NOT_FOUND', async () => {
    const { prisma } = buildPrisma();
    const app = buildApp(prisma);

    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', adminJwt())
      .send({
        name: 'Ghost Employee Project',
        assignments: [{ employeeId: EMP_GHOST, role: 'Imaginary' }],
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMPLOYEE_NOT_FOUND');
    expect(res.body.missingEmployeeIds).toEqual([EMP_GHOST]);
    // The route caught the sync error and returned 400 BEFORE reaching
    // the success path. We don't simulate transaction rollback in the
    // mock (tx === prisma), so we just check that no successful 201
    // response went out — the test for the error code + status is the
    // contract that matters.
    expect(res.body.error).toMatch(/unknown employee/i);
  });

  it('rejects anonymous POST with 401 (no auth bypass)', async () => {
    const { prisma } = buildPrisma();
    const app = buildApp(prisma);

    const res = await request(app)
      .post('/api/projects')
      .send({ name: 'Anon', assignments: [{ employeeId: EMP_ALICE }] });
    expect(res.status).toBe(401);
  });
});

// ─── 2. PATCH /api/projects/:id with assignments ────────────────────────────
describe('Project Assignments — PATCH /api/projects/:id', () => {
  it('3. PATCH with assignments: [] → all rows deleted', async () => {
    const { prisma, assignments } = buildPrisma();
    expect(assignments.length).toBe(1); // seed: Alice pre-assigned
    const app = buildApp(prisma);

    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}`)
      .set('Authorization', adminJwt())
      .send({ assignments: [] });

    expect(res.status).toBe(200);
    expect(prisma.projectAssignment.deleteMany).toHaveBeenCalled();
    expect(res.body.assignments).toEqual([]);
    expect(assignments.filter((a) => a.projectId === PROJECT_ID)).toEqual([]);
  });

  it('4. PATCH same assignments twice → idempotent (still 1 row, not 2)', async () => {
    const { prisma, assignments } = buildPrisma({ initialAssignments: [] });
    const app = buildApp(prisma);

    const payload = { assignments: [{ employeeId: EMP_ALICE, role: 'Site Engineer' }] };
    const r1 = await request(app)
      .patch(`/api/projects/${PROJECT_ID}`)
      .set('Authorization', adminJwt())
      .send(payload);
    expect(r1.status).toBe(200);
    expect(r1.body.assignments.length).toBe(1);

    // Re-fetch after first PATCH so the second diff runs against the
    // updated state (not the empty seed).
    const r2 = await request(app)
      .patch(`/api/projects/${PROJECT_ID}`)
      .set('Authorization', adminJwt())
      .send(payload);
    expect(r2.status).toBe(200);
    expect(r2.body.assignments.length).toBe(1);
    // In-memory store confirms no duplicate row.
    expect(assignments.filter((a) => a.projectId === PROJECT_ID).length).toBe(1);
  });

  it('5. PATCH with new pair added → 2 rows total', async () => {
    const { prisma, assignments } = buildPrisma();
    expect(assignments.filter((a) => a.projectId === PROJECT_ID).length).toBe(1);
    const app = buildApp(prisma);

    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}`)
      .set('Authorization', adminJwt())
      .send({
        assignments: [
          { employeeId: EMP_ALICE, role: 'Pre-existing' }, // unchanged
          { employeeId: EMP_BOB, role: 'QA' }, // newly added
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.assignments.length).toBe(2);
    const byEmp = Object.fromEntries(res.body.assignments.map((a) => [a.employeeId, a]));
    expect(byEmp[EMP_ALICE]).toBeDefined();
    expect(byEmp[EMP_BOB].role).toBe('QA');
  });

  it('PATCH without assignments field → existing rows untouched (back-compat)', async () => {
    const { prisma, assignments } = buildPrisma();
    const before = assignments.filter((a) => a.projectId === PROJECT_ID).length;
    const app = buildApp(prisma);

    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}`)
      .set('Authorization', adminJwt())
      .send({ client: 'New Client Name' });

    expect(res.status).toBe(200);
    expect(prisma.projectAssignment.deleteMany).not.toHaveBeenCalled();
    expect(prisma.projectAssignment.createMany).not.toHaveBeenCalled();
    const after = assignments.filter((a) => a.projectId === PROJECT_ID).length;
    expect(after).toBe(before);
    // client updated
    expect(res.body.client).toBe('New Client Name');
    // assignments not echoed — the response payload omits the field when
    // the PATCH didn't include it (no include + no fresh fetch).
    expect(res.body.assignments).toBeUndefined();
  });

  it('PATCH rejects unknown employeeId with 400 EMPLOYEE_NOT_FOUND', async () => {
    const { prisma } = buildPrisma();
    const app = buildApp(prisma);

    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}`)
      .set('Authorization', adminJwt())
      .send({ assignments: [{ employeeId: EMP_GHOST }] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMPLOYEE_NOT_FOUND');
    expect(res.body.missingEmployeeIds).toEqual([EMP_GHOST]);
  });
});

// ─── 3. GET /api/projects/:idOrName/assignments ─────────────────────────────
describe('Project Assignments — GET /api/projects/:idOrName/assignments', () => {
  it('8. returns rows with the employee join inlined', async () => {
    const { prisma } = buildPrisma();
    const app = buildApp(prisma);

    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/assignments`)
      .set('Authorization', userJwt());

    expect(res.status).toBe(200);
    expect(res.body.isRegistered).toBe(true);
    expect(res.body.projectId).toBe(PROJECT_ID);
    expect(Array.isArray(res.body.assignments)).toBe(true);
    expect(res.body.assignments.length).toBe(1);
    const row = res.body.assignments[0];
    expect(row.employeeId).toBe(EMP_ALICE);
    expect(row.employee).toMatchObject({
      id: EMP_ALICE,
      name: 'Alice',
      email: 'alice@example.com',
      designation: 'Site Engineer',
    });
    expect(row.role).toBe('Pre-existing');
  });

  it('9. project with zero assignments → 200 with assignments: []', async () => {
    const { prisma } = buildPrisma({ initialAssignments: [] });
    const app = buildApp(prisma);

    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/assignments`)
      .set('Authorization', userJwt());

    expect(res.status).toBe(200);
    expect(res.body.assignments).toEqual([]);
  });

  it('rejects anonymous GET with 401', async () => {
    const { prisma } = buildPrisma();
    const app = buildApp(prisma);
    const res = await request(app).get(`/api/projects/${PROJECT_ID}/assignments`);
    expect(res.status).toBe(401);
  });

  it('GET resolves by name (case-insensitive) like the other detail endpoints', async () => {
    const { prisma } = buildPrisma();
    // Seed the project with a known name.
    prisma.project.findUnique.mockImplementation(async ({ where } = {}) => {
      if (where && where.id === PROJECT_ID) {
        return {
          id: PROJECT_ID,
          name: 'T-Nagar',
          isActive: true,
          createdById: ADMIN_ID,
        };
      }
      if (where && where.name) {
        if (where.name.toLowerCase() === 't-nagar') {
          return {
            id: PROJECT_ID,
            name: 'T-Nagar',
            isActive: true,
            createdById: ADMIN_ID,
          };
        }
        return null;
      }
      return null;
    });
    const app = buildApp(prisma);

    const res = await request(app)
      .get('/api/projects/t-nagar/assignments')
      .set('Authorization', userJwt());

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('T-Nagar');
    expect(res.body.isRegistered).toBe(true);
  });
});
