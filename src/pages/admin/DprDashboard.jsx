import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { formatShortDate } from '../../lib/format.js';
import StatusBadge from '../../components/StatusBadge.jsx';
import PhotoDownloadButton from '../../components/PhotoDownloadButton.jsx';
import PhotoLightbox from '../../components/PhotoLightbox.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { CalendarIcon, MapPinIcon, CameraIcon } from '../../components/Icons.jsx';

// C-06 (round-15+): local StatusBadge removed. We pass a per-page `map` so
// SUBMITTED keeps its distinct blue (dpr-status-submitted, #dbeafe/#1d4ed8)
// separate from UNDER_REVIEW (dpr-status-review, yellow). The shared default
// collapses both to review-yellow, which would lose the visual hierarchy
// here (SUBMITTED is "awaiting pickup", UNDER_REVIEW is "admin has it").
const DPR_STATUS_MAP = {
  DRAFT: 'dpr-status-draft',
  SUBMITTED: 'dpr-status-submitted',
  UNDER_REVIEW: 'dpr-status-review',
  APPROVED: 'dpr-status-approved',
  REJECTED: 'dpr-status-rejected',
};

function StatCard({ number, label, color }) {
  return (
    <div className="dpr-stat-card">
      <div className="dpr-stat-number" style={color ? { color } : {}}>{number}</div>
      <div className="dpr-stat-label">{label}</div>
    </div>
  );
}

function PhotoThumb({ photo }) {
  const src = photo.thumbUrl || photo.readUrl || photo.blobUrl;
  if (!src) {
    return (
      <div
        className="text-placeholder"
        style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--steel)' }}
      >
        <CameraIcon size={16} />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={photo.caption || 'Site photo'}
      loading="lazy"
      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
    />
  );
}

export default function DprDashboard() {
  useDocumentTitle('Daily Reports Review');
  const { accessToken, employee } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [dprs, setDprs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reviewing, setReviewing] = useState(null); // id of DPR being reviewed
  const [adminNotes, setAdminNotes] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [actionLoading, setActionLoading] = useState('');
  const [filter, setFilter] = useState('SUBMITTED');
  // DR-029 (round-20): stats now come from /api/dpr/stats — a single
  // request that returns six explicit aggregate counts against the indexed
  // reportDate / status / approvedAt / reviewedAt columns. Replaces the
  // previous "fetch limit=20 paginated lists, use response.length" pattern
  // that silently capped every tile at 20. See docs/dashboard-metrics.md
  // for the field → label contract.
  const [stats, setStats] = useState({
    submittedToday: 0,
    pendingReview: 0,
    approvedToday: 0,
    rejectedToday: 0,
    draftCount: 0,
    totalActive: 0,
  });

  // Round-17 B-06: bulk-select state. We only allow selecting DPRs in a
  // reviewable state (SUBMITTED / UNDER_REVIEW) — APPROVED / REJECTED are
  // terminal and can't move forward, so checking them would only confuse
  // the admin. `selectableIds` is computed from the loaded list each render.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkActionLoading, setBulkActionLoading] = useState(false);
  // SOL-P0#5: confirmation summary before destructive actions. Holds the
  // pending action and the IDs it would touch; null = no dialog open.
  const [confirmAction, setConfirmAction] = useState(null); // { kind, dprId?, ids?, action?, reason? }
  const [bulkRejectReason, setBulkRejectReason] = useState('');
  // Round-28 #7: lightbox state. Holds the active DPR + index when a
  // queue-card thumbnail is clicked. null = closed. We previously
  // opened photos in a new tab (`target="_blank"`) but that's friction
  // during fast triage — the admin alt-tabs back and loses their place.
  // In-page lightbox + keyboard nav keeps the review queue in focus.
  const [lightbox, setLightbox] = useState(null); // { photos, index } | null

  const selectableDprs = dprs.filter(
    (d) => d.status === 'SUBMITTED' || d.status === 'UNDER_REVIEW'
  );
  const selectableIds = selectableDprs.map((d) => d.id);
  const allSelected =
    selectableIds.length > 0 &&
    selectableIds.every((id) => selectedIds.has(id));

  const loadDprs = useCallback(async () => {
    const data = await api.getDprs({ status: filter }, accessToken);
    return data.dprs || [];
  }, [accessToken, filter]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // DR-029 (round-20): replace four paginated sample queries with a
      // single stats endpoint. The backend runs six COUNT() queries in
      // parallel against indexed columns; the response includes a `window`
      // echo so we can show "as of <ts>" if we ever want to.
      const statsRes = await api.getDprStats(accessToken);
      setStats({
        submittedToday: Number(statsRes.submittedToday) || 0,
        pendingReview: Number(statsRes.pendingReview) || 0,
        approvedToday: Number(statsRes.approvedToday) || 0,
        rejectedToday: Number(statsRes.rejectedToday) || 0,
        draftCount: Number(statsRes.draftCount) || 0,
        totalActive: Number(statsRes.totalActive) || 0,
      });

      const items = await loadDprs();
      setDprs(items);
    } catch (err) {
      // 401 paths are handled by the api.js interceptor (auth:logout).
      // Round-10: 5xx is shown with a friendlier "temporarily unavailable"
      // message + retry button so the admin doesn't see a generic
      // "Internal server error" and think the app is broken (the underlying
      // cause is usually a transient Prisma cold-start on Render free tier).
      if (err.status !== 401) {
        const isServer = err.status >= 500;
        const msg = isServer
          ? 'DPR queue temporarily unavailable — please retry in a moment.'
          : (err.message || 'Failed to load DPRs.');
        setError(msg);
        toast.push(msg, isServer ? 'warning' : 'error');
      }
    } finally {
      setLoading(false);
    }
  }, [accessToken, filter, loadDprs, toast]);

  useEffect(() => {
    loadAll();
  }, [filter, loadAll]);

  // When the filter changes, the previously selected IDs may no longer be
  // visible — clear them so the floating action bar doesn't show "3 selected"
  // for IDs the admin can't see in the queue anymore.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [filter]);

  // SOL-P0#5: close the confirmation modal on Escape.
  useEffect(() => {
    if (!confirmAction) return;
    const handler = (e) => { if (e.key === 'Escape') setConfirmAction(null); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [confirmAction]);

  const toggleSelected = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      if (allSelected) return new Set();
      return new Set(selectableIds);
    });
  };

  // Round-17 B-06: bulk fan-out for the admin queue. Single network round-trip
  // for N IDs (vs N trips). Per-ID results so the admin can see which ones
  // failed (e.g. already APPROVED via concurrent single-row approve).
  const handleBulkAction = async (action) => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;

    if (action === 'REJECT' && !bulkRejectReason.trim()) {
      toast.push('Reject reason is required.', 'warning');
      return;
    }

    setBulkActionLoading(true);
    try {
      const result = await api.bulkReviewDprs(
        {
          ids,
          action,
          reason: action === 'REJECT' ? bulkRejectReason.trim() : undefined,
          adminNotes: adminNotes.trim() || undefined,
        },
        accessToken
      );

      const verb = action === 'APPROVE' ? 'approved' : action === 'REJECT' ? 'rejected' : 'marked for review';
      if (result.failedCount === 0) {
        toast.push(`${result.succeededCount} DPR${result.succeededCount === 1 ? '' : 's'} ${verb}.`, 'success');
      } else if (result.succeededCount === 0) {
        toast.push(`Bulk ${action.toLowerCase()} failed for all ${result.failedCount} IDs.`, 'error');
      } else {
        toast.push(`${verb}: ${result.succeededCount} ok, ${result.failedCount} failed.`, 'warning');
      }
      setSelectedIds(new Set());
      setBulkRejectReason('');
      setAdminNotes('');
      await loadAll();
    } catch (err) {
      if (err.status !== 401) {
        toast.push(err.message || `Bulk ${action.toLowerCase()} failed.`, 'error');
      }
    } finally {
      setBulkActionLoading(false);
    }
  };

  // Optimistic approve: change the card's status immediately, revert on error.
  // Feels instant on a good connection; rolls back cleanly on a 4xx/5xx.
  const handleApprove = async (dprId) => {
    const snapshot = dprs;
    setActionLoading('approve');
    // Optimistic update
    setDprs((prev) => prev.map((d) => (d.id === dprId ? { ...d, status: 'APPROVED' } : d)));
    try {
      await api.approveDpr(dprId, adminNotes || undefined, accessToken);
      setReviewing(null);
      setAdminNotes('');
      toast.push('DPR approved.', 'success');
      await loadAll();
    } catch (err) {
      setDprs(snapshot);
      if (err.status !== 401) {
        toast.push(err.message || 'Could not approve DPR.', 'error');
      }
    } finally {
      setActionLoading('');
    }
  };

  // Optimistic reject with required reason. Backend POST /:id/reject requires
  // `reason` — the old /review endpoint didn't, which is why "reject button
  // doesn't work" was a real bug.
  const handleReject = async (dprId) => {
    const reason = rejectReason.trim();
    if (!reason) {
      toast.push('Reject reason is required.', 'warning');
      return;
    }
    const snapshot = dprs;
    setActionLoading('reject');
    setDprs((prev) => prev.map((d) => (d.id === dprId ? { ...d, status: 'REJECTED' } : d)));
    try {
      await api.rejectDpr(dprId, reason, adminNotes || undefined, accessToken);
      setReviewing(null);
      setAdminNotes('');
      setRejectReason('');
      toast.push('DPR rejected.', 'success');
      await loadAll();
    } catch (err) {
      setDprs(snapshot);
      if (err.status !== 401) {
        toast.push(err.message || 'Could not reject DPR.', 'error');
      }
    } finally {
      setActionLoading('');
    }
  };

  const closeReview = () => {
    setReviewing(null);
    setAdminNotes('');
    setRejectReason('');
  };

  // SOL-P0#5: run the action that the user confirmed in the dialog.
  // Single approve/reject call into the existing handlers; bulk hands off
  // to handleBulkAction which already does the fan-out.
  const runConfirmedAction = async () => {
    if (!confirmAction) return;
    const a = confirmAction;
    setConfirmAction(null); // close dialog immediately for snappy UX
    if (a.kind === 'single-approve') {
      await handleApprove(a.dprId);
    } else if (a.kind === 'single-reject') {
      await handleReject(a.dprId);
    } else if (a.kind === 'bulk') {
      await handleBulkAction(a.action);
    }
  };

  // Helper for the confirm dialog: derive the user-visible context from the
  // pending action.
  const confirmSummary = () => {
    if (!confirmAction) return null;
    if (confirmAction.kind === 'single-approve' || confirmAction.kind === 'single-reject') {
      const d = dprs.find((x) => x.id === confirmAction.dprId);
      if (!d) return null;
      return {
        verb: confirmAction.kind === 'single-approve' ? 'Approve' : 'Reject',
        tone: confirmAction.kind === 'single-approve' ? 'success' : 'danger',
        title: `${confirmAction.kind === 'single-approve' ? 'Approve' : 'Reject'} this DPR?`,
        rows: [
          ['Project', d.project?.name || d.projectName || '(untitled)'],
          ['Date', formatShortDate(d.reportDate)],
          ['Submitted by', d.submittedBy?.name || '—'],
          ['Contractor', d.contractor || '—'],
          ['Status', d.status],
          ...(confirmAction.reason ? [['Reason', confirmAction.reason]] : []),
        ],
        footer: confirmAction.kind === 'single-approve'
          ? 'This will mark the report as approved. The decision is recorded in the audit trail.'
          : 'This will mark the report as rejected. The reason will be visible to the submitter.',
      };
    }
    if (confirmAction.kind === 'bulk') {
      const targets = dprs.filter((d) => confirmAction.ids.includes(d.id));
      const verb = confirmAction.action === 'APPROVE' ? 'Approve'
        : confirmAction.action === 'REJECT' ? 'Reject'
          : 'Mark for Review';
      const tone = confirmAction.action === 'APPROVE' ? 'success'
        : confirmAction.action === 'REJECT' ? 'danger'
          : 'secondary';
      return {
        verb,
        tone,
        title: `${verb} ${targets.length} DPR${targets.length === 1 ? '' : 's'}?`,
        rows: [
          ['Records', targets.length],
          ...(confirmAction.reason ? [['Reason', confirmAction.reason]] : []),
        ],
        list: targets.map((d) => `${d.project?.name || d.projectName || '(untitled)'} · ${formatShortDate(d.reportDate)} · ${d.submittedBy?.name || '—'}`),
        footer: confirmAction.action === 'APPROVE'
          ? 'Each report will be approved independently. Per-record failures are reported.'
          : confirmAction.action === 'REJECT'
            ? 'Each report will be rejected with the reason above. Per-record failures are reported.'
            : 'Each report will be moved to Under Review.',
      };
    }
    return null;
  };

  if (!employee?.isAdmin) {
    return (
      <div className="dpr-page">
        <div className="dpr-card" style={{ textAlign: 'center', padding: '3rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🔒</div>
          <h2 style={{ color: 'var(--navy)', marginBottom: '0.5rem' }}>Admin Access Required</h2>
          <p style={{ color: 'var(--steel)' }}>You need admin privileges to access the DPR Dashboard.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="dpr-page">
      <div className="dpr-page-header">
        <h1 className="dpr-page-title">Daily Reports Review</h1>
        <div className="dpr-page-tabs">
          {['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED'].map((s) => (
            <button
              key={s}
              className={`btn btn-sm ${filter === s ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setFilter(s)}
            >
              {s === 'UNDER_REVIEW' ? 'Under Review' : s.charAt(0) + s.slice(1).toLowerCase()}
            </button>
          ))}
          {/* Round-17 B-06: only show "Select all" when there's something
              worth selecting (i.e. we're on a reviewable-status tab). */}
          {selectableDprs.length > 0 && (
            <button
              className="btn btn-sm btn-secondary"
              onClick={toggleSelectAll}
              disabled={bulkActionLoading}
              aria-pressed={allSelected}
              title={allSelected ? 'Clear selection' : `Select all ${selectableDprs.length} visible`}
            >
              {allSelected ? '☐ Clear' : `☑ Select all (${selectableDprs.length})`}
            </button>
          )}
        </div>
      </div>

      <div className="dpr-dashboard-stats">
        {/* DR-029 (round-20): labels now match the backend aggregate.
            Each number is a real COUNT() against an indexed column with an
            explicit date window — see docs/dashboard-metrics.md. */}
        <StatCard number={stats.submittedToday} label="Submitted Today" />
        <StatCard number={stats.pendingReview} label="Pending Review" color="#f59e0b" />
        <StatCard number={stats.approvedToday} label="Approved Today" color="#22c55e" />
        <StatCard number={stats.rejectedToday} label="Rejected Today" color="#dc2626" />
        <StatCard number={stats.totalActive} label="Total Active DPRs" />
      </div>

      {error && <div className="portal-auth-error" style={{ marginBottom: '1rem' }}>{error}</div>}

      {loading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1rem' }}>
          {[1, 2, 3].map((i) => (
            <div key={i} className="dpr-card" aria-hidden="true" style={{ minHeight: 220, opacity: 0.55 }}>
              <div style={{ height: 16, background: '#e2e8f0', borderRadius: 4, width: '60%', marginBottom: 12 }} />
              <div style={{ height: 12, background: '#e2e8f0', borderRadius: 4, width: '80%', marginBottom: 8 }} />
              <div style={{ height: 12, background: '#e2e8f0', borderRadius: 4, width: '40%' }} />
            </div>
          ))}
        </div>
      ) : dprs.length === 0 ? (
        <div className="dpr-list-empty">
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>✅</div>
          <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", color: 'var(--navy)', marginBottom: '0.5rem' }}>No DPRs</h3>
          <p style={{ color: 'var(--steel)' }}>
            {filter === 'SUBMITTED' ? 'No DPRs awaiting review.' : `No ${filter.toLowerCase().replace('_', ' ')} DPRs.`}
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1rem' }}>
          {dprs.map((dpr) => {
            const isSelectable = dpr.status === 'SUBMITTED' || dpr.status === 'UNDER_REVIEW';
            const isSelected = selectedIds.has(dpr.id);
            const isReviewing = reviewing === dpr.id;
            // Improvement #1 (round-28): admin review queue cards are now
            // clickable as a whole — the click target opens the same detail
            // modal that /portal/dpr/all uses (DR-015 deep-link pattern).
            // Mirror DprAll.jsx's role="button" + tabIndex + Enter/Space
            // keyboard handler so the queue behaves consistently. When
            // the inline review form is expanded (isReviewing), the card
            // click is suppressed so typing into the reject-reason textarea
            // doesn't accidentally navigate away.
            const handleCardOpen = () => {
              if (isReviewing) return;
              navigate(`/portal/dpr/all?id=${encodeURIComponent(dpr.id)}`);
            };
            return (
            <div
              key={dpr.id}
              role={isReviewing ? undefined : 'button'}
              tabIndex={isReviewing ? -1 : 0}
              className={`dpr-card${isSelected ? ' dpr-card-selected' : ''}${!isReviewing ? ' dpr-card-clickable' : ''}`}
              onClick={handleCardOpen}
              onKeyDown={(e) => {
                if (isReviewing) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleCardOpen();
                }
              }}
              aria-label={isReviewing ? undefined : `Open ${dpr.project?.name || dpr.projectName || 'DPR'} details`}
            >
              {/* Round-17 B-06: per-card checkbox. Only rendered for reviewable
                  statuses; APPROVED/REJECTED cards keep their layout untouched.
                  Round-28: stopPropagation prevents the surrounding card from
                  navigating when the admin toggles the checkbox. */}
              {isSelectable && (
                <label className="dpr-card-checkbox-label" title={isSelected ? 'Deselect' : 'Select'} onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    className="dpr-card-checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelected(dpr.id)}
                    disabled={bulkActionLoading}
                    aria-label={`Select ${dpr.project?.name || dpr.projectName || 'DPR'} for bulk action`}
                  />
                </label>
              )}
              <div className="dpr-card-header">
                <div>
                  <h3 className="dpr-card-title">{dpr.project?.name || dpr.projectName}</h3>
                  <div className="dpr-card-meta" style={{ marginTop: '0.5rem' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                      <MapPinIcon size={13} style={{ color: 'var(--steel)' }} />
                      {dpr.location}
                    </span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                      <CalendarIcon size={13} style={{ color: 'var(--steel)' }} />
                      {formatShortDate(dpr.reportDate)}
                    </span>
                  </div>
                </div>
                <StatusBadge status={dpr.status} map={DPR_STATUS_MAP} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.75rem' }}>
                {dpr.weather && (
                  <div style={{ fontSize: '0.8rem', color: 'var(--steel)' }}>
                    <span style={{ fontWeight: 500 }}>Weather:</span> {dpr.weather}
                  </div>
                )}
                {dpr.temperature && (
                  <div style={{ fontSize: '0.8rem', color: 'var(--steel)' }}>
                    <span style={{ fontWeight: 500 }}>Temp:</span> {dpr.temperature}
                  </div>
                )}
                {dpr.contractor && (
                  <div style={{ fontSize: '0.8rem', color: 'var(--steel)' }}>
                    <span style={{ fontWeight: 500 }}>Contractor:</span> {dpr.contractor}
                  </div>
                )}
                <div style={{ fontSize: '0.8rem', color: 'var(--steel)' }}>
                  <span style={{ fontWeight: 500 }}>Photos:</span> {dpr.photos?.length || 0}
                </div>
                {Array.isArray(dpr.inspections) && dpr.inspections.length > 0 && (
                  <div style={{ fontSize: '0.8rem', color: 'var(--steel)' }}>
                    <span style={{ fontWeight: 500 }}>Inspections:</span>{' '}
                    {dpr.inspections.length} linked
                  </div>
                )}
              </div>

              {dpr.submittedBy && (
                <div style={{ fontSize: '0.8rem', color: 'var(--steel)', marginBottom: '0.75rem' }}>
                  <span style={{ fontWeight: 500 }}>Submitted by:</span> {dpr.submittedBy.name}
                  {dpr.submittedAt && (
                    <span> · {new Date(dpr.submittedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                  )}
                </div>
              )}

              {dpr.notes && (
                <div style={{
                  fontSize: '0.85rem',
                  color: 'var(--navy)',
                  background: '#f8fafc',
                  padding: '0.625rem 0.75rem',
                  borderRadius: 6,
                  marginBottom: '0.75rem',
                  borderLeft: '3px solid #cbd5e1',
                  whiteSpace: 'pre-wrap',
                }}>
                  {dpr.notes}
                </div>
              )}

              {/* Photo thumbnails — show actual images when backend provides URLs */}
              {dpr.photos?.length > 0 && (
                <div style={{ display: 'flex', gap: '0.375rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
                  {dpr.photos.slice(0, 4).map((photo, i) => (
                    <button
                      key={photo.id}
                      type="button"
                      // Round-28 #7: open in-page lightbox instead of new
                      // tab. stopPropagation so the parent card doesn't
                      // navigate when the admin taps a thumbnail.
                      onClick={(e) => {
                        e.stopPropagation();
                        setLightbox({ photos: dpr.photos, index: i });
                      }}
                      style={{ position: 'relative', width: 56, height: 56, borderRadius: 6, background: '#f1f5f9', overflow: 'hidden', flexShrink: 0, display: 'block', padding: 0, border: 'none', cursor: 'pointer' }}
                      title={photo.caption || 'Open photo'}
                      aria-label={`Open photo ${i + 1} of ${dpr.photos.length}`}
                    >
                      <PhotoThumb photo={photo} />
                      {/* R22.5: per-image download affordance on the queue
                          card thumbnail. Removing the download button here
                          would lose a feature engineers use frequently for
                          evidence; keep it on top of the button. */}
                      <PhotoDownloadButton photo={photo} />
                    </button>
                  ))}
                  {dpr.photos.length > 4 && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setLightbox({ photos: dpr.photos, index: 4 }); }}
                      style={{ width: 56, height: 56, borderRadius: 6, background: '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', color: 'var(--steel)', border: 'none', cursor: 'pointer' }}
                      aria-label={`Open all ${dpr.photos.length} photos`}
                    >
                      +{dpr.photos.length - 4}
                    </button>
                  )}
                </div>
              )}

              {/* Review actions */}
              {(dpr.status === 'SUBMITTED' || dpr.status === 'UNDER_REVIEW') && (
                <div className="dpr-review-actions">
                  {reviewing === dpr.id ? (
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      <input
                        className="form-input"
                        placeholder="Admin notes (optional)"
                        value={adminNotes}
                        onChange={(e) => setAdminNotes(e.target.value)}
                        style={{ fontSize: '0.85rem', padding: '0.5rem' }}
                      />
                      <textarea
                        className="form-input"
                        placeholder="Reject reason (required for reject)"
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        rows={2}
                        style={{ fontSize: '0.85rem', padding: '0.5rem', resize: 'vertical' }}
                        aria-label="Reject reason"
                      />
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button
                          className="btn btn-success btn-sm"
                          // SOL-P0#5: require a confirmation summary before
                          // approving. Avoids accidental one-click approval.
                          onClick={() => setConfirmAction({ kind: 'single-approve', dprId: dpr.id })}
                          disabled={!!actionLoading}
                          style={{ flex: 1 }}
                        >
                          {actionLoading === 'approve' ? 'Approving...' : '✓ Approve'}
                        </button>
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => setConfirmAction({ kind: 'single-reject', dprId: dpr.id, reason: rejectReason.trim() })}
                          disabled={!!actionLoading || !rejectReason.trim()}
                          title={!rejectReason.trim() ? 'Enter a reject reason first' : ''}
                          style={{ flex: 1 }}
                        >
                          {actionLoading === 'reject' ? 'Rejecting...' : '✗ Reject'}
                        </button>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={closeReview}
                          disabled={!!actionLoading}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={(e) => { e.stopPropagation(); setReviewing(dpr.id); }}
                      style={{ flex: 1 }}
                    >
                      Review
                    </button>
                  )}
                </div>
              )}

              {dpr.status === 'APPROVED' && (
                <div className="dpr-status-approved" style={{ textAlign: 'center', padding: '0.5rem', borderRadius: 6, fontSize: '0.85rem', fontWeight: 500 }}>
                  ✓ Approved
                </div>
              )}

              {dpr.status === 'REJECTED' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  <div className="dpr-status-rejected" style={{ textAlign: 'center', padding: '0.5rem', borderRadius: 6, fontSize: '0.85rem', fontWeight: 500 }}>
                    ✗ Rejected
                  </div>
                  {dpr.rejectionReason && (
                    <div style={{ fontSize: '0.75rem', color: 'var(--steel)', fontStyle: 'italic' }}>
                      Reason: {dpr.rejectionReason}
                    </div>
                  )}
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}

      {/* Round-17 B-06: floating action bar — only renders when something is
          selected. Pinned to the viewport bottom so the admin can apply
          actions without scrolling back up to the toolbar. */}
      {selectedIds.size > 0 && (
        <div className="dpr-bulk-action-bar" role="region" aria-label="Bulk actions">
          <div className="dpr-bulk-action-summary">
            <strong>{selectedIds.size}</strong> selected
            {selectedIds.size > 1 && (
              <button
                type="button"
                className="dpr-bulk-clear"
                onClick={() => setSelectedIds(new Set())}
                disabled={bulkActionLoading}
              >
                Clear
              </button>
            )}
          </div>
          <div className="dpr-bulk-action-controls">
            <input
              type="text"
              className="form-input dpr-bulk-reason-input"
              placeholder="Reject reason (only needed for Reject)"
              value={bulkRejectReason}
              onChange={(e) => setBulkRejectReason(e.target.value)}
              disabled={bulkActionLoading}
              aria-label="Bulk reject reason"
            />
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setConfirmAction({ kind: 'bulk', action: 'UNDER_REVIEW', ids: [...selectedIds] })}
              disabled={bulkActionLoading}
            >
              {bulkActionLoading ? '...' : '↪ Mark for Review'}
            </button>
            <button
              type="button"
              className="btn btn-success btn-sm"
              onClick={() => setConfirmAction({ kind: 'bulk', action: 'APPROVE', ids: [...selectedIds] })}
              disabled={bulkActionLoading}
            >
              {bulkActionLoading ? '...' : '✓ Approve'}
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => setConfirmAction({
                kind: 'bulk',
                action: 'REJECT',
                ids: [...selectedIds],
                reason: bulkRejectReason.trim(),
              })}
              disabled={bulkActionLoading || !bulkRejectReason.trim()}
              title={!bulkRejectReason.trim() ? 'Enter a reject reason first' : ''}
            >
              {bulkActionLoading ? '...' : '✗ Reject'}
            </button>
          </div>
        </div>
      )}

      {/* SOL-P0#5: approval / rejection confirmation summary. Renders an
          accessible modal listing the affected records + context before
          any state change is committed. Backdrop click and Escape cancel. */}
      {confirmAction && confirmSummary() && (() => {
        const s = confirmSummary();
        const toneColor = s.tone === 'success' ? 'var(--success-strong, #16a34a)'
          : s.tone === 'danger' ? 'var(--danger, #dc2626)'
            : 'var(--blue, #0066ff)';
        return (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="dpr-confirm-title"
            onClick={() => setConfirmAction(null)}
            style={{
              position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              zIndex: 110, padding: '1rem',
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: 'white', borderRadius: 12, maxWidth: 560, width: '100%',
                maxHeight: '85vh', overflow: 'auto',
                boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
              }}
            >
              <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border, #e2e8f0)' }}>
                <h2 id="dpr-confirm-title" style={{ margin: 0, fontSize: '1.1rem', color: 'var(--navy)' }}>
                  {s.title}
                </h2>
              </div>
              <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.4rem 1rem', fontSize: '0.9rem' }}>
                  {s.rows.map(([k, v]) => (
                    <React.Fragment key={k}>
                      <dt style={{ fontWeight: 600, color: 'var(--steel)' }}>{k}:</dt>
                      <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{v}</dd>
                    </React.Fragment>
                  ))}
                </dl>
                {s.list && (
                  <ul style={{ listStyle: 'none', padding: '0.5rem 0.75rem', margin: 0, background: '#f8fafc', borderRadius: 6, maxHeight: 180, overflow: 'auto', fontSize: '0.85rem' }}>
                    {s.list.map((row, i) => (
                      <li key={i} style={{ padding: '0.25rem 0' }}>• {row}</li>
                    ))}
                  </ul>
                )}
                {s.footer && (
                  <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--steel)' }}>{s.footer}</p>
                )}
              </div>
              <div style={{ padding: '1rem 1.5rem', borderTop: '1px solid var(--border, #e2e8f0)', display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setConfirmAction(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ background: toneColor, color: 'white', border: 'none', minWidth: 120 }}
                  onClick={runConfirmedAction}
                  autoFocus
                >
                  Yes, {s.verb}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Round-28 #7: in-page photo lightbox. Rendered at the page root
          so it sits outside the card grid; the createPortal inside
          PhotoLightbox moves it to <body> so it stacks above every
          z-index in the app, including the approval-confirm modal (110). */}
      <PhotoLightbox
        photos={lightbox?.photos || []}
        startIndex={lightbox?.index || 0}
        open={lightbox !== null}
        onClose={() => setLightbox(null)}
      />
    </div>
  );
}
