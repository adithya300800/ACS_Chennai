/**
 * [fixup / SIZE_DRIFT + PDF preview] Behavior tests for the in-page
 * PDF preview in AdminPayslips' upload modal.
 *
 * Pins four behaviors the new modal must satisfy (per the user's
 * one-PR spec, item 5):
 *
 *   P1. Preview appears after the admin selects a PDF.
 *   P2. Selecting the PDF does NOT make a network call — the bytes
 *       are still on the admin's machine, served from a `blob:`
 *       object URL.
 *   P3. The object URL is revoked when the file changes AND when the
 *       component unmounts (no `blob:` leaks past the modal's
 *       lifetime).
 *   P4. A non-PDF file (e.g. an image) produces NO preview — the
 *       existing validation message stays visible. Non-PDFs never
 *       reach the `URL.createObjectURL` branch.
 *
 * We mock the heavy dependencies (AuthContext, ToastContext, the
 * `api` helper) and intercept `URL.createObjectURL` /
 * `URL.revokeObjectURL` so the assertions can read the call log
 * without holding onto a real blob. The `fetch` global is also
 * spied on so the "no network call on select" assertion is
 * authoritative — a real fetch attempt would fail loudly if a
 * regression introduced one.
 */

const React = require('react');
const { render, screen, fireEvent, act, cleanup, waitFor } = require('@testing-library/react');
const { MemoryRouter } = require('react-router-dom');

// Stub AuthContext so the page mounts as an admin without going
// through the real provider tree (and without the bootstrap
// fetch the real provider would issue on mount).
jest.mock('../../src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({
    employee: { id: 'admin-1', name: 'Test Admin', email: 'admin@acschennai.com', isAdmin: true },
    accessToken: 'test-token',
    logout: jest.fn(),
  }),
}));

// Stub the toast hook — the modal never pushes a toast on
// select-file, so we only need a no-op shape here.
jest.mock('../../src/contexts/ToastContext.jsx', () => ({
  useToast: () => ({ push: jest.fn(), dismiss: jest.fn() }),
}));

// Stub the api helper so the page's mount-time fetches (coverage,
// list, employees) resolve with empty data. None of those touches
// should fire on a `select file` action, so the `fetch` spy below
// is the authoritative guard against accidental network calls.
jest.mock('../../src/lib/api.js', () => ({
  api: {
    getPayslipCoverage: jest.fn(async () => ({ rows: [], coverage: [] })),
    getAdminPayslips: jest.fn(async () => ({ payslips: [] })),
    listAdminEmployees: jest.fn(async () => ({
      employees: [
        { id: 'emp-1', name: 'Ada Lovelace', email: 'ada@example.com' },
        { id: 'emp-2', name: 'Grace Hopper', email: 'grace@example.com' },
      ],
    })),
    getPayslipSasUrl: jest.fn(),
    confirmPayslipUpload: jest.fn(),
    bindPayslip: jest.fn(),
    publishPayslips: jest.fn(),
    revokePayslip: jest.fn(),
    resendStuckPayslipEmails: jest.fn(),
    resendPayslipEmail: jest.fn(),
  },
}));

// jsdom does not honor requestAnimationFrame during synchronous
// test code. Modal uses it for initial-focus scheduling.
beforeAll(() => {
  global.requestAnimationFrame = (cb) => {
    const id = setTimeout(cb, 0);
    return id;
  };
  global.cancelAnimationFrame = (id) => clearTimeout(id);
});

const AdminPayslips = require('../../src/pages/admin/AdminPayslips.jsx').default;

// Per-test bookkeeping for the URL.createObjectURL / revokeObjectURL
// spies. jsdom does NOT implement these by default, so the page
// would crash on mount if the production code calls them. We
// install a tiny polyfill that produces unique `blob:test-N`
// tokens and tracks every call, then swap the jest.fn in for the
// assertions.
let createCalls;
let revokeCalls;
let fetchSpy;

function installUrlSpies() {
  createCalls = [];
  revokeCalls = [];
  // Polyfill first so AdminPayslips can call URL.createObjectURL
  // on mount. Then wrap with jest.fn so we can read the call log.
  let counter = 0;
  const polyCreate = (blob) => {
    const token = `blob:test-${++counter}`;
    createCalls.push({ token, size: blob && typeof blob.size === 'number' ? blob.size : 0 });
    return token;
  };
  const polyRevoke = (url) => { revokeCalls.push(url); };
  URL.createObjectURL = jest.fn(polyCreate);
  URL.revokeObjectURL = jest.fn(polyRevoke);
  return () => {
    // Clean up — leave the polyfill in place (jsdom has no
    // native impl, so removing it would break the next suite
    // that imports URL). The jest.fn wrappers stay; their
    // .mock.calls is reset by `createCalls = []` at the top of
    // each test.
  };
}

// Install the polyfill at module load so the AdminPayslips module
// can resolve URL.createObjectURL synchronously when the modal
// mounts. The per-test installUrlSpies() above wraps these with
// jest.fn for assertion-friendly call logs.
if (typeof URL.createObjectURL !== 'function') {
  let bootCounter = 0;
  URL.createObjectURL = (blob) => `blob:boot-${++bootCounter}`;
  URL.revokeObjectURL = () => {};
}

function installFetchSpy() {
  // Use a fake fetch that throws if anything tries to use it —
  // selecting a file must NOT trigger a network call. The only
  // allowed calls (page mount: list employees, coverage, list
  // payslips) go through the api helper, which is mocked above,
  // so `global.fetch` is never hit in this test.
  fetchSpy = jest.fn(async () => {
    throw new Error('fetch should not be called on file-select');
  });
  global.fetch = fetchSpy;
}

afterEach(() => {
  cleanup();
});

function mount() {
  return render(
    <MemoryRouter>
      <AdminPayslips />
    </MemoryRouter>,
  );
}

async function openUploadModal() {
  // The "+ Upload payslip" button on the page header opens the
  // modal. The button starts disabled while the employees
  // directory is loading; wait until it's enabled before
  // clicking. The mocked `listAdminEmployees` resolves in a
  // microtask, so a single `waitFor` tick is plenty.
  const trigger = await screen.findByRole('button', { name: /\+ Upload payslip/i });
  await waitFor(() => expect(trigger).not.toBeDisabled());
  fireEvent.click(trigger);
}

async function waitForModalOpen() {
  // The modal title is "Upload payslip" — wait for it to appear
  // before exercising the file input. The page's employees fetch
  // is mocked to resolve immediately, so the modal opens on click.
  await screen.findByRole('heading', { name: /^Upload payslip$/i, level: 2 });
}

function makePdfFile(name = 'payslip.pdf', sizeBytes = 4096) {
  // jsdom's File constructor accepts a parts array — we pad with
  // nulls to simulate a real PDF-sized payload. type is the magic
  // string the admin browser will read from the OS file picker.
  const blob = new Blob([Buffer.alloc(sizeBytes, 0x20)], { type: 'application/pdf' });
  return new File([blob], name, { type: 'application/pdf' });
}

function makeNonPdfFile(name = 'photo.png', sizeBytes = 4096, type = 'image/png') {
  const blob = new Blob([Buffer.alloc(sizeBytes, 0x20)], { type });
  return new File([blob], name, { type });
}

function getFileInput() {
  return document.querySelector('input[type="file"]');
}

function selectFile(file) {
  const input = getFileInput();
  // React reads files off the input via input.files. jsdom's
  // DataTransfer mock is incomplete, so we set the property
  // directly. The component reads `e.target.files[0]` on change.
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

describe('AdminPayslips — in-page PDF preview', () => {
  it('P1. selecting a PDF renders the in-page preview above the Upload button', async () => {
    installFetchSpy();
    const restore = installUrlSpies();
    try {
      mount();
      await openUploadModal();
      await waitForModalOpen();
      // The modal is open; pick a PDF and the preview pane appears.
      const file = makePdfFile('October.pdf', 153600);
      await act(async () => { selectFile(file); });
      const preview = await screen.findByTestId('payslip-preview');
      expect(preview).toBeTruthy();
      // The preview surface is an <object data="..." type="application/pdf">.
      const obj = preview.querySelector('object[type="application/pdf"]');
      expect(obj).toBeTruthy();
      // The data attribute points at the minted blob: token.
      expect(obj.getAttribute('data')).toMatch(/^blob:test-/);
      // The recipient + month + filename strip is visible.
      expect(preview.textContent).toMatch(/October\.pdf/);
      // The "Open in new tab" fallback is present.
      const fallback = screen.getByTestId('payslip-preview-open-newtab');
      expect(fallback).toBeTruthy();
      expect(fallback.getAttribute('href')).toMatch(/^blob:test-/);
      expect(fallback.getAttribute('target')).toBe('_blank');
    } finally {
      restore();
    }
  });

  it('P2. selecting a PDF does NOT make a network call', async () => {
    installFetchSpy();
    const restore = installUrlSpies();
    try {
      mount();
      await openUploadModal();
      await waitForModalOpen();
      const file = makePdfFile();
      const fetchCountBefore = fetchSpy.mock.calls.length;
      await act(async () => { selectFile(file); });
      // findByTestId awaits the preview, but we still need the
      // assertion inside `act` so React's microtask queue drains
      // before we count fetch calls.
      await screen.findByTestId('payslip-preview');
      expect(fetchSpy.mock.calls.length).toBe(fetchCountBefore);
    } finally {
      restore();
    }
  });

  it('P3. object URL is revoked when the file changes AND when the component unmounts', async () => {
    installFetchSpy();
    const restore = installUrlSpies();
    try {
      const { unmount } = mount();
      await openUploadModal();
      await waitForModalOpen();
      // First file → first object URL.
      await act(async () => { selectFile(makePdfFile('first.pdf', 100)); });
      const first = createCalls[0] && createCalls[0].token;
      expect(first).toMatch(/^blob:test-/);
      expect(revokeCalls).not.toContain(first);
      // Second file → second object URL, first revoked.
      await act(async () => { selectFile(makePdfFile('second.pdf', 200)); });
      const second = createCalls[1] && createCalls[1].token;
      expect(second).toMatch(/^blob:test-/);
      expect(second).not.toBe(first);
      expect(revokeCalls).toContain(first);
      expect(revokeCalls).not.toContain(second);
      // Unmount → second revoked too. The component-level
      // useEffect cleanup revokes whatever is still in
      // previewUrlRef.
      await act(async () => { unmount(); });
      expect(revokeCalls).toContain(second);
    } finally {
      restore();
    }
  });

  it('P4. selecting a non-PDF renders NO preview and surfaces the validation message', async () => {
    installFetchSpy();
    const restore = installUrlSpies();
    try {
      mount();
      await openUploadModal();
      await waitForModalOpen();
      const file = makeNonPdfFile('photo.png', 4096, 'image/png');
      await act(async () => { selectFile(file); });
      // Validation message contains "not supported" — this is the
      // signal that the validator rejected the file BEFORE the
      // preview branch ran.
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(/not supported/i);
      // No preview pane.
      expect(screen.queryByTestId('payslip-preview')).toBeNull();
      // No blob: URL was minted for the non-PDF.
      expect(createCalls).toHaveLength(0);
      expect(revokeCalls).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('P5. opening the upload modal a second time starts with a clean preview state', async () => {
    installFetchSpy();
    const restore = installUrlSpies();
    try {
      mount();
      await openUploadModal();
      await waitForModalOpen();
      await act(async () => { selectFile(makePdfFile('one.pdf', 100)); });
      const first = createCalls[0] && createCalls[0].token;
      expect(screen.queryByTestId('payslip-preview')).not.toBeNull();
      // Close the modal — the first URL is revoked.
      const cancelBtn = screen.getByRole('button', { name: /^Cancel$/i });
      await act(async () => { fireEvent.click(cancelBtn); });
      expect(revokeCalls).toContain(first);
      // Reopen and confirm a fresh open has no preview, and a new
      // file mints a NEW object URL (the old one is gone from
      // memory, not just hidden).
      await openUploadModal();
      await waitForModalOpen();
      expect(screen.queryByTestId('payslip-preview')).toBeNull();
      await act(async () => { selectFile(makePdfFile('two.pdf', 200)); });
      const second = createCalls[1] && createCalls[1].token;
      expect(second).toBeTruthy();
      expect(second).not.toBe(first);
    } finally {
      restore();
    }
  });
});
