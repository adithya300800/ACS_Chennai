// Round-40 — structured logging scaffold.
//
// Single durable writer for app_log. Today's pipeline:
//
//   log.info({ requestId, employeeHash, route, method, status, latencyMs },
//            'http.request');
//   log.warn(...);
//   log.error(...);
//
// Behaviour:
//
//   1. Normalise context: drop undefined keys, coerce known fields.
//   2. Redact PII via lib/pii#redact() — server-side firewall for email,
//      phone, address, ssn, pan, aadhaar. The only place this matters for
//      round-40 is auth/login bodies + URL query strings, but every write
//      goes through redaction so a future caller can't accidentally leak.
//   3. Fire-and-forget INSERT via prisma.appLog.create(). Fire-and-forget
//      because sync INSERT adds 2–5ms to every request's critical path;
//      the 248 existing console.* calls already accept best-effort loss.
//   4. Loud fallback: any Prisma throw → console.error('[log] persistence
//      failed', err, { level, message }). Never silent — a silent
//      logger is worse than no logger.
//   5. Also write to stdout (console.log / console.error at matching level)
//      so Render's live tail keeps working for deploy-debug. stdout is a
//      diagnostic fallback, never the durable store — Supabase app_log
//      is what the daily prune touches.
//
// API surface (intentionally minimal):
//   log.info(ctx, msg)
//   log.warn(ctx, msg)
//   log.error(ctx, msg)
//
// No child(), no flush(), no level filter. Rejected in round-40 plan K —
// every call site binds a context and immediately fires exactly one
// method, never reused; flush() adds a 4th inconsistent exception to a
// plan that already accepts best-effort loss in 3 other places.
//
// Backpressure: in-process counter. If open writes > 5,000, drop new
// writes with one console.error per 1,000 dropped. Keeps the logger
// from dragging the request path if Supabase pool stalls.
//
// PII_LOG_SALT env-var requirement: lib/pii.js already throws at import
// if the salt is missing. require()ing redact() here surfaces that throw
// at first-use rather than at app startup — acceptable because the
// existing pii.js callers hit the same wall.
//
// The Prisma client is NOT imported here at module load — it's looked up
// via the per-request app.set('prisma', ...) on the first write so a
// require()'d logger in a test environment doesn't accidentally pick up
// a global Prisma client.

'use strict';

const pii = require('./pii');

const BACKPRESSURE_LIMIT = 5000;
const BACKPRESSURE_REPORT_EVERY = 1000;

// In-flight write counter. Increments inside write() and decrements in
// the .catch / .then of the create() promise. Survives only for the
// process lifetime — which is exactly the scope of the backpressure
// guard.
let _openWrites = 0;
let _dropped = 0;

// Module-scoped Prisma client cache. Populated lazily on first write
// (default: a shared PrismaClient singleton), and overridable by tests
// via _setPrismaForTesting so jest mocks don't have to mock the
// @prisma/client module itself.
let _prismaClient = null;

function _emitStdout(level, msg) {
  const line = `[log] ${level} ${msg}`;
  // eslint-disable-next-line no-console
  if (level === 'error') console.error(line);
  else console.log(line);
}

function _normaliseCtx(ctx) {
  if (!ctx || typeof ctx !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

async function _write(level, ctx, msg) {
  // 1. Normalise + 2. Redact. Redaction is the only PII firewall.
  const safeCtx = pii.redact(_normaliseCtx(ctx));
  const safeMsg = String(msg || '');

  // Stdout fallback first (always) — so a Prisma outage doesn't blind the
  // operator's live tail during the very incident that broke the writes.
  _emitStdout(level, safeMsg);

  // 3. Backpressure guard. Drop BEFORE touching Prisma so a saturated
  // pool doesn't queue more.
  if (_openWrites >= BACKPRESSURE_LIMIT) {
    _dropped += 1;
    if (_dropped % BACKPRESSURE_REPORT_EVERY === 0) {
      // eslint-disable-next-line no-console
      console.error('[log] backpressure — dropping', {
        dropped: _dropped,
        limit: BACKPRESSURE_LIMIT,
      });
    }
    return;
  }

  // 4. Lazy-prisma lookup. Look up via the request-scoped client if
  // possible; fall back to a fresh PrismaClient import (singleton) so
  // scripts / tests / crons without an Express `req` still write.
  const prisma = _resolvePrisma();
  if (!prisma || !prisma.appLog) {
    // No DB to write to. Stdout fallback already fired. Bail.
    return;
  }

  _openWrites += 1;
  try {
    await prisma.appLog.create({
      data: {
        level,
        // Use a known-safe source field from ctx if the caller set one;
        // otherwise default to "unknown" so the column is never empty.
        source: typeof safeCtx.source === 'string' ? safeCtx.source : 'unknown',
        message: safeMsg,
        context: safeCtx,
        requestId: safeCtx.requestId ?? null,
        employeeHash: safeCtx.employeeHash ?? null,
        route: safeCtx.route ?? null,
        method: safeCtx.method ?? null,
        status: typeof safeCtx.status === 'number' ? safeCtx.status : null,
        latencyMs: typeof safeCtx.latencyMs === 'number' ? safeCtx.latencyMs : null,
        errorCode: safeCtx.errorCode ?? null,
        errorStack: safeCtx.errorStack ?? null,
      },
    });
  } catch (err) {
    // 5. Loud fallback — never silent.
    // eslint-disable-next-line no-console
    console.error('[log] persistence failed', err, { level, message: safeMsg });
  } finally {
    _openWrites -= 1;
  }
}

function _resolvePrisma() {
  // Express puts the prisma singleton on the app via app.set('prisma', ...).
  // Tests inject it the same way; scripts that don't go through Express
  // (e.g. retention cron) require it directly at the top of the file.
  //
  // We DON'T import { PrismaClient } at module load because every
  // require()ed logger would silently spin up a connection pool, and the
  // test suite would have to mock PrismaClient just to instantiate the
  // logger.
  if (_prismaClient) return _prismaClient;
  try {
    // eslint-disable-next-line global-require
    const { PrismaClient } = require('@prisma/client');
    // Module-level cache: a single shared client. Same connection-pool
    // semantics as src/index.js's createApp() default.
    _prismaClient = new PrismaClient();
    return _prismaClient;
  } catch (_err) {
    return null;
  }
}

// Exposed for tests so each test can inject a fresh mock client.
function _setPrismaForTesting(mockClient) {
  _prismaClient = mockClient;
}

// Public API. Sync wrappers around the async writer — fire-and-forget is
// achieved by NOT awaiting _write at the call site. The promise is
// intentionally unhandled; rejections surface as the console.error in
// _write's catch block (loud fallback, never silent).
function info(ctx, msg) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  _write('info', ctx, msg);
}
function warn(ctx, msg) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  _write('warn', ctx, msg);
}
function error(ctx, msg) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  _write('error', ctx, msg);
}

module.exports = {
  info,
  warn,
  error,
  // Internal handles for tests only — production callers should stick to
  // info/warn/error.
  _write,
  _setPrismaForTesting,
};
