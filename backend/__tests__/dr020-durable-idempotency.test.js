// DR-020 (audit, 2026-09-08) — durable DB-backed idempotency for
// billing certification POST.
//
// Audit finding: billing COP had no idempotency at all before this
// round. A retried POST on a flaky mobile network created two rows
// for the same bill. DPR and inspection had a 5-min in-memory cache
// keyed by `${employeeId}:${idempotencyKey}`, but:
//   - the cache forgot the slot on process restart, so a retry after
//     a restart happily created a duplicate;
//   - the cache did not survive across replicas (Render will spin up
//     more than one on the production plan);
//   - the cache had no body-hash defence — a leaked key could probe
//     arbitrary payloads against the cached slot (DR-006).
//
// Fix: extend idempotency.js with a `request_dedupe` table path.
// reserve() locks the slot in Postgres BEFORE side-effects; a same-key
// retry either replays the cached response (COMPLETED), 409s with
// IDEMPOTENCY_MISMATCH (different body), or 409s with
// IDEMPOTENCY_CONFLICT (still PENDING). 4xx errors release the slot
// so the client can fix the payload and retry; 5xx errors leave it
// PENDING so retries don't loop into the same wall.
//
// The dpr.js in-memory cache stays untouched (different surface, less
// audit weight) — see idempotency.js for the rationale.
//
// Run: cd backend && npx jest __tests__/dr020-durable-idempotency.test.js
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';

jest.mock('../src/lib/blobStorage', () => ({
  generateReadSASUrl: jest.fn(async () => ({ sasUrl: 'https://r2.example/sas', expiresAt: new Date().toISOString() })),
  generateUploadSASUrl: jest.fn(async () => ({ sasUrl: 'https://r2.example/put', blobPath: 'x', expiresAt: new Date().toISOString() })),
  generateULID: jest.fn(() => '01ARZ3NDEKTSV4RRFFQ69G5FAV'),
  verifyBlobExists: jest.fn(async () => ({ exists: true })),
  deleteBlob: jest.fn(async () => {}),
  uploadBufferToBlob: jest.fn(async () => {}),
  READ_URL_TTL_SECONDS: 3600,
  ALLOWED_R2_BUCKETS: ['dpr-photos', 'dpr-documents', 'inspection-photos'],
  REQUIRED_BUCKETS: ['dpr-photos', 'inspection-photos'],
  applyR2Cors: jest.fn(async () => []),
  CONTENT_TYPE_EXT: { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' },
}));

jest.mock('../src/lib/notify', () => ({
  fanOutEmail: jest.fn(async () => ({ sent: 0 })),
  fanOutToAdmins: jest.fn(async () => ({ sent: 0, skipped: 0, failed: 0 })),
}));

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
require('express-async-errors');

const billingRouter = require('../src/routes/billingCertifications');

const ADMIN_ID = '44444444-4444-4444-8444-444444444444';
const PROJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const IDEMPOTENCY_KEY = 'idem-bc-001';

function adminJwt() {
  return `Bearer ${jwt.sign(
    { employeeId: ADMIN_ID, email: 'admin@example.com', isAdmin: true },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  )}`;
}

// Body fixture — kept small so the bodyHash is deterministic across
// runs. The route only checks the audit fields + amounts.
function baseBody(overrides = {}) {
  return {
    projectId: PROJECT_A,
    contractorName: 'Acme Builders',
    billNumber: 'INV-2026-001',
    billDate: '2026-08-15',
    claimedAmount: 100000,
    certifiedAmount: 95000,
    ...overrides,
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());

  const certRows = new Map();
  const projectRows = new Map();
  projectRows.set(PROJECT_A, { id: PROJECT_A, name: 'Alpha Site', isActive: true });

  // requestDedupe store — the new (DR-020) durable path. Mock as a
  // Map keyed by the namespaced key. Mirrors the production schema:
  //   key          PK (string)
  //   payloadHash  string
  //   state        'PENDING' | 'COMPLETED' | 'FAILED'
  //   resultStatus number | null
  //   resultBody   any | null
  //   recordKind   string | null
  //   recordId     string | null
  //   createdAt    Date
  //   updatedAt    Date
  //   expiresAt    Date | null
  const dedupeRows = new Map();

  const prisma = {
    project: {
      findUnique: jest.fn(async ({ where }) => projectRows.get(where.id) || null),
    },
    employee: {
      findUnique: jest.fn(async ({ where }) => ({
        id: where.id,
        isAdmin: true,
      })),
    },
    dPR: { findMany: jest.fn(async () => []) },
    inspectionRecord: { findMany: jest.fn(async () => []) },
    boqItem: { findMany: jest.fn(async () => []) },
    variationOrder: { findMany: jest.fn(async () => []) },
    drawing: { findMany: jest.fn(async () => []) },
    requestDedupe: {
      create: jest.fn(async ({ data }) => {
        if (dedupeRows.has(data.key)) {
          // Prisma throws P2002 here in production. Mirror it so the
          // route's conflict branch is exercised by the tests below.
          const err = new Error('Unique constraint failed');
          err.code = 'P2002';
          throw err;
        }
        const row = {
          ...data,
          resultStatus: null,
          resultBody: null,
          recordKind: null,
          recordId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          expiresAt: null,
        };
        dedupeRows.set(data.key, row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }) => dedupeRows.get(where.key) || null),
      update: jest.fn(async ({ where, data }) => {
        const existing = dedupeRows.get(where.key);
        if (!existing) {
          const err = new Error('Not found');
          err.code = 'P2025';
          throw err;
        }
        const updated = { ...existing, ...data };
        dedupeRows.set(where.key, updated);
        return updated;
      }),
      deleteMany: jest.fn(async ({ where }) => {
        const existing = dedupeRows.get(where.key);
        if (existing && (where.state === undefined || existing.state === where.state)) {
          dedupeRows.delete(where.key);
          return { count: 1 };
        }
        return { count: 0 };
      }),
    },
    billingCertification: {
      create: jest.fn(async ({ data }) => {
        const row = {
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          version: 0,
          supersededAt: null,
          parentCertificationId: null,
        };
        certRows.set(row.id, row);
        return row;
      }),
      findUnique: jest.fn(async ({ where, include }) => {
        const row = certRows.get(where.id);
        if (!row) return null;
        if (!include) return row;
        return {
          ...row,
          project: include.project ? projectRows.get(row.projectId) || null : undefined,
          recordedBy: include.recordedBy ? { id: row.recordedById, name: 'Admin', designation: null } : undefined,
          certifiedBy: include.certifiedBy ? (row.certifiedById ? { id: row.certifiedById, name: 'Admin', designation: null } : null) : undefined,
        };
      }),
      findMany: jest.fn(async () => Array.from(certRows.values())),
      count: jest.fn(async () => certRows.size),
      groupBy: jest.fn(async () => []),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  };

  app.set('prisma', prisma);
  app.use((req, _res, next) => {
    req.employeeId = ADMIN_ID;
    req.isAdmin = true;
    req.employee = { id: ADMIN_ID, isAdmin: true };
    next();
  });
  app.use('/api/billing-certifications', billingRouter);

  return { app, prisma, dedupeRows, certRows };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('DR-020 — durable idempotency on billing certification POST', () => {
  test('1. POST without Idempotency-Key creates the row without a reservation', async () => {
    const { app, dedupeRows, certRows } = buildApp();
    const res = await request(app)
      .post('/api/billing-certifications')
      .set('Authorization', adminJwt())
      .send(baseBody());
    expect(res.status).toBe(201);
    // No header → no reservation row.
    expect(dedupeRows.size).toBe(0);
    expect(certRows.size).toBe(1);
  });

  test('2. POST with Idempotency-Key creates the row + marks reservation COMPLETED', async () => {
    const { app, dedupeRows, certRows } = buildApp();
    const res = await request(app)
      .post('/api/billing-certifications')
      .set('Authorization', adminJwt())
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send(baseBody());
    expect(res.status).toBe(201);
    expect(certRows.size).toBe(1);
    // Reservation row exists + COMPLETED with cached response.
    expect(dedupeRows.size).toBe(1);
    const [, dedupeRow] = Array.from(dedupeRows.entries())[0];
    expect(dedupeRow.state).toBe('COMPLETED');
    expect(dedupeRow.resultStatus).toBe(201);
    expect(dedupeRow.recordKind).toBe('billingCertification');
    expect(dedupeRow.recordId).toBeTruthy();
  });

  test('3. POST same key + same body → cached 201 + Idempotent-Replay header', async () => {
    const { app, certRows } = buildApp();
    const first = await request(app)
      .post('/api/billing-certifications')
      .set('Authorization', adminJwt())
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send(baseBody());
    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replay']).toBeUndefined();

    const second = await request(app)
      .post('/api/billing-certifications')
      .set('Authorization', adminJwt())
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send(baseBody());
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');
    // Only ONE row was created — the replay did NOT re-insert.
    expect(certRows.size).toBe(1);
  });

  test('4. POST same key + DIFFERENT body → 409 IDEMPOTENCY_MISMATCH', async () => {
    const { app, certRows } = buildApp();
    const first = await request(app)
      .post('/api/billing-certifications')
      .set('Authorization', adminJwt())
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send(baseBody());
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/billing-certifications')
      .set('Authorization', adminJwt())
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send(baseBody({ billNumber: 'INV-2026-002' }));
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('IDEMPOTENCY_MISMATCH');
    expect(certRows.size).toBe(1);
  });

  test('5. POST with concurrent PENDING reservation → 409 IDEMPOTENCY_CONFLICT on second', async () => {
    const { app, dedupeRows } = buildApp();
    // Pre-seed a PENDING slot under the same namespaced key so the
    // second request trips the unique-constraint guard.
    const { namespaceKey } = require('../src/lib/idempotency');
    const { sha256Hex, canonicalJsonStringify } = require('../src/lib/idempotency');
    const namespacedKey = namespaceKey({
      route: 'billingCertification.create',
      employeeId: ADMIN_ID,
      rawKey: IDEMPOTENCY_KEY,
    });
    dedupeRows.set(namespacedKey, {
      key: namespacedKey,
      payloadHash: sha256Hex(canonicalJsonStringify(baseBody())),
      state: 'PENDING',
      resultStatus: null,
      resultBody: null,
      recordKind: null,
      recordId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: null,
    });

    const res = await request(app)
      .post('/api/billing-certifications')
      .set('Authorization', adminJwt())
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send(baseBody());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  test('6. POST 4xx (project not found) releases the reservation so the client can retry', async () => {
    const { app, dedupeRows } = buildApp();
    const res = await request(app)
      .post('/api/billing-certifications')
      .set('Authorization', adminJwt())
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send(baseBody({ projectId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PROJECT_NOT_FOUND');
    // Reservation was released (deleteMany on PENDING).
    expect(dedupeRows.size).toBe(0);
  });

  test('7. POST 400 (validation) BEFORE reserve is called — no reservation made', async () => {
    const { app, dedupeRows } = buildApp();
    const res = await request(app)
      .post('/api/billing-certifications')
      .set('Authorization', adminJwt())
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      // Missing billNumber — rejected before reserve().
      .send(baseBody({ billNumber: '' }));
    expect(res.status).toBe(400);
    expect(dedupeRows.size).toBe(0);
  });
});

// ─── Source-text contracts ─────────────────────────────────────────────────

describe('DR-020 — durable idempotency source-text contracts', () => {
  const { readFileSync } = require('fs');
  const { resolve: resolvePath } = require('path');

  test('8. idempotency.js exports the durable reservation API', () => {
    const idempSrc = readFileSync(
      resolvePath(__dirname, '../src/lib/idempotency.js'),
      'utf8',
    );
    expect(idempSrc).toMatch(/async\s+function\s+reserve\s*\(/);
    expect(idempSrc).toMatch(/async\s+function\s+complete\s*\(/);
    expect(idempSrc).toMatch(/async\s+function\s+fail\s*\(/);
    expect(idempSrc).toMatch(/async\s+function\s+release\s*\(/);
    expect(idempSrc).toMatch(/function\s+namespaceKey\s*\(/);
    expect(idempSrc).toMatch(/async\s+function\s+lookupReservation\s*\(/);
  });

  test('9. billingCertifications.js wires reserve/complete/release', () => {
    const billSrc = readFileSync(
      resolvePath(__dirname, '../src/routes/billingCertifications.js'),
      'utf8',
    );
    // Imports the durable API.
    expect(billSrc).toMatch(
      /reserve:\s*reserveIdempotency[\s\S]*?complete:\s*completeIdempotency[\s\S]*?release:\s*releaseIdempotency[\s\S]*?\}\s*=\s*require\(['"]\.\.\/lib\/idempotency['"]\)/,
    );
    // Calls reserve() before any DB writes.
    expect(billSrc).toMatch(
      /const\s+idempotencyReservation\s*=\s*await\s+reserveIdempotency\(/,
    );
    // Branches on replay / mismatch / conflict.
    expect(billSrc).toMatch(/idempotencyReservation\.replay/);
    expect(billSrc).toMatch(/idempotencyReservation\.mismatch/);
    expect(billSrc).toMatch(/idempotencyReservation\.conflict/);
    // Calls complete() after success.
    expect(billSrc).toMatch(/await\s+completeIdempotency\(/);
    // Calls release() on recoverable 4xx paths.
    expect(billSrc).toMatch(/await\s+releaseIdempotency\(/);
  });

  test('10. schema.prisma declares the request_dedupe model', () => {
    const schemaSrc = readFileSync(
      resolvePath(__dirname, '../prisma/schema.prisma'),
      'utf8',
    );
    expect(schemaSrc).toMatch(/model\s+RequestDedupe\s*\{/);
    expect(schemaSrc).toMatch(/key\s+String\s+@id/);
    expect(schemaSrc).toMatch(/state\s+String/);
    expect(schemaSrc).toMatch(/payloadHash\s+String/);
  });
});
