import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { SUB_WORK_TYPE_OPTIONS } from './WorkTypes.jsx';
import MonthFilter from '../../components/MonthFilter.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { MapPinIcon, BuildingIcon, ClipboardIcon } from '../../components/Icons.jsx';
import { getCurrentIstMonth } from '../../lib/format.js';

// P0/A-13: admin cross-org inspection list. The previous dead link at
// /portal/inspection/all (rendered for admins in InspectionList.jsx)
// bounced users out of the portal. This route fixes that — admins see
// every inspection record across the org.
//
// Round-27: added a filter panel that mirrors DprAll.jsx so the two
// admin browse views behave the same way. Month defaults to the current
// IST business month so first-load is bounded; clearing snaps back to
// the current month (the same Clear semantics DprAll.jsx uses).

// Status enum (matches schema.prisma InspectionStatus + the OPTIONS
// inline-rendered in InspectionDashboard.jsx:372-378). Kept local here
// rather than hoisted because it's the only InspectionAll consumer —
// pulling it to constants.js would be premature given that file is
// already 8x larger than this page.
const STATUS_FILTERS = [
  { value: '', label: 'All Statuses' },
  { value: 'OPEN', label: 'Open' },
  { value: 'ACKNOWLEDGED', label: 'Acknowledged' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'PENDING_VERIFICATION', label: 'Pending verification' },
  { value: 'CLOSED', label: 'Closed' },
  { value: 'REJECTED', label: 'Rejected' },
];

// Severity enum (schema.prisma). Three-bucket model used by the
// dashboard's colour-coding logic. Untyped on the backend today — values
// come through as strings — so we just hand the user the canonical three
// plus a "no severity" filter to widen the search.
const SEVERITY_FILTERS = [
  { value: '', label: 'Any severity' },
  { value: 'LOW', label: 'Low' },
  { value: 'MEDIUM', label: 'Medium' },
  { value: 'HIGH', label: 'High' },
];

export default function InspectionAll() {
  useDocumentTitle('All Inspection Records');
  const { accessToken } = useAuth();
  const toast = useToast();
  const [inspections, setInspections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Round-27: filter state for the admin browse view. Backend accepts
  // `month`, `status`, `inspectionType`, `severity`, `from`, `to`. The
  // first three were the load-bearing ones historically; month + status
  // + type are what admins reach for most often, so we expose them
  // inline; severity + from/to stay in the panel for power users.
  const [filter, setFilter] = useState(() => ({
    month: getCurrentIstMonth(),
    status: '',
    inspectionType: '',
    severity: '',
    from: '',
    to: '',
  }));
  const [showFilters, setShowFilters] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // /api/inspection returns the current user's records by default; for
      // an admin "all" view we add my=false to get every org record.
      const params = { limit: '100', my: 'false' };
      if (filter.month) params.month = filter.month;
      if (filter.status) params.status = filter.status;
      if (filter.inspectionType) params.inspectionType = filter.inspectionType;
      if (filter.severity) params.severity = filter.severity;
      if (filter.from) params.from = filter.from;
      if (filter.to) params.to = filter.to;
      const data = await api.getInspections(params, accessToken);
      setInspections(data.inspections || []);
    } catch (err) {
      if (err.status !== 401) {
        setError(err.message || 'Failed to load all inspection records.');
        toast.push(err.message || 'Failed to load all inspection records.', 'error');
      }
    } finally {
      setLoading(false);
    }
  }, [accessToken, toast, filter]);

  useEffect(() => { load(); }, [load]);

  const handleFilterChange = (key, value) => {
    setFilter((f) => {
      // Same month-vs-range guard DprAll.jsx uses (backend refuses
      // MONTH_AND_RANGE_CONFLICT). Clear the matching side automatically
      // so the FE never sends a wire-illegal combination.
      if (key === 'month' && value && (f.from || f.to)) {
        return { ...f, month: value, from: '', to: '' };
      }
      if ((key === 'from' || key === 'to') && value && f.month) {
        return { ...f, month: '', [key]: value };
      }
      return { ...f, [key]: value };
    });
  };

  const clearFilters = () => {
    // Snap back to the current IST month so the admin never lands on
    // the unbounded every-org-row view.
    setFilter({
      month: getCurrentIstMonth(),
      status: '',
      inspectionType: '',
      severity: '',
      from: '',
      to: '',
    });
  };

  const hasActiveFilters = Boolean(
    filter.status || filter.inspectionType || filter.severity || filter.from || filter.to,
  );

  return (
    <div className="dpr-page">
      <div className="dpr-page-header">
        <div>
          <h1 className="dpr-page-title">All Inspection Records</h1>
          <p className="dpr-page-sub" style={{ color: 'var(--steel)', margin: 0, fontSize: '0.9rem' }}>
            Every inspection & compliance record across the organization.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button className="btn btn-secondary btn-sm" onClick={() => setShowFilters((s) => !s)}>
            <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 3H2l8 9.46V19l4 2V12.46z"/></svg>
            Filters {showFilters ? '▲' : '▼'}
          </button>
          <Link to="/portal/admin/inspection" className="btn btn-secondary btn-sm">
            ← Back to admin review queue
          </Link>
        </div>
      </div>

      {showFilters && (
        <div className="dpr-card" style={{ marginBottom: '1rem' }}>
          {/* Round-27: month filter sits above the existing per-field
              filters so it visually anchors the time scope. */}
          <div className="form-row">
            <MonthFilter
              id="inspall-filter-month"
              value={filter.month}
              onChange={(v) => handleFilterChange('month', v)}
            />
            <div className="form-group">
              <label htmlFor="inspall-filter-status">Status</label>
              <select
                id="inspall-filter-status"
                className="form-input"
                value={filter.status}
                onChange={(e) => handleFilterChange('status', e.target.value)}
              >
                {STATUS_FILTERS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="inspall-filter-type">Type</label>
              <select
                id="inspall-filter-type"
                className="form-input"
                value={filter.inspectionType}
                onChange={(e) => handleFilterChange('inspectionType', e.target.value)}
              >
                <option value="">All types</option>
                {SUB_WORK_TYPE_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="inspall-filter-severity">Severity</label>
              <select
                id="inspall-filter-severity"
                className="form-input"
                value={filter.severity}
                onChange={(e) => handleFilterChange('severity', e.target.value)}
              >
                {SEVERITY_FILTERS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <fieldset className="form-group" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <legend style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--steel)', padding: 0 }}>Date range</legend>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <div>
                  <label htmlFor="inspall-filter-from" style={{ fontSize: '0.8rem' }}>From</label>
                  <input
                    id="inspall-filter-from"
                    type="date"
                    className="form-input"
                    value={filter.from}
                    onChange={(e) => handleFilterChange('from', e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="inspall-filter-to" style={{ fontSize: '0.8rem' }}>To</label>
                  <input
                    id="inspall-filter-to"
                    type="date"
                    className="form-input"
                    value={filter.to}
                    onChange={(e) => handleFilterChange('to', e.target.value)}
                  />
                </div>
              </div>
            </fieldset>
          </div>
          {hasActiveFilters && (
            <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem' }}>
              <button className="btn btn-ghost btn-sm" onClick={clearFilters}>
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
          Loading records…
        </div>
      ) : inspections.length === 0 ? (
        <div className="dpr-list-empty" style={{ textAlign: 'center', padding: '3rem' }}>
          <div style={{ marginBottom: '1rem', color: 'var(--steel)' }}>
            <ClipboardIcon size={48} />
          </div>
          <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", color: 'var(--navy)' }}>
            No inspection records found
          </h3>
          <p style={{ color: 'var(--steel)' }}>
            {hasActiveFilters
              ? 'No inspections match your current filters.'
              : 'Nothing has been submitted across the org.'}
          </p>
          {hasActiveFilters && (
            <button className="btn btn-secondary btn-sm" onClick={clearFilters} style={{ marginTop: '0.5rem' }}>
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1rem' }}>
          {inspections.map((insp) => {
            const typeLabel = SUB_WORK_TYPE_OPTIONS.find(s => s.value === insp.inspectionType)?.label || insp.inspectionType;
            return (
              <Link
                key={insp.id}
                to={`/portal/inspection/${insp.id}`}
                className="dpr-card"
                style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
              >
                <div className="dpr-card-header">
                  <div>
                    <h3 className="dpr-card-title">{typeLabel}</h3>
                    <div className="dpr-card-meta" style={{ marginTop: '0.5rem' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                        <MapPinIcon size={13} style={{ color: 'var(--steel)' }} />
                        {insp.location}
                      </span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                        <BuildingIcon size={13} style={{ color: 'var(--steel)' }} />
                        {insp.projectName}
                      </span>
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--steel)' }}>
                  Submitted by <strong>{insp.submittedBy?.name || '—'}</strong>
                </div>
              </Link>
            );
          })}
        </div>
        <div className="dpr-list-count" style={{ textAlign: 'center', color: 'var(--steel)', fontSize: '0.8rem', padding: '0.75rem 0.5rem' }}>
          Showing {inspections.length} inspection{inspections.length !== 1 ? 's' : ''}
          {hasActiveFilters ? ' · filtered' : ''}
        </div>
        </>
      )}
    </div>
  );
}
