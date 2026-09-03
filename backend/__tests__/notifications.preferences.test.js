// ─────────────────────────────────────────────────────────────────────────────
// Round-25: Notification preferences API tests.
//
// Validates:
//   - GET /preferences returns defaults when no row exists
//   - GET /preferences returns the row when one exists
//   - PUT /preferences upserts partial updates
//   - Unknown notification type in typeMutes → 400
//   - digestHourLocal out of [0,23] → 400
//   - Unknown body field → 400 (no silent ignore)
//   - The route returns the same shape on GET and PUT so the UI can render
//     directly from the response without per-field normalization.
//   - POST /test requires admin (requireFreshAdmin gates it)
//   - POST /test calls sendEmail with the admin's email
//   - POST /test returns 503 with the underlying SMTP error on failure
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const request = require('supertest');

// ─── Mocks ────────────────────────────────────────────────────────────────
// Mock the email transport so POST /test doesn't reach out to Zoho.
jest.mock('../src/lib/email', () => {
  const actual = jest.requireActual('../src/lib/email');
  return {
    ...actual,
    sendEmail: jest.fn(async () => ({ ok: true, messageId: 'mock-msg-1' })),
    isConfigured: jest.fn(() => true),
    close: jest.fn(async () => {}),
    escapeHtml: actual.escapeHtml,
    FROM_EMAIL: 'noreply@acschennai.com',
    FROM_NAME: 'ACS Chennai Portal',
  };
});

// Mock the auth middleware so the test can supply req.employeeId + req.isAdmin
// via headers without minting a real JWT. The mock reads x-test-employee-id
// and x-test-is-admin just like the previous inline shim did, but the route
// file's `requireAuth` reference is now satisfied.
jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    req.employeeId = req.headers['x-test-employee-id'] || 'emp-1';
    req.isAdmin = req.headers['x-test-is-admin'] === '1';
    next();
  },
  // Mirror the real middleware's contract: 401 if no employeeId, 403 if not
  // admin. We let the test set req.employeeId via the requireAuth mock so
  // the no-employeeId branch is reachable by stripping the header.
  requireFreshAdmin: (req, res, next) => {
    if (!req.employeeId) {
      return res.status(401).json({ error: 'Authorization required' });
    }
    if (!req.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  },
  requireAdmin: (req, res, next) => {
    if (!req.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  },
}));

const mockPrisma = {
  notificationPreference: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  },
  employee: {
    findUnique: jest.fn(),
  },
  emailLog: { create: jest.fn() },
};

const app = express();
app.use(express.json());
app.set('prisma', mockPrisma);

const notificationsRoutes = require('../src/routes/notifications');
app.use('/api/notifications', notificationsRoutes);

beforeEach(() => {
  Object.values(mockPrisma.notificationPreference).forEach((fn) => fn.mockReset());
  Object.values(mockPrisma.employee).forEach((fn) => fn.mockReset());
  const sendEmail = require('../src/lib/email').sendEmail;
  sendEmail.mockClear();
  sendEmail.mockResolvedValue({ ok: true, messageId: 'mock-msg-1' });
});

const employeeHeaders = (overrides = {}) => ({
  // Note: NOT setting 'authorization' so requireAuth picks up the mock.
  'x-test-employee-id': 'emp-1',
  'x-test-is-admin': '0',
  ...overrides,
});

// ─── GET /api/notifications/preferences ────────────────────────────────────
describe('GET /api/notifications/preferences', () => {
  it('returns defaults when no row exists', async () => {
    mockPrisma.notificationPreference.findUnique.mockResolvedValue(null);
    const res = await request(app).get('/api/notifications/preferences').set(employeeHeaders());
    expect(res.status).toBe(200);
    expect(res.body.preferences).toMatchObject({
      emailEnabled: true,
      digestEnabled: true,
      typeMutes: {},
      digestHourLocal: 8,
    });
    // types array is always returned so the UI can render toggles without
    // a separate hardcoded list.
    expect(Array.isArray(res.body.types)).toBe(true);
    expect(res.body.types.length).toBe(11);
    expect(res.body.types[0]).toHaveProperty('type');
    expect(res.body.types[0]).toHaveProperty('channel');
  });

  it('returns the persisted row when one exists', async () => {
    mockPrisma.notificationPreference.findUnique.mockResolvedValue({
      emailEnabled: false,
      digestEnabled: true,
      typeMutes: { DPR_REVIEWED: true },
      digestHourLocal: 7,
      updatedAt: new Date('2026-09-01T10:00:00Z'),
    });
    const res = await request(app).get('/api/notifications/preferences').set(employeeHeaders());
    expect(res.status).toBe(200);
    expect(res.body.preferences.emailEnabled).toBe(false);
    expect(res.body.preferences.typeMutes).toEqual({ DPR_REVIEWED: true });
    expect(res.body.preferences.digestHourLocal).toBe(7);
  });
});

// ─── PUT /api/notifications/preferences ────────────────────────────────────
describe('PUT /api/notifications/preferences — upsert partial update', () => {
  it('upserts with only the fields present in the body', async () => {
    mockPrisma.notificationPreference.upsert.mockResolvedValue({
      employeeId: 'emp-1',
      emailEnabled: false,
      digestEnabled: true,
      typeMutes: {},
      digestHourLocal: 8,
      updatedAt: new Date(),
    });
    const res = await request(app)
      .put('/api/notifications/preferences')
      .set(employeeHeaders())
      .send({ emailEnabled: false });
    expect(res.status).toBe(200);
    // Only `emailEnabled` was passed; the upsert must only carry that key.
    const upsertArgs = mockPrisma.notificationPreference.upsert.mock.calls[0][0];
    // The update payload must include employeeId + emailEnabled, but must
    // NOT include the other fields (digestEnabled, typeMutes, digestHourLocal)
    // because the client didn't send them.
    expect(upsertArgs.update).toMatchObject({ employeeId: 'emp-1', emailEnabled: false });
    expect(upsertArgs.update).not.toHaveProperty('digestEnabled');
    expect(upsertArgs.update).not.toHaveProperty('typeMutes');
    expect(upsertArgs.update).not.toHaveProperty('digestHourLocal');
    expect(upsertArgs.where).toEqual({ employeeId: 'emp-1' });
  });

  it('rejects an unknown notification type in typeMutes (400 UNKNOWN_TYPE)', async () => {
    const res = await request(app)
      .put('/api/notifications/preferences')
      .set(employeeHeaders())
      .send({ typeMutes: { DPR_REVIEW: true } }); // typo: missing 'ED'
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNKNOWN_TYPE');
  });

  it('rejects digestHourLocal out of range (400 INVALID_DIGEST_HOUR)', async () => {
    const res = await request(app)
      .put('/api/notifications/preferences')
      .set(employeeHeaders())
      .send({ digestHourLocal: 25 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DIGEST_HOUR');
  });

  it('rejects non-integer digestHourLocal', async () => {
    const res = await request(app)
      .put('/api/notifications/preferences')
      .set(employeeHeaders())
      .send({ digestHourLocal: 8.5 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DIGEST_HOUR');
  });

  it('rejects unknown body fields (no silent ignore)', async () => {
    const res = await request(app)
      .put('/api/notifications/preferences')
      .set(employeeHeaders())
      .send({ ghostField: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNKNOWN_FIELD');
  });

  it('rejects non-object body', async () => {
    const res = await request(app)
      .put('/api/notifications/preferences')
      .set(employeeHeaders())
      .send([1, 2, 3]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });
});

// ─── POST /api/notifications/test (admin-only) ────────────────────────────
describe('POST /api/notifications/test — admin-only SMTP probe', () => {
  it('returns 403 for a non-admin caller', async () => {
    const res = await request(app)
      .post('/api/notifications/test')
      .set(employeeHeaders({ 'x-test-is-admin': '0' }));
    expect(res.status).toBe(403);
    // No employee lookup should have run for a non-admin.
    expect(mockPrisma.employee.findUnique).not.toHaveBeenCalled();
  });

  it('sends a test email to the admin and returns messageId', async () => {
    mockPrisma.employee.findUnique.mockResolvedValue({
      email: 'admin@acschennai.com',
      name: 'Admin',
    });
    const sendEmail = require('../src/lib/email').sendEmail;
    const res = await request(app)
      .post('/api/notifications/test')
      .set(employeeHeaders({ 'x-test-is-admin': '1' }));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.to).toBe('admin@acschennai.com');
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const args = sendEmail.mock.calls[0][0];
    expect(args.to).toBe('admin@acschennai.com');
    expect(args.subject).toContain('test send');
    expect(args.html).toContain('admin@acschennai.com');
  });

  it('returns 400 if the admin has no email on file', async () => {
    mockPrisma.employee.findUnique.mockResolvedValue({ email: null, name: 'Admin' });
    const res = await request(app)
      .post('/api/notifications/test')
      .set(employeeHeaders({ 'x-test-is-admin': '1' }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_EMAIL');
  });

  it('returns 503 when the SMTP send fails, with the underlying error', async () => {
    mockPrisma.employee.findUnique.mockResolvedValue({
      email: 'admin@acschennai.com',
      name: 'Admin',
    });
    const sendEmail = require('../src/lib/email').sendEmail;
    sendEmail.mockResolvedValueOnce({ ok: false, error: 'auth_failed', statusCode: 535 });
    const res = await request(app)
      .post('/api/notifications/test')
      .set(employeeHeaders({ 'x-test-is-admin': '1' }));
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('EMAIL_SEND_FAILED');
    expect(res.body.detail).toBe('auth_failed');
    expect(res.body.statusCode).toBe(535);
  });
});
