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
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.getProjects(accessToken);
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
      toast.pushToast({
        message: `Project "${pendingDelete.name}" archived`,
        tone: 'success',
      });
      setPendingDelete(null);
      load();
    } catch (err) {
      if (!mountedRef.current) return;
      toast.pushToast({
        message: err?.message || 'Failed to archive project',
        tone: 'error',
      });
    } finally {
      if (mountedRef.current) setDeleting(false);
    }
  }, [pendingDelete, accessToken, toast, load]);

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
    </div>
  );
}

// ──── List ────────────────────────────────────────────────────────────────
// Two visual groups: registered projects (have full metadata) and
// discovered (only a name — auto-discovered from DPR.projectName).
// Discovered entries get a "Register" CTA inline rather than edit/delete.
function ProjectsList({ projects, discovered, onRequestDelete, onGoToDashboard }) {
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
              <DiscoveredRow key={d.name} name={d.name} />
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

// Discovered row — name only + Register CTA. Inline so the admin can
// promote a discovered name to a registered project without leaving
// the list page.
function DiscoveredRow({ name }) {
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