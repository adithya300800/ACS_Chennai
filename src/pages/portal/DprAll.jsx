import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import StatusBadge from '../../components/StatusBadge.jsx';
import PhotoDownloadButton from '../../components/PhotoDownloadButton.jsx';
import MonthFilter from '../../components/MonthFilter.jsx';
import MonthStepper from '../../components/MonthStepper.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { CalendarIcon, MapPinIcon, CameraIcon, ClipboardIcon } from '../../components/Icons.jsx';
import { formatDateOnly, formatMonthLabel, getCurrentIstMonth } from '../../lib/format.js';
import {
  emptyStateMessage,
  emptyStateActions,
  scopeBadge as scopeBadgeFor,
} from '../../lib/scopeCopy.js';
import Modal from '../../components/Modal.jsx';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import BackButton from '../../components/BackButton.jsx';
// Round-28 #6: pull-to-refresh on mobile list views.
import usePullToRefresh from '../../hooks/usePullToRefresh.js';
import PullToRefreshIndicator from '../../components/PullToRefreshIndicator.jsx';
// Round-28 #7: full-screen photo lightbox with keyboard + swipe nav.
import PhotoLightbox from '../../components/PhotoLightbox.jsx';

// Round-22: admin cross-org DPR list. The previous "My Daily Reports" page
// (DprList at /portal/dpr/my) rendered every org DPR for admins because the
// backend GET /api/dpr returns all rows when no `my=true` filter is set,
// making the page title misleading for the admin role. This new page —
// mirroring InspectionAll — gives admins an explicit, well-named destination
// for browsing the cross-org DPR history. Layout is a card grid (not the
// row-list of DprList) to match the All Inspection Records visual contract.
// Click a card to open an inline detail modal; no separate /portal/dpr/:id
// route exists, so we mirror DprList's modal pattern.
//
// R22.5: filters (status, date range, project name, submitter) +
// per-photo download overlay on the modal.

const WORK_TYPE_LABEL = {
  MATERIAL_RECEIPT: 'Material Receipt',
  QUALITY_TESTING: 'Quality Testing',
  SITE_INSPECTION: 'Site Inspection',
  EXCEPTIONS_SAFETY: 'Exceptions / Safety',
};

// Same per-page status map as DprList.jsx so SUBMITTED stays visually
// distinct from UNDER_REVIEW (round-15 SOL C-06).
const DPR_STATUS_MAP = {
  DRAFT: 'dpr-status-draft',
  SUBMITTED: 'dpr-status-submitted',
  UNDER_REVIEW: 'dpr-status-review',
  APPROVED: 'dpr-status-approved',
  REJECTED: 'dpr-status-rejected',
};

// R22.5: shared status filter options for the All Daily Reports page. Same
// shape as DprList.jsx STATUS_FILTERS so the dropdown is consistent across
// the two DPR browse views.
const STATUS_FILTERS = [
  { value: '', label: 'All Statuses' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'SUBMITTED', label: 'Submitted' },
  { value: 'UNDER_REVIEW', label: 'Under Review' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
];

function PhotoThumb({ photo }) {
  const src = photo.thumbUrl || photo.readUrl || photo.blobUrl;
  if (!src) {
    return (
      <div
        className="text-placeholder"
        style={{ width: '100%', height: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--steel)', background: '#f1f5f9', borderRadius: 6 }}
      >
        <CameraIcon size={20} />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={photo.caption || 'Site photo'}
      loading="lazy"
      style={{ width: '100%', height: 100, objectFit: 'cover', borderRadius: 6, display: 'block' }}
    />
  );
}

function DprDetailModal({ dprSummary, onClose, returnFocusRef }) {
  const { accessToken } = useAuth();
  const [dpr, setDpr] = useState(dprSummary);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Round-28 #7: lightbox state. Click a thumbnail in the modal grid to
  // open the full-screen lightbox at that index; arrows / swipe / Esc
  // navigate inside the lightbox.
  const [lightboxIndex, setLightboxIndex] = useState(null);
  // Round-29: pourSummary state + getCubePourSummary call REMOVED —
  // the cube-test feature is gone. Cube testing is captured by the
  // cube_casting / cube_testing InspectionRecord sub-types.

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api.getDpr(dprSummary.id, accessToken)
      .then((full) => {
        if (cancelled) return;
        setDpr(full);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || 'Failed to load DPR details');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [dprSummary.id, accessToken]);

  return (
    // DR-017: replaced the inline <div role="dialog"> with the shared
    // Modal primitive. The audit found that six Tab presses escaped
    // the dialog into the cards behind it; the primitive now handles
    // initial focus, focus trap, Escape, and focus return to the
    // trigger. The DPR card ref captured by the parent <DprAll>
    // render is passed through via the parent (see `<DprDetailModal
    // ... returnFocusRef={triggerRef} />` below).
    <Modal
      open={!!dprSummary}
      onClose={onClose}
      ariaLabel={`DPR ${dpr?.project?.name || dpr?.projectName || ''} details`}
      returnFocusRef={returnFocusRef}
    >
      {/* SOL-P2 #8: breadcrumb + persistent back-to-list anchor. The
          modal previously had no trail at all — reviewers coming in
          from a deep link or after scrolling through 20 cards had to
          click "×" and re-find their row. The breadcrumb + BackButton
          give them an explicit escape hatch that matches the employee
          `DprList` modal and the rest of the portal's detail pages. */}
      <Breadcrumb
        items={[
          { label: 'All Daily Reports', to: '/portal/dpr/all' },
          { label: dpr?.project?.name || dpr?.projectName || 'Detail' },
        ]}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem', gap: '1rem' }}>
        <div>
          <h2 style={{ margin: 0, color: 'var(--navy)', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
            {dpr?.project?.name || dpr?.projectName || 'DPR'}
          </h2>
          <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <StatusBadge status={dpr?.status} map={DPR_STATUS_MAP} />
            <span style={{ fontSize: '0.85rem', color: 'var(--steel)' }}>
              {WORK_TYPE_LABEL[dpr?.workType] || dpr?.workType || '—'}
            </span>
          </div>
          {/* Round-28 #5: inline rejection reason so the reviewer can see WHY
              a previously-rejected DPR was sent back without diving into the
              activity log. Surfaced for any DPR — admins read it during
              re-review; employees read it before they fix and resubmit. */}
          {dpr?.status === 'REJECTED' && (dpr?.rejectionReason || dpr?.adminNotes) && (
            <div
              role="alert"
              style={{
                marginTop: '0.75rem',
                padding: '0.625rem 0.75rem',
                background: '#fef2f2',
                border: '1px solid #fecaca',
                borderLeft: '3px solid var(--danger, #dc2626)',
                borderRadius: 6,
                fontSize: '0.85rem',
                color: '#7f1d1d',
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>Rejected</div>
              {dpr.rejectionReason && (
                <div style={{ marginBottom: dpr.adminNotes ? '0.5rem' : 0 }}>
                  {dpr.rejectionReason}
                </div>
              )}
              {dpr.adminNotes && (
                <div style={{ fontSize: '0.8rem', color: '#991b1b', fontStyle: 'italic' }}>
                  Admin note: {dpr.adminNotes}
                </div>
              )}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexShrink: 0 }}>
          <BackButton to="/portal/dpr/all" label="Back to all reports" />
          <button type="button" onClick={onClose} className="btn btn-ghost btn-sm" aria-label="Close details">✕</button>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--steel)' }}>Loading details…</div>
      ) : error ? (
        <div className="portal-auth-error">{error}</div>
      ) : dpr ? (
        <>
          {/* SOL-P2 bug #8: mobile DPR detail modal used to render only a
              handful of fields. Round-28 added the photo lightbox and the
              rejection banner, but linked-inspections + approval-history
              were still missing on small viewports. We render them above
              the field grid so mobile (which scrolls single-column) reads
              them first. Desktop already showed the same info via the
              wider layout — this just makes it explicit for everyone. */}
          {(Array.isArray(dpr.inspections) && dpr.inspections.length > 0) || dpr.reviewedBy || dpr.approvedBy ? (
            <div style={{ marginBottom: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {Array.isArray(dpr.inspections) && dpr.inspections.length > 0 && (
                <div style={{ padding: '0.625rem 0.75rem', background: '#f8fafc', borderRadius: 6, borderLeft: '3px solid var(--blue)' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--steel)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.375rem' }}>
                    Linked Inspections ({dpr.inspections.length})
                  </div>
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                    {dpr.inspections.map((insp) => (
                      <li key={insp.id} style={{ fontSize: '0.85rem' }}>
                        <Link to={`/portal/inspection/${insp.id}`}>
                          {insp.inspectionType.replace(/_/g, ' ').toLowerCase()}
                        </Link>
                        {' · '}
                        <span style={{ color: 'var(--steel)' }}>{insp.status}</span>
                        {insp.severity && (
                          <span style={{ marginLeft: '0.4rem', color: insp.severity === 'CRITICAL' ? 'var(--danger, #dc2626)' : 'var(--steel)' }}>
                            · {insp.severity}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(dpr.reviewedBy || dpr.approvedBy) && (
                <div style={{ padding: '0.625rem 0.75rem', background: '#f8fafc', borderRadius: 6, borderLeft: '3px solid var(--steel)' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--steel)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.375rem' }}>
                    Approval History
                  </div>
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.85rem' }}>
                    {dpr.reviewedBy && (
                      <li>
                        <strong>Reviewed by:</strong> {dpr.reviewedBy.name}
                      </li>
                    )}
                    {dpr.approvedBy && (
                      <li>
                        <strong>Approved by:</strong> {dpr.approvedBy.name}
                      </li>
                    )}
                  </ul>
                </div>
              )}
            </div>
          ) : null}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '1rem' }}>            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--steel)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Report date</div>
              <div style={{ color: 'var(--navy)' }}>{dpr.reportDate ? formatDateOnly(dpr.reportDate) : '—'}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--steel)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Location</div>
              <div style={{ color: 'var(--navy)' }}>{dpr.location || '—'}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--steel)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Submitted by</div>
              <div style={{ color: 'var(--navy)' }}>{dpr.submittedBy?.name || '—'}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--steel)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Weather</div>
              <div style={{ color: 'var(--navy)' }}>{dpr.weather || '—'}{dpr.temperature ? ` · ${dpr.temperature}` : ''}</div>
            </div>
            {/* N7: linked BOQ item, same convention as DprList modal.
                Read-only here — admins can follow the variance link to
                the standalone report. */}
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--steel)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>BOQ Item</div>
              <div style={{ color: 'var(--navy)' }}>
                {dpr.boqItem ? (
                  <>
                    <span style={{ fontFamily: 'monospace' }}>{dpr.boqItem.itemCode}</span>
                    {' — '}
                    <span>{dpr.boqItem.description}</span>
                    {' · '}
                    <Link to={`/portal/boq?projectName=${encodeURIComponent((dpr.project?.name || dpr.projectName) || '')}`}>View variance</Link>
                  </>
                ) : (
                  <em className="text-placeholder">Not linked</em>
                )}
              </div>
            </div>
          </div>

          {dpr.workExecutedToday && (
            <div style={{ marginBottom: '1rem' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--steel)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.25rem' }}>Work executed today</div>
              <div style={{ whiteSpace: 'pre-wrap', color: 'var(--navy)' }}>{dpr.workExecutedToday}</div>
            </div>
          )}
          {dpr.notes && (
            <div style={{ marginBottom: '1rem' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--steel)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.25rem' }}>Other observations</div>
              <div style={{ whiteSpace: 'pre-wrap', color: 'var(--navy)' }}>{dpr.notes}</div>
            </div>
          )}

          {/* Round-29: cube-test pour summary panel REMOVED — the
              standalone cube-test feature is gone. */}

          {Array.isArray(dpr.photos) && dpr.photos.length > 0 && (
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--steel)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.5rem' }}>
                Photos ({dpr.photos.length})
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '0.5rem' }}>
                  {dpr.photos.map((p, i) => (
                    <button
                      key={p.id || p.ulid}
                      type="button"
                      onClick={() => setLightboxIndex(i)}
                      style={{
                        position: 'relative',
                        padding: 0,
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                      aria-label={`Open photo ${i + 1} of ${dpr.photos.length}`}
                    >
                      <PhotoThumb photo={p} />
                      {/* R22.5: per-image download affordance on the modal. */}
                      <PhotoDownloadButton photo={p} />
                      {p.caption && <div style={{ fontSize: '0.75rem', color: 'var(--steel)', marginTop: '0.25rem' }}>{p.caption}</div>}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : null}
      <PhotoLightbox
        photos={dpr?.photos || []}
        startIndex={lightboxIndex ?? 0}
        open={lightboxIndex !== null}
        onClose={() => setLightboxIndex(null)}
      />
    </Modal>
  );
}

export default function DprAll() {
  useDocumentTitle('All Daily Reports Records');
  const { accessToken } = useAuth();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [dprs, setDprs] = useState([]);
  const [loading, setLoading] = useState(true);
  // S5-pagination: cursor state for "Load more". The backend encodes the
  // cursor as (reportDate, id) from the last row of the current page
  // (see backend/src/routes/dpr.js:807-810 and backend/src/lib/cursor.js).
  // On filter change the loader resets nextCursor to null so a partial
  // page from the previous filter doesn't bleed into the new view.
  const [nextCursor, setNextCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [selectedDpr, setSelectedDpr] = useState(null);
  // DR-017: capture the DPR card that opened the modal so the Modal
  // primitive can return focus to it after close. Without this the
  // user is dropped at <body> and has to Tab back through the page.
  const lastTriggerRef = useRef(null);
  // [N1 Phase B] Project picker — feeds the projectId filter dropdown.
  // Mirrors Projects.jsx's fetch but only the registered slice so the
  // dropdown doesn't show 50+ auto-discovered names. The fetch is
  // one-shot and tolerant of failure (an empty dropdown silently
  // hides the new filter rather than breaking the page).
  const [projects, setProjects] = useState([]);
  const loadProjects = useCallback(async () => {
    try {
      const data = await api.getProjects({ isActive: 'true', limit: '200' }, accessToken);
      setProjects(data.projects || []);
    } catch (_) {
      // Silent — the project filter is an enhancement. Admins without
      // a working /api/projects still see every DPR.
    }
  }, [accessToken]);
  useEffect(() => { loadProjects(); }, [loadProjects]);

  // R22.5: filter state for the admin browse view. The backend supports
  // `status`, `from`, `to` (date range on reportDate), `projectName`
  // (case-insensitive contains), and `submittedById` (cuid). The first
  // three were already wired in r21; we added projectName + submittedById
  // in r22.5.
  //
  // Round-27: `month` is added on top of the existing filters, defaulted
  // to the current IST business month so the page lands on a bounded
  // window rather than every-org-row on first load. The backend
  // (`backend/src/routes/dpr.js` GET /) treats `month` as exclusive of
  // `from`/`to` and emits 400 MONTH_AND_RANGE_CONFLICT if both are sent
  // — the FE prevents that by clearing the matching filter when month
  // changes. Setting `month` to '' opts the admin out into an "all-time"
  // view; the Clear button snaps back to current month instead of empty.
  //
  // DR-016: persist filter state in the URL so refresh / back /
  // share-link / email-CTA all land on the same filtered view. The
  // URL is the single source of truth: `filter` is initialized from
  // URL params on every change (refresh, back/forward, share-link),
  // and writing a filter pushes it back to the URL.
  const FILTER_PARAM_KEYS = ['month', 'status', 'from', 'to', 'projectName', 'projectId', 'submittedById'];
  const defaultFilter = () => ({
    month: getCurrentIstMonth(),
    status: '',
    from: '',
    to: '',
    projectName: '',
    projectId: '',
    submittedById: '',
  });
  const [filter, setFilter] = useState(() => {
    const initial = defaultFilter();
    for (const k of FILTER_PARAM_KEYS) {
      const v = searchParams.get(k);
      if (v !== null) initial[k] = v;
    }
    return initial;
  });
  // URL -> filter sync (handles back/forward + share links). We only
  // re-derive when a key that we own changed in the URL — this avoids
  // an infinite loop with the filter->URL sync below and keeps the
  // deep-link `?id=` param alone (we don't touch it).
  const filterFromUrl = searchParams.get('month') !== null
    || searchParams.get('status') !== null
    || searchParams.get('from') !== null
    || searchParams.get('to') !== null
    || searchParams.get('projectName') !== null
    || searchParams.get('projectId') !== null
    || searchParams.get('submittedById') !== null;
  useEffect(() => {
    if (!filterFromUrl) return;
    const next = defaultFilter();
    for (const k of FILTER_PARAM_KEYS) {
      const v = searchParams.get(k);
      if (v !== null) next[k] = v;
    }
    setFilter(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterFromUrl]);
  // Filter -> URL sync (handles refresh + share-link). Only fires when
  // filter actually diverges from the URL — prevents an infinite loop
  // with the URL->filter sync above.
  //
  // The "value" computed for comparison normalizes the implicit
  // current-month default to the empty string on BOTH sides so a
  // filter == currentMonth looks identical to "no URL param" and
  // doesn't trigger an unnecessary URL write on cold load.
  const currentMonth = getCurrentIstMonth();
  const normalize = (k, v) => (
    (k === 'month' && v === currentMonth) ? '' : (v ?? '')
  );
  const filterKey = FILTER_PARAM_KEYS.map((k) => `${k}=${normalize(k, filter[k])}`).join('|');
  useEffect(() => {
    const current = FILTER_PARAM_KEYS.map((k) => `${k}=${normalize(k, searchParams.get(k))}`).join('|');
    if (current === filterKey) return;
    const next = new URLSearchParams(searchParams);
    for (const k of FILTER_PARAM_KEYS) {
      const v = filter[k];
      if (v && v !== '' && !(k === 'month' && v === currentMonth)) {
        next.set(k, v);
      } else {
        next.delete(k);
      }
    }
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  // DR-016: distinguish three time-scope states so the empty-state copy
  // and the recovery action are always accurate.
  //   - monthIsHistorical: month is set but not the current month.
  //     The admin is looking at a specific past month. An empty result
  //     means "no DPRs in <Month>" — NOT "the org has no data".
  //   - monthIsAllTime: month is '' (admin explicitly picked "All
  //     records" from the Month dropdown). An empty result means
  //     "no DPRs match your other filters".
  //   - monthIsCurrent: month is the current month (default landing).
  //     An empty result with no other filters means "no DPRs yet
  //     this month across the org" — only this branch uses the
  //     original copy.
  const monthIsAllTime = filter.month === '';
  const monthIsHistorical = !!filter.month && filter.month !== currentMonth;
  const monthIsCurrent = !!filter.month && filter.month === currentMonth;
  const [showFilters, setShowFilters] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    // S5-pagination: starting a fresh page (initial load or filter
    // change) clears any prior cursor so the page count is honest.
    setNextCursor(null);
    try {
      // GET /api/dpr returns every org row for admins by default (no
      // `my=true` filter). See backend/src/routes/dpr.js:641 — the
      // restrictToSelf check is `!isAdmin || my === 'true'`.
      //
      // S5-pagination: limit dropped from 100 → 50 so "Load more" is
      // visible at meaningful data sizes (the backend's default is 20,
      // which is too small for the admin browse view). The backend
      // returns `nextCursor: null` when the result is the tail, so the
      // footer can read "Showing N DPRs · all loaded".
      const params = { limit: '50' };
      // Round-27: send `month` as the YYYY-MM string. The backend
      // expands to a half-open IST window via getMonthRangeUtc() and
      // refuses `from`/`to` in the same request with 400.
      if (filter.month) params.month = filter.month;
      if (filter.status) params.status = filter.status;
      if (filter.from) params.from = filter.from;
      if (filter.to) params.to = filter.to;
      if (filter.projectName) params.projectName = filter.projectName;
      if (filter.projectId) params.projectId = filter.projectId;
      if (filter.submittedById) params.submittedById = filter.submittedById;
      const data = await api.getDprs(params, accessToken);
      setDprs(data.dprs || []);
      setNextCursor(data.nextCursor || null);
    } catch (err) {
      if (err.status !== 401) {
        // MONTH_AND_RANGE_CONFLICT and INVALID_MONTH surface here as a
        // 400; the FE keeps the filter state and shows the message so
        // the admin can back one filter out.
        setError(err.message || 'Failed to load all daily reports.');
        toast.push(err.message || 'Failed to load all daily reports.', 'error');
      }
    } finally {
      setLoading(false);
    }
  }, [accessToken, toast, filter]);

  // S5-pagination: appends the next page to `dprs` using the cursor from
  // the previous page. Reset (clear + initial load) still goes through
  // `load` above; this handler is only for "Load more" presses.
  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore || loading) return;
    setLoadingMore(true);
    setError('');
    try {
      const params = { limit: '50', cursor: nextCursor };
      if (filter.month) params.month = filter.month;
      if (filter.status) params.status = filter.status;
      if (filter.from) params.from = filter.from;
      if (filter.to) params.to = filter.to;
      if (filter.projectName) params.projectName = filter.projectName;
      if (filter.projectId) params.projectId = filter.projectId;
      if (filter.submittedById) params.submittedById = filter.submittedById;
      const data = await api.getDprs(params, accessToken);
      setDprs((prev) => [...prev, ...(data.dprs || [])]);
      setNextCursor(data.nextCursor || null);
    } catch (err) {
      if (err.status !== 401) {
        setError(err.message || 'Failed to load more daily reports.');
        toast.push(err.message || 'Failed to load more daily reports.', 'error');
      }
    } finally {
      setLoadingMore(false);
    }
  }, [accessToken, toast, filter, nextCursor, loadingMore, loading]);

  useEffect(() => { load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [accessToken, filter]);

  // DR-015: deep-link opener. Email CTAs for DPR detail route here
  // with `?id=<DPR_ID>` (see backend/src/lib/portalLinks.js:
  // dprDetailHref maps the logical "DPR detail page" to
  // /portal/dpr/all?id=<id>). When the user lands, we auto-open the
  // detail modal for that record IF it appears in the current loaded
  // list. If the record isn't in the loaded list (filtered out by the
  // current month/status filters), we clear the query param so the
  // empty-result state isn't misleading — the user keeps their filter
  // and can switch to "All time" to find the record.
  useEffect(() => {
    const idParam = searchParams.get('id');
    if (!idParam || loading) return;
    const match = dprs.find((d) => d.id === idParam);
    if (match) {
      setSelectedDpr(match);
      // Strip the param so a reload doesn't re-open the modal forever,
      // and so the URL doesn't keep a stale id after the user closes
      // the modal themselves.
      const next = new URLSearchParams(searchParams);
      next.delete('id');
      setSearchParams(next, { replace: true });
    }
    // We deliberately only respond once per ?id value: when no match
    // is found, drop the param so a back-and-forth with the filters
    // doesn't repeatedly try (and fail) to find it.
    if (!match) {
      const next = new URLSearchParams(searchParams);
      next.delete('id');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dprs, loading]);

  const handleFilterChange = (key, value) => {
    setFilter((f) => {
      // Round-27: backend refuses `month` combined with `from`/`to`.
      // Clearing the date-range half when a month is picked keeps the FE
      // honest with the wire contract — the admin reselects a range
      // explicitly if they want one.
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
    // Round-27: snap-back to the CURRENT month so the page never lands
    // on the unbounded "every org row" view after a Clear. Admins who
    // want all-time pick "All-time" explicitly from the Month dropdown.
    setFilter({
      month: getCurrentIstMonth(),
      status: '',
      from: '',
      to: '',
      projectName: '',
      projectId: '',
      submittedById: '',
    });
  };

  const hasActiveFilters = Boolean(
    filter.status || filter.from || filter.to || filter.projectName || filter.projectId || filter.submittedById
  );

  // DR-016 scope flags live next to the URL-sync block so the current
  // month is computed in one place.

  // The submitter dropdown is populated from the unique names found in the
  // currently loaded list. This avoids a separate /api/employees fetch and
  // keeps the dropdown scoped to "people who actually submitted a DPR". If
  // a filter narrows the list to 0 rows, the dropdown loses options — the
  // admin can clear the filter to re-populate.
  const submitterOptions = (() => {
    const map = new Map();
    for (const d of dprs) {
      const id = d.submittedBy?.id;
      if (id && !map.has(id)) map.set(id, d.submittedBy?.name || id);
    }
    return Array.from(map.entries()).map(([id, name]) => ({ value: id, label: name }));
  })();

  // Round-28 #6: pull-to-refresh on mobile. Re-runs the first-page load
  // (which also clears the cursor, so the indicator refresh means "from
  // the top again", matching native iOS/Android behavior).
  const { pullDistance, isRefreshing } = usePullToRefresh(async () => {
    await load();
  });

  return (
    <div className="dpr-page">
      <PullToRefreshIndicator pullDistance={pullDistance} isRefreshing={isRefreshing} />
      <div className="dpr-page-header">
        <div>
          <h1 className="dpr-page-title">All Daily Reports Records</h1>
          <p className="dpr-page-sub" style={{ color: 'var(--steel)', margin: 0, fontSize: '0.9rem' }}>
            Every daily progress report across the organization.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {/* R27.5: always-visible month stepper — the primary way to
              scroll back one month at a time without opening Filters. */}
          <MonthStepper
            value={filter.month}
            onChange={(v) => handleFilterChange('month', v)}
          />
          <button className="btn btn-secondary btn-sm" onClick={() => setShowFilters((s) => !s)}>
            <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 3H2l8 9.46V19l4 2V12.46z"/></svg>
            Filters {showFilters ? '▲' : '▼'}
          </button>
          <a href="#/portal/admin/dpr" className="btn btn-secondary btn-sm">
            ← Back to admin review queue
          </a>
        </div>
      </div>

      {showFilters && (
        <div className="dpr-card" style={{ marginBottom: '1rem' }}>
          {/* Round-27: month filter sits above the existing per-field
              filters so it visually anchors the time scope. Month-wise
              view is the default; other filters narrow within it. */}
          <div className="form-row">
            <MonthFilter
              id="dprall-filter-month"
              value={filter.month}
              onChange={(v) => handleFilterChange('month', v)}
            />
            <div className="form-group">
              <label htmlFor="dprall-filter-status">Status</label>
              <select
                id="dprall-filter-status"
                className="form-input"
                value={filter.status}
                onChange={(e) => handleFilterChange('status', e.target.value)}
              >
                {STATUS_FILTERS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <fieldset className="form-group" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <legend style={{ fontSize: '0.85rem', fontWeight: 500, color: 'var(--steel)', padding: 0 }}>Date range</legend>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <div>
                  <label htmlFor="dprall-filter-from" style={{ fontSize: '0.8rem' }}>From</label>
                  <input
                    id="dprall-filter-from"
                    type="date"
                    className="form-input"
                    value={filter.from}
                    onChange={(e) => handleFilterChange('from', e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="dprall-filter-to" style={{ fontSize: '0.8rem' }}>To</label>
                  <input
                    id="dprall-filter-to"
                    type="date"
                    className="form-input"
                    value={filter.to}
                    onChange={(e) => handleFilterChange('to', e.target.value)}
                  />
                </div>
              </div>
            </fieldset>
            <div className="form-group">
              <label htmlFor="dprall-filter-project">Project name</label>
              <input
                id="dprall-filter-project"
                type="text"
                className="form-input"
                value={filter.projectName}
                onChange={(e) => handleFilterChange('projectName', e.target.value)}
                placeholder="Contains…"
              />
            </div>
            {/* [N1 Phase B] Exact-match filter on the registered Project
                UUID — the natural deep-link target when an admin is
                drilling into one site from ProjectDetail. The dropdown
                is a strict superset of the text contains filter above:
                empty selection = no extra filtering; a selection here
                AND text in projectName = AND (so both can co-exist). */}
            <div className="form-group">
              <label htmlFor="dprall-filter-projectId">Project (registered)</label>
              <select
                id="dprall-filter-projectId"
                className="form-input"
                value={filter.projectId}
                onChange={(e) => handleFilterChange('projectId', e.target.value)}
                disabled={projects.length === 0}
              >
                <option value="">All projects</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.code ? ` (${p.code})` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="dprall-filter-submitter">Submitted by</label>
              <select
                id="dprall-filter-submitter"
                className="form-input"
                value={filter.submittedById}
                onChange={(e) => handleFilterChange('submittedById', e.target.value)}
              >
                <option value="">All submitters</option>
                {submitterOptions.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
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
      ) : dprs.length === 0 ? (
        <div className="dpr-list-empty" style={{ textAlign: 'center', padding: '3rem' }}>
          <div style={{ marginBottom: '1rem', color: 'var(--steel)' }}>
            <ClipboardIcon size={48} />
          </div>
          <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", color: 'var(--navy)' }}>
            No daily reports found
          </h3>
          {/* DR-016: copy is delegated to scopeCopy.emptyStateMessage()
              so the logic is unit-tested in isolation. The helper picks
              one of five branches based on (month, hasOtherFilters) —
              see frontend/__tests__/scopeCopy.test.js. */}
          <p style={{ color: 'var(--steel)' }}>
            {emptyStateMessage({
              entityName: 'daily reports',
              entityNameSingular: 'daily report',
              month: filter.month,
              currentMonth,
              hasOtherFilters: hasActiveFilters,
              formatMonthLabel,
            })}
          </p>
          {/* Recovery actions come from the same helper so they cannot
              drift out of sync with the copy. ALWAYS at least one
              action so the admin can never be stranded. */}
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', flexWrap: 'wrap', marginTop: '0.75rem' }}>
            {emptyStateActions({
              month: filter.month,
              currentMonth,
              hasOtherFilters: hasActiveFilters,
              formatMonthLabel,
            }).map((a) => (
              <button
                key={a.key}
                className={`btn btn-sm ${a.key === 'view-all' || a.key === 'clear-all' ? 'btn-secondary' : 'btn-ghost'}`}
                onClick={() => {
                  if (a.clearsAllFilters) clearFilters();
                  else handleFilterChange('month', a.targetMonth);
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1rem' }}>
          {dprs.map((dpr) => {
            const workTypeLabel = WORK_TYPE_LABEL[dpr.workType] || dpr.workType || '—';
            return (
              <div
                key={dpr.id}
                role="button"
                tabIndex={0}
                className="dpr-card"
                onClick={(e) => {
                  // Capture the trigger for focus-return on close.
                  lastTriggerRef.current = e.currentTarget;
                  setSelectedDpr(dpr);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    lastTriggerRef.current = e.currentTarget;
                    setSelectedDpr(dpr);
                  }
                }}
                aria-label={`${dpr.project?.name || dpr.projectName || 'Untitled'} — ${dpr.status}`}
                style={{ cursor: 'pointer', textDecoration: 'none', color: 'inherit', display: 'block' }}
              >
                <div className="dpr-card-header">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h3 className="dpr-card-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{dpr.project?.name || dpr.projectName || 'Untitled'}</h3>
                    <div className="dpr-card-meta" style={{ marginTop: '0.5rem' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                        <CalendarIcon size={13} style={{ color: 'var(--steel)' }} />
                        {dpr.reportDate ? formatDateOnly(dpr.reportDate) : '—'}
                      </span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                        <MapPinIcon size={13} style={{ color: 'var(--steel)' }} />
                        {dpr.location || '—'}
                      </span>
                    </div>
                    {/* N3 (Phase F): drawing stamp sub-line. Renders only when
                        the DPR was filed against a specific drawing revision.
                        drawingId is the joined UUID; drawingRev is the
                        denormalised revision string (e.g. "Rev 3"). */}
                    {dpr.drawingId && dpr.drawingRev && (
                      <div style={{ fontSize: '0.75rem', color: '#075985', marginTop: '0.25rem', fontFamily: 'monospace' }}>
                        Drawing · Rev {dpr.drawingRev}
                      </div>
                    )}
                  </div>
                  <StatusBadge status={dpr.status} map={DPR_STATUS_MAP} />
                </div>
                <div style={{ fontSize: '0.85rem', color: 'var(--steel)', marginBottom: '0.5rem' }}>{workTypeLabel}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--steel)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #f1f5f9', paddingTop: '0.5rem', marginTop: '0.5rem' }}>
                  <span>
                    Submitted by <strong style={{ color: 'var(--navy)' }}>{dpr.submittedBy?.name || '—'}</strong>
                  </span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                    <CameraIcon size={13} />
                    {Array.isArray(dpr.photos) ? dpr.photos.length : 0}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        <div className="dpr-list-count" style={{ textAlign: 'center', color: 'var(--steel)', fontSize: '0.8rem', padding: '0.75rem 0.5rem' }}>
          Showing {dprs.length} DPR{dprs.length !== 1 ? 's' : ''}
          {/* S5-pagination: tell the admin when more rows exist behind
              the cursor so they know the page is intentionally clipped.
              `nextCursor: null` means the backend's last page — see
              backend/src/routes/dpr.js:807-810. */}
          {nextCursor ? ' · more available' : ' · all loaded'}
          {/* DR-016: surface the active scope beside the count so the
              admin always knows whether they're looking at a specific
              month, all-time, or the current default. The previous
              '· filtered' suffix didn't tell the admin WHICH filter.
              scopeBadgeFor() returns '' for the default case so the
              common view stays clean. */}
          {(() => {
            const badge = scopeBadgeFor({ month: filter.month, currentMonth, formatMonthLabel });
            return badge ? ` · ${badge}` : '';
          })()}
          {hasActiveFilters ? ' · filtered' : ''}
        </div>
        {/* S5-pagination: append-next-page affordance. Disabled while
            loading or while the backend reported no cursor — both
            states mean "nothing to append right now". */}
        {nextCursor && (
          <div style={{ textAlign: 'center', padding: '0 0 1.5rem' }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={loadMore}
              disabled={loadingMore}
              aria-label="Load more daily reports"
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
        </>
      )}

      {selectedDpr && (
        <DprDetailModal
          dprSummary={selectedDpr}
          onClose={() => setSelectedDpr(null)}
          returnFocusRef={lastTriggerRef}
        />
      )}
    </div>
  );
}
