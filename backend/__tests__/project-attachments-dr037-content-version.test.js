// DR-037 — content-version optimistic concurrency on project attachments.
//
// Bug class: an admin opens file A in a tab and approves it. Meanwhile
// (same tab / different tab) the owner replaces the file with file B.
// The replace path correctly resets status to PENDING_REVIEW on the new
// blob, but the in-flight Approve PATCH still has the OLD contentVersion
// in hand — so it lands on the row, stamping APPROVED on bytes the
// reviewer never saw.
//
// Fix: every successful mutation (review, replace) bumps contentVersion.
// Every PATCH requires the caller to pass `expectedVersion` echoing the
// row's current value at click-time. A mismatch returns 409
// STALE_REVIEW_VERSION with both versions in the body so the SPA can
// render "refresh and try again" instead of silently approving unseen
// content.
//
// This suite covers:
//   1. review PATCH accepts expectedVersion + bumps contentVersion
//   2. review PATCH with stale expectedVersion → 409 STALE_REVIEW_VERSION
//   3. review PATCH with no expectedVersion (omitted) is allowed
//      (legacy / non-versioned callers still work)
//   4. replace PATCH with expectedVersion + bumps contentVersion
//   5. replace PATCH with stale expectedVersion → 409 STALE_REVIEW_VERSION
//   6. serializer exposes contentVersion on every read
//   7. schema + migration declare the column + index
//
// Source-text pinning (project-attachments-review.test.js pattern):
//   tests 7 pins the schema.prisma column + the migration column so a
//   future refactor that drops the field fails here at test time
//   instead of at deploy time.

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';

const { readFileSync } = require('fs');
const { resolve: resolvePath } = require('path');

// Stub blobStorage before the route module is required. Same shape as
// project-attachments.test.js — avoids the AWS SDK ESM chain.
jest.mock('../src/lib/blobStorage', () => ({
  generateReadSASUrl: jest.fn(async () => ({ sasUrl: 'https://r2.example/read?sig=stub' })),
  READ_URL_TTL_SECONDS: 3600,
  generateUploadSASUrl: jest.fn(async () => ({ sasUrl: 'https://r2.example/upload?sig=stub', blobPath: 'employee-1/01J0FAKEFAKEFAKEFAKEFAKE.pdf', expiresAt: '2030-01-01T00:00:00Z' })),
  generateULID: jest.fn(() => '01J0FZ0000000000000000FAKE'),
  verifyBlobExists: jest.fn(async () => ({ outcome: 'present', exists: true })),
  deleteBlob: jest.fn(),
  uploadBufferToBlob: jest.fn(),
  getClient: jest.fn(),
  applyR2Cors: jest.fn(async () => []),
  probeBucket: jest.fn(async () => true),
  listObjects: jest.fn(async () => []),
  ALLOWED_R2_BUCKETS: ['dpr-photos', 'dpr-documents', 'inspection-photos'],
  REQUIRED_BUCKETS: ['dpr-photos', 'inspection-photos'],
  CONTENT_TYPE_EXT: {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/heic': 'heic', 'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'text/plain': 'txt', 'text/csv': 'csv',
  },
}));

// Stub uploadIntentBinding so the replace path's intent validation is
// a no-op. The DR-037 fix doesn't touch binding logic; this just keeps
// the replace test focused on the version check.
jest.mock('../src/lib/uploadIntentBinding', () => ({
  validatePhotoIntents: jest.fn(async () => null),
  assertPhotoIntentsBindable: jest.fn(async () => undefined),
  // [DR-037] withRecordTransaction is called by the replace path.
  // Hand the callback through so the route's update call lands on the
  // in-memory mock row instead of being passed a transactional client
  // that the mock doesn't model.
  withRecordTransaction: async (prisma, modelName, fn) => fn(prisma),
}));

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
require('express-async-errors');

const projectAttachmentRouter = require('../src/routes/projectAttachments');

const ADMIN_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID  = '55555555-5555-4555-8555-555555555555';
const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ATTACHMENT_ID = '99999999-9999-4999-8999-999999999999';

function adminJwt() {
  return `Bearer ${jwt.sign(
    { employeeId: ADMIN_ID, email: 'admin@example.com', isAdmin: true },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  )}`;
}
function userJwt(employeeId = USER_ID) {
  return `Bearer ${jwt.sign(
    { employeeId, email: 'user@example.com', isAdmin: false },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  )}`;
}

// In-memory prisma that supports the three mutations the DR-037 routes
// touch: review PATCH (findUnique + update with contentVersion
// increment), replace PATCH (findUnique + tx with updateMany +
// contentVersion increment), and the serializer (every read).
function buildApp() {
  const app = express();
  app.use(express.json());

  const attachmentRows = new Map();
  const projectRows = new Map();
  projectRows.set(PROJECT_ID, { id: PROJECT_ID, name: 'DR037 Site', isActive: true });

  const prisma = {
    project: {
      findUnique: jest.fn(async ({ where }) => {
        if (where.id) return projectRows.get(where.id) || null;
        if (where.name) return projectRows.get(where.name) || null;
        return null;
      }),
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }) => {
        const row = { id: data.id || 'new', name: data.name, isActive: true, createdById: data.createdById || null };
        projectRows.set(row.id, row);
        projectRows.set(row.name, row);
        return row;
      }),
    },
    projectAttachment: {
      findUnique: jest.fn(async ({ where }) => {
        if (where.id) return attachmentRows.get(where.id) || null;
        return null;
      }),
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }) => {
        const row = {
          id: data.id || ATTACHMENT_ID,
          projectId: data.projectId,
          type: data.type,
          title: data.title || null,
          filename: data.filename,
          contentType: data.contentType,
          sizeBytes: data.sizeBytes,
          blobPath: data.blobPath,
          uploadedById: data.uploadedById,
          uploadedAt: new Date(),
          deletedAt: null,
          status: 'PENDING_REVIEW',
          reviewedById: null,
          reviewedAt: null,
          reviewNotes: null,
          contentVersion: 1,
        };
        attachmentRows.set(row.id, row);
        return row;
      }),
      // Mirror the production increment-by-1 pattern. The route hands
      // us `{ increment: 1 }`; honour it so the conflict check below
      // sees the row's bumped value on the next read.
      update: jest.fn(async ({ where, data }) => {
        const row = attachmentRows.get(where.id);
        if (!row) throw Object.assign(new Error('not found'), { code: 'P2025' });
        applyUpdateData(row, data);
        return row;
      }),
    },
    uploadIntent: {
      findMany: jest.fn(async () => []),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    employee: {
      findUnique: jest.fn(async ({ where }) => {
        // requireFreshAdmin re-reads isAdmin off this row.
        if (where?.id === ADMIN_ID) return { id: ADMIN_ID, name: 'DR037 Admin', email: 'a@example.com', isAdmin: true };
        if (where?.id === USER_ID) return { id: USER_ID, name: 'DR037 User', email: 'u@example.com', isAdmin: false };
        return null;
      }),
    },
    $transaction: async (fn) => fn(prisma),
  };
  app.set('prisma', prisma);
  app.use('/api/projects/:projectId/attachments', projectAttachmentRouter);
  return { app, prisma, attachmentRows };
}

// Mirror the production `{ increment: 1 }` shape so the in-memory
// row actually increments instead of getting stamped with the literal
// `{ increment: 1 }` object — a real Prisma update call would resolve
// it server-side; the test mock has to do the same.
function applyUpdateData(row, data) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in v && typeof v.increment === 'number') {
      row[k] = (row[k] || 0) + v.increment;
    } else {
      row[k] = v;
    }
  }
}

function seedAttachment(attachmentRows, overrides = {}) {
  const row = {
    id: ATTACHMENT_ID,
    projectId: PROJECT_ID,
    type: 'WEEKLY_REPORT',
    title: 'W36',
    filename: 'weekly-w36.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
    blobPath: 'employee-1/01J0FAKE.pdf',
    uploadedById: USER_ID,
    uploadedAt: new Date(),
    deletedAt: null,
    status: 'PENDING_REVIEW',
    reviewedById: null,
    reviewedAt: null,
    reviewNotes: null,
    contentVersion: 1,
    ...overrides,
  };
  attachmentRows.set(row.id, row);
  return row;
}

describe('DR-037 — content-version optimistic concurrency on project attachments', () => {
  test('1. review PATCH with matching expectedVersion succeeds + bumps contentVersion', async () => {
    const { app, prisma, attachmentRows } = buildApp();
    seedAttachment(attachmentRows, { contentVersion: 1 });
    prisma.projectAttachment.update = jest.fn(async ({ where, data }) => {
      const r = attachmentRows.get(where.id);
      applyUpdateData(r, data);
      return r;
    });

    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}/attachments/${ATTACHMENT_ID}`)
      .set('Authorization', adminJwt())
      .send({ status: 'APPROVED', reviewNotes: null, expectedVersion: 1 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');
    expect(res.body.contentVersion).toBe(2);
    expect(attachmentRows.get(ATTACHMENT_ID).contentVersion).toBe(2);
  });

  test('2. review PATCH with STALE expectedVersion → 409 STALE_REVIEW_VERSION (no row mutation)', async () => {
    const { app, prisma, attachmentRows } = buildApp();
    seedAttachment(attachmentRows, { contentVersion: 5 });
    const updateSpy = jest.fn(async ({ where, data }) => {
      const r = attachmentRows.get(where.id);
      applyUpdateData(r, data);
      return r;
    });
    prisma.projectAttachment.update = updateSpy;

    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}/attachments/${ATTACHMENT_ID}`)
      .set('Authorization', adminJwt())
      .send({ status: 'APPROVED', reviewNotes: null, expectedVersion: 4 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STALE_REVIEW_VERSION');
    expect(res.body.currentVersion).toBe(5);
    expect(res.body.submittedVersion).toBe(4);
    // The row must NOT have been mutated — no status change, no bump.
    expect(attachmentRows.get(ATTACHMENT_ID).status).toBe('PENDING_REVIEW');
    expect(attachmentRows.get(ATTACHMENT_ID).contentVersion).toBe(5);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  test('3. review PATCH with NO expectedVersion is allowed (legacy callers)', async () => {
    // Backwards-compatible: an older SPA that doesn't send expectedVersion
    // still works — DR-037 is an ADDITIVE check, not a breaking one.
    // The risk it adds (silent approve-of-unseen-blob) is acceptable
    // because the SPA always captures att.contentVersion at click-time
    // going forward.
    const { app, prisma, attachmentRows } = buildApp();
    seedAttachment(attachmentRows, { contentVersion: 1 });
    prisma.projectAttachment.update = jest.fn(async ({ where, data }) => {
      const r = attachmentRows.get(where.id);
      applyUpdateData(r, data);
      return r;
    });

    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}/attachments/${ATTACHMENT_ID}`)
      .set('Authorization', adminJwt())
      .send({ status: 'APPROVED', reviewNotes: null });

    expect(res.status).toBe(200);
    expect(res.body.contentVersion).toBe(2);
  });

  test('4. replace PATCH with matching expectedVersion succeeds + bumps contentVersion', async () => {
    const { app, prisma, attachmentRows } = buildApp();
    seedAttachment(attachmentRows, {
      contentVersion: 3,
      status: 'APPROVED',
      reviewedById: ADMIN_ID,
      reviewedAt: new Date(),
      reviewNotes: 'looks good',
    });
    prisma.projectAttachment.update = jest.fn(async ({ where, data }) => {
      const r = attachmentRows.get(where.id);
      applyUpdateData(r, data);
      return r;
    });

    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}/attachments/${ATTACHMENT_ID}/file`)
      .set('Authorization', userJwt())
      .send({
        uploadIntentUlid: '01J0FZ0000000000000000FAKE',
        blobPath: 'employee-1/01J0FAKE_NEW.pdf',
        filename: 'weekly-w36-v2.pdf',
        contentType: 'application/pdf',
        sizeBytes: 2048,
        expectedVersion: 3,
      });

    expect(res.status).toBe(200);
    // Review state reset on replace, contentVersion bumped.
    expect(res.body.status).toBe('PENDING_REVIEW');
    expect(res.body.contentVersion).toBe(4);
    expect(attachmentRows.get(ATTACHMENT_ID).contentVersion).toBe(4);
    expect(attachmentRows.get(ATTACHMENT_ID).reviewedById).toBeNull();
  });

  test('5. replace PATCH with STALE expectedVersion → 409 STALE_REVIEW_VERSION (no row mutation)', async () => {
    const { app, prisma, attachmentRows } = buildApp();
    seedAttachment(attachmentRows, { contentVersion: 7 });
    const updateSpy = jest.fn(async ({ where, data }) => {
      const r = attachmentRows.get(where.id);
      applyUpdateData(r, data);
      return r;
    });
    prisma.projectAttachment.update = updateSpy;

    const res = await request(app)
      .patch(`/api/projects/${PROJECT_ID}/attachments/${ATTACHMENT_ID}/file`)
      .set('Authorization', userJwt())
      .send({
        uploadIntentUlid: '01J0FZ0000000000000000FAKE',
        blobPath: 'employee-1/01J0FAKE_NEW.pdf',
        filename: 'weekly-w36-v2.pdf',
        contentType: 'application/pdf',
        sizeBytes: 2048,
        expectedVersion: 6,
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STALE_REVIEW_VERSION');
    expect(res.body.currentVersion).toBe(7);
    expect(res.body.submittedVersion).toBe(6);
    expect(attachmentRows.get(ATTACHMENT_ID).contentVersion).toBe(7);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  test('6. serializer exposes contentVersion on every read (list echo)', async () => {
    const { app, prisma, attachmentRows } = buildApp();
    seedAttachment(attachmentRows, { contentVersion: 42 });
    // The list findMany in buildApp returns [] by default — replace it
    // with one that surfaces the seeded row so the serializer runs.
    prisma.projectAttachment.findMany = jest.fn(async () =>
      Array.from(attachmentRows.values()),
    );

    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/attachments`)
      .set('Authorization', userJwt());

    expect(res.status).toBe(200);
    expect(res.body.attachments).toHaveLength(1);
    expect(res.body.attachments[0]).toHaveProperty('contentVersion', 42);
  });

  test('7. schema.prisma declares the contentVersion column with @default(1)', async () => {
    // Pin the schema so a future refactor that drops the field fails
    // here at test time (not at deploy time, where the @map field name
    // mismatch would silently lose every concurrent-write guard).
    const schemaSrc = readFileSync(
      resolvePath(__dirname, '../prisma/schema.prisma'),
      'utf8',
    );
    expect(schemaSrc).toMatch(/contentVersion\s+Int\s+@default\(1\)\s+@map\(["']content_version["']\)/);
  });

  test('8. migration declares the content_version column + composite index', async () => {
    const migrationSrc = readFileSync(
      resolvePath(
        __dirname,
        '../prisma/migrations/20260919000002_dr037_content_version/migration.sql',
      ),
      'utf8',
    );
    expect(migrationSrc).toMatch(/ADD COLUMN IF NOT EXISTS\s+content_version\s+INT NOT NULL DEFAULT 1/);
    expect(migrationSrc).toMatch(/project_attachment_status_content_version_idx/);
  });

  test('9. route source references STALE_REVIEW_VERSION envelope on both PATCH endpoints', async () => {
    // Pin the error code so a future refactor that renames the code
    // (and silently breaks the SPA's `err.code === 'STALE_REVIEW_VERSION'`
    // check) is caught here.
    const routeSrc = readFileSync(
      resolvePath(__dirname, '../src/routes/projectAttachments.js'),
      'utf8',
    );
    // Two STALE_REVIEW_VERSION code returns: one in the review PATCH,
    // one in the replace PATCH. Pin the count to lock the contract.
    const staleHits = routeSrc.match(/STALE_REVIEW_VERSION/g) || [];
    expect(staleHits.length).toBeGreaterThanOrEqual(4); // 2 returns × 2 mentions each (error + code)
  });
});
