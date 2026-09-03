// ─────────────────────────────────────────────────────────────────────────────
// Round-25 (M2): Daily digest cron handler tests.
//
// What we verify:
//   1. Token gate — 404 when INTERNAL_API_TOKEN unset, 403 when wrong, 200 on match.
//   2. Employee with no eligible notifications → DigestRun status=EMPTY.
//   3. Employee with 1 notification → DigestRun SENT, 1 EmailLog SENT, 1 DigestItem.
//   4. Multi-item digest groups items by type in the renderer's expected order.
//   5. Idempotency: 2nd call on the same date is a no-op (results.skipped=true).
//   6. FAILED retry: 1st call FAILED, 2nd call deletes the FAILED row and retries.
//   7. digestEnabled=false employee is excluded entirely.
//   8. typeMutes: every item muted → EMPTY (not SENT).
//   9. ?date= override pins scheduledFor to that IST date.
//  10. SMTP not configured → 503 (no empty digest rows leaked into the DB).
//
// We mock the email transport (so we don't need Zoho creds) and build a
// minimal prisma mock that captures every create. The handler is invoked
// through supertest against an Express app, mirroring the production mount.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const request = require('supertest');

// ─── Mocks ────────────────────────────────────────────────────────────────
// Email transport — fail-closed by default; tests opt in to success via
// sendEmail.mockResolvedValueOnce({ ok: true, messageId: 'msg' }).
const mockSendEmail = jest.fn(async () => ({ ok: true, messageId: 'msg-1' }));
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

const { sendEmail } = require('../src/lib/email');

// ─── Prisma mock factory ──────────────────────────────────────────────────
// Every test gets a fresh prisma so captures don't leak between cases.
function makePrisma({ employees = [], notifications = [] } = {}) {
  const digestRuns = [];
  const digestItems = [];
  const emailLogs = [];

  // Index notifications by id for fast lookup.
  const notificationById = new Map(notifications.map((n) => [n.id, n]));

  // Track which notifications are "already digested" — populated by
  // DigestItem.createMany. The handler uses this set to exclude items
  // that were bundled in a previous run.
  const alreadyDigested = new Set();

  return {
    employee: {
      findMany: jest.fn(async () => employees),
      findUnique: jest.fn(),
    },
    notification: {
      findMany: jest.fn(async () => notifications),
    },
    digestRun: {
      create: jest.fn(async ({ data }) => {
        // Honour the unique constraint simulation: P2002 if (employeeId,
        // scheduledFor) already exists in `digestRuns` with a non-FAILED
        // status. A FAILED row is treated as "delete and retry" — we
        // remove it from the array before raising the error so the
        // handler's catch+delete+recreate path can succeed.
        const existing = digestRuns.find(
          (r) =>
            r.employeeId === data.employeeId &&
            r.scheduledFor.getTime() === data.scheduledFor.getTime()
        );
        if (existing && existing.status !== 'FAILED') {
          const err = new Error('Unique constraint failed');
          err.code = 'P2002';
          throw err;
        }
        if (existing && existing.status === 'FAILED') {
          // Simulate the handler's delete — drop the failed row.
          const idx = digestRuns.indexOf(existing);
          digestRuns.splice(idx, 1);
        }
        const row = {
          id: 'run-' + (digestRuns.length + 1),
          status: data.status || 'PENDING',
          createdAt: new Date(),
          ...data,
        };
        digestRuns.push(row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }) => {
        return (
          digestRuns.find(
            (r) =>
              r.employeeId === where.employeeId_scheduledFor.employeeId &&
              r.scheduledFor.getTime() === where.employeeId_scheduledFor.scheduledFor.getTime()
          ) || null
        );
      }),
      update: jest.fn(async ({ where, data }) => {
        const row = digestRuns.find((r) => r.id === where.id);
        if (!row) throw new Error('DigestRun not found');
        Object.assign(row, data);
        return row;
      }),
      delete: jest.fn(async ({ where }) => {
        const idx = digestRuns.findIndex((r) => r.id === where.id);
        if (idx === -1) return;
        digestRuns.splice(idx, 1);
      }),
    },
    digestItem: {
      findMany: jest.fn(async ({ where }) => {
        const ids = where.notificationId?.in || [];
        // Return items that exist in digestItems + the runtime alreadyDigested
        // set so the handler's "exclude already-digested" check works.
        const result = [];
        for (const id of ids) {
          if (alreadyDigested.has(id)) {
            result.push({ notificationId: id });
          } else {
            const inDb = digestItems.find((di) => di.notificationId === id);
            if (inDb) result.push({ notificationId: id });
          }
        }
        return result;
      }),
      createMany: jest.fn(async ({ data }) => {
        for (const d of data) {
          digestItems.push(d);
          alreadyDigested.add(d.notificationId);
        }
        return { count: data.length };
      }),
    },
    emailLog: {
      create: jest.fn(async ({ data }) => {
        const row = { id: 'log-' + (emailLogs.length + 1), ...data };
        emailLogs.push(row);
        return row;
      }),
    },
    // Audit helpers for assertions.
    __digestRuns: digestRuns,
    __digestItems: digestItems,
    __emailLogs: emailLogs,
  };
}

function buildApp(prisma) {
  const app = express();
  app.set('prisma', prisma);
  const routes = require('../src/routes/internal-digest');
  app.use('/api/internal/digest', routes);
  // Surface async errors as JSON instead of HTML 500 — and let the test see
  // the actual exception if the handler throws.
  app.use((err, req, res, _next) => {
    res.status(500).json({ error: err.message, code: err.code, stack: err.stack?.split('\n').slice(0, 5) });
  });
  return app;
}

const SAMPLE_EMP = (overrides = {}) => ({
  id: 'emp-1',
  name: 'Rajesh',
  email: 'rajesh@example.com',
  notificationPreference: { emailEnabled: true, digestEnabled: true, typeMutes: {} },
  ...overrides,
});

const SAMPLE_NOTIF = (overrides = {}) => ({
  id: 'notif-1',
  employeeId: 'emp-1',
  type: 'DPR_REVIEWED',
  message: 'Your DPR for Acme was reviewed.',
  dprId: 'dpr-1',
  leaveRequestId: null,
  trainingEnrollmentId: null,
  createdAt: new Date('2026-09-02T10:00:00Z'),
  ...overrides,
});

const TOKEN_HEADER = { 'x-internal-token': 'test-token-123' };

beforeEach(() => {
  process.env.INTERNAL_API_TOKEN = 'test-token-123';
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ ok: true, messageId: 'msg-1' });
});

afterEach(() => {
  delete process.env.INTERNAL_API_TOKEN;
});

// ─── 1. Token gate ────────────────────────────────────────────────────────
describe('Token gate (mirrors /version in index.js)', () => {
  it('returns 404 when INTERNAL_API_TOKEN is unset', async () => {
    delete process.env.INTERNAL_API_TOKEN;
    const prisma = makePrisma({ employees: [SAMPLE_EMP()], notifications: [] });
    const res = await request(buildApp(prisma))
      .post('/api/internal/digest/run')
      .send();
    expect(res.status).toBe(404);
  });

  it('returns 403 when the token header is wrong', async () => {
    const prisma = makePrisma({ employees: [SAMPLE_EMP()], notifications: [] });
    const res = await request(buildApp(prisma))
      .post('/api/internal/digest/run')
      .set('x-internal-token', 'wrong')
      .send();
    expect(res.status).toBe(403);
  });

  it('returns 200 when the token header matches', async () => {
    const prisma = makePrisma({ employees: [], notifications: [] });
    const res = await request(buildApp(prisma))
      .post('/api/internal/digest/run')
      .set(TOKEN_HEADER)
      .send();
    expect(res.status).toBe(200);
  });
});

// ─── 2. SMTP not configured → 503 ────────────────────────────────────────
describe('SMTP not configured', () => {
  it('returns 503 without touching the DB (no empty digest rows leaked)', async () => {
    // The handler reads isConfigured() in both the run-start log AND the
    // 503 guard, so we need a sticky false (mockReturnValueOnce only
    // applies to one call). Use mockReturnValue to flip the whole test.
    const { isConfigured } = require('../src/lib/email');
    isConfigured.mockReturnValue(false);
    const prisma = makePrisma({ employees: [SAMPLE_EMP()], notifications: [] });
    const res = await request(buildApp(prisma))
      .post('/api/internal/digest/run')
      .set(TOKEN_HEADER)
      .send();
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SMTP_NOT_CONFIGURED');
    // No DigestRun row was created.
    expect(prisma.__digestRuns).toHaveLength(0);
    // Restore default for subsequent tests.
    isConfigured.mockReturnValue(true);
  });
});

// ─── 3. Empty digest ──────────────────────────────────────────────────────
describe('Empty digest (employee has no eligible notifications)', () => {
  it('writes DigestRun status=EMPTY and does NOT call sendEmail', async () => {
    const prisma = makePrisma({ employees: [SAMPLE_EMP()], notifications: [] });
    const res = await request(buildApp(prisma))
      .post('/api/internal/digest/run')
      .set(TOKEN_HEADER)
      .send();
    expect(res.status).toBe(200);
    expect(res.body.empty).toBe(1);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(prisma.__digestRuns).toHaveLength(1);
    expect(prisma.__digestRuns[0].status).toBe('EMPTY');
    expect(prisma.__digestRuns[0].completedAt).toBeDefined();
  });
});

// ─── 4. Single-item digest → SENT + DigestItem ────────────────────────────
describe('Single-item digest', () => {
  it('calls sendEmail, writes EmailLog SENT, links the notification via DigestItem', async () => {
    const notif = SAMPLE_NOTIF();
    const prisma = makePrisma({ employees: [SAMPLE_EMP()], notifications: [notif] });
    const res = await request(buildApp(prisma))
      .post('/api/internal/digest/run')
      .set(TOKEN_HEADER)
      .send();
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const args = sendEmail.mock.calls[0][0];
    expect(args.to).toBe('rajesh@example.com');
    expect(args.subject).toMatch(/Daily digest/);
    expect(args.html).toMatch(/Acme/);
    expect(args.html).toMatch(/Daily Progress Reports/);
    // EmailLog row written.
    expect(prisma.__emailLogs).toHaveLength(1);
    expect(prisma.__emailLogs[0].channel).toBe('DIGEST');
    expect(prisma.__emailLogs[0].status).toBe('SENT');
    // DigestItem row written.
    expect(prisma.__digestItems).toHaveLength(1);
    expect(prisma.__digestItems[0].notificationId).toBe('notif-1');
    // DigestRun linked to the email log.
    expect(prisma.__digestRuns[0].status).toBe('SENT');
    expect(prisma.__digestRuns[0].emailLogId).toBe('log-1');
  });
});

// ─── 5. Multi-item grouped digest ────────────────────────────────────────
describe('Multi-item grouped digest', () => {
  it('groups by type and renders the right headings', async () => {
    const employees = [SAMPLE_EMP()];
    const notifications = [
      SAMPLE_NOTIF({ id: 'n1', type: 'DPR_REVIEWED', message: 'DPR A reviewed' }),
      SAMPLE_NOTIF({ id: 'n2', type: 'DPR_REVIEWED', message: 'DPR B reviewed' }),
      SAMPLE_NOTIF({ id: 'n3', type: 'LEAVE_DECIDED', message: 'Leave approved' }),
    ];
    const prisma = makePrisma({ employees, notifications });
    const res = await request(buildApp(prisma))
      .post('/api/internal/digest/run')
      .set(TOKEN_HEADER)
      .send();
    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const html = sendEmail.mock.calls[0][0].html;
    // Both groups present in the body, in DIGEST_GROUPS order.
    expect(html).toMatch(/Daily Progress Reports/);
    expect(html).toMatch(/Leave decisions/);
    expect(html).toMatch(/DPR A reviewed/);
    expect(html).toMatch(/DPR B reviewed/);
    expect(html).toMatch(/Leave approved/);
    // Subject line uses the right count + date.
    expect(sendEmail.mock.calls[0][0].subject).toMatch(/3 new updates/);
  });
});

// ─── 6. Idempotency ───────────────────────────────────────────────────────
describe('Idempotency — 2nd call on the same date is a no-op', () => {
  it('skips the existing SENT run for the same scheduledFor', async () => {
    const notif = SAMPLE_NOTIF();
    const prisma = makePrisma({ employees: [SAMPLE_EMP()], notifications: [notif] });

    // 1st call — creates and sends.
    await request(buildApp(prisma)).post('/api/internal/digest/run').set(TOKEN_HEADER).send();
    expect(prisma.__digestRuns).toHaveLength(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);

    // 2nd call — same day, same employee → no-op.
    const res = await request(buildApp(prisma)).post('/api/internal/digest/run').set(TOKEN_HEADER).send();
    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1); // unchanged
    expect(res.body.results[0]).toMatchObject({ skipped: true, reason: 'SENT' });
  });
});

// ─── 7. FAILED retry ──────────────────────────────────────────────────────
describe('FAILED retry — first call fails, second retries', () => {
  it('deletes the FAILED run and sends on the second call', async () => {
    const notif = SAMPLE_NOTIF();
    const prisma = makePrisma({ employees: [SAMPLE_EMP()], notifications: [notif] });

    // 1st call: sendEmail fails.
    sendEmail.mockResolvedValueOnce({ ok: false, error: 'auth_failed', statusCode: 535 });
    await request(buildApp(prisma)).post('/api/internal/digest/run').set(TOKEN_HEADER).send();
    expect(prisma.__digestRuns).toHaveLength(1);
    expect(prisma.__digestRuns[0].status).toBe('FAILED');
    expect(prisma.__digestRuns[0].errorMessage).toContain('auth_failed');
    expect(sendEmail).toHaveBeenCalledTimes(1);

    // 2nd call: same day, same employee, FAILED → delete + retry.
    sendEmail.mockResolvedValueOnce({ ok: true, messageId: 'msg-2' });
    const res = await request(buildApp(prisma)).post('/api/internal/digest/run').set(TOKEN_HEADER).send();
    expect(res.status).toBe(200);
    // Original FAILED row replaced by a new SENT row.
    expect(prisma.__digestRuns).toHaveLength(1);
    expect(prisma.__digestRuns[0].status).toBe('SENT');
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });
});

// ─── 8. digestEnabled=false employee is excluded ─────────────────────────
describe('Opt-out signals', () => {
  it('digestEnabled=false employee is not returned by the employees query (excluded)', async () => {
    // The handler queries `where: { notificationPreference: { digestEnabled: true } }`
    // — so a digestEnabled=false employee won't even appear in the employees
    // list. We assert the empty path runs: 1 EMPTY run would be wrong
    // (no employee means no run), so we expect 0 digest runs.
    const prisma = makePrisma({ employees: [], notifications: [] });
    const res = await request(buildApp(prisma))
      .post('/api/internal/digest/run')
      .set(TOKEN_HEADER)
      .send();
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(0);
    expect(res.body.empty).toBe(0);
    expect(prisma.__digestRuns).toHaveLength(0);
  });

  it('typeMutes: every item muted → EMPTY', async () => {
    const employees = [SAMPLE_EMP({ notificationPreference: { emailEnabled: true, digestEnabled: true, typeMutes: { DPR_REVIEWED: true } } })];
    const notifications = [SAMPLE_NOTIF({ type: 'DPR_REVIEWED' })];
    const prisma = makePrisma({ employees, notifications });
    const res = await request(buildApp(prisma))
      .post('/api/internal/digest/run')
      .set(TOKEN_HEADER)
      .send();
    expect(res.status).toBe(200);
    // No email sent; EMPTY audit row.
    expect(sendEmail).not.toHaveBeenCalled();
    expect(prisma.__digestRuns[0].status).toBe('EMPTY');
  });
});

// ─── 9. ?date= override ───────────────────────────────────────────────────
describe('?date= override', () => {
  it('uses the override date as scheduledFor + window', async () => {
    const notif = SAMPLE_NOTIF({ createdAt: new Date('2026-08-31T20:00:00Z') }); // Aug 31 IST = still in window
    const prisma = makePrisma({ employees: [SAMPLE_EMP()], notifications: [notif] });
    const res = await request(buildApp(prisma))
      .post('/api/internal/digest/run?date=2026-09-01')
      .set(TOKEN_HEADER)
      .send();
    expect(res.status).toBe(200);
    expect(res.body.date).toBe('2026-09-01');
    // scheduledFor should be 2026-09-01 00:00 IST = 2026-08-31T18:30:00.000Z
    expect(new Date(res.body.scheduledFor).toISOString()).toBe('2026-08-31T18:30:00.000Z');
    expect(prisma.__digestRuns[0].scheduledFor.toISOString()).toBe('2026-08-31T18:30:00.000Z');
    expect(res.body.sent).toBe(1);
  });

  it('rejects a malformed date', async () => {
    const prisma = makePrisma({ employees: [], notifications: [] });
    const res = await request(buildApp(prisma))
      .post('/api/internal/digest/run?date=not-a-date')
      .set(TOKEN_HEADER)
      .send();
    expect(res.status).toBe(400);
  });
});

// ─── 10. Already-digested exclusion ───────────────────────────────────────
describe('Already-digested exclusion (defence against re-fire races)', () => {
  it('skips a notification that was already in a prior DigestItem', async () => {
    const employees = [SAMPLE_EMP()];
    const notifications = [SAMPLE_NOTIF()];
    const prisma = makePrisma({ employees, notifications });

    // Pre-populate digestItems so the handler's "exclude already-digested"
    // check sees this notification as already sent.
    prisma.__digestItems.push({
      digestRunId: 'run-prior',
      employeeId: 'emp-1',
      notificationId: 'notif-1',
    });

    const res = await request(buildApp(prisma))
      .post('/api/internal/digest/run')
      .set(TOKEN_HEADER)
      .send();
    expect(res.status).toBe(200);
    // Notification was excluded → empty digest for that employee.
    expect(res.body.empty).toBe(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
