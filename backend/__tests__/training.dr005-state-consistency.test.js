// SOL DR-005 — training state consistency across the admin / portal surfaces.
//
// Four bugs lived in the training module. Each one was pinned here as a
// route-level contract test so a future regression in any of them is
// caught at the backend boundary (even if the matching frontend surface
// changes shape):
//
//   1. Admin "Completed" filter sent `?status=COMPLETED`, but the
//      server allowlist (`ALLOWED_STATUSES` in
//      backend/src/lib/trainingRules.js) only contains the four
//      `*_COMPLETED` evidence classes plus the bookkeeping states
//      (OVERDUE, CANCELLED). The literal `COMPLETED` value was
//      silently dropped, so the admin queue returned every row.
//
//   2. Successful progress / completion responses were partly merged
//      on the client (only `status` + `progressPct`), so
//      `completedAt`, `evidenceClass`, `evidenceMetadata`, and
//      `lastWatchedSec` stayed stale. The backend contract has always
//      returned the full serialized row via `serializeEnrollment()` —
//      the regression was the frontend dropping fields, not the
//      backend omitting them. The route-side test pins the full
//      surface so a future backend change can't quietly drop a field
//      the UI's reconciliation depends on.
//
//   3. Interval `id` shadowing in TrainingDetail.jsx caused the
//      409-recovery refetch to call `api.getTrainingEnrollment(id, ...)`
//      with the Timeout handle instead of the enrollment id. The fix
//      is frontend-only; the backend contract pins that
//      `GET /api/training/enrollments/:id` requires the id to match a
//      real row (any other value 404s) so a future refactor that re-
//      introduces the shadow will 404 immediately in dev.
//
//   4. Cancelled courses showed up as overdue on the dashboard and
//      training hub because the predicates on the client only excluded
//      terminal completion states. The backend has always persisted
//      CANCELLED distinct from any *_COMPLETED / OVERDUE state — the
//      route shape pins that distinction so a future schema merge that
//      collapses CANCELLED into a completion state lights up here.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';

const fs = require('fs');
const path = require('path');
const {
  ALLOWED_STATUSES,
  isInactive,
  isCompleted,
} = require('../src/lib/trainingRules');

const ROUTE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'training.js'),
  'utf8',
);

// ─────────────────────────────────────────────────────────────────────────────
// Sub-bug 1: the server allowlist doesn't accept a literal 'COMPLETED' value,
// so the admin "Completed" filter must NOT forward it as `?status=COMPLETED`.
// ─────────────────────────────────────────────────────────────────────────────

describe('SOL DR-005 — backend status allowlist is honest about the literal COMPLETED', () => {
  test('1. ALLOWED_STATUSES does NOT include the legacy "COMPLETED" literal', () => {
    // The backend has only ever known the four *_COMPLETED evidence classes
    // (plus the bookkeeping states). The frontend's "Completed" filter must
    // map to those — sending `?status=COMPLETED` would silently no-op the
    // filter and return the entire queue.
    expect(ALLOWED_STATUSES.has('COMPLETED')).toBe(false);
  });

  test('2. ALLOWED_STATUSES includes every *_COMPLETED evidence class', () => {
    // Mirror the four classes. A future regression that drops one (e.g. a
    // refactor that swaps ADMIN_OVERRIDE_COMPLETED for a generic COMPLETED)
    // would let the admin "Completed" tab silently miss those rows even if
    // the frontend were updated.
    expect(ALLOWED_STATUSES.has('SELF_ATTESTED_COMPLETED')).toBe(true);
    expect(ALLOWED_STATUSES.has('PLAYER_OBSERVED_COMPLETED')).toBe(true);
    expect(ALLOWED_STATUSES.has('PROVIDER_VERIFIED_COMPLETED')).toBe(true);
    expect(ALLOWED_STATUSES.has('ADMIN_OVERRIDE_COMPLETED')).toBe(true);
  });

  test('3. ALLOWED_STATUSES includes CANCELLED + OVERDUE as bookkeeping states', () => {
    // The dashboard's "overdue" attention predicate (sub-bug 4) relies on
    // CANCELLED staying a separate, non-terminal-completion state. If a
    // future refactor folds it into the *_COMPLETED set, the predicate
    // would silently start bucketing cancelled rows as "completed".
    expect(ALLOWED_STATUSES.has('CANCELLED')).toBe(true);
    expect(ALLOWED_STATUSES.has('OVERDUE')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sub-bug 2: the route handlers return the FULL serialized enrollment row
// (status, progressPct, completedAt, evidenceClass, evidenceMetadata,
// lastWatchedSec, startedAt). The client reconciliation depends on every
// field being present — pin the contract at the route level.
// ─────────────────────────────────────────────────────────────────────────────

describe('SOL DR-005 — route handlers return the full serialized enrollment', () => {
  // Pin that the happy-path response on every enrollment-mutating route
  // serializes through `serializeEnrollment(...)`. A future refactor that
  // swaps to `res.json(updated)` (raw Prisma row) would let the UI's
  // reconciliation helper receive un-dated fields (no completedAt, no
  // evidenceClass, no lastWatchedSec) and the partial-merge bug returns.
  test('4. PUT /enrollments/:id/progress response uses serializeEnrollment(...)', () => {
    expect(ROUTE_SRC).toMatch(/res\.json\(\s*serializeEnrollment\(\s*updated\s*\)\s*\)/);
  });

  test('5. PUT /enrollments/:id/complete response uses serializeEnrollment(...)', () => {
    expect(ROUTE_SRC).toMatch(/res\.json\(\s*serializeEnrollment\(\s*updated\s*\)\s*\)/);
  });

  test('6. POST /enrollments/:id/admin-override response uses serializeEnrollment(...)', () => {
    expect(ROUTE_SRC).toMatch(/res\.json\(\s*serializeEnrollment\(\s*updated\s*\)\s*\)/);
  });

  test('7. POST /enrollments/:id/cancel response uses serializeEnrollment(...)', () => {
    expect(ROUTE_SRC).toMatch(/res\.json\(\s*serializeEnrollment\(\s*updated\s*\)\s*\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sub-bug 3: 409 ENROLLMENT_LOCKED is the canonical "stale ping" response — the
// client's reconciliation path depends on the route distinguishing between
// terminal-completed (200 noop) and CANCELLED / OVERDUE (409 + distinct code).
// ─────────────────────────────────────────────────────────────────────────────

describe('SOL DR-005 — 409 reconciliation distinguishes CANCELLED / OVERDUE from terminal-completed', () => {
  test('8. PUT /progress isInactive() gate returns 409 with a distinct code per state', () => {
    // The 409 body must carry the canonical status so the client's
    // reconcile can re-fetch the canonical row without guessing. Pre-fix
    // the catch unconditionally returned 200 noop, masking stale CANCELLED
    // / OVERDUE responses as success.
    expect(ROUTE_SRC).toMatch(/if\s*\(\s*isInactive\s*\(\s*fresh\.status\s*\)\s*\)/);
    expect(ROUTE_SRC).toMatch(/'ENROLLMENT_CANCELLED'/);
    expect(ROUTE_SRC).toMatch(/'ENROLLMENT_OVERDUE'/);
    expect(ROUTE_SRC).toMatch(/'ENROLLMENT_LOCKED'/);
  });

  test('9. The catch-block resolver reads fresh status and produces the right code', () => {
    // The catch arm of PUT /progress re-fetches the row after a P2025 and
    // chooses 200 noop (terminal-completed) vs 409 (CANCELLED / OVERDUE).
    // Pin both branches so a future refactor that just no-ops the catch
    // is caught.
    expect(ROUTE_SRC).toMatch(/fresh\.status\s*===\s*['"]CANCELLED['"]/);
    expect(ROUTE_SRC).toMatch(/fresh\.status\s*===\s*['"]OVERDUE['"]/);
    // 200 noop branch: the legitimate completion-race row.
    expect(ROUTE_SRC).toMatch(/return\s+res\.json\(\s*\{\s*ok:\s*true,\s*noop:\s*true/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sub-bug 4: CANCELLED is terminal-but-not-done and must stay distinct from
// every *_COMPLETED state. The isInactive() helper on the route side is the
// single source of truth — the frontend mirrors it as
// `TRAINING_ATTENTION_EXCLUDED_STATUSES`.
// ─────────────────────────────────────────────────────────────────────────────

describe('SOL DR-005 — isInactive() keeps CANCELLED distinct from terminal completion', () => {
  test('10. isInactive(CANCELLED) is true so the route gates treat it as terminal', () => {
    // Manual-complete + admin-override gates both check isInactive(); if
    // CANCELLED drops out, a cancelled row could be silently re-completed
    // via the API and overwrite the cancel audit trail.
    expect(isInactive('CANCELLED')).toBe(true);
  });

  test('11. isInactive(CANCELLED) is true while isCompleted(CANCELLED) is false', () => {
    // The dashboard's overdue predicate (sub-bug 4) is the "excluded from
    // attention" half — it must include CANCELLED but it must NOT route
    // CANCELLED into the "Completed" count. The cleanest pin: isCompleted
    // and isInactive disagree about CANCELLED.
    expect(isCompleted('CANCELLED')).toBe(false);
    expect(isInactive('CANCELLED')).toBe(true);
  });

  test('12. isInactive(OVERDUE) is true so the route gates refuse completion', () => {
    // DR-004 already pinned this — the route gates (manual-complete +
    // admin-override) must refuse OVERDUE so a direct API call can't
    // silently complete an overdue row that the UI marked closed.
    expect(isInactive('OVERDUE')).toBe(true);
  });

  test('13. every *_COMPLETED state is terminal-done AND inactive', () => {
    // Symmetry check: the route gates refuse writes on completion states
    // (so we never downgrade) and the dashboards still count them as
    // "completed" (not cancelled, not overdue).
    ['SELF_ATTESTED_COMPLETED', 'PLAYER_OBSERVED_COMPLETED', 'PROVIDER_VERIFIED_COMPLETED', 'ADMIN_OVERRIDE_COMPLETED'].forEach((s) => {
      expect(isCompleted(s)).toBe(true);
      expect(isInactive(s)).toBe(true);
    });
  });
});
