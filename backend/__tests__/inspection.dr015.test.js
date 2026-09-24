// SOL DR-015 — Name-only inspection queries must be scoped to the
// caller's authorized projects.
//
// Audit evidence (lines 250-260 of the fresh24 audit): the inspection
// list endpoint at backend/src/routes/inspection.js:992-1006 extracted
// `projectNameFilter` from the query string but silently dropped it from
// the where clause. ProjectExpandedPanel.jsx sends `projectName` (free-
// text) for discovered / unregistered projects, so an admin visiting a
// discovered project saw every inspection in the system that matched
// the other filters — including rows from similarly-named sites they
// weren't allocated to. Two scopes leaked:
//   1. Substring "Tower" pulled in "Tower Annex" / "Tower B" rows.
//   2. Records from another site sharing a project name ("Phase II")
//      showed up under the wrong site.
//
// Fix (inspection.js:998-1070):
//   1. projectName filter applied to the where clause (exact, case-
//      insensitive match).
//   2. Admin → no extra scope (already sees all).
//      Employee → intersect with ProjectAssignment.employeeId, matching
//      BOTH the curated FK (projectId is set) AND legacy typed-name
//      rows (projectId IS NULL, projectName matches a curated
//      Project.name on the roster).
//   3. UUID precedence preserved — projectId wins when both supplied.
//   4. Employee with no assignments → empty result for any name filter
//      (was previously: silently show all).
//
// This file mounts the real route and stubs Prisma with an in-memory
// store; assertions cover the WHERE shape (proves scoping) AND the
// response body (proves the route doesn't drop or duplicate records).

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

// Stub R2 surface so the route module loads without contacting cloud
// services. Same pattern as inspection.dr005.test.js.
jest.mock('../src/lib/blobStorage', () => ({
  generateReadSASUrl: jest.fn(async () => ({ sasUrl: 'https://r2.example/sas' })),
  generateUploadSASUrl: jest.fn(),
  verifyBlobExists: jest.fn(async () => ({ exists: true })),
  deleteBlob: jest.fn(async () => ({})),
  CONTENT_TYPE_EXT: { 'image/jpeg': 'jpg', 'image/png': 'png' },
  uploadIntentBinding: { bindPhotoIntents: jest.fn(async () => null) },
}));

const inspectionRouter = require('../src/routes/inspection');

// Two projects. The employee is assigned ONLY to "Site Alpha" — not to
// "Site Beta" or "Site Alpha Annex". A substring filter "Site" must NOT
// surface rows from Beta or Alpha Annex.
const PROJ_ALPHA = { id: 'proj-alpha', name: 'Site Alpha' };
const PROJ_BETA = { id: 'proj-beta', name: 'Site Beta' };
const PROJ_ALPHA_ANNEX = { id: 'proj-alpha-annex', name: 'Site Alpha Annex' };

const EMPLOYEE_ID = 'emp-dr015-employee';
const ADMIN_ID = 'emp-dr015-admin';

// 6 deterministic records — two per project, plus one legacy typed-name
// row for each site (projectId IS NULL, projectName is the typed name).
const baseRecords = [
  { id: 'rec-alpha-1', projectId: PROJ_ALPHA.id, projectName: 'Site Alpha' },
  { id: 'rec-alpha-2', projectId: PROJ_ALPHA.id, projectName: 'Site Alpha' },
  { id: 'rec-beta-1', projectId: PROJ_BETA.id, projectName: 'Site Beta' },
  { id: 'rec-beta-2', projectId: PROJ_BETA.id, projectName: 'Site Beta' },
  { id: 'rec-annex-1', projectId: PROJ_ALPHA_ANNEX.id, projectName: 'Site Alpha Annex' },
  { id: 'rec-annex-2', projectId: PROJ_ALPHA_ANNEX.id, projectName: 'Site Alpha Annex' },
  // Legacy rows: projectId null, free-text projectName. "Site Alpha
  // Legacy" was typed before curation, then promoted to PROJ_ALPHA. The
  // denormalized column retained the typed value.
  { id: 'rec-legacy-alpha', projectId: null, projectName: 'Site Alpha' },
  { id: 'rec-legacy-beta', projectId: null, projectName: 'Site Beta' },
];

// Mirror Prisma's filter semantics on the in-memory store.
function applyWhere(rows, where = {}) {
  let out = rows;

  // submittedById (already restrictToSelf — only relevant for admin
  // when my=true).
  if (where.submittedById) {
    const id = where.submittedById;
    out = out.filter((r) => recordsByEmp[id]?.has(r.id));
  }

  if (where.projectId) {
    out = out.filter((r) => r.projectId === where.projectId);
  }

  // projectName at the top level — used by the admin branch.
  if (where.projectName && !where.AND) {
    const f = where.projectName;
    if (f.equals) {
      out = out.filter((r) => r.projectName.toLowerCase() === String(f.equals).toLowerCase());
    } else if (f.contains) {
      out = out.filter((r) => r.projectName.toLowerCase().includes(String(f.contains).toLowerCase()));
    } else if (f.in) {
      const set = new Set(f.in.map((v) => String(v).toLowerCase()));
      out = out.filter((r) => set.has(r.projectName.toLowerCase()));
    }
  }

  // [DR-015] AND + OR wrapper used by the employee branch.
  if (where.AND) {
    out = where.AND.reduce((acc, clause) => applyWhere(acc, clause), out);
  }
  if (where.OR) {
    out = out.filter((r) => where.OR.some((clause) => applyWhere([r], clause).length > 0));
  }

  return out;
}

// Tracks which records were filed by which employee for restrictToSelf.
const recordsByEmp = {
  [ADMIN_ID]: new Set(baseRecords.map((r) => r.id)),
  [EMPLOYEE_ID]: new Set(['rec-alpha-1', 'rec-alpha-2', 'rec-legacy-alpha']),
};

let lastFindManyWhere = null;

function buildApp({ isAdmin = false, employeeId = EMPLOYEE_ID } = {}) {
  const app = express();
  app.use(express.json());

  // Employee is assigned ONLY to Site Alpha.
  const assignments = isAdmin ? [] : [{ projectId: PROJ_ALPHA.id }];

  const prisma = {
    inspectionRecord: {
      findMany: async (args) => {
        lastFindManyWhere = args.where || {};
        const where = { ...args.where };
        if (where.submittedById && !recordsByEmp[where.submittedById]) {
          return [];
        }
        const out = applyWhere(baseRecords, where);
        // Sort + take to mirror inspection.js:1103-1104.
        out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
        const take = typeof args.take === 'number' ? args.take : out.length;
        return out.slice(0, take);
      },
    },
    employee: {
      findUnique: async () => ({ id: employeeId, isAdmin }),
    },
    project: {
      findMany: async ({ where: w } = {}) => {
        // Only the names of curated projects the employee is assigned to.
        let pool = [PROJ_ALPHA, PROJ_BETA, PROJ_ALPHA_ANNEX];
        if (w && w.id && w.id.in) {
          const allowed = new Set(w.id.in);
          pool = pool.filter((p) => allowed.has(p.id));
        }
        return pool.map((p) => ({ name: p.name }));
      },
    },
    projectAssignment: {
      findMany: async () => assignments.map((a) => ({ projectId: a.projectId })),
    },
  };

  app.set('prisma', prisma);
  app.use('/api/inspection', inspectionRouter);
  return app;
}

function authHeader(employeeId, isAdmin = false) {
  const token = jwt.sign(
    { employeeId, email: `${employeeId}@example.com`, isAdmin },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  );
  return `Bearer ${token}`;
}

describe('SOL DR-015 — name-only inspection queries are scoped to authorized projects', () => {
  beforeEach(() => {
    lastFindManyWhere = null;
  });

  test('A1. admin filtering by projectName="Site Alpha" → finds across all sites', async () => {
    // Admin is unconstrained — the projectName filter must be applied
    // (no more silent drop) but no ProjectAssignment scope is added.
    const app = buildApp({ isAdmin: true, employeeId: ADMIN_ID });
    const res = await request(app)
      .get('/api/inspection?projectName=Site%20Alpha')
      .set('Authorization', authHeader(ADMIN_ID, true));

    expect(res.status).toBe(200);
    // Site Alpha + Site Alpha Legacy (projectId=null, projectName="Site Alpha").
    // NOT Site Beta, NOT Site Alpha Annex (substring bleed prevention).
    const ids = res.body.inspections.map((r) => r.id).sort();
    expect(ids).toEqual(['rec-alpha-1', 'rec-alpha-2', 'rec-legacy-alpha'].sort());
    // WHERE shape: exact-match projectName, no AND/OR wrapper.
    expect(lastFindManyWhere.projectName).toEqual({
      equals: 'Site Alpha',
      mode: 'insensitive',
    });
    expect(lastFindManyWhere.AND).toBeUndefined();
    expect(lastFindManyWhere.OR).toBeUndefined();
  });

  test('A2. admin exact-match — substring "Site" does NOT pull "Site Alpha Annex" rows', async () => {
    // The audit called out substring bleed ("Tower" → "Tower Annex").
    // Exact match + the equals filter shape closes that vector for
    // admins too.
    const app = buildApp({ isAdmin: true, employeeId: ADMIN_ID });
    const res = await request(app)
      .get('/api/inspection?projectName=Site')
      .set('Authorization', authHeader(ADMIN_ID, true));

    expect(res.status).toBe(200);
    const ids = res.body.inspections.map((r) => r.id).sort();
    expect(ids).toEqual([]); // exact-match: no row has projectName === "Site"
  });

  test('A3. admin exact-match — "Site Alpha" still excludes "Site Alpha Annex"', async () => {
    // Confirms equals (not contains) is the wire shape — Annex is a
    // distinct curated project whose name is a strict superset.
    const app = buildApp({ isAdmin: true, employeeId: ADMIN_ID });
    const res = await request(app)
      .get('/api/inspection?projectName=Site%20Alpha')
      .set('Authorization', authHeader(ADMIN_ID, true));

    expect(res.status).toBe(200);
    const ids = res.body.inspections.map((r) => r.id).sort();
    expect(ids).not.toContain('rec-annex-1');
    expect(ids).not.toContain('rec-annex-2');
  });

  test('E1. employee filtering by own assigned projectName → sees those records', async () => {
    // Employee is assigned to Site Alpha. The name filter must include
    // both curated (projectId set) and legacy typed-name rows (projectId
    // null) on the roster.
    const app = buildApp({ isAdmin: false, employeeId: EMPLOYEE_ID });
    const res = await request(app)
      .get('/api/inspection?projectName=Site%20Alpha')
      .set('Authorization', authHeader(EMPLOYEE_ID, false));

    expect(res.status).toBe(200);
    // Submitted-by-self + name + assigned-scope. Only the employee's own
    // records (restrictToSelf) survive: rec-alpha-1, rec-alpha-2,
    // rec-legacy-alpha.
    const ids = res.body.inspections.map((r) => r.id).sort();
    expect(ids).toEqual(['rec-alpha-1', 'rec-alpha-2', 'rec-legacy-alpha'].sort());

    // WHERE shape: AND-merged name + assigned-scope.
    expect(lastFindManyWhere.AND).toBeDefined();
    expect(lastFindManyWhere.AND[0]).toEqual({
      projectName: { equals: 'Site Alpha', mode: 'insensitive' },
    });
    // OR clause: assignedIds OR (projectId null AND assignedNames).
    expect(lastFindManyWhere.AND[1].OR).toEqual([
      { projectId: { in: [PROJ_ALPHA.id] } },
      { projectId: null, projectName: { in: ['Site Alpha'], mode: 'insensitive' } },
    ]);
  });

  test('E2. employee filtering by unassigned projectName → sees no records', async () => {
    // The audit acceptance: "An empty project A shows no inspections
    // from project B". Here Site Beta exists with records, but the
    // employee is NOT assigned to it — must return [].
    const app = buildApp({ isAdmin: false, employeeId: EMPLOYEE_ID });
    const res = await request(app)
      .get('/api/inspection?projectName=Site%20Beta')
      .set('Authorization', authHeader(EMPLOYEE_ID, false));

    expect(res.status).toBe(200);
    expect(res.body.inspections).toEqual([]);
    // Still sent the AND-wrapped filter (so Prisma has the chance to
    // short-circuit on the name predicate).
    expect(lastFindManyWhere.AND).toBeDefined();
    expect(lastFindManyWhere.AND[0]).toEqual({
      projectName: { equals: 'Site Beta', mode: 'insensitive' },
    });
  });

  test('E3. employee with no ProjectAssignment rows → empty result, no leak', async () => {
    // Build an app where the employee has zero assignments — must still
    // see no rows for a name filter (the audit called this out as
    // "silently show all" before the fix).
    const app = express();
    app.use(express.json());
    app.set('prisma', {
      inspectionRecord: {
        findMany: async (args) => {
          lastFindManyWhere = args.where || {};
          return applyWhere(baseRecords, args.where || {});
        },
      },
      employee: {
        findUnique: async () => ({ id: EMPLOYEE_ID, isAdmin: false }),
      },
      project: {
        findMany: async () => [],
      },
      projectAssignment: {
        findMany: async () => [],
      },
    });
    app.use('/api/inspection', inspectionRouter);

    const res = await request(app)
      .get('/api/inspection?projectName=Site%20Alpha')
      .set('Authorization', authHeader(EMPLOYEE_ID, false));

    expect(res.status).toBe(200);
    expect(res.body.inspections).toEqual([]);
    // OR clause is the empty array — Prisma interprets this as
    // match-nothing so the outer AND yields zero rows.
    expect(lastFindManyWhere.AND[1].OR).toEqual([]);
  });

  test('U1. projectId takes precedence — UUID wins, nameScopeWhere skipped', async () => {
    // When both projectId and projectName are supplied, the curated FK
    // is the canonical identity. The name filter is NOT applied.
    const app = buildApp({ isAdmin: false, employeeId: EMPLOYEE_ID });
    const res = await request(app)
      .get(`/api/inspection?projectId=${PROJ_ALPHA.id}&projectName=Site%20Beta`)
      .set('Authorization', authHeader(EMPLOYEE_ID, false));

    expect(res.status).toBe(200);
    expect(lastFindManyWhere.projectId).toBe(PROJ_ALPHA.id);
    // nameScopeWhere was NOT added — UUID precedence preserved.
    expect(lastFindManyWhere.AND).toBeUndefined();
    // submittedById from restrictToSelf is still pinned.
    expect(lastFindManyWhere.submittedById).toBe(EMPLOYEE_ID);
  });

  test('U2. blank projectName query param → no name filter applied', async () => {
    // ?projectName= (empty string) should NOT trigger the name filter.
    const app = buildApp({ isAdmin: false, employeeId: EMPLOYEE_ID });
    const res = await request(app)
      .get('/api/inspection?projectName=')
      .set('Authorization', authHeader(EMPLOYEE_ID, false));

    expect(res.status).toBe(200);
    expect(lastFindManyWhere.AND).toBeUndefined();
    expect(lastFindManyWhere.projectName).toBeUndefined();
  });
});
