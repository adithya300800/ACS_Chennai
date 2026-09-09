import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { formatShortDate } from '../../lib/format.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';

// N17 (Project-level dashboard with KPI tiles): admin project registry.
// Lists every registered + auto-discovered project, lets admins create
// a new one or soft-delete an existing one. Soft-delete is idempotent
// server-side so a double-click on Delete never throws.
//
// The project list view mirrors DprAll / InspectionAll (round-22.5):
// a single column on mobile, a 2-column table on desktop, with a
// sticky "+ New Project" CTA in the page header.

const ICONS = {
  building: (
    <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="21" x2="9" y2="9" />
    </svg>
  ),
  chart: (
    <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
      <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  ),
  edit: (
    <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  ),
  delete: (
    <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" /><path d="M19 6l-2 14a2 2 0 01-2 2H9a2 2 0 01-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" />
    </svg>
  ),
  plus: (
    <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  merge: (
    <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="6" cy="6" r="2.5" /><path d="M6 8.5v7.5" /><path d="M6 13c0-3.866 5-7 6-7" />
    </svg>
  ),
};

export default function ProjectsAdmin() {
  useDocumentTitle('Projects');
  const { accessToken } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const [projects, setProjects] = useState([]);
  const [discovered, setDiscovered] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Pending-delete is tracked per-id; null = no dialog open.
  // Same SOL-P0#5 confirmation pattern as DprDashboard bulk actions.
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  // [merge-orphan-source] Pending merge is tracked per discovered-name;
  // null = no dialog open. Shape:
  //   { sourceName, targetId, counts, previewing, merging }
  // `counts` (null until first preview) lets the modal swap between
  // "Preview merge" and "Merge N records" CTAs without changing handlers.
  const [pendingMerge, setPendingMerge] = useState(null);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.getProjects({ scope: 'all' }, accessToken);
      if (!mountedRef.current) return;
      setProjects(data.projects || []);
      setDiscovered(data.discovered || []);
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err?.message || 'Failed to load projects';
      setError(msg);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    mountedRef.current = true;
    load();
    return () => { mountedRef.current = false; };
  }, [load]);

  // Soft-delete handler. Backend is idempotent (already-deleted → no-op
  // success), so we just remove the row from local view after the call
  // returns. Toast confirms either path.
  const handleDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.softDeleteProject(pendingDelete.id, accessToken);
      if (!mountedRef.current) return;
      toast.push(
        `Project "${pendingDelete.name}" archived`,
        'success',
      );
      setPendingDelete(null);
      load();
    } catch (err) {
      if (!mountedRef.current) return;
      toast.push(
        err?.message || 'Failed to archive project',
        'error',
      );
    } finally {
      if (mountedRef.current) setDeleting(false);
    }
  }, [pendingDelete, accessToken, toast, load]);

  // [merge-orphan-source] Merge a discovered project name into an existing
  // curated Project. Two-phase: dryRun=true (commit=false) returns per-
  // table counts; commit=true writes the re-attribution. Preview is
  // mandatory before commit so the admin sees the row counts before any
  // destructive update — mirrors the dryRun pattern in
  // internal-upload-sweep.js / storage.js.
  const handleMerge = useCallback(async (commit) => {
    if (!pendingMerge) return;
    if (!pendingMerge.targetId) return; // guard — modal disables the button
    setPendingMerge((m) => ({ ...m, [commit ? 'merging' : 'previewing']: true }));
    try {
      const res = await api.mergeOrphanSourceIntoProject(
        pendingMerge.targetId,
        pendingMerge.sourceName,
        !commit, // dryRun=true when we're previewing
        accessToken,
      );
      if (!mountedRef.current) return;
      if (commit) {
        const total = res?.total ?? (res?.counts?.dpr + res?.counts?.inspection + res?.counts?.boq) ?? 0;
        toast.push(
          `Merged ${total} record${total === 1 ? '' : 's'} from "${pendingMerge.sourceName}" into "${res?.target?.name || 'target'}"`,
          'success',
        );
        setPendingMerge(null);
        load();
      } else {
        setPendingMerge((m) => ({ ...m, counts: res.counts, previewing: false }));
      }
    } catch (err) {
      if (!mountedRef.current) return;
      toast.push(
        err?.message || (commit ? 'Failed to merge' : 'Failed to preview merge'),
        'error',
      );
      setPendingMerge((m) => ({ ...m, previewing: false, merging: false }));
    }
  }, [pendingMerge, accessToken, toast, load]);

  return (
    <div className="dpr-page">
      <div className="dpr-page-header">
        <div>
          <h1 className="dpr-page-title" aria-label="Projects">Projects</h1>
          <p className="dpr-page-sub" style={{ color: 'var(--steel)', margin: 0, fontSize: '0.9rem' }}>
            Register projects so the PM dashboard can scope KPIs to a single site.
          </p>
        </div>
        <Link
          to="/portal/admin/projects/new"
          className="dpr-card"
          style={{
            padding: '0.5rem 0.875rem',
            textDecoration: 'none',
            color: 'white',
            background: 'var(--blue, #0066FF)',
            fontWeight: 600,
            fontSize: '0.9rem',
            borderRadius: 8,
            display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
          }}
        >
          {ICONS.plus}
          <span>New Project</span>
        </Link>
      </div>

      {error ? (
        <div
          className="dpr-card"
          style={{
            padding: '1.5rem',
            textAlign: 'center',
            color: 'var(--red, #dc2626)',
          }}
        >
          {error}
        </div>
      ) : loading ? (
        <div className="dpr-card" style={{ padding: '2rem', textAlign: 'center', color: 'var(--steel, #64748b)' }}>
          Loading projects&hellip;
        </div>
      ) : projects.length === 0 && discovered.length === 0 ? (
        <EmptyProjectsState />
      ) : (
        <ProjectsList
          projects={projects}
          discovered={discovered}
          onRequestDelete={setPendingDelete}
          onRequestMerge={setPendingMerge}
          onGoToDashboard={(name) => navigate(`/portal/admin/project-dashboard?project=${encodeURIComponent(name)}`)}
        />
      )}

      {/* Soft-delete confirmation — same shape as DprDashboard's
          destructive-action modal. We don't import the shared Modal
          component here because this confirmation is scoped to one row and
          reusing Modal would pull a heavier bundle than the dialog
          needs. Kept inline so the page stays self-contained. */}
      {pendingDelete ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-project-title"
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(15,23,42,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: '1rem',
          }}
          onClick={(e) => { if (e.target === e.currentTarget && !deleting) setPendingDelete(null); }}
        >
          <div
            className="dpr-card"
            style={{ maxWidth: 420, padding: '1.25rem', background: 'white' }}
          >
            <h2
              id="delete-project-title"
              style={{
                fontFamily: "'Plus Jakarta Sans', sans-serif",
                fontSize: '1rem', fontWeight: 700,
                color: 'var(--navy, #0f172a)', margin: '0 0 0.5rem',
              }}
            >
              Archive this project?
            </h2>
            <p style={{ fontSize: '0.85rem', color: 'var(--steel, #64748b)', margin: '0 0 1rem', lineHeight: 1.5 }}>
              <strong style={{ color: 'var(--navy, #0f172a)' }}>{pendingDelete.name}</strong> will be
              marked inactive. Historical DPRs and inspection records stay intact — only the
              dashboard will stop grouping new data here.
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
                style={{
                  padding: '0.5rem 0.875rem', border: '1px solid var(--steel, #cbd5e1)',
                  background: 'white', borderRadius: 8, fontSize: '0.85rem', cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                style={{
                  padding: '0.5rem 0.875rem',
                  background: 'var(--red, #dc2626)', color: 'white',
                  border: 'none', borderRadius: 8, fontSize: '0.85rem',
                  fontWeight: 600, cursor: deleting ? 'not-allowed' : 'pointer',
                  opacity: deleting ? 0.6 : 1,
                }}
              >
                {deleting ? 'Archiving…' : 'Archive project'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Merge-orphan-source confirmation — two-phase: pick a target, run a
          dryRun preview to see row counts, then commit. Inline rather than
          importing the shared Modal because this dialog owns its own
          preview flow and keeps the page self-contained (same posture as
          the soft-delete modal above). */}
      {pendingMerge ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="merge-project-title"
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(15,23,42,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: '1rem',
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && !pendingMerge.previewing && !pendingMerge.merging) {
              setPendingMerge(null);
            }
          }}
        >
          <div
            className="dpr-card"
            style={{ maxWidth: 480, padding: '1.25rem', background: 'white' }}
          >
            <h2
              id="merge-project-title"
              style={{
                fontFamily: "'Plus Jakarta Sans', sans-serif",
                fontSize: '1rem', fontWeight: 700,
                color: 'var(--navy, #0f172a)', margin: '0 0 0.5rem',
              }}
            >
              Merge &ldquo;{pendingMerge.sourceName}&rdquo; into&hellip;
            </h2>
            <p style={{ fontSize: '0.85rem', color: 'var(--steel, #64748b)', margin: '0 0 0.75rem', lineHeight: 1.5 }}>
              Pick a registered project to absorb the orphaned Daily Reports, Inspections, and BOQ items from <strong style={{ color: 'var(--navy, #0f172a)' }}>{pendingMerge.sourceName}</strong>. The KPI dashboard will start counting them under the target project.
            </p>
            <label
              htmlFor="merge-target"
              style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: 'var(--steel, #64748b)', marginBottom: '0.3rem' }}
            >
              Target project
            </label>
            <select
              id="merge-target"
              value={pendingMerge.targetId || ''}
              onChange={(e) => setPendingMerge((m) => m ? { ...m, targetId: e.target.value || null, counts: null } : m)}
              disabled={pendingMerge.previewing || pendingMerge.merging}
              style={{
                width: '100%', padding: '0.5rem 0.625rem',
                border: '1px solid var(--steel, #cbd5e1)', borderRadius: 6,
                background: 'white', fontSize: '0.85rem', color: 'var(--navy, #0f172a)',
                marginBottom: '0.75rem',
              }}
            >
              <option value="">Select a project&hellip;</option>
              {projects.filter((p) => p.isActive).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.code ? ` (${p.code})` : ''}
                </option>
              ))}
            </select>
            {pendingMerge.counts ? (
              <div
                role="status"
                style={{
                  padding: '0.625rem 0.75rem',
                  background: 'rgba(0,102,255,0.06)',
                  border: '1px solid rgba(0,102,255,0.18)',
                  borderRadius: 6,
                  fontSize: '0.82rem', color: 'var(--navy, #0f172a)',
                  lineHeight: 1.45, marginBottom: '0.75rem',
                }}
              >
                <strong>{pendingMerge.counts.dpr}</strong> Daily Report{pendingMerge.counts.dpr === 1 ? '' : 's'},
                {' '}<strong>{pendingMerge.counts.inspection}</strong> Inspection{pendingMerge.counts.inspection === 1 ? '' : 's'},
                {' '}<strong>{pendingMerge.counts.boq}</strong> BOQ item{pendingMerge.counts.boq === 1 ? '' : 's'}
                {' '}will be re-attributed to{' '}
                <strong>{projects.find((p) => p.id === pendingMerge.targetId)?.name || 'the selected project'}</strong>.
              </div>
            ) : null}
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => setPendingMerge(null)}
                disabled={pendingMerge.previewing || pendingMerge.merging}
                style={{
                  padding: '0.5rem 0.875rem', border: '1px solid var(--steel, #cbd5e1)',
                  background: 'white', borderRadius: 8, fontSize: '0.85rem',
                  cursor: (pendingMerge.previewing || pendingMerge.merging) ? 'not-allowed' : 'pointer',
                  opacity: (pendingMerge.previewing || pendingMerge.merging) ? 0.6 : 1,
                }}
              >
                Cancel
              </button>
              {!pendingMerge.counts ? (
                <button
                  type="button"
                  onClick={() => handleMerge(false)}
                  disabled={!pendingMerge.targetId || pendingMerge.previewing}
                  style={{
                    padding: '0.5rem 0.875rem',
                    background: 'var(--blue, #0066FF)', color: 'white',
                    border: 'none', borderRadius: 8, fontSize: '0.85rem',
                    fontWeight: 600,
                    cursor: (!pendingMerge.targetId || pendingMerge.previewing) ? 'not-allowed' : 'pointer',
                    opacity: (!pendingMerge.targetId || pendingMerge.previewing) ? 0.6 : 1,
                  }}
                >
                  {pendingMerge.previewing ? 'Counting…' : 'Preview merge'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => handleMerge(true)}
                  disabled={pendingMerge.merging || (pendingMerge.counts.dpr + pendingMerge.counts.inspection + pendingMerge.counts.boq) === 0}
                  style={{
                    padding: '0.5rem 0.875rem',
                    background: 'var(--blue, #0066FF)', color: 'white',
                    border: 'none', borderRadius: 8, fontSize: '0.85rem',
                    fontWeight: 600,
                    cursor: (pendingMerge.merging || (pendingMerge.counts.dpr + pendingMerge.counts.inspection + pendingMerge.counts.boq) === 0) ? 'not-allowed' : 'pointer',
                    opacity: (pendingMerge.merging || (pendingMerge.counts.dpr + pendingMerge.counts.inspection + pendingMerge.counts.boq) === 0) ? 0.6 : 1,
                  }}
                  title={
                    (pendingMerge.counts.dpr + pendingMerge.counts.inspection + pendingMerge.counts.boq) === 0
                      ? 'Nothing to merge — source has no orphaned rows against it'
                      : undefined
                  }
                >
                  {pendingMerge.merging
                    ? 'Merging…'
                    : `Merge ${pendingMerge.counts.dpr + pendingMerge.counts.inspection + pendingMerge.counts.boq} record${(pendingMerge.counts.dpr + pendingMerge.counts.inspection + pendingMerge.counts.boq) === 1 ? '' : 's'}`}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ──── List ────────────────────────────────────────────────────────────────
// Two visual groups: registered projects (have full metadata) and
// discovered (only a name — auto-discovered from DPR.projectName).
// Discovered entries get a "Register" CTA inline rather than edit/delete.
function ProjectsList({ projects, discovered, onRequestDelete, onRequestMerge, onGoToDashboard }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* Registered projects */}
      <section>
        <h2
          style={{
            fontFamily: "'Plus Jakarta Sans', sans-serif",
            fontSize: '0.78rem', fontWeight: 700,
            color: 'var(--steel, #64748b)', textTransform: 'uppercase',
            letterSpacing: '0.06em', margin: '0 0 0.5rem',
          }}
        >
          Registered ({projects.length})
        </h2>
        {projects.length === 0 ? (
          <div className="dpr-card" style={{ padding: '1rem', textAlign: 'center', color: 'var(--steel, #64748b)' }}>
            No registered projects yet.
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
              gap: '0.75rem',
            }}
          >
            {projects.map((p) => (
              <RegisteredRow
                key={p.id}
                project={p}
                onRequestDelete={onRequestDelete}
                onGoToDashboard={() => onGoToDashboard(p.name)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Discovered projects — names that exist on DPR rows but have
          no Project row yet. Light-weight render: name + a register
          CTA. The admin can convert a discovered name to a registered
          project via ProjectForm (which can pre-fill the name via a
          query string). */}
      {discovered.length > 0 && (
        <section>
          <h2
            style={{
              fontFamily: "'Plus Jakarta Sans', sans-serif",
              fontSize: '0.78rem', fontWeight: 700,
              color: 'var(--steel, #64748b)', textTransform: 'uppercase',
              letterSpacing: '0.06em', margin: '0 0 0.5rem',
            }}
          >
            Discovered ({discovered.length})
          </h2>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
              gap: '0.75rem',
            }}
          >
            {discovered.map((d) => (
              <DiscoveredRow
                key={d.name}
                name={d.name}
                onRequestMerge={onRequestMerge}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// One registered-project card. Layout matches the admin queue cards:
// icon chip on the left, project metadata + actions on the right.
function RegisteredRow({ project, onRequestDelete, onGoToDashboard }) {
  return (
    <div
      className="dpr-card"
      style={{
        padding: '0.875rem 1rem',
        display: 'flex', alignItems: 'flex-start', gap: '0.75rem',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 40, height: 40, flexShrink: 0,
          color: 'var(--blue, #0066FF)',
          background: 'rgba(0,102,255,0.08)',
          borderRadius: 10,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        {ICONS.building}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', flexWrap: 'wrap' }}>
          <div
            style={{
              fontFamily: "'Plus Jakarta Sans', sans-serif",
              fontWeight: 700, fontSize: '0.95rem',
              color: 'var(--navy, #0f172a)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {project.name}
          </div>
          {project.code ? (
            <span style={{
              fontSize: '0.7rem', fontWeight: 600,
              color: 'var(--steel, #64748b)',
              background: 'rgba(100,116,139,0.10)',
              padding: '1px 6px', borderRadius: 4,
            }}>
              {project.code}
            </span>
          ) : null}
          {!project.isActive ? (
            <span style={{
              fontSize: '0.7rem', fontWeight: 600,
              color: 'var(--steel, #64748b)',
              background: 'rgba(100,116,139,0.10)',
              padding: '1px 6px', borderRadius: 4,
            }}>
              Inactive
            </span>
          ) : null}
        </div>
        <div style={{ fontSize: '0.78rem', color: 'var(--steel, #64748b)', marginTop: '0.2rem' }}>
          {project.client ? <span>{project.client}</span> : null}
          {project.location ? <span>{project.client ? ' · ' : ''}{project.location}</span> : null}
        </div>
        <div style={{ fontSize: '0.72rem', color: 'var(--steel, #64748b)', marginTop: '0.15rem' }}>
          {project.startDate ? <>Start: {formatShortDate(project.startDate)}</> : null}
        </div>
        {/* Actions row. Stays inside the same card so a delete
          confirmation (modal) reads as scoped to this row. */}
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={onGoToDashboard}
            style={{
              padding: '0.35rem 0.625rem',
              border: '1px solid var(--blue, #0066FF)',
              borderRadius: 6,
              background: 'rgba(0,102,255,0.06)',
              color: 'var(--blue, #0066FF)',
              fontWeight: 600, fontSize: '0.78rem',
              cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
            }}
          >
            {ICONS.chart}
            <span>KPIs</span>
          </button>
          <Link
            to={`/portal/admin/projects/${project.id}/edit`}
            style={{
              padding: '0.35rem 0.625rem',
              border: '1px solid var(--steel, #cbd5e1)',
              borderRadius: 6, background: 'white',
              color: 'var(--navy, #0f172a)',
              fontWeight: 600, fontSize: '0.78rem',
              textDecoration: 'none',
              display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
            }}
          >
            {ICONS.edit}
            <span>Edit</span>
          </Link>
          <button
            type="button"
            onClick={() => onRequestDelete({ id: project.id, name: project.name })}
            style={{
              padding: '0.35rem 0.625rem',
              border: '1px solid var(--red, #dc2626)',
              borderRadius: 6, background: 'white',
              color: 'var(--red, #dc2626)',
              fontWeight: 600, fontSize: '0.78rem',
              cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
            }}
          >
            {ICONS.delete}
            <span>Archive</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// Discovered row — name only + Register (primary) + Merge into… (secondary).
// "Register" promotes the discovered name to a brand-new Project row via
// ProjectForm. "Merge into…" opens a modal picker that re-attributes the
// orphaned DPR / Inspection / BOQ rows onto an existing curated Project —
// use this when the discovered name is really a duplicate of an existing
// project (typo, case drift, etc.) and the KPI dashboard should fold the
// history into the curated target.
function DiscoveredRow({ name, onRequestMerge }) {
  return (
    <div
      className="dpr-card"
      style={{
        padding: '0.875rem 1rem',
        display: 'flex', alignItems: 'center', gap: '0.75rem',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 40, height: 40, flexShrink: 0,
          color: 'var(--amber, #d97706)',
          background: 'rgba(217,119,6,0.10)',
          borderRadius: 10,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        {ICONS.building}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: "'Plus Jakarta Sans', sans-serif",
            fontWeight: 700, fontSize: '0.95rem',
            color: 'var(--navy, #0f172a)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          {name}
        </div>
        <div style={{ fontSize: '0.78rem', color: 'var(--steel, #64748b)' }}>
          Not yet registered
        </div>
      </div>
      <div style={{ display: 'flex', gap: '0.4rem', flexShrink: 0 }}>
        <button
          type="button"
          onClick={() => onRequestMerge({ sourceName: name, targetId: null, counts: null, previewing: false, merging: false })}
          style={{
            padding: '0.35rem 0.625rem',
            border: '1px solid var(--steel, #cbd5e1)',
            borderRadius: 6, background: 'white',
            color: 'var(--navy, #0f172a)',
            fontWeight: 600, fontSize: '0.78rem',
            cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
          }}
        >
          {ICONS.merge}
          <span>Merge into&hellip;</span>
        </button>
        <Link
          to={`/portal/admin/projects/new?name=${encodeURIComponent(name)}`}
          style={{
            padding: '0.35rem 0.625rem',
            background: 'var(--blue, #0066FF)', color: 'white',
            borderRadius: 6, fontWeight: 600, fontSize: '0.78rem',
            textDecoration: 'none',
            display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
          }}
        >
          {ICONS.plus}
          <span>Register</span>
        </Link>
      </div>
    </div>
  );
}

// Empty state — only shown when there's nothing registered AND nothing
// discovered (i.e. fresh portal). Shows the two CTAs to either register
// a new project or wait for DPRs.
function EmptyProjectsState() {
  return (
    <div
      className="dpr-card"
      style={{
        padding: '2rem',
        textAlign: 'center',
        color: 'var(--steel, #64748b)',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 56, height: 56, margin: '0 auto 1rem',
          color: 'var(--blue, #0066FF)',
          background: 'rgba(0,102,255,0.08)',
          borderRadius: 14,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        {ICONS.building}
      </div>
      <div
        style={{
          fontFamily: "'Plus Jakarta Sans', sans-serif",
          fontWeight: 700, fontSize: '1.05rem',
          color: 'var(--navy, #0f172a)', marginBottom: '0.4rem',
        }}
      >
        No projects yet
      </div>
      <div style={{ fontSize: '0.9rem', marginBottom: '1rem', lineHeight: 1.5 }}>
        Register your first project so the PM dashboard can scope KPIs to a site, or wait — projects are auto-discovered from filed Daily Reports.
      </div>
      <Link
        to="/portal/admin/projects/new"
        style={{
          padding: '0.5rem 0.875rem',
          textDecoration: 'none',
          color: 'white',
          background: 'var(--blue, #0066FF)',
          fontWeight: 600,
          fontSize: '0.9rem',
          borderRadius: 8,
          display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
        }}
      >
        {ICONS.plus}
        <span>Register first project</span>
      </Link>
    </div>
  );
}