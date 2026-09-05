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

// ────────────────────────────────────────────────────────────────────────────
// DR-018d: real-mount regression coverage.
//
// The behavioural mirror tests above pin the count bucketing and the
// mark-complete guard. They are necessary but not sufficient: a future
// refactor could rename the helper, swap to a derived constant, or move
// the guard into a memoized child — and the mirror would still pass
// while the rendered DOM silently regressed.
//
// These tests mount the production TrainingDashboard component with the
// real provider tree (MemoryRouter + AuthContext + ToastContext) so a
// regression in the rendered output fails the suite. The headline
// assertions are the same as the mirror: every terminal status shows 1
// in "Completed" and never shows the "Mark complete" button.
// ────────────────────────────────────────────────────────────────────────────

import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Mock the contexts and hooks the component consumes. We mirror the
// pattern in InspectionSubmit.draft.test.jsx so the test stays focused on
// the dashboard's own logic, not on its dependencies.
jest.mock('../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({
    accessToken: 'test-token',
    user: { id: 'admin-1' },
    employee: { id: 'emp-admin', isAdmin: true },
  }),
}));

jest.mock('../contexts/ToastContext.jsx', () => ({
  useToast: () => ({ push: jest.fn(), dismiss: jest.fn() }),
}));

jest.mock('../hooks/useDocumentTitle.js', () => ({
  useDocumentTitle: jest.fn(),
}));

jest.mock('../lib/businessDate.js', () => {
  const actual = jest.requireActual('../lib/businessDate.js');
  return {
    ...actual,
    useBusinessDateKey: () => '2026-09-04',
  };
});

// The api surface TrainingDashboard reads on mount. Each test sets its
// own resolved value via mockResolvedValueOnce so the mount reflects the
// scenario under test.
jest.mock('../lib/api.js', () => ({
  api: {
    getTrainingCourses: jest.fn(),
    getAllTrainingEnrollments: jest.fn(),
    markTrainingComplete: jest.fn(),
  },
}));

const { api } = require('../lib/api.js');

const renderDashboard = async () => {
  // Lazy require so the api mocks above are installed before the
  // component's module-level side effects run.
  const { default: TrainingDashboard } = require('../pages/admin/TrainingDashboard.jsx');
  const utils = render(
    <MemoryRouter initialEntries={['/portal/admin/training']}>
      <TrainingDashboard />
    </MemoryRouter>
  );
  await waitFor(() =>
    expect(api.getAllTrainingEnrollments).toHaveBeenCalled()
  );
  return utils;
};

const sampleEnrollments = [
  { id: 'e-1', status: 'SELF_ATTESTED_COMPLETED', employee: { name: 'A' }, course: { title: 'X' } },
  { id: 'e-2', status: 'PLAYER_OBSERVED_COMPLETED', employee: { name: 'B' }, course: { title: 'X' } },
  { id: 'e-3', status: 'PROVIDER_VERIFIED_COMPLETED', employee: { name: 'C' }, course: { title: 'X' } },
  { id: 'e-4', status: 'ADMIN_OVERRIDE_COMPLETED', employee: { name: 'D' }, course: { title: 'X' } },
  { id: 'e-5', status: 'ASSIGNED', employee: { name: 'E' }, course: { title: 'X' } },
  { id: 'e-6', status: 'IN_PROGRESS', employee: { name: 'F' }, course: { title: 'X' } },
  { id: 'e-7', status: 'COMPLETED', employee: { name: 'G' }, course: { title: 'X' } }, // legacy
];

beforeEach(() => {
  api.getTrainingCourses.mockResolvedValue({ courses: [] });
  api.getAllTrainingEnrollments.mockResolvedValue({ enrollments: [] });
  api.markTrainingComplete.mockResolvedValue({});
});

describe('TrainingDashboard admin — DR-018d real-mount coverage', () => {
  test('Completed stat tile shows 1 for a single SELF_ATTESTED_COMPLETED enrollment (the audit\'s headline)', async () => {
    api.getAllTrainingEnrollments.mockResolvedValueOnce({
      enrollments: [{ id: 'only', status: 'SELF_ATTESTED_COMPLETED', employee: { name: 'Solo' }, course: { title: 'Course' } }],
    });

    await renderDashboard();

    // 'Completed' appears in three places: the stat tile label, the
    // filter tab, and the enrollment status pill. Pick the label-cell
    // (the one inside a `.training-stat`) so we always read the tile.
    const completedLabels = screen.getAllByText('Completed');
    const tileLabel = completedLabels.find((el) => el.classList.contains('training-stat-label'));
    expect(tileLabel).toBeDefined();
    const completedTile = tileLabel.closest('.training-stat');
    expect(completedTile).not.toBeNull();
    expect(completedTile.querySelector('.training-stat-num').textContent).toBe('1');
  });

  test('Completed stat tile counts every terminal status (mirror of behavioural test, on the real DOM)', async () => {
    api.getAllTrainingEnrollments.mockResolvedValueOnce({
      enrollments: sampleEnrollments,
    });

    await renderDashboard();

    const completedLabels = screen.getAllByText('Completed');
    const completedTile = completedLabels
      .find((el) => el.classList.contains('training-stat-label'))
      .closest('.training-stat');
    expect(completedTile.querySelector('.training-stat-num').textContent).toBe('5');

    const inProgressTile = screen.getByText('In progress').closest('.training-stat');
    expect(inProgressTile.querySelector('.training-stat-num').textContent).toBe('1');
  });

  test('Mark complete button is NOT rendered for any terminal-status enrollment', async () => {
    // Mirror how the real backend would honour the status filter: when
    // the component sends `params.status = 'COMPLETED'` the server
    // returns terminal rows (every evidence class is bucketed as
    // Completed). That's the contract the rendered output depends on.
    const isTerminal = (e) =>
      e.status === 'COMPLETED' ||
      e.status === 'SELF_ATTESTED_COMPLETED' ||
      e.status === 'PLAYER_OBSERVED_COMPLETED' ||
      e.status === 'PROVIDER_VERIFIED_COMPLETED' ||
      e.status === 'ADMIN_OVERRIDE_COMPLETED';
    api.getAllTrainingEnrollments.mockImplementation(async (params = {}) => {
      if (params && params.status === 'COMPLETED') {
        return { enrollments: sampleEnrollments.filter(isTerminal) };
      }
      return { enrollments: sampleEnrollments };
    });

    await renderDashboard();

    // Switch to the Completed filter. fireEvent wraps the click in
    // act() so the resulting re-render + useEffect refetch settles
    // before our assertions.
    fireEvent.click(screen.getByRole('tab', { name: /Completed/ }));

    // After the tab switch + refetch, no "Mark complete" button should
    // appear for any terminal row. We wait for the queue to repopulate
    // with terminal-only rows.
    await waitFor(() => {
      const buttons = screen.queryAllByRole('button', { name: /Mark .* complete/i });
      expect(buttons).toHaveLength(0);
    });
  });

  test('Mark complete button IS rendered for ASSIGNED enrollment rows (gate is open for non-terminal)', async () => {
    api.getAllTrainingEnrollments.mockResolvedValueOnce({
      enrollments: [
        { id: 'e-1', status: 'ASSIGNED', employee: { name: 'Alice' }, course: { title: 'X' } },
        { id: 'e-2', status: 'IN_PROGRESS', employee: { name: 'Bob' }, course: { title: 'X' } },
      ],
    });

    await renderDashboard();

    const aliceBtn = screen.getByRole('button', { name: /Mark Alice complete/i });
    const bobBtn = screen.getByRole('button', { name: /Mark Bob complete/i });
    expect(aliceBtn).toBeInTheDocument();
    expect(bobBtn).toBeInTheDocument();
  });
});
