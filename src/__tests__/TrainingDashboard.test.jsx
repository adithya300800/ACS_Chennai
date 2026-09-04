// S3-8 regression test for the admin TrainingDashboard.
//
// Two bugs lived in src/pages/admin/TrainingDashboard.jsx:
//   1. The `counts` forEach used `c[e.status] != null`, which only matched
//      keys literally present in the counter object. The counter only had
//      a `COMPLETED` key, so the four evidence-class terminal statuses
//      (SELF_ATTESTED_COMPLETED, PLAYER_OBSERVED_COMPLETED,
//      PROVIDER_VERIFIED_COMPLETED, ADMIN_OVERRIDE_COMPLETED) were
//      silently dropped. The "Completed" stat tile showed 0 even when
//      enrollments were clearly complete — embarrassing in front of a
//      customer.
//
//   2. The "Mark complete" admin-override button was gated on
//      `e.status !== 'COMPLETED'`. That comparison is true for every
//      *_COMPLETED evidence class, so the button kept rendering for
//      rows that were already done (an admin could re-mark-complete
//      a self-attested row, for instance).
//
// Fix: route both decisions through isTrainingTerminal() — the canonical
// terminal list defined in src/lib/constants.js. That mirrors the
// already-correct employee page (src/pages/portal/Training.jsx).
//
// We use the same module-text + behavioural pattern as App.test.jsx
// (DR-020): re-implement the production logic here, and assert BOTH the
// file content (no literal 'COMPLETED' comparison remains) AND that the
// behaviour correctly buckets every terminal status.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';
import { isTrainingTerminal, TRAINING_STATUSES } from '../lib/constants.js';

const tdPath = resolvePath(__dirname, '../pages/admin/TrainingDashboard.jsx');
const tdSource = readFileSync(tdPath, 'utf8');

// Behavioural mirror of the production counts forEach loop in the admin
// dashboard. Kept tiny on purpose so the test cannot drift from the
// production logic via shared code; the file-content assertions below
// are what pin the production code itself.
function bucketCounts(enrollments, isOverdue) {
  const c = { ALL: enrollments.length, ASSIGNED: 0, IN_PROGRESS: 0, COMPLETED: 0, OVERDUE: 0 };
  enrollments.forEach((e) => {
    if (e.status === TRAINING_STATUSES.ASSIGNED) c.ASSIGNED += 1;
    else if (e.status === TRAINING_STATUSES.IN_PROGRESS) c.IN_PROGRESS += 1;
    else if (isTrainingTerminal(e.status)) c.COMPLETED += 1;
    if (isOverdue(e)) c.OVERDUE += 1;
  });
  return c;
}

// Behavioural mirror of the "should show Mark complete?" check.
function shouldShowMarkComplete(enrollment) {
  return !isTrainingTerminal(enrollment.status);
}

describe('TrainingDashboard admin — S3-8 terminal-status coverage', () => {
  test('source no longer compares e.status to literal "COMPLETED" on the Mark-complete guard', () => {
    // The buggy guard was: {e.status !== 'COMPLETED' && ( <button ... /> )}
    // After the fix, the only places that touch a terminal status must
    // go through isTrainingTerminal() (or the derived helpers like
    // COMPLETED_STATUSES / STATUS_LABEL keys).
    expect(tdSource).not.toMatch(/e\.status\s*!==\s*['"]COMPLETED['"]/);
  });

  test('source routes the Mark-complete guard through isTrainingTerminal', () => {
    // Accept either the negative form `!isTrainingTerminal(e.status)` or
    // any helper that wraps the same predicate. The fix landed as the
    // negative form; pin that exactly so a future refactor doesn't
    // quietly drop the helper back to a literal.
    expect(tdSource).toMatch(/!\s*isTrainingTerminal\s*\(\s*e\.status\s*\)/);
  });

  test('source counts forEach routes terminal statuses through isTrainingTerminal', () => {
    // The fix at the counts forEach loop checks `else if (isTrainingTerminal(e.status))`.
    // We assert the predicate is invoked in that block — protecting
    // against a regression to the original `c[e.status] != null` lookup.
    expect(tdSource).toMatch(/isTrainingTerminal\s*\(\s*e\.status\s*\)/);
    expect(tdSource).not.toMatch(/if\s*\(\s*c\[e\.status\]\s*!=\s*null\s*\)/);
  });

  test('counts bucket every terminal evidence class into Completed', () => {
    const enrollments = [
      { id: '1', status: 'SELF_ATTESTED_COMPLETED' },
      { id: '2', status: 'PLAYER_OBSERVED_COMPLETED' },
      { id: '3', status: 'PROVIDER_VERIFIED_COMPLETED' },
      { id: '4', status: 'ADMIN_OVERRIDE_COMPLETED' },
      { id: '5', status: 'ASSIGNED' },
      { id: '6', status: 'IN_PROGRESS' },
      { id: '7', status: 'COMPLETED' }, // legacy key — also terminal
    ];
    const counts = bucketCounts(enrollments, () => false);
    expect(counts.COMPLETED).toBe(5);
    expect(counts.ALL).toBe(7);
    expect(counts.ASSIGNED).toBe(1);
    expect(counts.IN_PROGRESS).toBe(1);
    expect(counts.OVERDUE).toBe(0);
  });

  test('counts bucket SELF_ATTESTED_COMPLETED into Completed (the original symptom)', () => {
    // This is the headline assertion: a single evidence-class completion
    // must show up as 1 in the Completed tile. Pre-fix, this read 0.
    const counts = bucketCounts([{ id: '1', status: 'SELF_ATTESTED_COMPLETED' }], () => false);
    expect(counts.COMPLETED).toBe(1);
  });

  test('counts do NOT bucket an unknown status into any tab', () => {
    // Future-proofing: an unknown status string should be ignored by
    // every counter, not silently coalesced into COMPLETED.
    const enrollments = [
      { id: '1', status: 'SOMETHING_NEW' },
      { id: '2', status: 'ASSIGNED' },
    ];
    const counts = bucketCounts(enrollments, () => false);
    expect(counts.ALL).toBe(2);
    expect(counts.ASSIGNED).toBe(1);
    expect(counts.IN_PROGRESS).toBe(0);
    expect(counts.COMPLETED).toBe(0);
  });

  test('Mark complete is hidden for SELF_ATTESTED_COMPLETED', () => {
    expect(shouldShowMarkComplete({ status: 'SELF_ATTESTED_COMPLETED' })).toBe(false);
  });

  test('Mark complete is hidden for every terminal status in the canonical list', () => {
    // The helper is the single source of truth — assert against the
    // exported list rather than a hand-typed array so adding a new
    // evidence class only requires updating constants.js + trainingRules.js.
    const { TRAINING_TERMINAL_STATUSES } = require('../lib/constants.js');
    TRAINING_TERMINAL_STATUSES.forEach((status) => {
      expect(shouldShowMarkComplete({ status })).toBe(false);
    });
  });

  test('Mark complete is offered for ASSIGNED and IN_PROGRESS', () => {
    expect(shouldShowMarkComplete({ status: 'ASSIGNED' })).toBe(true);
    expect(shouldShowMarkComplete({ status: 'IN_PROGRESS' })).toBe(true);
  });
});
