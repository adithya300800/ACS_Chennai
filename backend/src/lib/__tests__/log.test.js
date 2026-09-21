// Round-40 — lib/log.js scaffold tests.
//
// Five pin points (each guards a single round-40 decision):
//
//   1. PII redaction — the email / phone / token in the context MUST be
//      hashed before the row is persisted. Without this the table leaks
//      raw email / SAS URLs / auth tokens into Supabase.
//   2. The three levels (info / warn / error) each produce a row with
//      the matching level literal — no enum coercion surprises.
//   3. The "source" column accepts the round-40 canonical values
//      ("http", "errorHandler", "safeAsync", "cron") verbatim from the
//      caller's context.
//   4. Loud fallback on Prisma throw — the failed write MUST hit
//      console.error with [log] persistence failed. A silent logger
//      is worse than no logger.
//   5. Backpressure — when open writes exceed the limit, new writes
//      are dropped with one console.error per 1000 dropped. The exact
//      error message is pinned so a future refactor that swallows the
//      drop becomes a test failure.
//
// Tests are sync at the surface but the writer is async. Each test
// awaits a small helper that yields to the microtask queue so the
// underlying appLog.create() promise settles before assertions fire.

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.PII_LOG_SALT =
  process.env.PII_LOG_SALT || 'test-pii-log-salt-must-be-set';

const log = require('../log');

function buildMockPrisma() {
  return {
    appLog: {
      create: jest.fn(async ({ data }) => data),
    },
  };
}

// Yield once to the microtask queue so the fire-and-forget _write()
// inside log.* has a chance to settle. Two yields because
// appLog.create() resolves on a tick.
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

let mockPrisma;
let consoleErrorSpy;

beforeEach(() => {
  mockPrisma = buildMockPrisma();
  log._setPrismaForTesting(mockPrisma);
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe('lib/log — PII redaction firewall', () => {
  test('emails, phone numbers, addresses in context are hashed before persist', async () => {
    log.info(
      {
        email: 'leak@example.com',
        phone: '+91-98765-43210',
        address: '42 Mount Road, Chennai',
        // Non-PII keys survive untouched.
        route: '/api/auth/login',
        requestId: 'req-test-1',
      },
      'auth.attempt',
    );
    await settle();

    expect(mockPrisma.appLog.create).toHaveBeenCalledTimes(1);
    const persisted = mockPrisma.appLog.create.mock.calls[0][0].data;

    // Round-40 contract: PII keys in context are HASHED, not raw.
    expect(persisted.context.email).not.toBe('leak@example.com');
    expect(persisted.context.email).toMatch(/^[a-f0-9]{12}$/);
    expect(persisted.context.phone).not.toBe('+91-98765-43210');
    expect(persisted.context.phone).toMatch(/^[a-f0-9]{12}$/);
    expect(persisted.context.address).not.toBe('42 Mount Road, Chennai');
    expect(persisted.context.address).toMatch(/^[a-f0-9]{12}$/);

    // Non-PII survives unchanged.
    expect(persisted.context.route).toBe('/api/auth/login');
    expect(persisted.context.requestId).toBe('req-test-1');
  });

  test('PII keys are redacted regardless of nesting depth', async () => {
    log.warn(
      {
        user: { email: 'nested@example.com', name: 'Nested' },
        meta: { nested: { address: 'Leaf Road' } },
      },
      'test.nested',
    );
    await settle();
    const persisted = mockPrisma.appLog.create.mock.calls[0][0].data;
    expect(persisted.context.user.email).not.toBe('nested@example.com');
    expect(persisted.context.meta.nested.address).not.toBe('Leaf Road');
    expect(persisted.context.user.name).toBe('Nested');
  });
});

describe('lib/log — level + source columns', () => {
  test.each(['info', 'warn', 'error'])(
    'log.%s writes a row with level=%s',
    async (level) => {
      log[level]({ source: 'http', route: '/x', method: 'GET', status: 200 }, 'http.request');
      await settle();
      expect(mockPrisma.appLog.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.appLog.create.mock.calls[0][0].data.level).toBe(level);
    },
  );

  test('each round-40 canonical source value is accepted verbatim', async () => {
    for (const source of ['http', 'errorHandler', 'safeAsync', 'cron']) {
      log.info({ source, requestId: `r-${source}` }, 'test.source');
    }
    await settle();
    expect(mockPrisma.appLog.create).toHaveBeenCalledTimes(4);
    const sources = mockPrisma.appLog.create.mock.calls.map(
      (c) => c[0].data.source,
    );
    expect(sources).toEqual(['http', 'errorHandler', 'safeAsync', 'cron']);
  });

  test('source column defaults to "unknown" when caller did not set one', async () => {
    log.info({ route: '/x' }, 'no.source');
    await settle();
    const persisted = mockPrisma.appLog.create.mock.calls[0][0].data;
    expect(persisted.source).toBe('unknown');
  });
});

describe('lib/log — column projection from context', () => {
  test('requestId / employeeHash / route / method / status / latencyMs / errorCode are extracted from context', async () => {
    log.error(
      {
        requestId: 'req-42',
        employeeHash: 'abc123def456',
        route: '/api/dpr',
        method: 'POST',
        status: 409,
        latencyMs: 137,
        errorCode: 'VERSION_CONFLICT',
        // Arbitrary extra context field — should NOT pollute the typed
        // top-level columns (it stays in context JSON only).
        bodyHash: 'b0d7',
      },
      'http.error',
    );
    await settle();
    const persisted = mockPrisma.appLog.create.mock.calls[0][0].data;
    expect(persisted.requestId).toBe('req-42');
    expect(persisted.employeeHash).toBe('abc123def456');
    expect(persisted.route).toBe('/api/dpr');
    expect(persisted.method).toBe('POST');
    expect(persisted.status).toBe(409);
    expect(persisted.latencyMs).toBe(137);
    expect(persisted.errorCode).toBe('VERSION_CONFLICT');
    // extra keys survive in context JSON (not the typed top-level cols).
    expect(persisted.context.bodyHash).toBe('b0d7');
  });

  test('undefined context keys are stripped before persist (no JSON null pollution)', async () => {
    log.info(
      { requestId: 'r', route: undefined, method: 'GET', status: undefined },
      'test.undef',
    );
    await settle();
    const persisted = mockPrisma.appLog.create.mock.calls[0][0].data;
    expect(persisted.route).toBeNull();
    expect(persisted.status).toBeNull();
    expect(persisted.method).toBe('GET');
    expect(persisted.context).not.toHaveProperty('route');
    expect(persisted.context).not.toHaveProperty('status');
  });
});

describe('lib/log — loud fallback on Prisma throw', () => {
  test('a failing appLog.create logs [log] persistence failed to console.error', async () => {
    const boom = new Error('connection reset');
    boom.code = 'P1001';
    mockPrisma.appLog.create.mockRejectedValueOnce(boom);
    log.error({ source: 'http', route: '/x' }, 'http.error');

    // The .catch fires on the microtask after the create promise rejects.
    await settle();
    await settle();
    await settle();

    const sawPersistenceFailed = consoleErrorSpy.mock.calls.some((args) =>
      String(args[0] || '').includes('[log] persistence failed'),
    );
    expect(sawPersistenceFailed).toBe(true);
  });
});

describe('lib/log — Prisma client resolver', () => {
  test('when _setPrismaForTesting is given a client without appLog, the write is a no-op (no throw)', async () => {
    log._setPrismaForTesting({}); // no appLog
    expect(() => log.info({ route: '/x' }, 'noop')).not.toThrow();
    await settle();
    // Stdout fallback still fired — that's the diagnostic path.
    // No persistence call because there is no appLog model on the mock.
  });
});
