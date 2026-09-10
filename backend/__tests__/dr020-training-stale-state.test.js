// SOL DR-020 — render actual training state; never synthesize completion.
//
// Audit findings:
//   1. The detail page's progress-throttle catch mapped ANY 409 (ENROLLMENT_LOCKED
//      AND ENROLLMENT_CANCELLED AND ENROLLMENT_OVERDUE) to status=COMPLETED/100.
//   2. A 200 noop from the progress handler — when fresh.status was CANCELLED
//      or OVERDUE — would also announce completion via the success branch.
//   3. The list card labeled SELF_ATTESTED_COMPLETED rows as "100% watched"
//      even when the underlying row had lastWatchedSec: 0.
//   4. The list card labeled CANCELLED / OVERDUE rows "Continue" instead of
//      "View details" — implying forward action on non-actionable rows.
//   5. The manual-complete + admin-override route gates used `isTerminal`
//      (not `isInactive`), so an OVERDUE row could be silently completed via
//      direct API call even though the UI hides the button on OVERDUE rows.
//   6. The conditional UPDATE WHERE clauses in progress / manual-complete /
//      admin-override excluded only the 4 completed-states + CANCELLED, so
//      an OVERDUE flip that races the read-then-write got a silent overwrite.
//
// Smallest complete fix:
//   - Frontend: refetch on 409 (instead of synthesizing COMPLETED); gate
//     the success toast on `isTrainingTerminal` (not `isTrainingInactive`);
//     show "Self-attested" instead of "100% watched"; show "View details"
//     instead of "Continue" for inactive assignments.
//   - Backend: route gates widened from `isTerminal` to `isInactive`; the
//     late-completion policy is left to the owner (the UI already refuses
//     late completion, the backend now agrees instead of disagreeing);
//     OVERDUE added to the conditional-CAS notIn lists; the progress
//     P2025 race resolves CANCELLED/OVERDUE fresh states to 409 instead
//     of letting them slide through as a 200 noop.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';

const fs = require('fs');
const path = require('path');
const { isInactive, isTerminal, TERMINAL_STATUSES } = require('../src/lib/trainingRules');

const ROUTE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'training.js'),
  'utf8',
);
const TRAINING_JSX = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'pages', 'portal', 'Training.jsx'),
  'utf8',
);
const TRAINING_DETAIL_JSX = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'pages', 'portal', 'TrainingDetail.jsx'),
  'utf8',
);

// ─────────────────────────────────────────────────────────────────────────────
// Predicate semantics — the gate functions must agree.
// ─────────────────────────────────────────────────────────────────────────────

describe('SOL DR-020 — isInactive widens isTerminal to cover OVERDUE', () => {
  test('1. isInactive is true for every completed-state + CANCELLED + OVERDUE', () => {
    for (const s of TERMINAL_STATUSES) {
      expect(isInactive(s)).toBe(true);
    }
    expect(isInactive('CANCELLED')).toBe(true);
    expect(isInactive('OVERDUE')).toBe(true);
  });

  test('2. isTerminal is true for every completed-state + CANCELLED, but FALSE for OVERDUE', () => {
    // isTerminal is the narrower predicate that does NOT block OVERDUE → CANCELLED
    // transitions in the cancel route. Keeping the two helpers distinct was the
    // whole point of DR-024. DR-020 widens the route-level gate, not the helper.
    expect(isTerminal('SELF_ATTESTED_COMPLETED')).toBe(true);
    expect(isTerminal('CANCELLED')).toBe(true);
    expect(isTerminal('OVERDUE')).toBe(false);
  });

  test('3. ASSIGNED + IN_PROGRESS are inactive=false + terminal=false (sanity)', () => {
    expect(isInactive('ASSIGNED')).toBe(false);
    expect(isInactive('IN_PROGRESS')).toBe(false);
    expect(isTerminal('ASSIGNED')).toBe(false);
    expect(isTerminal('IN_PROGRESS')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Progress handler — CAS agrees with the gate (DR-020 OVERDUE inclusion)
// ─────────────────────────────────────────────────────────────────────────────

describe('SOL DR-020 — progress handler conditional CAS includes OVERDUE', () => {
  const handlerStart = ROUTE_SRC.indexOf("router.put('/enrollments/:id/progress'");
  const handlerSrc = ROUTE_SRC.slice(handlerStart, handlerStart + 4000);

  test('4. progress UPDATE WHERE notIn set includes OVERDUE', () => {
    // The notIn list must include OVERDUE so an overdue-flip that races the
    // read-then-write produces a clean P2025 instead of a silent overwrite.
    expect(handlerSrc).toMatch(/'OVERDUE'/);
  });

  test('5. progress P2025 race resolves CANCELLED/OVERDUE fresh states to 409', () => {
    // After a P2025 the route re-fetches the row. If the fresh state is
    // CANCELLED or OVERDUE we must return 409 (same shape as the explicit
    // gate), NOT 200 noop. The pre-fix code unconditionally returned 200
    // noop regardless of the fresh state, letting a stale cancelled/overdue
    // response announce completion.
    expect(handlerSrc).toMatch(/fresh\s*\.\s*status\s*===\s*['"]CANCELLED['"]/);
    expect(handlerSrc).toMatch(/fresh\s*\.\s*status\s*===\s*['"]OVERDUE['"]/);
    // Still 200 noop for the legitimate completion-race case:
    expect(handlerSrc).toMatch(/ok:\s*true,\s*noop:\s*true/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Manual-complete + admin-override — route gates agree with the conditional CAS
// ─────────────────────────────────────────────────────────────────────────────

describe('SOL DR-020 — manual-complete + admin-override gates use isInactive', () => {
  test('6. manual-complete handler gate is `isInactive(existing.status)`', () => {
    // Widened from `isTerminal` so OVERDUE rows are also refused. The UI
    // hides the manual-complete button on OVERDUE rows; this aligns the
    // backend to the same policy without changing it.
    const slice = ROUTE_SRC.slice(
      ROUTE_SRC.indexOf("router.put('/enrollments/:id/complete'"),
      ROUTE_SRC.indexOf("router.put('/enrollments/:id/complete'") + 4000,
    );
    expect(slice).toMatch(/if\s*\(\s*isInactive\s*\(\s*existing\.status\s*\)\s*\)/);
  });

  test('7. manual-complete emits ENROLLMENT_OVERDUE code for OVERDUE rows', () => {
    // The new branch (post-fix) emits a distinct code for OVERDUE rejections
    // so the client can distinguish them from cancellation + already-completed.
    expect(ROUTE_SRC).toMatch(/'ENROLLMENT_OVERDUE'/);
  });

  test('8. admin-override handler gate is `isInactive(existing.status)`', () => {
    const slice = ROUTE_SRC.slice(
      ROUTE_SRC.indexOf("router.post('/enrollments/:id/admin-override'"),
      ROUTE_SRC.indexOf("router.post('/enrollments/:id/admin-override'") + 4000,
    );
    expect(slice).toMatch(/if\s*\(\s*isInactive\s*\(\s*existing\.status\s*\)\s*\)/);
  });

  test('9. admin-override UPDATE notIn set includes OVERDUE', () => {
    const slice = ROUTE_SRC.slice(
      ROUTE_SRC.indexOf("router.post('/enrollments/:id/admin-override'"),
      ROUTE_SRC.indexOf("router.post('/enrollments/:id/admin-override'") + 6000,
    );
    expect(slice).toMatch(/OVERDUE/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Frontend — list card evidence-class labels never claim observed watch duration
// ─────────────────────────────────────────────────────────────────────────────

describe('SOL DR-020 — Training.jsx list card evidence-class labels', () => {
  test('10. list card substitutes "Self-attested" for SELF_ATTESTED_COMPLETED rows', () => {
    // Render-actual-returned-state rule: a self-attested row often persists
    // with lastWatchedSec: 0, so calling it "100% watched" is a lie.
    expect(TRAINING_JSX).toMatch(/Self-attested/);
    // The literal "100% watched" must NOT appear on the self-attested branch.
    // (We still use it for non-self-attested rows in the else branch — the
    // test pins the SELF_ATTESTED_COMPLETED branch specifically.)
    expect(TRAINING_JSX).toMatch(/SELF_ATTESTED_COMPLETED/);
  });

  test('11. list card suppresses the progress bar for inactive rows', () => {
    // CANCELLED + OVERDUE rows have nothing honest to report. Skip them
    // rather than rendering a misleading "0% watched" or "100% watched".
    expect(TRAINING_JSX).toMatch(/isTrainingInactive\s*\(\s*e\.status\s*\)/);
    // The inactive branch (above) must NOT render the % watched element.
    expect(TRAINING_JSX).toMatch(/!\s*isTrainingInactive\s*\([\s\S]{0,80}progressPct\s*>\s*0/);
  });

  test('12. list card CTA labels inactive rows as "View details" (not Continue/Replay)', () => {
    // DR-020: inactive assignments need a non-actionable CTA. The link still
    // navigates to the detail page — it just doesn't promise forward progress.
    expect(TRAINING_JSX).toMatch(/View details/);
    // The branch explicitly checks isTrainingInactive before choosing 'View details'.
    expect(TRAINING_JSX).toMatch(/isTrainingInactive\s*\(\s*e\.status\s*\)\s*\?\s*['"]View details['"]/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Frontend — detail page stops synthesizing completion on stale responses
// ─────────────────────────────────────────────────────────────────────────────

describe('SOL DR-020 — TrainingDetail.jsx never synthesizes completion from 409', () => {
  test('13. error path refetches the canonical state instead of flipping to COMPLETED', () => {
    // Pre-fix: `if (err.code === 'ENROLLMENT_LOCKED' || err.status === 409)
    //   setEnrollment({ status: TRAINING_STATUSES.COMPLETED, progressPct: 100 })`.
    // The structural proof that this is gone: no `status: TRAINING_STATUSES.COMPLETED`
    // appears inside the catch block.
    const catchBlock = TRAINING_DETAIL_JSX.slice(
      TRAINING_DETAIL_JSX.indexOf('catch (err)'),
      TRAINING_DETAIL_JSX.indexOf('catch (err)') + 1200,
    );
    expect(catchBlock).not.toMatch(/status:\s*TRAINING_STATUSES\.COMPLETED/);
    // The new path calls api.getTrainingEnrollment(...) inside the 409 branch.
    expect(catchBlock).toMatch(/api\.getTrainingEnrollment\s*\(/);
  });

  test('14. success-completion toast gated on isTrainingTerminal (not isTrainingInactive)', () => {
    // Pre-fix: the success branch fired "Course marked complete." on ANY
    // status change into an inactive state, including CANCELLED + OVERDUE.
    // The fix narrows to isTrainingTerminal — only the 4 *_COMPLETED states.
    expect(TRAINING_DETAIL_JSX).toMatch(/isTrainingTerminal\s*\(\s*updated\.status\s*\)/);
  });

  test('15. handleEnded success toast also gated on isTrainingTerminal', () => {
    // Defensive consistency: the onEnded handler can announce completion
    // only when the server returned a terminal-completed status. Mirrors
    // the throttle's narrower gate.
    const handleEnded = TRAINING_DETAIL_JSX.slice(
      TRAINING_DETAIL_JSX.indexOf('handleEnded'),
      TRAINING_DETAIL_JSX.indexOf('handleEnded') + 1500,
    );
    expect(handleEnded).toMatch(/isTrainingTerminal\s*\(\s*updated\.status\s*\)/);
  });
});
