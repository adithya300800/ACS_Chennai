// SOL DR-007 regression coverage. The audit caught two distinct defects
// in the inspection draft continuation flow:
//
//   1. Save → reload → resume → edit → publish had no UI path on the
//      list / detail / submit surfaces (frontend wiring only — verified
//      manually on InspectionList.jsx, InspectionDetail.jsx,
//      InspectionSubmit.jsx). The endpoint existed and worked for the
//      happy path; the gap was reachability.
//
//   2. POST /api/inspection/:id/submit attempted to insert a notification
//      row with type=null into a non-null String column. The route
//      hard-coded `notifType = null` for the SUBMIT branch in
//      transitionInspectionRecord, then fed that null straight into
//      `tx.notification.create({ data: { ..., type: notifType } })`.
//
// This test pins both defects against the live router:
//
//   - DR-007-A: a valid DRAFT submitted via POST /:id/submit transitions
//     to OPEN, writes a Notification row whose type is a non-null
//     string literal, and preserves any photos already attached to the
//     DRAFT row (the audit called out "attachments preserved").
//
//   - DR-007-B: a second POST /:id/submit on the same record (the audit
//     asked for idempotency on "already-SUBMITTED" = already-OPEN) is a
//     200 no-op that does NOT write a duplicate Notification row and
//     does NOT re-fire the admin fan-out.
//
// The DR-009 acceptance criteria (reject empty required arrays and the
// Day Activity `checklistItems: []` defect) are flagged but NOT
// implemented here — see the report for the overlap note.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

let mockFanOutCalls = [];
let mockNotificationCreates = [];
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

const inspectionRouter = require('../src/routes/inspection');

const OWNER_ID = 'emp-dr007-owner';

let records = {};
let notifications = [];

function seedRecord({
  id,
  status = 'DRAFT',
  submittedById = OWNER_ID,
  inspectionType = 'material_inspection',
  data = { qty: 100 },
  photoCount = 0,
} = {}) {
  const photos = [];
  for (let i = 0; i < photoCount; i += 1) {
    photos.push({
      id: `photo-${id}-${i}`,
      inspectionId: id,
      ulid: `ulid-${id}-${i}`,
      container: 'inspection-photos',
      filename: `p-${i}.jpg`,
      contentType: 'image/jpeg',
      sizeBytes: 1024,
      caption: null,
      location: null,
      takenAt: new Date('2026-09-04T10:00:00.000Z'),
      uploadedAt: new Date(),
    });
  }
  records[id] = {
    id,
    projectName: 'Site X',
    location: 'Chennai',
    reportDate: new Date('2026-09-04T00:00:00.000Z'),
    weather: 'Sunny',
    contractor: null,
    dprId: null,
    inspectionType,
    data,
    severity: null,
    submittedById,
    status,
    photos,
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

  // Shared in-memory store backing the per-method prisma mocks. The
  // transaction body uses the same shared store so a write inside the
  // tx callback (e.g. tx.notification.create) is visible to the
  // post-tx assertions.
  const store = {
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
    notification: {
      create: async ({ data }) => {
        // DR-007: capture every per-record notification the SUBMIT
        // tx creates so the test can assert the type is a non-null
        // string literal. The Prisma shape is { employeeId, type,
        // message }.
        const row = {
          id: `notif-${notifications.length + 1}`,
          ...data,
          createdAt: new Date(),
        };
        notifications.push(row);
        return row;
      },
    },
  };

  const prisma = {
    inspectionRecord: {
      create: async ({ data }) => {
        const id = `rec-${Math.random().toString(36).slice(2, 8)}`;
        const rec = seedRecord({
          id,
          status: data.status || 'OPEN',
          submittedById: data.submittedById,
          inspectionType: data.inspectionType,
          data: data.data,
          photoCount: 0,
        });
        if (Array.isArray(data.photos)) rec.photos = [...data.photos];
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
      // is exactly the "no admins configured" path, which keeps the
      // fan-out tests focused on the per-record notification row.
      findMany: async () => [],
    },
    notification: {
      create: async (args) => store.notification.create(args),
      findMany: async () => notifications,
    },
    notificationRecipient: { findMany: async () => [] },
    // Top-level transaction wrapper — mirrors Prisma's `$transaction(fn)`
    // shape. The SUBMIT path performs update + notification.create
    // inside the callback; a top-level mock that returns a single
    // value would lose those side-effects.
    $transaction: async (fn) => fn(store),
  };
  app.set('prisma', prisma);
  app.use('/api/inspection', inspectionRouter);
  // Error middleware so a thrown DB error during the tx surfaces as a
  // real HTTP status, not as an unhandled rejection that hangs the
  // test request.
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
  notifications = [];
  mockFanOutCalls = [];
});

describe('SOL DR-007 — POST /api/inspection/:id/submit (notification.type non-null)', () => {
  it('owner submits a valid DRAFT and the per-record notification type is a non-null string', async () => {
    const id = 'dr007-valid-draft';
    // Photos already attached to the DRAFT row — the audit calls these
    // out as "attachments preserved" through the transition.
    seedRecord({ id, status: 'DRAFT', photoCount: 2 });
    const app = buildApp();
    const res = await request(app)
      .post(`/api/inspection/${id}/submit`)
      .set('Authorization', authHeader(OWNER_ID))
      .send({});
    expect(res.status).toBe(200);
    expect(records[id].status).toBe('OPEN');
    // Exactly one notification row was written by the SUBMIT tx.
    expect(notifications).toHaveLength(1);
    // DR-007-A: the type must be a non-null string literal. Before the
    // fix this was `null` and the test caught it because Prisma's
    // non-null column would 500 the create in a real DB.
    expect(notifications[0].type).toBeTruthy();
    expect(typeof notifications[0].type).toBe('string');
    expect(notifications[0].type).not.toBe('null');
    // The notification goes to the owner (matches the
    // transitionInspectionRecord contract).
    expect(notifications[0].employeeId).toBe(OWNER_ID);
    // Admin fan-out fires exactly once, post-tx.
    expect(mockFanOutCalls).toHaveLength(1);
    expect(mockFanOutCalls[0].type).toBe('ADMIN_INSPECTION_OPENED');
    // Attachments preserved: the 2 photos that were on the DRAFT row
    // are still attached after the transition.
    expect(records[id].photos).toHaveLength(2);
  });

  it('is idempotent when called a second time on the same record (already-OPEN)', async () => {
    const id = 'dr007-already-open';
    seedRecord({ id, status: 'OPEN', photoCount: 1 });
    const app = buildApp();
    const res = await request(app)
      .post(`/api/inspection/${id}/submit`)
      .set('Authorization', authHeader(OWNER_ID))
      .send({});
    // DR-007-B: re-submit on already-OPEN is a 200 no-op. Before the
    // fix this returned 409 INVALID_TRANSITION, which reads as
    // "the system rejected my submit" even though the row is in the
    // correct terminal state.
    expect(res.status).toBe(200);
    expect(records[id].status).toBe('OPEN');
    // No duplicate notification row.
    expect(notifications).toHaveLength(0);
    // No duplicate admin fan-out (avoids spamming the admin inbox on
    // a NETWORK_ERROR retry of an already-committed submit).
    expect(mockFanOutCalls).toHaveLength(0);
    // Attachments preserved.
    expect(records[id].photos).toHaveLength(1);
  });

  it('still rejects submit on a record in a terminal admin state (CLOSED)', async () => {
    const id = 'dr007-closed';
    seedRecord({ id, status: 'CLOSED' });
    const app = buildApp();
    const res = await request(app)
      .post(`/api/inspection/${id}/submit`)
      .set('Authorization', authHeader(OWNER_ID))
      .send({});
    // Only OPEN gets the idempotent path. CLOSED is a terminal admin
    // state — owner re-submission would (a) bypass the admin's
    // decision and (b) bypass the audit trail of admin action.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_TRANSITION');
    expect(notifications).toHaveLength(0);
    expect(mockFanOutCalls).toHaveLength(0);
  });
});

describe('SOL DR-007 — frontend wiring contract (api.submitInspection shape)', () => {
  // This block documents the helper contract that the frontend wiring
  // in src/pages/portal/InspectionSubmit.jsx relies on. The api helper
  // already exists at src/lib/api.js:477 — this test pins that the
  // route accepts an empty POST body and returns the row in its
  // terminal state, which is exactly what api.submitInspection sends.
  it('accepts an empty POST body and returns the row in OPEN state', async () => {
    const id = 'dr007-empty-body';
    seedRecord({ id, status: 'DRAFT' });
    const app = buildApp();
    const res = await request(app)
      .post(`/api/inspection/${id}/submit`)
      .set('Authorization', authHeader(OWNER_ID))
      // Mirrors api.submitInspection(id, token) → api.post(`/inspection/${id}/submit`, {}, token)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OPEN');
    expect(res.body.id).toBe(id);
  });
});

// SOL DR-007 / DR-009 OVERLAP FLAG
// ---------------------------------
// The audit's guardrail #4 also asked for tests covering:
//   - "Submit with empty required arrays → 400" (DR-009 prerequisite)
//   - "Submit attempt on DRAFT that lacks required subtype data
//     (empty checklistItems for Day Activity) → 400 with field path"
// Both are accepted as DR-009 scope in the audit; the backend
// transitionInspectionRecord handler does not currently reject these
// payloads (it only checks `allowedFrom`). Tests for these scenarios
// should be added under backend/__tests__/inspection.dr009.test.js
// when DR-009 lands — see the report for the overlap note.
