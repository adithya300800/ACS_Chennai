// SOL DR-013 regression coverage. The "final" inspection validation was
// scattered (only the per-subtype required-array contract from DR-009 ran,
// and only when the caller supplied an inspectionType that matched a single
// entry — `day_activity_inspection`). Cube Casting / Cube Testing carried
// an `isCritical: true` flag in the form schema but the server only
// accepted "must be a JSON object"; a project-only material draft could
// later publish without required scalar fields (cube count, grade, age),
// and `numberOfCubes: -1` slipped past every write path.
//
// Fix shape (per audit's "smallest complete fix"):
//   - One server-side `validateFinalInspection` helper.
//   - Mirrors the per-subtype scalar `required` flags from
//     src/pages/portal/WorkTypes.jsx (cube_casting + cube_testing are the
//     audit-flagged "final" subtypes).
//   - Each field carries a `kind` (`nonEmptyString`, `finiteNumber`,
//     `positiveNumber`, `positiveInteger`) so engineering decimals pass
//     (`compressiveStrength: 23.45`) while half-cast counts fail
//     (`numberOfCubes: -1` / `numberOfCubes: 0.5`).
//   - Routed through every final write path: POST (final create), PUT
//     (editable-final update), POST /:id/submit (publish).
//   - DRAFT stays permissive — the barest bones is the whole point of
//     "Save as Draft".
//
// Acceptance locked by the tests below:
//   - DR-013-A: POST with cube_casting omits required scalar fields →
//     400 REQUIRED_FIELD_MISSING_OR_INVALID.
//   - DR-013-B: POST with cube_casting.numberOfCubes = -1 → 400.
//   - DR-013-C: POST with cube_casting.numberOfCubes = 0.5 → 400.
//   - DR-013-D: POST with cube_testing.compressiveStrength = 23.45 → 201
//     (engineering decimals still pass the finiteNumber kind).
//   - DR-013-E: POST with valid cube_casting payload → 201.
//   - DR-013-F: POST with cube_casting + status: 'DRAFT' → 201 (DRAFT
//     exempted by design).
//   - DR-013-G: PUT (editable-final update) missing required scalar
//     fields → 400.
//   - DR-013-H: SUBMIT (DRAFT → OPEN) with cube_casting numberOfCubes
//     stripped between Save and Publish → 400 (publish reads CURRENT
//     row state, mirrors DR-008-B).

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

let mockFanOutCalls = [];
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

const OWNER_ID = 'emp-dr013-owner';

let records = {};
let notifications = [];

function seedRecord({
  id,
  status = 'DRAFT',
  submittedById = OWNER_ID,
  inspectionType = 'cube_casting',
  data = {},
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
    updatedAt: new Date('2026-09-04T09:30:00.000Z'),
  };
  return records[id];
}

function buildApp({ isAdmin = false } = {}) {
  const app = express();
  app.use(express.json());

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
        const row = { id: `notif-${notifications.length + 1}`, ...data, createdAt: new Date() };
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
      create: (args) => store.notification.create(args),
      findMany: async () => notifications,
    },
    notificationRecipient: { findMany: async () => [] },
    project: { findUnique: async () => null, findFirst: async () => null },
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

// A "good" cube_casting payload — every required scalar field present and
// in the right `kind`. Tests that want to break a single field start from
// this base and override the offender.
const VALID_CUBE_CASTING = {
  cubeId: 'C-2026-001',
  grade: 'M25',
  pourLocation: 'V-101',
  pourActivity: 'Column',
  quantityOfConcrete: 4.5,
  cubeSize: '150mm x 150mm x 150mm',
  numberOfCubes: 6,
  curingMethod: 'Ponding',
  daysToTest: '7 Days',
  mixDesignRef: 'MD-25-1',
  slumpRecorded: 75,
  castBy: 'Engineer A',
  supervisedBy: 'Engineer B',
};

// A "good" cube_testing payload — mirror of the WORK_TYPE_FIELDS schema in
// WorkTypes.jsx. Tests assert engineering decimals (23.45) pass the
// finiteNumber kind for compressiveStrength, while ageOfCube=0.5 / -1
// fails the positiveInteger kind.
const VALID_CUBE_TESTING = {
  cubeId: 'C-2026-001',
  grade: 'M25',
  ageOfCube: 7,
  castingDate: '2026-08-28',
  loadAtFailure: 540,
  compressiveStrength: 23.45,
  requiredStrength: 25,
  percentageOfRequired: 93.8,
  result: 'Pass',
  testingMachineId: 'TM-007',
  testedBy: 'Lab Engineer',
};

const VALID_BODY = {
  projectName: 'Site X',
  location: 'Chennai',
  reportDate: '2026-09-04',
  inspectionType: 'cube_casting',
  data: VALID_CUBE_CASTING,
  photos: [],
};

beforeEach(() => {
  records = {};
  notifications = [];
  mockFanOutCalls = [];
});

// ─── DR-013-A: POST omits required scalar field → 400 ───────────────────────

describe('SOL DR-013-A — POST (final create) rejects cube_casting without required scalar fields', () => {
  it('omitting numberOfCubes returns 400 REQUIRED_FIELD_MISSING_OR_INVALID', async () => {
    const { numberOfCubes: _omitted, ...incompleteData } = VALID_CUBE_CASTING;
    const app = buildApp();
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader())
      .send({ ...VALID_BODY, data: incompleteData });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REQUIRED_FIELD_MISSING_OR_INVALID');
    expect(res.body.field).toBe('data.numberOfCubes');
  });

  it('omitting grade (a nonEmptyString field) returns 400 REQUIRED_FIELD_MISSING_OR_INVALID', async () => {
    const { grade: _omitted, ...incompleteData } = VALID_CUBE_CASTING;
    const app = buildApp();
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader())
      .send({ ...VALID_BODY, data: incompleteData });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REQUIRED_FIELD_MISSING_OR_INVALID');
    expect(res.body.field).toBe('data.grade');
  });

  it('omitting a finiteNumber (slumpRecorded) returns 400 REQUIRED_FIELD_MISSING_OR_INVALID', async () => {
    const { slumpRecorded: _omitted, ...incompleteData } = VALID_CUBE_CASTING;
    const app = buildApp();
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader())
      .send({ ...VALID_BODY, data: incompleteData });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REQUIRED_FIELD_MISSING_OR_INVALID');
    expect(res.body.field).toBe('data.slumpRecorded');
  });
});

// ─── DR-013-B/C: numeric boundary enforcement ──────────────────────────────

describe('SOL DR-013-B/C — POST enforces numeric kinds on cube_casting', () => {
  it('numberOfCubes = -1 returns 400 (positiveInteger rejects negative)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader())
      .send({
        ...VALID_BODY,
        data: { ...VALID_CUBE_CASTING, numberOfCubes: -1 },
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REQUIRED_FIELD_MISSING_OR_INVALID');
    expect(res.body.field).toBe('data.numberOfCubes');
    expect(res.body.message).toMatch(/positive integer/);
  });

  it('numberOfCubes = 0 returns 400 (positiveInteger rejects zero)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader())
      .send({
        ...VALID_BODY,
        data: { ...VALID_CUBE_CASTING, numberOfCubes: 0 },
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REQUIRED_FIELD_MISSING_OR_INVALID');
    expect(res.body.field).toBe('data.numberOfCubes');
  });

  it('numberOfCubes = 0.5 returns 400 (positiveInteger rejects non-integer)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader())
      .send({
        ...VALID_BODY,
        data: { ...VALID_CUBE_CASTING, numberOfCubes: 0.5 },
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REQUIRED_FIELD_MISSING_OR_INVALID');
    expect(res.body.field).toBe('data.numberOfCubes');
  });

  it('numberOfCubes = "abc" returns 400 (numeric kind rejects non-parseable string)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader())
      .send({
        ...VALID_BODY,
        data: { ...VALID_CUBE_CASTING, numberOfCubes: 'abc' },
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REQUIRED_FIELD_MISSING_OR_INVALID');
    expect(res.body.field).toBe('data.numberOfCubes');
  });

  it('numberOfCubes as string "6" is accepted (form numbers arrive as strings)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader())
      .send({
        ...VALID_BODY,
        data: { ...VALID_CUBE_CASTING, numberOfCubes: '6' },
      });
    expect(res.status).toBe(201);
  });

  it('quantityOfConcrete = -1 passes the finiteNumber gate (audience-magnitude fields accept negatives)', async () => {
    // finiteNumber kind is "must parse to a finite number" — no positive
    // constraint applies. -1 IS finite, so this should pass the gate.
    // The audit acceptance line "Negative/noninteger cube COUNTS fail"
    // targets the positiveInteger kind specifically (cube counts), not
    // all finiteNumber fields. This test pins that contract so a future
    // refactor doesn't quietly upgrade finiteNumber → positiveNumber
    // and start rejecting engineering magnitudes (e.g. slump readings
    // below the test slab level).
    const app = buildApp();
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader())
      .send({
        ...VALID_BODY,
        data: { ...VALID_CUBE_CASTING, quantityOfConcrete: -1 },
      });
    expect(res.status).toBe(201);
  });
});

// ─── DR-013-D: engineering decimals still pass ─────────────────────────────

describe('SOL DR-013-D — POST accepts valid engineering decimals', () => {
  it('cube_testing with compressiveStrength = 23.45 returns 201', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader())
      .send({
        projectName: 'Site X',
        location: 'Chennai',
        reportDate: '2026-09-04',
        inspectionType: 'cube_testing',
        data: VALID_CUBE_TESTING,
        photos: [],
      });
    expect(res.status).toBe(201);
    expect(mockFanOutCalls).toHaveLength(1); // OPEN → admin fan-out
  });

  it('cube_casting with quantityOfConcrete = 4.5 returns 201', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader())
      .send(VALID_BODY);
    expect(res.status).toBe(201);
  });
});

// ─── DR-013-E: valid cube_casting lands cleanly ────────────────────────────

describe('SOL DR-013-E — POST (final create) accepts a complete cube_casting payload', () => {
  it('returns 201 and the row is persisted with OPEN status + admin fan-out', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader())
      .send(VALID_BODY);
    expect(res.status).toBe(201);
    expect(res.body.inspectionType).toBe('cube_casting');
    expect(res.body.data.numberOfCubes).toBe(6);
    expect(mockFanOutCalls).toHaveLength(1);
  });
});

// ─── DR-013-F: DRAFT path stays permissive ─────────────────────────────────

describe('SOL DR-013-F — DRAFT exemption carries through the new validator', () => {
  it('POST with status: DRAFT and bare-bones data (no cube count) returns 201', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader())
      .send({ ...VALID_BODY, status: 'DRAFT', data: null });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DRAFT');
    // DRAFT never fires admin fan-out — same contract as DR-005 baseline.
    expect(mockFanOutCalls).toHaveLength(0);
  });
});

// ─── DR-013-G: PUT (editable-final update) uses the same validator ─────────

describe('SOL DR-013-G — PUT enforces the same contract on editable-final updates', () => {
  it('PUT on an OPEN row with cleared numberOfCubes returns 400 REQUIRED_FIELD_MISSING_OR_INVALID', async () => {
    const id = 'dr013-put-open';
    seedRecord({
      id,
      status: 'OPEN',
      inspectionType: 'cube_casting',
      data: VALID_CUBE_CASTING,
    });
    const { numberOfCubes: _omitted, ...incompleteData } = VALID_CUBE_CASTING;
    const app = buildApp();
    const res = await request(app)
      .put(`/api/inspection/${id}`)
      .set('Authorization', authHeader(OWNER_ID))
      .send({ data: incompleteData });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REQUIRED_FIELD_MISSING_OR_INVALID');
    expect(res.body.field).toBe('data.numberOfCubes');
  });

  it('PUT on a DRAFT row still permits bare-bones edits (DRAFT exempt — DR-013-F carries through)', async () => {
    const id = 'dr013-put-draft';
    seedRecord({
      id,
      status: 'DRAFT',
      inspectionType: 'cube_casting',
      data: {},
    });
    const app = buildApp();
    const res = await request(app)
      .put(`/api/inspection/${id}`)
      .set('Authorization', authHeader(OWNER_ID))
      .send({ data: {} });
    expect(res.status).toBe(200);
  });
});

// ─── DR-013-H: SUBMIT validates the row's CURRENT data (mirror of DR-008-B)

describe('SOL DR-013-H — SUBMIT (publish) enforces the final-subtype contract', () => {
  it('SUBMIT on a DRAFT cube_casting with numberOfCubes = -1 returns 400 REQUIRED_FIELD_MISSING_OR_INVALID', async () => {
    const id = 'dr013-submit-bad';
    seedRecord({
      id,
      status: 'DRAFT',
      inspectionType: 'cube_casting',
      data: { ...VALID_CUBE_CASTING, numberOfCubes: -1 },
    });
    const app = buildApp();
    const res = await request(app)
      .post(`/api/inspection/${id}/submit`)
      .set('Authorization', authHeader(OWNER_ID))
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REQUIRED_FIELD_MISSING_OR_INVALID');
    expect(res.body.field).toBe('data.numberOfCubes');
    // Row stays DRAFT — rejection did not transition status.
    expect(records[id].status).toBe('DRAFT');
    expect(notifications).toHaveLength(0);
    expect(mockFanOutCalls).toHaveLength(0);
  });

  it('SUBMIT on a DRAFT cube_casting stripped of grade between Save and Publish returns 400', async () => {
    const id = 'dr013-submit-stripped';
    seedRecord({
      id,
      status: 'DRAFT',
      inspectionType: 'cube_casting',
      data: VALID_CUBE_CASTING,
    });
    // Mirror DR-008-B: the owner PUT-clears the grade between Save and
    // Submit. SUBMIT must validate the current row state, not the
    // create-time payload.
    const { grade: _cleared, ...rowAfterClear } = VALID_CUBE_CASTING;
    records[id].data = rowAfterClear;
    const app = buildApp();
    const res = await request(app)
      .post(`/api/inspection/${id}/submit`)
      .set('Authorization', authHeader(OWNER_ID))
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REQUIRED_FIELD_MISSING_OR_INVALID');
    expect(res.body.field).toBe('data.grade');
    expect(records[id].status).toBe('DRAFT');
  });

  it('SUBMIT on a valid DRAFT cube_casting transitions to OPEN + fires fan-out', async () => {
    const id = 'dr013-submit-valid';
    seedRecord({
      id,
      status: 'DRAFT',
      inspectionType: 'cube_casting',
      data: VALID_CUBE_CASTING,
    });
    const app = buildApp();
    const res = await request(app)
      .post(`/api/inspection/${id}/submit`)
      .set('Authorization', authHeader(OWNER_ID))
      .send({});
    expect(res.status).toBe(200);
    expect(records[id].status).toBe('OPEN');
    expect(mockFanOutCalls).toHaveLength(1);
  });

  it('SUBMIT on a DRAFT cube_testing with ageOfCube = "ten" returns 400', async () => {
    const id = 'dr013-submit-cube-test';
    seedRecord({
      id,
      status: 'DRAFT',
      inspectionType: 'cube_testing',
      data: { ...VALID_CUBE_TESTING, ageOfCube: 'ten' },
    });
    const app = buildApp();
    const res = await request(app)
      .post(`/api/inspection/${id}/submit`)
      .set('Authorization', authHeader(OWNER_ID))
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REQUIRED_FIELD_MISSING_OR_INVALID');
    expect(res.body.field).toBe('data.ageOfCube');
  });
});
