import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import StatusBadge from '../../components/StatusBadge.jsx';
import { SUB_WORK_TYPE_OPTIONS } from './WorkTypes.jsx';

// C-06: local StatusBadge removed (round-15+). The shared component covers
// all inspection statuses (OPEN/ACKNOWLEDGED/IN_PROGRESS/PENDING_VERIFICATION/
// CLOSED/REJECTED) in its DEFAULT_STATUS_MAP — passing `insp.status` works
// without a per-page override.

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

function formatIndianDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function InspectionList() {
  const { accessToken, employee } = useAuth();
  const toast = useToast();
  const [inspections, setInspections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { limit: '50' };
      if (typeFilter) params.inspectionType = typeFilter;
      if (statusFilter) params.status = statusFilter;
      const data = await api.getInspections(params, accessToken);
      setInspections(data.inspections || []);
    } catch (err) {
      if (err.status !== 401) {
        setError(err.message || 'Failed to load inspection records.');
        toast.push(err.message || 'Failed to load inspection records.', 'error');
      }
    } finally {
      setLoading(false);
    }
  }, [accessToken, typeFilter, statusFilter, toast]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="dpr-page">
      <div className="dpr-page-header">
        <h1 className="dpr-page-title">My Inspection Records</h1>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <Link to="/portal/inspection/submit" className="btn btn-primary btn-sm">
            + New Record
          </Link>
          {employee?.isAdmin && (
            <Link to="/portal/inspection/all" className="btn btn-secondary btn-sm">
              All Records
            </Link>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <select
          className="form-input"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          style={{ maxWidth: 240 }}
          aria-label="Filter by type"
        >
          <option value="">All types</option>
          {SUB_WORK_TYPE_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <select
          className="form-input"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          style={{ maxWidth: 200 }}
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          <option value="OPEN">Open</option>
          <option value="ACKNOWLEDGED">Acknowledged</option>
          <option value="IN_PROGRESS">In progress</option>
          <option value="PENDING_VERIFICATION">Pending verification</option>
          <option value="CLOSED">Closed</option>
          <option value="REJECTED">Rejected</option>
        </select>
      </div>

      {error && <div className="portal-auth-error" style={{ marginBottom: '1rem' }}>{error}</div>}

      {loading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1rem' }}>
          {[1, 2, 3].map((i) => (
            <div key={i} className="dpr-card" aria-hidden="true" style={{ minHeight: 180, opacity: 0.55 }}>
              <div style={{ height: 16, background: '#e2e8f0', borderRadius: 4, width: '60%', marginBottom: 12 }} />
              <div style={{ height: 12, background: '#e2e8f0', borderRadius: 4, width: '80%', marginBottom: 8 }} />
              <div style={{ height: 12, background: '#e2e8f0', borderRadius: 4, width: '40%' }} />
            </div>
          ))}
        </div>
      ) : inspections.length === 0 ? (
        <div className="dpr-list-empty" style={{ textAlign: 'center', padding: '3rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>📋</div>
          <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", color: 'var(--navy)', marginBottom: '0.5rem' }}>
            No inspection records yet
          </h3>
          <p style={{ color: 'var(--steel)', marginBottom: '1rem' }}>
            File a material receipt, cube test, NCR, or any other inspection record to see it here.
          </p>
          <Link to="/portal/inspection/submit" className="btn btn-primary btn-sm">
            + New Inspection Record
          </Link>
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
                {insp.dpr && (
                  <span>📎 Linked to DPR</span>
                )}
                <span style={{ marginLeft: 'auto' }}>
                  {insp.submittedBy?.name || ''}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
