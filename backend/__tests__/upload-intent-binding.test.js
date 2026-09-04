/**
 * [S3-7] Upload-intent binding — DPR + Inspection consume the registry.
 *
 * LPR-012 built a durable `upload_intent` table but nothing consumed it.
 * Report creation attached photos straight from the client array and
 * neither read, validated, nor consumed the intent, which left two silent
 * holes:
 *
 *   - A CONFIRMED intent whose DPR was never POSTed bound its blob to
 *     nothing, and the LPR-012 cleanup deliberately skipped CONFIRMED rows
 *     → permanent orphan, permanent storage cost.
 *   - A client could POST a photo whose `ulid` had no intent at all (only
 *     the 26-char Crockford shape was checked) — including another
 *     employee's ulid.
 *
 * This suite pins the closing contract on BOTH routes:
 *
 *   1. Happy path — a CONFIRMED intent is stamped boundType/boundAt after
 *      a successful create.
 *   2. No intent at all for one photo → 400 UPLOAD_NOT_CONFIRMED.
 *   3. PENDING intent (uploaded, never confirmed) → 400.
 *   4. EXPIRED intent (the sweep already retired the blob) → 400.
 *   5. Intent owned by a different employee → 400 (IDOR).
 *
 * Deliberately also pinned: no photos → no intent query at all, and a
 * prisma without `uploadIntent` (pre-migration deploy / the many unit
 * suites with hand-rolled mocks) degrades to a no-op rather than a 500.
 *
 * Harness follows dpr.month-shortcut.test.js — mounted router, stubbed
 * Prisma, real JWT.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

// blobStorage pulls in @aws-sdk/client-s3 (ESM) — mock the surface both
// routers touch. Same pattern as dpr.month-shortcut.test.js.
jest.mock('../src/lib/blobStorage', () => ({
  generateReadSASUrl: jest.fn(async () => ({ sasUrl: 'https://r2.example/sas', expiresAt: new Date().toISOString() })),
  generateUploadSASUrl: jest.fn(async () => ({ sasUrl: 'https://r2.example/put', blobPath: 'x', expiresAt: new Date().toISOString() })),
  generateULID: jest.fn(() => '01ARZ3NDEKTSV4RRFFQ69G5FAV'),
  verifyBlobExists: jest.fn(async () => ({ exists: true })),
  deleteBlob: jest.fn(async () => {}),
  CONTENT_TYPE_EXT: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' },
}));

// Admin fan-out fires on SUBMITTED DPRs / OPEN inspections — irrelevant here
// and it would try to reach Resend.
jest.mock('../src/lib/notify', () => ({
  fanOutEmail: jest.fn(async () => ({ sent: 0 })),
  fanOutToAdmins: jest.fn(async () => ({ sent: 0, skipped: 0, failed: 0 })),
}));

const dprRouter = require('../src/routes/dpr');
const inspectionRouter = require('../src/routes/inspection');

const EMPLOYEE_A = 'employee-a-s3-7';
const EMPLOYEE_B = 'employee-b-s3-7';

// Valid 26-char Crockford base32 ULIDs (the regex the routes already enforce).
const ULID_1 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ULID_2 = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const ULID_3 = '01C0SJXTHKMR5RQ8T2SZ6Q8ZTC';

// ─── Prisma stub ───────────────────────────────────────────────────────────
// Backed by a plain array of intent rows so tests can seed any lifecycle
// state and then assert what the route wrote back.
function buildPrisma(intentRows = []) {
  const intents = intentRows.map((r) => ({ ...r }));
  const created = { dprs: [], inspections: [] };
  const updateManyCalls = [];

  const matches = (row, where) => {
    if (where.employeeId !== undefined && row.employeeId !== where.employeeId) return false;
    if (where.status !== undefined && row.status !== where.status) return false;
    if (where.ulid && Array.isArray(where.ulid.in) && !where.ulid.in.includes(row.ulid)) return false;
    return true;
  };

  return {
    uploadIntent: {
      findMany: jest.fn(async ({ where }) => intents.filter((r) => matches(r, where)).map((r) => ({ ...r }))),
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
          submittedBy: { id: EMPLOYEE_A, name: 'A', email: 'a@example.com' },
          inspections: [],
        };
        created.dprs.push(row);
        return row;
      }),
    },
    inspectionRecord: {
      create: jest.fn(async ({ data }) => {
        const row = {
          id: `insp-${created.inspections.length + 1}`,
          ...data,
          photos: (data.photos && data.photos.create) || [],
          submittedBy: { id: EMPLOYEE_A, name: 'A', email: 'a@example.com' },
          dpr: null,
        };
        created.inspections.push(row);
        return row;
      }),
    },
    employee: { findUnique: jest.fn(async () => ({ id: EMPLOYEE_A, isAdmin: false })) },
    _intents: intents,
    _created: created,
    _updateManyCalls: updateManyCalls,
  };
}

function buildApp(prisma) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.use('/api/dpr', dprRouter);
  app.use('/api/inspection', inspectionRouter);
  return app;
}

function authHeader(employeeId = EMPLOYEE_A) {
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

// DRAFT so the admin fan-out branch stays out of the way; the binding
// happens on every create regardless of status.
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
  contractor: 'AEC',
  inspectionType: 'material_inspection',
  severity: 'MINOR',
  data: { note: 'ok' },
  photos,
});

const intent = (overrides) => ({
  id: `intent-${overrides.ulid}`,
  employeeId: EMPLOYEE_A,
  container: 'dpr-photos',
  blobPath: `${EMPLOYEE_A}/${overrides.ulid}.jpg`,
  contentType: 'image/jpeg',
  status: 'CONFIRMED',
  expiresAt: new Date(Date.now() + 600000),
  confirmedAt: new Date(),
  createdAt: new Date(),
  boundType: null,
  boundAt: null,
  ...overrides,
});

const postDpr = (app, photos, employeeId = EMPLOYEE_A) =>
  request(app).post('/api/dpr').set('Authorization', authHeader(employeeId)).send(dprBody(photos));

const postInspection = (app, photos, employeeId = EMPLOYEE_A) =>
  request(app).post('/api/inspection').set('Authorization', authHeader(employeeId)).send(inspectionBody(photos));

describe('S3-7 — DPR POST consumes upload intents', () => {
  it('stamps boundType=dpr and boundAt on every confirmed intent', async () => {
    const prisma = buildPrisma([intent({ ulid: ULID_1 }), intent({ ulid: ULID_2 })]);
    const app = buildApp(prisma);

    const res = await postDpr(app, [photo(ULID_1, 'dpr-photos'), photo(ULID_2, 'dpr-documents')]);

    expect(res.status).toBe(201);
    expect(prisma.dPR.create).toHaveBeenCalledTimes(1);

    for (const ulid of [ULID_1, ULID_2]) {
      const row = prisma._intents.find((r) => r.ulid === ulid);
      expect(row.boundType).toBe('dpr');
      expect(row.boundAt).toBeInstanceOf(Date);
      // Still CONFIRMED — binding is expressed by the new columns, not by
      // a fourth status value.
      expect(row.status).toBe('CONFIRMED');
    }

    // The bind is guarded on status so a row the sweep retired mid-request
    // cannot be resurrected.
    const bind = prisma._updateManyCalls.at(-1);
    expect(bind.where.employeeId).toBe(EMPLOYEE_A);
    expect(bind.where.status).toBe('CONFIRMED');
  });

  it('rejects 400 UPLOAD_NOT_CONFIRMED when one photo has no intent at all', async () => {
    const prisma = buildPrisma([intent({ ulid: ULID_1 })]);
    const app = buildApp(prisma);

    const res = await postDpr(app, [photo(ULID_1, 'dpr-photos'), photo(ULID_3, 'dpr-photos')]);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UPLOAD_NOT_CONFIRMED');
    expect(res.body.photoIndexes).toEqual([1]);
    // Rejected BEFORE the create — no half-written DPR.
    expect(prisma.dPR.create).not.toHaveBeenCalled();
  });

  it('rejects a PENDING intent — bytes were never verified in R2', async () => {
    const prisma = buildPrisma([intent({ ulid: ULID_1, status: 'PENDING', confirmedAt: null })]);
    const app = buildApp(prisma);

    const res = await postDpr(app, [photo(ULID_1, 'dpr-photos')]);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UPLOAD_NOT_CONFIRMED');
    expect(prisma.dPR.create).not.toHaveBeenCalled();
  });

  it('rejects an EXPIRED intent — the sweep already deleted the blob', async () => {
    const prisma = buildPrisma([intent({ ulid: ULID_1, status: 'EXPIRED' })]);
    const app = buildApp(prisma);

    const res = await postDpr(app, [photo(ULID_1, 'dpr-photos')]);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UPLOAD_NOT_CONFIRMED');
    expect(prisma.dPR.create).not.toHaveBeenCalled();
  });

  it('rejects an intent owned by another employee (IDOR)', async () => {
    // The intent is real and CONFIRMED — it just belongs to employee B.
    const prisma = buildPrisma([intent({ ulid: ULID_1, employeeId: EMPLOYEE_B })]);
    const app = buildApp(prisma);

    const res = await postDpr(app, [photo(ULID_1, 'dpr-photos')], EMPLOYEE_A);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UPLOAD_NOT_CONFIRMED');
    expect(prisma.dPR.create).not.toHaveBeenCalled();

    // B's intent was not touched by A's attempt.
    const row = prisma._intents.find((r) => r.ulid === ULID_1);
    expect(row.boundType).toBeNull();
    expect(row.boundAt).toBeNull();
  });
});

describe('S3-7 — Inspection POST consumes upload intents', () => {
  const inspIntent = (o) => intent({ container: 'inspection-photos', ...o });

  it('stamps boundType=inspection and boundAt on every confirmed intent', async () => {
    const prisma = buildPrisma([inspIntent({ ulid: ULID_1 }), inspIntent({ ulid: ULID_2 })]);
    const app = buildApp(prisma);

    const res = await postInspection(app, [
      photo(ULID_1, 'inspection-photos'),
      photo(ULID_2, 'inspection-photos'),
    ]);

    expect(res.status).toBe(201);
    for (const ulid of [ULID_1, ULID_2]) {
      const row = prisma._intents.find((r) => r.ulid === ulid);
      expect(row.boundType).toBe('inspection');
      expect(row.boundAt).toBeInstanceOf(Date);
    }
  });

  it('rejects 400 UPLOAD_NOT_CONFIRMED when one photo has no intent at all', async () => {
    const prisma = buildPrisma([inspIntent({ ulid: ULID_1 })]);
    const app = buildApp(prisma);

    const res = await postInspection(app, [
      photo(ULID_1, 'inspection-photos'),
      photo(ULID_3, 'inspection-photos'),
    ]);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UPLOAD_NOT_CONFIRMED');
    expect(res.body.photoIndexes).toEqual([1]);
    expect(prisma.inspectionRecord.create).not.toHaveBeenCalled();
  });

  it('rejects a PENDING intent', async () => {
    const prisma = buildPrisma([inspIntent({ ulid: ULID_1, status: 'PENDING', confirmedAt: null })]);
    const res = await postInspection(buildApp(prisma), [photo(ULID_1, 'inspection-photos')]);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UPLOAD_NOT_CONFIRMED');
    expect(prisma.inspectionRecord.create).not.toHaveBeenCalled();
  });

  it('rejects an EXPIRED intent', async () => {
    const prisma = buildPrisma([inspIntent({ ulid: ULID_1, status: 'EXPIRED' })]);
    const res = await postInspection(buildApp(prisma), [photo(ULID_1, 'inspection-photos')]);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UPLOAD_NOT_CONFIRMED');
    expect(prisma.inspectionRecord.create).not.toHaveBeenCalled();
  });

  it('rejects an intent owned by another employee (IDOR)', async () => {
    const prisma = buildPrisma([inspIntent({ ulid: ULID_1, employeeId: EMPLOYEE_B })]);
    const res = await postInspection(buildApp(prisma), [photo(ULID_1, 'inspection-photos')], EMPLOYEE_A);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UPLOAD_NOT_CONFIRMED');
    expect(prisma.inspectionRecord.create).not.toHaveBeenCalled();
  });
});

describe('S3-7 — no-photo and pre-migration paths stay open', () => {
  it('does not query the intent registry when photos is empty', async () => {
    const prisma = buildPrisma([]);
    const res = await postDpr(buildApp(prisma), []);

    expect(res.status).toBe(201);
    expect(prisma.uploadIntent.findMany).not.toHaveBeenCalled();
    expect(prisma.uploadIntent.updateMany).not.toHaveBeenCalled();
  });

  it('degrades to a no-op when prisma has no uploadIntent model', async () => {
    // Pre-LPR-012 deploy, or one of the many unit suites whose hand-rolled
    // Prisma mock exposes only the models its route touches. Turning that
    // into a 500 would be a self-inflicted outage; the durable sweep still
    // reclaims the storage.
    const prisma = buildPrisma([]);
    delete prisma.uploadIntent;

    const res = await postDpr(buildApp(prisma), [photo(ULID_1, 'dpr-photos')]);
    expect(res.status).toBe(201);
  });
});
