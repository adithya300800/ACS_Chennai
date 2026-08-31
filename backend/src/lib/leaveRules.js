// Pure leave validators. No I/O, fully unit-testable.
//
// Status string is a string (not Prisma enum) on the model side, but the
// server validates against an allowlist so a client can't smuggle an
// unknown status into a query string or POST body.

'use strict';

const ALLOWED_LEAVE_TYPES = new Set(['CASUAL', 'SICK', 'EARNED', 'UNPAID', 'OPTIONAL']);
const ALLOWED_LEAVE_STATUSES = new Set(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']);

// Parse a YYYY-MM-DD (or full ISO with time, but only the date matters)
// into a local-midnight Date. Returns null on invalid input.
//
// Important: this uses the server's LOCAL TZ (which is Asia/Kolkata per
// index.js). `new Date('2026-08-30')` parses as UTC midnight in V8 — that
// shifts the day bucket backward 5h30m from IST midnight, which is the
// off-by-one bug the existing `parseLocalDate` helper in attendance.js
// was written to avoid. We mirror that pattern.
function parseLeaveDate(input) {
  if (input == null) return null;
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return null;
    return new Date(input.getFullYear(), input.getMonth(), input.getDate());
  }
  if (typeof input !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(input.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return null;
  // Use the calendar's last-day check to reject 2026-02-30 etc.
  const last = new Date(y, mo, 0).getDate();
  if (d < 1 || d > last) return null;
  return new Date(y, mo - 1, d);
}

// Inclusive day count for the leave window. Used in dayCount summaries.
function inclusiveDayCount(startDate, endDate) {
  if (!startDate || !endDate) return 0;
  const s = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate()).getTime();
  const e = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate()).getTime();
  if (e < s) return 0;
  return Math.round((e - s) / (1000 * 60 * 60 * 24)) + 1;
}

// Inclusive overlap test: two ranges overlap iff a.start <= b.end AND
// b.start <= a.end. Treats single-day ranges correctly:
//   [1–5] vs [5–9] → TRUE (day 5 is shared)
//   [1–5] vs [6–9] → FALSE
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
