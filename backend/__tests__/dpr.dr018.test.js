// SOL DR-018 regression coverage. The audit caught a path-derivation bug
// at every DPR photo read site (list, detail, repair). The previous code
// reconstructed the storage key as `${dpr.submittedById}/${ulid}.${ext}`
// — the shape /sas-url mints for the original submitter. When an admin
// replaced a photo whose bytes were never landed, the new /sas-url mint
// lived under the admin's prefix, but the reader still looked under the
// submitter's prefix. The byte was there; the reader looked in the wrong
// place and returned null readUrl forever.
//
// Repair: introduce a dual-reader at every read site:
//   1. canonical  — the durable `uploadIntent.blobPath` (the real answer
//                   to "where did the bytes actually land?")
//   2. legacy     — the historical `${submitterId}/${ulid}.${ext}` shape,
//                   preserved for pre-migration uploads and any reader
//                   that hasn't been migrated yet
//
// Acceptance (audit, DR-018):
//   - Owner and different-admin repair each resolve the confirmed
//     object immediately via the canonical path.
//   - Fresh list/detail read after the repair also resolves the canonical
//     path (not the legacy fallback).
//   - Legacy objects remain readable when no intent row exists.
//   - Both candidates absent → readUrl: null (genuine BLOB_GONE).

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

// Mocked blobStorage: every verifyBlobExists invocation is observed so
// the test can assert the resolver tried the canonical path BEFORE the
// legacy path, and the SAS mint is recorded so we can verify the
// readUrl comes from whichever candidate R2 answered 'present' on.
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

// Real photoBlobLookup — we want the test to exercise the actual
// canonical→legacy fall-through, not a stubbed-out copy.
const { resolvePhotoBlobAddress } = require('../src/lib/photoBlobLookup');

const dprRouter = require('../src/routes/dpr');

const SUBMITTER_ID = 'emp-dr018-submitter';
const ADMIN_ID = 'emp-dr018-admin';
const OTHER_EMP = 'emp-dr018-other';

// Helpers
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

/**
 * Build a prisma mock for the DR-018 surface. Keeps two tables:
 *   - dprs[id]    : DPR rows keyed by id
 *   - photosByDprId[dprId] : photo rows for a given DPR
 *   - intentsByUlid[ulid]  : upload-intent rows keyed by ulid
 *
 * All four prisma delegates the dual-reader touches are wired
 * (uploadIntent.findFirst, dPRPhoto.findUnique / findMany, dPR.findUnique,
 * employee.findUnique) so the resolver exercises the real code paths.
 */
function buildPrismaMock({
  intentsByUlid = {},
  photosByDprId = {},
  dprs = {},
  withTransaction = true,
} = {}) {
  const getIntent = async (ulid) => intentsByUlid[ulid] || null;

  const prisma = {
    uploadIntent: {
      // validatePhotoIntents lookup
      findMany: async ({ where }) => {
        const inList = (where && where.ulid && where.ulid.in) || [];
        return inList
          .filter((u) => intentsByUlid[u] && intentsByUlid[u].status === 'CONFIRMED' && intentsByUlid[u].employeeId === where.employeeId)
          .map((u) => ({
            ulid: u,
            container: intentsByUlid[u].container,
            blobPath: intentsByUlid[u].blobPath,
            contentType: intentsByUlid[u].contentType,
            verifiedContentType: intentsByUlid[u].contentType,
            verifiedSizeBytes: intentsByUlid[u].sizeBytes,
          }));
      },
      // assertPhotoIntentsBindable lookup
      findFirst: async ({ where, orderBy: _orderBy }) => {
        const intent = intentsByUlid[where.ulid];
        if (!intent) return null;
        if (where.container && intent.container !== where.container) return null;
        return { blobPath: intent.blobPath };
      },
    },
    dPRPhoto: {
      findUnique: async ({ where: { id } }) => {
        for (const list of Object.values(photosByDprId)) {
          const found = list.find((p) => p.id === id);
          if (found) return { ...found };
        }
        return null;
      },
      findMany: async ({ where }) => {
        const list = photosByDprId[where.dprId] || [];
        return list.map((p) => ({ ...p }));
      },
      update: async ({ where: { id }, data }) => {
        for (const list of Object.values(photosByDprId)) {
          const idx = list.findIndex((p) => p.id === id);
          if (idx >= 0) {
            const merged = { ...list[idx], ...data };
            for (const k of Object.keys(data)) {
              if (typeof data[k] === 'object' && data[k] && 'increment' in data[k]) {
                merged[k] = list[idx][k] + data[k].increment;
              }
            }
            list[idx] = merged;
            return { ...merged };
          }
        }
        const e = new Error('Photo not found');
        e.code = 'P2025';
        throw e;
      },
    },
    dPR: {
      findUnique: async ({ where: { id }, include }) => {
        const row = dprs[id];
        if (!row) return null;
        const out = { ...row };
        if (include && include.photos) {
          // Mirror the GET /api/dpr/:id include shape — the route expects
          // `dpr.photos` plus `dpr.photos[i].dpr.submittedById` for the
          // dual-reader fallback. The route itself builds the response,
          // so we just project the (photo, dpr.submittedById) tuple.
          const photos = photosByDprId[id] || [];
          out.photos = photos.map((p) => ({
            ...p,
            dpr: { submittedById: row.submittedById },
          }));
        }
        return out;
      },
    },
    employee: {
      findUnique: async ({ where: { id } }) => ({
        id,
        isAdmin: id === ADMIN_ID,
      }),
    },
    $transaction: withTransaction
      ? async (fnOrArray) => {
        if (typeof fnOrArray === 'function') {
          return fnOrArray(prisma);
        }
        const results = [];
        for (const op of fnOrArray) results.push(await op);
        return results;
      }
      : undefined,
  };
  return prisma;
}

// Test fixtures
const seedDpr = ({ id, submittedById = SUBMITTER_ID, status = 'DRAFT', version = 1 } = {}) => ({
  id,
  submittedById,
  status,
  version,
  projectId: null,
  projectName: 'Race site',
  reportDate: new Date('2026-09-21T00:00:00.000Z'),
});

const seedPhoto = ({ id, dprId, ulid, container = 'dpr-photos', contentType = 'image/jpeg' } = {}) => ({
  id,
  dprId,
  container,
  ulid,
  filename: `${ulid}.jpg`,
  contentType,
  sizeBytes: 4096,
  caption: null,
  location: null,
  takenAt: null,
});

beforeEach(() => {
  mockVerifyBlobExists.mockReset();
  mockVerifyBlobExists.mockResolvedValue({ outcome: 'unknown', exists: false, reason: 'NETWORK_ERROR_UNKNOWN' });
  mockGenerateReadSASUrl.mockClear();
});

describe('SOL DR-018 — DPR photo dual-reader (canonical intent → legacy derivation)', () => {
  describe('PATCH /api/dpr/:id/photos/:photoId — repair endpoint', () => {
    test('owner repair: canonical intent path resolves the new readUrl', async () => {
      const photoUlid = '01HREPAIROWNER01';
      const intentBlobPath = `${SUBMITTER_ID}/${photoUlid}.jpg`; // owner uploaded under their own prefix
      const prisma = buildPrismaMock({
        dprs: { 'dpr-1': seedDpr({ id: 'dpr-1' }) },
        photosByDprId: {
          'dpr-1': [seedPhoto({ id: 'photo-1', dprId: 'dpr-1', ulid: photoUlid })],
        },
        intentsByUlid: {
          [photoUlid]: {
            employeeId: SUBMITTER_ID,
            container: 'dpr-photos',
            blobPath: intentBlobPath,
            contentType: 'image/jpeg',
            sizeBytes: 4096,
            status: 'CONFIRMED',
          },
        },
      });
      const app = buildApp({ prisma });

      // HEAD against the canonical blobPath → 'present'.
      mockVerifyBlobExists.mockImplementation(async (_container, blobName) => {
        if (blobName === intentBlobPath) return { outcome: 'present', exists: true };
        return { outcome: 'absent', exists: false, reason: 'NOT_FOUND_404' };
      });

      const res = await request(app)
        .patch('/api/dpr/dpr-1/photos/photo-1')
        .set('Authorization', `Bearer ${authHeader(SUBMITTER_ID)}`)
        .send({
          uploadIntentUlid: photoUlid,
          blobPath: intentBlobPath,
          filename: 'rep.jpg',
          contentType: 'image/jpeg',
          sizeBytes: 4096,
        });

      expect(res.status).toBe(200);
      expect(res.body.readUrl).toBe(`https://r2.example/${encodeURIComponent(intentBlobPath)}`);
      // The canonical lookup must have been tried first; verifyBlobExists
      // recorded it as the first call.
      expect(mockVerifyBlobExists.mock.calls[0][1]).toBe(intentBlobPath);
      // Source tagged as 'canonical' in the response envelope? — current
      // wire shape just echoes the readUrl. Tag is internal, so we exercise
      // it via the order of verifyBlobExists calls (canonical first, no
      // need to try legacy).
      expect(mockVerifyBlobExists.mock.calls.length).toBe(1);
    });

    test('admin repair: canonical path lives under the ADMIN prefix, NOT under submittedById', async () => {
      // The exact failure mode the audit caught. An admin replaces the
      // photo: /sas-url mints under ADMIN_ID/<ulid>.jpg, but the old
      // reader asks for SUBMITTER_ID/<ulid>.jpg → 404 → null readUrl.
      // The dual-reader must ask for the admin-prefixed path first.
      const photoUlid = '01HREPAIRADMIN001';
      const canonicalBlobPath = `${ADMIN_ID}/${photoUlid}.jpg`; // admin's upload
      const legacyBlobPath = `${SUBMITTER_ID}/${photoUlid}.jpg`; // what the old reader asked for
      const prisma = buildPrismaMock({
        dprs: { 'dpr-1': seedDpr({ id: 'dpr-1' }) },
        photosByDprId: {
          'dpr-1': [seedPhoto({ id: 'photo-1', dprId: 'dpr-1', ulid: photoUlid })],
        },
        intentsByUlid: {
          [photoUlid]: {
            employeeId: ADMIN_ID,
            container: 'dpr-photos',
            blobPath: canonicalBlobPath,
            contentType: 'image/jpeg',
            sizeBytes: 4096,
            status: 'CONFIRMED',
          },
        },
      });
      const app = buildApp({ prisma });

      mockVerifyBlobExists.mockImplementation(async (_container, blobName) => {
        if (blobName === canonicalBlobPath) return { outcome: 'present', exists: true };
        if (blobName === legacyBlobPath) return { outcome: 'absent', exists: false, reason: 'NOT_FOUND_404' };
        return { outcome: 'absent', exists: false, reason: 'NOT_FOUND_404' };
      });

      const res = await request(app)
        .patch('/api/dpr/dpr-1/photos/photo-1')
        .set('Authorization', `Bearer ${authHeader(ADMIN_ID, true)}`)
        .send({
          uploadIntentUlid: photoUlid,
          blobPath: canonicalBlobPath,
          filename: 'rep.jpg',
          contentType: 'image/jpeg',
          sizeBytes: 4096,
        });

      expect(res.status).toBe(200);
      expect(res.body.readUrl).toBe(`https://r2.example/${encodeURIComponent(canonicalBlobPath)}`);
      // The very first HEAD must hit the canonical path, not the
      // legacy one — this is the "admin uploads under the admin
      // prefix but readers reconstruct under the submitter prefix"
      // defect the audit caught.
      expect(mockVerifyBlobExists.mock.calls[0][1]).toBe(canonicalBlobPath);
      expect(mockVerifyBlobExists.mock.calls[0][1]).not.toBe(legacyBlobPath);
    });

    test('canonical intent path is absent → falls back to legacy derivation', async () => {
      // The intent row points at a canonical blobPath that R2 returns
      // 404 on (e.g. the intent was confirmed but the bytes were never
      // PUT — exactly the transient-upload failure BLOB_GONE was
      // originally written to detect). The dual-reader must surface
      // the legacy `${submitterId}/${ulid}.${ext}` derivation as the
      // next candidate and mint the SAS URL from there if R2 confirms.
      const photoUlid = '01HCANONICALGONE01';
      const canonicalBlobPath = `${ADMIN_ID}/${photoUlid}.jpg`; // canonical says bytes are here
      const legacyBlobPath = `${SUBMITTER_ID}/${photoUlid}.jpg`; // bytes actually live here
      const prisma = buildPrismaMock({
        dprs: { 'dpr-1': seedDpr({ id: 'dpr-1' }) },
        photosByDprId: {
          'dpr-1': [seedPhoto({ id: 'photo-1', dprId: 'dpr-1', ulid: photoUlid })],
        },
        intentsByUlid: {
          [photoUlid]: {
            employeeId: ADMIN_ID,
            container: 'dpr-photos',
            blobPath: canonicalBlobPath,
            contentType: 'image/jpeg',
            sizeBytes: 4096,
            status: 'CONFIRMED',
          },
        },
      });
      const app = buildApp({ prisma });

      mockVerifyBlobExists.mockImplementation(async (_container, blobName) => {
        if (blobName === canonicalBlobPath) return { outcome: 'absent', exists: false, reason: 'NOT_FOUND_404' };
        if (blobName === legacyBlobPath) return { outcome: 'present', exists: true };
        return { outcome: 'absent', exists: false, reason: 'NOT_FOUND_404' };
      });

      const res = await request(app)
        .patch('/api/dpr/dpr-1/photos/photo-1')
        .set('Authorization', `Bearer ${authHeader(ADMIN_ID, true)}`)
        .send({
          uploadIntentUlid: photoUlid,
          blobPath: canonicalBlobPath,
          filename: 'rep.jpg',
          contentType: 'image/jpeg',
          sizeBytes: 4096,
        });

      expect(res.status).toBe(200);
      expect(res.body.readUrl).toBe(`https://r2.example/${encodeURIComponent(legacyBlobPath)}`);
      // Canonical was tried first, then legacy. The order matters.
      expect(mockVerifyBlobExists.mock.calls.map((c) => c[1])).toEqual([
        canonicalBlobPath,
        legacyBlobPath,
      ]);
    });

    test('both candidates absent → readUrl: null (genuine BLOB_GONE)', async () => {
      const photoUlid = '01HBOTHBLOBGONE1';
      const canonicalBlobPath = `${ADMIN_ID}/${photoUlid}.jpg`;
      const legacyBlobPath = `${SUBMITTER_ID}/${photoUlid}.jpg`;
      const prisma = buildPrismaMock({
        dprs: { 'dpr-1': seedDpr({ id: 'dpr-1' }) },
        photosByDprId: {
          'dpr-1': [seedPhoto({ id: 'photo-1', dprId: 'dpr-1', ulid: photoUlid })],
        },
        intentsByUlid: {
          [photoUlid]: {
            employeeId: ADMIN_ID,
            container: 'dpr-photos',
            blobPath: canonicalBlobPath,
            contentType: 'image/jpeg',
            sizeBytes: 4096,
            status: 'CONFIRMED',
          },
        },
      });
      const app = buildApp({ prisma });

      mockVerifyBlobExists.mockResolvedValue({ outcome: 'absent', exists: false, reason: 'NOT_FOUND_404' });

      const res = await request(app)
        .patch('/api/dpr/dpr-1/photos/photo-1')
        .set('Authorization', `Bearer ${authHeader(ADMIN_ID, true)}`)
        .send({
          uploadIntentUlid: photoUlid,
          blobPath: canonicalBlobPath,
          filename: 'rep.jpg',
          contentType: 'image/jpeg',
          sizeBytes: 4096,
        });

      expect(res.status).toBe(200);
      expect(res.body.readUrl).toBeNull();
      // Both candidates attempted.
      expect(mockVerifyBlobExists.mock.calls.map((c) => c[1])).toEqual(
        expect.arrayContaining([canonicalBlobPath, legacyBlobPath]),
      );
    });
  });

  describe('GET /api/dpr/:id — detail endpoint dual-reader', () => {
    test('admin-repaired photo: detail GET resolves canonical path after a fresh fetch', async () => {
      // The audit acceptance: "fresh list/detail read" after the repair
      // must also resolve the canonical path. This is the list/detail
      // counterpart to the repair test above.
      const photoUlid = '01HDETAILADMIN001';
      const canonicalBlobPath = `${ADMIN_ID}/${photoUlid}.jpg`;
      const legacyBlobPath = `${SUBMITTER_ID}/${photoUlid}.jpg`;
      const prisma = buildPrismaMock({
        dprs: { 'dpr-1': seedDpr({ id: 'dpr-1', status: 'DRAFT' }) },
        photosByDprId: {
          'dpr-1': [seedPhoto({ id: 'photo-1', dprId: 'dpr-1', ulid: photoUlid })],
        },
        intentsByUlid: {
          [photoUlid]: {
            employeeId: ADMIN_ID,
            container: 'dpr-photos',
            blobPath: canonicalBlobPath,
            contentType: 'image/jpeg',
            sizeBytes: 4096,
            status: 'CONFIRMED',
          },
        },
      });
      const app = buildApp({ prisma });

      mockVerifyBlobExists.mockImplementation(async (_container, blobName) => {
        if (blobName === canonicalBlobPath) return { outcome: 'present', exists: true };
        return { outcome: 'absent', exists: false, reason: 'NOT_FOUND_404' };
      });

      const res = await request(app)
        .get('/api/dpr/dpr-1')
        .set('Authorization', `Bearer ${authHeader(SUBMITTER_ID)}`);

      expect(res.status).toBe(200);
      const photo = res.body.photos.find((p) => p.id === 'photo-1');
      expect(photo.readUrl).toBe(`https://r2.example/${encodeURIComponent(canonicalBlobPath)}`);
      // Canonical was tried first.
      expect(mockVerifyBlobExists.mock.calls[0][1]).toBe(canonicalBlobPath);
    });

    test('pre-migration photo (no intent row): detail GET resolves via legacy derivation', async () => {
      const photoUlid = '01HPREMIGDETAIL01';
      const legacyBlobPath = `${SUBMITTER_ID}/${photoUlid}.jpg`;
      const prisma = buildPrismaMock({
        dprs: { 'dpr-1': seedDpr({ id: 'dpr-1', status: 'DRAFT' }) },
        photosByDprId: {
          'dpr-1': [seedPhoto({ id: 'photo-1', dprId: 'dpr-1', ulid: photoUlid })],
        },
        intentsByUlid: {},
      });
      const app = buildApp({ prisma });

      mockVerifyBlobExists.mockImplementation(async (_container, blobName) => {
        if (blobName === legacyBlobPath) return { outcome: 'present', exists: true };
        return { outcome: 'absent', exists: false, reason: 'NOT_FOUND_404' };
      });

      const res = await request(app)
        .get('/api/dpr/dpr-1')
        .set('Authorization', `Bearer ${authHeader(SUBMITTER_ID)}`);

      expect(res.status).toBe(200);
      const photo = res.body.photos.find((p) => p.id === 'photo-1');
      expect(photo.readUrl).toBe(`https://r2.example/${encodeURIComponent(legacyBlobPath)}`);
    });
  });

  describe('resolver contract (direct)', () => {
    test('resolvePhotoBlobAddress returns canonical first when both would resolve', async () => {
      mockVerifyBlobExists.mockResolvedValue({ outcome: 'present', exists: true });
      const result = await resolvePhotoBlobAddress({
        prisma: {
          uploadIntent: {
            findFirst: async () => ({ blobPath: 'canonical/path.jpg' }),
          },
        },
        photo: { ulid: 'U1', container: 'dpr-photos', contentType: 'image/jpeg' },
        dpr: { submittedById: 'submitter' },
      });
      expect(result.blobName).toBe('canonical/path.jpg');
      expect(result.source).toBe('canonical');
    });

    test('resolvePhotoBlobAddress falls back to legacy when canonical is absent', async () => {
      mockVerifyBlobExists.mockImplementation(async (_c, blobName) => {
        if (blobName === 'canonical/missing.jpg') return { outcome: 'absent', exists: false, reason: 'NOT_FOUND_404' };
        if (blobName === 'submitter/U1.jpg') return { outcome: 'present', exists: true };
        return { outcome: 'absent', exists: false, reason: 'NOT_FOUND_404' };
      });
      const result = await resolvePhotoBlobAddress({
        prisma: {
          uploadIntent: {
            findFirst: async () => ({ blobPath: 'canonical/missing.jpg' }),
          },
        },
        photo: { ulid: 'U1', container: 'dpr-photos', contentType: 'image/jpeg' },
        dpr: { submittedById: 'submitter' },
      });
      expect(result.blobName).toBe('submitter/U1.jpg');
      expect(result.source).toBe('legacy');
    });

    test('resolvePhotoBlobAddress returns null when both candidates are absent', async () => {
      mockVerifyBlobExists.mockResolvedValue({ outcome: 'absent', exists: false, reason: 'NOT_FOUND_404' });
      const result = await resolvePhotoBlobAddress({
        prisma: {
          uploadIntent: {
            findFirst: async () => ({ blobPath: 'canonical/gone.jpg' }),
          },
        },
        photo: { ulid: 'U1', container: 'dpr-photos', contentType: 'image/jpeg' },
        dpr: { submittedById: 'submitter' },
      });
      expect(result.blobName).toBeNull();
      expect(result.source).toBe('absent');
    });

    test('resolvePhotoBlobAddress: no prisma intent table → uses legacy only', async () => {
      mockVerifyBlobExists.mockResolvedValue({ outcome: 'present', exists: true });
      const result = await resolvePhotoBlobAddress({
        prisma: undefined, // legacy unit-suite mock: no uploadIntent table
        photo: { ulid: 'U1', container: 'dpr-photos', contentType: 'image/jpeg' },
        dpr: { submittedById: 'submitter' },
      });
      expect(result.blobName).toBe('submitter/U1.jpg');
      expect(result.source).toBe('legacy');
    });
  });
});