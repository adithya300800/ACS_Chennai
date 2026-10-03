// [Payslips Stage 1 / commit 6 — frontend] Employee "My Payslips" page.
//
// Read-only inbox of the employee's own payslips, sourced from
// GET /api/portal/payslips (requireAuth + IDOR guard WHERE employeeId =
// req.employeeId AND deletedAt IS NULL — backend/routes/payslip.js:556-590).
// The page surfaces three columns per row: month/year label,
// emailStatus pill, and a Download button that goes through
// api.downloadPayslip(id, token) → api.download() → blob → objectURL →
// <a download> trigger (the exportUrlRef pattern from src/pages/portal/
// Admin.jsx:38-50, 98-125 — revoke on unmount + revoke before re-use).
//
// Why a custom download flow and not a plain <a href>? Two reasons:
//
//   1. The backend never exposes an R2 presigned URL for payslip blobs
//      — the route streams the PDF through the API at
//      /api/portal/payslips/:id/download with a Content-Disposition
//      attachment filename `Payslip-YYYY-MM.pdf`. The shared
//      `api.download` helper (src/lib/api.js:378-496) already handles
//      401-refresh + filename-parse + returns the parsed filename
//      verbatim. Using it means a download keeps working through a
//      token refresh instead of dropping the bytes.
//
//   2. Backend streaming avoids leaking the SAS token + R2 endpoint to
//      the browser — the bytes never leave the API host until the
//      browser receives them. No extra CORS surface, no presigned-URL
//      expiry race for the user.
//
// Filter UX matches the MyCertifications pattern (round-37.1):
// year + status chip-row + cursor pagination. Year filter is a flat
// <select> populated from the visible rows so the user doesn't need
// to know the dataset's calendar range up-front.
//
// No console.log calls anywhere (DR-018 family). No hashIdentifier
// use — PII hashing is a backend concern (lib/log.js calls redact()
// on every log context). The page reads payslip.id / payslip.year /
// payslip.month from the wire only; the human-facing "September 2026"
// label is rendered via formatMonthLabel() which is a pure formatter.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import usePullToRefresh from '../../hooks/usePullToRefresh.js';
import PullToRefreshIndicator from '../../components/PullToRefreshIndicator.jsx';
import {
  formatShortDate,
  formatBytes,
  formatMonthLabel,
} from '../../lib/format.js';
import {
  PAYSLIP_STATUSES,
  PAYSLIP_EMAIL_STATUS_LABELS,
} from '../../lib/constants.js';

const DEFAULT_LIMIT = 50;

// Per-row status pills. Three states that mirror what the wire
// serializer actually returns:
//   DRAFT       → publishedAt IS NULL                       → "Draft"
//   PUBLISHED   → publishedAt IS NOT NULL AND deletedAt IS NULL → "Published"
//   REVOKED     → deletedAt IS NOT NULL                      → "Revoked"
// The backend's portal list endpoint excludes `deletedAt IS NOT NULL`
// rows (see lib/payslip.js:556-590 IDOR guard), so REVOKED rows
// won't surface here — but the predicate is kept for completeness
// in case the backend contract is loosened in a future round.
const STATUS_BADGE_STYLES = {
  DRAFT:     { background: '#f1f5f9', color: '#475569' }, // slate
  PUBLISHED: { background: '#dcfce7', color: '#166534' }, // green
  REVOKED:   { background: '#fee2e2', color: '#b91c1c' }, // red
};

// Map a wire row to the employee-facing "status" the pill renders.
// The serializer doesn't include a `status` field directly, so the
// predicate is the source of truth.
function rowStatus(row) {
  if (row.deletedAt) return 'REVOKED';
  if (row.publishedAt) return 'PUBLISHED';
  return 'DRAFT';
}

function monthYearLabel(year, month) {
  if (!year || !month) return '—';
  return formatMonthLabel(`${year}-${String(month).padStart(2, '0')}`);
}

export default function MyPayslips() {
  useDocumentTitle('My Payslips');
  const { accessToken } = useAuth();
  const toast = useToast();

  // Filter state. Year is an optional narrowing filter; status narrows
  // the list by the 3-state pill set above. Both default to "all" so
  // the first paint shows the most recent payslip at the top.
  const [year, setYear] = useState('');
  const [status, setStatus] = useState(''); // '' = all

  // Pagination + data state.
  const [payslips, setPayslips] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  // Download-in-flight tracker — only one payslip download can run at a
  // time so the button's spinner state is unambiguous and a stuck
  // download doesn't leave the UI in a half-spun state. The backend
  // payslipDownloadLimiter (120/h, keyed on req.employeeId) is the
  // authoritative guard against bursty downloads from a single token.
  const [downloadingId, setDownloadingId] = useState(null);

  // [R2/S5 pattern] Ref to the most recent objectURL so we can revoke
  // it on unmount + before re-use. The shared Admin.jsx exportUrlRef
  // pattern (lines 38-50) is the convention this mirrors.
  const downloadUrlRef = useRef(null);
  useEffect(() => () => {
    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = null;
    }
  }, []);

  const buildListParams = useCallback(({ cursor = null } = {}) => {
    const params = { limit: String(DEFAULT_LIMIT) };
    if (year) params.year = String(year);
    if (status) params.status = status;
    if (cursor) params.cursor = cursor;
    return params;
  }, [year, status]);

  const fetchPayslips = useCallback(async ({ append = false, cursor = null } = {}) => {
    if (append) setLoadingMore(true); else setLoading(true);
    setError('');
    try {
      const data = await api.getMyPayslips(buildListParams({ cursor }), accessToken);
      const items = data?.payslips || [];
      setPayslips((prev) => (append ? [...prev, ...items] : items));
      setNextCursor(data?.nextCursor || null);
      if (!append) setTotal(data?.total || items.length);
    } catch (err) {
      setError(err?.message || 'Failed to load your payslips');
      if (!append) {
        setPayslips([]);
        setNextCursor(null);
        setTotal(0);
      }
    } finally {
      if (append) setLoadingMore(false); else setLoading(false);
    }
  }, [buildListParams, accessToken]);

  useEffect(() => { fetchPayslips(); }, [fetchPayslips]);

  // Pull-to-refresh — mirrors MyCertifications:146-149.
  const { pullDistance, isRefreshing } = usePullToRefresh(async () => {
    try { await fetchPayslips(); }
    catch (err) { toast.push(err?.message || 'Refresh failed', 'error'); }
  });

  // Year options derived from the loaded rows so the user only sees
  // years with at least one payslip. Cheap (one reduce over the page)
  // and avoids hardcoding a 2020-current window in case the dataset
  // spans older history.
  const yearOptions = useMemo(() => {
    const set = new Set();
    payslips.forEach((p) => { if (p.year) set.add(p.year); });
    return Array.from(set).sort((a, b) => b - a);
  }, [payslips]);

  // Download handler — fetch → blob → objectURL → <a download> trigger.
  // The backend always emits `Content-Disposition: attachment;
  // filename="Payslip-YYYY-MM.pdf"` for ?download=1; the helper's
  // existing filename-parse code returns that name verbatim so the
  // browser downloads with the right name without us re-deriving it.
  const handleDownload = useCallback(async (row) => {
    if (!row || downloadingId) return;
    setDownloadingId(row.id);
    try {
      const { blob, filename } = await api.downloadPayslip(row.id, accessToken);
      // Revoke the previous URL before allocating a new one so the
      // browser tab doesn't accumulate objectURL entries (one per
      // download — they only free on tab close otherwise).
      if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
      const url = URL.createObjectURL(blob);
      downloadUrlRef.current = url;
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || `Payslip-${row.year}-${String(row.month).padStart(2, '0')}.pdf`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast.push('Downloaded.', 'success');
    } catch (err) {
      // 404 is the "row exists but not in your scope / already revoked
      // / purged" signal — surface as a friendly message rather than
      // the raw NOT_FOUND so the user understands the row is gone, not
      // that the system is broken.
      const msg = err?.status === 404 || /not found/i.test(err?.message || '')
        ? 'This payslip is no longer available.'
        : err?.message || 'Download failed';
      toast.push(msg, 'error');
    } finally {
      setDownloadingId(null);
    }
  }, [accessToken, downloadingId, toast]);

  return (
    <div className="portal-page">
      <PullToRefreshIndicator pullDistance={pullDistance} isRefreshing={isRefreshing} />
      <Breadcrumb items={[{ label: 'My Reports' }, { label: 'My Payslips' }]} />

      <header style={{ marginBottom: '0.75rem' }}>
        <h1 style={{ margin: '0 0 0.25rem', color: 'var(--navy)' }}>
          My Payslips
        </h1>
        <p style={{ margin: 0, color: 'var(--steel)', fontSize: '0.85rem' }}>
          Your published payslips. Tap <strong>Download</strong> to fetch the
          PDF. If a payslip doesn't show up, check your email — admins publish
          monthly and a delayed send can leave a row in <em>Sending…</em> for a
          few minutes.
        </p>
      </header>

      {/* Filter row — year select + status chips. The year select is
          derived from the visible rows so it always matches the data
          (no stale 2020-2030 placeholder). */}
      <div className="dpr-card" style={{ marginBottom: '0.75rem' }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))',
          gap: '0.5rem',
          alignItems: 'flex-end',
        }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--steel)', fontWeight: 600 }}>Year</span>
            <select
              className="form-input"
              value={year}
              onChange={(e) => setYear(e.target.value)}
            >
              <option value="">All years</option>
              {yearOptions.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--steel)', fontWeight: 600 }}>Status</span>
            <div className="filter-chip-row" style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
              <FilterChip active={!status} onClick={() => setStatus('')}>All</FilterChip>
              {Object.values(PAYSLIP_STATUSES).map((s) => (
                <FilterChip
                  key={s}
                  active={status === s}
                  onClick={() => setStatus(s)}
                  tone={STATUS_BADGE_STYLES[s]}
                >
                  {s.charAt(0) + s.slice(1).toLowerCase()}
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

      {loading && payslips.length === 0 ? (
        <div className="dpr-card" style={{ textAlign: 'center', color: 'var(--steel)' }}>
          Loading your payslips…
        </div>
      ) : payslips.length === 0 ? (
        <div className="dpr-card" style={{ textAlign: 'center' }}>
          <p style={{ margin: '0.5rem 0', color: 'var(--navy)', fontWeight: 600 }}>
            No payslips to show.
          </p>
          <p style={{ margin: 0, color: 'var(--steel)', fontSize: '0.85rem' }}>
            Once your admin publishes a payslip, it'll appear here for download.
            You'll also get an email with a link to this page.
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
            {payslips.map((p) => {
              const st = rowStatus(p);
              const badge = STATUS_BADGE_STYLES[st] || STATUS_BADGE_STYLES.DRAFT;
              const emailCfg = p.emailStatus
                ? PAYSLIP_EMAIL_STATUS_LABELS[p.emailStatus]
                : null;
              const emailTone = emailCfg ? emailCfg.tone : null;
              const emailBg = emailTone === 'success' ? '#dcfce7'
                : emailTone === 'danger' ? '#fee2e2'
                : emailTone === 'muted' ? '#f1f5f9'
                : null;
              const emailColor = emailTone === 'success' ? '#166534'
                : emailTone === 'danger' ? '#b91c1c'
                : emailTone === 'muted' ? '#475569'
                : null;
              return (
                <div
                  key={p.id}
                  className="dpr-card"
                  style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}
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
                        {st === 'PUBLISHED' ? 'Published' : st === 'REVOKED' ? 'Revoked' : 'Draft'}
                      </span>
                      <div style={{ marginTop: '0.4rem', color: 'var(--navy)', fontWeight: 600, fontSize: '1.05rem' }}>
                        {monthYearLabel(p.year, p.month)}
                      </div>
                    </div>
                  </div>

                  <div style={{ fontSize: '0.78rem', color: 'var(--steel)', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                    {p.publishedAt ? (
                      <span>Published {formatShortDate(p.publishedAt)}</span>
                    ) : (
                      <span>Not yet published</span>
                    )}
                    <span>{formatBytes(p.sizeBytes)} · PDF</span>
                    {emailCfg && (
                      <span style={{
                        display: 'inline-block', alignSelf: 'flex-start',
                        fontSize: '0.65rem', fontWeight: 700,
                        background: emailBg, color: emailColor,
                        padding: '2px 8px', borderRadius: 999,
                        textTransform: 'uppercase', letterSpacing: '0.04em',
                      }}>
                        Email: {emailCfg.label}
                      </span>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'flex-end', marginTop: '0.25rem' }}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => handleDownload(p)}
                      disabled={!p.publishedAt || downloadingId === p.id || !!downloadingId}
                      aria-label={`Download payslip for ${monthYearLabel(p.year, p.month)}`}
                    >
                      {downloadingId === p.id ? 'Downloading…' : 'Download'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ textAlign: 'center', color: 'var(--steel)', fontSize: '0.8rem', padding: '0.75rem' }}>
            Showing {payslips.length} of {total} payslip{total !== 1 ? 's' : ''}
          </div>

          {nextCursor && (
            <div style={{ textAlign: 'center', paddingBottom: '1rem' }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => fetchPayslips({ append: true, cursor: nextCursor })}
                disabled={loadingMore}
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Tiny chip helper — mirrors MyCertifications.jsx:556-573 so the two
// pages share a single visual vocabulary.
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