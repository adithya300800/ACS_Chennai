import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import StatusBadge from '../../components/StatusBadge.jsx';

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
        style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem', color: '#94a3b8' }}
      >
        📷
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
  const { accessToken, employee } = useAuth();
  const toast = useToast();
  const [dprs, setDprs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reviewing, setReviewing] = useState(null); // id of DPR being reviewed
  const [adminNotes, setAdminNotes] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [actionLoading, setActionLoading] = useState('');
  const [filter, setFilter] = useState('SUBMITTED');
  const [stats, setStats] = useState({ today: 0, pending: 0, approvedWeek: 0, total: 0, openInspections: 0 });

  const loadDprs = useCallback(async () => {
    const data = await api.getDprs({ status: filter }, accessToken);
    return data.dprs || [];
  }, [accessToken, filter]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [pendingData, todayData, weekData, openInspectionsData] = await Promise.all([
        api.getDprs({ status: 'SUBMITTED' }, accessToken),
        api.getDprs({ status: 'UNDER_REVIEW' }, accessToken),
        api.getDprs({ status: 'APPROVED' }, accessToken),
        // Round-12: 5th stat card — open inspection records across the org.
        // Non-fatal if it fails (e.g. permissions); fall back to 0.
        api.getInspections({ status: 'OPEN', limit: '1' }, accessToken).catch(() => ({ inspections: [] })),
      ]);

      setStats({
        today: (pendingData.dprs || []).length,
        pending: (todayData.dprs || []).length,
        approvedWeek: (weekData.dprs || []).length,
        total: (pendingData.dprs || []).length + (todayData.dprs || []).length,
        openInspections: openInspectionsData.inspections?.length || 0,
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
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED'].map((s) => (
            <button
              key={s}
              className={`btn btn-sm ${filter === s ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setFilter(s)}
            >
              {s === 'UNDER_REVIEW' ? 'Under Review' : s.charAt(0) + s.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="dpr-dashboard-stats">
        <StatCard number={stats.today} label="Submitted Today" />
        <StatCard number={stats.pending} label="Pending Review" color="#f59e0b" />
        <StatCard number={stats.approvedWeek} label="Approved" color="#22c55e" />
        <StatCard number={stats.openInspections} label="Open Inspections" color="#dc2626" />
        <StatCard number={stats.total} label="Total Active DPRs" />
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
          {dprs.map((dpr) => (
            <div key={dpr.id} className="dpr-card">
              <div className="dpr-card-header">
                <div>
                  <h3 className="dpr-card-title">{dpr.projectName}</h3>
                  <div className="dpr-card-meta" style={{ marginTop: '0.5rem' }}>
                    <span>📍 {dpr.location}</span>
                    <span>📅 {new Date(dpr.reportDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
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
                  {dpr.photos.slice(0, 4).map((photo) => (
                    <a
                      key={photo.id}
                      href={photo.readUrl || photo.blobUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ width: 56, height: 56, borderRadius: 6, background: '#f1f5f9', overflow: 'hidden', flexShrink: 0, display: 'block' }}
                      title={photo.caption || 'Open photo'}
                    >
                      <PhotoThumb photo={photo} />
                    </a>
                  ))}
                  {dpr.photos.length > 4 && (
                    <div style={{ width: 56, height: 56, borderRadius: 6, background: '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', color: 'var(--steel)' }}>
                      +{dpr.photos.length - 4}
                    </div>
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
                          onClick={() => handleApprove(dpr.id)}
                          disabled={!!actionLoading}
                          style={{ flex: 1 }}
                        >
                          {actionLoading === 'approve' ? 'Approving...' : '✓ Approve'}
                        </button>
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => handleReject(dpr.id)}
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
                      onClick={() => setReviewing(dpr.id)}
                      style={{ flex: 1 }}
                    >
                      Review
                    </button>
                  )}
                </div>
              )}

              {dpr.status === 'APPROVED' && (
                <div style={{ textAlign: 'center', padding: '0.5rem', background: '#dcfce7', borderRadius: 6, color: '#16a34a', fontSize: '0.85rem', fontWeight: 500 }}>
                  ✓ Approved
                </div>
              )}

              {dpr.status === 'REJECTED' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  <div style={{ textAlign: 'center', padding: '0.5rem', background: '#fee2e2', borderRadius: 6, color: '#dc2626', fontSize: '0.85rem', fontWeight: 500 }}>
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
          ))}
        </div>
      )}
    </div>
  );
}
