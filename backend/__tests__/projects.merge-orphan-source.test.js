/**
 * merge-orphan-source — re-attribute orphaned child rows (DPR /
 * InspectionRecord / BoqItem) from a discovered project name onto an
 * existing curated Project row.
 *
 * Contract under test (matches backend/src/routes/projects.js
 * POST /:targetId/merge-orphan-source):
 *
 *   1. dryRun: true returns per-table counts without calling updateMany
 *      or $transaction. The frontend preview modal uses this.
 *   2. Commit (dryRun: false / omitted) calls updateMany on all three
 *      tables with BOTH projectId AND projectName in the `data` shape.
 *      The projectName rewrite is the correctness hook — without it the
 *      exact-match KPI filter (projects.js kpiHandler) would miss the
 *      just-merged rows. This is the AMENDMENT 2 contract.
 *   3. WHERE shape locks to { projectId: null, projectName: { equals, mode:
 *      'insensitive' } } — case-insensitive match + idempotent re-run
 *      (rows already pointing at the target are skipped).
 *   4. Commit path is atomic — $transaction wraps all three updateMany
 *      calls so a partial failure rolls back the rest.
 *   5. Empty result (count === 0) is data-safe — mirrors the
 *      admin-training-overdue.test.js updateMany-skip precedent.
 *   6. Validation: missing sourceName → 400; non-UUID targetId → 400;
 *      missing target project → 404; sourceName matches target name →
 *      409 SAME_PROJECT; non-admin token → 403 (requireFreshAdmin).
 *
 * Test scope mirrors the per-feature precedent in
 * projects.dr010.test.js / projects.dr012.test.js — own prisma mock
 * builder, no shared helpers (the project-kpi.test.js makePrisma is not
 * exported).
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
const TARGET_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MISSING_UUID = '00000000-0000-4000-8000-000000000000';
const TARGET_NAME = 'Alpha Towers'; // intentionally NOT case-insensitively equal to any orphan source

function adminJwt() {
  return `Bearer ${jwt.sign(
    { employeeId: ADMIN_ID, email: 'admin@example.com', isAdmin: true },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  )}`;
}

function userJwt() {
  return `Bearer ${jwt.sign(
    { employeeId: USER_ID, email: 'user@example.com', isAdmin: false },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  )}`;
}

// Match the WHERE shape the route emits. Supports Prisma's
// { equals, mode } case-insensitive shape and the bare `projectId: null`
// lock. Exhaustive — the route only emits these two fields.
function rowMatches(row, where) {
  if (!where) return true;
  for (const k of Object.keys(where)) {
    if (k === 'projectId' && row.projectId !== where.projectId) return false;
    if (k === 'projectName') {
      const cond = where.projectName;
      if (cond && typeof cond === 'object' && 'equals' in cond) {
        const mode = cond.mode || 'default';
        const rowVal = String(row.projectName);
        const cmpVal = String(cond.equals);
        if (mode === 'insensitive') {
          if (rowVal.toLowerCase() !== cmpVal.toLowerCase()) return false;
        } else if (rowVal !== cmpVal) return false;
      } else if (typeof cond === 'string') {
        if (row.projectName !== cond) return false;
      }
    }
  }
  return true;
}

// Each test gets its own prisma mock with its own copy of the data
// arrays — the updateMany mock mutates row state to verify the
// data-shape rewrite, so per-test isolation is required.
function makePrisma() {
  const projects = [
    {
      id: TARGET_UUID,
      name: TARGET_NAME,
      code: 'AT',
      isActive: true,
      createdById: ADMIN_ID,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  ];

  // 2 DPR rows for "T-NAGAR" (orphan, projectId=null) — must merge
  // 1 DPR row already pointing at TARGET_UUID via projectId — must NOT be touched (WHERE locks projectId:null)
  // 1 DPR row for a different project ("OTHER") — must NOT be touched
  const dprs = [
    { id: 'd1', projectId: null, projectName: 'T-NAGAR' },
    { id: 'd2', projectId: null, projectName: 'T-NAGAR' },
    { id: 'd3', projectId: TARGET_UUID, projectName: TARGET_NAME },
    { id: 'd4', projectId: null, projectName: 'OTHER' },
  ];
  const inspections = [
    { id: 'i1', projectId: null, projectName: 'T-NAGAR' },
  ];
  const boqs = [
    { id: 'b1', projectId: null, projectName: 'T-NAGAR' },
  ];

  return {
    project: {
      findUnique: jest.fn(async ({ where } = {}) =>
        projects.find((p) => p.id === where.id) || null
      ),
    },
    // requireFreshAdmin re-reads isAdmin from the DB on every mutation.
    // Return ADMIN_ID with isAdmin=true; non-admin tokens get the same
    // shape but isAdmin=false, which the middleware turns into 403.
    employee: {
      findUnique: jest.fn(async ({ where } = {}) => {
        if (where.id === ADMIN_ID) return { id: ADMIN_ID, isAdmin: true };
        if (where.id === USER_ID) return { id: USER_ID, isAdmin: false };
        return null;
      }),
    },
    dPR: {
      count: jest.fn(async ({ where } = {}) =>
        dprs.filter((r) => rowMatches(r, where || {})).length
      ),
      updateMany: jest.fn(async ({ where, data } = {}) => {
        const matched = dprs.filter((r) => rowMatches(r, where || {}));
        matched.forEach((r) => {
          r.projectId = data.projectId;
          r.projectName = data.projectName;
        });
        return { count: matched.length };
      }),
    },
    inspectionRecord: {
      count: jest.fn(async ({ where } = {}) =>
        inspections.filter((r) => rowMatches(r, where || {})).length
      ),
      updateMany: jest.fn(async ({ where, data } = {}) => {
        const matched = inspections.filter((r) => rowMatches(r, where || {}));
        matched.forEach((r) => {
          r.projectId = data.projectId;
          r.projectName = data.projectName;
        });
        return { count: matched.length };
      }),
    },
    boqItem: {
      count: jest.fn(async ({ where } = {}) =>
        boqs.filter((r) => rowMatches(r, where || {})).length
      ),
      updateMany: jest.fn(async ({ where, data } = {}) => {
        const matched = boqs.filter((r) => rowMatches(r, where || {}));
        matched.forEach((r) => {
          r.projectId = data.projectId;
          r.projectName = data.projectName;
        });
        return { count: matched.length };
      }),
    },
    $transaction: jest.fn(async (ops) => {
      const out = [];
      for (const op of ops) out.push(await op);
      return out;
    }),
  };
}

function buildApp(prisma) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.use('/api/projects', projectRouter);
  return app;
}

// ─── 1. dryRun preview ─────────────────────────────────────────────────────
describe('POST /api/projects/:targetId/merge-orphan-source — dryRun preview', () => {
  it('1. returns per-table counts without calling updateMany or $transaction', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post(`/api/projects/${TARGET_UUID}/merge-orphan-source`)
      .set('Authorization', adminJwt())
      .send({ sourceName: 'T-NAGAR', dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.counts).toEqual({ dpr: 2, inspection: 1, boq: 1 });
    expect(res.body.target).toEqual({ id: TARGET_UUID, name: TARGET_NAME });
    expect(res.body.sourceName).toBe('T-NAGAR');
    // The headline dryRun contract: no writes happen.
    expect(prisma.dPR.updateMany).not.toHaveBeenCalled();
    expect(prisma.inspectionRecord.updateMany).not.toHaveBeenCalled();
    expect(prisma.boqItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('2. case-insensitive match: lowercase source "t-nagar" matches "T-NAGAR" rows', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post(`/api/projects/${TARGET_UUID}/merge-orphan-source`)
      .set('Authorization', adminJwt())
      .send({ sourceName: 't-nagar', dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.counts.dpr).toBe(2);
  });

  it('3. empty result (count === 0) is still 200 — no rows match the source', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post(`/api/projects/${TARGET_UUID}/merge-orphan-source`)
      .set('Authorization', adminJwt())
      .send({ sourceName: 'NEVER-FILED', dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ dpr: 0, inspection: 0, boq: 0 });
    expect(res.body.total).toBe(0);
  });
});

// ─── 2. commit (dryRun omitted or false) ───────────────────────────────────
describe('POST /api/projects/:targetId/merge-orphan-source — commit', () => {
  it('4. updateMany is called on all 3 tables with BOTH projectId AND projectName in data', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post(`/api/projects/${TARGET_UUID}/merge-orphan-source`)
      .set('Authorization', adminJwt())
      .send({ sourceName: 'T-NAGAR' });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(false);
    expect(res.body.counts).toEqual({ dpr: 2, inspection: 1, boq: 1 });
    // AMENDMENT 2 — the BOTH-fields data shape. Without projectName the
    // KPI filter (exact match on Project.name) would miss the merged rows.
    const expectedWhere = {
      projectId: null,
      projectName: { equals: 'T-NAGAR', mode: 'insensitive' },
    };
    const expectedData = { projectId: TARGET_UUID, projectName: TARGET_NAME };
    expect(prisma.dPR.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedWhere, data: expectedData })
    );
    expect(prisma.inspectionRecord.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedWhere, data: expectedData })
    );
    expect(prisma.boqItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedWhere, data: expectedData })
    );
  });

  it('5. commit path is atomic — $transaction wraps all three updateMany calls', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    await request(app)
      .post(`/api/projects/${TARGET_UUID}/merge-orphan-source`)
      .set('Authorization', adminJwt())
      .send({ sourceName: 'T-NAGAR' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const arg = prisma.$transaction.mock.calls[0][0];
    expect(Array.isArray(arg)).toBe(true);
    expect(arg).toHaveLength(3);
  });

  it('6. data is mutated on the matched rows: projectId AND projectName both rewritten', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    // Capture the dprs array via the prisma mock's identity — we can't
    // peek inside `makePrisma`, so verify via the updateMany call args
    // and the response counts.
    const res = await request(app)
      .post(`/api/projects/${TARGET_UUID}/merge-orphan-source`)
      .set('Authorization', adminJwt())
      .send({ sourceName: 'T-NAGAR' });
    // 2 matched → counts.dpr === 2, and the data shape on the call
    // is { projectId: TARGET_UUID, projectName: 'T-Nagar' } — the
    // canonical-name rewrite is the contract.
    expect(res.body.counts.dpr).toBe(2);
    const callArgs = prisma.dPR.updateMany.mock.calls[0][0];
    expect(callArgs.data.projectName).toBe(TARGET_NAME);
    expect(callArgs.data.projectId).toBe(TARGET_UUID);
  });

  it('7. WHERE locks to projectId: null — rows already pointing at target are skipped', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    await request(app)
      .post(`/api/projects/${TARGET_UUID}/merge-orphan-source`)
      .set('Authorization', adminJwt())
      .send({ sourceName: 'T-NAGAR', dryRun: true });
    // The dryRun path goes through count() — verify the lock is in place.
    expect(prisma.dPR.count).toHaveBeenCalled();
    const whereArgs = prisma.dPR.count.mock.calls[0][0];
    expect(whereArgs.where.projectId).toBe(null);
  });

  it('8. empty result (count === 0) returns 200 with zeros — data-safe concurrent merge', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post(`/api/projects/${TARGET_UUID}/merge-orphan-source`)
      .set('Authorization', adminJwt())
      .send({ sourceName: 'NEVER-FILED' });
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ dpr: 0, inspection: 0, boq: 0 });
    expect(res.body.total).toBe(0);
    // Still runs through $transaction (3 updateManys with 0 matches each).
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

// ─── 3. validation & auth ──────────────────────────────────────────────────
describe('POST /api/projects/:targetId/merge-orphan-source — validation', () => {
  it('9. 400 when sourceName is missing', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post(`/api/projects/${TARGET_UUID}/merge-orphan-source`)
      .set('Authorization', adminJwt())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('10. 400 when sourceName is whitespace only', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post(`/api/projects/${TARGET_UUID}/merge-orphan-source`)
      .set('Authorization', adminJwt())
      .send({ sourceName: '   ' });
    expect(res.status).toBe(400);
  });

  it('11. 400 when targetId is not a UUID', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/projects/not-a-uuid/merge-orphan-source')
      .set('Authorization', adminJwt())
      .send({ sourceName: 'T-NAGAR' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/UUID/i);
  });

  it('12. 404 when target project does not exist', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post(`/api/projects/${MISSING_UUID}/merge-orphan-source`)
      .set('Authorization', adminJwt())
      .send({ sourceName: 'T-NAGAR' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PROJECT_NOT_FOUND');
  });

  it('13. 409 SAME_PROJECT when sourceName case-insensitive equals target.name', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post(`/api/projects/${TARGET_UUID}/merge-orphan-source`)
      .set('Authorization', adminJwt())
      .send({ sourceName: 'alpha towers' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SAME_PROJECT');
  });

  it('14. 403 when caller is not an admin (requireFreshAdmin)', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post(`/api/projects/${TARGET_UUID}/merge-orphan-source`)
      .set('Authorization', userJwt())
      .send({ sourceName: 'T-NAGAR' });
    expect(res.status).toBe(403);
  });

  it('15. 401 when no Authorization header is sent', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post(`/api/projects/${TARGET_UUID}/merge-orphan-source`)
      .send({ sourceName: 'T-NAGAR' });
    expect(res.status).toBe(401);
  });
});
