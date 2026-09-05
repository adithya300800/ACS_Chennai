import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { formatShortDate } from '../../lib/format.js';
import StatusBadge from '../../components/StatusBadge.jsx';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { ClipboardIcon, BuildingIcon, CalendarIcon, DocIcon } from '../../components/Icons.jsx';
import VariationFormModal from '../../components/VariationFormModal.jsx';

// Status enum (DRAFT / SUBMITTED / APPROVED / REJECTED) + dropdown.
// Mirrors backend/src/routes/variations.js:ALLOWED_VARIATION_STATUSES.
const STATUS_FILTERS = [
  { value: '', label: 'All Statuses' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'SUBMITTED', label: 'Submitted' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
];

const VARIATION_STATUS_MAP = {
  DRAFT: 'dpr-status-draft',
  SUBMITTED: 'dpr-status-review',
  APPROVED: 'dpr-status-approved',
  REJECTED: 'dpr-status-rejected',
};

// Indian-grouping ₹ formatter. Backend serializes Decimal as a string so
// callers may pass either shape; we coerce to Number() for display only.
function formatRupees(value) {
  if (value == null || value === '') return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return String(value);
  const formatted = Math.abs(n).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${n < 0 ? '−' : ''}₹${formatted}`;
}

function formatIndianDate(value) {
  if (!value) return '—';
  return formatShortDate(value) || String(value);
}

export default function VariationOrdersAdmin() {
  useDocumentTitle('Variation Orders');
  const { accessToken } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const [variations, setVariations] = useState([]);
  const [projects, setProjects] = useState([]);
  const [rfis, setRfis] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState({
    status: '',
    projectId: '',
    from: '',
    to: '',
  });
  const [showFilters, setShowFilters] = useState(false);
  const [newOpen, setNewOpen] = useState(false);

  // Counts for the header stat tiles. All computed client-side; v1 doesn't
  // ship an aggregate `/api/variations/stats` endpoint so the cards mirror
  // the in-memory set (which is bounded by the list limit, default 20).
  const counts = useMemo(() => ({
    total: variations.length,
    draft: variations.filter((v) => v.status === 'DRAFT').length,
    submitted: variations.filter((v) => v.status === 'SUBMITTED').length,
    approved: variations.filter((v) => v.status === 'APPROVED').length,
    rejected: variations.filter((v) => v.status === 'REJECTED').length,
  }), [variations]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = {};
      if (filter.status) params.status = filter.status;
      if (filter.projectId) params.projectId = filter.projectId;
      if (filter.from) params.from = filter.from;
      if (filter.to) params.to = filter.to;
      const data = await api.getVariations(params, accessToken);
      setVariations(data.variations || []);
    } catch (err) {
      setError(err.message || 'Failed to load variation orders.');
      if (err.status !== 401) {
        toast.push(err.message || 'Failed to load variation orders.', 'error');
      }
    } finally {
      setLoading(false);
    }
  }, [accessToken, filter, toast]);

  useEffect(() => { load(); }, [load]);

  // Project dropdown options for the filter row + the new-VO modal.
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

  // RFI directory — needed for the referenceRfiId picker in the new-VO
  // modal. We pull the full list once on mount and let the modal filter
  // by project (the picker is scoped client-side too).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getRfis({ limit: 100 }, accessToken);
        if (cancelled) return;
        setRfis(data.rfis || []);
      } catch (_err) {
        if (!cancelled) setRfis([]);
      }
    })();
    return () => { cancelled = true; };
  }, [accessToken]);

  const handleFilterChange = (key, value) => {
    setFilter((f) => ({ ...f, [key]: value }));
  };

  const handleSaved = (created) => {
    setNewOpen(false);
    // Jump straight to the detail page so the admin can review the row
    // and trigger Submit (DRAFT → SUBMITTED) from the detail surface.
    if (created?.id) {
      toast.push('Variation draft created.', 'success');
      navigate(`/portal/admin/variations/${created.id}`);
    } else {
      load();
    }
  };

  return (
    <div className="dpr-page">
      <Breadcrumb items={[{ label: 'Variation Orders' }]} />
      <div className="dpr-page-header">
        <div>
          <h1 className="dpr-page-title">Variation Orders</h1>
          <p className="dpr-page-sub" style={{ color: 'var(--steel)', margin: 0, fontSize: '0.9rem' }}>
            Scope changes with budget impact — drafted by anyone, approved or rejected by an admin.
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
          <button className="btn btn-primary btn-sm" onClick={() => setNewOpen(true)}>
            + New Variation
          </button>
        </div>
      </div>

      {showFilters && (
        <div className="dpr-card" style={{ marginBottom: '1rem' }}>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="variation-filter-status">Status</label>
              <select
                id="variation-filter-status"
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
              <label htmlFor="variation-filter-project">Project</label>
              <select
                id="variation-filter-project"
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
                  <label htmlFor="variation-filter-from" style={{ fontSize: '0.8rem' }}>From</label>
                  <input
                    id="variation-filter-from"
                    type="date"
                    className="form-input"
                    value={filter.from}
                    onChange={(e) => handleFilterChange('from', e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="variation-filter-to" style={{ fontSize: '0.8rem' }}>To</label>
                  <input
                    id="variation-filter-to"
                    type="date"
                    className="form-input"
                    value={filter.to}
                    onChange={(e) => handleFilterChange('to', e.target.value)}
                  />
                </div>
              </div>
            </fieldset>
          </div>
          {(filter.status || filter.projectId || filter.from || filter.to) && (
            <div style={{ marginTop: '0.75rem' }}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setFilter({ status: '', projectId: '', from: '', to: '' })}
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
          <div className="dpr-stat-number" style={{ color: 'var(--blue)' }}>{counts.draft}</div>
          <div className="dpr-stat-label">Draft</div>
        </div>
        <div className="dpr-stat-card">
          <div className="dpr-stat-number" style={{ color: 'var(--blue)' }}>{counts.submitted}</div>
          <div className="dpr-stat-label">Awaiting decision</div>
        </div>
        <div className="dpr-stat-card">
          <div className="dpr-stat-number" style={{ color: 'var(--success, #16a34a)' }}>{counts.approved}</div>
          <div className="dpr-stat-label">Approved</div>
        </div>
        <div className="dpr-stat-card">
          <div className="dpr-stat-number" style={{ color: 'var(--danger, #dc2626)' }}>{counts.rejected}</div>
          <div className="dpr-stat-label">Rejected</div>
        </div>
      </div>

      {error && <div className="portal-auth-error" style={{ marginBottom: '1rem' }}>{error}</div>}

      {loading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--steel)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>⏳</div>
          Loading variation orders...
        </div>
      ) : variations.length === 0 ? (
        <div className="dpr-list-empty" style={{ textAlign: 'center', padding: '3rem' }}>
          <div style={{ marginBottom: '1rem', color: 'var(--steel)' }}>
            <ClipboardIcon size={48} />
          </div>
          <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", color: 'var(--navy)', marginBottom: '0.5rem' }}>
            No variation orders yet
          </h3>
          <p style={{ color: 'var(--steel)', marginBottom: '1.5rem' }}>
            {filter.status || filter.projectId || filter.from || filter.to
              ? 'No variation orders match your current filters.'
              : 'Capture scope changes with a budget delta so they can be approved.'}
          </p>
          <button className="btn btn-primary" onClick={() => setNewOpen(true)}>
            + New Variation
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1rem' }}>
          {variations.map((v) => {
            const isAwaiting = v.status === 'SUBMITTED';
            return (
              <div
                key={v.id}
                className="dpr-card"
                style={{
                  borderLeft: isAwaiting ? '3px solid var(--blue)' : undefined,
                }}
              >
                <div className="dpr-card-header">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <h3 className="dpr-card-title" style={{ overflowWrap: 'anywhere' }}>
                      {v.title}
                    </h3>
                    <div className="dpr-card-meta" style={{ marginTop: '0.5rem' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                        <BuildingIcon size={13} style={{ color: 'var(--steel)' }} />
                        {v.project?.name || '—'}
                      </span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                        <CalendarIcon size={13} style={{ color: 'var(--steel)' }} />
                        {formatIndianDate(v.createdAt)}
                      </span>
                    </div>
                  </div>
                  <StatusBadge status={v.status} map={VARIATION_STATUS_MAP} />
                </div>

                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: '0.5rem', gap: '0.5rem' }}>
                  <span style={{
                    fontFamily: "'Plus Jakarta Sans', sans-serif",
                    fontSize: '1.25rem',
                    fontWeight: 700,
                    color: v.deltaAmount != null && Number(v.deltaAmount) < 0 ? 'var(--success, #16a34a)' : 'var(--navy)',
                  }}>
                    {formatRupees(v.deltaAmount)}
                  </span>
                  {v.referenceRfi && (
                    <Link
                      to={`/portal/rfis/${v.referenceRfi.id}`}
                      className="dpr-card-meta"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', color: 'var(--blue)' }}
                      title={`From RFI: ${v.referenceRfi.subject || v.referenceRfi.id}`}
                    >
                      <DocIcon size={13} />
                      {v.referenceRfi.subject || 'RFI'}
                    </Link>
                  )}
                </div>

                {v.description && (
                  <p style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--steel)', overflowWrap: 'anywhere' }}>
                    {v.description.length > 140 ? `${v.description.slice(0, 140)}…` : v.description}
                  </p>
                )}

                {v.raisedBy && (
                  <div style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: 'var(--steel)' }}>
                    Raised by <strong style={{ color: 'var(--navy)' }}>{v.raisedBy.name}</strong>
                  </div>
                )}

                <div style={{ borderTop: '1px solid #e2e8f0', marginTop: '0.75rem', paddingTop: '0.5rem', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                  <Link to={`/portal/admin/variations/${v.id}`} className="btn btn-secondary btn-sm">
                    View
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <VariationFormModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onSaved={handleSaved}
        projects={projects}
        rfis={rfis}
        accessToken={accessToken}
      />
    </div>
  );
}