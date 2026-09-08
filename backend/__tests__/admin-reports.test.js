// R36: Admin "Project Reports" — GET /api/admin/reports.
//
// Mounted at /api/admin/reports in backend/src/index.js. Admin-only
// cross-project, cross-employee list of ProjectAttachment rows.
// Mirrors the per-project surface in backend/__tests__/project-attachments
// .test.js so the contract stays tight (the admin view is just the same
// rows minus a projectId prefix, plus joins).
//
// Coverage matrix:
//   Auth gates
//     1. 401 without token
//     2. 403 for non-admin employee
//   Filters
//     3. Empty list when no attachments exist
//     4. ?type=WEEKLY_REPORT filter honored (returns only WEEKLY rows)
//     5. ?uploadedById filter honored
//     6. ?from / ?to date range honored (inclusive to end-of-day UTC)
//     7. ?projectId=<uuid> scope
//     8. ?projectId=<free-text-name> resolves case-insensitive
//     9. ?projectId=<unknown-name> returns empty list, total: 0 (R35.1 UX)
//    10. Soft-deleted rows excluded (deletedAt != null)
//   Pagination
//    11. ?limit=2 + ?cursor returns next page; cursor is base64url JSON
//    12. Cursor stability across rows with identical uploadedAt
//   Misc
//    13. Response includes joined project.name + uploadedBy.name
//    14. Order: uploadedAt desc, id desc
//    15. Bad ?type → 400 INVALID_TYPE
//    16. Bad ?from / ?to → 400 VALIDATION_ERROR
//    17. Bad ?cursor → 400 INVALID_CURSOR

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
require('express-async-errors');

const adminReportsRouter = require('../src/routes/adminReports');

const ADMIN_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_USER_ID = '66666666-6666-4666-8666-666666666666';
const PROJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ATT_A1 = '99999999-9999-4999-8999-999999999991';
const ATT_A2 = '99999999-9999-4999-8999-999999999992';
const ATT_A3 = '99999999-9999-4999-8999-999999999993';
const ATT_B1 = '99999999-9999-4999-8999-999999999994';

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

// Build a fresh app + in-memory Prisma for each test. Mock surfaces the
// route actually calls:
//   - prisma.project.findUnique (UUID lookup) + prisma.project.findFirst
//     (case-insensitive name lookup, mirrors the R35.1 helper shape).
//   - prisma.projectAttachment.findMany + prisma.projectAttachment.count
//     with filter logic in-memory.
//   - prisma.employee.findUnique (requireFreshAdmin gate).
function buildApp({ adminIsAdmin = true, userIsAdmin = false, employeeExists = true } = {}) {
  const app = express();
  app.use(express.json());

  const attachmentRows = new Map();
  const projectRows = new Map();
  // Pre-seed two projects.
  projectRows.set(PROJECT_A, { id: PROJECT_A, name: 'Alpha Site', code: 'ALPHA', isActive: true });
  projectRows.set(PROJECT_B, { id: PROJECT_B, name: 'Bravo Site', code: 'BRAVO', isActive: true });

  const prisma = {
    project: {
      findUnique: jest.fn(async ({ where }) => {
        if (!where) return null;
        if (where.id) {
          const row = projectRows.get(where.id);
          if (!row) return null;
          return { id: row.id, isActive: row.isActive };
        }
        if (where.name) return projectRows.get(where.name) || null;
        return null;
      }),
      findFirst: jest.fn(async ({ where }) => {
        if (!where?.name?.equals) return null;
        const needle = String(where.name.equals).toLowerCase();
        for (const row of projectRows.values()) {
          if (typeof row.name === 'string' && row.name.toLowerCase() === needle) {
            return { id: row.id, isActive: row.isActive };
          }
        }
        return null;
      }),
    },
    projectAttachment: {
      findMany: jest.fn(async ({ where = {}, orderBy, take, include } = {}) => {
        let rows = Array.from(attachmentRows.values()).filter((r) => {
          if (where.deletedAt === null && r.deletedAt) return false;
          if (where.projectId && r.projectId !== where.projectId) return false;
          if (where.uploadedById && r.uploadedById !== where.uploadedById) return false;
          if (where.type && r.type !== where.type) return false;
          // [DR-012] Prisma's relational filter — when no projectId is
          // pinned the unscoped list adds `project: { isActive: true }`
          // so attachments for archived projects are excluded.
          if (where.project && typeof where.project === 'object') {
            const proj = projectRows.get(r.projectId);
            if (!proj) return false;
            if (where.project.isActive === true && !proj.isActive) return false;
            if (where.project.isActive === false && proj.isActive) return false;
          }
          if (where.uploadedAt) {
            const { gte, lte } = where.uploadedAt;
            const ts = r.uploadedAt instanceof Date ? r.uploadedAt.getTime() : new Date(r.uploadedAt).getTime();
            if (gte && ts < gte.getTime()) return false;
            if (lte && ts > lte.getTime()) return false;
          }
          // Keyset cursor predicate (Prisma OR-of-compared-tails form).
          // The route emits TWO branches for `(uploadedAt, id) DESC`:
          //   1. { uploadedAt: { lt: cursorTs } }            — strictly older rows
          //   2. { uploadedAt: cursorTs, id: { lt: id } }   — same ts, smaller id
          if (where.OR && Array.isArray(where.OR)) {
            const rowTs = r.uploadedAt instanceof Date ? r.uploadedAt.getTime() : new Date(r.uploadedAt).getTime();
            const matches = where.OR.some((branch) => {
              if (branch.uploadedAt?.lt) {
                const cursorTs = branch.uploadedAt.lt instanceof Date
                  ? branch.uploadedAt.lt.getTime()
                  : new Date(branch.uploadedAt.lt).getTime();
                return rowTs < cursorTs;
              }
              if (branch.uploadedAt && branch.id?.lt) {
                const cursorTs = branch.uploadedAt instanceof Date
                  ? branch.uploadedAt.getTime()
                  : new Date(branch.uploadedAt).getTime();
                return rowTs === cursorTs && r.id < branch.id.lt;
              }
              return false;
            });
            if (!matches) return false;
          }
          return true;
        });
        // Sort by uploadedAt desc, id desc. Stable order even on identical timestamps.
        rows.sort((a, b) => {
          const at = a.uploadedAt instanceof Date ? a.uploadedAt.getTime() : 0;
          const bt = b.uploadedAt instanceof Date ? b.uploadedAt.getTime() : 0;
          if (at !== bt) return bt - at;
          return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
        });
        if (typeof take === 'number') rows = rows.slice(0, take);
        if (include) {
          rows = rows.map((r) => ({
            ...r,
            project: include.project ? projectRows.get(r.projectId) || null : undefined,
            uploadedBy: include.uploadedBy ? {
              id: r.uploadedById,
              name: r.uploadedByName || `Employee ${r.uploadedById.slice(0, 4)}`,
              designation: r.uploadedByDesignation || null,
            } : undefined,
          }));
        }
        return rows;
      }),
      count: jest.fn(async ({ where = {} } = {}) => {
        return Array.from(attachmentRows.values()).filter((r) => {
          if (where.deletedAt === null && r.deletedAt) return false;
          if (where.projectId && r.projectId !== where.projectId) return false;
          if (where.uploadedById && r.uploadedById !== where.uploadedById) return false;
          if (where.type && r.type !== where.type) return false;
          // [DR-012] Same relational filter as findMany — see comment above.
          if (where.project && typeof where.project === 'object') {
            const proj = projectRows.get(r.projectId);
            if (!proj) return false;
            if (where.project.isActive === true && !proj.isActive) return false;
            if (where.project.isActive === false && proj.isActive) return false;
          }
          if (where.uploadedAt) {
            const { gte, lte } = where.uploadedAt;
            const ts = r.uploadedAt instanceof Date ? r.uploadedAt.getTime() : new Date(r.uploadedAt).getTime();
            if (gte && ts < gte.getTime()) return false;
            if (lte && ts > lte.getTime()) return false;
          }
          return true;
        }).length;
      }),
    },
    employee: {
      findUnique: jest.fn(async ({ where }) => {
        if (!employeeExists) return null;
        if (where.id === ADMIN_ID) return { id: ADMIN_ID, isAdmin: adminIsAdmin };
        if (where.id === USER_ID) return { id: USER_ID, isAdmin: userIsAdmin };
        if (where.id === OTHER_USER_ID) return { id: OTHER_USER_ID, isAdmin: false };
        return null;
      }),
    },
  };

  app.set('prisma', prisma);
  app.use('/api/admin/reports', adminReportsRouter);
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({
      error: err.message || 'INTERNAL_ERROR',
      code: err.code || 'INTERNAL',
    });
  });
  return { app, prisma, attachmentRows, projectRows };
}

// Helper to seed an attachment row with sensible defaults.
function seed({ id, projectId, type = 'WEEKLY_REPORT', uploadedById = USER_ID, uploadedAt = new Date('2026-09-01T10:00:00Z'), deletedAt = null, filename, title, uploadedByName, uploadedByDesignation }) {
  return {
    id, projectId, type,
    title: title ?? `${type} title`,
    filename: filename ?? `${type.toLowerCase()}.pdf`,
    contentType: 'application/pdf',
    sizeBytes: 1024,
    blobPath: `employee-1/${id}.pdf`,
    uploadedById, uploadedAt, deletedAt,
    uploadedByName: uploadedByName ?? 'Test User',
    uploadedByDesignation: uploadedByDesignation ?? null,
  };
}

describe('R36 — Admin Project Reports: auth gates', () => {
  it('1. 401 without token', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/admin/reports');
    expect(res.status).toBe(401);
  });

  it('2. 403 for non-admin employee', async () => {
    const { app } = buildApp({ userIsAdmin: false });
    const res = await request(app)
      .get('/api/admin/reports')
      .set('Authorization', userJwt());
    expect(res.status).toBe(403);
  });
});

describe('R36 — Admin Project Reports: filtering', () => {
  it('3. Empty list when no attachments exist', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/admin/reports')
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reports: [], nextCursor: null, total: 0 });
  });

  it('4. ?type=WEEKLY_REPORT filter honored', async () => {
    const { app, attachmentRows } = buildApp();
    attachmentRows.set(ATT_A1, seed({ id: ATT_A1, projectId: PROJECT_A, type: 'WEEKLY_REPORT' }));
    attachmentRows.set(ATT_A2, seed({ id: ATT_A2, projectId: PROJECT_A, type: 'MONTHLY_REPORT' }));
    const res = await request(app)
      .get('/api/admin/reports?type=WEEKLY_REPORT')
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    expect(res.body.reports).toHaveLength(1);
    expect(res.body.reports[0].type).toBe('WEEKLY_REPORT');
    expect(res.body.total).toBe(1);
  });

  it('5. ?uploadedById filter honored', async () => {
    const { app, attachmentRows } = buildApp();
    attachmentRows.set(ATT_A1, seed({ id: ATT_A1, projectId: PROJECT_A, uploadedById: USER_ID }));
    attachmentRows.set(ATT_A2, seed({ id: ATT_A2, projectId: PROJECT_A, uploadedById: OTHER_USER_ID }));
    const res = await request(app)
      .get(`/api/admin/reports?uploadedById=${USER_ID}`)
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    expect(res.body.reports).toHaveLength(1);
    expect(res.body.reports[0].uploadedById).toBe(USER_ID);
  });

  it('6. ?from / ?to date range honored (inclusive to end-of-day UTC)', async () => {
    const { app, attachmentRows } = buildApp();
    attachmentRows.set(ATT_A1, seed({ id: ATT_A1, projectId: PROJECT_A, uploadedAt: new Date('2026-09-05T10:00:00Z') }));
    attachmentRows.set(ATT_A2, seed({ id: ATT_A2, projectId: PROJECT_A, uploadedAt: new Date('2026-09-10T10:00:00Z') }));
    attachmentRows.set(ATT_A3, seed({ id: ATT_A3, projectId: PROJECT_A, uploadedAt: new Date('2026-09-20T10:00:00Z') }));
    const res = await request(app)
      .get('/api/admin/reports?from=2026-09-06&to=2026-09-15')
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    // ATT_A1 (Sep 5) is before 'from' (Sep 6 00:00 UTC) → excluded.
    // ATT_A2 (Sep 10) is in range → included.
    // ATT_A3 (Sep 20) is after 'to' (Sep 15 23:59:59 UTC) → excluded.
    expect(res.body.reports).toHaveLength(1);
    expect(res.body.reports[0].id).toBe(ATT_A2);
  });

  it('7. ?projectId=<uuid> scopes to one project', async () => {
    const { app, attachmentRows } = buildApp();
    attachmentRows.set(ATT_A1, seed({ id: ATT_A1, projectId: PROJECT_A }));
    attachmentRows.set(ATT_B1, seed({ id: ATT_B1, projectId: PROJECT_B }));
    const res = await request(app)
      .get(`/api/admin/reports?projectId=${PROJECT_A}`)
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    expect(res.body.reports).toHaveLength(1);
    expect(res.body.reports[0].projectId).toBe(PROJECT_A);
  });

  it('8. ?projectId=<free-text-name> resolves case-insensitive', async () => {
    const { app, attachmentRows } = buildApp();
    attachmentRows.set(ATT_A1, seed({ id: ATT_A1, projectId: PROJECT_A }));
    const res = await request(app)
      .get('/api/admin/reports?projectId=alpha%20site')
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    expect(res.body.reports).toHaveLength(1);
    expect(res.body.reports[0].projectId).toBe(PROJECT_A);
  });

  it('9. ?projectId=<unknown-name> returns empty list, total: 0 (R35.1 UX)', async () => {
    const { app, attachmentRows } = buildApp();
    attachmentRows.set(ATT_A1, seed({ id: ATT_A1, projectId: PROJECT_A }));
    const res = await request(app)
      .get('/api/admin/reports?projectId=Nowhere%20Site')
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reports: [], nextCursor: null, total: 0 });
  });

  it('10. Soft-deleted rows excluded', async () => {
    const { app, attachmentRows } = buildApp();
    attachmentRows.set(ATT_A1, seed({ id: ATT_A1, projectId: PROJECT_A, deletedAt: null }));
    attachmentRows.set(ATT_A2, seed({ id: ATT_A2, projectId: PROJECT_A, deletedAt: new Date('2026-09-01') }));
    const res = await request(app)
      .get('/api/admin/reports')
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    expect(res.body.reports).toHaveLength(1);
    expect(res.body.reports[0].id).toBe(ATT_A1);
  });
});

describe('R36 — Admin Project Reports: pagination', () => {
  it('11. ?limit=2 + ?cursor returns next page; cursor is base64url JSON', async () => {
    const { app, attachmentRows } = buildApp();
    // Seed 3 rows; paginate with limit=2.
    attachmentRows.set(ATT_A1, seed({ id: ATT_A1, projectId: PROJECT_A, uploadedAt: new Date('2026-09-07T10:00:00Z') }));
    attachmentRows.set(ATT_A2, seed({ id: ATT_A2, projectId: PROJECT_A, uploadedAt: new Date('2026-09-06T10:00:00Z') }));
    attachmentRows.set(ATT_A3, seed({ id: ATT_A3, projectId: PROJECT_A, uploadedAt: new Date('2026-09-05T10:00:00Z') }));

    const page1 = await request(app)
      .get('/api/admin/reports?limit=2')
      .set('Authorization', adminJwt());
    expect(page1.status).toBe(200);
    expect(page1.body.reports).toHaveLength(2);
    expect(page1.body.total).toBe(3);
    expect(typeof page1.body.nextCursor).toBe('string');
    // Cursor must be decodable base64url JSON { uploadedAt, id }.
    const decoded = JSON.parse(Buffer.from(page1.body.nextCursor, 'base64url').toString('utf8'));
    expect(decoded.id).toBe(ATT_A2);
    expect(typeof decoded.uploadedAt).toBe('string');

    const page2 = await request(app)
      .get(`/api/admin/reports?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
      .set('Authorization', adminJwt());
    expect(page2.status).toBe(200);
    expect(page2.body.reports).toHaveLength(1);
    expect(page2.body.reports[0].id).toBe(ATT_A3);
    expect(page2.body.nextCursor).toBeNull();
  });

  it('12. Cursor stability across rows with identical uploadedAt', async () => {
    const { app, attachmentRows } = buildApp();
    const sameTs = new Date('2026-09-07T10:00:00Z');
    attachmentRows.set(ATT_A1, seed({ id: ATT_A1, projectId: PROJECT_A, uploadedAt: sameTs }));
    attachmentRows.set(ATT_A2, seed({ id: ATT_A2, projectId: PROJECT_A, uploadedAt: sameTs }));
    attachmentRows.set(ATT_A3, seed({ id: ATT_A3, projectId: PROJECT_A, uploadedAt: sameTs }));
    // Same uploadedAt → tie-broken by id DESC. ATT_A3 (ends in 3) > ATT_A2 > ATT_A1.
    const page1 = await request(app)
      .get('/api/admin/reports?limit=2')
      .set('Authorization', adminJwt());
    expect(page1.body.reports.map((r) => r.id)).toEqual([ATT_A3, ATT_A2]);
    const page2 = await request(app)
      .get(`/api/admin/reports?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
      .set('Authorization', adminJwt());
    expect(page2.body.reports.map((r) => r.id)).toEqual([ATT_A1]);
    expect(page2.body.nextCursor).toBeNull();
  });
});

describe('R36 — Admin Project Reports: response shape', () => {
  it('13. Response includes joined project.name + uploadedBy.name', async () => {
    const { app, attachmentRows } = buildApp();
    attachmentRows.set(ATT_A1, seed({
      id: ATT_A1, projectId: PROJECT_A,
      uploadedByName: 'Priya Sharma',
      uploadedByDesignation: 'Site Engineer',
    }));
    const res = await request(app)
      .get('/api/admin/reports')
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    const row = res.body.reports[0];
    expect(row.project).toEqual({ id: PROJECT_A, name: 'Alpha Site', code: 'ALPHA' });
    expect(row.uploadedBy).toEqual({ id: USER_ID, name: 'Priya Sharma', designation: 'Site Engineer' });
  });

  it('14. Order: uploadedAt desc, id desc', async () => {
    const { app, attachmentRows } = buildApp();
    attachmentRows.set(ATT_A1, seed({ id: ATT_A1, projectId: PROJECT_A, uploadedAt: new Date('2026-09-05T10:00:00Z') }));
    attachmentRows.set(ATT_A2, seed({ id: ATT_A2, projectId: PROJECT_A, uploadedAt: new Date('2026-09-10T10:00:00Z') }));
    attachmentRows.set(ATT_A3, seed({ id: ATT_A3, projectId: PROJECT_A, uploadedAt: new Date('2026-09-07T10:00:00Z') }));
    const res = await request(app)
      .get('/api/admin/reports')
      .set('Authorization', adminJwt());
    expect(res.body.reports.map((r) => r.id)).toEqual([ATT_A2, ATT_A3, ATT_A1]);
  });
});

describe('R36 — Admin Project Reports: validation', () => {
  it('15. Bad ?type → 400 INVALID_TYPE', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/admin/reports?type=BOGUS')
      .set('Authorization', adminJwt());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TYPE');
  });

  it('16. Bad ?from / ?to → 400', async () => {
    const { app } = buildApp();
    const fromBad = await request(app)
      .get('/api/admin/reports?from=not-a-date')
      .set('Authorization', adminJwt());
    expect(fromBad.status).toBe(400);
    expect(fromBad.body.code).toBe('INVALID_FROM');
    const toBad = await request(app)
      .get('/api/admin/reports?to=2026-13-99')
      .set('Authorization', adminJwt());
    expect(toBad.status).toBe(400);
    expect(toBad.body.code).toBe('INVALID_TO');
    // from > to → INVALID_RANGE
    const range = await request(app)
      .get('/api/admin/reports?from=2026-09-15&to=2026-09-10')
      .set('Authorization', adminJwt());
    expect(range.status).toBe(400);
    expect(range.body.code).toBe('INVALID_RANGE');
  });

  it('17. Bad ?cursor → 400 INVALID_CURSOR', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/admin/reports?cursor=not-base64-at-all-!!')
      .set('Authorization', adminJwt());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CURSOR');
  });
});

// ─── DR-012 — Archive filter on unscoped reports list ─────────────────────
// Audit symptom: the admin dashboard listed a report for a project that
// had been archived (isActive=false), but Download returned 404 with
// "Linked project does not exist or is archived". The fix: the unscoped
// list now applies `project: { isActive: true }` so an archived project's
// attachments never surface in the admin reports registry.
describe('DR-012 — unscoped admin reports exclude archived-project attachments', () => {
  const ARCHIVED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const ARCHIVED_ATT = '99999999-9999-4999-8999-aaaaaaaaaaaa';

  function buildAppWithArchived() {
    const env = buildApp();
    // Add a third project that is archived (isActive=false), plus one
    // attachment against it. The seeded PROJECT_A + PROJECT_B remain
    // isActive=true so the regression-guard test can still see them.
    env.projectRows.set(ARCHIVED, {
      id: ARCHIVED,
      name: 'Archived Site',
      code: 'ARCH',
      isActive: false,
    });
    // Seed three active attachments on PROJECT_A and one on PROJECT_B
    // so the unscoped list has known-active rows to render — the
    // original buildApp() does not pre-seed attachments, so each
    // historical test calls seed() directly. For the DR-012 cases we
    // need a populated active set as the regression baseline.
    const ACTIVE_ATT_A1 = '99999999-9999-4999-8999-aaa111111111';
    const ACTIVE_ATT_A2 = '99999999-9999-4999-8999-aaa222222222';
    const ACTIVE_ATT_A3 = '99999999-9999-4999-8999-aaa333333333';
    const ACTIVE_ATT_B1 = '99999999-9999-4999-8999-bbb111111111';
    for (const [id, projectId] of [
      [ACTIVE_ATT_A1, PROJECT_A],
      [ACTIVE_ATT_A2, PROJECT_A],
      [ACTIVE_ATT_A3, PROJECT_A],
      [ACTIVE_ATT_B1, PROJECT_B],
    ]) {
      env.attachmentRows.set(id, {
        id,
        projectId,
        type: 'WEEKLY_REPORT',
        filename: `${id}.pdf`,
        contentType: 'application/pdf',
        sizeBytes: 1000,
        blobPath: `projects/${projectId}/${id}.pdf`,
        uploadedById: USER_ID,
        uploadedAt: new Date('2026-09-01T10:00:00Z'),
        deletedAt: null,
        title: `Active ${id}`,
      });
    }
    env.attachmentRows.set(ARCHIVED_ATT, {
      id: ARCHIVED_ATT,
      projectId: ARCHIVED,
      type: 'WEEKLY_REPORT',
      filename: 'archived.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1234,
      blobPath: 'projects/ARCHIVED/w1.pdf',
      uploadedById: USER_ID,
      uploadedAt: new Date('2026-09-01T10:00:00Z'),
      deletedAt: null,
      title: 'Archived weekly',
    });
    return env;
  }

  it('18. unscoped list excludes attachments whose parent project is archived', async () => {
    const { app } = buildAppWithArchived();
    const res = await request(app)
      .get('/api/admin/reports')
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    const projectIds = res.body.reports.map((r) => r.projectId);
    // The archived project's attachment must NOT surface — the row is
    // un-downloadable (per-project scope 404s), and the audit verdict
    // was that this orphan row confused the admin UI.
    expect(projectIds).not.toContain(ARCHIVED);
    // Active projects still surface (regression guard).
    expect(projectIds).toContain(PROJECT_A);
    expect(projectIds).toContain(PROJECT_B);
  });

  it('19. unscoped total count also excludes archived-project attachments', async () => {
    const { app } = buildAppWithArchived();
    const res = await request(app)
      .get('/api/admin/reports')
      .set('Authorization', adminJwt());
    expect(res.status).toBe(200);
    // The seeded env has 4 active attachments (3 on A, 1 on B) plus 1
    // archived on ARCHIVED. After DR-012, total = 4.
    expect(res.body.total).toBe(4);
  });

  it('20. ?projectId=<archived uuid> still 404s (resolveProjectParam unchanged)', async () => {
    const { app } = buildAppWithArchived();
    const res = await request(app)
      .get(`/api/admin/reports?projectId=${ARCHIVED}`)
      .set('Authorization', adminJwt());
    // The resolveProjectParam helper still rejects an explicit archived
    // UUID with 404 — DR-012 only added the unscoped list filter, did
    // not change the pinned-projectId path.
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PROJECT_NOT_FOUND');
  });
});
