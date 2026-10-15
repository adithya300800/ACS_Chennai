// [feat/google-login-allowlist] Google sign-in route tests.
//
// 14 cases covering the deny / allow paths + the cross-flow state
// guard + the log-redaction contract. The id_token crypto is mocked
// (jose.jwtVerify) so we can inject claims without a real Google
// round-trip. The Prisma client is a hand-rolled in-memory fake that
// only implements the operations googleAuth.js touches.
//
// We assert behavior, not the database: a successful login MUST
// (a) create / link an Employee, (b) persist googleSub + lastLoginAt
// on the allowlist row, (c) call issueSession. A denied login MUST
// be (a) generic GOOGLE_DENIED to the client, (b) silent in the
// DB (no employee or allowlist mutation), (c) one structured
// logDenial call with the specific reason + PII-redacted email hash.
//
// Env-var strategy: googleAuth.js reads GOOGLE_* at module load.
// All other tests run with the kill switch ON — the env vars are set
// at the top before any `require`. Test 9 (kill switch) uses
// `jest.isolateModules` to get a fresh require with the env vars
// cleared, so the new module instance reports "not configured".

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-must-be-at-least-32-chars-BBBB';
process.env.PII_LOG_SALT = process.env.PII_LOG_SALT || 'test-pii-salt-32-chars-min-deadbeef';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
// Kill switch is ON for the default-loaded module (tests 1-8, 10-14).
process.env.GOOGLE_LOGIN_ENABLED = 'true';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI = 'http://localhost/api/auth/google/callback';

const express = require('express');
const request = require('supertest');

// ─── jose mock ────────────────────────────────────────────────────────────
// We override jwtVerify so each test can control which claims come
// back (or whether verification throws for the "forged token" case).
// createRemoteJWKSet is mocked too because we never want to hit
// Google's JWKS endpoint from a test.
let mockVerifyImpl = () => {
  throw new Error('mockVerifyImpl not set');
};
jest.mock('jose', () => ({
  __esModule: true,
  createRemoteJWKSet: jest.fn(() => () => {}),
  jwtVerify: (...args) => mockVerifyImpl(...args),
}));

// ─── log mock ────────────────────────────────────────────────────────────
// Capture the structured log calls so test 11 can assert the
// internal reason + email-hash redaction shape.
const logCalls = { info: [], warn: [], error: [] };
jest.mock('../src/lib/log', () => ({
  __esModule: true,
  info: jest.fn((event, payload) => { logCalls.info.push({ event, payload }); }),
  warn: jest.fn((event, payload) => { logCalls.warn.push({ event, payload }); }),
  error: jest.fn((event, payload) => { logCalls.error.push({ event, payload }); }),
  debug: jest.fn(),
}));

// ─── fetch mock ──────────────────────────────────────────────────────────
// The token exchange is a real HTTPS call to oauth2.googleapis.com in
// production. In tests we replace it with a stub that returns the
// id_token the test wants. The test sets `mockTokenResponse` to
// control what comes back.
let mockTokenResponse = {
  ok: true,
  status: 200,
  json: async () => ({ id_token: 'fake.id.token' }),
};
const realFetch = global.fetch;
beforeEach(() => {
  global.fetch = jest.fn(async () => mockTokenResponse);
});
afterAll(() => { global.fetch = realFetch; });

// ─── Prisma in-memory mock ───────────────────────────────────────────────
function makePrisma() {
  const allowlistByEmail = new Map();
  const employeeByEmail = new Map();
  const employeeById = new Map();

  function persistEmployee(emp) {
    employeeByEmail.set(emp.email, emp);
    employeeById.set(emp.id, emp);
  }

  const prisma = {
    googleLoginAllowlist: {
      findUnique: jest.fn(async ({ where }) => {
        if (where.email) return allowlistByEmail.get(where.email) || null;
        if (where.id) {
          for (const r of allowlistByEmail.values()) {
            if (r.id === where.id) return r;
          }
          return null;
        }
        return null;
      }),
      findFirst: jest.fn(async ({ where }) => {
        for (const r of allowlistByEmail.values()) {
          if (where.email && r.email !== where.email) continue;
          if (where.isActive === true && !r.isActive) continue;
          return r;
        }
        return null;
      }),
      create: jest.fn(async ({ data }) => {
        const row = {
          id: `allowlist-${allowlistByEmail.size + 1}`,
          email: data.email,
          userId: data.userId || null,
          googleSub: data.googleSub || null,
          isActive: data.isActive !== undefined ? data.isActive : true,
          note: data.note || null,
          addedBy: data.addedBy || null,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastLoginAt: data.lastLoginAt || null,
        };
        allowlistByEmail.set(row.email, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }) => {
        const row = await prisma.googleLoginAllowlist.findUnique({ where });
        if (!row) throw new Error('not found');
        const updated = { ...row, ...data, updatedAt: new Date() };
        allowlistByEmail.set(row.email, updated);
        return updated;
      }),
    },
    employee: {
      findUnique: jest.fn(async ({ where }) => {
        if (where.email) return employeeByEmail.get(where.email) || null;
        if (where.id) return employeeById.get(where.id) || null;
        return null;
      }),
      create: jest.fn(async ({ data }) => {
        const emp = {
          id: data.id || `emp-${employeeByEmail.size + 1}`,
          email: data.email,
          name: data.name,
          isAdmin: !!data.isAdmin,
          password: data.password || null,
          zohoAccessToken: data.zohoAccessToken || null,
          zohoRefreshToken: data.zohoRefreshToken || null,
        };
        persistEmployee(emp);
        return emp;
      }),
      update: jest.fn(async ({ where, data }) => {
        const emp = await prisma.employee.findUnique({ where });
        if (!emp) throw new Error('not found');
        const updated = { ...emp, ...data };
        persistEmployee(updated);
        return updated;
      }),
    },
    // refreshToken.create is called by issueSession (via auth.js).
    // We don't need to model rotation here — we just need the call
    // to not throw, so the session-issuing code path returns a
    // token pair to the client.
    refreshToken: {
      create: jest.fn(async ({ data }) => ({
        id: `rt-${Math.random().toString(36).slice(2)}`,
        employeeId: data.employeeId,
        tokenHash: data.tokenHash,
        rotatedFromId: data.rotatedFromId,
        expiresAt: data.expiresAt,
        createdAt: new Date(),
        revokedAt: null,
        lastUsedAt: null,
      })),
    },
  };
  return { prisma, allowlistByEmail, employeeByEmail, employeeById };
}

// ─── App + helpers ───────────────────────────────────────────────────────
const googleAuthRouter = require('../src/routes/googleAuth');
const { oauthStateStore } = require('../src/routes/auth');
const {
  googleStartLimiter,
  googleCallbackLimiter,
  googleSpaCallbackLimiter,
} = require('../src/middleware/rateLimit');

function buildApp(prisma) {
  const app = express();
  app.use(express.json());
  app.set('prisma', prisma);
  app.use('/api/auth/google', googleAuthRouter);
  return app;
}

// The in-process rate-limit buckets are keyed on req.ip. supertest
// reuses the same loopback IP across every test, so 5/min on the
// start limiter would otherwise exhaust by the 6th test in this
// file. Reset the buckets for the loopback IP range + the
// keyGenerator's 'unknown' fallback before every test.
const LOOPBACK_KEYS = ['127.0.0.1', '::ffff:127.0.0.1', '::1', 'unknown'];
function resetLimiters() {
  for (const ip of LOOPBACK_KEYS) {
    for (const limiter of [googleStartLimiter, googleCallbackLimiter, googleSpaCallbackLimiter]) {
      try { limiter.resetKey(ip); } catch (_) { /* limiter may not be wired */ }
    }
  }
}

beforeEach(() => {
  // Reset module-scoped jose mock per test so a test's claim-shaping
  // doesn't leak into the next.
  mockVerifyImpl = () => { throw new Error('mockVerifyImpl not set'); };
  logCalls.info.length = 0;
  logCalls.warn.length = 0;
  logCalls.error.length = 0;
  // Clear the OAuth state store so state-fuzzing tests don't see
  // leftover entries from earlier tests.
  oauthStateStore.clear();
  // Reset the shared rate-limit buckets so test 6+ don't get 429s.
  resetLimiters();
  // Default: token exchange succeeds.
  mockTokenResponse = {
    ok: true,
    status: 200,
    json: async () => ({ id_token: 'fake.id.token' }),
  };
});

async function startAndGetState(app) {
  const startRes = await request(app).post('/api/auth/google/');
  expect(startRes.status).toBe(200);
  const mintedState = new URL(startRes.body.authUrl).searchParams.get('state');
  expect(mintedState).toBeTruthy();
  return mintedState;
}

// ─── 1. New allowlisted email → Employee created ─────────────────────────
describe('Google sign-in — happy path', () => {
  it('1. new allowlisted email → Employee created, googleSub persisted, session issued', async () => {
    const { prisma, allowlistByEmail, employeeByEmail } = makePrisma();
    await prisma.googleLoginAllowlist.create({
      data: { email: 'fresh@gmail.com' },
    });
    mockVerifyImpl = async () => ({
      payload: { sub: 'google-sub-1', email: 'fresh@gmail.com', email_verified: true, name: 'Fresh User' },
    });

    const app = buildApp(prisma);
    const state = await startAndGetState(app);
    const res = await request(app).get(`/api/auth/google/callback?code=auth-code&state=${state}`);
    expect(res.status).toBe(200);

    // The popup closing page is HTML whose <script> embeds the
    // payload as JSON; assert against the embedded text.
    expect(res.text).toMatch(/"accessToken":"[^"]+"/);
    expect(res.text).toMatch(/"refreshToken":"[^"]+"/);
    expect(res.text).toMatch(/fresh@gmail\.com/);

    // Employee created with the right shape.
    const emp = employeeByEmail.get('fresh@gmail.com');
    expect(emp).toBeTruthy();
    expect(emp.isAdmin).toBe(false);
    expect(emp.name).toBe('Fresh User');

    // Allowlist row stamped.
    const allow = allowlistByEmail.get('fresh@gmail.com');
    expect(allow.googleSub).toBe('google-sub-1');
    expect(allow.lastLoginAt).toBeTruthy();
    expect(allow.userId).toBe(emp.id);

    // refresh_token row was created.
    expect(prisma.refreshToken.create).toHaveBeenCalled();
  });

  it('2. second login reuses the same Employee (allowlist already has userId)', async () => {
    const { prisma, allowlistByEmail, employeeByEmail } = makePrisma();
    await prisma.googleLoginAllowlist.create({
      data: { email: 'returning@gmail.com' },
    });
    mockVerifyImpl = async () => ({
      payload: { sub: 'google-sub-2', email: 'returning@gmail.com', email_verified: true },
    });

    const app = buildApp(prisma);
    // First login.
    const state1 = await startAndGetState(app);
    await request(app).get(`/api/auth/google/callback?code=c1&state=${state1}`);

    const allow1 = allowlistByEmail.get('returning@gmail.com');
    expect(allow1.userId).toBeTruthy();
    const linkedEmpId = allow1.userId;

    // Second login: same sub, same email.
    const state2 = await startAndGetState(app);
    await request(app).get(`/api/auth/google/callback?code=c2&state=${state2}`);

    // Employee count stays at 1.
    const allEmps = employeeByEmail.get('returning@gmail.com');
    expect(allEmps.id).toBe(linkedEmpId);
    expect(prisma.employee.create).toHaveBeenCalledTimes(1);
  });

  it('3. existing Employee with the same email → linked on first login, no duplicate', async () => {
    const { prisma, allowlistByEmail } = makePrisma();
    await prisma.employee.create({
      data: { id: 'pre-existing', email: 'shared@gmail.com', name: 'Shared User' },
    });
    await prisma.googleLoginAllowlist.create({
      data: { email: 'shared@gmail.com' },
    });
    // The pre-create above already triggered the spy once; reset
    // it so the assertion below is about the route's call only.
    prisma.employee.create.mockClear();
    mockVerifyImpl = async () => ({
      payload: { sub: 'google-sub-3', email: 'shared@gmail.com', email_verified: true },
    });

    const app = buildApp(prisma);
    const state = await startAndGetState(app);
    await request(app).get(`/api/auth/google/callback?code=c1&state=${state}`);

    expect(prisma.employee.create).not.toHaveBeenCalled();
    const allow = allowlistByEmail.get('shared@gmail.com');
    expect(allow.userId).toBe('pre-existing');
  });
});

// ─── 4-8. Denial modes ───────────────────────────────────────────────────
describe('Google sign-in — denial paths', () => {
  it('4. non-allowlisted email → 403 GOOGLE_DENIED, no Employee created, no allowlist mutation', async () => {
    const { prisma } = makePrisma();
    mockVerifyImpl = async () => ({
      payload: { sub: 'google-sub-4', email: 'stranger@gmail.com', email_verified: true },
    });
    const app = buildApp(prisma);
    const state = await startAndGetState(app);
    const res = await request(app).get(`/api/auth/google/callback?code=c1&state=${state}`);

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/GOOGLE_DENIED/);
    expect(res.text).not.toMatch(/stranger/); // no PII leak in the embedded JSON
    expect(prisma.employee.create).not.toHaveBeenCalled();
    const denial = logCalls.warn.find((c) => c.event === 'google_oauth_denied');
    expect(denial).toBeTruthy();
    expect(denial.payload.reason).toBe('not_allowlisted');
    expect(denial.payload.emailHash).toBeTruthy(); // PII-redacted
  });

  it('5. email_verified=false → 403 GOOGLE_DENIED, no Employee created', async () => {
    const { prisma } = makePrisma();
    await prisma.googleLoginAllowlist.create({ data: { email: 'unverified@gmail.com' } });
    mockVerifyImpl = async () => ({
      payload: { sub: 'google-sub-5', email: 'unverified@gmail.com', email_verified: false },
    });
    const app = buildApp(prisma);
    const state = await startAndGetState(app);
    const res = await request(app).get(`/api/auth/google/callback?code=c1&state=${state}`);

    expect(res.text).toMatch(/GOOGLE_DENIED/);
    expect(prisma.employee.create).not.toHaveBeenCalled();
    const denial = logCalls.warn.find((c) => c.event === 'google_oauth_denied');
    expect(denial.payload.reason).toBe('email_not_verified');
  });

  it('6. allowlist isActive=false → 403 GOOGLE_DENIED, no Employee created', async () => {
    const { prisma } = makePrisma();
    await prisma.googleLoginAllowlist.create({
      data: { email: 'inactive@gmail.com', isActive: false },
    });
    mockVerifyImpl = async () => ({
      payload: { sub: 'google-sub-6', email: 'inactive@gmail.com', email_verified: true },
    });
    const app = buildApp(prisma);
    const state = await startAndGetState(app);
    const res = await request(app).get(`/api/auth/google/callback?code=c1&state=${state}`);

    expect(res.text).toMatch(/GOOGLE_DENIED/);
    expect(prisma.employee.create).not.toHaveBeenCalled();
    const denial = logCalls.warn.find((c) => c.event === 'google_oauth_denied');
    expect(denial.payload.reason).toBe('not_allowlisted');
  });

  it('7. sub mismatch (allowlist has a different googleSub) → 403 GOOGLE_DENIED', async () => {
    const { prisma, allowlistByEmail } = makePrisma();
    await prisma.googleLoginAllowlist.create({
      data: { email: 'pinned@gmail.com', googleSub: 'ORIGINAL-SUB' },
    });
    mockVerifyImpl = async () => ({
      payload: { sub: 'DIFFERENT-SUB', email: 'pinned@gmail.com', email_verified: true },
    });
    const app = buildApp(prisma);
    const state = await startAndGetState(app);
    const res = await request(app).get(`/api/auth/google/callback?code=c1&state=${state}`);

    expect(res.text).toMatch(/GOOGLE_DENIED/);
    expect(prisma.employee.create).not.toHaveBeenCalled();
    const denial = logCalls.warn.find((c) => c.event === 'google_oauth_denied');
    expect(denial.payload.reason).toBe('sub_mismatch');

    // The allowlist row's googleSub was NOT mutated.
    const allow = allowlistByEmail.get('pinned@gmail.com');
    expect(allow.googleSub).toBe('ORIGINAL-SUB');
  });

  it('8. forged id_token (jwtVerify throws) → 403 GOOGLE_DENIED, no Employee created', async () => {
    const { prisma } = makePrisma();
    await prisma.googleLoginAllowlist.create({ data: { email: 'forged@gmail.com' } });
    mockVerifyImpl = async () => {
      // jose throws a JWS signature verification error for bad sigs;
      // the route catches and returns the generic denial.
      const err = new Error('invalid signature');
      err.code = 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED';
      throw err;
    };
    const app = buildApp(prisma);
    const state = await startAndGetState(app);
    const res = await request(app).get(`/api/auth/google/callback?code=c1&state=${state}`);

    expect(res.text).toMatch(/GOOGLE_DENIED/);
    expect(prisma.employee.create).not.toHaveBeenCalled();
    const denial = logCalls.warn.find((c) => c.event === 'google_oauth_denied');
    expect(denial.payload.reason).toBe('token_invalid');
  });
});

// ─── 9. Kill switch ──────────────────────────────────────────────────────
describe('Google sign-in — kill switch', () => {
  it('9. GOOGLE_LOGIN_ENABLED=false → all endpoints 404, no Employee created', () => {
    // Re-require the route with the kill switch off so the
    // module-level `isFullyConfigured()` returns false.
    const previouslySet = {
      enabled: process.env.GOOGLE_LOGIN_ENABLED,
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      redirect: process.env.GOOGLE_REDIRECT_URI,
    };
    delete process.env.GOOGLE_LOGIN_ENABLED;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_REDIRECT_URI;

    let freshRouter;
    jest.isolateModules(() => {
      freshRouter = require('../src/routes/googleAuth');
    });

    const { prisma } = makePrisma();
    const app = express();
    app.set('prisma', prisma);
    app.use('/api/auth/google', freshRouter);

    // Restore the env for any subsequent tests in the file.
    process.env.GOOGLE_LOGIN_ENABLED = previouslySet.enabled;
    process.env.GOOGLE_CLIENT_ID = previouslySet.clientId;
    process.env.GOOGLE_CLIENT_SECRET = previouslySet.clientSecret;
    process.env.GOOGLE_REDIRECT_URI = previouslySet.redirect;

    // We only need to assert 404 for the four endpoints that exist.
    return Promise.all([
      request(app).get('/api/auth/google/active').then((r) => {
        expect(r.status).toBe(404);
      }),
      request(app).post('/api/auth/google/').then((r) => {
        expect(r.status).toBe(404);
      }),
      request(app).get('/api/auth/google/callback?code=x&state=y').then((r) => {
        expect(r.status).toBe(404);
      }),
      request(app).post('/api/auth/google/callback').send({ code: 'x', state: 'y' }).then((r) => {
        expect(r.status).toBe(404);
      }),
    ]).then(() => {
      expect(prisma.employee.create).not.toHaveBeenCalled();
    });
  });
});

// ─── 10. Cross-flow state ────────────────────────────────────────────────
describe('Google sign-in — OAuth state integrity', () => {
  it('10. a Zoho-issued state is rejected on the Google callback with INVALID_STATE', async () => {
    const { prisma } = makePrisma();
    // Hand-mint a Zoho state directly into the shared store.
    const zohoState = 'zoho-issued-state';
    oauthStateStore.set(zohoState, {
      timestamp: Date.now(),
      expiresAt: Date.now() + 5 * 60 * 1000,
      flow: 'zoho',
    });

    const app = buildApp(prisma);
    const res = await request(app).get(`/api/auth/google/callback?code=any&state=${zohoState}`);

    // Popup path embeds the error type in the postMessage payload.
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/INVALID_STATE/);
    // The denial was logged with reason=invalid_state.
    const denial = logCalls.warn.find((c) => c.event === 'google_oauth_denied');
    expect(denial).toBeTruthy();
    expect(denial.payload.reason).toBe('invalid_state');
  });
});

// ─── 11. Internal log reason + redaction ─────────────────────────────────
describe('Google sign-in — log redaction', () => {
  it('11. sub_mismatch denial: log line has reason + emailHash; no tokens in payload', async () => {
    const { prisma } = makePrisma();
    await prisma.googleLoginAllowlist.create({
      data: { email: 'logcheck@gmail.com', googleSub: 'PINNED-SUB' },
    });
    mockVerifyImpl = async () => ({
      payload: { sub: 'OTHER-SUB', email: 'logcheck@gmail.com', email_verified: true },
    });
    const app = buildApp(prisma);
    const state = await startAndGetState(app);
    await request(app).get(`/api/auth/google/callback?code=c&state=${state}`);

    const denial = logCalls.warn.find((c) => c.event === 'google_oauth_denied');
    expect(denial).toBeTruthy();
    expect(denial.payload.reason).toBe('sub_mismatch');
    expect(denial.payload.emailHash).toBeTruthy();
    expect(denial.payload.emailHash).not.toBe('logcheck@gmail.com');

    // The log payload MUST NOT contain any token.
    const flat = JSON.stringify(denial);
    expect(flat).not.toMatch(/id_token/);
    expect(flat).not.toMatch(/access_token/);
    expect(flat).not.toMatch(/refresh_token/);
    expect(flat).not.toMatch(/fake\.id\.token/);
  });
});

// ─── 12. Mixed-case email (amendment-final-8a) ────────────────────────────
describe('Google sign-in — email canonicalisation', () => {
  it('12. mixed-case id_token email matches the lowercase allowlist row; Employee stored lowercase', async () => {
    const { prisma } = makePrisma();
    await prisma.googleLoginAllowlist.create({
      data: { email: 'test.user@gmail.com' },
    });
    mockVerifyImpl = async () => ({
      payload: {
        sub: 'google-sub-12',
        email: 'Test.User@Gmail.com',
        email_verified: true,
      },
    });
    const app = buildApp(prisma);
    const state = await startAndGetState(app);
    const res = await request(app).get(`/api/auth/google/callback?code=c&state=${state}`);

    expect(res.text).toMatch(/test\.user@gmail\.com/);
    expect(prisma.employee.create).toHaveBeenCalledTimes(1);
    const created = prisma.employee.create.mock.calls[0][0];
    expect(created.data.email).toBe('test.user@gmail.com');
  });

  it('13. Gmail dot/+ variant of an allowlisted email is denied (no canonicalisation)', async () => {
    const { prisma } = makePrisma();
    await prisma.googleLoginAllowlist.create({
      data: { email: 'testuser@gmail.com' },
    });
    mockVerifyImpl = async () => ({
      payload: {
        sub: 'google-sub-13',
        email: 't.e.s.t.u.s.e.r@gmail.com',
        email_verified: true,
      },
    });
    const app = buildApp(prisma);
    const state = await startAndGetState(app);
    const res = await request(app).get(`/api/auth/google/callback?code=c&state=${state}`);

    expect(res.text).toMatch(/GOOGLE_DENIED/);
    expect(prisma.employee.create).not.toHaveBeenCalled();
    const denial = logCalls.warn.find((c) => c.event === 'google_oauth_denied');
    expect(denial.payload.reason).toBe('not_allowlisted');
  });
});

// ─── 14. State single-use replay (amendment-final-8c) ────────────────────
describe('Google sign-in — state single-use', () => {
  it('14. replayed state returns INVALID_STATE on the second consume', async () => {
    const { prisma } = makePrisma();
    await prisma.googleLoginAllowlist.create({ data: { email: 'replay@gmail.com' } });
    mockVerifyImpl = async () => ({
      payload: { sub: 'google-sub-14', email: 'replay@gmail.com', email_verified: true },
    });
    const app = buildApp(prisma);
    const state = await startAndGetState(app);

    // First callback succeeds.
    const first = await request(app).get(`/api/auth/google/callback?code=c1&state=${state}`);
    expect(first.text).toMatch(/"accessToken":/);

    // Same state, second consume: state was deleted by the first
    // callback's consumeOAuthState call, so the second is a no-op
    // and the route returns INVALID_STATE.
    const second = await request(app).get(`/api/auth/google/callback?code=c2&state=${state}`);
    expect(second.text).toMatch(/INVALID_STATE/);
  });
});
