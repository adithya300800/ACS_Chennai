// ─────────────────────────────────────────────────────────────────────────────
// Round-25: Email fan-out contract tests.
//
// Pins the dispatch helper's behavior so a future refactor doesn't silently
// change which notification types fire immediately vs. queue for digest, or
// regress any of the three opt-out signals (master emailEnabled, per-type
// mute, missing address).
//
// What we verify:
//   1. CRITICAL_TYPES set membership — single source of truth.
//   2. sendImmediate path → calls sendEmail + writes EmailLog with channel=IMMEDIATE.
//   3. enqueueForDigest path → writes EmailLog with channel=DIGEST, status=QUEUED.
//   4. emailEnabled=false → no send, EmailLog SKIPPED_OPT_OUT.
//   5. typeMutes[TYPE]=true → no send, EmailLog SKIPPED_TYPE_MUTED.
//   6. Employee has no email → no send, EmailLog SKIPPED_NO_ADDRESS.
//   7. sendEmail returns ok:false → EmailLog status=FAILED with errorMessage captured.
//   8. sendEmail returns ok:true → EmailLog status=SENT with providerMessageId.
//   9. Helper NEVER throws — a broken template must not escape the fan-out envelope.
//  10. isCritical() returns the right boolean for every defined type.
//
// We mock both the email transport (sendEmail) and the prisma client so the
// test is fully isolated — no DB, no SMTP, no network.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Email transport mock (no out-of-scope variable references) ────────────
//
// The jest.mock() factory must be self-contained (Jest hoists it to the top
// of the file BEFORE any other code runs, so it cannot close over module-
// level lets). We expose the underlying jest.fn so each test can override the
// return value with mockResolvedValueOnce / mockResolvedValue.
const mockSendEmail = jest.fn(async () => ({ ok: true, messageId: 'test-message-id' }));
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

const { fanOutEmail, sendImmediate, enqueueForDigest, isCritical, CRITICAL_TYPES } = require('../src/lib/notify');
const { sendEmail } = require('../src/lib/email');

// ─── Prisma mock factory ───────────────────────────────────────────────────
// Each test gets a fresh prisma so __emailLogWrites is per-test.
function makePrisma({ prefs = null, employee = { email: 'user@example.com' } } = {}) {
  const emailLogWrites = [];
  return {
    notificationPreference: {
      findUnique: jest.fn(async () => prefs),
    },
    employee: {
      findUnique: jest.fn(async () => employee),
    },
    emailLog: {
      create: jest.fn(async ({ data }) => {
        emailLogWrites.push(data);
        return { id: 'log-' + emailLogWrites.length, ...data };
      }),
    },
    // Audit helper — lets tests inspect what got written.
    __emailLogWrites: emailLogWrites,
  };
}

const sampleNotification = (overrides = {}) => ({
  id: 'notif-1',
  employeeId: 'emp-1',
  type: 'DPR_APPROVED',
  dprId: 'dpr-1',
  message: 'Your DPR was approved.',
  ...overrides,
});

beforeEach(() => {
  // Default: sendEmail returns ok=true with a messageId. Tests that want a
  // failure path override with mockResolvedValueOnce.
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ ok: true, messageId: 'test-message-id' });
});

// ─── 1. CRITICAL_TYPES membership ──────────────────────────────────────────
describe('CRITICAL_TYPES — single source of truth for immediate-vs-digest split', () => {
  it('contains the 5 critical types per user spec', () => {
    expect(CRITICAL_TYPES.has('TRAINING_ASSIGNED')).toBe(true);
    expect(CRITICAL_TYPES.has('TRAINING_CANCELLED')).toBe(true);
    expect(CRITICAL_TYPES.has('DPR_APPROVED')).toBe(true);
    expect(CRITICAL_TYPES.has('DPR_REJECTED')).toBe(true);
    expect(CRITICAL_TYPES.has('INSPECTION_REJECTED')).toBe(true);
  });

  it('does NOT contain the 6 informational (digest) types', () => {
    const digestTypes = [
      'DPR_REVIEWED',
      'INSPECTION_ACKNOWLEDGED',
      'INSPECTION_CLOSED',
      'LEAVE_DECIDED',
      'TRAINING_IN_PROGRESS',
      'TRAINING_COMPLETED',
    ];
    for (const t of digestTypes) {
      expect(CRITICAL_TYPES.has(t)).toBe(false);
    }
  });

  it('isCritical() returns true for critical types, false otherwise', () => {
    expect(isCritical('DPR_APPROVED')).toBe(true);
    expect(isCritical('DPR_REVIEWED')).toBe(false);
    expect(isCritical('LEAVE_DECIDED')).toBe(false);
    expect(isCritical('UNKNOWN_TYPE')).toBe(false);
  });
});

// ─── 2. sendImmediate path ─────────────────────────────────────────────────
describe('sendImmediate — critical types fire email', () => {
  it('calls sendEmail with rendered subject + html for DPR_APPROVED', async () => {
    const prisma = makePrisma();
    await sendImmediate(sampleNotification({ type: 'DPR_APPROVED' }), prisma, { projectName: 'Acme', reportDate: '2026-09-03' });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const args = sendEmail.mock.calls[0][0];
    expect(args.to).toBe('user@example.com');
    expect(args.subject).toMatch(/DPR for Acme was approved/);
    expect(args.html).toMatch(/Acme/);
  });

  it('writes EmailLog status=SENT with providerMessageId on success', async () => {
    sendEmail.mockResolvedValueOnce({ ok: true, messageId: 'zoho-msg-abc' });
    const prisma = makePrisma();
    await sendImmediate(sampleNotification(), prisma, { projectName: 'X', reportDate: '2026-09-03' });
    expect(prisma.__emailLogWrites).toHaveLength(1);
    const w = prisma.__emailLogWrites[0];
    expect(w.channel).toBe('IMMEDIATE');
    expect(w.status).toBe('SENT');
    expect(w.providerMessageId).toBe('zoho-msg-abc');
    expect(w.recipientEmail).toBe('user@example.com');
    expect(w.errorMessage).toBeNull();
  });

  it('writes EmailLog status=FAILED with errorMessage when SMTP returns ok:false', async () => {
    sendEmail.mockResolvedValueOnce({ ok: false, error: 'auth_failed', statusCode: 535 });
    const prisma = makePrisma();
    await sendImmediate(sampleNotification(), prisma, { projectName: 'X', reportDate: '2026-09-03' });
    expect(prisma.__emailLogWrites).toHaveLength(1);
    const w = prisma.__emailLogWrites[0];
    expect(w.status).toBe('FAILED');
    expect(w.errorMessage).toContain('auth_failed');
    expect(w.providerMessageId).toBeNull();
  });
});

// ─── 3. enqueueForDigest path ─────────────────────────────────────────────
describe('enqueueForDigest — informational types queue for the daily digest', () => {
  it('does NOT call sendEmail', async () => {
    const prisma = makePrisma();
    await enqueueForDigest(sampleNotification({ type: 'DPR_REVIEWED' }), prisma, { projectName: 'X' });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('writes EmailLog channel=DIGEST status=QUEUED with recipient email', async () => {
    const prisma = makePrisma();
    await enqueueForDigest(sampleNotification({ type: 'LEAVE_DECIDED' }), prisma);
    expect(prisma.__emailLogWrites).toHaveLength(1);
    const w = prisma.__emailLogWrites[0];
    expect(w.channel).toBe('DIGEST');
    expect(w.status).toBe('QUEUED');
    expect(w.recipientEmail).toBe('user@example.com');
  });
});

// ─── 4. emailEnabled = false → SKIPPED_OPT_OUT ─────────────────────────────
describe('Opt-out signals are honoured', () => {
  it('emailEnabled=false → no send, EmailLog SKIPPED_OPT_OUT (IMMEDIATE)', async () => {
    const prisma = makePrisma({ prefs: { emailEnabled: false, typeMutes: {}, digestEnabled: true } });
    await sendImmediate(sampleNotification(), prisma, { projectName: 'X' });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(prisma.__emailLogWrites[0].status).toBe('SKIPPED_OPT_OUT');
    expect(prisma.__emailLogWrites[0].channel).toBe('IMMEDIATE');
  });

  it('typeMutes[DPR_APPROVED]=true → no send, EmailLog SKIPPED_TYPE_MUTED', async () => {
    const prisma = makePrisma({ prefs: { emailEnabled: true, typeMutes: { DPR_APPROVED: true } } });
    await sendImmediate(sampleNotification({ type: 'DPR_APPROVED' }), prisma, { projectName: 'X' });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(prisma.__emailLogWrites[0].status).toBe('SKIPPED_TYPE_MUTED');
  });

  it('missing employee email → no send, EmailLog SKIPPED_NO_ADDRESS', async () => {
    const prisma = makePrisma({ employee: { email: null } });
    await sendImmediate(sampleNotification(), prisma, { projectName: 'X' });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(prisma.__emailLogWrites[0].status).toBe('SKIPPED_NO_ADDRESS');
  });

  it('digestEnabled=false → no queue for digest types', async () => {
    const prisma = makePrisma({ prefs: { emailEnabled: true, digestEnabled: false } });
    await enqueueForDigest(sampleNotification({ type: 'DPR_REVIEWED' }), prisma);
    expect(prisma.__emailLogWrites[0].status).toBe('SKIPPED_OPT_OUT');
    expect(prisma.__emailLogWrites[0].errorMessage).toContain('digest');
  });

  it('no preferences row (first-time user) → defaults to all-on, no skip', async () => {
    const prisma = makePrisma({ prefs: null });
    await sendImmediate(sampleNotification(), prisma, { projectName: 'X', reportDate: '2026-09-03' });
    expect(sendEmail).toHaveBeenCalled();
    expect(prisma.__emailLogWrites[0].status).toBe('SENT');
  });
});

// ─── 5. fanOutEmail dispatch ───────────────────────────────────────────────
describe('fanOutEmail — routes by type', () => {
  it('DPR_APPROVED (critical) → calls sendImmediate → SENT', async () => {
    const prisma = makePrisma();
    await fanOutEmail(sampleNotification({ type: 'DPR_APPROVED' }), prisma, { projectName: 'X' });
    expect(sendEmail).toHaveBeenCalled();
    expect(prisma.__emailLogWrites[0].channel).toBe('IMMEDIATE');
    expect(prisma.__emailLogWrites[0].status).toBe('SENT');
  });

  it('LEAVE_DECIDED (digest) → calls enqueueForDigest → QUEUED', async () => {
    const prisma = makePrisma();
    await fanOutEmail(sampleNotification({ type: 'LEAVE_DECIDED' }), prisma);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(prisma.__emailLogWrites[0].channel).toBe('DIGEST');
    expect(prisma.__emailLogWrites[0].status).toBe('QUEUED');
  });

  it('ignores malformed notifications (no employeeId) — does not call sendEmail', async () => {
    const prisma = makePrisma();
    await fanOutEmail({ id: 'x', type: 'DPR_APPROVED' /* no employeeId */ }, prisma);
    await fanOutEmail({ id: 'x', employeeId: 'e' /* no type */ }, prisma);
    await fanOutEmail(null, prisma);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(prisma.__emailLogWrites).toHaveLength(0);
  });

  it('does NOT throw when prisma is missing', async () => {
    await expect(fanOutEmail(sampleNotification(), null)).resolves.toBeUndefined();
  });
});

// ─── 6. NEVER-THROW contract ───────────────────────────────────────────────
describe('Helper never throws — even on broken SMTP transport', () => {
  // We test the never-throw guarantee via a realistic failure mode: the
  // transport itself throws mid-send (TCP reset, socket hang up). notify.js
  // has no try/catch around the `await sendEmail()` call inside sendImmediate,
  // so this error must be caught by fanOutEmail's outer catch and must NOT
  // propagate to the caller.
  //
  // Mutating `templates.renderTemplate` would not work here because notify.js
  // destructures the function at require-time, so the local reference is
  // locked; the actual transport layer (email.js) is also a one-shot
  // require. sendEmail IS reassigned per test (it is the mockSendEmail fn
  // reference), so we can flip its implementation to throw.
  it('fanOutEmail does not throw when sendEmail throws (transport mid-send failure)', async () => {
    const prisma = makePrisma();
    sendEmail.mockImplementationOnce(async () => { throw new Error('connection reset'); });
    // The whole point: the call returns normally; no throw escapes.
    await expect(fanOutEmail(sampleNotification({ type: 'DPR_APPROVED' }), prisma, { projectName: 'X' }))
      .resolves.toBeUndefined();
  });

  it('sendImmediate does not throw when prisma.employee lookup rejects (transient DB blip)', async () => {
    const prisma = makePrisma();
    prisma.employee.findUnique.mockRejectedValueOnce(new Error('connection terminated'));
    // The inner try/catch in sendImmediate swallows this and returns; the
    // outer try/catch in fanOutEmail is defence in depth.
    await expect(sendImmediate(sampleNotification(), prisma, { projectName: 'X' }))
      .resolves.toBeUndefined();
  });
});
