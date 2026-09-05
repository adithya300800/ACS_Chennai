// SOL DR-012 — Inspection create POST now respects Idempotency-Key.
//
// The audit found that the inspection POST was the only business write
// surface missing the round-10 Idempotency-Key replay gate that dpr.js
// already had. A NETWORK_ERROR retry from src/lib/api.js:168-178 on a
// committed-but-response-lost POST would create a duplicate
// InspectionRecord, a duplicate notification row, and a duplicate admin
// fan-out email.
//
// Fix:
//   1. backend/src/lib/idempotency.js — shared (employeeId, key,
//      bodyHash) → {status, body} cache + tryReplay/recordSuccess.
//      Exported so dpr.js, inspection.js, and future write surfaces share
//      one canonical-JSON body-hash contract (DR-006 security pin: a
//      leaked key MUST NOT probe arbitrary payloads against the cached
//      slot).
//   2. inspection.js POST '/' — calls tryReplay at the top, records
//      the 201 on success before the admin fan-out (so a retry that
//      lands while the fan-out is in flight still gets the cached row
//      instead of re-queueing a duplicate notification).
//   3. src/lib/api.js request() — forwards an optional `idempotencyKey`
//      as the `Idempotency-Key` header on every send AND on every
//      NETWORK_ERROR retry of the same call.
//
// Acceptance:
//   - Replay with same key + same body returns 201 + Idempotent-Replay
//     header; the cache returns the cached body without a second
//     record-create call.
//   - Replay with same key + different body returns 409
//     IDEMPOTENCY_MISMATCH.
//   - Different key on the same body creates a second record (the key
//     is per-intent, not per-body).
//   - dpr.js POST '/' still works the same way (regression pin).

'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
require('express-async-errors');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.INTERNAL_API_TOKEN =
  process.env.INTERNAL_API_TOKEN || 'test-internal-token';

// blobStorage pulls in @aws-sdk/client-s3 (ESM) — mock the surface the
// inspection route touches at import time. Same pattern as
// upload-intent-binding.test.js.
jest.mock('../src/lib/blobStorage', () => ({
  generateReadSASUrl: jest.fn(async () => ({ sasUrl: 'https://r2.example/sas', expiresAt: new Date().toISOString() })),
  generateUploadSASUrl: jest.fn(async () => ({ sasUrl: 'https://r2.example/put', blobPath: 'x', expiresAt: new Date().toISOString() })),
  generateULID: jest.fn(() => '01ARZ3NDEKTSV4RRFFQ69G5FAV'),
  verifyBlobExists: jest.fn(async () => ({ exists: true })),
  deleteBlob: jest.fn(async () => {}),
  CONTENT_TYPE_EXT: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' },
}));

// Admin fan-out fires on OPEN inspections — irrelevant here.
jest.mock('../src/lib/notify', () => ({
  fanOutEmail: jest.fn(async () => ({ sent: 0 })),
  fanOutToAdmins: jest.fn(async () => ({ sent: 0, skipped: 0, failed: 0 })),
}));

const { tryReplay, recordSuccess, _clearCache, sha256Hex, canonicalJsonStringify } =
  require('../src/lib/idempotency');
const inspectionRouter = require('../src/routes/inspection');

function authHeader(employeeId = 'emp-1') {
  return `Bearer ${jwt.sign(
    { employeeId, email: 'emp@example.com' },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  )}`;
}

function buildApp({ inspectionCreate }) {
  const app = express();
  app.use(express.json());
  const prisma = {
    employee: {
      findUnique: jest.fn(async () => null),
    },
    dPR: {
      findUnique: jest.fn(async () => null),
    },
    inspectionRecord: {
      create: inspectionCreate,
    },
    // The admin fan-out helper tries to read notificationPreference for
    // each recipient; stub it so the create call completes without
    // dragging in a fan-out mock.
    notificationPreference: { findUnique: jest.fn(async () => null) },
  };
  app.set('prisma', prisma);
  app.use('/api/inspection', inspectionRouter);
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({
      error: err.message || 'INTERNAL_ERROR',
      code: err.code || 'INTERNAL',
    });
  });
  return { app, prisma };
}

// Minimal valid payload. The status gate accepts 'OPEN' or 'DRAFT';
// photos[] must be an empty array (the validation loop iterates it).
// inspectionType must be one of ALLOWED_INSPECTION_TYPES in inspection.js.
const VALID_BODY = {
  projectName: 'Project Alpha',
  location: 'Tower 1',
  reportDate: '2026-09-04',
  inspectionType: 'cement_receipt',
  data: { received: 'Cement 50 bags' },
  photos: [],
};

describe('SOL DR-012 — Inspection create idempotency (backend)', () => {
  beforeEach(() => {
    _clearCache();
  });

  test('A1. tryReplay returns null when no Idempotency-Key header is sent', () => {
    const req = { headers: {}, employeeId: 'emp-1', body: VALID_BODY };
    expect(tryReplay(req)).toBeNull();
  });

  test('A2. tryReplay returns null when header is present but cache miss', () => {
    const req = {
      headers: { 'idempotency-key': 'k-first' },
      employeeId: 'emp-1',
      body: VALID_BODY,
    };
    const r = tryReplay(req);
    expect(r).not.toBeNull();
    expect(r.miss).toBe(true);
    expect(r.replay).toBeUndefined();
    expect(r.mismatch).toBeUndefined();
  });

  test('A3. recordSuccess then tryReplay with same body → returns cached entry', () => {
    const req = {
      headers: { 'idempotency-key': 'k-replay' },
      employeeId: 'emp-1',
      body: VALID_BODY,
    };
    recordSuccess(req, 201, { id: 'insp-42' }, VALID_BODY);
    const r = tryReplay(req);
    expect(r.replay).toBe(true);
    expect(r.mismatch).toBeUndefined();
    expect(r.cached.status).toBe(201);
    expect(r.cached.body).toEqual({ id: 'insp-42' });
  });

  test('A4. recordSuccess then tryReplay with same key but DIFFERENT body → mismatch', () => {
    const req = {
      headers: { 'idempotency-key': 'k-mismatch' },
      employeeId: 'emp-1',
      body: VALID_BODY,
    };
    recordSuccess(req, 201, { id: 'insp-1' }, VALID_BODY);
    const replayReq = {
      headers: { 'idempotency-key': 'k-mismatch' },
      employeeId: 'emp-1',
      body: { ...VALID_BODY, projectName: 'DIFFERENT NAME' },
    };
    const r = tryReplay(replayReq);
    expect(r.mismatch).toBe(true);
    expect(r.replay).toBeUndefined();
  });

  test('A5. canonicalJsonStringify sorts object keys (security pin)', () => {
    // {a:1,b:2} and {b:2,a:1} MUST hash identically; otherwise a
    // legitimate "same intent, different wire ordering" replay would
    // trip IDEMPOTENCY_MISMATCH and the client would think it has a
    // collision bug.
    const h1 = sha256Hex(canonicalJsonStringify({ a: 1, b: 2, c: [3, 4] }));
    const h2 = sha256Hex(canonicalJsonStringify({ c: [3, 4], b: 2, a: 1 }));
    expect(h1).toBe(h2);
  });

  test('A6. Different employeeId is a different cache slot', () => {
    // A leaked key from employee A cannot replay employee B's response.
    const reqA = {
      headers: { 'idempotency-key': 'k-leak' },
      employeeId: 'emp-A',
      body: VALID_BODY,
    };
    recordSuccess(reqA, 201, { id: 'insp-A' }, VALID_BODY);
    const reqB = {
      headers: { 'idempotency-key': 'k-leak' },
      employeeId: 'emp-B',
      body: VALID_BODY,
    };
    const r = tryReplay(reqB);
    expect(r.miss).toBe(true);
    expect(r.replay).toBeUndefined();
  });
});

describe('SOL DR-012 — Inspection create POST / endpoint', () => {
  beforeEach(() => {
    _clearCache();
  });

  test('B1. First POST creates the record; second POST with same key + body returns 201 + Idempotent-Replay header', async () => {
    const createMock = jest.fn(async (args) => ({
      id: 'insp-42',
      ...args.data,
      photos: [],
      submittedBy: { id: args.data.submittedById, name: 'X', email: 'x@x' },
      dpr: null,
    }));
    const { app } = buildApp({ inspectionCreate: createMock });
    const key = 'submit-abc-123';

    const first = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader())
      .set('Idempotency-Key', key)
      .send(VALID_BODY);
    expect(first.status).toBe(201);
    expect(first.body.id).toBe('insp-42');
    expect(first.headers['idempotent-replay']).toBeUndefined();
    expect(createMock).toHaveBeenCalledTimes(1);

    const second = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader())
      .set('Idempotency-Key', key)
      .send(VALID_BODY);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replay']).toBe('true');
    // The CRITICAL assertion: the create was NOT called a second time.
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  test('B2. Same key + DIFFERENT body returns 409 IDEMPOTENCY_MISMATCH', async () => {
    const createMock = jest.fn(async (args) => ({
      id: 'insp-1',
      ...args.data,
      photos: [],
      submittedBy: { id: args.data.submittedById, name: 'X', email: 'x@x' },
      dpr: null,
    }));
    const { app } = buildApp({ inspectionCreate: createMock });
    const key = 'submit-attack';

    const first = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader())
      .set('Idempotency-Key', key)
      .send(VALID_BODY);
    expect(first.status).toBe(201);

    const tampered = { ...VALID_BODY, projectName: 'PROJECT BETA' };
    const second = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader())
      .set('Idempotency-Key', key)
      .send(tampered);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('IDEMPOTENCY_MISMATCH');
    // DR-006 pin: only the original (cached) record was created.
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  test('B3. Two POSTs with DIFFERENT keys on the same body create two records (key is per-intent)', async () => {
    const createMock = jest.fn(async (args) => ({
      id: 'insp-' + Math.random().toString(36).slice(2),
      ...args.data,
      photos: [],
      submittedBy: { id: args.data.submittedById, name: 'X', email: 'x@x' },
      dpr: null,
    }));
    const { app } = buildApp({ inspectionCreate: createMock });

    const r1 = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader())
      .set('Idempotency-Key', 'submit-1')
      .send(VALID_BODY);
    expect(r1.status).toBe(201);

    const r2 = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader())
      .set('Idempotency-Key', 'submit-2')
      .send(VALID_BODY);
    expect(r2.status).toBe(201);
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  test('B4. POST without Idempotency-Key still works (the gate is opt-in)', async () => {
    const createMock = jest.fn(async (args) => ({
      id: 'insp-no-key',
      ...args.data,
      photos: [],
      submittedBy: { id: args.data.submittedById, name: 'X', email: 'x@x' },
      dpr: null,
    }));
    const { app } = buildApp({ inspectionCreate: createMock });

    const r = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader())
      .send(VALID_BODY);
    expect(r.status).toBe(201);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(r.headers['idempotent-replay']).toBeUndefined();
  });

  test('B5. POST with an over-length Idempotency-Key is treated as no key (does not 500)', async () => {
    const createMock = jest.fn(async (args) => ({
      id: 'insp-oversize',
      ...args.data,
      photos: [],
      submittedBy: { id: args.data.submittedById, name: 'X', email: 'x@x' },
      dpr: null,
    }));
    const { app } = buildApp({ inspectionCreate: createMock });
    const longKey = 'x'.repeat(201);

    const r = await request(app)
      .post('/api/inspection')
      .set('Authorization', authHeader())
      .set('Idempotency-Key', longKey)
      .send(VALID_BODY);
    expect(r.status).toBe(201);
    // The over-length key was dropped, so this is treated as a fresh
    // request — no replay header, no cache lookup.
    expect(r.headers['idempotent-replay']).toBeUndefined();
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});
