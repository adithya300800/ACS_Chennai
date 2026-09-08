// SOL DR-009 — required-array enforcement + canonical severity normalisation.
//
// The audit (Code review by SOL/ACS-Portal-Workflow-Completeness-Review
// 2026-09-08, lines 164-174) flagged two distinct defects on the
// Inspection & Compliance Records wire shape:
//
//   1. Day Activity `checklistItems: []` slipped past the form because
//      WorkEntryForm.jsx validates with `if (field.required && !formData[field.name])`
//      — empty arrays are truthy, so Add and Submit both succeeded with
//      Overall Status Pass even after the user checked and then unchecked
//      every checklist option.
//
//   2. Safety Violation severity "Critical" lived only in `data.severity`
//      while the canonical `severity` column stayed NULL, so the admin
//      queue (which filters on the canonical column) lost the severity
//      signal entirely.
//
// This test pins the server-side fix:
//   - DR-009-A: Day Activity submit with `checklistItems: []` → 400
//     REQUIRED_FIELD_EMPTY with field path `data.checklistItems`.
//   - DR-009-B: Day Activity submit with the field MISSING (undefined) →
//     same 400 (server treats both as empty).
//   - DR-009-C: Safety Violation submit with `data.severity: "Critical"`
//     and wire `severity: null` → canonical `severity` column = "CRITICAL"
//     on the persisted row.
//   - DR-009-D: submit with wire top-level `severity: "Critical"` flows
//     straight through to the canonical column (no double-mapping).
//   - DR-009-E: Near Miss (a tier NOT collapsed to MINOR) maps to the
//     canonical column "NEAR_MISS" so the admin queue filter can target
//     it explicitly.
//   - DR-009-F: a typo in `data.severity` ("Critcal") is rejected as
//     422 SEVERITY_INVALID instead of silently downgrading to NULL.
//
// DRAFT rows are exempt from the required-array contract — the whole
// point of "Save as Draft" is the barest bones. We don't test that here
// (it's the existing N-4 behaviour); the tests above all submit at
// status=OPEN (the default).

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

const OWNER_ID = 'emp-dr009-owner';

let records = {};
let notifications = [];

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
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return records[id];
}

function buildApp({ isAdmin = false } = {}) {
  const app = express();
  app.use(express.json());

  // Shared store backing both the top-level prisma mock and the
  // transaction-callback mock. The POST create path runs inside a
  // tx callback (withRecordTransaction), so writes need to flow through
  // the same store to be visible to the assertions.
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
          data: data.data,
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
    },
    notification: {
      create: async ({ data: notifData }) => {
        const row = {
          id: `notif-${notifications.length + 1}`,
          ...notifData,
          createdAt: new Date(),
        };
        notifications.push(row);
        return row;
      },
    },
  };

  const prisma = {
    inspectionRecord: {
      create: store.inspectionRecord.create,
      findUnique: async ({ where: { id } }) => records[id] || null,
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
    dPR: { findUnique: async () => null },
    boqItem: { findUnique: async () => null },
    // resolveProject (called when POST/PUT arrive with projectName but
    // no projectId) walks findUnique then findFirst with a case-
    // insensitive mode. Returning null for both routes through the
    // 'discovered' branch — the typed name becomes the canonical
    // projectName and no FK is set. Same shape the dr007 test relies
    // on, just made explicit here.
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

const VALID_DAY_ACTIVITY_DATA = (overrides = {}) => ({
  activityType: 'Concrete Pouring',
  location: 'V-101',
  overallStatus: 'Pass',
  observations: 'Workmanship acceptable; no defects observed.',
  inspectedBy: 'Site Engineer',
  ...overrides,
});

const VALID_SAFETY_VIOLATION_DATA = (overrides = {}) => ({
  violationTime: '10:30',
  location: 'V-101',
  violationType: 'PPE Violation',
  description: 'Worker observed without hard hat at slab edge.',
  personsInvolved: 'Mr. X (worker)',
  contractorOrWorker: 'Worker',
  immediateAction: 'Verbal warning issued; PPE issued.',
  stopWorkOrder: 'Yes',
  actionStatus: 'Pending',
  safetyOfficer: 'Safety Officer',
  ...overrides,
});

beforeEach(() => {
  records = {};
  notifications = [];
  mockFanOutCalls = [];
});

// ─── DR-009-A: Day Activity with checklistItems: [] ────────────────────────

describe('SOL DR-009-A — required array enforcement (Day Activity checklistItems: [])', () => {
  it('rejects Day Activity submit with checklistItems: [] as 400 REQUIRED_FIELD_EMPTY', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader(OWNER_ID))
      .send({
        projectName: 'Site X',
        location: 'Chennai',
        reportDate: '2026-09-04',
        inspectionType: 'day_activity_inspection',
        severity: null,
        data: {
          ...VALID_DAY_ACTIVITY_DATA(),
          // The exact wire shape the audit flagged: a user checked and
          // then unchecked every option, producing an empty array.
          checklistItems: [],
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REQUIRED_FIELD_EMPTY');
    expect(res.body.field).toBe('data.checklistItems');
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(res.body.message).toMatch(/checklistItems/);
    // No row was persisted (the validation fires before the create).
    expect(Object.keys(records)).toHaveLength(0);
  });

  it('rejects Day Activity submit with all items unchecked (same wire shape: [])', async () => {
    // The audit explicitly called out "Checking and then unchecking the
    // last required Day Activity item" — wire shape is an empty array.
    // This test is the same defect, just framed differently so the
    // regression cannot be hidden by a future refactor that special-cases
    // `undefined` over `[]`.
    const app = buildApp();
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader(OWNER_ID))
      .send({
        projectName: 'Site X',
        location: 'Chennai',
        reportDate: '2026-09-04',
        inspectionType: 'day_activity_inspection',
        severity: null,
        data: VALID_DAY_ACTIVITY_DATA(),
        // checklistItems omitted entirely — server should also reject.
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REQUIRED_FIELD_EMPTY');
    expect(res.body.field).toBe('data.checklistItems');
    expect(Object.keys(records)).toHaveLength(0);
  });

  it('accepts Day Activity submit with a non-empty checklist', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader(OWNER_ID))
      .send({
        projectName: 'Site X',
        location: 'Chennai',
        reportDate: '2026-09-04',
        inspectionType: 'day_activity_inspection',
        severity: null,
        data: {
          ...VALID_DAY_ACTIVITY_DATA(),
          checklistItems: ['As per drawings', 'Material quality verified'],
        },
      });
    expect(res.status).toBe(201);
    expect(Object.keys(records)).toHaveLength(1);
    const rec = Object.values(records)[0];
    expect(rec.data.checklistItems).toEqual(['As per drawings', 'Material quality verified']);
  });

  it('accepts DRAFT Day Activity rows with no checklist (Save as Draft is intentionally lenient)', async () => {
    // N-4: DRAFT = "save for later" — the barest bones is the whole
    // point. The required-array contract is OPEN-only. Pin that here so
    // a future refactor doesn't accidentally tighten DRAFT. location
    // is still required at write time (the route unconditionally calls
    // location.trim() in the create block) — only the required-ARRAY
    // contract is OPEN-only.
    const app = buildApp();
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader(OWNER_ID))
      .send({
        projectName: 'Site X',
        location: 'Chennai',
        status: 'DRAFT',
        inspectionType: 'day_activity_inspection',
        data: {},
      });
    expect(res.status).toBe(201);
    expect(Object.keys(records)).toHaveLength(1);
    const rec = Object.values(records)[0];
    expect(rec.status).toBe('DRAFT');
  });
});

// ─── DR-009-C: Safety Violation data.severity → canonical column ─────────

describe('SOL DR-009-C — canonical severity normalisation (Safety Violation)', () => {
  it('promotes data.severity "Critical" into the canonical severity column', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader(OWNER_ID))
      .send({
        projectName: 'Site X',
        location: 'Chennai',
        reportDate: '2026-09-04',
        inspectionType: 'safety_violation',
        // Wire top-level severity is always null in InspectionSubmit —
        // the canonical column used to stay NULL and the admin queue
        // lost the severity signal.
        severity: null,
        data: {
          ...VALID_SAFETY_VIOLATION_DATA(),
          severity: 'Critical',
        },
      });
    expect(res.status).toBe(201);
    const rec = Object.values(records)[0];
    expect(rec.severity).toBe('CRITICAL');
    expect(rec.data.severity).toBe('Critical');
  });

  it('uses wire top-level severity "Critical" without double-mapping', async () => {
    // If both wire top-level and data.severity are set, the wire top
    // level wins (it's the explicit signal). Confirm we don't try to
    // remap a canonical value through the Title Case table (which would
    // 422 SEVERITY_INVALID).
    const app = buildApp();
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader(OWNER_ID))
      .send({
        projectName: 'Site X',
        location: 'Chennai',
        reportDate: '2026-09-04',
        inspectionType: 'safety_violation',
        severity: 'CRITICAL',
        data: VALID_SAFETY_VIOLATION_DATA(),
      });
    expect(res.status).toBe(201);
    const rec = Object.values(records)[0];
    expect(rec.severity).toBe('CRITICAL');
  });

  it('maps "Near Miss" to canonical NEAR_MISS (NOT silently downgraded to MINOR)', async () => {
    // The audit explicitly called this out: Near Miss is a distinct
    // severity tier, not an equivalent of Minor. The explicit map keeps
    // the admin queue filter on NEAR_MISS working.
    const app = buildApp();
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader(OWNER_ID))
      .send({
        projectName: 'Site X',
        location: 'Chennai',
        reportDate: '2026-09-04',
        inspectionType: 'safety_violation',
        severity: null,
        data: {
          ...VALID_SAFETY_VIOLATION_DATA(),
          severity: 'Near Miss',
        },
      });
    expect(res.status).toBe(201);
    const rec = Object.values(records)[0];
    expect(rec.severity).toBe('NEAR_MISS');
  });

  it('rejects a typo in data.severity with 422 SEVERITY_INVALID', async () => {
    // "Critcal" (typo) used to silently downgrade to NULL. The fix
    // rejects it so the admin queue can never end up with rows that
    // LOOK severity-less because of a typo.
    const app = buildApp();
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader(OWNER_ID))
      .send({
        projectName: 'Site X',
        location: 'Chennai',
        reportDate: '2026-09-04',
        inspectionType: 'safety_violation',
        severity: null,
        data: {
          ...VALID_SAFETY_VIOLATION_DATA(),
          severity: 'Critcal',
        },
      });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SEVERITY_INVALID');
    expect(res.body.allowed).toEqual(expect.arrayContaining(['Critical', 'Major', 'Minor', 'Near Miss']));
    expect(Object.keys(records)).toHaveLength(0);
  });
});

// ─── DR-009 PUT path: same fixes apply on update ─────────────────────────

describe('SOL DR-009 — PUT (update) path enforces the same contract', () => {
  it('rejects Day Activity PUT that empties checklistItems on an OPEN row', async () => {
    const id = 'dr009-day-open';
    seedRecord({
      id,
      status: 'OPEN',
      inspectionType: 'day_activity_inspection',
      data: {
        ...VALID_DAY_ACTIVITY_DATA(),
        checklistItems: ['As per drawings'],
      },
    });
    const app = buildApp();
    const res = await request(app)
      .put(`/api/inspection/${id}`)
      .set('Authorization', authHeader(OWNER_ID))
      .send({
        data: {
          ...VALID_DAY_ACTIVITY_DATA(),
          checklistItems: [],
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REQUIRED_FIELD_EMPTY');
    expect(res.body.field).toBe('data.checklistItems');
    // The existing row's checklist is preserved (validation fires
    // before the update).
    expect(records[id].data.checklistItems).toEqual(['As per drawings']);
  });

  it('promotes data.severity "Major" into the canonical column on PUT', async () => {
    const id = 'dr009-sv-update';
    seedRecord({
      id,
      status: 'OPEN',
      inspectionType: 'safety_violation',
      data: {
        ...VALID_SAFETY_VIOLATION_DATA(),
        severity: 'Minor',
      },
      severity: 'MINOR',
    });
    const app = buildApp();
    const res = await request(app)
      .put(`/api/inspection/${id}`)
      .set('Authorization', authHeader(OWNER_ID))
      .send({
        severity: null,
        data: {
          ...VALID_SAFETY_VIOLATION_DATA(),
          severity: 'Major',
        },
      });
    expect(res.status).toBe(200);
    expect(records[id].severity).toBe('MAJOR');
    expect(records[id].data.severity).toBe('Major');
  });
});
