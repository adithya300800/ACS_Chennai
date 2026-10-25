// DR-034 — DPR evidence lock.
//
// WHAT THIS PINS DOWN
//
// PATCH /api/dpr/:id/photos/:photoId re-binds a photo row to freshly
// uploaded bytes. That is the BLOB_GONE repair path: the server found
// the blob missing from object storage, so the user re-uploads and the
// existing row is pointed at the new intent.
//
// The hazard: once a DPR has left DRAFT its evidence is "on file" —
// a reviewer is looking at those bytes. If the submitter can still
// replace them, the reviewer approves bytes they never saw, and the
// approval trail no longer describes what was approved. The route
// therefore locks evidence replacement to DRAFT.
//
// The lock has TWO parts and this suite covers both:
//
//   1. The fast path — a non-DRAFT DPR is rejected with 409
//      DPR_EVIDENCE_LOCKED before any write.
//   2. The authoritative path — the claim is a conditional write
//      (`updateMany` with `status: 'DRAFT'` in the WHERE) INSIDE the
//      transaction. The read that feeds part 1 can be stale by the
//      time the transaction runs, so a DPR that is submitted between
//      the read and the write must still be rejected — and must not
//      have its photo row re-bound.
//
// Acceptance:
//   - DRAFT DPR, owner or admin → 200, photo re-bound, version bumped.
//   - SUBMITTED / UNDER_REVIEW / APPROVED / REJECTED → 409
//     DPR_EVIDENCE_LOCKED, for the owner AND for an admin.
//   - A DPR that leaves DRAFT between the read and the write → 409
//     DPR_EVIDENCE_LOCKED, and the photo row is NOT re-bound.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const mockVerifyBlobExists = jest.fn();
const mockGenerateReadSASUrl = jest.fn(async (_container, blobName) => ({
  sasUrl: `https://r2.example/${encodeURIComponent(blobName)}`,
}));
jest.mock('../src/lib/blobStorage', () => ({
  generateUploadSASUrl: jest.fn(),
  verifyBlobExists: (...args) => mockVerifyBlobExists(...args),
  deleteBlob: jest.fn(async () => ({ ok: true })),
  generateReadSASUrl: (...args) => mockGenerateReadSASUrl(...args),
  CONTENT_TYPE_EXT: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' },
  uploadIntentBinding: { bindPhotoIntents: jest.fn(async () => null) },
}));

const dprRouter = require('../src/routes/dpr');

const SUBMITTER_ID = 'emp-dr034-submitter';
const ADMIN_ID = 'emp-dr034-admin';

const authHeader = (employeeId, isAdmin = false) => jwt.sign(
  { employeeId, email: `${employeeId}@example.com`, isAdmin },
  process.env.JWT_SECRET,
  { expiresIn: '8h' },
);

function buildApp({ prisma }) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.use('/api/dpr', dprRouter);
  return app;
}

const PHOTO_ULID = '01HREPLACELOCK001';
const BLOB_PATH = `${SUBMITTER_ID}/${PHOTO_ULID}.jpg`;

// An admin repairs the photo with THEIR OWN upload intent — /sas-url mints
// under the caller's own prefix, and `validatePhotoIntents` only accepts
// an intent the caller owns. So the admin path needs a second intent row.
const ADMIN_PHOTO_ULID = '01HREPLACELOCKADMIN1';
const ADMIN_BLOB_PATH = `${ADMIN_ID}/${ADMIN_PHOTO_ULID}.jpg`;

/**
 * Prisma mock with the pieces the replace endpoint touches.
 *
 * `onBeforeClaim` is the hook that lets a test move the DPR out of
 * DRAFT *after* the route's status read but *before* the conditional
 * write inside the transaction — the exact TOCTOU window the in-
 * transaction claim exists to close.
 */
function buildPrismaMock({ status = 'DRAFT', onBeforeClaim = null } = {}) {
  const dpr = {
    id: 'dpr-1',
    submittedById: SUBMITTER_ID,
    status,
    version: 1,
    projectName: 'Race site',
    location: 'Chennai',
    reportDate: new Date('2026-09-21T00:00:00.000Z'),
  };
  const photos = [{
    id: 'photo-1',
    dprId: 'dpr-1',
    container: 'dpr-photos',
    ulid: PHOTO_ULID,
    filename: `${PHOTO_ULID}.jpg`,
    contentType: 'image/jpeg',
    sizeBytes: 4096,
    caption: null,
    location: null,
    takenAt: null,
  }];
  const intentsByUlid = {
    [PHOTO_ULID]: {
      employeeId: SUBMITTER_ID,
      container: 'dpr-photos',
      blobPath: BLOB_PATH,
      contentType: 'image/jpeg',
      sizeBytes: 4096,
      status: 'CONFIRMED',
    },
    [ADMIN_PHOTO_ULID]: {
      employeeId: ADMIN_ID,
      container: 'dpr-photos',
      blobPath: ADMIN_BLOB_PATH,
      contentType: 'image/jpeg',
      sizeBytes: 4096,
      status: 'CONFIRMED',
    },
  };

  const prisma = {
    uploadIntent: {
      findMany: async ({ where }) => {
        const inList = (where && where.ulid && where.ulid.in) || [];
        return inList
          .filter((u) => intentsByUlid[u]
            && intentsByUlid[u].status === 'CONFIRMED'
            && intentsByUlid[u].employeeId === where.employeeId)
          .map((u) => ({
            ulid: u,
            container: intentsByUlid[u].container,
            blobPath: intentsByUlid[u].blobPath,
            contentType: intentsByUlid[u].contentType,
            verifiedContentType: intentsByUlid[u].contentType,
            verifiedSizeBytes: intentsByUlid[u].sizeBytes,
          }));
      },
      findFirst: async ({ where }) => {
        const intent = intentsByUlid[where.ulid];
        if (!intent) return null;
        if (where.container && intent.container !== where.container) return null;
        return { blobPath: intent.blobPath };
      },
    },
    dPRPhoto: {
      findUnique: async ({ where: { id } }) => photos.find((p) => p.id === id) || null,
      findMany: async ({ where }) => photos.filter((p) => p.dprId === where.dprId).map((p) => ({ ...p })),
      update: async ({ where: { id }, data }) => {
        const idx = photos.findIndex((p) => p.id === id);
        if (idx < 0) {
          const e = new Error('Photo not found');
          e.code = 'P2025';
          throw e;
        }
        photos[idx] = { ...photos[idx], ...data };
        return { ...photos[idx] };
      },
    },
    dPR: {
      findUnique: async ({ where: { id } }) => (id === dpr.id ? { ...dpr } : null),
      // The conditional write that claims the DRAFT state. Mirrors
      // Prisma's compare-and-swap semantics: count 1 only when the row
      // exists AND still matches the status in the WHERE clause.
      updateMany: async ({ where, data }) => {
        if (onBeforeClaim) await onBeforeClaim();
        if (!dpr || dpr.id !== where.id) return { count: 0 };
        if (where.status !== undefined && dpr.status !== where.status) return { count: 0 };
        if (data?.version?.increment) dpr.version += data.version.increment;
        return { count: 1 };
      },
      // Present so withRecordTransaction() treats this client as a real
      // transactional client (it probes for `tx.dPR.create`).
      create: async () => ({}),
    },
    employee: {
      findUnique: async ({ where: { id } }) => ({
        id,
        isAdmin: id === ADMIN_ID,
      }),
    },
    $transaction: async (fn) => fn(prisma),
  };

  return { prisma, dpr, photos };
}

function replaceBody(ulid = PHOTO_ULID, blobPath = BLOB_PATH) {
  return {
    uploadIntentUlid: ulid,
    blobPath,
    filename: 'rep.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 4096,
  };
}

beforeEach(() => {
  mockVerifyBlobExists.mockReset();
  mockVerifyBlobExists.mockResolvedValue({ outcome: 'present', exists: true });
  mockGenerateReadSASUrl.mockClear();
});

describe('DR-034 — DPR evidence lock (PATCH /api/dpr/:id/photos/:photoId)', () => {
  test('DRAFT DPR: owner can replace the photo — 200 and the row is re-bound', async () => {
    const { prisma, dpr, photos } = buildPrismaMock({ status: 'DRAFT' });
    const app = buildApp({ prisma });

    const res = await request(app)
      .patch('/api/dpr/dpr-1/photos/photo-1')
      .set('Authorization', `Bearer ${authHeader(SUBMITTER_ID)}`)
      .send(replaceBody());

    expect(res.status).toBe(200);
    expect(photos[0].ulid).toBe(PHOTO_ULID);
    // The record's evidence changed, so the optimistic-concurrency token
    // must advance — otherwise a concurrent editor keeps editing against
    // a version that no longer describes the record.
    expect(dpr.version).toBe(2);
  });

  test('DRAFT DPR: admin can replace the photo', async () => {
    const { prisma } = buildPrismaMock({ status: 'DRAFT' });
    const app = buildApp({ prisma });

    const res = await request(app)
      .patch('/api/dpr/dpr-1/photos/photo-1')
      .set('Authorization', `Bearer ${authHeader(ADMIN_ID, true)}`)
      .send(replaceBody(ADMIN_PHOTO_ULID, ADMIN_BLOB_PATH));

    expect(res.status).toBe(200);
  });

  test.each(['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED'])(
    '%s DPR: owner is refused with 409 DPR_EVIDENCE_LOCKED',
    async (status) => {
      const { prisma, photos } = buildPrismaMock({ status });
      const app = buildApp({ prisma });

      const res = await request(app)
        .patch('/api/dpr/dpr-1/photos/photo-1')
        .set('Authorization', `Bearer ${authHeader(SUBMITTER_ID)}`)
        .send(replaceBody());

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DPR_EVIDENCE_LOCKED');
      // The photo row must be untouched.
      expect(photos[0].ulid).toBe(PHOTO_ULID);
    },
  );

  test('SUBMITTED DPR: even an admin is refused with 409 DPR_EVIDENCE_LOCKED', async () => {
    // The admin is not the threat model here — the EVIDENCE is. An
    // admin repairing a broken photo on a submitted report would still
    // swap the bytes the reviewer is being asked to approve, so the
    // lock applies to every caller.
    const { prisma, photos } = buildPrismaMock({ status: 'SUBMITTED' });
    const app = buildApp({ prisma });

    const res = await request(app)
      .patch('/api/dpr/dpr-1/photos/photo-1')
      .set('Authorization', `Bearer ${authHeader(ADMIN_ID, true)}`)
      .send(replaceBody(ADMIN_PHOTO_ULID, ADMIN_BLOB_PATH));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DPR_EVIDENCE_LOCKED');
    expect(photos[0].ulid).toBe(PHOTO_ULID);
  });

  test('TOCTOU: a DPR submitted between the status read and the write is refused, photo untouched', async () => {
    // The pre-check read said DRAFT. By the time the conditional write
    // runs, the row is SUBMITTED (a concurrent submit landed). The
    // in-transaction claim must lose, and the photo row must NOT be
    // re-bound — otherwise the reviewer approves bytes they never saw.
    const { prisma, dpr, photos } = buildPrismaMock({
      status: 'DRAFT',
      onBeforeClaim: () => { dpr.status = 'SUBMITTED'; },
    });
    const app = buildApp({ prisma });

    const res = await request(app)
      .patch('/api/dpr/dpr-1/photos/photo-1')
      .set('Authorization', `Bearer ${authHeader(SUBMITTER_ID)}`)
      .send(replaceBody());

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DPR_EVIDENCE_LOCKED');
    // The critical assertion: no bytes were swapped.
    expect(photos[0].ulid).toBe(PHOTO_ULID);
  });
});
