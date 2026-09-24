// SOL DR-004 — overdue training promises a recovery action that does not
// exist. The learner was told an administrator can "reopen or reassign" an
// OVERDUE course, but the completion handler rejects OVERDUE, the
// admin-override handler rejects OVERDUE, and assigning the same
// course/employee pair hits the (courseId, employeeId) @@unique constraint
// and silently no-ops (P2002 skip). No reopen/extend writer exists.
//
// Acceptance criterion: every offered recovery action exists and can
// complete. If overdue is terminal, the UI explains the actual supported
// next step without promising reassignment as a reset.
//
// Smallest complete fix (this file pins it):
//   - Frontend: TrainingDetail.jsx OVERDUE branch stops promising
//     "reopen or reassign". It now says "Ask your administrator for a new
//     assignment" — the actual supported flow is admin-cancel-then-reassign
//     (P2002 doesn't fire once the prior row is CANCELLED, not OVERDUE).
//   - Backend: unchanged — the gates (isInactive in manual-complete +
//     admin-override, OVERDUE→CANCELLED-only canTransition rule, P2002
//     silent-skip on assign) are all correct. They just don't add the
//     reopen/extend writer the old UI was hinting at.
//
// This test pins the contract so a future copy change that re-introduces
// the false promise is caught, and so the backend invariants the UI now
// relies on (no reopen/extend writer exists) don't drift.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';

const fs = require('fs');
const path = require('path');
const { canTransition, isInactive } = require('../src/lib/trainingRules');

const ROUTE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'training.js'),
  'utf8',
);
const TRAINING_DETAIL_JSX = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'pages', 'portal', 'TrainingDetail.jsx'),
  'utf8',
);
const TRAINING_RULES_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'lib', 'trainingRules.js'),
  'utf8',
);

// ─────────────────────────────────────────────────────────────────────────────
// Frontend — OVERDUE branch copy must not promise a reset that does not exist
// ─────────────────────────────────────────────────────────────────────────────

describe('SOL DR-004 — TrainingDetail.jsx OVERDUE copy aligns with backend support', () => {
  // Pin the inactive branch so a future copy edit doesn't re-introduce the
  // false "reopen or reassign" promise. The structural location is the
  // `isCancelled || isOverdue ?` ternary (DR-024 marker).
  const inactiveBlock = TRAINING_DETAIL_JSX.slice(
    TRAINING_DETAIL_JSX.indexOf('isCancelled || isOverdue'),
    TRAINING_DETAIL_JSX.indexOf('isCancelled || isOverdue') + 800,
  );

  test('1. OVERDUE branch no longer says "reopen" (no reopen writer exists)', () => {
    expect(inactiveBlock).not.toMatch(/reopen/);
  });

  test('2. OVERDUE branch no longer says "reassign" (P2002 silent-skips on the same pair)', () => {
    // The pre-fix copy said "Contact your administrator to reopen or reassign."
    // Reassign without a prior cancel hits the (courseId, employeeId) @@unique
    // constraint and silently no-ops (see training.js assign handler), which
    // would have been a wasted admin action that left the OVERDUE row in place.
    expect(inactiveBlock).not.toMatch(/reassign/i);
  });

  test('3. OVERDUE branch directs the learner to the actually supported next step', () => {
    // The supported recovery flow is admin-cancel-then-reassign. From the
    // learner's seat the right instruction is "ask your administrator for a
    // new assignment" — the admin can cancel the OVERDUE row, then assign
    // a fresh one (P2002 no longer fires because the prior row is CANCELLED).
    expect(inactiveBlock).toMatch(/ask your administrator for a new assignment/i);
  });

  test('4. CANCELLED branch copy is left untouched (sanity)', () => {
    // DR-004 only edits the OVERDUE branch. Cancelled copy must stay verbatim
    // so a parallel class of false-promise doesn't get introduced there.
    expect(inactiveBlock).toMatch(/cancelled and cannot be completed/i);
    expect(inactiveBlock).toMatch(/Contact your administrator if you believe this is in error/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Backend — terminal-state guard has no reopen/extend transition
// ─────────────────────────────────────────────────────────────────────────────

describe('SOL DR-004 — trainingRules.js: OVERDUE only transitions to CANCELLED', () => {
  test('5. canTransition(OVERDUE, *) only allows CANCELLED (no reopen/extend writer)', () => {
    // The single supported OVERDUE→* transition is admin-cancel. No reopen,
    // no extend-due-date, no admin-override-completion. The pre-fix UI
    // promised reopen-or-reassign; the rule table never had it.
    expect(canTransition('OVERDUE', 'CANCELLED')).toBe(true);
    expect(canTransition('OVERDUE', 'ASSIGNED')).toBe(false);
    expect(canTransition('OVERDUE', 'IN_PROGRESS')).toBe(false);
    expect(canTransition('OVERDUE', 'SELF_ATTESTED_COMPLETED')).toBe(false);
    expect(canTransition('OVERDUE', 'PLAYER_OBSERVED_COMPLETED')).toBe(false);
    expect(canTransition('OVERDUE', 'PROVIDER_VERIFIED_COMPLETED')).toBe(false);
    expect(canTransition('OVERDUE', 'ADMIN_OVERRIDE_COMPLETED')).toBe(false);
  });

  test('6. trainingRules.js OVERDUE branch only returns true for CANCELLED', () => {
    // Structural pin: the OVERDUE arm of canTransition must not have grown
    // a new transition. (We strip comments so a future "TODO: reopen" note
    // doesn't false-positive.)
    const code = TRAINING_RULES_SRC
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    const overdueArm = code.slice(
      code.indexOf("if (fromStatus === 'OVERDUE')"),
      code.indexOf("if (fromStatus === 'OVERDUE')") + 400,
    );
    expect(overdueArm).toMatch(/return\s+toStatus\s*===\s*['"]CANCELLED['"]/);
    // No second return-true after the CANCELLED branch in the same arm.
    const trueReturns = overdueArm.match(/return\s+toStatus\s*===\s*['"][A-Z_]+['"]/g) || [];
    expect(trueReturns.length).toBe(1);
  });

  test('7. isInactive(OVERDUE) is true so the route-level gate blocks completion', () => {
    // The route gates in manual-complete + admin-override use isInactive,
    // not just isTerminal — so OVERDUE rows can't be silently completed
    // through direct API calls. Pinning the helper here so the UI copy
    // change isn't paired with a backend relaxation.
    expect(isInactive('OVERDUE')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Backend — the route gates the UI relies on
// ─────────────────────────────────────────────────────────────────────────────

describe('SOL DR-004 — manual-complete + admin-override reject OVERDUE rows', () => {
  test('8. manual-complete handler gate refuses OVERDUE via isInactive', () => {
    const slice = ROUTE_SRC.slice(
      ROUTE_SRC.indexOf("router.put('/enrollments/:id/complete'"),
      ROUTE_SRC.indexOf("router.put('/enrollments/:id/complete'") + 4000,
    );
    expect(slice).toMatch(/if\s*\(\s*isInactive\s*\(\s*existing\.status\s*\)\s*\)/);
    // And the OVERDUE-specific branch must exist with a distinct code so
    // the client can tell OVERDUE rejections apart from CANCELLED ones.
    expect(slice).toMatch(/'ENROLLMENT_OVERDUE'/);
  });

  test('9. admin-override handler gate refuses OVERDUE via isInactive', () => {
    const slice = ROUTE_SRC.slice(
      ROUTE_SRC.indexOf("router.post('/enrollments/:id/admin-override'"),
      ROUTE_SRC.indexOf("router.post('/enrollments/:id/admin-override'") + 4000,
    );
    expect(slice).toMatch(/if\s*\(\s*isInactive\s*\(\s*existing\.status\s*\)\s*\)/);
    expect(slice).toMatch(/'ENROLLMENT_OVERDUE'/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Backend — assign handler skips the same (courseId, employeeId) on P2002
// ─────────────────────────────────────────────────────────────────────────────

describe('SOL DR-004 — assign handler silently skips P2002 (no in-place reopen)', () => {
  test('10. assign handler catches P2002 and silently skips (does NOT reopen the OVERDUE row)', () => {
    // This is the structural reason "reassign" was a misleading promise:
    // if the admin re-assigns the same course to the same employee without
    // cancelling first, Prisma's @@unique([courseId, employeeId]) fires
    // P2002 and the handler reports the employee as `skipped`. The OVERDUE
    // row is left untouched. The supported flow requires cancel-first, then
    // re-assign (which now succeeds because the prior row is CANCELLED).
    const assignStart = ROUTE_SRC.indexOf("router.post('/enrollments'");
    expect(assignStart).toBeGreaterThan(-1);
    // The assign handler is long (validation + course fetch + per-employee
    // create loop + best-effort notifications), so use a generous slice.
    const slice = ROUTE_SRC.slice(assignStart, assignStart + 5000);
    expect(slice).toMatch(/err\.code\s*===\s*['"]P2002['"]/);
    // The skip branch must NOT do an UPDATE on the existing OVERDUE row —
    // it only appends to the skipped[] list and continues.
    expect(slice).toMatch(/skipped\.push\s*\(\s*employeeId\s*\)/);
    // No "reopen" / "reset" / "extend" writer exists in the assign slice.
    expect(slice).not.toMatch(/reopen/i);
    expect(slice).not.toMatch(/extend/i);
    expect(slice).not.toMatch(/reset/i);
  });

  test('11. there is no /enrollments/:id/reopen or /extend route', () => {
    // Defensive: a future "reopen-overdue" endpoint should land here as a
    // positive pin so the cheap-path UI fix isn't quietly undermined by a
    // half-built writer. Today there is none.
    expect(ROUTE_SRC).not.toMatch(/router\.(?:post|put|patch)\s*\(\s*['"]\/enrollments\/:id\/(?:reopen|extend)/);
  });
});
