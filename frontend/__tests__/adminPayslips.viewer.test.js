/**
 * [Admin payslip viewer] Behavior tests for the in-page PDF viewer
 * for PUBLISHED payslip rows in the admin coverage panel +
 * "All payslips" list.
 *
 * Mirrors `adminPayslips.preview.test.js`'s structure (PR #6
 * shipped the upload-modal preview; this test pins the new
 * PUBLISHED-row viewer). Six tests:
 *
 *   V1. PUBLISHED rows render a "View" button; DRAFT / MISSING /
 *       REVOKED rows do NOT.
 *   V2. Clicking View on a PUBLISHED row opens a modal whose body
 *       contains `<object type="application/pdf" data="blob:...">`
 *       whose `data` attribute is the minted blob URL.
 *   V3. Clicking View calls `api.getAdminPayslipDownload` exactly
 *       once with the row's id and a non-empty token.
 *   V4. The "Open in new tab" link points at the same blob URL with
 *       `target="_blank"`; the "Download" link has the same href
 *       and a `download="Payslip-YYYY-MM.pdf"` attribute.
 *   V5. Closing the modal revokes the blob URL; a second View click
 *       on a different row mints a fresh URL and revokes the first.
 *   V6. Unmounting the page revokes the most recent blob URL as a
 *       safety net.
 *
 * Approach: stub the api helper so `getAdminPayslipDownload` returns
 * a real Blob with a tiny `%PDF-` header. Polyfill
 * `URL.createObjectURL` / `URL.revokeObjectURL` so jsdom's missing
 * implementation doesn't crash the page on mount. Spy
 * `global.fetch` (throws if hit) so a regression that drops the
 * `api.download` indirection in favour of raw `fetch` would surface
 * as a test failure.
 */

const React = require('react');
const { render, screen, fireEvent, act, cleanup, waitFor } = require('@testing-library/react');
const { MemoryRouter } = require('react-router-dom');

jest.mock('../../src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({
    employee: { id: 'admin-1', name: 'Test Admin', email: 'admin@acschennai.com', isAdmin: true },
    accessToken: 'test-admin-token',
    logout: jest.fn(),
  }),
}));

jest.mock('../../src/contexts/ToastContext.jsx', () => ({
  useToast: () => ({ push: jest.fn(), dismiss: jest.fn() }),
}));

// Coverage fixture: 4 rows covering every PUBLISHED / DRAFT / REVOKED
// / MISSING path. The viewer's gate is
//   `c.payslip && c.payslip.published`
// so a row with no payslip (MISSING) and a row with a publishedAt=null
// payslip (DRAFT) and a row with a deletedAt NOT NULL payslip
// (REVOKED) all must NOT render a "View" button. Only the PUBLISHED
// row does.
const COVERAGE = [
  { employeeId: 'emp-published', employeeName: 'Rajesh Kumar', payslip: { id: 'payslip-published', published: true, publishedAt: '2026-10-11T00:00:00.000Z', sizeBytes: 153600, emailStatus: 'SENT' } },
  { employeeId: 'emp-draft',     employeeName: 'Draft User',   payslip: { id: 'payslip-draft',     published: false, publishedAt: null, sizeBytes: 102400, emailStatus: 'PENDING' } },
  { employeeId: 'emp-revoked',   employeeName: 'Old Employee', payslip: { id: 'payslip-revoked',   published: true, publishedAt: '2026-09-01T00:00:00.000Z', sizeBytes: 102400, emailStatus: 'SENT', deletedAt: '2026-10-01T00:00:00.000Z' } },
  { employeeId: 'emp-missing',   employeeName: 'New Hire',     payslip: null },
];

// Stub the api helper. The page calls `getPayslipCoverage`,
// `getAdminPayslips`, and `listAdminEmployees` on mount. The viewer
// calls `getAdminPayslipDownload` on a click.
const mockGetAdminPayslipDownload = jest.fn();
jest.mock('../../src/lib/api.js', () => ({
  api: {
    getPayslipCoverage: jest.fn(async () => ({ rows: [], coverage: [] })),
    getAdminPayslips: jest.fn(async () => ({ payslips: [] })),
    listAdminEmployees: jest.fn(async () => ({ employees: [] })),
    getPayslipSasUrl: jest.fn(),
    confirmPayslipUpload: jest.fn(),
    bindPayslip: jest.fn(),
    publishPayslips: jest.fn(),
    revokePayslip: jest.fn(),
    resendStuckPayslipEmails: jest.fn(),
    resendPayslipEmail: jest.fn(),
    getAdminPayslipDownload: (id, token) => mockGetAdminPayslipDownload(id, token),
  },
}));

beforeAll(() => {
  global.requestAnimationFrame = (cb) => { const id = setTimeout(cb, 0); return id; };
  global.cancelAnimationFrame = (id) => clearTimeout(id);
});

const AdminPayslips = require('../../src/pages/admin/AdminPayslips.jsx').default;

let createCalls;
let revokeCalls;
let fetchSpy;

function installUrlSpies() {
  createCalls = [];
  revokeCalls = [];
  let counter = 0;
  const polyCreate = (blob) => {
    const token = `blob:test-${++counter}`;
    createCalls.push({ token, size: blob && typeof blob.size === 'number' ? blob.size : 0 });
    return token;
  };
  const polyRevoke = (url) => { revokeCalls.push(url); };
  URL.createObjectURL = jest.fn(polyCreate);
  URL.revokeObjectURL = jest.fn(polyRevoke);
}

if (typeof URL.createObjectURL !== 'function') {
  let bootCounter = 0;
  URL.createObjectURL = (blob) => `blob:boot-${++bootCounter}`;
  URL.revokeObjectURL = () => {};
}

function installFetchSpy() {
  fetchSpy = jest.fn(async () => {
    throw new Error('fetch should not be called — all network access should go through the api helper');
  });
  global.fetch = fetchSpy;
}

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

function mount() {
  return render(
    <MemoryRouter>
      <AdminPayslips />
    </MemoryRouter>,
  );
}

// Make coverage return COVERAGE for this test suite. The test file
// mints its own page mount per test, but the api mock is module-level
// — the per-test override below ensures coverage is non-empty.
// `mockResolvedValue` (not Once) because React 18 + the page's
// fetchCoverage useCallback may re-fire the effect more than once
// during a single mount; Once would only cover the first call and
// the re-render would land on the default `coverage: []` mock.
function setCoverageAsPublished() {
  const { api } = require('../../src/lib/api.js');
  api.getPayslipCoverage.mockReset();
  api.getAdminPayslips.mockReset();
  api.listAdminEmployees.mockReset();
  api.getPayslipCoverage.mockResolvedValue({ rows: [], coverage: COVERAGE });
  api.getAdminPayslips.mockResolvedValue({ payslips: [] });
  api.listAdminEmployees.mockResolvedValue({ employees: [] });
}

async function waitForCoverageLoaded() {
  // The page renders coverage after the api.getPayslipCoverage
  // mock resolves. Wait for the PUBLISHED row's "Resend email"
  // button (the existing row-1 element that proves the coverage
  // rendered) before exercising the View button.
  await waitFor(() => {
    expect(screen.queryByText(/Rajesh Kumar/)).toBeTruthy();
  }, { timeout: 3000 });
}

describe('AdminPayslips — in-page PDF viewer (published rows)', () => {
  it('V1. PUBLISHED rows render a "View" button; DRAFT / MISSING / REVOKED rows do NOT', async () => {
    installFetchSpy();
    installUrlSpies();
    try {
      setCoverageAsPublished();
      mount();
      await waitForCoverageLoaded();
      // 1. Rajesh Kumar (PUBLISHED, not revoked) — View button present.
      const publishedViewBtns = screen.getAllByTestId('payslip-view-btn');
      expect(publishedViewBtns.length).toBe(1);
      // 2. The 3 non-View rows: DRAFT, REVOKED (deletedAt-stamped),
      //    MISSING (no payslip). The REVOKED row's name "Old
      //    Employee" still renders (the card itself still shows),
      //    just no View button. The MISSING row "New Hire" has no
      //    View button and no Publish button.
      expect(screen.getByText(/Old Employee/)).toBeTruthy();
      expect(screen.getByText(/New Hire/)).toBeTruthy();
      // The DRAFT row gets a Publish button (not View) — the
      // existing per-row late-publish flow.
      const publishBtns = screen.getAllByRole('button', { name: /^Publish$/i });
      expect(publishBtns.length).toBeGreaterThanOrEqual(1);
    } finally {
      // No restore needed — the spies stay (jsdom has no native
      // impl and removing them breaks the next test).
    }
  });

  it('V2. clicking View opens a modal with an <object type="application/pdf" data="blob:...">', async () => {
    installFetchSpy();
    installUrlSpies();
    // Wire the api download mock to return a real Blob so
    // URL.createObjectURL has a real blob to wrap.
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
    mockGetAdminPayslipDownload.mockResolvedValueOnce({
      blob: new Blob([pdfBytes], { type: 'application/pdf' }),
      filename: 'Payslip-2026-10.pdf',
      contentType: 'application/pdf',
      format: '',
      rowCount: 0,
    });
    try {
      setCoverageAsPublished();
      mount();
      await waitForCoverageLoaded();
      const viewBtn = screen.getByTestId('payslip-view-btn');
      await act(async () => { fireEvent.click(viewBtn); });
      // The modal body is wrapped in a data-testid div inside the
      // Modal component. Wait for the object to appear after the
      // async fetch resolves.
      const modal = await screen.findByTestId('payslip-viewer-modal');
      expect(modal).toBeTruthy();
      const obj = await waitFor(() => {
        const node = modal.querySelector('object[type="application/pdf"]');
        if (!node) throw new Error('object not yet in DOM');
        return node;
      });
      // data is the minted blob: token.
      expect(obj.getAttribute('data')).toMatch(/^blob:test-/);
      // A blob: URL was minted exactly once.
      expect(createCalls).toHaveLength(1);
    } finally {
      // nothing
    }
  });

  it('V3. clicking View calls api.getAdminPayslipDownload exactly once with the row id and a non-empty token', async () => {
    installFetchSpy();
    installUrlSpies();
    mockGetAdminPayslipDownload.mockResolvedValueOnce({
      blob: new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: 'application/pdf' }),
      filename: 'Payslip-2026-10.pdf',
      contentType: 'application/pdf',
    });
    try {
      setCoverageAsPublished();
      mount();
      await waitForCoverageLoaded();
      const viewBtn = screen.getByTestId('payslip-view-btn');
      await act(async () => { fireEvent.click(viewBtn); });
      await screen.findByTestId('payslip-viewer-modal');
      expect(mockGetAdminPayslipDownload).toHaveBeenCalledTimes(1);
      const [id, token] = mockGetAdminPayslipDownload.mock.calls[0];
      expect(id).toBe('payslip-published');
      expect(token).toBe('test-admin-token');
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
    mockGetAdminPayslipDownload.mockResolvedValueOnce({
      blob: new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: 'application/pdf' }),
      filename: 'Payslip-2026-10.pdf',
      contentType: 'application/pdf',
    });
    try {
      setCoverageAsPublished();
      mount();
      await waitForCoverageLoaded();
      const viewBtn = screen.getByTestId('payslip-view-btn');
      await act(async () => { fireEvent.click(viewBtn); });
      await screen.findByTestId('payslip-viewer-modal');
      const blobUrl = createCalls[0].token;
      const openNewTab = screen.getByTestId('payslip-viewer-open-newtab-link');
      expect(openNewTab.getAttribute('href')).toBe(blobUrl);
      expect(openNewTab.getAttribute('target')).toBe('_blank');
      const downloadLink = screen.getByTestId('payslip-viewer-download-link');
      expect(downloadLink.getAttribute('href')).toBe(blobUrl);
      expect(downloadLink.getAttribute('download')).toBe('Payslip-2026-10.pdf');
    } finally {
      // nothing
    }
  });

  it('V5. closing the modal revokes the blob URL; a second View mints a fresh URL and revokes the first', async () => {
    installFetchSpy();
    installUrlSpies();
    mockGetAdminPayslipDownload
      .mockResolvedValueOnce({
        blob: new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: 'application/pdf' }),
        filename: 'Payslip-2026-10.pdf',
        contentType: 'application/pdf',
      })
      .mockResolvedValueOnce({
        blob: new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], { type: 'application/pdf' }),
        filename: 'Payslip-2026-10.pdf',
        contentType: 'application/pdf',
      });
    try {
      setCoverageAsPublished();
      mount();
      await waitForCoverageLoaded();
      const viewBtn = screen.getByTestId('payslip-view-btn');
      // First open.
      await act(async () => { fireEvent.click(viewBtn); });
      await screen.findByTestId('payslip-viewer-modal');
      const firstBlob = createCalls[0].token;
      expect(firstBlob).toMatch(/^blob:test-/);
      // Close — Close button.
      const closeBtn = screen.getByRole('button', { name: /^Close$/i });
      await act(async () => { fireEvent.click(closeBtn); });
      await waitFor(() => {
        if (screen.queryByTestId('payslip-viewer-modal')) {
          throw new Error('modal still in DOM');
        }
      });
      expect(revokeCalls).toContain(firstBlob);
      // Second open — fresh URL, the first is NOT revoked a second
      // time (we already revoked it on close).
      const secondViewBtn = screen.getByTestId('payslip-view-btn');
      await act(async () => { fireEvent.click(secondViewBtn); });
      await screen.findByTestId('payslip-viewer-modal');
      const secondBlob = createCalls[1].token;
      expect(secondBlob).toMatch(/^blob:test-/);
      expect(secondBlob).not.toBe(firstBlob);
      // The first URL's revoke is in the log; the second is not yet.
      const firstRevokeCount = revokeCalls.filter((u) => u === firstBlob).length;
      expect(firstRevokeCount).toBe(1);
      expect(revokeCalls).not.toContain(secondBlob);
    } finally {
      // nothing
    }
  });

  it('V6. unmounting the page revokes the most recent blob URL as a safety net', async () => {
    installFetchSpy();
    installUrlSpies();
    mockGetAdminPayslipDownload.mockResolvedValueOnce({
      blob: new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: 'application/pdf' }),
      filename: 'Payslip-2026-10.pdf',
      contentType: 'application/pdf',
    });
    try {
      setCoverageAsPublished();
      const { unmount } = mount();
      await waitForCoverageLoaded();
      const viewBtn = screen.getByTestId('payslip-view-btn');
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
