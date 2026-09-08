// DR-029 (audit, 2026-09-08) — event timestamps render in the company
// timezone (Asia/Kolkata) so the IST morning of 8 Sept shows "8 Sept"
// rather than the previous UTC day "7 Sept".
//
// Audit finding: a date-only formatter applied to a full ISO instant
// preserves the UTC date. Between 00:00 and 05:29 IST every event
// timestamp displayed the previous calendar day, disagreeing with the
// IST header rendered by businessDate.js.
//
// Fix: formatDateTime / formatShortDate / formatTimeOnly all force
// `timeZone: 'Asia/Kolkata'` on their `toLocaleString` / `toLocaleTimeString`
// calls so the wall-clock matches the business date regardless of the
// browser TZ.
//
// Run: cd src && npx jest __tests__/format-dr029-ist.test.js
// ─────────────────────────────────────────────────────────────────────────────

import { formatDateTime, formatShortDate, formatTimeOnly } from '../lib/format.js';

// Test cases pin the IST morning / UTC evening boundary that
// triggered the audit finding. The instant `2026-09-07T19:30:00.000Z`
// is 01:00 IST on 8 Sept — the header would say "8 Sept" but the
// formatter previously rendered "7 Sept" because the browser TZ was
// UTC.

describe('DR-029 — event timestamps render in Asia/Kolkata', () => {
  test('1. formatDateTime on a 01:00 IST instant shows 8 Sept, not 7 Sept', () => {
    // 01:00 IST on 8 Sept 2026 = 19:30 UTC on 7 Sept 2026.
    const out = formatDateTime('2026-09-07T19:30:00.000Z');
    expect(out).toMatch(/8 Sept/);
    expect(out).toMatch(/01:00/);
    expect(out).not.toMatch(/7 Sept/);
  });

  test('2. formatShortDate on a 01:00 IST instant shows 8 Sept, not 7 Sept', () => {
    const out = formatShortDate('2026-09-07T19:30:00.000Z');
    expect(out).toMatch(/8 Sept 2026/);
    expect(out).not.toMatch(/7 Sept 2026/);
  });

  test('3. formatTimeOnly on a 01:00 IST instant shows 01:00 AM', () => {
    const out = formatTimeOnly('2026-09-07T19:30:00.000Z');
    expect(out).toMatch(/01:00/);
  });

  test('4. formatDateTime on a 23:30 IST instant shows the correct IST day', () => {
    // 23:30 IST on 8 Sept = 18:00 UTC on 8 Sept.
    const out = formatDateTime('2026-09-08T18:00:00.000Z');
    expect(out).toMatch(/8 Sept/);
    expect(out).toMatch(/11:30/);
  });

  test('5. formatDateTime on a date-only input still uses calendar date (no TZ drift)', () => {
    // A YYYY-MM-DD string IS a calendar day, not a moment — it must
    // round-trip verbatim regardless of the browser TZ. The audit
    // explicitly says: leave report/bill/leave calendar dates as
    // date-only values.
    expect(formatDateTime('2026-09-08')).toMatch(/8 Sept/);
    expect(formatDateTime('2026-09-08')).not.toMatch(/7 Sept/);
  });

  test('6. formatDateTime returns empty string for null / unparseable', () => {
    expect(formatDateTime(null)).toBe('');
    expect(formatDateTime('')).toBe('');
    expect(formatDateTime('not-a-date')).toBe('');
  });
});
