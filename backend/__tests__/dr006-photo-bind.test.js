// SOL DR-006 (server half) — photo-intent claim is atomic with the create.
//
// Before this fix the create path was:
//
//   validate intents  →  COMMIT report + photo rows  →  bind intents
//
// If the durable sweep retired a CONFIRMED intent anywhere in that window,
// the report committed anyway and the bind logged a warning. The user saw
// "saved"; the bytes behind the photo were already deleted. The audit is
// explicit: *"a short binding count is an error, not successful
// publication."*
//
// The flow is now:
//
//   validate (fast reject, outside tx)
//   └─ $transaction:
//        re-validate (status: 'CONFIRMED')
//        create report + photo rows
//        updateMany boundType/boundAt (status: 'CONFIRMED')  ← atomic guard
//        count short?  →  throw  →  ROLLBACK  →  409 PHOTO_BINDING_LOST
//
// These tests pin all five branches against the live routers for BOTH
// resources. The prisma stub implements a real snapshot/restore rollback so
// "no record persists" is an assertion about state, not about call counts.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

jest.mock('../src/lib/notify', () => ({
  fanOutEmail: jest.fn(async () => null),
  fanOutToAdmins: jest.fn(async () => null),
}));

// The routers mount the shared upload routes at import time; stub the R2
// surface so nothing reaches the network.
jest.mock('../src/lib/blobStorage', () => ({
  generateUploadSASUrl: jest.fn(),
  verifyBlobExists: jest.fn(async () => ({ exists: false })),
  deleteBlob: jest.fn(async () => ({ ok: true })),
  generateReadSASUrl: jest.fn(async () => ({ sasUrl: 'https://r2.example/fake' })),
  CONTENT_TYPE_EXT: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' },
}));

const dprRouter = require('../src/routes/dpr');
const inspectionRouter = require('../src/routes/inspection');

const EMPLOYEE = 'employee-dr006';

// Valid 26-char Crockford base32 ULIDs (the shape both routes enforce).
const ULID_1 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ULID_2 = '01BX5ZZKBKACTAV9WEVGEMMVRZ';

// ─── Prisma stub with real transaction rollback ────────────────────────────
//
// `$transaction(fn)` snapshots the intent rows and the created-record lists,
// runs the callback, and restores the snapshot if the callback throws. That
// is what lets the sweep-race tests assert "NO record was created" rather
// than the much weaker "create was not called".
function buildPrisma(intentRows = [], hooks = {}) {
  const intents = intentRows.map((r) => ({ ...r }));
  const created = { dprs: [], inspections: [], photos: [] };
  const updateManyCalls = [];
  let findManyCalls = 0;

  const matches = (row, where) => {
    if (where.employeeId !== undefined && row.employeeId !== where.employeeId) return false;
    if (where.status !== undefined && row.status !== where.status) return false;
    if (where.ulid && Array.isArray(where.ulid.in) && !where.ulid.in.includes(row.ulid)) return false;
    return true;
  };

  // Simulate the durable sweep retiring an intent: CONFIRMED → EXPIRED.
  const sweep = (ulid) => {
    const row = intents.find((r) => r.ulid === ulid);
    if (row) row.status = 'EXPIRED';
  };

  const prisma = {
    uploadIntent: {
      findMany: jest.fn(async ({ where }) => {
        findManyCalls += 1;
        const rows = intents.filter((r) => matches(r, where)).map((r) => ({ ...r }));
        // `sweepAfterFindMany: n` fires the sweep immediately AFTER the nth
        // lookup — n=1 is "between the pre-flight validate and the in-tx
        // re-validate", n=2 is "between the re-validate and the bind".
        if (hooks.sweepAfterFindMany === findManyCalls && hooks.sweepUlids) {
          hooks.sweepUlids.forEach(sweep);
        }
        return rows;
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        updateManyCalls.push({ where, data });
        const hits = intents.filter((r) => matches(r, where));
        for (const row of hits) Object.assign(row, data);
        return { count: hits.length };
      }),
    },
    dPR: {
      create: jest.fn(async ({ data }) => {
        const row = {
          id: `dpr-${created.dprs.length + 1}`,
          ...data,
          photos: (data.photos && data.photos.create) || [],
          submittedBy: { id: EMPLOYEE, name: 'A', email: 'a@example.com' },
          inspections: [],
        };
        created.dprs.push(row);
        created.photos.push(...row.photos);
        return row;
      }),
    },
    inspectionRecord: {
      create: jest.fn(async ({ data }) => {
        const row = {
          id: `insp-${created.inspections.length + 1}`,
          ...data,
          photos: (data.photos && data.photos.create) || [],
          submittedBy: { id: EMPLOYEE, name: 'A', email: 'a@example.com' },
          dpr: null,
        };
        created.inspections.push(row);
        created.photos.push(...row.photos);
        return row;
      }),
    },
    employee: {
      findUnique: jest.fn(async () => ({ id: EMPLOYEE, isAdmin: false })),
      findMany: jest.fn(async () => []),
    },
    notification: { create: jest.fn(async () => ({})) },
    $transaction: jest.fn(async (fn) => {
      const snapshot = {
        intents: intents.map((r) => ({ ...r })),
        dprs: created.dprs.length,
        inspections: created.inspections.length,
        photos: created.photos.length,
      };
      try {
        return await fn(prisma);
      } catch (err) {
        // Roll back exactly like Postgres would.
        intents.length = 0;
        intents.push(...snapshot.intents);
        created.dprs.length = snapshot.dprs;
        created.inspections.length = snapshot.inspections;
        created.photos.length = snapshot.photos;
        throw err;
      }
    }),
    _intents: intents,
    _created: created,
    _updateManyCalls: updateManyCalls,
  };
  return prisma;
}

function buildApp(prisma) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.use('/api/dpr', dprRouter);
  app.use('/api/inspection', inspectionRouter);
  // Without an error middleware an escaped throw hangs the request until
  // the 120s jest timeout instead of surfacing as a status code.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ error: err.message || 'INTERNAL_ERROR' });
  });
  return app;
}

function authHeader(employeeId = EMPLOYEE) {
  const token = jwt.sign({ employeeId, email: `${employeeId}@example.com` }, process.env.JWT_SECRET, { expiresIn: '8h' });
  return `Bearer ${token}`;
}

const photo = (ulid, container) => ({
  ulid,
  container,
  filename: 'site.jpg',
  contentType: 'image/jpeg',
  sizeBytes: 2048,
});

// DRAFT keeps the admin fan-out branch out of the way — the binding runs on
// every create regardless of status.
const dprBody = (photos) => ({
  projectName: 'Tower B',
  location: 'Chennai',
  reportDate: '2026-09-01',
  workType: 'SITE_INSPECTION',
  status: 'DRAFT',
  photos,
});

const inspectionBody = (photos) => ({
  projectName: 'Tower B',
  location: 'Chennai',
  reportDate: '2026-09-01',
  weather: 'sunny',
  inspectionType: 'material_inspection',
  severity: 'MINOR',
  status: 'DRAFT',
  data: { note: 'ok' },
  photos,
});

const intent = (overrides) => ({
  id: `intent-${overrides.ulid}`,
  employeeId: EMPLOYEE,
  container: 'dpr-photos',
  blobPath: `${EMPLOYEE}/${overrides.ulid}.jpg`,
  contentType: 'image/jpeg',
  status: 'CONFIRMED',
  boundType: null,
  boundAt: null,
  ...overrides,
});

const postDpr = (app, photos) =>
  request(app).post('/api/dpr').set('Authorization', authHeader()).send(dprBody(photos));

const postInspection = (app, photos) =>
  request(app).post('/api/inspection').set('Authorization', authHeader()).send(inspectionBody(photos));

// Each resource runs the identical matrix — the fix is the same pattern in
// both routes, so the coverage has to be symmetric or one can regress alone.
const RESOURCES = [
  {
    name: 'DPR',
    container: 'dpr-photos',
    boundType: 'dpr',
    post: postDpr,
    createdKey: 'dprs',
    createSpy: (p) => p.dPR.create,
  },
  {
    name: 'Inspection',
    container: 'inspection-photos',
    boundType: 'inspection',
    post: postInspection,
    createdKey: 'inspections',
    createSpy: (p) => p.inspectionRecord.create,
  },
];

describe.each(RESOURCES)('DR-006 — $name create claims photo intents atomically', (R) => {
  const seed = (o) => intent({ container: R.container, ...o });

  it('1. happy path — every intent is claimed and the record is created (201)', async () => {
    const prisma = buildPrisma([seed({ ulid: ULID_1 }), seed({ ulid: ULID_2 })]);
    const app = buildApp(prisma);

    const res = await R.post(app, [photo(ULID_1, R.container), photo(ULID_2, R.container)]);

    expect(res.status).toBe(201);
    expect(prisma._created[R.createdKey]).toHaveLength(1);
    expect(prisma._created.photos).toHaveLength(2);

    for (const ulid of [ULID_1, ULID_2]) {
      const row = prisma._intents.find((r) => r.ulid === ulid);
      expect(row.boundType).toBe(R.boundType);
      expect(row.boundAt).toBeInstanceOf(Date);
      expect(row.status).toBe('CONFIRMED');
    }

    // The claim ran inside the transaction, not after it.
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('2. sweep race — bind count short ⇒ 409 and the create is rolled back', async () => {
    // The sweep lands AFTER the in-tx re-validate (2nd findMany), so the
    // guard that catches it is the updateMany's `status: 'CONFIRMED'`
    // predicate coming back with count 0.
    const prisma = buildPrisma(
      [seed({ ulid: ULID_1 })],
      { sweepAfterFindMany: 2, sweepUlids: [ULID_1] },
    );
    const app = buildApp(prisma);

    const res = await R.post(app, [photo(ULID_1, R.container)]);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PHOTO_BINDING_LOST');
    expect(res.body.code).toBe('PHOTO_BINDING_LOST');

    // The create WAS attempted — and then undone. No record, no photo rows.
    expect(R.createSpy(prisma)).toHaveBeenCalledTimes(1);
    expect(prisma._created[R.createdKey]).toHaveLength(0);
    expect(prisma._created.photos).toHaveLength(0);
  });

  it('3. concurrent sweep — flipped to EXPIRED before the in-tx re-validate ⇒ 409, nothing created', async () => {
    // The sweep lands between the pre-flight validate (1st findMany) and
    // the in-tx re-validate (2nd findMany). The re-validate fails fast, so
    // the create is never even attempted.
    const prisma = buildPrisma(
      [seed({ ulid: ULID_1 })],
      { sweepAfterFindMany: 1, sweepUlids: [ULID_1] },
    );
    const app = buildApp(prisma);

    const res = await R.post(app, [photo(ULID_1, R.container)]);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PHOTO_BINDING_LOST');
    expect(R.createSpy(prisma)).not.toHaveBeenCalled();
    expect(prisma._created[R.createdKey]).toHaveLength(0);
    expect(prisma._intents[0].boundType).toBeNull();
  });

  it('4. partial bind — one of two intents expires ⇒ whole tx rolls back, 409', async () => {
    const prisma = buildPrisma(
      [seed({ ulid: ULID_1 }), seed({ ulid: ULID_2 })],
      { sweepAfterFindMany: 2, sweepUlids: [ULID_2] },
    );
    const app = buildApp(prisma);

    const res = await R.post(app, [photo(ULID_1, R.container), photo(ULID_2, R.container)]);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PHOTO_BINDING_LOST');
    expect(prisma._created[R.createdKey]).toHaveLength(0);
    expect(prisma._created.photos).toHaveLength(0);

    // The surviving intent must NOT stay half-claimed — the rollback
    // restores it, so the retry re-uploads from a clean state.
    const survivor = prisma._intents.find((r) => r.ulid === ULID_1);
    expect(survivor.boundType).toBeNull();
    expect(survivor.boundAt).toBeNull();
  });

  it('5. empty photos — record is still created (201) and the registry is untouched', async () => {
    const prisma = buildPrisma([]);
    const app = buildApp(prisma);

    const res = await R.post(app, []);

    expect(res.status).toBe(201);
    expect(prisma._created[R.createdKey]).toHaveLength(1);
    expect(prisma.uploadIntent.findMany).not.toHaveBeenCalled();
    expect(prisma.uploadIntent.updateMany).not.toHaveBeenCalled();
  });

  it('the bind is filtered on status CONFIRMED — the atomic guard, not a redundancy', async () => {
    const prisma = buildPrisma([seed({ ulid: ULID_1 })]);
    const app = buildApp(prisma);

    await R.post(app, [photo(ULID_1, R.container)]);

    const bind = prisma._updateManyCalls.at(-1);
    expect(bind.where.status).toBe('CONFIRMED');
    expect(bind.where.employeeId).toBe(EMPLOYEE);
    expect(bind.where.ulid.in).toEqual([ULID_1]);
    expect(bind.data.boundType).toBe(R.boundType);
  });
});
