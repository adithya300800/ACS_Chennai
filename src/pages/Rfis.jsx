import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useToast } from '../contexts/ToastContext.jsx';
import { api } from '../lib/api.js';
import { formatShortDate } from '../lib/format.js';
import StatusBadge from '../components/StatusBadge.jsx';
import Breadcrumb from '../components/Breadcrumb.jsx';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';
import { ClipboardIcon, CalendarIcon, BuildingIcon, BellIcon } from '../components/Icons.jsx';
import RfiFormModal from '../components/RfiFormModal.jsx';
// Round-28 #6: pull-to-refresh on mobile list views.
import usePullToRefresh from '../hooks/usePullToRefresh.js';
import PullToRefreshIndicator from '../components/PullToRefreshIndicator.jsx';

// Status enum + dropdown values. Mirrors the backend's ALLOWED_RFI_STATUSES
// set (backend/src/routes/rfis.js). OVERDUE is a presentation flag — the
// backend expands it to status=OPEN + dueDate < today server-side, so we
// include it as a filter value here for parity with the other entries.
const STATUS_FILTERS = [
  { value: '', label: 'All Statuses' },
  { value: 'OPEN', label: 'Open' },
  { value: 'RESPONDED', label: 'Responded' },
  { value: 'CLOSED', label: 'Closed' },
  { value: 'OVERDUE', label: 'Overdue' },
];

// Per-page status map so OPEN/RESPONDED/CLOSED/OVERDUE each get a
// recognisable colour. OVERDUE inherits the rejected palette (red) so
// stale-but-still-open RFIs don't accidentally look healthy.
const RFI_STATUS_MAP = {
  OPEN: 'dpr-status-draft',
  RESPONDED: 'dpr-status-review',
  CLOSED: 'dpr-status-approved',
  OVERDUE: 'dpr-status-rejected',
};

// S5 audit pattern: shared date helpers from src/lib/format.js handle the
// DR-032 calendar-date timezone fix. Wrap with a single null-tolerant
// helper so the list / detail / modal render sites don't repeat the
// `value ? formatShortDate(value) : '—'` dance.
function formatIndianDate(value) {
  if (!value) return '—';
  return formatShortDate(value) || String(value);
}

export default function Rfis() {
  useDocumentTitle('My RFIs');
  const { accessToken, employee } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const isAdmin = !!employee?.isAdmin;

  const [rfis, setRfis] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState({
    status: '',
    projectId: '',
    from: '',
    to: '',
    myOnly: true,
  });
  const [showFilters, setShowFilters] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  // R8 fix: refetch on focus + visibilitychange so the row's status +
  // action affordances always reflect backend truth. Without this, a row
  // that an admin just escalated to a Variation Order would still render
  // the Escalate button in local React state, and clicking it would 409
  // INVALID_TRANSITION with a string the user reads as "the button is
  // broken". Same pattern as DprList / InspectionList.
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = {};
      if (filter.status) params.status = filter.status;
      if (filter.projectId) params.projectId = filter.projectId;
      if (filter.myOnly) params.my = 'true';
      if (filter.from) params.from = filter.from;
      if (filter.to) params.to = filter.to;
      const data = await api.getRfis(params, accessToken);
      setRfis(data.rfis || []);
    } catch (err) {
      setError(err.message || 'Failed to load RFIs.');
      if (err.status !== 401) {
        toast.push(err.message || 'Failed to load RFIs.', 'error');
      }
    } finally {
      setLoading(false);
    }
  }, [accessToken, filter, toast]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, accessToken]);

  // Project dropdown options. Lazy-loaded once on mount via the existing
  // `/api/projects` endpoint so the filter row has the same source of
  // truth as the rest of the portal. Failures are silent — the filter row
  // just omits the dropdown and the user can still filter by status.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getProjects(accessToken);
        if (cancelled) return;
        setProjects(data.projects || []);
      } catch (_err) {
        if (!cancelled) setProjects([]);
      }
    })();
    return () => { cancelled = true; };
  }, [accessToken]);

  const handleFilterChange = (key, value) => {
    setFilter((f) => ({ ...f, [key]: value }));
  };

  const handleSaved = async (created) => {
    setFormOpen(false);
    toast.push('RFI raised.', 'success');
    // Server returns the row with displayStatus — navigate straight to
    // its detail so the user can capture a response / target right away.
    if (created?.id) navigate(`/portal/rfis/${created.id}`);
    else load();
  };

  // Round-28 #6: pull-to-refresh on mobile.
  const { pullDistance, isRefreshing } = usePullToRefresh(async () => {
    await load();
  });

  // Counts for the header pills (used by the filter row when collapsed
  // so the user can see at-a-glance how many RFIs are in each bucket).
  const counts = useMemo(() => {
    return {
      total: rfis.length,
      open: rfis.filter((r) => (r.displayStatus || r.status) === 'OPEN').length,
      overdue: rfis.filter((r) => (r.displayStatus || r.status) === 'OVERDUE').length,
      responded: rfis.filter((r) => (r.displayStatus || r.status) === 'RESPONDED').length,
      closed: rfis.filter((r) => (r.displayStatus || r.status) === 'CLOSED').length,
    };
  }, [rfis]);

  return (
    <div className="dpr-page">
      <PullToRefreshIndicator pullDistance={pullDistance} isRefreshing={isRefreshing} />
      <Breadcrumb items={[{ label: 'My RFIs' }]} />
      <div className="dpr-page-header">
        <div>
          <h1 className="dpr-page-title">My RFIs</h1>
          <p className="dpr-page-sub" style={{ color: 'var(--steel)', margin: 0, fontSize: '0.9rem' }}>
            Request for Information threads — questions to a colleague plus their response.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setShowFilters((s) => !s)}
            aria-expanded={showFilters}
          >
            <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 3H2l8 9.46V19l4 2V12.46z"/></svg>
            Filters {showFilters ? '▲' : '▼'}
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setFormOpen(true)}>
            + New RFI
          </button>
        </div>
      </div>

      {showFilters && (
        <div className="dpr-card" style={{ marginBottom: '1rem' }}>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="rfi-filter-status">Status</label>
              <select
                id="rfi-filter-status"
                className="form-input"
                value={filter.status}
                onChange={(e) => handleFilterChange('status', e.target.value)}
              >
                {STATUS_FILTERS.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="rfi-filter-project">Project</label>
              <select
                id="rfi-filter-project"
                className="form-input"
                value={filter.projectId}
                onChange={(e) => handleFilterChange('projectId', e.target.value)}
              >
                <option value="">All projects</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <fieldset className="form-group" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <legend style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--steel)', padding: 0 }}>Date range</legend>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <div>
                  <label htmlFor="rfi-filter-from" style={{ fontSize: '0.8rem' }}>From</label>
                  <input
                    id="rfi-filter-from"
                    type="date"
                    className="form-input"
                    value={filter.from}
                    onChange={(e) => handleFilterChange('from', e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="rfi-filter-to" style={{ fontSize: '0.8rem' }}>To</label>
                  <input
                    id="rfi-filter-to"
                    type="date"
                    className="form-input"
                    value={filter.to}
                    onChange={(e) => handleFilterChange('to', e.target.value)}
                  />
                </div>
              </div>
            </fieldset>
            <div className="form-group" style={{ justifyContent: 'flex-end' }}>
              {isAdmin && (
                <label htmlFor="rfi-filter-mine" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                  <input
                    id="rfi-filter-mine"
                    type="checkbox"
                    checked={filter.myOnly}
                    onChange={(e) => handleFilterChange('myOnly', e.target.checked)}
                  />
                  My RFIs only
                </label>
              )}
            </div>
          </div>
          {(filter.status || filter.projectId || filter.from || filter.to) && (
            <div style={{ marginTop: '0.75rem' }}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setFilter({ status: '', projectId: '', from: '', to: '', myOnly: true })}
              >
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
          Loading RFIs...
        </div>
      ) : rfis.length === 0 ? (
        <div className="dpr-list-empty" style={{ textAlign: 'center', padding: '3rem' }}>
          <div style={{ marginBottom: '1rem', color: 'var(--steel)' }}>
            <ClipboardIcon size={48} />
          </div>
          <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", color: 'var(--navy)', marginBottom: '0.5rem' }}>
            No RFIs yet
          </h3>
          <p style={{ color: 'var(--steel)', marginBottom: '1.5rem' }}>
            {filter.status || filter.projectId || filter.from || filter.to
              ? 'No RFIs match your current filters.'
              : "No RFIs yet. Click 'New RFI' to raise one."}
          </p>
          <button className="btn btn-primary" onClick={() => setFormOpen(true)}>
            + New RFI
          </button>
        </div>
      ) : (
        <>
          {/* Header status pills for at-a-glance scoping. Same visual
              language as the InspectionDashboard stat tiles. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '0.5rem', marginBottom: '1rem' }}>
            <div className="dpr-stat-card">
              <div className="dpr-stat-number">{counts.total}</div>
              <div className="dpr-stat-label">Total in view</div>
            </div>
            <div className="dpr-stat-card">
              <div className="dpr-stat-number" style={{ color: 'var(--blue)' }}>{counts.open}</div>
              <div className="dpr-stat-label">Open</div>
            </div>
            <div className="dpr-stat-card">
              <div className="dpr-stat-number" style={{ color: 'var(--danger, #dc2626)' }}>{counts.overdue}</div>
              <div className="dpr-stat-label">Overdue</div>
            </div>
            <div className="dpr-stat-card">
              <div className="dpr-stat-number" style={{ color: 'var(--blue)' }}>{counts.responded}</div>
              <div className="dpr-stat-label">Responded</div>
            </div>
            <div className="dpr-stat-card">
              <div className="dpr-stat-number" style={{ color: 'var(--success, #16a34a)' }}>{counts.closed}</div>
              <div className="dpr-stat-label">Closed</div>
            </div>
          </div>

          <div className="dpr-card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="dpr-list-item" style={{ background: '#f8fafc', fontWeight: 600, fontSize: '0.8rem', color: 'var(--steel)', padding: '0.75rem 1rem' }}>
              <div style={{ flex: 2 }}>Subject / Project</div>
              <div style={{ flex: 1 }}>Status</div>
              <div style={{ flex: 1 }}>Due</div>
              <div style={{ flex: 1 }}>Responder</div>
            </div>

            {rfis.map((r) => {
              const displayStatus = r.displayStatus || r.status;
              const dueDate = r.dueDate ? new Date(r.dueDate) : null;
              const isOverdueRow = displayStatus === 'OVERDUE';
              return (
                <div key={r.id} className="dpr-list-item">
                  <button
                    type="button"
                    onClick={() => navigate(`/portal/rfis/${r.id}`)}
                    aria-label={`${r.subject} — ${displayStatus}`}
                    style={{
                      flex: 2, textAlign: 'left', background: 'none', border: 'none',
                      padding: 0, cursor: 'pointer', color: 'inherit',
                    }}
                  >
                    <div style={{ fontWeight: 600, color: 'var(--navy)', marginBottom: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <span>{r.subject || '(no subject)'}</span>
                      {isOverdueRow && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', color: 'var(--danger, #dc2626)', fontSize: '0.75rem', fontWeight: 600 }}>
                          <BellIcon size={12} style={{ color: 'var(--danger, #dc2626)' }} />
                          overdue
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--steel)', display: 'inline-flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <BuildingIcon size={12} />
                      {r.project?.name || 'No project'}
                    </div>
                  </button>
                  <div style={{ flex: 1 }}>
                    <StatusBadge status={displayStatus} map={RFI_STATUS_MAP} />
                  </div>
                  <div style={{ flex: 1, color: dueDate && dueDate < new Date() && displayStatus === 'OPEN' ? 'var(--danger, #dc2626)' : 'var(--steel)', fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                    <CalendarIcon size={13} style={{ color: 'inherit' }} />
                    {formatIndianDate(r.dueDate)}
                  </div>
                  <div style={{ flex: 1, color: 'var(--steel)', fontSize: '0.85rem' }}>
                    {r.targetResponder?.name || <em className="text-placeholder">Anyone</em>}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="dpr-list-count" style={{ textAlign: 'center', color: 'var(--steel)', fontSize: '0.8rem', padding: '0.5rem' }}>
            Showing {rfis.length} RFI{rfis.length !== 1 ? 's' : ''}
          </div>
        </>
      )}

      <RfiFormModal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSaved={handleSaved}
        projects={projects}
        accessToken={accessToken}
      />
    </div>
  );
}