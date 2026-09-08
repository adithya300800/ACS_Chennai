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

import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { formatShortDate, formatBytes } from '../../lib/format.js';
import {
  PROJECT_REPORT_TYPES,
  PROJECT_REPORT_TYPE_LABELS,
} from '../../lib/constants.js';

// Color-coded type badges — 5 enum values, each gets a distinct bg/text
// pair so the admin can scan the card grid by hue.
const REPORT_TYPE_BADGE_STYLES = {
  WEEKLY_REPORT:        { background: '#dbeafe', color: '#1e40af' }, // blue
  MONTHLY_REPORT:       { background: '#dcfce7', color: '#166534' }, // green
  DUE_DILIGENCE_REPORT: { background: '#fef3c7', color: '#92400e' }, // amber
  QUALITY_REPORT:       { background: '#ede9fe', color: '#5b21b6' }, // purple
  OTHER:                { background: '#f1f5f9', color: '#475569' }, // slate
};

const DEFAULT_LIMIT = 50;

function formatDate(value) {
  if (!value) return '—';
  const out = formatShortDate(value);
  return out || String(value);
}

export default function ReportsAdmin() {
  useDocumentTitle('Project Reports');
  const { accessToken } = useAuth();
  const toast = useToast();

  // Filter state.
  const [projects, setProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectId, setProjectId] = useState('');          // '' = all
  const [activeTypes, setActiveTypes] = useState([]);        // [] = all
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
  }, [projectId, activeTypes, uploadedById, fromDate, toDate, accessToken]);

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
    setUploadedById('');
    setFromDate('');
    setToDate('');
  }
  const anyFilterActive = projectId || activeTypes.length > 0 || uploadedById || fromDate || toDate;

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

  return (
    <div className="dpr-page">
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
                      <div style={{ marginTop: '0.4rem', color: 'var(--navy)', fontWeight: 600, fontSize: '0.95rem' }}>
                        {r.project?.name || 'Unknown project'}
                        {r.project?.code ? <span style={{ color: 'var(--steel)', fontWeight: 400 }}> ({r.project.code})</span> : null}
                      </div>
                    </div>
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
