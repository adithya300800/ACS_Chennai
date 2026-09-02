/**
 * DR-008 — unified cursor codec unit tests.
 *
 * Covers the encoder/decoder contract for keyset pagination over
 * (reportDate DESC, id DESC). The bug being fixed: the previous wire
 * format was `base64(<ISO timestamp>|<id>)` but the decoder validated
 * the date as YYYY-MM-DD, so every cursor failed on page 2. These
 * tests pin down the new contract so a future regression can't ship
 * silently.
 */
const {
  encodeCursor,
  decodeCursor,
  InvalidCursorError,
  _parseDateOnly,
  _toDateOnlyString,
} = require('../src/lib/cursor');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

describe('DR-008 — cursor codec', () => {
  describe('encodeCursor', () => {
    it('returns a base64url string for a Date + id', () => {
      const out = encodeCursor(new Date('2026-09-02T00:00:00.000Z'), 'abc-123');
      expect(typeof out).toBe('string');
      expect(out.length).toBeGreaterThan(0);
      // base64url alphabet — no '+' or '/', no padding
      expect(/^[A-Za-z0-9_-]+$/.test(out)).toBe(true);
    });

    it('accepts a YYYY-MM-DD string date', () => {
      const out = encodeCursor('2026-09-02', 'abc-123');
      expect(typeof out).toBe('string');
      expect(out.length).toBeGreaterThan(0);
    });

    it('rejects full ISO timestamps (contract is date-only)', () => {
      expect(() => encodeCursor('2026-09-02T00:00:00.000Z', 'x')).toThrow(InvalidCursorError);
    });

    it('rejects empty / non-string id', () => {
      expect(() => encodeCursor('2026-09-02', '')).toThrow(InvalidCursorError);
      expect(() => encodeCursor('2026-09-02', null)).toThrow(InvalidCursorError);
      expect(() => encodeCursor('2026-09-02', undefined)).toThrow(InvalidCursorError);
      expect(() => encodeCursor('2026-09-02', 123)).toThrow(InvalidCursorError);
    });

    it('rejects ids longer than 128 chars (tampered payload defense)', () => {
      const longId = 'a'.repeat(129);
      expect(() => encodeCursor('2026-09-02', longId)).toThrow(InvalidCursorError);
    });

    it('rejects invalid dates (silent rollover, out-of-range month/day)', () => {
      expect(() => encodeCursor('2026-02-30', 'x')).toThrow(InvalidCursorError);
      expect(() => encodeCursor('2026-13-01', 'x')).toThrow(InvalidCursorError);
      expect(() => encodeCursor('2026-00-01', 'x')).toThrow(InvalidCursorError);
      expect(() => encodeCursor('2026-12-00', 'x')).toThrow(InvalidCursorError);
      expect(() => encodeCursor('not-a-date', 'x')).toThrow(InvalidCursorError);
    });

    it('rejects Invalid Date instances', () => {
      expect(() => encodeCursor(new Date('garbage'), 'x')).toThrow(InvalidCursorError);
    });
  });

  describe('decodeCursor — happy path', () => {
    it('round-trips a Date input', () => {
      const d = new Date('2026-09-02T00:00:00.000Z');
      const cur = encodeCursor(d, 'abc-123');
      const out = decodeCursor(cur);
      expect(out.id).toBe('abc-123');
      expect(out.date).toBeInstanceOf(Date);
      expect(out.date.getTime()).toBe(d.getTime());
    });

    it('round-trips a YYYY-MM-DD string input', () => {
      const cur = encodeCursor('2026-09-02', 'abc-123');
      const out = decodeCursor(cur);
      expect(out.id).toBe('abc-123');
      expect(out.date.getUTCFullYear()).toBe(2026);
      expect(out.date.getUTCMonth()).toBe(8);
      expect(out.date.getUTCDate()).toBe(2);
    });

    it('produces a UTC midnight Date (matches @db.Date column)', () => {
      const cur = encodeCursor('2026-09-02', 'x');
      const out = decodeCursor(cur);
      expect(out.date.getUTCHours()).toBe(0);
      expect(out.date.getUTCMinutes()).toBe(0);
      expect(out.date.getUTCSeconds()).toBe(0);
      expect(out.date.getUTCMilliseconds()).toBe(0);
    });
  });

  describe('decodeCursor — malformed input', () => {
    it('throws INVALID_CURSOR on garbage', () => {
      expect(() => decodeCursor('garbage')).toThrow(InvalidCursorError);
      expect(() => decodeCursor('garbage')).toThrow(/INVALID_CURSOR|not valid/);
    });

    it('throws on non-string / empty input', () => {
      expect(() => decodeCursor('')).toThrow(InvalidCursorError);
      expect(() => decodeCursor(null)).toThrow(InvalidCursorError);
      expect(() => decodeCursor(undefined)).toThrow(InvalidCursorError);
      expect(() => decodeCursor(123)).toThrow(InvalidCursorError);
    });

    it('throws on valid JSON but bad date string', () => {
      const cur = b64('{"date":"not-a-date","id":"x"}');
      expect(() => decodeCursor(cur)).toThrow(InvalidCursorError);
    });

    it('throws on empty id', () => {
      const cur = b64('{"date":"2026-09-02","id":""}');
      expect(() => decodeCursor(cur)).toThrow(InvalidCursorError);
    });

    it('throws on rollover date (2026-02-30 → 2026-03-02)', () => {
      const cur = b64('{"date":"2026-02-30","id":"x"}');
      expect(() => decodeCursor(cur)).toThrow(InvalidCursorError);
    });

    it('throws on tampered JSON (correct shape, wrong field types)', () => {
      // date is a number, not a string
      expect(() => decodeCursor(b64('{"date":20260902,"id":"x"}'))).toThrow(InvalidCursorError);
      // id is a number
      expect(() => decodeCursor(b64('{"date":"2026-09-02","id":42}'))).toThrow(InvalidCursorError);
      // missing fields
      expect(() => decodeCursor(b64('{"date":"2026-09-02"}'))).toThrow(InvalidCursorError);
      expect(() => decodeCursor(b64('{"id":"x"}'))).toThrow(InvalidCursorError);
      // extra junk fields are allowed (forward-compat) but types must match
      const cur = b64('{"date":"2026-09-02","id":"x","extra":"ok"}');
      const out = decodeCursor(cur);
      expect(out.id).toBe('x');
    });

    it('throws on JSON array (not an object)', () => {
      expect(() => decodeCursor(b64('["2026-09-02","x"]'))).toThrow(InvalidCursorError);
    });

    it('throws on JSON null', () => {
      expect(() => decodeCursor(b64('null'))).toThrow(InvalidCursorError);
    });

    it('throws on oversize id (matches encoder cap)', () => {
      const cur = b64(`{"date":"2026-09-02","id":"${'a'.repeat(129)}"}`);
      expect(() => decodeCursor(cur)).toThrow(InvalidCursorError);
    });
  });

  describe('InvalidCursorError', () => {
    it('has code INVALID_CURSOR for route-handler mapping', () => {
      try {
        decodeCursor('garbage');
        throw new Error('should not reach here');
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidCursorError);
        expect(e.code).toBe('INVALID_CURSOR');
        expect(e.name).toBe('InvalidCursorError');
      }
    });
  });

  describe('_parseDateOnly', () => {
    it('returns a UTC midnight Date for YYYY-MM-DD', () => {
      const d = _parseDateOnly('2026-09-02');
      expect(d).toBeInstanceOf(Date);
      expect(d.getUTCFullYear()).toBe(2026);
      expect(d.getUTCMonth()).toBe(8);
      expect(d.getUTCDate()).toBe(2);
      expect(d.getUTCHours()).toBe(0);
    });

    it('returns null for invalid shapes', () => {
      expect(_parseDateOnly('2026-9-2')).toBeNull();
      expect(_parseDateOnly('2026/09/02')).toBeNull();
      expect(_parseDateOnly('2026-09-02T00:00:00Z')).toBeNull();
      expect(_parseDateOnly('not-a-date')).toBeNull();
      expect(_parseDateOnly(null)).toBeNull();
      expect(_parseDateOnly(undefined)).toBeNull();
      expect(_parseDateOnly(20260902)).toBeNull();
    });

    it('returns null for silent rollover (2026-02-30 → 2026-03-02)', () => {
      expect(_parseDateOnly('2026-02-30')).toBeNull();
    });
  });

  describe('_toDateOnlyString', () => {
    it('formats a Date as YYYY-MM-DD using UTC fields', () => {
      const d = new Date(Date.UTC(2026, 8, 2));
      expect(_toDateOnlyString(d)).toBe('2026-09-02');
    });

    it('passes through a valid YYYY-MM-DD string', () => {
      expect(_toDateOnlyString('2026-09-02')).toBe('2026-09-02');
    });

    it('throws InvalidCursorError on bad input', () => {
      expect(() => _toDateOnlyString('2026-9-2')).toThrow(InvalidCursorError);
      expect(() => _toDateOnlyString('garbage')).toThrow(InvalidCursorError);
      expect(() => _toDateOnlyString(123)).toThrow(InvalidCursorError);
    });
  });
});
