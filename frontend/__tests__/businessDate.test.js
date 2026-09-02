/**
 * DR-026 (round-20) business-date tests.
 *
 * The original bug: training overdue badges compared
 * `enrollment.dueDate < new Date().toISOString().split('T')[0]` — which
 * is the UTC day, not the IST day. Between 00:00 and 05:29 IST that
 * comparison was off by one and badges rendered wrong.
 *
 * These tests pin the new helpers in `src/lib/businessDate.js`. The
 * React hook (`useBusinessDateKey`) is exercised through its underlying
 * `getBusinessToday` since rendering hooks requires @testing-library/react
 * setup we don't need to commit for this fix.
 */

const { getBusinessToday, isOverdue } = require('../../src/lib/businessDate.js');

describe('getBusinessToday (Asia/Kolkata)', () => {
  it('rolls to the next day at 00:00 IST (= 18:30 UTC the prior day)', () => {
    // 2026-09-02 18:30 UTC == 2026-09-03 00:00 IST
    expect(getBusinessToday(new Date('2026-09-02T18:30:00.000Z'), 'Asia/Kolkata')).toBe('2026-09-03');
  });

  it('stays on the prior day one minute earlier (23:59 IST)', () => {
    // 2026-09-02 18:29 UTC == 2026-09-02 23:59 IST
    expect(getBusinessToday(new Date('2026-09-02T18:29:00.000Z'), 'Asia/Kolkata')).toBe('2026-09-02');
  });

  it('matches the UTC day for clocks safely inside the IST window', () => {
    // 2026-09-02 06:00 UTC == 2026-09-02 11:30 IST — both dates agree.
    expect(getBusinessToday(new Date('2026-09-02T06:00:00.000Z'), 'Asia/Kolkata')).toBe('2026-09-02');
  });
});

describe('isOverdue', () => {
  const now = new Date('2026-09-02T19:00:00.000Z'); // 2026-09-03 00:30 IST

  it('flags a date strictly before the business today', () => {
    expect(isOverdue('2026-09-01', { now })).toBe(true);
  });

  it('does NOT flag a due date equal to today (still has the whole day)', () => {
    // The business day in IST right now is 2026-09-03; the due date matches.
    expect(isOverdue('2026-09-03', { now })).toBe(false);
  });

  it('does NOT flag a due date in the future', () => {
    expect(isOverdue('2026-09-04', { now })).toBe(false);
  });

  it('accepts a bare Date as the second argument (no wrapper object)', () => {
    expect(isOverdue('2026-09-01', now)).toBe(true);
  });

  it('returns false when the due date is missing or empty', () => {
    expect(isOverdue('', { now })).toBe(false);
    expect(isOverdue(null, { now })).toBe(false);
    expect(isOverdue(undefined, { now })).toBe(false);
  });

  it('tolerates a full ISO timestamp in the due date (split on T)', () => {
    // DB stores can come back as 'YYYY-MM-DDT00:00:00.000Z'. The function
    // only compares the date portion, so the time suffix is harmless.
    expect(isOverdue('2026-09-01T18:30:00.000Z', { now })).toBe(true);
    expect(isOverdue('2026-09-03T00:30:00.000Z', { now })).toBe(false);
  });
});
