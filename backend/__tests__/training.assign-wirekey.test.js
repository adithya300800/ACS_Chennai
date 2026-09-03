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
