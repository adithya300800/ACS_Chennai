// SOL DR-003 regression coverage: the audit caught that "Save Draft ->
// Resume -> Submit Report" returned 200 but left the row in DRAFT
// because the PUT mass-assignment allowlist deliberately excludes
// `status`. The fix adds a dedicated POST /api/dpr/:id/submit command
// that performs the DRAFT -> SUBMITTED transition with optimistic
// concurrency. These tests pin:
//
//   1. Submit transitions DRAFT -> SUBMITTED and the response carries
//      status=SUBMITTED.
//   2. Save Draft on the same draft (PUT) stays DRAFT — the two gestures
//      don't bleed into each other.
//   3. Bad expected version returns 409 VERSION_CONFLICT.
//   4. Non-DRAFT source statuses (UNDER_REVIEW / APPROVED / REJECTED)
//      return 409 INVALID_TRANSITION — the owner can't claim the publish
//      after the row has moved on.
//   5. Idempotent re-submit on an already-SUBMITTED row returns 200
//      with the existing row — a retried Submit click doesn't 409.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const dprRouter = require('../src/routes/dpr');

const EMPLOYEE_ID = 'test-employee-dr003';
const OTHER_EMPLOYEE = 'someone-else';
let dprs = {};

function seedDpr({
  id,
  status = 'DRAFT',
  submittedById = EMPLOYEE_ID,
  version = 1,
  reportDate = new Date('2026-09-01T00:00:00.000Z'),
  projectName = 'Test project',
  // Default to a "publishable" draft — workType set + narrative present —
  // so the happy-path submit test isn't fighting the required-field
  // validator. Specific test cases override these to exercise the gate.
  workType = 'SITE_INSPECTION',
  workExecutedToday = 'Installed rebar at grid line A',
  workLocation = 'Site A',
  manpowerSummary = '5 crew',
  materialsReceivedSummary = 'Cement 10 bags',
  notes = 'seed notes',
  photos = [],
} = {}) {
  dprs[id] = {
    id,
    submittedById,
    status,
    version,
    projectName,
    projectId: null,
    location: 'Test location',
    reportDate,
    workType,
    notes,
    customSections: null,
    workExecutedToday,
    workLocation,
    manpowerSummary,
    risksHindrances: null,
    materialsReceivedSummary,
    weather: null,
    temperature: null,
    contractor: null,
    drawingId: null,
    drawingRev: null,
    boqItemId: null,
    submittedAt: null,
    photos,
  };
  return dprs[id];
}

function buildApp() {
  const app = express();
  app.use(express.json());
  const prisma = {
    dPR: {
      findUnique: async ({ where: { id }, include }) => {
        const row = dprs[id];
        if (!row) return null;
        if (!include) return { ...row };
        // The submit handler reads `photos: { include: ... }` to run the
        // SOL-P1#11 narrative-presence check. Hand back the seeded array
        // (empty by default) — tests that exercise the photo-as-narrative
        // branch pre-seed with a fake photo object.
        return { ...row, photos: row.photos || [] };
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
          } else if (k === 'updatedAt' || k === 'submittedAt') {
            row[k] = v || row[k];
          } else {
            row[k] = v;
          }
        }
        return { ...row };
      },
    },
    employee: {
      findUnique: async () => ({ id: EMPLOYEE_ID, isAdmin: false }),
    },
    project: {
      // The PUT handler resolves a free-text projectName via resolveProject.
      // None of the seeded DPRs in this suite have a curated Project row,
      // so all three lookups return null — the PUT then leaves the FK
      // NULL and keeps the typed projectName as-is (legacy contract).
      findUnique: async () => null,
      findFirst: async () => null,
    },
    boqItem: { findUnique: async () => null },
    dPRPhoto: {},
  };
  app.set('prisma', prisma);
  app.use('/api/dpr', dprRouter);
  return app;
}

function authHeader(forEmployeeId = EMPLOYEE_ID) {
  return jwt.sign(
    { employeeId: forEmployeeId, email: 'test@example.com' },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  );
}

beforeEach(() => {
  dprs = {};
});

describe('SOL DR-003 — POST /dpr/:id/submit transitions DRAFT -> SUBMITTED', () => {
  it('returns 200 with status=SUBMITTED and bumps version', async () => {
    seedDpr({ id: 'd-1', version: 3 });
    const app = buildApp();
    const res = await request(app)
      .post('/api/dpr/d-1/submit')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({ version: 3 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SUBMITTED');
    expect(res.body.version).toBe(4);
    expect(dprs['d-1'].status).toBe('SUBMITTED');
    expect(dprs['d-1'].version).toBe(4);
    expect(dprs['d-1'].submittedAt).toBeTruthy();
  });

  it('sets submittedAt to a real Date on the publish transition', async () => {
    seedDpr({ id: 'd-1b', version: 1 });
    const app = buildApp();
    const before = Date.now();
    const res = await request(app)
      .post('/api/dpr/d-1b/submit')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({ version: 1 });
    const after = Date.now();
    expect(res.status).toBe(200);
    const ts = new Date(dprs['d-1b'].submittedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('PUT /dpr/:id with status absent keeps the row DRAFT (Save Draft gesture)', async () => {
    // Audit-caught regression: PUT mass-assignment allowlist deliberately
    // excludes `status`, so a Save Draft must NOT silently flip the row
    // to SUBMITTED. The audit explicitly calls this out: "the edit command
    // excludes status" — we want to keep that guarantee.
    seedDpr({ id: 'd-1c', version: 1, status: 'DRAFT' });
    const app = buildApp();
    const res = await request(app)
      .put('/api/dpr/d-1c')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({
        version: 1,
        projectName: 'Edited Project',
        location: 'Edited Location',
        reportDate: '2026-09-04',
        weather: null,
        temperature: null,
        contractor: null,
        workType: 'SITE_INSPECTION',
        notes: 'Edited notes',
        workExecutedToday: 'Installed rebar',
        workLocation: null,
        manpowerSummary: null,
        risksHindrances: null,
        materialsReceivedSummary: null,
        customSections: null,
      });
    expect(res.status).toBe(200);
    expect(dprs['d-1c'].status).toBe('DRAFT');
    expect(res.body.status).toBe('DRAFT');
    expect(dprs['d-1c'].version).toBe(2);
  });

  it('returns 409 VERSION_CONFLICT when client-supplied version is stale', async () => {
    seedDpr({ id: 'd-2', version: 5 });
    const app = buildApp();
    const res = await request(app)
      .post('/api/dpr/d-2/submit')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({ version: 4 }); // stale — DB is at 5
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');
    // The row was NOT published.
    expect(dprs['d-2'].status).toBe('DRAFT');
    expect(dprs['d-2'].version).toBe(5);
  });

  it('returns 400 VALIDATION_ERROR when version is missing or non-positive', async () => {
    seedDpr({ id: 'd-2b', version: 1 });
    const app = buildApp();
    const res = await request(app)
      .post('/api/dpr/d-2b/submit')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({}); // no version
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 403 FORBIDDEN when the caller is not the owner', async () => {
    seedDpr({ id: 'd-3', submittedById: OTHER_EMPLOYEE });
    const app = buildApp();
    const res = await request(app)
      .post('/api/dpr/d-3/submit')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({ version: 1 });
    expect(res.status).toBe(403);
    expect(dprs['d-3'].status).toBe('DRAFT');
  });

  it('returns 404 NOT_FOUND for an unknown dpr id', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/dpr/missing/submit')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({ version: 1 });
    expect(res.status).toBe(404);
  });

  it('rejects submitting a DPR that is already UNDER_REVIEW (INVALID_TRANSITION)', async () => {
    seedDpr({ id: 'd-4', status: 'UNDER_REVIEW' });
    const app = buildApp();
    const res = await request(app)
      .post('/api/dpr/d-4/submit')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({ version: 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_TRANSITION');
    expect(res.body.currentStatus).toBe('UNDER_REVIEW');
    expect(dprs['d-4'].status).toBe('UNDER_REVIEW');
  });

  it('rejects submitting a DPR that is APPROVED (audit-trail integrity)', async () => {
    seedDpr({ id: 'd-5', status: 'APPROVED' });
    const app = buildApp();
    const res = await request(app)
      .post('/api/dpr/d-5/submit')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({ version: 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_TRANSITION');
  });

  it('rejects submitting a DPR that is REJECTED (audit-trail integrity)', async () => {
    seedDpr({ id: 'd-6', status: 'REJECTED' });
    const app = buildApp();
    const res = await request(app)
      .post('/api/dpr/d-6/submit')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({ version: 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_TRANSITION');
  });

  it('idempotently returns 200 with the existing row when already SUBMITTED', async () => {
    // A retried Submit click on a row that already landed SUBMITTED must
    // not 409 — the user already succeeded, they just didn't see the
    // success page. The optimistic version pin still protects against
    // a real concurrent change.
    seedDpr({ id: 'd-7', status: 'SUBMITTED', version: 4 });
    const app = buildApp();
    const res = await request(app)
      .post('/api/dpr/d-7/submit')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({ version: 4 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SUBMITTED');
    expect(dprs['d-7'].version).toBe(4); // not bumped — already submitted
  });

  it('rejects empty-draft submit with VALIDATION_ERROR (SOL-P1#11 mirror)', async () => {
    // The server-side gate mirrors the client's SOL-P1#11 check so a
    // direct API call can't smuggle an empty draft into the admin queue.
    seedDpr({
      id: 'd-8',
      workExecutedToday: null,
      manpowerSummary: null,
      materialsReceivedSummary: null,
      notes: null,
      photos: [],
    });
    const app = buildApp();
    const res = await request(app)
      .post('/api/dpr/d-8/submit')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({ version: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(dprs['d-8'].status).toBe('DRAFT');
  });

  it('accepts a photo-only draft as having narrative (photos count as content)', async () => {
    seedDpr({
      id: 'd-9',
      workExecutedToday: null,
      manpowerSummary: null,
      materialsReceivedSummary: null,
      notes: null,
      photos: [{ id: 'p1', ulid: '01HF3XK9P4NQ5Y7V0ABCDEFGHJ' }],
    });
    const app = buildApp();
    const res = await request(app)
      .post('/api/dpr/d-9/submit')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({ version: 1 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SUBMITTED');
  });
});
