// ─────────────────────────────────────────────────────────────────────────────
// N5 (round-29): cube-test integration API tests.
//
// Pins:
//   - Auth: 401 without token on GET /api/cube-tests.
//   - Create: success path with both FKs (casting inspection + dpr).
//   - Create: 403 when the casting inspection belongs to another employee.
//   - Create: 400 when the referenced inspection is NOT cube_casting.
//   - Update: status flips to TWENTY_EIGHT_DAY_PASSED when result >= expected.
//   - Update: status flips to TWENTY_EIGHT_DAY_FAILED when result < expected.
//   - Due-soon: returns rows whose 28-day due-date lands in the next N days.
//   - Pour-summary: returns counts per DPR (cast / passed / failed / pending).
//
// Uses the buildApp pattern (mirror of dr006-photo-bind.test.js): a fresh
// Express app per test group, a hand-rolled prisma stub with the surface the
// route file calls. requireAuth is mocked so the test can supply employeeId
// without minting a real JWT.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const request = require('supertest');

// Mock the auth middleware. The route file references `requireAuth`,
// `requireAdmin`, and `requireFreshAdmin` from '../middleware/auth'.
// requireAuth just needs to populate req.employeeId (and the route file
// does its own admin re-read inline, so we don't need requireFreshAdmin
// behaviour here — that lives inside the route, not in middleware).
jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    const id = req.headers['x-test-employee-id'];
    if (!id) {
      // Mirror the real middleware's 401 contract so the auth-boundary
      // test below can assert it. Without a real JWT we have no way to
      // mint a synthetic employee id, so missing header → 401.
      return res.status(401).json({ error: 'Authorization required' });
    }
    req.employeeId = id;
    req.isAdmin = req.headers['x-test-is-admin'] === '1';
    next();
  },
  requireAdmin: (req, res, next) => {
    if (!req.isAdmin) return res.status(403).json({ error: 'Admin access required' });
    next();
  },
  requireFreshAdmin: (req, res, next) => {
    if (!req.employeeId) return res.status(401).json({ error: 'Authorization required' });
    if (!req.isAdmin) return res.status(403).json({ error: 'Admin access required' });
    next();
  },
}));

const cubeTestRouter = require('../src/routes/cubeTest');

const EMPLOYEE = 'emp-owner';
const OTHER_EMPLOYEE = 'emp-other';

// Stable UUIDs so test assertions are deterministic across runs.
const DprId = '11111111-1111-4111-8111-111111111111';
const CastingInspectionId = '22222222-2222-4222-8222-222222222222';
const WrongTypeInspectionId = '33333333-3333-4333-8333-333333333333';
const CubeTestId = '44444444-4444-4444-8444-444444444444';

function buildPrisma({ isAdmin = false, submittedById = EMPLOYEE, dprSubmittedById = EMPLOYEE, inspectionType = 'cube_casting' } = {}) {
  const cubeTests = {};
  const inspections = {
    [CastingInspectionId]: {
      id: CastingInspectionId,
      inspectionType,
      submittedById,
    },
    [WrongTypeInspectionId]: {
      id: WrongTypeInspectionId,
      inspectionType: 'material_inspection',
      submittedById: EMPLOYEE,
    },
  };
  const dprs = {
    [DprId]: {
      id: DprId,
      projectName: 'Tower B',
      reportDate: new Date('2026-09-01T00:00:00.000Z'),
      location: 'Grid A3-B4',
      submittedById: dprSubmittedById,
    },
  };

  const prisma = {
    cubeTest: {
      findUnique: jest.fn(async ({ where: { id } }) => cubeTests[id] || null),
      findMany: jest.fn(async ({ where = {}, orderBy, take } = {}) => {
        let rows = Object.values(cubeTests);
        if (where.status) rows = rows.filter((r) => r.status === where.status);
        if (where.dprId) rows = rows.filter((r) => r.dprId === where.dprId);
        if (where.castingRecordId) rows = rows.filter((r) => r.castingRecordId === where.castingRecordId);
        if (where.twentyEightDayDueDate) {
          const { gte, lt, lte } = where.twentyEightDayDueDate;
          rows = rows.filter((r) => {
            const t = r.twentyEightDayDueDate.getTime();
            if (gte && t < gte.getTime()) return false;
            if (lt && t >= lt.getTime()) return false;
            if (lte && t > lte.getTime()) return false;
            return true;
          });
        }
        rows.sort((a, b) => {
          const ad = a.twentyEightDayDueDate.getTime();
          const bd = b.twentyEightDayDueDate.getTime();
          if (ad !== bd) return ad - bd;
          return a.id < b.id ? -1 : 1;
        });
        if (take) rows = rows.slice(0, take);
        return rows;
      }),
      create: jest.fn(async ({ data }) => {
        const id = data.id || CubeTestId;
        const row = {
          id,
          castingRecordId: data.castingRecordId ?? null,
          dprId: data.dprId ?? null,
          pourLocation: data.pourLocation,
          concreteGrade: data.concreteGrade,
          castDate: data.castDate,
          sevenDayDueDate: data.sevenDayDueDate,
          twentyEightDayDueDate: data.twentyEightDayDueDate,
          sevenDayResult: data.sevenDayResult ?? null,
          sevenDayTestedAt: data.sevenDayTestedAt ?? null,
          twentyEightDayResult: data.twentyEightDayResult ?? null,
          twentyEightDayTestedAt: data.twentyEightDayTestedAt ?? null,
          expectedStrength: data.expectedStrength,
          status: data.status || 'PENDING',
          submittedById: data.submittedById,
          notes: data.notes ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
          // The route does not actually use these joined relations in the
          // mock, but include them so the response shape mirrors production.
          castingRecord: data.castingRecordId ? inspections[data.castingRecordId] : null,
          dpr: data.dprId ? dprs[data.dprId] : null,
          submittedBy: { id: data.submittedById, name: 'Owner', email: 'owner@example.com' },
        };
        cubeTests[id] = row;
        return row;
      }),
      update: jest.fn(async ({ where: { id }, data }) => {
        const existing = cubeTests[id];
        if (!existing) {
          const e = new Error('Record not found');
          e.code = 'P2025';
          throw e;
        }
        for (const [k, v] of Object.entries(data)) {
          if (k === 'updatedAt') continue;
          existing[k] = v;
        }
        return existing;
      }),
    },
    inspectionRecord: {
      findUnique: jest.fn(async ({ where: { id } }) => inspections[id] || null),
    },
    dPR: {
      findUnique: jest.fn(async ({ where: { id }, select }) => {
        const row = dprs[id];
        if (!row) return null;
        if (select) {
          const out = {};
          for (const k of Object.keys(select)) out[k] = row[k];
          return out;
        }
        return row;
      }),
    },
    employee: {
      findUnique: jest.fn(async () => ({ id: EMPLOYEE, isAdmin })),
    },
    _cubeTests: cubeTests,
    _inspections: inspections,
    _dprs: dprs,
  };
  return prisma;
}

function buildApp(prisma) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.use('/api/cube-tests', cubeTestRouter);
  return app;
}

const authHeaders = (overrides = {}) => ({
  'x-test-employee-id': EMPLOYEE,
  'x-test-is-admin': '0',
  ...overrides,
});

// Cast dates are UTC midnights; helpers return values aligned with the
// dateOnly convention so the route's UTC-midnight math produces equal dates.
const addDays = (iso, days) => {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('N5 cube-test integration — auth', () => {
  it('GET /api/cube-tests returns 401 without an employee header', async () => {
    // Strip the header the mock auth reads.
    const app = buildApp(buildPrisma());
    const res = await request(app).get('/api/cube-tests');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Authorization required');
  });

  it('GET /api/cube-tests returns 200 with an employee header', async () => {
    const prisma = buildPrisma();
    const app = buildApp(prisma);
    const res = await request(app).get('/api/cube-tests').set(authHeaders());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.tests)).toBe(true);
  });
});

describe('N5 cube-test integration — POST /api/cube-tests', () => {
  it('creates a cube-test row with both FKs populated', async () => {
    const prisma = buildPrisma();
    const app = buildApp(prisma);

    const body = {
      castingRecordId: CastingInspectionId,
      dprId: DprId,
      pourLocation: 'Grid A3-B4, Slab Level 2',
      concreteGrade: 'M30',
      castDate: '2026-09-05',
      expectedStrength: 30.0,
      notes: 'lab reference 2026-09-05-A',
    };
    const res = await request(app).post('/api/cube-tests').set(authHeaders()).send(body);

    expect(res.status).toBe(201);
    expect(res.body.castingRecordId).toBe(CastingInspectionId);
    expect(res.body.dprId).toBe(DprId);
    expect(res.body.pourLocation).toBe('Grid A3-B4, Slab Level 2');
    expect(res.body.concreteGrade).toBe('M30');
    expect(res.body.castDate).toBe('2026-09-05T00:00:00.000Z');
    expect(res.body.sevenDayDueDate).toBe(`${addDays('2026-09-05', 7)}T00:00:00.000Z`);
    expect(res.body.twentyEightDayDueDate).toBe(`${addDays('2026-09-05', 28)}T00:00:00.000Z`);
    expect(res.body.expectedStrength).toBe(30.0);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.submittedById).toBe(EMPLOYEE);
    expect(res.body.notes).toBe('lab reference 2026-09-05-A');
    // The mock's prisma.cubeTest.create was called with the parsed data.
    expect(prisma.cubeTest.create).toHaveBeenCalledTimes(1);
  });

  it('returns 403 when the casting inspection belongs to another employee', async () => {
    const prisma = buildPrisma({ submittedById: OTHER_EMPLOYEE });
    const app = buildApp(prisma);

    const body = {
      castingRecordId: CastingInspectionId,
      dprId: DprId,
      pourLocation: 'Grid A3-B4',
      concreteGrade: 'M30',
      castDate: '2026-09-05',
      expectedStrength: 30.0,
    };
    const res = await request(app).post('/api/cube-tests').set(authHeaders()).send(body);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_OWNER');
    expect(prisma.cubeTest.create).not.toHaveBeenCalled();
  });

  it('returns 400 when the referenced inspection is not cube_casting', async () => {
    const prisma = buildPrisma();
    const app = buildApp(prisma);

    const body = {
      castingRecordId: WrongTypeInspectionId,
      dprId: DprId,
      pourLocation: 'Grid A3-B4',
      concreteGrade: 'M30',
      castDate: '2026-09-05',
      expectedStrength: 30.0,
    };
    const res = await request(app).post('/api/cube-tests').set(authHeaders()).send(body);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INSPECTION_TYPE_INVALID');
    expect(res.body.currentType).toBe('material_inspection');
    expect(prisma.cubeTest.create).not.toHaveBeenCalled();
  });
});

describe('N5 cube-test integration — PATCH /api/cube-tests/:id (status derivation)', () => {
  // For these tests we seed a cube-test row directly into the prisma stub so
  // the patch handler can find it and apply the result-vs-expected comparison.
  function seedCubeTest(prisma, overrides = {}) {
    const id = CubeTestId;
    prisma._cubeTests[id] = {
      id,
      castingRecordId: CastingInspectionId,
      dprId: DprId,
      pourLocation: 'Grid A3-B4',
      concreteGrade: 'M30',
      castDate: new Date('2026-09-05T00:00:00.000Z'),
      sevenDayDueDate: new Date('2026-09-12T00:00:00.000Z'),
      twentyEightDayDueDate: new Date('2026-09-05T00:00:00.000Z'),
      sevenDayResult: null,
      sevenDayTestedAt: null,
      twentyEightDayResult: null,
      twentyEightDayTestedAt: null,
      expectedStrength: 30.0,
      status: 'PENDING',
      submittedById: EMPLOYEE,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    return prisma._cubeTests[id];
  }

  it('flips status to TWENTY_EIGHT_DAY_PASSED when result >= expectedStrength', async () => {
    const prisma = buildPrisma();
    seedCubeTest(prisma);
    const app = buildApp(prisma);

    const res = await request(app)
      .patch(`/api/cube-tests/${CubeTestId}`)
      .set(authHeaders())
      .send({ twentyEightDayResult: 32.5 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('TWENTY_EIGHT_DAY_PASSED');
    expect(res.body.twentyEightDayResult).toBe(32.5);
  });

  it('flips status to TWENTY_EIGHT_DAY_FAILED when result < expectedStrength', async () => {
    const prisma = buildPrisma();
    seedCubeTest(prisma);
    const app = buildApp(prisma);

    const res = await request(app)
      .patch(`/api/cube-tests/${CubeTestId}`)
      .set(authHeaders())
      .send({ twentyEightDayResult: 27.0 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('TWENTY_EIGHT_DAY_FAILED');
    expect(res.body.twentyEightDayResult).toBe(27.0);
  });
});

describe('N5 cube-test integration — GET /api/cube-tests/due-soon', () => {
  it('returns tests whose 28-day due-date lands within the requested window', async () => {
    const prisma = buildPrisma();
    const today = new Date('2026-09-10T00:00:00.000Z');
    const inThreeDays = new Date('2026-09-13T00:00:00.000Z');
    const inFiveWeeks = new Date('2026-10-15T00:00:00.000Z');
    prisma._cubeTests['t-1'] = {
      id: 't-1',
      castingRecordId: null, dprId: null,
      pourLocation: 'A', concreteGrade: 'M30',
      castDate: new Date('2026-08-16T00:00:00.000Z'),
      sevenDayDueDate: new Date('2026-08-23T00:00:00.000Z'),
      twentyEightDayDueDate: inThreeDays,
      sevenDayResult: null, sevenDayTestedAt: null,
      twentyEightDayResult: null, twentyEightDayTestedAt: null,
      expectedStrength: 30.0, status: 'PENDING',
      submittedById: EMPLOYEE, notes: null,
      createdAt: new Date(), updatedAt: new Date(),
    };
    prisma._cubeTests['t-2'] = {
      id: 't-2',
      castingRecordId: null, dprId: null,
      pourLocation: 'B', concreteGrade: 'M40',
      castDate: new Date('2026-07-01T00:00:00.000Z'),
      sevenDayDueDate: new Date('2026-07-08T00:00:00.000Z'),
      twentyEightDayDueDate: inFiveWeeks,
      sevenDayResult: null, sevenDayTestedAt: null,
      twentyEightDayResult: null, twentyEightDayTestedAt: null,
      expectedStrength: 40.0, status: 'PENDING',
      submittedById: EMPLOYEE, notes: null,
      createdAt: new Date(), updatedAt: new Date(),
    };
    const app = buildApp(prisma);

    // Pin "today" so the route's startDate is deterministic regardless of
    // the wall-clock when the test runs.
    const realDate = Date;
    global.Date = class extends realDate {
      constructor(...args) {
        if (args.length === 0) return new realDate(today);
        return new realDate(...args);
      }
      static now() { return today.getTime(); }
    };
    try {
      const res = await request(app).get('/api/cube-tests/due-soon?days=7').set(authHeaders());
      expect(res.status).toBe(200);
      expect(res.body.window.days).toBe(7);
      const ids = res.body.tests.map((t) => t.id);
      expect(ids).toContain('t-1'); // due in 3 days → included
      expect(ids).not.toContain('t-2'); // due in 5 weeks → excluded
    } finally {
      global.Date = realDate;
    }
  });
});

describe('N5 cube-test integration — GET /api/cube-tests/pour-summary/:dprId', () => {
  it('returns cast / passed / failed / pending counts grouped by status', async () => {
    const prisma = buildPrisma();
    // Seed three rows on the same DPR: one PASSED, one FAILED, one PENDING.
    const base = {
      castingRecordId: null, dprId: DprId,
      pourLocation: 'X', concreteGrade: 'M30',
      sevenDayDueDate: new Date('2026-09-12T00:00:00.000Z'),
      sevenDayResult: null, sevenDayTestedAt: null,
      twentyEightDayTestedAt: null,
      expectedStrength: 30.0,
      submittedById: EMPLOYEE, notes: null,
      createdAt: new Date(), updatedAt: new Date(),
    };
    prisma._cubeTests['ps-passed'] = {
      ...base, id: 'ps-passed',
      castDate: new Date('2026-09-01T00:00:00.000Z'),
      twentyEightDayDueDate: new Date('2026-09-29T00:00:00.000Z'),
      twentyEightDayResult: 32.5,
      status: 'TWENTY_EIGHT_DAY_PASSED',
    };
    prisma._cubeTests['ps-failed'] = {
      ...base, id: 'ps-failed',
      castDate: new Date('2026-09-02T00:00:00.000Z'),
      twentyEightDayDueDate: new Date('2026-09-30T00:00:00.000Z'),
      twentyEightDayResult: 25.0,
      status: 'TWENTY_EIGHT_DAY_FAILED',
    };
    prisma._cubeTests['ps-pending'] = {
      ...base, id: 'ps-pending',
      castDate: new Date('2026-09-03T00:00:00.000Z'),
      twentyEightDayDueDate: new Date('2026-10-01T00:00:00.000Z'),
      twentyEightDayResult: null,
      status: 'PENDING',
    };
    const app = buildApp(prisma);

    const res = await request(app).get(`/api/cube-tests/pour-summary/${DprId}`).set(authHeaders());

    expect(res.status).toBe(200);
    expect(res.body.dpr.id).toBe(DprId);
    expect(res.body.counts.cast).toBe(3);
    expect(res.body.counts.passed).toBe(1);
    expect(res.body.counts.failed).toBe(1);
    expect(res.body.counts.pending).toBe(1);
    expect(res.body.counts.overdue).toBe(0);
    expect(res.body.billingStatus).toBe('IN_PROGRESS');
    expect(Array.isArray(res.body.tests)).toBe(true);
    expect(res.body.tests.length).toBe(3);
  });

  it('returns 404 when the dpr does not exist', async () => {
    const prisma = buildPrisma();
    const app = buildApp(prisma);
    const res = await request(app).get('/api/cube-tests/pour-summary/99999999-9999-4999-8999-999999999999').set(authHeaders());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('DPR_NOT_FOUND');
  });
});
