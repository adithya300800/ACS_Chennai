// [Payslips Stage 1 / commit 6 — frontend, fixup] Employee "My Payslips" page.
//
// Read-only inbox of the employee's own payslips, sourced from
// GET /api/portal/payslips (requireAuth + IDOR guard WHERE employeeId =
// req.employeeId AND deletedAt IS NULL — backend/routes/payslip.js:556-590).
// The page surfaces two columns per row: month/year label and a
// Download button that goes through api.downloadPayslip(id, token) →
// api.download() → blob → objectURL → <a download> trigger (the
// exportUrlRef pattern from src/pages/portal/Admin.jsx:38-50, 98-125 —
// revoke on unmount + revoke before re-use).
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
// Plain newest-first list, server-capped at 50. No year filter, no
// status chip row, no cursor pagination, no "Load more" button — the
// plan (§B.2.1 + §E.3) removed all of these. A payslip list is
// 12 rows per year per employee; 50 rows is plenty of headroom and
// the API returns rows sorted by (year DESC, month DESC). An employee
// who needs an older payslip asks HR — there is no "scrolling back
// through 6 years" UX in v1.
//
// EMAIL STATUS IS NOT SHOWN HERE. The plan §B.2.1 puts the
// `emailStatus` (SENT / PENDING / FAILED / SKIPPED_*) pill on the
// admin's coverage view (src/pages/admin/AdminPayslips.jsx) only.
// An employee who sees "FAILED" on their own row cannot act on it
// (they cannot re-trigger the email; only an admin can) and a
// "PENDING" pill is a noisy "wait a few minutes" that just causes
// "did I get paid?" tickets. The plan deliberately keeps the
// employee view focused on the only thing the employee can act on:
// download the PDF. The header copy used to explain the "Sending…"
// state — that copy is gone too because there is no longer a state
// to explain.
//
// No console.log calls anywhere (DR-018 family). No hashIdentifier
// use — PII hashing is a backend concern (lib/log.js calls redact()
// on every log context). The page reads payslip.id / payslip.year /
// payslip.month from the wire only; the human-facing "September 2026"
// label is rendered via formatMonthLabel() which is a pure formatter.

import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  formatBytes,
  formatMonthLabel,
} from '../../lib/format.js';

const DEFAULT_LIMIT = 50;

// The portal list endpoint (backend/src/routes/payslip.js, employee
// sub-router) enforces a four-guard predicate on the server side:
//   publishedAt IS NOT NULL   (drafts are admin-only)
//   deletedAt   IS NULL       (revoked rows are excluded)
//   purgedAt    IS NULL       (tombstoned rows are excluded)
//   employeeId  = session     (IDOR guard)
// The wire therefore only ever contains PUBLISHED rows for the
// requesting employee — there is no "draft" or "revoked" or "purged"
// state to surface here, so no filter chips are needed. We keep a
// tiny per-row status pill for visual rhythm (so the card doesn't
// read as an empty heading) but the pill only ever shows "Published"
// because that's the only state the server returns.
const PUBLISHED_BADGE = { background: '#dcfce7', color: '#166534' };

function monthYearLabel(year, month) {
  if (!year || !month) return '—';
  return formatMonthLabel(`${year}-${String(month).padStart(2, '0')}`);
}

export default function MyPayslips() {
  useDocumentTitle('My Payslips');
  const { accessToken } = useAuth();
  const toast = useToast();

  // Data state — plain newest-first list. No filter, no cursor, no
  // "Load more" button. The server returns rows sorted by (year DESC,
  // month DESC) and caps at 50 (DEFAULT_LIMIT); the page renders
  // whatever the server returned.
  const [payslips, setPayslips] = useState([]);
  const [loading, setLoading] = useState(false);
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

  // ── Viewer modal (PUBLISHED rows) ──────────────────────────────────
  // Mirrors the admin viewer's plumbing (AdminPayslips.jsx:272-305).
  // Clicking "View" fetches the PDF as a Blob via the shared
  // `api.downloadPayslip` (which routes through `api.download` —
  // 401-refresh + filename-parse + AbortController timeout), mints a
  // `blob:` object URL, and renders it inside an `<object data
  // type="application/pdf">`. The blob URL is same-origin and does
  // not inherit the API response's headers, so the portal's
  // X-Frame-Options / CSP frame-ancestors are not in play for the
  // rendered document.
  //
  // The download path's `downloadUrlRef` (above) is for the file-save
  // flow (revoked immediately after the synthetic <a> click); this
  // new `viewerUrlRef` is for the modal (revoked on close or
  // unmount). They never share because their lifecycles don't
  // overlap.
  const [viewerRow, setViewerRow] = useState(null); // { id, year, month, sizeBytes, publishedAt }
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
  // Unmount safety net — covers the case where the employee navigates
  // away from the page while the modal is still mounted (route
  // transition, sidebar click, etc.).
  useEffect(() => () => {
    if (viewerUrlRef.current) URL.revokeObjectURL(viewerUrlRef.current);
  }, []);

  const fetchPayslips = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.getMyPayslips({ limit: String(DEFAULT_LIMIT) }, accessToken);
      setPayslips(data?.payslips || []);
    } catch (err) {
      setError(err?.message || 'Failed to load your payslips');
      setPayslips([]);
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => { fetchPayslips(); }, [fetchPayslips]);

  // Pull-to-refresh — mirrors MyCertifications:146-149.
  const { pullDistance, isRefreshing } = usePullToRefresh(async () => {
    try { await fetchPayslips(); }
    catch (err) { toast.push(err?.message || 'Refresh failed', 'error'); }
  });

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

  // ── Action: open the in-page PDF viewer for a payslip row ───────
  // Reuses `api.downloadPayslip` (the existing helper) — the response
  // body is byte-for-byte identical with or without `?download=1`;
  // only the `Content-Disposition` header differs, and the viewer
  // never reads that header (it mints its own `blob:` URL and renders
  // the PDF via `<object>`). The blob's mime type comes from the
  // server's `Content-Type: application/pdf` response, which is set
  // unconditionally — so the blob always renders correctly in
  // `<object type="application/pdf">`.
  //
  // 404 / 410 are the "this row is no longer available" path (a
  // revoke-then-click or BLOB_GONE sequence) — surface as a friendly
  // toast and tear the modal back down so the employee isn't stuck
  // on a blank modal frame.
  const openViewer = useCallback(async (row) => {
    if (!row || viewerLoading) return;
    // Tear down any previous blob URL before opening a new modal so a
    // back-to-back View click on row B after row A doesn't leave row
    // A's blob dangling. (Each call mints a fresh URL.)
    revokeViewer();
    setViewerError('');
    setViewerRow(row);
    setViewerLoading(true);
    try {
      const { blob } = await api.downloadPayslip(row.id, accessToken);
      const url = URL.createObjectURL(blob);
      viewerUrlRef.current = url;
      setViewerBlobUrl(url);
    } catch (err) {
      const code = err?.code || '';
      if (code === 'NOT_FOUND' || code === 'PAYSLIP_BLOB_GONE') {
        toast.push('This payslip is no longer available.', 'error');
      } else {
        toast.push(err?.message || 'Could not load the payslip PDF.', 'error');
      }
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

  return (
    <div className="portal-page">
      <PullToRefreshIndicator pullDistance={pullDistance} isRefreshing={isRefreshing} />
      <Breadcrumb items={[{ label: 'My Work' }, { label: 'My Payslips' }]} />

      <header style={{ marginBottom: '0.75rem' }}>
        <h1 style={{ margin: '0 0 0.25rem', color: 'var(--navy)' }}>
          My Payslips
        </h1>
        <p style={{ margin: 0, color: 'var(--steel)', fontSize: '0.85rem' }}>
          Your published payslips. Tap <strong>View</strong> to read it inline or
          <strong> Download</strong> to save a copy. If a payslip doesn't show
          up, check your email — admins publish monthly and a delayed send can
          leave the row late by a few minutes.
        </p>
      </header>

      {error && (
        <div role="alert" style={{ color: 'var(--danger)', marginBottom: '0.75rem', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span>{error}</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => fetchPayslips()}
            aria-label="Retry loading your payslips"
          >
            Retry
          </button>
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
                        background: PUBLISHED_BADGE.background, color: PUBLISHED_BADGE.color,
                        padding: '2px 8px', borderRadius: 999,
                        textTransform: 'uppercase', letterSpacing: '0.04em',
                        whiteSpace: 'nowrap',
                      }}>
                        Published
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
                  </div>

                  <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'flex-end', marginTop: '0.25rem' }}>
                    {p.publishedAt && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => openViewer(p)}
                        disabled={viewerLoading === p.id || !!viewerLoading}
                        aria-label={`View payslip for ${monthYearLabel(p.year, p.month)}`}
                        data-testid="payslip-view-btn"
                      >
                        {viewerLoading === p.id ? 'Loading…' : 'View'}
                      </button>
                    )}
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
            Showing {payslips.length} payslip{payslips.length !== 1 ? 's' : ''}.
          </div>
        </>
      )}

      {/* ── Viewer modal (PUBLISHED rows) ────────────────────────────
          Renders the published PDF in an <object> via a freshly
          minted `blob:` URL. The blob is fetched by
          `api.downloadPayslip` (openViewer), which routes through the
          shared api.download helper. A separate "Open in new tab"
          link is the same blob URL with target=_blank for browsers
          without an inline PDF viewer; a "Download" link uses the
          same href with a `download` attribute so the browser saves
          the bytes with a stable filename. The filename is hardcoded
          — the blob has no Content-Disposition visible to the
          browser, so we supply the same `Payslip-YYYY-MM.pdf` name
          the portal route emits. */}
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
                  aria-label={`Payslip PDF for ${monthYearLabel(viewerRow.year, viewerRow.month)}`}
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
