import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { formatShortDate } from '../../lib/format.js';
import StatusBadge from '../../components/StatusBadge.jsx';
import SeverityBadge from '../../components/SeverityBadge.jsx';
import { SUB_WORK_TYPE_OPTIONS } from '../portal/WorkTypes.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { CalendarIcon, MapPinIcon, CameraIcon } from '../../components/Icons.jsx';

// Round-12: admin view across all submitted inspection records across all
// engineers. Mirrors the DprDashboard structure (stat cards + filter chips
// + card grid) but scoped to the InspectionRecord table. The 15 sub-work
// types are the same SUB_WORK_TYPE_OPTIONS imported from WorkTypes.jsx
// so a label rename there is reflected here without duplication.
//
// C-06 (round-15+): local StatusBadge removed; uses the shared component.
// Inspection statuses (OPEN/ACKNOWLEDGED/IN_PROGRESS/PENDING_VERIFICATION/
// CLOSED/REJECTED) are all in the shared DEFAULT_STATUS_MAP.
// S5 audit, item 7: local SeverityBadge removed in favour of the shared
// component so palette + border + padding stay consistent with the rest of
// the portal (previously this one used MAJOR where the data carries HIGH,
// leading to a divergent label).

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
  return formatShortDate(iso) || String(iso);
}

function getLocalDate() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now - offset * 60000).toISOString().split('T')[0];
}

export default function InspectionDashboard() {
  useDocumentTitle('Inspections Review');
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
  // DR-029 (round-20): stats now come from /api/inspection/stats — a
  // single request that returns six explicit aggregate counts. Replaces the
  // previous "fetch limit=1 paginated lists, use response.length" pattern
  // that hard-capped every tile at 1. See docs/dashboard-metrics.md.
  const [stats, setStats] = useState({
    openNow: 0,
    filedToday: 0,
    closedToday: 0,
    acknowledged: 0,
    pendingReview: 0,
    totalActive: 0,
  });

  // Round-17 B-06: bulk-select state for the inspection admin queue. The
  // inspection status enum is OPEN / ACKNOWLEDGED / IN_PROGRESS /
  // PENDING_VERIFICATION / CLOSED / REJECTED (schema.prisma). Admin actions
  // (acknowledge / close / reject) only allow OPEN as a starting point;
  // the backend's REJECT_FROM set also covers IN_PROGRESS / PENDING_VERIFICATION.
  // Mirror that here so the checkbox only appears where bulk review is legal.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkActionLoading, setBulkActionLoading] = useState(false);
  const [bulkRejectReason, setBulkRejectReason] = useState('');

  const REVIEWABLE_STATUSES = new Set(['OPEN', 'IN_PROGRESS', 'PENDING_VERIFICATION']);
  // Round-26.5: per-action allowed-from sets that mirror the backend
  // ACK_FROM / CLOSE_FROM / REJECT_FROM constants in routes/inspection.js.
  // Without this, an admin who selects an OPEN record and clicks "Close" gets
  // a generic "Bulk close failed for all 1 IDs" toast because OPEN→CLOSED is
  // not a valid transition. The backend rejects per-ID; the UI now disables
  // the offending button + surfaces which row(s) blocked it.
  const ACK_ALLOWED_FROM = new Set(['OPEN']);
  const CLOSE_ALLOWED_FROM = new Set(['ACKNOWLEDGED', 'IN_PROGRESS', 'PENDING_VERIFICATION']);
  const REJECT_ALLOWED_FROM = new Set(['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'PENDING_VERIFICATION']);
  const selectableInspections = inspections.filter((i) => REVIEWABLE_STATUSES.has(i.status));
  const selectableIds = selectableInspections.map((i) => i.id);
  const allSelected =
    selectableIds.length > 0 &&
    selectableIds.every((id) => selectedIds.has(id));

  // Per-action compatibility for the currently-selected IDs. Returns the IDs
  // that are incompatible with the action AND the human-readable status(es)
  // they hold, so we can disable the button + show a tooltip / count.
  const incompatibleForAction = (action) => {
    const allowed =
      action === 'ACKNOWLEDGE' ? ACK_ALLOWED_FROM
      : action === 'CLOSE' ? CLOSE_ALLOWED_FROM
      : action === 'REJECT' ? REJECT_ALLOWED_FROM
      : null;
    if (!allowed) return { blockedIds: [], blockedStatuses: [] };
    const blockedIds = [];
    const blockedStatuses = new Set();
    for (const id of selectedIds) {
      const insp = inspections.find((i) => i.id === id);
      if (!insp) continue;
      if (!allowed.has(insp.status)) {
        blockedIds.push(id);
        blockedStatuses.add(insp.status);
      }
    }
    return { blockedIds, blockedStatuses: [...blockedStatuses] };
  };
  const ackCompat = incompatibleForAction('ACKNOWLEDGE');
  const closeCompat = incompatibleForAction('CLOSE');
  const rejectCompat = incompatibleForAction('REJECT');
  const ackBlockedCount = ackCompat.blockedIds.length;
  const closeBlockedCount = closeCompat.blockedIds.length;
  const rejectBlockedCount = rejectCompat.blockedIds.length;
  const formatBlockedHint = (compat) => {
    if (compat.blockedIds.length === 0) return '';
    const statuses = compat.blockedStatuses.join(', ');
    return `${compat.blockedIds.length} row${compat.blockedIds.length === 1 ? '' : 's'} in ${statuses} — not eligible`;
  };

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
      // DR-029 (round-20): replace three limit=1 sample queries with one
      // aggregate endpoint. The backend runs six COUNT() queries in
      // parallel against indexed columns; labels match exactly what the
      // count returns. See docs/dashboard-metrics.md.
      const statsRes = await api.getInspectionStats(accessToken);
      setStats({
        openNow: Number(statsRes.openNow) || 0,
        filedToday: Number(statsRes.filedToday) || 0,
        closedToday: Number(statsRes.closedToday) || 0,
        acknowledged: Number(statsRes.acknowledged) || 0,
        pendingReview: Number(statsRes.pendingReview) || 0,
        totalActive: Number(statsRes.totalActive) || 0,
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

  // Round-17 B-06: when filters change, the previously selected IDs may no
  // longer be visible — clear them so the floating action bar doesn't show
  // "3 selected" for rows the admin can't see anymore.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [filterStatus, filterType, filterFrom, filterTo]);

  const toggleSelected = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      if (allSelected) return new Set();
      return new Set(selectableIds);
    });
  };

  // Round-17 B-06: bulk fan-out for the inspection admin queue. Single
  // network round-trip for N IDs (vs N trips). Per-ID results so the admin
  // can see which rows failed (e.g. already moved to CLOSED via the detail
  // page while the bulk was in flight).
  //
  // Round-26.5: pre-flight validation against the same per-action allowed-from
  // sets the backend enforces. If ANY selected ID is in a status that the
  // action can't accept (e.g. OPEN → CLOSE), we abort the request entirely
  // and surface a precise message. Otherwise we'd still pay the round-trip
  // cost, the server would NACK every row, and the admin would see the
  // generic "Bulk close failed for all 1 IDs" toast with no clue why.
  const handleBulkAction = async (action) => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;

    if (action === 'REJECT' && !bulkRejectReason.trim()) {
      toast.push('Reject reason is required.', 'warning');
      return;
    }

    // Pre-flight: filter out IDs that can't be transitioned by this action.
    // The backend will reject them anyway; better UX is to send only the
    // eligible subset and tell the admin what got skipped.
    const compat = incompatibleForAction(action);
    if (compat.blockedIds.length === ids.length) {
      toast.push(
        `None of the ${ids.length} selected inspection${ids.length === 1 ? ' is' : 's are'} eligible to ${action.toLowerCase()}. Current statuses: ${compat.blockedStatuses.join(', ')}.`,
        'error'
      );
      return;
    }
    const eligibleIds = ids.filter((id) => !compat.blockedIds.includes(id));
    const skippedCount = compat.blockedIds.length;

    setBulkActionLoading(true);
    try {
      const result = await api.bulkReviewInspections(
        {
          ids: eligibleIds,
          action,
          reason: action === 'REJECT' ? bulkRejectReason.trim() : undefined,
        },
        accessToken
      );

      const verb =
        action === 'ACKNOWLEDGE' ? 'acknowledged' :
        action === 'CLOSE' ? 'closed' :
        action === 'REJECT' ? 'rejected' : 'updated';
      // Build a per-row error breakdown when ANY rows failed, so the admin
      // doesn't have to guess whether the issue was status, network, or
      // something else. The server returns `failed: [{id, error, code}]`.
      const failureBreakdown = (result.failed || [])
        .reduce((acc, f) => {
          acc[f.code || 'INTERNAL'] = (acc[f.code || 'INTERNAL'] || 0) + 1;
          return acc;
        }, {});
      const failureSummary = Object.keys(failureBreakdown).length
        ? ` (${Object.entries(failureBreakdown).map(([code, n]) => `${code}: ${n}`).join(', ')})`
        : '';

      if (result.failedCount === 0 && skippedCount === 0) {
        toast.push(`${result.succeededCount} inspection${result.succeededCount === 1 ? '' : 's'} ${verb}.`, 'success');
      } else if (result.succeededCount === 0 && skippedCount === 0) {
        toast.push(`Bulk ${action.toLowerCase()} failed for all ${result.failedCount} IDs${failureSummary}.`, 'error');
      } else if (result.succeededCount === 0) {
        toast.push(
          `Bulk ${action.toLowerCase()} skipped (${skippedCount} ineligible) and failed (${result.failedCount})${failureSummary}.`,
          'error'
        );
      } else {
        toast.push(
          `${verb}: ${result.succeededCount} ok, ${result.failedCount} failed${failureSummary}` +
            (skippedCount > 0 ? `, ${skippedCount} skipped (ineligible status)` : '') + '.',
          'warning'
        );
      }
      setSelectedIds(new Set());
      setBulkRejectReason('');
      await loadAll();
    } catch (err) {
      if (err.status !== 401) {
        toast.push(err.message || `Bulk ${action.toLowerCase()} failed.`, 'error');
      }
    } finally {
      setBulkActionLoading(false);
    }
  };

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
        <h1 className="dpr-page-title">Inspections Review</h1>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <Link to="/portal/inspection/submit" className="btn btn-primary btn-sm">
            + New Record
          </Link>
        </div>
      </div>

      <div className="dpr-dashboard-stats">
        {/* DR-029 (round-20): labels now match the backend aggregate.
            Each number is a real COUNT() against an indexed column with an
            explicit window — see docs/dashboard-metrics.md. */}
        <StatCard number={stats.openNow} label="Open" color="#dc2626" />
        <StatCard number={stats.filedToday} label="Filed Today" color="#2563eb" />
        <StatCard number={stats.closedToday} label="Closed Today" color="#16a34a" />
        <StatCard number={stats.acknowledged} label="Acknowledged" color="#f59e0b" />
        <StatCard number={stats.totalActive} label="Total Active" color="#64748b" />
      </div>

      <div className="dpr-card" style={{ marginBottom: '1rem' }}>
        {/* SOL-P0#2: every filter control now has a unique id and a wired
            <label htmlFor>. The From/To date pair is grouped in a
            <fieldset> with a <legend> for screen-reader context. */}
        <div className="form-row">
          <div className="form-group">
            <label htmlFor="insp-filter-status">Status</label>
            <select
              id="insp-filter-status"
              className="form-input"
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
            >
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
            <label htmlFor="insp-filter-type">Type</label>
            <select
              id="insp-filter-type"
              className="form-input"
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
            >
              <option value="">All types</option>
              {SUB_WORK_TYPE_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
          <fieldset className="form-group" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <legend style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--steel)', padding: 0 }}>Date range</legend>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <div>
                <label htmlFor="insp-filter-from" style={{ fontSize: '0.8rem' }}>From</label>
                <input
                  id="insp-filter-from"
                  type="date"
                  className="form-input"
                  value={filterFrom}
                  onChange={(e) => setFilterFrom(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="insp-filter-to" style={{ fontSize: '0.8rem' }}>To</label>
                <input
                  id="insp-filter-to"
                  type="date"
                  className="form-input"
                  value={filterTo}
                  onChange={(e) => setFilterTo(e.target.value)}
                />
              </div>
            </div>
          </fieldset>
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
        {/* Round-17 B-06: "Select all" only when there's something worth
            selecting (i.e. a reviewable-status row is visible). Hidden on
            purely terminal tabs (CLOSED/REJECTED) so the button doesn't
            appear dead. */}
        {selectableInspections.length > 0 && (
          <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem' }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={toggleSelectAll}
              disabled={bulkActionLoading}
              aria-pressed={allSelected}
              title={allSelected ? 'Clear selection' : `Select all ${selectableInspections.length} visible`}
            >
              {allSelected ? '☐ Clear' : `☑ Select all (${selectableInspections.length})`}
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
          {inspections.map((insp) => {
            const isSelectable = REVIEWABLE_STATUSES.has(insp.status);
            const isSelected = selectedIds.has(insp.id);
            return (
            <Link
              key={insp.id}
              to={`/portal/inspection/${insp.id}`}
              className={`dpr-card${isSelected ? ' inspection-card-selected' : ''}`}
              style={{ textDecoration: 'none', color: 'inherit', display: 'block', position: 'relative' }}
            >
              {/* Round-17 B-06: per-card checkbox. Only rendered for reviewable
                  statuses; CLOSED/REJECTED cards keep their layout untouched.
                  stopPropagation prevents the surrounding <Link> from also
                  navigating when the admin toggles the checkbox. */}
              {isSelectable && (
                <label
                  className="inspection-card-checkbox-label"
                  title={isSelected ? 'Deselect' : 'Select'}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    className="inspection-card-checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelected(insp.id)}
                    onClick={(e) => e.stopPropagation()}
                    disabled={bulkActionLoading}
                    aria-label={`Select ${insp.projectName || insp.location || 'inspection'} for bulk action`}
                  />
                </label>
              )}
              <div className="dpr-card-header">
                <div>
                  <h3 className="dpr-card-title">
                    <InspectionTypeLabel type={insp.inspectionType} />
                  </h3>
                  <div className="dpr-card-meta" style={{ marginTop: '0.5rem' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                      <MapPinIcon size={13} style={{ color: 'var(--steel)' }} />
                      {insp.location}
                    </span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                      <CalendarIcon size={13} style={{ color: 'var(--steel)' }} />
                      {formatIndianDate(insp.reportDate)}
                    </span>
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
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                  <CameraIcon size={13} style={{ color: 'var(--steel)' }} />
                  {insp.photos?.length || 0}
                </span>
                <span style={{ marginLeft: 'auto' }}>{insp.submittedBy?.name || '—'}</span>
              </div>
            </Link>
            );
          })}
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

      {/* Round-17 B-06: floating action bar — only renders when something is
          selected. Pinned to the viewport bottom so the admin can apply
          actions without scrolling back up to the toolbar. Mirrors the DPR
          bulk action bar but with the inspection-specific verbs
          (Acknowledge / Close / Reject). */}
      {selectedIds.size > 0 && (
        <div className="inspection-bulk-action-bar" role="region" aria-label="Bulk actions">
          <div className="inspection-bulk-action-summary">
            <strong>{selectedIds.size}</strong> selected
            {selectedIds.size > 1 && (
              <button
                type="button"
                className="inspection-bulk-clear"
                onClick={() => setSelectedIds(new Set())}
                disabled={bulkActionLoading}
              >
                Clear
              </button>
            )}
          </div>
          <div className="inspection-bulk-action-controls">
            <input
              type="text"
              className="form-input inspection-bulk-reason-input"
              placeholder="Reject reason (only needed for Reject)"
              value={bulkRejectReason}
              onChange={(e) => setBulkRejectReason(e.target.value)}
              disabled={bulkActionLoading}
              aria-label="Bulk reject reason"
            />
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => handleBulkAction('ACKNOWLEDGE')}
              disabled={bulkActionLoading || ackBlockedCount === selectedIds.size}
              title={ackBlockedCount > 0 ? formatBlockedHint(ackCompat) : ''}
            >
              {bulkActionLoading ? '...' : `✓ Acknowledge${ackBlockedCount > 0 ? ` (${selectedIds.size - ackBlockedCount})` : ''}`}
            </button>
            <button
              type="button"
              className="btn btn-success btn-sm"
              onClick={() => handleBulkAction('CLOSE')}
              disabled={bulkActionLoading || closeBlockedCount === selectedIds.size}
              title={closeBlockedCount > 0 ? formatBlockedHint(closeCompat) : ''}
            >
              {bulkActionLoading ? '...' : `✓ Close${closeBlockedCount > 0 ? ` (${selectedIds.size - closeBlockedCount})` : ''}`}
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => handleBulkAction('REJECT')}
              disabled={
                bulkActionLoading ||
                !bulkRejectReason.trim() ||
                rejectBlockedCount === selectedIds.size
              }
              title={
                !bulkRejectReason.trim()
                  ? 'Enter a reject reason first'
                  : rejectBlockedCount > 0
                  ? formatBlockedHint(rejectCompat)
                  : ''
              }
            >
              {bulkActionLoading ? '...' : `✗ Reject${rejectBlockedCount > 0 && bulkRejectReason.trim() ? ` (${selectedIds.size - rejectBlockedCount})` : ''}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
