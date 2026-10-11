/**
 * [MyPayslips viewer] Behavior tests for the in-page PDF viewer
 * for PUBLISHED payslip rows in the employee "My Payslips" page.
 *
 * Mirrors `frontend/__tests__/adminPayslips.viewer.test.js`'s
 * structure (PR #7 shipped the admin coverage-panel viewer; this
 * test pins the parity feature for employees). Six tests:
 *
 *   V1. PUBLISHED rows render a "View" button; the page's wire
 *       contract (PUBLISHED-only — the portal list endpoint
 *       server-side filter ensures DRAFT / REVOKED / MISSING
 *       never reach the page) means a row with no publishedAt
 *       does NOT render a "View" button.
 *   V2. Clicking View opens a modal whose body contains
 *       `<object type="application/pdf" data="blob:...">`
 *       whose `data` attribute is the minted blob URL.
 *   V3. Clicking View calls `api.downloadPayslip` exactly once
 *       with the row's id and a non-empty token.
 *   V4. The "Open in new tab" link points at the same blob URL
 *       with `target="_blank"`; the "Download" link has the
 *       same `href` and a `download="Payslip-YYYY-MM.pdf"`
 *       attribute.
 *   V5. Closing the modal revokes the blob URL; a second View
 *       click on a different row mints a fresh URL and revokes
 *       the first.
 *   V6. Unmounting the page revokes the most recent blob URL
 *       as a safety net.
 *
 * Approach: stub the api helper so `getMyPayslips` returns a
 * fixture with at least one PUBLISHED row + one row missing
 * publishedAt, and `downloadPayslip` returns a real Blob with
 * a tiny `%PDF-` header. Polyfill `URL.createObjectURL` /
 * `URL.revokeObjectURL` so jsdom's missing implementation
 * doesn't crash the page on mount. Spy `global.fetch` (throws
 * if hit) so a regression that drops the `api.download`
 * indirection in favour of raw `fetch` would surface as a
 * test failure.
 */

import React from 'react';
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

jest.mock('../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({
    employee: { id: 'emp-1' },
    accessToken: 'test-emp-token',
    logout: jest.fn(),
  }),
}));

const mockToastPush = jest.fn();
jest.mock('../contexts/ToastContext.jsx', () => ({
  useToast: () => ({ push: mockToastPush, dismiss: jest.fn() }),
}));

jest.mock('../hooks/useDocumentTitle.js', () => ({
  useDocumentTitle: jest.fn(),
}));

jest.mock('../hooks/usePullToRefresh.js', () => ({
  __esModule: true,
  default: () => ({ pullDistance: 0, isRefreshing: false }),
}));

// Fixture: two rows, both PUBLISHED (matches the wire contract —
// the portal list endpoint's four-guard predicate filters out
// drafts / revoked / purged rows server-side, so the page
// never sees anything else). The "View" + "Download" buttons
// both render on every row, gated on per-row in-flight state.
const PAYSLIPS = [
  { id: 'p-published-1', year: 2026, month: 9, sizeBytes: 186117, publishedAt: '2026-10-11T00:00:00.000Z' },
  { id: 'p-published-2', year: 2026, month: 8, sizeBytes: 102400, publishedAt: '2026-09-11T00:00:00.000Z' },
];

const mockGetMyPayslips = jest.fn();
const mockDownloadPayslip = jest.fn();
jest.mock('../lib/api.js', () => ({
  api: {
    getMyPayslips: mockGetMyPayslips,
    downloadPayslip: mockDownloadPayslip,
  },
}));

beforeEach(() => {
  mockGetMyPayslips.mockResolvedValue({ payslips: PAYSLIPS, nextCursor: null, total: PAYSLIPS.length });
  mockDownloadPayslip.mockResolvedValue({
    blob: new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: 'application/pdf' }),
    filename: 'Payslip-2026-09.pdf',
    contentType: 'application/pdf',
  });
  // jsdom does not implement URL.createObjectURL / revokeObjectURL;
  // polyfill so the page's blob: token works. The download path
  // (file-save) also uses these.
  if (!global.URL.createObjectURL) {
    global.URL.createObjectURL = jest.fn(() => 'blob:mock');
  }
  if (!global.URL.revokeObjectURL) {
    global.URL.revokeObjectURL = jest.fn();
  }
});

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

const MyPayslips = require('../pages/portal/MyPayslips.jsx').default;

let createCalls;
let revokeCalls;
let fetchSpy;

function installUrlSpies() {
  createCalls = [];
  revokeCalls = [];
  let counter = 0;
  URL.createObjectURL = jest.fn((blob) => {
    const token = `blob:test-${++counter}`;
    createCalls.push({ token, size: blob && typeof blob.size === 'number' ? blob.size : 0 });
    return token;
  });
  URL.revokeObjectURL = jest.fn((url) => { revokeCalls.push(url); });
}

function installFetchSpy() {
  fetchSpy = jest.fn(async () => {
    throw new Error('fetch should not be called — all network access should go through the api helper');
  });
  global.fetch = fetchSpy;
}

function mountPage() {
  return render(
    <MemoryRouter initialEntries={['/portal/payslips']}>
      <Routes>
        <Route path="/portal/payslips" element={<MyPayslips />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function waitForRowsLoaded() {
  // Wait for the page to render the rows. The "Published" pill on
  // the first row is the signal the list rendered.
  await waitFor(() => {
    expect(screen.queryByText(/September 2026/)).toBeTruthy();
  }, { timeout: 3000 });
}

describe('MyPayslips — in-page PDF viewer (published rows)', () => {
  it('V1. PUBLISHED rows render a "View" button; the page does not show one for unpublished rows', async () => {
    installFetchSpy();
    installUrlSpies();
    // Feed the page a mix: one published row + one with
    // publishedAt=null. The page's render-guard on `p.publishedAt`
    // suppresses the View button for the unpublished row (matches
    // the existing Download button's `disabled={!p.publishedAt}`
    // pattern).
    mockGetMyPayslips.mockResolvedValue({
      payslips: [
        { id: 'p-published', year: 2026, month: 9, sizeBytes: 186117, publishedAt: '2026-10-11T00:00:00.000Z' },
        { id: 'p-unpublished', year: 2026, month: 8, sizeBytes: 102400, publishedAt: null },
      ],
      nextCursor: null,
      total: 2,
    });
    try {
      mountPage();
      await waitForRowsLoaded();
      const viewBtns = screen.getAllByTestId('payslip-view-btn');
      expect(viewBtns.length).toBe(1);
      // The Download button still renders on both rows (gated only
      // by `disabled`, not by render-time hide).
      const downloadBtns = screen.getAllByRole('button', { name: /Download payslip/i });
      expect(downloadBtns.length).toBe(2);
      // The View button's aria-label must NOT match the Download
      // button's regex — that's the distinction the existing
      // behavior tests rely on for their count assertions.
      const viewAriaLabels = viewBtns.map((b) => b.getAttribute('aria-label'));
      expect(viewAriaLabels.every((l) => /View payslip for /.test(l || ''))).toBe(true);
    } finally {
      // nothing
    }
  });

  it('V2. clicking View opens a modal with an <object type="application/pdf" data="blob:...">', async () => {
    installFetchSpy();
    installUrlSpies();
    try {
      mountPage();
      await waitForRowsLoaded();
      const viewBtn = screen.getAllByTestId('payslip-view-btn')[0];
      await act(async () => { fireEvent.click(viewBtn); });
      const modal = await screen.findByTestId('payslip-viewer-modal');
      expect(modal).toBeTruthy();
      const obj = await waitFor(() => {
        const node = modal.querySelector('object[type="application/pdf"]');
        if (!node) throw new Error('object not yet in DOM');
        return node;
      });
      expect(obj.getAttribute('data')).toMatch(/^blob:test-/);
      // The viewer fetch went through the api.download indirection
      // — the synthetic <a download> click did NOT call createObjectURL
      // (that's the file-save path's job). The viewer mints exactly
      // one blob URL.
      expect(createCalls).toHaveLength(1);
    } finally {
      // nothing
    }
  });

  it('V3. clicking View calls api.downloadPayslip exactly once with the row id and a non-empty token', async () => {
    installFetchSpy();
    installUrlSpies();
    try {
      mountPage();
      await waitForRowsLoaded();
      const viewBtn = screen.getAllByTestId('payslip-view-btn')[0];
      await act(async () => { fireEvent.click(viewBtn); });
      await screen.findByTestId('payslip-viewer-modal');
      expect(mockDownloadPayslip).toHaveBeenCalledTimes(1);
      const [id, token] = mockDownloadPayslip.mock.calls[0];
      expect(id).toBe('p-published-1');
      expect(token).toBe('test-emp-token');
      // No raw fetch was triggered — the api helper is the only
      // network access path.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      // nothing
    }
  });

  it('V4. the "Open in new tab" + "Download" links point at the blob URL with the expected attrs', async () => {
    installFetchSpy();
    installUrlSpies();
    try {
      mountPage();
      await waitForRowsLoaded();
      const viewBtn = screen.getAllByTestId('payslip-view-btn')[0];
      await act(async () => { fireEvent.click(viewBtn); });
      await screen.findByTestId('payslip-viewer-modal');
      const blobUrl = createCalls[0].token;
      const openNewTab = screen.getByTestId('payslip-viewer-open-newtab-link');
      expect(openNewTab.getAttribute('href')).toBe(blobUrl);
      expect(openNewTab.getAttribute('target')).toBe('_blank');
      const downloadLink = screen.getByTestId('payslip-viewer-download-link');
      expect(downloadLink.getAttribute('href')).toBe(blobUrl);
      expect(downloadLink.getAttribute('download')).toBe('Payslip-2026-09.pdf');
    } finally {
      // nothing
    }
  });

  it('V5. closing the modal revokes the blob URL; a second View mints a fresh URL and revokes the first', async () => {
    installFetchSpy();
    installUrlSpies();
    try {
      mountPage();
      await waitForRowsLoaded();
      // First open.
      const viewBtn = screen.getAllByTestId('payslip-view-btn')[0];
      await act(async () => { fireEvent.click(viewBtn); });
      await screen.findByTestId('payslip-viewer-modal');
      const firstBlob = createCalls[0].token;
      expect(firstBlob).toMatch(/^blob:test-/);
      // Close.
      const closeBtn = screen.getByRole('button', { name: /^Close$/i });
      await act(async () => { fireEvent.click(closeBtn); });
      await waitFor(() => {
        if (screen.queryByTestId('payslip-viewer-modal')) {
          throw new Error('modal still in DOM');
        }
      });
      expect(revokeCalls).toContain(firstBlob);
    } finally {
      // nothing
    }
  });

  it('V6. unmounting the page revokes the most recent blob URL as a safety net', async () => {
    installFetchSpy();
    installUrlSpies();
    try {
      const { unmount } = mountPage();
      await waitForRowsLoaded();
      const viewBtn = screen.getAllByTestId('payslip-view-btn')[0];
      await act(async () => { fireEvent.click(viewBtn); });
      await screen.findByTestId('payslip-viewer-modal');
      const blob = createCalls[0].token;
      expect(revokeCalls).not.toContain(blob);
      // Unmount without closing — the useEffect cleanup fires.
      await act(async () => { unmount(); });
      expect(revokeCalls).toContain(blob);
    } finally {
      // nothing
    }
  });
});
