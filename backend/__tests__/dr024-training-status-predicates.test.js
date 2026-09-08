// SOL DR-024 — separate completed / cancelled / overdue / actionable
// predicates so a "completed" row can never mask a CANCELLED or OVERDUE
// one in the UI, and so the backend progress handler refuses to silently
// no-op writes against CANCELLED / OVERDUE rows.
//
// Audit findings pinned here:
//   1. External launch + manual completion persisted SELF_ATTESTED_COMPLETED
//      with lastWatchedSec: 0 but the UI rendered "100% watched".
//   2. A CANCELLED enrollment still offered the embedded-player "Continue".
//   3. PUT /api/training/enrollments/:id/progress returned 200 noop for
//      OVERDUE/CANCELLED writes — let the throttle loop and the embedded
//      player's onEnded handler keep firing on rows that should not accept
//      progress at all.
//   4. The embedded player's ended handler could announce completion even
//      when the row was already CANCELLED or OVERDUE.
//
// This file follows the SOL DR-014 pattern in dr014-training-cancel-complete.test.js:
// pure-helper assertions + route-source structure assertions. We do NOT
// spin up a mock Prisma here — the previous test file proves that pattern
// is sufficient to catch a regression of these four guards.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';

const fs = require('fs');
const path = require('path');
const {
  isCompleted,
  isTerminal,
  isInactive,
  TERMINAL_STATUSES,
} = require('../src/lib/trainingRules');

const ROUTE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'training.js'),
  'utf8',
);

// ─────────────────────────────────────────────────────────────────────────────
// Predicate semantics
// ─────────────────────────────────────────────────────────────────────────────

describe('SOL DR-024 — isInactive helper (broader than isTerminal)', () => {
  test('A1. isInactive is true for every *_COMPLETED evidence class', () => {
    for (const s of TERMINAL_STATUSES) {
      expect(isInactive(s)).toBe(true);
    }
  });

  test('A2. isInactive is true for CANCELLED (the failure-2 case)', () => {
    // Pre-fix, the progress handler checked `isCompleted || status === CANCELLED`
    // and returned 200 noop for it — letting the embedded player's onEnded
    // handler announce completion on a CANCELLED row.
    expect(isCompleted('CANCELLED')).toBe(false);
    expect(isTerminal('CANCELLED')).toBe(true);
    expect(isInactive('CANCELLED')).toBe(true);
  });

  test('A3. isInactive is true for OVERDUE (the failure-3 case)', () => {
    // The overdue scheduler writes OVERDUE; the progress handler must
    // refuse subsequent writes — pre-fix, a 200 noop left the throttle
    // loop spinning forever on an OVERDUE row.
    expect(isCompleted('OVERDUE')).toBe(false);
    expect(isTerminal('OVERDUE')).toBe(false); // narrower helper
    expect(isInactive('OVERDUE')).toBe(true);
  });

  test('A4. isInactive is false for the actionable states (ASSIGNED, IN_PROGRESS)', () => {
    expect(isInactive('ASSIGNED')).toBe(false);
    expect(isInactive('IN_PROGRESS')).toBe(false);
  });

  test('A5. isInactive is false for unknown / nullish input', () => {
    expect(isInactive('COMPLETED')).toBe(false); // legacy enum value
    expect(isInactive(null)).toBe(false);
    expect(isInactive(undefined)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Progress handler — refuses writes against CANCELLED / OVERDUE / completed
// ─────────────────────────────────────────────────────────────────────────────

describe('SOL DR-024 — progress handler returns 409 for inactive rows', () => {
  // The handler is at PUT /api/training/enrollments/:id/progress. Find its
  // source slice once and assert against it.
  const handlerStart = ROUTE_SRC.indexOf("router.put('/enrollments/:id/progress'");
  const handlerSrc = ROUTE_SRC.slice(handlerStart, handlerStart + 4000);

  test('B1. progress handler imports isInactive from trainingRules', () => {
    const code = ROUTE_SRC
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    expect(code).toMatch(/isInactive\s*[,}]/);
  });

  test('B2. progress handler guards existing.status with isInactive', () => {
    expect(handlerSrc).toMatch(/if\s*\(\s*isInactive\s*\(\s*existing\.status\s*\)\s*\)/);
  });

  test('B3. progress handler returns 409 with ENROLLMENT_CANCELLED for CANCELLED rows', () => {
    // The new branch must include ENROLLMENT_CANCELLED as a response code
    // so clients can distinguish a cancelled-row rejection from the
    // already-completed case.
    expect(handlerSrc).toMatch(/ENROLLMENT_CANCELLED/);
  });

  test('B4. progress handler returns 409 with ENROLLMENT_OVERDUE for OVERDUE rows', () => {
    expect(handlerSrc).toMatch(/ENROLLMENT_OVERDUE/);
  });

  test('B5. progress handler no longer returns the old 200 noop for inactive rows', () => {
    // The pre-fix code was `if (isCompleted(...) || === 'CANCELLED' || === 'OVERDUE') { res.json({ ok: true, noop: true, ... }) }`.
    // After the fix, the gate is `isInactive(...)` and the response is 409.
    // Assert the literal `noop: true` shape is gone from the handler.
    expect(handlerSrc).not.toMatch(/noop:\s*true/);
    // And the 409 status code is present.
    expect(handlerSrc).toMatch(/res\.status\(409\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mirrors the frontend expectation — the frontend `TRAINING_INACTIVE_STATUSES`
// constant must include CANCELLED + OVERDUE alongside the existing 5 terminal
// states. Pinned here because both halves drift without a regression test.
// ─────────────────────────────────────────────────────────────────────────────

describe('SOL DR-024 — frontend TRAINING_INACTIVE_STATUSES mirrors backend', () => {
  const constantsSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'lib', 'constants.js'),
    'utf8',
  );

  test('C1. constants.js defines TRAINING_INACTIVE_STATUSES with CANCELLED + OVERDUE', () => {
    expect(constantsSrc).toMatch(/TRAINING_INACTIVE_STATUSES\s*=/);
    const block = constantsSrc.slice(
      constantsSrc.indexOf('TRAINING_INACTIVE_STATUSES'),
      constantsSrc.indexOf('TRAINING_INACTIVE_STATUSES') + 400,
    );
    expect(block).toMatch(/'CANCELLED'/);
    expect(block).toMatch(/'OVERDUE'/);
  });

  test('C2. constants.js exports an isTrainingInactive helper', () => {
    expect(constantsSrc).toMatch(/export const isTrainingInactive\s*=/);
  });
});
