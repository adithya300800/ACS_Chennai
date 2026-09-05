// SOL DR-005 regression coverage. The original "Save as Draft" button
// sent status: 'OPEN' — both buttons were identical except for the
// success toast. The audit caught this and required:
//
//   - a real DRAFT status (not an ignored isDraft flag)
//   - DRAFT records do NOT trigger admin fan-out
//   - owner-only SUBMIT transition (DRAFT → OPEN) that DOES trigger
//     admin fan-out exactly once
//
// These tests pin all four points against the live router.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

// Track notification calls — the test asserts that DRAFT does NOT
// trigger fan-out but SUBMIT does. Variable name MUST start with
// "mock" so jest's hoisted factory closure accepts it.
let mockFanOutCalls = [];
jest.mock('../src/lib/notify', () => ({
  fanOutEmail: jest.fn(async () => null),
  fanOutToAdmins: jest.fn(async (payload) => {
    mockFanOutCalls.push(payload);
    return null;
  }),
}));

// The shared uploadRoutes module doesn't need real R2 calls here, but
// import-time instantiation may reach for blobStorage helpers. Stub
// them so the route module loads cleanly without contacting cloud
// services.
jest.mock('../src/lib/blobStorage', () => ({
  generateUploadSASUrl: jest.fn(),
  verifyBlobExists: jest.fn(async () => ({ exists: false })),
  deleteBlob: jest.fn(async () => ({ ok: true })),
  generateReadSASUrl: jest.fn(async () => ({ sasUrl: 'https://r2.example/fake' })),
  CONTENT_TYPE_EXT: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' },
  uploadIntentBinding: { bindPhotoIntents: jest.fn(async () => null) },
}));

// Some routes pull in a notification helper that needs prisma. Make
// sure we don't accidentally fan out from places we don't care about.
// (The route already gets prisma via app.set('prisma', ...) and the
// require chain pulls `getPrisma` from ../src/lib/getPrisma.)
const inspectionRouter = require('../src/routes/inspection');

const OWNER_ID = 'emp-dr005-owner';
const OTHER_EMPLOYEE = 'emp-dr005-other';

let records = {};

function seedRecord({ id, status = 'DRAFT', submittedById = OWNER_ID, inspectionType = 'material_inspection' } = {}) {
  records[id] = {
    id,
    projectName: 'Site X',
    location: 'Chennai',
    reportDate: new Date('2026-09-04T00:00:00.000Z'),
    weather: 'Sunny',
    contractor: null,
    dprId: null,
    inspectionType,
    data: { qty: 100 },
    severity: null,
    submittedById,
    status,
    photos: [],
    submittedBy: { id: submittedById, name: 'Owner', email: 'o@example.com' },
    dpr: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return records[id];
}

function buildApp({ isAdmin = false } = {}) {
  const app = express();
  app.use(express.json());

  // Shared in-memory store backing the per-method prisma mocks. We
  // hoist the transaction body onto the top-level prisma mock below
  // because `transitionInspectionRecord` calls `prisma.$transaction(...)`
  // directly (not `prisma.inspectionRecord.$transaction`). Putting it on
  // the inspectionRecord would leave the route unable to wrap the
  // ack/close/reject/submit helpers.
  const txStore = {
    inspectionRecord: {
      findUnique: async ({ where: { id } }) => records[id] || null,
      update: async ({ where, data }) => {
        const rec = records[where.id];
        if (!rec) {
          const e = new Error('not found');
          e.code = 'P2025';
          throw e;
        }
        if (where.status && rec.status !== where.status) {
          const e = new Error('status changed');
          e.code = 'P2025';
          throw e;
        }
        Object.assign(rec, data);
        return rec;
      },
    },
    // [SOL DR-005] The SUBMIT transition writes a notification row
    // inside the tx (see transitionInspectionRecord). Without this stub
    // the throw surfaces as a 500 via the error middleware.
    notification: { create: async () => ({}) },
  };

  const prisma = {
    inspectionRecord: {
      create: async ({ data }) => {
        const id = `rec-${Math.random().toString(36).slice(2, 8)}`;
        const rec = seedRecord({
          id,
          status: data.status || 'OPEN',
          submittedById: data.submittedById,
        });
        rec.photos = (data.photos && data.photos.create) || [];
        return { ...rec, id };
      },
      findUnique: async ({ where: { id } }) => records[id] || null,
      update: async ({ where, data }) => {
        const rec = records[where.id];
        if (!rec) {
          const e = new Error('not found');
          e.code = 'P2025';
          throw e;
        }
        if (where.status && rec.status !== where.status) {
          const e = new Error('status changed');
          e.code = 'P2025';
          throw e;
        }
        Object.assign(rec, data);
        return rec;
      },
      count: async () => 0,
      findMany: async () => [],
    },
    employee: {
      findUnique: async () => ({ id: OWNER_ID, isAdmin }),
      // fanOutToAdmins → findActiveAdmins guards on this; returning []
      // is exactly the "no admins configured" path, which is what the
      // DRAFT test wants to prove is silent.
      findMany: async () => [],
    },
    notification: { create: async () => ({}) },
    notificationRecipient: { findMany: async () => [] },
    // Top-level transaction wrapper — mirrors Prisma's `$transaction(fn)`
    // shape. We deliberately do NOT short-circuit on a return value
    // because the SUBMIT path performs multiple writes inside the
    // callback (update + notification.create); a top-level mock that
    // returns a single value would lose those side-effects.
    $transaction: async (fn) => fn(txStore),
  };
  app.set('prisma', prisma);
  app.use('/api/inspection', inspectionRouter);
  // Mirror inspection-fresh-admin.test.js: an error middleware so a
  // thrown DB error during the tx (e.g. the SUBMIT path failing the
  // notification.create stub) surfaces as a real HTTP status, not as
  // an unhandled rejection that hangs the test request. Without this
  // the test suite sits at 120s timeout.
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({
      error: err.message || 'INTERNAL_ERROR',
      code: err.code || 'INTERNAL',
    });
  });
  return app;
}

function authHeader(employeeId = OWNER_ID) {
  const token = jwt.sign(
    { employeeId, email: 'test@example.com' },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  );
  return `Bearer ${token}`;
}

beforeEach(() => {
  records = {};
  mockFanOutCalls = [];
});

const VALID_BODY = {
  projectName: 'Site X',
  location: 'Chennai',
  reportDate: '2026-09-04',
  inspectionType: 'material_inspection',
  data: { qty: 100 },
  photos: [],
};

describe('SOL DR-005 — POST /api/inspection accepts DRAFT and stays silent', () => {
  it('saves a DRAFT and does NOT fire admin fan-out', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader())
      .send({ ...VALID_BODY, status: 'DRAFT' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DRAFT');
    // Critical: DRAFT creation must NOT notify admins.
    expect(mockFanOutCalls).toHaveLength(0);
  });

  it('saves an OPEN and DOES fire admin fan-out (regression baseline)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader())
      .send({ ...VALID_BODY, status: 'OPEN' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('OPEN');
    expect(mockFanOutCalls).toHaveLength(1);
    expect(mockFanOutCalls[0].type).toBe('ADMIN_INSPECTION_OPENED');
  });

  it('defaults to OPEN when status is omitted', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader())
      .send(VALID_BODY);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('OPEN');
    expect(mockFanOutCalls).toHaveLength(1);
  });

  it('rejects unknown statuses with 422 STATUS_INVALID', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader())
      .send({ ...VALID_BODY, status: 'BOGUS' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('STATUS_INVALID');
    expect(mockFanOutCalls).toHaveLength(0);
  });
});

describe('SOL DR-005 — POST /api/inspection/:id/submit (DRAFT → OPEN)', () => {
  it('owner submits a DRAFT and the row transitions to OPEN with fan-out', async () => {
    const id = 'draft-1';
    seedRecord({ id, status: 'DRAFT' });
    const app = buildApp();
    const res = await request(app)
      .post(`/api/inspection/${id}/submit`)
      .set('Authorization', authHeader(OWNER_ID))
      .send({});
    expect(res.status).toBe(200);
    expect(records[id].status).toBe('OPEN');
    // The fan-out fires exactly once, post-transition.
    expect(mockFanOutCalls).toHaveLength(1);
    expect(mockFanOutCalls[0].type).toBe('ADMIN_INSPECTION_OPENED');
  });

  it('non-owner cannot submit someone else\'s draft', async () => {
    const id = 'draft-2';
    seedRecord({ id, status: 'DRAFT', submittedById: OWNER_ID });
    const app = buildApp();
    const res = await request(app)
      .post(`/api/inspection/${id}/submit`)
      .set('Authorization', authHeader(OTHER_EMPLOYEE))
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_OWNER');
    expect(records[id].status).toBe('DRAFT'); // unchanged
    expect(mockFanOutCalls).toHaveLength(0);
  });

  it('cannot submit a record that is not DRAFT (e.g. OPEN)', async () => {
    const id = 'rec-already-open';
    seedRecord({ id, status: 'OPEN' });
    const app = buildApp();
    const res = await request(app)
      .post(`/api/inspection/${id}/submit`)
      .set('Authorization', authHeader(OWNER_ID))
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_TRANSITION');
  });

  it('cannot submit a non-existent record', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/inspection/missing/submit')
      .set('Authorization', authHeader())
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

describe('SOL DR-005 — PUT /api/inspection/:id accepts edits on DRAFT', () => {
  it('owner can edit a DRAFT record', async () => {
    const id = 'draft-3';
    seedRecord({ id, status: 'DRAFT' });
    const app = buildApp();
    const res = await request(app)
      .put(`/api/inspection/${id}`)
      .set('Authorization', authHeader(OWNER_ID))
      .send({ projectName: 'Edited' });
    expect(res.status).toBe(200);
    expect(records[id].projectName).toBe('Edited');
    expect(records[id].status).toBe('DRAFT');
  });

  it('owner can still edit an OPEN record (regression baseline)', async () => {
    const id = 'open-1';
    seedRecord({ id, status: 'OPEN' });
    const app = buildApp();
    const res = await request(app)
      .put(`/api/inspection/${id}`)
      .set('Authorization', authHeader(OWNER_ID))
      .send({ projectName: 'Edited Open' });
    expect(res.status).toBe(200);
    expect(records[id].projectName).toBe('Edited Open');
  });

  it('owner cannot edit an ACKNOWLEDGED record (state-machine lock)', async () => {
    const id = 'ack-1';
    seedRecord({ id, status: 'ACKNOWLEDGED' });
    const app = buildApp();
    const res = await request(app)
      .put(`/api/inspection/${id}`)
      .set('Authorization', authHeader(OWNER_ID))
      .send({ projectName: 'too late' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INSPECTION_LOCKED');
  });
});
