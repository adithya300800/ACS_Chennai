/**
 * DR-016 — Employee project creation must communicate the pending-
 * allocation outcome.
 *
 * Audit verdict (ACS-Portal-Fresh-Product-Audit-2026-09-24-71f183a.md):
 *   "Employee project creation lacks a discoverable allocation
 *    outcome. When an employee resolves a project (creates a master),
 *    the resolve flow can create a master WITHOUT creating an
 *    assignment. Subsequent My Projects discovery requires an
 *    assignment. The current automatic-creation/'Every project'
 *    wording does not explain why the newly created project
 *    disappears from the employee's view after reload."
 *
 * Chosen policy: "creation requests administrator allocation" — the
 * endpoint does NOT auto-assign the creator to the new project. The
 * frontend needs a discoverable signal so it can explain to the
 * employee where the project went after reload. The fix is additive:
 *   - `POST /api/projects/resolve` returns `allocationPending: true`
 *     on the create branch ONLY (not on the existing-branch, because
 *     no new project was created so there is no pending allocation).
 *   - The endpoint does NOT create a `ProjectAssignment` row for the
 *     creator — the policy is to leave roster membership as an
 *     admin-only gesture.
 *   - `?scope=assigned` continues to require an active
 *     `ProjectAssignment` row (S7/ISRO-LEAK) so the project will not
 *     surface in My Projects until an admin allocates the employee.
 *
 * Acceptance ("The employee can explain where a newly created project
 * went after reload, without granting themselves access outside the
 * chosen policy"):
 *   1. Create branch response carries `allocationPending: true`.
 *   2. Create branch does NOT create a `ProjectAssignment` row for
 *      the creator (no out-of-policy self-assignment).
 *   3. Existing-branch response does NOT carry `allocationPending:
 *      true` (no new allocation to wait on).
 *   4. Existing DR-014 wire shape is preserved on the create branch
 *      (status 201, isRegistered true, linkedCounts, linkedTotal).
 *   5. Auth: 401 without Authorization header.
 *   6. Validation: 400 on missing name.
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
const NEW_PROJECT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RAW_NAME = 'T-Nagar';

function userJwt(employeeId = USER_ID, isAdmin = false) {
  return `Bearer ${jwt.sign(
    { employeeId, email: `${employeeId}@example.com`, isAdmin },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  )}`;
}

function makePrisma() {
  const projects = [];
  // Track ProjectAssignment writes so we can assert no out-of-policy
  // self-assignment happens during the resolve commit path.
  const assignments = [];

  const projectHandle = {
    findFirst: jest.fn(async () => null),
    findUnique: jest.fn(async () => null),
    create: jest.fn(async ({ data }) => {
      const row = {
        id: NEW_PROJECT_ID,
        name: data.name,
        code: null,
        isActive: data.isActive !== false,
        createdById: data.createdById,
        createdAt: new Date('2026-09-24T00:00:00.000Z'),
        updatedAt: new Date('2026-09-24T00:00:00.000Z'),
      };
      projects.push(row);
      return row;
    }),
  };
  const projectAssignmentHandle = {
    // DR-016 acceptance: the resolve endpoint MUST NOT call create
    // (or createMany) on the projectAssignment model — the policy is
    // to leave roster allocation as an admin-only gesture.
    create: jest.fn(async () => { throw new Error('projectAssignment.create must not be called on /resolve'); }),
    createMany: jest.fn(async () => { throw new Error('projectAssignment.createMany must not be called on /resolve'); }),
    findMany: jest.fn(async () => assignments),
    count: jest.fn(async () => assignments.length),
  };
  const employeeHandle = {
    findUnique: jest.fn(async ({ where } = {}) => {
      if (where.id === ADMIN_ID) return { id: ADMIN_ID, isAdmin: true };
      if (where.id === USER_ID) return { id: USER_ID, isAdmin: false };
      return null;
    }),
  };
  const dprHandle = {
    count: jest.fn(async () => 0),
    updateMany: jest.fn(async () => ({ count: 0 })),
  };
  const inspectionHandle = {
    count: jest.fn(async () => 0),
    updateMany: jest.fn(async () => ({ count: 0 })),
  };
  const boqHandle = {
    count: jest.fn(async () => 0),
    updateMany: jest.fn(async () => ({ count: 0 })),
  };

  // $transaction with a callback — mirror the route's commit shape so
  // tx.dPR.updateMany / tx.inspectionRecord.updateMany / tx.boqItem.updateMany
  // are forwarded to the SAME jest.fn instances the top-level handle
  // exposes. projectAssignment is intentionally NOT exposed on tx so
  // any code path that tried to write one inside the transaction would
  // TypeError — a louder failure than silent acceptance.
  const transactionHandle = jest.fn(async (fn) => {
    const tx = {
      project: { create: projectHandle.create },
      dPR: { updateMany: dprHandle.updateMany },
      inspectionRecord: { updateMany: inspectionHandle.updateMany },
      boqItem: { updateMany: boqHandle.updateMany },
    };
    return await fn(tx);
  });

  return {
    project: projectHandle,
    projectAssignment: projectAssignmentHandle,
    employee: employeeHandle,
    dPR: dprHandle,
    inspectionRecord: inspectionHandle,
    boqItem: boqHandle,
    $transaction: transactionHandle,
    _internal: { projects, assignments },
  };
}

function buildApp(prisma) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.use('/api/projects', projectRouter);
  return app;
}

// ─── 1. Create-branch response shape (DR-016) ──────────────────────────────
describe('POST /api/projects/resolve — allocationPending contract (DR-016)', () => {
  it('1. Create-branch response carries allocationPending: true', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/projects/resolve')
      .set('Authorization', userJwt())
      .send({ name: RAW_NAME });
    expect(res.status).toBe(201);
    expect(res.body.allocationPending).toBe(true);
  });

  it('2. Create-branch does NOT create a ProjectAssignment for the creator', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/projects/resolve')
      .set('Authorization', userJwt())
      .send({ name: RAW_NAME });
    expect(res.status).toBe(201);
    // The headline DR-016 contract: roster membership is admin-only.
    // No create / createMany / upsert call on the projectAssignment
    // model is permitted during the resolve commit.
    expect(prisma.projectAssignment.create).not.toHaveBeenCalled();
    expect(prisma.projectAssignment.createMany).not.toHaveBeenCalled();
    expect(prisma._internal.assignments).toEqual([]);
  });

  it('3. Create-branch preserves the DR-014 wire shape (status, isRegistered, linkedCounts, linkedTotal)', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/projects/resolve')
      .set('Authorization', userJwt())
      .send({ name: RAW_NAME });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(NEW_PROJECT_ID);
    expect(res.body.name).toBe(RAW_NAME);
    expect(res.body.isRegistered).toBe(true);
    // linkedCounts / linkedTotal are the DR-014 surface; the DR-016
    // addition is purely additive so the existing contract stays green.
    expect(res.body.linkedCounts).toEqual({ dpr: 0, inspection: 0, boq: 0 });
    expect(res.body.linkedTotal).toBe(0);
    // The new flag lives alongside the existing fields.
    expect(res.body.allocationPending).toBe(true);
  });
});

// ─── 2. Existing-branch does NOT advertise pending allocation ───────────────
describe('POST /api/projects/resolve — existing-branch (DR-016)', () => {
  it('4. Existing project response does NOT carry allocationPending: true', async () => {
    const existingId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const prisma = makePrisma();
    // Override findFirst to return an existing curated row so the
    // route takes the no-create branch.
    prisma.project.findFirst = jest.fn(async () => ({
      id: existingId,
      name: 'T-Nagar',
      code: 'T-NAGAR',
      isActive: true,
      createdById: ADMIN_ID,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    }));
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/projects/resolve')
      .set('Authorization', userJwt())
      .send({ name: 'T-NAGAR' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(existingId);
    expect(res.body.isRegistered).toBe(true);
    // No new project → no pending allocation to wait on. Either the
    // flag is absent or it is explicitly false; both are acceptable.
    if ('allocationPending' in res.body) {
      expect(res.body.allocationPending).not.toBe(true);
    }
    // No write happened on the create-branch — and so no assignment
    // could have been granted on the existing branch either.
    expect(prisma.project.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.projectAssignment.create).not.toHaveBeenCalled();
  });
});

// ─── 3. Auth + validation regression (DR-016) ───────────────────────────────
describe('POST /api/projects/resolve — auth + validation (DR-016)', () => {
  it('5. 401 when no Authorization header is sent', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/projects/resolve')
      .send({ name: RAW_NAME });
    expect(res.status).toBe(401);
  });

  it('6. 400 when name is missing', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/projects/resolve')
      .set('Authorization', userJwt())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });
});
