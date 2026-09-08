// DR-008 (2026-09-08 SOL audit): "An acknowledged inspection cannot be
// selected for the Close action that already allows it".
//
// The admin queue gated the per-card checkbox on REVIEWABLE_STATUSES, a
// hand-typed set that listed OPEN / IN_PROGRESS / PENDING_VERIFICATION and
// omitted ACKNOWLEDGED — even though CLOSE_ALLOWED_FROM and
// REJECT_ALLOWED_FROM (both mirroring the backend's CLOSE_FROM / REJECT_FROM
// in backend/src/routes/inspection.js:1501-1503) accept ACKNOWLEDGED. Net
// effect: once a record advanced OPEN → ACKNOWLEDGED it rendered with no
// checkbox, so the Close action it *was* eligible for became unreachable.
//
// Fix: derive REVIEWABLE_STATUSES from the union of the three per-action
// allowed-from sets, so the checkbox gate can never be narrower than the
// actions themselves.
//
// Coverage:
//   1. source: REVIEWABLE_STATUSES is derived from the per-action sets
//   2. source: no hand-typed REVIEWABLE_STATUSES literal remains
//   3. mount: an ACKNOWLEDGED row renders a selection checkbox
//   4. mount: selecting the ACKNOWLEDGED row surfaces an enabled Close button
//   5. mount: an OPEN row is selectable but its Close button stays disabled
//      (the audit is explicit — OPEN must not close directly)
//   6. mount: terminal rows (CLOSED / REJECTED) remain unselectable

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const pagePath = resolvePath(__dirname, '../pages/admin/InspectionDashboard.jsx');
const pageSrc = readFileSync(pagePath, 'utf8');

describe('DR-008 — InspectionDashboard source contracts', () => {
  test('1. REVIEWABLE_STATUSES is derived from the per-action allowed-from sets', () => {
    expect(pageSrc).toMatch(
      /REVIEWABLE_STATUSES\s*=\s*new Set\(\[\s*\.\.\.ACK_ALLOWED_FROM,\s*\.\.\.CLOSE_ALLOWED_FROM,\s*\.\.\.REJECT_ALLOWED_FROM,?\s*\]\)/,
    );
  });

  test('2. no hand-typed REVIEWABLE_STATUSES string literal remains', () => {
    // The buggy line was:
    //   const REVIEWABLE_STATUSES = new Set(['OPEN', 'IN_PROGRESS', 'PENDING_VERIFICATION']);
    expect(pageSrc).not.toMatch(/REVIEWABLE_STATUSES\s*=\s*new Set\(\s*\[\s*['"]/);
  });

  test('3. per-action sets still mirror the backend (restrictions preserved)', () => {
    expect(pageSrc).toMatch(/ACK_ALLOWED_FROM\s*=\s*new Set\(\['OPEN'\]\)/);
    expect(pageSrc).toMatch(
      /CLOSE_ALLOWED_FROM\s*=\s*new Set\(\['ACKNOWLEDGED',\s*'IN_PROGRESS',\s*'PENDING_VERIFICATION'\]\)/,
    );
    expect(pageSrc).toMatch(
      /REJECT_ALLOWED_FROM\s*=\s*new Set\(\['OPEN',\s*'ACKNOWLEDGED',\s*'IN_PROGRESS',\s*'PENDING_VERIFICATION'\]\)/,
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Real-mount coverage. Mirrors the provider/mock pattern in
// TrainingDashboard.test.jsx (DR-018d) so the rendered DOM — not just the
// source text — is what fails if the gate regresses.
// ────────────────────────────────────────────────────────────────────────────

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

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

jest.mock('../lib/api.js', () => ({
  api: {
    getInspections: jest.fn(),
    getInspectionStats: jest.fn(),
    bulkReviewInspections: jest.fn(),
  },
}));

const { api } = require('../lib/api.js');

const EMPTY_STATS = {
  openNow: 0,
  filedToday: 0,
  closedToday: 0,
  acknowledged: 0,
  pendingReview: 0,
  totalActive: 0,
};

const inspection = (id, status) => ({
  id,
  status,
  inspectionType: 'SAFETY_VIOLATION',
  location: `Block ${id}`,
  reportDate: '2026-09-08',
  severity: 'HIGH',
  project: { name: 'Synthetic Project' },
  photos: [],
  submittedBy: { name: 'Engineer One' },
});

const renderDashboard = async () => {
  const { default: InspectionDashboard } = require('../pages/admin/InspectionDashboard.jsx');
  const utils = render(
    <MemoryRouter initialEntries={['/portal/admin/inspections']}>
      <InspectionDashboard />
    </MemoryRouter>
  );
  await waitFor(() => expect(api.getInspections).toHaveBeenCalled());
  return utils;
};

beforeEach(() => {
  jest.clearAllMocks();
  api.getInspectionStats.mockResolvedValue(EMPTY_STATS);
  api.getInspections.mockResolvedValue({ inspections: [], nextCursor: null });
  api.bulkReviewInspections.mockResolvedValue({ succeededCount: 1, failedCount: 0, failed: [] });
});

describe('DR-008 — InspectionDashboard real-mount coverage', () => {
  test('4. an ACKNOWLEDGED row renders a selection checkbox (the audit headline)', async () => {
    api.getInspections.mockResolvedValue({
      inspections: [inspection('ack-1', 'ACKNOWLEDGED')],
      nextCursor: null,
    });

    await renderDashboard();

    const checkbox = await screen.findByRole('checkbox', {
      name: /Select Synthetic Project for bulk action/i,
    });
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).not.toBeDisabled();
  });

  test('5. selecting the ACKNOWLEDGED row surfaces an ENABLED Close action', async () => {
    api.getInspections.mockResolvedValue({
      inspections: [inspection('ack-1', 'ACKNOWLEDGED')],
      nextCursor: null,
    });

    await renderDashboard();

    fireEvent.click(
      await screen.findByRole('checkbox', { name: /Select Synthetic Project for bulk action/i })
    );

    const closeBtn = await screen.findByRole('button', { name: /Close/ });
    expect(closeBtn).toBeInTheDocument();
    expect(closeBtn).not.toBeDisabled();

    // And the action actually dispatches CLOSE for that ID — the pre-flight
    // no longer treats ACKNOWLEDGED as ineligible.
    fireEvent.click(closeBtn);
    await waitFor(() => expect(api.bulkReviewInspections).toHaveBeenCalled());
    expect(api.bulkReviewInspections.mock.calls[0][0]).toMatchObject({
      ids: ['ack-1'],
      action: 'CLOSE',
    });
  });

  test('6. an OPEN row is selectable but its Close button stays DISABLED (OPEN must not close directly)', async () => {
    api.getInspections.mockResolvedValue({
      inspections: [inspection('open-1', 'OPEN')],
      nextCursor: null,
    });

    await renderDashboard();

    fireEvent.click(
      await screen.findByRole('checkbox', { name: /Select Synthetic Project for bulk action/i })
    );

    // Acknowledge is the legal next step for OPEN…
    expect(await screen.findByRole('button', { name: /Acknowledge/ })).not.toBeDisabled();
    // …but Close is not, and the button reflects that.
    expect(screen.getByRole('button', { name: /Close/ })).toBeDisabled();
  });

  test('7. terminal rows (CLOSED / REJECTED) remain unselectable', async () => {
    api.getInspections.mockResolvedValue({
      inspections: [inspection('closed-1', 'CLOSED'), inspection('rejected-1', 'REJECTED')],
      nextCursor: null,
    });

    await renderDashboard();

    await waitFor(() => expect(screen.getAllByText('Synthetic Project')).toHaveLength(2));
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });
});
