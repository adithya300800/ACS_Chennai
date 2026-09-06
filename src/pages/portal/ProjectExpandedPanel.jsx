// [Round-33] Inline expansion panel for a single project on /portal/projects.
//
// Renders five sub-sections (Overview, BOQ, DPRs, Inspections, Drawings)
// directly below the chosen project card. The user never leaves the
// My Projects page. Sub-section rows are themselves clickable tiles
// that expand to show full details — keeping the surface scannable
// when a project has dozens of DPRs.
//
// Data flow:
//   - On mount: lazy-load project parties + DPRs + Inspections + Drawings
//     + BOQ in parallel (Promise.all). BOQ uses projectName (since the
//     BOQ API is name-keyed); the rest use projectId when available.
//   - On project change (parent re-mounts): the panel starts fresh.
//   - Per-section errors don't block the rest — a DPR fetch failure
//     renders an error banner inside the DPR sub-section and the
//     other sub-sections stay usable.
//
// Design rationale: rather than re-implementing DprList / InspectionList
// / DrawingsBrowse here (would double the maintenance surface), we
// render a lighter card-per-row tile list with the most useful summary
// fields + an expand affordance for the full body. The full
// admin/browse page is still one click away via "Open project details →"
// at the bottom of the panel.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { formatShortDate } from '../../lib/format.js';
import StatusBadge from '../../components/StatusBadge.jsx';

// Status maps for the per-row badges. Mirrors DprList / InspectionList
// so the colors match the user's existing mental model.
const DPR_STATUS_MAP = {
  DRAFT: 'dpr-status-draft',
  SUBMITTED: 'dpr-status-submitted',
  UNDER_REVIEW: 'dpr-status-review',
  APPROVED: 'dpr-status-approved',
  REJECTED: 'dpr-status-rejected',
};

const INSPECTION_STATUS_MAP = {
  DRAFT: 'dpr-status-draft',
  OPEN: 'dpr-status-submitted',
  ACKNOWLEDGED: 'dpr-status-review',
  CLOSED: 'dpr-status-approved',
  REJECTED: 'dpr-status-rejected',
};

const DRAWING_STATUS_MAP = {
  ACTIVE: 'dpr-status-approved',
  SUPERSEDED: 'dpr-status-rejected',
};

// Section identifiers — used both for the tab UI and as the keys in
// `openSections`. All five sections are open by default; the user can
// fold any of them.
const SECTION_IDS = ['overview', 'boq', 'dprs', 'inspections', 'drawings'];

export default function ProjectExpandedPanel({ project, accessToken, onClose, onOpenProjectDetail }) {
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Sub-section collapse state. `null` for an id means folded.
  const [openSections, setOpenSections] = useState(() =>
    SECTION_IDS.reduce((acc, id) => ({ ...acc, [id]: true }), {})
  );

  // Lazy-loaded payload slots. Each slot can be:
  //   { status: 'idle' | 'loading' | 'ready' | 'error', data?, error? }
  const [parties, setParties] = useState({ status: 'idle' });
  const [dprs, setDprs] = useState({ status: 'idle' });
  const [inspections, setInspections] = useState({ status: 'idle' });
  const [drawings, setDrawings] = useState({ status: 'idle' });
  const [boq, setBoq] = useState({ status: 'idle' });

  // Tile-expansion state — id of the row currently expanded within a
  // section, or null. Keeps the panel tidy when one DPR is open at a
  // time (mirrors the single-accordion pattern at the project level).
  const [expandedRow, setExpandedRow] = useState({ dprs: null, inspections: null, drawings: null });

  const projectKey = project.id || project.name;
  const isRegistered = !!project.id;
  const projectName = project.name;

  // Lazy-load all five payloads on mount (or when the project key
  // changes). Each section's failure is isolated so one bad endpoint
  // doesn't blank the whole panel.
  useEffect(() => {
    mountedRef.current = true;
    setParties({ status: 'loading' });
    setDprs({ status: 'loading' });
    setInspections({ status: 'loading' });
    setDrawings({ status: 'loading' });
    setBoq({ status: 'loading' });

    const tasks = [];

    // Parties — only meaningful when the project is registered. For a
    // discovered (name-only) row, the backend returns 200 with an
    // isRegistered=false payload — we render the empty state instead
    // of an error.
    if (isRegistered) {
      tasks.push(
        api.getProjectParties(projectKey, accessToken)
          .then((d) => mountedRef.current && setParties({ status: 'ready', data: d }))
          .catch((err) => mountedRef.current && setParties({ status: 'error', error: err?.message || 'Failed to load' })),
      );
    } else {
      setParties({ status: 'ready', data: { isRegistered: false } });
    }

    // DPRs — keyed by projectId when known, else projectName. The DPR
    // list endpoint accepts either as a query param.
    const projectIdOrName = isRegistered
      ? { projectId: projectKey }
      : { projectName };
    tasks.push(
      api.getDprs({ ...projectIdOrName, limit: 25 }, accessToken)
        .then((resp) => {
          if (!mountedRef.current) return;
          const rows = resp?.dprs || resp?.items || (Array.isArray(resp) ? resp : []);
          setDprs({ status: 'ready', data: rows });
        })
        .catch((err) => mountedRef.current && setDprs({ status: 'error', error: err?.message || 'Failed to load' })),
    );

    // Inspections — same shape as DPRs.
    tasks.push(
      api.getInspections({ ...projectIdOrName, limit: 25 }, accessToken)
        .then((resp) => {
          if (!mountedRef.current) return;
          const rows = resp?.inspections || resp?.items || (Array.isArray(resp) ? resp : []);
          setInspections({ status: 'ready', data: rows });
        })
        .catch((err) => mountedRef.current && setInspections({ status: 'error', error: err?.message || 'Failed to load' })),
    );

    // Drawings — projectId REQUIRED by the backend. Discovered rows have
    // no id; the section renders an empty state instead of calling the
    // endpoint (which would 400).
    if (isRegistered) {
      tasks.push(
        api.getDrawings({ projectId: projectKey, status: 'ACTIVE', limit: 25 }, accessToken)
          .then((resp) => {
            if (!mountedRef.current) return;
            const rows = resp?.drawings || resp?.items || (Array.isArray(resp) ? resp : []);
            setDrawings({ status: 'ready', data: rows });
          })
          .catch((err) => mountedRef.current && setDrawings({ status: 'error', error: err?.message || 'Failed to load' })),
      );
    } else {
      setDrawings({ status: 'ready', data: [] });
    }

    // BOQ — keyed by projectName (the BOQ list endpoint requires a
    // projectName). Always works for both registered + discovered rows.
    if (projectName) {
      tasks.push(
        api.getBoqItems({ projectName, limit: 50 }, accessToken)
          .then((resp) => {
            if (!mountedRef.current) return;
            const rows = resp?.items || resp?.boqItems || (Array.isArray(resp) ? resp : []);
            setBoq({ status: 'ready', data: rows });
          })
          .catch((err) => mountedRef.current && setBoq({ status: 'error', error: err?.message || 'Failed to load' })),
      );
    } else {
      setBoq({ status: 'ready', data: [] });
    }

    Promise.allSettled(tasks);
  }, [projectKey, isRegistered, projectName, accessToken]);

  const toggleSection = useCallback((id) => {
    setOpenSections((s) => ({ ...s, [id]: !s[id] }));
  }, []);

  const toggleRow = useCallback((section, id) => {
    setExpandedRow((r) => ({ ...r, [section]: r[section] === id ? null : id }));
  }, []);

  // Count summary shown on each section header.
  const counts = useMemo(() => ({
    boq: boq.status === 'ready' ? (boq.data || []).length : null,
    dprs: dprs.status === 'ready' ? (dprs.data || []).length : null,
    inspections: inspections.status === 'ready' ? (inspections.data || []).length : null,
    drawings: drawings.status === 'ready' ? (drawings.data || []).length : null,
  }), [boq, dprs, inspections, drawings]);

  return (
    <div
      id={`projects-card-body-${projectKey}`}
      role="region"
      aria-label={`Project details for ${projectName}`}
      className="dpr-card"
      style={{
        padding: '0',
        marginTop: '0.5rem',
        background: 'rgba(0, 102, 255, 0.03)',
        borderColor: 'rgba(0, 102, 255, 0.25)',
        overflow: 'hidden',
      }}
    >
      {/* Header row — project name + close button. */}
      <div
        style={{
          padding: '0.75rem 1rem',
          background: 'rgba(0, 102, 255, 0.06)',
          borderBottom: '1px solid rgba(0, 102, 255, 0.18)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.75rem',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span
            style={{
              fontFamily: "'Plus Jakarta Sans', sans-serif",
              fontSize: '0.92rem',
              fontWeight: 700,
              color: 'var(--navy, #0f172a)',
            }}
          >
            {projectName}
          </span>
          <span style={{ fontSize: '0.78rem', color: 'var(--steel, #64748b)' }}>
            Project details — click a section to fold it
          </span>
        </div>
        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
          {isRegistered && (
            <Link
              to={`/portal/projects/${encodeURIComponent(projectKey)}`}
              className="btn btn-ghost btn-sm"
              onClick={onOpenProjectDetail}
            >
              Open project details →
            </Link>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Collapse project"
            className="btn btn-ghost btn-sm"
            style={{ padding: '0.25rem 0.6rem' }}
          >
            ✕
          </button>
        </div>
      </div>

      <div style={{ padding: '0.5rem' }}>
        <Section
          id="overview"
          title="Overview"
          isOpen={openSections.overview}
          onToggle={() => toggleSection('overview')}
        >
          <OverviewSection
            project={project}
            parties={parties}
            isRegistered={isRegistered}
          />
        </Section>

        <Section
          id="boq"
          title="BOQ"
          isOpen={openSections.boq}
          onToggle={() => toggleSection('boq')}
          count={counts.boq}
          emptyState={boq.status === 'ready' && (boq.data || []).length === 0}
          emptyHint="No BOQ items yet — file a BOQ variance to register the first line item."
        >
          <BoqSection boq={boq} />
        </Section>

        <Section
          id="dprs"
          title="DPRs"
          isOpen={openSections.dprs}
          onToggle={() => toggleSection('dprs')}
          count={counts.dprs}
          emptyState={dprs.status === 'ready' && (dprs.data || []).length === 0}
          emptyHint="No daily reports against this project yet."
        >
          <DprSection
            dprs={dprs}
            expandedId={expandedRow.dprs}
            onToggle={(id) => toggleRow('dprs', id)}
          />
        </Section>

        <Section
          id="inspections"
          title="Inspections"
          isOpen={openSections.inspections}
          onToggle={() => toggleSection('inspections')}
          count={counts.inspections}
          emptyState={inspections.status === 'ready' && (inspections.data || []).length === 0}
          emptyHint="No inspection records against this project yet."
        >
          <InspectionSection
            inspections={inspections}
            expandedId={expandedRow.inspections}
            onToggle={(id) => toggleRow('inspections', id)}
          />
        </Section>

        <Section
          id="drawings"
          title="Drawings"
          isOpen={openSections.drawings}
          onToggle={() => toggleSection('drawings')}
          count={counts.drawings}
          emptyState={drawings.status === 'ready' && (drawings.data || []).length === 0}
          emptyHint={
            isRegistered
              ? 'No active drawing revisions for this project yet.'
              : 'Register this project first to start tracking drawing revisions.'
          }
        >
          <DrawingSection drawings={drawings} isRegistered={isRegistered} projectKey={projectKey} />
        </Section>
      </div>
    </div>
  );
}

// Collapsible section wrapper. Header doubles as a toggle button;
// body shows loading / error / children when open.
function Section({ id, title, isOpen, onToggle, count, emptyState, emptyHint, children }) {
  return (
    <div
      data-testid={`projects-section-${id}`}
      style={{
        background: 'white',
        border: '1px solid #e2e8f0',
        borderRadius: 8,
        marginBottom: '0.5rem',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-controls={`projects-section-body-${id}`}
        style={{
          width: '100%',
          padding: '0.625rem 0.875rem',
          background: 'white',
          border: 0,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          font: 'inherit',
          textAlign: 'left',
          color: 'inherit',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 150ms ease',
            color: 'var(--steel, #64748b)',
            fontSize: '0.85rem',
            width: 12,
            textAlign: 'center',
          }}
        >
          ▸
        </span>
        <span
          style={{
            fontFamily: "'Plus Jakarta Sans', sans-serif",
            fontWeight: 700,
            fontSize: '0.85rem',
            color: 'var(--navy, #0f172a)',
            flex: 1,
          }}
        >
          {title}
        </span>
        {typeof count === 'number' && (
          <span
            style={{
              fontSize: '0.7rem',
              fontWeight: 600,
              color: 'var(--steel, #64748b)',
              background: 'rgba(100,116,139,0.10)',
              padding: '1px 7px',
              borderRadius: 999,
            }}
          >
            {count}
          </span>
        )}
        {!isOpen && emptyState && (
          <span
            style={{
              fontSize: '0.7rem',
              color: 'var(--amber, #d97706)',
              fontWeight: 600,
            }}
          >
            empty
          </span>
        )}
      </button>
      {isOpen && (
        <div
          id={`projects-section-body-${id}`}
          role="region"
          aria-label={`${title} content`}
          style={{
            padding: '0 0.875rem 0.75rem',
            borderTop: '1px solid #f1f5f9',
          }}
        >
          {emptyState ? (
            <div
              style={{
                padding: '0.875rem 0',
                fontSize: '0.85rem',
                color: 'var(--steel, #64748b)',
                fontStyle: 'italic',
              }}
            >
              {emptyHint}
            </div>
          ) : (
            children
          )}
        </div>
      )}
    </div>
  );
}

// Overview — parties + contract + dates + description. Falls back to a
// "not registered yet" empty state for discovered rows.
function OverviewSection({ project, parties, isRegistered }) {
  if (!isRegistered) {
    return (
      <div style={{ padding: '0.875rem 0', fontSize: '0.85rem', color: 'var(--steel, #64748b)' }}>
        Auto-discovered project — no metadata yet. File a DPR or Inspection to start, then ask
        an admin to formally register it (client, location, contract value).
      </div>
    );
  }

  if (parties.status === 'loading') {
    return <LoadingHint>Loading project metadata…</LoadingHint>;
  }
  if (parties.status === 'error') {
    return <ErrorHint>{parties.error}</ErrorHint>;
  }

  const data = parties.data || {};
  const partyRecord = data.parties || {};
  const sites = Array.isArray(data.sites) ? data.sites : [];
  const hasContent =
    project.client || project.location || data.contractValue || project.startDate ||
    Object.keys(partyRecord).length > 0 || sites.length > 0 || data.description;

  if (!hasContent) {
    return (
      <div style={{ padding: '0.875rem 0', fontSize: '0.85rem', color: 'var(--steel, #64748b)' }}>
        No overview details yet — an admin can add client, location, and contract value in
        the project registry.
      </div>
    );
  }

  const inrFormatter = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
  const contractDisplay = data.contractValue != null && data.contractValue !== ''
    ? `₹${inrFormatter.format(typeof data.contractValue === 'string' ? Number(data.contractValue) : data.contractValue)}`
    : null;

  return (
    <div style={{ padding: '0.5rem 0', display: 'grid', gap: '0.6rem' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: '0.5rem 1rem',
          fontSize: '0.85rem',
        }}
      >
        {project.client && <MetaCell label="Client" value={project.client} />}
        {project.location && <MetaCell label="Location" value={project.location} />}
        {contractDisplay && <MetaCell label="Contract value" value={contractDisplay} />}
        {project.startDate && <MetaCell label="Start date" value={formatShortDate(project.startDate)} />}
        {project.expectedEndDate && <MetaCell label="Expected end" value={formatShortDate(project.expectedEndDate)} />}
        {project.code && <MetaCell label="Code" value={project.code} />}
      </div>
      {Object.keys(partyRecord).length > 0 && (
        <div>
          <div style={{ fontSize: '0.7rem', color: 'var(--steel, #64748b)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.2rem' }}>
            Parties
          </div>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: '0.2rem', fontSize: '0.85rem' }}>
            {Object.entries(partyRecord).map(([role, name]) => (
              <li key={role}>
                <span style={{ color: 'var(--steel, #64748b)', marginRight: '0.4rem', textTransform: 'capitalize' }}>
                  {role}:
                </span>
                <span style={{ color: 'var(--navy, #0f172a)' }}>{name || '—'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {sites.length > 0 && (
        <div>
          <div style={{ fontSize: '0.7rem', color: 'var(--steel, #64748b)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.2rem' }}>
            Sites
          </div>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: '0.2rem', fontSize: '0.85rem' }}>
            {sites.map((s, i) => (
              <li key={i} style={{ color: 'var(--navy, #0f172a)' }}>
                {typeof s === 'string' ? s : (s.name || s.location || JSON.stringify(s))}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.description && (
        <div>
          <div style={{ fontSize: '0.7rem', color: 'var(--steel, #64748b)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.2rem' }}>
            Description
          </div>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: '0.85rem', color: 'var(--navy, #0f172a)' }}>
            {data.description}
          </div>
        </div>
      )}
    </div>
  );
}

function MetaCell({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: '0.65rem', color: 'var(--steel, #64748b)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.15rem' }}>
        {label}
      </div>
      <div style={{ color: 'var(--navy, #0f172a)', fontWeight: 500 }}>{value}</div>
    </div>
  );
}

// BOQ — render items as a compact table with description / unit / qty /
// rate / amount. The full BoqVariance report is one click away.
function BoqSection({ boq }) {
  if (boq.status === 'loading') return <LoadingHint>Loading BOQ items…</LoadingHint>;
  if (boq.status === 'error') return <ErrorHint>{boq.error}</ErrorHint>;
  const items = boq.data || [];
  if (items.length === 0) return null;
  const inrFormatter = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
  return (
    <div style={{ padding: '0.5rem 0', overflowX: 'auto' }}>
      <table
        style={{
          width: '100%',
          fontSize: '0.78rem',
          borderCollapse: 'collapse',
        }}
      >
        <thead>
          <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
            <th style={th}>Description</th>
            <th style={th}>Unit</th>
            <th style={{ ...th, textAlign: 'right' }}>Qty</th>
            <th style={{ ...th, textAlign: 'right' }}>Rate (₹)</th>
            <th style={{ ...th, textAlign: 'right' }}>Amount (₹)</th>
          </tr>
        </thead>
        <tbody>
          {items.map((b) => {
            const rate = b.rate != null ? inrFormatter.format(typeof b.rate === 'string' ? Number(b.rate) : b.rate) : '—';
            const qty = b.quantity != null ? b.quantity : '—';
            const amount = b.amount != null
              ? inrFormatter.format(typeof b.amount === 'string' ? Number(b.amount) : b.amount)
              : (b.quantity != null && b.rate != null
                ? inrFormatter.format(Number(b.quantity) * Number(b.rate))
                : '—');
            return (
              <tr key={b.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                <td style={td}>{b.description || b.itemDescription || '—'}</td>
                <td style={td}>{b.unit || '—'}</td>
                <td style={{ ...td, textAlign: 'right' }}>{qty}</td>
                <td style={{ ...td, textAlign: 'right' }}>{rate}</td>
                <td style={{ ...td, textAlign: 'right' }}>{amount}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const th = { padding: '0.4rem 0.6rem', textAlign: 'left', fontWeight: 600, color: 'var(--steel, #64748b)' };
const td = { padding: '0.4rem 0.6rem', color: 'var(--navy, #0f172a)' };

// DPR — tile per row, click to expand for the full body. The expanded
// body shows the workType, the 5 PMC daily fields (Round-12), notes,
// contractor, weather, photos count, and the audit trail (submitted /
// approved). Rather than guessing which subset of fields is populated,
// DprBody renders every populated, non-internal field via FieldGrid —
// future schema additions surface automatically without code changes.
function DprSection({ dprs, expandedId, onToggle }) {
  if (dprs.status === 'loading') return <LoadingHint>Loading DPRs…</LoadingHint>;
  if (dprs.status === 'error') return <ErrorHint>{dprs.error}</ErrorHint>;
  const rows = dprs.data || [];
  if (rows.length === 0) return null;
  return (
    <div style={{ display: 'grid', gap: '0.4rem', padding: '0.5rem 0' }}>
      {rows.map((d) => (
        <ResourceTile
          key={d.id}
          id={d.id}
          isExpanded={expandedId === d.id}
          onToggle={() => onToggle(d.id)}
          primary={d.reportDate ? formatShortDate(d.reportDate) : '—'}
          secondary={d.workType ? prettyWorkType(d.workType) : (d.location || '')}
          badges={<StatusBadge status={d.status} map={DPR_STATUS_MAP} />}
          extra={
            (d.photos?.length || d.photoCount)
              ? `${d.photos?.length || d.photoCount} photo${(d.photos?.length || d.photoCount) === 1 ? '' : 's'}`
              : null
          }
          expandedBody={<DprBody d={d} />}
        />
      ))}
    </div>
  );
}

// Convert the workType enum to a friendlier label (MATERIAL_RECEIPT →
// "Material receipt"). Falls back to the raw enum if unknown.
const WORK_TYPE_LABELS = {
  MATERIAL_RECEIPT: 'Material receipt',
  WORK_EXECUTION: 'Work execution',
  DAY_ACTIVITY: 'Day activity',
  SAFETY_INCIDENT: 'Safety incident',
  QUALITY_ISSUE: 'Quality issue',
  PROGRESS_UPDATE: 'Progress update',
};
function prettyWorkType(t) {
  if (!t) return '';
  return WORK_TYPE_LABELS[t] || t.replace(/_/g, ' ').toLowerCase();
}

function DprBody({ d }) {
  // Inline rows (single field = single value, e.g. Contractor, Weather).
  const inlineRows = [];
  if (d.location) inlineRows.push(['Location', d.location]);
  if (d.contractor || d.contractorName) inlineRows.push(['Contractor', d.contractor || d.contractorName]);
  if (d.weather) {
    inlineRows.push(['Weather', d.temperature ? `${d.weather} · ${d.temperature}` : d.weather]);
  }
  if (d.boqItem?.description || d.boqItemId) {
    inlineRows.push(['BOQ item', d.boqItem?.description || `BOQ #${d.boqItemId}`]);
  }
  if (d.drawing?.drawingNumber || d.drawingId) {
    inlineRows.push([
      'Drawing',
      d.drawing?.drawingNumber ? `${d.drawing.drawingNumber} Rev ${d.drawingRev || '—'}` : `Drawing ${d.drawingId}`,
    ]);
  }

  // Block rows (longer text — needs whitespace wrap). These are the
  // five Round-12 PMC daily fields + the canonical free-form `notes`.
  const blockRows = [];
  if (d.notes) blockRows.push(['Notes', d.notes]);
  if (d.workExecutedToday) blockRows.push(['Work executed today', d.workExecutedToday]);
  if (d.workLocation) blockRows.push(['Work location', d.workLocation]);
  if (d.manpowerSummary) blockRows.push(['Manpower', d.manpowerSummary]);
  if (d.risksHindrances) blockRows.push(['Risks / hindrances', d.risksHindrances]);
  if (d.materialsReceivedSummary) blockRows.push(['Materials received', d.materialsReceivedSummary]);
  if (d.workEntries?.length) {
    blockRows.push(['Work entries', d.workEntries.map((w) => formatWorkEntry(w)).filter(Boolean).join('\n')]);
  }
  if (d.customSections?.length) {
    blockRows.push(['Custom sections', d.customSections.map((s) => formatCustomSection(s)).filter(Boolean).join('\n\n')]);
  }

  // Admin / audit trail.
  const auditRows = [];
  if (d.submittedBy?.name) auditRows.push(['Submitted by', formatAuditTime(d.submittedBy, d.submittedAt)]);
  if (d.reviewedBy?.name) auditRows.push(['Reviewed by', formatAuditTime(d.reviewedBy, d.reviewedAt)]);
  if (d.approvedBy?.name) auditRows.push(['Approved by', formatAuditTime(d.approvedBy, d.approvedAt)]);
  if (d.rejectionReason) auditRows.push(['Rejection reason', d.rejectionReason]);
  if (d.adminNotes) auditRows.push(['Admin notes', d.adminNotes]);

  const photos = d.photos?.length || d.photoCount || 0;

  return (
    <div style={{ padding: '0.6rem 0', display: 'grid', gap: '0.6rem', fontSize: '0.82rem' }}>
      {inlineRows.length > 0 && (
        <FieldGrid rows={inlineRows} />
      )}
      {blockRows.map(([label, value]) => (
        <BlockField key={label} label={label} value={value} />
      ))}
      {photos > 0 && (
        <div style={{ fontSize: '0.78rem', color: 'var(--steel, #64748b)' }}>
          📎 {photos} photo{photos === 1 ? '' : 's'} attached (open the full report to view)
        </div>
      )}
      {auditRows.length > 0 && (
        <div
          style={{
            borderTop: '1px solid #f1f5f9',
            paddingTop: '0.5rem',
            marginTop: '0.2rem',
          }}
        >
          <FieldGrid rows={auditRows} compact />
        </div>
      )}
    </div>
  );
}

// Inspection — same tile pattern as DPR. Inspection data lives in a
// nested `data` JSONB (inspectedBy, observations, checklistItems, etc.)
// plus top-level contractor / location / severity. InspectionBody
// renders every populated field — top-level first, then the `data`
// sub-object's populated fields.
function InspectionSection({ inspections, expandedId, onToggle }) {
  if (inspections.status === 'loading') return <LoadingHint>Loading inspections…</LoadingHint>;
  if (inspections.status === 'error') return <ErrorHint>{inspections.error}</ErrorHint>;
  const rows = inspections.data || [];
  if (rows.length === 0) return null;
  return (
    <div style={{ display: 'grid', gap: '0.4rem', padding: '0.5rem 0' }}>
      {rows.map((i) => (
        <ResourceTile
          key={i.id}
          id={i.id}
          isExpanded={expandedId === i.id}
          onToggle={() => onToggle(i.id)}
          primary={i.reportDate ? formatShortDate(i.reportDate) : '—'}
          secondary={i.inspectionType ? prettyInspectionType(i.inspectionType) : (i.location || '')}
          badges={<StatusBadge status={i.status} map={INSPECTION_STATUS_MAP} />}
          extra={i.severity ? `Severity: ${i.severity}` : null}
          expandedBody={<InspectionBody i={i} />}
        />
      ))}
    </div>
  );
}

const INSPECTION_TYPE_LABELS = {
  villa_inspection: 'Villa inspection',
  day_activity_inspection: 'Day activity inspection',
  safety_inspection: 'Safety inspection',
  quality_inspection: 'Quality inspection',
  compliance_inspection: 'Compliance inspection',
};
function prettyInspectionType(t) {
  if (!t) return '';
  return INSPECTION_TYPE_LABELS[t] || t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function InspectionBody({ i }) {
  // Top-level inline rows.
  const inlineRows = [];
  if (i.location) inlineRows.push(['Location', i.location]);
  if (i.contractor) inlineRows.push(['Contractor', i.contractor]);
  if (i.severity) inlineRows.push(['Severity', i.severity]);
  if (i.dprId) inlineRows.push(['Linked DPR', `#${i.dprId.slice(0, 8)}`]);
  if (i.boqItem?.description || i.boqItemId) {
    inlineRows.push(['BOQ item', i.boqItem?.description || `BOQ #${i.boqItemId}`]);
  }
  if (i.drawing?.drawingNumber || i.drawingId) {
    inlineRows.push([
      'Drawing',
      i.drawing?.drawingNumber ? `${i.drawing.drawingNumber} Rev ${i.drawingRev || '—'}` : `Drawing ${i.drawingId}`,
    ]);
  }

  // The `data` JSONB holds the form-specific fields. Render them all.
  const dataBlockRows = [];
  const dObj = i.data && typeof i.data === 'object' ? i.data : {};
  for (const [key, value] of Object.entries(dObj)) {
    if (INSPECTION_DATA_INTERNAL.has(key)) continue;
    if (value == null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    const label = INSPECTION_DATA_LABELS[key] || prettyCamel(key);
    if (Array.isArray(value)) {
      dataBlockRows.push([label, value.map((item) => formatListItem(item)).join('\n')]);
    } else {
      dataBlockRows.push([label, String(value)]);
    }
  }

  // Top-level block rows (rare — most rich content is in `data`).
  const blockRows = [];
  if (i.notes) blockRows.push(['Notes', i.notes]);
  if (i.findings) blockRows.push(['Findings', i.findings]);
  if (i.summary) blockRows.push(['Summary', i.summary]);

  // Audit trail.
  const auditRows = [];
  if (i.submittedBy?.name) auditRows.push(['Submitted by', formatAuditTime(i.submittedBy, i.createdAt)]);
  if (i.reviewedBy?.name) auditRows.push(['Reviewed by', formatAuditTime(i.reviewedBy, i.reviewedAt)]);
  if (i.approvedBy?.name) auditRows.push(['Approved by', formatAuditTime(i.approvedBy, i.approvedAt)]);
  if (i.rejectionReason) auditRows.push(['Rejection reason', i.rejectionReason]);
  if (i.adminNotes) auditRows.push(['Admin notes', i.adminNotes]);

  const photos = i.photos?.length || i.photoCount || 0;

  return (
    <div style={{ padding: '0.6rem 0', display: 'grid', gap: '0.6rem', fontSize: '0.82rem' }}>
      {inlineRows.length > 0 && <FieldGrid rows={inlineRows} />}
      {dataBlockRows.map(([label, value]) => (
        <BlockField key={label} label={label} value={value} />
      ))}
      {blockRows.map(([label, value]) => (
        <BlockField key={label} label={label} value={value} />
      ))}
      {photos > 0 && (
        <div style={{ fontSize: '0.78rem', color: 'var(--steel, #64748b)' }}>
          📎 {photos} photo{photos === 1 ? '' : 's'} attached (open the full report to view)
        </div>
      )}
      {auditRows.length > 0 && (
        <div
          style={{
            borderTop: '1px solid #f1f5f9',
            paddingTop: '0.5rem',
            marginTop: '0.2rem',
          }}
        >
          <FieldGrid rows={auditRows} compact />
        </div>
      )}
    </div>
  );
}

// Drawings — tiles link to the drawing detail page since drawings need
// a full PDF preview surface.
function DrawingSection({ drawings, isRegistered, projectKey }) {
  if (!isRegistered) {
    return (
      <div style={{ padding: '0.5rem 0', fontSize: '0.85rem', color: 'var(--steel, #64748b)' }}>
        Register this project first to start tracking drawing revisions.
      </div>
    );
  }
  if (drawings.status === 'loading') return <LoadingHint>Loading drawings…</LoadingHint>;
  if (drawings.status === 'error') return <ErrorHint>{drawings.error}</ErrorHint>;
  const rows = drawings.data || [];
  if (rows.length === 0) return null;
  return (
    <div style={{ display: 'grid', gap: '0.4rem', padding: '0.5rem 0' }}>
      {rows.map((d) => (
        <div
          key={d.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.6rem',
            padding: '0.5rem 0.75rem',
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: 6,
            fontSize: '0.85rem',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontWeight: 700, color: 'var(--navy, #0f172a)' }}>
            {d.drawingNumber || '—'}
          </span>
          <span style={{ color: 'var(--steel, #64748b)' }}>
            Rev {d.revision || '—'}
          </span>
          <span style={{ color: 'var(--navy, #0f172a)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {d.title || d.description || ''}
          </span>
          <StatusBadge status={d.status} map={DRAWING_STATUS_MAP} />
          <Link
            to={`/portal/drawings/${d.id}`}
            className="btn btn-ghost btn-sm"
            style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}
          >
            View →
          </Link>
        </div>
      ))}
    </div>
  );
}

// ── Field renderers ──────────────────────────────────────────────────
//
// Two layouts:
//   - FieldGrid  — compact two-column label / value pairs (Contractor,
//                 Location, Weather, Severity, audit trail). Renders
//                 up to 3 columns at wide widths, collapses to one.
//   - BlockField — full-width row with a label header + multi-line body
//                 (Notes, Observations, Checklist, PMC fields).
//
// Both skip empty rows so a DPR with no weather doesn't render an
// "Weather: —" placeholder.

function FieldGrid({ rows, compact = false }) {
  if (!rows || rows.length === 0) return null;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: compact
          ? 'repeat(auto-fit, minmax(180px, 1fr))'
          : 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: compact ? '0.3rem 0.8rem' : '0.45rem 1rem',
        fontSize: compact ? '0.78rem' : '0.82rem',
      }}
    >
      {rows.map(([label, value]) => (
        <div key={label}>
          <div
            style={{
              fontSize: '0.62rem',
              color: 'var(--steel, #64748b)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: '0.1rem',
              fontWeight: 600,
            }}
          >
            {label}
          </div>
          <div style={{ color: 'var(--navy, #0f172a)' }}>{value}</div>
        </div>
      ))}
    </div>
  );
}

function BlockField({ label, value }) {
  if (value == null || value === '') return null;
  return (
    <div>
      <div
        style={{
          fontSize: '0.62rem',
          color: 'var(--steel, #64748b)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginBottom: '0.25rem',
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div
        style={{
          whiteSpace: 'pre-wrap',
          color: 'var(--navy, #0f172a)',
          fontSize: '0.82rem',
          lineHeight: 1.45,
        }}
      >
        {value}
      </div>
    </div>
  );
}

// camelCase → "Pretty case" (inspectedBy → "Inspected By").
function prettyCamel(s) {
  return String(s)
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

// Friendly labels for known inspection `data` JSONB keys. Anything
// unknown falls through to prettyCamel. Add new entries here when
// the inspection form gains a new field — keeps the visible UI
// readable without forcing a code change to the renderer.
const INSPECTION_DATA_LABELS = {
  // villa_inspection form
  inspectedBy: 'Inspected by',
  observations: 'Observations',
  villaUnitNumber: 'Villa / unit',
  complianceStatus: 'Compliance status',
  activitiesInspected: 'Activities inspected',
  stageOfConstruction: 'Stage of construction',
  // day_activity_inspection form
  remarks: 'Remarks',
  activityType: 'Activity type',
  overallStatus: 'Overall status',
  checklistItems: 'Checklist',
  // shared
  location: 'Location',
  notes: 'Notes',
  findings: 'Findings',
  summary: 'Summary',
  severity: 'Severity',
  contractor: 'Contractor',
};

// Internal `data` keys we never surface (schema-internal flags /
// duplicates of top-level fields we already render).
const INSPECTION_DATA_INTERNAL = new Set([
  '__typename',
  'id',
  'inspectionId',
]);

// Format a work entry (Round-12 DPR schema) — usually a { description,
// quantity, unit } object. Returns a one-line "Description (qty unit)"
// or just the description if structure is unknown.
function formatWorkEntry(w) {
  if (!w) return '';
  if (typeof w === 'string') return `• ${w}`;
  const desc = w.description || w.work || w.item || '';
  const qty = w.quantity != null ? w.quantity : w.qty;
  const unit = w.unit || '';
  if (!desc) return JSON.stringify(w);
  if (qty != null && unit) return `• ${desc} — ${qty} ${unit}`;
  if (qty != null) return `• ${desc} — ${qty}`;
  return `• ${desc}`;
}

// Format a custom DPR section — Round-12 user-added sections are
// { title, body } objects.
function formatCustomSection(s) {
  if (!s) return '';
  if (typeof s === 'string') return s;
  const title = s.title || s.heading || '';
  const body = s.body || s.content || '';
  if (title && body) return `${title}\n${body}`;
  return title || body || JSON.stringify(s);
}

// Format a single audit-row actor with optional timestamp.
function formatAuditTime(by, at) {
  if (!by) return '';
  const name = by.name || by.email || by.id || '—';
  if (!at) return name;
  const t = typeof at === 'string' ? at : (at instanceof Date ? at.toISOString() : '');
  if (!t) return name;
  return `${name} · ${formatShortDate(t)}`;
}

// Format a checklist / array item — objects become "label: value" lines,
// primitives become bullet points.
function formatListItem(item) {
  if (item == null) return '';
  if (typeof item === 'string') return `• ${item}`;
  if (typeof item === 'object') {
    const label = item.label || item.name || item.item || '';
    const value = item.value || item.checked != null ? (item.checked ? '✓' : '☐') : '';
    if (label && value) return `• ${label}: ${value}`;
    return `• ${label || JSON.stringify(item)}`;
  }
  return `• ${String(item)}`;
}

// A single clickable tile that expands to reveal its body. Used by
// DPR + Inspection sections.
function ResourceTile({ primary, secondary, badges, extra, isExpanded, onToggle, expandedBody, id }) {
  return (
    <div
      data-testid={id ? `resource-tile-${id}` : undefined}
      style={{
        border: '1px solid #e2e8f0',
        borderRadius: 6,
        background: 'white',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        style={{
          width: '100%',
          padding: '0.5rem 0.75rem',
          background: 'white',
          border: 0,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem',
          font: 'inherit',
          textAlign: 'left',
          color: 'inherit',
          flexWrap: 'wrap',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 150ms ease',
            color: 'var(--steel, #64748b)',
            fontSize: '0.7rem',
            width: 10,
            textAlign: 'center',
          }}
        >
          ▸
        </span>
        <span style={{ fontWeight: 600, color: 'var(--navy, #0f172a)' }}>{primary}</span>
        {secondary && (
          <span style={{ color: 'var(--steel, #64748b)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {secondary}
          </span>
        )}
        {extra && <span style={{ fontSize: '0.78rem', color: 'var(--steel, #64748b)' }}>{extra}</span>}
        {badges}
      </button>
      {isExpanded && (
        <div style={{ padding: '0 0.875rem 0.75rem', borderTop: '1px solid #f1f5f9' }}>
          {expandedBody}
        </div>
      )}
    </div>
  );
}

function LoadingHint({ children }) {
  return (
    <div style={{ padding: '0.875rem 0', fontSize: '0.85rem', color: 'var(--steel, #64748b)' }}>
      <span style={{ marginRight: '0.4rem' }}>⏳</span>{children}
    </div>
  );
}

function ErrorHint({ children }) {
  return (
    <div
      role="alert"
      style={{ padding: '0.6rem 0.75rem', fontSize: '0.85rem', color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, margin: '0.5rem 0' }}
    >
      {children}
    </div>
  );
}
