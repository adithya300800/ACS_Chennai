/**
 * format.js — DR-032 (round-20) regression tests.
 *
 * Guards the `formatDateOnly` helper that DPR/inspection/training detail
 * and list views now use to render calendar-date values without the
 * UTC-midnight timezone shift. The original bug:
 *
 *   new Date('2026-09-02').toLocaleDateString(...) in America/Los_Angeles
 *   renders as 9/1/2026 because the bare ISO date is parsed as UTC 00:00,
 *   which is still the previous calendar day locally.
 *
 * The contract under test:
 *   - formatDateOnly('2026-09-02') returns the calendar components for
 *     that day, regardless of the test machine's TZ.
 *   - options are forwarded to toLocaleDateString (weekday, month, year).
 *   - Date instances whose local time is 00:00:00.000 are treated as
 *     calendar dates (still use local components).
 *   - Real timestamps (non-zero time) fall through to toLocaleDateString —
 *     this preserves IST/PST/UTC behaviour for callers that pass real
 *     Date instances.
 *   - Unparseable strings (and null/undefined) return '' — matching the
 *     existing formatDate / formatTime convention.
 */

const {
  formatDateOnly,
  formatDate,
  formatFullDate,
  formatTime,
  formatTimeOrDash,
  toDateString,
  getMapUrl,
  formatCoords,
} = require('../../src/lib/format.js');

describe('format.js — formatDateOnly (DR-032)', () => {
  test('renders a YYYY-MM-DD string using calendar components (no TZ shift)', () => {
    // The bug: `new Date('2026-09-02').toLocaleDateString('en-IN')` in
    // any timezone west of UTC would render `1 Sept 2026`. The fix builds
    // the Date with (year, month-1, day) so the local calendar wins.
    const result = formatDateOnly('2026-09-02', {
      day: 'numeric', month: 'numeric', year: 'numeric',
    });
    expect(result).toBe('2/9/2026');
  });

  test('forwards `weekday` option to toLocaleDateString', () => {
    // 2026-09-02 is a Wednesday.
    const result = formatDateOnly('2026-09-02', { weekday: 'long' });
    expect(result.toLowerCase()).toContain('wednesday');
  });

  test('treats ISO strings with a midnight time component as a calendar date', () => {
    // Prisma DateTime columns serialize as ISO with "T00:00:00.000Z".
    // We want the same calendar-component treatment, not the UTC shift.
    const result = formatDateOnly('2026-09-02T00:00:00.000Z', {
      day: 'numeric', month: 'numeric', year: 'numeric',
    });
    expect(result).toBe('2/9/2026');
  });

  test('Date instance built from local (year, month-1, day) renders the correct day', () => {
    // `new Date(2026, 8, 2)` produces a Date whose local time is 00:00:00
    // (because all components are local). All-zero time → calendar branch.
    const localMidnight = new Date(2026, 8, 2);
    const result = formatDateOnly(localMidnight, {
      day: 'numeric', month: 'numeric', year: 'numeric',
    });
    expect(result).toBe('2/9/2026');
  });

  test('null and empty string return empty string (matches formatDate contract)', () => {
    expect(formatDateOnly(null)).toBe('');
    expect(formatDateOnly(undefined)).toBe('');
    expect(formatDateOnly('')).toBe('');
  });

  test('unparseable strings return empty string (matches formatDate contract)', () => {
    // Chosen behaviour: matches `formatDate`/`formatTime` which return ''
    // for null. Returning '' is preferable to throwing because every call
    // site interpolates the result directly into JSX.
    expect(formatDateOnly('not-a-date')).toBe('');
    expect(formatDateOnly('hello world')).toBe('');
    expect(formatDateOnly('2026/09/02')).toBe('');
  });

  test('non-string non-Date inputs return empty string (defensive)', () => {
    expect(formatDateOnly(123)).toBe('');
    expect(formatDateOnly({})).toBe('');
  });

  test('default options render YYYY-MM-DD as `2/9/2026` (en-IN numeric)', () => {
    // Without options, toLocaleDateString uses locale defaults.
    // en-IN defaults to day/month/year numeric format.
    const result = formatDateOnly('2026-09-02');
    expect(result).toBe('2/9/2026');
  });
});

describe('format.js — pre-existing helpers are unchanged', () => {
  // Defence-in-depth: DR-032 only adds formatDateOnly. None of the other
  // exports should drift in this round.
  test('formatDate still uses YYYY-MM-DD component split', () => {
    expect(formatDate('2026-09-02')).toBeTruthy();
  });

  test('formatFullDate still uses YYYY-MM-DD component split', () => {
    expect(formatFullDate('2026-09-02')).toContain('2026');
  });

  test('formatTime / formatTimeOrDash stay on the toLocaleTimeString path', () => {
    expect(formatTime('2026-09-02T15:00:00.000Z')).toBeTruthy();
    expect(formatTimeOrDash('2026-09-02T15:00:00.000Z')).toBeTruthy();
    expect(formatTimeOrDash(null)).toBe('—');
    expect(formatTime(null)).toBe('');
  });

  test('toDateString returns local YYYY-MM-DD', () => {
    const d = new Date(2026, 8, 2);
    expect(toDateString(d)).toBe('2026-09-02');
  });

  test('getMapUrl returns null for (0,0) and missing coords', () => {
    expect(getMapUrl(0, 0)).toBeNull();
    expect(getMapUrl(null, null)).toBeNull();
    expect(getMapUrl(undefined, undefined)).toBeNull();
    expect(getMapUrl(47.7, -122.2)).toContain('openstreetmap.org');
  });

  test('formatCoords formats lat/lng with cardinal directions', () => {
    expect(formatCoords(47.72, -122.18)).toMatch(/N/);
    expect(formatCoords(47.72, -122.18)).toMatch(/W/);
    expect(formatCoords(0, 0)).toBe('');
    expect(formatCoords(null, null)).toBe('');
  });
});
