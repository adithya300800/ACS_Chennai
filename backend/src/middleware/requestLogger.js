// Round-40 #2 — per-request log middleware.
//
// One `http.request` row per HTTP exchange, fired from `res.on('finish')`
// so the listener runs AFTER the response is sent — i.e. AFTER the entire
// middleware chain has run, including requireAuth. That means
// `req.employeeId` is populated by the time we read it for the
// `employeeHash` column, regardless of where this middleware sits in the
// chain.
//
// Mount order (src/index.js createApp()):
//
//   request-id      ← mints req.id (must run first so the log row has the id)
//   requestLogger   ← THIS file — attaches res.on('finish') listener
//                     (must run BEFORE anything that can throw / short-
//                     circuit so even 401s + body-parser 4xx produce rows)
//   cors
//   body-parser
//   requireAuth     ← populates req.employeeId
//   routes
//   errorHandler
//
// Two reasons for the EARLY mount (before CORS / body-parser / requireAuth):
//
//   1. A 401 from requireAuth short-circuits before any route handler runs.
//      If requestLogger were mounted AFTER requireAuth, those rejections
//      (bad tokens, expired sessions, refresh-token reuse) would never
//      produce an http.request row — exactly the noisy bug surface an
//      http.request row helps debug.
//
//   2. Body-parser failures (DR-014 oversize, DR-012 malformed JSON)
//      short-circuit at parse time. Same reason to log them.
//
// PII: the context sent to log.info goes through lib/log's redact() before
// it hits Prisma. employeeId is hashed here via pii.hashIdentifier before
// the context leaves this file, so the logger never sees the raw value.

'use strict';

const log = require('../lib/log');
const pii = require('../lib/pii');

module.exports = function requestLogger(req, res, next) {
  // Capture start time as a BigInt hrtime so the latency math is monotonic
  // and unaffected by system clock changes (Date.now() can go backwards on
  // NTP correction, hrtime can't).
  const startBig = process.hrtime.bigint();
  req._logStartBig = startBig;

  res.on('finish', () => {
    // Latency in whole milliseconds — BigInt math, then coerce to Number
    // so the AppLog.latencyMs INTEGER column accepts it without a
    // Number.isSafeInteger guardrail failure.
    const latencyMs = Number((process.hrtime.bigint() - startBig) / 1_000_000n);

    // req.id is set by the request-id middleware in src/index.js — it
    // runs BEFORE this one in the chain. The `?? null` is defensive for
    // edge cases where this middleware is mounted without request-id
    // (e.g. a test that constructs the chain by hand).
    const requestId = req.id ?? null;

    // employeeId is set by requireAuth. Pre-auth requests (401 from
    // requireAuth itself, OPTIONS preflight, body-parser 4xx) read as
    // null here, which becomes the null employeeHash column value — the
    // round-40 design contract.
    const employeeId = req.employeeId ?? null;
    const employeeHash = employeeId ? pii.hashIdentifier(employeeId) : null;

    // res.statusCode is the final status that reached the wire. res.on(
    // 'finish') only fires after the response body is fully flushed, so
    // this is the canonical "what did the client see" answer.
    log.info(
      {
        source: 'http',
        requestId,
        employeeHash,
        isAdmin: !!req.isAdmin,
        route: req.originalUrl || req.url || req.path,
        method: req.method,
        status: res.statusCode,
        latencyMs,
      },
      'http.request',
    );
  });

  next();
};
