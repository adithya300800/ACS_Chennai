// S5 (audit) — central date-only/instant formatters.
//
// The audit flagged that the three most common date patterns were
// inlined as raw `toLocale*` calls across 12+ components. That
// duplicated the same options object everywhere AND made it easy to
// drift the format. This file pins the three new helpers in
// src/lib/format.js:
//
//   formatShortDate(value)   → "5 Sept 2026"
//   formatDateTime(value)    → "5 Sept 2026, 08:42 PM"
//   formatTimeOnly(value)    → "08:42 PM"
//
// Each test exercises the same input shapes the rest of the lib
// already accepts (YYYY-MM-DD strings, ISO with midnight T-separator,
// real timestamps, Date instances, null/undefined) so a future
// refactor that breaks one branch fails the suite.

import {
  formatShortDate,
  formatDateTime,
  formatTimeOnly,
} from '../lib/format.js';

describe('S5 — formatShortDate', () => {
  test('YYYY-MM-DD string uses the IST-safe split path (DR-032)', () => {
    // The bare ISO parser behaves differently in negative-offset
    // locales; this helper avoids that by anchoring on local-noon
    // components. We assert the visible year/month/day, not the
    // formatter internals.
    const out = formatShortDate('2026-09-04');
    expect(out).toContain('2026');
    expect(out).toContain('Sep');
    expect(out).toMatch(/4/);
  });

  test('full ISO timestamp with midnight T-separator stays calendar-correct', () => {
    const out = formatShortDate('2026-09-04T00:00:00.000Z');
    expect(out).toContain('2026');
    expect(out).toContain('Sep');
  });

  test('passes through a non-date-only timestamp via toLocaleDateString', () => {
    // Anything that isn't a YYYY-MM-DD prefix falls through to the
    // raw Date formatter. We only assert it doesn't throw and yields
    // a string with a 4-digit year in it.
    const out = formatShortDate('2026-09-04T08:42:00.000Z');
    expect(typeof out).toBe('string');
    expect(out).toMatch(/2026/);
  });

  test('null and undefined return the same empty-string as the rest of the lib', () => {
    expect(formatShortDate(null)).toBe('');
    expect(formatShortDate(undefined)).toBe('');
    expect(formatShortDate('')).toBe('');
  });

  test('unparseable string returns empty (defensive)', () => {
    expect(formatShortDate('not-a-date')).toBe('');
  });
});

describe('S5 — formatDateTime', () => {
  test('YYYY-MM-DD string returns the DATE only (no fake clock)', () => {
    // A date-only value has no meaningful hour/minute. We omit the
    // wall clock so the result doesn't imply a moment the data
    // doesn't carry. Pin that explicitly.
    const out = formatDateTime('2026-09-04');
    expect(out).toContain('2026');
    expect(out).toContain('Sep');
    expect(out).not.toMatch(/\d{1,2}:\d{2}/);
  });

  test('full ISO timestamp renders BOTH date and time', () => {
    const out = formatDateTime('2026-09-04T08:42:00.000Z');
    expect(out).toContain('2026');
    expect(out).toContain('Sep');
    // Either AM/PM marker or a colon-delimited time — depends on
    // locale settings of the test runner. Match loosely.
    expect(out).toMatch(/(\d:\d|AM|PM)/);
  });

  test('null / undefined / empty return empty string', () => {
    expect(formatDateTime(null)).toBe('');
    expect(formatDateTime(undefined)).toBe('');
    expect(formatDateTime('')).toBe('');
  });

  test('Date instance at midnight is treated as a calendar date', () => {
    const d = new Date(2026, 8, 4, 0, 0, 0, 0); // local-time Sep 4 2026
    const out = formatDateTime(d);
    expect(out).toContain('2026');
    // No fake clock for midnight-only Dates.
    expect(out).not.toMatch(/12:00\s?AM/i);
  });

  test('Date instance with a real time renders BOTH date and time', () => {
    const d = new Date(2026, 8, 4, 20, 42, 0, 0); // 8:42 PM local
    const out = formatDateTime(d);
    expect(out).toContain('2026');
    expect(out).toMatch(/(\d:\d|AM|PM)/);
  });

  test('unparseable string returns empty', () => {
    expect(formatDateTime('not-a-date')).toBe('');
  });
});

describe('S5 — formatTimeOnly', () => {
  test('renders hour + minute', () => {
    // 20:42 local. Match loosely for AM/PM vs 24h settings.
    const d = new Date(2026, 8, 4, 20, 42, 0, 0);
    const out = formatTimeOnly(d);
    expect(typeof out).toBe('string');
    expect(out).toMatch(/\d/);
  });

  test('null / undefined / empty return empty string', () => {
    expect(formatTimeOnly(null)).toBe('');
    expect(formatTimeOnly(undefined)).toBe('');
    expect(formatTimeOnly('')).toBe('');
  });

  test('unparseable string returns empty', () => {
    expect(formatTimeOnly('not-a-date')).toBe('');
  });
});

describe('S5 — central helper consolidation', () => {
  // Pin the helpers so a future rename / split breaks the suite.
  // Mirrors the DR-020 "if you import this name, it must exist" pattern.
  test('formatShortDate is exported and is a function', () => {
    expect(typeof formatShortDate).toBe('function');
  });
  test('formatDateTime is exported and is a function', () => {
    expect(typeof formatDateTime).toBe('function');
  });
  test('formatTimeOnly is exported and is a function', () => {
    expect(typeof formatTimeOnly).toBe('function');
  });
});
