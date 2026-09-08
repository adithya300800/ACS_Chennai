// R35: Project Reports — backend route tests.
//
// The route module lives at backend/src/routes/projectAttachments.js
// and is mounted at /api/projects/:projectId/attachments in index.js.
// Four routes:
//   GET    /                                   list (active only; ?type=)
//   POST   /                                   create row
//   GET    /:attachmentId/read-sas              mint a 1h read SAS
//   DELETE /:attachmentId                      soft-delete via deletedAt
//
// Auth model pinned by these tests:
//   - requireAuth on every route (401/403 with no/invalid token)
//   - requireProjectScope: 404 PROJECT_NOT_FOUND when the parent
//     projectId (UUID) doesn't exist or is archived. R35.1 broadened the
//     middleware to accept a free-text projectName too — names that
//     don't yet exist as Project rows are auto-created (isActive=true,
//     minimal fields). The resolved UUID is rewritten onto req.params so
//     the downstream handlers stay UUID-only.
//   - DELETE additionally requires (admin OR uploader). Non-admin /
//     non-uploader → 403 NOT_ATTACHMENT_OWNER.
//
// Coverage matrix:
//   1. GET list as auth user → 200, empty
//   2. GET with ?type=WEEKLY_REPORT → 200, filter honored
//   3. GET excludes deletedAt != null rows (soft-delete is a hide)
//   4. POST creates row, auto-stamps uploadedById = req.employeeId
//   5. POST rejects contentType outside allowlist (400 VALIDATION_ERROR)
//   6. POST rejects sizeBytes > 25 MB (413 REPORT_TOO_LARGE)
//   7. POST on missing UUID projectId → 404 PROJECT_NOT_FOUND
//   8. GET read-sas mints a 1h SAS URL on the dpr-documents container
//   9. DELETE as uploader soft-deletes (sets deletedAt)
//  10. DELETE as admin (different uploader) → 200, soft-deletes
//  11. DELETE as different non-admin employee → 403 NOT_ATTACHMENT_OWNER
//  12. DELETE on already-deleted row → 404 ATTACHMENT_NOT_FOUND (idempotent)
//
// R35.1 additions:
//  13. POST with name param for an EXISTING project name → uses existing UUID
//  14. POST with name param for a NEW name → auto-creates Project row +
//       inserts attachment against the new UUID
//  15. POST with name param + casing mismatch → resolves via case-insensitive match
//  16. GET with name param for a NEW name → 200 + empty list (no auto-create
//       on read; only POST writes materialise a new project row)

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';

// Stub blobStorage before the route module is required. The route uses
// generateReadSASUrl + READ_URL_TTL_SECONDS from blobStorage.js; tests
// don't want to hit R2. jest.mock would work but a plain module-export
// override keeps the test file readable without a __mocks__ folder.
jest.mock('../src/lib/blobStorage', () => ({
  generateReadSASUrl: jest.fn(async () => ({ sasUrl: 'https://r2.example/read?sig=stub' })),
  READ_URL_TTL_SECONDS: 3600,
  // Unused by these tests but referenced by sibling modules; keep them
  // harmless stubs so importing the route file doesn't crash.
  generateUploadSASUrl: jest.fn(),
  generateULID: jest.fn(() => '01J0AAAAAAAAAAAAAAAAAAAA'),
  verifyBlobExists: jest.fn(),
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

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
require('express-async-errors');

const { generateReadSASUrl, READ_URL_TTL_SECONDS } = require('../src/lib/blobStorage');
const projectAttachmentRouter = require('../src/routes/projectAttachments');

// All four IDs are RFC4122 v4 so the route's isValidUuid regex accepts
// them. Same UUID-prefix scheme as the drawings-create-auth test (4xxx
// admin, 5xxx employee, 8xxx project, 9xxx attachment).
const ADMIN_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID  = '55555555-5555-4555-8555-555555555555';
const OTHER_USER_ID = '66666666-6666-4666-8666-666666666666';
const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ATTACHMENT_ID = '99999999-9999-4999-8999-999999999999';
const ATTACHMENT_ID_2 = '99999999-9999-4999-8999-999999999998';
// R35.1: a discovered project's free-text name + the UUID the
// auto-create path will materialise. The two stay linked so the mock
// can assert create was called with the right payload.
const DISCOVERED_NAME = 'Brand New Site Visit';
const NEW_PROJECT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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

// Build a fresh app + in-memory Prisma for each test so state can't leak.
// The route calls prisma.project.findUnique (UUID lookup), findFirst
// (case-insensitive name lookup, R35.1), create (auto-create path,
// R35.1), and prisma.projectAttachment.{findMany, create, findUnique,
// update}. Each test seeds the fixtures it needs.
function buildApp() {
  const app = express();
  app.use(express.json());
  const attachmentRows = new Map();
  const projectRows = new Map();
  // Pre-seed the two test projects so the case-sensitive lookup works
  // out of the box. The DISCOVERED_NAME row is what name-based requests
  // resolve to via the case-insensitive match; tests that exercise
  // auto-create should NOT pre-seed a matching name.
  projectRows.set(PROJECT_ID, { id: PROJECT_ID, name: 'Registered Test', isActive: true });
  let createdSeq = 0;
  let createdProjectSeq = 0;
  const prisma = {
    project: {
      findUnique: jest.fn(async ({ where }) => {
        if (where.id) return projectRows.get(where.id) || null;
        if (where.name) return projectRows.get(where.name) || null;
        return null; // unknown / archived → 404
      }),
      findFirst: jest.fn(async ({ where }) => {
        if (!where?.name?.equals) return null;
        const needle = where.name.equals;
        for (const row of projectRows.values()) {
          if (row.name.toLowerCase() === needle.toLowerCase()) return row;
        }
        return null;
      }),
      create: jest.fn(async ({ data }) => {
        createdProjectSeq += 1;
        // P2002 collision simulation: only the "second" auto-create call
        // with the same name actually inserts; the first one a separate
        // test (race-condition coverage) is exercised separately.
        const id = data.id || `new-${createdProjectSeq}`;
        const row = {
          id,
          name: data.name,
          isActive: data.isActive ?? true,
          createdById: data.createdById || null,
        };
        projectRows.set(id, row);
        // Also index by name so subsequent findUnique(name=...) calls
        // in the same test resolve to the new row.
        projectRows.set(row.name, row);
        return row;
      }),
    },
    projectAttachment: {
      findMany: jest.fn(async ({ where }) => {
        const all = Array.from(attachmentRows.values());
        return all.filter((row) => {
          if (where.projectId && row.projectId !== where.projectId) return false;
          if (where.deletedAt === null && row.deletedAt) return false;
          if (where.type && row.type !== where.type) return false;
          return true;
        }).slice(0, where.take || 100);
      }),
      create: jest.fn(async ({ data }) => {
        createdSeq += 1;
        const id = data.id || `att-${createdSeq}`;
        const row = {
          id,
          projectId: data.projectId,
          type: data.type,
          title: data.title,
          filename: data.filename,
          contentType: data.contentType,
          sizeBytes: data.sizeBytes,
          blobPath: data.blobPath,
          uploadedById: data.uploadedById,
          uploadedAt: new Date(),
          deletedAt: null,
        };
        attachmentRows.set(id, row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }) => {
        if (where.id) return attachmentRows.get(where.id) || null;
        return null;
      }),
      update: jest.fn(async ({ where, data }) => {
        const row = attachmentRows.get(where.id);
        if (!row) throw Object.assign(new Error('not found'), { code: 'P2025' });
        if (data.deletedAt) row.deletedAt = data.deletedAt;
        return row;
      }),
    },
  };
  app.set('prisma', prisma);
  app.use('/api/projects/:projectId/attachments', projectAttachmentRouter);
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({
      error: err.message || 'INTERNAL_ERROR',
      code: err.code || 'INTERNAL',
    });
  });
  return { app, prisma, attachmentRows, projectRows };
}

const baseBody = {
  type: 'WEEKLY_REPORT',
  filename: 'weekly-2026-w36.pdf',
  contentType: 'application/pdf',
  sizeBytes: 1024,
  blobPath: 'employee-1/01J0AAAAAAAAAAAAAAAAAAAA.pdf',
};

describe('R35 — Project Reports: GET /api/projects/:projectId/attachments', () => {
  it('1. GET empty list returns { attachments: [] }', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/attachments`)
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    // [DR-022] Empty list now includes `nextCursor: null` so the SPA can
    // blindly read `res.body.nextCursor` and walk until null without
    // special-casing the first page.
    expect(res.body).toEqual({ attachments: [], nextCursor: null });
  });

  it('2. GET with ?type=WEEKLY_REPORT honors the filter', async () => {
    const { app, attachmentRows } = buildApp();
    attachmentRows.set(ATTACHMENT_ID, {
      id: ATTACHMENT_ID, projectId: PROJECT_ID, type: 'WEEKLY_REPORT',
      title: 'W36', filename: 'w.pdf', contentType: 'application/pdf',
      sizeBytes: 100, blobPath: 'x/y.pdf', uploadedById: USER_ID,
      uploadedAt: new Date(), deletedAt: null,
    });
    attachmentRows.set(ATTACHMENT_ID_2, {
      id: ATTACHMENT_ID_2, projectId: PROJECT_ID, type: 'MONTHLY_REPORT',
      title: 'Aug', filename: 'm.pdf', contentType: 'application/pdf',
      sizeBytes: 200, blobPath: 'x/z.pdf', uploadedById: USER_ID,
      uploadedAt: new Date(), deletedAt: null,
    });
    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/attachments?type=WEEKLY_REPORT`)
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    expect(res.body.attachments).toHaveLength(1);
    expect(res.body.attachments[0].type).toBe('WEEKLY_REPORT');
  });

  it('3. GET excludes soft-deleted rows', async () => {
    const { app, attachmentRows } = buildApp();
    attachmentRows.set(ATTACHMENT_ID, {
      id: ATTACHMENT_ID, projectId: PROJECT_ID, type: 'WEEKLY_REPORT',
      title: 'W36', filename: 'w.pdf', contentType: 'application/pdf',
      sizeBytes: 100, blobPath: 'x/y.pdf', uploadedById: USER_ID,
      uploadedAt: new Date(), deletedAt: null,
    });
    attachmentRows.set(ATTACHMENT_ID_2, {
      id: ATTACHMENT_ID_2, projectId: PROJECT_ID, type: 'WEEKLY_REPORT',
      title: 'old', filename: 'old.pdf', contentType: 'application/pdf',
      sizeBytes: 100, blobPath: 'x/old.pdf', uploadedById: USER_ID,
      uploadedAt: new Date(), deletedAt: new Date('2026-08-01'),
    });
    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/attachments`)
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    expect(res.body.attachments).toHaveLength(1);
    expect(res.body.attachments[0].id).toBe(ATTACHMENT_ID);
  });

  it('4. GET on missing project → 404 PROJECT_NOT_FOUND', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/projects/cccccccc-cccc-4ccc-8ccc-cccccccccccc/attachments')
      .set('Authorization', userJwt());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PROJECT_NOT_FOUND');
  });

  it('5. GET rejects unknown ?type → 400 VALIDATION_ERROR', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/attachments?type=DAILY_RANT`)
      .set('Authorization', userJwt());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TYPE');
  });
});

describe('R35 — Project Reports: POST /api/projects/:projectId/attachments', () => {
  it('6. POST creates row, auto-stamps uploadedById = req.employeeId', async () => {
    const { app, prisma } = buildApp();
    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/attachments`)
      .set('Authorization', userJwt())
      .send(baseBody);
    expect(res.status).toBe(201);
    expect(res.body.uploadedById).toBe(USER_ID);
    expect(res.body.type).toBe('WEEKLY_REPORT');
    expect(res.body.filename).toBe('weekly-2026-w36.pdf');
    expect(prisma.projectAttachment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ uploadedById: USER_ID }),
      }),
    );
  });

  it('7. POST rejects contentType outside allowlist → 400 INVALID_CONTENT_TYPE', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/attachments`)
      .set('Authorization', userJwt())
      .send({ ...baseBody, contentType: 'application/x-evil' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CONTENT_TYPE');
  });

  it('8. POST rejects sizeBytes > 25 MB → 413 REPORT_TOO_LARGE', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/attachments`)
      .set('Authorization', userJwt())
      .send({ ...baseBody, sizeBytes: 26 * 1024 * 1024 });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('REPORT_TOO_LARGE');
  });

  it('9. POST on missing project → 404 PROJECT_NOT_FOUND', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/projects/cccccccc-cccc-4ccc-8ccc-cccccccccccc/attachments')
      .set('Authorization', userJwt())
      .send(baseBody);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PROJECT_NOT_FOUND');
  });
});

describe('R35 — Project Reports: GET /:attachmentId/read-sas', () => {
  it('10. GET read-sas mints a 1h SAS URL on the dpr-documents container', async () => {
    const { app, attachmentRows } = buildApp();
    attachmentRows.set(ATTACHMENT_ID, {
      id: ATTACHMENT_ID, projectId: PROJECT_ID,
      type: 'WEEKLY_REPORT', title: 'W36',
      filename: 'w.pdf', contentType: 'application/pdf',
      sizeBytes: 100, blobPath: 'employee-1/uuid.pdf',
      uploadedById: USER_ID, uploadedAt: new Date(), deletedAt: null,
    });
    generateReadSASUrl.mockClear();
    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/attachments/${ATTACHMENT_ID}/read-sas`)
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    expect(res.body.sasUrl).toMatch(/^https:\/\/r2\.example/);
    expect(res.body.expiresIn).toBe(READ_URL_TTL_SECONDS);
    expect(generateReadSASUrl).toHaveBeenCalledWith('dpr-documents', 'employee-1/uuid.pdf');
  });

  it('11. GET read-sas on missing attachment → 404 ATTACHMENT_NOT_FOUND', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}/attachments/${ATTACHMENT_ID}/read-sas`)
      .set('Authorization', userJwt());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ATTACHMENT_NOT_FOUND');
  });
});

describe('R35 — Project Reports: DELETE /:attachmentId', () => {
  it('12. DELETE as uploader soft-deletes (sets deletedAt)', async () => {
    const { app, attachmentRows, prisma } = buildApp();
    attachmentRows.set(ATTACHMENT_ID, {
      id: ATTACHMENT_ID, projectId: PROJECT_ID,
      type: 'WEEKLY_REPORT', title: 'W36',
      filename: 'w.pdf', contentType: 'application/pdf',
      sizeBytes: 100, blobPath: 'employee-1/uuid.pdf',
      uploadedById: USER_ID, uploadedAt: new Date(), deletedAt: null,
    });
    const res = await request(app)
      .delete(`/api/projects/${PROJECT_ID}/attachments/${ATTACHMENT_ID}`)
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    expect(prisma.projectAttachment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ATTACHMENT_ID },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
    // Subsequent GET hides the row (already verified by test #3, but the
    // soft-delete side-effect is what this test pins).
    expect(attachmentRows.get(ATTACHMENT_ID).deletedAt).toBeInstanceOf(Date);
  });

  it('13. DELETE as admin (different uploader) → 200, soft-deletes', async () => {
    const { app, attachmentRows } = buildApp();
    attachmentRows.set(ATTACHMENT_ID, {
      id: ATTACHMENT_ID, projectId: PROJECT_ID,
      type: 'WEEKLY_REPORT', title: 'W36',
      filename: 'w.pdf', contentType: 'application/pdf',
      sizeBytes: 100, blobPath: 'employee-1/uuid.pdf',
      uploadedById: USER_ID, uploadedAt: new Date(), deletedAt: null,
    });
    const res = await request(app)
      .delete(`/api/projects/${PROJECT_ID}/attachments/${ATTACHMENT_ID}`)
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    expect(attachmentRows.get(ATTACHMENT_ID).deletedAt).toBeInstanceOf(Date);
  });

  it('14. DELETE as different non-admin → 403 NOT_ATTACHMENT_OWNER', async () => {
    const { app, attachmentRows } = buildApp();
    attachmentRows.set(ATTACHMENT_ID, {
      id: ATTACHMENT_ID, projectId: PROJECT_ID,
      type: 'WEEKLY_REPORT', title: 'W36',
      filename: 'w.pdf', contentType: 'application/pdf',
      sizeBytes: 100, blobPath: 'employee-1/uuid.pdf',
      uploadedById: USER_ID, uploadedAt: new Date(), deletedAt: null,
    });
    const res = await request(app)
      .delete(`/api/projects/${PROJECT_ID}/attachments/${ATTACHMENT_ID}`)
      .set('Authorization', userJwt(OTHER_USER_ID));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_ATTACHMENT_OWNER');
  });

  it('15. DELETE on already-deleted row → 404 ATTACHMENT_NOT_FOUND (idempotent 404)', async () => {
    const { app, attachmentRows } = buildApp();
    attachmentRows.set(ATTACHMENT_ID, {
      id: ATTACHMENT_ID, projectId: PROJECT_ID,
      type: 'WEEKLY_REPORT', title: 'W36',
      filename: 'w.pdf', contentType: 'application/pdf',
      sizeBytes: 100, blobPath: 'employee-1/uuid.pdf',
      uploadedById: USER_ID, uploadedAt: new Date(),
      deletedAt: new Date('2026-09-01'),
    });
    const res = await request(app)
      .delete(`/api/projects/${PROJECT_ID}/attachments/${ATTACHMENT_ID}`)
      .set('Authorization', adminJwt());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ATTACHMENT_NOT_FOUND');
  });
});

describe('R35.1 — Auto-create project on free-text name in URL', () => {
  it('16. POST with name of an EXISTING project → resolves to existing UUID, no create call', async () => {
    const { app, prisma, projectRows } = buildApp();
    // Pre-seed a registered project under the name we're about to use.
    projectRows.set('seeded-name-id', { id: 'seeded-name-id', name: 'Seeded Site', isActive: true });
    const res = await request(app)
      .post('/api/projects/Seeded%20Site/attachments')
      .set('Authorization', userJwt())
      .send(baseBody);
    expect(res.status).toBe(201);
    expect(res.body.projectId).toBe('seeded-name-id');
    expect(prisma.project.create).not.toHaveBeenCalled();
    expect(prisma.projectAttachment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ projectId: 'seeded-name-id' }) }),
    );
  });

  it('17. POST with NEW name → auto-creates Project row, attachment uses new UUID', async () => {
    const { app, prisma } = buildApp();
    const res = await request(app)
      .post(`/api/projects/${encodeURIComponent(DISCOVERED_NAME)}/attachments`)
      .set('Authorization', userJwt())
      .send(baseBody);
    expect(res.status).toBe(201);
    expect(prisma.project.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: DISCOVERED_NAME,
          isActive: true,
          createdById: USER_ID,
        }),
      }),
    );
    // The attachment row must reference the new UUID, not the raw name.
    const createCall = prisma.projectAttachment.create.mock.calls[0][0];
    expect(createCall.data.projectId).toMatch(/^new-\d+$/);
    // The serialized response should include the resolved UUID too.
    expect(res.body.projectId).toMatch(/^new-\d+$/);
  });

  it('18. POST with name + case mismatch → resolves via case-insensitive lookup', async () => {
    const { app, prisma } = buildApp();
    // Pre-seed a project with title-cased name; user posts with all-lowercase.
    const built = buildApp();
    built.projectRows.set('case-id', { id: 'case-id', name: 'T-Nagar Site', isActive: true });
    const res = await request(built.app)
      .post('/api/projects/t-nagar%20site/attachments')
      .set('Authorization', userJwt())
      .send(baseBody);
    expect(res.status).toBe(201);
    expect(res.body.projectId).toBe('case-id');
    expect(built.prisma.project.create).not.toHaveBeenCalled();
  });

  it('19. POST with URL-encoded name with %20 / + characters → trimmed and resolved', async () => {
    // Sanity-check that the decodeURIComponent step doesn't crash on
    // an encoded space, plus, or ampersand. (URLParameters in the SPA
    // use encodeURIComponent before interpolation.)
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/projects/Lots%20Of%20%26%20Symbols/attachments')
      .set('Authorization', userJwt())
      .send(baseBody);
    expect(res.status).toBe(201);
    expect(res.body.projectId).toMatch(/^new-\d+$/);
  });

  it('20. POST with name → still rejects sizeBytes > 25 MB', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post(`/api/projects/${encodeURIComponent(DISCOVERED_NAME)}/attachments`)
      .set('Authorization', userJwt())
      .send({ ...baseBody, sizeBytes: 26 * 1024 * 1024 });
    // Project auto-creates FIRST (the middleware runs before the size
    // check), then the size validator catches it. This is intentional —
    // better to leave a discovered project row than to surface a 413 to
    // the user without telling them why.
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('REPORT_TOO_LARGE');
  });

  it('21. GET with NEW name → 200 + empty list (no auto-create on read)', async () => {
    const { app, prisma } = buildApp();
    const res = await request(app)
      .get(`/api/projects/${encodeURIComponent(DISCOVERED_NAME)}/attachments`)
      .set('Authorization', userJwt());
    expect(res.status).toBe(200);
    // [DR-022] Empty list includes nextCursor: null.
    expect(res.body).toEqual({ attachments: [], nextCursor: null });
    expect(prisma.project.create).not.toHaveBeenCalled();
  });

  it('22. POST with name that resolves to an ARCHIVED project → 404 PROJECT_NOT_FOUND', async () => {
    const built = buildApp();
    built.projectRows.set('arch-id', { id: 'arch-id', name: 'Dead Project', isActive: false });
    const res = await request(built.app)
      .post('/api/projects/Dead%20Project/attachments')
      .set('Authorization', userJwt())
      .send(baseBody);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PROJECT_NOT_FOUND');
  });
});
