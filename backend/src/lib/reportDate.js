// DR-027 — "no future report dates" enforced at the backend boundary.
//
// The problem this closes: DprSubmit.jsx / InspectionSubmit.jsx both clamp the
// date picker to today, but the server only ever validated calendar SHAPE
// (`parseStrictISODate` in lib/errors.js rejects 2026-02-30, not 2027-01-01).
// Anything that talks to the API directly — curl, a replayed request, a stale
// mobile bundle with a wrong device clock — could persist a DPR or an
// inspection dated in the future. Two concrete harms:
//
//   1. A future-dated DPR reserves the legitimate (employee, calendar-day)
//      key, so when that day actually arrives the real report 409s as a
//      duplicate.
//   2. Future rows land in the admin review queue for work that has not
//      happened yet, which contaminates the queue and the approval audit
//      trail.
//
// The rule: a reportDate may be at most the CURRENT ACS business day. The
// business day comes from `getTodayBusinessDate` in lib/dateOnly.js (DR-023),
// so this module inherits the same UTC-midnight convention and the same
// `Asia/Kolkata` default — we do not introduce a second notion of "today".
//
// Back-dating stays legal and unrestricted: engineers routinely file
// yesterday's DPR the next morning, and there is no lower bound in scope for
// this round.
//
// Admin override: an admin acting through an admin-gated route may write a
// future date (rare, but e.g. pre-filing a planned shutdown inspection). That
// is allowed only with `allowAdminOverride: true`, and every use emits an
// `audit_admin_override` event so the bypass is never silent.

'use strict';

const { getTodayBusinessDate, formatDateOnly } = require('./dateOnly');
const { hashIdentifier } = require('./pii');

// Single source of truth for the ACS business timezone. Same value as
// dateOnly.js / attendance.js — do NOT diverge from it.
const ACS_TIMEZONE = 'Asia/Kolkata';

class FutureReportDateError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'FutureReportDateError';
    // `code` matches the wire contract the routes return to the client so a
    // handler can pass it straight through without a translation table.
    this.code = 'FUTURE_REPORT_DATE';
    this.status = 400;
    this.reportDate = meta.reportDate || null;
    this.maxReportDate = meta.maxReportDate || null;
  }
}

// ─── audit sink ──────────────────────────────────────────────────────────────
// Admin overrides are logged through a swappable sink. Default writes one
// structured JSON line to stdout, which is what Render's log drain ingests.
// Tests (and any future DB-backed audit table) replace it with setAuditLogger.
function defaultAuditLogger(event) {
  // console.info, not console.log — keeps audit lines separable from the
  // debug noise the round-18 cleanup removed from console.log.
  console.info(JSON.stringify(event));
}

let auditLogger = defaultAuditLogger;

function setAuditLogger(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('setAuditLogger expects a function');
  }
  auditLogger = fn;
}

function resetAuditLogger() {
  auditLogger = defaultAuditLogger;
}

// ─── coercion ────────────────────────────────────────────────────────────────
// Accept either a Date (what `parseStrictISODate` hands back — UTC midnight)
// or a plain 'YYYY-MM-DD' string, and reduce it to the UTC-midnight Date that
// represents its calendar day. Returns null for anything we can't read as a
// calendar day; callers treat null as "not my problem" because shape
// validation already happened upstream and returns INVALID_REPORT_DATE.
function toCalendarDay(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  if (typeof value === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (!m) return null;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (Number.isNaN(d.getTime())) return null;
    return d;
  }
  return null;
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * True when `date` is strictly after the ACS business day for `now`.
 *
 * "Strictly after" means today itself is always acceptable — the 23:59 IST
 * submission of today's DPR is the normal case, not an edge case.
 *
 * Unreadable input returns false: shape validation is the caller's job
 * (`parseStrictISODate`), and returning true here would report the wrong
 * error code for a malformed string.
 */
function isFutureReportDate(date, now = new Date(), timezone = ACS_TIMEZONE) {
  const day = toCalendarDay(date);
  if (day === null) return false;
  const today = getTodayBusinessDate(now instanceof Date ? now : new Date(), timezone || ACS_TIMEZONE);
  return day.getTime() > today.getTime();
}

/**
 * The latest reportDate the validator accepts: the current business day in
 * the ACS timezone, as a Date at 00:00:00.000Z.
 *
 * Useful for the API surface (a 400 can tell the client the ceiling) and for
 * a future `max` attribute handed to the date picker.
 */
function getMaxReportDate(now = new Date(), timezone = ACS_TIMEZONE) {
  return getTodayBusinessDate(now instanceof Date ? now : new Date(), timezone || ACS_TIMEZONE);
}

/**
 * Throw `FutureReportDateError` (code: FUTURE_REPORT_DATE) when `date` is
 * strictly in the future of `now`.
 *
 * With `allowAdminOverride: true` any date is accepted, but a future date
 * emits an `audit_admin_override` event first. A non-future date under an
 * override does NOT log — there was nothing to override, and logging it
 * would bury the real bypasses in noise.
 *
 * Returns the coerced UTC-midnight Date so a caller can use the normalized
 * value instead of re-parsing.
 */
function assertNotFutureReportDate(date, options = {}) {
  const {
    allowAdminOverride = false,
    now = new Date(),
    timezone = ACS_TIMEZONE,
    // Optional provenance for the audit event. `actor` is an employee id and
    // is hashed before it is written, per the round-2 PII-redaction rule.
    actor = null,
    resource = null,
  } = options;

  const day = toCalendarDay(date);
  const isFuture = isFutureReportDate(date, now, timezone);
  const maxDate = getMaxReportDate(now, timezone);

  if (!isFuture) return day;

  if (allowAdminOverride) {
    auditLogger({
      event: 'audit_admin_override',
      rule: 'FUTURE_REPORT_DATE',
      resource,
      actorHash: actor ? hashIdentifier(actor) : null,
      reportDate: formatDateOnly(day),
      maxReportDate: formatDateOnly(maxDate),
      daysAhead: Math.round((day.getTime() - maxDate.getTime()) / 86400000),
      at: new Date(now instanceof Date ? now.getTime() : Date.now()).toISOString(),
    });
    return day;
  }

  throw new FutureReportDateError('reportDate cannot be in the future', {
    reportDate: formatDateOnly(day),
    maxReportDate: formatDateOnly(maxDate),
  });
}

/**
 * Express-level convenience used by dpr.js and inspection.js so the same
 * 400 body is returned from every call site.
 *
 * Returns true when it has already responded (caller must `return`), false
 * when the date is acceptable. Admin override is derived from `req.isAdmin`,
 * which `requireAuth` sets from the JWT claim.
 *
 * Lives here rather than being copy-pasted into both routers because a
 * divergent error body between DPR and Inspection is exactly the kind of
 * silent UI↔API desync that bit rounds 9/14/15/16.
 */
function rejectIfFutureReportDate(req, res, date, resource) {
  try {
    assertNotFutureReportDate(date, {
      allowAdminOverride: !!(req && req.isAdmin),
      actor: req ? req.employeeId : null,
      resource,
    });
    return false;
  } catch (err) {
    if (err && err.code === 'FUTURE_REPORT_DATE') {
      res.status(400).json({
        error: 'FUTURE_REPORT_DATE',
        message: 'reportDate cannot be in the future',
        maxReportDate: err.maxReportDate,
      });
      return true;
    }
    throw err;
  }
}

module.exports = {
  ACS_TIMEZONE,
  FutureReportDateError,
  isFutureReportDate,
  getMaxReportDate,
  assertNotFutureReportDate,
  rejectIfFutureReportDate,
  setAuditLogger,
  resetAuditLogger,
};
