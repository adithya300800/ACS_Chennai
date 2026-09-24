// DR-007 — Admin attendance digest gate.
//
// Two related sub-bugs closed by the DR-007 fix:
//   (a) The previous inline branch checked ONLY `prefs.emailEnabled ===
//       false` and IGNORED `prefs.digestEnabled === false`. An admin
//       who flipped the digest master switch off in NotificationPreferences
//       still received the daily attendance digest.
//   (b) When the prefs read failed (safeAsync swallowed the error and
//       returned `null`), the downstream code treated missing prefs as
//       "fully opted in" and fired the digest. A degraded preference
//       service silently opted admins in.
//
// Fix contract (audit acceptance: "Digest-off suppresses the attendance
// digest; an unavailable preference service does not silently opt users
// in."):
//   1. Route the per-admin gate through shouldSkipSend(prefs, type,
//      'ADMIN_DIGEST') so digestEnabled is honoured.
//   2. On prefs read failure, write a DEFERRED_PREFS_UNAVAILABLE EmailLog
//      row and skip the send. The status is a new value added to
//      notify.js's STATUS_* vocabulary so the audit trail distinguishes
//      "preference service down" from "user opted out".
//
// Run: cd backend && npx jest --testPathPattern="internal-admin-attendance.dr007"

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

// Prisma mock factory. Splits prefsByAdmin (success) from
// prefsReadShouldThrow (failure) so the new tests can simulate both
// halves of the (a)/(b) audit split without disturbing the existing
// admin-attendance-digest suite.
function makePrisma({
  employees = [],
  attendanceRows = [],
  approvedLeaves = [],
  prefsByAdmin = {},
  prefsReadShouldThrow = false,
  prefsError = new Error('preference service unavailable'),
} = {}) {
  const emailLogWrites = [];
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
      findUnique: jest.fn(async ({ where }) => {
        if (prefsReadShouldThrow) throw prefsError;
        return prefsByAdmin[where.employeeId] || null;
      }),
    },
    emailLog: {
      create: jest.fn(async ({ data }) => {
        emailLogWrites.push(data);
        return { id: 'log-' + emailLogWrites.length, ...data };
      }),
    },
    adminDigestRun: {
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

// ─── (a) digestEnabled gate ───────────────────────────────────────────────

describe('DR-007 — admin digest honours digestEnabled (was silently bypassed)', () => {
  test('1. admin with digestEnabled=false → digest NOT sent, SKIPPED_OPT_OUT logged', async () => {
    // The audit's exact reproduction: an admin turned OFF daily digests
    // in NotificationPreferences but kept emailEnabled=true. The
    // previous inline branch ignored digestEnabled entirely and fired
    // the digest anyway. After the fix the canonical shouldSkipSend
    // helper sees digestEnabled=false and returns skip:true
    // (status=SKIPPED_OPT_OUT — both emailEnabled and digestEnabled
    // map to the same opt-out status per the notify.js contract).
    const prisma = makePrisma({
      employees: [{ id: 'emp-1', name: 'Rajesh' }],
      prefsByAdmin: { 'admin-1': { emailEnabled: true, digestEnabled: false, typeMutes: {} } },
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
    // Terminal AdminDigestRun row also stamps SKIPPED_OPT_OUT — the
    // operator's downstream report sees the same status.
    const adrRows = prisma.__adminDigestRunWrites.filter((r) => r.status === 'SKIPPED_OPT_OUT');
    expect(adrRows).toHaveLength(1);
  });

  test('2. admin with digestEnabled=true + emailEnabled=true → digest sent (happy path unchanged)', async () => {
    // Regression pin: the canonical gate must still send when BOTH
    // toggles are on. The (a) fix only adds the digestEnabled check —
    // it does not narrow the happy path.
    const prisma = makePrisma({
      employees: [{ id: 'emp-1', name: 'Rajesh' }],
      prefsByAdmin: { 'admin-1': { emailEnabled: true, digestEnabled: true, typeMutes: {} } },
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/attendance/digest/run?date=2026-09-02')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(1);
    expect(res.body.skipped).toBe(0);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const sentRows = prisma.__emailLogWrites.filter((r) => r.status === 'SENT');
    expect(sentRows).toHaveLength(1);
    expect(sentRows[0].channel).toBe('ADMIN_DIGEST');
  });

  test('3. admin with NO prefs row (null) → still sent (permissive default preserved)', async () => {
    // The canonical shouldSkipSend treats a missing prefs row as fully
    // enabled (matches the documented contract). The DR-007 fix must
    // NOT regress this — only the *failed-read* path defers. This
    // pins the (a)/(b) split: prefsResult.ok=true + value=null still
    // sends; prefsResult.ok=false defers.
    const prisma = makePrisma({
      employees: [{ id: 'emp-1', name: 'Rajesh' }],
      prefsByAdmin: {}, // findUnique returns null
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/attendance/digest/run?date=2026-09-02')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });
});

// ─── (b) prefs-read-failure deferral ─────────────────────────────────────

describe('DR-007 — admin digest DEFERs when preference service is degraded', () => {
  test('4. findUnique throws → digest NOT sent, DEFERRED_PREFS_UNAVAILABLE logged', async () => {
    // Audit's exact reproduction: the prefs read fails (DB outage /
    // connection-pool exhaustion / transient Prisma error). The
    // previous fallback:null shape let the downstream branch fall
    // through to send. After the fix: sentinel wrapper distinguishes
    // success from failure → DEFERRED_PREFS_UNAVAILABLE + skip.
    const prisma = makePrisma({
      employees: [{ id: 'emp-1', name: 'Rajesh' }],
      prefsReadShouldThrow: true,
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/attendance/digest/run?date=2026-09-02')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(0);
    expect(res.body.skipped).toBe(1);
    expect(mockSendEmail).not.toHaveBeenCalled();
    const deferredRows = prisma.__emailLogWrites.filter(
      (r) => r.status === 'DEFERRED_PREFS_UNAVAILABLE'
    );
    expect(deferredRows).toHaveLength(1);
    expect(deferredRows[0].channel).toBe('ADMIN_DIGEST');
    expect(deferredRows[0].errorMessage).toMatch(/preference service unavailable/i);
    // Terminal AdminDigestRun row also stamps DEFERRED so the operator
    // sees the same status in the digest-run audit.
    const adrRows = prisma.__adminDigestRunWrites.filter(
      (r) => r.status === 'DEFERRED_PREFS_UNAVAILABLE'
    );
    expect(adrRows).toHaveLength(1);
  });

  test('5. mixed cohort: 1 degraded + 1 healthy → 1 deferred, 1 sent', async () => {
    // The fix must apply PER-ADMIN. Two admins where one read fails and
    // the other succeeds: the failure defers, the success sends. This
    // pins that the read-failure detection is per-admin (the safeAsync
    // + sentinel wrapper pattern) and not a route-level trip.
    mockFindActiveAdmins.mockResolvedValue([
      { id: 'admin-1', email: 'admin1@example.com', name: 'Admin One' },
      { id: 'admin-2', email: 'admin2@example.com', name: 'Admin Two' },
    ]);
    // First admin: prefs read fails. Second admin: prefs read succeeds
    // with digestEnabled=true. The mock factory's prefsReadShouldThrow
    // flag is process-wide, so we use a per-call findUnique override
    // to model the per-admin difference.
    const emailLogWrites = [];
    const adminDigestRunWrites = [];
    const prisma = {
      employee: { findMany: jest.fn(async () => [{ id: 'emp-1', name: 'Rajesh' }]) },
      attendance: { findMany: jest.fn(async () => []) },
      leaveRequest: { findMany: jest.fn(async () => []) },
      notificationPreference: {
        findUnique: jest.fn(async ({ where }) => {
          if (where.employeeId === 'admin-1') {
            const err = new Error('preference service unavailable');
            throw err;
          }
          // admin-2: enabled
          return { emailEnabled: true, digestEnabled: true, typeMutes: {} };
        }),
      },
      emailLog: {
        create: jest.fn(async ({ data }) => {
          emailLogWrites.push(data);
          return { id: 'log-' + emailLogWrites.length, ...data };
        }),
      },
      adminDigestRun: {
        create: jest.fn(async ({ data }) => {
          const row = { id: 'adr-' + (adminDigestRunWrites.length + 1), ...data };
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
    };
    const app = buildApp(prisma);
    const res = await request(app)
      .post('/api/internal/attendance/digest/run?date=2026-09-02')
      .set('X-Internal-Token', process.env.INTERNAL_API_TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(1);
    expect(res.body.skipped).toBe(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const deferred = emailLogWrites.filter((r) => r.status === 'DEFERRED_PREFS_UNAVAILABLE');
    const sent = emailLogWrites.filter((r) => r.status === 'SENT');
    expect(deferred).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(deferred[0].employeeId).toBe('admin-1');
    expect(sent[0].employeeId).toBe('admin-2');
  });

  test('6. STATUS_DEFERRED_PREFS_UNAVAILABLE constant is exported from notify.js', async () => {
    // The new status value must be a stable export so callers in other
    // modules (dashboards, reports) can branch on it without
    // hard-coding the string. Importing the symbol directly here is
    // a contract pin for the audit's "log + skip" requirement.
    const notify = require('../src/lib/notify');
    expect(notify.STATUS_DEFERRED_PREFS_UNAVAILABLE).toBe('DEFERRED_PREFS_UNAVAILABLE');
  });
});
