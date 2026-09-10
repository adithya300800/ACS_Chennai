/**
 * DR-019 (audit, 2026-09-08) — instant-preserving cursor codec.
 *
 * The shared `encodeCursor` truncates a DateTime to `YYYY-MM-DD`
 * (UTC midnight) so it can match a `@db.Date` column. That's wrong for
 * keyset pagination over an `DateTime` column (e.g.
 * VariationOrder.createdAt): the cursor encoded only the calendar day,
 * so the seek predicate `(createdAt < cursor.date)` matched nothing
 * on that day past midnight, and `(createdAt = cursor.date, id <
 * cursor.id)` matched only same-instant rows. A project with 21
 * same-day VOs only returned the first page — every later row had
 * `createdAt > cursor.date (midnight)` AND `createdAt != cursor.date
 * (midnight)`, invisible to the seek.
 *
 * Fix: a new instant codec that carries the unix-ms timestamp so the
 * seek can carry a sub-day timestamp forward and tie-break same-instant
 * rows by id. Versioned wire format (`v: 1`) so a hand-crafted legacy
 * date-only cursor fails loudly rather than silently truncating.
 *
 * Acceptance:
 *   1. encodeInstantCursor(Date, id) → base64url JSON.
 *   2. decodeInstantCursor round-trips the exact instant.
 *   3. A legacy date-only cursor (no `v`) is rejected.
 *   4. The codec preserves sub-day precision (millisecond).
 *   5. Tampered / malformed cursors throw InvalidCursorError.
 */
'use strict';

const {
  encodeInstantCursor,
  decodeInstantCursor,
  encodeCursor, // sanity-check the shared codec still works on date-only
  decodeCursor,
  InvalidCursorError,
} = require('../src/lib/cursor');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const b64u = (s) => Buffer.from(s, 'utf8').toString('base64url');

describe('DR-019 — instant cursor codec', () => {
  describe('encodeInstantCursor', () => {
    it('returns a base64url string for a Date + id', () => {
      const out = encodeInstantCursor(new Date('2026-09-08T14:30:00.123Z'), 'abc-123');
      expect(typeof out).toBe('string');
      expect(out.length).toBeGreaterThan(0);
      expect(/^[A-Za-z0-9_-]+$/.test(out)).toBe(true);
    });

    it('rejects non-Date inputs (must be a DateTime instance, not date-only string)', () => {
      // The whole point of this codec: don't accept a YYYY-MM-DD string
      // because callers should reach for the shared `encodeCursor`
      // (date+id) when they want date-only semantics.
      expect(() => encodeInstantCursor('2026-09-08', 'x')).toThrow(InvalidCursorError);
      expect(() => encodeInstantCursor('2026-09-08T14:30:00.000Z', 'x')).toThrow(InvalidCursorError);
      expect(() => encodeInstantCursor(null, 'x')).toThrow(InvalidCursorError);
      expect(() => encodeInstantCursor(123, 'x')).toThrow(InvalidCursorError);
    });

    it('rejects invalid Date instances', () => {
      expect(() => encodeInstantCursor(new Date('garbage'), 'x')).toThrow(InvalidCursorError);
    });

    it('rejects empty / non-string id', () => {
      const d = new Date('2026-09-08T14:30:00.123Z');
      expect(() => encodeInstantCursor(d, '')).toThrow(InvalidCursorError);
      expect(() => encodeInstantCursor(d, null)).toThrow(InvalidCursorError);
      expect(() => encodeInstantCursor(d, undefined)).toThrow(InvalidCursorError);
      expect(() => encodeInstantCursor(d, 123)).toThrow(InvalidCursorError);
    });

    it('rejects ids longer than 128 chars (tampered payload defense)', () => {
      const longId = 'a'.repeat(129);
      expect(() => encodeInstantCursor(new Date('2026-09-08T00:00:00.000Z'), longId)).toThrow(InvalidCursorError);
    });
  });

  describe('decodeInstantCursor — happy path', () => {
    it('round-trips a Date input with sub-day precision', () => {
      const d = new Date('2026-09-08T14:30:00.123Z');
      const cur = encodeInstantCursor(d, 'abc-123');
      const out = decodeInstantCursor(cur);
      expect(out.id).toBe('abc-123');
      expect(out.date).toBeInstanceOf(Date);
      // Exact millisecond preservation — the whole point of this codec.
      expect(out.date.getTime()).toBe(d.getTime());
    });

    it('preserves midnight boundary (00:00:00.000)', () => {
      const d = new Date('2026-09-08T00:00:00.000Z');
      const cur = encodeInstantCursor(d, 'x');
      const out = decodeInstantCursor(cur);
      expect(out.date.getTime()).toBe(d.getTime());
      expect(out.date.getUTCHours()).toBe(0);
      expect(out.date.getUTCMilliseconds()).toBe(0);
    });

    it('preserves pre-epoch instants (negative ms)', () => {
      // Defensive: although VO rows are recent, the codec shouldn't
      // blow up on edge timestamps if a long-lived archive row ever
      // shows up.
      const d = new Date('1969-12-31T23:59:59.999Z');
      const cur = encodeInstantCursor(d, 'x');
      const out = decodeInstantCursor(cur);
      expect(out.date.getTime()).toBe(d.getTime());
    });

    it('wire format is versioned (v: 1) and carries ms as integer', () => {
      const cur = encodeInstantCursor(new Date('2026-09-08T14:30:00.123Z'), 'x');
      const decoded = JSON.parse(Buffer.from(cur, 'base64url').toString('utf8'));
      expect(decoded.v).toBe(1);
      expect(typeof decoded.ms).toBe('number');
      expect(Number.isInteger(decoded.ms)).toBe(true);
      expect(decoded.ms).toBe(new Date('2026-09-08T14:30:00.123Z').getTime());
    });
  });

  describe('decodeInstantCursor — malformed input', () => {
    it('throws INVALID_CURSOR on garbage', () => {
      expect(() => decodeInstantCursor('garbage')).toThrow(InvalidCursorError);
    });

    it('throws on non-string / empty input', () => {
      expect(() => decodeInstantCursor('')).toThrow(InvalidCursorError);
      expect(() => decodeInstantCursor(null)).toThrow(InvalidCursorError);
      expect(() => decodeInstantCursor(undefined)).toThrow(InvalidCursorError);
      expect(() => decodeInstantCursor(123)).toThrow(InvalidCursorError);
    });

    it('throws on JSON null', () => {
      expect(() => decodeInstantCursor(b64u('null'))).toThrow(InvalidCursorError);
    });

    it('throws on JSON array', () => {
      expect(() => decodeInstantCursor(b64u('["2026-09-08","x"]'))).toThrow(InvalidCursorError);
    });

    it('throws on legacy date-only cursor (v missing)', () => {
      // A cursor produced by the SHARED encodeCursor (date+id) must not
      // be silently accepted here — the seek would mis-translate the
      // truncated date as an instant and silently drop same-day rows.
      const sharedCur = encodeCursor('2026-09-08', 'x');
      expect(() => decodeInstantCursor(sharedCur)).toThrow(/v must be 1/);
    });

    it('throws on cursors with v !== 1', () => {
      expect(() => decodeInstantCursor(b64u('{"v":2,"ms":123,"id":"x"}'))).toThrow(/v must be 1/);
      expect(() => decodeInstantCursor(b64u('{"ms":123,"id":"x"}'))).toThrow(/v must be 1/);
    });

    it('throws on missing ms / wrong type', () => {
      expect(() => decodeInstantCursor(b64u('{"v":1,"id":"x"}'))).toThrow(/ms/);
      expect(() => decodeInstantCursor(b64u('{"v":1,"ms":"123","id":"x"}'))).toThrow(/ms/);
      expect(() => decodeInstantCursor(b64u('{"v":1,"ms":1.5,"id":"x"}'))).toThrow(/ms/);
      // `null` is not a number — must also fail the type check.
      expect(() => decodeInstantCursor(b64u('{"v":1,"ms":null,"id":"x"}'))).toThrow(/ms/);
    });

    it('throws on missing / bad id', () => {
      expect(() => decodeInstantCursor(b64u('{"v":1,"ms":123}'))).toThrow(/id/);
      expect(() => decodeInstantCursor(b64u('{"v":1,"ms":123,"id":""}'))).toThrow(/id/);
      expect(() => decodeInstantCursor(b64u(`{"v":1,"ms":123,"id":"${'a'.repeat(129)}"}`))).toThrow(/id/);
    });

    it('throws on bad base64', () => {
      expect(() => decodeInstantCursor('###not-base64###')).toThrow(InvalidCursorError);
    });
  });

  describe('codec independence — shared encodeCursor is unaffected', () => {
    it('the shared codec still produces a date-only cursor (regression pin)', () => {
      const cur = encodeCursor(new Date('2026-09-08T14:30:00.123Z'), 'x');
      const decoded = JSON.parse(Buffer.from(cur, 'base64url').toString('utf8'));
      // Shared codec still uses date+id shape, NOT the instant shape —
      // [DR-019] acceptance that the change is additive only.
      expect(decoded.date).toBe('2026-09-08');
      expect(decoded.id).toBe('x');
      expect(decoded.ms).toBeUndefined();
      expect(decoded.v).toBeUndefined();
    });

    it('shared decodeCursor still accepts a legacy date-only cursor (backward compat)', () => {
      const cur = b64('{"date":"2026-09-08","id":"x"}');
      const out = decodeCursor(cur);
      expect(out.id).toBe('x');
      expect(out.date).toBeInstanceOf(Date);
      expect(out.date.getUTCDate()).toBe(8);
    });
  });
});
