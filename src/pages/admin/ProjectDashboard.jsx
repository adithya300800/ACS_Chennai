import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { formatShortDate } from '../../lib/format.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';

// N17 (Project-level dashboard with KPI tiles): PM's daily landing page.
//
// One page that surfaces five roll-up buckets scoped to a single project:
//   1. Daily Reports  — submitted / pending / approved / rejected / drafts
//   2. Inspections    — total (window), open (org-wide), breakdown by type
//   3. Cube Tests     — due in next 7d / overdue / passed
//   4. BOQ Variance   — item count, contract INR, executed INR, variance %
//   5. People         — on leave today, pending leave, overdue training
//
// The KPI endpoint is tolerant — if a sibling roll-up throws (e.g. CubeTest
// or BoqItem migration not yet shipped in some branch) the dashboard still
// renders with that bucket zeroed + a non-blocking warning toast. We treat
// missing data as an empty state rather than a hard error.
//
// N17 design notes (dataviz skill — stat tiles skip the hover layer, but
// colour follows the job):
//   - Status colours are reserved for the four poles (good / warning /
//     serious / critical). We use them only for tile-level colour cues
//     (a red count for "Overdue", a green count for "Approved") and never
//     as decoration.
//   - Text stays in the standard tokens (var(--navy) / var(--steel)) so
//     numbers carry identity, not labels.
//   - Variance % diverges around 0% — green for negative (under contract),
//     red for positive (overrun). Diverging pair, not a rainbow.

// ──── Formatting helpers ──────────────────────────────────────────────────
// INR with Indian-locale grouping (1,23,45,678.90). Used for the BOQ
// contract/executed values. Falls back to 0 for non-numeric input so a
// single bad row doesn't crash the tile.
function formatINR(value) {
  const n = Number(value) || 0;
  return n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

// Variance % → status colour token. Diverging pair around 0%:
//   negative  → under contract (good) → green
//   positive  → overrun (bad)          → red
//   0         → neutral                → steel
// Pinned to status palette so a "green variance" never reads as a brand
// colour reused for the next series.
function varianceColor(percent) {
  const n = Number(percent) || 0;
  if (n < 0) return 'var(--green, #16a34a)';
  if (n > 0) return 'var(--red, #dc2626)';
  return 'var(--steel, #64748b)';
}

// Count → status colour token. Counts of 0 stay neutral; counts > 0 use
// the colour that matches the bucket's polarity. Same status palette
// reservation as varianceColor.
function countColor(value, tone) {
  const n = Number(value) || 0;
  if (n === 0) return 'var(--navy, #0f172a)';
  if (tone === 'good') return 'var(--green, #16a34a)';
  if (tone === 'warning') return 'var(--amber, #d97706)';
  if (tone === 'critical') return 'var(--red, #dc2626)';
  return 'var(--navy, #0f172a)';
}

// Inspection-type slug → human label. Mirrors the labels AdminInspection
// already uses via SUB_WORK_TYPE_OPTIONS; we don't import that here
// because the inspection byType map is keyed by raw enum values and the
// label map is small enough to inline. The fallback to a title-cased slug
// covers any new enum the backend adds before the frontend catches up.
function prettyInspectionType(slug) {
  if (!slug) return '';
  return String(slug)
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// One KPI tile — large number + label + optional sub-line. The icon is
// a small SVG bubble that mirrors AdminOverview's icon chip aesthetic
// (44×44, 10px radius, blue tint background).
function StatTile({ icon, number, label, tone = 'neutral', sub }) {
  // tone ∈ 'neutral' | 'good' | 'warning' | 'critical' — maps to the
  // status palette. Icons stay in the blue brand colour regardless of
  // tone — only the NUMBER shifts colour so a red "Overdue" tile reads
  // as a problem, not the whole card.
  const colorMap = {
    neutral: 'var(--navy, #0f172a)',
    good: 'var(--green, #16a34a)',
    warning: 'var(--amber, #d97706)',
    critical: 'var(--red, #dc2626)',
  };
  const numColor = colorMap[tone] || colorMap.neutral;
  return (
    <div
      className="dpr-card"
      style={{
        padding: '1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
        minHeight: 110,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
        <div
          aria-hidden="true"
          style={{
            color: 'var(--blue, #0066FF)',
            width: 36, height: 36, flexShrink: 0,
            background: 'rgba(0,102,255,0.08)',
            borderRadius: 8,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          {icon}
        </div>
        <div
          style={{
            fontFamily: "'Plus Jakarta Sans', sans-serif",
            fontWeight: 700,
            fontSize: '1.75rem',
            lineHeight: 1,
            color: numColor,
          }}
        >
          {number}
        </div>
      </div>
      <div
        style={{
          fontFamily: "'Plus Jakarta Sans', sans-serif",
          fontWeight: 600,
          fontSize: '0.85rem',
          color: 'var(--navy, #0f172a)',
        }}
      >
        {label}
      </div>
      {sub ? (
        <div style={{ fontSize: '0.78rem', color: 'var(--steel, #64748b)' }}>{sub}</div>
      ) : null}
    </div>
  );
}

// SVG icons — line strokes match AdminOverview's ICONS map (1.75px,
// round caps, no fill). All 16x16 / 20x20 — they sit inside a 36px chip
// so a smaller-than-AdminOverview size keeps the tile compact.
const ICONS = {
  dpr: (
    <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  ),
  check: (
    <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
    </svg>
  ),
  pending: (
    <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  reject: (
    <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" /><line x1="9" y1="9" x2="15" y2="15" /><line x1="15" y1="9" x2="9" y2="15" />
    </svg>
  ),
  draft: (
    <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  ),
  inspection: (
    <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),
  cube: (
    <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  ),
  // Variants below tone-shift their chip background in subtle ways so a
  // reader can scan the column by row colour rather than reading every
  // number.
  money: (
    <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
      <line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" />
    </svg>
  ),
  calendar: (
    <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  ),
  refresh: (
    <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
    </svg>
  ),
  building: (
    <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="21" x2="9" y2="9" />
    </svg>
  ),
  person: (
    <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" />
    </svg>
  ),
};

// ──── The dashboard component ─────────────────────────────────────────────
export default function ProjectDashboard() {
  useDocumentTitle('Project Dashboard');
  const { accessToken } = useAuth();
  const toast = useToast();

  // Project list (the dropdown source). Cached for the lifetime of the
  // page so a window-selector change doesn't re-fetch the list.
  const [projects, setProjects] = useState([]);
  const [discovered, setDiscovered] = useState([]);
  const [loadingProjects, setLoadingProjects] = useState(true);

  // Currently-selected project. `null` = no selection yet → empty state.
  // We key by name (string) so an unregistered project can still be the
  // selection — the backend's `idOrName` resolver accepts both, and the
  // dashboard needs to show KPIs for "T-Nagar / Phase II" before an
  // admin has registered it as a formal Project row.
  const [selectedProject, setSelectedProject] = useState(null);

  // KPI payload from /api/projects/:idOrName/kpis
  const [kpis, setKpis] = useState(null);
  const [loadingKpis, setLoadingKpis] = useState(false);
  const [kpisError, setKpisError] = useState('');

  // Lookback window in days. 30 = default. "all" is sent as 365 — the
  // backend clamps to 365 and we surface that in the window sub-line.
  const [days, setDays] = useState(30);

  // Mounted-ref guard so a fast project-switch (click-select-click) can't
  // fire two KPI calls and let a stale response overwrite the fresh one.
  // Same defensive pattern as Round-26's InspectionSubmit (live bug #2).
  const mountedRef = useRef(true);

  // Initial project list fetch. Auto-selects the first registered
  // project so the PM lands on KPIs, not the empty state. If the list
  // is empty (no registered projects yet) the dropdown stays empty and
  // the empty state appears — that's the right behaviour for a fresh
  // portal.
  const loadProjects = useCallback(async () => {
    setLoadingProjects(true);
    try {
      const data = await api.getProjects(accessToken);
      if (!mountedRef.current) return;
      const list = data.projects || [];
      const disc = data.discovered || [];
      setProjects(list);
      setDiscovered(disc);
      // Auto-select first project (registered wins over discovered —
      // they have richer metadata).
      if (!selectedProject && list.length > 0) {
        setSelectedProject({ id: list[0].id, name: list[0].name, isRegistered: true });
      } else if (!selectedProject && disc.length > 0) {
        setSelectedProject({ id: null, name: disc[0].name, isRegistered: false });
      }
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err?.message || 'Failed to load projects';
      toast.pushToast({ message: msg, tone: 'error' });
    } finally {
      if (mountedRef.current) setLoadingProjects(false);
    }
  }, [accessToken, toast, selectedProject]);

  // KPI fetch — depends on (selectedProject, days). Aborts on unmount.
  const loadKpis = useCallback(async () => {
    if (!selectedProject) return;
    setLoadingKpis(true);
    setKpisError('');
    try {
      // The backend accepts id OR name. We forward whichever we have —
      // id first if registered, otherwise the name. encodeURIComponent
      // inside api.getProjectKpis handles spaces + slashes.
      const ref = selectedProject.id || selectedProject.name;
      const data = await api.getProjectKpis(ref, days, accessToken);
      if (!mountedRef.current) return;
      setKpis(data);
      // If the backend reported warnings (a sibling roll-up failed),
      // surface the first one as a non-blocking toast. The dashboard
      // still renders — the missing bucket just shows zeros + an empty
      // state sub-line.
      if (Array.isArray(data.warnings) && data.warnings.length > 0) {
        toast.pushToast({
          message: `Some KPIs could not be loaded: ${data.warnings[0]}`,
          tone: 'warning',
        });
      }
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err?.message || 'Failed to load KPIs';
      setKpisError(msg);
      toast.pushToast({ message: msg, tone: 'error' });
    } finally {
      if (mountedRef.current) setLoadingKpis(false);
    }
  }, [selectedProject, days, accessToken, toast]);

  // Effects — mount guard + refresh-on-focus so a quick review + back
  // shows fresh counts without a manual reload (same pattern as
  // AdminOverview).
  useEffect(() => {
    mountedRef.current = true;
    loadProjects();
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        loadProjects();
        loadKpis();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      mountedRef.current = false;
      document.removeEventListener('visibilitychange', onVis);
    };
  // We intentionally re-bind this effect when loadProjects/loadKpis
  // identities change so the visibility handler always sees the freshest
  // closures (avoids the "stale callback" trap after login).
  }, [loadProjects, loadKpis]);

  // When the selection or window changes, kick a fresh KPI load. The
  // mountedRef guard inside loadKpis prevents a race between the old
  // fetch (in flight when the user clicked) and the new one.
  useEffect(() => {
    if (selectedProject) loadKpis();
  }, [selectedProject, days, loadKpis]);

  // ── Render ─────────────────────────────────────────────────────────────
  // Combined options for the project dropdown. Registered projects come
  // first (they have richer metadata); discovered names follow as a
  // separate "Discovered" optgroup so the admin can see which projects
  // haven't been registered yet.
  const combinedOptions = useMemo(() => {
    const reg = projects.map((p) => ({
      id: p.id, name: p.name, isRegistered: true,
      code: p.code, client: p.client, location: p.location,
    }));
    const disc = discovered.map((d) => ({
      id: null, name: d.name, isRegistered: false,
    }));
    return { registered: reg, discovered: disc };
  }, [projects, discovered]);

  return (
    <div className="dpr-page">
      {/* Page header — title + project selector + window + refresh.
          The selector is the primary control: PMs arrive wanting "today's
          numbers for Project X", and changing the project is the most
          common interaction. */}
      <div className="dpr-page-header">
        <div>
          <h1 className="dpr-page-title" aria-label="Project Dashboard">Project Dashboard</h1>
          <p className="dpr-page-sub" style={{ color: 'var(--steel)', margin: 0, fontSize: '0.9rem' }}>
            KPIs across DPR, Inspections, Cube Tests, BOQ, and People — scoped to a single project.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <label htmlFor="project-select" style={{ position: 'absolute', left: -9999 }}>Project</label>
          <select
            id="project-select"
            value={selectedProject ? (selectedProject.id || `name:${selectedProject.name}`) : ''}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return;
              // Selector values: UUID for registered, "name:<x>" for discovered.
              if (v.startsWith('name:')) {
                setSelectedProject({ id: null, name: v.slice(5), isRegistered: false });
              } else {
                const p = projects.find((x) => x.id === v);
                if (p) setSelectedProject({ id: p.id, name: p.name, isRegistered: true });
              }
            }}
            disabled={loadingProjects}
            aria-label="Select project"
            style={{
              padding: '0.5rem 0.75rem',
              border: '1px solid var(--steel, #cbd5e1)',
              borderRadius: 8,
              fontSize: '0.9rem',
              background: 'white',
              minWidth: 240,
            }}
          >
            <option value="" disabled>Select a project…</option>
            <optgroup label="Registered">
              {combinedOptions.registered.map((p) => (
                <option key={p.id} value={p.id}>{p.name}{p.code ? ` (${p.code})` : ''}</option>
              ))}
            </optgroup>
            {combinedOptions.discovered.length > 0 && (
              <optgroup label="Discovered (not yet registered)">
                {combinedOptions.discovered.map((p) => (
                  <option key={`name:${p.name}`} value={`name:${p.name}`}>{p.name}</option>
                ))}
              </optgroup>
            )}
          </select>
          <label htmlFor="days-select" style={{ position: 'absolute', left: -9999 }}>Window</label>
          <select
            id="days-select"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            aria-label="Window"
            style={{
              padding: '0.5rem 0.75rem',
              border: '1px solid var(--steel, #cbd5e1)',
              borderRadius: 8,
              fontSize: '0.9rem',
              background: 'white',
            }}
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last 365 days</option>
          </select>
          <button
            type="button"
            onClick={() => { loadProjects(); loadKpis(); }}
            disabled={loadingKpis || loadingProjects}
            aria-label="Refresh"
            title="Refresh"
            style={{
              padding: '0.5rem 0.75rem',
              border: '1px solid var(--steel, #cbd5e1)',
              borderRadius: 8,
              background: 'white',
              cursor: (loadingKpis || loadingProjects) ? 'not-allowed' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.4rem',
              fontSize: '0.85rem',
            }}
          >
            {ICONS.refresh}
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Body — three branches:
          1. No project selected yet → empty state
          2. Project selected + KPIs loaded → tile grid
          3. Project selected but KPIs failed → error state with retry */}
      {!selectedProject ? (
        <EmptyState />
      ) : kpisError ? (
        <ErrorState message={kpisError} onRetry={loadKpis} />
      ) : (
        <ProjectKpiView
          kpis={kpis}
          loading={loadingKpis}
          selectedProject={selectedProject}
          days={days}
        />
      )}
    </div>
  );
}

// ──── Empty state ─────────────────────────────────────────────────────────
// Shown when no project is selected — typically only on the very first
// render before the auto-select kicks in, or when the project list is
// empty (fresh portal, no DPRs filed yet). Two CTAs: admin can create a
// project, or wait for DPRs to be filed (which auto-discovers a name).
function EmptyState() {
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
          fontWeight: 700,
          fontSize: '1.05rem',
          color: 'var(--navy, #0f172a)',
          marginBottom: '0.4rem',
        }}
      >
        No project selected
      </div>
      <div style={{ fontSize: '0.9rem', marginBottom: '1rem', lineHeight: 1.5 }}>
        Pick a project from the dropdown above to see its KPI tiles, or register a new project to get started.
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <Link
          to="/portal/admin/projects/new"
          className="dpr-card"
          style={{
            padding: '0.5rem 0.875rem',
            textDecoration: 'none',
            color: 'var(--blue, #0066FF)',
            fontWeight: 600,
            fontSize: '0.9rem',
            background: 'rgba(0,102,255,0.08)',
            borderRadius: 8,
          }}
        >
          + New Project
        </Link>
        <Link
          to="/portal/admin/projects"
          className="dpr-card"
          style={{
            padding: '0.5rem 0.875rem',
            textDecoration: 'none',
            color: 'var(--steel, #64748b)',
            fontWeight: 600,
            fontSize: '0.9rem',
            background: 'rgba(100,116,139,0.08)',
            borderRadius: 8,
          }}
        >
          Browse all projects
        </Link>
      </div>
    </div>
  );
}

// Error state — backend 5xx or network error. Mirrors the InspectionList
// retry pattern: keep the page chrome, surface a clear message, offer a
// retry button. No back-to-overview link — admin can change the project
// from the dropdown to recover.
function ErrorState({ message, onRetry }) {
  return (
    <div
      className="dpr-card"
      style={{
        padding: '2rem',
        textAlign: 'center',
        color: 'var(--red, #dc2626)',
      }}
    >
      <div
        style={{
          fontFamily: "'Plus Jakarta Sans', sans-serif",
          fontWeight: 700,
          fontSize: '1rem',
          marginBottom: '0.5rem',
        }}
      >
        Couldn&rsquo;t load KPIs
      </div>
      <div style={{ fontSize: '0.85rem', color: 'var(--steel, #64748b)', marginBottom: '1rem' }}>
        {message || 'Please try again in a moment.'}
      </div>
      <button
        type="button"
        onClick={onRetry}
        style={{
          padding: '0.5rem 0.875rem',
          border: '1px solid var(--steel, #cbd5e1)',
          borderRadius: 8,
          background: 'white',
          cursor: 'pointer',
          fontSize: '0.9rem',
        }}
      >
        Try again
      </button>
    </div>
  );
}

// ──── KPI view (5 grouped tile sections) ──────────────────────────────────
// Renders once `kpis` is loaded. Each section has its own grid that
// collapses to a single column on mobile (the auto-fill minmax below
// already collapses — single tile row fits 1 card on a 320px viewport).
function ProjectKpiView({ kpis, loading, selectedProject, days }) {
  if (loading && !kpis) {
    return (
      <div className="dpr-card" style={{ padding: '2rem', textAlign: 'center', color: 'var(--steel, #64748b)' }}>
        Loading KPIs&hellip;
      </div>
    );
  }
  if (!kpis) return null;

  const project = kpis.project || {};
  const isDiscovered = project.isRegistered === false;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {/* Project header card. Discovered projects (no Project row yet)
          render with a "not yet registered" badge and a CTA to register
          so the dashboard never silently shows data for an unknown
          project. */}
      <div className="dpr-card" style={{ padding: '1rem 1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
          <div
            aria-hidden="true"
            style={{
              width: 48, height: 48, flexShrink: 0,
              color: 'var(--blue, #0066FF)',
              background: 'rgba(0,102,255,0.08)',
              borderRadius: 10,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            {ICONS.building}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              <div
                style={{
                  fontFamily: "'Plus Jakarta Sans', sans-serif",
                  fontWeight: 700, fontSize: '1.1rem',
                  color: 'var(--navy, #0f172a)',
                }}
              >
                {project.name || selectedProject.name}
              </div>
              {project.code ? (
                <span
                  style={{
                    fontSize: '0.7rem',
                    fontWeight: 600,
                    color: 'var(--steel, #64748b)',
                    background: 'rgba(100,116,139,0.10)',
                    padding: '2px 6px',
                    borderRadius: 4,
                    letterSpacing: '0.04em',
                  }}
                >
                  {project.code}
                </span>
              ) : null}
              {isDiscovered ? (
                <span
                  style={{
                    fontSize: '0.7rem',
                    fontWeight: 600,
                    color: 'var(--amber, #d97706)',
                    background: 'rgba(217,119,6,0.10)',
                    padding: '2px 6px',
                    borderRadius: 4,
                  }}
                >
                  Not yet registered
                </span>
              ) : null}
            </div>
            <div
              style={{
                fontSize: '0.85rem',
                color: 'var(--steel, #64748b)',
                marginTop: '0.25rem',
                display: 'flex', flexWrap: 'wrap', gap: '0.75rem',
              }}
            >
              {project.client ? <span>Client: <strong style={{ color: 'var(--navy, #0f172a)' }}>{project.client}</strong></span> : null}
              {project.location ? <span>Location: <strong style={{ color: 'var(--navy, #0f172a)' }}>{project.location}</strong></span> : null}
              {project.startDate ? <span>Start: <strong style={{ color: 'var(--navy, #0f172a)' }}>{formatShortDate(project.startDate)}</strong></span> : null}
              {project.expectedEndDate ? <span>Expected end: <strong style={{ color: 'var(--navy, #0f172a)' }}>{formatShortDate(project.expectedEndDate)}</strong></span> : null}
            </div>
          </div>
          <div style={{ fontSize: '0.78rem', color: 'var(--steel, #64748b)' }}>
            <div>Window: <strong style={{ color: 'var(--navy, #0f172a)' }}>{kpis.window?.from} → {kpis.window?.to}</strong></div>
            <div>{kpis.window?.days} day{kpis.window?.days === 1 ? '' : 's'}</div>
          </div>
        </div>
        {isDiscovered ? (
          <div style={{ marginTop: '0.75rem', fontSize: '0.85rem' }}>
            <Link
              to={`/portal/admin/projects/new?name=${encodeURIComponent(project.name)}`}
              style={{ color: 'var(--blue, #0066FF)', fontWeight: 600 }}
            >
              Register this project →
            </Link>
          </div>
        ) : null}
      </div>

      {/* Five KPI sections. Each one matches the AdminOverview
          TileSection aesthetic (uppercase section label + auto-fill
          tile grid) so the visual language stays consistent. */}
      <TileSection title="Daily Reports">
        <StatTile
          icon={ICONS.dpr}
          number={kpis.dpr?.submittedCount ?? 0}
          label="Submitted"
          sub={`${kpis.dpr?.pendingReviewCount ?? 0} awaiting review`}
        />
        <StatTile
          icon={ICONS.pending}
          number={kpis.dpr?.pendingReviewCount ?? 0}
          label="Pending Review"
          tone={(kpis.dpr?.pendingReviewCount ?? 0) > 0 ? 'warning' : 'neutral'}
          sub="Submitted + Under Review"
        />
        <StatTile
          icon={ICONS.check}
          number={kpis.dpr?.approvedCount ?? 0}
          label="Approved"
          tone={(kpis.dpr?.approvedCount ?? 0) > 0 ? 'good' : 'neutral'}
        />
        <StatTile
          icon={ICONS.reject}
          number={kpis.dpr?.rejectedCount ?? 0}
          label="Rejected"
          tone={(kpis.dpr?.rejectedCount ?? 0) > 0 ? 'critical' : 'neutral'}
        />
        <StatTile
          icon={ICONS.draft}
          number={kpis.dpr?.draftCount ?? 0}
          label="Drafts"
          sub="Owner-only, not yet submitted"
        />
      </TileSection>

      <TileSection title="Inspections">
        <StatTile
          icon={ICONS.inspection}
          number={kpis.inspections?.totalCount ?? 0}
          label="Total (window)"
          sub={`${kpis.inspections?.openCount ?? 0} currently open`}
        />
        <StatTile
          icon={ICONS.pending}
          number={kpis.inspections?.openCount ?? 0}
          label="Open"
          tone={(kpis.inspections?.openCount ?? 0) > 0 ? 'warning' : 'neutral'}
          sub="Across all of this project"
        />
        {/* Breakdown by inspection type — small chips, one per type. We
            pin this as a full-width tile (not the 320px minmax grid)
            because chip flow is the right shape for "5 different counts
            with no fixed row length". */}
        <div className="dpr-card" style={{ padding: '1rem', gridColumn: '1 / -1' }}>
          <div
            style={{
              fontFamily: "'Plus Jakarta Sans', sans-serif",
              fontWeight: 600,
              fontSize: '0.85rem',
              color: 'var(--navy, #0f172a)',
              marginBottom: '0.5rem',
            }}
          >
            By type
          </div>
          {Object.keys(kpis.inspections?.byType || {}).length === 0 ? (
            <div style={{ fontSize: '0.85rem', color: 'var(--steel, #64748b)' }}>
              No inspections recorded in this window yet.
            </div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
              {Object.entries(kpis.inspections.byType).map(([type, count]) => (
                <span
                  key={type}
                  style={{
                    fontSize: '0.78rem',
                    fontWeight: 600,
                    color: 'var(--navy, #0f172a)',
                    background: 'rgba(0,102,255,0.08)',
                    padding: '4px 10px',
                    borderRadius: 999,
                  }}
                >
                  {prettyInspectionType(type)}: {count}
                </span>
              ))}
            </div>
          )}
        </div>
      </TileSection>

      <TileSection title="Cube Tests">
        <StatTile
          icon={ICONS.cube}
          number={kpis.cubeTests?.dueSoonCount ?? 0}
          label="Due Soon"
          tone={(kpis.cubeTests?.dueSoonCount ?? 0) > 0 ? 'warning' : 'neutral'}
          sub="28-day tests in next 7 days"
        />
        <StatTile
          icon={ICONS.pending}
          number={kpis.cubeTests?.overdueCount ?? 0}
          label="Overdue"
          tone={(kpis.cubeTests?.overdueCount ?? 0) > 0 ? 'critical' : 'neutral'}
        />
        <StatTile
          icon={ICONS.check}
          number={kpis.cubeTests?.passedCount ?? 0}
          label="Passed"
          tone={(kpis.cubeTests?.passedCount ?? 0) > 0 ? 'good' : 'neutral'}
          sub="28-day result reported"
        />
        {/* Empty-state sub-line when N5 (CubeTest) hasn't shipped yet —
          the backend's defensive catch returns zeros, so we can't
          distinguish "no tests" from "feature not yet present". Pin a
          gentle hint either way. */}
        {(kpis.cubeTests?.dueSoonCount ?? 0) === 0
          && (kpis.cubeTests?.overdueCount ?? 0) === 0
          && (kpis.cubeTests?.passedCount ?? 0) === 0 ? (
          <div className="dpr-card" style={{ padding: '0.75rem 1rem', gridColumn: '1 / -1', fontSize: '0.82rem', color: 'var(--steel, #64748b)' }}>
            No cube tests recorded for this project yet.
          </div>
        ) : null}
      </TileSection>

      <TileSection title="BOQ Variance">
        <StatTile
          icon={ICONS.cube}
          number={kpis.boqVariance?.itemsCount ?? 0}
          label="Items"
          sub="Active line items in BOQ"
        />
        <StatTile
          icon={ICONS.money}
          number={`₹${formatINR(kpis.boqVariance?.totalContractValue ?? 0)}`}
          label="Contract Value"
        />
        <StatTile
          icon={ICONS.money}
          number={`₹${formatINR(kpis.boqVariance?.totalExecutedValue ?? 0)}`}
          label="Executed Value"
        />
        <StatTile
          icon={ICONS.money}
          number={`${(Number(kpis.boqVariance?.variancePercent) || 0).toFixed(1)}%`}
          label="Variance"
          // Diverging colour: green if under contract (negative),
          // red if overrun (positive), neutral at zero.
          tone={
            Number(kpis.boqVariance?.variancePercent) < 0 ? 'good'
              : Number(kpis.boqVariance?.variancePercent) > 0 ? 'critical'
              : 'neutral'
          }
          sub="Negative = under contract (good)"
          // Override the stat-tile colour to use the diverging pair.
          // countColor/varianceColor share the same reservation so this
          // is consistent with the tile-level tones.
        />
        {(kpis.boqVariance?.itemsCount ?? 0) === 0 ? (
          <div className="dpr-card" style={{ padding: '0.75rem 1rem', gridColumn: '1 / -1', fontSize: '0.82rem', color: 'var(--steel, #64748b)' }}>
            No BOQ line items recorded for this project yet.
          </div>
        ) : null}
      </TileSection>

      <TileSection title="People">
        <StatTile
          icon={ICONS.person}
          number={kpis.people?.onLeaveToday ?? 0}
          label="On Leave Today"
          sub="Approved leave active today"
        />
        <StatTile
          icon={ICONS.pending}
          number={kpis.people?.pendingLeaveCount ?? 0}
          label="Pending Leave"
          tone={(kpis.people?.pendingLeaveCount ?? 0) > 0 ? 'warning' : 'neutral'}
          sub="Awaiting approval"
        />
        <StatTile
          icon={ICONS.pending}
          number={kpis.people?.overdueTrainingCount ?? 0}
          label="Overdue Training"
          tone={(kpis.people?.overdueTrainingCount ?? 0) > 0 ? 'critical' : 'neutral'}
          sub="Past their due date"
        />
      </TileSection>

      {/* Footer line — meta info for the data the user just looked at.
          Helps when a PM shares a screenshot in a meeting ("these are
          the numbers as of …"). */}
      <div style={{ fontSize: '0.78rem', color: 'var(--steel, #64748b)', textAlign: 'center' }}>
        Window: {days === 365 ? 'Last 365 days' : `Last ${days} day${days === 1 ? '' : 's'}`} · Loaded {loading ? 'in progress…' : 'fresh'}
      </div>
    </div>
  );
}

// TileSection — same uppercase label + auto-fill grid pattern used by
// AdminOverview. Keeps the visual language consistent across the
// admin pages.
function TileSection({ title, children }) {
  return (
    <section>
      <h2
        style={{
          fontFamily: "'Plus Jakarta Sans', sans-serif",
          fontSize: '0.78rem',
          fontWeight: 700,
          color: 'var(--steel, #64748b)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          margin: '0 0 0.6rem',
        }}
      >
        {title}
      </h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: '0.75rem',
        }}
      >
        {children}
      </div>
    </section>
  );
}