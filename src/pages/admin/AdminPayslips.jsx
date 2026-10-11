// [Payslips Stage 1 / commit 6 — frontend] Admin payslip register.
//
// Coverage panel (top) + admin actions (bottom). The page mirrors the
// BillingCertificationsAdmin shell (cards + filters + cursor pagination
// + alertdialog modals + DR-018 admin guard) and adds three things the
// COP register doesn't have:
//
//   1. The "N emails pending or failed" headline indicator — derived
//      from the per-row `emailStatus` on every row in the GET
//      /api/admin/payslips/coverage response. The backend emits no
//      aggregate field today (security-contract agent confirmed), so
//      the admin client computes it once per refresh via
//      isPayslipEmailAttention() in src/lib/constants.js.
//
//   2. The Resend action — one-click re-fire of a single stuck
//      emailStatus (calls POST /api/admin/payslips/:id/resend-email →
//      202 { ok, id, queued: true }) AND a "Sweep all" button that
//      fires the admin-triggered stuck-PENDING sweep (POST
//      /api/admin/payslips/resend-stuck → { ok, scanned, sent, failed }
//      — there is NO cron, by explicit user constraint).
//
//   3. The per-row late-publish path — a single-row Publish button on
//      each covered-but-unpublished employee row. This is the natural
//      UI for a "we uploaded all the payslips on day 5 but Y received
//      their T-4 on day 8" admin action: no need to rebind; just
//      publish the one row that's late. Backend POST
//      /api/admin/payslips/publish is bulk-shaped (`{ payslipIds: [] }`)
//      but accepts a single-id array so the same code path handles
//      both the all-rows and the one-row case.
//
// Other admin actions (revoke, replace-via-rebind, replace-file) reuse
// the patterns established by BillingCertificationsAdmin / ReportsAdmin:
//
//   - Revoke  → POST /:id/revoke with optional `reason` (server runs
//               sanitizeAuditReason — throws on salary/pan/uan/etc, the
//               400 echoes `rejectedWord` so the admin can rewrite).
//   - Replace → revoke + rebind via the same 3-step pipeline used on
//               create. There is no in-place replace endpoint for
//               payslips (per security-contract agent); the
//               cross-employee-bind + blob-path-tamper tests pin this
//               contract in backend/__tests__/payslip-routes.test.js.
//   - Download → api.downloadPayslip(id, token) — same blob flow as the
//                employee page, but admins can download anyone's payslip
//                (the portal-router is the only one with the IDOR guard;
//                the admin /:id/download?admin=1 path is NOT shipped
//                yet — admins use GET /api/admin/payslips → list with
//                download links per row when they need a copy).
//
// Privacy discipline (mirrors the plan's C.4): no console logs, no
// hashIdentifier calls — PII hashing is the backend's job. The wire
// serializer explicitly excludes salary figures (see backend/src/lib/
// payslip.js serializePayslipForWire), so the frontend never touches
// monetary data even by accident.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import Modal from '../../components/Modal.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import {
  formatShortDate,
  formatBytes,
  formatMonthLabel,
} from '../../lib/format.js';
import {
  MAX_PAYSLIP_BYTES,
  ACCEPTED_PAYSLIP_TYPES,
  PAYSLIP_STATUSES,
  PAYSLIP_STATUS_LABELS,
  PAYSLIP_EMAIL_STATUS_LABELS,
  isPayslipEmailAttention,
} from '../../lib/constants.js';
import {
  uploadBlob,
  DEFAULT_BLOB_UPLOAD_TIMEOUT_MS,
  BlobUploadError,
} from '../../lib/blobUpload.js';

const DEFAULT_LIMIT = 50;
const MAX_REVOKE_REASON = 500;

// Per-row status pills — 3-state machine. Status is computed locally
// (the wire serializer doesn't expose a `status` field directly; the
// same predicate used by MyPayslips is reused so the two pages read
// identically).
const STATUS_BADGE_STYLES = {
  DRAFT:     { background: '#f1f5f9', color: '#475569' }, // slate
  PUBLISHED: { background: '#dcfce7', color: '#166534' }, // green
  REVOKED:   { background: '#fee2e2', color: '#b91c1c' }, // red
};

function rowStatus(row) {
  if (row.deletedAt) return 'REVOKED';
  if (row.publishedAt) return 'PUBLISHED';
  return 'DRAFT';
}

function monthYearLabel(year, month) {
  if (!year || !month) return '—';
  return formatMonthLabel(`${year}-${String(month).padStart(2, '0')}`);
}

// Tiny per-row file validator — mirrors MyProjectReports.jsx:319-328.
// Server is authoritative on MIME (application/pdf only) + 2 MB cap;
// the client mirror is just to surface a friendly error before the
// SAS-URL call goes out.
function validatePayslipFile(file) {
  if (!file) return 'Please pick a file first.';
  if (file.size > MAX_PAYSLIP_BYTES) {
    return `File too large. Max ${Math.round(MAX_PAYSLIP_BYTES / (1024 * 1024))} MB.`;
  }
  if (!ACCEPTED_PAYSLIP_TYPES.includes(file.type)) {
    return `File type "${file.type || 'unknown'}" not supported. Use PDF.`;
  }
  return null;
}

// Email-status pill renderer. Returns inline-styled JSX so the cell can
// sit inside an existing row without a CSS-class dependency.
function EmailPill({ status }) {
  if (!status) {
    return (
      <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>—</span>
    );
  }
  const cfg = PAYSLIP_EMAIL_STATUS_LABELS[status] || { label: status, tone: 'muted' };
  const tone = cfg.tone;
  const bg = tone === 'success' ? '#dcfce7'
    : tone === 'danger' ? '#fee2e2'
    : tone === 'muted' ? '#f1f5f9'
    : '#f1f5f9';
  const fg = tone === 'success' ? '#166534'
    : tone === 'danger' ? '#b91c1c'
    : tone === 'muted' ? '#475569'
    : '#475569';
  return (
    <span style={{
      fontSize: '0.62rem', fontWeight: 700,
      background: bg, color: fg,
      padding: '2px 6px', borderRadius: 999,
      textTransform: 'uppercase', letterSpacing: '0.04em',
      whiteSpace: 'nowrap',
    }}>
      {cfg.label}
    </span>
  );
}

function StatusPill({ status }) {
  const cfg = PAYSLIP_STATUS_LABELS[status] || { label: status, tone: 'muted' };
  const bg = cfg.tone === 'success' ? '#dcfce7'
    : cfg.tone === 'danger' ? '#fee2e2'
    : '#f1f5f9';
  const fg = cfg.tone === 'success' ? '#166534'
    : cfg.tone === 'danger' ? '#b91c1c'
    : '#475569';
  return (
    <span style={{
      fontSize: '0.65rem', fontWeight: 700,
      background: bg, color: fg,
      padding: '2px 8px', borderRadius: 999,
      textTransform: 'uppercase', letterSpacing: '0.04em',
      whiteSpace: 'nowrap',
    }}>
      {cfg.label}
    </span>
  );
}

export default function AdminPayslips() {
  useDocumentTitle('Payslips');
  const { employee, accessToken } = useAuth();
  const toast = useToast();

  // [DR-018] Render-time admin guard — even though the route is
  // <ProtectedRoute requireAdmin>, mirror the BillingCertificationsAdmin
  // pattern (lines 570-582) so a stale JWT (e.g. demoted admin) gets
  // a visible denial page instead of a silent fetch storm.
  if (employee && !employee.isAdmin) {
    return (
      <div className="dpr-page">
        <div className="dpr-card" style={{ textAlign: 'center', padding: '3rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🔒</div>
          <h2 style={{ color: 'var(--navy)', marginBottom: '0.5rem' }}>Admin Access Required</h2>
          <p style={{ color: 'var(--steel)' }}>
            You need admin privileges to access the payslip register.
          </p>
        </div>
      </div>
    );
  }

  // ── Filters ──────────────────────────────────────────────────────────
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1); // 1..12
  const [statusFilter, setStatusFilter] = useState(''); // '' | 'active' | 'revoked' | 'published' | 'unpublished'
  const [employeeFilter, setEmployeeFilter] = useState(''); // id or empty

  // ── Coverage + list data ─────────────────────────────────────────────
  const [coverage, setCoverage] = useState(null);
  const [coverageLoading, setCoverageLoading] = useState(false);
  const [payslips, setPayslips] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [total, setTotal] = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const [listLoadingMore, setListLoadingMore] = useState(false);
  const [error, setError] = useState('');

  // ── Email-status indicator ───────────────────────────────────────────
  // Derived client-side from the coverage response. The backend does
  // not expose an aggregate count endpoint, so the admin page does the
  // reduction here. `scanIdRef` invalidates late scans so a slow refresh
  // can't overwrite a newer fetch's attention count.
  const attentionCount = useMemo(() => {
    if (!coverage?.coverage) return 0;
    return coverage.coverage.filter(
      (c) => c.payslip && isPayslipEmailAttention(c.payslip.emailStatus),
    ).length;
  }, [coverage]);

  // ── Sweep / Resend per-row state ────────────────────────────────────
  const [sweeping, setSweeping] = useState(false);
  const [resendingId, setResendingId] = useState(null);

  // ── Upload modal ────────────────────────────────────────────────────
  // Stage 1 ships an admin "upload for one employee" modal — the
  // drag-and-drop bulk flow is documented as stage 2. The modal
  // mirrors BillingCertificationsAdmin's CertificationFormModal
  // (lines 1488-1623) — same 3-step pipeline + idempotency-key mint.
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadEmployeeId, setUploadEmployeeId] = useState('');
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadPhase, setUploadPhase] = useState(''); // 'sas'|'uploading'|'confirming'|'binding'|'publishing'|''
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // When true, the upload modal will publish the new row immediately
  // after bind succeeds. Default off so admins can stage uploads.
  const [publishAfterBind, setPublishAfterBind] = useState(true);
  const fileInputRef = useRef(null);

  // In-page PDF preview — when the admin picks a PDF, mint a
  // `blob:` object URL and render it inside the modal so the admin
  // can sanity-check the file before clicking Upload. No network
  // call: the bytes are still on the admin's machine. The URL is
  // revoked on file change, modal close, and component unmount
  // (URL.createObjectURL leaks the underlying blob until either
  // revokeObjectURL runs or the document is unloaded, so we have
  // to be explicit). Non-PDF files: no preview, validation message
  // stays visible. The endpoint CSP check (no Content-Security-
  // Policy on https://acs-portal-spa.onrender.com — verified via
  // curl -sI) lets `blob:` frames render without any header change.
  const [previewUrl, setPreviewUrl] = useState(null);
  const previewUrlRef = useRef(null);
  const revokePreview = useCallback(() => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreviewUrl(null);
  }, []);
  // Revoke on unmount as a safety net (closeUpload also revokes on
  // each close, but an admin navigating away mid-modal still has to
  // release the URL).
  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  // ── Viewer modal (PUBLISHED rows) ──────────────────────────────────
  // Mirrors the upload-preview plumbing above. When the admin clicks
  // "View" on a PUBLISHED row, we fetch the PDF as a Blob via
  // `api.getAdminPayslipDownload` (which routes through the shared
  // api.download helper — 401-refresh + filename-parse +
  // AbortController timeout), mint a `blob:` object URL, and render
  // it inside an `<object data type="application/pdf">`. The blob
  // URL is same-origin and does not inherit the API response's
  // headers, so the portal's X-Frame-Options / CSP frame-ancestors
  // are not in play for the rendered document (and the admin
  // download route doesn't emit them).
  //
  // Gated on PUBLISHED rows only — drafts are the admin's own
  // (upload-modal preview already shows the local file) and revoked
  // rows must not expose the underlying bytes to anyone.
  const [viewerRow, setViewerRow] = useState(null); // { id, year, month, employeeName, sizeBytes }
  const [viewerBlobUrl, setViewerBlobUrl] = useState(null);
  const viewerUrlRef = useRef(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [viewerError, setViewerError] = useState('');
  const revokeViewer = useCallback(() => {
    if (viewerUrlRef.current) {
      URL.revokeObjectURL(viewerUrlRef.current);
      viewerUrlRef.current = null;
    }
    setViewerBlobUrl(null);
  }, []);
  // Unmount safety net — covers the case where the admin navigates
  // away from the page while the modal is still mounted (route
  // transition, sidebar click, etc.). The ref-tracked URL is the
  // canonical source; the state copy is just for re-render.
  useEffect(() => () => {
    if (viewerUrlRef.current) URL.revokeObjectURL(viewerUrlRef.current);
  }, []);

  // Employee directory for the picker. Capped at 500 by the backend;
  // a 15-80 employee payroll fits comfortably. Reuse the admin
  // employees endpoint — same one TrainingCourseNew uses.
  const [employees, setEmployees] = useState([]);
  const [employeesLoading, setEmployeesLoading] = useState(false);
  const fetchEmployees = useCallback(async () => {
    setEmployeesLoading(true);
    try {
      const data = await api.listAdminEmployees({ limit: '500' }, accessToken);
      setEmployees(data?.employees || []);
    } catch (err) {
      // Non-fatal — the picker just shows the placeholder. Admins can
      // retry by reopening the modal.
      // eslint-disable-next-line no-console
      console.error('[AdminPayslips] could not load employee directory', err);
    } finally {
      setEmployeesLoading(false);
    }
  }, [accessToken]);
  useEffect(() => { fetchEmployees(); }, [fetchEmployees]);

  // ── Revoke modal ────────────────────────────────────────────────────
  const [confirmRevoke, setConfirmRevoke] = useState(null); // row
  const [revokeReason, setRevokeReason] = useState('');
  const [revoking, setRevoking] = useState(false);

  // ── Coverage fetch (headline indicator + per-employee status) ───────
  const coverageScanIdRef = useRef(0);
  const fetchCoverage = useCallback(async () => {
    const scanId = ++coverageScanIdRef.current;
    setCoverageLoading(true);
    try {
      const data = await api.getPayslipCoverage(year, month, accessToken);
      if (scanId !== coverageScanIdRef.current) return; // stale
      setCoverage(data);
    } catch (err) {
      if (scanId !== coverageScanIdRef.current) return;
      setError(err?.message || 'Failed to load coverage');
      setCoverage(null);
    } finally {
      if (scanId === coverageScanIdRef.current) setCoverageLoading(false);
    }
  }, [year, month, accessToken]);

  // ── List fetch (admin filterable browse) ────────────────────────────
  const buildListParams = useCallback(({ cursor = null } = {}) => {
    const params = { limit: String(DEFAULT_LIMIT), year: String(year), month: String(month) };
    if (statusFilter) params.status = statusFilter;
    if (employeeFilter) params.employeeId = employeeFilter;
    if (cursor) params.cursor = cursor;
    return params;
  }, [year, month, statusFilter, employeeFilter]);

  const fetchList = useCallback(async ({ append = false, cursor = null } = {}) => {
    if (append) setListLoadingMore(true); else setListLoading(true);
    setError('');
    try {
      const data = await api.getAdminPayslips(buildListParams({ cursor }), accessToken);
      const items = data?.payslips || [];
      setPayslips((prev) => (append ? [...prev, ...items] : items));
      setNextCursor(data?.nextCursor || null);
      if (!append) setTotal(data?.total || items.length);
    } catch (err) {
      setError(err?.message || 'Failed to load payslips');
      if (!append) {
        setPayslips([]);
        setNextCursor(null);
        setTotal(0);
      }
    } finally {
      if (append) setListLoadingMore(false); else setListLoading(false);
    }
  }, [buildListParams, accessToken]);

  // Refresh both on year/month/filter change.
  useEffect(() => {
    fetchCoverage();
    fetchList();
  }, [fetchCoverage, fetchList]);

  // ── Action: publish one row (per-row late publish) ──────────────────
  const [publishingId, setPublishingId] = useState(null);
  const handlePublishRow = useCallback(async (row) => {
    if (!row || publishingId) return;
    setPublishingId(row.id);
    try {
      const idempotencyKey = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `payslip-pub-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const result = await api.publishPayslips([row.id], accessToken, idempotencyKey);
      const sent = result?.published?.length || 0;
      const failed = result?.failed?.length || 0;
      const failedReasons = (result?.failed || [])
        .map((f) => f.reason)
        .filter(Boolean);
      toast.push(
        failed === 0
          ? `Published. Emails are sent in the background — check back in a moment.`
          : `Published ${sent}, ${failed} failed (${failedReasons.join(', ') || 'see server logs'}).`,
        failed === 0 ? 'success' : 'warning',
      );
      await fetchCoverage();
      await fetchList();
    } catch (err) {
      toast.push(err?.message || 'Publish failed', 'error');
    } finally {
      setPublishingId(null);
    }
  }, [publishingId, accessToken, toast, fetchCoverage, fetchList]);

  // ── Action: bulk publish every draft for this month ─────────────────
  // The plan asks for a "Publish all for this month" button. The
  // backend has no /publish-month endpoint — the route is the same
  // /publish with the full set of draft ids from the coverage response.
  const [publishingAll, setPublishingAll] = useState(false);
  const handlePublishAll = useCallback(async () => {
    if (!coverage?.coverage || publishingAll) return;
    const draftIds = coverage.coverage
      .filter((c) => c.payslip && !c.payslip.published)
      .map((c) => c.payslip.id);
    if (draftIds.length === 0) {
      toast.push('No drafts to publish for this month.', 'info');
      return;
    }
    if (!window.confirm(`Publish ${draftIds.length} draft payslip${draftIds.length === 1 ? '' : 's'} for ${monthYearLabel(year, month)}? Emails will be sent in the background.`)) return;
    setPublishingAll(true);
    try {
      const idempotencyKey = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `payslip-pub-all-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const result = await api.publishPayslips(draftIds, accessToken, idempotencyKey);
      const sent = result?.published?.length || 0;
      const failed = result?.failed?.length || 0;
      toast.push(
        failed === 0
          ? `Published ${sent} payslip${sent === 1 ? '' : 's'}. Emails are sent in the background.`
          : `Published ${sent}, ${failed} failed.`,
        failed === 0 ? 'success' : 'warning',
      );
      await fetchCoverage();
      await fetchList();
    } catch (err) {
      toast.push(err?.message || 'Bulk publish failed', 'error');
    } finally {
      setPublishingAll(false);
    }
  }, [coverage, publishingAll, year, month, accessToken, toast, fetchCoverage, fetchList]);

  // ── Action: resend a single email ───────────────────────────────────
  const handleResend = useCallback(async (row) => {
    if (!row || resendingId) return;
    setResendingId(row.id);
    try {
      await api.resendPayslipEmail(row.id, accessToken);
      toast.push('Resend queued. Status will refresh in a few seconds.', 'success');
      // Brief delay then re-fetch so the UI picks up the new emailStatus
      // (the backend stamps PENDING then fires the drain async).
      setTimeout(async () => {
        await fetchCoverage();
        await fetchList();
      }, 1500);
    } catch (err) {
      toast.push(err?.message || 'Resend failed', 'error');
    } finally {
      setResendingId(null);
    }
  }, [resendingId, accessToken, toast, fetchCoverage, fetchList]);

  // ── Action: stuck-PENDING sweep (admin-triggered; NOT a cron) ───────
  const handleSweep = useCallback(async () => {
    if (sweeping) return;
    if (!window.confirm('Sweep every PENDING payslip email older than 5 minutes? Failed sends will be re-tried.')) return;
    setSweeping(true);
    try {
      const result = await api.resendStuckPayslipEmails(accessToken);
      const sent = result?.sent || 0;
      const failed = result?.failed || 0;
      const scanned = result?.scanned || 0;
      toast.push(
        `Sweep complete: scanned ${scanned}, sent ${sent}, failed ${failed}.`,
        failed === 0 ? 'success' : 'warning',
      );
      await fetchCoverage();
      await fetchList();
    } catch (err) {
      toast.push(err?.message || 'Sweep failed', 'error');
    } finally {
      setSweeping(false);
    }
  }, [sweeping, accessToken, toast, fetchCoverage, fetchList]);

  // ── Action: revoke ──────────────────────────────────────────────────
  const openRevoke = useCallback((row) => {
    setConfirmRevoke(row);
    setRevokeReason('');
    setError('');
  }, []);
  const closeRevoke = useCallback(() => {
    if (revoking) return;
    setConfirmRevoke(null);
    setRevokeReason('');
  }, [revoking]);
  const handleRevoke = useCallback(async () => {
    if (!confirmRevoke || revoking) return;
    const reason = revokeReason.trim();
    if (reason.length > MAX_REVOKE_REASON) {
      toast.push(`Reason is too long (max ${MAX_REVOKE_REASON} chars).`, 'error');
      return;
    }
    setRevoking(true);
    try {
      const idempotencyKey = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `payslip-rev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await api.revokePayslip(confirmRevoke.id, reason ? { reason } : {}, accessToken, idempotencyKey);
      toast.push(`Revoked payslip for ${monthYearLabel(confirmRevoke.year, confirmRevoke.month)}.`, 'success');
      setConfirmRevoke(null);
      setRevokeReason('');
      await fetchCoverage();
      await fetchList();
    } catch (err) {
      // [DR-007 / payroll appsec] Loud rejection on salary-keyword audit
      // reason — the route returns 400 AUDIT_REASON_REJECTED with
      // `rejectedWord` echoed. Surface that word to the admin so they
      // can rewrite. Never silent-redact — the audit-reason input is
      // the admin's signed record and the rejection must be visible.
      const code = err?.code || '';
      if (code === 'AUDIT_REASON_REJECTED') {
        toast.push(
          `Reason contains a banned keyword (${err?.rejectedWord || 'see server'}). Rewrite without salary/pan/uan/tax terms.`,
          'error',
        );
      } else {
        toast.push(err?.message || 'Revoke failed', 'error');
      }
    } finally {
      setRevoking(false);
    }
  }, [confirmRevoke, revoking, revokeReason, accessToken, toast, fetchCoverage, fetchList]);

  // ── Action: view a published payslip (admin viewer modal) ─────────
  // The row argument is the union of the coverage + list shapes — the
  // { id, year, month, employeeName/recipientName, sizeBytes } keys
  // are present on both. The viewer does NOT mutate the row — it's a
  // pure read — so no fetchCoverage/fetchList refresh on close.
  const openViewer = useCallback(async (row) => {
    if (!row || viewerLoading) return;
    // Tear down any previous blob URL before opening a new modal so
    // a back-to-back View click on row B after row A doesn't leave
    // row A's blob dangling. (Each call mints a fresh URL.)
    revokeViewer();
    setViewerError('');
    setViewerRow(row);
    setViewerLoading(true);
    try {
      const { blob } = await api.getAdminPayslipDownload(row.id, accessToken);
      const url = URL.createObjectURL(blob);
      viewerUrlRef.current = url;
      setViewerBlobUrl(url);
    } catch (err) {
      // Map the common cases to friendly toasts; fall back to the
      // server's message for anything else. 404 / 410 are the
      // "this row is no longer available" path — a revoke-then-click
      // sequence, or a BLOB_GONE purge-then-click sequence.
      const code = err?.code || '';
      if (code === 'NOT_FOUND' || code === 'PAYSLIP_BLOB_GONE') {
        toast.push('This payslip is no longer available.', 'error');
      } else {
        toast.push(err?.message || 'Could not load the payslip PDF.', 'error');
      }
      // Close the modal on failure so the admin isn't stuck on a
      // blank modal frame.
      setViewerRow(null);
    } finally {
      setViewerLoading(false);
    }
  }, [viewerLoading, revokeViewer, accessToken, toast]);
  const closeViewer = useCallback(() => {
    if (viewerLoading) return;
    revokeViewer();
    setViewerRow(null);
    setViewerError('');
  }, [viewerLoading, revokeViewer]);

  // ── Action: upload + bind + (optional) publish (admin modal) ───────
  const openUpload = useCallback(() => {
    setUploadOpen(true);
    setUploadEmployeeId('');
    setUploadFile(null);
    setUploadError('');
    setUploadPhase('');
    setUploadProgress(0);
    revokePreview();
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [revokePreview]);
  const closeUpload = useCallback(() => {
    if (submitting) return;
    revokePreview();
    setUploadOpen(false);
  }, [submitting, revokePreview]);
  const handleFileChange = useCallback((e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const err = validatePayslipFile(f);
    if (err) {
      setUploadError(err);
      setUploadFile(null);
      revokePreview();
      return;
    }
    setUploadError('');
    setUploadFile(f);
    // Mint a fresh object URL for the in-page preview. Revoke any
    // previous URL first so the modal never accumulates dangling
    // `blob:` references. Only PDFs get a preview — non-PDFs flow
    // through `validatePayslipFile` above and are rejected (the
    // validation message in the modal is the user-facing signal,
    // not a preview).
    revokePreview();
    if (f.type === 'application/pdf') {
      const url = URL.createObjectURL(f);
      previewUrlRef.current = url;
      setPreviewUrl(url);
    }
  }, [revokePreview]);
  const handleUploadSubmit = useCallback(async () => {
    if (!uploadFile || !uploadEmployeeId) {
      setUploadError('Pick an employee and a PDF file.');
      return;
    }
    setSubmitting(true);
    setUploadError('');
    try {
      // Step 1 — mint SAS URL. The server-side mount sets
      // `pathPrefix: 'payslips'` so the resulting blobPath is
      // `payslips/<employeeId>/<ulid>.pdf`. The bind step asserts
      // this exact shape, so the client must send the same prefix
      // verbatim (api.getPayslipSasUrl does this — see the comment
      // at api.js:getPayslipSasUrl).
      setUploadPhase('sas');
      const { sasUrl, ulid, blobPath } = await api.getPayslipSasUrl(
        uploadFile.name, uploadFile.type, accessToken,
      );

      // Step 2 — PUT bytes to R2. The shared uploadBlob helper handles
      // the XHR + progress callbacks + AbortController-based cancel.
      setUploadPhase('uploading');
      setUploadProgress(0);
      try {
        await uploadBlob(sasUrl, uploadFile, {
          contentType: uploadFile.type,
          onProgress: (pct) => setUploadProgress(pct),
          timeoutMs: DEFAULT_BLOB_UPLOAD_TIMEOUT_MS,
        });
      } catch (err) {
        if (err instanceof BlobUploadError) throw new Error(`Upload failed: ${err.message}`);
        throw err;
      }

      // Step 3 — confirm the upload intent so the server flips the
      // UploadIntent row from PENDING → CONFIRMED. The bind step
      // (step 4) reads back the same intent + verified blobPath.
      setUploadPhase('confirming');
      await api.confirmPayslipUpload(
        ulid, uploadFile.name, uploadFile.type, uploadFile.size, accessToken,
      );

      // Step 4 — bind the uploaded blob to the (employee, year, month)
      // Payslip row. The server runs the magic-byte verification on
      // the blob, asserts the blobPath prefix, and 409s on a duplicate
      // (employee_id, year, month) per the partial-unique index.
      //
      // Idempotency-Key: SEPARATE per endpoint call. The current
      // backend does NOT consult the Idempotency-Key header on the
      // payslip admin routes (it is idempotent at the DB level via
      // the partial-unique index on bind and the publishedAt CAS on
      // publish), but defensive separation is the right contract:
      // if a future change adds an Idempotency-Key-aware cache that
      // keys on the raw header alone, a single key for "bind +
      // publish" would short-circuit publish as a replay of bind.
      // See backend/__tests__/payslip-routes.test.js:
      //   "C-bind-publish-distinct-keys. publish is NOT short-circuited
      //    when the same Idempotency-Key is sent on bind and publish."
      setUploadPhase('binding');
      const bindKey = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `payslip-bind-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const bound = await api.bindPayslip({
        ulid,
        employeeId: uploadEmployeeId,
        year,
        month,
      }, accessToken, bindKey);

      // Step 5 — optional publish. Default ON so the "upload and
      // notify" common case is one click. Admins who want to stage
      // uploads can flip the toggle off; the row will appear as a
      // DRAFT in the coverage panel until they hit the per-row Publish
      // button (or the bulk Publish all).
      if (publishAfterBind) {
        setUploadPhase('publishing');
        const publishKey = (typeof crypto !== 'undefined' && crypto.randomUUID)
          ? crypto.randomUUID()
          : `payslip-publish-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await api.publishPayslips([bound.id], accessToken, publishKey);
        toast.push('Payslip uploaded and published. Email is on its way.', 'success');
      } else {
        toast.push('Payslip uploaded as draft. Use Publish when ready.', 'success');
      }
      revokePreview();
      setUploadOpen(false);
      setUploadFile(null);
      setUploadEmployeeId('');
      setUploadPhase('');
      setUploadProgress(0);
      if (fileInputRef.current) fileInputRef.current.value = '';
      await fetchCoverage();
      await fetchList();
    } catch (err) {
      // Common 4xx + their UX implications:
      //  - 400 INVALID_BLOB_PATH   — the prefix mismatch; should not
      //    happen because the wrapper hardcodes `payslips/`.
      //  - 404 EMPLOYEE_NOT_FOUND  — the admin picked a directory row
      //    that the server can't resolve (rare race).
      //  - 404 UPLOAD_NOT_CONFIRMED — the confirm step failed silently
      //    or the SAS expired mid-upload. Retry the whole flow.
      //  - 409 PAYSLIP_DUPLICATE   — there is already a payslip for
      //    (employee, year, month). Admin must revoke the existing
      //    row first or pick a different month.
      //  - 422 NOT_PDF             — the magic-byte check rejected the
      //    bytes. The browser's file.type said application/pdf but
      //    the actual file is something else. Admin must re-export
      //    the PDF from the payroll system.
      const code = err?.code || '';
      let msg = err?.message || 'Upload failed';
      if (code === 'PAYSLIP_DUPLICATE') {
        msg = 'A payslip for this employee and month is already on file. Revoke the existing row first.';
      } else if (code === 'NOT_PDF') {
        msg = 'The uploaded file is not a valid PDF. Re-export the payslip from the payroll system.';
      } else if (code === 'UPLOAD_NOT_CONFIRMED') {
        msg = 'The upload did not complete in time. Try again — the SAS URL expires after 20 minutes.';
      }
      setUploadError(msg);
    } finally {
      setSubmitting(false);
      setUploadPhase('');
      setUploadProgress(0);
    }
  }, [uploadFile, uploadEmployeeId, year, month, publishAfterBind, accessToken, toast, fetchCoverage, fetchList, revokePreview]);

  // Submitting-phase label — mirrors BillingCertificationsAdmin:251-257
  // so the modal surfaces "Uploading PDF… 47%" instead of a frozen
  // spinner. This is the single point where the user can tell that
  // the multi-step pipeline is still moving.
  const submittingLabel = useMemo(() => {
    if (uploadPhase === 'sas') return 'Preparing upload…';
    if (uploadPhase === 'uploading') return `Uploading PDF… ${uploadProgress}%`;
    if (uploadPhase === 'confirming') return 'Confirming upload…';
    if (uploadPhase === 'binding') return 'Saving payslip row…';
    if (uploadPhase === 'publishing') return 'Publishing & queuing email…';
    if (submitting) return 'Saving…';
    return null;
  }, [uploadPhase, uploadProgress, submitting]);

  const anyFilterActive = !!statusFilter || !!employeeFilter;

  return (
    <div className="dpr-page">
      <div className="dpr-page-header">
        <div>
          <Breadcrumb
            items={[
              { label: 'Admin Overview', to: '/portal/admin' },
              { label: 'Payslips' },
            ]}
          />
          <h1 className="dpr-page-title">Payslips</h1>
          <p style={{ color: 'var(--steel)', fontSize: '0.9rem', margin: 0 }}>
            Upload, publish, and revoke monthly payslips. The headline indicator
            shows how many emails are still pending or failed for the selected
            month — use <strong>Resend</strong> on a single row or
            <strong> Sweep</strong> to retry every PENDING older than 5 minutes.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={openUpload}
          disabled={employeesLoading}
        >
          + Upload payslip
        </button>
      </div>

      {/* Filter toolbar — year + month + status chip-row + employee select. */}
      <div className="dpr-card" style={{ marginBottom: '1rem' }}>
        <div className="form-row" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: '0.75rem' }}>
          <div className="form-group" style={{ flex: '0 0 120px' }}>
            <label htmlFor="payslip-year">Year</label>
            <input
              id="payslip-year"
              type="number"
              className="form-input"
              min="2000"
              max="2100"
              value={year}
              onChange={(e) => setYear(Number(e.target.value) || now.getFullYear())}
            />
          </div>
          <div className="form-group" style={{ flex: '0 0 120px' }}>
            <label htmlFor="payslip-month">Month</label>
            <select
              id="payslip-month"
              className="form-input"
              value={month}
              onChange={(e) => setMonth(Number(e.target.value))}
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>
                  {formatMonthLabel(`${year}-${String(m).padStart(2, '0')}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group" style={{ flex: '1 1 180px', minWidth: 180 }}>
            <label htmlFor="payslip-employee">Employee</label>
            <select
              id="payslip-employee"
              className="form-input"
              value={employeeFilter}
              onChange={(e) => setEmployeeFilter(e.target.value)}
              disabled={employeesLoading}
            >
              <option value="">Any employee</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.name}{emp.email ? ` (${emp.email})` : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center', marginTop: '0.6rem' }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--steel)', marginRight: '0.25rem' }}>Status:</span>
          <FilterChip active={!statusFilter} onClick={() => setStatusFilter('')}>All</FilterChip>
          <FilterChip active={statusFilter === 'published'} onClick={() => setStatusFilter(statusFilter === 'published' ? '' : 'published')}>Published</FilterChip>
          <FilterChip active={statusFilter === 'unpublished'} onClick={() => setStatusFilter(statusFilter === 'unpublished' ? '' : 'unpublished')}>Drafts</FilterChip>
          <FilterChip active={statusFilter === 'revoked'} onClick={() => setStatusFilter(statusFilter === 'revoked' ? '' : 'revoked')}>Revoked</FilterChip>
          {anyFilterActive && (
            <button
              type="button"
              onClick={() => { setStatusFilter(''); setEmployeeFilter(''); }}
              style={{ marginLeft: 'auto', fontSize: '0.78rem', color: 'var(--steel)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* Coverage panel + headline indicator. The indicator is the
          most important affordance on the page — admins care more
          about "did the email go out?" than "is the row on disk?". */}
      <div className="dpr-card" style={{ marginBottom: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--steel)' }}>
              Coverage for {monthYearLabel(year, month)}
            </div>
            <div style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--navy)', marginTop: '0.2rem' }}>
              {coverageLoading ? '…' : (
                coverage
                  ? `${coverage.coveredCount} of ${coverage.totalEmployees} employees have a published payslip`
                  : '—'
              )}
            </div>
          </div>
          <div
            data-testid="payslip-email-attention-count"
            style={{
              marginLeft: 'auto',
              padding: '0.4rem 0.75rem',
              borderRadius: 8,
              background: attentionCount > 0 ? '#fef2f2' : '#f0fdf4',
              border: `1px solid ${attentionCount > 0 ? '#fecaca' : '#bbf7d0'}`,
              color: attentionCount > 0 ? '#991b1b' : '#166534',
              fontWeight: 700,
              fontSize: '0.92rem',
              display: 'flex', alignItems: 'center', gap: '0.4rem',
            }}
            aria-live="polite"
          >
            <span aria-hidden="true">{attentionCount > 0 ? '⚠' : '✓'}</span>
            <span>
              {attentionCount === 0
                ? 'All emails delivered'
                : `${attentionCount} email${attentionCount === 1 ? '' : 's'} pending or failed`}
            </span>
          </div>
        </div>

        {/* Bulk action row — Publish all drafts + Sweep stuck PENDING. */}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', borderTop: '1px solid #f1f5f9', paddingTop: '0.5rem' }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={handlePublishAll}
            disabled={publishingAll || !coverage || coverage.coveredCount >= coverage.totalEmployees}
            title="Publish every draft payslip for this month"
          >
            {publishingAll ? 'Publishing…' : 'Publish all drafts'}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={handleSweep}
            disabled={sweeping}
            title="Retry every PENDING email older than 5 minutes"
            style={{ color: '#b91c1c' }}
          >
            {sweeping ? 'Sweeping…' : 'Sweep stuck emails'}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => { fetchCoverage(); fetchList(); }}
            title="Re-fetch coverage + list"
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" style={{ color: 'var(--danger)', marginBottom: '0.75rem', fontSize: '0.85rem' }}>
          {error}
        </div>
      )}

      {/* Per-employee coverage list — the operational ground truth. */}
      {coverageLoading && !coverage ? (
        <div className="dpr-card" style={{ textAlign: 'center', color: 'var(--steel)' }}>Loading coverage…</div>
      ) : coverage?.coverage?.length ? (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 360px), 1fr))',
          gap: '0.75rem',
        }}>
          {coverage.coverage.map((c) => {
            const st = c.payslip
              ? (c.payslip.published ? 'PUBLISHED' : 'DRAFT')
              : 'MISSING';
            const badge = st === 'PUBLISHED' ? STATUS_BADGE_STYLES.PUBLISHED
              : st === 'DRAFT' ? STATUS_BADGE_STYLES.DRAFT
              : { background: '#f1f5f9', color: '#475569' };
            const attention = c.payslip && isPayslipEmailAttention(c.payslip.emailStatus);
            return (
              <div
                key={c.employeeId}
                className="dpr-card"
                style={{
                  display: 'flex', flexDirection: 'column', gap: '0.5rem',
                  border: attention ? '1px solid #fecaca' : undefined,
                  background: attention ? '#fffafa' : undefined,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                  <div style={{ minWidth: 0 }}>
                    <span style={{
                      fontSize: '0.65rem', fontWeight: 700,
                      background: badge.background, color: badge.color,
                      padding: '2px 8px', borderRadius: 999,
                      textTransform: 'uppercase', letterSpacing: '0.04em',
                      whiteSpace: 'nowrap',
                    }}>
                      {st === 'PUBLISHED' ? 'Published' : st === 'DRAFT' ? 'Draft' : 'Missing'}
                    </span>
                    <div style={{ marginTop: '0.4rem', color: 'var(--navy)', fontWeight: 600, fontSize: '0.95rem' }}>
                      {c.employeeName || 'Unknown'}
                    </div>
                    <div style={{ color: 'var(--steel)', fontSize: '0.78rem' }}>
                      {c.employeeEmail}
                    </div>
                  </div>
                </div>
                {c.payslip && (
                  <div style={{ fontSize: '0.78rem', color: 'var(--steel)', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                    {c.payslip.published && (
                      <span>Published {formatShortDate(c.payslip.emailSentAt || c.payslip.createdAt)}</span>
                    )}
                    <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                      <span>Email:</span>
                      <EmailPill status={c.payslip.emailStatus} />
                    </div>
                  </div>
                )}
                <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'flex-end', marginTop: '0.25rem', flexWrap: 'wrap' }}>
                  {c.payslip && !c.payslip.published && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => handlePublishRow({ id: c.payslip.id, year, month })}
                      disabled={publishingId === c.payslip.id || !!publishingId}
                    >
                      {publishingId === c.payslip.id ? 'Publishing…' : 'Publish'}
                    </button>
                  )}
                  {c.payslip && c.payslip.published && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => handleResend({ id: c.payslip.id })}
                      disabled={resendingId === c.payslip.id || !!resendingId}
                      title="Re-queue this row's email"
                    >
                      {resendingId === c.payslip.id ? 'Resending…' : 'Resend email'}
                    </button>
                  )}
                  {c.payslip && c.payslip.published && !c.payslip.deletedAt && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => openViewer({
                        id: c.payslip.id,
                        year,
                        month,
                        employeeName: c.employeeName,
                        sizeBytes: c.payslip.sizeBytes,
                      })}
                      disabled={viewerLoading}
                      title="Open the published PDF in a viewer"
                      data-testid="payslip-view-btn"
                    >
                      View
                    </button>
                  )}
                  {c.payslip && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ color: 'var(--danger)' }}
                      onClick={() => openRevoke({
                        id: c.payslip.id,
                        year, month,
                        employeeName: c.employeeName,
                      })}
                    >
                      Revoke
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {/* Lower list — admin filterable browse. Mirrors the admin-list
          shape but is the "give me every row matching X filter" view,
          useful for cross-month audits. */}
      {payslips.length > 0 && (
        <>
          <h2 style={{ color: 'var(--navy)', fontSize: '1.05rem', marginTop: '1.5rem', marginBottom: '0.5rem' }}>
            All payslips ({total})
          </h2>
          {listLoading && payslips.length === 0 ? (
            <div className="dpr-card" style={{ textAlign: 'center', color: 'var(--steel)' }}>Loading…</div>
          ) : (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 360px), 1fr))',
              gap: '0.75rem',
            }}>
              {payslips.map((p) => {
                const st = rowStatus(p);
                const isAttention = isPayslipEmailAttention(p.emailStatus);
                return (
                  <div
                    key={p.id}
                    className="dpr-card"
                    style={{
                      display: 'flex', flexDirection: 'column', gap: '0.5rem',
                      border: isAttention ? '1px solid #fecaca' : undefined,
                      background: isAttention ? '#fffafa' : undefined,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                      <div style={{ minWidth: 0 }}>
                        <StatusPill status={st} />
                        <div style={{ marginTop: '0.4rem', color: 'var(--navy)', fontWeight: 600, fontSize: '0.95rem' }}>
                          {p.recipientName || 'Unknown'} · {monthYearLabel(p.year, p.month)}
                        </div>
                        <div style={{ color: 'var(--steel)', fontSize: '0.78rem' }}>{p.recipientEmail}</div>
                      </div>
                    </div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--steel)', display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                      <EmailPill status={p.emailStatus} />
                      {p.publishedAt && (
                        <span>· published {formatShortDate(p.publishedAt)}</span>
                      )}
                      {p.sizeBytes && <span>· {formatBytes(p.sizeBytes)}</span>}
                    </div>
                    <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'flex-end', marginTop: '0.25rem' }}>
                      {st === 'PUBLISHED' && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => handleResend({ id: p.id })}
                          disabled={resendingId === p.id || !!resendingId}
                        >
                          {resendingId === p.id ? 'Resending…' : 'Resend'}
                        </button>
                      )}
                      {st === 'PUBLISHED' && !p.deletedAt && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => openViewer({
                            id: p.id,
                            year: p.year,
                            month: p.month,
                            employeeName: p.recipientName,
                            sizeBytes: p.sizeBytes,
                          })}
                          disabled={viewerLoading}
                          title="Open the published PDF in a viewer"
                          data-testid="payslip-view-btn-list"
                        >
                          View
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{ color: 'var(--danger)' }}
                        onClick={() => openRevoke({
                          id: p.id, year: p.year, month: p.month, employeeName: p.recipientName,
                        })}
                      >
                        Revoke
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ textAlign: 'center', color: 'var(--steel)', fontSize: '0.8rem', padding: '0.75rem' }}>
            Showing {payslips.length} of {total} payslip{total !== 1 ? 's' : ''}
          </div>
          {nextCursor && (
            <div style={{ textAlign: 'center', paddingBottom: '1rem' }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => fetchList({ append: true, cursor: nextCursor })}
                disabled={listLoadingMore}
              >
                {listLoadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}

      {/* ── Upload modal ────────────────────────────────────────────── */}
      {uploadOpen && (
        <Modal
          open={true}
          onClose={closeUpload}
          ariaLabel="Upload payslip"
          maxWidth={520}
          dismissable={!submitting}
        >
          <h2 style={{ margin: '0 0 0.75rem', color: 'var(--navy)' }}>Upload payslip</h2>
          <p style={{ margin: '0 0 0.75rem', color: 'var(--steel)', fontSize: '0.85rem' }}>
            Upload a PDF for one employee and one month. The server enforces
            a 2 MB cap and a magic-byte check — only true PDFs make it into
            R2.
          </p>

          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', marginBottom: '0.6rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--steel)', fontWeight: 600 }}>Employee</span>
            <select
              className="form-input"
              value={uploadEmployeeId}
              onChange={(e) => setUploadEmployeeId(e.target.value)}
              disabled={submitting || employeesLoading}
            >
              <option value="">{employeesLoading ? 'Loading…' : 'Pick an employee'}</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>{emp.name} ({emp.email})</option>
              ))}
            </select>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', marginBottom: '0.6rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--steel)', fontWeight: 600 }}>PDF file (max 2 MB)</span>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_PAYSLIP_TYPES.join(',')}
              onChange={handleFileChange}
              disabled={submitting}
            />
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.4rem' }}>
            <input
              type="checkbox"
              checked={publishAfterBind}
              onChange={(e) => setPublishAfterBind(e.target.checked)}
              disabled={submitting}
            />
            <span style={{ fontSize: '0.85rem', color: 'var(--navy)' }}>
              Publish + email immediately after upload
            </span>
          </label>

          {submittingLabel && (
            <div role="status" aria-live="polite" style={{
              marginTop: '0.5rem', padding: '0.5rem 0.75rem',
              background: '#f0f9ff', border: '1px solid #bae6fd',
              borderRadius: 6, fontSize: '0.85rem', color: '#075985',
            }}>
              {submittingLabel}
            </div>
          )}

          {/* In-page PDF preview — admin sanity-check the local file
              before clicking Upload. No network call: the bytes are
              still on the admin's machine, served from a `blob:`
              object URL. Revoked on file change, modal close, and
              component unmount (see the revokePreview() wiring at
              openUpload / closeUpload / handleFileChange / the
              unmount useEffect). Non-PDFs never set previewUrl — the
              validation message above is the user-facing signal. */}
          {previewUrl && uploadFile && (
            <div
              data-testid="payslip-preview"
              style={{
                marginTop: '0.75rem',
                border: '1px solid var(--line, #d6dbe2)',
                borderRadius: 6,
                overflow: 'hidden',
                background: '#f8fafc',
              }}
            >
              <div style={{
                padding: '0.5rem 0.75rem',
                background: '#eef2f7',
                borderBottom: '1px solid var(--line, #d6dbe2)',
                fontSize: '0.8rem',
                color: 'var(--navy, #0b2545)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '0.5rem',
                flexWrap: 'wrap',
              }}>
                <span style={{ fontWeight: 600 }}>
                  Preview ·{' '}
                  {(() => {
                    const emp = employees.find((e) => e.id === uploadEmployeeId);
                    return emp ? emp.name : 'recipient';
                  })()}
                  {' · '}
                  {monthYearLabel(year, month)}
                  {' · '}
                  {uploadFile.name} ({formatBytes(uploadFile.size)})
                </span>
                <a
                  href={previewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-ghost btn-sm"
                  data-testid="payslip-preview-open-newtab"
                  aria-label="Open preview in new tab"
                >
                  Open in new tab
                </a>
              </div>
              <object
                data={previewUrl}
                type="application/pdf"
                aria-label={`Preview of ${uploadFile.name}`}
                style={{
                  display: 'block',
                  width: '100%',
                  height: 360,
                  border: 0,
                  background: '#fff',
                }}
              >
                <div style={{ padding: '0.75rem', fontSize: '0.85rem', color: 'var(--steel)' }}>
                  Your browser cannot render this PDF inline.{' '}
                  <a href={previewUrl} target="_blank" rel="noreferrer">
                    Open in new tab
                  </a>{' '}
                  to preview.
                </div>
              </object>
            </div>
          )}

          {uploadError && (
            <div className="portal-auth-error" role="alert" style={{ marginTop: '0.75rem' }}>
              {uploadError}
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
            <button type="button" className="btn btn-secondary" onClick={closeUpload} disabled={submitting}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleUploadSubmit}
              disabled={submitting || !uploadFile || !uploadEmployeeId}
            >
              {submitting ? 'Working…' : 'Upload'}
            </button>
          </div>
        </Modal>
      )}

      {/* ── Revoke confirm modal ────────────────────────────────────── */}
      {confirmRevoke && (
        <div role="alertdialog" aria-labelledby="payslip-revoke-title" aria-describedby="payslip-revoke-desc"
          style={{
            position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 100, padding: '1rem',
          }}
          onClick={(e) => { if (e.target === e.currentTarget && !revoking) closeRevoke(); }}
        >
          <div style={{
            background: '#fff', borderRadius: 12, maxWidth: 460, width: '100%',
            padding: '1.5rem', boxShadow: '0 20px 60px rgba(15,23,42,0.3)',
          }}>
            <h2 id="payslip-revoke-title" style={{ margin: '0 0 0.5rem', color: 'var(--navy)' }}>
              Revoke payslip?
            </h2>
            <p id="payslip-revoke-desc" style={{ margin: '0 0 0.75rem', color: 'var(--steel)', fontSize: '0.88rem' }}>
              This will hide {confirmRevoke.employeeName ? `${confirmRevoke.employeeName}'s ` : ''}payslip for{' '}
              <strong>{monthYearLabel(confirmRevoke.year, confirmRevoke.month)}</strong> from their portal. The
              PDF stays in R2 until the next purge sweep — only the row's `deletedAt` is stamped.
            </p>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', marginBottom: '0.75rem' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--steel)', fontWeight: 600 }}>
                Reason (optional, {MAX_REVOKE_REASON} char max)
              </span>
              <textarea
                className="form-input"
                rows={3}
                maxLength={MAX_REVOKE_REASON}
                placeholder="e.g. Wrong amount — re-uploading corrected PDF"
                value={revokeReason}
                onChange={(e) => setRevokeReason(e.target.value)}
                disabled={revoking}
              />
              <span style={{ fontSize: '0.7rem', color: 'var(--steel)' }}>
                Avoid salary, PAN, UAN, account, or tax keywords — the server rejects
                those so the audit record stays clean.
              </span>
            </label>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary" onClick={closeRevoke} disabled={revoking}>
                Cancel
              </button>
              <button
                type="button"
                className="btn"
                style={{ background: 'var(--danger, #b91c1c)', color: 'white', border: 'none' }}
                onClick={handleRevoke}
                disabled={revoking}
              >
                {revoking ? 'Revoking…' : 'Revoke'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Viewer modal (PUBLISHED rows) ────────────────────────────
          Renders the published PDF in an <object> via a freshly
          minted `blob:` URL. The blob is fetched by
          `api.getAdminPayslipDownload` (openViewer), which routes
          through the shared api.download helper. The modal is gated
          on `viewerRow` so a successful fetch renders the inline
          PDF; a failed fetch tears the modal back down (toast
          carries the user-facing message). A separate "Open in new
          tab" link is the same blob URL with target=_blank for
          browsers without an inline PDF viewer; a "Download" link
          uses the same href with a `download` attribute so the
          browser saves the bytes with a stable filename. The
          filename is hardcoded — the blob has no Content-Disposition
          visible to the browser, so we supply the same
          `Payslip-YYYY-MM.pdf` name the portal route emits. */}
      {viewerRow && (
        <Modal
          open={true}
          onClose={closeViewer}
          ariaLabel="View payslip"
          maxWidth={720}
          dismissable={!viewerLoading}
        >
          <div data-testid="payslip-viewer-modal">
            <h2 style={{ margin: '0 0 0.5rem', color: 'var(--navy)' }}>
              View payslip
            </h2>
            <div style={{ margin: '0 0 0.75rem', color: 'var(--steel)', fontSize: '0.85rem' }}>
              {viewerRow.employeeName ? `${viewerRow.employeeName} · ` : ''}
              {monthYearLabel(viewerRow.year, viewerRow.month)}
              {viewerRow.sizeBytes ? ` · ${formatBytes(viewerRow.sizeBytes)}` : ''}
            </div>

            {viewerLoading && (
              <div className="dpr-card" style={{ textAlign: 'center', color: 'var(--steel)', padding: '1.5rem' }} data-testid="payslip-viewer-loading">
                Loading payslip PDF…
              </div>
            )}

            {!viewerLoading && viewerBlobUrl && (
              <div className="dpr-card" style={{ padding: '0.5rem', background: '#f8fafc' }} data-testid="payslip-viewer-frame">
                <object
                  data={viewerBlobUrl}
                  type="application/pdf"
                  width="100%"
                  height="480"
                  aria-label={`Payslip PDF for ${viewerRow.employeeName || 'employee'} ${monthYearLabel(viewerRow.year, viewerRow.month)}`}
                >
                  <div style={{ padding: '1rem', color: 'var(--steel)' }}>
                    Your browser cannot render this PDF inline.{' '}
                    <a
                      href={viewerBlobUrl}
                      target="_blank"
                      rel="noreferrer"
                      data-testid="payslip-viewer-open-newtab"
                    >
                      Open in new tab
                    </a>{' '}
                    or use Download.
                  </div>
                </object>
              </div>
            )}

            {viewerError && (
              <div className="portal-auth-error" role="alert" style={{ marginTop: '0.75rem' }}>
                {viewerError}
              </div>
            )}

            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem', flexWrap: 'wrap' }}>
              <a
                href={viewerBlobUrl || '#'}
                target="_blank"
                rel="noreferrer"
                className="btn btn-ghost btn-sm"
                data-testid="payslip-viewer-open-newtab-link"
                style={{
                  pointerEvents: viewerBlobUrl ? 'auto' : 'none',
                  opacity: viewerBlobUrl ? 1 : 0.5,
                }}
              >
                Open in new tab
              </a>
              <a
                href={viewerBlobUrl || '#'}
                download={`Payslip-${viewerRow.year}-${String(viewerRow.month).padStart(2, '0')}.pdf`}
                className="btn btn-ghost btn-sm"
                data-testid="payslip-viewer-download-link"
                style={{
                  pointerEvents: viewerBlobUrl ? 'auto' : 'none',
                  opacity: viewerBlobUrl ? 1 : 0.5,
                }}
              >
                Download
              </a>
              <button type="button" className="btn btn-secondary btn-sm" onClick={closeViewer} disabled={viewerLoading}>
                Close
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// Tiny chip helper — mirrors MyCertifications.jsx:556-573.
function FilterChip({ active, onClick, tone, children }) {
  const style = {
    padding: '4px 10px',
    borderRadius: 999,
    border: '1px solid',
    borderColor: active ? (tone ? tone.color : 'var(--navy)') : '#cbd5e1',
    background: active && tone ? tone.background : 'white',
    color: active && tone ? tone.color : 'var(--steel)',
    fontSize: '0.78rem',
    fontWeight: 600,
    cursor: 'pointer',
  };
  return (
    <button type="button" onClick={onClick} style={style} aria-pressed={active}>
      {children}
    </button>
  );
}