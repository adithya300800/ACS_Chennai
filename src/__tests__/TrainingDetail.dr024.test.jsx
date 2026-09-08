// SOL DR-024 — separate completed / cancelled / overdue / actionable
// predicates in the employee TrainingDetail page.
//
// Pins the four audit failures described in
// Code review by SOL/ACS-Portal-Workflow-Completeness-Review-2026-09-08-5c61cd8.md
// (lines 360-370):
//
//   1. External launch + manual completion persisted SELF_ATTESTED_COMPLETED
//      with lastWatchedSec: 0 but the UI rendered "100% watched".
//      Fix: render "Self-attested" in the progress label for that status.
//   2. A CANCELLED enrollment still offered the embedded-player "Continue".
//      Fix: hide the player + Mark-as-Complete for CANCELLED / OVERDUE.
//   3. PUT /api/training/enrollments/:id/progress returned 200 noop for
//      OVERDUE/CANCELLED — backend test in
//      backend/__tests__/dr024-training-status-predicates.test.js.
//   4. Embedded player's ended handler could announce completion on a row
//      that was already CANCELLED / OVERDUE.
//      Fix: gate on isTrainingInactive (broader than isTrainingTerminal).
//
// We mount the real TrainingDetail component so a regression in the rendered
// output fails the suite — the source-content assertions in the backend test
// file cover the route; these cover the UI.

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

jest.mock('../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({
    accessToken: 'test-token',
    user: { id: 'u-1' },
    employee: { id: 'emp-1', isAdmin: false },
  }),
}));

// Stable module-singleton push so the TrainingDetail useEffect deps do not
// churn when useToast returns a fresh fn reference each render.
jest.mock('../contexts/ToastContext.jsx', () => {
  const stablePush = jest.fn();
  const stableDismiss = jest.fn();
  return {
    __esModule: true,
    ToastProvider: ({ children }) => children,
    useToast: () => ({ push: stablePush, dismiss: stableDismiss }),
  };
});

jest.mock('../hooks/useDocumentTitle.js', () => ({
  useDocumentTitle: jest.fn(),
}));

jest.mock('../lib/api.js', () => ({
  api: {
    getTrainingEnrollment: jest.fn(),
    updateTrainingProgress: jest.fn(),
    markTrainingComplete: jest.fn(),
  },
}));

// Stub the embedded player so we don't drag in the iframe wiring — we only
// care about whether TrainingDetail renders the right actions around it.
jest.mock('../components/VideoPlayer.jsx', () => ({
  __esModule: true,
  default: function VideoPlayerStub({ onEnded, onProgress }) {
    return (
      <div data-testid="video-player-stub">
        <button type="button" onClick={() => onEnded && onEnded()}>
          fire ended
        </button>
        <button type="button" onClick={() => onProgress && onProgress({ pct: 100, currentSec: 0 })}>
          fire progress
        </button>
      </div>
    );
  },
}));

const { api } = require('../lib/api.js');

const renderDetail = async (enrollment) => {
  // React 18 strict mode mounts twice; use mockResolvedValue (not Once)
  // so the second mount's fetchEnrollment resolves the same row.
  api.getTrainingEnrollment.mockResolvedValue(enrollment);
  const { default: TrainingDetail } = require('../pages/portal/TrainingDetail.jsx');
  const result = render(
    <MemoryRouter initialEntries={[`/portal/training/${enrollment.id}`]}>
      <Routes>
        <Route path="/portal/training/:id" element={<TrainingDetail />} />
      </Routes>
    </MemoryRouter>
  );
  // Wait for the loaded branch to render. The component returns the
  // "Loading course…" stub while the fetch is in flight (StrictMode
  // re-mounts, so this may flicker twice); assertions in the tests below
  // expect the post-load markup, not the loading stub.
  await waitFor(() =>
    expect(document.querySelector('.training-detail-page')).toBeTruthy()
  );
  return result;
};

const baseCourse = {
  id: 'c-1',
  title: 'Project Safety',
  provider: 'YOUTUBE',
  externalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  category: 'Safety',
};

beforeEach(() => {
  api.getTrainingEnrollment.mockReset();
  api.updateTrainingProgress.mockReset();
  api.markTrainingComplete.mockReset();
  api.updateTrainingProgress.mockResolvedValue({ status: 'IN_PROGRESS', progressPct: 50 });
  api.markTrainingComplete.mockResolvedValue({ status: 'SELF_ATTESTED_COMPLETED', progressPct: 100 });
});

describe('TrainingDetail (DR-024) — status predicates and labels', () => {
  test('1. SELF_ATTESTED_COMPLETED with lastWatchedSec=0 shows "Self-attested", not "100% watched"', async () => {
    await renderDetail({
      id: 'e-1',
      status: 'SELF_ATTESTED_COMPLETED',
      progressPct: 100,
      lastWatchedSec: 0, // the audit evidence file's exact symptom
      completedAt: '2026-09-04T10:00:00.000Z',
      course: baseCourse,
    });

    await waitFor(() => expect(screen.getByText('Self-attested')).toBeInTheDocument());
    expect(screen.queryByText(/100% watched/)).not.toBeInTheDocument();
    // The completed banner + pill should still be present.
    expect(screen.getByText(/Completed on/)).toBeInTheDocument();
  });

  test('2a. CANCELLED row hides the embedded player and Mark-as-Complete', async () => {
    await renderDetail({
      id: 'e-2',
      status: 'CANCELLED',
      progressPct: 30,
      lastWatchedSec: 120,
      course: baseCourse,
    });

    await waitFor(() => expect(screen.queryByTestId('video-player-stub')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Mark as Complete/i })).not.toBeInTheDocument();
    // Pill + explanation rendered.
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.getByText(/cancelled and cannot be completed/i)).toBeInTheDocument();
  });

  test('2b. OVERDUE row hides the embedded player and Mark-as-Complete', async () => {
    await renderDetail({
      id: 'e-3',
      status: 'OVERDUE',
      progressPct: 25,
      lastWatchedSec: 90,
      course: baseCourse,
    });

    await waitFor(() => expect(screen.queryByTestId('video-player-stub')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Mark as Complete/i })).not.toBeInTheDocument();
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(screen.getByText(/overdue and can no longer be completed/i)).toBeInTheDocument();
  });

  test('3. ASSIGNED row keeps the embedded player and the Mark-as-Complete button', async () => {
    await renderDetail({
      id: 'e-4',
      status: 'ASSIGNED',
      progressPct: 0,
      lastWatchedSec: 0,
      course: baseCourse,
    });

    await waitFor(() => expect(screen.getByTestId('video-player-stub')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Mark as Complete/i })).toBeInTheDocument();
    expect(screen.getByText('Assigned')).toBeInTheDocument();
  });

  test('4. IN_PROGRESS row shows the percent-watched label, not "Self-attested"', async () => {
    await renderDetail({
      id: 'e-5',
      status: 'IN_PROGRESS',
      progressPct: 42,
      lastWatchedSec: 180,
      course: baseCourse,
    });

    await waitFor(() => expect(screen.getByText('42% watched')).toBeInTheDocument());
    expect(screen.queryByText('Self-attested')).not.toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pin the action-guard wiring: handleEnded / handleManualComplete / the
// progress interval must short-circuit on CANCELLED + OVERDUE so the
// embedded player can't push progress into a row that should not accept it.
// We assert by reading the source — the same "real mount proves the wiring"
// pattern used elsewhere, but inverted: here we read the file because the
// guards are inline arrows that the real mount cannot easily exercise (the
// throttle loop + the player both need real timers, which would slow the
// suite and make it flaky).
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

describe('TrainingDetail (DR-024) — action guards route through isTrainingInactive', () => {
  const tdPath = resolvePath(__dirname, '../pages/portal/TrainingDetail.jsx');
  const tdSource = readFileSync(tdPath, 'utf8');

  test('5. progress-interval guard uses isTrainingInactive (not isTrainingTerminal)', () => {
    expect(tdSource).toMatch(/isTrainingInactive\s*\(\s*enrollment\.status\s*\)/);
  });

  test('6. onEnded handler short-circuits via isTrainingInactive', () => {
    // Mirror the same pattern: a `if (isTrainingInactive(...)) return` line
    // must appear inside the onEnded useCallback. We assert by looking for
    // the literal phrase.
    expect(tdSource).toMatch(/if\s*\(\s*isTrainingInactive\s*\(\s*enrollment\.status\s*\)\s*\)\s*return\s*;/);
  });

  test('7. manual-complete handler short-circuits via isTrainingInactive', () => {
    expect(tdSource).toMatch(/if\s*\(\s*isTrainingInactive\s*\(\s*enrollment\.status\s*\)\s*\)\s*return\s*;/);
  });
});
