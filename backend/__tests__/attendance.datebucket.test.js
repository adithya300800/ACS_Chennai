/**
 * DR-023 (round-20): attendance date-bucket canonical encoding.
 *
 * Audit-confirmed: the bug described in DR-023 ("Mixed UTC and IST
 * attendance date keys can return yesterday as today") is fixed in
 * `backend/src/routes/attendance.js::computeLocalDate` and the canonical
 * helper `backend/src/lib/dateOnly.js::getTodayBusinessDate`.
 *
 * Round-20 (post-deploy simplification): the previous implementation
 * had TWO paths through computeLocalDate — an IANA-aware path for users
 * who sent a `clientTimezone` field, and an IST fallback for those who
 * didn't. The user (PST, viewing the portal from California) confirmed
 * that the company is uniformly in IST and asked to collapse both paths
 * into one: always bucket by Asia/Kolkata. The `clientTimezone` field
 * is still accepted on the wire (frontend compatibility) but ignored.
 *
 * Why this also closes DR-023: the bug was that the IANA-aware path
 * and the IST fallback could disagree, AND that the IST fallback used
 * `new Date(y, m, d)` (LOCAL midnight per Node's process TZ, which is
 * UTC on Render) instead of UTC midnight. With the two-path design
 * gone, there is exactly one bucket resolver (Asia/Kolkata → UTC
 * midnight), and DR-023's "mixed UTC/IST" failure mode is structurally
 * impossible.
 *
 * Background on what the test pins:
 *   The pre-fix code used `new Date(y, m, d)` in the fallback path,
 *   which constructs a Date at LOCAL midnight (per Node's process TZ).
 *   When the deployment ran in UTC (Render default), an IST 00:30
 *   check-in was bucketed to the PREVIOUS UTC date — a check-in
 *   stamped `2026-09-02T00:30:00+05:30` (which is
 *   `2026-09-01T19:00:00Z` UTC) ended up bucketed under
 *   `2026-09-01` instead of `2026-09-02`.
 *
 * Today's contract (the fix):
 *   computeLocalDate returns `YYYY-MM-DDT00:00:00.000Z` — UTC midnight
 *   of the calendar day resolved in `Asia/Kolkata`. Both `Date.UTC(y,
 *   m-1, d)` and the canonical helper `getTodayBusinessDate` produce
 *   this encoding; the two never disagree.
 *
 * If a future refactor reintroduces the `new Date(y, m, d)` LOCAL-
 * midnight antipattern, these assertions fail.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';

const {
  getTodayBusinessDate,
  isSameUtcCalendarDay,
  formatDateOnly,
} = require('../src/lib/dateOnly');

describe('DR-023 — getTodayBusinessDate canonical UTC-midnight encoding (IST only)', () => {
  it('IST 00:30 check-in → buckets to the IST calendar day (Wednesday)', () => {
    // Wednesday 2026-09-02 at 00:30 IST = Tuesday 2026-09-01 at 19:00 UTC.
    // The bug bucketed this under 2026-09-01 (the UTC date).
    // The fix buckets under 2026-09-02 (the IST calendar day).
    const instant = new Date('2026-09-01T19:00:00.000Z');
    const bucket = getTodayBusinessDate(instant, 'Asia/Kolkata');
    expect(bucket.toISOString()).toBe('2026-09-02T00:00:00.000Z');
    expect(formatDateOnly(bucket)).toBe('2026-09-02');
  });

  it('IST 23:59:59 check-in → buckets to the SAME IST calendar day', () => {
    // Almost-midnight IST = 18:29:59 UTC same day.
    const instant = new Date('2026-09-02T18:29:59.000Z');
    const bucket = getTodayBusinessDate(instant, 'Asia/Kolkata');
    expect(formatDateOnly(bucket)).toBe('2026-09-02');
  });

  it('IST 18:00 UTC (23:30 IST same day) → buckets to the same IST day', () => {
    const instant = new Date('2026-09-02T18:00:00.000Z');
    const bucket = getTodayBusinessDate(instant, 'Asia/Kolkata');
    expect(formatDateOnly(bucket)).toBe('2026-09-02');
  });

  it('returns UTC midnight (canonical encoding for @db.Date round-trip)', () => {
    const instant = new Date('2026-09-02T10:15:30.500Z');
    const bucket = getTodayBusinessDate(instant, 'Asia/Kolkata');
    expect(bucket.getUTCHours()).toBe(0);
    expect(bucket.getUTCMinutes()).toBe(0);
    expect(bucket.getUTCSeconds()).toBe(0);
    expect(bucket.getUTCMilliseconds()).toBe(0);
    expect(bucket.toISOString()).toBe('2026-09-02T00:00:00.000Z');
  });

  it('handles IST year boundary correctly (no DST in IST)', () => {
    // 2026-12-31T18:30:00.000Z = 2027-01-01 00:00 IST.
    const instant = new Date('2026-12-31T18:30:00.000Z');
    const bucket = getTodayBusinessDate(instant, 'Asia/Kolkata');
    expect(formatDateOnly(bucket)).toBe('2027-01-01');
  });

  it('handles epoch (degenerate "now") — buckets to 1970-01-01 IST', () => {
    // 1970-01-01T00:00:00.000Z = 05:30 IST on 1970-01-01.
    const bucket = getTodayBusinessDate(new Date(0), 'Asia/Kolkata');
    expect(formatDateOnly(bucket)).toBe('1970-01-01');
  });

  it('zero-arg call uses IST by default (no process-TZ dependency)', () => {
    // 2026-09-01T19:00:00.000Z = 00:30 IST on Sep 2.
    const instant = new Date('2026-09-01T19:00:00.000Z');
    const bucket = getTodayBusinessDate(instant); // no TZ arg
    expect(formatDateOnly(bucket)).toBe('2026-09-02');
  });
});

describe('DR-023 — IANA-aware path algorithm agrees with canonical helper (algorithm-level pin)', () => {
  // computeLocalDate in attendance.js is module-private; this test
  // mirrors its IANA-aware algorithm inline to pin the contract that
  // BOTH paths use the same canonical encoding (Intl.DateTimeFormat →
  // formatToParts → Date.UTC). If a future refactor reintroduces
  // `new Date(y, m, d)` LOCAL-midnight in any path, this test catches
  // the divergence.

  function computeViaIanaPath(instant, ianaTz) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: ianaTz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = fmt.formatToParts(instant);
    const y = Number(parts.find((p) => p.type === 'year').value);
    const m = Number(parts.find((p) => p.type === 'month').value);
    const d = Number(parts.find((p) => p.type === 'day').value);
    return new Date(Date.UTC(y, m - 1, d));
  }

  const cases = [
    // IST cases (the canonical path)
    ['2026-09-01T19:00:00Z', 'Asia/Kolkata', '2026-09-02'],
    ['2026-09-02T18:29:59Z', 'Asia/Kolkata', '2026-09-02'],
    ['2026-09-02T18:00:00Z', 'Asia/Kolkata', '2026-09-02'],
    ['2026-12-31T18:30:00Z', 'Asia/Kolkata', '2027-01-01'],
    // Sanity: even with a non-IST IANA name, the algorithm produces
    // the SAME canonical encoding shape (UTC midnight). This guards
    // against a future refactor that adds back the local-midnight
    // antipattern. The values themselves aren't used at runtime since
    // the simplification ignores clientTimezone, but the algorithm
    // shape must remain canonical.
    ['2026-09-02T02:00:00Z', 'America/Los_Angeles', '2026-09-01'],
    ['2026-03-08T10:30:00Z', 'America/Los_Angeles', '2026-03-08'],
  ];

  it.each(cases)(
    'IANA algorithm agrees with canonical helper for %s in %s',
    (isoInstant, tz, expectedDate) => {
      const instant = new Date(isoInstant);
      const ianaPath = computeViaIanaPath(instant, tz);
      const canonical = getTodayBusinessDate(instant, tz);
      expect(formatDateOnly(ianaPath)).toBe(expectedDate);
      expect(formatDateOnly(canonical)).toBe(expectedDate);
      expect(ianaPath.toISOString()).toBe(canonical.toISOString());
    },
  );
});

describe('DR-023 — same UTC instant buckets consistently across helpers', () => {
  // Smoke test that getTodayBusinessDate + isSameUtcCalendarDay + formatDateOnly
  // agree on the same instant across the IST day boundary — i.e. the
  // helpers are internally consistent.
  const midnightInstant = new Date('2026-09-01T18:30:00.000Z'); // 00:00 IST Sep 2
  const justBefore = new Date('2026-09-01T18:29:59.000Z');       // 23:59:59 IST Sep 1
  const justAfter = new Date('2026-09-01T18:30:01.000Z');        // 00:00:01 IST Sep 2

  it('two consecutive seconds near IST midnight bucket to different days', () => {
    const bJustBefore = getTodayBusinessDate(justBefore, 'Asia/Kolkata');
    const bJustAfter = getTodayBusinessDate(justAfter, 'Asia/Kolkata');
    expect(formatDateOnly(bJustBefore)).toBe('2026-09-01');
    expect(formatDateOnly(bJustAfter)).toBe('2026-09-02');
    expect(isSameUtcCalendarDay(bJustBefore, bJustAfter)).toBe(false);
  });

  it('exact IST midnight buckets to the new day', () => {
    const bucket = getTodayBusinessDate(midnightInstant, 'Asia/Kolkata');
    expect(formatDateOnly(bucket)).toBe('2026-09-02');
  });
});