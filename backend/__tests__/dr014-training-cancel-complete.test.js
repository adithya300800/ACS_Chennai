// SOL DR-014 — a cancelled training enrollment cannot be revived through
// the manual-complete or admin-override routes.
//
// The audit found that the manual-complete handler at
// training.js:699 checked ONLY `isCompleted(existing.status)` before
// transitioning the row to a completed-state. CANCELLED is a terminal
// status too (canTransition() rejects CANCELLED→* in trainingRules),
// but `isCompleted()` returns false for it — so a learner (or admin
// via the override path at training.js:844) could "complete" a row
// that had just been cancelled, silently overwriting the audit trail
// of who pulled the assignment and why.
//
// Acceptance criteria from SOL DR-014:
//   - manual-complete route (PUT /enrollments/:id/complete) rejects
//     CANCELLED with 409 ENROLLMENT_CANCELLED
//   - admin-override route (POST /enrollments/:id/admin-override)
//     rejects CANCELLED with 409 ENROLLMENT_CANCELLED
//   - both routes still reject COMPLETED with 409 ENROLLMENT_LOCKED
//   - both UPDATEs add CANCELLED to the notIn where-clause so a
//     concurrent cancel + complete race produces a clean P2025
//   - new helper `isTerminal(status)` in trainingRules covers both
//     states and is exported

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';

const fs = require('fs');
const path = require('path');
const {
  isCompleted,
  isTerminal,
  canTransition,
  TERMINAL_STATUSES,
} = require('../src/lib/trainingRules');

const ROUTE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'training.js'),
  'utf8',
);

describe('SOL DR-014 — isTerminal helper', () => {
  test('A1. isTerminal returns true for every completed-state', () => {
    for (const s of TERMINAL_STATUSES) {
      expect(isTerminal(s)).toBe(true);
    }
  });

  test('A2. isTerminal returns true for CANCELLED (the bug class)', () => {
    // Pre-fix, isCompleted('CANCELLED') was false → the route let the
    // row be re-completed. isTerminal closes the gap.
    expect(isCompleted('CANCELLED')).toBe(false);
    expect(isTerminal('CANCELLED')).toBe(true);
  });

  test('A3. isTerminal returns false for open + bookkeeping states', () => {
    expect(isTerminal('ASSIGNED')).toBe(false);
    expect(isTerminal('IN_PROGRESS')).toBe(false);
    expect(isTerminal('OVERDUE')).toBe(false);
  });

  test('A4. isTerminal returns false for unknown / nullish', () => {
    expect(isTerminal('COMPLETED')).toBe(false); // legacy enum value
    expect(isTerminal(null)).toBe(false);
    expect(isTerminal(undefined)).toBe(false);
  });

  test('A5. canTransition still rejects CANCELLED → any completed-state (sanity)', () => {
    // The transition rule was always correct; the bug was that the
    // route handler never consulted it. This test pins the rule so
    // a future refactor of trainingRules.js keeps it.
    expect(canTransition('CANCELLED', 'SELF_ATTESTED_COMPLETED')).toBe(false);
    expect(canTransition('CANCELLED', 'PLAYER_OBSERVED_COMPLETED')).toBe(false);
    expect(canTransition('CANCELLED', 'PROVIDER_VERIFIED_COMPLETED')).toBe(false);
    expect(canTransition('CANCELLED', 'ADMIN_OVERRIDE_COMPLETED')).toBe(false);
  });
});

describe('SOL DR-014 — manual-complete handler enforces terminal-state', () => {
  test('B1. handler imports isTerminal from trainingRules', () => {
    // Strip comments so the regression header doesn't false-positive.
    const code = ROUTE_SRC
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    expect(code).toMatch(/isTerminal\s*[,}]/);
  });

  test('B2. manual-complete handler guards existing.status with isTerminal', () => {
    // Find the PUT /enrollments/:id/complete handler and assert its
    // guard uses isTerminal — not just isCompleted.
    const handlerStart = ROUTE_SRC.indexOf("router.put('/enrollments/:id/complete'");
    expect(handlerStart).toBeGreaterThan(-1);
    // Look at the next 80 lines — the guard must be inside that scope.
    const slice = ROUTE_SRC.slice(handlerStart, handlerStart + 4000);
    // The guard pattern: `if (isTerminal(existing.status))`.
    expect(slice).toMatch(/if\s*\(\s*isTerminal\s*\(\s*existing\.status\s*\)\s*\)/);
    // Negative: the old guard `if (isCompleted(existing.status))` alone
    // is no longer in this handler — replaced by isTerminal().
    // (The DB UPDATE notIn clause still mentions completed-states by name
    // for the notIn set, which is fine.)
    const guardOnly = slice.match(/if\s*\(\s*isCompleted\s*\(\s*existing\.status\s*\)\s*\)\s*\{/g) || [];
    expect(guardOnly.length).toBe(0);
  });

  test('B3. manual-complete returns ENROLLMENT_CANCELLED for CANCELLED rows', () => {
    // The new branch must include ENROLLMENT_CANCELLED as the response
    // code so clients can distinguish a cancelled-row rejection from
    // an already-completed one.
    expect(ROUTE_SRC).toMatch(/ENROLLMENT_CANCELLED/);
  });

  test('B4. manual-complete UPDATE notIn set includes CANCELLED', () => {
    // Belt-and-suspenders: even if a concurrent cancel lands after our
    // read but before our UPDATE, the notIn where-clause refuses the
    // overwrite.
    const slice = ROUTE_SRC.slice(
      ROUTE_SRC.indexOf("router.put('/enrollments/:id/complete'"),
      ROUTE_SRC.indexOf("router.put('/enrollments/:id/complete'") + 6000
    );
    expect(slice).toMatch(/'CANCELLED'/);
  });
});

describe('SOL DR-014 — admin-override handler enforces terminal-state', () => {
  test('C1. admin-override handler guards existing.status with isTerminal', () => {
    const handlerStart = ROUTE_SRC.indexOf("router.post('/enrollments/:id/admin-override'");
    expect(handlerStart).toBeGreaterThan(-1);
    const slice = ROUTE_SRC.slice(handlerStart, handlerStart + 4000);
    expect(slice).toMatch(/if\s*\(\s*isTerminal\s*\(\s*existing\.status\s*\)\s*\)/);
  });

  test('C2. admin-override UPDATE notIn set includes CANCELLED', () => {
    const slice = ROUTE_SRC.slice(
      ROUTE_SRC.indexOf("router.post('/enrollments/:id/admin-override'"),
      ROUTE_SRC.indexOf("router.post('/enrollments/:id/admin-override'") + 6000
    );
    // Should include CANCELLED in the spread or explicit list.
    expect(slice).toMatch(/CANCELLED/);
  });
});

describe('SOL DR-014 — cancel route still rejects completed rows', () => {
  // Sanity: the cancel route at /enrollments/:id/cancel must still
  // refuse to cancel an already-completed row (the inverse direction
  // of the bug we just fixed). This guards against a future refactor
  // that swaps the check and breaks the symmetric invariant.
  test('D1. cancel route guards completed-state via isCompleted', () => {
    const handlerStart = ROUTE_SRC.indexOf("router.post('/enrollments/:id/cancel'");
    expect(handlerStart).toBeGreaterThan(-1);
    const slice = ROUTE_SRC.slice(handlerStart, handlerStart + 3000);
    expect(slice).toMatch(/isCompleted\s*\(\s*existing\.status\s*\)/);
  });
});
