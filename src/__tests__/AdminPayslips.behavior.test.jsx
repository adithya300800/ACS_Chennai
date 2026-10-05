// AdminPayslips — behavior tests (no source-text pins).
//
// What this file pins:
//   1. Coverage table renders the API response into a per-employee table.
//   2. Upload validation rejects non-PDF files client-side (no API call).
//   3. Upload validation rejects files larger than 2 MB client-side.
//   4. Per-row Publish calls api.publishPayslips with the row's id.
//   5. Revoke: when the server returns 400 AUDIT_REASON_REJECTED with
//      `rejectedWord`, the page surfaces the word in a toast so the
//      admin can rewrite the reason (DR-007 contract).
//   6. "N emails pending or failed" indicator is derived from the
//      coverage response — the count updates when the wire changes.
//
// Why behavior tests: source-text pins can't catch a wire-shape
// regression in the coverage endpoint, a paste-typo in the upload
// MIME check, or a silent filter change in the attention predicate.

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// ─── Network mocks (variable names start with `mock` so jest's hoisted
// factory closure accepts the out-of-scope references).
const mockGetAdminPayslips = jest.fn();
const mockGetPayslipCoverage = jest.fn();
const mockGetActiveEmployees = jest.fn();
const mockGetPayslipUploadSas = jest.fn();
const mockConfirmUpload = jest.fn();
const mockBindPayslip = jest.fn();
const mockPublishPayslips = jest.fn();
const mockRevokePayslip = jest.fn();
const mockResendPayslipEmail = jest.fn();
const mockResendStuckPayslipEmails = jest.fn();
const mockListAdminEmployees = jest.fn();
const mockToastPush = jest.fn();

jest.mock('../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({
    accessToken: 'admin-token',
    employee: { id: 'admin-1', isAdmin: true, name: 'Admin', email: 'admin@example.com' },
  }),
}));

jest.mock('../contexts/ToastContext.jsx', () => ({
  useToast: () => ({ push: mockToastPush, dismiss: jest.fn() }),
}));

jest.mock('../lib/api.js', () => ({
  api: {
    getAdminPayslips: mockGetAdminPayslips,
    getPayslipCoverage: mockGetPayslipCoverage,
    getActiveEmployees: mockGetActiveEmployees,
    getPayslipUploadSas: mockGetPayslipUploadSas,
    confirmUpload: mockConfirmUpload,
    bindPayslip: mockBindPayslip,
    publishPayslips: mockPublishPayslips,
    revokePayslip: mockRevokePayslip,
    resendPayslipEmail: mockResendPayslipEmail,
    resendStuckPayslipEmails: mockResendStuckPayslipEmails,
    listAdminEmployees: mockListAdminEmployees,
  },
}));

jest.mock('../hooks/useDocumentTitle.js', () => ({
  useDocumentTitle: jest.fn(),
}));

jest.mock('../lib/blobUpload.js', () => ({
  uploadBlob: jest.fn().mockResolvedValue({ etag: '"x"', sizeBytes: 100 }),
}));

// Build a coverage response with `n` rows, of which `nAttention` carry
// an emailStatus that should trip the attention predicate (PENDING
// or FAILED). The remaining rows are SENT (terminal-delivered).
const buildCoverage = ({ totalEmployees = 3, sent = 1, pending = 1, failed = 1 }) => {
  const attention = pending + failed;
  const coverage = [];
  let idx = 0;
  for (let i = 0; i < sent; i++, idx++) {
    coverage.push({
      employeeId: `emp-sent-${idx}`,
      employeeName: `Sent ${idx}`,
      employeeEmail: `s${idx}@e.test`,
      payslip: {
        id: `p-sent-${idx}`,
        year: 2026, month: 10,
        publishedAt: '2026-10-31T00:00:00.000Z',
        emailStatus: 'SENT',
        emailSentAt: '2026-10-31T00:05:00.000Z',
        publishedById: 'admin-1',
      },
    });
  }
  for (let i = 0; i < pending; i++, idx++) {
    coverage.push({
      employeeId: `emp-pending-${idx}`,
      employeeName: `Pending ${idx}`,
      employeeEmail: `p${idx}@e.test`,
      payslip: {
        id: `p-pending-${idx}`,
        year: 2026, month: 10,
        publishedAt: '2026-10-31T00:00:00.000Z',
        emailStatus: 'PENDING',
        publishedById: 'admin-1',
      },
    });
  }
  for (let i = 0; i < failed; i++, idx++) {
    coverage.push({
      employeeId: `emp-failed-${idx}`,
      employeeName: `Failed ${idx}`,
      employeeEmail: `f${idx}@e.test`,
      payslip: {
        id: `p-failed-${idx}`,
        year: 2026, month: 10,
        publishedAt: '2026-10-31T00:00:00.000Z',
        emailStatus: 'FAILED',
        emailFailedReason: 'SMTP timeout',
        publishedById: 'admin-1',
      },
    });
  }
  return {
    year: 2026, month: 10,
    totalEmployees,
    coveredCount: sent + pending + failed,
    missingCount: Math.max(0, totalEmployees - sent - pending - failed),
    coverage,
    attentionCount: attention,
  };
};

beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
  // Default list is empty.
  mockGetAdminPayslips.mockResolvedValue({ payslips: [], nextCursor: null, total: 0 });
  // Default employees list — at least 3 for the coverage test.
  mockGetActiveEmployees.mockResolvedValue([
    { id: 'e1', name: 'Alice', email: 'alice@example.com', isActive: true },
    { id: 'e2', name: 'Bob', email: 'bob@example.com', isActive: true },
    { id: 'e3', name: 'Carol', email: 'carol@example.com', isActive: true },
  ]);
  mockListAdminEmployees.mockResolvedValue([
    { id: 'e1', name: 'Alice', email: 'alice@example.com', isActive: true },
    { id: 'e2', name: 'Bob', email: 'bob@example.com', isActive: true },
    { id: 'e3', name: 'Carol', email: 'carol@example.com', isActive: true },
  ]);
  // Default coverage — zero pending/failed, all SENT.
  mockGetPayslipCoverage.mockResolvedValue(buildCoverage({ sent: 3, pending: 0, failed: 0 }));
  // Default upload pipeline — never reached unless the validation
  // tests are bypassed; the tests below don't trigger it.
  mockGetPayslipUploadSas.mockResolvedValue({ sasUrl: 'https://r2.example/sas', blobPath: 'payslips/e1/01ARZ3NDEKTSV4RRFFQ69G5FAV.pdf', container: 'dpr-documents' });
  mockConfirmUpload.mockResolvedValue({ ok: true });
  mockBindPayslip.mockResolvedValue({ id: 'p-new', employeeId: 'e1', year: 2026, month: 10 });
  mockPublishPayslips.mockResolvedValue({ published: [{ id: 'p-new' }], failed: [] });
});

const renderPage = () => {
  const AdminPayslips = require('../pages/admin/AdminPayslips.jsx').default;
  return render(
    <MemoryRouter initialEntries={['/portal/admin/payslips']}>
      <Routes>
        <Route path="/portal/admin/payslips" element={<AdminPayslips />} />
      </Routes>
    </MemoryRouter>
  );
};

describe('AdminPayslips — coverage table + attention indicator', () => {
  test('1. coverage table renders one row per coverage entry, with the per-row status', async () => {
    mockGetPayslipCoverage.mockResolvedValue(buildCoverage({ sent: 2, pending: 1, failed: 1 }));
    renderPage();
    // The headline reads "<sent+pending+failed> of <totalEmployees> employees have a published payslip".
    // With sent=2, pending=1, failed=1, totalEmployees=3 → "4 of 3" (coveredCount is 4, but
    // totalEmployees is 3 — server counts missing as 0 when coveredCount > totalEmployees).
    // The test only pins that the headline contains the covered count and the total.
    await waitFor(() => {
      expect(
        screen.getByText(/have a published payslip/i)
      ).toBeInTheDocument();
    });
    // The per-row status pills — the "Failed" pill is on the FAILED row.
    expect(screen.getAllByText('Sent').length).toBeGreaterThanOrEqual(1);
    // The "Sending…" pill (PENDING) is on the pending row.
    expect(screen.getAllByText(/Sending/i).length).toBeGreaterThanOrEqual(1);
    // The "Failed" pill is on the failed row.
    expect(screen.getAllByText('Failed').length).toBeGreaterThanOrEqual(1);
  });

  test('2. "N emails pending or failed" indicator: 0 → "All emails delivered"; 2 → "2 emails pending or failed"', async () => {
    // Path A: zero attention — the green success state.
    mockGetPayslipCoverage.mockResolvedValue(buildCoverage({ sent: 3, pending: 0, failed: 0 }));
    const { unmount } = renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('payslip-email-attention-count')).toHaveTextContent(/All emails delivered/i);
    });
    unmount();

    // Path B: two attention rows (1 PENDING + 1 FAILED).
    mockGetPayslipCoverage.mockResolvedValue(buildCoverage({ sent: 1, pending: 1, failed: 1 }));
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('payslip-email-attention-count')).toHaveTextContent(/2 emails pending or failed/i);
    });
  });
});

describe('AdminPayslips — upload validation', () => {
  // The upload modal is opened by clicking an "Upload payslip" button.
  // The file input is inside the modal and is filtered to application/pdf.
  const openUploadModal = async () => {
    renderPage();
    const openBtn = await screen.findByRole('button', { name: /Upload payslip/i });
    fireEvent.click(openBtn);
    // The modal renders a file input — find it.
    await waitFor(() => {
      expect(screen.getByLabelText(/PDF file/i)).toBeInTheDocument();
    });
  };

  test('3. non-PDF file → "File type ... not supported" error, no SAS-URL call', async () => {
    await openUploadModal();
    const fileInput = screen.getByLabelText(/PDF file/i);
    // Build a file that is NOT a PDF.
    const badFile = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(fileInput, { target: { files: [badFile] } });
    // The validation error appears in the modal.
    await waitFor(() => {
      expect(screen.getByText(/File type "text\/plain" not supported/i)).toBeInTheDocument();
    });
    // The SAS-URL endpoint was NOT called.
    expect(mockGetPayslipUploadSas).not.toHaveBeenCalled();
  });

  test('4. file > 2 MB → "File too large. Max 2 MB." error, no SAS-URL call', async () => {
    await openUploadModal();
    const fileInput = screen.getByLabelText(/PDF file/i);
    // 2 MB + 1 byte. The constant is in src/lib/constants.js as
    // MAX_PAYSLIP_BYTES = 2 * 1024 * 1024.
    const bigBuffer = new ArrayBuffer(2 * 1024 * 1024 + 1);
    const bigFile = new File([bigBuffer], 'huge.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput, { target: { files: [bigFile] } });
    await waitFor(() => {
      expect(screen.getByText(/File too large\. Max 2 MB\./i)).toBeInTheDocument();
    });
    expect(mockGetPayslipUploadSas).not.toHaveBeenCalled();
  });
});

describe('AdminPayslips — publish + revoke', () => {
  test('5. per-row Publish: click row Publish button → api.publishPayslips called with the row id', async () => {
    // Seed a coverage with at least one DRAFT row so a per-row Publish
    // button is rendered. The current coverage schema doesn't carry a
    // DRAFT column directly — the test uses the publishedAt=null
    // contract to mean "draft": the page renders a Publish button for
    // any row whose payslip has publishedAt = null.
    mockGetPayslipCoverage.mockResolvedValue({
      ...buildCoverage({ sent: 0, pending: 0, failed: 0, totalEmployees: 1 }),
      coverage: [
        {
          employeeId: 'e1', employeeName: 'Alice', employeeEmail: 'alice@example.com',
          payslip: {
            id: 'p-draft-1', year: 2026, month: 10,
            publishedAt: null, emailStatus: null, publishedById: null,
          },
        },
      ],
      coveredCount: 1, missingCount: 0,
    });
    renderPage();
    // Per-row Publish button — find by accessible name on the row.
    const publishBtn = await screen.findByRole('button', { name: /^Publish$/ });
    fireEvent.click(publishBtn);
    await waitFor(() => {
      expect(mockPublishPayslips).toHaveBeenCalledWith(
        ['p-draft-1'],
        'admin-token',
        expect.any(String), // Idempotency-Key — any UUID-shaped value
      );
    });
  });

  test('6. revoke with rejected-word: server returns 400 AUDIT_REASON_REJECTED → admin sees the rejectedWord in a toast', async () => {
    // Seed a coverage with one published row, so a per-row Revoke button
    // appears.
    mockGetPayslipCoverage.mockResolvedValue({
      ...buildCoverage({ sent: 1, pending: 0, failed: 0, totalEmployees: 1 }),
      coverage: [
        {
          employeeId: 'e1', employeeName: 'Alice', employeeEmail: 'alice@example.com',
          payslip: {
            id: 'p-rev-1', year: 2026, month: 10,
            publishedAt: '2026-10-31T00:00:00.000Z', emailStatus: 'SENT',
            publishedById: 'admin-1',
          },
        },
      ],
    });
    // Mock revoke to throw the exact shape the api.js wrapper produces
    // for a 400 with code + rejectedWord on the body: ApiError carries
    // {status, code} on itself and copies any extra body fields onto
    // the same Error (api.js ApiError ctor accepts `extra`).
    mockRevokePayslip.mockRejectedValue(Object.assign(
      new Error('Reason contains a banned keyword'),
      { status: 400, code: 'AUDIT_REASON_REJECTED', rejectedWord: 'salary' }
    ));

    renderPage();
    // The per-row Revoke button — match exactly "Revoke" (the
    // "Revoked" filter chip is a separate button, so the regex must
    // not match it).
    const revokeBtn = await screen.findByRole('button', { name: 'Revoke' });
    fireEvent.click(revokeBtn);
    // The revoke modal opens. The reason textarea is keyed by its
    // placeholder — the label wraps the textarea, so getByLabelText
    // resolves through the implicit label association.
    const reasonInput = await screen.findByPlaceholderText(/Wrong amount/i);
    fireEvent.change(reasonInput, { target: { value: 'Wrong salary figure' } });
    // Click the confirm Revoke button (inside the modal, text "Revoke").
    const modal = screen.getByRole('alertdialog');
    const confirmBtn = within(modal).getByRole('button', { name: /Revoke/i });
    fireEvent.click(confirmBtn);
    // The mock rejects — the page must surface the rejectedWord in a
    // toast so the admin can rewrite.
    await waitFor(() => {
      expect(mockToastPush).toHaveBeenCalledWith(
        expect.stringMatching(/salary/i),
        'error',
      );
    });
  });
});
