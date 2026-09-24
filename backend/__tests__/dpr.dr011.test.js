// SOL DR-011 regression coverage. The audit caught that the destructive
// DELETE on a DRAFT DPR read the row OUTSIDE the destructive
// transaction. A concurrent SUBMIT (or PUT) could land between the read
// and the destructive transaction; the later DELETE would then
// unlink inspections and delete the now-submitted report, cascading
// the photo + revision rows with it.
//
// Repair: capture (id, owner, status=DRAFT, version) at read time,
// then predicate the destructive transaction on that tuple. If a
// concurrent mutation breaks the predicate, Prisma throws P2025 →
// the transaction rolls back → the inspection unlink + DPR delete
// never run → the now-published report and its photo/revision rows
// survive. Server-captured version is sufficient; no new DELETE
// field is required.
//
// Acceptance (audit, DR-011):
//   - If publication wins, the report / photos / revisions /
//     inspection links SURVIVE and DELETE conflicts (409
//     VERSION_CONFLICT, not the generic 404 NOT_FOUND).
//   - If DELETE wins, publication cannot claim success (the
//     transaction is atomic — no partial state possible).
//   - Include concurrent edit coverage: a PUT that bumps the
//     version between read and guarded update also conflicts.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

jest.mock('../src/lib/blobStorage', () => ({
  generateUploadSASUrl: jest.fn(),
  verifyBlobExists: jest.fn(async () => ({ exists: false })),
  deleteBlob: jest.fn(async () => ({ ok: true })),
  generateReadSASUrl: jest.fn(async () => ({ sasUrl: 'https://r2.example/fake' })),
  CONTENT_TYPE_EXT: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' },
  uploadIntentBinding: { bindPhotoIntents: jest.fn(async () => null) },
}));

const dprRouter = require('../src/routes/dpr');

const OWNER_ID = 'emp-dr011-owner';
const OTHER_EMPLOYEE = 'emp-dr011-probe';

let dprs = {};
let inspectionsByDprId = {};   // dprId -> [inspection rows]
let guardedUpdateCalls = [];   // captures every guarded-update WHERE for audit

function seedDpr({
  id,
  status = 'DRAFT',
  submittedById = OWNER_ID,
  version = 1,
  projectName = 'Race site',
  reportDate = new Date('2026-09-04T00:00:00.000Z'),
} = {}) {
  dprs[id] = {
    id,
    submittedById,
    status,
    version,
    projectName,
    projectId: null,
    location: 'Chennai',
    reportDate,
    workType: 'SITE_INSPECTION',
    notes: 'seed',
    customSections: null,
    workExecutedToday: null,
    workLocation: null,
    manpowerSummary: null,
    risksHindrances: null,
    materialsReceivedSummary: null,
    weather: null,
    temperature: null,
    contractor: null,
    drawingId: null,
    drawingRev: null,
    boqItemId: null,
    submittedAt: null,
    reviewedById: null,
    approvedById: null,
  };
  inspectionsByDprId[id] = inspectionsByDprId[id] || [];
  return dprs[id];
}

function buildApp({ raceSimulator = null } = {}) {
  // raceSimulator (optional): simulates a concurrent mutation that lands
  // between DELETE's read and its guarded update.
  //   'publish-wins' → concurrent SUBMIT: status flips DRAFT → SUBMITTED,
  //                    version bumps by 1.
  //   'edit-wins'    → concurrent PUT: version bumps by 1, status stays DRAFT.
  //
  // Implementation: findUnique captures the row snapshot, then mutates the
  // underlying state to simulate the concurrent write. The guarded update
  // (which reads the underlying state) fails with P2025, exactly the race
  // path the audit flagged.
  //
  // Atomicity note: the mock's `$transaction` queues destructive side
  // effects (delete + inspection-unlink) and only commits them if every
  // operation resolves successfully. This mirrors Prisma's array-form
  // `$transaction` semantics, where an aborted transaction rolls back
  // every queued write. Without this, the test cannot assert that a
  // rolled-back DELETE leaves the report intact.
  const app = express();
  app.use(express.json());

  const pendingInspectionUnlinks = [];   // [{ dprId }]
  const pendingDprDeletes = [];          // [{ id }]
  let transactionAborted = false;

  const prisma = {
    dPR: {
      findUnique: async ({ where: { id } }) => {
        const row = dprs[id];
        if (!row) return null;
        const snapshot = { ...row };
        if (raceSimulator === 'publish-wins' && row.status === 'DRAFT') {
          // SUBMIT lands right after our read.
          row.status = 'SUBMITTED';
          row.version = row.version + 1;
          row.submittedAt = new Date();
        }
        if (raceSimulator === 'edit-wins' && row.status === 'DRAFT') {
          // PUT bumps version right after our read.
          row.version = row.version + 1;
        }
        return snapshot;
      },
      update: async ({ where, data }) => {
        if (transactionAborted) {
          // Defensive — should never be reached since the abort path
          // exits the transaction before subsequent ops are awaited.
          throw new Error('Update reached after transaction abort');
        }
        const row = dprs[where.id];
        if (!row) {
          const e = new Error('Record not found');
          e.code = 'P2025';
          throw e;
        }
        guardedUpdateCalls.push({ where: { ...where } });
        // Honor multi-field WHERE — every non-id field must match the
        // CURRENT underlying state. A status flip / version bump from a
        // concurrent writer trips P2025, exactly the race-repair
        // signal DR-011 requires.
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
            // ignore
          } else {
            row[k] = v;
          }
        }
        return { ...row };
      },
      delete: async ({ where: { id } }) => {
        // Queue the destructive side effect; commit only if the
        // surrounding transaction succeeds. Mirrors Prisma's array-form
        // `$transaction` atomicity — when the guarded update throws
        // P2025, this delete is never committed and the DPR survives.
        pendingDprDeletes.push({ id });
        return { id };
      },
    },
    inspectionRecord: {
      updateMany: async ({ where, data }) => {
        // Queue the inspection-unlink side effect; commit only on
        // transaction success. Mirrors production behavior — if the
        // guarded update trips P2025, the inspections keep their dprId
        // (FK ON DELETE SET NULL never fires because the delete is
        // rolled back).
        pendingInspectionUnlinks.push({ dprId: where.dprId, data: { ...data } });
        // Compute count off the current state so the route's logger
        // shape matches production semantics.
        const list = inspectionsByDprId[where.dprId] || [];
        return { count: list.length };
      },
    },
    employee: {
      findUnique: async () => ({ id: OWNER_ID, isAdmin: false }),
    },
    // The DELETE handler uses prisma.$transaction([...]) (array form).
    // Execute the queued operations sequentially against the same mock
    // bindings; if any throws, abort — no queued destructive side
    // effects (delete + inspection-unlink) commit.
    //
    // Note: the mock's `prisma.dPR.update` / `updateMany` / `delete`
    // are invoked eagerly when the array is constructed (the route
    // passes `prisma.dPR.update({...})` directly, not a thunk). The
    // queued side effects (pendingInspectionUnlinks, pendingDprDeletes)
    // are therefore populated BEFORE $transaction runs. Do NOT reset
    // the queues here — the eager mock calls already committed to
    // them, and a reset would discard the work.
    $transaction: async (ops) => {
      transactionAborted = false;
      try {
        const results = [];
        for (const op of ops) {
          results.push(await op);
        }
        // All ops resolved — commit the queued destructive side effects.
        for (const { dprId, data } of pendingInspectionUnlinks) {
          for (const ins of inspectionsByDprId[dprId] || []) {
            ins.dprId = data.dprId;
          }
        }
        for (const { id } of pendingDprDeletes) {
          delete dprs[id];
        }
        return results;
      } catch (err) {
        // Transaction aborted — discard the queued destructive side
        // effects. The guarded update tripped P2025, so neither the
        // inspection-unlink nor the DPR delete commit.
        transactionAborted = true;
        throw err;
      }
    },
  };

  app.set('prisma', prisma);
  app.use('/api/dpr', dprRouter);
  return app;
}

function authHeader(employeeId = OWNER_ID) {
  return jwt.sign(
    { employeeId, email: `${employeeId}@example.com` },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  );
}

beforeEach(() => {
  dprs = {};
  inspectionsByDprId = {};
  guardedUpdateCalls = [];
});

describe('SOL DR-011 — DELETE destructive predicate (id, owner, status, version)', () => {
  test('happy path: DELETE on own DRAFT unlinks inspections and removes the report', async () => {
    // Pre-seed a DRAFT at version=2 with one inspection linked. This is
    // the control case — no race, no concurrent mutation.
    seedDpr({ id: 'happy-1', version: 2 });
    inspectionsByDprId['happy-1'] = [
      { id: 'insp-1', dprId: 'happy-1', inspectionType: 'material_inspection' },
    ];

    const app = buildApp();
    const res = await request(app)
      .delete('/api/dpr/happy-1')
      .set('Authorization', `Bearer ${authHeader()}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, id: 'happy-1' });

    // Guarded update fired with all four predicate fields.
    expect(guardedUpdateCalls.length).toBe(1);
    expect(guardedUpdateCalls[0].where).toMatchObject({
      id: 'happy-1',
      submittedById: OWNER_ID,
      status: 'DRAFT',
      version: 2,
    });

    // The DPR row is gone (delete reached + transaction committed), the
    // inspection was unlinked.
    expect(dprs['happy-1']).toBeUndefined();
    expect(inspectionsByDprId['happy-1'][0].dprId).toBeNull();
  });

  test('non-DRAFT row returns 409 INVALID_TRANSITION (no transaction runs)', async () => {
    // Pre-fix this still worked (existing handler returns 409 before the
    // transaction). Post-fix it MUST still work — the predicate guard
    // only runs inside the transaction, not in front of it.
    seedDpr({ id: 'submitted-1', status: 'SUBMITTED', version: 5 });
    const app = buildApp();
    const res = await request(app)
      .delete('/api/dpr/submitted-1')
      .set('Authorization', `Bearer ${authHeader()}`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_TRANSITION');
    expect(res.body.currentStatus).toBe('SUBMITTED');
    // No transaction was attempted — no guarded update.
    expect(guardedUpdateCalls.length).toBe(0);
    // The row survives untouched.
    expect(dprs['submitted-1']).toBeDefined();
    expect(dprs['submitted-1'].version).toBe(5);
  });

  test('non-owner returns 403 (predicate never built)', async () => {
    seedDpr({ id: 'foreign-1', submittedById: OTHER_EMPLOYEE, version: 1 });
    const app = buildApp();
    const res = await request(app)
      .delete('/api/dpr/foreign-1')
      .set('Authorization', `Bearer ${authHeader()}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(guardedUpdateCalls.length).toBe(0);
    expect(dprs['foreign-1']).toBeDefined();
  });

  test('non-existent id returns 404', async () => {
    const app = buildApp();
    const res = await request(app)
      .delete('/api/dpr/does-not-exist')
      .set('Authorization', `Bearer ${authHeader()}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(guardedUpdateCalls.length).toBe(0);
  });
});

describe('SOL DR-011 — race: concurrent publication', () => {
  test('DRAFT published between DELETE read and guarded update → 409 VERSION_CONFLICT + report survives', async () => {
    // The audit\'s headline case: a SUBMIT lands between the DELETE\'s
    // read and the destructive transaction. Without DR-011 the delete
    // would unlink inspections and remove the now-published report
    // (cascading photo + revision rows). Post-fix the predicate trips,
    // the transaction aborts, the report + linked rows survive.
    seedDpr({ id: 'race-pub', version: 1 });
    inspectionsByDprId['race-pub'] = [
      { id: 'insp-pub-1', dprId: 'race-pub', inspectionType: 'material_inspection' },
      { id: 'insp-pub-2', dprId: 'race-pub', inspectionType: 'cube_casting' },
    ];

    const app = buildApp({ raceSimulator: 'publish-wins' });
    const res = await request(app)
      .delete('/api/dpr/race-pub')
      .set('Authorization', `Bearer ${authHeader()}`);

    // 409 VERSION_CONFLICT — not the generic 404 NOT_FOUND that
    // mapPrismaError would emit on P2025.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');
    expect(res.body.error).toMatch(/modified by another action/);

    // The DPR was NOT deleted — transaction aborted before commit.
    expect(dprs['race-pub']).toBeDefined();
    // The publication flip from the simulated SUBMIT stuck (we can\'t
    // claim success AND delete — the predicate made us pick: DELETE
    // lost, publication won, the row is now SUBMITTED at v2).
    expect(dprs['race-pub'].status).toBe('SUBMITTED');
    expect(dprs['race-pub'].version).toBe(2);

    // Inspections kept their dprId (the unlink updateMany was queued
    // but never committed — the guarded update tripped P2025 first).
    expect(inspectionsByDprId['race-pub'][0].dprId).toBe('race-pub');
    expect(inspectionsByDprId['race-pub'][1].dprId).toBe('race-pub');

    // The guarded update WAS attempted with the (id, owner, status, version)
    // captured at read time — that\'s the predicate the audit required.
    expect(guardedUpdateCalls.length).toBe(1);
    expect(guardedUpdateCalls[0].where).toMatchObject({
      id: 'race-pub',
      submittedById: OWNER_ID,
      status: 'DRAFT',
      version: 1,
    });
  });
});

describe('SOL DR-011 — race: concurrent edit (PUT)', () => {
  test('DRAFT edited (version bumped) between DELETE read and guarded update → 409 VERSION_CONFLICT + report survives', async () => {
    // Concurrent edit coverage required by the audit. A PUT that bumps
    // the version between DELETE\'s read and the destructive transaction
    // also trips the predicate — the version component of the (id, owner,
    // status, version) tuple no longer matches.
    seedDpr({ id: 'race-edit', version: 4 });

    const app = buildApp({ raceSimulator: 'edit-wins' });
    const res = await request(app)
      .delete('/api/dpr/race-edit')
      .set('Authorization', `Bearer ${authHeader()}`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');

    // Row survives (the PUT\'s version bump is the only mutation that landed).
    expect(dprs['race-edit']).toBeDefined();
    expect(dprs['race-edit'].status).toBe('DRAFT');
    expect(dprs['race-edit'].version).toBe(5);

    // The guarded update fired with the OBSERVED version (4), which is
    // now stale because of the concurrent PUT.
    expect(guardedUpdateCalls.length).toBe(1);
    expect(guardedUpdateCalls[0].where).toMatchObject({
      id: 'race-edit',
      submittedById: OWNER_ID,
      status: 'DRAFT',
      version: 4,
    });
  });
});

describe('SOL DR-011 — server-captured version (security)', () => {
  test('predicate uses server-captured version from the read — no client-supplied version', async () => {
    // The audit was explicit: "A server-captured version is sufficient
    // for this race repair; a mandatory new DELETE field is not
    // necessary." This test pins that contract — DELETE has no body,
    // the predicate uses the version from findUnique, and the request
    // body cannot be used to bypass the guard.
    seedDpr({ id: 'sec-1', version: 7 });
    const app = buildApp();
    const res = await request(app)
      .delete('/api/dpr/sec-1')
      .set('Authorization', `Bearer ${authHeader()}`)
      // Send a body that tries to bypass with a higher version. DELETE
      // should ignore the body entirely (Express + the route handler do
      // not parse it), and the predicate still uses observedVersion=7.
      .send({ version: 999, submittedById: OWNER_ID, status: 'DRAFT' });

    // Happy path — DELETE succeeded with the server-captured v7.
    expect(res.status).toBe(200);
    expect(guardedUpdateCalls[0].where.version).toBe(7);
    expect(guardedUpdateCalls[0].where.submittedById).toBe(OWNER_ID);
  });

  test('predicate uses req.employeeId (JWT-derived, server-side), not a client-supplied field', async () => {
    // A request body trying to assert a different owner is ignored.
    // The predicate\'s submittedById is the authenticated user from the
    // JWT, set by requireAuth — clients cannot spoof it.
    seedDpr({ id: 'sec-2', version: 1, submittedById: OWNER_ID });
    const app = buildApp();
    const res = await request(app)
      .delete('/api/dpr/sec-2')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({ submittedById: 'attacker-controlled-id' });

    // Happy path — submittedById in the predicate matches the JWT owner.
    expect(res.status).toBe(200);
    expect(guardedUpdateCalls[0].where.submittedById).toBe(OWNER_ID);
  });
});
