import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { BuildingIcon } from '../../components/Icons.jsx';
import { formatShortDate } from '../../lib/format.js';
import ProjectExpandedPanel from './ProjectExpandedPanel.jsx';

// [N1 Phase B] Portal-side "My projects" list. Mirrors DprList's
// structure (fetch + header + card grid + filter row) but is a much
// simpler read-only surface. The backend `GET /api/projects` returns
//   { projects: [...registered], discovered: [...names auto-discovered
//   from DPR.projectName] }
// — both are merged here into one "projects I'm associated with" view
// so the employee doesn't need a separate "discovered" badge. Discovered
// entries are flagged with `isRegistered=false` and route to the same
// anchor page (which renders the empty-state metadata).
//
// [Round-33] Cards are now expandable accordions. Clicking a card
// expands an inline panel beneath it with five sub-sections (Overview,
// BOQ, DPRs, Inspections, Drawings). The panel lazy-loads the
// project's parties + sub-resource lists in parallel; sub-section rows
// are themselves clickable tiles that expand to show full details.
// The user never leaves /portal/projects. Only one project is expanded
// at a time (single-open accordion) so the page stays predictable.

// Indian-rupee formatter. Backend serializes contractValue as a string
// (precision-preserving — see serializeProject in
// backend/src/routes/projects.js:236-241) so we never go through
// `Number()` here; doing so on a 15-digit value would silently lose
// the last few digits. Parse to Number ONLY at the formatting boundary.
const inrFormatter = new Intl.NumberFormat('en-IN', {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});
function formatInr(value) {
  if (value == null || value === '') return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  return `₹${inrFormatter.format(n)}`;
}

// Render the joined `parties` JSONB into a one-line summary.
// Backend stores parties as a record like { client, contractor, consultant }.
// The "—" fallback covers both null parties and a parsed-empty object.
function summarizeParties(parties) {
  if (!parties || typeof parties !== 'object') return null;
  const parts = [];
  if (parties.client) parts.push(`Client: ${parties.client}`);
  if (parties.contractor) parts.push(`Contractor: ${parties.contractor}`);
  if (parties.consultant) parts.push(`Consultant: ${parties.consultant}`);
  if (parts.length === 0) return null;
  return parts.join(' · ');
}

export default function Projects() {
  useDocumentTitle('My Projects');
  const { accessToken } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const mountedRef = useRef(true);

  // Single merged list. `registered` is shown with full metadata; a
  // discovered entry has only `name` and a `isRegistered=false` flag.
  // The two source lists arrive in separate fields from the backend and
  // we de-dup by name so an auto-discovered name that's been registered
  // in the meantime is only rendered once (the registered row wins).
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Local client-side filter — N1 portal surface is small (typically
  // < 50 projects per org) so we don't need a backend search param.
  const [search, setSearch] = useState('');
  // Status filter: active / inactive / all. Discovered entries are
  // always "active" in the local sense (they have no isActive flag).
  const [statusFilter, setStatusFilter] = useState('active');
  // [Round-33] Accordion: only one project expanded at a time. Keyed
  // by the same id||name string the card uses. Stays null until the
  // user clicks a card's chevron.
  const [expandedKey, setExpandedKey] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // [Round-31] Scope the curated list to projects the employee has
      // personally touched or created (DPR/Inspection/Boq/Variation/Drawing
      // audit columns + Project.createdById). Without this, the page
      // returned every active project org-wide — leaking admin test rigs
      // / contracts the employee has no context on. Mirrors the
      // DrawingsBrowse typeahead (commit 94b0235).
      const data = await api.getProjects({ scope: 'assigned' }, accessToken);
      if (!mountedRef.current) return;
      const registered = (data.projects || []).map((p) => ({ ...p, isRegistered: true }));
      const registeredNames = new Set(registered.map((p) => p.name));
      const discovered = (data.discovered || [])
        .filter((d) => !registeredNames.has(d.name))
        .map((d) => ({ name: d.name, isRegistered: false, isActive: true }));
      // Registered first (full metadata), then discovered (name-only).
      setItems([...registered, ...discovered]);
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err?.message || 'Failed to load projects';
      setError(msg);
      if (err?.status !== 401) toast.push(msg, 'error');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [accessToken, toast]);

  useEffect(() => {
    mountedRef.current = true;
    load();
    return () => { mountedRef.current = false; };
  }, [load]);

  // Client-side filter chain: search + status. Discovered entries are
  // always "active" in this view (they have no isActive flag) — see
  // the statusFilter branch below.
  const filtered = items.filter((p) => {
    if (statusFilter === 'active' && !p.isActive) return false;
    if (statusFilter === 'inactive' && p.isActive) return false;
    if (search) {
      const q = search.toLowerCase();
      const hay = `${p.name || ''} ${p.code || ''} ${p.client || ''} ${p.location || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const registeredCount = items.filter((p) => p.isRegistered).length;
  const discoveredCount = items.length - registeredCount;

  return (
    <div className="dpr-page">
      <div className="dpr-page-header">
        <div>
          <Breadcrumb
            items={[
              { label: 'Projects' },
            ]}
          />
          <h1 className="dpr-page-title">My Projects</h1>
          <p className="dpr-page-sub" style={{ color: 'var(--steel)', margin: 0, fontSize: '0.9rem' }}>
            Every project you're associated with. Projects are created automatically
            when you file a DPR or inspection, and admins can register new ones in
            the project registry.
          </p>
          <p className="dpr-page-sub" style={{ color: 'var(--steel)', margin: '0.4rem 0 0', fontSize: '0.78rem' }}>
            Tip: click any project card to expand its Overview, BOQ, DPRs,
            Inspections, and Drawings — all in place, no navigation.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <Link to="/portal/dpr/submit" className="btn btn-secondary btn-sm">
            + New DPR
          </Link>
          <Link to="/portal/inspection/submit" className="btn btn-secondary btn-sm">
            + New Inspection
          </Link>
        </div>
      </div>

      {/* Filter row: text search + status segmented control. Mirrors the
          DprList layout (a single dpr-card with form-row + status select)
          so the visual contract is consistent across the two list pages. */}
      <div className="dpr-card" style={{ marginBottom: '1rem' }}>
        <div className="form-row" style={{ alignItems: 'flex-end' }}>
          <div className="form-group" style={{ flex: 2 }}>
            <label htmlFor="projects-search">Search</label>
            <input
              id="projects-search"
              type="text"
              className="form-input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name, code, client, or location…"
            />
          </div>
          <div className="form-group" style={{ flex: 1 }}>
            <label htmlFor="projects-status">Status</label>
            <select
              id="projects-status"
              className="form-input"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="all">All</option>
            </select>
          </div>
        </div>
        {(search || statusFilter !== 'active') && (
          <div style={{ marginTop: '0.75rem' }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => { setSearch(''); setStatusFilter('active'); }}
            >
              Clear filters
            </button>
          </div>
        )}
      </div>

      {error && <div className="portal-auth-error" style={{ marginBottom: '1rem' }}>{error}</div>}

      {loading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--steel)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>⏳</div>
          Loading projects…
        </div>
      ) : items.length === 0 ? (
        <div className="dpr-list-empty" style={{ textAlign: 'center', padding: '3rem' }}>
          <div style={{ marginBottom: '1rem', color: 'var(--steel)' }}>
            <BuildingIcon size={48} />
          </div>
          <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", color: 'var(--navy)', marginBottom: '0.5rem' }}>
            No projects yet
          </h3>
          <p style={{ color: 'var(--steel)', marginBottom: '1.5rem', maxWidth: 480, marginLeft: 'auto', marginRight: 'auto' }}>
            They'll be created automatically when you submit a DPR or Inspection.
            Pick any project name on the form and it'll appear here next time.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link to="/portal/dpr/submit" className="btn btn-primary">
              Submit a DPR
            </Link>
            <Link to="/portal/inspection/submit" className="btn btn-secondary">
              File an Inspection
            </Link>
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="dpr-list-empty" style={{ textAlign: 'center', padding: '2rem' }}>
          <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", color: 'var(--navy)', marginBottom: '0.5rem' }}>
            No projects match your filters
          </h3>
          <p style={{ color: 'var(--steel)' }}>
            Try clearing the search or status filter to see all {items.length} project{items.length !== 1 ? 's' : ''}.
          </p>
        </div>
      ) : (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
              gap: '1rem',
            }}
          >
            {filtered.map((p) => {
              const key = p.id || p.name;
              const isExpanded = expandedKey === key;
              return (
                <React.Fragment key={key}>
                  <ProjectCard
                    project={p}
                    isExpanded={isExpanded}
                    onToggle={() => setExpandedKey(isExpanded ? null : key)}
                  />
                  {isExpanded && (
                    <div
                      data-testid="projects-expanded-panel"
                      style={{ gridColumn: '1 / -1' }}
                    >
                      <ProjectExpandedPanel
                        project={p}
                        accessToken={accessToken}
                        onClose={() => setExpandedKey(null)}
                        onOpenProjectDetail={() =>
                          navigate(`/portal/projects/${encodeURIComponent(p.id || p.name)}`)
                        }
                      />
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>
          <div
            className="dpr-list-count"
            style={{ textAlign: 'center', color: 'var(--steel)', fontSize: '0.8rem', padding: '0.75rem 0.5rem' }}
          >
            Showing {filtered.length} of {items.length} project{items.length !== 1 ? 's' : ''}
            {discoveredCount > 0 && registeredCount > 0 ? ` · ${registeredCount} registered, ${discoveredCount} auto-discovered` : ''}
          </div>
        </>
      )}
    </div>
  );
}

// One card. Layout mirrors the admin ProjectCard at
// src/pages/admin/ProjectsAdmin.jsx#RegisteredRow, minus the destructive
// actions (the portal user can't archive projects). The whole card is
// keyboard-navigable via a single button wrapper so screen readers
// announce a single "Open <project>" action per card.
//
// [Round-33] Card is now an accordion trigger — chevron on the right
// flips between expanded/collapsed. The metadata header remains the
// primary button for users who tab-navigate; the chevron is the visual
// affordance.
function ProjectCard({ project, isExpanded, onToggle }) {
  const parties = summarizeParties(project.parties);
  return (
    <div
      className="dpr-card"
      style={{
        padding: '0',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        borderColor: isExpanded ? 'var(--blue, #0066FF)' : undefined,
        boxShadow: isExpanded ? '0 0 0 1px var(--blue, #0066FF)' : undefined,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'stretch' }}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={isExpanded}
          aria-controls={`projects-card-body-${project.id || project.name}`}
          aria-label={`${isExpanded ? 'Collapse' : 'Expand'} project ${project.name}`}
          style={{
            padding: '0.875rem 1rem',
            flex: 1,
            display: 'flex', alignItems: 'flex-start', gap: '0.75rem',
            background: 'white', border: 0, textAlign: 'left', cursor: 'pointer',
            font: 'inherit', color: 'inherit',
          }}
        >
          <div
            aria-hidden="true"
            style={{
              width: 40, height: 40, flexShrink: 0,
              color: project.isRegistered ? 'var(--blue, #0066FF)' : 'var(--amber, #d97706)',
              background: project.isRegistered ? 'rgba(0,102,255,0.08)' : 'rgba(217,119,6,0.08)',
              borderRadius: 10,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <BuildingIcon size={18} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', flexWrap: 'wrap' }}>
              <div
                style={{
                  fontFamily: "'Plus Jakarta Sans', sans-serif",
                  fontWeight: 700, fontSize: '0.95rem',
                  color: 'var(--navy, #0f172a)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  maxWidth: '100%',
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
              {/* Project Assignments: passive team-count badge. Renders only
                  when serializeProject includes a non-empty `assignments`
                  array, so a discovered (name-only) project or an older
                  cached payload simply omits it. No fetch of its own. */}
              {project.assignments && project.assignments.length > 0 ? (
                <span
                  style={{
                    padding: '0.125rem 0.5rem',
                    background: 'var(--blue, #0066FF)', color: 'white',
                    borderRadius: 12, fontSize: '0.75rem', fontWeight: 600,
                  }}
                  title={`${project.assignments.length} employee${project.assignments.length === 1 ? '' : 's'} assigned`}
                >
                  <span aria-hidden="true">👥 </span>
                  {project.assignments.length}
                </span>
              ) : null}
              {!project.isRegistered ? (
                <span style={{
                  fontSize: '0.7rem', fontWeight: 600,
                  color: 'var(--amber, #d97706)',
                  background: 'rgba(217,119,6,0.10)',
                  padding: '1px 6px', borderRadius: 4,
                }}>
                  Not registered
                </span>
              ) : !project.isActive ? (
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
            {(project.client || project.location) && (
              <div style={{ fontSize: '0.78rem', color: 'var(--steel, #64748b)', marginTop: '0.2rem' }}>
                {project.client ? <span>{project.client}</span> : null}
                {project.location ? <span>{project.client ? ' · ' : ''}{project.location}</span> : null}
              </div>
            )}
            {parties && (
              <div style={{ fontSize: '0.72rem', color: 'var(--steel, #64748b)', marginTop: '0.2rem' }}>
                {parties}
              </div>
            )}
            <div
              style={{
                display: 'flex', gap: '0.75rem', alignItems: 'center',
                marginTop: '0.5rem', flexWrap: 'wrap',
                fontSize: '0.78rem', color: 'var(--steel, #64748b)',
              }}
            >
              {project.contractValue != null && project.contractValue !== '' ? (
                <span style={{ fontWeight: 600, color: 'var(--navy, #0f172a)' }}>
                  {formatInr(project.contractValue)}
                </span>
              ) : null}
              {project.startDate ? (
                <span>Start: {formatShortDate(project.startDate)}</span>
              ) : null}
            </div>
          </div>
        </button>
        {/* Chevron toggle button. Separated from the main button so the
            click target is unambiguous and screen readers see a single
            "Expand / Collapse" affordance. */}
        <button
          type="button"
          onClick={onToggle}
          aria-label={`${isExpanded ? 'Collapse' : 'Expand'} project ${project.name}`}
          aria-expanded={isExpanded}
          aria-controls={`projects-card-body-${project.id || project.name}`}
          style={{
            width: 44, flexShrink: 0,
            background: 'white', border: 0, cursor: 'pointer',
            borderLeft: '1px solid rgba(100,116,139,0.10)',
            color: 'var(--steel, #64748b)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 150ms ease',
              fontSize: '1rem',
              lineHeight: 1,
            }}
          >
            ▾
          </span>
        </button>
      </div>
    </div>
  );
}
