// ─────────────────────────────────────────────────────────────────────────────
// Round-25d: regression test for the `notifMessage` scope-bleed bug in
// `src/routes/dpr.js`. The bug: `const notifMessage = …` was declared
// INSIDE the `prisma.$transaction(async (tx) => { … })` callback but
// referenced OUTSIDE in the fanOutEmail() call that runs after the tx
// resolves. Scope bleed across the async boundary → ReferenceError at
// request time → the route 500s → the email fan-out never fires.
//
// The bug bit a live user on 2026-09-04 — admin approved a DPR, the
// backend logged `DPR approve error { message: 'notifMessage is not defined' }`
// and the employee never received the APPROVED email.
//
// This test pins the wiring for all FOUR affected handlers:
//
//   POST /api/dpr/:id/review      — non-terminal admin transitions to UNDER_REVIEW
//   POST /api/dpr/:id/approve    — terminal admin transition to APPROVED  ← live bug
//   POST /api/dpr/:id/reject     — terminal admin transition to REJECTED
//   POST /api/dpr/bulk-review    — batch APPROVE|REJECT|UNDER_REVIEW over IDs
//
// We use supertest against the real router with a mocked prisma client
// (the same pattern as dpr.update.test.js). We mock `../src/lib/notify`
// so fanOutEmail becomes a Jest spy that captures the message text the
// handler is trying to send — that's the proof the scope fix works.
// ─────────────────────────────────────────────────────────────────────────────

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

// ─── Mock fanOutEmail BEFORE the router is required ────────────────────────
//
// `lib/notify.js` is loaded transitively by dprRouter. jest.mock() hoists
// to the top of the file, so this must come before `require('../src/routes/dpr')`.
// We pass through every other export of notify (CRITICAL_TYPES, etc.) so the
// router doesn't blow up on undefined access.
const mockFanOutEmail = jest.fn(async () => undefined);
jest.mock('../src/lib/notify', () => {
  const actual = jest.requireActual('../src/lib/notify');
  return {
    ...actual,
    fanOutEmail: mockFanOutEmail,
  };
});

const dprRouter = require('../src/routes/dpr');

// ─── In-memory DPR store (mirrors dpr.update.test.js) ──────────────────────
const ADMIN_ID = 'admin-1';
const EMPLOYEE_ID = 'employee-1';
let dprs = {};

function seedDpr({ id, status = 'SUBMITTED', submittedById = EMPLOYEE_ID, version = 1 } = {}) {
  dprs[id] = {
    id,
    submittedById,
    status,
    version,
    projectName: 'Acme Tower',
    location: 'Chennai',
    reportDate: new Date('2026-09-03T00:00:00.000Z'),
    adminNotes: null,
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
  };
  return dprs[id];
}

// ─── Prisma mock: full surface the 4 handlers touch ────────────────────────
//
// The handler wraps the mutation + notification + revision in
// `$transaction(async (tx) => { … })`. We forward every tx call to the
// top-level prisma mock (the tx client has the same shape — just with the
// operations scoped to the transaction).
function buildApp() {
  const app = express();
  app.use(express.json());

  const txPrisma = {
    dPR: {
      findUnique: async ({ where: { id } }) => dprs[id] || null,
      update: async ({ where, data }) => {
        const row = dprs[where.id];
        if (!row) {
          const e = new Error('Record not found');
          e.code = 'P2025';
          throw e;
        }
        // Honor the conditional WHERE — every key must match (status+version).
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
    },
    dPRRevision: { create: async ({ data }) => ({ id: 'rev-' + data.dprId, ...data }) },
    notification: { create: async ({ data }) => ({ id: 'notif-' + Date.now(), ...data }) },
  };

  const prisma = {
    ...txPrisma,
    // LPR-007: requireFreshAdmin middleware re-reads Employee.isAdmin
    // from the database on every mutating admin route. The JWT claim's
    // isAdmin is no longer trusted for mutations, so the mock needs to
    // answer "yes, ADMIN_ID is admin" when the middleware asks.
    employee: {
      findUnique: async ({ where: { id } }) =>
        id === ADMIN_ID ? { id: ADMIN_ID, isAdmin: true } : null,
    },
    $transaction: async (cb) => cb(txPrisma),
  };

  app.set('prisma', prisma);
  app.use('/api/dpr', dprRouter);
  return app;
}

function adminAuth() {
  const token = jwt.sign(
    { employeeId: ADMIN_ID, email: 'admin@example.com', isAdmin: true },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  );
  return `Bearer ${token}`;
}

beforeEach(() => {
  dprs = {};
  mockFanOutEmail.mockReset();
  mockFanOutEmail.mockResolvedValue(undefined);
});

describe('Round-25d — fanOutEmail scope wiring across $transaction boundary', () => {
  it('POST /:id/approve does NOT throw ReferenceError and calls fanOutEmail with the approval message', async () => {
    seedDpr({ id: 'dpr-approve', status: 'SUBMITTED' });
    const app = buildApp();
    const res = await request(app)
      .post('/api/dpr/dpr-approve/approve')
      .set('Authorization', adminAuth())
      .send({ adminNotes: 'Looks good.' });

    // Before the fix: 500 with message 'notifMessage is not defined'.
    expect(res.status).toBe(200);
    expect(mockFanOutEmail).toHaveBeenCalledTimes(1);
    const call = mockFanOutEmail.mock.calls[0][0];
    expect(call.type).toBe('DPR_APPROVED');
    expect(call.employeeId).toBe(EMPLOYEE_ID);
    expect(call.message).toMatch(/was approved/);
    expect(call.message).toMatch(/Looks good\./);
  });

  it('POST /:id/review does NOT throw ReferenceError and calls fanOutEmail with the review message', async () => {
    seedDpr({ id: 'dpr-review', status: 'SUBMITTED' });
    const app = buildApp();
    const res = await request(app)
      .post('/api/dpr/dpr-review/review')
      .set('Authorization', adminAuth())
      .send({ adminNotes: 'Following up tomorrow.' });

    expect(res.status).toBe(200);
    expect(mockFanOutEmail).toHaveBeenCalledTimes(1);
    const call = mockFanOutEmail.mock.calls[0][0];
    expect(call.type).toBe('DPR_REVIEWED');
    expect(call.message).toMatch(/was reviewed/);
    expect(call.message).toMatch(/Following up tomorrow\./);
  });

  it('POST /:id/reject does NOT throw ReferenceError and calls fanOutEmail with the reject message', async () => {
    seedDpr({ id: 'dpr-reject', status: 'SUBMITTED' });
    const app = buildApp();
    const res = await request(app)
      .post('/api/dpr/dpr-reject/reject')
      .set('Authorization', adminAuth())
      .send({ reason: 'Missing photos', adminNotes: 'Resubmit with all 5 photos.' });

    expect(res.status).toBe(200);
    expect(mockFanOutEmail).toHaveBeenCalledTimes(1);
    const call = mockFanOutEmail.mock.calls[0][0];
    expect(call.type).toBe('DPR_REJECTED');
    expect(call.message).toMatch(/was rejected: Missing photos/);
    expect(call.message).toMatch(/Resubmit with all 5 photos\./);
  });

  it('POST /bulk-review does NOT throw ReferenceError on APPROVE action and fans out per ID', async () => {
    seedDpr({ id: 'dpr-bulk-1', status: 'SUBMITTED' });
    seedDpr({ id: 'dpr-bulk-2', status: 'SUBMITTED' });
    const app = buildApp();
    const res = await request(app)
      .post('/api/dpr/bulk-review')
      .set('Authorization', adminAuth())
      .send({ ids: ['dpr-bulk-1', 'dpr-bulk-2'], action: 'APPROVE' });

    expect(res.status).toBe(200);
    expect(res.body.succeededCount).toBe(2);
    expect(mockFanOutEmail).toHaveBeenCalledTimes(2);
    const types = mockFanOutEmail.mock.calls.map((c) => c[0].type);
    expect(types).toEqual(['DPR_APPROVED', 'DPR_APPROVED']);
  });

  it('POST /bulk-review on REJECT action includes reason in the message', async () => {
    seedDpr({ id: 'dpr-bulk-rej', status: 'SUBMITTED' });
    const app = buildApp();
    const res = await request(app)
      .post('/api/dpr/bulk-review')
      .set('Authorization', adminAuth())
      .send({ ids: ['dpr-bulk-rej'], action: 'REJECT', reason: 'Wrong project code' });

    expect(res.status).toBe(200);
    expect(mockFanOutEmail).toHaveBeenCalledTimes(1);
    expect(mockFanOutEmail.mock.calls[0][0].message).toMatch(/Wrong project code/);
  });

  it('POST /bulk-review on UNDER_REVIEW action fans out with DPR_REVIEWED type', async () => {
    seedDpr({ id: 'dpr-bulk-urv', status: 'SUBMITTED' });
    const app = buildApp();
    const res = await request(app)
      .post('/api/dpr/bulk-review')
      .set('Authorization', adminAuth())
      .send({ ids: ['dpr-bulk-urv'], action: 'UNDER_REVIEW' });

    expect(res.status).toBe(200);
    expect(mockFanOutEmail).toHaveBeenCalledTimes(1);
    expect(mockFanOutEmail.mock.calls[0][0].type).toBe('DPR_REVIEWED');
  });

  it('bulk-review does NOT throw ReferenceError on REJECT action', async () => {
    // Pin the reject branch of the bulk-review handler (separate code path
    // from APPROVE/UNDER_REVIEW branches). The fix is identical — hoist
    // `notifMessage` to outer scope — but exercising it here keeps the
    // contract explicit.
    seedDpr({ id: 'dpr-bulk-rej2', status: 'SUBMITTED' });
    const app = buildApp();
    const res = await request(app)
      .post('/api/dpr/bulk-review')
      .set('Authorization', adminAuth())
      .send({ ids: ['dpr-bulk-rej2'], action: 'REJECT', reason: 'Photo evidence missing' });

    expect(res.status).toBe(200);
    expect(mockFanOutEmail).toHaveBeenCalledTimes(1);
    expect(mockFanOutEmail.mock.calls[0][0].type).toBe('DPR_REJECTED');
    expect(mockFanOutEmail.mock.calls[0][0].message).toMatch(/Photo evidence missing/);
  });
});