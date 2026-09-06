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
// [Round-30] Project picker changed from a static <select> to a
// typeahead input. Two reasons:
//   1. Scope narrowing — the picker now reads /api/projects?scope=assigned
//      so a field engineer only sees projects they've personally touched
//      (filed a DPR/Inspection/BoqItem/Variation/Drawing against) or
//      created. The previous default `?scope=mine` returned the full
//      org-wide curated list, exposing admin test rigs / contracts the
//      employee has no business knowing about.
//   2. Typed-name entry — the input lets the employee type a project
//      name to find it, and resolves unknown names via the existing
//      /api/projects/resolve endpoint (same auto-discovery flow
//      DprSubmit/InspectionSubmit already use). If the typed name
//      doesn't exist yet, a new Project row is created with
//      createdById=req.employeeId, so it stays in their picker on next
//      load (the assigned scope includes createdById matches).
//
// URL shape:
//   ?projectId=<uuid>    selected project (existing — still honored for
//                        deep links from ProjectDetail's Drawings tab)
//   ?q=<typed query>     shareable search state (debounced 200ms)
//
// Differences from DrawingsAdmin:
//   - No "+ New drawing" button (admin-curated only).
//   - No "Supersede" / "Archive" per-card actions.
//   - Status filter is locked to ACTIVE (employees don't curate history).
//   - Project picker reads from /api/projects?scope=assigned (curated
//     list narrowed to the employee's touched set + their created set).
//   - No static <select> — typeahead input instead, with a "Find or
//     create '<name>'" affordance that surfaces when the typed name
//     isn't an exact match for any existing project.
//
// Auth: backend GET /api/drawings is requireAuth (all employees) so
// no client-side gating is needed beyond the ProtectedRoute wrapper.

import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  const [projectsError, setProjectsError] = useState('');

  // `projectId` is driven by the URL — `?projectId=<uuid>` from
  // ProjectDetail's "Drawings" tab, or a click on a typeahead result.
  const urlProjectId = searchParams.get('projectId') || '';
  const [projectId, setProjectId] = useState(urlProjectId);

  // ── Typeahead state ───────────────────────────────────────────────────
  // `query` mirrors the input. We debounce 200ms before writing to the
  // URL so the history doesn't churn while the user is typing.
  const urlQuery = searchParams.get('q') || '';
  const [query, setQuery] = useState(urlQuery);
  const [resolveBusy, setResolveBusy] = useState(false);
  const [resolveError, setResolveError] = useState('');
  // Projects added by resolveProject that weren't in the initial
  // /scope=assigned fetch (e.g. brand-new projects the employee just
  // created). Keep them in local state so the picker remembers them
  // for the rest of the session.
  const [extraProjects, setExtraProjects] = useState([]);
  const queryDebounceRef = useRef(null);

  const [drawings, setDrawings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [nextCursor, setNextCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Load curated (active) projects on mount, scoped to the employee's
  // touched/created set. The previous default `?scope=mine` returned
  // the full org-wide curated list — switching to `?scope=assigned`
  // (round-30) narrows the picker to projects the employee actually
  // has context on.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getProjects({ scope: 'assigned' }, accessToken);
        if (cancelled) return;
        const list = (data?.projects || []).filter((p) => p.isActive);
        setProjects(list);
        // Pick a default project: URL-supplied first, else the first
        // active one. This keeps the page non-empty for any employee
        // who has at least one assigned project.
        setProjectId((prev) => {
          if (prev && list.some((p) => p.id === prev)) return prev;
          const fromUrl = list.some((p) => p.id === urlProjectId) ? urlProjectId : '';
          return fromUrl || (list.length > 0 ? list[0].id : '');
        });
      } catch (err) {
        if (!cancelled) setProjectsError(err?.message || 'Failed to load projects');
      } finally {
        if (!cancelled) setProjectsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [accessToken, urlProjectId]);

  // Sync the typed query to the URL (debounced 200ms) so the picker
  // state is shareable like ?projectId= already is.
  useEffect(() => {
    if (queryDebounceRef.current) clearTimeout(queryDebounceRef.current);
    queryDebounceRef.current = setTimeout(() => {
      const sp = new URLSearchParams(searchParams);
      if (query) sp.set('q', query); else sp.delete('q');
      const currentQ = searchParams.get('q') || '';
      if (currentQ !== query) {
        setSearchParams(sp, { replace: true });
      }
    }, 200);
    return () => {
      if (queryDebounceRef.current) clearTimeout(queryDebounceRef.current);
    };
  }, [query, searchParams, setSearchParams]);

  // ── Filter logic — typeahead ─────────────────────────────────────────
  // Hoisted BEFORE the keyboard handler so its dependency array
  // ([query, filtered, ...]) can read `filtered` at useCallback-call
  // time. (Earlier order put the handler first and crashed at render
  // with a temporal-dead-zone error: "Cannot access 'filtered' before
  // initialization".)
  const allProjects = [...projects, ...extraProjects];
  const trimmed = query.trim();
  const filtered = trimmed.length > 0
    ? allProjects.filter((p) => {
        const name = (p.name || '').toLowerCase();
        const code = (p.code || '').toLowerCase();
        const q = trimmed.toLowerCase();
        return name.includes(q) || code.includes(q);
      })
    : allProjects;
  const exactMatch = trimmed.length > 0 && allProjects.some(
    (p) => (p.name || '').toLowerCase() === trimmed.toLowerCase()
  );

  // ── Selection handler — click on a typeahead result ──────────────────
  const handleSelectProject = useCallback((next) => {
    setProjectId(next);
    setQuery('');
    setResolveError('');
    const sp = new URLSearchParams(searchParams);
    if (next) sp.set('projectId', next); else sp.delete('projectId');
    sp.delete('q');
    setSearchParams(sp, { replace: true });
  }, [searchParams, setSearchParams]);

  // ── Resolve a typed name to a real Project row ───────────────────────
  // Calls POST /api/projects/resolve: returns the existing Project if
  // the name matches (case-insensitive), or creates one with
  // createdById=req.employeeId. 409 PROJECT_INACTIVE if archived.
  const handleResolveTyped = useCallback(async () => {
    const name = query.trim();
    if (!name || resolveBusy) return;
    setResolveBusy(true);
    setResolveError('');
    try {
      const proj = await api.resolveProject(name, accessToken);
      // Add to local state so the picker remembers this project for
      // the rest of the session (the next /scope=assigned fetch
      // won't return it until the employee files a child record
      // against it — but Project.createdById=req.employeeId will
      // include it from then on).
      setExtraProjects((prev) => {
        if (prev.some((p) => p.id === proj.id)) return prev;
        return [...prev, proj];
      });
      handleSelectProject(proj.id);
    } catch (err) {
      const code = err?.code;
      if (code === 'PROJECT_INACTIVE') {
        setResolveError(`"${name}" is archived. Ask an admin to reactivate it.`);
      } else {
        setResolveError(err?.message || `Couldn't find or create "${name}".`);
      }
    } finally {
      setResolveBusy(false);
    }
  }, [query, resolveBusy, accessToken, handleSelectProject]);

  // ── Keyboard handler on the input ────────────────────────────────────
  // Enter: pick the first filtered match, OR fall back to resolve.
  // Escape: clear the query.
  const handleQueryKeyDown = useCallback((e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const trimmed = query.trim();
      if (!trimmed) return;
      const matches = filtered;
      if (matches.length > 0) {
        handleSelectProject(matches[0].id);
      } else {
        handleResolveTyped();
      }
    } else if (e.key === 'Escape') {
      setQuery('');
      setResolveError('');
    }
  }, [query, filtered, handleSelectProject, handleResolveTyped]);

  // Show the results panel whenever the user is typing OR when they
  // have no assigned projects yet (so we can render the empty-state
  // hint inside the panel itself).
  const showPanel = trimmed.length > 0
    || (!projectsLoading && allProjects.length === 0 && !projectsError);

  // Fetch drawings (cursor-paginated). ACTIVE-only — employees browse
  // the active set, not the supersede history.
  const fetchDrawings = useCallback(async ({ append = false, cursor = null } = {}) => {
    if (!projectId) return;
    if (append) setLoadingMore(true); else setLoading(true);
    setError('');
    try {
      const params = { projectId, status: 'ACTIVE', limit: '100' };
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

  const selectedProject = allProjects.find((p) => p.id === projectId);

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
            Active drawing revisions for your projects. Type a project
            name to find or create one; click a card to preview the PDF
            and see the supersedes chain.
          </p>
        </div>
      </div>

      {/* Filter toolbar — typeahead picker, employee-scoped */}
      <div className="dpr-card" style={{ marginBottom: '1rem' }}>
        <div className="form-row" style={{ alignItems: 'flex-end' }}>
          <div className="form-group" style={{ flex: 2, position: 'relative' }}>
            <label htmlFor="drawings-browse-project">Project *</label>
            <input
              id="drawings-browse-project"
              type="search"
              className="form-input"
              autoComplete="off"
              spellCheck={false}
              placeholder={
                projectsLoading
                  ? 'Finding projects…'
                  : (selectedProject ? selectedProject.name : 'Type a project name…')
              }
              value={query}
              onChange={(e) => { setQuery(e.target.value); setResolveError(''); }}
              onKeyDown={handleQueryKeyDown}
              disabled={projectsLoading || resolveBusy}
              aria-busy={projectsLoading || resolveBusy}
              aria-autocomplete="list"
              aria-expanded={showPanel}
              aria-controls="drawings-browse-project-results"
            />
            {selectedProject && query === '' && (
              <div style={{ fontSize: '0.85rem', color: 'var(--steel)', marginTop: '0.25rem' }}>
                Showing drawings for: <strong style={{ color: 'var(--navy)' }}>{selectedProject.name}</strong>
                {selectedProject.code ? ` (${selectedProject.code})` : ''}
              </div>
            )}
            {projectsError && (
              <div role="alert" style={{ fontSize: '0.85rem', color: 'var(--danger, #c0392b)', marginTop: '0.25rem' }}>
                {projectsError}
              </div>
            )}
            {resolveError && (
              <div role="alert" style={{ fontSize: '0.85rem', color: 'var(--danger, #c0392b)', marginTop: '0.25rem' }}>
                {resolveError}
              </div>
            )}
            {showPanel && (
              <ul
                id="drawings-browse-project-results"
                role="listbox"
                style={{
                  listStyle: 'none',
                  margin: '0.25rem 0 0',
                  padding: '0.25rem 0',
                  border: '1px solid var(--border, #e0e0e0)',
                  borderRadius: 4,
                  background: 'white',
                  maxHeight: 240,
                  overflowY: 'auto',
                  position: 'absolute',
                  zIndex: 10,
                  width: '100%',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                }}
              >
                {projectsLoading && (
                  <li style={{ padding: '0.5rem 0.75rem', color: 'var(--steel)', fontSize: '0.9rem' }}>
                    Finding projects…
                  </li>
                )}
                {!projectsLoading && allProjects.length === 0 && trimmed.length === 0 && (
                  <li style={{ padding: '0.5rem 0.75rem', color: 'var(--steel)', fontSize: '0.9rem' }}>
                    You haven't filed a DPR, Inspection, or BoqItem yet.
                    Type a project name above — it'll be created if it
                    doesn't exist.
                  </li>
                )}
                {!projectsLoading && filtered.length === 0 && trimmed.length > 0 && (
                  <li
                    role="option"
                    aria-selected="false"
                    onClick={handleResolveTyped}
                    style={{
                      padding: '0.5rem 0.75rem',
                      cursor: resolveBusy ? 'wait' : 'pointer',
                      background: 'var(--soft-bg, #f4f6f9)',
                      fontSize: '0.9rem',
                    }}
                  >
                    {resolveBusy ? 'Finding / creating…' : `Find or create "${trimmed}"`}
                  </li>
                )}
                {filtered.map((p) => (
                  <li
                    key={p.id}
                    role="option"
                    aria-selected={p.id === projectId}
                    onClick={() => handleSelectProject(p.id)}
                    style={{
                      padding: '0.5rem 0.75rem',
                      cursor: 'pointer',
                      background: p.id === projectId ? 'var(--soft-bg, #f4f6f9)' : 'transparent',
                      fontSize: '0.9rem',
                    }}
                  >
                    {p.name}{p.code ? ` (${p.code})` : ''}
                  </li>
                ))}
                {!exactMatch && trimmed.length > 0 && filtered.length > 0 && (
                  <li
                    role="option"
                    aria-selected="false"
                    onClick={handleResolveTyped}
                    style={{
                      padding: '0.5rem 0.75rem',
                      cursor: resolveBusy ? 'wait' : 'pointer',
                      borderTop: '1px solid var(--border, #e0e0e0)',
                      background: 'var(--soft-bg, #f4f6f9)',
                      fontSize: '0.9rem',
                    }}
                  >
                    {resolveBusy ? 'Finding / creating…' : `Find or create "${trimmed}"`}
                  </li>
                )}
              </ul>
            )}
          </div>
        </div>
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
