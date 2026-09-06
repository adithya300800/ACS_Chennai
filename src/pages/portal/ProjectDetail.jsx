import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { BuildingIcon, ClipboardIcon, CameraIcon, MapPinIcon, DocIcon, BookIcon } from '../../components/Icons.jsx';
import { formatShortDate } from '../../lib/format.js';

// [N1 Phase B] Project detail — the anchor page at /portal/projects/:id.
//
// Layout: header (name + code + status), then a single Overview card with
// the four metadata pieces (parties / sites / contractValue / description),
// then a tab strip that links OUT to the existing admin pages filtered
// by projectId. We deliberately don't re-implement the BOQ / DPR /
// Inspection / RFI / Variation / Drawing tables on this page — those
// already exist as full pages and a tab that deep-links + URL-filters them
// is the cheaper, more consistent UX. RFI / Variation / Drawing are
// placeholders for now (Phase D / F are separate sub-agents — see
// instructions) so the tab strip renders them as a "coming soon" pill.

// Tabs visible to everyone. The "active" tab is tracked locally — we
// don't put it in the URL because the body content is just a meta
// summary, not a per-tab resource. (The actual per-resource filters go
// through the linked admin page's `?projectId=…` URL param instead.)
const TABS = [
  { id: 'overview',  label: 'Overview',    Icon: BuildingIcon,     always: true  },
  { id: 'boq',       label: 'BOQ',         Icon: BookIcon,         always: true  },
  { id: 'dprs',      label: 'DPRs',        Icon: DocIcon,          always: true  },
  { id: 'inspections', label: 'Inspections', Icon: ClipboardIcon,   always: true  },
  // Round-28 Bug 3: RFIs / Variations / Drawings tabs were hidden because
  // they 404'd for employees. They've since shipped as admin-only modules
  // (/portal/admin/rfis, /portal/admin/variations, /portal/admin/drawings)
  // but no employee-scoped page exists yet. Rather than carry dead tabs
  // in the strip, hide them and surface a single "Coming soon" badge
  // in the page header so employees know the modules exist but aren't
  // surfacing broken links. Reintroduce when employee-scoped views ship.
];

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

export default function ProjectDetail() {
  const { id: idOrName } = useParams();
  const navigate = useNavigate();
  const { accessToken, employee } = useAuth();
  const toast = useToast();
  const mountedRef = useRef(true);

  const [project, setProject] = useState(null);
  const [parties, setParties] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // `activeTab` is a local UI state — the body always shows the same
  // Overview content, and the tab buttons are quick links out to the
  // admin pages (the BOQ/DPR/Inspection tabs don't render their own
  // tables here). We track the active one for the "active" pill.
  const [activeTab, setActiveTab] = useState('overview');

  const load = useCallback(async () => {
    if (!idOrName) return;
    setLoading(true);
    setError('');
    try {
      // Fire the project lookup + the metadata (parties) lookup in
      // parallel — the anchor page needs both. /:idOrName/parties
      // returns 200 with isRegistered=false for a discovered project
      // (name only, no Project row) so the metadata block renders the
      // "not registered" empty state instead of 404ing.
      const [proj, parts] = await Promise.all([
        api.getProject(idOrName, accessToken),
        api.getProjectParties(idOrName, accessToken),
      ]);
      if (!mountedRef.current) return;
      setProject(proj);
      setParties(parts);
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err?.message || 'Failed to load project';
      setError(msg);
      if (err?.status !== 401) toast.push(msg, 'error');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [idOrName, accessToken, toast]);

  useEffect(() => {
    mountedRef.current = true;
    load();
    return () => { mountedRef.current = false; };
  }, [load]);

  // useDocumentTitle fires on the project name once it lands; falls
  // back to a generic title while the lookup is in flight. Calling the
  // hook unconditionally on every render is the documented contract
  // for useDocumentTitle (see src/hooks/useDocumentTitle.js).
  useDocumentTitle(project?.name ? `${project.name} · Project` : 'Project');

  // Tab click handler. Round-28 Bug 2a: route to the EMPLOYEE browse
  // pages (not the admin pages) so employees aren't bounced to the
  // admin guard. The browse pages accept ?projectId= as a filter
  // (DprAll, InspectionAll). For BOQ, BoqVariance takes a free-text
  // projectName — we pass the project name through ?projectName= and
  // also pre-populate the input via the URL hash so the page renders
  // results without the user having to click "Show variance".
  const handleTabClick = useCallback((tab) => {
    setActiveTab(tab.id);
    if (tab.comingSoon) return;
    const pid = encodeURIComponent(project?.id || idOrName);
    const projectName = encodeURIComponent(project?.name || idOrName);
    switch (tab.id) {
      case 'boq':
        // BoqVariance pre-fills via ?projectName= and applies on mount.
        navigate(`/portal/boq?projectName=${projectName}`);
        break;
      case 'dprs':
        navigate(`/portal/dpr/all?projectId=${pid}`);
        break;
      case 'inspections':
        navigate(`/portal/inspection/all?projectId=${pid}`);
        break;
      case 'overview':
      default:
        document.getElementById('project-overview')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
    }
  }, [navigate, project, idOrName]);

  if (loading) {
    return (
      <div className="dpr-page">
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--steel)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>⏳</div>
          Loading project…
        </div>
      </div>
    );
  }

  if (error && !project) {
    return (
      <div className="dpr-page">
        <div className="dpr-page-header">
          <Breadcrumb items={[{ label: 'Projects', to: '/portal/projects' }, { label: 'Not found' }]} />
          <h1 className="dpr-page-title">Project not found</h1>
        </div>
        <div className="dpr-card" style={{ padding: '1.5rem', textAlign: 'center' }}>
          <p style={{ color: 'var(--steel)', marginBottom: '1rem' }}>{error}</p>
          <Link to="/portal/projects" className="btn btn-primary">
            ← Back to projects
          </Link>
        </div>
      </div>
    );
  }

  // Project may still be null if the lookup returned a discovered
  // (name-only) payload — render with what we have. Parties endpoint
  // also returns isRegistered=false in that case.
  const p = project || { name: idOrName, isRegistered: false, isActive: true };
  const isRegistered = parties?.isRegistered !== false && !!p.id;

  return (
    <div className="dpr-page">
      <div className="dpr-page-header">
        <div>
          <Breadcrumb
            items={[
              { label: 'Projects', to: '/portal/projects' },
              { label: p.name || 'Project' },
            ]}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
            <h1 className="dpr-page-title" style={{ margin: 0 }}>{p.name}</h1>
            {p.code ? (
              <span style={{
                fontSize: '0.78rem', fontWeight: 600,
                color: 'var(--steel, #64748b)',
                background: 'rgba(100,116,139,0.10)',
                padding: '2px 8px', borderRadius: 4,
              }}>
                {p.code}
              </span>
            ) : null}
            {!isRegistered ? (
              <span style={{
                fontSize: '0.78rem', fontWeight: 600,
                color: 'var(--amber, #d97706)',
                background: 'rgba(217,119,6,0.10)',
                padding: '2px 8px', borderRadius: 4,
              }}>
                Not registered
              </span>
            ) : p.isActive === false ? (
              <span style={{
                fontSize: '0.78rem', fontWeight: 600,
                color: 'var(--steel, #64748b)',
                background: 'rgba(100,116,139,0.10)',
                padding: '2px 8px', borderRadius: 4,
              }}>
                Inactive
              </span>
            ) : (
              <span style={{
                fontSize: '0.78rem', fontWeight: 600,
                color: 'var(--success, #16a34a)',
                background: 'rgba(22,163,74,0.10)',
                padding: '2px 8px', borderRadius: 4,
              }}>
                Active
              </span>
            )}
          </div>
          {p.client || p.location ? (
            <p className="dpr-page-sub" style={{ color: 'var(--steel)', margin: '0.4rem 0 0', fontSize: '0.9rem' }}>
              {p.client ? <span>{p.client}</span> : null}
              {p.client && p.location ? ' · ' : ''}
              {p.location ? <span>{p.location}</span> : null}
            </p>
          ) : null}
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {/* Round-28 Bug 8: only surface "+ New DPR/Inspection" to
              non-admin employees. Admins triage via the admin queue
              rather than authoring; showing them author buttons
              invites accidental submissions and clutters the page. */}
          {!employee?.isAdmin && (
            <>
              <Link to={`/portal/dpr/submit?projectName=${encodeURIComponent(p.name || '')}`} className="btn btn-secondary btn-sm">
                + New DPR
              </Link>
              <Link to={`/portal/inspection/submit?projectName=${encodeURIComponent(p.name || '')}`} className="btn btn-secondary btn-sm">
                + New Inspection
              </Link>
            </>
          )}
        </div>
      </div>

      {/* Round-28 Bug 6: a single auto-discovered banner above the tab
          strip so the user lands with the context ("this isn't a real
          project row yet") rather than discovering it on the Overview
          tab. Admin sees an extra "Register this project" CTA. */}
      {!isRegistered && (
        <div
          className="dpr-card"
          style={{
            padding: '0.625rem 0.875rem',
            marginBottom: '0.75rem',
            background: 'rgba(245, 158, 11, 0.06)',
            borderLeft: '3px solid var(--amber, #d97706)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: '1.05rem' }} aria-hidden="true">🛈</span>
          <span style={{ fontSize: '0.85rem', color: 'var(--navy, #0f172a)' }}>
            <strong>Auto-discovered project.</strong> No client, location, or
            contract details yet. An admin needs to formally register it.
          </span>
          {employee?.isAdmin && (
            <Link
              to={`/portal/admin/projects/new?name=${encodeURIComponent(p.name || '')}`}
              className="btn btn-secondary btn-sm"
              style={{ marginLeft: 'auto' }}
            >
              Register this project →
            </Link>
          )}
        </div>
      )}

      {/* Tab strip. The BOQ / DPRs / Inspections tabs are live links to
          the existing admin pages with a projectId URL param. */}
      <div
        className="dpr-card"
        style={{
          padding: 0,
          marginBottom: '1rem',
          overflowX: 'auto',
        }}
        role="tablist"
        aria-label="Project sections"
      >
        <div
          style={{
            display: 'flex',
            gap: '0.25rem',
            padding: '0.5rem',
            minWidth: 'max-content',
          }}
        >
          {TABS.map((tab) => {
            const Icon = tab.Icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls="project-tabpanel"
                onClick={() => handleTabClick(tab)}
                className={`btn btn-sm ${isActive ? 'btn-primary' : 'btn-ghost'}`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
              >
                <Icon size={14} />
                <span>{tab.label}</span>
                {tab.comingSoon ? (
                  <span
                    style={{
                      fontSize: '0.65rem', fontWeight: 600,
                      color: 'var(--steel, #64748b)',
                      background: 'rgba(100,116,139,0.10)',
                      padding: '1px 5px', borderRadius: 3,
                      marginLeft: '0.25rem',
                    }}
                  >
                    Soon
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab panel — always renders the Overview content here. The live
          tabs (BOQ / DPRs / Inspections) navigate away to the admin
          pages; the Overview tab is the only one that stays in place. */}
      <div id="project-tabpanel" role="tabpanel" aria-labelledby={`tab-${activeTab}`}>
        {activeTab === 'overview' && (
          <OverviewPanel project={p} parties={parties} isRegistered={isRegistered} />
        )}
        {activeTab === 'boq' && (
          <TabLinkNotice
            tab="BOQ"
            href={`/portal/admin/boq?projectName=${encodeURIComponent(p.id || p.name)}`}
          />
        )}
        {activeTab === 'dprs' && (
          <TabLinkNotice
            tab="DPRs"
            href={`/portal/admin/dpr?projectId=${encodeURIComponent(p.id || p.name)}`}
          />
        )}
        {activeTab === 'inspections' && (
          <TabLinkNotice
            tab="Inspections"
            href={`/portal/admin/inspection?projectId=${encodeURIComponent(p.id || p.name)}`}
          />
        )}
        {(activeTab === 'rfis' || activeTab === 'variations' || activeTab === 'drawings' || activeTab === 'documents' || activeTab === 'issues' || activeTab === 'team') && (
          <ComingSoonNotice label={TABS.find((t) => t.id === activeTab)?.label || activeTab} />
        )}
      </div>
    </div>
  );
}

// Overview metadata panel. Mirrors the admin ProjectForm layout
// (parties / contractValue / sites / description) but read-only. The
// "not registered" branch renders an empty state that prompts the user
// to file a DPR / Inspection so the project gets auto-created with
// full metadata.
function OverviewPanel({ project, parties, isRegistered }) {
  if (!isRegistered) {
    return (
      <div className="dpr-card" style={{ padding: '1.5rem' }}>
        <h2 style={{ margin: '0 0 0.5rem', fontSize: '1rem', color: 'var(--navy, #0f172a)' }}>
          No metadata yet
        </h2>
        <p style={{ color: 'var(--steel, #64748b)', margin: '0 0 1rem', fontSize: '0.9rem' }}>
          This project was discovered from an existing daily report or inspection, but
          hasn't been formally registered. Once an admin adds the project details
          (client, contract value, sites), they'll show up here.
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <Link to="/portal/dpr/submit" className="btn btn-primary btn-sm">
            File a DPR
          </Link>
          <Link to="/portal/inspection/submit" className="btn btn-secondary btn-sm">
            File an Inspection
          </Link>
        </div>
      </div>
    );
  }

  // Merge the project + parties payloads. The /:idOrName endpoint
  // returns the full row (name, code, client, location, dates) and
  // the /:idOrName/parties endpoint returns the four widening columns
  // (parties / contractValue / sites / description). The /parties
  // payload wins for those four fields because it's the canonical
  // N1 widening read surface.
  const partiesData = parties || {};
  const partyRecord = partiesData.parties || {};
  const sites = Array.isArray(partiesData.sites) ? partiesData.sites : [];

  return (
    <div id="project-overview" className="dpr-card" style={{ padding: '1.25rem' }}>
      <h2
        style={{
          fontFamily: "'Plus Jakarta Sans', sans-serif",
          fontSize: '1.05rem', fontWeight: 700,
          color: 'var(--navy, #0f172a)', margin: '0 0 1rem',
        }}
      >
        Project Overview
      </h2>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '0.75rem 1.5rem',
          marginBottom: '1rem',
          fontSize: '0.9rem',
        }}
      >
        <MetaCell label="Client" value={project.client} />
        <MetaCell label="Location" value={project.location} />
        <MetaCell
          label="Contract value"
          value={partiesData.contractValue != null && partiesData.contractValue !== '' ? formatInr(partiesData.contractValue) : null}
        />
        <MetaCell
          label="Start date"
          value={project.startDate ? formatShortDate(project.startDate) : null}
        />
        <MetaCell
          label="Expected end date"
          value={project.expectedEndDate ? formatShortDate(project.expectedEndDate) : null}
        />
        <MetaCell
          label="Code"
          value={project.code}
        />
      </div>

      <Section title="Parties">
        {Object.keys(partyRecord).length === 0 ? (
          <EmptyMeta>No parties listed yet.</EmptyMeta>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: '0.4rem' }}>
            {Object.entries(partyRecord).map(([role, name]) => (
              <li key={role} style={{ fontSize: '0.9rem' }}>
                <span style={{ color: 'var(--steel, #64748b)', marginRight: '0.5rem', textTransform: 'capitalize' }}>
                  {role}:
                </span>
                <span style={{ color: 'var(--navy, #0f172a)' }}>{name || '—'}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Sites">
        {sites.length === 0 ? (
          <EmptyMeta>No sites listed yet.</EmptyMeta>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: '0.4rem' }}>
            {sites.map((s, i) => (
              <li key={i} style={{ fontSize: '0.9rem', color: 'var(--navy, #0f172a)' }}>
                <MapPinIcon size={13} style={{ color: 'var(--steel, #64748b)', marginRight: '0.4rem' }} />
                {typeof s === 'string' ? s : (s.name || s.location || JSON.stringify(s))}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Description">
        {partiesData.description ? (
          <div style={{ whiteSpace: 'pre-wrap', fontSize: '0.9rem', color: 'var(--navy, #0f172a)' }}>
            {partiesData.description}
          </div>
        ) : (
          <EmptyMeta>No description provided.</EmptyMeta>
        )}
      </Section>
    </div>
  );
}

// Small label + value cell used in the metadata grid. Renders an
// em-dash placeholder for null / empty values so the layout stays
// even when metadata is sparse.
function MetaCell({ label, value }) {
  return (
    <div>
      <div style={{
        fontSize: '0.7rem',
        color: 'var(--steel, #64748b)',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        marginBottom: '0.2rem',
      }}>
        {label}
      </div>
      <div style={{ color: 'var(--navy, #0f172a)', fontWeight: 500 }}>
        {value && value !== '' ? value : <em className="text-placeholder">—</em>}
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: '1rem', marginTop: '1rem' }}>
      <h3
        style={{
          fontSize: '0.78rem',
          fontWeight: 700,
          color: 'var(--steel, #64748b)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          margin: '0 0 0.5rem',
        }}
      >
        {title}
      </h3>
      {children}
    </div>
  );
}

function EmptyMeta({ children }) {
  return <em className="text-placeholder" style={{ fontSize: '0.9rem' }}>{children}</em>;
}

// Live tabs show a quick "we're taking you to the admin page" notice
// instead of rendering their own table — the user already has a click
// handler in flight. Keeping the notice around the navigation gives
// the user a beat to read where they're going.
function TabLinkNotice({ tab, href }) {
  return (
    <div className="dpr-card" style={{ padding: '1.25rem', textAlign: 'center' }}>
      <p style={{ color: 'var(--steel, #64748b)', margin: '0 0 1rem' }}>
        {tab} for this project open in the {tab === 'BOQ' ? 'BOQ registry' : `${tab.toLowerCase()} admin view`}.
      </p>
      <Link to={href} className="btn btn-primary">
        Open {tab}
      </Link>
    </div>
  );
}

function ComingSoonNotice({ label }) {
  return (
    <div className="dpr-card" style={{ padding: '1.25rem', textAlign: 'center' }}>
      <p style={{ color: 'var(--steel, #64748b)', margin: 0 }}>
        <strong style={{ color: 'var(--navy, #0f172a)' }}>{label}</strong> is on the
        roadmap. The tab is reserved so the navigation stays stable; a
        dedicated page will land in a future phase.
      </p>
    </div>
  );
}

// useDocumentTitle is normally called at the top level of a component,
// but here the project name is async (loaded after the request lands).
// We delegate that to the useEffect in the component body above.
