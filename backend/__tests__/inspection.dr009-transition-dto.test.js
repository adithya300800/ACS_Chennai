/**
 * [DR-009] Successful inspection actions returned a photo DTO lacking
 * the `readUrl` field — SPA gallery images went to `<img src>` empty
 * until a page reload. Root cause: the GET handler mints readUrls;
 * every transition handler (acknowledge / close / reject / submit /
 * PUT) returned the raw ORM record.
 *
 * Fix: hoist the decoration into `serializeInspectionRecordForWire`
 * and call it from every transition handler before responding. The
 * wire shape is now invariant across reads and mutations.
 *
 * This suite pins the four transitions end-to-end:
 *   - acknowledge (admin)
 *   - close (admin)
 *   - reject (admin) — also asserts the structured rejection fields
 *   - submit (owner)
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

// Force a deterministic SAS URL so the assertion can pin against a
// known string. Real blobStorage has no test surface in this suite —
// keeping the jest.mock at module-load time avoids accidental pulls
// of the @aws-sdk ESM chain.
jest.mock('../src/lib/blobStorage', () => ({
  generateReadSASUrl: jest.fn(async () => ({ sasUrl: 'https://r2.example/dr009-sas', expiresAt: '2030-01-01T00:00:00Z' })),
  verifyBlobExists: jest.fn(async () => ({ outcome: 'present', exists: true })),
  isAbsent: (props) => !!(props && (props.outcome === 'absent' || (props.outcome === undefined && props.exists === false))),
  // [DR-009] serializeInspectionRecordForWire uses
  // CONTENT_TYPE_EXT[p.contentType] to build the R2 blob name. Mock
  // it the same shape dpr / drawings / project-attachments tests do
  // so the GET and transition paths both correctly read the ext.
  CONTENT_TYPE_EXT: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' },
}));

const inspectionRouter = require('../src/routes/inspection');

// [DR-009] transitionInspectionRecord fans out an email + SSE after the
// tx commits. Mock the notify surface so the helper doesn't reach for
// a real `notificationPreference` model (which our hand-rolled prisma
// stub doesn't expose). The handler is fire-and-forget so the route
// returns immediately even if the promise rejects internally.
jest.mock('../src/lib/notify', () => ({
  fanOutEmail: jest.fn(async () => ({ sent: 0 })),
  fanOutToAdmins: jest.fn(async () => ({ sent: 0, skipped: 0, failed: 0 })),
  scheduleDailyDigest: jest.fn(),
}));

const OWNER_ID = 'emp-dr009-owner';
const ADMIN_ID = 'emp-dr009-admin';
const OTHER_EMPLOYEE = 'emp-dr009-other';
const RECORD_ID = 'rec-dr009-1';

let records = {};

function seedRecord({
  id = RECORD_ID,
  submittedById = OWNER_ID,
  status = 'OPEN',
  data = {},
  photos = [],
} = {}) {
  records[id] = {
    id,
    projectName: 'DR009 Site',
    location: 'Chennai',
    reportDate: new Date('2026-09-04T00:00:00.000Z'),
    weather: 'Sunny',
    contractor: null,
    dprId: null,
    inspectionType: 'material_inspection',
    data,
    severity: null,
    submittedById,
    status,
    photos,
    // GET-time include has more joins than the transition-time include
    // — the helper tolerates either shape via the
    // `(p.inspection && p.inspection.submittedById)` fallback.
    submittedBy: { id: submittedById, name: 'Owner', email: 'o@example.com' },
    dpr: null,
    boqItem: null,
    project: null,
    drawing: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return records[id];
}

function buildApp({ isAdmin = true, employeeId = ADMIN_ID } = {}) {
  const app = express();
  app.use(express.json());

  const inspect = {
    findUnique: async ({ where }) => {
      const row = records[where.id];
      if (!row) return null;
      return { ...row };
    },
    update: async ({ where, data }) => {
      const row = records[where.id];
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return { ...row };
    },
    // withRecordTransaction probes `tx[modelName].create` to decide
    // which client to hand the callback. Hand the probe a no-op so
    // the test routes through the tx reference; the actual transition
    // uses updateMany via update above.
    create: async () => ({ id: 'noop' }),
  };

  const prisma = {
    inspectionRecord: inspect,
    notification: {
      // transitionInspectionRecord writes a per-record notification
      // (DR-021) so the SSE wire shape carries the SAME UUID the
      // /list endpoint returns. The test doesn't read it back, but
      // the helper's `tx.notification.create` probe is what fails
      // when this delegate is missing.
      create: async ({ data }) => ({ id: 'notif-test', ...data }),
    },
    // [DR-009] The transition helper in src/routes/inspection.js wraps
    // its writes in prisma.$transaction when available. Hand the
    // helper a no-op transaction that calls through with the base
    // prisma — same shape as the production fallback, since the
    // mock has no real relational concerns.
    $transaction: async (fn) => fn(prisma),
    uploadIntent: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
    employee: {
      // Tracked so test #3 can assert the reject path resolved the
      // reviewer; jest.fn() with an implementation satisfies both
      // `expect(fn).toHaveBeenCalledWith(...)` AND the resolver.
      findUnique: jest.fn(async ({ where } = {}) => {
        // requireFreshAdmin reads `isAdmin` off this row before
        // letting an admin action through; the rejected-by resolver
        // reads the same row's id/name/email. Returning the wide
        // shape keeps both paths happy.
        if (where?.id === ADMIN_ID) return { id: ADMIN_ID, name: 'DR009 Admin', email: 'a@example.com', isAdmin: true };
        if (where?.id === OWNER_ID) return { id: OWNER_ID, name: 'DR009 Owner', email: 'o@example.com', isAdmin: false };
        if (where?.id === OTHER_EMPLOYEE) return { id: OTHER_EMPLOYEE, name: 'Other', email: 'x@example.com', isAdmin: false };
        return null;
      }),
    },
  };

  app.set('prisma', prisma);
  app.use('/api/inspection', inspectionRouter);
  return { app, prisma };
}

function authHeader(employeeId) {
  return `Bearer ${jwt.sign(
    { employeeId, email: `${employeeId}@example.com`, isAdmin: employeeId === ADMIN_ID },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  )}`;
}

beforeEach(() => {
  records = {};
  jest.clearAllMocks();
});

const PHOTO = {
  id: 'photo-1',
  ulid: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  container: 'inspection-photos',
  contentType: 'image/jpeg',
  sizeBytes: 4096,
  inspectionId: RECORD_ID,
};

describe('SOL DR-009 — transition responses return the same decorated DTO as the GET handler', () => {
  test('1. acknowledge response includes readUrl on every photo (no reload)', async () => {
    seedRecord({ status: 'OPEN', photos: [{ ...PHOTO }] });
    const { app } = buildApp({ isAdmin: true, employeeId: ADMIN_ID });

    const res = await request(app)
      .post(`/api/inspection/${RECORD_ID}/acknowledge`)
      .set('Authorization', authHeader(ADMIN_ID))
      .send({ adminNotes: 'lgtm' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ACKNOWLEDGED');
    // [DR-009] The bug class — before this fix the response was
    // `record.photos[i].readUrl === undefined`. Pin the readUrl so a
    // future regression that drops the decoration surfaces here.
    expect(Array.isArray(res.body.photos)).toBe(true);
    expect(res.body.photos).toHaveLength(1);
    expect(res.body.photos[0]).toMatchObject({
      ulid: PHOTO.ulid,
      container: PHOTO.container,
      readUrl: expect.stringMatching(/^https:\/\/r2\.example\/dr009-sas/),
    });
  });

  test('2. close response includes readUrl on every photo (no reload)', async () => {
    seedRecord({ status: 'ACKNOWLEDGED', photos: [{ ...PHOTO }] });
    const { app } = buildApp({ isAdmin: true, employeeId: ADMIN_ID });

    const res = await request(app)
      .post(`/api/inspection/${RECORD_ID}/close`)
      .set('Authorization', authHeader(ADMIN_ID))
      .send({ adminNotes: 'closed' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CLOSED');
    expect(res.body.photos).toHaveLength(1);
    expect(res.body.photos[0].readUrl).toMatch(/^https:\/\/r2\.example\/dr009-sas/);
  });

  test('3. reject response surfaces readUrl + structured rejection fields in ONE round-trip', async () => {
    seedRecord({ status: 'OPEN', photos: [{ ...PHOTO }] });
    const { app, prisma } = buildApp({ isAdmin: true, employeeId: ADMIN_ID });

    const res = await request(app)
      .post(`/api/inspection/${RECORD_ID}/reject`)
      .set('Authorization', authHeader(ADMIN_ID))
      .send({ reason: 'Wrong severity classification', adminNotes: 'see ticket #42' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REJECTED');
    // [DR-009] photos[].readUrl decorated in the same response as
    // the rejection banner — SPA never has to fire a second GET to
    // render both the gallery and the rejection reason.
    expect(res.body.photos[0].readUrl).toMatch(/^https:\/\/r2\.example\/dr009-sas/);
    expect(res.body.rejectionReason).toBe('Wrong severity classification');
    expect(res.body.rejectionNotes).toBe('see ticket #42');
    // rejectedBy resolves the cuid via prisma.employee.findUnique.
      // The mock returns the wider record (select: { id, name, email,
      // isAdmin }); the route spreads the returned row as-is.
      expect(res.body.rejectedBy).toEqual({
        id: ADMIN_ID,
        name: 'DR009 Admin',
        email: 'a@example.com',
        isAdmin: true,
      });
    expect(res.body.rejectedAt).toEqual(expect.any(String));

    // The internally-recorded `_adminNotes` history was stamped by
    // the transition helper before the decoration ran — confirm the
    // most recent REJECT entry carries the reason we just submitted.
    const notes = (records[RECORD_ID].data || {})._adminNotes || [];
    expect(notes[notes.length - 1]).toMatchObject({
      action: 'REJECT',
      reason: 'Wrong severity classification',
      notes: 'see ticket #42',
      by: ADMIN_ID,
    });

    // Sanity — the mocked employee lookup was used (at most N+1
    // finds for the reject path; we only assert the reviewer).
    expect(prisma.employee.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ADMIN_ID } }),
    );
  });

  test('4. submit response (owner transition DRAFT → OPEN) also includes readUrl', async () => {
    seedRecord({ submittedById: OWNER_ID, status: 'DRAFT', photos: [{ ...PHOTO }] });
    const { app } = buildApp({ isAdmin: false, employeeId: OWNER_ID });

    const res = await request(app)
      .post(`/api/inspection/${RECORD_ID}/submit`)
      .set('Authorization', authHeader(OWNER_ID))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OPEN');
    expect(res.body.photos).toHaveLength(1);
    expect(res.body.photos[0].readUrl).toMatch(/^https:\/\/r2\.example\/dr009-sas/);
  });

  test('5. ack/close on a record with NO photos returns photos: [] (not undefined, not hidden)', async () => {
    seedRecord({ status: 'OPEN', photos: [] });
    const { app } = buildApp({ isAdmin: true, employeeId: ADMIN_ID });

    const res = await request(app)
      .post(`/api/inspection/${RECORD_ID}/acknowledge`)
      .set('Authorization', authHeader(ADMIN_ID))
      .send({ adminNotes: 'no photos' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ACKNOWLEDGED');
    expect(res.body.photos).toEqual([]);
  });

  test('6. GET response uses the same helper (single source of DTO truth)', async () => {
    seedRecord({ status: 'OPEN', photos: [{ ...PHOTO }] });
    const { app } = buildApp({ isAdmin: true, employeeId: ADMIN_ID });

    const getRes = await request(app)
      .get(`/api/inspection/${RECORD_ID}`)
      .set('Authorization', authHeader(ADMIN_ID));

    expect(getRes.status).toBe(200);
    expect(getRes.body.photos[0].readUrl).toMatch(/^https:\/\/r2\.example\/dr009-sas/);
    // Wire-shape parity: same set of top-level keys after the
    // decoration (photos is the photos-with-urls array; rejection*
    // fields default to null on a non-REJECTED record).
    expect(getRes.body).toHaveProperty('rejectionReason', null);
    expect(getRes.body).toHaveProperty('rejectionNotes', null);
    expect(getRes.body).toHaveProperty('rejectedBy', null);
    expect(getRes.body).toHaveProperty('rejectedAt', null);
  });
});
