/**
 * Fresh24 DR-014 — Registering a discovered project must retain access to
 * its prior unresolved history.
 *
 * Audit verdict (ACS-Portal-Fresh-Product-Audit-2026-09-24-71f183a.md
 * lines 238-248): "Registration creates the project master/roster without
 * linking matching null-project-ID history. Discovery then hides the
 * name, and the panel switches to UUID queries that exclude those old
 * records. Same-name merge rejects the recovery attempt."
 *
 * The fix: when POST /api/projects/resolve creates a NEW Project row,
 * the create + three updateManys (DPR / InspectionRecord / BoqItem) run
 * inside a single $transaction. WHERE locks to { projectId: null,
 * projectName: { equals, mode: 'insensitive' } } so already-linked rows
 * are NEVER touched (idempotent re-run + safe same-name recovery).
 *
 * Acceptance ("Registering a discovered project retains access to its
 * prior records and cannot pull unrelated similarly named or already-
 * linked records into it."):
 *   1. Create branch re-links DPR / InspectionRecord / BoqItem rows with
 *      { projectId: null, projectName: case-insensitive match } → new
 *      Project row. The data shape rewrites BOTH projectId AND
 *      projectName (same hook as merge-orphan-source's AMENDMENT 2 —
 *      the KPI exact-name filter would otherwise miss the just-linked
 *      rows).
 *   2. Rows already pointing at any project (projectId set) are NEVER
 *      touched — the WHERE shape locks to projectId: null.
 *   3. Rows with a DIFFERENT projectName are NEVER touched — case-
 *      insensitive name match.
 *   4. dryRun: true returns per-table counts WITHOUT creating the
 *      Project or calling updateMany. "Do not call mutating /resolve
 *      merely to browse" — DR-014 minimal-implementation line.
 *   5. The whole promotion is atomic — a $transaction wraps the create
 *      and the three updateManys so a partial failure rolls back the
 *      Project create.
 *   6. Existing-branch behaviour is unchanged — a name that already
 *      resolves to a curated row returns the existing row, no orphan
 *      re-link (the audit brief scopes the fix to NEW registrations).
 *   7. Validation: missing name → 400; same-name existing → 200 with
 *      existing row (no mutation).
 *
 * Pattern mirrors projects.merge-orphan-source.test.js — own prisma mock
 * builder, no shared helpers.
 *
 * NOTE: this file deliberately does NOT clobber the pre-existing
 * `projects.dr014.test.js` (which pins a different DR-014 — the
 * pendingReviewCount drill contract from the readiness round). The
 * Fresh24 audit uses the same DR number for a different finding; the
 * distinct filename keeps both contracts testable in isolation.
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

// Each test gets its own prisma mock with its own data arrays so the
// updateMany mock mutating row state can't bleed across tests.
function makePrisma() {
  const projects = [];
  // Fixture: 2 DPRs + 1 InspectionRecord + 1 BoqItem for "T-NAGAR"
  // (orphan, projectId=null) — must be re-linked on commit.
  // Plus 1 DPR already pointing at another project — must NOT be touched.
  // Plus 1 DPR with a different projectName ("OTHER") — must NOT be touched.
  const dprs = [
    { id: 'd1', projectId: null, projectName: 'T-NAGAR' },
    { id: 'd2', projectId: null, projectName: 'T-NAGAR' },
    { id: 'd3', projectId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', projectName: 'Alpha Towers' },
    { id: 'd4', projectId: null, projectName: 'OTHER' },
  ];
  const inspections = [
    { id: 'i1', projectId: null, projectName: 'T-NAGAR' },
    { id: 'i2', projectId: null, projectName: 'OTHER' },
  ];
  const boqs = [
    { id: 'b1', projectId: null, projectName: 'T-NAGAR' },
  ];

  // The mock surfaces — split into named handles so the $transaction
  // closure below can capture them (the returned object is constructed
  // AFTER the closures are defined, so referencing it by name inside
  // those closures would ReferenceError).
  const projectHandle = {
    // No curated rows for "T-Nagar" yet — findFirst returns null,
    // which sends /resolve down the create branch.
    findFirst: jest.fn(async () => null),
    // The transactional create — capture the request and add it to
    // `projects` so a second findFirst (race recovery on P2002) can
    // see it.
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
  // requireFreshAdmin re-reads isAdmin from the DB on every mutation.
  // /resolve isn't requireFreshAdmin (any-auth), but the mock keeps
  // the surface consistent with other route tests in the suite.
  const employeeHandle = {
    findUnique: jest.fn(async ({ where } = {}) => {
      if (where.id === ADMIN_ID) return { id: ADMIN_ID, isAdmin: true };
      if (where.id === USER_ID) return { id: USER_ID, isAdmin: false };
      return null;
    }),
  };
  const dprHandle = {
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
  };
  const inspectionHandle = {
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
  };
  const boqHandle = {
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
  };

  // $transaction with a callback — mirror the route's commit shape.
  // tx.<model>.<op> calls are forwarded to the SAME jest.fn instances
  // the top-level handle exposes, so the route's tx.dPR.updateMany
  // call lands on the dprHandle.updateMany mock — mock-call counters
  // + assertions across the test surface stay consistent.
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
    employee: employeeHandle,
    dPR: dprHandle,
    inspectionRecord: inspectionHandle,
    boqItem: boqHandle,
    $transaction: transactionHandle,
    _internal: { projects, dprs, inspections, boqs },
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
describe('POST /api/projects/resolve — dryRun preview (DR-014)', () => {
  it('1. dryRun: true returns per-table counts without creating the Project or calling updateMany', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/projects/resolve')
      .set('Authorization', userJwt())
      .send({ name: 'T-NAGAR', dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.name).toBe('T-NAGAR');
    expect(res.body.counts).toEqual({ dpr: 2, inspection: 1, boq: 1 });
    expect(res.body.total).toBe(4);
    // Headline contract: no writes happen during preview.
    expect(prisma.project.create).not.toHaveBeenCalled();
    expect(prisma.dPR.updateMany).not.toHaveBeenCalled();
    expect(prisma.inspectionRecord.updateMany).not.toHaveBeenCalled();
    expect(prisma.boqItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('2. dryRun: true uses case-insensitive name match', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/projects/resolve')
      .set('Authorization', userJwt())
      .send({ name: 't-nagar', dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.counts.dpr).toBe(2);
  });

  it('3. dryRun: empty cohort is 200 with zeros — no rows match the source', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/projects/resolve')
      .set('Authorization', userJwt())
      .send({ name: 'NEVER-FILED', dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ dpr: 0, inspection: 0, boq: 0 });
    expect(res.body.total).toBe(0);
    expect(prisma.project.create).not.toHaveBeenCalled();
  });
});

// ─── 2. commit (dryRun omitted or false) ───────────────────────────────────
describe('POST /api/projects/resolve — transactional commit (DR-014)', () => {
  it('4. commit creates the Project AND atomically re-links orphans via $transaction', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/projects/resolve')
      .set('Authorization', userJwt())
      .send({ name: 'T-NAGAR' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(NEW_PROJECT_ID);
    expect(res.body.name).toBe('T-NAGAR');
    expect(res.body.isRegistered).toBe(true);
    expect(res.body.linkedCounts).toEqual({ dpr: 2, inspection: 1, boq: 1 });
    expect(res.body.linkedTotal).toBe(4);
    // The atomicity hook — create + three updateManys run inside one tx.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][0]).toBeInstanceOf(Function);
    // All four writes did happen.
    expect(prisma.project.create).toHaveBeenCalledTimes(1);
    expect(prisma.dPR.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.inspectionRecord.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.boqItem.updateMany).toHaveBeenCalledTimes(1);
  });

  it('5. commit data shape rewrites BOTH projectId AND projectName on the orphan cohort', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    await request(app)
      .post('/api/projects/resolve')
      .set('Authorization', userJwt())
      .send({ name: 'T-NAGAR' });
    const expectedWhere = {
      projectId: null,
      projectName: { equals: 'T-NAGAR', mode: 'insensitive' },
    };
    const expectedData = { projectId: NEW_PROJECT_ID, projectName: 'T-NAGAR' };
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

  it('6. commit DOES NOT touch rows whose projectId is already set', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    await request(app)
      .post('/api/projects/resolve')
      .set('Authorization', userJwt())
      .send({ name: 'T-NAGAR' });
    // The updateMany WHERE locks to projectId: null — the
    // Alpha Towers DPR (projectId set) must not be in the matched set.
    const callArgs = prisma.dPR.updateMany.mock.calls[0][0];
    expect(callArgs.where.projectId).toBe(null);
    // Mock returns count=2 (only the two T-NAGAR orphans); the Alpha
    // Towers row is structurally excluded by the WHERE shape.
    expect(callArgs).toEqual(expect.objectContaining({
      where: {
        projectId: null,
        projectName: { equals: 'T-NAGAR', mode: 'insensitive' },
      },
    }));
  });

  it('7. commit DOES NOT touch rows with a different projectName', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/projects/resolve')
      .set('Authorization', userJwt())
      .send({ name: 'T-NAGAR' });
    // The OTHER inspection is excluded by the case-insensitive name
    // match — linkedCounts.inspection === 1, not 2.
    expect(res.body.linkedCounts).toEqual({ dpr: 2, inspection: 1, boq: 1 });
    // linkedTotal reflects only the T-NAGAR cohort.
    expect(res.body.linkedTotal).toBe(4);
  });

  it('8. empty cohort (no orphans) still commits — Project created with linkedCounts = zeros', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/projects/resolve')
      .set('Authorization', userJwt())
      .send({ name: 'NEVER-FILED' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(NEW_PROJECT_ID);
    expect(res.body.linkedCounts).toEqual({ dpr: 0, inspection: 0, boq: 0 });
    expect(res.body.linkedTotal).toBe(0);
    // updateManys still run inside the transaction (zero matches each).
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

// ─── 3. existing-branch (DR-014 scopes the fix to NEW registrations) ──────
describe('POST /api/projects/resolve — existing-branch is unchanged (DR-014)', () => {
  it('9. existing Project row → returns existing project, NO re-link on this branch', async () => {
    // Build a prisma where findFirst returns an existing curated row.
    const existingId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const prisma = makePrisma();
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
    // The headline contract: the existing branch does NOT mutate
    // orphans. The audit brief scopes the fix to NEW registrations —
    // silently re-linking every time the picker resolves a known name
    // is exactly the "silently granting project membership" behaviour
    // the counters rejected.
    expect(prisma.project.create).not.toHaveBeenCalled();
    expect(prisma.dPR.updateMany).not.toHaveBeenCalled();
    expect(prisma.inspectionRecord.updateMany).not.toHaveBeenCalled();
    expect(prisma.boqItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

// ─── 4. validation & auth ──────────────────────────────────────────────────
describe('POST /api/projects/resolve — validation', () => {
  it('10. 400 when name is missing', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/projects/resolve')
      .set('Authorization', userJwt())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('11. 400 when name is whitespace only', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/projects/resolve')
      .set('Authorization', userJwt())
      .send({ name: '   ' });
    expect(res.status).toBe(400);
  });

  it('12. 401 when no Authorization header is sent', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/projects/resolve')
      .send({ name: 'T-NAGAR' });
    expect(res.status).toBe(401);
  });
});
