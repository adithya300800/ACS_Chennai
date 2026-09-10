// R37: Admin "Billing Certifications" — cross-project, cross-employee
// COP / RA-bill certification register.
//
// Mirrors the ReportsAdmin / DrawingsAdmin registry pattern:
//   - filter toolbar (project, status chips, contractor, date range)
//   - summary tile (per-project totals by status) at the top
//   - card grid (auto-fill, 320px min) with status badge + project name +
//     contractor + bill # + amounts + bill date + View + Certify/Dispute
//     + Archive actions
//   - cursor pagination via "Load more"
//   - empty + loading states
//
// Two modals are embedded (create/edit form + detail view) so we ship
// only one new file instead of three. The create form mirrors
// components/DrawingFormModal.jsx — same 4-step upload pipeline (mint
// SAS via /api/dpr/sas-url, PUT bytes, confirm-upload, POST row); the
// `billing/` prefix is applied server-side via `pathPrefix: 'billing'`.
//
// Sits at /portal/admin/billing-certifications, mounted under
// PortalLayout's admin tree. Backend route is /api/billing-certifications
// (see backend/src/routes/billingCertifications.js) — admin-only, with
// project + recordedBy + certifiedBy joins in the response so the SPA
// never has to resolve UUIDs to labels.
//
// Per the user's "use existing pages, don't over-engineer" guidance
// this page reuses:
//   - api.* helpers from src/lib/api.js (getBillingCertifications,
//     createBillingCertification, certifyBillingCertification, etc.)
//   - BILLING_CERTIFICATION_STATUSES / BILLING_CERTIFICATION_STATUS_LABELS
//     from src/lib/constants.js — single source of truth for status pills.
//   - uploadBlob + the new getBillingCertSasUrl / confirmBillingCertUpload
//     pair (mirrors the Drawing upload pipeline). [DR-016] the `billing/`
//     blob-path prefix is now server-owned — the wrapper sends
//     `pathPrefix: 'billing'` to /api/dpr/sas-url and the dpr mount adds
//     it server-side, so the saved row's blobPath is a real R2 key.
//   - formatShortDate / formatBytes / formatINR from src/lib/format.js.

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
  formatINR,
} from '../../lib/format.js';
import {
  BILLING_CERTIFICATION_STATUSES,
  BILLING_CERTIFICATION_STATUS_LABELS,
  MAX_REPORT_BYTES,
  ACCEPTED_REPORT_TYPES,
} from '../../lib/constants.js';
import {
  uploadBlob,
  DEFAULT_BLOB_UPLOAD_TIMEOUT_MS,
  BlobUploadError,
} from '../../lib/blobUpload.js';

const DEFAULT_LIMIT = 50;

// Status badge styles — 3-state pill colour mapping. Mirrors the DPR /
// Inspection tone vocabulary so admins can scan the card grid by hue.
const STATUS_BADGE_STYLES = {
  DRAFT:     { background: '#f1f5f9', color: '#475569' }, // slate
  CERTIFIED: { background: '#dcfce7', color: '#166534' }, // green
  DISPUTED:  { background: '#fee2e2', color: '#b91c1c' }, // red
};

// Field length caps — must stay in sync with backend FIELD_MAX.
const FIELD_MAX = {
  contractorName: 160,
  billNumber: 60,
  invoiceNo: 60,
  poContractRef: 120,
  remarks: 2000,
  disputeReason: 1000,
};

const todayLocalDate = () => {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  return new Date(d - offset * 60000).toISOString().split('T')[0];
};

function formatDate(value) {
  if (!value) return '—';
  const out = formatShortDate(value);
  return out || String(value);
}

function formatAmount(value) {
  if (value == null) return '—';
  return formatINR(value);
}

// [DR-016] Build the initial form state for the certification modal.
// In create mode it returns the empty defaults (today's date, all
// numeric fields blank). In edit mode it pre-fills from the DRAFT
// row's stored values, including the existing attachment metadata
// (carried separately so the file input shows the current PDF and a
// "Replace" prompt).
function initialiseFormState(initialCert, mode) {
  if (mode !== 'edit' || !initialCert) {
    return {
      projectId: '',
      contractorName: '',
      billNumber: '',
      billDate: todayLocalDate(),
      invoiceNo: '',
      poContractRef: '',
      claimedAmount: '',
      deductedAmount: '',
      certifiedAmount: '',
      gstAmount: '',
      poValue: '',
      balanceValue: '',
      remarks: '',
    };
  }
  const c = initialCert;
  return {
    projectId: c.projectId || '',
    contractorName: c.contractorName || '',
    billNumber: c.billNumber || '',
    // billDate is a YYYY-MM-DD string in the API; the date input
    // expects the same shape so we pass it through verbatim.
    billDate: c.billDate || todayLocalDate(),
    invoiceNo: c.invoiceNo || '',
    poContractRef: c.poContractRef || '',
    // The form stores amounts as strings so the user can clear /
    // retype them. Empty string → null on the wire; finite number
    // → the number. The backend's parseAmount rejects NaN with
    // 400 INVALID_* so a partial edit doesn't silently record 0.
    claimedAmount: c.claimedAmount != null ? String(c.claimedAmount) : '',
    deductedAmount: c.deductedAmount != null ? String(c.deductedAmount) : '',
    certifiedAmount: c.certifiedAmount != null ? String(c.certifiedAmount) : '',
    gstAmount: c.gstAmount != null ? String(c.gstAmount) : '',
    poValue: c.poValue != null ? String(c.poValue) : '',
    balanceValue: c.balanceValue != null ? String(c.balanceValue) : '',
    remarks: c.remarks || '',
  };
}

// Build the project / recordedBy / certifiedBy filter URL params. Same
// shape the backend takes — empty filters are ignored by the server.
function buildListParams({
  projectId, status, contractorName, fromDate, toDate, cursor,
}) {
  const params = { limit: String(DEFAULT_LIMIT) };
  if (projectId) params.projectId = projectId;
  if (status) params.status = status;
  if (contractorName && contractorName.trim()) params.contractorName = contractorName.trim();
  if (fromDate) params.from = fromDate;
  if (toDate) params.to = toDate;
  if (cursor) params.cursor = cursor;
  return params;
}

export default function BillingCertificationsAdmin() {
  useDocumentTitle('Billing Certifications');
  const { employee, accessToken } = useAuth();
  const toast = useToast();

  // Filter state.
  const [projects, setProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectId, setProjectId] = useState('');
  const [status, setStatus] = useState(''); // '' = all
  const [contractorName, setContractorName] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  // [DR-029] Aggregate panel state — tracks load status + the most recent
  // good snapshot so the per-project totals refresh on every mutation
  // (create / certify / dispute / correct / archive) and a late or failed
  // request can't overwrite newer data. `data` is the last-known good
  // payload, used by the panel even when the latest request errors out
  // (so a transient 503 doesn't blank out the dashboard).
  const [aggregateState, setAggregateState] = useState({
    status: 'idle', // 'idle' | 'loading' | 'ok' | 'error'
    data: [],
    error: null,
  });
  // Monotonic request id — incremented on every aggregate fetch. The
  // response handler checks `aggregateReqIdRef.current` against the id
  // captured at request start; if a newer request fired while this one
  // was in flight, we discard the result.
  const aggregateReqIdRef = useRef(0);

  // Pagination + data state.
  const [certs, setCerts] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [total, setTotal] = useState(0);
  const [summaryByStatus, setSummaryByStatus] = useState(null);
  // [DR-021] Top-level summary envelope — distinct labels for
  // all-status context vs certified liability vs disputed amounts so
  // the admin sees three separate figures, not a single "sum-of-rows"
  // that mixes payable liability with disputed / draft amounts.
  const [summaryTotals, setSummaryTotals] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  // Modal state.
  const [createOpen, setCreateOpen] = useState(false);
  const [detailCert, setDetailCert] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(null);
  const [archiving, setArchiving] = useState(false);
  const [transitionPending, setTransitionPending] = useState(false);
  const [disputeOpen, setDisputeOpen] = useState(null);
  const [disputeReason, setDisputeReason] = useState('');
  const [disputeSubmitting, setDisputeSubmitting] = useState(false);
  // [DR-016] Edit-correction / abandon-correction modal state.
  // `editingCert` opens the shared form modal in edit mode prefilled
  // from the correction DRAFT. `abandoningCert` confirms the
  // user-initiated discard of a correction DRAFT (does NOT restore
  // the original — closing the modal without abandoning is NOT a
  // silent cancel; the original stays superseded until the chain
  // runs again).
  const [editingCert, setEditingCert] = useState(null);
  const [abandoningCert, setAbandoningCert] = useState(null);
  const [abandoning, setAbandoning] = useState(false);

  // ─── Loaders ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!employee?.isAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getProjects(accessToken);
        if (cancelled) return;
        const list = (data?.projects || []).filter((p) => p.isActive);
        setProjects(list);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load projects');
      } finally {
        if (!cancelled) setProjectsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [accessToken]);

  const fetchCerts = useCallback(async ({ append = false, cursor = null } = {}) => {
    if (append) setLoadingMore(true); else setLoading(true);
    setError('');
    try {
      const params = buildListParams({
        projectId, status, contractorName, fromDate, toDate, cursor,
      });
      const data = await api.getBillingCertifications(params, accessToken);
      const items = data?.certifications || [];
      setCerts((prev) => (append ? [...prev, ...items] : items));
      setNextCursor(data?.nextCursor || null);
      // [DR-021] Totals + per-status summary describe the FULL filtered
      // population. The server already separates count + sums from the
      // cursor predicate (see backend/src/routes/billingCertifications.js),
      // so the response is invariant under `cursor`. We still gate the
      // setter on `!append` because the UI must not visibly flicker
      // (a 50ms replace during Load more would briefly show the same
      // number, but it's safer to just not call setState when nothing
      // changed). The mutation handlers below do a full non-append
      // fetchCerts() after POST/PATCH/certify/dispute/correct/delete,
      // so the post-mutation totals stay current.
      if (!append) {
        setTotal(data?.total || 0);
        setSummaryByStatus(data?.summary?.byStatus || null);
        setSummaryTotals(data?.summary || null);
      }
    } catch (err) {
      setError(err?.message || 'Failed to load billing certifications');
      if (!append) {
        setCerts([]);
        setNextCursor(null);
        setTotal(0);
        setSummaryByStatus(null);
        setSummaryTotals(null);
      }
    } finally {
      if (append) setLoadingMore(false); else setLoading(false);
    }
  }, [projectId, status, contractorName, fromDate, toDate, accessToken]);

  useEffect(() => {
    if (!employee?.isAdmin) return;
    fetchCerts();
  }, [fetchCerts, employee?.isAdmin]);

  // [DR-029] Aggregates (per-project totals) — extracted from the original
  // useEffect so the mutation handlers (create / certify / dispute /
  // correct / archive) can invoke the same loader. Guarded by a
  // monotonic request id so a late response from an older call can't
  // clobber the newer one. Errors are surfaced to the UI as
  // stale/error + Retry instead of being swallowed to the console, so a
  // 503 doesn't leave the panel showing a 2-minute-old count.
  const fetchAggregates = useCallback(async () => {
    const reqId = ++aggregateReqIdRef.current;
    setAggregateState((prev) => ({ ...prev, status: 'loading', error: null }));
    try {
      const params = {};
      if (fromDate) params.from = fromDate;
      if (toDate) params.to = toDate;
      const data = await api.getBillingCertificationAggregates(params, accessToken);
      // Stale-response guard: a newer request fired while this one was
      // in flight. Discard — the newer call will own the state.
      if (reqId !== aggregateReqIdRef.current) return;
      setAggregateState({
        status: 'ok',
        data: data?.projects || [],
        error: null,
      });
    } catch (err) {
      if (reqId !== aggregateReqIdRef.current) return;
      // Keep the last good `data` so the panel stays renderable; just
      // mark the status as error so the banner + Retry appear.
      setAggregateState((prev) => ({
        ...prev,
        status: 'error',
        error: err?.message || 'Failed to refresh aggregates',
      }));
    }
  }, [accessToken, fromDate, toDate]);

  useEffect(() => {
    if (!employee?.isAdmin) return;
    fetchAggregates();
  }, [fetchAggregates, employee?.isAdmin]);

  // ─── Filter handlers ───────────────────────────────────────────────
  function clearAllFilters() {
    setProjectId('');
    setStatus('');
    setContractorName('');
    setFromDate('');
    setToDate('');
  }
  const anyFilterActive = projectId || status || contractorName || fromDate || toDate;

  // ─── Detail modal ───────────────────────────────────────────────────
  async function openDetail(cert) {
    setDetailCert(cert);
    setDetailLoading(true);
    try {
      const full = await api.getBillingCertification(cert.id, accessToken);
      setDetailCert(full);
    } catch (err) {
      toast.push(err?.message || 'Failed to load certification', 'error');
      setDetailCert(null);
    } finally {
      setDetailLoading(false);
    }
  }
  function closeDetail() {
    setDetailCert(null);
    setDisputeOpen(null);
    setDisputeReason('');
  }

  // ─── Certify / dispute actions ─────────────────────────────────────
  async function handleCertify(cert) {
    setTransitionPending(true);
    try {
      // [DR-015] Pin the displayed version on the /certify call. A stale
      // tab whose read happened before another admin's certify or
      // correction gets 409 instead of silently flipping the row.
      const updated = await api.certifyBillingCertification(cert.id, cert.version, accessToken);
      toast.push(`Bill ${updated.billNumber} marked Certified.`, 'success');
      // If the detail modal is open on this row, update it in place; otherwise refetch the list.
      if (detailCert && detailCert.id === cert.id) setDetailCert(updated);
      await fetchCerts();
      // [DR-029] Re-pull per-project aggregates so the panel reflects
      // the new status split without a manual reload.
      await fetchAggregates();
    } catch (err) {
      toast.push(err?.message || 'Failed to certify', 'error');
    } finally {
      setTransitionPending(false);
    }
  }

  // [DR-019] Draft correction flow. Creates a NEW DRAFT row pointing
  // back at the original via parentCertificationId, stamps supersededAt
  // on the original in the same transaction, and returns the new row.
  // We open the new row in the detail modal so the admin can immediately
  // edit + re-certify it. The original is preserved verbatim — prior
  // amounts / PDF / reasons / actors all stay intact for audit.
  async function handleCorrect(cert) {
    if (transitionPending) return;
    setTransitionPending(true);
    try {
      // [DR-015] Pin the displayed version on the /correct call. A stale tab
      // whose read happened before another admin's correction will get
      // 409 instead of silently creating a duplicate correction chain.
      const newRow = await api.correctBillingCertification(cert.id, cert.version, accessToken);
      toast.push(
        `Opened correction DRAFT for bill ${newRow.billNumber}. Edit amounts, then re-certify.`,
        'success',
      );
      // Switch the detail modal to the new row so the admin can start
      // editing immediately. Close any dispute modal that was open on
      // the old row.
      setDetailCert(newRow);
      setDisputeOpen(null);
      setDisputeReason('');
      await fetchCerts();
      // [DR-029] Correction creates a new DRAFT row + supersedes the
      // original — the aggregate count and status mix both change.
      await fetchAggregates();
    } catch (err) {
      // 409 SUPERSEDED — the original was already superseded by
      // another admin's correction. Refetch and surface a helpful
      // message rather than the raw error.
      const code = err?.code || err?.body?.code;
      if (code === 'SUPERSEDED') {
        toast.push('This certification is already superseded. Opening the latest version.', 'warning');
        await fetchCerts();
        // [DR-029] Supersede path also mutates the project totals.
        await fetchAggregates();
      } else {
        toast.push(err?.message || err?.body?.message || 'Failed to start correction', 'error');
      }
    } finally {
      setTransitionPending(false);
    }
  }

  async function handleDisputeSubmit() {
    if (!disputeOpen) return;
    if (!disputeReason.trim()) {
      toast.push('Dispute reason is required', 'error');
      return;
    }
    setDisputeSubmitting(true);
    try {
      // [DR-015] Pin the displayed version on the /dispute call. Same
      // rationale as handleCertify — stale-tab protection.
      const updated = await api.disputeBillingCertification(
        disputeOpen.id, disputeReason.trim(), disputeOpen.version, accessToken,
      );
      toast.push(`Bill ${updated.billNumber} marked Disputed.`, 'success');
      if (detailCert && detailCert.id === disputeOpen.id) setDetailCert(updated);
      setDisputeOpen(null);
      setDisputeReason('');
      await fetchCerts();
      // [DR-029] Dispute moves a row from CERTIFIED → DISPUTED in the
      // aggregate breakdown.
      await fetchAggregates();
    } catch (err) {
      toast.push(err?.message || 'Failed to dispute', 'error');
    } finally {
      setDisputeSubmitting(false);
    }
  }

  // ─── Archive ─────────────────────────────────────────────────────────
  async function handleArchive() {
    if (!confirmArchive) return;
    setArchiving(true);
    try {
      await api.deleteBillingCertification(confirmArchive.id, accessToken);
      toast.push(`Bill ${confirmArchive.billNumber} archived.`, 'success');
      setConfirmArchive(null);
      if (detailCert && detailCert.id === confirmArchive.id) setDetailCert(null);
      await fetchCerts();
      // [DR-029] Archive (soft delete) removes the row from the
      // aggregate's active set — the panel's per-project count drops
      // immediately, no manual reload required.
      await fetchAggregates();
    } catch (err) {
      toast.push(err?.message || 'Failed to archive', 'error');
    } finally {
      setArchiving(false);
    }
  }

  // [DR-016] Correction lifecycle helpers — make the DRAFT correction
  // editable, reachable, and reversible from the admin UI. The
  // correction row already exists (POST /:id/correct minted it in the
  // same transaction that superseded the original); these handlers
  // close the loop the audit flagged:
  //   • Edit: re-opens the same form in PATCH mode, prefilled from the
  //     DRAFT, with the displayed version pinned (DR-015 wire shape)
  //     so a stale tab cannot overwrite a concurrent PATCH / certify /
  //     dispute on the same DRAFT.
  //   • View original: re-loads the detail modal onto the parent row so
  //     the admin can walk the correction chain forward and backward.
  //   • Abandon correction: soft-deletes the DRAFT. The original stays
  //     superseded (the supersede stamp does NOT auto-revert) — the
  //     audit's "concurrent undo/approval cannot restore the wrong
  //     version" requirement is satisfied because the soft-delete is
  //     a one-shot tombstone on this DRAFT, not a fork that competes
  //     with future certifies. To re-activate the original after an
  //     abandon, correct it again from the successor row.

  function openEdit(cert) {
    setEditingCert(cert);
  }

  async function openOriginal(cert) {
    if (!cert?.parentCertificationId) return;
    const parentId = cert.parentCertificationId;
    setDetailLoading(true);
    try {
      const parent = await api.getBillingCertification(parentId, accessToken);
      // Walk to the parent row in-place — keeps the modal open, just
      // swaps the cert it shows. The back-link to the child is
      // preserved on the loaded parent (its parentCertificationId
      // points at the cert we came from).
      setDetailCert(parent);
    } catch (err) {
      toast.push(err?.message || 'Failed to load parent certification', 'error');
    } finally {
      setDetailLoading(false);
    }
  }

  async function handleAbandon() {
    if (!abandoningCert) return;
    setAbandoning(true);
    try {
      await api.deleteBillingCertification(abandoningCert.id, accessToken);
      toast.push(
        `Correction DRAFT for bill ${abandoningCert.billNumber} abandoned. The original row stays superseded — correct it again from the latest successor to re-activate.`,
        'warning',
      );
      setAbandoningCert(null);
      // Close the detail modal if it was open on this row.
      if (detailCert && detailCert.id === abandoningCert.id) setDetailCert(null);
      await fetchCerts();
      // [DR-029] Abandoning removes the DRAFT from the aggregate set
      // (it was a row in the project; soft-delete hides it).
      await fetchAggregates();
    } catch (err) {
      toast.push(err?.message || 'Failed to abandon correction', 'error');
    } finally {
      setAbandoning(false);
    }
  }

  // ─── View attached PDF ──────────────────────────────────────────────
  async function handleViewPdf(cert) {
    if (!cert.blobPath) {
      toast.push('No PDF attached', 'error');
      return;
    }
    try {
      const { sasUrl } = await api.getBillingCertificationReadSas(cert.id, accessToken);
      window.open(sasUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      toast.push(err?.message || 'Could not open file', 'error');
    }
  }

  // ─── Render ─────────────────────────────────────────────────────────
  // DR-018 fix (frontend half): admin-only ledger — non-admins get a clear
  // "access required" state instead of the admin shell with admin actions.
  // Mirrors the DprDashboard.jsx render-time guard. The three useEffect
  // loaders above also early-return on `!employee?.isAdmin` so a non-admin
  // direct-navigation here doesn't fire any 401-bound fetches.
  if (!employee?.isAdmin) {
    return (
      <div className="dpr-page">
        <div className="dpr-card" style={{ textAlign: 'center', padding: '3rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🔒</div>
          <h2 style={{ color: 'var(--navy)', marginBottom: '0.5rem' }}>Admin Access Required</h2>
          <p style={{ color: 'var(--steel)' }}>
            You need admin privileges to access the Billing Certifications register.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="dpr-page">
      <div className="dpr-page-header">
        <div>
          <Breadcrumb
            items={[
              { label: 'Admin Overview', to: '/portal/admin' },
              { label: 'Billing Certifications' },
            ]}
          />
          <h1 className="dpr-page-title">Billing Certifications</h1>
          <p style={{ color: 'var(--steel)', fontSize: '0.9rem', margin: 0 }}>
            Internal register of contractor RA-bill (COP) certifications
            across all projects. Use the filters to narrow by project,
            status, contractor, or date range. The portal records the
            certification result — the actual bill calculation lives in
            the ACS Excel workbook emailed between project teams.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setCreateOpen(true)}
          disabled={projectsLoading}
        >
          + Add certification
        </button>
      </div>

      {/* ─── Aggregates summary tile ───────────────────────────────────── */}
      {/* [DR-021] Three distinct figures — all-status context (sum-of-
          recordValues across statuses), certified liability (CERTIFIED
          only), and disputed amounts (DISPUTED only) — so the admin
          doesn't conflate payable liability with disputed or in-flight
          draft amounts. The per-status breakdown below preserves the
          count + per-status sum so DRAFT / CERTIFIED / DISPUTED still
          read as a triplet. */}
      {summaryByStatus && (
        <div
          className="dpr-card"
          style={{
            marginBottom: '1rem',
            display: 'grid',
            gap: '0.75rem',
          }}
        >
          <div
            data-testid="bc-summary-totals"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: '0.75rem',
            }}
          >
            <div>
              <div style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--steel)' }}>
                All status (context)
              </div>
              <div style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--navy)', marginTop: '0.2rem' }}>
                {formatINR((summaryTotals && summaryTotals.totalCertifiedAllStatus) || 0)}
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--steel)', marginTop: '0.15rem' }}>
                Sum-of-recordValues across DRAFT + CERTIFIED + DISPUTED
              </div>
            </div>
            <div>
              <div style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: '#166534' }}>
                Certified liability
              </div>
              <div style={{ fontSize: '1.05rem', fontWeight: 700, color: '#166534', marginTop: '0.2rem' }}>
                {formatINR((summaryTotals && summaryTotals.totalCertifiedLiability) || 0)}
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--steel)', marginTop: '0.15rem' }}>
                CERTIFIED sum only — payable against POs
              </div>
            </div>
            <div>
              <div style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: '#b91c1c' }}>
                Disputed amounts
              </div>
              <div style={{ fontSize: '1.05rem', fontWeight: 700, color: '#b91c1c', marginTop: '0.2rem' }}>
                {formatINR((summaryTotals && summaryTotals.totalCertifiedDisputed) || 0)}
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--steel)', marginTop: '0.15rem' }}>
                DISPUTED sum only — withheld pending resolution
              </div>
            </div>
          </div>
          <div
            data-testid="bc-summary-by-status"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: '0.75rem',
              borderTop: '1px solid #f1f5f9',
              paddingTop: '0.6rem',
            }}
          >
            {Object.values(BILLING_CERTIFICATION_STATUSES).map((s) => {
              const cfg = BILLING_CERTIFICATION_STATUS_LABELS[s];
              const cell = summaryByStatus[s] || { count: 0, totalCertified: 0 };
              return (
                <div key={s} style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--steel)' }}>
                    {cfg.label}
                  </div>
                  <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--navy)', marginTop: '0.2rem' }}>
                    {cell.count}
                  </div>
                  <div style={{ fontSize: '0.78rem', color: 'var(--steel)', marginTop: '0.15rem' }}>
                    {formatINR(cell.totalCertified || 0)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ─── Filter toolbar ───────────────────────────────────────────── */}
      <div className="dpr-card" style={{ marginBottom: '1rem' }}>
        <div className="form-row" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: '0.75rem' }}>
          <div className="form-group" style={{ flex: '2 1 220px', minWidth: 200 }}>
            <label htmlFor="bc-project">Project</label>
            <select
              id="bc-project"
              className="form-input"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              disabled={projectsLoading}
            >
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.code ? ` (${p.code})` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group" style={{ flex: '2 1 200px', minWidth: 180 }}>
            <label htmlFor="bc-contractor">Contractor</label>
            <input
              id="bc-contractor"
              type="search"
              className="form-input"
              value={contractorName}
              onChange={(e) => setContractorName(e.target.value)}
              placeholder="e.g. Ponni"
              maxLength={FIELD_MAX.contractorName}
            />
          </div>
          <div className="form-group" style={{ flex: '1 1 140px', minWidth: 140 }}>
            <label htmlFor="bc-from">From</label>
            <input
              id="bc-from"
              type="date"
              className="form-input"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              max={toDate || undefined}
            />
          </div>
          <div className="form-group" style={{ flex: '1 1 140px', minWidth: 140 }}>
            <label htmlFor="bc-to">To</label>
            <input
              id="bc-to"
              type="date"
              className="form-input"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              min={fromDate || undefined}
            />
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center', marginTop: '0.6rem' }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--steel)', marginRight: '0.25rem' }}>Status:</span>
          {Object.values(BILLING_CERTIFICATION_STATUSES).map((s) => {
            const cfg = BILLING_CERTIFICATION_STATUS_LABELS[s];
            const active = status === s;
            return (
              <button
                key={s}
                type="button"
                aria-pressed={active}
                onClick={() => setStatus(active ? '' : s)}
                style={{
                  fontSize: '0.72rem',
                  fontWeight: 600,
                  padding: '0.2rem 0.6rem',
                  borderRadius: 999,
                  border: '1px solid ' + (active ? 'var(--brand, #0066ff)' : '#cbd5e1'),
                  background: active ? STATUS_BADGE_STYLES[s].background : 'white',
                  color: active ? STATUS_BADGE_STYLES[s].color : 'var(--steel, #64748b)',
                  cursor: 'pointer',
                }}
              >
                {cfg.label}
              </button>
            );
          })}
          {anyFilterActive && (
            <button
              type="button"
              onClick={clearAllFilters}
              style={{
                marginLeft: 'auto',
                fontSize: '0.72rem',
                padding: '0.2rem 0.6rem',
                borderRadius: 999,
                border: '1px solid #cbd5e1',
                background: 'white',
                color: 'var(--steel, #64748b)',
                cursor: 'pointer',
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="portal-auth-error" role="alert" style={{ marginBottom: '1rem' }}>
          {error}
        </div>
      )}

      {/* ─── States ────────────────────────────────────────────────────── */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--steel)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>⏳</div>
          Loading certifications...
        </div>
      ) : certs.length === 0 ? (
        <div className="dpr-list-empty">
          <div style={{ marginBottom: '1rem', color: 'var(--steel)', fontSize: '2rem' }}>🧾</div>
          <h3 style={{ color: 'var(--navy)', marginBottom: '0.5rem' }}>
            {anyFilterActive ? 'No certifications match the current filters' : 'No certifications recorded yet'}
          </h3>
          <p style={{ color: 'var(--steel)' }}>
            {anyFilterActive
              ? 'Try widening the date range or clearing the project / contractor filter.'
              : 'Use "+ Add certification" to record the first RA-bill (COP) outcome.'}
          </p>
        </div>
      ) : (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))',
              gap: '0.75rem',
            }}
          >
            {certs.map((c) => {
              const badge = STATUS_BADGE_STYLES[c.status] || STATUS_BADGE_STYLES.DRAFT;
              const label = BILLING_CERTIFICATION_STATUS_LABELS[c.status]?.label || c.status;
              return (
                <div
                  key={c.id}
                  className="dpr-card"
                  style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}
                >
                  {/* Header: status badge + project name */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <div style={{ minWidth: 0 }}>
                      <span
                        style={{
                          fontSize: '0.65rem',
                          fontWeight: 700,
                          background: badge.background,
                          color: badge.color,
                          padding: '2px 8px',
                          borderRadius: 999,
                          textTransform: 'uppercase',
                          letterSpacing: '0.04em',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {label}
                      </span>
                      <div style={{ marginTop: '0.4rem', color: 'var(--navy)', fontWeight: 600, fontSize: '0.95rem' }}>
                        {c.project?.name || 'Unknown project'}
                        {c.project?.code ? <span style={{ color: 'var(--steel)', fontWeight: 400 }}> ({c.project.code})</span> : null}
                      </div>
                    </div>
                  </div>

                  {/* Contractor + bill # */}
                  <div style={{ fontSize: '0.85rem', color: 'var(--navy)' }}>
                    <div style={{ fontWeight: 600 }}>
                      {c.contractorName}
                    </div>
                    <div style={{ color: 'var(--steel)', fontSize: '0.78rem' }}>
                      Bill {c.billNumber} · {formatDate(c.billDate)}
                    </div>
                  </div>

                  {/* Amounts */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', fontSize: '0.78rem', color: 'var(--steel)' }}>
                    <span title="Claimed amount">📋 {formatAmount(c.claimedAmount)}</span>
                    <span title="Deducted amount">➖ {formatAmount(c.deductedAmount)}</span>
                    <span title="Certified amount" style={{ color: 'var(--navy)', fontWeight: 600 }}>
                      ✅ {formatAmount(c.certifiedAmount)}
                    </span>
                  </div>

                  {/* Attachment + recorder */}
                  <div style={{ fontSize: '0.75rem', color: 'var(--steel)', display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                    {c.blobPath ? (
                      <span title={c.filename}>📎 {c.filename || 'PDF attached'}</span>
                    ) : (
                      <span style={{ color: '#94a3b8' }}>📎 no PDF</span>
                    )}
                    <span title={c.recordedBy?.name || c.recordedBy?.email || c.recordedById}>
                      👤 {c.recordedBy?.name || c.recordedBy?.email || '—'}
                    </span>
                  </div>

                  {/* Actions */}
                  <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'flex-end', marginTop: '0.25rem' }}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => openDetail(c)}
                      aria-label={`View ${c.billNumber}`}
                    >
                      View
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ color: 'var(--muted, #64748b)' }}
                      onClick={() => setConfirmArchive(c)}
                      aria-label={`Archive ${c.billNumber}`}
                    >
                      Archive
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ textAlign: 'center', color: 'var(--steel)', fontSize: '0.8rem', padding: '0.75rem' }}>
            Showing {certs.length} of {total} certification{total !== 1 ? 's' : ''}
          </div>

          {nextCursor && (
            <div style={{ textAlign: 'center', paddingBottom: '1rem' }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => fetchCerts({ append: true, cursor: nextCursor })}
                disabled={loadingMore}
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}

      {/* ─── Per-project aggregates (collapsible list) ─────────────────── */}
      {/* [DR-029] Panel renders whenever we have data OR an error to
          surface. A failed refresh keeps the last good totals on screen
          and tacks on a "couldn't refresh — Retry" banner instead of
          silently going blank. */}
      {(aggregateState.data.length > 0 || aggregateState.status === 'error') && (
        <details
          className="dpr-card"
          data-testid="bc-aggregates-panel"
          style={{ marginTop: '1rem' }}
        >
          <summary style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--navy)' }}>
            Per-project totals ({aggregateState.data.length})
            {aggregateState.status === 'loading' && (
              <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', color: 'var(--steel)', fontWeight: 400 }}>
                · refreshing…
              </span>
            )}
          </summary>
          {aggregateState.status === 'error' && (
            <div
              role="alert"
              data-testid="bc-aggregates-stale"
              style={{
                marginTop: '0.6rem',
                padding: '0.5rem 0.75rem',
                background: '#fef2f2',
                border: '1px solid #fecaca',
                borderRadius: 6,
                fontSize: '0.8rem',
                color: '#7f1d1d',
                display: 'flex',
                gap: '0.75rem',
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <span>Couldn't refresh per-project totals — showing last known values. ({aggregateState.error})</span>
              <button
                type="button"
                className="btn btn-sm"
                style={{ background: '#b91c1c', color: 'white', border: 'none' }}
                onClick={() => fetchAggregates()}
              >
                Retry
              </button>
            </div>
          )}
          {aggregateState.data.length > 0 && (
            <div style={{ marginTop: '0.6rem', display: 'grid', gap: '0.4rem' }}>
              {aggregateState.data.map((row) => (
                <div
                  key={row.projectId}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '2fr repeat(4, 1fr)',
                    gap: '0.5rem',
                    fontSize: '0.82rem',
                    alignItems: 'center',
                    padding: '0.3rem 0',
                    borderBottom: '1px solid #f1f5f9',
                  }}
                >
                  <span style={{ color: 'var(--navy)', fontWeight: 600 }}>
                    {row.projectName}
                    {row.projectCode ? <span style={{ color: 'var(--steel)', fontWeight: 400 }}> ({row.projectCode})</span> : null}
                  </span>
                  <span style={{ color: 'var(--steel)' }}>{row.totals.count} bill{row.totals.count !== 1 ? 's' : ''}</span>
                  <span>{formatAmount(row.totals.totalClaimed)}</span>
                  <span style={{ color: '#b91c1c' }}>−{formatAmount(row.totals.totalDeducted)}</span>
                  <span style={{ fontWeight: 700, color: '#166534' }}>{formatAmount(row.totals.totalCertified)}</span>
                </div>
              ))}
            </div>
          )}
        </details>
      )}

      {/* ─── Create / edit modal ──────────────────────────────────────── */}
      {createOpen && (
        <CertificationFormModal
          accessToken={accessToken}
          projects={projects}
          projectsLoading={projectsLoading}
          onClose={() => setCreateOpen(false)}
          onSaved={async (created) => {
            setCreateOpen(false);
            toast.push(`Bill ${created.billNumber} recorded.`, 'success');
            await fetchCerts();
            // [DR-029] A new row joins the project aggregate (and may
            // be the very first row for a project, in which case the
            // aggregates panel grows by one).
            await fetchAggregates();
          }}
          onError={(msg) => toast.push(msg, 'error')}
        />
      )}

      {/* ─── Detail modal ─────────────────────────────────────────────── */}
      {detailCert && (
        <Modal
          open={true}
          onClose={closeDetail}
          ariaLabel={`Certification ${detailCert.billNumber}`}
          maxWidth={720}
        >
          <h2 style={{ margin: '0 0 0.75rem', color: 'var(--navy)' }}>
            Certification — Bill {detailCert.billNumber}
          </h2>
          {detailLoading ? (
            <div style={{ padding: '1.5rem', color: 'var(--steel)', textAlign: 'center' }}>Loading…</div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', marginBottom: '0.75rem' }}>
                <span
                  style={{
                    fontSize: '0.72rem',
                    fontWeight: 700,
                    background: STATUS_BADGE_STYLES[detailCert.status]?.background,
                    color: STATUS_BADGE_STYLES[detailCert.status]?.color,
                    padding: '2px 10px',
                    borderRadius: 999,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}
                >
                  {BILLING_CERTIFICATION_STATUS_LABELS[detailCert.status]?.label || detailCert.status}
                </span>
                <span style={{ color: 'var(--steel)', fontSize: '0.85rem' }}>
                  {detailCert.project?.name}{detailCert.project?.code ? ` (${detailCert.project.code})` : ''}
                </span>
              </div>

              <DetailRow label="Contractor" value={detailCert.contractorName} />
              <DetailRow label="Bill number" value={detailCert.billNumber} />
              <DetailRow label="Bill date" value={formatDate(detailCert.billDate)} />
              <DetailRow label="Invoice no." value={detailCert.invoiceNo || '—'} />
              <DetailRow label="PO / Contract ref" value={detailCert.poContractRef || '—'} />
              <DetailRow label="PO value" value={formatAmount(detailCert.poValue)} />
              <DetailRow label="Claimed amount" value={formatAmount(detailCert.claimedAmount)} />
              <DetailRow label="Deducted amount" value={formatAmount(detailCert.deductedAmount)} />
              <DetailRow label="Certified amount" value={<strong>{formatAmount(detailCert.certifiedAmount)}</strong>} />
              <DetailRow label="GST amount" value={formatAmount(detailCert.gstAmount)} />
              <DetailRow label="Balance value" value={formatAmount(detailCert.balanceValue)} />
              {detailCert.remarks && <DetailRow label="Remarks" value={detailCert.remarks} />}
              <DetailRow label="Recorded by" value={detailCert.recordedBy?.name || '—'} />
              <DetailRow
                label="Certified by"
                value={detailCert.certifiedBy ? `${detailCert.certifiedBy.name} on ${formatDate(detailCert.certifiedAt)}` : '—'}
              />
              {detailCert.disputedAt && (
                <DetailRow
                  label="Dispute"
                  value={`${formatDate(detailCert.disputedAt)} — ${detailCert.disputeReason || '(no reason recorded)'}`}
                />
              )}

              {detailCert.blobPath && (
                <div style={{ marginTop: '0.75rem', fontSize: '0.85rem' }}>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleViewPdf(detailCert)}>
                    📄 Open attached PDF
                  </button>
                </div>
              )}

              {/* Dispute inline form */}
              {disputeOpen && disputeOpen.id === detailCert.id && (
                <div style={{ marginTop: '0.75rem', padding: '0.75rem', borderRadius: 8, border: '1px solid #fecaca', background: '#fff1f2' }}>
                  <label htmlFor="dispute-reason" style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', color: '#7f1d1d', marginBottom: '0.3rem' }}>
                    Dispute reason *
                  </label>
                  <textarea
                    id="dispute-reason"
                    className="form-input"
                    rows={3}
                    value={disputeReason}
                    onChange={(e) => setDisputeReason(e.target.value)}
                    maxLength={FIELD_MAX.disputeReason}
                  />
                  <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setDisputeOpen(null); setDisputeReason(''); }}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ background: '#b91c1c', color: 'white', border: 'none' }}
                      disabled={disputeSubmitting || !disputeReason.trim()}
                      onClick={handleDisputeSubmit}
                    >
                      {disputeSubmitting ? 'Submitting…' : 'Mark Disputed'}
                    </button>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem', flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-secondary" onClick={closeDetail}>Close</button>
                {detailCert.status !== 'CERTIFIED' && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={transitionPending}
                    onClick={() => handleCertify(detailCert)}
                  >
                    {transitionPending ? 'Working…' : 'Mark Certified'}
                  </button>
                )}
                {detailCert.status === 'CERTIFIED' && (
                  <button
                    type="button"
                    className="btn"
                    style={{ background: '#b91c1c', color: 'white', border: 'none' }}
                    disabled={transitionPending}
                    onClick={() => setDisputeOpen(detailCert)}
                  >
                    Mark Disputed
                  </button>
                )}
                {/* [DR-019] "Correct certification" — opens a new DRAFT
                    row that carries the original's amounts forward verbatim
                    so the admin can re-edit + re-certify. The original
                    stays in the audit trail (supersededAt is stamped on
                    the server). Hidden once the row is already superseded
                    (the chain's latest successor is the right place to
                    correct from). */}
                {(detailCert.status === 'CERTIFIED' || detailCert.status === 'DISPUTED') && !detailCert.supersededAt && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={transitionPending}
                    onClick={() => handleCorrect(detailCert)}
                    title="Create a corrected DRAFT. The original row stays in the audit trail."
                  >
                    Correct certification
                  </button>
                )}
                {detailCert.supersededAt && (
                  <span
                    className="badge"
                    style={{ background: '#94a3b8', color: 'white', alignSelf: 'center' }}
                    title={`Superseded by correction ${detailCert.parentCertificationId ? '— parent row: ' + detailCert.parentCertificationId : ''}`}
                  >
                    Superseded
                  </span>
                )}
                {/* [DR-016] Edit the correction DRAFT — the audit caught
                    that opening a correction switched to a read-only
                    detail view with no way to edit the copied amounts.
                    This re-opens the same form modal in PATCH mode,
                    prefilled from the DRAFT and version-pinned to
                    `detailCert.version` so a concurrent PATCH / certify
                    / dispute on this row cannot be silently overwritten. */}
                {detailCert.status === 'DRAFT' && !detailCert.supersededAt && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={transitionPending}
                    onClick={() => openEdit(detailCert)}
                    data-testid="bc-edit-draft"
                    title="Edit this DRAFT (amend amounts / replace PDF / add remarks)."
                  >
                    Edit DRAFT
                  </button>
                )}
                {/* [DR-016] Walk the correction chain backward. The
                    original CERTIFIED row remains reachable from its
                    successor — load it back into this modal in place. */}
                {detailCert.parentCertificationId && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={transitionPending}
                    onClick={() => openOriginal(detailCert)}
                    data-testid="bc-view-original"
                    title="Open the parent row this correction was forked from."
                  >
                    View original
                  </button>
                )}
                {/* [DR-016] Abandon the correction DRAFT. Soft-deletes
                    this row only — the original stays superseded (the
                    supersede stamp does not auto-revert) and any
                    concurrent approve / save on this DRAFT will 404.
                    This makes "closing the modal without abandoning"
                    unambiguously NOT a silent cancellation. */}
                {detailCert.status === 'DRAFT' && !detailCert.supersededAt && detailCert.parentCertificationId && (
                  <button
                    type="button"
                    className="btn"
                    style={{ background: '#7f1d1d', color: 'white', border: 'none' }}
                    disabled={transitionPending}
                    onClick={() => setAbandoningCert(detailCert)}
                    data-testid="bc-abandon-correction"
                    title="Discard this correction DRAFT. The original row stays superseded."
                  >
                    Abandon correction
                  </button>
                )}
              </div>
            </>
          )}
        </Modal>
      )}

      {/* ─── Archive confirm ────────────────────────────────────────────── */}
      {confirmArchive && (
        <div
          role="alertdialog"
          aria-labelledby="archive-bc-title"
          aria-describedby="archive-bc-desc"
          style={{
            position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 100, padding: '1rem',
          }}
          onClick={(e) => { if (e.target === e.currentTarget && !archiving) setConfirmArchive(null); }}
        >
          <div
            style={{
              background: '#fff', borderRadius: 12, maxWidth: 420, width: '100%',
              padding: '1.5rem', boxShadow: '0 20px 60px rgba(15,23,42,0.3)',
            }}
          >
            <h2 id="archive-bc-title" style={{ margin: '0 0 0.5rem', color: 'var(--navy)' }}>
              Archive certification?
            </h2>
            <p id="archive-bc-desc" style={{ margin: '0 0 1rem', fontSize: '0.9rem', color: 'var(--steel)' }}>
              <strong>Bill {confirmArchive.billNumber}</strong>
              {' — '}{confirmArchive.contractorName}
              {' — '}{confirmArchive.project?.name || 'unknown project'}
            </p>
            <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: 'var(--steel)' }}>
              Soft-delete only — the row is hidden from this list but stays in the
              database for audit.
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirmArchive(null)} disabled={archiving}>
                Cancel
              </button>
              <button
                type="button"
                className="btn"
                style={{ background: 'var(--muted, #64748b)', color: 'white', border: 'none' }}
                disabled={archiving}
                onClick={handleArchive}
              >
                {archiving ? 'Archiving…' : 'Archive'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── [DR-016] Edit correction DRAFT modal ───────────────────────── */}
      {editingCert && (
        <CertificationFormModal
          accessToken={accessToken}
          projects={projects}
          projectsLoading={projectsLoading}
          mode="edit"
          initialCert={editingCert}
          expectedVersion={editingCert?.version ?? null}
          onClose={() => setEditingCert(null)}
          onSaved={async (saved) => {
            setEditingCert(null);
            toast.push(`Bill ${saved.billNumber} updated.`, 'success');
            // The detail modal may have been open on this same row —
            // swap it to the saved row in place so the admin sees the
            // post-edit amounts / version immediately. If the detail
            // modal was on the parent row, leave it alone.
            if (detailCert && detailCert.id === saved.id) setDetailCert(saved);
            await fetchCerts();
            // [DR-029] An edit can move certifiedAmount / claimedAmount
            // and so changes the per-project aggregates.
            await fetchAggregates();
          }}
          onError={(msg) => toast.push(msg, 'error')}
        />
      )}

      {/* ─── [DR-016] Abandon correction confirm ──────────────────────── */}
      {abandoningCert && (
        <div
          role="alertdialog"
          aria-labelledby="abandon-bc-title"
          aria-describedby="abandon-bc-desc"
          data-testid="bc-abandon-confirm"
          style={{
            position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 100, padding: '1rem',
          }}
          onClick={(e) => { if (e.target === e.currentTarget && !abandoning) setAbandoningCert(null); }}
        >
          <div
            style={{
              background: '#fff', borderRadius: 12, maxWidth: 460, width: '100%',
              padding: '1.5rem', boxShadow: '0 20px 60px rgba(15,23,42,0.3)',
            }}
          >
            <h2 id="abandon-bc-title" style={{ margin: '0 0 0.5rem', color: 'var(--navy)' }}>
              Abandon correction DRAFT?
            </h2>
            <p id="abandon-bc-desc" style={{ margin: '0 0 1rem', fontSize: '0.9rem', color: 'var(--steel)' }}>
              <strong>Bill {abandoningCert.billNumber}</strong>
              {' — '}{abandoningCert.contractorName}
              {' — '}{abandoningCert.project?.name || 'unknown project'}
            </p>
            <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: 'var(--steel)' }}>
              The correction DRAFT will be discarded. The original row stays
              <strong> superseded</strong> — abandoning a correction does not
              restore the original. To re-activate the original, correct it
              again from the latest successor in the chain.
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setAbandoningCert(null)} disabled={abandoning}>
                Cancel
              </button>
              <button
                type="button"
                className="btn"
                style={{ background: '#7f1d1d', color: 'white', border: 'none' }}
                disabled={abandoning}
                onClick={handleAbandon}
                data-testid="bc-abandon-confirm-btn"
              >
                {abandoning ? 'Abandoning…' : 'Abandon correction'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Detail row helper ───────────────────────────────────────────────────
function DetailRow({ label, value }) {
  return (
    <div style={{ display: 'flex', gap: '0.5rem', padding: '0.25rem 0', borderBottom: '1px solid #f1f5f9', fontSize: '0.85rem' }}>
      <span style={{ color: 'var(--steel)', flex: '0 0 130px' }}>{label}</span>
      <span style={{ color: 'var(--navy)', flex: 1, wordBreak: 'break-word' }}>{value}</span>
    </div>
  );
}

// ─── Create / edit form modal ────────────────────────────────────────────
// Mirrors components/DrawingFormModal.jsx — same 4-step upload pipeline
// (mint SAS, PUT bytes, confirm-upload, POST row) but with the `billing/`
// blob-path prefix. Embedded in this file so we ship only one new file
// instead of three (page + form + form-upload-helper).
//
// [DR-016] Same modal doubles as the correction DRAFT editor. In
// `mode === 'edit'` it pre-fills from the DRAFT row (which already
// carries the parent row's amounts forward verbatim) and submits via
// PATCH instead of POST. If the user doesn't pick a new file, the
// existing attachment is left untouched (the backend PATCH only writes
// attachment fields when one of them is present in the body) — the
// replacement-upload identity is the new upload intent only when
// actually uploaded.
function CertificationFormModal({
  accessToken, projects, projectsLoading,
  onClose, onSaved, onError,
  // [DR-016] edit-mode props. `mode` is 'create' (default) or 'edit'.
  // `initialCert` is the DRAFT row being edited; `expectedVersion` is
  // the version pin (DR-015) so a stale tab cannot overwrite a
  // concurrent PATCH / certify / dispute on the same DRAFT.
  mode = 'create', initialCert = null, expectedVersion = null,
}) {
  const fileInputRef = useRef(null);
  const [form, setForm] = useState(() => initialiseFormState(initialCert, mode));
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [pendingFile, setPendingFile] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadPhase, setUploadPhase] = useState(''); // 'sas'|'uploading'|'confirming'|''

  // Auto-select project if only one exists (create mode only — edit
  // mode pre-fills from the existing row).
  useEffect(() => {
    if (mode !== 'create') return;
    if (!form.projectId && projects.length === 1) {
      setForm((f) => ({ ...f, projectId: projects[0].id }));
    }
  }, [projects, form.projectId, mode]);

  function validate(f) {
    const e = {};
    if (!f.projectId) e.projectId = 'Select a project.';
    if (!f.contractorName.trim()) e.contractorName = 'Contractor name is required.';
    if (!f.billNumber.trim()) e.billNumber = 'Bill number is required.';
    if (!f.billDate) e.billDate = 'Bill date is required.';
    const claimed = parseFloat(f.claimedAmount);
    if (!Number.isFinite(claimed) || claimed < 0) e.claimedAmount = 'Claimed amount must be ≥ 0.';
    const cert = parseFloat(f.certifiedAmount);
    if (!Number.isFinite(cert) || cert < 0) e.certifiedAmount = 'Certified amount must be ≥ 0.';
    const ded = f.deductedAmount === '' ? 0 : parseFloat(f.deductedAmount);
    if (!Number.isFinite(ded) || ded < 0) e.deductedAmount = 'Deducted amount must be ≥ 0.';
    return e;
  }

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
    setErrors((prev) => ({ ...prev, [name]: undefined }));
  }

  function handleFileChange(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) { setPendingFile(null); return; }
    if (!ACCEPTED_REPORT_TYPES.includes(file.type)) {
      setServerError(`Unsupported file type: ${file.type || 'unknown'}`);
      setPendingFile(null);
      e.target.value = '';
      return;
    }
    if (file.size > MAX_REPORT_BYTES) {
      setServerError(`File is too large (max ${MAX_REPORT_BYTES / 1024 / 1024}MB).`);
      setPendingFile(null);
      e.target.value = '';
      return;
    }
    setServerError('');
    setPendingFile(file);
    setUploadProgress(0);
    setUploadPhase('');
  }

  async function handleSubmit(e) {
    e?.preventDefault();
    if (submitting) return;
    const v = validate(form);
    if (Object.keys(v).length > 0) {
      setErrors(v);
      return;
    }
    setErrors({});
    setServerError('');
    setSubmitting(true);
    try {
      let attachment = null;
      if (pendingFile) {
        setUploadPhase('sas');
        const { sasUrl, ulid, blobPath } = await api.getBillingCertSasUrl(
          pendingFile.name, pendingFile.type, accessToken,
        );
        setUploadPhase('uploading');
        try {
          await uploadBlob(sasUrl, pendingFile, {
            contentType: pendingFile.type,
            onProgress: setUploadProgress,
            timeoutMs: DEFAULT_BLOB_UPLOAD_TIMEOUT_MS,
          });
        } catch (err) {
          if (err instanceof BlobUploadError) {
            throw new Error(`Upload failed: ${err.message}`);
          }
          throw err;
        }
        setUploadPhase('confirming');
        await api.confirmBillingCertUpload(
          ulid, pendingFile.name, pendingFile.type, pendingFile.size, accessToken,
        );
        attachment = {
          blobPath,
          filename: pendingFile.name,
          contentType: pendingFile.type,
          sizeBytes: pendingFile.size,
        };
      }
      setUploadPhase('');
      const payload = {
        projectId: form.projectId,
        contractorName: form.contractorName.trim(),
        billNumber: form.billNumber.trim(),
        billDate: form.billDate,
        invoiceNo: form.invoiceNo ? form.invoiceNo.trim() : null,
        poContractRef: form.poContractRef ? form.poContractRef.trim() : null,
        claimedAmount: parseFloat(form.claimedAmount) || 0,
        deductedAmount: form.deductedAmount === '' ? 0 : (parseFloat(form.deductedAmount) || 0),
        certifiedAmount: parseFloat(form.certifiedAmount) || 0,
        // [DR-028] Don't coerce zero to null — `parseFloat('0') || null`
        // would record absence instead of zero. Blank input → null;
        // numeric input (including legitimate 0) → the parsed number.
        // The backend's `parseAmount` rejects NaN with 400
        // INVALID_CLAIMED so a typed-in garbage string still bounces.
        gstAmount: form.gstAmount === '' ? null : parseFloat(form.gstAmount),
        poValue: form.poValue === '' ? null : parseFloat(form.poValue),
        balanceValue: form.balanceValue === '' ? null : parseFloat(form.balanceValue),
        remarks: form.remarks ? form.remarks.trim() : null,
        // [DR-015] version pin on PATCH so a stale tab cannot overwrite
        // a concurrent write on the same DRAFT.
        ...(mode === 'edit' && expectedVersion != null ? { expectedVersion } : {}),
        ...(attachment || {}),
      };
      // [DR-017] Mint one Idempotency-Key per submit intent. The api.js
      // NETWORK_ERROR retry path re-sends the same payload — without the
      // key, the retry would record the COP twice (the audit's primary
      // DR-017 defect for the COP register).
      const idempotencyKey = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : `billing-cert-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const saved = mode === 'edit'
        ? await api.updateBillingCertification(initialCert.id, payload, accessToken)
        : await api.createBillingCertification(payload, accessToken, idempotencyKey);
      await onSaved(saved);
    } catch (err) {
      setServerError(err?.message || 'Failed to save certification');
      setSubmitting(false);
      setUploadPhase('');
    }
  }

  const submittingLabel = useMemo(() => {
    if (uploadPhase === 'sas') return 'Preparing upload…';
    if (uploadPhase === 'uploading') return `Uploading PDF… ${uploadProgress}%`;
    if (uploadPhase === 'confirming') return 'Confirming upload…';
    if (submitting) return 'Saving certification…';
    return null;
  }, [uploadPhase, uploadProgress, submitting]);

  return (
    <Modal open onClose={onClose} ariaLabel={mode === 'edit' ? 'Edit certification' : 'Add certification'} maxWidth={720} dismissable={!submitting}>
      <h2 style={{ margin: '0 0 1rem', color: 'var(--navy)' }}>
        {mode === 'edit' ? `Edit correction DRAFT — Bill ${initialCert?.billNumber || ''}` : 'Add billing certification'}
      </h2>
      <form onSubmit={handleSubmit}>
        <div className="form-row">
          <div className="form-group" style={{ flex: 2 }}>
            <label htmlFor="bc-form-projectId">Project *</label>
            <select
              id="bc-form-projectId"
              name="projectId"
              className="form-input"
              value={form.projectId}
              onChange={handleChange}
              required
              disabled={projectsLoading || submitting || mode === 'edit'}
            >
              <option value="">— Select project —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.code ? ` (${p.code})` : ''}
                </option>
              ))}
            </select>
            {errors.projectId && <div className="form-field-error" role="alert">{errors.projectId}</div>}
          </div>
          <div className="form-group" style={{ flex: 1 }}>
            <label htmlFor="bc-form-billDate">Bill date *</label>
            <input
              id="bc-form-billDate"
              type="date"
              name="billDate"
              className="form-input"
              value={form.billDate}
              onChange={handleChange}
              required
              disabled={submitting}
            />
          </div>
        </div>

        <div className="form-row">
          <div className="form-group" style={{ flex: 2 }}>
            <label htmlFor="bc-form-contractor">Contractor name *</label>
            <input
              id="bc-form-contractor"
              name="contractorName"
              className="form-input"
              value={form.contractorName}
              onChange={handleChange}
              maxLength={FIELD_MAX.contractorName}
              required
              placeholder="e.g. Ponni Constructions & Developers Pvt Ltd"
              disabled={submitting}
            />
            {errors.contractorName && <div className="form-field-error" role="alert">{errors.contractorName}</div>}
          </div>
          <div className="form-group" style={{ flex: 1 }}>
            <label htmlFor="bc-form-billNumber">Bill number *</label>
            <input
              id="bc-form-billNumber"
              name="billNumber"
              className="form-input"
              value={form.billNumber}
              onChange={handleChange}
              maxLength={FIELD_MAX.billNumber}
              required
              placeholder="e.g. RAB 05"
              disabled={submitting}
            />
            {mode === 'edit' && (
              <div style={{ fontSize: '0.72rem', color: 'var(--steel)', marginTop: '0.15rem' }}>
                Locked to the original bill — correction keeps the same bill identity.
              </div>
            )}
            {errors.billNumber && <div className="form-field-error" role="alert">{errors.billNumber}</div>}
          </div>
        </div>

        <div className="form-row">
          <div className="form-group" style={{ flex: 1 }}>
            <label htmlFor="bc-form-invoiceNo">Invoice no.</label>
            <input
              id="bc-form-invoiceNo"
              name="invoiceNo"
              className="form-input"
              value={form.invoiceNo}
              onChange={handleChange}
              maxLength={FIELD_MAX.invoiceNo}
              placeholder="e.g. PCDPL/25-26/021"
              disabled={submitting}
            />
          </div>
          <div className="form-group" style={{ flex: 1 }}>
            <label htmlFor="bc-form-poRef">PO / Contract ref</label>
            <input
              id="bc-form-poRef"
              name="poContractRef"
              className="form-input"
              value={form.poContractRef}
              onChange={handleChange}
              maxLength={FIELD_MAX.poContractRef}
              placeholder="e.g. LLPL/2387/25-26"
              disabled={submitting}
            />
          </div>
        </div>

        <div className="form-row">
          <div className="form-group" style={{ flex: 1 }}>
            <label htmlFor="bc-form-claimed">Claimed amount *</label>
            <input
              id="bc-form-claimed"
              type="number"
              step="0.01"
              name="claimedAmount"
              className="form-input"
              value={form.claimedAmount}
              onChange={handleChange}
              required
              placeholder="0.00"
              disabled={submitting}
            />
            {errors.claimedAmount && <div className="form-field-error" role="alert">{errors.claimedAmount}</div>}
          </div>
          <div className="form-group" style={{ flex: 1 }}>
            <label htmlFor="bc-form-deducted">Deducted amount</label>
            <input
              id="bc-form-deducted"
              type="number"
              step="0.01"
              name="deductedAmount"
              className="form-input"
              value={form.deductedAmount}
              onChange={handleChange}
              placeholder="0.00"
              disabled={submitting}
            />
            {errors.deductedAmount && <div className="form-field-error" role="alert">{errors.deductedAmount}</div>}
          </div>
          <div className="form-group" style={{ flex: 1 }}>
            <label htmlFor="bc-form-certified">Certified amount *</label>
            <input
              id="bc-form-certified"
              type="number"
              step="0.01"
              name="certifiedAmount"
              className="form-input"
              value={form.certifiedAmount}
              onChange={handleChange}
              required
              placeholder="0.00"
              disabled={submitting}
            />
            {errors.certifiedAmount && <div className="form-field-error" role="alert">{errors.certifiedAmount}</div>}
          </div>
        </div>

        <div className="form-row">
          <div className="form-group" style={{ flex: 1 }}>
            <label htmlFor="bc-form-gst">GST amount</label>
            <input
              id="bc-form-gst"
              type="number"
              step="0.01"
              name="gstAmount"
              className="form-input"
              value={form.gstAmount}
              onChange={handleChange}
              placeholder="0.00"
              disabled={submitting}
            />
          </div>
          <div className="form-group" style={{ flex: 1 }}>
            <label htmlFor="bc-form-poValue">PO value</label>
            <input
              id="bc-form-poValue"
              type="number"
              step="0.01"
              name="poValue"
              className="form-input"
              value={form.poValue}
              onChange={handleChange}
              placeholder="0.00"
              disabled={submitting}
            />
          </div>
          <div className="form-group" style={{ flex: 1 }}>
            <label htmlFor="bc-form-balance">Balance value</label>
            <input
              id="bc-form-balance"
              type="number"
              step="0.01"
              name="balanceValue"
              className="form-input"
              value={form.balanceValue}
              onChange={handleChange}
              placeholder="0.00"
              disabled={submitting}
            />
          </div>
        </div>

        <div className="form-group">
          <label htmlFor="bc-form-remarks">Remarks</label>
          <textarea
            id="bc-form-remarks"
            name="remarks"
            className="form-input"
            rows={3}
            value={form.remarks}
            onChange={handleChange}
            maxLength={FIELD_MAX.remarks}
            placeholder="Optional — e.g. deductions, dispute context, credit notes"
            disabled={submitting}
          />
        </div>

        <div className="form-group">
          <label htmlFor="bc-form-file">
            COP PDF {mode === 'edit' ? '(replace optional)' : '(optional)'}
          </label>
          <input
            id="bc-form-file"
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_REPORT_TYPES.join(',')}
            className="form-input"
            onChange={handleFileChange}
            disabled={submitting}
          />
          {pendingFile && (
            <div style={{ marginTop: '0.4rem', fontSize: '0.8rem', color: 'var(--steel)' }}>
              📄 New: {pendingFile.name} · {formatBytes(pendingFile.size)}
            </div>
          )}
          {mode === 'edit' && initialCert?.filename && !pendingFile && (
            <div style={{ marginTop: '0.4rem', fontSize: '0.8rem', color: 'var(--steel)' }}>
              📄 Current: {initialCert.filename}
              {initialCert.sizeBytes ? ` · ${formatBytes(initialCert.sizeBytes)}` : ''}
              {' '}— leave the field empty to keep this attachment.
            </div>
          )}
          <span style={{ fontSize: '0.75rem', color: 'var(--steel)', marginTop: '0.25rem' }}>
            PDF / Office / photo / text up to {MAX_REPORT_BYTES / 1024 / 1024}MB.
          </span>
        </div>

        {submittingLabel && (
          <div role="status" aria-live="polite" style={{
            marginTop: '0.5rem', padding: '0.5rem 0.75rem',
            background: '#f0f9ff', border: '1px solid #bae6fd',
            borderRadius: 6, fontSize: '0.85rem', color: '#075985',
          }}>
            {submittingLabel}
          </div>
        )}

        {serverError && (
          <div className="portal-auth-error" role="alert" style={{ marginTop: '0.75rem' }}>
            {serverError}
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? (submittingLabel || 'Saving…') : (mode === 'edit' ? 'Save correction' : 'Record certification')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
