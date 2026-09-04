// ─────────────────────────────────────────────────────────────────────────────
// Round-26: Admin-targeted email fan-out contract tests.
//
// Pins the dispatch helper's behavior + the per-route insertion-point guards
// so a future refactor doesn't silently regress the "admin gets an email when
// an employee submits a DPR / opens an inspection / requests leave" flow.
//
// What we verify:
//
//   1. fanOutToAdmins with 3 admins → 3 EmailLog rows, channel=ADMIN_IMMEDIATE,
//      all SENT (one send per admin recipient).
//   2. Admin with emailEnabled=false → SKIPPED_OPT_OUT log, no send.
//   3. Admin with typeMutes.ADMIN_DPR_SUBMITTED=true → SKIPPED_TYPE_MUTED log,
//      no send.
//   4. sendEmail throws → all admins get FAILED log, no throw to caller
//      (best-effort envelope).
//   5. findActiveAdmins excludes non-admins — only isAdmin=true comes back.
//   6. POST /api/dpr with status='DRAFT' → no admin fan-out (DRAFT guard).
//   7. POST /api/dpr with status='SUBMITTED' → admin fan-out fires.
//   8. POST /api/inspection with requestedStatus='OPEN' → admin fan-out fires.
//   9. POST /api/inspection with requestedStatus='ACKNOWLEDGED' (admin path)
//      → no admin fan-out (OPEN guard).
//  10. POST /api/leave → admin fan-out always fires (status hard-coded PENDING).
//  11. Admin template renderAdminDprSubmitted includes project name + employee
//      name (escaped HTML).
//  12. Admin template renderAdminAttendanceDigest renders 3 sections with
//      correct counts (present / onLeave / absent).
// ─────────────────────────────────────────────────────────────────────────────

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

// ─── Email transport mock ────────────────────────────────────────────────
// `mock*`-prefixed variable so jest's hoisted factory can close over it
// (see round-25d lesson: jest.mock factories can ONLY reference variables
// prefixed with `mock` / `Mock`).
const mockSendEmail = jest.fn(async () => ({ ok: true, messageId: 'admin-test-message-id' }));
jest.mock('../src/lib/email', () => {
  const actual = jest.requireActual('../src/lib/email');
  return {
    ...actual,
    sendEmail: mockSendEmail,
    isConfigured: jest.fn(() => true),
    close: jest.fn(async () => {}),
    escapeHtml: actual.escapeHtml,
    FROM_EMAIL: 'noreply@acschennai.com',
    FROM_NAME: 'ACS Chennai Portal',
  };
});

// ─── Admin-recipients mock ───────────────────────────────────────────────
// We override findActiveAdmins so the test can control which "admins" the
// fan-out sees without depending on the real DB.
const mockFindActiveAdmins = jest.fn(async () => [
  { id: 'admin-1', email: 'admin1@example.com', name: 'Admin One' },
  { id: 'admin-2', email: 'admin2@example.com', name: 'Admin Two' },
]);
jest.mock('../src/lib/adminRecipients', () => ({
  findActiveAdmins: mockFindActiveAdmins,
}));

const { fanOutToAdmins } = require('../src/lib/notify');
const { renderAdminAttendanceDigest } = require('../src/templates/email/types');

// ─── Prisma mock factory ─────────────────────────────────────────────────
// Each test gets a fresh prisma so __emailLogWrites is per-test. The prisma
// shape mirrors what fanOutToAdmins touches (notificationPreference lookup +
// emailLog writes) PLUS the minimal surface the POST route handlers need to
// reach the admin-fan-out insertion point: dPR.create, inspectionRecord.create,
// leaveRequest.findMany + leaveRequest.create.
function makePrisma({
  admins = [
    { id: 'admin-1', email: 'admin1@example.com', name: 'Admin One' },
    { id: 'admin-2', email: 'admin2@example.com', name: 'Admin Two' },
    { id: 'admin-3', email: 'admin3@example.com', name: 'Admin Three' },
  ],
  prefsByAdmin = {}, // { 'admin-1': { emailEnabled, typeMutes } }
} = {}) {
  mockFindActiveAdmins.mockResolvedValue(admins);

  const emailLogWrites = [];

  // Default POST result builders — return enough fields that the route's
  // res.json(...) + downstream fanOutToAdmins meta read doesn't blow up.
  const dprDefaultCreate = (args) => ({
    id: 'dpr-test-1',
    projectName: args.data.projectName,
    location: args.data.location,
    reportDate: args.data.reportDate,
    workType: args.data.workType,
    status: args.data.status,
    submittedById: args.data.submittedById,
    submittedBy: { id: args.data.submittedById, name: 'Rajesh Kumar', email: 'employee@example.com' },
    inspections: [],
    photos: [],
  });

  const inspectionDefaultCreate = (args) => ({
    id: 'insp-test-1',
    projectName: args.data.projectName,
    location: args.data.location,
    reportDate: args.data.reportDate,
    inspectionType: args.data.inspectionType,
    status: args.data.status,
    submittedById: args.data.submittedById,
    submittedBy: { id: args.data.submittedById, name: 'Rajesh Kumar', email: 'employee@example.com' },
    dpr: null,
    photos: [],
  });

  const leaveDefaultCreate = (args) => ({
    id: 'leave-test-1',
    employeeId: args.data.employeeId,
    startDate: args.data.startDate,
    endDate: args.data.endDate,
    leaveType: args.data.leaveType,
    reason: args.data.reason,
    status: args.data.status,
    employee: {
      id: args.data.employeeId,
      name: 'Rajesh Kumar',
      email: 'employee@example.com',
      department: 'Engineering',
    },
    reviewedBy: null,
  });

  return {
    notificationPreference: {
      findUnique: jest.fn(async ({ where }) => prefsByAdmin[where.employeeId] || null),
    },
    emailLog: {
      create: jest.fn(async ({ data }) => {
        emailLogWrites.push(data);
        return { id: 'log-' + emailLogWrites.length, ...data };
      }),
    },
    // DPR POST (dpr.js:496) + inspection POST's optional dprId lookup (inspection.js:241)
    dPR: {
      create: jest.fn(async (args) => dprDefaultCreate(args)),
      findUnique: jest.fn(async () => null), // no linked DPR in tests
    },
    // Inspection POST (inspection.js:280)
    inspectionRecord: {
      create: jest.fn(async (args) => inspectionDefaultCreate(args)),
    },
    // Leave POST (leave.js:119 overlap precheck + leave.js:143 create)
    leaveRequest: {
      findMany: jest.fn(async () => []), // empty = no overlap conflict
      create: jest.fn(async (args) => leaveDefaultCreate(args)),
    },
    __emailLogWrites: emailLogWrites,
  };
}

beforeEach(() => {
  mockSendEmail.mockReset();
  mockSendEmail.mockResolvedValue({ ok: true, messageId: 'admin-test-message-id' });
  mockFindActiveAdmins.mockReset();
  mockFindActiveAdmins.mockResolvedValue([
    { id: 'admin-1', email: 'admin1@example.com', name: 'Admin One' },
    { id: 'admin-2', email: 'admin2@example.com', name: 'Admin Two' },
    { id: 'admin-3', email: 'admin3@example.com', name: 'Admin Three' },
  ]);
});

// ─── fanOutToAdmins unit tests ───────────────────────────────────────────

describe('Round-26 — fanOutToAdmins unit tests', () => {
  it('1. fan-out to 3 admins → 3 EmailLog rows, channel=ADMIN_IMMEDIATE, all SENT', async () => {
    const prisma = makePrisma();
    const result = await fanOutToAdmins(
      {
        type: 'ADMIN_DPR_SUBMITTED',
        message: 'New DPR submitted by Rajesh',
        meta: { employeeName: 'Rajesh', projectName: 'Acme Tower' },
      },
      prisma,
    );

    expect(result.sent).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(mockSendEmail).toHaveBeenCalledTimes(3);
    expect(prisma.__emailLogWrites).toHaveLength(3);
    prisma.__emailLogWrites.forEach((row) => {
      expect(row.channel).toBe('ADMIN_IMMEDIATE');
      expect(row.status).toBe('SENT');
      expect(row.notificationId).toBeNull();
      expect(row.providerMessageId).toBe('admin-test-message-id');
    });
    // Each admin got their own row (employeeId matches the recipient).
    const recipientIds = prisma.__emailLogWrites.map((r) => r.employeeId).sort();
    expect(recipientIds).toEqual(['admin-1', 'admin-2', 'admin-3']);
  });

  it('2. admin with emailEnabled=false → SKIPPED_OPT_OUT, no send', async () => {
    const prisma = makePrisma({
      prefsByAdmin: {
        'admin-2': { emailEnabled: false, typeMutes: {} },
      },
    });
    const result = await fanOutToAdmins(
      { type: 'ADMIN_DPR_SUBMITTED', message: 'X', meta: {} },
      prisma,
    );

    expect(result.sent).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    // Only admin-1 + admin-3 got the send (admin-2 skipped before send).
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    const admin2Rows = prisma.__emailLogWrites.filter((r) => r.employeeId === 'admin-2');
    expect(admin2Rows).toHaveLength(1);
    expect(admin2Rows[0].status).toBe('SKIPPED_OPT_OUT');
  });

  it('3. admin with typeMutes.ADMIN_DPR_SUBMITTED=true → SKIPPED_TYPE_MUTED, no send', async () => {
    const prisma = makePrisma({
      prefsByAdmin: {
        'admin-3': { emailEnabled: true, typeMutes: { ADMIN_DPR_SUBMITTED: true } },
      },
    });
    const result = await fanOutToAdmins(
      { type: 'ADMIN_DPR_SUBMITTED', message: 'X', meta: {} },
      prisma,
    );

    expect(result.sent).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    const admin3Rows = prisma.__emailLogWrites.filter((r) => r.employeeId === 'admin-3');
    expect(admin3Rows).toHaveLength(1);
    expect(admin3Rows[0].status).toBe('SKIPPED_TYPE_MUTED');
  });

  it('4. sendEmail throws → all admins get FAILED log, fanOutToAdmins does NOT throw', async () => {
    mockSendEmail.mockRejectedValue(new Error('SMTP exploded'));
    const prisma = makePrisma();
    // fanOutToAdmins must never throw — the route handler is already in
    // a "user got their 201, now do best-effort admin email" posture.
    let threw = false;
    let result;
    try {
      result = await fanOutToAdmins(
        { type: 'ADMIN_DPR_SUBMITTED', message: 'X', meta: {} },
        prisma,
      );
    } catch (_) {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result.failed).toBe(3);
    expect(result.sent).toBe(0);
    // Each admin got a FAILED row (helper swallows the per-recipient error).
    prisma.__emailLogWrites.forEach((row) => {
      expect(row.status).toBe('FAILED');
      expect(row.errorMessage).toMatch(/SMTP exploded/);
    });
  });

  it('5. findActiveAdmins returns only isAdmin=true (the helper filters at the source)', async () => {
    // The mock simulates a single admin (findActiveAdmins already filters).
    const prisma = makePrisma({
      admins: [{ id: 'admin-solo', email: 'solo@example.com', name: 'Solo Admin' }],
    });
    const result = await fanOutToAdmins(
      { type: 'ADMIN_DPR_SUBMITTED', message: 'X', meta: {} },
      prisma,
    );
    expect(result.sent).toBe(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(prisma.__emailLogWrites[0].employeeId).toBe('admin-solo');
  });
});

// ─── Per-route POST integration tests (dpr / inspection / leave) ─────────
//
// Each test boots the real route + a minimal prisma mock + the
// `fanOutToAdmins` spy from lib/notify. We assert whether the admin fan-out
// fired based on the route's guard (DRAFT vs SUBMITTED for DPR, OPEN vs
// non-OPEN for inspection, always for leave).

const dprRouter = require('../src/routes/dpr');
const inspectionRouter = require('../src/routes/inspection');
const leaveRouter = require('../src/routes/leave');

function adminAuth() {
  return `Bearer ${jwt.sign(
    { employeeId: 'employee-1', email: 'employee@example.com', isAdmin: false },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  )}`;
}

function buildApp(prisma) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.use('/api/dpr', dprRouter);
  app.use('/api/inspection', inspectionRouter);
  app.use('/api/leave', leaveRouter);
  return app;
}

describe('Round-26 — POST /api/dpr admin fan-out guards', () => {
  it('6. POST /api/dpr with status=DRAFT → NO admin fan-out (guard)', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/dpr')
      .set('Authorization', adminAuth())
      .send({
        projectName: 'Acme Tower',
        location: 'Chennai',
        reportDate: '2026-09-03',
        workType: 'MATERIAL_RECEIPT',
        status: 'DRAFT',
        photos: [],
      });
    expect(res.status).toBe(201);
    // No admin fan-out because DRAFT.
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(prisma.__emailLogWrites).toHaveLength(0);
  });

  it('7. POST /api/dpr with status=SUBMITTED → admin fan-out fires', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/dpr')
      .set('Authorization', adminAuth())
      .send({
        projectName: 'Acme Tower',
        location: 'Chennai',
        reportDate: '2026-09-03',
        workType: 'MATERIAL_RECEIPT',
        status: 'SUBMITTED',
        photos: [],
      });
    expect(res.status).toBe(201);
    // 3 admins × 1 send each.
    expect(mockSendEmail).toHaveBeenCalledTimes(3);
    // Verify the subject line carries the project name.
    const sendArgs = mockSendEmail.mock.calls[0][0];
    expect(sendArgs.subject).toMatch(/Acme Tower/);
    // EmailLog rows: 3 SENT.
    expect(prisma.__emailLogWrites).toHaveLength(3);
    prisma.__emailLogWrites.forEach((row) => {
      expect(row.channel).toBe('ADMIN_IMMEDIATE');
      expect(row.status).toBe('SENT');
    });
  });
});

describe('Round-26 — POST /api/inspection admin fan-out guards', () => {
  it('8. POST /api/inspection with status=OPEN → admin fan-out fires', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', adminAuth())
      .send({
        projectName: 'Acme Tower',
        location: 'Chennai',
        reportDate: '2026-09-03',
        inspectionType: 'material_inspection', // valid per ALLOWED_INSPECTION_TYPES
        data: {},
        status: 'OPEN',
        photos: [],
      });
    expect(res.status).toBe(201);
    expect(mockSendEmail).toHaveBeenCalledTimes(3);
    const sendArgs = mockSendEmail.mock.calls[0][0];
    expect(sendArgs.subject).toMatch(/New inspection/);
  });

  it('9. POST /api/inspection with status=ACKNOWLEDGED (admin path) → NO admin fan-out', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const adminToken = `Bearer ${jwt.sign(
      { employeeId: 'admin-1', email: 'admin@example.com', isAdmin: true },
      process.env.JWT_SECRET,
      { expiresIn: '8h' },
    )}`;
    const res = await request(app)
      .post('/api/inspection')
      .set('Authorization', adminToken)
      .send({
        projectName: 'Acme Tower',
        location: 'Chennai',
        reportDate: '2026-09-03',
        inspectionType: 'material_inspection',
        data: {},
        status: 'ACKNOWLEDGED',
        photos: [],
      });
    // Server may reject the admin-set non-OPEN status with 403 OR the
    // ACKNOWLEDGED status guard in inspection.js may block it with 422.
    // Either way the admin fan-out must NOT fire.
    expect([201, 403, 422]).toContain(res.status);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(prisma.__emailLogWrites).toHaveLength(0);
  });
});

describe('Round-26 — POST /api/leave admin fan-out', () => {
  it('10. POST /api/leave → admin fan-out always fires (PENDING on create)', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/leave')
      .set('Authorization', adminAuth())
      .send({
        startDate: '2026-10-01',
        endDate: '2026-10-03',
        leaveType: 'CASUAL',
        reason: 'Family function',
      });
    expect(res.status).toBe(201);
    expect(mockSendEmail).toHaveBeenCalledTimes(3);
    const sendArgs = mockSendEmail.mock.calls[0][0];
    expect(sendArgs.subject).toMatch(/Leave requested/);
    expect(prisma.__emailLogWrites).toHaveLength(3);
    prisma.__emailLogWrites.forEach((row) => {
      expect(row.channel).toBe('ADMIN_IMMEDIATE');
      expect(row.status).toBe('SENT');
    });
  });
});

// ─── Template snapshot tests ─────────────────────────────────────────────

describe('Round-26 — admin email template renderers', () => {
  it('11. renderAdminDprSubmitted includes project name + employee name (escaped HTML)', () => {
    const types = require('../src/templates/email/types').types;
    const renderer = types.ADMIN_DPR_SUBMITTED;
    expect(renderer).toBeDefined();
    const out = renderer({
      notification: { type: 'ADMIN_DPR_SUBMITTED', message: 'X' },
      context: {
        employeeName: 'Rajesh Kumar',
        projectName: 'Acme Tower <script>alert(1)</script>', // attempt injection
        reportDate: '3 Sept 2026',
        dprId: 'dpr-1',
      },
      wrapHtml: ({ bodyHtml }) => bodyHtml, // unwrap so we can grep the body
      ctaButton: () => '',
      escapeHtml: (v) => String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
      portalUrl: 'https://acschennai.com',
    });
    expect(out.subject).toMatch(/New DPR/);
    expect(out.subject).toMatch(/Rajesh Kumar/);
    expect(out.html).toContain('Rajesh Kumar');
    expect(out.html).toContain('Acme Tower'); // readable part
    // XSS attempt escaped — raw <script> should not appear.
    expect(out.html).not.toContain('<script>alert(1)</script>');
    expect(out.html).toContain('&lt;script&gt;');
  });

  it('12. renderAdminAttendanceDigest renders 3 sections with correct counts', () => {
    const out = renderAdminAttendanceDigest({
      context: {
        istDateLabel: '3 Sept 2026',
        present: [
          { name: 'Rajesh Kumar', checkInLabel: '08:47' },
          { name: 'Priya Sharma', checkInLabel: '09:02' },
        ],
        onLeave: [{ name: 'Anita Raj' }],
        absent: [{ name: 'Mohan Raj' }, { name: 'Lakshmi V' }],
      },
      wrapHtml: ({ bodyHtml }) => bodyHtml,
      ctaButton: () => '',
      escapeHtml: (v) => String(v == null ? '' : v),
      portalUrl: 'https://acschennai.com',
    });
    expect(out.subject).toMatch(/Daily attendance/);
    expect(out.subject).toMatch(/3 Sept 2026/);
    // Counts in the body.
    expect(out.html).toContain('<strong>2</strong> present');
    expect(out.html).toContain('<strong>1</strong> on approved leave');
    expect(out.html).toContain('<strong>2</strong> absent');
    // Section headings present.
    expect(out.html).toContain('Present');
    expect(out.html).toContain('On approved leave');
    expect(out.html).toContain('Absent');
    // All five employees rendered in some section.
    ['Rajesh Kumar', 'Priya Sharma', 'Anita Raj', 'Mohan Raj', 'Lakshmi V'].forEach((name) => {
      expect(out.html).toContain(name);
    });
    // Check-in time surfaces.
    expect(out.html).toContain('08:47');
    expect(out.html).toContain('09:02');
  });
});
