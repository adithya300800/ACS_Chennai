// N3 (Phase F) — Drawing Revision Register admin page.
//
// Lists every drawing revision for the selected project, ordered by
// (issuedDate DESC, id DESC). Cards mirror the BoqAdmin row layout so
// admins get a consistent visual vocabulary between the two registries:
// drawing number + revision + title + status badge + issued date +
// reference count.
//
// Filters:
//   - project (dropdown, required — backend refuses without a projectId).
//   - status  (ACTIVE | SUPERSEDED | ALL).
//   - cursor pagination: loadMore appends the next page; the backend
//     caps each page at 100.
//
// Actions:
//   - + New drawing → opens DrawingFormModal in create mode.
//   - Per-card actions:
//       • View       → /portal/admin/drawings/:id (DrawingDetail).
//       • Supersede  → opens DrawingFormModal in supersede mode
//                      (atomic flip of the predecessor to SUPERSEDED).
//       • Delete     → soft-delete via /api/drawings/:id (status flips
//                      to SUPERSEDED; idempotent on the server).
//
// UX notes
// ────────
//   - project list comes from /api/projects (curated + active). We use
//     just `projects` (not `discovered`) because the backend's drawing
//     POST requires a projectId that exists in the curated table.
//   - The "+ New drawing" button is disabled until a project is
//     selected — same UX rule as the BOQ page (see BoqAdmin.jsx).
//   - Supersede is wired to the same modal as Create; the modal
//     switches into supersede mode when `supersedes` is supplied.

import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';
import DrawingFormModal from '../../components/DrawingFormModal.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { formatShortDate } from '../../lib/format.js';

const STATUS_OPTIONS = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'SUPERSEDED', label: 'Superseded' },
  { value: 'ALL', label: 'All' },
];

const DRAWING_STATUS_MAP = {
  ACTIVE: 'dpr-status-approved',
  SUPERSEDED: 'dpr-status-rejected',
};

function formatDate(value) {
  if (!value) return '—';
  const out = formatShortDate(value);
  return out || String(value);
}

export default function DrawingsAdmin() {
  useDocumentTitle('Drawings Register');
  const { accessToken } = useAuth();
  const toast = useToast();

  const [projects, setProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(true);

  const [projectId, setProjectId] = useState('');
  const [statusFilter, setStatusFilter] = useState('ACTIVE');

  const [drawings, setDrawings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [nextCursor, setNextCursor] = useState(null);

  const [formOpen, setFormOpen] = useState(false);
  const [supersede, setSupersede] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  // Load curated (active) projects on mount. Drawing creation requires
  // a curated projectId, so we ignore the `discovered` auto-names from
  // /api/projects. If a user opens the page on a fresh account with no
  // registered projects, the project dropdown will be empty + the page
  // surfaces a "Register a project first" hint.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getProjects(accessToken);
        if (cancelled) return;
        const list = (data?.projects || []).filter((p) => p.isActive);
        setProjects(list);
        // Default to the first active project so the page is never
        // empty for an account that has at least one project.
        if (list.length > 0) setProjectId((prev) => prev || list[0].id);
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load projects');
      } finally {
        if (!cancelled) setProjectsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [accessToken]);

  const fetchDrawings = useCallback(async ({ append = false, cursor = null } = {}) => {
    if (!projectId) return;
    if (append) setLoadingMore(true); else setLoading(true);
    setError('');
    try {
      const params = {
        projectId,
        status: statusFilter,
        limit: '100',
      };
      if (cursor) params.cursor = cursor;
      const data = await api.getDrawings(params, accessToken);
      const items = data?.drawings || [];
      setDrawings((prev) => (append ? [...prev, ...items] : items));
      setNextCursor(data?.nextCursor || null);
    } catch (err) {
      setError(err?.message || 'Failed to load drawings');
      if (!append) setDrawings([]);
      setNextCursor(null);
    } finally {
      if (append) setLoadingMore(false); else setLoading(false);
    }
  }, [projectId, statusFilter, accessToken]);

  useEffect(() => {
    fetchDrawings();
  }, [fetchDrawings]);

  const handleCreate = () => {
    if (!projectId) {
      toast.push('Select a project first.', 'warning');
      return;
    }
    setSupersede(null);
    setFormOpen(true);
  };

  const handleSupersede = (drawing) => {
    if (!projectId) return;
    setSupersede(drawing);
    setFormOpen(true);
  };

  const handleSave = async (payload) => {
    if (supersede) {
      await api.createDrawing(payload, accessToken);
      toast.push(
        `Created new revision and superseded ${supersede.drawingNumber} Rev ${supersede.revision}.`,
        'success',
      );
    } else {
      await api.createDrawing(payload, accessToken);
      toast.push('Drawing created.', 'success');
    }
    setFormOpen(false);
    setSupersede(null);
    // After a supersede, the predecessor flips to SUPERSEDED so it
    // disappears from the default ACTIVE view. Switch to ALL briefly
    // so the admin sees both rows, or stay on ACTIVE and let the
    // next visit show only the new revision. We stay on the current
    // filter and refetch — the predecessor only disappears when the
    // admin's filter is ACTIVE, which matches their mental model.
    await fetchDrawings();
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await api.softDeleteDrawing(confirmDelete.id, accessToken);
      toast.push(`Drawing ${confirmDelete.drawingNumber} Rev ${confirmDelete.revision} archived.`, 'success');
      setConfirmDelete(null);
      await fetchDrawings();
    } catch (err) {
      toast.push(err?.message || 'Failed to archive drawing', 'error');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="dpr-page">
      <div className="dpr-page-header">
        <div>
          <Breadcrumb
            items={[
              { label: 'Admin Overview', to: '/portal/admin' },
              { label: 'Drawings Register' },
            ]}
          />
          <h1 className="dpr-page-title">Drawings Register</h1>
          <p style={{ color: 'var(--steel)', fontSize: '0.9rem', margin: 0 }}>
            Curated drawing revisions per project. Stamp DPRs and
            Inspections against a specific revision so future revisions
            can supersede without orphaning the historical record.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            className="btn btn-primary"
            onClick={handleCreate}
            disabled={!projectId}
            aria-label="Add drawing"
          >
            + New drawing
          </button>
        </div>
      </div>

      {/* Filter toolbar */}
      <div className="dpr-card" style={{ marginBottom: '1rem' }}>
        <div className="form-row" style={{ alignItems: 'flex-end' }}>
          <div className="form-group" style={{ flex: 2 }}>
            <label htmlFor="drawings-project">Project *</label>
            <select
              id="drawings-project"
              className="form-input"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              disabled={projectsLoading || projects.length === 0}
            >
              {projectsLoading && <option value="">Loading projects…</option>}
              {!projectsLoading && projects.length === 0 && (
                <option value="">No projects registered yet</option>
              )}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.code ? ` (${p.code})` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group" style={{ flex: 1 }}>
            <label htmlFor="drawings-status">Status</label>
            <select
              id="drawings-status"
              className="form-input"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              disabled={!projectId}
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
        </div>
        {!projectsLoading && projects.length === 0 && (
          <p style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--steel)' }}>
            <Link to="/portal/admin/projects/new">Register a project</Link>
            {' '}before adding drawings.
          </p>
        )}
      </div>

      {error && (
        <div className="portal-auth-error" role="alert" style={{ marginBottom: '1rem' }}>
          {error}
        </div>
      )}

      {!projectId ? null : loading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--steel)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>⏳</div>
          Loading drawings...
        </div>
      ) : drawings.length === 0 ? (
        <div className="dpr-list-empty">
          <div style={{ marginBottom: '1rem', color: 'var(--steel)', fontSize: '2rem' }}>📐</div>
          <h3 style={{ color: 'var(--navy)', marginBottom: '0.5rem' }}>
            No drawings {statusFilter === 'ALL' ? '' : `(${statusFilter.toLowerCase()}) `}for this project
          </h3>
          <p style={{ color: 'var(--steel)', marginBottom: '1.5rem' }}>
            Upload the first revision to start stamping DPRs and Inspections against it.
          </p>
          <button className="btn btn-primary" onClick={handleCreate} disabled={!projectId}>
            + New drawing
          </button>
        </div>
      ) : (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: '0.75rem',
            }}
          >
            {drawings.map((d) => (
              <div
                key={d.id}
                className="dpr-card"
                style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, color: 'var(--navy)', fontFamily: 'monospace', fontSize: '0.95rem' }}>
                        {d.drawingNumber}
                      </span>
                      <span style={{ fontSize: '0.85rem', color: 'var(--steel)' }}>
                        Rev {d.revision}
                      </span>
                    </div>
                    {d.title && (
                      <div style={{ fontSize: '0.85rem', color: 'var(--steel)', marginTop: '0.15rem' }}>
                        {d.title}
                      </div>
                    )}
                  </div>
                  <StatusBadge status={d.status} map={DRAWING_STATUS_MAP} />
                </div>

                <div style={{ fontSize: '0.8rem', color: 'var(--steel)', display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                  <span>📅 Issued {formatDate(d.issuedDate)}</span>
                  <span title="Number of DPRs + Inspections that reference this drawing revision">
                    📌 {d.referencedByCount ?? 0} reference{d.referencedByCount === 1 ? '' : 's'}
                  </span>
                </div>

                <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'flex-end', marginTop: '0.25rem' }}>
                  <Link
                    to={`/portal/admin/drawings/${d.id}`}
                    className="btn btn-ghost btn-sm"
                  >
                    View
                  </Link>
                  {d.status === 'ACTIVE' && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => handleSupersede(d)}
                      aria-label={`Supersede ${d.drawingNumber} Rev ${d.revision}`}
                    >
                      Supersede
                    </button>
                  )}
                  {d.status !== 'SUPERSEDED' && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ color: 'var(--danger)' }}
                      onClick={() => setConfirmDelete(d)}
                      aria-label={`Archive ${d.drawingNumber} Rev ${d.revision}`}
                    >
                      Archive
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div style={{ textAlign: 'center', color: 'var(--steel)', fontSize: '0.8rem', padding: '0.75rem' }}>
            Showing {drawings.length} drawing revision{drawings.length !== 1 ? 's' : ''}
          </div>

          {nextCursor && (
            <div style={{ textAlign: 'center', paddingBottom: '1rem' }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => fetchDrawings({ append: true, cursor: nextCursor })}
                disabled={loadingMore}
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}

      <DrawingFormModal
        open={formOpen}
        onClose={() => { setFormOpen(false); setSupersede(null); }}
        onSave={handleSave}
        accessToken={accessToken}
        projects={projects}
        supersedes={supersede}
      />

      {confirmDelete && (
        <div
          role="alertdialog"
          aria-labelledby="archive-drawing-title"
          aria-describedby="archive-drawing-desc"
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
            <h2 id="archive-drawing-title" style={{ margin: '0 0 0.5rem', color: 'var(--navy)' }}>
              Archive drawing?
            </h2>
            <p id="archive-drawing-desc" style={{ margin: '0 0 1rem', fontSize: '0.9rem', color: 'var(--steel)' }}>
              <strong>{confirmDelete.drawingNumber} Rev {confirmDelete.revision}</strong>
              {confirmDelete.title ? ` — ${confirmDelete.title}` : ''}
            </p>
            <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: 'var(--steel)' }}>
              Linked DPRs and Inspection Records keep their reference (soft-delete
              only — the row is hidden from this list but stays in the database
              for audit).
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