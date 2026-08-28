import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { api } from '../../lib/api.js';

const STATUS_FILTERS = [
  { value: '', label: 'All Statuses' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'SUBMITTED', label: 'Submitted' },
  { value: 'UNDER_REVIEW', label: 'Under Review' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
];

function StatusBadge({ status }) {
  const cls = {
    DRAFT: 'dpr-status-draft',
    SUBMITTED: 'dpr-status-submitted',
    UNDER_REVIEW: 'dpr-status-review',
    APPROVED: 'dpr-status-approved',
    REJECTED: 'dpr-status-rejected',
  }[status] || 'dpr-status-draft';
  const label = {
    DRAFT: 'Draft',
    SUBMITTED: 'Submitted',
    UNDER_REVIEW: 'Under Review',
    APPROVED: 'Approved',
    REJECTED: 'Rejected',
  }[status] || status;
  return <span className={`dpr-status-badge ${cls}`}>{label}</span>;
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function DprList() {
  const { accessToken } = useAuth();
  const navigate = useNavigate();

  const [dprs, setDprs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState(null);
  const [filter, setFilter] = useState({ status: '', myOnly: false, from: '', to: '' });
  const [showFilters, setShowFilters] = useState(false);

  const fetchDprs = useCallback(async (cursor = null) => {
    try {
      const params = {};
      if (filter.status) params.status = filter.status;
      if (filter.myOnly) params.my = 'true';
      if (filter.from) params.from = filter.from;
      if (filter.to) params.to = filter.to;
      if (cursor) params.cursor = cursor;

      const data = await api.getDprs(params, accessToken);
      return data;
    } catch (err) {
      throw err;
    }
  }, [accessToken, filter]);

  const load = useCallback(async (cursor = null) => {
    if (cursor) setLoadingMore(true);
    else setLoading(true);
    try {
      const data = await fetchDprs(cursor);
      if (cursor) {
        setDprs(prev => [...prev, ...data.dprs]);
      } else {
        setDprs(data.dprs || []);
      }
      setNextCursor(data.nextCursor || null);
      setHasMore(data.nextCursor != null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [fetchDprs]);

  useEffect(() => {
    load();
  }, [filter]);

  const handleFilterChange = (key, value) => {
    setFilter(f => ({ ...f, [key]: value }));
  };

  const handleLoadMore = () => {
    if (nextCursor && !loadingMore) load(nextCursor);
  };

  const handleRowClick = (dpr) => {
    navigate('/portal/dpr/my', { state: { selectedDpr: dpr } });
  };

  return (
    <div className="dpr-page">
      <div className="dpr-page-header">
        <h1 className="dpr-page-title">My DPRs</h1>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button className="btn btn-secondary btn-sm" onClick={() => setShowFilters(s => !s)}>
            <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M22 3H2l8 9.46V19l4 2V12.46z"/></svg>
            Filters {showFilters ? '▲' : '▼'}
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => navigate('/portal/dpr/submit')}>
            + New DPR
          </button>
        </div>
      </div>

      {showFilters && (
        <div className="dpr-card" style={{ marginBottom: '1rem' }}>
          <div className="form-row">
            <div className="form-group">
              <label>Status</label>
              <select className="form-input" value={filter.status} onChange={e => handleFilterChange('status', e.target.value)}>
                {STATUS_FILTERS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>From Date</label>
              <input type="date" className="form-input" value={filter.from} onChange={e => handleFilterChange('from', e.target.value)} />
            </div>
            <div className="form-group">
              <label>To Date</label>
              <input type="date" className="form-input" value={filter.to} onChange={e => handleFilterChange('to', e.target.value)} />
            </div>
            <div className="form-group" style={{ justifyContent: 'flex-end' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                <input type="checkbox" checked={filter.myOnly} onChange={e => handleFilterChange('myOnly', e.target.checked)} />
                My DPRs only
              </label>
            </div>
          </div>
          {(filter.status || filter.from || filter.to) && (
            <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setFilter({ status: '', myOnly: false, from: '', to: '' })}>
                Clear filters
              </button>
            </div>
          )}
        </div>
      )}

      {error && <div className="portal-auth-error" style={{ marginBottom: '1rem' }}>{error}</div>}

      {loading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--steel)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>⏳</div>
          Loading DPRs...
        </div>
      ) : dprs.length === 0 ? (
        <div className="dpr-list-empty">
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>📋</div>
          <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", color: 'var(--navy)', marginBottom: '0.5rem' }}>No DPRs found</h3>
          <p style={{ color: 'var(--steel)', marginBottom: '1.5rem' }}>
            {filter.status || filter.myOnly || filter.from || filter.to
              ? 'No DPRs match your current filters.'
              : "You haven't submitted any DPRs yet."}
          </p>
          <button className="btn btn-primary" onClick={() => navigate('/portal/dpr/submit')}>
            Submit Your First DPR
          </button>
        </div>
      ) : (
        <>
          <div className="dpr-card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="dpr-list-item" style={{ background: '#f8fafc', fontWeight: 600, fontSize: '0.8rem', color: 'var(--steel)', padding: '0.75rem 1rem' }}>
              <div style={{ flex: '0 0 36px' }}></div>
              <div style={{ flex: 2 }}>Project / Date</div>
              <div style={{ flex: 1, display: 'none' }}>Location</div>
              <div style={{ flex: 1 }}>Status</div>
              <div style={{ flex: 1 }}>Photos</div>
              <div style={{ flex: 1 }}>Submitted</div>
            </div>

            {dprs.map(dpr => (
              <div
                key={dpr.id}
                className="dpr-list-item"
                onClick={() => handleRowClick(dpr)}
                style={{ cursor: 'pointer' }}
              >
                <div style={{ flex: '0 0 36px', fontSize: '1.25rem' }}>📄</div>
                <div style={{ flex: 2 }}>
                  <div style={{ fontWeight: 600, color: 'var(--navy)', marginBottom: '0.25rem' }}>{dpr.projectName}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--steel)' }}>
                    {new Date(dpr.reportDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                    {dpr.contractor ? ` · ${dpr.contractor}` : ''}
                  </div>
                </div>
                <div style={{ flex: 1, display: 'none' }} className="dpr-list-location">{dpr.location}</div>
                <div style={{ flex: 1 }}>
                  <StatusBadge status={dpr.status} />
                </div>
                <div style={{ flex: 1, color: 'var(--steel)', fontSize: '0.85rem' }}>
                  {dpr.photos?.length || 0} photos
                </div>
                <div style={{ flex: 1, color: 'var(--steel)', fontSize: '0.8rem' }}>
                  {dpr.submittedAt ? (
                    <div>
                      <div>{timeAgo(dpr.submittedAt)}</div>
                      <div style={{ fontSize: '0.75rem' }}>{dpr.submittedBy?.name}</div>
                    </div>
                  ) : (
                    <span style={{ color: '#94a3b8' }}>Draft</span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {hasMore && (
            <div style={{ textAlign: 'center', padding: '1.5rem' }}>
              <button className="btn btn-secondary" onClick={handleLoadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading...' : 'Load More'}
              </button>
            </div>
          )}

          <div className="dpr-list-count" style={{ textAlign: 'center', color: 'var(--steel)', fontSize: '0.8rem', padding: '0.5rem' }}>
            Showing {dprs.length} DPR{dprs.length !== 1 ? 's' : ''}
            {!hasMore && filter.status && ` · All ${filter.status.toLowerCase().replace('_', ' ')} DPRs loaded`}
          </div>
        </>
      )}
    </div>
  );
}
