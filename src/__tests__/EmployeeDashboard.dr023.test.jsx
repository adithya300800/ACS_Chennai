// DR-023 (SOL audit 2026-09-08): the dashboard "Check in now" shortcut
// previously posted /attendance/check-in with clientTime + clientTimezone
// but WITHOUT mandatory coordinates — the endpoint correctly rejected
// those with 400 "latitude and longitude are required". The dedicated
// /portal/attendance page is the single source of truth for the GPS flow,
// so the dashboard shortcut now navigates there with `?action=check-in`
// and lets the dedicated handler obtain + send real coordinates.
//
// Coverage:
//   1. source: the dashboard no longer calls api.post('/attendance/check-in')
//      from the inline handler (the old contract was incomplete — no
//      latitude / longitude).
//   2. source: the dashboard imports useNavigate (so the shortcut has a
//      real navigation primitive).
//   3. mount: clicking "Check in now" navigates to /portal/attendance
//      with the action hint, and does NOT call /attendance/check-in
//      from the dashboard.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

const dashPath = resolvePath(__dirname, '../pages/portal/EmployeeDashboard.jsx');
const dashSrc = readFileSync(dashPath, 'utf8');

describe('DR-023 — EmployeeDashboard source contracts', () => {
  test('1. dashboard no longer posts /attendance/check-in directly', () => {
    // The old code called api.post('/attendance/check-in', { clientTime,
    // clientTimezone }) with no coordinates — that payload was
    // structurally incomplete. The fix is to navigate instead of posting.
    expect(dashSrc).not.toMatch(/api\.post\(['"`]\/attendance\/check-in['"`]/);
    // The endpoint contract now belongs exclusively to Attendance.jsx.
  });

  test('2. dashboard imports useNavigate (navigation primitive available)', () => {
    expect(dashSrc).toMatch(/useNavigate/);
  });

  test('3. dashboard shortcut navigates to /portal/attendance?action=check-in', () => {
    expect(dashSrc).toMatch(
      /navigate\(['"`]\/portal\/attendance\?action=check-in['"`]\)/
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Real-mount coverage. Mirrors the provider/mock pattern in
// InspectionDashboard.dr008.test.jsx so a regression in the rendered
// DOM (not just the source text) trips the test.
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

// We never want the dashboard to post attendance. If this mock is
// called the test fails immediately via the spy assertion below.
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

const EMPTY_TODAY = { date: '2026-09-08', sessions: [] };
const EMPTY_DPRS = { dprs: [] };
const EMPTY_TRAINING = { enrollments: [] };
const EMPTY_LEAVES = { requests: [] };
const EMPTY_NOTIFS = { notifications: [] };

beforeEach(() => {
  jest.clearAllMocks();
  api.get.mockResolvedValue(EMPTY_TODAY);
  api.getDprs.mockResolvedValue(EMPTY_DPRS);
  api.getMyTraining.mockResolvedValue(EMPTY_TRAINING);
  api.getMyLeaves.mockResolvedValue(EMPTY_LEAVES);
  api.getNotifications.mockResolvedValue(EMPTY_NOTIFS);
  api.post.mockResolvedValue({});
});

describe('DR-023 — EmployeeDashboard real-mount coverage', () => {
  test('4. clicking "Check in now" does NOT post /attendance/check-in', async () => {
    render(
      <MemoryRouter initialEntries={['/portal/dashboard']}>
        <EmployeeDashboardProbe />
      </MemoryRouter>
    );

    const btn = await screen.findByRole('button', { name: /check in now/i });
    fireEvent.click(btn);

    // Give any deferred work a chance to run.
    await waitFor(() => {
      expect(api.post).not.toHaveBeenCalled();
    });
  });

  test('5. clicking "Check in now" navigates to /portal/attendance?action=check-in', async () => {
    render(
      <MemoryRouter initialEntries={['/portal/dashboard']}>
        <EmployeeDashboardProbe />
      </MemoryRouter>
    );

    const btn = await screen.findByRole('button', { name: /check in now/i });
    fireEvent.click(btn);

    // After navigation the probe renders the captured pathname + search.
    const heading = await screen.findByTestId('observed-location');
    expect(heading.textContent).toMatch(/pathname=\/portal\/attendance/);
    expect(heading.textContent).toMatch(/search=.*action=check-in/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// §8.1 — Training-tile deep-link. The actionable overdue row on the
// employee dashboard should deep-link straight to /portal/training/:id
// (the course player) so a single tap resumes the most pressing course.
// Static `<li>` rows are preserved for the secondary overdue + due-soon
// items so the affordance stays focused on the most actionable one.
// ────────────────────────────────────────────────────────────────────────────

describe('§8.1 — EmployeeDashboard training deep-link', () => {
  test('6. actionable overdue tile links to /portal/training/<enrollmentId>', async () => {
    // Mount-time data: one overdue enrollment (actionable, must deep-link)
    // + one secondary overdue + one due-soon. Only the FIRST overdue row
    // gets the direct link — the audit acceptance was "single tap to the
    // most actionable overdue item", not "deep-link every row".
    api.getMyTraining.mockResolvedValueOnce({
      enrollments: [
        {
          id: 'enr-actionable',
          dueDate: '2026-09-01T00:00:00Z', // past → overdue
          course: { id: 'course-1', title: 'Fall Protection 101' },
        },
        {
          id: 'enr-secondary',
          dueDate: '2026-09-05T00:00:00Z', // past → overdue but not actionable
          course: { id: 'course-2', title: 'Confined Space' },
        },
        {
          id: 'enr-due-soon',
          dueDate: '2099-01-01T00:00:00Z', // future → due-soon
          course: { id: 'course-3', title: 'First Aid Recert' },
        },
      ],
    });

    render(
      <MemoryRouter initialEntries={['/portal/dashboard']}>
        <EmployeeDashboardProbe />
      </MemoryRouter>
    );

    // The actionable overdue row is identified by its aria-label which
    // is unique to the deep-linked row. Other rows don't carry one.
    const actionable = await screen.findByLabelText(/resume overdue course: fall protection 101/i);
    expect(actionable).toBeInTheDocument();
    // The deep-link target must be /portal/training/<enrollmentId>.
    expect(actionable.getAttribute('href')).toMatch(/\/portal\/training\/enr-actionable$/);
  });

  test('7. source-text pin: the actionable overdue row wraps in <Link to=/portal/training/...>', () => {
    // Guard against a regression that drops the deep-link affordance
    // — the regex pins BOTH the Link wrapper shape and the dynamic
    // enrollment-id interpolation so a future "rewrap as <a>" refactor
    // that hard-codes the URL would also trip this pin.
    expect(dashSrc).toMatch(
      /<Link[^>]*to=\{`\/portal\/training\/\$\{e\.id\}`\}/
    );
  });
});

// Probe harness: renders EmployeeDashboard inside a MemoryRouter that
// captures every navigation into the DOM so the assertion above can
// read the resulting pathname/search without needing history/.
//
// We split this into its own component (vs. inlining a Routes tree)
// so the test file's source-text regex assertions above remain
// unambiguous about the dashboard's own navigation call.
function EmployeeDashboardProbe() {
  const { default: EmployeeDashboard } = require('../pages/portal/EmployeeDashboard.jsx');
  const location = useLocation();
  return (
    <>
      <EmployeeDashboard />
      <pre data-testid="observed-location">
        pathname={location.pathname}
        search={location.search}
      </pre>
    </>
  );
}
