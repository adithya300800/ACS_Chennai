import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { formatShortDate } from '../../lib/format.js';
import StatusBadge from '../../components/StatusBadge.jsx';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { ClipboardIcon, BuildingIcon, CalendarIcon, BellIcon } from '../../components/Icons.jsx';
import VariationFormModal from '../../components/VariationFormModal.jsx';

// Same status enum + map as Rfis.jsx so OPEN/RESPONDED/CLOSED/OVERDUE
// render with consistent colours across employee + admin views.
const STATUS_FILTERS = [
  { value: '', label: 'All Statuses' },
  { value: 'OPEN', label: 'Open' },
  { value: 'RESPONDED', label: 'Responded' },
  { value: 'CLOSED', label: 'Closed' },
  { value: 'OVERDUE', label: 'Overdue' },
];

const RFI_STATUS_MAP = {
  OPEN: 'dpr-status-draft',
  RESPONDED: 'dpr-status-review',
  CLOSED: 'dpr-status-approved',
  OVERDUE: 'dpr-status-rejected',
};

function formatIndianDate(value) {
  if (!value) return '—';
  return formatShortDate(value) || String(value);
}

export default function RfisAdmin() {
  useDocumentTitle('All RFIs');
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
    raisedByMe: false,
  });
  const [showFilters, setShowFilters] = useState(false);
  const [escalateRfi, setEscalateRfi] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = {};
      if (filter.status) params.status = filter.status;
      if (filter.projectId) params.projectId = filter.projectId;
      if (filter.raisedByMe) params.my = 'true';
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

  // Project dropdown source.
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

  // Counts for the header stat tiles.
  const counts = useMemo(() => ({
    total: rfis.length,
    open: rfis.filter((r) => (r.displayStatus || r.status) === 'OPEN').length,
    overdue: rfis.filter((r) => (r.displayStatus || r.status) === 'OVERDUE').length,
    responded: rfis.filter((r) => (r.displayStatus || r.status) === 'RESPONDED').length,
    closed: rfis.filter((r) => (r.displayStatus || r.status) === 'CLOSED').length,
  }), [rfis]);

  const handleFilterChange = (key, value) => {
    setFilter((f) => ({ ...f, [key]: value }));
  };

  // Admin escalation: open the VariationFormModal pre-filled with the
  // RFI's project + referenceRfiId. The form posts via api.createVariation
  // — we deliberately do NOT auto-call the backend escalation endpoint
  // so the admin sees the resulting Variation DRAFT before committing
  // to its title / description / deltaAmount.
  const handleEscalate = (createdVo) => {
    setEscalateRfi(null);
    if (createdVo?.id) {
      toast.push('RFI escalated to a Variation Order draft.', 'success');
      navigate(`/portal/admin/variations/${createdVo.id}`);
    } else {
      toast.push('RFI escalated.', 'success');
      load();
    }
  };

  return (
    <div className="dpr-page">
      <Breadcrumb items={[{ label: 'All RFIs' }]} />
      <div className="dpr-page-header">
        <div>
          <h1 className="dpr-page-title">All RFIs</h1>
          <p className="dpr-page-sub" style={{ color: 'var(--steel)', margin: 0, fontSize: '0.9rem' }}>
            Cross-project view of every RFI in the organization.
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
        </div>
      </div>

      {showFilters && (
        <div className="dpr-card" style={{ marginBottom: '1rem' }}>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="admin-rfi-filter-status">Status</label>
              <select
                id="admin-rfi-filter-status"
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
              <label htmlFor="admin-rfi-filter-project">Project</label>
              <select
                id="admin-rfi-filter-project"
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
                  <label htmlFor="admin-rfi-filter-from" style={{ fontSize: '0.8rem' }}>From</label>
                  <input
                    id="admin-rfi-filter-from"
                    type="date"
                    className="form-input"
                    value={filter.from}
                    onChange={(e) => handleFilterChange('from', e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="admin-rfi-filter-to" style={{ fontSize: '0.8rem' }}>To</label>
                  <input
                    id="admin-rfi-filter-to"
                    type="date"
                    className="form-input"
                    value={filter.to}
                    onChange={(e) => handleFilterChange('to', e.target.value)}
                  />
                </div>
              </div>
            </fieldset>
            <div className="form-group" style={{ justifyContent: 'flex-end' }}>
              <label htmlFor="admin-rfi-filter-raised" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                <input
                  id="admin-rfi-filter-raised"
                  type="checkbox"
                  checked={filter.raisedByMe}
                  onChange={(e) => handleFilterChange('raisedByMe', e.target.checked)}
                />
                Raised by me
              </label>
            </div>
          </div>
          {(filter.status || filter.projectId || filter.from || filter.to || filter.raisedByMe) && (
            <div style={{ marginTop: '0.75rem' }}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setFilter({ status: '', projectId: '', from: '', to: '', raisedByMe: false })}
              >
                Clear filters
              </button>
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '0.5rem', marginBottom: '1rem' }}>
        <div className="dpr-stat-card">
          <div className="dpr-stat-number">{counts.total}</div>
          <div className="dpr-stat-label">In view</div>
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
            No RFIs in view
          </h3>
          <p style={{ color: 'var(--steel)', marginBottom: '1rem' }}>
            {filter.status || filter.projectId || filter.from || filter.to || filter.raisedByMe
              ? 'No RFIs match your current filters.'
              : 'No RFIs have been raised yet.'}
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1rem' }}>
          {rfis.map((r) => {
            const displayStatus = r.displayStatus || r.status;
            const isOverdueRow = displayStatus === 'OVERDUE';
            const canEscalate = isAdmin && displayStatus !== 'CLOSED';
            return (
              <div
                key={r.id}
                className="dpr-card"
                style={{
                  borderLeft: isOverdueRow ? '3px solid var(--danger, #dc2626)' : undefined,
                }}
              >
                <div className="dpr-card-header">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <h3 className="dpr-card-title" style={{ overflowWrap: 'anywhere' }}>
                      {r.subject || '(no subject)'}
                    </h3>
                    <div className="dpr-card-meta" style={{ marginTop: '0.5rem' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                        <BuildingIcon size={13} style={{ color: 'var(--steel)' }} />
                        {r.project?.name || 'No project'}
                      </span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                        <CalendarIcon size={13} style={{ color: isOverdueRow ? 'var(--danger, #dc2626)' : 'var(--steel)' }} />
                        {formatIndianDate(r.dueDate)}
                      </span>
                    </div>
                  </div>
                  <StatusBadge status={displayStatus} map={RFI_STATUS_MAP} />
                </div>

                {isOverdueRow && (
                  <div style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: 'var(--danger, #dc2626)', display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                    <BellIcon size={12} />
                    Past due — escalate or close.
                  </div>
                )}

                <p style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--steel)', overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {r.question || <em className="text-placeholder">No question text</em>}
                </p>

                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', fontSize: '0.8rem', color: 'var(--steel)', marginTop: '0.5rem' }}>
                  <span>
                    <strong style={{ color: 'var(--navy)' }}>Raised by:</strong> {r.raisedBy?.name || '—'}
                  </span>
                  {r.targetResponder && (
                    <span>
                      <strong style={{ color: 'var(--navy)' }}>→</strong> {r.targetResponder.name}
                    </span>
                  )}
                </div>

                <div style={{ borderTop: '1px solid #e2e8f0', marginTop: '0.75rem', paddingTop: '0.5rem', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                  <Link to={`/portal/rfis/${r.id}`} className="btn btn-secondary btn-sm">
                    View
                  </Link>
                  {canEscalate && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => setEscalateRfi(r)}
                    >
                      Escalate to VO
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Escalation modal — open the VariationFormModal with the project
          pre-filled. The submit triggers api.createVariation, NOT
          api.escalateRfiToVariation, because the admin needs to see
          the full editable form before committing to the financial
          scope. The api.escalateRfiToVariation helper is still wired
          in src/lib/api.js for any caller that prefers the backend
          shortcut. */}
      {escalateRfi && (
        <VariationFormModal
          open={!!escalateRfi}
          onClose={() => setEscalateRfi(null)}
          onSaved={handleEscalate}
          projects={projects}
          accessToken={accessToken}
          initialProjectId={escalateRfi.projectId || ''}
          initialReferenceRfiId={escalateRfi.id}
        />
      )}
    </div>
  );
}