/**
 * DR-023: canonical date-only helper.
 *
 * Every "date-only" Date in the codebase MUST round-trip through this
 * module so Prisma 5.22's @db.Date encoding is unambiguous. The tests
 * below pin the contract — change the helper, expect to update these.
 */

const {
  InvalidDateOnlyError,
  InvalidMonthRangeError,
  dateOnlyToUtc,
  parseDateOnlyToUtc,
  getTodayBusinessDate,
  getMonthRangeUtc,
  isSameUtcCalendarDay,
  formatDateOnly,
} = require('../src/lib/dateOnly');

describe('dateOnly — canonical helpers (DR-023)', () => {
  describe('dateOnlyToUtc', () => {
    it('returns UTC midnight for a valid (y, m, d)', () => {
      const d = dateOnlyToUtc(2026, 9, 2);
      expect(d.toISOString()).toBe('2026-09-02T00:00:00.000Z');
      expect(d.getUTCFullYear()).toBe(2026);
      expect(d.getUTCMonth()).toBe(8); // September is 8 (0-indexed)
      expect(d.getUTCDate()).toBe(2);
    });
  });

  describe('parseDateOnlyToUtc', () => {
    it('parses a valid YYYY-MM-DD into UTC midnight', () => {
      const d = parseDateOnlyToUtc('2026-09-02');
      expect(d.getTime()).toBe(Date.UTC(2026, 8, 2));
      expect(d.toISOString()).toBe('2026-09-02T00:00:00.000Z');
    });

    it('parses January 1 without rolling into the previous year', () => {
      const d = parseDateOnlyToUtc('2026-01-01');
      expect(d.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    });

    it('parses December 31 without rolling into the next year', () => {
      const d = parseDateOnlyToUtc('2026-12-31');
      expect(d.toISOString()).toBe('2026-12-31T00:00:00.000Z');
    });

    it('throws InvalidDateOnlyError on month > 12', () => {
      expect(() => parseDateOnlyToUtc('2026-13-01')).toThrow(InvalidDateOnlyError);
    });

    it('throws InvalidDateOnlyError on month < 1', () => {
      expect(() => parseDateOnlyToUtc('2026-00-15')).toThrow(InvalidDateOnlyError);
    });

    it('throws InvalidDateOnlyError on Feb 30 (calendar-incoherent day)', () => {
      expect(() => parseDateOnlyToUtc('2026-02-30')).toThrow(InvalidDateOnlyError);
    });

    it('throws InvalidDateOnlyError on Apr 31', () => {
      expect(() => parseDateOnlyToUtc('2026-04-31')).toThrow(InvalidDateOnlyError);
    });

    it('throws InvalidDateOnlyError on non-date strings', () => {
      expect(() => parseDateOnlyToUtc('not-a-date')).toThrow(InvalidDateOnlyError);
    });

    it('throws InvalidDateOnlyError on empty string', () => {
      expect(() => parseDateOnlyToUtc('')).toThrow(InvalidDateOnlyError);
    });

    it('throws InvalidDateOnlyError on non-string input', () => {
      expect(() => parseDateOnlyToUtc(null)).toThrow(InvalidDateOnlyError);
      expect(() => parseDateOnlyToUtc(20260902)).toThrow(InvalidDateOnlyError);
      expect(() => parseDateOnlyToUtc({})).toThrow(InvalidDateOnlyError);
    });

    it('throws on a string with extra characters (strict 10-char shape)', () => {
      expect(() => parseDateOnlyToUtc('2026-09-02T00:00:00Z')).toThrow(InvalidDateOnlyError);
      expect(() => parseDateOnlyToUtc(' 2026-09-02')).toThrow(InvalidDateOnlyError);
    });
  });

  describe('getTodayBusinessDate', () => {
    it('rolls forward across the IST midnight boundary (19:30Z = 01:00 IST next day)', () => {
      // 2026-09-02T19:30:00Z = 2026-09-03T01:00:00 IST. In IST, the
      // business date is 2026-09-03, NOT 2026-09-02.
      const d = getTodayBusinessDate(new Date('2026-09-02T19:30:00Z'), 'Asia/Kolkata');
      expect(d.toISOString()).toBe('2026-09-03T00:00:00.000Z');
    });

    it('stays on the same IST day for instants before the IST midnight', () => {
      // 2026-09-02T18:29:00Z = 2026-09-02T23:59:00 IST — still 2026-09-02.
      const d = getTodayBusinessDate(new Date('2026-09-02T18:29:00Z'), 'Asia/Kolkata');
      expect(d.toISOString()).toBe('2026-09-02T00:00:00.000Z');
    });

    it('defaults to Asia/Kolkata when no timezone is passed', () => {
      // 2026-09-02T19:30:00Z is past IST midnight for 2026-09-02, so the
      // default timezone yields 2026-09-03.
      const d = getTodayBusinessDate(new Date('2026-09-02T19:30:00Z'));
      expect(d.toISOString()).toBe('2026-09-03T00:00:00.000Z');
    });

    it('respects an explicit non-IST timezone (UTC)', () => {
      // 2026-09-02T23:30:00Z is still 2026-09-02 in UTC.
      const d = getTodayBusinessDate(new Date('2026-09-02T23:30:00Z'), 'UTC');
      expect(d.toISOString()).toBe('2026-09-02T00:00:00.000Z');
    });
  });

  describe('getMonthRangeUtc', () => {
    it('returns half-open range for a regular month', () => {
      const { startDate, endDate } = getMonthRangeUtc('2026-08');
      expect(startDate.toISOString()).toBe('2026-08-01T00:00:00.000Z');
      expect(endDate.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    });

    it('rolls over from December to January of the next year', () => {
      const { startDate, endDate } = getMonthRangeUtc('2026-12');
      expect(startDate.toISOString()).toBe('2026-12-01T00:00:00.000Z');
      expect(endDate.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    });

    it('handles February (non-leap) by giving 2026-03-01 as endDate', () => {
      const { startDate, endDate } = getMonthRangeUtc('2026-02');
      expect(startDate.toISOString()).toBe('2026-02-01T00:00:00.000Z');
      expect(endDate.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    });
  });

  describe('getMonthRangeUtc — DR-030 strict validation', () => {
    // Before DR-030 the helper silently rolled overflowing inputs forward:
    //   "2026-13" → 2027-02-01 (via Date.UTC(y, 12, 1) == Feb 1 next year)
    //   "2026-00" → 2025-12-01 (via Date.UTC(y, -1, 1) == Dec prev year)
    // The /attendance list endpoint used to return data for the wrong month
    // instead of failing loudly. These tests pin the new contract: throw
    // InvalidMonthRangeError, never silently roll.

    it('throws InvalidMonthRangeError on month > 12 (was: silently rolled to Feb next year)', () => {
      expect(() => getMonthRangeUtc('2026-13')).toThrow(InvalidMonthRangeError);
      // Pin the code so the route handler's `instanceof` check survives a
      // rename.
      try { getMonthRangeUtc('2026-13'); } catch (e) {
        expect(e.code).toBe('INVALID_MONTH');
      }
    });

    it('throws InvalidMonthRangeError on month < 1 (was: silently rolled to Dec prev year)', () => {
      expect(() => getMonthRangeUtc('2026-00')).toThrow(InvalidMonthRangeError);
    });

    it('throws InvalidMonthRangeError on non-canonical shape', () => {
      expect(() => getMonthRangeUtc('2026-1')).toThrow(InvalidMonthRangeError);
      expect(() => getMonthRangeUtc('26-01')).toThrow(InvalidMonthRangeError);
      expect(() => getMonthRangeUtc('2026/01')).toThrow(InvalidMonthRangeError);
      expect(() => getMonthRangeUtc('2026-01-15')).toThrow(InvalidMonthRangeError);
      expect(() => getMonthRangeUtc('')).toThrow(InvalidMonthRangeError);
    });

    it('throws InvalidMonthRangeError on a non-string input', () => {
      expect(() => getMonthRangeUtc(null)).toThrow(InvalidMonthRangeError);
      expect(() => getMonthRangeUtc(undefined)).toThrow(InvalidMonthRangeError);
      expect(() => getMonthRangeUtc(202609)).toThrow(InvalidMonthRangeError);
      expect(() => getMonthRangeUtc({})).toThrow(InvalidMonthRangeError);
    });

    it('accepts the boundary months 01 and 12', () => {
      const jan = getMonthRangeUtc('2026-01');
      expect(jan.startDate.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(jan.endDate.toISOString()).toBe('2026-02-01T00:00:00.000Z');

      const dec = getMonthRangeUtc('2026-12');
      expect(dec.startDate.toISOString()).toBe('2026-12-01T00:00:00.000Z');
      expect(dec.endDate.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    });
  });

  describe('isSameUtcCalendarDay', () => {
    it('matches two UTC-midnight Dates on the same day', () => {
      expect(
        isSameUtcCalendarDay(
          new Date(Date.UTC(2026, 8, 2, 0, 0, 0)),
          new Date(Date.UTC(2026, 8, 2, 23, 59, 59))
        )
      ).toBe(true);
    });

    it('rejects two Dates on different days', () => {
      expect(
        isSameUtcCalendarDay(
          new Date(Date.UTC(2026, 8, 2, 23, 59, 59)),
          new Date(Date.UTC(2026, 8, 3, 0, 0, 1))
        )
      ).toBe(false);
    });

    it('returns false for invalid Dates', () => {
      expect(isSameUtcCalendarDay(new Date('not-a-date'), new Date())).toBe(false);
      expect(isSameUtcCalendarDay(null, new Date())).toBe(false);
      expect(isSameUtcCalendarDay(undefined, new Date())).toBe(false);
    });

    it('treats an IST-local 2026-09-02 instant as the previous UTC day', () => {
      // IST 2026-09-02 09:00 = UTC 2026-09-02 03:30 — same day.
      // IST 2026-09-03 00:30 = UTC 2026-09-02 19:00 — different days
      // in UTC. This is the off-by-one axis the bug fix closes.
      const a = new Date('2026-09-02T03:30:00Z');
      const b = new Date('2026-09-02T19:00:00Z');
      expect(isSameUtcCalendarDay(a, b)).toBe(false);
    });
  });

  describe('formatDateOnly', () => {
    it('formats a UTC-midnight Date as YYYY-MM-DD', () => {
      expect(formatDateOnly(new Date(Date.UTC(2026, 8, 2)))).toBe('2026-09-02');
    });

    it('uses UTC components, not local time', () => {
      // 2026-09-02T18:30:00Z is 2026-09-03 in IST local time but
      // 2026-09-02 in UTC. We want UTC components for round-tripping
      // through Prisma 5.22's @db.Date encoding.
      const d = new Date('2026-09-02T18:30:00Z');
      expect(formatDateOnly(d)).toBe('2026-09-02');
    });

    it('returns null for invalid Dates', () => {
      expect(formatDateOnly(new Date('not-a-date'))).toBeNull();
      expect(formatDateOnly(null)).toBeNull();
      expect(formatDateOnly(undefined)).toBeNull();
    });
  });
});
