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
// [Round-30] Project picker narrowed to /api/projects?scope=assigned
// (the employee's touched set) instead of the org-wide `?scope=mine`.
// Originally rendered as a typeahead input so employees could type a
// name and resolve new projects inline.
//
// [Round-32] Reverted the typeahead to a real <select> dropdown at
// the user's request — they found the typeahead hard to scan, and
// the picker only ever holds a small employee-scoped list (a handful
// of project names at most). The "create new project" affordance is
// a sentinel <option value="__create__"> at the bottom of the
// dropdown; picking it swaps the picker for an inline name input
// + Create / Cancel pair that calls /api/projects/resolve.
//
// [Round-32.1 bugfix] Two dropdown correctness fixes from live user
// feedback:
//   1. Auto-discovered names from `data.discovered` (DPR/Inspection
//      projectName values with no Project row) are now merged into
//      the dropdown — earlier the picker only took `data.projects`,
//      so every DPR a field engineer filed with projectName instead
//      of projectId was silently missing from their picker.
//   2. `Project.createdById === req.employeeId` was dropped from the
//      backend `?scope=assigned` union — projects the employee
//      merely created (often test artifacts from the typeahead/resolve
//      flow) leaked into the picker even though they had no child
//      records. The dropdown now reflects actual work history.
//
// Discovered entries render with `· not registered` suffix and use
// a sentinel value `__disc__:${name}`. Picking one flips into
// create-mode with the name pre-filled, so the engineer can register
// the Project row in one step.
//
// URL shape:
//   ?projectId=<uuid>    selected project (existing — still honored for
//                        deep links from ProjectDetail's Drawings tab)
//   (no ?q= — the typeahead's URL state is gone with the input)
//
// Differences from DrawingsAdmin:
//   - No "Supersede" / "Archive" per-card actions (curation stays admin-only).
//   - Status filter is locked to ACTIVE (employees don't curate history).
//   - Project picker reads from /api/projects?scope=assigned (curated
//     list narrowed to the employee's touched set, PLUS auto-discovered
//     names from the same set, PLUS a "+ Create new project…" sentinel
//     option at the bottom).
//
// [Round-31] "+ Add drawing" CTA on the page header + empty state.
// POST /api/drawings was loosened to requireAuth so a field engineer can
// register a fresh revision without bouncing to an admin. The CTA is
// disabled when no project is picked; the modal's project dropdown is
// pre-filled and locked to the current ?projectId= so the engineer
// can't accidentally upload against a different project.
//
// Auth: backend GET /api/drawings + POST /api/drawings are both
// requireAuth (all employees) so no client-side gating is needed beyond
// the ProtectedRoute wrapper.

import React, { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';
import DrawingFormModal from '../../components/DrawingFormModal.jsx';
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

  // ── Create-new-project state (Round-32) ────────────────────────────────
  // `createMode` flips when the user picks the "+ Create new project…"
  // sentinel option; an inline name input + Create/Cancel pair renders
  // below the (disabled) select. `resolveBusy` gates the create button +
  // the input while the POST /api/projects/resolve round-trip is in flight.
  const [createMode, setCreateMode] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [resolveBusy, setResolveBusy] = useState(false);
  const [resolveError, setResolveError] = useState('');

  const [drawings, setDrawings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [nextCursor, setNextCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // ── Add-drawing modal state (Round-31) ─────────────────────────────────
  // `formOpen` toggles the modal. `creating` mirrors the modal's submit
  // state so the header button can show a "Saving…" affordance. The
  // modal owns the per-field + server-error display via DrawingFormModal's
  // own internal state — errors thrown from handleSave are caught inside
  // DrawingFormModal.submit and rendered inline, so no parent mirror is
  // needed.
  const [formOpen, setFormOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  // Load curated (active) projects on mount, scoped to the employee's
  // touched set. The previous default `?scope=mine` returned the full
  // org-wide curated list — switching to `?scope=assigned` (round-30)
  // narrows the picker to projects the employee actually has child
  // records against.
  //
  // [Round-32.1 bugfix] We also merge `data.discovered` — the auto-
  // discovered project names that come from DPR/Inspection rows where
  // the legacy `projectName` string was used but no Project row exists
  // yet. Without this merge, employees whose DPRs were filed with
  // projectName instead of projectId saw the dropdown missing every
  // project they actually worked on (the user's "not showing all the
  // projects name that the employee has DPRs" complaint). Discovered
  // entries render with `isRegistered: false` and a "· not registered"
  // suffix in the dropdown; picking one flips into create-mode with
  // the name pre-filled so the user can register the Project row.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getProjects({ scope: 'assigned' }, accessToken);
        if (cancelled) return;
        const curated = (data?.projects || [])
          .filter((p) => p.isActive)
          .map((p) => ({ ...p, isRegistered: true }));
        // Discovered names only have a `name` and `isRegistered: false`.
        // Synthesize a null id so they can coexist with curated rows in
        // the same array — the dropdown keys on `id ?? name` and the
        // select sentinel is `__disc__:${name}`.
        const discovered = (data?.discovered || []).map((d) => ({
          id: null,
          name: d.name,
          code: null,
          client: null,
          location: null,
          isActive: true,
          isRegistered: false,
        }));
        // Dedupe by name (case-insensitive) so an auto-discovered name
        // that was registered between two fetches doesn't appear twice.
        const seen = new Set(curated.map((p) => (p.name || '').toLowerCase()));
        const merged = [
          ...curated,
          ...discovered.filter((d) => !seen.has((d.name || '').toLowerCase())),
        ];
        setProjects(merged);
        // Pick a default project: URL-supplied first, else the first
        // active one. This keeps the page non-empty for any employee
        // who has at least one assigned project.
        setProjectId((prev) => {
          if (prev && merged.some((p) => p.id === prev)) return prev;
          const fromUrl = merged.some((p) => p.id === urlProjectId) ? urlProjectId : '';
          return fromUrl || (merged.length > 0 && merged[0].id ? merged[0].id : '');
        });
      } catch (err) {
        if (!cancelled) setProjectsError(err?.message || 'Failed to load projects');
      } finally {
        if (!cancelled) setProjectsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [accessToken, urlProjectId]);

  // ── Selection handler — <select> change ───────────────────────────────
  // Drives both `projectId` (local state) and the URL ?projectId= so
  // ProjectDetail's Drawings tab and shared links still work.
  const handleSelectProject = useCallback((next) => {
    setProjectId(next);
    const sp = new URLSearchParams(searchParams);
    if (next) sp.set('projectId', next); else sp.delete('projectId');
    setSearchParams(sp, { replace: true });
    // Picking a real project always closes any open create-mode form.
    setCreateMode(false);
    setNewProjectName('');
    setResolveError('');
  }, [searchParams, setSearchParams]);

  // ── Create a new project from the inline form ────────────────────────
  // Calls POST /api/projects/resolve: returns the existing Project if
  // the name matches (case-insensitive), or creates one with
  // createdById=req.employeeId. 409 PROJECT_INACTIVE if the typed name
  // matches an archived project.
  const handleCreateProject = useCallback(async () => {
    const name = newProjectName.trim();
    if (!name || resolveBusy) return;
    setResolveBusy(true);
    setResolveError('');
    try {
      const proj = await api.resolveProject(name, accessToken);
      // Add to the projects list so it shows up in the dropdown for the
      // rest of the session — the next /scope=assigned fetch won't
      // return it until the employee files a child record against it,
      // but Project.createdById=req.employeeId includes it from then on.
      setProjects((prev) => (prev.some((p) => p.id === proj.id) ? prev : [...prev, proj]));
      setCreateMode(false);
      setNewProjectName('');
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
  }, [newProjectName, resolveBusy, accessToken, handleSelectProject]);

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

  // ── Round-31: handleSave from DrawingFormModal ──────────────────────────
  // Called when the modal's submit succeeds and DrawingFormModal's
  // onSave fires. We POST /api/drawings via api.createDrawing, then
  // refresh the grid so the new revision shows up without a page reload.
  // Errors thrown from createDrawing bubble up to DrawingFormModal's
  // own submit() catch (lines 233-239 of DrawingFormModal.jsx), which
  // renders the server message inline — the toast is reserved for the
  // success case so the engineer gets one clear signal per outcome.
  const handleSave = useCallback(async (payload) => {
    setCreating(true);
    try {
      await api.createDrawing(payload, accessToken);
      setFormOpen(false);
      toast.push('Drawing added.', 'success');
      // Refresh the grid. The fetchDrawings closure captures the current
      // projectId, so the new row will appear in the active list.
      await fetchDrawings();
    } catch (err) {
      // Re-throw so DrawingFormModal's own submit() catch renders the
      // message inside the modal. Setting creating=false here would
      // unmount before the user sees the error.
      throw err;
    } finally {
      setCreating(false);
    }
  }, [accessToken, fetchDrawings, toast]);

  const selectedProject = projects.find((p) => p.id === projectId);

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
            Active drawing revisions for your projects. Pick a project
            from your assigned list — or create a new one — then click a
            card to preview the PDF and see the supersedes chain.
          </p>
        </div>
        {/* [Round-31] + Add drawing. Disabled when no project is picked
            because the modal pre-fills + locks the projectId from the
            current selection — opening it with no project would render
            an empty form and force the user back to the picker. */}
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => setFormOpen(true)}
          disabled={!projectId || creating}
          aria-label="Add drawing"
          aria-disabled={!projectId || creating}
          title={!projectId ? 'Pick a project first' : 'Add a new drawing revision'}
        >
          {creating ? 'Saving…' : '+ Add drawing'}
        </button>
      </div>

      {/* Filter toolbar — <select> dropdown picker, employee-scoped.
          Renders curated projects + auto-discovered names + a sentinel
          "+ Create new project…" option. Picking the "__create__"
          sentinel opens an inline name input. Picking a discovered
          entry (sentinel value "__disc__:<name>") opens the same
          inline form with the name pre-filled — the engineer can
          register the Project row in one step. The select stays
          disabled while in create mode so the user can't double-fire
          the resolver. */}
      <div className="dpr-card" style={{ marginBottom: '1rem' }}>
        <div className="form-row" style={{ alignItems: 'flex-start' }}>
          <div className="form-group" style={{ flex: 2 }}>
            <label htmlFor="drawings-browse-project">Project *</label>
            <select
              id="drawings-browse-project"
              name="projectId"
              className="form-input"
              // While in create-mode the select shows the "+ Create new
              // project…" sentinel. Outside create-mode, projectId is
              // either a real id or empty (when only discovered entries
              // exist — the dropdown can show them but projectId stays
              // empty until the user registers one).
              value={createMode ? '__create__' : (projectId || '')}
              onChange={(e) => {
                const val = e.target.value;
                if (val === '__create__') {
                  setCreateMode(true);
                  setNewProjectName('');
                  setResolveError('');
                } else if (val.startsWith('__disc__:')) {
                  // Picked a discovered name — flip into create-mode
                  // with the name pre-filled so the engineer can
                  // register the Project row in one step.
                  const name = val.slice('__disc__:'.length);
                  setCreateMode(true);
                  setNewProjectName(name);
                  setResolveError('');
                } else {
                  handleSelectProject(val);
                }
              }}
              disabled={projectsLoading || resolveBusy}
              aria-busy={projectsLoading || resolveBusy}
            >
              <option value="">— Select project —</option>
              {projects.map((p) => (
                <option
                  key={p.id ?? `__disc__:${p.name}`}
                  value={p.id ?? `__disc__:${p.name}`}
                  disabled={!p.id && !p.isRegistered}
                >
                  {p.name}{p.code ? ` (${p.code})` : ''}{!p.isRegistered ? ' · not registered' : ''}
                </option>
              ))}
              <option value="__create__">+ Create new project…</option>
            </select>
            {selectedProject && !createMode && (
              <div style={{ fontSize: '0.85rem', color: 'var(--steel)', marginTop: '0.25rem' }}>
                Showing drawings for: <strong style={{ color: 'var(--navy)' }}>{selectedProject.name}</strong>
                {selectedProject.code ? ` (${selectedProject.code})` : ''}
              </div>
            )}
            {!projectsLoading && projects.length === 0 && !createMode && (
              <div style={{ fontSize: '0.85rem', color: 'var(--steel)', marginTop: '0.25rem' }}>
                You haven't filed a DPR, Inspection, or BoqItem against any
                project yet. Pick <strong>+ Create new project…</strong>{' '}
                above to start one.
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
          </div>
          {createMode && (
            <div
              className="form-group"
              style={{ flex: 3, display: 'flex', gap: '0.5rem', alignItems: 'flex-end', marginBottom: 0 }}
              role="group"
              aria-label="Create new project"
            >
              <div style={{ flex: 1 }}>
                <label
                  htmlFor="drawings-browse-new-project"
                  style={{ fontSize: '0.8rem', color: 'var(--steel)' }}
                >
                  New project name
                </label>
                <input
                  id="drawings-browse-new-project"
                  type="text"
                  className="form-input"
                  value={newProjectName}
                  onChange={(e) => { setNewProjectName(e.target.value); setResolveError(''); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleCreateProject();
                    } else if (e.key === 'Escape') {
                      setCreateMode(false);
                      setNewProjectName('');
                      setResolveError('');
                    }
                  }}
                  disabled={resolveBusy}
                  placeholder="e.g. New Project Name"
                  aria-label="New project name"
                  autoFocus
                />
              </div>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleCreateProject}
                disabled={resolveBusy || !newProjectName.trim()}
              >
                {resolveBusy ? 'Creating…' : 'Create'}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  setCreateMode(false);
                  setNewProjectName('');
                  setResolveError('');
                }}
                disabled={resolveBusy}
              >
                Cancel
              </button>
            </div>
          )}
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
        <div className="dpr-list-empty" style={{ textAlign: 'center', padding: '3rem 1rem' }}>
          <div style={{ marginBottom: '1rem', color: 'var(--steel)', fontSize: '2rem' }}>📐</div>
          <h3 style={{ color: 'var(--navy)', marginBottom: '0.5rem' }}>
            No active drawings for {selectedProject?.name || 'this project'} yet
          </h3>
          <p style={{ color: 'var(--steel)', maxWidth: 460, margin: '0 auto 1.25rem' }}>
            Be the first to add a revision — it'll show up here as the
            stamp target on your DPR and Inspection records.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setFormOpen(true)}
            disabled={creating}
            aria-label="Add drawing"
          >
            {creating ? 'Saving…' : '+ Add drawing'}
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

      {/* Round-31: add-drawing modal. Project is pre-filled and locked
          via initialProjectId so the engineer can't upload against a
          different project than the one they have loaded. Errors thrown
          from handleSave are caught inside DrawingFormModal's submit
          (line 233-239) and rendered inline via the modal's own
          serverError state — we don't need to forward them. */}
      <DrawingFormModal
        open={formOpen}
        onClose={() => { if (!creating) setFormOpen(false); }}
        onSave={handleSave}
        accessToken={accessToken}
        projects={projects}
        initialProjectId={projectId}
      />
    </div>
  );
}
