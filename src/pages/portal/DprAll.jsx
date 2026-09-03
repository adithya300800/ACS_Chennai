import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import StatusBadge from '../../components/StatusBadge.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { CalendarIcon, MapPinIcon, CameraIcon, ClipboardIcon } from '../../components/Icons.jsx';

// Round-22: admin cross-org DPR list. The previous "My Daily Reports" page
// (DprList at /portal/dpr/my) rendered every org DPR for admins because the
// backend GET /api/dpr returns all rows when no `my=true` filter is set,
// making the page title misleading for the admin role. This new page —
// mirroring InspectionAll — gives admins an explicit, well-named destination
// for browsing the cross-org DPR history. Layout is a card grid (not the
// row-list of DprList) to match the All Inspection Records visual contract.
// Click a card to open an inline detail modal; no separate /portal/dpr/:id
// route exists, so we mirror DprList's modal pattern.

const WORK_TYPE_LABEL = {
  MATERIAL_RECEIPT: 'Material Receipt',
  QUALITY_TESTING: 'Quality Testing',
  SITE_INSPECTION: 'Site Inspection',
  EXCEPTIONS_SAFETY: 'Exceptions / Safety',
};

// Same per-page status map as DprList.jsx so SUBMITTED stays visually
// distinct from UNDER_REVIEW (round-15 SOL C-06).
const DPR_STATUS_MAP = {
  DRAFT: 'dpr-status-draft',
  SUBMITTED: 'dpr-status-submitted',
  UNDER_REVIEW: 'dpr-status-review',
  APPROVED: 'dpr-status-approved',
  REJECTED: 'dpr-status-rejected',
};

function PhotoThumb({ photo }) {
  const src = photo.thumbUrl || photo.readUrl || photo.blobUrl;
  if (!src) {
    return (
      <div
        className="text-placeholder"
        style={{ width: '100%', height: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--steel)', background: '#f1f5f9', borderRadius: 6 }}
      >
        <CameraIcon size={20} />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={photo.caption || 'Site photo'}
      loading="lazy"
      style={{ width: '100%', height: 100, objectFit: 'cover', borderRadius: 6, display: 'block' }}
    />
  );
}

function DprDetailModal({ dprSummary, onClose }) {
  const { accessToken } = useAuth();
  const [dpr, setDpr] = useState(dprSummary);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api.getDpr(dprSummary.id, accessToken)
      .then((full) => {
        if (cancelled) return;
        setDpr(full);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || 'Failed to load DPR details');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [dprSummary.id, accessToken]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`DPR ${dpr?.projectName || ''} details`}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 100, padding: '1rem',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 12, maxWidth: 720, width: '100%',
          maxHeight: '90vh', overflowY: 'auto', padding: '1.5rem',
          boxShadow: '0 20px 60px rgba(15,23,42,0.3)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem', gap: '1rem' }}>
          <div>
            <h2 style={{ margin: 0, color: 'var(--navy)', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
              {dpr?.projectName || 'DPR'}
            </h2>
            <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <StatusBadge status={dpr?.status} map={DPR_STATUS_MAP} />
              <span style={{ fontSize: '0.85rem', color: 'var(--steel)' }}>
                {WORK_TYPE_LABEL[dpr?.workType] || dpr?.workType || '—'}
              </span>
            </div>
          </div>
          <button type="button" onClick={onClose} className="btn btn-ghost btn-sm" aria-label="Close details">✕</button>
        </div>

        {loading ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--steel)' }}>Loading details…</div>
        ) : error ? (
          <div className="portal-auth-error">{error}</div>
        ) : dpr ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '1rem' }}>
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--steel)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Report date</div>
                <div style={{ color: 'var(--navy)' }}>{dpr.reportDate ? new Date(dpr.reportDate).toLocaleDateString() : '—'}</div>
              </div>
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--steel)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Location</div>
                <div style={{ color: 'var(--navy)' }}>{dpr.location || '—'}</div>
              </div>
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--steel)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Submitted by</div>
                <div style={{ color: 'var(--navy)' }}>{dpr.submittedBy?.name || '—'}</div>
              </div>
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--steel)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Weather</div>
                <div style={{ color: 'var(--navy)' }}>{dpr.weather || '—'}{dpr.temperature ? ` · ${dpr.temperature}` : ''}</div>
              </div>
            </div>

            {dpr.workExecutedToday && (
              <div style={{ marginBottom: '1rem' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--steel)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.25rem' }}>Work executed today</div>
                <div style={{ whiteSpace: 'pre-wrap', color: 'var(--navy)' }}>{dpr.workExecutedToday}</div>
              </div>
            )}
            {dpr.notes && (
              <div style={{ marginBottom: '1rem' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--steel)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.25rem' }}>Other observations</div>
                <div style={{ whiteSpace: 'pre-wrap', color: 'var(--navy)' }}>{dpr.notes}</div>
              </div>
            )}

            {Array.isArray(dpr.photos) && dpr.photos.length > 0 && (
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--steel)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.5rem' }}>
                  Photos ({dpr.photos.length})
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '0.5rem' }}>
                  {dpr.photos.map((p) => (
                    <div key={p.id || p.ulid}>
                      <PhotoThumb photo={p} />
                      {p.caption && <div style={{ fontSize: '0.75rem', color: 'var(--steel)', marginTop: '0.25rem' }}>{p.caption}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

export default function DprAll() {
  useDocumentTitle('All Daily Reports Records');
  const { accessToken } = useAuth();
  const toast = useToast();
  const [dprs, setDprs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedDpr, setSelectedDpr] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // GET /api/dpr returns every org row for admins by default (no
      // `my=true` filter). See backend/src/routes/dpr.js:633 — the
      // restrictToSelf check is `!isAdmin || my === 'true'`. Limit 100
      // matches InspectionAll's browse-view contract.
      const data = await api.getDprs({ limit: '100' }, accessToken);
      setDprs(data.dprs || []);
    } catch (err) {
      if (err.status !== 401) {
        setError(err.message || 'Failed to load all daily reports.');
        toast.push(err.message || 'Failed to load all daily reports.', 'error');
      }
    } finally {
      setLoading(false);
    }
  }, [accessToken, toast]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="dpr-page">
      <div className="dpr-page-header">
        <div>
          <h1 className="dpr-page-title">All Daily Reports Records</h1>
          <p className="dpr-page-sub" style={{ color: 'var(--steel)', margin: 0, fontSize: '0.9rem' }}>
            Every daily progress report across the organization.
          </p>
        </div>
        <a href="#/portal/admin/dpr" className="btn btn-secondary btn-sm">
          ← Back to admin review queue
        </a>
      </div>

      {error && <div className="portal-auth-error" style={{ marginBottom: '1rem' }}>{error}</div>}

      {loading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--steel)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>⏳</div>
          Loading records…
        </div>
      ) : dprs.length === 0 ? (
        <div className="dpr-list-empty" style={{ textAlign: 'center', padding: '3rem' }}>
          <div style={{ marginBottom: '1rem', color: 'var(--steel)' }}>
            <ClipboardIcon size={48} />
          </div>
          <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", color: 'var(--navy)' }}>
            No daily reports yet
          </h3>
          <p style={{ color: 'var(--steel)' }}>Nothing has been submitted across the org.</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1rem' }}>
          {dprs.map((dpr) => {
            const workTypeLabel = WORK_TYPE_LABEL[dpr.workType] || dpr.workType || '—';
            return (
              <div
                key={dpr.id}
                role="button"
                tabIndex={0}
                className="dpr-card"
                onClick={() => setSelectedDpr(dpr)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelectedDpr(dpr);
                  }
                }}
                aria-label={`${dpr.projectName || 'Untitled'} — ${dpr.status}`}
                style={{ cursor: 'pointer', textDecoration: 'none', color: 'inherit', display: 'block' }}
              >
                <div className="dpr-card-header">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h3 className="dpr-card-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{dpr.projectName || 'Untitled'}</h3>
                    <div className="dpr-card-meta" style={{ marginTop: '0.5rem' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                        <CalendarIcon size={13} style={{ color: 'var(--steel)' }} />
                        {dpr.reportDate ? new Date(dpr.reportDate).toLocaleDateString() : '—'}
                      </span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                        <MapPinIcon size={13} style={{ color: 'var(--steel)' }} />
                        {dpr.location || '—'}
                      </span>
                    </div>
                  </div>
                  <StatusBadge status={dpr.status} map={DPR_STATUS_MAP} />
                </div>
                <div style={{ fontSize: '0.85rem', color: 'var(--steel)', marginBottom: '0.5rem' }}>{workTypeLabel}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--steel)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #f1f5f9', paddingTop: '0.5rem', marginTop: '0.5rem' }}>
                  <span>
                    Submitted by <strong style={{ color: 'var(--navy)' }}>{dpr.submittedBy?.name || '—'}</strong>
                  </span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                    <CameraIcon size={13} />
                    {Array.isArray(dpr.photos) ? dpr.photos.length : 0}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {selectedDpr && (
        <DprDetailModal dprSummary={selectedDpr} onClose={() => setSelectedDpr(null)} />
      )}
    </div>
  );
}
