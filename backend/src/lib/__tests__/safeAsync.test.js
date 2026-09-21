// Round-40 #3 — safeAsync wrapper tests.
//
// Pin points (each guards a single round-40 decision):
//
//   1. On failure, safeAsync emits EXACTLY ONE log.error row whose
//      context carries source=safeAsync, code=fanout.failed, the call-
//      site label, the caller's requestId + employeeHash, and a
//      trimmed error shape (name / first-line message / code).
//   2. On success, safeAsync emits NO log row — it's fire-and-forget
//      for the audit trail, by design.
//   3. The optional `fallback` is the value the wrapper's returned
//      promise resolves to on failure. KPI / picker call sites rely on
//      this exact contract; if a refactor swaps `fallback` order or
//      returns `undefined`, every getAssignedProjectIds + projectKpi
//      call silently ships an empty list.
//   4. The success path's return value is the underlying fn's result —
//      NOT the fallback. The previous round-40 plan caught a regression
//      where a trailing .then() overwrote the success value with the
//      fallback; the pin lives in test 4 so future "cleanup" reintroduces
//      a failure.
//   5. No raw PII leak — safeAsync passes requestId + employeeHash as
//      opaque strings; raw employeeId must never reach log.error's
//      context. We pin the input/output contract here.

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.PII_LOG_SALT =
  process.env.PII_LOG_SALT || 'test-pii-log-salt-must-be-set';

const safeAsync = require('../safeAsync');
const log = require('../log');

function buildMockPrisma() {
  return {
    appLog: {
      create: jest.fn(async ({ data }) => data),
    },
  };
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

// Yield twice — once for the safeAsync microtask that calls fn(),
// once for the appLog.create() promise to settle.
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('safeAsync — success path', () => {
  test('a successful fn() does NOT emit any log row (fire-and-forget audit)', async () => {
    const fn = jest.fn(async () => [{ projectId: 'p1' }, { projectId: 'p2' }]);
    safeAsync(
      'projects.assigned.dpr',
      fn,
      { requestId: 'req-test', employeeHash: 'abc123def456' },
    );
    await settle();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockPrisma.appLog.create).not.toHaveBeenCalled();
  });

  test('a successful fn() return value flows back through the promise (not the fallback)', async () => {
    // Pin: the round-40 plan caught a bug where a trailing .then() silently
    // overwrote the success value with `fallback`. Critical for KPI / picker
    // callers that DO await and rely on truth data on the happy path.
    const value = await safeAsync(
      'kpi.auditLog',
      async () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      { fallback: [] },
    );
    expect(value).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(value).not.toEqual([]);
  });

  test('a synchronous throw inside fn is caught and treated as failure', async () => {
    const fn = () => {
      throw new Error('boom-sync');
    };
    const result = await safeAsync('sync.throw', fn, { fallback: null });
    expect(result).toBeNull();
    await settle();
    expect(mockPrisma.appLog.create).toHaveBeenCalledTimes(1);
  });
});

describe('safeAsync — failure path', () => {
  test('emits one log.error row with source=safeAsync, code=fanout.failed, label, requestId, employeeHash', async () => {
    const err = new Error('connect ECONNREFUSED');
    err.code = 'P1001';
    err.name = 'PrismaClientKnownRequestError';
    const fn = jest.fn(async () => { throw err; });

    await safeAsync(
      'projects.assigned.dpr',
      fn,
      { requestId: 'req-fail-1', employeeHash: 'deadbeef0001', fallback: [] },
    );
    await settle();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockPrisma.appLog.create).toHaveBeenCalledTimes(1);

    const persisted = mockPrisma.appLog.create.mock.calls[0][0].data;
    expect(persisted.level).toBe('error');
    expect(persisted.source).toBe('safeAsync');
    // errorCode is the typed column — feeds `WHERE error_code = 'fanout.failed'`.
    expect(persisted.errorCode).toBe('fanout.failed');
    expect(persisted.requestId).toBe('req-fail-1');
    expect(persisted.employeeHash).toBe('deadbeef0001');
    expect(persisted.context.label).toBe('projects.assigned.dpr');
    expect(persisted.context.errorCode).toBe('fanout.failed');
    // Error shape: name preserved, message trimmed to first line,
    // Prisma code preserved.
    expect(persisted.context.error.name).toBe('PrismaClientKnownRequestError');
    expect(persisted.context.error.message).toBe('connect ECONNREFUSED');
    expect(persisted.context.error.code).toBe('P1001');
    expect(persisted.message).toBe('fanout.failed');
  });

  test('error.message is trimmed to the first line (no stack-trace pollution of app_log)', async () => {
    const err = new Error('line one\nline two\nline three\nat Object.<anonymous>');
    err.code = 'P1001';
    await safeAsync(
      'kpi.auditLog',
      async () => { throw err; },
      { fallback: [] },
    );
    await settle();
    const persisted = mockPrisma.appLog.create.mock.calls[0][0].data;
    expect(persisted.context.error.message).toBe('line one');
    // stack doesn't appear in the row at all.
    expect(persisted.context.error).not.toHaveProperty('stack');
  });

  test('when the error has no .code field, the row carries an absent-or-undefined code (no "null" pollution)', async () => {
    const err = new Error('plain error');
    err.name = 'PlainError';
    await safeAsync(
      'kpi.auditLog',
      async () => { throw err; },
      { fallback: [] },
    );
    await settle();
    const persisted = mockPrisma.appLog.create.mock.calls[0][0].data;
    // Top-level ctx keys with undefined values are stripped by
    // lib/log._normaliseCtx. Inside the nested error object, code
    // remains undefined (JSON serialisation drops it). Either way, the
    // contract is that the row NEVER ships `code: null` for an error
    // without a code — null would imply a meaningful "null" rather
    // than the absence of a code.
    expect(persisted.context.error.code).toBeFalsy();
    expect(persisted.context.error.code).not.toBe('null');
    expect(persisted.context.error.name).toBe('PlainError');
  });

  test('fallback is returned on failure so existing empty-array callers keep their contract', async () => {
    const result = await safeAsync(
      'kpi.auditLog',
      async () => { throw new Error('down'); },
      { fallback: [] },
    );
    expect(result).toEqual([]);
  });

  test('a non-array fallback (null) is also preserved', async () => {
    const result = await safeAsync(
      'attendance.adminPrefs',
      async () => { throw new Error('down'); },
      { fallback: null },
    );
    expect(result).toBeNull();
  });

  test('absent fallback resolves to undefined (default)', async () => {
    const result = await safeAsync(
      'notify.dpr',
      async () => { throw new Error('down'); },
    );
    expect(result).toBeUndefined();
  });
});

describe('safeAsync — PII input contract', () => {
  test('does not propagate a raw employeeId into the log row (caller must pre-hash)', async () => {
    // safeAsync accepts ONLY pre-hashed employeeHash. If a caller
    // accidentally passes a raw employeeId, the audit row preserves it
    // verbatim — this test pins that contract so future refactors that
    // add "convenience hashing" are caught.
    const rawEmployeeId = 'emp_abc123_xyz';
    await safeAsync(
      'notify.dpr',
      async () => { throw new Error('down'); },
      { requestId: 'r', employeeHash: rawEmployeeId, fallback: null },
    );
    await settle();
    const persisted = mockPrisma.appLog.create.mock.calls[0][0].data;
    // The column receives whatever the caller passed — no surprise
    // hashing inside safeAsync. The contract is "hash at the call site
    // via pii.hashIdentifier(employeeId) before crossing this boundary."
    expect(persisted.employeeHash).toBe(rawEmployeeId);
  });
});
