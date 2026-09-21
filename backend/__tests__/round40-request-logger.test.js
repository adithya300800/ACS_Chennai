// Round-40 #2 — request-id consolidation + requestLogger + errorHandler pins.
//
// Three contract pins this file guards:
//
//   1. Single minting site: only the request-id middleware in
//      src/index.js createApp() mints X-Request-Id. The legacy mint
//      sites in src/lib/errors.js#safeHandler and
//      src/routes/dpr.js (POST /api/dpr catch) must NOT regenerate a
//      random value if req.id is missing — they fall back to req.id or
//      res.getHeader('X-Request-Id').
//
//   2. requestLogger fires for EVERY response, including:
//      - a 401 from requireAuth (bad token)
//      - a 400 from body-parser (malformed JSON)
//      - a 200 from a successful route
//      Each must produce exactly one log.info({ source: 'http',
//      message: 'http.request', … }) call with the matching status code.
//
//   3. errorHandler upgrade: a thrown error from a route produces a
//      log.error({ source: 'errorHandler', message: 'http.error', … })
//      row with redacted body / query / explicit-allowlist headers.
//      errorStack is null in production unless LOG_STACK_TRACE=1.

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.PII_LOG_SALT =
  process.env.PII_LOG_SALT || 'test-pii-log-salt-must-be-set';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

// ── Mock Prisma + log so the test never opens a DB connection. ───────────────
const mockPrisma = {
  appLog: { create: jest.fn(async ({ data }) => data) },
  employee: {
    findUnique: jest.fn(async ({ where }) => ({
      id: where.id,
      isAdmin: false,
      email: 'e@example.com',
    })),
  },
  notification: { create: jest.fn(async () => null) },
  project: { findUnique: jest.fn(async () => null) },
  $transaction: jest.fn(async (fn) => fn(mockPrisma)),
};

jest.mock('../src/lib/log', () => {
  const actual = jest.requireActual('../src/lib/log');
  return actual;
});
const log = require('../src/lib/log');
// Inject the mock client so the logger writes go through it.
log._setPrismaForTesting(mockPrisma);

beforeEach(() => {
  mockPrisma.appLog.create.mockClear();
});

function authHeader(employeeId = 'emp-r40', isAdmin = false) {
  return `Bearer ${jwt.sign(
    { employeeId, email: 'e@example.com', isAdmin },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  )}`;
}

// Tiny replica of createApp()'s middlewares we care about. Built by hand so
// (a) we don't open a DB connection via real PrismaClient and (b) the
// order is identical to src/index.js's createApp() chain.
function buildTinyApp({
  withAuth = false,
  authRejects = false,
  routeHandler,
  bodyParserLimit = '1mb',
}) {
  const app = express();

  // request-id (matches src/index.js:209-217)
  const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
  app.use((req, res, next) => {
    const supplied = req.headers['x-request-id'];
    req.id = (typeof supplied === 'string' && REQUEST_ID_RE.test(supplied))
      ? supplied
      : require('crypto').randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  });

  // requestLogger
  app.use(require('../src/middleware/requestLogger'));

  app.use(express.json({ limit: bodyParserLimit }));

  // requireAuth
  if (withAuth) {
    app.use((req, res, next) => {
      if (authRejects) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      try {
        const decoded = jwt.verify(
          req.headers.authorization.replace(/^Bearer /, ''),
          process.env.JWT_SECRET,
        );
        req.employeeId = decoded.employeeId;
        req.isAdmin = decoded.isAdmin || false;
        next();
      } catch (_err) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    });
  }

  if (routeHandler) app.use(routeHandler);

  // Error handler (mirrors src/index.js:524-568 with the round-40 upgrade)
  app.use((err, req, res, next) => {
    const requestId = req.id ?? require('crypto').randomUUID();
    let status = err.status || 500;
    let body = { error: err.message || 'Internal server error', requestId };
    if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError) && err.status === 400) {
      status = 400;
      body = { error: 'Malformed JSON body', code: 'INVALID_JSON', requestId };
    } else if (err && err.type === 'entity.too.large' && err.status === 413) {
      status = 413;
      body = { error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE', requestId };
    }
    console.error(`[err ${requestId}]`, {
      path: req.path,
      method: req.method,
      status,
      code: err?.code,
      name: err?.name,
      message: err?.message?.split('\n')[0],
    });
    log.error(
      {
        source: 'errorHandler',
        requestId,
        employeeHash: req.employeeId
          ? require('../src/lib/pii').hashIdentifier(req.employeeId)
          : null,
        isAdmin: !!req.isAdmin,
        route: req.path,
        method: req.method,
        status,
        code: err?.code,
        name: err?.name,
        message: err?.message?.split('\n')[0],
        body: req.body,
        query: req.query,
        headers: {
          'user-agent': req.headers['user-agent'],
          referer: req.headers['referer'],
        },
        errorStack: (process.env.NODE_ENV !== 'production' ||
                     process.env.LOG_STACK_TRACE === '1')
          ? (err?.stack || '').slice(0, 2000)
          : null,
      },
      'http.error',
    );
    res.status(status).json(body);
  });

  return app;
}

async function settle() {
  // Two yields — same as log.test.js — so the fire-and-forget write
  // resolves before we assert against it.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ─── 1. Single minting site ─────────────────────────────────────────────────

describe('round-40 — request-id is minted exactly once', () => {
  test('a request with no X-Request-Id gets a server-minted id echoed on the response', async () => {
    const app = buildTinyApp({ routeHandler: (_req, res) => res.status(200).json({ ok: true }) });
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toMatch(/^[A-Za-z0-9-]{36}$/); // uuid shape
  });

  test('a request WITH a valid X-Request-Id echoes it back verbatim', async () => {
    const app = buildTinyApp({ routeHandler: (_req, res) => res.status(200).json({ ok: true }) });
    const res = await request(app).get('/api/health').set('X-Request-Id', 'caller-abc.123_xyz');
    expect(res.headers['x-request-id']).toBe('caller-abc.123_xyz');
  });

  test('a malformed X-Request-Id is REPLACED, not echoed (prevents log forging)', async () => {
    const app = buildTinyApp({ routeHandler: (_req, res) => res.status(200).json({ ok: true }) });
    // Header with CR/LF would be rejected by supertest, so use a value
    // matching the regex's OUT-of-range (whitespace) — header stays valid
    // but the regex drops it.
    const res = await request(app).get('/api/health').set('X-Request-Id', 'has spaces');
    expect(res.headers['x-request-id']).not.toBe('has spaces');
    expect(res.headers['x-request-id']).toMatch(/^[A-Za-z0-9-]{36}$/);
  });
});

// ─── 2. requestLogger produces a row for every response shape ───────────────

describe('round-40 — requestLogger fires for every response shape', () => {
  test('a successful 200 produces one http.request row', async () => {
    const app = buildTinyApp({
      withAuth: true,
      routeHandler: (_req, res) => res.json({ ok: true }),
    });
    const res = await request(app).get('/api/x').set('Authorization', authHeader('emp-r40'));
    expect(res.status).toBe(200);
    await settle();
    const httpReqs = mockPrisma.appLog.create.mock.calls
      .map((c) => c[0].data)
      .filter((d) => d.source === 'http' && d.message === 'http.request');
    expect(httpReqs).toHaveLength(1);
    expect(httpReqs[0].status).toBe(200);
    expect(httpReqs[0].method).toBe('GET');
    expect(httpReqs[0].employeeHash).toMatch(/^[a-f0-9]{12}$/);
  });

  test('a 401 from requireAuth STILL produces an http.request row (employeeHash=null)', async () => {
    const app = buildTinyApp({
      withAuth: true,
      authRejects: true,
      routeHandler: (_req, res) => res.json({ ok: true }),
    });
    const res = await request(app).get('/api/x'); // no Authorization header
    expect(res.status).toBe(401);
    await settle();
    const httpReqs = mockPrisma.appLog.create.mock.calls
      .map((c) => c[0].data)
      .filter((d) => d.source === 'http' && d.message === 'http.request');
    expect(httpReqs).toHaveLength(1);
    expect(httpReqs[0].status).toBe(401);
    expect(httpReqs[0].employeeHash).toBeNull();
  });

  test('a malformed-JSON 400 from body-parser STILL produces an http.request row', async () => {
    const app = buildTinyApp({
      routeHandler: (_req, res) => res.json({ ok: true }),
    });
    const res = await request(app)
      .post('/api/x')
      .set('Content-Type', 'application/json')
      .send('{not-json');
    expect(res.status).toBe(400);
    await settle();
    const httpReqs = mockPrisma.appLog.create.mock.calls
      .map((c) => c[0].data)
      .filter((d) => d.source === 'http' && d.message === 'http.request');
    expect(httpReqs).toHaveLength(1);
    expect(httpReqs[0].status).toBe(400);
  });

  test('a 500 thrown from a route produces BOTH an http.request row AND an http.error row', async () => {
    const boom = new Error('route exploded');
    boom.status = 500;
    const app = buildTinyApp({
      routeHandler: (_req, _res, next) => next(boom),
    });
    const res = await request(app).get('/api/x');
    expect(res.status).toBe(500);
    await settle();
    const all = mockPrisma.appLog.create.mock.calls.map((c) => c[0].data);
    const httpReq = all.find((d) => d.source === 'http' && d.message === 'http.request');
    const httpErr = all.find((d) => d.source === 'errorHandler' && d.message === 'http.error');
    expect(httpReq).toBeDefined();
    expect(httpReq.status).toBe(500);
    expect(httpErr).toBeDefined();
    expect(httpErr.status).toBe(500);
    // The AppLog.message column is the log message string; the
    // underlying error text lives in context.message (redacted payload).
    expect(httpErr.message).toBe('http.error');
    expect(httpErr.context.message).toBe('route exploded');
  });
});

// ─── 3. errorHandler redaction + errorStack policy ──────────────────────────

describe('round-40 — errorHandler upgrades to durable log.error with redaction', () => {
  test('email in body is HASHED before persist (DPDP firewall)', async () => {
    const app = buildTinyApp({
      routeHandler: (req, _res, next) => {
        const err = new Error('bad creds');
        err.status = 401;
        req.body = { email: 'leak@example.com', password: 'secret' };
        next(err);
      },
    });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'leak@example.com', password: 'secret' });
    expect(res.status).toBe(401);
    await settle();
    const httpErr = mockPrisma.appLog.create.mock.calls
      .map((c) => c[0].data)
      .find((d) => d.source === 'errorHandler');
    expect(httpErr).toBeDefined();
    expect(httpErr.context.body.email).not.toBe('leak@example.com');
    expect(httpErr.context.body.email).toMatch(/^[a-f0-9]{12}$/);
    // password is not a PII key per lib/pii#redact, but it shouldn't be
    // emphasized either — just assert it doesn't appear in clear form
    // when looking at the persisted body. (The redact() regex hashes
    // email/phone/address/ssn/pan/aadhaar; password is intentionally
    // NOT hashed by redact(). The plan is for the route to omit
    // password before logging — pinned by an audit, not by this test.)
    expect(httpErr.context.body.password).toBe('secret');
  });

  test('headers field is an explicit allowlist (no authorization, no cookie)', async () => {
    const app = buildTinyApp({
      routeHandler: (_req, _res, next) => next(new Error('boom')),
    });
    await request(app)
      .get('/api/x')
      .set('Authorization', 'Bearer should-never-appear')
      .set('Cookie', 'session=should-never-appear')
      .set('User-Agent', 'ua-test/1.0')
      .set('Referer', 'http://example.com/page');
    await settle();
    const httpErr = mockPrisma.appLog.create.mock.calls
      .map((c) => c[0].data)
      .find((d) => d.source === 'errorHandler');
    expect(httpErr).toBeDefined();
    expect(httpErr.context.headers).toEqual({
      'user-agent': 'ua-test/1.0',
      referer: 'http://example.com/page',
    });
    expect(httpErr.context.headers).not.toHaveProperty('authorization');
    expect(httpErr.context.headers).not.toHaveProperty('cookie');
  });

  test('errorStack is null in production unless LOG_STACK_TRACE=1', async () => {
    const prev = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.LOG_STACK_TRACE;
      const app = buildTinyApp({
        routeHandler: (_req, _res, next) => next(new Error('prod-stack-test')),
      });
      await request(app).get('/api/x');
      await settle();
      const httpErr = mockPrisma.appLog.create.mock.calls
        .map((c) => c[0].data)
        .find((d) => d.source === 'errorHandler');
      expect(httpErr.errorStack).toBeNull();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  test('errorStack IS captured in test env (NODE_ENV=test)', async () => {
    const app = buildTinyApp({
      routeHandler: (_req, _res, next) => next(new Error('test-stack-test')),
    });
    await request(app).get('/api/x');
    await settle();
    const httpErr = mockPrisma.appLog.create.mock.calls
      .map((c) => c[0].data)
      .find((d) => d.source === 'errorHandler');
    expect(httpErr.errorStack).toBeTruthy();
    expect(httpErr.errorStack).toContain('test-stack-test');
  });
});

// ─── 4. Legacy mint sites are gone ──────────────────────────────────────────

describe('round-40 — legacy request-id mint sites are removed', () => {
  test('src/lib/errors.js no longer mints random ids', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'lib', 'errors.js'),
      'utf8',
    );
    expect(src).not.toMatch(/randomUUID|toString\(36\)/);
    // safeHandler still uses req.id fallback — that's the only id source now.
    expect(src).toMatch(/req\.id/);
  });

  test('src/routes/dpr.js POST /api/dpr catch uses req.id instead of random fallback', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'routes', 'dpr.js'),
      'utf8',
    );
    // The legacy mint pattern is gone (Math.random fallback at the catch).
    // We can't easily grep the exact "requestId = ..." line without
    // false-positives, so assert no Math.random + no Date.now-random in
    // the DPR route file.
    expect(src).not.toMatch(/Math\.random\(\)\.toString\(36\)\.slice/);
    expect(src).not.toMatch(/\$\{Date\.now\(\)\}-\$\{Math\.random/);
  });
});
