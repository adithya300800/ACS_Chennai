// ─────────────────────────────────────────────────────────────────────────────
// [REPORT-S3-11] Admin attendance digest idempotency contract tests.
//
// Pins the (adminId, scheduledFor) claim race-safety on POST
// /api/internal/attendance/digest/run. Before S3-11 the handler
// acknowledged in its own header that it had no application-layer
// idempotency — any manual re-fire via workflow_dispatch re-sent the
// digest to every admin.
//
// What we verify:
//
//   1. First fire: 3 admins → 3 EmailLog rows (SENT) + 3 AdminDigestRun
//      rows (status=SENT, emailLogId linked).
//   2. Second fire on the same date: 0 sends, idempotentSkips=3, NO new
//      EmailLog rows, all 3 AdminDigestRun rows already SENT.
//   3. Different date (?date= override): 3 sends (idempotency is per-
//      date; the scheduledFor key changes).
//   4. prefs.emailEnabled=false admin: AdminDigestRun row written with
//      status=SKIPPED_OPT_OUT (still audited, no send).
//   5. typeMutes.ADMIN_ATTENDANCE_DAILY: AdminDigestRun row written
//      with status=SKIPPED_TYPE_MUTED.
//   6. P2002 path: the route returns 200 with idempotentSkips > 0 —
//      a P2002 from the claim create is NOT a 500.
//   7. emailLogId is correctly linked on the AdminDigestRun terminal
//      update (for the SENT path AND the SKIPPED_* paths).
// ─────────────────────────────────────────────────────────────────────────────

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';
process.env.INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || 'test-internal-token';

const express = require('express');
const request = require('supertest');

const mockSendEmail = jest.fn(async () => ({ ok: true, messageId: 'admin-att-msg' }));
const mockIsConfigured = jest.fn(() => true);

// `mock*`-prefixed variable so jest's hoisted factory can close over it
// (round-25d lesson: jest.mock factories can ONLY reference variables
// prefixed with `mock` / `Mock`).
const mockFindActiveAdmins = jest.fn(async () => []);
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
  // Surface async errors as JSON so the test sees the actual exception
  // if a handler throws — mirrors internal-digest.test.js:184-186.
  app.use((err, req, res, _next) => {
    res.status(500).json({ error: err.message, code: err.code, stack: err.stack?.split('\n').slice(0, 5) });
  });
  return app;
}

const TOKEN_HEADER = { 'X-Internal-Token': process.env.INTERNAL_API_TOKEN };

function makePrisma({ admins = [], employees = [], prefsByAdmin = {} } = {}) {
  const emailLogWrites = [];
  const adminDigestRunWrites = [];

  return {
    employee: {
      findMany: jest.fn(async () => employees),
    },
    attendance: {
      findMany: jest.fn(async () => []),
    },
    leaveRequest: {
      findMany: jest.fn(async () => []),
    },
    notificationPreference: {
      findUnique: jest.fn(async ({ where }) => prefsByAdmin[where.employeeId] || null),
    },
    emailLog: {
      create: jest.fn(async ({ data }) => {
        const row = { id: 'log-' + (emailLogWrites.length + 1), ...data };
        emailLogWrites.push(row);
        return row;
      }),
    },
    adminDigestRun: {
      // Atomic claim — honour the @@unique([adminId, scheduledFor])
      // constraint. A second create for the same pair raises P2002 (the
      // route catches that and increments idempotentSkips).
      create: jest.fn(async ({ data }) => {
        const existing = adminDigestRunWrites.find(
          (r) =>
            r.adminId === data.adminId &&
            r.scheduledFor.getTime() === data.scheduledFor.getTime()
        );
        if (existing) {
          const err = new Error('Unique constraint failed on admin_digest_run');
          err.code = 'P2002';
          throw err;
        }
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
  mockFindActiveAdmins.mockResolvedValue([]);
  mockIsConfigured.mockReset();
  mockIsConfigured.mockReturnValue(true);
});

const THREE_ADMINS = [
  { id: 'admin-1', email: 'admin1@example.com', name: 'Admin One' },
  { id: 'admin-2', email: 'admin2@example.com', name: 'Admin Two' },
  { id: 'admin-3', email: 'admin3@example.com', name: 'Admin Three' },
];

async function fire(prisma, dateStr = '2026-09-02') {
  const app = buildApp(prisma);
  return request(app)
    .post(`/api/internal/attendance/digest/run?date=${dateStr}`)
    .set(TOKEN_HEADER);
}

// ─── 1. First fire: 3 admins → 3 SENT, 3 EmailLog, 3 AdminDigestRun ────────

describe('[REPORT-S3-11] first fire pins the audit + bookkeeping rows', () => {
  it('1. first fire: 3 admins → 3 EmailLog SENT + 3 AdminDigestRun SENT', async () => {
    mockFindActiveAdmins.mockResolvedValue(THREE_ADMINS);
    const prisma = makePrisma({
      employees: [{ id: 'emp-1', name: 'Rajesh' }],
    });
    const res = await fire(prisma);
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(3);
    expect(res.body.idempotentSkips).toBe(0);

    // 3 EmailLog rows, all SENT, channel=ADMIN_DIGEST.
    expect(prisma.__emailLogWrites).toHaveLength(3);
    prisma.__emailLogWrites.forEach((row) => {
      expect(row.status).toBe('SENT');
      expect(row.channel).toBe('ADMIN_DIGEST');
    });

    // 3 AdminDigestRun rows, all SENT, each linked to its EmailLog.
    expect(prisma.__adminDigestRunWrites).toHaveLength(3);
    prisma.__adminDigestRunWrites.forEach((row) => {
      expect(row.status).toBe('SENT');
      expect(row.emailLogId).toMatch(/^log-\d+$/);
      expect(row.errorMessage).toBeNull();
    });

    // emailLogId ↔ AdminDigestRun pairing is consistent: the linked
    // EmailLog row exists in __emailLogWrites and matches by id.
    const logIds = new Set(prisma.__emailLogWrites.map((l) => l.id));
    prisma.__adminDigestRunWrites.forEach((row) => {
      expect(logIds.has(row.emailLogId)).toBe(true);
    });
  });
});

// ─── 2. Second fire on the same date: idempotentSkips=3, no new sends ───────

describe('[REPORT-S3-11] second fire on same date is a no-op', () => {
  it('2. second fire: 0 sends, idempotentSkips=3, no new EmailLog rows', async () => {
    mockFindActiveAdmins.mockResolvedValue(THREE_ADMINS);
    const prisma = makePrisma({
      employees: [{ id: 'emp-1', name: 'Rajesh' }],
    });

    // First fire — primes the AdminDigestRun rows.
    const first = await fire(prisma);
    expect(first.status).toBe(200);
    expect(first.body.sent).toBe(3);
    expect(first.body.idempotentSkips).toBe(0);
    const firstLogCount = prisma.__emailLogWrites.length;
    const firstRunCount = prisma.__adminDigestRunWrites.length;
    expect(firstLogCount).toBe(3);
    expect(firstRunCount).toBe(3);

    // Second fire — same date — should be a no-op for sends.
    const second = await fire(prisma);
    expect(second.status).toBe(200);
    expect(second.body.sent).toBe(0);
    expect(second.body.idempotentSkips).toBe(3);
    expect(second.body.failed).toBe(0);

    // No NEW EmailLog rows. The handler short-circuited BEFORE
    // prisma.emailLog.create for every admin.
    expect(prisma.__emailLogWrites.length).toBe(firstLogCount);
    // No NEW AdminDigestRun rows. The P2002 path never reaches update().
    expect(prisma.__adminDigestRunWrites.length).toBe(firstRunCount);
    // sendEmail is never called on the second fire.
    expect(mockSendEmail).toHaveBeenCalledTimes(3); // only the first fire
  });
});

// ─── 3. Different date: idempotency is per-date ────────────────────────────

describe('[REPORT-S3-11] idempotency is keyed on (adminId, scheduledFor)', () => {
  it('3. different ?date= → 3 sends (the scheduledFor key changes)', async () => {
    mockFindActiveAdmins.mockResolvedValue(THREE_ADMINS);
    const prisma = makePrisma({
      employees: [{ id: 'emp-1', name: 'Rajesh' }],
    });

    const first = await fire(prisma, '2026-09-02');
    expect(first.status).toBe(200);
    expect(first.body.sent).toBe(3);
    expect(first.body.idempotentSkips).toBe(0);

    // Different date — fresh scheduledFor — claims succeed.
    const second = await fire(prisma, '2026-09-03');
    expect(second.status).toBe(200);
    expect(second.body.sent).toBe(3);
    expect(second.body.idempotentSkips).toBe(0);

    expect(prisma.__emailLogWrites).toHaveLength(6);
    expect(prisma.__adminDigestRunWrites).toHaveLength(6);
    // Two distinct scheduledFor values present in the run rows.
    const scheduledFors = new Set(
      prisma.__adminDigestRunWrites.map((r) => r.scheduledFor.toISOString())
    );
    expect(scheduledFors.size).toBe(2);
  });
});

// ─── 4. emailEnabled=false: AdminDigestRun row with SKIPPED_OPT_OUT ────────

describe('[REPORT-S3-11] SKIPPED_OPT_OUT bookkeeping path', () => {
  it('4. admin with emailEnabled=false → AdminDigestRun status=SKIPPED_OPT_OUT', async () => {
    mockFindActiveAdmins.mockResolvedValue(THREE_ADMINS);
    const prisma = makePrisma({
      employees: [{ id: 'emp-1', name: 'Rajesh' }],
      prefsByAdmin: { 'admin-2': { emailEnabled: false, typeMutes: {} } },
    });
    const res = await fire(prisma);
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(2);
    expect(res.body.skipped).toBe(1);
    expect(res.body.idempotentSkips).toBe(0);

    // 2 AdminDigestRun SENT + 1 SKIPPED_OPT_OUT. Total 3.
    const runs = prisma.__adminDigestRunWrites;
    expect(runs).toHaveLength(3);
    const skipRow = runs.find((r) => r.adminId === 'admin-2');
    expect(skipRow).toBeDefined();
    expect(skipRow.status).toBe('SKIPPED_OPT_OUT');
    expect(skipRow.emailLogId).toMatch(/^log-\d+$/); // still linked
    expect(skipRow.errorMessage).toBeNull();

    // EmailLog SKIPPED_OPT_OUT row was written and linked.
    const skipLog = prisma.__emailLogWrites.find((l) => l.employeeId === 'admin-2');
    expect(skipLog).toBeDefined();
    expect(skipLog.status).toBe('SKIPPED_OPT_OUT');
    expect(skipRow.emailLogId).toBe(skipLog.id);
  });
});

// ─── 5. typeMutes.ADMIN_ATTENDANCE_DAILY: SKIPPED_TYPE_MUTED ───────────────

describe('[REPORT-S3-11] SKIPPED_TYPE_MUTED bookkeeping path', () => {
  it('5. admin with typeMutes.ADMIN_ATTENDANCE_DAILY → AdminDigestRun status=SKIPPED_TYPE_MUTED', async () => {
    mockFindActiveAdmins.mockResolvedValue(THREE_ADMINS);
    const prisma = makePrisma({
      employees: [{ id: 'emp-1', name: 'Rajesh' }],
      prefsByAdmin: {
        'admin-3': { emailEnabled: true, typeMutes: { ADMIN_ATTENDANCE_DAILY: true } },
      },
    });
    const res = await fire(prisma);
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(2);
    expect(res.body.skipped).toBe(1);
    expect(res.body.idempotentSkips).toBe(0);

    const runs = prisma.__adminDigestRunWrites;
    expect(runs).toHaveLength(3);
    const muteRow = runs.find((r) => r.adminId === 'admin-3');
    expect(muteRow).toBeDefined();
    expect(muteRow.status).toBe('SKIPPED_TYPE_MUTED');
    expect(muteRow.emailLogId).toMatch(/^log-\d+$/);

    const muteLog = prisma.__emailLogWrites.find((l) => l.employeeId === 'admin-3');
    expect(muteLog).toBeDefined();
    expect(muteLog.status).toBe('SKIPPED_TYPE_MUTED');
    expect(muteRow.emailLogId).toBe(muteLog.id);
  });
});

// ─── 6. P2002 path returns 200 (NOT 500) ───────────────────────────────────

describe('[REPORT-S3-11] P2002 from claim is graceful, not an error', () => {
  it('6. P2002 path returns 200 with idempotentSkips > 0 (no 500 escape)', async () => {
    mockFindActiveAdmins.mockResolvedValue(THREE_ADMINS);
    const prisma = makePrisma({
      employees: [{ id: 'emp-1', name: 'Rajesh' }],
    });

    // Pre-populate AdminDigestRun rows for every admin. The handler's
    // very first prisma.adminDigestRun.create throws P2002 for each —
    // we want to assert the route catches that and short-circuits,
    // returning 200 (NOT 500).
    // scheduledFor is IST midnight expressed in UTC: 2026-09-02 IST →
    // 2026-09-01T18:30:00Z (see lib/dateOnly.istMidnightUtcFromDateString).
    const istMidnight20260902 = new Date('2026-09-01T18:30:00.000Z');
    prisma.__adminDigestRunWrites.push(
      { id: 'pre-1', adminId: 'admin-1', scheduledFor: istMidnight20260902, status: 'SENT', emailLogId: null, errorMessage: null },
      { id: 'pre-2', adminId: 'admin-2', scheduledFor: istMidnight20260902, status: 'SENT', emailLogId: null, errorMessage: null },
      { id: 'pre-3', adminId: 'admin-3', scheduledFor: istMidnight20260902, status: 'SENT', emailLogId: null, errorMessage: null },
    );

    const res = await fire(prisma);
    expect(res.status).toBe(200);
    expect(res.body.idempotentSkips).toBe(3);
    expect(res.body.sent).toBe(0);
    expect(res.body.skipped).toBe(0);
    expect(res.body.failed).toBe(0);

    // No EmailLog rows written — the handler never reached that path.
    expect(prisma.__emailLogWrites).toHaveLength(0);
    // No sendEmail calls.
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

// ─── 7. emailLogId is linked on the AdminDigestRun terminal update ─────────

describe('[REPORT-S3-11] terminal update correctly links emailLogId', () => {
  it('7. SENT path: AdminDigestRun.emailLogId points at the SENT EmailLog', async () => {
    mockFindActiveAdmins.mockResolvedValue([THREE_ADMINS[0]]);
    const prisma = makePrisma({
      employees: [{ id: 'emp-1', name: 'Rajesh' }],
    });
    const res = await fire(prisma);
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(1);

    expect(prisma.__adminDigestRunWrites).toHaveLength(1);
    const run = prisma.__adminDigestRunWrites[0];
    expect(run.status).toBe('SENT');
    expect(run.emailLogId).toBeTruthy();

    // The EmailLog row the run points at has status=SENT and matches
    // admin-1 — the audit chain is intact end-to-end.
    const log = prisma.__emailLogWrites.find((l) => l.id === run.emailLogId);
    expect(log).toBeDefined();
    expect(log.status).toBe('SENT');
    expect(log.employeeId).toBe('admin-1');
  });

  it('7b. FAILED path: AdminDigestRun.status=FAILED + errorMessage populated', async () => {
    mockFindActiveAdmins.mockResolvedValue([THREE_ADMINS[0]]);
    mockSendEmail.mockResolvedValueOnce({ ok: false, error: 'Resend 502' });
    const prisma = makePrisma({
      employees: [{ id: 'emp-1', name: 'Rajesh' }],
    });
    const res = await fire(prisma);
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(0);
    expect(res.body.failed).toBe(1);

    const run = prisma.__adminDigestRunWrites[0];
    expect(run.status).toBe('FAILED');
    expect(run.errorMessage).toMatch(/Resend 502/);
    // emailLogId still linked — the FAILED audit row was written.
    expect(run.emailLogId).toBeTruthy();
    const log = prisma.__emailLogWrites.find((l) => l.id === run.emailLogId);
    expect(log.status).toBe('FAILED');
  });
});
