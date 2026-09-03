// Pure leave validators. No I/O, fully unit-testable.
//
// Status string is a string (not Prisma enum) on the model side, but the
// server validates against an allowlist so a client can't smuggle an
// unknown status into a query string or POST body.

'use strict';

const { parseDateOnlyToUtc } = require('./dateOnly');

const ALLOWED_LEAVE_TYPES = new Set(['CASUAL', 'SICK', 'EARNED', 'UNPAID', 'OPTIONAL']);
const ALLOWED_LEAVE_STATUSES = new Set(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']);

// Parse a YYYY-MM-DD (or full ISO with time, but only the date matters)
// into a UTC-midnight Date. Returns null on invalid input.
//
// DR-023: the previous implementation returned local-midnight Dates
// (`new Date(y, mo-1, d)`). With `process.env.TZ = 'Asia/Kolkata'` set in
// src/index.js, that produces IST-midnight instants like
// `2026-08-30T00:00:00+05:30` (= `2026-08-29T18:30:00Z`). Prisma 5.22
// serializes Date → @db.Date via `toISOString()` and reads `2026-08-29`,
// off by one calendar day from what the user typed. The new path goes
// through `parseDateOnlyToUtc` so the same canonical UTC-midnight Date
// is returned everywhere in the app.
//
// DR-031 (round-20): the audit reviewed every leave-overlap predicate
// that consumes these Dates and confirmed the **inclusive** `lte`/`gte`
// form is correct for `@db.Date` columns. Each value represents a
// CALENDAR DAY the employee is on leave, not a half-open time range —
// a leave with startDate=endDate=Sept 4 is a one-day leave covering
// Sept 4, and a separate leave starting Sept 4 conflicts with it. A
// half-open `lt`/`gt` rewrite would break this: two leaves touching
// on day 4 would silently stop conflicting. The application-level
// precheck at leave.js and the PostgreSQL EXCLUDE constraint at
// `no_overlap_leave` (migration 20260902220220_dr009_leave_overlap_constraint)
// both use inclusive semantics; they MUST stay aligned. Tests in
// __tests__/leaveRules.test.js pin this.
function parseLeaveDate(input) {
  if (input == null) return null;
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return null;
    // Normalize a Date to its UTC calendar day. The previous shape
    // returned local-midnight; callers that compared two parseLeaveDate
    // outputs via `Date.getTime()` are unaffected because both sides are
    // normalized the same way.
    return new Date(Date.UTC(
      input.getUTCFullYear(),
      input.getUTCMonth(),
      input.getUTCDate()
    ));
  }
  if (typeof input !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(input.trim());
  if (!m) return null;
  try {
    // Delegate validation + encoding to the canonical helper.
    return parseDateOnlyToUtc(input.trim());
  } catch (_e) {
    return null;
  }
}

// Inclusive day count for the leave window. Used in dayCount summaries.
//
// DR-031 (round-20): both inputs are UTC-midnight Dates from
// `parseLeaveDate` (via `parseDateOnlyToUtc`). Reading UTC components
// here would be more direct, but the previous local-midnight shape is
// preserved so anyone reading the diff doesn't have to chase a
// follow-up. The values are equivalent for the day count.
function inclusiveDayCount(startDate, endDate) {
  if (!startDate || !endDate) return 0;
  const s = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate()).getTime();
  const e = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate()).getTime();
  if (e < s) return 0;
  return Math.round((e - s) / (1000 * 60 * 60 * 24)) + 1;
}

// Inclusive overlap test: two ranges overlap iff a.start <= b.end AND
// b.start <= a.end.
//
// DR-031 (round-20): the inclusive form is REQUIRED for `@db.Date`
// columns. Each value is a calendar day (UTC midnight) the employee is
// on leave — a half-open `lt`/`gt` rewrite would silently let two
// leaves that touch on the same day stop conflicting. See the tests
// in __tests__/leaveRules.test.js for the cases:
//   [1–5] vs [5–9] → TRUE  (day 5 is shared)
//   [1–5] vs [6–9] → FALSE (no shared day)
//   [4–4] vs [4–6] → TRUE  (one-day leave on day 4 conflicts with day 4-6)
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  if (!aStart || !aEnd || !bStart || !bEnd) return false;
  return aStart <= bEnd && bStart <= aEnd;
}

// Validate a leave-create payload. Returns { ok: true, value } or
// { ok: false, code, message }. Pure — no DB access.
function validateCreatePayload(body, { now = new Date(), maxFutureDays = 365, maxPastDays = 90, maxDurationDays = 90 } = {}) {
  if (!body || typeof body !== 'object') {
    return { ok: false, code: 'INVALID_BODY', message: 'Body required' };
  }
  const { startDate, endDate, leaveType, reason } = body;

  const s = parseLeaveDate(startDate);
  const e = parseLeaveDate(endDate);
  if (!s) return { ok: false, code: 'INVALID_START_DATE', message: 'startDate must be a valid YYYY-MM-DD' };
  if (!e) return { ok: false, code: 'INVALID_END_DATE', message: 'endDate must be a valid YYYY-MM-DD' };
  if (e < s) return { ok: false, code: 'INVALID_DATE_RANGE', message: 'endDate must be on or after startDate' };

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayMs = 1000 * 60 * 60 * 24;
  const daysAhead = Math.round((s - today) / dayMs);
  const daysBehind = Math.round((today - e) / dayMs); // past end
  if (daysAhead > maxFutureDays) {
    return { ok: false, code: 'FUTURE_DATE', message: `startDate is more than ${maxFutureDays} days in the future` };
  }
  if (daysBehind > maxPastDays) {
    return { ok: false, code: 'PAST_DATE', message: `endDate is more than ${maxPastDays} days in the past` };
  }

  const duration = inclusiveDayCount(s, e);
  if (duration > maxDurationDays) {
    return { ok: false, code: 'INVALID_DATE_RANGE', message: `Leave duration (${duration} days) exceeds the ${maxDurationDays}-day maximum` };
  }

  if (typeof leaveType !== 'string' || !ALLOWED_LEAVE_TYPES.has(leaveType)) {
    return { ok: false, code: 'INVALID_LEAVE_TYPE', message: `leaveType must be one of: ${[...ALLOWED_LEAVE_TYPES].join(', ')}` };
  }

  if (typeof reason !== 'string') {
    return { ok: false, code: 'INVALID_REASON', message: 'reason must be a string' };
  }
  const trimmed = reason.trim();
  if (trimmed.length < 5) {
    return { ok: false, code: 'REASON_TOO_SHORT', message: 'reason must be at least 5 characters' };
  }
  if (trimmed.length > 1000) {
    return { ok: false, code: 'REASON_TOO_LONG', message: 'reason must be at most 1000 characters' };
  }

  return {
    ok: true,
    value: {
      startDate: s,
      endDate: e,
      leaveType,
      reason: trimmed,
    },
  };
}

// Validate that a leave status transition is allowed. The state machine:
//   PENDING   → APPROVED  (admin)
//   PENDING   → REJECTED  (admin)
//   PENDING   → CANCELLED (owner)
//   any other transition → reject.
function canTransition(fromStatus, toStatus) {
  if (!ALLOWED_LEAVE_STATUSES.has(fromStatus)) return false;
  if (!ALLOWED_LEAVE_STATUSES.has(toStatus)) return false;
  if (fromStatus === 'PENDING') {
    return toStatus === 'APPROVED' || toStatus === 'REJECTED' || toStatus === 'CANCELLED';
  }
  return false; // APPROVED / REJECTED / CANCELLED are terminal in v1.
}

// Map a validation-failure code to an HTTP status. PII codes (e.g. 'reason
// too short') are 400s; overlap conflicts (which surface as separate DB
// errors) are 409s.
function httpStatusForCode(code) {
  switch (code) {
    case 'INVALID_BODY':
    case 'INVALID_START_DATE':
    case 'INVALID_END_DATE':
    case 'INVALID_DATE_RANGE':
    case 'INVALID_LEAVE_TYPE':
    case 'INVALID_REASON':
    case 'REASON_TOO_SHORT':
    case 'REASON_TOO_LONG':
    case 'FUTURE_DATE':
    case 'PAST_DATE':
      return 400;
    case 'NOT_FOUND':
      return 404;
    case 'FORBIDDEN':
      return 403;
    case 'LEAVE_ALREADY_DECIDED':
    case 'LEAVE_NOT_PENDING':
    case 'LEAVE_OVERLAP':
    case 'SELF_APPROVAL':
    case 'DUPLICATE':
      return 409;
    default:
      return 400;
  }
}

module.exports = {
  ALLOWED_LEAVE_TYPES,
  ALLOWED_LEAVE_STATUSES,
  parseLeaveDate,
  inclusiveDayCount,
  rangesOverlap,
  validateCreatePayload,
  canTransition,
  httpStatusForCode,
};
