// R36: Admin "Project Reports" — cross-project, cross-employee view.
//
// Mirrors the DrawingsAdmin / BOQ / Variations registry pattern:
//   - 4-filter toolbar (project, type chips, uploader, date range)
//   - card grid (auto-fill, 300px min) with type badge + project name +
//     uploader + size + date + Download + Delete actions
//   - cursor pagination via "Load more"
//   - empty + loading states
//
// Sits at /portal/admin/reports, mounted under PortalLayout's admin tree.
// Backend route is /api/admin/reports (see
// backend/src/routes/adminReports.js) — admin-only, with project +
// uploadedBy joins in the response so the SPA never has to resolve
// UUIDs to labels.
//
// Per the user's "use existing pages, don't over-engineer" guidance
// this page reuses:
//   - The per-project read-sas + delete helpers (api.getProjectAttachmentReadSas
//     + api.deleteProjectAttachment) — the admin response includes
//     `projectId` so no new download/delete endpoints are needed.
//   - PROJECT_REPORT_TYPES / PROJECT_REPORT_TYPE_LABELS from
//     src/lib/constants.js — same labels the per-project ReportSection
//     uses for chips + badges.
//   - The filter-chip + card-grid visual vocabulary of DrawingsAdmin.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { uploadBlob, BlobUploadError } from '../../lib/blobUpload.js';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { formatShortDate, formatBytes } from '../../lib/format.js';
import {
  MAX_REPORT_BYTES,
  ACCEPTED_REPORT_TYPES,
  PROJECT_REPORT_TYPES,
  PROJECT_REPORT_TYPE_LABELS,
  DOCUMENT_CATEGORIES,
  DOCUMENT_CATEGORY_LABELS,
} from '../../lib/constants.js';
import FilterChip from '../../components/ui/FilterChip.jsx';

// Color-coded type badges — 5 enum values, each gets a distinct bg/text
// pair so the admin can scan the card grid by hue.
const REPORT_TYPE_BADGE_STYLES = {
  WEEKLY_REPORT:        { background: '#dbeafe', color: '#1e40af' }, // blue
  MONTHLY_REPORT:       { background: '#dcfce7', color: '#166534' }, // green
  DUE_DILIGENCE_REPORT: { background: '#fef3c7', color: '#92400e' }, // amber
  QUALITY_REPORT:       { background: '#ede9fe', color: '#5b21b6' }, // purple
  OTHER:                { background: '#f1f5f9', color: '#475569' }, // slate
};

// [S7 round-2] Mirror the MyProjectReports state-machine constants — the
// wire enum strings + the allowed-from Sets must match the backend
// `ALLOWED_TRANSITIONS` map keys by source text (see
// projectAttachments.js PATCH handler).
const APPROVE_ALLOWED_FROM = new Set(['PENDING_REVIEW', 'REVISION_REQUESTED']);
const REVISE_ALLOWED_FROM = new Set(['PENDING_REVIEW']);
const REJECT_ALLOWED_FROM = new Set(['PENDING_REVIEW', 'REVISION_REQUESTED']);

const STATUS_LABEL = {
  PENDING_REVIEW: 'Pending review',
  APPROVED: 'Approved',
  REVISION_REQUESTED: 'Revision requested',
  REJECTED: 'Rejected',
};
const STATUS_COLOR = {
  PENDING_REVIEW: { bg: '#fef3c7', fg: '#92400e' },
  APPROVED: { bg: '#dcfce7', fg: '#166534' },
  REVISION_REQUESTED: { bg: '#ffedd5', fg: '#9a3412' },
  REJECTED: { bg: '#fee2e2', fg: '#991b1b' },
};

const DEFAULT_LIMIT = 50;

function formatDate(value) {
  if (!value) return '—';
  const out = formatShortDate(value);
  return out || String(value);
}

export default function ReportsAdmin() {
  useDocumentTitle('Project Reports');
  const { accessToken, isAdmin } = useAuth();
  const toast = useToast();

  // Filter state.
  const [projects, setProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectId, setProjectId] = useState('');          // '' = all
  const [activeTypes, setActiveTypes] = useState([]);        // [] = all
  // [DocumentCategory] Single-value category chip filter (mutually
  // exclusive — '' = show every category including uncategorised
  // legacy rows). Mirrors the MyProjectReports chip row + the
  // backend's ?category= query param. The admin can pick at most
  // one category at a time to keep the chip row readable on a 5-row
  // toolbar that already has 4 dropdown filters.
  const [filterCategory, setFilterCategory] = useState('');
  const [uploadedById, setUploadedById] = useState('');     // '' = all
  const [employees, setEmployees] = useState([]);
  const [employeesLoading, setEmployeesLoading] = useState(true);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // Pagination state.
  const [reports, setReports] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  // [S7 round-2] Admin review action bar state. actionBusy is a single
  // in-flight flag (not per-row); reviewNotes is keyed by attachment id so
  // multiple rows can have a half-typed reject reason without clobbering
  // each other. Mirrors the MyProjectReports implementation exactly so
  // the source-text test pins stay in lockstep.
  const [actionBusy, setActionBusy] = useState(false);
  const [reviewNotesById, setReviewNotesById] = useState({});

  // [BLOB_GONE recovery] Replace-file flow — admins can re-upload a new
  // file in place of one whose R2 bytes are missing (BLOB_GONE 410 from
  // read-sas). The hidden <input type="file"> is keyed by attachment id
  // so the change handler knows which row to PATCH. One in-flight flag
  // mirrors the upload pipeline elsewhere.
  const [replaceBusyId, setReplaceBusyId] = useState(null);
  const [replaceError, setReplaceError] = useState(null);
  const fileInputRef = useRef(null);
  const replaceTargetRef = useRef(null);

  // ─── Loaders: projects + employees (filters' dropdowns) ─────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getProjects(accessToken);
        if (cancelled) return;
        const list = (data?.projects || []).filter((p) => p.isActive);
        setProjects(list);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load projects');
      } finally {
        if (!cancelled) setProjectsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [accessToken]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Admin directory picker — same endpoint the Training bulk-assign
        // picker consumes. Limited to 200 entries (the admin picker cap)
        // which is plenty for the per-employee filter on a ~50-person team.
        const data = await api.listAdminEmployees({ limit: '200' }, accessToken);
        if (cancelled) return;
        setEmployees(data?.employees || []);
      } catch (err) {
        if (!cancelled) {
          // Non-fatal — the uploader filter just stays empty + we surface
          // the error inline. Don't block the page over a stale directory.
          console.warn('[reports-admin] employee directory load failed', err?.message);
        }
      } finally {
        if (!cancelled) setEmployeesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [accessToken]);

  // ─── Fetch reports (page 1 or load more) ───────────────────────────
  const fetchReports = useCallback(async ({ append = false, cursor = null } = {}) => {
    if (append) setLoadingMore(true); else setLoading(true);
    setError('');
    try {
      // [DR-022] Backend now accepts `?types=A,B,C` (CSV) — the
      // multi-type chip case used to issue one request per type and
      // merge in-memory, silently truncating to 50 rows on page 1 and
      // keeping only the first type's nextCursor. The CSV form is one
      // round trip, the order is server-stable, and the nextCursor we
      // forward is the union's, not one bucket's. The previous
      // truncation (`deduped.slice(0, DEFAULT_LIMIT)`) is gone — every
      // matching ID is reachable across pages.
      const params = { limit: String(DEFAULT_LIMIT) };
      if (projectId) params.projectId = projectId;
      if (activeTypes.length > 0) params.types = activeTypes.join(',');
      // [DocumentCategory] Forward the chip filter to the backend GET
      // handler. The CSV variant (?categories=A,B) is intentionally not
      // exposed here — admins pick one category at a time on this page
      // so the single-value param keeps the wire contract symmetric
      // with MyProjectReports.
      if (filterCategory) params.category = filterCategory;
      if (uploadedById) params.uploadedById = uploadedById;
      if (fromDate) params.from = fromDate;
      if (toDate) params.to = toDate;
      if (cursor) params.cursor = cursor;
      const data = await api.getAdminReports(params, accessToken);
      const items = data?.reports || [];
      setReports((prev) => (append ? [...prev, ...items] : items));
      setNextCursor(data?.nextCursor || null);
      // total is the unsplit filtered count from the first page; on
      // subsequent pages we keep what we already had so the header
      // stat stays stable.
      if (!append) setTotal(data?.total ?? items.length);
    } catch (err) {
      setError(err?.message || 'Failed to load reports');
      if (!append) {
        setReports([]);
        setNextCursor(null);
        setTotal(0);
      }
    } finally {
      if (append) setLoadingMore(false); else setLoading(false);
    }
  }, [projectId, activeTypes, uploadedById, fromDate, toDate, accessToken, filterCategory]);

  // Re-fetch when any filter changes — same effect shape as
  // DrawingsAdmin's `useEffect(() => { fetchDrawings(); }, [fetchDrawings])`.
  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  // ─── Filter handlers ───────────────────────────────────────────────
  function toggleType(t) {
    setActiveTypes((prev) => prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]);
  }
  function clearAllFilters() {
    setProjectId('');
    setActiveTypes([]);
    setFilterCategory('');
    setUploadedById('');
    setFromDate('');
    setToDate('');
  }
  const anyFilterActive = projectId || activeTypes.length > 0 || uploadedById || fromDate || toDate || filterCategory;

  // ─── Actions ───────────────────────────────────────────────────────
  async function handleDownload(att) {
    try {
      const { sasUrl } = await api.getProjectAttachmentReadSas(
        att.projectId, att.id, accessToken,
      );
      window.open(sasUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      toast.push(err?.message || 'Could not open file', 'error');
    }
  }

  async function handleDelete() {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await api.deleteProjectAttachment(confirmDelete.projectId, confirmDelete.id, accessToken);
      toast.push(`Report "${confirmDelete.title || confirmDelete.filename}" archived.`, 'success');
      setConfirmDelete(null);
      // Refetch — the soft-delete will disappear from the list immediately.
      await fetchReports();
    } catch (err) {
      toast.push(err?.message || 'Failed to archive report', 'error');
    } finally {
      setDeleting(false);
    }
  }

  // [BLOB_GONE recovery] Click handler for the "Replace file" button.
  // Stash the row on a ref + programmatically open the hidden file
  // picker. The change handler (handleReplaceFileChange) does the actual
  // SAS → R2 PUT → confirm → PATCH dance.
  function startReplaceFile(att) {
    if (replaceBusyId) return;
    replaceTargetRef.current = att;
    setReplaceError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  }

  async function handleReplaceFileChange(e) {
    const file = e.target.files?.[0];
    const att = replaceTargetRef.current;
    if (!file || !att) return;
    if (file.size > MAX_REPORT_BYTES) {
      const msg = `File too large. Max ${Math.round(MAX_REPORT_BYTES / (1024 * 1024))} MB.`;
      setReplaceError(msg);
      toast.push(msg, 'error');
      return;
    }
    if (!ACCEPTED_REPORT_TYPES.includes(file.type)) {
      const msg = `File type "${file.type || 'unknown'}" not supported.`;
      setReplaceError(msg);
      toast.push(msg, 'error');
      return;
    }
    setReplaceBusyId(att.id);
    setReplaceError(null);
    try {
      // 1. Mint a presigned PUT URL for the new bytes.
      const { sasUrl, ulid, blobPath } = await api.getReportSasUrl(
        file.name, file.type, accessToken,
      );
      // 2. PUT bytes direct-to-R2 (defense-in-depth: confirm-upload
      //    flips the intent row to CONFIRMED so the orphan sweeper
      //    can't evict the new bytes while we wait for the PATCH).
      await uploadBlob(sasUrl, file, { contentType: file.type });
      await api.confirmReportUpload(
        ulid, file.name, file.type, file.size, accessToken,
      );
      // 3. PATCH the row — DR-001 intent binding + review state reset.
      const updated = await api.replaceProjectAttachmentFile(
        att.projectId, att.id, {
          uploadIntentUlid: ulid,
          blobPath,
          filename: file.name,
          contentType: file.type,
          sizeBytes: file.size,
        }, accessToken,
      );
      // 4. Patch the row in place so the new filename/size + reset
      //    status render without a full re-fetch.
      setReports((prev) => prev.map((r) => (r.id === att.id ? { ...r, ...updated } : r)));
      toast.push(`Replaced file — "${updated.filename}".`, 'success');
    } catch (err) {
      const msg = err instanceof BlobUploadError
        ? err.message
        : (err?.message || 'Replace failed');
      setReplaceError(msg);
      toast.push(msg, 'error');
    } finally {
      setReplaceBusyId(null);
      replaceTargetRef.current = null;
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  // [S7 round-2] Admin review handler — mirrors MyProjectReports.runReviewAction.
  // `action` is one of 'APPROVED' | 'REVISION_REQUESTED' | 'REJECTED' (matches
  // backend enum exactly). On success the local row is patched in place so
  // the status pill + buttons re-render without a full re-fetch; on a 409
  // the optimistic patch is reverted via fetchReports().
  const runReviewAction = useCallback(async (att, action) => {
    if (actionBusy) return;
    const notes = (reviewNotesById[att.id] || '').trim();
    if ((action === 'REVISION_REQUESTED' || action === 'REJECTED') && !notes) return;
    setActionBusy(true);
    setReports((prev) => prev.map((r) => (r.id === att.id
      ? { ...r, status: action, reviewedAt: new Date().toISOString(), reviewNotes: notes || null }
      : r
    )));
    try {
      const updated = await api.reviewProjectAttachment(
        att.projectId, att.id,
        // [DR-037] Echo the row's contentVersion at click-time so the
        // server can 409 if a parallel replace already moved it. This
        // is captured from `att.contentVersion` (the optimistic-updated
        // local row above sets it from the prior server response).
        { status: action, reviewNotes: notes || null, expectedVersion: att.contentVersion ?? 0 },
        accessToken,
      );
      setReports((prev) => prev.map((r) => (r.id === att.id ? { ...r, ...updated } : r)));
      setReviewNotesById((prev) => {
        if (!prev[att.id]) return prev;
        const next = { ...prev };
        delete next[att.id];
        return next;
      });
      const verb = action === 'APPROVED' ? 'approved' : action === 'REJECTED' ? 'rejected' : 'sent for revision';
      toast.push(`Report ${verb}.`, 'success');
    } catch (err) {
      fetchReports();
      // [DR-037] Stale-version 409 — server says the row moved since
      // we opened the tab. Render a "refresh and try again" toast
      // instead of the generic failure copy so the admin knows the
      // action didn't fail for a transient reason.
      const isStale = err?.code === 'STALE_REVIEW_VERSION'
        || (typeof err?.message === 'string' && err.message.includes('STALE_REVIEW_VERSION'));
      const msg = isStale
        ? 'This report changed since you opened it. The page refreshed; please try again.'
        : (err?.message || `Failed to ${action.toLowerCase()} report.`);
      if (err?.status !== 401) toast.push(msg, 'error');
    } finally {
      setActionBusy(false);
    }
  }, [actionBusy, reviewNotesById, accessToken, toast]);

  return (
    <div className="dpr-page">
      {/* Hidden file input — triggered programmatically by the Replace
          button on each report card. Mirrors the per-card picker
          pattern used by ReportSection. */}
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_REPORT_TYPES.join(',')}
        onChange={handleReplaceFileChange}
        style={{ display: 'none' }}
        aria-hidden="true"
      />
      {replaceError && (
        <div className="portal-auth-error" role="alert" style={{ marginBottom: '0.75rem' }}>
          {replaceError}
        </div>
      )}
      <div className="dpr-page-header">
        <div>
          <Breadcrumb
            items={[
              { label: 'Admin Overview', to: '/portal/admin' },
              { label: 'Project Reports' },
            ]}
          />
          <h1 className="dpr-page-title">Project Reports</h1>
          <p style={{ color: 'var(--steel)', fontSize: '0.9rem', margin: 0 }}>
            Every weekly, monthly, due-diligence, quality, and ad-hoc report
            uploaded across all projects and all employees. Use the filters
            to narrow by project, type, uploader, or date range.
          </p>
        </div>
      </div>

      {/* ─── Filter toolbar ───────────────────────────────────────────── */}
      <div className="dpr-card" style={{ marginBottom: '1rem' }}>
        <div className="form-row" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: '0.75rem' }}>
          <div className="form-group" style={{ flex: '2 1 220px', minWidth: 200 }}>
            <label htmlFor="reports-project">Project</label>
            <select
              id="reports-project"
              className="form-input"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              disabled={projectsLoading}
            >
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.code ? ` (${p.code})` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group" style={{ flex: '1 1 180px', minWidth: 180 }}>
            <label htmlFor="reports-uploader">Uploaded by</label>
            <select
              id="reports-uploader"
              className="form-input"
              value={uploadedById}
              onChange={(e) => setUploadedById(e.target.value)}
              disabled={employeesLoading}
            >
              <option value="">Any employee</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>{emp.name}</option>
              ))}
            </select>
          </div>
          <div className="form-group" style={{ flex: '1 1 140px', minWidth: 140 }}>
            <label htmlFor="reports-from">From</label>
            <input
              id="reports-from"
              type="date"
              className="form-input"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              max={toDate || undefined}
            />
          </div>
          <div className="form-group" style={{ flex: '1 1 140px', minWidth: 140 }}>
            <label htmlFor="reports-to">To</label>
            <input
              id="reports-to"
              type="date"
              className="form-input"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              min={fromDate || undefined}
            />
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center', marginTop: '0.6rem' }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--steel)', marginRight: '0.25rem' }}>Type:</span>
          {PROJECT_REPORT_TYPES.map((t) => {
            const active = activeTypes.includes(t);
            return (
              <button
                key={t}
                type="button"
                aria-pressed={active}
                onClick={() => toggleType(t)}
                style={{
                  fontSize: '0.72rem',
                  fontWeight: 600,
                  padding: '0.2rem 0.6rem',
                  borderRadius: 999,
                  border: '1px solid ' + (active ? 'var(--brand, #0066ff)' : '#cbd5e1'),
                  background: active ? 'rgba(0, 102, 255, 0.08)' : 'white',
                  color: active ? 'var(--brand, #0066ff)' : 'var(--steel, #64748b)',
                  cursor: 'pointer',
                }}
              >
                {PROJECT_REPORT_TYPE_LABELS[t]?.short || t}
              </button>
            );
          })}
          {anyFilterActive && (
            <button
              type="button"
              onClick={clearAllFilters}
              style={{
                marginLeft: 'auto',
                fontSize: '0.72rem',
                padding: '0.2rem 0.6rem',
                borderRadius: 999,
                border: '1px solid #cbd5e1',
                background: 'white',
                color: 'var(--steel, #64748b)',
                cursor: 'pointer',
              }}
            >
              Clear filters
            </button>
          )}
        </div>
        {/* [DocumentCategory] Subject-matter chip filter row. Sits
            BELOW the type chips so the cadence filter stays visually
            primary, matching the upload form's order. Uses the shared
            FilterChip (lifted in round-43) so the admin chip row +
            the employee MyProjectReports chip row + the upload
            chip row render identical pills. Mutually exclusive: one
            category at a time, since the admin toolbar already has 4
            dropdown filters above. */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center', marginTop: '0.4rem' }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--steel)', marginRight: '0.25rem' }}>Category:</span>
          <FilterChip
            label="All"
            active={filterCategory === ''}
            onClick={() => setFilterCategory('')}
          />
          {DOCUMENT_CATEGORIES.map((c) => (
            <FilterChip
              key={c}
              label={DOCUMENT_CATEGORY_LABELS[c]?.short || c}
              active={filterCategory === c}
              onClick={() => setFilterCategory(filterCategory === c ? '' : c)}
            />
          ))}
        </div>
      </div>

      {error && (
        <div className="portal-auth-error" role="alert" style={{ marginBottom: '1rem' }}>
          {error}
        </div>
      )}

      {/* ─── States ────────────────────────────────────────────────────── */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--steel)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>⏳</div>
          Loading reports...
        </div>
      ) : reports.length === 0 ? (
        <div className="dpr-list-empty">
          <div style={{ marginBottom: '1rem', color: 'var(--steel)', fontSize: '2rem' }}>📄</div>
          <h3 style={{ color: 'var(--navy)', marginBottom: '0.5rem' }}>
            {anyFilterActive ? 'No reports match the current filters' : 'No reports uploaded yet'}
          </h3>
          <p style={{ color: 'var(--steel)' }}>
            {anyFilterActive
              ? 'Try widening the date range or clearing the project / uploader filter.'
              : 'Reports uploaded from the My Projects accordion will appear here.'}
          </p>
        </div>
      ) : (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))',
              gap: '0.75rem',
            }}
          >
            {reports.map((r) => {
              const badgeStyle = REPORT_TYPE_BADGE_STYLES[r.type] || REPORT_TYPE_BADGE_STYLES.OTHER;
              // [DR-010] r.status is required on every row now — the
              // backend serializer always emits it (NOT NULL enum column
              // with a default of PENDING_REVIEW). Drop the silent
              // fallback so a missing status surfaces as an obvious
              // missing-data case ("Status unavailable") instead of a
              // fake "Pending Review" that hides the bug.
              const rStatus = r.status;
              const rStatusMissing = !rStatus;
              const canApprove = APPROVE_ALLOWED_FROM.has(rStatus);
              const canRevise = REVISE_ALLOWED_FROM.has(rStatus);
              const canReject = REJECT_ALLOWED_FROM.has(rStatus);
              const showReviewBar = isAdmin && (canApprove || canRevise || canReject);
              const rNotes = reviewNotesById[r.id] || '';
              const statusPalette = STATUS_COLOR[rStatus] || STATUS_COLOR.PENDING_REVIEW;
              return (
                <div
                  key={r.id}
                  className="dpr-card"
                  style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}
                >
                  {/* Header: type badge + project name */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <div style={{ minWidth: 0 }}>
                      <span
                        style={{
                          fontSize: '0.65rem',
                          fontWeight: 700,
                          background: badgeStyle.background,
                          color: badgeStyle.color,
                          padding: '2px 8px',
                          borderRadius: 999,
                          textTransform: 'uppercase',
                          letterSpacing: '0.04em',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {PROJECT_REPORT_TYPE_LABELS[r.type]?.short || r.type}
                      </span>
                      {/* [DocumentCategory] Per-card category badge.
                          Rendered on a new line under the type badge
                          so the two classifiers don't compete for
                          horizontal space inside the card header.
                          Legacy rows (category=null) get no badge,
                          keeping the visual surface unchanged for
                          pre-migration uploads. The purple tint
                          deliberately differs from every REPORT_TYPE
                          badge above so the category classifier
                          stays distinguishable at a glance. */}
                      {r.category && (
                        <div style={{ marginTop: '0.25rem' }}>
                          <span
                            title={DOCUMENT_CATEGORY_LABELS[r.category]?.label || r.category}
                            style={{
                              fontSize: '0.65rem',
                              fontWeight: 700,
                              background: '#ede9fe',
                              color: '#5b21b6',
                              padding: '2px 8px',
                              borderRadius: 999,
                              textTransform: 'uppercase',
                              letterSpacing: '0.04em',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {DOCUMENT_CATEGORY_LABELS[r.category]?.short || r.category}
                          </span>
                        </div>
                      )}
                      <div style={{ marginTop: '0.4rem', color: 'var(--navy)', fontWeight: 600, fontSize: '0.95rem' }}>
                        {r.project?.name || 'Unknown project'}
                        {r.project?.code ? <span style={{ color: 'var(--steel)', fontWeight: 400 }}> ({r.project.code})</span> : null}
                      </div>
                    </div>
                    {/* Status pill (visible to admin) */}
                    <span
                      style={{
                        fontSize: '0.65rem',
                        fontWeight: 700,
                        background: statusPalette.bg,
                        color: statusPalette.fg,
                        padding: '2px 8px',
                        borderRadius: 999,
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {/* [DR-010] explicit missing-data label rather than
                          a silent fallback to "Pending Review" — if the
                          server ever drops `status` from the DTO, we
                          want to see the bug, not invent a state. */}
                      {rStatusMissing
                        ? 'Status unavailable'
                        : (STATUS_LABEL[rStatus] || rStatus)}
                    </span>
                  </div>

                  {/* Title or filename */}
                  <div
                    style={{
                      fontSize: '0.85rem',
                      color: 'var(--navy)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={r.title || r.filename}
                  >
                    {r.title || r.filename}
                  </div>

                  {/* Meta: size + uploader + date */}
                  <div style={{ fontSize: '0.75rem', color: 'var(--steel)', display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                    <span title={`${formatBytes(r.sizeBytes)}`}>📎 {formatBytes(r.sizeBytes)}</span>
                    <span title={r.uploadedBy?.name || r.uploadedById}>
                      👤 {r.uploadedBy?.name || (r.uploadedById ? r.uploadedById.slice(0, 8) : '—')}
                    </span>
                    <span>📅 {formatDate(r.uploadedAt)}</span>
                  </div>

                  {/* Review notes (if any) — visible to admin so the
                      reviewer can see what was already sent back.
                      [DR-010] also renders "by <reviewer name>" so a
                      freshly-approved reload doesn't read as anonymous
                      — the backend now joins `reviewedBy` and the SPA
                      uses it. */}
                  {(r.reviewNotes || r.reviewedAt) && (
                    <div
                      style={{
                        fontSize: '0.75rem',
                        color: 'var(--steel)',
                        fontStyle: 'italic',
                        overflowWrap: 'anywhere',
                      }}
                      title={r.reviewNotes || ''}
                    >
                      {r.reviewedAt && `Reviewed ${formatDate(r.reviewedAt)}`}
                      {r.reviewedBy?.name && ` by ${r.reviewedBy.name}`}
                      {r.reviewNotes && ` · “${r.reviewNotes.length > 100 ? `${r.reviewNotes.slice(0, 100)}…` : r.reviewNotes}”`}
                    </div>
                  )}

                  {/* [S7 round-2] Admin-only review action bar — mirrors
                      the MyProjectReports pattern. Gate: isAdmin AND any
                      allowed-from set has the row status. */}
                  {showReviewBar && (
                    <div
                      role="toolbar"
                      aria-label="Admin review actions"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.35rem',
                        flexWrap: 'wrap',
                        paddingTop: '0.4rem',
                        borderTop: '1px dashed #e2e8f0',
                      }}
                    >
                      {canApprove && (
                        <button
                          type="button"
                          className="btn btn-success btn-sm"
                          disabled={actionBusy}
                          onClick={() => runReviewAction(r, 'APPROVED')}
                        >
                          ✓ Approve
                        </button>
                      )}
                      {(canRevise || canReject) && (
                        <input
                          type="text"
                          value={rNotes}
                          onChange={(e) => setReviewNotesById((prev) => ({ ...prev, [r.id]: e.target.value }))}
                          placeholder={canRevise ? 'Reason for revision (required)' : 'Reject reason (required)'}
                          maxLength={2000}
                          aria-label="Review notes"
                          disabled={actionBusy}
                          style={{
                            flex: '1 1 160px',
                            minWidth: 0,
                            padding: '0.3rem 0.5rem',
                            fontSize: '0.75rem',
                            border: '1px solid #cbd5e1',
                            borderRadius: 4,
                          }}
                        />
                      )}
                      {canRevise && (
                        <button
                          type="button"
                          className="btn btn-warning btn-sm"
                          disabled={actionBusy || !rNotes.trim()}
                          onClick={() => runReviewAction(r, 'REVISION_REQUESTED')}
                          title={!rNotes.trim() ? 'Enter a reason to enable Request revision' : 'Send back to uploader for revision'}
                        >
                          ↺ Revision
                        </button>
                      )}
                      {canReject && (
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          disabled={actionBusy || !rNotes.trim()}
                          onClick={() => runReviewAction(r, 'REJECTED')}
                          title={!rNotes.trim() ? 'Enter a reason to enable Reject' : 'Reject this report'}
                        >
                          ✗ Reject
                        </button>
                      )}
                    </div>
                  )}

                  {/* Actions */}
                  <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'flex-end', marginTop: '0.25rem' }}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => handleDownload(r)}
                      aria-label={`Download ${r.filename}`}
                    >
                      Download
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => startReplaceFile(r)}
                      disabled={replaceBusyId === r.id || (replaceBusyId !== null && replaceBusyId !== r.id)}
                      aria-label={`Replace file for ${r.filename}`}
                      title="Re-upload a new file in place — use this if Download returned BLOB_GONE"
                    >
                      {replaceBusyId === r.id ? 'Uploading…' : 'Replace'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ color: 'var(--danger)' }}
                      onClick={() => setConfirmDelete(r)}
                      aria-label={`Archive ${r.filename}`}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ textAlign: 'center', color: 'var(--steel)', fontSize: '0.8rem', padding: '0.75rem' }}>
            Showing {reports.length} of {total} report{total !== 1 ? 's' : ''}
          </div>

          {nextCursor && (
            <div style={{ textAlign: 'center', paddingBottom: '1rem' }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => fetchReports({ append: true, cursor: nextCursor })}
                disabled={loadingMore}
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}

      {/* ─── Delete confirmation ──────────────────────────────────────── */}
      {confirmDelete && (
        <div
          role="alertdialog"
          aria-labelledby="archive-report-title"
          aria-describedby="archive-report-desc"
          style={{
            position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 100, padding: '1rem',
          }}
          onClick={(e) => { if (e.target === e.currentTarget && !deleting) setConfirmDelete(null); }}
        >
          <div
            style={{
              background: '#fff', borderRadius: 12, maxWidth: 420, width: '100%',
              padding: '1.5rem', boxShadow: '0 20px 60px rgba(15,23,42,0.3)',
            }}
          >
            <h2 id="archive-report-title" style={{ margin: '0 0 0.5rem', color: 'var(--navy)' }}>
              Archive report?
            </h2>
            <p id="archive-report-desc" style={{ margin: '0 0 1rem', fontSize: '0.9rem', color: 'var(--steel)' }}>
              <strong>{confirmDelete.title || confirmDelete.filename}</strong>
              {' — '}{confirmDelete.project?.name || 'unknown project'}
            </p>
            <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: 'var(--steel)' }}>
              Soft-delete only — the row is hidden from this list but stays in the
              database for audit. Admins can restore via the database if needed.
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirmDelete(null)} disabled={deleting}>
                Cancel
              </button>
              <button
                type="button"
                className="btn"
                style={{ background: 'var(--danger)', color: 'white', border: 'none' }}
                disabled={deleting}
                onClick={handleDelete}
              >
                {deleting ? 'Archiving…' : 'Archive'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
