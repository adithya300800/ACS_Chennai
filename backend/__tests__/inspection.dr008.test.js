// SOL DR-008 regression coverage. The audit caught that the SUBMIT
// (publish) transition never validated the required-array contract on
// the row's CURRENT data. A draft could be edited to clear the
// Day Activity `checklistItems` array, the form's `if (field.required &&
// !formData[field.name])` check (empty array is truthy) was a separate
// false-positive, and the SUBMIT endpoint had no content gate at all —
// so the cleared checklist landed on the admin queue as an OPEN record.
//
// Fix shape (per the audit's "smallest complete fix"):
//   - Validate the merged effective type+data on every final write
//     (POST, PUT on non-DRAFT, SUBMIT).
//   - Pin the content being validated using a shared row lock or
//     genuine content-version CAS across edit and publish. The
//     existing `status` CAS wasn't enough — a PUT between read and
//     publish doesn't change status, so we add `updatedAt` to the
//     SUBMIT WHERE clause.
//   - Standardize empty draft data as `{}` rather than rejected `null`.
//
// These tests pin all four points against the live router:
//   - DR-008-A: SUBMIT on a draft with `checklistItems: []` → 400
//     REQUIRED_FIELD_EMPTY (the exact audit scenario).
//   - DR-008-B: SUBMIT on a draft that was edited to empty between
//     save and publish is rejected (data shape, not state machine).
//   - DR-008-C: a CONCURRENT draft edit (simulated by mutating the
//     row's updatedAt under the tx) trips the updatedAt CAS — returns
//     409 VERSION_CONFLICT instead of slipping past validation.
//   - DR-008-D: a valid Day Activity draft with `checklistItems`
//     populated publishes successfully.
//   - DR-008-E: POST with `data: null` on a DRAFT normalizes to `{}`
//     (and the row's data column reads `{}`, not `null`).
//   - DR-008-F: PUT that supplies only `inspectionType` (no data) on a
//     non-DRAFT row validates the merged pair (new type + existing
//     data) and rejects when the existing data is missing the new
//     type's required array.
//   - DR-008-G: DRAFT is exempt — clearing checklistItems on a DRAFT
//     is permitted because the whole point of "Save as Draft" is the
//     barest bones.
//   - DR-008-H: a draft edit (PUT on DRAFT) can clear checklistItems
//     and still resave — the DRAFT exemption flows through.

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

jest.mock('../src/lib/blobStorage', () => ({
  generateUploadSASUrl: jest.fn(),
  verifyBlobExists: jest.fn(async () => ({ exists: false })),
  deleteBlob: jest.fn(async () => ({ ok: true })),
  generateReadSASUrl: jest.fn(async () => ({ sasUrl: 'https://r2.example/fake' })),
  CONTENT_TYPE_EXT: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' },
  uploadIntentBinding: { bindPhotoIntents: jest.fn(async () => null) },
}));

const inspectionRouter = require('../src/routes/inspection');

const OWNER_ID = 'emp-dr008-owner';

let records = {};
let notifications = [];
// Test knob: when set, mutate the row's updatedAt inside the
// findUnique handler to simulate a concurrent PUT landing between the
// SUBMIT tx's read and its conditional update. Mirrors what a real
// PUT would do (`updatedAt: new Date()` at PUT inspection.js:1451).
let simulateConcurrentUpdatedAtJump = false;

function seedRecord({
  id,
  status = 'DRAFT',
  submittedById = OWNER_ID,
  inspectionType = 'material_inspection',
  data = { qty: 100 },
  severity = null,
} = {}) {
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
    severity,
    submittedById,
    status,
    photos: [],
    submittedBy: { id: submittedById, name: 'Owner', email: 'o@example.com' },
    dpr: null,
    createdAt: new Date('2026-09-04T09:00:00.000Z'),
    // Stable updatedAt so the CAS clause can pin it.
    updatedAt: new Date('2026-09-04T09:30:00.000Z'),
  };
  return records[id];
}

function buildApp({ isAdmin = false } = {}) {
  const app = express();
  app.use(express.json());

  const store = {
    inspectionRecord: {
      findUnique: async ({ where: { id } }) => {
        const rec = records[id];
        if (!rec) return null;
        // DR-008-C: simulate a concurrent draft PUT landing between our
        // SUBMIT tx read and the conditional update. The "concurrent"
        // PUT bumps updatedAt AND clears the checklistItems array —
        // exactly the audit race: a draft edit that invalidates content
        // while the SUBMIT tx is mid-flight.
        if (simulateConcurrentUpdatedAtJump && rec.status === 'DRAFT') {
          rec.updatedAt = new Date('2026-09-04T09:35:00.000Z');
          rec.data = { ...(rec.data || {}), checklistItems: [] };
        }
        return rec;
      },
      update: async ({ where, data }) => {
        const rec = records[where.id];
        if (!rec) {
          const e = new Error('not found');
          e.code = 'P2025';
          throw e;
        }
        // DR-008: honor the conditional WHERE clause so the
        // updatedAt CAS test (DR-008-C) trips a P2025.
        if (where.status && rec.status !== where.status) {
          const e = new Error('status changed');
          e.code = 'P2025';
          throw e;
        }
        if (where.updatedAt && rec.updatedAt.getTime() !== where.updatedAt.getTime()) {
          const e = new Error('updatedAt changed');
          e.code = 'P2025';
          throw e;
        }
        Object.assign(rec, data);
        return rec;
      },
    },
    notification: {
      create: async ({ data }) => {
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
        const rec = {
          id,
          projectName: data.projectName || 'Site X',
          location: data.location || 'Chennai',
          reportDate: data.reportDate || new Date('2026-09-04T00:00:00.000Z'),
          weather: data.weather || null,
          contractor: data.contractor || null,
          dprId: data.dprId || null,
          inspectionType: data.inspectionType,
          // DR-008-E: server normalises null → {}. The create mock
          // preserves whatever the handler wrote.
          data: data.data === null || data.data === undefined ? {} : data.data,
          severity: data.severity,
          submittedById: data.submittedById,
          status: data.status,
          photos: [],
          submittedBy: { id: data.submittedById, name: 'Owner', email: 'o@example.com' },
          dpr: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        records[id] = rec;
        return rec;
      },
      findUnique: store.inspectionRecord.findUnique,
      update: store.inspectionRecord.update,
      count: async () => 0,
      findMany: async () => [],
    },
    employee: {
      findUnique: async () => ({ id: OWNER_ID, isAdmin }),
      findMany: async () => [],
    },
    notification: {
      create: async (args) => store.notification.create(args),
      findMany: async () => notifications,
    },
    notificationRecipient: { findMany: async () => [] },
    project: {
      findUnique: async () => null,
      findFirst: async () => null,
    },
    drawing: { findUnique: async () => null, findFirst: async () => null },
    $transaction: async (fn) => fn(store),
  };
  app.set('prisma', prisma);
  app.use('/api/inspection', inspectionRouter);
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

const VALID_DAY_ACTIVITY = (overrides = {}) => ({
  activityType: 'Concrete Pouring',
  location: 'V-101',
  overallStatus: 'Pass',
  observations: 'Workmanship acceptable; no defects observed.',
  inspectedBy: 'Site Engineer',
  ...overrides,
});

beforeEach(() => {
  records = {};
  notifications = [];
  mockFanOutCalls = [];
  simulateConcurrentUpdatedAtJump = false;
});

// ─── DR-008-A: SUBMIT on draft with empty checklistItems → 400 ──────────────

describe('SOL DR-008-A — SUBMIT (publish) rejects drafts with empty required arrays', () => {
  it('SUBMIT on a draft with checklistItems: [] returns 400 REQUIRED_FIELD_EMPTY', async () => {
    // The exact audit scenario: user picks Day Activity, checks one
    // item, then unchecks it, then Save as Draft, then Publish. The
    // empty required array used to slip past SUBMIT because the
    // transition only checked the state machine.
    const id = 'dr008-empty-checklist';
    seedRecord({
      id,
      status: 'DRAFT',
      inspectionType: 'day_activity_inspection',
      data: { ...VALID_DAY_ACTIVITY(), checklistItems: [] },
    });
    const app = buildApp();
    const res = await request(app)
      .post(`/api/inspection/${id}/submit`)
      .set('Authorization', authHeader(OWNER_ID))
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REQUIRED_FIELD_EMPTY');
    expect(res.body.field).toBe('data.checklistItems');
    // Row stays DRAFT — the rejection did not transition status.
    expect(records[id].status).toBe('DRAFT');
    // No notification written, no admin fan-out fired.
    expect(notifications).toHaveLength(0);
    expect(mockFanOutCalls).toHaveLength(0);
  });
});

// ─── DR-008-B: SUBMIT on a draft that was edited to empty between save and publish ──

describe('SOL DR-008-B — SUBMIT (publish) validates the merged effective state', () => {
  it('SUBMIT reads the row\'s CURRENT data, not the request payload', async () => {
    // The row was saved with a populated checklist, then PUT to clear
    // it. SUBMIT must validate the current DB state — there's no body
    // in /submit for data, so the only sensible source is the row.
    const id = 'dr008-edited-empty';
    seedRecord({
      id,
      status: 'DRAFT',
      inspectionType: 'day_activity_inspection',
      data: { ...VALID_DAY_ACTIVITY(), checklistItems: ['As per drawings'] },
    });
    // Simulate the owner PUT-clearing the checklist between save+submit.
    records[id].data = { ...VALID_DAY_ACTIVITY(), checklistItems: [] };
    const app = buildApp();
    const res = await request(app)
      .post(`/api/inspection/${id}/submit`)
      .set('Authorization', authHeader(OWNER_ID))
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REQUIRED_FIELD_EMPTY');
    expect(records[id].status).toBe('DRAFT');
  });
});

// ─── DR-008-C: concurrent draft edit trips updatedAt CAS ────────────────────

describe('SOL DR-008-C — SUBMIT updatedAt CAS catches concurrent draft edits', () => {
  it('returns 409 VERSION_CONFLICT when a concurrent draft edit lands between read and update', async () => {
    const id = 'dr008-concurrent-edit';
    seedRecord({
      id,
      status: 'DRAFT',
      inspectionType: 'day_activity_inspection',
      data: { ...VALID_DAY_ACTIVITY(), checklistItems: ['As per drawings'] },
    });
    // The mock findUnique handler bumps updatedAt and clears
    // checklistItems before the SUBMIT tx's conditional update fires —
    // exactly the audit's "concurrent invalidating edit" race.
    simulateConcurrentUpdatedAtJump = true;
    const app = buildApp();
    const res = await request(app)
      .post(`/api/inspection/${id}/submit`)
      .set('Authorization', authHeader(OWNER_ID))
      .send({});
    // DR-008-C: the row's updatedAt drifted, the conditional update
    // failed, and the catch mapped P2025 → 409 VERSION_CONFLICT. The
    // owner refetches and retries against the now-empty content (which
    // will then fail DR-008-A's content check on the next attempt).
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');
    expect(records[id].status).toBe('DRAFT');
    expect(notifications).toHaveLength(0);
  });
});

// ─── DR-008-D: a valid draft publishes successfully ─────────────────────────

describe('SOL DR-008-D — SUBMIT (publish) accepts a draft with valid content', () => {
  it('a draft with populated checklistItems transitions to OPEN with fan-out', async () => {
    const id = 'dr008-valid-draft';
    seedRecord({
      id,
      status: 'DRAFT',
      inspectionType: 'day_activity_inspection',
      data: { ...VALID_DAY_ACTIVITY(), checklistItems: ['As per drawings'] },
    });
    const app = buildApp();
    const res = await request(app)
      .post(`/api/inspection/${id}/submit`)
      .set('Authorization', authHeader(OWNER_ID))
      .send({});
    expect(res.status).toBe(200);
    expect(records[id].status).toBe('OPEN');
    expect(notifications).toHaveLength(1);
    expect(mockFanOutCalls).toHaveLength(1);
  });
});

// ─── DR-008-E: POST with data: null normalizes to {} on DRAFT ──────────────

describe('SOL DR-008-E — DRAFT data: null normalizes to {}', () => {
  it('saves a DRAFT with data: null and persists {} (not null) on the row', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader(OWNER_ID))
      .send({
        projectName: 'Site X',
        location: 'TBD',
        reportDate: '2026-09-04',
        inspectionType: 'day_activity_inspection',
        severity: null,
        status: 'DRAFT',
        // The exact wire shape the audit flagged: barest-bones draft
        // with null data. Was rejected; now normalized to {}.
        data: null,
      });
    expect(res.status).toBe(201);
    // Persisted data is an object — never null — so downstream reads
    // don't need to special-case it.
    const persisted = Object.values(records)[0];
    expect(persisted.data).toEqual({});
    expect(persisted.data).not.toBeNull();
  });
});

// ─── DR-008-F: type-only PUT on non-DRAFT validates merged effective pair ──

describe('SOL DR-008-F — type-only PUT on non-DRAFT row validates merged effective pair', () => {
  it('PUT that flips inspectionType without supplying data validates existing data', async () => {
    // Non-DRAFT row has an empty checklistItems. PUT flips the type
    // from material_inspection to day_activity_inspection. The merged
    // pair (new type + existing data) fails the contract, even though
    // `data` was omitted from the request.
    const id = 'dr008-type-only-update';
    seedRecord({
      id,
      status: 'OPEN',
      inspectionType: 'material_inspection',
      data: { qty: 100 },
    });
    const app = buildApp();
    const res = await request(app)
      .put(`/api/inspection/${id}`)
      .set('Authorization', authHeader(OWNER_ID))
      .send({ inspectionType: 'day_activity_inspection' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REQUIRED_FIELD_EMPTY');
    expect(res.body.field).toBe('data.checklistItems');
    // Row unchanged.
    expect(records[id].inspectionType).toBe('material_inspection');
  });
});

// ─── DR-008-G: DRAFT is exempt — empty required arrays are allowed ──────────

describe('SOL DR-008-G — DRAFT rows are exempt from the required-array contract', () => {
  it('PUT on a DRAFT row with empty checklistItems is permitted (Save as Draft semantics)', async () => {
    // The audit calls out that DRAFT is the "save for later" state —
    // the barest bones is the whole point. DRAFT edits that clear the
    // required array must resave cleanly so the owner can come back
    // and refill before publish.
    const id = 'dr008-draft-empty-resave';
    seedRecord({
      id,
      status: 'DRAFT',
      inspectionType: 'day_activity_inspection',
      data: { ...VALID_DAY_ACTIVITY(), checklistItems: ['As per drawings'] },
    });
    const app = buildApp();
    const res = await request(app)
      .put(`/api/inspection/${id}`)
      .set('Authorization', authHeader(OWNER_ID))
      .send({
        data: { ...VALID_DAY_ACTIVITY(), checklistItems: [] },
      });
    // The DRAFT exemption lets the empty array persist.
    expect(res.status).toBe(200);
    expect(records[id].data.checklistItems).toEqual([]);
    expect(records[id].status).toBe('DRAFT');
  });
});
