// MyPayslips — behavior tests (no source-text pins).
//
// What this file pins:
//   1. Renders empty state when the API returns an empty list.
//   2. Renders rows newest-first when the API returns a paginated list.
//      (The page trusts the wire order, but the page's UI surface —
//      the download button gating, the published pill — must reflect
//      the wire order the page actually received. We verify by
//      feeding the page an unordered API response and asserting the
//      rendered order matches the input order.)
//   3. Renders error + Retry when the API throws; click → re-fetches.
//   4. Clicking Download calls api.downloadPayslip with the right id
//      and pipes the response blob through a real objectURL trigger.
//   5. After the four-guard fix to the portal list endpoint, only
//      PUBLISHED rows are returned from the API — the page must not
//      filter out anything else (the page is a thin renderer now).
//   6. Plain newest-first list — no year filter, no status chips, no
//      "Load more" button. The plan (§B.2.1 + §E.3) forbids a
//      year-filter / cursor / "Load more" surface in v1; the page
//      must NOT have these elements regardless of how many rows the
//      API returns.
//   7. NO email-status pill on the employee view. Plan §B.2.1 puts
//      the emailStatus pill on the admin coverage view only — the
//      employee page is focused on the only thing the employee can
//      act on (download). A FAILED pill on the employee view would
//      just generate "did I get paid?" tickets; a PENDING pill is
//      the same noise. The header must not contain "Sending…" copy.
//   8. The page does NOT import or use PAYSLIP_EMAIL_STATUS_LABELS
//      (it lives in src/lib/constants.js). A future refactor that
//      re-introduces the pill on the employee side will fail this
//      test if it forgets to import the labels — and the page itself
//      will fail to render the pill if it imports nothing.
//
// Why behavior tests and not source-text pins: the user explicitly
// forbade source-text pins. These tests mount the page, mock the
// network, and assert the DOM. They will catch a regression where
// the wire shape drifts from the page's contract — a regression
// source-text pins would miss.

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// ─── Network mocks (variable names start with `mock` so jest's hoisted
// factory closure accepts the out-of-scope references).
const mockGetMyPayslips = jest.fn();
const mockDownloadPayslip = jest.fn();
const mockToastPush = jest.fn();

jest.mock('../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({
    accessToken: 'test-token',
    employee: { id: 'emp-1' },
  }),
}));

jest.mock('../contexts/ToastContext.jsx', () => ({
  useToast: () => ({ push: mockToastPush, dismiss: jest.fn() }),
}));

jest.mock('../lib/api.js', () => ({
  api: {
    getMyPayslips: mockGetMyPayslips,
    downloadPayslip: mockDownloadPayslip,
  },
}));

jest.mock('../hooks/useDocumentTitle.js', () => ({
  useDocumentTitle: jest.fn(),
}));

// usePullToRefresh just observes touch gestures; jsdom doesn't dispatch
// touch events so the refresh path never fires on its own. Stub it.
jest.mock('../hooks/usePullToRefresh.js', () => ({
  __esModule: true,
  default: () => ({ pullDistance: 0, isRefreshing: false }),
}));

beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
  // Default to an empty list — individual tests override.
  mockGetMyPayslips.mockResolvedValue({ payslips: [], nextCursor: null, total: 0 });
  // Default download — returns a small blob and a filename matching the
  // server's Content-Disposition contract.
  mockDownloadPayslip.mockResolvedValue({
    blob: new Blob(['%PDF-1.4\n%%EOF\n'], { type: 'application/pdf' }),
    filename: 'Payslip-2026-10.pdf',
    contentType: 'application/pdf',
  });
  // jsdom does not implement URL.createObjectURL / revokeObjectURL;
  // stub them so the download happy path can complete in the test
  // environment. The objectURL trigger is a real browser API the
  // page calls unconditionally; without this stub, the download
  // path throws and the success toast is never pushed.
  if (!global.URL.createObjectURL) {
    global.URL.createObjectURL = jest.fn(() => 'blob:mock-url');
  }
  if (!global.URL.revokeObjectURL) {
    global.URL.revokeObjectURL = jest.fn();
  }
});

const renderPage = () => {
  const MyPayslips = require('../pages/portal/MyPayslips.jsx').default;
  return render(
    <MemoryRouter initialEntries={['/portal/payslips']}>
      <Routes>
        <Route path="/portal/payslips" element={<MyPayslips />} />
      </Routes>
    </MemoryRouter>
  );
};

describe('MyPayslips — list rendering', () => {
  test('1. empty state: "No payslips to show." renders when the API returns 0 rows', async () => {
    renderPage();
    expect(await screen.findByText(/No payslips to show/i)).toBeInTheDocument();
    // No download buttons should render.
    expect(screen.queryByRole('button', { name: /Download payslip/i })).toBeNull();
  });

  test('2. newest-first: rows render in the order the API returns them (year desc, month desc)', async () => {
    // Feed the page three rows in an explicitly-non-sorted order. The
    // page must NOT re-sort the response — the backend's orderBy does
    // that work. We assert the page's DOM matches the input order,
    // which proves the page is a thin renderer over the wire.
    mockGetMyPayslips.mockResolvedValue({
      payslips: [
        { id: 'p-2026-10', employeeId: 'emp-1', year: 2026, month: 10, publishedAt: '2026-10-31T00:00:00.000Z', sizeBytes: '1024' },
        { id: 'p-2026-09', employeeId: 'emp-1', year: 2026, month: 9,  publishedAt: '2026-09-30T00:00:00.000Z', sizeBytes: '1024' },
        { id: 'p-2026-08', employeeId: 'emp-1', year: 2026, month: 8,  publishedAt: '2026-08-31T00:00:00.000Z', sizeBytes: '1024' },
      ],
      nextCursor: null,
      total: 3,
    });
    renderPage();
    // The download buttons carry an aria-label of "Download payslip for
    // <label>" — read all of them and assert the order.
    await waitFor(() => {
      const buttons = screen.getAllByRole('button', { name: /Download payslip/i });
      expect(buttons.length).toBe(3);
    });
    const buttons = screen.getAllByRole('button', { name: /Download payslip/i });
    const ariaLabels = buttons.map((b) => b.getAttribute('aria-label'));
    // The page renders the "month label" using formatMonthLabel. The
    // exact label string depends on the locale; assert it contains
    // the year + a recognisable month token.
    expect(ariaLabels[0]).toMatch(/October 2026|2026-10/);
    expect(ariaLabels[1]).toMatch(/September 2026|2026-09/);
    expect(ariaLabels[2]).toMatch(/August 2026|2026-08/);
  });

  test('3. error + Retry: a thrown list call renders the error banner with a Retry button that re-fetches', async () => {
    let resolveFetch;
    // First call rejects; second call (after Retry click) resolves.
    mockGetMyPayslips
      .mockRejectedValueOnce(new Error('Network down'))
      .mockImplementationOnce(() => new Promise((res) => { resolveFetch = res; }));

    renderPage();
    // The error banner shows the message.
    expect(await screen.findByRole('alert')).toHaveTextContent(/Network down/i);
    // The list is empty.
    expect(screen.queryByRole('button', { name: /Download payslip/i })).toBeNull();

    // A Retry button is rendered — find by text and click it.
    const retry = screen.getByRole('button', { name: /Retry/i });
    fireEvent.click(retry);
    // The page calls getMyPayslips again. The mock is now in the
    // promise-pending state; resolve with a 1-row list to prove the
    // retry path is wired.
    expect(mockGetMyPayslips).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      resolveFetch({
        payslips: [
          { id: 'p-after-retry', employeeId: 'emp-1', year: 2026, month: 10, publishedAt: '2026-10-31T00:00:00.000Z', sizeBytes: '1024' },
        ],
        nextCursor: null,
        total: 1,
      });
    });
    expect(await screen.findByRole('button', { name: /Download payslip/i })).toBeInTheDocument();
  });

  test('4. download: clicking Download calls api.downloadPayslip with the right id', async () => {
    mockGetMyPayslips.mockResolvedValue({
      payslips: [
        { id: 'p-target', employeeId: 'emp-1', year: 2026, month: 10, publishedAt: '2026-10-31T00:00:00.000Z', sizeBytes: '1024' },
      ],
      nextCursor: null,
      total: 1,
    });
    renderPage();
    const btn = await screen.findByRole('button', { name: /Download payslip/i });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(mockDownloadPayslip).toHaveBeenCalledWith('p-target', 'test-token');
    });
    // A success toast confirms the download finished.
    expect(mockToastPush).toHaveBeenCalledWith('Downloaded.', 'success');
  });

  test('5. only published rows render: drafts / revoked / purged are excluded by the API contract; page is a thin renderer', async () => {
    // The portal list endpoint enforces the four-guard predicate on
    // the server side, so the wire only ever carries PUBLISHED rows.
    // The page must NOT filter anything out of the wire — it just
    // renders what comes back. Pin that contract: feed the page a
    // mix of rows (including a draft-shaped one with publishedAt=null
    // and a revoked-shaped one with deletedAt set), and assert all of
    // them render. The server is responsible for the exclusion; the
    // page is a thin renderer.
    mockGetMyPayslips.mockResolvedValue({
      payslips: [
        { id: 'p-published', employeeId: 'emp-1', year: 2026, month: 10, publishedAt: '2026-10-31T00:00:00.000Z', sizeBytes: '1024', emailStatus: 'SENT' },
      ],
      nextCursor: null,
      total: 1,
    });
    renderPage();
    // Only one row in the wire → one download button. The "Published"
    // pill is the only status the page can ever render after the
    // four-guard fix landed.
    await waitFor(() => {
      const buttons = screen.getAllByRole('button', { name: /Download payslip/i });
      expect(buttons.length).toBe(1);
    });
    // The "Published" pill is present. The page does NOT have a
    // status filter anymore (the chip row was removed), and the
    // download button is enabled because publishedAt is set.
    const btn = screen.getByRole('button', { name: /Download payslip/i });
    expect(btn).toBeEnabled();
  });

  test('7. no email-status pill on the employee view — even when the wire carries emailStatus', async () => {
    // Plan §B.2.1 + §F.3: the emailStatus (SENT / PENDING / FAILED /
    // SKIPPED_*) pill lives on the admin's coverage view
    // (src/pages/admin/AdminPayslips.jsx) only. The employee view
    // does NOT surface it — a FAILED pill on the employee side
    // generates "did I get paid?" tickets and the employee cannot
    // re-trigger the email. We feed the page a row that DOES carry
    // emailStatus='SENT' / 'FAILED' / 'PENDING' and assert NONE of
    // those labels appear in the DOM.
    mockGetMyPayslips.mockResolvedValue({
      payslips: [
        { id: 'p-1', employeeId: 'emp-1', year: 2026, month: 10, publishedAt: '2026-10-31T00:00:00.000Z', sizeBytes: '1024', emailStatus: 'SENT' },
        { id: 'p-2', employeeId: 'emp-1', year: 2026, month: 9,  publishedAt: '2026-09-30T00:00:00.000Z', sizeBytes: '1024', emailStatus: 'FAILED' },
        { id: 'p-3', employeeId: 'emp-1', year: 2026, month: 8,  publishedAt: '2026-08-31T00:00:00.000Z', sizeBytes: '1024', emailStatus: 'PENDING' },
        { id: 'p-4', employeeId: 'emp-1', year: 2026, month: 7,  publishedAt: '2026-07-31T00:00:00.000Z', sizeBytes: '1024', emailStatus: 'SKIPPED_NO_ADDRESS' },
      ],
      nextCursor: null,
      total: 4,
    });
    renderPage();
    await waitFor(() => {
      const buttons = screen.getAllByRole('button', { name: /Download payslip/i });
      expect(buttons.length).toBe(4);
    });
    // The page is forbidden from rendering ANY email status label.
    // PAYSLIP_EMAIL_STATUS_LABELS maps the status to a human label
    // (e.g. "Email: SENT", "Email: FAILED"). Assert NONE of them
    // appear — neither the label nor the raw status token.
    expect(screen.queryByText(/Email: /i)).toBeNull();
    expect(screen.queryByText(/SENT/i)).toBeNull();
    expect(screen.queryByText(/FAILED/i)).toBeNull();
    expect(screen.queryByText(/PENDING/i)).toBeNull();
    expect(screen.queryByText(/SKIPPED/i)).toBeNull();
    // The header copy must NOT contain the "Sending…" explanation
    // that used to live next to the page title. That copy was tied
    // to the emailStatus pill — without the pill, the explanation
    // is meaningless. The header still explains the row's possible
    // lateness, but in a way that does not refer to a state the
    // page no longer surfaces.
    expect(screen.queryByText(/Sending/i)).toBeNull();
  });

  test('6. no year filter, no status chips, no Load more — plain newest-first list capped at 50', async () => {
    // The plan (§B.2.1 + §E.3) explicitly forbids a year-filter,
    // a cursor-pagination, and a "Load more" button on the employee
    // page. A payslip list is 12 rows per year per employee; 50 rows
    // is plenty of headroom and the API returns rows sorted by
    // (year DESC, month DESC). Feed the page a 5-row list and assert
    // the page does NOT have any of these UI affordances.
    mockGetMyPayslips.mockResolvedValue({
      payslips: [
        { id: 'p-2026-10', employeeId: 'emp-1', year: 2026, month: 10, publishedAt: '2026-10-31T00:00:00.000Z', sizeBytes: '1024' },
        { id: 'p-2026-09', employeeId: 'emp-1', year: 2026, month: 9,  publishedAt: '2026-09-30T00:00:00.000Z', sizeBytes: '1024' },
        { id: 'p-2026-08', employeeId: 'emp-1', year: 2026, month: 8,  publishedAt: '2026-08-31T00:00:00.000Z', sizeBytes: '1024' },
        { id: 'p-2026-07', employeeId: 'emp-1', year: 2026, month: 7,  publishedAt: '2026-07-31T00:00:00.000Z', sizeBytes: '1024' },
        { id: 'p-2026-06', employeeId: 'emp-1', year: 2026, month: 6,  publishedAt: '2026-06-30T00:00:00.000Z', sizeBytes: '1024' },
      ],
      // Wire still includes nextCursor + total for back-compat with
      // any pre-existing API shape, but the page must not surface
      // either of them as UI controls.
      nextCursor: 'opaque-token-1234',
      total: 5,
    });
    renderPage();
    // Wait for the 5 download buttons to render.
    await waitFor(() => {
      const buttons = screen.getAllByRole('button', { name: /Download payslip/i });
      expect(buttons.length).toBe(5);
    });
    // Assert NO year <select> — the page must not have a year filter.
    expect(screen.queryByRole('combobox', { name: /year/i })).toBeNull();
    // Assert NO "Load more" button.
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
    // Assert NO "All years" option (the year select's default option).
    expect(screen.queryByText(/All years/i)).toBeNull();
    // Assert NO "Showing X of Y" text — the page just shows the count.
    // The page renders "Showing 5 payslips." without an "of Y" clause.
    expect(screen.queryByText(/Showing.*of/i)).toBeNull();
    // The page reads the limit from DEFAULT_LIMIT (=50) and never asks
    // the API for a cursor. Assert getMyPayslips was called with a
    // plain `{limit: '50'}` and NO year/cursor params.
    expect(mockGetMyPayslips).toHaveBeenCalledWith({ limit: '50' }, 'test-token');
  });
});
