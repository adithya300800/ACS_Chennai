// Round-40 #3 — safeAsync wrapper.
//
// Converts a fire-and-forget call (one the caller does NOT await because
// the result is best-effort and the route must keep moving) into a
// structured-error-logged fire-and-forget that surfaces failures as
// `source=safeAsync code=fanout.failed` rows in app_log.
//
// BEFORE (round-25d and earlier):
//
//   fanOutEmail(notifRow, prisma).catch(() => { /* silent */ });
//
//   or
//
//   prisma.auditLog.findMany({...}).catch(() => []);  // KPI / picker fallback
//
// Both shapes swallow errors. The findMany version returns [] on
// failure, so a transient DB outage silently hands the user an empty
// picker and nobody knows. The fanOutEmail version writes nothing to
// any audit trail; a transport failure means the user simply never
// gets the email and the operator finds out when they complain.
//
// AFTER:
//
//   safeAsync('notify.dpr.submit',
//     () => fanOutEmail(notifRow, prisma),
//     { requestId: req.id, employeeHash: hashIdentifier(req.employeeId) });
//
//   safeAsync('kpi.auditLog',
//     () => prisma.auditLog.findMany({...}),
//     { requestId: req.id, employeeHash: hashIdentifier(req.employeeId),
//       fallback: [] });
//
// Same fire-and-forget semantics (the caller does not await).
// Failures become log.error rows. The optional `fallback` is returned
// ONLY on failure so existing callers that rely on `[]` / `null` keep
// working without a behavioural change.
//
// Why explicit args beat AsyncLocalStorage here:
// - 26 fire-and-forget sites today (12 fan-out + 14 silent-catch).
//   Adding an ALS module + propagation + a real risk of context bleed
//   across unrelated async ops to save 26 × 2 argument lines is not
//   worth the complexity. Explicit args are grep-able. ALS would hide
//   them into the runtime.
// - The plan (K.4) commits to explicit args.
//
// Semantics — important:
//   .then(() => fn())        — runs fn(), returns its promise
//   .catch(err => …)         — on rejection, log + return fallback
// No trailing `.then()` — the previous version had one and it
// overwrote the success value too, so a successful auditLog.findMany
// was being replaced with [] silently (round-40 plan round-3 bug
// pin).

'use strict';

const log = require('./log');

/**
 * Run `fn()` as a fire-and-forget. On success, the underlying promise's
 * value is discarded (caller doesn't await). On failure, emit a
 * log.error({ source: 'safeAsync', code: 'fanout.failed', … }) row and
 * resolve with `fallback` (default: undefined).
 *
 * @param {string} label            — short identifier for the call site,
 *                                    used in the log row's `label` field.
 *                                    Convention: 'module.action', e.g.
 *                                    'notify.dpr.submit',
 *                                    'kpi.auditLog'.
 * @param {() => Promise<any>} fn   — the operation to run. Its return
 *                                    value is not propagated back to the
 *                                    caller (fire-and-forget).
 * @param {object} [opts]
 * @param {string} [opts.requestId]    — X-Request-Id for correlation.
 * @param {string} [opts.employeeHash] — pre-hashed employeeHash
 *                                       (compute via
 *                                       pii.hashIdentifier at the call
 *                                       site; never pass raw employeeId).
 * @param {any}    [opts.fallback]     — value to "return" on failure
 *                                       (so existing .catch(() => [])
 *                                       callers can keep their empty-
 *                                       array contract).
 * @returns {Promise<any>}              — promise that resolves with
 *                                       `fallback` on failure or
 *                                       `undefined` on success. Intended
 *                                       to be left un-awaited.
 */
function safeAsync(label, fn, { requestId, employeeHash, fallback } = {}) {
  return Promise.resolve()
    .then(() => fn())
    .catch((err) => {
      // Durable log row. Loud fallback (never silent) — lib/log's own
      // persistence layer ALSO emits console.error on Prisma throw so
      // this is belt-and-braces. The label + a trimmed error shape keep
      // the row small while preserving the actionable detail.
      log.error(
        {
          source: 'safeAsync',
          requestId,
          employeeHash,
          label,
          // `errorCode` lands in the typed AppLog.errorCode column
          // (see schema.prisma + lib/log.js column projection) so an
          // operator can `WHERE error_code = 'fanout.failed'`. The
          // shape stays compatible with the errorHandler's code= field.
          errorCode: 'fanout.failed',
          error: {
            name: err?.name,
            message: (err?.message || '').split('\n')[0],
            code: err?.code,
          },
        },
        'fanout.failed',
      );
      // Return fallback ONLY on failure. A trailing .then() would
      // overwrite the success value too — that bug was caught in the
      // round-40 plan review; the pin lives in this comment so a
      // future refactor that "cleans up" the trailing .then re-introduces
      // a test failure.
      return fallback;
    });
}

module.exports = safeAsync;
