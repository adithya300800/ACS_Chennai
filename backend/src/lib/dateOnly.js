// Canonical "date-only" helpers for the ACS Chennai portal.
//
// The codebase previously mixed two ways of constructing a JS Date for a
// calendar day:
//   1. `new Date(Date.UTC(y, m-1, d))`  — UTC midnight
//   2. `new Date(y, m-1, d)`           — server-local midnight (IST when
//      `process.env.TZ = 'Asia/Kolkata'` is set in src/index.js)
//
// Mixing the two with Prisma 5.22's `@db.Date` columns produces off-by-one
// day-buckets: the row written with UTC midnight of "2026-09-02" reads back
// as the local-midnight of "2026-09-01" once the server's TZ is IST, so a
// check-in at 00:30 IST was being recorded under the wrong calendar day.
// DR-023 fixes this by routing every "date-only" Date through one helper
// that always returns UTC midnight. Reading a DATE column with Prisma
// 5.22 returns a Date whose UTC components mirror the stored calendar
// day, so a stored "2026-09-02" round-trips through `toISOString()` as
// "2026-09-02T00:00:00.000Z" and `getUTCDate()` returns 2.
//
// Scope (DR-023): this helper centralizes construction only. DR-024 will
// revisit the trust boundary around client-supplied timezones in
// `computeLocalDate` (see attendance.js). DR-031 will revisit the overlap
// predicates in leaveRules.js that still depend on `parseLeaveDate`'s
// output, which after this change is UTC midnight but otherwise identical
// in shape.

'use strict';

class InvalidDateOnlyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidDateOnlyError';
    this.code = 'INVALID_DATE_ONLY';
  }
}

// Build a UTC midnight Date for the given calendar year/month/day.
// Caller is responsible for validity; we don't re-check here because the
// JS `Date` constructor accepts overflow values silently (e.g.
// `Date.UTC(2026, 1, 30)` becomes March 2). Validation lives in
// `parseDateOnlyToUtc` below.
function dateOnlyToUtc(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day));
}

// Parse a strict YYYY-MM-DD string into a UTC midnight Date. Throws
// `InvalidDateOnlyError` (code: INVALID_DATE_ONLY) on any deviation:
//   - wrong shape (must be exactly 10 chars, four-digit year, hyphen,
//     two-digit month, hyphen, two-digit day)
//   - month outside 1..12
//   - day outside 1..last-day-of-that-month
//   - non-string input
function parseDateOnlyToUtc(input) {
  if (typeof input !== 'string') {
    throw new InvalidDateOnlyError('date-only input must be a string');
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!m) {
    throw new InvalidDateOnlyError(
      `date-only input must match YYYY-MM-DD (got: ${JSON.stringify(input)})`
    );
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isInteger(y) || y < 1) {
    throw new InvalidDateOnlyError(`year out of range: ${m[1]}`);
  }
  if (!Number.isInteger(mo) || mo < 1 || mo > 12) {
    throw new InvalidDateOnlyError(`month out of range: ${m[2]}`);
  }
  // Last-day check rejects 2026-02-30, 2026-04-31, etc. by asking JS for
  // day 0 of the NEXT month, which is the last day of `mo` in year `y`.
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (!Number.isInteger(d) || d < 1 || d > last) {
    throw new InvalidDateOnlyError(`day out of range for month: ${m[3]}`);
  }
  return dateOnlyToUtc(y, mo, d);
}

// Resolve "today" in a given IANA timezone to a UTC-midnight Date. This
// lets the server pick the company calendar day for an IST workforce
// regardless of where the Node process is actually running. Default
// timezone is `Asia/Kolkata` (set in src/index.js as `process.env.TZ`,
// but we don't rely on the process env here — pass it explicitly so this
// helper is testable in isolation).
function getTodayBusinessDate(now, timezone) {
  const instant = now instanceof Date ? now : new Date();
  const tz = timezone || 'Asia/Kolkata';
  // en-CA yields YYYY-MM-DD ordered parts. `timeZone` controls which
  // wall-clock calendar day the instant belongs to.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(instant);
  const y = Number(parts.find((p) => p.type === 'year').value);
  const mo = Number(parts.find((p) => p.type === 'month').value);
  const d = Number(parts.find((p) => p.type === 'day').value);
  return dateOnlyToUtc(y, mo, d);
}

// Half-open month range: { startDate: UTC midnight of first day,
// endDate: UTC midnight of FIRST day of next month }. Use `gte` + `lt`
// at every predicate so the upper bound is exclusive — avoids the
// off-by-one risk of inclusive `lte` against a UTC-midnight end.
//
// Caller must pass a `YYYY-MM` string; we don't validate shape here
// because all callers already do. If you want shape validation, run it
// upstream.
function getMonthRangeUtc(yearMonth) {
  const [yearStr, monthStr] = yearMonth.split('-');
  const y = Number(yearStr);
  const mo = Number(monthStr);
  // startDate = first day of month @ UTC midnight
  const startDate = dateOnlyToUtc(y, mo, 1);
  // endDate = first day of NEXT month @ UTC midnight. `mo === 12` rolls
  // into January of the following year because `Date.UTC` accepts
  // month=12 (= January of y+1).
  const endDate = dateOnlyToUtc(y + Math.floor(mo / 12), (mo % 12) + 1, 1);
  return { startDate, endDate };
}

// Compare two Date values as UTC calendar days. Both inputs are coerced
// through `Date.UTC` of their UTC components so an instant like
// `2026-09-02T18:30:00.000Z` is NOT the same day as
// `2026-09-02T00:00:00.000Z` for our purposes — only the calendar-day
// components that JS represents for a UTC-midnight Date count.
function isSameUtcCalendarDay(a, b) {
  if (!(a instanceof Date) || !(b instanceof Date)) return false;
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return false;
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

// Format a Date as `YYYY-MM-DD` using its UTC components. Required for
// round-tripping values Prisma reads back from `@db.Date` columns —
// `toISOString()` would give a full instant like
// `2026-09-02T00:00:00.000Z` which the calendar grid treats as the right
// day, but mixing `toISOString` with `toDateString` (local-time) is the
// original source of the off-by-one.
function formatDateOnly(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

module.exports = {
  InvalidDateOnlyError,
  dateOnlyToUtc,
  parseDateOnlyToUtc,
  getTodayBusinessDate,
  getMonthRangeUtc,
  isSameUtcCalendarDay,
  formatDateOnly,
};
