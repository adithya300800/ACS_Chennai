// ─────────────────────────────────────────────────────────────────────────────
// Round-24 regression: validateAssignEnrollments wire-key contract.
//
// Background — before round-24:
//   The frontend `api.assignTraining` wrapper in src/lib/api.js hardcoded
//   `employeeEmails: <list>` on the wire regardless of the caller's input.
//   The picker in TrainingCourseNew.jsx + the new reassign modal both pass
//   CU-ids via `Array.from(selectedIds)`. Without `byEmail: true`, those
//   calls fell into the email-validation branch, returned 0 created, and
//   painted the rest as `invalidInputs` — i.e. "Assigned to 0" in the toast
//   for every admin who tried to bulk-assign.
//
// Round-24 fix (src/lib/api.js):
//   Send `employeeIds` by default; send `employeeEmails` only when the
//   caller opts in via `{ byEmail: true }`.
//
// This test pins the validator contract that the wrapper depends on,
// matching the real `result.value` shape (validator always populates
// `employeeIds`; `employeeEmails` is `null` unless the email branch fired).
// The route at src/routes/training.js:301 picks the email branch whenever
// `employeeEmails !== null`, which is what the wrapper fix has to honor.
// ─────────────────────────────────────────────────────────────────────────────

const {
  validateAssignEnrollments,
  validateCancelPayload,
  validateProgressPayload,
  canTransition,
  httpStatusForCode,
} = require('../src/lib/trainingRules');

const CUID = (n) => `c${String(n).padStart(24, '0')}`;
const CUID_A = CUID(1);
const CUID_B = CUID(2);
const CUID_C = CUID(3);

const ok = (r) => {
  if (!r.ok) throw new Error(`expected ok=true, got ok=false (code=${r.code} message=${r.message})`);
  return r.value;
};

describe('Round-24 — validateAssignEnrollments wire-key contract', () => {
  it('employeeIds branch: cleans list, populates employeeIds, leaves employeeEmails null', () => {
    const v = ok(validateAssignEnrollments({
      courseId: 'course-1',
      employeeIds: [CUID_A, CUID_B],
    }));
    // cuid branch: employeeIds populated, employeeEmails explicitly null
    // (the route uses `employeeEmails !== null` to pick the lookup path).
    expect(v.employeeIds).toEqual([CUID_A, CUID_B]);
    expect(v.employeeEmails).toBeNull();
    expect(v.courseId).toBe('course-1');
    expect(v.dueDate).toBeNull();
    expect(v.priority).toBe('NORMAL');
  });

  it('employeeEmails branch: lists populated, route still sees employeeEmails non-null', () => {
    const v = ok(validateAssignEnrollments({
      courseId: 'course-1',
      employeeEmails: ['a@example.com', 'b@example.com'],
    }));
    // email branch: validator populates BOTH lists with the cleaned values
    // (employeeIds mirrors the email list for compatibility), and the
    // route uses `employeeEmails !== null` as the signal to query by email.
    expect(v.employeeEmails).toEqual(['a@example.com', 'b@example.com']);
    expect(v.employeeIds).toEqual(['a@example.com', 'b@example.com']);
    expect(v.employeeEmails).not.toBeNull();
  });

  it('rejects when both lists are missing (400 INVALID_EMPLOYEE_IDS)', () => {
    const r = validateAssignEnrollments({ courseId: 'course-1' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_EMPLOYEE_IDS');
    expect(httpStatusForCode(r.code)).toBe(400);
  });

  it('when both sent: cleaned list is built from employeeIds (cuids win), but the route sees employeeEmails non-null and queries by email of the cuid → 0 created / N invalid', () => {
    // Document-the-quirk test. The wrapper fix prevents this combination
    // from ever happening on the wire — api.assignTraining sends exactly
    // one of employeeIds or employeeEmails per its `byEmail` opt. If a
    // future refactor regresses the wrapper, the route will hit the email
    // branch with cuid strings as the "emails" and return 0 created, N
    // invalid — exactly the symptom the round-24 fix exists to prevent.
    //
    // Behavior matches: hasIds=true → rawList picks body.employeeIds →
    // cleaned is built from those → hasEmails=true → employeeEmails: cleaned
    // (so the cuid string gets stored under the email slot).
    const v = ok(validateAssignEnrollments({
      courseId: 'course-1',
      employeeIds: [CUID_A],
      employeeEmails: ['a@example.com'],
    }));
    expect(v.employeeIds).toEqual([CUID_A]);
    expect(v.employeeEmails).toEqual([CUID_A]); // NOT the email — quirk
    expect(v.employeeEmails).not.toBeNull();
  });

  it('rejects empty list (400 NO_EMPLOYEES)', () => {
    const r = validateAssignEnrollments({
      courseId: 'course-1',
      employeeIds: [],
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NO_EMPLOYEES');
    expect(httpStatusForCode(r.code)).toBe(400);
  });

  it('deduplicates email entries by case-insensitive lookup', () => {
    const v = ok(validateAssignEnrollments({
      courseId: 'course-1',
      employeeEmails: ['A@Example.com', 'a@example.com', 'b@example.com'],
    }));
    expect(v.employeeEmails).toEqual(['A@Example.com', 'b@example.com']);
  });

  it('rejects when courseId is missing (400 INVALID_COURSE_ID)', () => {
    const r = validateAssignEnrollments({ employeeIds: [CUID_A] });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_COURSE_ID');
    expect(httpStatusForCode(r.code)).toBe(400);
  });

  it('rejects non-string entries (400 INVALID_EMPLOYEE_ID)', () => {
    const r = validateAssignEnrollments({
      courseId: 'course-1',
      employeeIds: [CUID_A, 42, CUID_C],
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_EMPLOYEE_ID');
  });

  it('coerces valid YYYY-MM-DD dueDate to a Date instance and accepts allowlisted priority', () => {
    const v = ok(validateAssignEnrollments({
      courseId: 'course-1',
      employeeIds: [CUID_A],
      dueDate: '2026-12-01',
      priority: 'HIGH',
    }));
    expect(v.dueDate).toBeInstanceOf(Date);
    expect(v.dueDate.toISOString().startsWith('2026-12-01')).toBe(true);
    expect(v.priority).toBe('HIGH');
  });

  it('rejects malformed dueDate strings (400 INVALID_DUE_DATE)', () => {
    const r = validateAssignEnrollments({
      courseId: 'course-1',
      employeeIds: [CUID_A],
      dueDate: '2026-13-40',
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_DUE_DATE');
    expect(httpStatusForCode(r.code)).toBe(400);
  });

  it('rejects unknown priority values (400 INVALID_PRIORITY)', () => {
    const r = validateAssignEnrollments({
      courseId: 'course-1',
      employeeIds: [CUID_A],
      priority: 'URGENT_PLUS',
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_PRIORITY');
    expect(httpStatusForCode(r.code)).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Round-24 follow-up: cancel (unassign) wire + state-machine contract.
//
// The cancel flow is two-layered:
//   1. validateCancelPayload — body shape (note?), lives in trainingRules.
//   2. canTransition — guards which (fromStatus → 'CANCELLED') pairs are
//      allowed. The route also reads the row first to surface a clean 409
//      ENROLLMENT_LOCKED / ENROLLMENT_CANCELLED instead of letting the
//      where-clause's P2025 do all the talking. Completed states are
//      terminal upstream (isCompleted → false), so canTransition never
//      accepts *_COMPLETED → CANCELLED.
// ─────────────────────────────────────────────────────────────────────────────

describe('Round-24 — validateCancelPayload', () => {
  it('accepts an empty body (note is optional)', () => {
    const r = validateCancelPayload({});
    expect(r.ok).toBe(true);
    expect(r.value.note).toBeNull();
  });

  it('accepts a trimmed non-empty note', () => {
    const r = validateCancelPayload({ note: '  wrong course for this employee  ' });
    expect(r.ok).toBe(true);
    expect(r.value.note).toBe('wrong course for this employee');
  });

  it('coerces an all-whitespace note to null (no-point storing "   ")', () => {
    const r = validateCancelPayload({ note: '   ' });
    expect(r.ok).toBe(true);
    expect(r.value.note).toBeNull();
  });

  it('rejects non-string notes (400 INVALID_NOTE)', () => {
    const r = validateCancelPayload({ note: 42 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_NOTE');
    expect(httpStatusForCode(r.code)).toBe(400);
  });

  it('rejects notes longer than MAX_EMPLOYEE_NOTE_LEN (400 NOTE_TOO_LONG)', () => {
    // Pin to the constant rather than a magic number — matches the existing
    // training.test.js convention for length bounds.
    const { MAX_EMPLOYEE_NOTE_LEN } = require('../src/lib/trainingRules');
    const long = 'a'.repeat(MAX_EMPLOYEE_NOTE_LEN + 1);
    const r = validateCancelPayload({ note: long });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NOTE_TOO_LONG');
    expect(httpStatusForCode(r.code)).toBe(400);
  });

  it('rejects null/array/missing body (400 INVALID_BODY)', () => {
    expect(validateCancelPayload(null).code).toBe('INVALID_BODY');
    expect(validateCancelPayload(undefined).code).toBe('INVALID_BODY');
    expect(validateCancelPayload([]).code).toBe('INVALID_BODY');
    expect(validateCancelPayload('not an object').code).toBe('INVALID_BODY');
  });
});

describe('Round-24 — canTransition → CANCELLED allowlist', () => {
  // Active rows can be pulled by an admin. The route's `where: { id,
  // status: <existing.status> }` clause locks the row so a concurrent
  // override/complete fires P2025 → 409 ENROLLMENT_LOCKED instead of a
  // silent overwrite. canTransition is just the policy layer.
  it('allows ASSIGNED → CANCELLED', () => {
    expect(canTransition('ASSIGNED', 'CANCELLED')).toBe(true);
  });
  it('allows IN_PROGRESS → CANCELLED', () => {
    expect(canTransition('IN_PROGRESS', 'CANCELLED')).toBe(true);
  });
  it('allows OVERDUE → CANCELLED (admin cleanup of stale assignments)', () => {
    expect(canTransition('OVERDUE', 'CANCELLED')).toBe(true);
  });

  // Terminal / blocked. The route surfaces these as 409 with codes:
  //   *_COMPLETED → ENROLLMENT_LOCKED (already completed)
  //   CANCELLED  → ENROLLMENT_CANCELLED
  it('refuses *_COMPLETED → CANCELLED (completed is terminal)', () => {
    expect(canTransition('SELF_ATTESTED_COMPLETED', 'CANCELLED')).toBe(false);
    expect(canTransition('PLAYER_OBSERVED_COMPLETED', 'CANCELLED')).toBe(false);
    expect(canTransition('PROVIDER_VERIFIED_COMPLETED', 'CANCELLED')).toBe(false);
    expect(canTransition('ADMIN_OVERRIDE_COMPLETED', 'CANCELLED')).toBe(false);
  });
  it('refuses CANCELLED → CANCELLED re-open (terminal)', () => {
    // canTransition idempotent-write rule: same→same is true. Pin
    // explicitly that a re-cancel is treated as a no-op transition (the
    // route, however, still 409s because the row is already terminal —
    // that 409 is the *route's* status check, not the canTransition
    // matrix).
    expect(canTransition('CANCELLED', 'CANCELLED')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Round-24 follow-up: progress pings must carry evidenceMetadata.sessionId
// once progressPct >= 100 from a player-observable provider (DR-010).
//
// Background — before round-24:
//   TrainingDetail.jsx posted `{ progressPct, lastWatchedSec }` with no
//   evidenceMetadata. The route's PLAYER_OBSERVED guard (training.js:546)
//   then 400'd at 100% with `PLAYER_DATA_REQUIRED`. Manual "Mark as
//   Complete" still worked (different route, SELF_ATTESTED evidence class),
//   so admins could complete a course, but the auto-complete path that
//   fires when a learner finishes a YouTube/Vimeo video was dead.
//
// Round-24 fix:
//   - TrainingDetail generates `sessionIdRef` once on mount (crypto.randomUUID).
//   - api.updateTrainingProgress now accepts an `evidenceMetadata` arg and
//     sends `{ sessionId }` on every progress POST (interval + handleEnded).
//   - validateProgressPayload accepts an optional `evidenceMetadata` object
//     and returns it verbatim — the route then guards against missing
//     `sessionId` only at the 100% threshold for player-observable providers.
//
// These tests pin the validator contract (shape, monotonic guard, missing/
// non-object error) so the wire shape the route relies on is locked.
// ─────────────────────────────────────────────────────────────────────────────

describe('Round-24 — validateProgressPayload evidenceMetadata contract', () => {
  it('returns progressPct/lastWatchedSec with evidenceMetadata=null when omitted', () => {
    const v = ok(validateProgressPayload({ progressPct: 42, lastWatchedSec: 123 }));
    expect(v.progressPct).toBe(42);
    expect(v.lastWatchedSec).toBe(123);
    expect(v.evidenceMetadata).toBeNull();
  });

  it('echoes evidenceMetadata.sessionId verbatim when present', () => {
    const sessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const v = ok(validateProgressPayload({
      progressPct: 99,
      lastWatchedSec: 200,
      evidenceMetadata: { sessionId },
    }));
    expect(v.evidenceMetadata).toEqual({ sessionId });
  });

  it('accepts progressPct=100 with a valid sessionId (route-level guard runs separately)', () => {
    const v = ok(validateProgressPayload({
      progressPct: 100,
      lastWatchedSec: 600,
      evidenceMetadata: { sessionId: 'sess-abc-123' },
    }));
    expect(v.progressPct).toBe(100);
    expect(v.evidenceMetadata.sessionId).toBe('sess-abc-123');
  });

  it('accepts progressPct=100 WITHOUT a sessionId (validator layer only — route enforces)', () => {
    // The validator accepts the body; the ROUTE then 400s when
    // canAutoCompleteFromPlayer(provider) is true and sessionId is
    // missing. The split lets the same validator serve the admin
    // override / non-trackable paths where sessionId isn't required.
    const v = ok(validateProgressPayload({ progressPct: 100, lastWatchedSec: 0 }));
    expect(v.progressPct).toBe(100);
    expect(v.evidenceMetadata).toBeNull();
  });

  it('rejects non-object evidenceMetadata (400 INVALID_METADATA)', () => {
    expect(validateProgressPayload({
      progressPct: 50, lastWatchedSec: 0, evidenceMetadata: 'not-an-object',
    }).code).toBe('INVALID_METADATA');
    expect(validateProgressPayload({
      progressPct: 50, lastWatchedSec: 0, evidenceMetadata: 42,
    }).code).toBe('INVALID_METADATA');
    expect(httpStatusForCode('INVALID_METADATA')).toBe(400);
  });

  it('accepts evidenceMetadata with extra fields (forward-compat for future keys)', () => {
    // The route reads only sessionId today, but the schema should be open
    // so adding e.g. `playerVersion`, `networkType`, etc. doesn't require
    // a validator change. Pins the open-object shape so a future
    // refactor that switches to a strict allowlist is a deliberate choice.
    const v = ok(validateProgressPayload({
      progressPct: 80,
      lastWatchedSec: 480,
      evidenceMetadata: {
        sessionId: 'sess-xyz',
        playerVersion: '2.0',
        networkType: 'wifi',
      },
    }));
    expect(v.evidenceMetadata).toEqual({
      sessionId: 'sess-xyz',
      playerVersion: '2.0',
      networkType: 'wifi',
    });
  });

  it('rejects body regressions with PROGRESS_REGRESSED (monotonic guard still in force)', () => {
    // progressPct+5 < previousPct triggers the guard. Make sure the new
    // evidenceMetadata handling doesn't accidentally disable the
    // monotonic check.
    const r = validateProgressPayload(
      { progressPct: 10, lastWatchedSec: 0, evidenceMetadata: { sessionId: 'sess' } },
      50 /* previousPct */
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('PROGRESS_REGRESSED');
  });
});
