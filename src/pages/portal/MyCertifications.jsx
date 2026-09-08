// R37.1 — Employee "My Certifications" — read-only scoped view of the
// COP / Billing Certification Register.
//
// Field engineers can see what was certified for the projects they're
// working on, but they CAN'T create / certify / dispute / archive rows.
// The admin-only counterparts live at /portal/admin/billing-certifications
// (Records group → "Billing Certifications"). The two pages share the
// same backend table and the same status-pill vocabulary, but the
// employee view is intentionally read-only:
//
//   - Filters limited to status chips + contractor + date range (no
//     project picker — the union of "filed DPR/Inspection/BOQ/VO/
//     Drawing" is what gets surfaced, so the project picker would
//     have to mirror that union anyway, and the server already
//     enforces it).
//   - "View" opens a read-only detail modal; no Certify / Dispute /
//     Delete / Edit buttons. Admin keeps the full surface on the
//     Records-group page.
//
// The backend route GET /api/billing-certifications was loosened in
// R37.1 from requireFreshAdmin → requireAuth + ?scope=assigned. This
// page passes `scope: 'assigned'` on every list call so the response is
// narrowed to projects the employee has personal context on. Admins who
// land here (via direct URL) ignore the param and see everything — same
// behaviour as the other ?scope=assigned consumers (Projects.js, etc.).

import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import Modal from '../../components/Modal.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import usePullToRefresh from '../../hooks/usePullToRefresh.js';
import PullToRefreshIndicator from '../../components/PullToRefreshIndicator.jsx';
import {
  formatShortDate,
  formatINR,
} from '../../lib/format.js';
import {
  BILLING_CERTIFICATION_STATUSES,
  BILLING_CERTIFICATION_STATUS_LABELS,
} from '../../lib/constants.js';

const DEFAULT_LIMIT = 50;

// Status badge styles — mirror the admin page's 3-state pill so the two
// surfaces look identical when an employee opens them side by side.
const STATUS_BADGE_STYLES = {
  DRAFT:     { background: '#f1f5f9', color: '#475569' }, // slate
  CERTIFIED: { background: '#dcfce7', color: '#166534' }, // green
  DISPUTED:  { background: '#fee2e2', color: '#b91c1c' }, // red
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

export default function MyCertifications() {
  useDocumentTitle('My Certifications');
  const { accessToken } = useAuth();
  const toast = useToast();

  // Filter state. Mirrors the admin page so muscle memory carries over.
  const [status, setStatus] = useState('');
  const [contractorName, setContractorName] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // Pagination + data state.
  const [certs, setCerts] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [total, setTotal] = useState(0);
  const [summaryByStatus, setSummaryByStatus] = useState(null);
  // [DR-021] Top-level summary envelope — distinct labels for
  // all-status context vs certified liability vs disputed amounts.
  // Mirrors the admin page's three-figure summary so the two surfaces
  // read identically apart from the action buttons.
  const [summaryTotals, setSummaryTotals] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  // Detail modal state — read-only.
  const [detailCert, setDetailCert] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  // R37.1: always send scope=assigned so the server narrows to the
  // employee's assigned project set. Admins who hit this URL have the
  // param ignored server-side, which is fine — they keep seeing the
  // cross-project registry as a side effect of the new RBAC split.
  const buildListParams = useCallback(({ cursor = null } = {}) => {
    const params = { scope: 'assigned', limit: String(DEFAULT_LIMIT) };
    if (status) params.status = status;
    if (contractorName && contractorName.trim()) params.contractorName = contractorName.trim();
    if (fromDate) params.from = fromDate;
    if (toDate) params.to = toDate;
    if (cursor) params.cursor = cursor;
    return params;
  }, [status, contractorName, fromDate, toDate]);

  const fetchCerts = useCallback(async ({ append = false, cursor = null } = {}) => {
    if (append) setLoadingMore(true); else setLoading(true);
    setError('');
    try {
      const data = await api.getBillingCertifications(buildListParams({ cursor }), accessToken);
      const items = data?.certifications || [];
      setCerts((prev) => (append ? [...prev, ...items] : items));
      setNextCursor(data?.nextCursor || null);
      // [DR-021] Totals + per-status summary describe the FULL filtered
      // population. Server already separates count + sums from cursor
      // (see backend/src/routes/billingCertifications.js), so the
      // response is invariant under `cursor`. Don't replace on append
      // to avoid a flicker; the next non-append fetch (filter change,
      // pull-to-refresh, mutation) will repopulate.
      if (!append) {
        setTotal(data?.total || 0);
        setSummaryByStatus(data?.summary?.byStatus || null);
        setSummaryTotals(data?.summary || null);
      }
    } catch (err) {
      setError(err?.message || 'Failed to load your certifications');
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
  }, [buildListParams, accessToken]);

  useEffect(() => { fetchCerts(); }, [fetchCerts]);

  // Round-28 #6 pull-to-refresh.
  const { pullDistance, isRefreshing } = usePullToRefresh(async () => {
    try { await fetchCerts(); }
    catch (err) { toast.push(err?.message || 'Refresh failed', 'error'); }
  });

  // Detail modal — re-fetch by id so the modal always shows the freshest
  // state. The GET /:id route is open to any authenticated employee, but
  // 404s for COPs against projects they're not assigned to (round-37.1).
  const openDetail = useCallback(async (cert) => {
    setDetailCert({ id: cert.id, ...cert });
    setDetailLoading(true);
    setDetailError('');
    try {
      const fresh = await api.getBillingCertification(cert.id, accessToken);
      setDetailCert(fresh);
    } catch (err) {
      // 404 is the "row exists but not in your scope" signal — surface
      // as a friendly "no longer available" message rather than the raw
      // NOT_FOUND error so an employee doesn't think the row is gone.
      const msg = err?.status === 404 || /not found/i.test(err?.message || '')
        ? 'This certification is no longer available.'
        : err?.message || 'Failed to load certification details';
      setDetailError(msg);
    } finally {
      setDetailLoading(false);
    }
  }, [accessToken]);

  const closeDetail = useCallback(() => {
    setDetailCert(null);
    setDetailLoading(false);
    setDetailError('');
  }, []);

  const handleViewPdf = useCallback(async (cert) => {
    if (!cert || !cert.blobPath) return;
    try {
      const { sasUrl } = await api.getBillingCertificationReadSas(cert.id, accessToken);
      window.open(sasUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      toast.push(err?.message || 'Could not open the attached PDF', 'error');
    }
  }, [accessToken, toast]);

  // Summary tile counts — derived from the list response. The server
  // returns the same byStatus breakdown for any scope so the
  // employee-scoped list shows only the employee's totals, which is
  // exactly what we want.
  const summaryTiles = summaryByStatus ? [
    { key: 'DRAFT',     label: 'Draft',     ...summaryByStatus.DRAFT },
    { key: 'CERTIFIED', label: 'Certified', ...summaryByStatus.CERTIFIED },
    { key: 'DISPUTED',  label: 'Disputed',  ...summaryByStatus.DISPUTED },
  ] : null;

  return (
    <div className="portal-page">
      <PullToRefreshIndicator pullDistance={pullDistance} isRefreshing={isRefreshing} />
      <Breadcrumb items={[{ label: 'My Reports' }, { label: 'My Certifications' }]} />

      <header style={{ marginBottom: '0.75rem' }}>
        <h1 style={{ margin: '0 0 0.25rem', color: 'var(--navy)' }}>
          My Certifications
        </h1>
        <p style={{ margin: 0, color: 'var(--steel)', fontSize: '0.85rem' }}>
          Read-only view of the COP / RA-bill certifications recorded against
          the projects you've personally filed on (DPR, Inspection, BOQ,
          Variation, Drawing). The full cross-project register is in the
          Records section.
        </p>
      </header>

      {/* [DR-021] Three distinct summary figures — all-status context
          (sum-of-recordValues across statuses), certified liability
          (CERTIFIED only), and disputed amounts (DISPUTED only) — so
          the employee sees the same three-figure summary the admin
          page renders. Mirrors the admin-side `bc-summary-totals`
          tile so the two pages read identically apart from the
          action buttons. */}
      {summaryTiles && (
        <div className="dpr-card" style={{ marginBottom: '0.75rem', display: 'grid', gap: '0.5rem' }}>
          <div
            data-testid="mycert-summary-totals"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
              gap: '0.5rem',
            }}
          >
            <div>
              <div style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--steel)' }}>
                All status (context)
              </div>
              <div style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--navy)', marginTop: '0.2rem' }}>
                {formatAmount((summaryTotals && summaryTotals.totalCertifiedAllStatus) || 0)}
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--steel)', marginTop: '0.15rem' }}>
                Sum across DRAFT + CERTIFIED + DISPUTED
              </div>
            </div>
            <div>
              <div style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: '#166534' }}>
                Certified liability
              </div>
              <div style={{ fontSize: '1.05rem', fontWeight: 700, color: '#166534', marginTop: '0.2rem' }}>
                {formatAmount((summaryTotals && summaryTotals.totalCertifiedLiability) || 0)}
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--steel)', marginTop: '0.15rem' }}>
                CERTIFIED sum only
              </div>
            </div>
            <div>
              <div style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: '#b91c1c' }}>
                Disputed amounts
              </div>
              <div style={{ fontSize: '1.05rem', fontWeight: 700, color: '#b91c1c', marginTop: '0.2rem' }}>
                {formatAmount((summaryTotals && summaryTotals.totalCertifiedDisputed) || 0)}
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--steel)', marginTop: '0.15rem' }}>
                DISPUTED sum only
              </div>
            </div>
          </div>
          <div
            data-testid="mycert-summary-by-status"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 160px), 1fr))',
              gap: '0.5rem',
              borderTop: '1px solid #f1f5f9',
              paddingTop: '0.5rem',
            }}
          >
            {summaryTiles.map((tile) => {
              const badge = STATUS_BADGE_STYLES[tile.key];
              return (
                <div
                  key={tile.key}
                  style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <span
                      style={{
                        fontSize: '0.65rem', fontWeight: 700,
                        background: badge.background, color: badge.color,
                        padding: '2px 8px', borderRadius: 999,
                        textTransform: 'uppercase', letterSpacing: '0.04em',
                      }}
                    >
                      {tile.label}
                    </span>
                  </div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--navy)' }}>
                    {tile.count}
                  </div>
                  {Number(tile.totalCertified) > 0 && (
                    <div style={{ fontSize: '0.78rem', color: 'var(--steel)' }}>
                      Certified {formatAmount(tile.totalCertified)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Filter row. Same vocabulary as the admin page minus the project
          picker (the scope filter already does the project narrowing). */}
      <div className="dpr-card" style={{ marginBottom: '0.75rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', gap: '0.5rem' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--steel)', fontWeight: 600 }}>Contractor</span>
            <input
              type="text"
              className="form-input"
              placeholder="Any contractor"
              value={contractorName}
              onChange={(e) => setContractorName(e.target.value)}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--steel)', fontWeight: 600 }}>From</span>
            <input
              type="date"
              className="form-input"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--steel)', fontWeight: 600 }}>To</span>
            <input
              type="date"
              className="form-input"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
            />
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--steel)', fontWeight: 600 }}>Status</span>
            <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
              <FilterChip active={!status} onClick={() => setStatus('')}>All</FilterChip>
              {Object.values(BILLING_CERTIFICATION_STATUSES).map((s) => (
                <FilterChip key={s} active={status === s} onClick={() => setStatus(s)} tone={STATUS_BADGE_STYLES[s]}>
                  {BILLING_CERTIFICATION_STATUS_LABELS[s]?.label || s}
                </FilterChip>
              ))}
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div role="alert" style={{ color: 'var(--danger)', marginBottom: '0.75rem', fontSize: '0.85rem' }}>
          {error}
        </div>
      )}

      {loading && certs.length === 0 ? (
        <div className="dpr-card" style={{ textAlign: 'center', color: 'var(--steel)' }}>
          Loading your certifications…
        </div>
      ) : certs.length === 0 ? (
        <div className="dpr-card" style={{ textAlign: 'center' }}>
          <p style={{ margin: '0.5rem 0', color: 'var(--navy)', fontWeight: 600 }}>
            No certifications to show.
          </p>
          <p style={{ margin: 0, color: 'var(--steel)', fontSize: '0.85rem' }}>
            Once a COP / RA-bill is recorded against one of your projects,
            it'll appear here. The full cross-project register is in the
            admin Records section.
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
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <div style={{ minWidth: 0 }}>
                      <span
                        style={{
                          fontSize: '0.65rem', fontWeight: 700,
                          background: badge.background, color: badge.color,
                          padding: '2px 8px', borderRadius: 999,
                          textTransform: 'uppercase', letterSpacing: '0.04em',
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

                  <div style={{ fontSize: '0.85rem', color: 'var(--navy)' }}>
                    <div style={{ fontWeight: 600 }}>{c.contractorName}</div>
                    <div style={{ color: 'var(--steel)', fontSize: '0.78rem' }}>
                      Bill {c.billNumber} · {formatDate(c.billDate)}
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', fontSize: '0.78rem', color: 'var(--steel)' }}>
                    <span title="Claimed amount">📋 {formatAmount(c.claimedAmount)}</span>
                    <span title="Deducted amount">➖ {formatAmount(c.deductedAmount)}</span>
                    <span title="Certified amount" style={{ color: 'var(--navy)', fontWeight: 600 }}>
                      ✅ {formatAmount(c.certifiedAmount)}
                    </span>
                  </div>

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

                  <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'flex-end', marginTop: '0.25rem' }}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => openDetail(c)}
                      aria-label={`View ${c.billNumber}`}
                    >
                      View
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

      {detailCert && (
        <Modal
          open={true}
          onClose={closeDetail}
          ariaLabel={`Certification ${detailCert.billNumber || ''}`}
          maxWidth={720}
        >
          <h2 style={{ margin: '0 0 0.75rem', color: 'var(--navy)' }}>
            Certification — Bill {detailCert.billNumber || '—'}
          </h2>
          {detailLoading ? (
            <div style={{ padding: '1.5rem', color: 'var(--steel)', textAlign: 'center' }}>Loading…</div>
          ) : detailError ? (
            <div role="alert" style={{ color: 'var(--danger)', padding: '0.5rem 0' }}>
              {detailError}
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', marginBottom: '0.75rem' }}>
                <span
                  style={{
                    fontSize: '0.72rem', fontWeight: 700,
                    background: STATUS_BADGE_STYLES[detailCert.status]?.background,
                    color: STATUS_BADGE_STYLES[detailCert.status]?.color,
                    padding: '2px 10px', borderRadius: 999,
                    textTransform: 'uppercase', letterSpacing: '0.04em',
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

              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
                <button type="button" className="btn btn-secondary" onClick={closeDetail}>Close</button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

// Tiny helper for status chips + filter pills.
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

// Label / value row used inside the read-only detail modal. Mirrors the
// admin page's DetailRow so the two detail views are pixel-identical
// apart from the action buttons at the bottom.
function DetailRow({ label, value }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '160px 1fr',
        gap: '0.5rem',
        padding: '0.35rem 0',
        borderBottom: '1px solid #f1f5f9',
        fontSize: '0.85rem',
      }}
    >
      <span style={{ color: 'var(--steel)' }}>{label}</span>
      <span style={{ color: 'var(--navy)' }}>{value || '—'}</span>
    </div>
  );
}
