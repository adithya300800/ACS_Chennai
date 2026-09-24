// DR-005 — admin "Completed" filter sent `?status=COMPLETED`, but the
// backend's ALLOWED_STATUSES allowlist only contains the four
// `*_COMPLETED` evidence classes plus the bookkeeping states. The
// legacy `COMPLETED` literal was silently dropped, so the server
// returned the entire queue under the "Completed" tab.
//
// The minimal fix routes COMPLETED + OVERDUE through client-side
// filtering — `fetchEnrollments` no longer forwards a status param for
// either filter, and `visibleEnrollments` narrows to the canonical
// terminal list (COMPLETED) or the shared overdue predicate (OVERDUE).
//
// This file pins three behaviours:
//   1. The admin source no longer sends `?status=COMPLETED` for the
//      Completed tab (the wire-shape regression test).
//   2. The visibleEnrollments memo narrows to the canonical terminal
//      list — every *_COMPLETED evidence class + legacy COMPLETED.
//   3. The rendered DOM only lists terminal rows under the Completed
//      tab (no Mark-complete button, no ASSIGNED / IN_PROGRESS row).

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { isTrainingTerminal, TRAINING_TERMINAL_STATUSES } from '../lib/constants.js';

const tdPath = resolvePath(__dirname, '../pages/admin/TrainingDashboard.jsx');
const tdSource = readFileSync(tdPath, 'utf8');

// Mirror of the production visibleEnrollments memo — pre-fix this was
// only narrowing for OVERDUE, so COMPLETED silently returned every row.
function narrowEnrollments(enrollments, filter) {
  if (filter === 'OVERDUE') return enrollments.filter((e) => e.__isOverdue);
  if (filter === 'COMPLETED') return enrollments.filter((e) => isTrainingTerminal(e.status));
  return enrollments;
}

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
    useBusinessDateKey: () => '2026-09-24',
  };
});

jest.mock('../lib/api.js', () => ({
  api: {
    getTrainingCourses: jest.fn(),
    getAllTrainingEnrollments: jest.fn(),
    markTrainingComplete: jest.fn(),
  },
}));

const { api } = require('../lib/api.js');

const renderDashboard = async () => {
  const { default: TrainingDashboard } = require('../pages/admin/TrainingDashboard.jsx');
  const utils = render(
    <MemoryRouter initialEntries={['/portal/admin/training']}>
      <TrainingDashboard />
    </MemoryRouter>
  );
  await waitFor(() => expect(api.getAllTrainingEnrollments).toHaveBeenCalled());
  return utils;
};

beforeEach(() => {
  api.getTrainingCourses.mockResolvedValue({ courses: [] });
  api.getAllTrainingEnrollments.mockResolvedValue({ enrollments: [] });
  api.markTrainingComplete.mockResolvedValue({});
});

// ────────────────────────────────────────────────────────────────────────────
// Source-text pins — catch the wire-shape regression directly.
// ────────────────────────────────────────────────────────────────────────────

describe('DR-005 — TrainingDashboard admin "Completed" filter wire shape', () => {
  test('1. fetchEnrollments no longer forwards ?status=COMPLETED for the Completed tab', () => {
    // The gate inside fetchEnrollments must explicitly exclude 'COMPLETED'.
    // Pre-fix the gate allowed everything except 'ALL' and 'OVERDUE', so
    // 'COMPLETED' was forwarded straight to a backend that silently
    // ignored it.
    expect(tdSource).toMatch(/filter\s*!==\s*['"]ALL['"]\s*&&\s*filter\s*!==\s*['"]OVERDUE['"]\s*&&\s*filter\s*!==\s*['"]COMPLETED['"]/);
  });

  test('2. visibleEnrollments narrows COMPLETED through isTrainingTerminal()', () => {
    // The COMPLETED branch of visibleEnrollments must hit isTrainingTerminal
    // (the canonical completion list, NOT a literal 'COMPLETED' check).
    // This is what gives the tab every *_COMPLETED row + legacy
    // 'COMPLETED' rows together.
    expect(tdSource).toMatch(/filter\s*===\s*['"]COMPLETED['"]/);
    expect(tdSource).toMatch(/isTrainingTerminal\s*\(\s*e\.status\s*\)/);
  });

  test('3. The source no longer compares e.status to the literal string "COMPLETED"', () => {
    // Belt-and-suspenders: nothing in the file should be treating
    // e.status === 'COMPLETED' as the test for "is this row done?". The
    // canonical list lives in isTrainingTerminal(); a literal compare
    // would miss every evidence-class completion.
    expect(tdSource).not.toMatch(/e\.status\s*===\s*['"]COMPLETED['"]/);
    expect(tdSource).not.toMatch(/e\.status\s*!==\s*['"]COMPLETED['"]/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Behavioural mirror — narrows COMPLETED to the canonical terminal list.
// ────────────────────────────────────────────────────────────────────────────

describe('DR-005 — visibleEnrollments mirror narrows COMPLETED to every terminal evidence class', () => {
  test('4. COMPLETED filter returns legacy COMPLETED + the four evidence classes', () => {
    const enrollments = [
      { id: 'a', status: 'COMPLETED' },                      // legacy
      { id: 'b', status: 'SELF_ATTESTED_COMPLETED' },
      { id: 'c', status: 'PLAYER_OBSERVED_COMPLETED' },
      { id: 'd', status: 'PROVIDER_VERIFIED_COMPLETED' },
      { id: 'e', status: 'ADMIN_OVERRIDE_COMPLETED' },
      { id: 'f', status: 'ASSIGNED' },
      { id: 'g', status: 'IN_PROGRESS' },
      { id: 'h', status: 'CANCELLED' },
      { id: 'i', status: 'OVERDUE' },
    ];
    const narrowed = narrowEnrollments(enrollments, 'COMPLETED');
    expect(narrowed.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(narrowed.length).toBe(TRAINING_TERMINAL_STATUSES.length);
  });

  test('5. CANCELLED rows are NOT included in the COMPLETED tab', () => {
    // Pre-fix this happened because the filter never narrowed at all
    // (the server-side filter was a no-op). Now that we narrow
    // client-side, CANCELLED rows must stay out of the "Completed" tab.
    const enrollments = [{ id: 'x', status: 'CANCELLED' }];
    expect(narrowEnrollments(enrollments, 'COMPLETED')).toEqual([]);
  });

  test('6. OVERDUE rows are NOT included in the COMPLETED tab', () => {
    // A row the backend has flagged OVERDUE is still actionable; the
    // admin needs to see it under "Overdue", not under "Completed".
    const enrollments = [{ id: 'x', status: 'OVERDUE' }];
    expect(narrowEnrollments(enrollments, 'COMPLETED')).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Real-mount coverage — wire shape + DOM in lockstep.
// ────────────────────────────────────────────────────────────────────────────

describe('DR-005 — TrainingDashboard real-mount: Completed filter narrows correctly', () => {
  test('7. clicking the Completed tab does NOT send ?status=COMPLETED to the backend', async () => {
    api.getAllTrainingEnrollments.mockResolvedValue({ enrollments: [] });

    await renderDashboard();

    // Reset call history so we can observe only the tab-switch refetch.
    api.getAllTrainingEnrollments.mockClear();
    fireEvent.click(screen.getByRole('tab', { name: /Completed/ }));

    await waitFor(() => expect(api.getAllTrainingEnrollments).toHaveBeenCalled());
    // The first argument (params object) must NOT carry a status key.
    const [params] = api.getAllTrainingEnrollments.mock.calls[0];
    expect(params).toBeDefined();
    expect(params.status).toBeUndefined();
    expect(params).not.toHaveProperty('status');
  });

  test('8. the Completed tab renders ONLY terminal rows (no Mark-complete buttons)', async () => {
    // mockResolvedValue (not Once) so the tab-switch refetch also gets
    // the full queue — the dashboard's fetchEnrollments is recreated on
    // every filter change, and useEffect re-fires it. mockResolvedValueOnce
    // would be consumed by the mount fetch and the click refetch would
    // fall through to the empty default.
    api.getAllTrainingEnrollments.mockResolvedValue({
      enrollments: [
        { id: 'e-1', status: 'SELF_ATTESTED_COMPLETED', employee: { name: 'Alice' }, course: { title: 'Course A' } },
        { id: 'e-2', status: 'PLAYER_OBSERVED_COMPLETED', employee: { name: 'Bob' }, course: { title: 'Course B' } },
        { id: 'e-3', status: 'ASSIGNED', employee: { name: 'Carol' }, course: { title: 'Course C' } },
        { id: 'e-4', status: 'IN_PROGRESS', employee: { name: 'Dave' }, course: { title: 'Course D' } },
        { id: 'e-5', status: 'CANCELLED', employee: { name: 'Eve' }, course: { title: 'Course E' } },
      ],
    });

    await renderDashboard();
    fireEvent.click(screen.getByRole('tab', { name: /Completed/ }));

    // Only the terminal rows render under the Completed tab.
    await waitFor(() => {
      expect(screen.getByText(/Alice/)).toBeInTheDocument();
      expect(screen.getByText(/Bob/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Carol/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Dave/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Eve/)).not.toBeInTheDocument();

    // And no Mark-complete button — terminal rows aren't actionable.
    expect(screen.queryAllByRole('button', { name: /Mark .* complete/i })).toHaveLength(0);
  });
});
