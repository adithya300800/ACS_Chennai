/**
 * DR-010 (2026-09-08 SOL audit): "The advertised remove/re-add role
 * change still returns silent success".
 *
 * Background: the prior syncProjectAssignments diff in
 * backend/src/routes/projects.js treated assignments as set-membership
 * only — it created rows for new (projectId, employeeId) pairs and
 * deleted rows whose employeeId wasn't in `desired`, but it never
 * touched the role on rows that were already present. The frontend
 * shipped an "advertised workaround" (✕ remove → "+ Add employee…" re-
 * add with a new role → Save) that still hit this silent-success path:
 * the frontend's remove was a local-state change only, so on submit
 * the diff saw the existing row as "still in desired" and left it
 * alone — the new role was discarded and PATCH200 returned the old
 * role. Reload retained the old role.
 *
 * Fix: extend the diff to UPDATE the role on retained employeeIds when
 * the desired role differs from the stored role. Preserves the row's
 * id, assignedAt, and assignedById so the audit trail stays intact.
 *
 * Coverage matrix:
 *   1. PATCH with a changed role for a retained employee → UPDATE is
 *      called, the in-memory row reflects the new role, response
 *      payload carries the new role.
 *   2. PATCH with the SAME role (no-op edit) → no UPDATE is called,
 *      idempotent (one row still).
 *   3. PATCH that clears a previously-set role to null → UPDATE is
 *      called, the row's role becomes null.
 *   4. PATCH with a new pair added + retained role edit → both an
 *      UPDATE on the retained row AND a createMany on the new pair
 *      happen in the same transaction.
 *   5. PATCH that omits a retained employee → DELETE happens AND a
 *      separate retained role update happens — no interference.
 *   6. Source-text pin: syncProjectAssignments contains the literal
 *      `[DR-010]` marker and the per-row update path. Stops a future
 *      refactor from reverting the silent-success contract.
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

jest.mock('../src/lib/blobStorage', () => ({
  generateReadSASUrl: jest.fn(async () => ({ sasUrl: 'https://r2.example/sas', expiresAt: new Date().toISOString() })),
  generateUploadSASUrl: jest.fn(async () => ({ sasUrl: 'https://r2.example/put', blobPath: 'x', expiresAt: new Date().toISOString() })),
  generateULID: jest.fn(() => '01ARZ3NDEKTSV4RRFFQ69G5FAV'),
  verifyBlobExists: jest.fn(async () => ({ exists: true })),
  deleteBlob: jest.fn(async () => {}),
  CONTENT_TYPE_EXT: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' },
}));

jest.mock('../src/lib/notify', () => ({
  fanOutEmail: jest.fn(async () => ({ sent: 0 })),
  fanOutToAdmins: jest.fn(async () => ({ sent: 0, skipped: 0, failed: 0 })),
}));

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const fs = require('fs');
const path = require('path');

const projectRouter = require('../src/routes/projects');

const ADMIN_ID = 'admin-dr010';
const EMP_ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EMP_BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

function adminJwt() {
  return `Bearer ${jwt.sign(
    { employeeId: ADMIN_ID, email: 'admin@example.com', isAdmin: true },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  )}`;
}

// ─── In-memory Prisma stub ──────────────────────────────────────────────────
// The shared in-memory store lets us assert "the row WAS actually
// rewritten" by reading back the live object after PATCH completes.
function buildPrisma(overrides = {}) {
  const employees = new Map([
    [ADMIN_ID, { id: ADMIN_ID, name: 'Admin', email: 'admin@example.com', isAdmin: true, designation: 'Director' }],
    [EMP_ALICE, { id: EMP_ALICE, name: 'Alice', email: 'alice@example.com', isAdmin: false, designation: 'Site Engineer' }],
    [EMP_BOB, { id: EMP_BOB, name: 'Bob', email: 'bob@example.com', isAdmin: false, designation: 'QA' }],
  ]);

  const projects = new Map([
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

  // Default seed: Alice is pre-assigned with role 'Site Engineer'.
  // Overrides can replace it (e.g. null role, or two rows).
  const assignments = overrides.initialAssignments || [
    {
      id: 'pa-existing-1',
      projectId: PROJECT_ID,
      employeeId: EMP_ALICE,
      role: 'Site Engineer',
      assignedAt: new Date('2026-09-01T00:00:00.000Z'),
      assignedById: ADMIN_ID,
    },
  ];

  // The mock tx === prisma for these contract tests — the route only
  // uses the transaction as a "scope" hint, not for rollback semantics.
  const tx = {};
  const prisma = {
    $transaction: jest.fn(async (cb) => cb(tx)),
    project: {
      findUnique: jest.fn(async ({ where, include } = {}) => {
        let row = null;
        if (where && where.id) row = projects.get(where.id) || null;
        if (!row) return null;
        if (include && include.assignments) {
          return {
            ...row,
            assignments: assignments
              .filter((a) => a.projectId === row.id)
              .slice()
              .sort((a, b) => a.assignedAt.getTime() - b.assignedAt.getTime())
              .map((r) => {
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
              }),
          };
        }
        return row;
      }),
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => Array.from(projects.values())),
      create: jest.fn(async ({ data }) => {
        const id = `proj-${Date.now()}`;
        const row = { id, isActive: true, createdAt: new Date(), updatedAt: new Date(), ...data };
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
      findMany: jest.fn(async (args = {}) => {
        let rows = assignments.slice();
        if (args.where && args.where.projectId) {
          rows = rows.filter((r) => r.projectId === args.where.projectId);
        }
        if (args.include && args.include.employee) {
          rows = rows.map((r) => {
            const e = employees.get(r.employeeId);
            return {
              ...r,
              employee: e
                ? { id: e.id, name: e.name, email: e.email, designation: e.designation }
                : null,
            };
          });
        }
        return rows;
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
      // [DR-010] Per-row update preserves id + assignedAt + assignedById;
      // only role is rewritten. The contract test pins that this method
      // is invoked once per retained employee whose role changed.
      update: jest.fn(async ({ where, data }) => {
        const row = assignments.find((a) => a.id === where.id);
        if (!row) {
          const err = new Error('Not found');
          err.code = 'P2025';
          throw err;
        }
        Object.assign(row, data);
        return row;
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
        return e ? { id: e.id, isAdmin: e.isAdmin } : null;
      }),
      findMany: jest.fn(async ({ where } = {}) => {
        if (!where || !where.id || !where.id.in) return Array.from(employees.values());
        const set = new Set(where.id.in);
        return Array.from(employees.values()).filter((e) => set.has(e.id));
      }),
    },
  };
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

// ─── Source-text pin ────────────────────────────────────────────────────────
// Stops a future refactor from silently reverting the per-row update
// path. If the marker disappears, this test fails — the source-text
// pin is the durable contract.
describe('DR-010 — source-text pin in syncProjectAssignments', () => {
  it('syncProjectAssignments contains the [DR-010] marker and a per-row update call', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'routes', 'projects.js'),
      'utf8',
    );
    // The diff comment that calls out retained-employeeIds.
    expect(src).toMatch(/\[DR-010\][^\n]*retained[^\n]*employeeIds/i);
    // The per-row update path — `tx.projectAssignment.update({ where: { id: row.id }, data: { role: row.role } })`.
    expect(src).toMatch(/tx\.projectAssignment\.update\(\s*\{\s*where:\s*\{\s*id:\s*row\.id/);
    // The role-equality short-circuit that keeps PATCH idempotent.
    expect(src).toMatch(/existing\.role\s*\?\?\s*null\)\s*!==\s*\(desiredRow\.role\s*\?\?\s*null\)/);
  });
});

// ─── Behavioural coverage ───────────────────────────────────────────────────
describe('DR-010 — PATCH assignment role change persists for retained employees', () => {
  it('1. changed role → update is called and the in-memory row reflects the new role', async () => {
    const { prisma, assignments } = buildPrisma();
    const seedRow = assignments.find((a) => a.employeeId === EMP_ALICE);
    expect(seedRow.role).toBe('Site Engineer');
    const app = buildApp(prisma);

    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}`)
      .set('Authorization', adminJwt())
      .send({ assignments: [{ employeeId: EMP_ALICE, role: 'Project Manager' }] });

    expect(res.status).toBe(200);
    // Per-row update was called once with the new role, preserving id.
    expect(prisma.projectAssignment.update).toHaveBeenCalledTimes(1);
    const updateArgs = prisma.projectAssignment.update.mock.calls[0][0];
    expect(updateArgs.where.id).toBe(seedRow.id);
    expect(updateArgs.data.role).toBe('Project Manager');
    // The shared in-memory store reflects the change.
    const afterRow = assignments.find((a) => a.id === seedRow.id);
    expect(afterRow.role).toBe('Project Manager');
    expect(afterRow.id).toBe(seedRow.id);
    expect(afterRow.assignedAt).toEqual(seedRow.assignedAt);
    expect(afterRow.assignedById).toBe(ADMIN_ID);
    // The response payload carries the new role.
    const aliceRow = res.body.assignments.find((a) => a.employeeId === EMP_ALICE);
    expect(aliceRow.role).toBe('Project Manager');
  });

  it('2. same role (no-op edit) → no update, idempotent', async () => {
    const { prisma, assignments } = buildPrisma();
    const seedRow = assignments.find((a) => a.employeeId === EMP_ALICE);
    const app = buildApp(prisma);

    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}`)
      .set('Authorization', adminJwt())
      .send({ assignments: [{ employeeId: EMP_ALICE, role: 'Site Engineer' }] });

    expect(res.status).toBe(200);
    expect(prisma.projectAssignment.update).not.toHaveBeenCalled();
    expect(prisma.projectAssignment.createMany).not.toHaveBeenCalled();
    expect(prisma.projectAssignment.deleteMany).not.toHaveBeenCalled();
    expect(res.body.assignments.length).toBe(1);
    expect(assignments.length).toBe(1);
    expect(seedRow.role).toBe('Site Engineer');
  });

  it('3. cleared role → update sets role to null', async () => {
    const { prisma, assignments } = buildPrisma();
    const seedRow = assignments.find((a) => a.employeeId === EMP_ALICE);
    expect(seedRow.role).toBe('Site Engineer');
    const app = buildApp(prisma);

    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}`)
      .set('Authorization', adminJwt())
      .send({ assignments: [{ employeeId: EMP_ALICE, role: null }] });

    expect(res.status).toBe(200);
    expect(prisma.projectAssignment.update).toHaveBeenCalledTimes(1);
    expect(prisma.projectAssignment.update.mock.calls[0][0].data.role).toBeNull();
    expect(assignments.find((a) => a.id === seedRow.id).role).toBeNull();
    const aliceRow = res.body.assignments.find((a) => a.employeeId === EMP_ALICE);
    expect(aliceRow.role).toBeNull();
  });

  it('4. role edit + new assignee → update AND createMany in the same transaction', async () => {
    const { prisma, assignments } = buildPrisma();
    const seedRow = assignments.find((a) => a.employeeId === EMP_ALICE);
    const app = buildApp(prisma);

    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}`)
      .set('Authorization', adminJwt())
      .send({
        assignments: [
          { employeeId: EMP_ALICE, role: 'Lead Engineer' },
          { employeeId: EMP_BOB, role: 'QA' },
        ],
      });

    expect(res.status).toBe(200);
    expect(prisma.projectAssignment.update).toHaveBeenCalledTimes(1);
    expect(prisma.projectAssignment.update.mock.calls[0][0].where.id).toBe(seedRow.id);
    expect(prisma.projectAssignment.createMany).toHaveBeenCalledTimes(1);
    const createArgs = prisma.projectAssignment.createMany.mock.calls[0][0];
    expect(createArgs.data.map((d) => d.employeeId)).toEqual([EMP_BOB]);
    expect(createArgs.data[0].role).toBe('QA');
    // Two rows in total after the diff.
    expect(res.body.assignments.length).toBe(2);
    expect(assignments.filter((a) => a.projectId === PROJECT_ID).length).toBe(2);
    const byEmp = Object.fromEntries(res.body.assignments.map((a) => [a.employeeId, a]));
    expect(byEmp[EMP_ALICE].role).toBe('Lead Engineer');
    expect(byEmp[EMP_BOB].role).toBe('QA');
  });

  it('5. omitted retained employee + retained role edit → delete AND update happen independently', async () => {
    // Seed with TWO existing rows so we can both UPDATE one and DELETE
    // the other in the same diff.
    const seed = buildPrisma.bind(null, {
      initialAssignments: [
        {
          id: 'pa-A',
          projectId: PROJECT_ID,
          employeeId: EMP_ALICE,
          role: 'Site Engineer',
          assignedAt: new Date('2026-09-01T00:00:00.000Z'),
          assignedById: ADMIN_ID,
        },
        {
          id: 'pa-B',
          projectId: PROJECT_ID,
          employeeId: EMP_BOB,
          role: 'QA',
          assignedAt: new Date('2026-09-02T00:00:00.000Z'),
          assignedById: ADMIN_ID,
        },
      ],
    });
    const { prisma, assignments } = seed();
    const app = buildApp(prisma);

    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}`)
      .set('Authorization', adminJwt())
      .send({
        // Alice stays, role changes; Bob is omitted → DELETE.
        assignments: [{ employeeId: EMP_ALICE, role: 'Lead Engineer' }],
      });

    expect(res.status).toBe(200);
    expect(prisma.projectAssignment.update).toHaveBeenCalledTimes(1);
    expect(prisma.projectAssignment.update.mock.calls[0][0].where.id).toBe('pa-A');
    expect(prisma.projectAssignment.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.projectAssignment.deleteMany.mock.calls[0][0].where.employeeId.in).toEqual([EMP_BOB]);
    expect(assignments.find((a) => a.id === 'pa-A').role).toBe('Lead Engineer');
    expect(assignments.find((a) => a.id === 'pa-B')).toBeUndefined();
    expect(res.body.assignments.length).toBe(1);
    expect(res.body.assignments[0].employeeId).toBe(EMP_ALICE);
    expect(res.body.assignments[0].role).toBe('Lead Engineer');
  });
});
