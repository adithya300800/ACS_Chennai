/**
 * DR-031 (round-20): unit tests for the leaveRules helpers that pin the
 * inclusive lte/gte semantic for `@db.Date` overlap detection.
 *
 * Why this matters: a Prisma `@db.Date` value is a CALENDAR DAY, not a
 * half-open time range. A leave with startDate=endDate=Sept 4 is a
 * one-day leave covering Sept 4. Two leaves that touch on the same
 * calendar day must conflict. A half-open `lt`/`gt` rewrite would
 * silently stop flagging day-4-vs-day-4 conflicts.
 *
 * The same inclusive semantic is mirrored by:
 *   - The application-level precheck at leave.js (lte/gte)
 *   - The PostgreSQL EXCLUDE constraint `no_overlap_leave` (the migration
 *     in 20260902220220_dr009_leave_overlap_constraint/ uses
 *     `daterange(start_date, end_date + 1, '[]')` which is inclusive)
 *
 * If anyone tries to "fix" the predicate to half-open, these tests
 * will fail and force a re-audit of the constraint + the consumer routes.
 */

process.env.NODE_ENV = 'test';

const {
  rangesOverlap,
  inclusiveDayCount,
  validateCreatePayload,
  ALLOWED_LEAVE_TYPES,
  ALLOWED_LEAVE_STATUSES,
  parseLeaveDate,
  canTransition,
  httpStatusForCode,
} = require('../src/lib/leaveRules');

const day = (s) => new Date(`${s}T00:00:00.000Z`);

describe('DR-031 — leaveRules inclusive overlap semantic', () => {
  describe('rangesOverlap — the @db.Date canonical predicate', () => {
    it('returns TRUE when ranges share at least one calendar day', () => {
      expect(rangesOverlap(day('2026-09-01'), day('2026-09-05'), day('2026-09-05'), day('2026-09-09'))).toBe(true);
      expect(rangesOverlap(day('2026-09-05'), day('2026-09-09'), day('2026-09-01'), day('2026-09-05'))).toBe(true);
    });

    it('returns TRUE for two one-day leaves on the same day', () => {
      // The critical case: a half-open rewrite would silently let this
      // through as a non-conflict.
      expect(rangesOverlap(day('2026-09-04'), day('2026-09-04'), day('2026-09-04'), day('2026-09-04'))).toBe(true);
    });

    it('returns TRUE when one range is a single day inside another', () => {
      expect(rangesOverlap(day('2026-09-01'), day('2026-09-10'), day('2026-09-05'), day('2026-09-05'))).toBe(true);
    });

    it('returns FALSE for ranges that touch by one day boundary only', () => {
      // [Sept 1–5] vs [Sept 6–10] — no shared calendar day.
      expect(rangesOverlap(day('2026-09-01'), day('2026-09-05'), day('2026-09-06'), day('2026-09-10'))).toBe(false);
      expect(rangesOverlap(day('2026-09-06'), day('2026-09-10'), day('2026-09-01'), day('2026-09-05'))).toBe(false);
    });

    it('returns FALSE for completely disjoint ranges', () => {
      expect(rangesOverlap(day('2026-09-01'), day('2026-09-02'), day('2026-09-10'), day('2026-09-15'))).toBe(false);
    });

    it('returns FALSE on any null/undefined input (defensive)', () => {
      expect(rangesOverlap(null, day('2026-09-01'), day('2026-09-01'), day('2026-09-01'))).toBe(false);
      expect(rangesOverlap(day('2026-09-01'), day('2026-09-01'), null, day('2026-09-01'))).toBe(false);
      expect(rangesOverlap(undefined, undefined, undefined, undefined)).toBe(false);
    });
  });

  describe('inclusiveDayCount — same UTC-midnight inputs as the route', () => {
    it('counts a single-day leave as 1', () => {
      expect(inclusiveDayCount(day('2026-09-04'), day('2026-09-04'))).toBe(1);
    });

    it('counts consecutive days inclusively', () => {
      expect(inclusiveDayCount(day('2026-09-01'), day('2026-09-05'))).toBe(5);
    });

    it('returns 0 when endDate is before startDate', () => {
      expect(inclusiveDayCount(day('2026-09-10'), day('2026-09-01'))).toBe(0);
    });

    it('returns 0 on null inputs', () => {
      expect(inclusiveDayCount(null, day('2026-09-01'))).toBe(0);
      expect(inclusiveDayCount(day('2026-09-01'), null)).toBe(0);
    });
  });

  describe('parseLeaveDate — UTC midnight canonical shape', () => {
    it('returns UTC midnight for a YYYY-MM-DD string', () => {
      const d = parseLeaveDate('2026-09-04');
      expect(d.toISOString()).toBe('2026-09-04T00:00:00.000Z');
    });

    it('normalizes a Date input to UTC midnight of its calendar day', () => {
      const d = parseLeaveDate(new Date('2026-09-04T18:30:00.000Z'));
      expect(d.toISOString()).toBe('2026-09-04T00:00:00.000Z');
    });

    it('returns null on invalid input', () => {
      expect(parseLeaveDate(null)).toBeNull();
      expect(parseLeaveDate(undefined)).toBeNull();
      expect(parseLeaveDate('not-a-date')).toBeNull();
      expect(parseLeaveDate('2026-13-01')).toBeNull();   // month > 12
      expect(parseLeaveDate('2026-02-30')).toBeNull();   // Feb 30 rolls silently
      expect(parseLeaveDate(123)).toBeNull();            // non-string, non-Date
    });
  });

  describe('validateCreatePayload — guards the date shape', () => {
    // We don't exhaustively re-test the existing payload rules here —
    // leave.overlap.test.js already covers the precheck + EXCLUDE
    // constraint integration. This block pins the date semantic at the
    // validator level so a future half-open rewrite is caught here too.

    const basePayload = () => ({
      startDate: '2026-09-04',
      endDate: '2026-09-04',
      leaveType: 'CASUAL',
      reason: 'family event',
    });

    it('accepts a one-day leave (start == end)', () => {
      const result = validateCreatePayload(basePayload());
      expect(result.ok).toBe(true);
      expect(result.value.startDate.getTime()).toBe(day('2026-09-04').getTime());
      expect(result.value.endDate.getTime()).toBe(day('2026-09-04').getTime());
    });

    it('rejects when endDate < startDate', () => {
      const result = validateCreatePayload({ ...basePayload(), endDate: '2026-09-03' });
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_DATE_RANGE');
    });
  });

  describe('canTransition — leave state machine', () => {
    it('PENDING → APPROVED allowed', () => {
      expect(canTransition('PENDING', 'APPROVED')).toBe(true);
    });

    it('PENDING → REJECTED allowed', () => {
      expect(canTransition('PENDING', 'REJECTED')).toBe(true);
    });

    it('PENDING → CANCELLED allowed (owner cancel)', () => {
      expect(canTransition('PENDING', 'CANCELLED')).toBe(true);
    });

    it('APPROVED → anything is forbidden (terminal)', () => {
      expect(canTransition('APPROVED', 'CANCELLED')).toBe(false);
      expect(canTransition('APPROVED', 'REJECTED')).toBe(false);
    });

    it('unknown statuses rejected', () => {
      expect(canTransition('FOOBAR', 'APPROVED')).toBe(false);
      expect(canTransition('PENDING', 'FOOBAR')).toBe(false);
    });
  });

  describe('httpStatusForCode — wire mapping contract', () => {
    it('conflict codes (LEAVE_OVERLAP, LEAVE_ALREADY_DECIDED, SELF_APPROVAL) → 409', () => {
      expect(httpStatusForCode('LEAVE_OVERLAP')).toBe(409);
      expect(httpStatusForCode('LEAVE_ALREADY_DECIDED')).toBe(409);
      expect(httpStatusForCode('LEAVE_NOT_PENDING')).toBe(409);
      expect(httpStatusForCode('SELF_APPROVAL')).toBe(409);
      expect(httpStatusForCode('DUPLICATE')).toBe(409);
    });

    it('validation codes → 400', () => {
      expect(httpStatusForCode('INVALID_START_DATE')).toBe(400);
      expect(httpStatusForCode('INVALID_DATE_RANGE')).toBe(400);
      expect(httpStatusForCode('REASON_TOO_SHORT')).toBe(400);
    });

    it('NOT_FOUND → 404', () => {
      expect(httpStatusForCode('NOT_FOUND')).toBe(404);
    });

    it('FORBIDDEN → 403', () => {
      expect(httpStatusForCode('FORBIDDEN')).toBe(403);
    });

    it('unknown code → 400 (safe default)', () => {
      expect(httpStatusForCode('NOT_A_REAL_CODE')).toBe(400);
    });
  });

  describe('allowlists — server is source of truth', () => {
    it('ALLOWED_LEAVE_TYPES is a closed set', () => {
      // If a new leave type is added to the enum, this assertion forces
      // the test author to look at every consumer that branches on type.
      expect([...ALLOWED_LEAVE_TYPES].sort()).toEqual(['CASUAL', 'EARNED', 'OPTIONAL', 'SICK', 'UNPAID']);
    });

    it('ALLOWED_LEAVE_STATUSES is a closed set', () => {
      expect([...ALLOWED_LEAVE_STATUSES].sort()).toEqual(['APPROVED', 'CANCELLED', 'PENDING', 'REJECTED']);
    });
  });
});
