import React, { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { formatDateOnly, formatMonthLabel, getCurrentIstMonth, shiftMonth } from '../../lib/format.js';
import StatusBadge from '../../components/StatusBadge.jsx';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import PhotoDownloadButton from '../../components/PhotoDownloadButton.jsx';
import MonthStepper from '../../components/MonthStepper.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { ClipboardIcon } from '../../components/Icons.jsx';
// Round-28 #6: pull-to-refresh on mobile list views.
import usePullToRefresh from '../../hooks/usePullToRefresh.js';
import PullToRefreshIndicator from '../../components/PullToRefreshIndicator.jsx';

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
  const { accessToken, employee } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const isAdmin = !!employee?.isAdmin;

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
  //
  // Live-R7a: `month` is now the primary time axis — the header shows a
  // MonthStepper so the user can walk back one calendar month at a time
  // without opening Filters. `month` is mutually exclusive with
  // `from`/`to` on the backend (400 MONTH_AND_RANGE_CONFLICT); when
  // `month` is set we send it instead of the manual range. Setting
  // `month` to '' opts into "all-time" (rare for employees). The Clear
  // filters action snaps month back to the current month — same as
  // DprAll's "snap-to-current" pattern.
  const [filter, setFilter] = useState({
    status: '',
    myOnly: true,
    from: '',
    to: '',
    month: getCurrentIstMonth(),
  });
  const [showFilters, setShowFilters] = useState(false);
  // P0 fix (round-10): clicking a row previously navigated to the same
  // route with location.state.selectedDpr — nothing read that state, so
  // the click looked broken. Open an inline modal with the DPR detail
  // (fetches the canonical row with photos + read-SAS URLs).
  const [expandedDpr, setExpandedDpr] = useState(null);
  const [expandedLoading, setExpandedLoading] = useState(false);
  const [expandedError, setExpandedError] = useState('');
  // N5: pour-summary cache keyed by dpr id. Filled in when the modal
  // opens; failures are non-fatal — if the cube-test endpoint is down
  // we just hide the section rather than gating the rest of the modal.
  const [pourSummary, setPourSummary] = useState(null);
  const [pourSummaryLoading, setPourSummaryLoading] = useState(false);

  const fetchDprs = useCallback(async (cursor = null) => {
    try {
      const params = {};
      if (filter.status) params.status = filter.status;
      if (filter.myOnly) params.my = 'true';
      // R7a: prefer the month shortcut when set. Backend rejects
      // month + from/to together, so only send the manual range when
      // month is unset (employee explicitly opted into "all-time" via
      // Clear filters or via the from/to inputs).
      if (filter.month) {
        params.month = filter.month;
      } else {
        if (filter.from) params.from = filter.from;
        if (filter.to) params.to = filter.to;
      }
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

  // R8 fix: refetch when the tab regains focus so the row's status +
  // Resume/Delete affordances always reflect backend truth. Without
  // this, a draft that was approved by an admin in another tab (or
  // from the admin phone) stays in the local React state as DRAFT, the
  // user clicks Delete, and the backend correctly returns 409
  // INVALID_TRANSITION — the user then reads the error toast as
  // "delete is broken". One focus event + an idempotent re-load is
  // cheaper than a SWR-style stale-on-mount dance and matches the
  // pattern already used in DprAll / InspectionAll.
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
    setPourSummary(null);
    try {
      const full = await api.getDpr(dpr.id, accessToken);
      setExpandedDpr(full);
    } catch (err) {
      setExpandedError(err.message || 'Failed to load DPR details');
    } finally {
      setExpandedLoading(false);
    }
    // N5: also fetch the cube-test pour summary so the modal can show
    // cast / passed / pending counts inline. Parallel to the DPR fetch
    // so the modal still opens promptly when the cube-test endpoint is
    // slow. Failures are silent — see setPourSummary's catch block.
    setPourSummaryLoading(true);
    try {
      const summary = await api.getCubePourSummary(dpr.id, accessToken);
      setPourSummary(summary);
    } catch (_err) {
      setPourSummary(null);
    } finally {
      setPourSummaryLoading(false);
    }
  };

  const handleCloseModal = () => {
    setExpandedDpr(null);
    setExpandedError('');
    setExpandedLoading(false);
    setPourSummary(null);
    setPourSummaryLoading(false);
  };

  // SOL-P0#4: Resume / Edit / Delete draft actions.
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const handleResumeDraft = (dprId) => {
    navigate(`/portal/dpr/submit?draftId=${dprId}`);
  };

  // Live-R1 + R6 + R8: Render free-plan sleeps the backend after ~15 min
  // of inactivity. The first request to a sleeping backend often hits a
  // TCP-level failure (NETWORK_ERROR from api.js), not a slow timeout.
  //
  // Cold-start reality from the live-validation run (5 Sept 2026): a
  // single retry wasn't enough — Render took ~30s to fully wake, so a
  // 4s backoff still hit a NETWORK_ERROR. Escalate to a backoff ladder
  // (4s → 8s → 16s, ~30s total) and surface "still waking up" toasts
  // so the user sees progress instead of a silent spinner.
  //
  // R8 (5 Sept 2026): the previous ladder ONLY handled NETWORK_ERROR.
  // The actual "still failing" report turned out to be the 409
  // INVALID_TRANSITION response — a draft that an admin had just
  // approved (from the admin phone / another tab) was still showing in
  // the local React state as DRAFT, the user clicked Delete, and the
  // backend's perfectly-correct 409 surfaced as the bare string
  // "Only DRAFT DPRs can be deleted (current status: SUBMITTED)" which
  // read as "delete is broken". Two fixes:
  //   1) The page now refetches on `focus` + `visibilitychange`
  //      (effect above) so the row's status is always current BEFORE
  //      the click — most 409s disappear at the source.
  //   2) The catch block below now maps the remaining 409 / 404 / 403
  //      codes to friendly messages AND refreshes the list, so the
  //      stale row disappears and the modal closes — the user sees
  //      "This DPR is no longer a draft" instead of a Prisma error.
  const handleDeleteDraft = async (dprId, attempt = 1) => {
    setDeleting(true);
    try {
      await api.deleteDpr(dprId, accessToken);
      toast.push('Draft deleted.', 'success');
      setConfirmDeleteId(null);
      handleCloseModal();
      setDprs((prev) => prev.filter((d) => d.id !== dprId));
      return;
    } catch (err) {
      const isColdStart = err?.code === 'NETWORK_ERROR';
      // 4s, 8s, 16s — gives the container time to boot AND bind port.
      const backoffs = [4000, 8000, 16000];
      if (isColdStart && attempt <= backoffs.length) {
        toast.push(
          attempt === 1
            ? 'Server is waking up — retrying…'
            : `Server still waking up — attempt ${attempt} of ${backoffs.length + 1}…`,
          'info'
        );
        await new Promise((r) => setTimeout(r, backoffs[attempt - 1]));
        return handleDeleteDraft(dprId, attempt + 1);
      }
      // R8: structured backend errors → friendly text. 404 means the
      // draft was already deleted (likely from another tab / device);
      // 409 means the status moved off DRAFT; 403 means it's no longer
      // theirs. In all three, the local row is stale — close the modal
      // and re-load so the UI matches reality.
      const code = err?.code || err?.error;
      let friendly = null;
      let shouldReload = false;
      if (err?.status === 404 || code === 'NOT_FOUND') {
        friendly = 'This DPR no longer exists — it may have already been deleted.';
        shouldReload = true;
      } else if (err?.status === 409 || code === 'INVALID_TRANSITION') {
        friendly = 'This DPR is no longer a draft and cannot be deleted. Refreshing the list.';
        shouldReload = true;
      } else if (err?.status === 403 || code === 'FORBIDDEN') {
        friendly = 'You can only delete your own drafts.';
      }
      if (shouldReload) {
        toast.push(friendly, 'info');
        setConfirmDeleteId(null);
        handleCloseModal();
        load();
      } else {
        toast.push(
          isColdStart
            ? 'Server is taking too long to respond. Tap Delete again in a minute to retry.'
            : (friendly || err.message || 'Failed to delete draft'),
          'error'
        );
      }
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

  // Round-28 #6: pull-to-refresh on mobile. Re-runs the first-page
  // load on a downward swipe at scroll-top. The indicator overlay
  // (rendered just inside the page root) drives its visual state from
  // the hook's {pullDistance, isRefreshing} return value.
  const { pullDistance, isRefreshing } = usePullToRefresh(async () => {
    await load(null);
  });

  return (
    <div className="dpr-page">
      <PullToRefreshIndicator pullDistance={pullDistance} isRefreshing={isRefreshing} />
      <div className="dpr-page-header">
        <h1 className="dpr-page-title">My Daily Reports</h1>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {/* R7a: month stepper mirrors the DprAll header layout. The
              stepper walks `filter.month` back/forward one calendar
              month at a time; clearing month to '' isn't surfaced in
              the UI because employees almost never want an unbounded
              history view. Reset paths (Current month / Clear filters
              below) always snap back to the current month. */}
          <MonthStepper
            value={filter.month}
            onChange={(v) => setFilter((f) => ({ ...f, month: v }))}
          />
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
              {/* Live-R4: the "My DPRs only" checkbox is admin-only.
                  Employees on this page have no cross-org view (the
                  backend scopes them to their own records regardless of
                  `my`), so showing them a checkbox that can never do
                  anything is dead UI. Admins keep it as the toggle
                  between their own records and the org-wide view. */}
              {isAdmin && (
                <label htmlFor="dpr-filter-mine" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                  <input
                    id="dpr-filter-mine"
                    type="checkbox"
                    checked={filter.myOnly}
                    onChange={e => handleFilterChange('myOnly', e.target.checked)}
                  />
                  My DPRs only
                </label>
              )}
            </div>
          </div>
          {/* Live-R7a: the reset pills also snap `month` back to the
              current month — the header MonthStepper owns the time
              scope on this page, so any "reset" action has to align
              with it. "Clear filters" resets `month` to current
              (matches DprAll's snap-to-current pattern) and clears
              status; "All-time" is the only path that drops month
              to '' (left to the user's discretion via a future
              enhancement — not surfaced today). */}
          {(filter.status || filter.from || filter.to || (filter.month && filter.month !== getCurrentIstMonth())) && (
            <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setFilter((f) => ({ ...f, month: getCurrentIstMonth(), from: '', to: '' }))}
                aria-label="Reset to current month"
              >
                Current month
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setFilter((f) => ({ ...f, status: '', from: '', to: '', month: getCurrentIstMonth() }))}
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
                  {/* SOL-P0#4 + live-R2: Resume / Delete are gated on
                      `status === 'DRAFT'`, not on `!dpr.submittedAt`.
                      The old heuristic broke when an admin approved a
                      DRAFT directly (backend/src/routes/dpr.js only
                      stamps submittedAt on the DRAFT → SUBMITTED
                      transition — see line 518), leaving approved rows
                      with status=APPROVED and submittedAt=null, which
                      the row renderer mistakenly rendered as a draft
                      with a Resume button that 409'd on click.

                      Non-DRAFT rows render the time-ago block; the
                      ternary's else branch is required because esbuild
                      (vite's JSX transform) rejects a truthy-only
                      conditional — babel-jest was more permissive,
                      which is why this slipped past `npx jest`. */}
                  {dpr.status === 'DRAFT' ? (
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
                  ) : (
                    // Non-DRAFT rows: show the original timeAgo block
                    // that the previous `dpr.submittedAt ? ... : ...`
                    // ternary was producing for terminal-state rows.
                    // Without this else branch, approved/submitted
                    // rows would render an empty cell.
                    <div>
                      {dpr.submittedAt && (
                        <>
                          <div>{timeAgo(dpr.submittedAt)}</div>
                          <div style={{ fontSize: '0.75rem' }}>{dpr.submittedBy?.name}</div>
                        </>
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
                    {/* N7: linked BOQ item. Server returns the related
                        boqItem row joined in (boqItemId → boqItem).
                        Render a deep-link into the variance report —
                        admins can also jump to the BOQ registry edit
                        page for the same item. */}
                    <div>
                      <strong>BOQ Item:</strong>{' '}
                      {expandedDpr.boqItem ? (
                        <>
                          <span style={{ fontFamily: 'monospace' }}>{expandedDpr.boqItem.itemCode}</span>
                          {' — '}
                          <span>{expandedDpr.boqItem.description}</span>
                          {' · '}
                          <Link to={`/portal/boq?projectName=${encodeURIComponent(expandedDpr.projectName || '')}`}>
                            View variance
                          </Link>
                        </>
                      ) : (
                        <em className="text-placeholder">Not linked</em>
                      )}
                    </div>
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

                  {/* N5: cube-test pour summary — cast / passed / pending
                      counts + a deep-link to each cube test row. Sourced
                      from /api/cube-tests/pour-summary/:dprId, fetched
                      in parallel with the DPR detail. Failures are silent
                      — the user still sees the rest of the modal. */}
                  {(pourSummary || pourSummaryLoading) && (
                    <div style={{ marginTop: '1rem' }}>
                      <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.5rem', color: 'var(--navy)' }}>
                        Cube Tests ({pourSummary?.counts?.cast ?? 0})
                      </h3>
                      {pourSummary && (
                        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                          <span style={{ color: 'var(--steel)' }}>
                            <strong style={{ color: 'var(--navy)' }}>{pourSummary.counts.passed}</strong> passed
                          </span>
                          <span style={{ color: 'var(--steel)' }}>
                            <strong style={{ color: 'var(--navy)' }}>{pourSummary.counts.pending}</strong> pending
                          </span>
                          {pourSummary.counts.failed > 0 && (
                            <span style={{ color: 'var(--danger, #dc2626)' }}>
                              <strong>{pourSummary.counts.failed}</strong> failed
                            </span>
                          )}
                          {pourSummary.counts.overdue > 0 && (
                            <span style={{ color: 'var(--danger, #dc2626)' }}>
                              <strong>{pourSummary.counts.overdue}</strong> overdue
                            </span>
                          )}
                          <span style={{ marginLeft: 'auto', color: 'var(--steel)' }}>
                            Billing: {pourSummary.billingStatus === 'READY' ? 'Ready' : 'In progress'}
                          </span>
                        </div>
                      )}
                      {pourSummary?.tests?.length > 0 && (
                        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                          {pourSummary.tests.map((ct) => (
                            <li key={ct.id} style={{ fontSize: '0.9rem' }}>
                              <Link to={`/portal/cube-tests/${ct.id}`}>
                                {ct.concreteGrade} · {ct.pourLocation}
                              </Link>
                              {' · '}
                              <span style={{ color: 'var(--steel)' }}>{ct.status.replace(/_/g, ' ').toLowerCase()}</span>
                            </li>
                          ))}
                        </ul>
                      )}
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
