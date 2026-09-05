import React, { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { formatDateOnly } from '../../lib/format.js';
import StatusBadge from '../../components/StatusBadge.jsx';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import PhotoDownloadButton from '../../components/PhotoDownloadButton.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { ClipboardIcon } from '../../components/Icons.jsx';

const STATUS_FILTERS = [
  { value: '', label: 'All Statuses' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'SUBMITTED', label: 'Submitted' },
  { value: 'UNDER_REVIEW', label: 'Under Review' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
];

// C-06 (round-15+): local StatusBadge removed; uses the shared component
// with a per-page map so SUBMITTED stays visually distinct from UNDER_REVIEW.
// Same rationale as DprDashboard — the two states convey different things
// to the employee and should not collapse to one color.
const DPR_STATUS_MAP = {
  DRAFT: 'dpr-status-draft',
  SUBMITTED: 'dpr-status-submitted',
  UNDER_REVIEW: 'dpr-status-review',
  APPROVED: 'dpr-status-approved',
  REJECTED: 'dpr-status-rejected',
};

// Round-12: render user-added ad-hoc sections (text + tables) read-only
// inside the DPR detail modal. Mirrors the editor shape at DprCustomSection.
function CustomSectionsView({ sections }) {
  if (!Array.isArray(sections) || sections.length === 0) return null;
  return (
    <div style={{ marginTop: '1rem' }}>
      <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.5rem', color: 'var(--navy)' }}>
        Custom Sections
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {sections.map((s) => (
          <div
            key={s.id}
            style={{ border: '1px solid #e2e8f0', borderRadius: 6, padding: '0.625rem 0.875rem', background: '#fff' }}
          >
            <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--navy)', marginBottom: '0.25rem' }}>
              {s.type === 'text' ? '📝 ' : '📊 '}
              {s.title || <em className="text-placeholder">(untitled)</em>}
            </div>
            {s.type === 'text' ? (
              <div style={{ whiteSpace: 'pre-wrap', fontSize: '0.9rem' }}>
                {s.content || <em className="text-placeholder">(empty)</em>}
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ background: '#f1f5f9' }}>
                      {(s.columns || []).map((c, i) => (
                        <th key={i} style={{ textAlign: 'left', padding: '0.375rem', borderBottom: '1px solid #e2e8f0' }}>
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(s.rows || []).map((r, i) => (
                      <tr key={i}>
                        {(s.columns || []).map((_, j) => (
                          <td key={j} style={{ padding: '0.375rem', borderBottom: '1px solid #f1f5f9' }}>
                            {r[j] != null && r[j] !== '' ? r[j] : <span style={{ color: '#cbd5e1' }}>—</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
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
  useDocumentTitle('My Daily Reports');
  const { accessToken } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const [dprs, setDprs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState(null);
  // R22.5: default `myOnly` to true so the page matches its title. Admins
  // used to land here and see every org DPR (the backend returns all rows
  // when `my=true` is unset — see backend/src/routes/dpr.js:641); that
  // made "My Daily Reports" misleading for admins. They can still uncheck
  // the box to opt in to the cross-org view, and admins get a sidebar
  // link to the dedicated `/portal/dpr/all` browse page (round-22).
  const [filter, setFilter] = useState({ status: '', myOnly: true, from: '', to: '' });
  const [showFilters, setShowFilters] = useState(false);
  // P0 fix (round-10): clicking a row previously navigated to the same
  // route with location.state.selectedDpr — nothing read that state, so
  // the click looked broken. Open an inline modal with the DPR detail
  // (fetches the canonical row with photos + read-SAS URLs).
  const [expandedDpr, setExpandedDpr] = useState(null);
  const [expandedLoading, setExpandedLoading] = useState(false);
  const [expandedError, setExpandedError] = useState('');

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, accessToken]);

  const handleFilterChange = (key, value) => {
    setFilter(f => ({ ...f, [key]: value }));
  };

  const handleLoadMore = () => {
    if (nextCursor && !loadingMore) load(nextCursor);
  };

  const handleRowClick = async (dpr) => {
    // Round-10 fix: fetch the full DPR (with photos + read-SAS URLs) and
    // open an inline modal. Previously this navigated to the same route
    // with location.state.selectedDpr — nothing read that state, so the
    // click appeared to do nothing.
    setExpandedDpr({ ...dpr, photos: [] });
    setExpandedError('');
    setExpandedLoading(true);
    try {
      const full = await api.getDpr(dpr.id, accessToken);
      setExpandedDpr(full);
    } catch (err) {
      setExpandedError(err.message || 'Failed to load DPR details');
    } finally {
      setExpandedLoading(false);
    }
  };

  const handleCloseModal = () => {
    setExpandedDpr(null);
    setExpandedError('');
    setExpandedLoading(false);
  };

  // SOL-P0#4: Resume / Edit / Delete draft actions.
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const handleResumeDraft = (dprId) => {
    navigate(`/portal/dpr/submit?draftId=${dprId}`);
  };

  const handleDeleteDraft = async (dprId) => {
    setDeleting(true);
    try {
      await api.deleteDpr(dprId, accessToken);
      toast.push('Draft deleted.', 'success');
      setConfirmDeleteId(null);
      handleCloseModal();
      // Refresh list
      setDprs((prev) => prev.filter((d) => d.id !== dprId));
    } catch (err) {
      toast.push(err.message || 'Failed to delete draft', 'error');
    } finally {
      setDeleting(false);
    }
  };

  // Close modal on Escape (matches NotificationBell behaviour for a11y)
  useEffect(() => {
    if (!expandedDpr) return;
    const handler = (e) => {
      if (e.key === 'Escape') handleCloseModal();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [expandedDpr]);

  return (
    <div className="dpr-page">
      <div className="dpr-page-header">
        <h1 className="dpr-page-title">My Daily Reports</h1>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button className="btn btn-secondary btn-sm" onClick={() => setShowFilters(s => !s)}>
            <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 3H2l8 9.46V19l4 2V12.46z"/></svg>
            Filters {showFilters ? '▲' : '▼'}
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => navigate('/portal/dpr/submit')}>
            + New DPR
          </button>
        </div>
      </div>

      {showFilters && (
        <div className="dpr-card" style={{ marginBottom: '1rem' }}>
          {/* SOL-P0#2: wire visible labels to their controls via htmlFor/id,
              and group the date range in a fieldset with a legend. */}
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="dpr-filter-status">Status</label>
              <select
                id="dpr-filter-status"
                className="form-input"
                value={filter.status}
                onChange={e => handleFilterChange('status', e.target.value)}
              >
                {STATUS_FILTERS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <fieldset className="form-group" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <legend style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--steel)', padding: 0 }}>Date range</legend>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <div>
                  <label htmlFor="dpr-filter-from" style={{ fontSize: '0.8rem' }}>From</label>
                  <input
                    id="dpr-filter-from"
                    type="date"
                    className="form-input"
                    value={filter.from}
                    onChange={e => handleFilterChange('from', e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="dpr-filter-to" style={{ fontSize: '0.8rem' }}>To</label>
                  <input
                    id="dpr-filter-to"
                    type="date"
                    className="form-input"
                    value={filter.to}
                    onChange={e => handleFilterChange('to', e.target.value)}
                  />
                </div>
              </div>
            </fieldset>
            <div className="form-group" style={{ justifyContent: 'flex-end' }}>
              <label htmlFor="dpr-filter-mine" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                <input
                  id="dpr-filter-mine"
                  type="checkbox"
                  checked={filter.myOnly}
                  onChange={e => handleFilterChange('myOnly', e.target.checked)}
                />
                My DPRs only
              </label>
            </div>
          </div>
          {(filter.status || filter.from || filter.to) && (
            <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setFilter({ status: '', myOnly: true, from: '', to: '' })}>
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
          <div style={{ marginBottom: '1rem', color: 'var(--steel)' }}>
            <ClipboardIcon size={48} />
          </div>
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
              <div style={{ flex: 1 }}>Status</div>
              <div style={{ flex: 1 }}>Photos</div>
              <div style={{ flex: 1 }}>Submitted</div>
            </div>

            {dprs.map(dpr => (
              // S5-dpr-a11y: the previous row was role=button with a
              // nested <button> for Resume. axe flagged that as
              // nested-interactive (one focusable inside another
              // focusable). The audit's recommendation: a semantic
              // card/list-item plus a SEPARATE sibling action. Now:
              //   - outer container is role=listitem — read-only, not
              //     in the tab order, not a phantom button.
              //   - the project-title cell IS the open-detail button
              //     (the primary "see this DPR" action).
              //   - Resume is a sibling, not a descendant.
              // Keyboard flow: Tab moves project-title → Resume
              // (if present) → next row's project-title. Enter/Space
              // on the project-title opens the modal.
              <div
                key={dpr.id}
                className="dpr-list-item"
              >
                <div style={{ flex: '0 0 36px', fontSize: '1.25rem' }} aria-hidden="true">📄</div>
                <button
                  type="button"
                  className="dpr-list-item-detail"
                  onClick={() => handleRowClick(dpr)}
                  aria-label={`${dpr.projectName || 'Untitled'} — ${dpr.status}${dpr.submittedAt ? `, submitted ${timeAgo(dpr.submittedAt)}` : ', draft'}`}
                  style={{ flex: 2, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit' }}
                >
                  <div style={{ fontWeight: 600, color: 'var(--navy)', marginBottom: '0.25rem' }}>{dpr.projectName}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--steel)' }}>
                    {formatDateOnly(dpr.reportDate, { day: 'numeric', month: 'short', year: 'numeric' })}
                    {dpr.contractor ? ` · ${dpr.contractor}` : ''}
                  </div>
                </button>
                <div style={{ flex: 1 }}>
                  <StatusBadge status={dpr.status} map={DPR_STATUS_MAP} />
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
                    // SOL-P0#4: Resume button as a SIBLING of the
                    // detail button (no longer nested inside the
                    // clickable row wrapper, which is gone).
                    <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => handleResumeDraft(dpr.id)}
                        style={{ padding: '0.3rem 0.7rem', fontSize: '0.78rem' }}
                        aria-label={`Resume editing ${dpr.projectName || 'draft'}`}
                      >
                        Resume
                      </button>
                      {confirmDeleteId === dpr.id ? (
                        <>
                          <span style={{ fontSize: '0.78rem', color: 'var(--danger)' }}>
                            Delete?
                          </span>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            style={{ padding: '0.25rem 0.55rem', fontSize: '0.78rem' }}
                            onClick={() => setConfirmDeleteId(null)}
                            disabled={deleting}
                          >
                            No
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            style={{
                              padding: '0.25rem 0.55rem',
                              fontSize: '0.78rem',
                              background: 'var(--danger)',
                              color: '#fff',
                              border: 'none',
                            }}
                            onClick={() => handleDeleteDraft(dpr.id)}
                            disabled={deleting}
                          >
                            {deleting ? 'Deleting…' : 'Yes, delete'}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          style={{
                            padding: '0.25rem 0.55rem',
                            fontSize: '0.78rem',
                            color: 'var(--danger)',
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDeleteId(dpr.id);
                          }}
                          aria-label={`Delete draft ${dpr.projectName || 'untitled'}`}
                        >
                          Delete
                        </button>
                      )}
                    </div>
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

      {expandedDpr && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`DPR ${expandedDpr.projectName} details`}
          onClick={handleCloseModal}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 100, padding: '1rem',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'white', borderRadius: 12, maxWidth: 720, width: '100%',
              maxHeight: '85vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
            }}
          >
            <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                {/* Round-17 B-03: breadcrumb in modal header. Last item is current page (no `to`). */}
                <Breadcrumb
                  items={[
                    { label: 'My Daily Reports', to: '/portal/dpr/my' },
                    {
                      // Prefer projectName; fall back to formatted reportDate so
                      // the breadcrumb always carries context even if the project
                      // name is empty (defensive — modal already gates on `expandedDpr`).
                      label: expandedDpr.projectName
                        || formatDateOnly(expandedDpr.reportDate, { day: 'numeric', month: 'short', year: 'numeric' })
                        || 'Daily Report',
                    },
                  ]}
                />
                <h1
                  style={{ margin: 0, fontSize: '1.15rem', color: 'var(--navy)' }}
                  aria-label={`${expandedDpr.projectName} — Daily Progress Report`}
                >
                  {expandedDpr.projectName}
                </h1>
                <div style={{ marginTop: '0.25rem', fontSize: '0.85rem', color: 'var(--steel)' }}>
                  {formatDateOnly(expandedDpr.reportDate, { day: 'numeric', month: 'short', year: 'numeric' })}
                  {' · '}{expandedDpr.location}
                </div>
              </div>
              <button
                onClick={handleCloseModal}
                aria-label="Close DPR details"
                className="btn btn-ghost btn-sm"
                style={{ fontSize: '1.25rem', lineHeight: 1 }}
              >
                ×
              </button>
            </div>

            <div style={{ padding: '1.25rem 1.5rem' }}>
              {expandedLoading ? (
                <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--steel)' }}>Loading details…</div>
              ) : expandedError ? (
                <div className="portal-auth-error">{expandedError}</div>
              ) : (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem 1.5rem', marginBottom: '1rem', fontSize: '0.9rem' }}>
                    <div><strong>Status:</strong> <StatusBadge status={expandedDpr.status} map={DPR_STATUS_MAP} /></div>
                    <div><strong>Work Type:</strong> {expandedDpr.workType || 'N/A'}</div>
                    <div><strong>Weather:</strong> {expandedDpr.weather || '—'}</div>
                    <div><strong>Temperature:</strong> {expandedDpr.temperature || '—'}</div>
                    <div><strong>Contractor:</strong> {expandedDpr.contractor || '—'}</div>
                    <div><strong>Submitted by:</strong> {expandedDpr.submittedBy?.name || '—'}</div>
                  </div>

                  {/* Round-12: 5 daily-narrative fields. */}
                  <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: '1rem', marginTop: '0.5rem' }}>
                    <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.5rem', color: 'var(--navy)' }}>
                      Daily Narrative
                    </h3>
                    <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'minmax(140px, max-content) 1fr', gap: '0.5rem 1rem', fontSize: '0.9rem' }}>
                      <dt style={{ fontWeight: 500, color: 'var(--steel)' }}>Work executed:</dt>
                      <dd style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{expandedDpr.workExecutedToday || <em className="text-placeholder">—</em>}</dd>
                      <dt style={{ fontWeight: 500, color: 'var(--steel)' }}>Work location:</dt>
                      <dd style={{ margin: 0 }}>{expandedDpr.workLocation || <em className="text-placeholder">—</em>}</dd>
                      <dt style={{ fontWeight: 500, color: 'var(--steel)' }}>Manpower:</dt>
                      <dd style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{expandedDpr.manpowerSummary || <em className="text-placeholder">—</em>}</dd>
                      <dt style={{ fontWeight: 500, color: 'var(--steel)' }}>Risks:</dt>
                      <dd style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{expandedDpr.risksHindrances || <em className="text-placeholder">—</em>}</dd>
                      <dt style={{ fontWeight: 500, color: 'var(--steel)' }}>Materials:</dt>
                      <dd style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{expandedDpr.materialsReceivedSummary || <em className="text-placeholder">—</em>}</dd>
                    </dl>
                  </div>

                  {expandedDpr.notes && (
                    <div style={{ marginTop: '1rem', fontSize: '0.9rem' }}>
                      <strong>Other notes:</strong>
                      <div style={{ marginTop: '0.25rem', color: 'var(--steel)', whiteSpace: 'pre-wrap' }}>{expandedDpr.notes}</div>
                    </div>
                  )}

                  {/* Round-12: user-added ad-hoc sections. */}
                  <CustomSectionsView sections={expandedDpr.customSections} />

                  {/* Round-12: linked inspection records. */}
                  {Array.isArray(expandedDpr.inspections) && expandedDpr.inspections.length > 0 && (
                    <div style={{ marginTop: '1rem' }}>
                      <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.5rem', color: 'var(--navy)' }}>
                        Linked Inspection Records ({expandedDpr.inspections.length})
                      </h3>
                      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                        {expandedDpr.inspections.map((insp) => (
                          <li key={insp.id} style={{ fontSize: '0.9rem' }}>
                            <Link to={`/portal/inspection/${insp.id}`}>{insp.inspectionType}</Link>
                            {' · '}
                            <span style={{ color: 'var(--steel)' }}>{insp.status}</span>
                            {insp.severity && (
                              <>
                                {' · '}
                                <span style={{ color: 'var(--steel)' }}>{insp.severity}</span>
                              </>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {expandedDpr.photos && expandedDpr.photos.length > 0 && (
                    <div style={{ marginTop: '1rem' }}>
                      <strong style={{ fontSize: '0.9rem' }}>Photos ({expandedDpr.photos.length})</strong>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '0.5rem', marginTop: '0.5rem' }}>
                        {expandedDpr.photos.map((p) => (
                          <a key={p.id} href={p.readUrl} target="_blank" rel="noopener noreferrer" title={p.filename} style={{ position: 'relative', display: 'block' }}>
                            <img
                              src={p.readUrl}
                              alt={p.caption || p.filename}
                              style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 6 }}
                            />
                            {/* R22.5: per-image download affordance — opens
                                the signed R2 URL in a new tab so the user
                                can right-click → Save As. */}
                            <PhotoDownloadButton photo={p} />
                          </a>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* SOL-P0#4: Resume / Edit / Delete actions for DRAFT DPRs. */}
                  {expandedDpr.status === 'DRAFT' && !expandedLoading && (
                    <div style={{ marginTop: '1.5rem', paddingTop: '1rem', borderTop: '1px solid #e2e8f0', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => handleResumeDraft(expandedDpr.id)}
                      >
                        Resume draft
                      </button>
                      {confirmDeleteId === expandedDpr.id ? (
                        <>
                          <span style={{ fontSize: '0.85rem', color: 'var(--danger)', alignSelf: 'center' }}>
                            Delete this draft permanently?
                          </span>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => setConfirmDeleteId(null)}
                            disabled={deleting}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            style={{ background: 'var(--danger)', color: 'white', border: 'none' }}
                            onClick={() => handleDeleteDraft(expandedDpr.id)}
                            disabled={deleting}
                          >
                            {deleting ? 'Deleting…' : 'Yes, delete'}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          style={{ color: 'var(--danger)' }}
                          onClick={() => setConfirmDeleteId(expandedDpr.id)}
                        >
                          Delete draft
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
