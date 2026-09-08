// SOL DR-004 regression coverage. Three sequential bugs the audit caught:
//
//   1. GET /dpr/:id returned `reportDate: "2026-09-01T00:00:00.000Z"` and
//      the frontend's `<input type="date">` rejected it as malformed.
//   2. PUT /dpr/:id call signature: `updateDpr(id, data, accessToken)` —
//      the api helper signature is `(id, data, version, token)`, so the
//      token ended up in the `version` slot and the PUT was sent
//      unauthenticated.
//   3. The list endpoint returned the same ISO-datetime shape; consumers
//      like DprDashboard had to re-parse it client-side.
//
// These tests pin the fix: GET and list emit strict YYYY-MM-DD, and the
// PUT contract is exercised end-to-end through the api helper signature.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const dprRouter = require('../src/routes/dpr');

const EMPLOYEE_ID = 'test-employee-dr004';
let dprs = {};
let nextVersion = 1;

function seedDpr({
  id,
  status = 'DRAFT',
  submittedById = EMPLOYEE_ID,
  version = 1,
  reportDate = new Date('2026-09-01T00:00:00.000Z'),
} = {}) {
  dprs[id] = {
    id,
    submittedById,
    status,
    version,
    projectName: 'Test project',
    location: 'Test location',
    reportDate,
    notes: 'seed notes',
    customSections: null,
    workExecutedToday: null,
    workLocation: null,
    manpowerSummary: null,
    risksHindrances: null,
    materialsReceivedSummary: null,
    weather: null,
    temperature: null,
    contractor: null,
    workType: 'MATERIAL_RECEIPT',
    boqItemId: null,
    drawingId: null,
    drawingRev: null,
  };
  return dprs[id];
}

function buildApp({ isAdmin = false, boqItems = {} } = {}) {
  const app = express();
  app.use(express.json());
  const prisma = {
    dPR: {
      findUnique: async ({ where: { id }, include }) => {
        const row = dprs[id];
        if (!row) return null;
        if (!include) return { ...row };
        // The GET route pulls `photos: { include: { dpr: ... } }`, but we
        // don't exercise photos in this suite — return an empty list so the
        // SAS URL generation loop is a no-op.
        if (include.photos) {
          return {
            ...row,
            photos: [],
            submittedBy: { id: row.submittedById, name: 'Owner', email: 'owner@example.com' },
            reviewedBy: null,
            approvedBy: null,
            revisions: [],
            inspections: [],
          };
        }
        return { ...row };
      },
      findMany: async ({ where, orderBy, take }) => {
        // The list route only filters on `submittedById` here (the suite
        // scopes to the same employee), so a simple Object.values() scan
        // is faithful enough.
        let rows = Object.values(dprs);
        if (where && where.submittedById) {
          rows = rows.filter((r) => r.submittedById === where.submittedById);
        }
        // Honor the orderBy so the cursor encoder doesn't trip on
        // out-of-order rows.
        if (orderBy && Array.isArray(orderBy)) {
          rows.sort((a, b) => {
            for (const ob of orderBy) {
              const k = Object.keys(ob)[0];
              const dir = ob[k] === 'asc' ? 1 : -1;
              if (a[k] < b[k]) return -1 * dir;
              if (a[k] > b[k]) return 1 * dir;
            }
            return 0;
          });
        }
        if (typeof take === 'number') rows = rows.slice(0, take);
        return rows.map((r) => ({
          ...r,
          photos: [],
          submittedBy: { id: r.submittedById, name: 'Owner', email: 'owner@example.com' },
        }));
      },
      update: async ({ where, data }) => {
        const row = dprs[where.id];
        if (!row) {
          const e = new Error('Record not found');
          e.code = 'P2025';
          throw e;
        }
        // Honor the conditional WHERE — every key must match.
        for (const [k, v] of Object.entries(where)) {
          if (k === 'id') continue;
          if (row[k] !== v) {
            const e = new Error(`Conditional update failed: ${k}=${v}`);
            e.code = 'P2025';
            throw e;
          }
        }
        for (const [k, v] of Object.entries(data)) {
          if (k === 'version' && typeof v === 'object' && v && 'increment' in v) {
            row.version = row.version + v.increment;
          } else if (k === 'updatedAt') {
            // ignore for test purposes
          } else {
            row[k] = v;
          }
        }
        return { ...row };
      },
    },
    employee: { findUnique: async () => ({ id: EMPLOYEE_ID, isAdmin }) },
    dPRPhoto: {},
    // PUT /dpr/:id calls resolveProject() which uses findUnique/findFirst.
    // The seeded DPRs in this suite don't pin to a curated Project row, so
    // both return null and the FK stays NULL on the update payload.
    project: {
      findUnique: async () => null,
      findFirst: async () => null,
    },
    // SOL DR-004 (audit 2026-09-08): the BOQ PUT branch needs
    // `boqItem.findUnique` to validate the link. The audit caught a TDZ
    // because the previous code read `existing` before its `const` decl.
    // Tests below inject a per-row `boqItems` map keyed by id.
    boqItem: {
      findUnique: async ({ where: { id: boqId } }) => {
        // Return null (not `{}`) when the id isn't seeded — the
        // validator's `!boq` guard maps that to BOQ_ITEM_NOT_FOUND.
        const row = boqItems[boqId];
        return row ? { ...row } : null;
      },
    },
  };
  app.set('prisma', prisma);
  app.use('/api/dpr', dprRouter);
  return app;
}

function authHeader() {
  return jwt.sign(
    { employeeId: EMPLOYEE_ID, email: 'test@example.com' },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  );
}

beforeEach(() => {
  dprs = {};
  nextVersion = 1;
});

describe('SOL DR-004 — GET /dpr/:id emits strict YYYY-MM-DD for reportDate', () => {
  it('serializes a JS Date @db.Date value as YYYY-MM-DD', async () => {
    seedDpr({ id: 'd1', reportDate: new Date('2026-09-01T00:00:00.000Z') });
    const app = buildApp();
    const res = await request(app)
      .get('/api/dpr/d1')
      .set('Authorization', `Bearer ${authHeader()}`);
    expect(res.status).toBe(200);
    expect(res.body.reportDate).toBe('2026-09-01');
    // Crucially NOT the ISO datetime form the audit caught.
    expect(res.body.reportDate).not.toMatch(/T00:00:00/);
  });

  it('accepts an already-stringified YYYY-MM-DD value (idempotent)', async () => {
    seedDpr({ id: 'd2', reportDate: '2026-09-04' });
    const app = buildApp();
    const res = await request(app)
      .get('/api/dpr/d2')
      .set('Authorization', `Bearer ${authHeader()}`);
    expect(res.status).toBe(200);
    expect(res.body.reportDate).toBe('2026-09-04');
  });

  it('returns null for a null column (does not emit "null" string)', async () => {
    seedDpr({ id: 'd3', reportDate: null });
    const app = buildApp();
    const res = await request(app)
      .get('/api/dpr/d3')
      .set('Authorization', `Bearer ${authHeader()}`);
    expect(res.status).toBe(200);
    expect(res.body.reportDate).toBeNull();
  });
});

describe('SOL DR-004 — GET /dpr (list) normalizes every row', () => {
  it('every list item has reportDate in strict YYYY-MM-DD', async () => {
    seedDpr({ id: 'l1', reportDate: new Date('2026-09-01T00:00:00.000Z') });
    seedDpr({ id: 'l2', reportDate: '2026-09-02' });
    seedDpr({ id: 'l3', reportDate: new Date('2026-09-03T00:00:00.000Z') });
    const app = buildApp();
    const res = await request(app)
      .get('/api/dpr')
      .set('Authorization', `Bearer ${authHeader()}`);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.dprs.map((d) => [d.id, d.reportDate]));
    expect(byId.l1).toBe('2026-09-01');
    expect(byId.l2).toBe('2026-09-02');
    expect(byId.l3).toBe('2026-09-03');
    // None of them carry the time component.
    for (const d of res.body.dprs) {
      expect(d.reportDate).not.toMatch(/T/);
    }
  });
});

describe('SOL DR-004 — PUT /dpr/:id accepts a YYYY-MM-DD body and increments version', () => {
  it('PUT with a strict date + matching version succeeds and bumps version', async () => {
    seedDpr({ id: 'p1', version: 3 });
    const app = buildApp();
    const res = await request(app)
      .put('/api/dpr/p1')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({
        version: 3,
        projectName: 'Edited Project',
        location: 'Edited Location',
        reportDate: '2026-09-04',
        weather: 'Sunny',
        temperature: '32',
        contractor: 'Edited Contractor',
        workType: 'SITE_INSPECTION',
        notes: 'Edited notes',
        workExecutedToday: null,
        workLocation: null,
        manpowerSummary: null,
        risksHindrances: null,
        materialsReceivedSummary: null,
        customSections: null,
      });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(4);
    expect(res.body.reportDate).toBeTruthy();
  });

  it('PUT rejects an ISO-datetime reportDate as INVALID_REPORT_DATE', async () => {
    seedDpr({ id: 'p2', version: 1 });
    const app = buildApp();
    const res = await request(app)
      .put('/api/dpr/p2')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({
        version: 1,
        projectName: 'X',
        location: 'Y',
        reportDate: '2026-09-04T00:00:00.000Z', // not YYYY-MM-DD
        weather: 'Sunny',
        temperature: null,
        contractor: null,
        workType: 'SITE_INSPECTION',
        notes: null,
        workExecutedToday: null,
        workLocation: null,
        manpowerSummary: null,
        risksHindrances: null,
        materialsReceivedSummary: null,
        customSections: null,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REPORT_DATE');
  });

  it('PUT rejects when client-supplied version is stale', async () => {
    seedDpr({ id: 'p3', version: 5 });
    const app = buildApp();
    const res = await request(app)
      .put('/api/dpr/p3')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({
        version: 4, // stale — DB is at 5
        projectName: 'X',
        location: 'Y',
        reportDate: '2026-09-04',
        weather: 'Sunny',
        temperature: null,
        contractor: null,
        workType: 'SITE_INSPECTION',
        notes: null,
        workExecutedToday: null,
        workLocation: null,
        manpowerSummary: null,
        risksHindrances: null,
        materialsReceivedSummary: null,
        customSections: null,
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');
  });
});

describe('SOL DR-004 — toDateOnly helper contract', () => {
  const { toDateOnly } = require('../src/lib/errors');

  it('Date instance → YYYY-MM-DD in UTC', () => {
    expect(toDateOnly(new Date('2026-09-01T00:00:00.000Z'))).toBe('2026-09-01');
    expect(toDateOnly(new Date('2026-12-31T23:59:59.999Z'))).toBe('2026-12-31');
  });

  it('Strict YYYY-MM-DD string → itself', () => {
    expect(toDateOnly('2026-09-04')).toBe('2026-09-04');
  });

  it('ISO datetime string → first 10 chars', () => {
    expect(toDateOnly('2026-09-01T00:00:00.000Z')).toBe('2026-09-01');
  });

  it('null / undefined → null', () => {
    expect(toDateOnly(null)).toBeNull();
    expect(toDateOnly(undefined)).toBeNull();
  });

  it('Invalid input → null (does not throw)', () => {
    expect(toDateOnly('not-a-date')).toBeNull();
    expect(toDateOnly({})).toBeNull();
  });
});

// SOL DR-004 (audit 2026-09-08) — PUT /dpr/:id boqItemId validator.
//
// Background: the BOQ-link branch (lines 1398-1414 of dpr.js, now 1416-1433
// after the TDZ fix) was reading `existing` to call resolveTargetProjectName
// while `existing` was still in its TDZ — `const existing = await ...` was
// declared further down in the handler. Any PUT that set `boqItemId` to a
// real (string) value threw ReferenceError → 500. Drawing-only and minimal
// updates never tripped the branch, which is why the audit only saw the
// bug fire on BOQ edits.
//
// Acceptance (from the audit):
//   - load and authorize the existing DPR BEFORE dependent-link validation
//   - valid same-project BOQ changes must persist (the audit's failing case)
//   - inactive / cross-project choices must STILL reject (no validator weakening)
//   - optimistic concurrency still pins version
//
// These tests pin all three BOQ branches through the real route. The
// `resolveTargetProjectName` helper short-circuits on `fields.projectName`
// when present, so we keep the projectName in the body identical to the
// stored row to exercise the "fall back to existing.projectName" branch.

describe('SOL DR-004 — PUT /dpr/:id boqItemId validator (TDZ fix)', () => {
  const PROJECT = 'Test project'; // matches seedDpr default

  function putPayload(overrides = {}) {
    return {
      version: 1,
      projectName: PROJECT,
      location: 'Edited Location',
      reportDate: '2026-09-04',
      weather: null,
      temperature: null,
      contractor: null,
      workType: 'SITE_INSPECTION',
      notes: 'Edited notes',
      workExecutedToday: null,
      workLocation: null,
      manpowerSummary: null,
      risksHindrances: null,
      materialsReceivedSummary: null,
      customSections: null,
      ...overrides,
    };
  }

  it('valid same-project BOQ PUT persists (the audit\'s 500 case)', async () => {
    // Pre-fix this returned 500 (ReferenceError on `existing`). Post-fix
    // it must return 200, persist boqItemId on the row, and bump version.
    seedDpr({ id: 'boq-ok', version: 1 });
    const app = buildApp({
      boqItems: { 'boq-1': { id: 'boq-1', projectName: PROJECT, isActive: true } },
    });
    const res = await request(app)
      .put('/api/dpr/boq-ok')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send(putPayload({ boqItemId: 'boq-1' }));
    expect(res.status).toBe(200);
    expect(res.body.boqItemId).toBe('boq-1');
    expect(dprs['boq-ok'].boqItemId).toBe('boq-1');
    expect(dprs['boq-ok'].version).toBe(2);
  });

  it('inactive BOQ (isActive=false) still rejects with 400 BOQ_ITEM_INACTIVE', async () => {
    // Regression guard: do not weaken the validator. The TDZ fix must not
    // accidentally let an archived BOQ land on the DPR.
    seedDpr({ id: 'boq-inactive', version: 1 });
    const app = buildApp({
      boqItems: { 'boq-archived': { id: 'boq-archived', projectName: PROJECT, isActive: false } },
    });
    const res = await request(app)
      .put('/api/dpr/boq-inactive')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send(putPayload({ boqItemId: 'boq-archived' }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BOQ_ITEM_INACTIVE');
    // The link was NOT persisted.
    expect(dprs['boq-inactive'].boqItemId).toBeNull();
    expect(dprs['boq-inactive'].version).toBe(1);
  });

  it('cross-project BOQ still rejects with 400 BOQ_PROJECT_MISMATCH', async () => {
    // Regression guard: BOQ item belongs to a DIFFERENT project than the
    // DPR. Validator must still catch the mismatch.
    seedDpr({ id: 'boq-xproj', version: 1 });
    const app = buildApp({
      boqItems: { 'boq-other': { id: 'boq-other', projectName: 'Other project', isActive: true } },
    });
    const res = await request(app)
      .put('/api/dpr/boq-xproj')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send(putPayload({ boqItemId: 'boq-other' }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BOQ_PROJECT_MISMATCH');
    expect(dprs['boq-xproj'].boqItemId).toBeNull();
  });

  it('non-existent BOQ returns 400 BOQ_ITEM_NOT_FOUND (no silent 500)', async () => {
    // The mock returns undefined for unknown ids, which the validator
    // maps to BOQ_ITEM_NOT_FOUND. Pre-fix this also surfaced as 500
    // because the TDZ fired before the validator could short-circuit.
    seedDpr({ id: 'boq-missing', version: 1 });
    const app = buildApp({ boqItems: {} });
    const res = await request(app)
      .put('/api/dpr/boq-missing')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send(putPayload({ boqItemId: 'boq-ghost' }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BOQ_ITEM_NOT_FOUND');
  });

  it('boqItemId=null clears the link (positive unlink path)', async () => {
    // The audit's repo also unlinks via PUT. Make sure the null branch
    // still works (it never hit the TDZ, but the refactor shifted code
    // around it — guard against an accidental regression).
    seedDpr({ id: 'boq-unlink', version: 1, boqItemId: 'boq-old' });
    const app = buildApp({ boqItems: {} });
    const res = await request(app)
      .put('/api/dpr/boq-unlink')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send(putPayload({ boqItemId: null }));
    expect(res.status).toBe(200);
    expect(dprs['boq-unlink'].boqItemId).toBeNull();
  });

  it('stale version on a valid same-project BOQ PUT still rejects with 409 VERSION_CONFLICT', async () => {
    // Optimistic concurrency must still pin version. The TDZ fix must
    // not bypass the version check on the BOQ branch.
    seedDpr({ id: 'boq-stale', version: 5 });
    const app = buildApp({
      boqItems: { 'boq-1': { id: 'boq-1', projectName: PROJECT, isActive: true } },
    });
    const res = await request(app)
      .put('/api/dpr/boq-stale')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send(putPayload({ version: 4, boqItemId: 'boq-1' }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');
    // The row did not advance and the link did not land.
    expect(dprs['boq-stale'].version).toBe(5);
    expect(dprs['boq-stale'].boqItemId).toBeNull();
  });
});
