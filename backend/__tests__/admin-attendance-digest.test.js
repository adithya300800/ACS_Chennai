// ─────────────────────────────────────────────────────────────────────────────
// Round-26: Admin attendance-digest cron contract tests.
//
// Pins the partition + dispatch behavior of POST /api/internal/attendance/digest/run:
//   - Token gate (404 unset, 403 wrong, 200 match)
//   - Partition: present / onLeave / absent based on Attendance row +
//     APPROVED LeaveRequest on the target date
//   - Admin users excluded from the grid (they don't mark attendance)
//   - PENDING leave does NOT count as on-leave
//   - Per-admin preference respect (emailEnabled, typeMutes.ADMIN_ATTENDANCE_DAILY)
//   - One email per admin (not per employee)
// ─────────────────────────────────────────────────────────────────────────────

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';
process.env.INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || 'test-internal-token';

const express = require('express');
const request = require('supertest');

const mockSendEmail = jest.fn(async () => ({ ok: true, messageId: 'admin-att-msg' }));
const mockIsConfigured = jest.fn(() => true);
const mockFindActiveAdmins = jest.fn(async () => [
  { id: 'admin-1', email: 'admin1@example.com', name: 'Admin One' },
]);

jest.mock('../src/lib/email', () => {
  const actual = jest.requireActual('../src/lib/email');
  return {
    ...actual,
    sendEmail: mockSendEmail,
    isConfigured: mockIsConfigured,
    close: jest.fn(async () => {}),
    escapeHtml: actual.escapeHtml,
    FROM_EMAIL: 'noreply@acschennai.com',
    FROM_NAME: 'ACS Chennai Portal',
  };
});

jest.mock('../src/lib/adminRecipients', () => ({
  findActiveAdmins: mockFindActiveAdmins,
}));

const router = require('../src/routes/internal-admin-attendance');

function buildApp(prisma) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.use('/api/internal/attendance/digest', router);
  return app;
}

function makePrisma({
  employees = [],
  attendanceRows = [],
  approvedLeaves = [],
  prefsByAdmin = {},
} = {}) {
  const emailLogWrites = [];
  // [REPORT-S3-11] Track AdminDigestRun writes so tests can assert on
  // the per-admin bookkeeping. Each create+update pair is one row.
  const adminDigestRunWrites = [];
  return {
    employee: {
      findMany: jest.fn(async () => employees),
    },
    attendance: {
      findMany: jest.fn(async () => attendanceRows),
    },
    leaveRequest: {
      findMany: jest.fn(async () => approvedLeaves),
    },
    notificationPreference: {
      findUnique: jest.fn(async ({ where }) => prefsByAdmin[where.employeeId] || null),
    },
    emailLog: {
      create: jest.fn(async ({ data }) => {
        emailLogWrites.push(data);
        return { id: 'log-' + emailLogWrites.length, ...data };
      }),
    },
    adminDigestRun: {
      // Atomic claim — never raises P2002 here because the legacy suite
      // only fires the handler once per test. The new idempotency suite
      // (admin-attendance-digest-idempotency.test.js) has its own mock
      // factory that honours the @@unique constraint.
      create: jest.fn(async ({ data }) => {
        const row = {
          id: 'adr-' + (adminDigestRunWrites.length + 1),
          ...data,
        };
        adminDigestRunWrites.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }) => {
        const row = adminDigestRunWrites.find(
          (r) =>
            r.adminId === where.adminId_scheduledFor.adminId &&
            r.scheduledFor.getTime() === where.adminId_scheduledFor.scheduledFor.getTime()
        );
        if (!row) throw new Error('AdminDigestRun not found');
        Object.assign(row, data);
        return row;
      }),
    },
    __emailLogWrites: emailLogWrites,
    __adminDigestRunWrites: adminDigestRunWrites,
  };
}

beforeEach(() => {
  mockSendEmail.mockReset();
  mockSendEmail.mockResolvedValue({ ok: true, messageId: 'admin-att-msg' });
  mockFindActiveAdmins.mockReset();
  mockFindActiveAdmins.mockResolvedValue([
    { id: 'admin-1', email: 'admin1@example.com', name: 'Admin One' },
  ]);
  mockIsConfigured.mockReset();
  mockIsConfigured.mockReturnValue(true);
});

// ─── Token gate ───────────────────────────────────────────────────────────

describe('Round-26 — POST /api/internal/attendance/digest/run token gate', () => {
  it('returns 404 when INTERNAL_API_TOKEN is unset', async () => {
    const saved = process.env.INTERNAL_API_TOKEN;
    delete process.env.INTERNAL_API_TOKEN;
    try {
      const prisma = makePrisma();
      const app = buildApp(prisma);
      const res = await request(app).post('/api/internal/attendance/digest/run');
      expect(res.status).toBe(404);
    } finally {
      process.env.INTERNAL_API_TOKEN = saved;
    }
  });

  it('returns 403 on wrong token', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/attendance/digest/run')
      .set('X-Internal-Token', 'nope');
    expect(res.status).toBe(403);
  });

  it('returns 503 when email transport is not configured', async () => {
    // Override the shared mockIsConfigured for this test only — the
    // beforeEach() reset + mockReturnValue(true) will restore the default
    // for subsequent tests, so this can't leak across the suite.
    mockIsConfigured.mockReturnValue(false);
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/attendance/digest/run')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SMTP_NOT_CONFIGURED');
  });
});

// ─── Partition behavior ───────────────────────────────────────────────────

describe('Round-26 — POST /api/internal/attendance/digest/run partition logic', () => {
  it('1. all present → present=N, onLeave=0, absent=0', async () => {
    const checkIn = new Date(Date.UTC(2026, 8, 2, 2, 47)); // 08:17 IST on 2026-09-02
    const prisma = makePrisma({
      employees: [
        { id: 'emp-1', name: 'Rajesh' },
        { id: 'emp-2', name: 'Priya' },
      ],
      attendanceRows: [
        { employeeId: 'emp-1', sessions: [{ checkIn }] },
        { employeeId: 'emp-2', sessions: [{ checkIn }] },
      ],
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/attendance/digest/run?date=2026-09-02')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.sections).toEqual({ present: 2, onLeave: 0, absent: 0 });
    expect(res.body.sent).toBe(1); // one admin
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const sendArgs = mockSendEmail.mock.calls[0][0];
    expect(sendArgs.subject).toMatch(/Daily attendance/);
  });

  it('2. mix present + on-leave (APPROVED leave) → both sections populated', async () => {
    const checkIn = new Date(Date.UTC(2026, 8, 2, 3, 32));
    const prisma = makePrisma({
      employees: [
        { id: 'emp-1', name: 'Rajesh' },
        { id: 'emp-2', name: 'Anita' },
      ],
      attendanceRows: [
        { employeeId: 'emp-1', sessions: [{ checkIn }] },
      ],
      approvedLeaves: [
        { employeeId: 'emp-2' },
      ],
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/attendance/digest/run?date=2026-09-02')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.sections).toEqual({ present: 1, onLeave: 1, absent: 0 });
  });

  it('3. mix present + absent (no Present row, no APPROVED leave)', async () => {
    const checkIn = new Date(Date.UTC(2026, 8, 2, 1, 15));
    const prisma = makePrisma({
      employees: [
        { id: 'emp-1', name: 'Rajesh' },
        { id: 'emp-2', name: 'Mohan' },
      ],
      attendanceRows: [{ employeeId: 'emp-1', sessions: [{ checkIn }] }],
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/attendance/digest/run?date=2026-09-02')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.sections).toEqual({ present: 1, onLeave: 0, absent: 1 });
  });

  it('4. approved leave on the date → that employee goes to onLeave, NOT absent', async () => {
    const prisma = makePrisma({
      employees: [{ id: 'emp-1', name: 'Anita' }],
      approvedLeaves: [{ employeeId: 'emp-1' }],
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/attendance/digest/run?date=2026-09-02')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.sections).toEqual({ present: 0, onLeave: 1, absent: 0 });
  });

  it('5. PENDING leave does NOT count as on-leave (only APPROVED)', async () => {
    // The query filters to status='APPROVED', so a PENDING leave in the
    // window returns 0 rows → employee falls through to absent.
    const prisma = makePrisma({
      employees: [{ id: 'emp-1', name: 'Mohan' }],
      approvedLeaves: [], // PENDING leave is filtered out at the query level
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/attendance/digest/run?date=2026-09-02')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.sections).toEqual({ present: 0, onLeave: 0, absent: 1 });
    // Verify the query filtered on APPROVED only.
    const where = prisma.leaveRequest.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('APPROVED');
  });

  it('6. admin employees are excluded from the grid (employee.findMany filters by isAdmin: false)', async () => {
    const prisma = makePrisma({
      employees: [
        { id: 'emp-1', name: 'Rajesh' },
        { id: 'emp-2', name: 'Priya' },
      ],
    });
    const app = buildApp(prisma);
    await request(app)
      .post('/api/internal/attendance/digest/run?date=2026-09-02')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    const where = prisma.employee.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ isAdmin: false });
  });

  it('7. admin with emailEnabled=false → no digest sent, SKIPPED_OPT_OUT logged', async () => {
    const prisma = makePrisma({
      employees: [{ id: 'emp-1', name: 'Rajesh' }],
      prefsByAdmin: { 'admin-1': { emailEnabled: false, typeMutes: {} } },
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/attendance/digest/run?date=2026-09-02')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(0);
    expect(res.body.skipped).toBe(1);
    expect(mockSendEmail).not.toHaveBeenCalled();
    const skipRows = prisma.__emailLogWrites.filter((r) => r.status === 'SKIPPED_OPT_OUT');
    expect(skipRows).toHaveLength(1);
    expect(skipRows[0].channel).toBe('ADMIN_DIGEST');
  });

  it('8. admin with typeMutes.ADMIN_ATTENDANCE_DAILY=true → SKIPPED_TYPE_MUTED logged', async () => {
    const prisma = makePrisma({
      prefsByAdmin: { 'admin-1': { emailEnabled: true, typeMutes: { ADMIN_ATTENDANCE_DAILY: true } } },
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/attendance/digest/run?date=2026-09-02')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(0);
    expect(res.body.skipped).toBe(1);
    const skipRows = prisma.__emailLogWrites.filter((r) => r.status === 'SKIPPED_TYPE_MUTED');
    expect(skipRows).toHaveLength(1);
    expect(skipRows[0].channel).toBe('ADMIN_DIGEST');
  });

  it('9. multiple admins → 1 send per admin (N admins → N sends)', async () => {
    mockFindActiveAdmins.mockResolvedValue([
      { id: 'admin-1', email: 'admin1@example.com', name: 'Admin One' },
      { id: 'admin-2', email: 'admin2@example.com', name: 'Admin Two' },
      { id: 'admin-3', email: 'admin3@example.com', name: 'Admin Three' },
    ]);
    const prisma = makePrisma({ employees: [{ id: 'emp-1', name: 'Rajesh' }] });
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/attendance/digest/run?date=2026-09-02')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(3);
    expect(mockSendEmail).toHaveBeenCalledTimes(3);
    // All 3 EmailLog rows are ADMIN_DIGEST + SENT.
    expect(prisma.__emailLogWrites.filter((r) => r.status === 'SENT')).toHaveLength(3);
    prisma.__emailLogWrites.forEach((row) => {
      expect(row.channel).toBe('ADMIN_DIGEST');
    });
  });

  it('10. invalid ?date= returns 400', async () => {
    const prisma = makePrisma();
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/attendance/digest/run?date=not-a-date')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);
    expect(res.status).toBe(400);
  });
});
