import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { SUB_WORK_TYPE_OPTIONS } from '../portal/DprWorkTypes.jsx';

// Round-12: admin view across all submitted inspection records across all
// engineers. Mirrors the DprDashboard structure (stat cards + filter chips
// + card grid) but scoped to the InspectionRecord table. The 15 sub-work
// types are the same SUB_WORK_TYPE_OPTIONS imported from DprWorkTypes.jsx
// so a label rename there is reflected here without duplication.

function StatusBadge({ status }) {
  const cls = {
    OPEN: 'dpr-status-draft',
    ACKNOWLEDGED: 'dpr-status-review',
    IN_PROGRESS: 'dpr-status-review',
    PENDING_VERIFICATION: 'dpr-status-review',
    CLOSED: 'dpr-status-approved',
    REJECTED: 'dpr-status-rejected',
  }[status] || 'dpr-status-draft';
  const label = status ? status.replace(/_/g, ' ').toLowerCase() : 'open';
  return <span className={`dpr-status-badge ${cls}`}>{label.charAt(0).toUpperCase() + label.slice(1)}</span>;
}

function SeverityBadge({ severity }) {
  if (!severity) return null;
  const color = severity === 'CRITICAL' ? '#dc2626'
    : severity === 'MAJOR' ? '#f59e0b'
    : '#64748b';
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 12,
        fontSize: '0.7rem',
        fontWeight: 600,
        background: `${color}1a`,
        color,
        border: `1px solid ${color}40`,
      }}
    >
      {severity}
    </span>
  );
}

function InspectionTypeLabel({ type }) {
  const found = SUB_WORK_TYPE_OPTIONS.find((s) => s.value === type);
  return <span>{found ? found.label : type}</span>;
}

function StatCard({ number, label, color }) {
  return (
    <div className="dpr-stat-card">
      <div className="dpr-stat-number" style={color ? { color } : {}}>{number}</div>
      <div className="dpr-stat-label">{label}</div>
    </div>
  );
}

function formatIndianDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function getLocalDate() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now - offset * 60000).toISOString().split('T')[0];
}

export default function InspectionDashboard() {
  const { accessToken, employee } = useAuth();
  const toast = useToast();
  const [inspections, setInspections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState(null);
  const [filterStatus, setFilterStatus] = useState('OPEN');
  const [filterType, setFilterType] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [stats, setStats] = useState({ open: 0, closedWeek: 0, today: 0, total: 0 });

  const fetchPage = useCallback(async (cursor = null) => {
    const params = { limit: '50' };
    if (cursor) params.cursor = cursor;
    if (filterStatus) params.status = filterStatus;
    if (filterType) params.inspectionType = filterType;
    if (filterFrom) params.from = filterFrom;
    if (filterTo) params.to = filterTo;
    const data = await api.getInspections(params, accessToken);
    return data;
  }, [accessToken, filterStatus, filterType, filterFrom, filterTo]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const today = getLocalDate();

      // Fire all stat queries in parallel.
      const [openRes, closedRes, todayRes] = await Promise.all([
        api.getInspections({ status: 'OPEN', limit: '1' }, accessToken),
        api.getInspections({ status: 'CLOSED', from: today, to: today, limit: '1' }, accessToken),
        api.getInspections({ reportDate: today, limit: '1' }, accessToken),
      ]);

      setStats({
        open: openRes.inspections?.length || 0,
        closedWeek: closedRes.inspections?.length || 0,
        today: todayRes.inspections?.length || 0,
        total: (openRes.inspections?.length || 0) + (closedRes.inspections?.length || 0),
      });

      const data = await fetchPage(null);
      setInspections(data.inspections || []);
      setNextCursor(data.nextCursor || null);
      setHasMore(data.nextCursor != null);
    } catch (err) {
      const isServer = err.status >= 500;
      const msg = isServer
        ? 'Inspection queue temporarily unavailable — please retry in a moment.'
        : err.message || 'Failed to load inspection records.';
      setError(msg);
      if (err.status !== 401) toast.push(msg, 'error');
    } finally {
      setLoading(false);
    }
  }, [accessToken, fetchPage, toast]);

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterStatus, filterType, filterFrom, filterTo, accessToken]);

  const handleLoadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await fetchPage(nextCursor);
      setInspections((prev) => [...prev, ...(data.inspections || [])]);
      setNextCursor(data.nextCursor || null);
      setHasMore(data.nextCursor != null);
    } catch (err) {
      toast.push(err.message || 'Failed to load more records.', 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="dpr-page">
      <div className="dpr-page-header">
        <h1 className="dpr-page-title">Inspection &amp; Compliance Dashboard</h1>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <Link to="/portal/inspection/submit" className="btn btn-primary btn-sm">
            + New Record
          </Link>
        </div>
      </div>

      <div className="dpr-stats-grid">
        <StatCard number={stats.open} label="Open" color="#dc2626" />
        <StatCard number={stats.today} label="Filed Today" color="#2563eb" />
        <StatCard number={stats.closedWeek} label="Closed" color="#16a34a" />
        <StatCard number={stats.total} label="Total Visible" color="#64748b" />
      </div>

      <div className="dpr-card" style={{ marginBottom: '1rem' }}>
        <div className="form-row">
          <div className="form-group">
            <label>Status</label>
            <select className="form-input" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              <option value="">All</option>
              <option value="OPEN">Open</option>
              <option value="ACKNOWLEDGED">Acknowledged</option>
              <option value="IN_PROGRESS">In progress</option>
              <option value="PENDING_VERIFICATION">Pending verification</option>
              <option value="CLOSED">Closed</option>
              <option value="REJECTED">Rejected</option>
            </select>
          </div>
          <div className="form-group">
            <label>Type</label>
            <select className="form-input" value={filterType} onChange={(e) => setFilterType(e.target.value)}>
              <option value="">All types</option>
              {SUB_WORK_TYPE_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>From</label>
            <input type="date" className="form-input" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} />
          </div>
          <div className="form-group">
            <label>To</label>
            <input type="date" className="form-input" value={filterTo} onChange={(e) => setFilterTo(e.target.value)} />
          </div>
        </div>
        {(filterStatus !== 'OPEN' || filterType || filterFrom || filterTo) && (
          <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem' }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => { setFilterStatus('OPEN'); setFilterType(''); setFilterFrom(''); setFilterTo(''); }}
            >
              Clear filters
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="portal-auth-error" style={{ marginBottom: '1rem' }}>
          {error}
          <button type="button" className="btn btn-secondary btn-sm" onClick={loadAll} style={{ marginLeft: '0.75rem' }}>
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--steel)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>⏳</div>
          Loading inspection records…
        </div>
      ) : inspections.length === 0 ? (
        <div className="dpr-list-empty" style={{ textAlign: 'center', padding: '3rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>✅</div>
          <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", color: 'var(--navy)', marginBottom: '0.5rem' }}>
            No matching records
          </h3>
          <p style={{ color: 'var(--steel)', marginBottom: '1rem' }}>
            Try clearing filters or check back after engineers file records for today.
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1rem' }}>
          {inspections.map((insp) => (
            <Link
              key={insp.id}
              to={`/portal/inspection/${insp.id}`}
              className="dpr-card"
              style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
            >
              <div className="dpr-card-header">
                <div>
                  <h3 className="dpr-card-title">
                    <InspectionTypeLabel type={insp.inspectionType} />
                  </h3>
                  <div className="dpr-card-meta" style={{ marginTop: '0.5rem' }}>
                    <span>📍 {insp.location}</span>
                    <span>📅 {formatIndianDate(insp.reportDate)}</span>
                  </div>
                </div>
                <StatusBadge status={insp.status} />
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
                <SeverityBadge severity={insp.severity} />
                <span style={{ fontSize: '0.8rem', color: 'var(--steel)' }}>
                  {insp.projectName}
                </span>
              </div>

              <div style={{ display: 'flex', gap: '1rem', fontSize: '0.8rem', color: 'var(--steel)' }}>
                <span>📷 {insp.photos?.length || 0}</span>
                <span style={{ marginLeft: 'auto' }}>{insp.submittedBy?.name || '—'}</span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {hasMore && (
        <div style={{ textAlign: 'center', padding: '1.5rem' }}>
          <button type="button" className="btn btn-secondary" onClick={handleLoadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load More'}
          </button>
        </div>
      )}

      {!loading && !hasMore && inspections.length > 0 && (
        <div style={{ textAlign: 'center', color: 'var(--steel)', fontSize: '0.8rem', padding: '0.5rem' }}>
          Showing {inspections.length} record{inspections.length !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  );
}
