// R37: Admin "Billing Certifications" — cross-project, cross-employee
// COP / RA-bill certification register.
//
// Mirrors the ReportsAdmin / DrawingsAdmin registry pattern:
//   - filter toolbar (project, status chips, contractor, date range)
//   - summary tile (per-project totals by status) at the top
//   - card grid (auto-fill, 320px min) with status badge + project name +
//     contractor + bill # + amounts + bill date + View + Certify/Dispute
//     + Delete actions
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
  const [aggregates, setAggregates] = useState([]); // per-project totals

  // Pagination + data state.
  const [certs, setCerts] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [total, setTotal] = useState(0);
  const [summaryByStatus, setSummaryByStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  // Modal state.
  const [createOpen, setCreateOpen] = useState(false);
  const [detailCert, setDetailCert] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [transitionPending, setTransitionPending] = useState(false);
  const [disputeOpen, setDisputeOpen] = useState(null);
  const [disputeReason, setDisputeReason] = useState('');
  const [disputeSubmitting, setDisputeSubmitting] = useState(false);

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
      setTotal(data?.total || 0);
      setSummaryByStatus(data?.summary?.byStatus || null);
    } catch (err) {
      setError(err?.message || 'Failed to load billing certifications');
      if (!append) {
        setCerts([]);
        setNextCursor(null);
        setTotal(0);
      }
    } finally {
      if (append) setLoadingMore(false); else setLoading(false);
    }
  }, [projectId, status, contractorName, fromDate, toDate, accessToken]);

  useEffect(() => {
    if (!employee?.isAdmin) return;
    fetchCerts();
  }, [fetchCerts, employee?.isAdmin]);

  // Aggregates (per-project totals) — fetched in the background whenever
  // the project filter changes. Kept separate from the list so a heavy
  // status filter doesn't reset the aggregates view.
  useEffect(() => {
    if (!employee?.isAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const params = {};
        if (fromDate) params.from = fromDate;
        if (toDate) params.to = toDate;
        const data = await api.getBillingCertificationAggregates(params, accessToken);
        if (!cancelled) setAggregates(data?.projects || []);
      } catch (err) {
        if (!cancelled) console.warn('[billing-cert] aggregates load failed', err?.message);
      }
    })();
    return () => { cancelled = true; };
  }, [accessToken, fromDate, toDate]);

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
      const updated = await api.certifyBillingCertification(cert.id, accessToken);
      toast.push(`Bill ${updated.billNumber} marked Certified.`, 'success');
      // If the detail modal is open on this row, update it in place; otherwise refetch the list.
      if (detailCert && detailCert.id === cert.id) setDetailCert(updated);
      await fetchCerts();
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
      const newRow = await api.correctBillingCertification(cert.id, accessToken);
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
    } catch (err) {
      // 409 SUPERSEDED — the original was already superseded by
      // another admin's correction. Refetch and surface a helpful
      // message rather than the raw error.
      const code = err?.code || err?.body?.code;
      if (code === 'SUPERSEDED') {
        toast.push('This certification is already superseded. Opening the latest version.', 'warning');
        await fetchCerts();
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
      const updated = await api.disputeBillingCertification(
        disputeOpen.id, disputeReason.trim(), accessToken,
      );
      toast.push(`Bill ${updated.billNumber} marked Disputed.`, 'success');
      if (detailCert && detailCert.id === disputeOpen.id) setDetailCert(updated);
      setDisputeOpen(null);
      setDisputeReason('');
      await fetchCerts();
    } catch (err) {
      toast.push(err?.message || 'Failed to dispute', 'error');
    } finally {
      setDisputeSubmitting(false);
    }
  }

  // ─── Delete ─────────────────────────────────────────────────────────
  async function handleDelete() {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await api.deleteBillingCertification(confirmDelete.id, accessToken);
      toast.push(`Bill ${confirmDelete.billNumber} archived.`, 'success');
      setConfirmDelete(null);
      if (detailCert && detailCert.id === confirmDelete.id) setDetailCert(null);
      await fetchCerts();
    } catch (err) {
      toast.push(err?.message || 'Failed to archive', 'error');
    } finally {
      setDeleting(false);
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
      {summaryByStatus && (
        <div
          className="dpr-card"
          style={{
            marginBottom: '1rem',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '0.75rem',
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
                    <span title={c.recordedBy?.name || c.recordedById}>
                      👤 {c.recordedBy?.name || (c.recordedById ? c.recordedById.slice(0, 8) : '—')}
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
                      style={{ color: 'var(--danger)' }}
                      onClick={() => setConfirmDelete(c)}
                      aria-label={`Archive ${c.billNumber}`}
                    >
                      Delete
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
      {aggregates.length > 0 && (
        <details className="dpr-card" style={{ marginTop: '1rem' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--navy)' }}>
            Per-project totals ({aggregates.length})
          </summary>
          <div style={{ marginTop: '0.6rem', display: 'grid', gap: '0.4rem' }}>
            {aggregates.map((row) => (
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
              </div>
            </>
          )}
        </Modal>
      )}

      {/* ─── Delete confirm ────────────────────────────────────────────── */}
      {confirmDelete && (
        <div
          role="alertdialog"
          aria-labelledby="archive-bc-title"
          aria-describedby="archive-bc-desc"
          style={{
            position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 100, padding: '1rem',
          }}
          onClick={(e) => { if (e.target === e.currentTarget && !deleting) setConfirmDelete(null); }}
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
              <strong>Bill {confirmDelete.billNumber}</strong>
              {' — '}{confirmDelete.contractorName}
              {' — '}{confirmDelete.project?.name || 'unknown project'}
            </p>
            <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: 'var(--steel)' }}>
              Soft-delete only — the row is hidden from this list but stays in the
              database for audit.
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirmDelete(null)} disabled={deleting}>
                Cancel
              </button>
              <button
                type="button"
                className="btn"
                style={{ background: 'var(--danger)', color: 'white', border: 'none' }}
                disabled={deleting}
                onClick={handleDelete}
              >
                {deleting ? 'Archiving…' : 'Archive'}
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

// ─── Create form modal ────────────────────────────────────────────────────
// Mirrors components/DrawingFormModal.jsx — same 4-step upload pipeline
// (mint SAS, PUT bytes, confirm-upload, POST row) but with the `billing/`
// blob-path prefix. Embedded in this file so we ship only one new file
// instead of three (page + form + form-upload-helper).
function CertificationFormModal({
  accessToken, projects, projectsLoading, onClose, onSaved, onError,
}) {
  const fileInputRef = useRef(null);
  const [form, setForm] = useState({
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
  });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [pendingFile, setPendingFile] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadPhase, setUploadPhase] = useState(''); // 'sas'|'uploading'|'confirming'|''

  // Auto-select project if only one exists.
  useEffect(() => {
    if (!form.projectId && projects.length === 1) {
      setForm((f) => ({ ...f, projectId: projects[0].id }));
    }
  }, [projects, form.projectId]);

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
        gstAmount: form.gstAmount === '' ? null : (parseFloat(form.gstAmount) || null),
        poValue: form.poValue === '' ? null : (parseFloat(form.poValue) || null),
        balanceValue: form.balanceValue === '' ? null : (parseFloat(form.balanceValue) || null),
        remarks: form.remarks ? form.remarks.trim() : null,
        ...(attachment || {}),
      };
      const created = await api.createBillingCertification(payload, accessToken);
      await onSaved(created);
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
    <Modal open onClose={onClose} ariaLabel="Add certification" maxWidth={720} dismissable={!submitting}>
      <h2 style={{ margin: '0 0 1rem', color: 'var(--navy)' }}>
        Add billing certification
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
              disabled={projectsLoading || submitting}
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
          <label htmlFor="bc-form-file">COP PDF (optional)</label>
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
              📄 {pendingFile.name} · {formatBytes(pendingFile.size)}
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
            {submitting ? (submittingLabel || 'Saving…') : 'Record certification'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
