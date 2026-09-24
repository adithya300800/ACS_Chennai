// DR-005 — employee dashboard "Training due" widget included cancelled
// courses with a past dueDate as overdue. The local `isOverdue` /
// `isDueSoon` predicates only excluded terminal completion states, so a
// CANCELLED row lit up the badge and counted toward the list.
//
// The minimal fix moves the predicates to a single shared helper in
// src/lib/constants.js (isOverdueEnrollment / isDueSoonEnrollment) so
// the dashboard, the training hub, and the admin queue can't drift.
//
// This file pins three behaviours:
//   1. Source-text: the dashboard no longer defines a local `isOverdue`
//      / `isDueSoon` (those would let a future refactor reintroduce the
//      bug). It imports the shared predicates instead.
//   2. Predicate behaviour: isOverdueEnrollment + isDueSoonEnrollment
//      both exclude CANCELLED + terminal completion, but INCLUDE
//      persisted OVERDUE.
//   3. Real-mount: a CANCELLED row never appears in the "Training due"
//      widget's overdue / due-soon lists, even when its dueDate is in
//      the past.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import {
  isOverdueEnrollment,
  isDueSoonEnrollment,
  isTrainingAttentionExcluded,
} from '../lib/constants.js';

const dashPath = resolvePath(__dirname, '../pages/portal/EmployeeDashboard.jsx');
const dashSrc = readFileSync(dashPath, 'utf8');

const TODAY = new Date('2026-09-24T12:00:00Z');
const YESTERDAY = '2026-09-23';
const TOMORROW = '2026-09-25';
const NEXT_WEEK = '2026-09-30';
const FAR_FUTURE = '2026-10-31';

// ────────────────────────────────────────────────────────────────────────────
// Source-text pins — guard against the local-predicate regression.
// ────────────────────────────────────────────────────────────────────────────

describe('DR-005 — EmployeeDashboard source contracts', () => {
  test('1. dashboard imports the shared isOverdueEnrollment / isDueSoonEnrollment helpers', () => {
    // A local `isOverdue` definition would let a future refactor quietly
    // drop the CANCELLED exclusion (the original bug). Pin that the
    // dashboard reads the shared predicate instead.
    expect(dashSrc).toMatch(/import\s*\{[^}]*isOverdueEnrollment[^}]*\}\s*from\s*['"]\.\.\/\.\.\/lib\/constants\.js['"]/);
    expect(dashSrc).toMatch(/import\s*\{[^}]*isDueSoonEnrollment[^}]*\}\s*from\s*['"]\.\.\/\.\.\/lib\/constants\.js['"]/);
  });

  test('2. dashboard no longer defines its own local isOverdue or isDueSoon', () => {
    // Pre-fix the dashboard had two `const isOverdue = (e) => ...` and
    // `const isDueSoon = (e) => ...` definitions. Pin that they're gone
    // so a future contributor can't reintroduce a per-page predicate.
    expect(dashSrc).not.toMatch(/^const\s+isOverdue\s*=/m);
    expect(dashSrc).not.toMatch(/^const\s+isDueSoon\s*=/m);
  });

  test('3. dashboard routes overdue / due-soon lists through the shared helpers', () => {
    // The dashboard's `overdueTraining` / `dueSoonTraining` derived
    // arrays must come from the shared helpers, not from a custom
    // predicate. Re-implement the same shape here so a future rename
    // stays pinned.
    //
    // Belt-and-suspenders: also pin the arrow-function wrap. The shared
    // `isDueSoonEnrollment(enrollment, optsOrNow, windowDays = 7)` takes
    // a 3rd positional arg, and Array.prototype.filter forwards
    // `(element, index, array)` to the callback — passing the source
    // array as `windowDays`. The arrow wrap keeps the predicate
    // single-arg and prevents a future refactor that drops the wrap
    // from re-introducing the "1 <= [array]" silent-zero bug.
    expect(dashSrc).toMatch(/training\.filter\(\s*\(e\)\s*=>\s*isOverdueEnrollment\(\s*e\s*\)\s*\)/);
    expect(dashSrc).toMatch(/training\.filter\(\s*\(e\)\s*=>\s*isDueSoonEnrollment\(\s*e\s*\)\s*\)/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Predicate behaviour — the shared helpers exclude CANCELLED but
// include persisted OVERDUE.
// ────────────────────────────────────────────────────────────────────────────

describe('DR-005 — shared training attention predicates', () => {
  test('4. isTrainingAttentionExcluded covers completion states + CANCELLED but NOT OVERDUE', () => {
    // A persisted OVERDUE row IS what the attention list surfaces — it
    // must not be in the exclusion set.
    expect(isTrainingAttentionExcluded('SELF_ATTESTED_COMPLETED')).toBe(true);
    expect(isTrainingAttentionExcluded('PLAYER_OBSERVED_COMPLETED')).toBe(true);
    expect(isTrainingAttentionExcluded('PROVIDER_VERIFIED_COMPLETED')).toBe(true);
    expect(isTrainingAttentionExcluded('ADMIN_OVERRIDE_COMPLETED')).toBe(true);
    expect(isTrainingAttentionExcluded('COMPLETED')).toBe(true); // legacy
    expect(isTrainingAttentionExcluded('CANCELLED')).toBe(true);
    // Persisted OVERDUE must NOT be excluded — the badge should light up.
    expect(isTrainingAttentionExcluded('OVERDUE')).toBe(false);
    // Actionable rows must NOT be excluded.
    expect(isTrainingAttentionExcluded('ASSIGNED')).toBe(false);
    expect(isTrainingAttentionExcluded('IN_PROGRESS')).toBe(false);
  });

  test('5. isOverdueEnrollment returns false for a CANCELLED row with a past dueDate', () => {
    // Headline assertion: a CANCELLED row with yesterday's dueDate must
    // NOT show up as overdue. Pre-fix the dashboard used a local
    // isOverdue that only filtered terminal completion states, so this
    // row lit up the badge.
    expect(isOverdueEnrollment({ status: 'CANCELLED', dueDate: YESTERDAY }, { now: TODAY })).toBe(false);
  });

  test('6. isOverdueEnrollment returns false for every terminal completion state', () => {
    const terminal = ['COMPLETED', 'SELF_ATTESTED_COMPLETED', 'PLAYER_OBSERVED_COMPLETED', 'PROVIDER_VERIFIED_COMPLETED', 'ADMIN_OVERRIDE_COMPLETED'];
    terminal.forEach((status) => {
      expect(isOverdueEnrollment({ status, dueDate: YESTERDAY }, { now: TODAY })).toBe(false);
    });
  });

  test('7. isOverdueEnrollment returns true for an ASSIGNED row with a past dueDate', () => {
    expect(isOverdueEnrollment({ status: 'ASSIGNED', dueDate: YESTERDAY }, { now: TODAY })).toBe(true);
  });

  test('8. isOverdueEnrollment returns true for a persisted OVERDUE row (actionable attention)', () => {
    // A row the backend has already flipped to OVERDUE is exactly what
    // the badge is meant to surface. The predicate must keep counting
    // it as overdue so the warning tile stays lit.
    expect(isOverdueEnrollment({ status: 'OVERDUE', dueDate: YESTERDAY }, { now: TODAY })).toBe(true);
  });

  test('9. isOverdueEnrollment returns false for a row without a dueDate', () => {
    // Edge: missing dueDate is the safe default — don't show overdue
    // when the backend simply hasn't recorded a deadline.
    expect(isOverdueEnrollment({ status: 'ASSIGNED', dueDate: null }, { now: TODAY })).toBe(false);
    expect(isOverdueEnrollment({ status: 'ASSIGNED' }, { now: TODAY })).toBe(false);
  });

  test('10. isDueSoonEnrollment excludes CANCELLED + overdue rows; includes 7-day window', () => {
    expect(isDueSoonEnrollment({ status: 'CANCELLED', dueDate: TOMORROW }, { now: TODAY })).toBe(false);
    expect(isDueSoonEnrollment({ status: 'ASSIGNED', dueDate: YESTERDAY }, { now: TODAY })).toBe(false); // already overdue
    expect(isDueSoonEnrollment({ status: 'ASSIGNED', dueDate: TOMORROW }, { now: TODAY })).toBe(true);
    expect(isDueSoonEnrollment({ status: 'ASSIGNED', dueDate: NEXT_WEEK }, { now: TODAY })).toBe(true);
    expect(isDueSoonEnrollment({ status: 'ASSIGNED', dueDate: FAR_FUTURE }, { now: TODAY })).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Real-mount coverage — the rendered DOM must not include CANCELLED rows
// in the "Training due" widget.
// ────────────────────────────────────────────────────────────────────────────

jest.mock('../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({
    accessToken: 'test-token',
    user: { id: 'emp-1' },
    employee: { id: 'emp-1', isAdmin: false, name: 'Test Employee' },
  }),
}));

jest.mock('../hooks/useDocumentTitle.js', () => ({
  useDocumentTitle: jest.fn(),
}));

jest.mock('../lib/api.js', () => ({
  api: {
    get: jest.fn(),
    getDprs: jest.fn(),
    getMyTraining: jest.fn(),
    getMyLeaves: jest.fn(),
    getNotifications: jest.fn(),
    post: jest.fn(),
  },
}));

const { api } = require('../lib/api.js');

const EMPTY_TODAY = { date: '2026-09-24', sessions: [] };
const EMPTY_DPRS = { dprs: [] };
const EMPTY_LEAVES = { requests: [] };
const EMPTY_NOTIFS = { notifications: [] };

beforeEach(() => {
  jest.clearAllMocks();
  api.get.mockResolvedValue(EMPTY_TODAY);
  api.getDprs.mockResolvedValue(EMPTY_DPRS);
  api.getMyLeaves.mockResolvedValue(EMPTY_LEAVES);
  api.getNotifications.mockResolvedValue(EMPTY_NOTIFS);
  api.post.mockResolvedValue({});
});

const renderDashboard = async (trainingEnrollments = []) => {
  api.getMyTraining.mockResolvedValue({ enrollments: trainingEnrollments });
  const { default: EmployeeDashboard } = require('../pages/portal/EmployeeDashboard.jsx');
  const utils = render(
    <MemoryRouter initialEntries={['/portal/dashboard']}>
      <EmployeeDashboard />
    </MemoryRouter>
  );
  await waitFor(() => expect(api.getMyTraining).toHaveBeenCalled());
  return utils;
};

describe('DR-005 — EmployeeDashboard "Training due" widget excludes CANCELLED rows', () => {
  test('11. CANCELLED row with past dueDate is NOT in the overdue list', async () => {
    await renderDashboard([
      { id: 'cancelled', status: 'CANCELLED', dueDate: '2026-09-20', course: { title: 'Cancelled Course' } },
      { id: 'overdue', status: 'ASSIGNED', dueDate: '2026-09-20', course: { title: 'Real Overdue' } },
    ]);

    // The genuine overdue row must be in the list.
    expect(await screen.findByText(/Real Overdue/)).toBeInTheDocument();
    // The cancelled row must NOT.
    expect(screen.queryByText(/Cancelled Course/)).not.toBeInTheDocument();
  });

  test('12. CANCELLED row with future dueDate is NOT in the due-soon list', async () => {
    await renderDashboard([
      { id: 'cancelled', status: 'CANCELLED', dueDate: '2026-09-25', course: { title: 'Cancelled Course' } },
      { id: 'due-soon', status: 'ASSIGNED', dueDate: '2026-09-25', course: { title: 'Real Due Soon' } },
    ]);

    // Headline assertion: the due-soon list surfaces ASSIGNED rows that
    // fall in the next week, while CANCELLED rows with the same dueDate
    // are silently dropped. Pre-fix the dashboard's training filter
    // passed the 3-arg `isDueSoonEnrollment(enrollment, optsOrNow,
    // windowDays)` straight to Array.prototype.filter — which forwards
    // `(element, index, array)` as the second/third args. The source
    // array slipped into `windowDays` and `1 <= [array]` evaluated to
    // NaN ≤, so the filter never matched anything.
    expect(await screen.findByText(/Real Due Soon/)).toBeInTheDocument();
    expect(screen.queryByText(/Cancelled Course/)).not.toBeInTheDocument();
  });

  test('13. empty attention list shows the "Nothing due in the next week." copy', async () => {
    // Edge case: a user with only CANCELLED rows shouldn't see the
    // attention card vanish silently — they should see the
    // "nothing due" copy because none of the rows are actually overdue
    // or due soon.
    await renderDashboard([
      { id: 'cancelled-1', status: 'CANCELLED', dueDate: '2026-09-20', course: { title: 'Cancelled A' } },
      { id: 'cancelled-2', status: 'CANCELLED', dueDate: '2026-09-25', course: { title: 'Cancelled B' } },
    ]);

    expect(await screen.findByText(/Nothing due in the next week\./)).toBeInTheDocument();
    expect(screen.queryByText(/Cancelled A/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Cancelled B/)).not.toBeInTheDocument();
  });
});
