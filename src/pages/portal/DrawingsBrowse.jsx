// N3-employee — Drawing Revision Register, employee-facing browse view.
//
// Read-only mirror of the admin DrawingsAdmin page. Employees (non-admin
// users) need to see which drawing revisions are active for the projects
// they're working on, so they can stamp their DPR / Inspection rows
// against the right revision (the DrawingPicker on the submit screens
// only shows ACTIVE rows by default). Admins still have the full CRUD
// at /portal/admin/drawings — this page is the lightweight
// browse/preview surface for field engineers.
//
// Differences from DrawingsAdmin:
//   - No "+ New drawing" button (admin-curated only).
//   - No "Supersede" / "Archive" per-card actions.
//   - Status filter is locked to ACTIVE (employees don't curate history).
//   - Project picker reads from /api/projects?isActive=true (no discovered).
//   - Deep-link: ?projectId=<uuid> pre-selects a project so a click
//     from ProjectDetail's "Drawings" tab lands directly on the list.
//
// Auth: backend GET /api/drawings is requireAuth (all employees) so
// no client-side gating is needed beyond the ProtectedRoute wrapper.

import React, { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { formatShortDate } from '../../lib/format.js';

// Shared status map with DrawingsAdmin so a row's badge color matches
// across the admin and employee views.
const DRAWING_STATUS_MAP = {
  ACTIVE: 'dpr-status-approved',
  SUPERSEDED: 'dpr-status-rejected',
};

function formatDate(value) {
  if (!value) return '—';
  const out = formatShortDate(value);
  return out || String(value);
}

export default function DrawingsBrowse() {
  useDocumentTitle('My Drawings');
  const { accessToken } = useAuth();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [projects, setProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(true);

  // `projectId` is driven by the URL — `?projectId=<uuid>` from
  // ProjectDetail's "Drawings" tab, or a dropdown change. When the
  // dropdown changes, the URL is updated so the link is shareable.
  const urlProjectId = searchParams.get('projectId') || '';
  const [projectId, setProjectId] = useState(urlProjectId);

  const [drawings, setDrawings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [nextCursor, setNextCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Load curated (active) projects on mount. The admin page filters to
  // isActive too; an employee with no active projects just sees the
  // empty state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getProjects(accessToken);
        if (cancelled) return;
        const list = (data?.projects || []).filter((p) => p.isActive);
        setProjects(list);
        // Pick a default project: URL-supplied first, else the first
        // active one. This keeps the page non-empty for any employee
        // who has at least one project.
        setProjectId((prev) => {
          if (prev && list.some((p) => p.id === prev)) return prev;
          const fromUrl = list.some((p) => p.id === urlProjectId) ? urlProjectId : '';
          return fromUrl || (list.length > 0 ? list[0].id : '');
        });
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load projects');
      } finally {
        if (!cancelled) setProjectsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [accessToken, urlProjectId]);

  // Sync URL when the dropdown changes so the page is shareable.
  const handleProjectChange = (next) => {
    setProjectId(next);
    const sp = new URLSearchParams(searchParams);
    if (next) sp.set('projectId', next);
    else sp.delete('projectId');
    setSearchParams(sp, { replace: true });
  };

  const fetchDrawings = useCallback(async ({ append = false, cursor = null } = {}) => {
    if (!projectId) return;
    if (append) setLoadingMore(true); else setLoading(true);
    setError('');
    try {
      // ACTIVE-only — employees browse the active set, not the
      // supersede history. If they need to inspect a superseded
      // revision (e.g. via a deep link), the detail page still
      // renders the full record + chain.
      const params = {
        projectId,
        status: 'ACTIVE',
        limit: '100',
      };
      if (cursor) params.cursor = cursor;
      const data = await api.getDrawings(params, accessToken);
      const items = data?.drawings || [];
      setDrawings((prev) => (append ? [...prev, ...items] : items));
      setNextCursor(data?.nextCursor || null);
    } catch (err) {
      setError(err?.message || 'Failed to load drawings');
      if (!append) {
        setDrawings([]);
        setNextCursor(null);
      }
    } finally {
      if (append) setLoadingMore(false); else setLoading(false);
    }
  }, [projectId, accessToken]);

  useEffect(() => {
    fetchDrawings();
  }, [fetchDrawings]);

  return (
    <div className="dpr-page">
      <div className="dpr-page-header">
        <div>
          <Breadcrumb
            items={[
              { label: 'My Drawings' },
            ]}
          />
          <h1 className="dpr-page-title">My Drawings</h1>
          <p style={{ color: 'var(--steel)', fontSize: '0.9rem', margin: 0 }}>
            Active drawing revisions for your projects. Pick a project to
            see the latest revision of every drawing; click a card to
            preview the PDF and see the supersedes chain.
          </p>
        </div>
      </div>

      {/* Filter toolbar — project only, ACTIVE-only. */}
      <div className="dpr-card" style={{ marginBottom: '1rem' }}>
        <div className="form-row" style={{ alignItems: 'flex-end' }}>
          <div className="form-group" style={{ flex: 2 }}>
            <label htmlFor="drawings-browse-project">Project *</label>
            <select
              id="drawings-browse-project"
              className="form-input"
              value={projectId}
              onChange={(e) => handleProjectChange(e.target.value)}
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
        </div>
        {!projectsLoading && projects.length === 0 && (
          <p style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--steel)' }}>
            An admin needs to register a project before drawings can be browsed.
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
          Loading drawings…
        </div>
      ) : drawings.length === 0 ? (
        <div className="dpr-list-empty">
          <div style={{ marginBottom: '1rem', color: 'var(--steel)', fontSize: '2rem' }}>📐</div>
          <h3 style={{ color: 'var(--navy)', marginBottom: '0.5rem' }}>
            No active drawings for this project
          </h3>
          <p style={{ color: 'var(--steel)', maxWidth: 420, margin: '0 auto' }}>
            Once an admin uploads a drawing revision, it'll show up here.
            Ask your project manager to add one if you need a reference
            to stamp your DPR or Inspection record against.
          </p>
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
              <Link
                key={d.id}
                to={`/portal/drawings/${d.id}`}
                className="dpr-card"
                style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', textDecoration: 'none', color: 'inherit' }}
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
              </Link>
            ))}
          </div>

          <div style={{ textAlign: 'center', color: 'var(--steel)', fontSize: '0.8rem', padding: '0.75rem' }}>
            Showing {drawings.length} active drawing revision{drawings.length !== 1 ? 's' : ''}
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
    </div>
  );
}
