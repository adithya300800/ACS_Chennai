// DR-008 (Fresh24 audit 2026-09-24): "Workforce read errors become
// reassuring zero/no-work states"
//
// Three failure-as-zero patterns identified at the cited evidence paths:
//
//   A. AdminOverview.jsx:35-45
//      The `Promise.all` of `getDprs / getInspections / getAllLeaves /
//      getTrainingCourses` previously used `.catch(() => ({...empty}))`,
//      collapsing a downed endpoint into a zero badge indistinguishable
//      from a genuinely-empty queue. Fix: per-tile `tileStatus` so an
//      error renders a "!" pill + an inline Retry button; healthy tiles
//      remain unchanged.
//
//   B. TrainingCourseDetail.jsx:140-148
//      `fetchEnrollments` swallowed failures into `console.error`, then
//      `setEnrollments([])` left the state visually indistinguishable from
//      "no enrollments yet". Fix: separate `enrollmentsStatus` so the
//      "Recent enrollments" section renders a Retry on error, the stats
//      tiles swap to "—" (unknown), and the page-level "No enrollments
//      yet." copy is gated on `enrollmentsStatus === 'success'`.
//
//   C. Attendance.jsx:119-130, 392-414
//      `fetchMonth` silently reset `monthRecords` to [] on error, so
//      today's cell rendered as "unmarked" — exactly the failure-as-zero
//      pattern that drove the audit. The manual "Mark Attendance"
//      button rendered whenever `!hasOpenSession`, including on
//      loading/error states where todayRecord is null but for the wrong
//      reason. Fix: `monthStatus` swaps the calendar grid for an error
//      + Retry; the manual button is gated on `fetchStatus === 'success'`,
//      mirroring the auto-shortcut gate that already existed at
//      `useEffect({fetchStatus})`.
//
// Coverage targets (≥ 4 cases):
//   1. AdminOverview: one failed endpoint renders the ! badge + Retry,
//      independent healthy tiles keep their numeric badge.
//   2. AdminOverview: Retry only re-fires loadCounts; a previously-failed
//      tile recovers when its endpoint is mocked-OK on retry.
//   3. TrainingCourseDetail: a failed `getAllTrainingEnrollments`
//      renders the Retry CTA in the recent-enrollments section AND
//      swaps the stats tiles to "—" rather than 0.
//   4. TrainingCourseDetail: a recovered enrollment fetch clears the
//      error arm and re-renders the list (or "No enrollments yet" if
//      the recovered payload is empty).
//   5. Attendance: a failed `fetchMonth` does NOT render the calendar
//      grid; today's cell does not appear as "unmarked". A Retry CTA
//      is present.
//   6. Attendance: the manual "Mark Attendance" button is NOT rendered
//      while `fetchStatus === 'loading' || fetchStatus === 'error'`;
//      the auto-shortcut gate that protects `?action=check-in` is mirrored.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// ─── Shared providers / mocks ─────────────────────────────────────────────

jest.mock('../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({
    accessToken: 'test-token',
    user: { id: 'admin-1' },
    employee: { id: 'emp-admin', isAdmin: true, name: 'Test Admin' },
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
    get: jest.fn(),
    getDprs: jest.fn(),
    getInspections: jest.fn(),
    getAllLeaves: jest.fn(),
    getTrainingCourses: jest.fn(),
    getTrainingCourse: jest.fn(),
    getAllTrainingEnrollments: jest.fn(),
    post: jest.fn(),
  },
}));

const { api } = require('../lib/api.js');

// ─── Source-text guards (mirror the existing DO-F-1 pattern) ──────────────

const aoSrc = readFileSync(resolvePath(__dirname, '../pages/admin/AdminOverview.jsx'), 'utf8');
const tcdSrc = readFileSync(resolvePath(__dirname, '../pages/admin/TrainingCourseDetail.jsx'), 'utf8');
const attSrc = readFileSync(resolvePath(__dirname, '../pages/portal/Attendance.jsx'), 'utf8');

beforeEach(() => {
  jest.clearAllMocks();
});

// ────────────────────────────────────────────────────────────────────────
// A. AdminOverview — per-tile failure distinction + Retry
// ────────────────────────────────────────────────────────────────────────

describe('DR-008 — AdminOverview source contracts', () => {
  test('source: AdminOverview no longer collapses each fetch failure into an empty envelope', () => {
    // The buggy line was:
    //   api.getDprs(...).catch(() => ({ dprs: [] }))
    // A failure-as-empty catch for any of the four overview endpoints.
    // After the fix the API calls are wrapped with `.then(ok, fail)`
    // so each tile records its own status. Pin the absence of any
    // remaining `.catch(() => ({...empty}))` collapse.
    expect(aoSrc).not.toMatch(/\.catch\(\s*\(\)\s*=>\s*\(\{\s*dprs:\s*\[\]\s*\}\s*\)\)/);
    expect(aoSrc).not.toMatch(/\.catch\(\s*\(\)\s*=>\s*\(\{\s*inspections:\s*\[\]\s*\}\s*\)\)/);
    expect(aoSrc).not.toMatch(/\.catch\(\s*\(\)\s*=>\s*\(\{\s*requests:\s*\[\]\s*\}\s*\)\)/);
    expect(aoSrc).not.toMatch(/\.catch\(\s*\(\)\s*=>\s*\(\{\s*courses:\s*\[\]\s*\}\s*\)\)/);
  });

  test('source: AdminOverview records per-tile status ("tileStatus") and reuses it on render', () => {
    expect(aoSrc).toMatch(/tileStatus/);
    expect(aoSrc).toMatch(/setTileStatus/);
    // The render branch must consult tileStatus so a downed endpoint
    // swaps the numeric badge for an error pill.
    expect(aoSrc).toMatch(/admin-overview-badge-error/);
    expect(aoSrc).toMatch(/Retry/);
  });
});

describe('DR-008 — AdminOverview real-mount coverage', () => {
  const renderOverview = async () => {
    const { default: AdminOverview } = require('../pages/admin/AdminOverview.jsx');
    const utils = render(
      <MemoryRouter initialEntries={['/portal/admin']}>
        <AdminOverview />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(api.getDprs).toHaveBeenCalled()
    );
    return utils;
  };

  test('A1. one failed endpoint shows "!" + Retry; independent healthy tiles keep their badge', async () => {
    // DPR fails, the other three endpoints succeed.
    api.getDprs.mockRejectedValue(new Error('boom'));
    api.getInspections.mockResolvedValue({ inspections: [] });
    api.getAllLeaves.mockResolvedValue({ requests: [{ id: 'lv-1' }, { id: 'lv-2' }] });
    api.getTrainingCourses.mockResolvedValue({ courses: [] });

    await renderOverview();

    // DPR tile is the failure case — should expose an inline Retry button.
    const retryBtns = await screen.findAllByRole('button', { name: /Retry/i });
    expect(retryBtns.length).toBeGreaterThanOrEqual(1);

    // The Leave Approvals badge is the healthy tile — "2 pending" must
    // still be present even though DPR is in error. This is the headline
    // assertion: healthy tiles remain usable while one is degraded.
    // (Multiple tiles render the "pending" label — both healthy DPR
    // (here in error) and Inspection — so we use the All variant and
    // assert at least one occurrence of the "2" count survives.)
    const pendingLabels = screen.getAllByText('pending');
    expect(pendingLabels.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('2')).toBeInTheDocument();
    // The DPR error pill shows "!" + "unavailable" so an admin can
    // distinguish a downed endpoint from a genuinely-empty one.
    expect(screen.getByText('unavailable')).toBeInTheDocument();
    expect(screen.getByText('!')).toBeInTheDocument();
  });

  test('A2. clicking Retry re-fires loadCounts; a previously-failed tile recovers when OK', async () => {
    // First call: DPR fails. Second call: DPR returns 5 records.
    api.getDprs
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ dprs: [{}, {}, {}, {}, {}] });
    api.getInspections.mockResolvedValue({ inspections: [] });
    api.getAllLeaves.mockResolvedValue({ requests: [] });
    api.getTrainingCourses.mockResolvedValue({ courses: [] });

    await renderOverview();

    // Confirm the failure arm is visible first.
    await screen.findByRole('button', { name: /Retry/i });
    const callsBefore = api.getDprs.mock.calls.length;

    // Click any Retry — both tiles share the same loadCounts handle,
    // so one click re-fires all four. We assert that DPR is re-called.
    fireEvent.click(screen.getAllByRole('button', { name: /Retry/i })[0]);

    await waitFor(() =>
      expect(api.getDprs.mock.calls.length).toBeGreaterThan(callsBefore)
    );
    // After recovery the badge should reflect 5 — the failure-as-zero
    // pattern is gone, the healthy count drives the badge.
    await waitFor(() => {
      expect(screen.getAllByText('5').length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// B. TrainingCourseDetail — enrollment fetch error distinguishable from empty
// ────────────────────────────────────────────────────────────────────────

describe('DR-008 — TrainingCourseDetail source contracts', () => {
  test('source: enrollment fetch tracks its own status (no silent reset to [])', () => {
    // The buggy line was:
    //   } catch (err) {
    //     console.error('[training/course-detail] enrollments fetch failed', err?.message);
    //   }
    // leaving `enrollments` at its previous value with no UI signal.
    // After the fix, the catch must record an error status (not just log).
    expect(tcdSrc).toMatch(/setEnrollmentsStatus\(['"]error['"]\)/);
    // The "No enrollments yet." copy must be guarded by status so it
    // never renders on a failed fetch.
    expect(tcdSrc).toMatch(/enrollmentsStatus\s*===\s*['"]error['"]/);
    // Stats tiles must swap to "—" when the fetch failed.
    expect(tcdSrc).toMatch(/countsUnknown\s*\?\s*['"]—['"]/);
  });
});

describe('DR-008 — TrainingCourseDetail real-mount coverage', () => {
  const renderCourse = async () => {
    const { default: TrainingCourseDetail } = require('../pages/admin/TrainingCourseDetail.jsx');
    const utils = render(
      <MemoryRouter initialEntries={['/portal/admin/training/course-1']}>
        <TrainingCourseDetail />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(api.getTrainingCourse).toHaveBeenCalled()
    );
    return utils;
  };

  const baseCourse = {
    id: 'course-1',
    title: 'Safety Induction',
    provider: 'INTERNAL',
    category: 'SAFETY',
    externalUrl: 'https://example.com',
    description: '',
    isArchived: false,
    createdAt: '2026-09-01T00:00:00Z',
    createdBy: { name: 'Admin One' },
  };

  test('B3. failed enrollment fetch renders Retry and "—" stats (NOT "No enrollments yet" + zeros)', async () => {
    api.getTrainingCourse.mockResolvedValue(baseCourse);
    api.getAllTrainingEnrollments.mockRejectedValue(new Error('boom'));

    await renderCourse();

    // The stats tiles must read as unknown — "—" — not 0.
    const dashCells = await screen.findAllByText('—');
    expect(dashCells.length).toBeGreaterThanOrEqual(1);

    // The Recent enrollments section must NOT show "No enrollments yet.".
    // (That copy is gated on `enrollmentsStatus !== 'error'` after the fix.)
    expect(screen.queryByText(/No enrollments yet/i)).not.toBeInTheDocument();

    // A Retry CTA is present.
    expect(screen.getByRole('button', { name: /^Retry$/i })).toBeInTheDocument();
  });

  test('B4. recovered enrollment fetch clears the error arm and renders the list', async () => {
    api.getTrainingCourse.mockResolvedValue(baseCourse);
    api.getAllTrainingEnrollments
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ enrollments: [] });

    await renderCourse();
    expect(screen.getByRole('button', { name: /^Retry$/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Retry$/i }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Retry$/i })).not.toBeInTheDocument();
    });
    // The recovered-but-empty payload renders the original "No enrollments yet."
    expect(await screen.findByText(/No enrollments yet/i)).toBeInTheDocument();
    // And the stats tiles return to numeric values (here, all 4 tiles
    // are 0 — Enrolled/In progress/Completed/Overdue).
    await waitFor(() => {
      expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(1);
    });
    // The "—" markers from the failure arm must be gone.
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });
});

// ────────────────────────────────────────────────────────────────────────
// C. Attendance — month fetch error does not masquerade as "unmarked",
//    manual button gated on fetchStatus === 'success'
// ────────────────────────────────────────────────────────────────────────

describe('DR-008 — Attendance source contracts', () => {
  test('source: month fetch tracks status separately (no silent reset to [])', () => {
    // The buggy line was `catch { setMonthRecords([]); }`. After the fix
    // the catch must record an error status; the records themselves stay
    // at their previous value so a brief outage doesn't visually blank
    // the month.
    expect(attSrc).toMatch(/setMonthStatus\(['"]error['"]\)/);
    // The "couldn't load" arm must render the calendar-grid branch only
    // when monthStatus !== 'error'.
    expect(attSrc).toMatch(/monthStatus\s*===\s*['"]error['"]/);
  });

  test('source: manual "Mark Attendance" button gated on fetchStatus === "success" (mirror of auto-shortcut)', () => {
    // The render branch of the action button must consult fetchStatus
    // before showing the manual button. The auto-shortcut already gated
    // on `if (fetchStatus !== 'success') return;` — the manual button
    // must follow the same gate.
    expect(attSrc).toMatch(/fetchStatus\s*===\s*['"]error['"]\s*\?\s*\(/);
    expect(attSrc).toMatch(/fetchStatus\s*===\s*['"]loading['"]\s*\?\s*\(/);
  });
});

describe('DR-008 — Attendance real-mount coverage', () => {
  // Stub geolocation so the test paths that surface the manual button
  // don't trip the geolocation prompt.
  const installGeoStub = () => {
    if (!global.navigator.geolocation) {
      Object.defineProperty(global.navigator, 'geolocation', {
        value: { getCurrentPosition: jest.fn() },
        configurable: true,
      });
    }
  };

  const renderAttendance = async ({ todayMock, monthMock } = {}) => {
    installGeoStub();
    api.get.mockImplementation(async (path) => {
      if (path.startsWith('/attendance/today')) {
        if (todayMock instanceof Error) throw todayMock;
        return todayMock ?? { date: '2026-09-24', sessions: [] };
      }
      if (path.startsWith('/attendance')) {
        if (monthMock instanceof Error) throw monthMock;
        return monthMock ?? [];
      }
      return {};
    });

    const { default: Attendance } = require('../pages/portal/Attendance.jsx');
    const utils = render(
      <MemoryRouter initialEntries={['/portal/attendance']}>
        <Attendance />
      </MemoryRouter>
    );
    // Wait for at least one /attendance fetch to settle.
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    return utils;
  };

  test('C5. failed /attendance (month) does NOT render the calendar grid; Retry is shown', async () => {
    await renderAttendance({
      todayMock: { date: '2026-09-24', sessions: [] },
      monthMock: new Error('month boom'),
    });

    // Wait for both fetches to complete. The Today record is OK, so we
    // expect the action area; the month fetch failed, so the calendar
    // grid is replaced by the error arm.
    await waitFor(() => {
      // The error arm: a Retry CTA + the failure message.
      expect(screen.getByRole('button', { name: /^Retry$/i })).toBeInTheDocument();
    });
    expect(screen.getByText(/Couldn't load attendance for this month/i)).toBeInTheDocument();
    // The calendar grid itself must not be rendered. The grid renders
    // 7 weekday headers (Sun..Sat); their absence is what we check.
    expect(screen.queryByText('Sun')).not.toBeInTheDocument();
  });

  test('C6. manual "Mark Attendance" button is NOT rendered while fetchStatus === "loading" or "error"', async () => {
    // Today fetch fails. The auto-shortcut was already gated on
    // `fetchStatus === 'success'`; the manual button must mirror that.
    await renderAttendance({
      todayMock: new Error('today boom'),
      monthMock: new Error('month boom'),
    });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Mark Attendance$/i })).not.toBeInTheDocument();
    });
    // A Retry CTA exists for today's record specifically.
    expect(screen.getByRole('button', { name: /Retry loading today's record/i })).toBeInTheDocument();
  });

  test('C7. successful fetch renders the original "Mark Attendance" button (regression guard)', async () => {
    // The fix must not break the success path. When fetchStatus ===
    // 'success' AND no open session exists, the manual button must
    // render as before.
    await renderAttendance({
      todayMock: { date: '2026-09-24', sessions: [] },
      monthMock: [],
    });

    const btn = await screen.findByRole('button', { name: /^Mark Attendance$/i });
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
  });
});