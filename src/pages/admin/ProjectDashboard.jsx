import React, { useState, useEffect, useCallback, useMemo, useRef, lazy } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { formatShortDate } from '../../lib/format.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import StatusBadge from '../../components/StatusBadge.jsx';
// R38 charts: pure aggregation helpers stay in the main chunk
// (used by SparklineTile + memoised by the parent). The recharts-
// using chart components are extracted into ProjectDashboardCharts.jsx
// and loaded via React.lazy — recharts only enters the bundle when an
// admin opens /portal/admin/project-dashboard, keeping every other
// admin page at its pre-R38 size.
import {
  bucketByDay,
  byLineItemTopN,
  byEmployeeWeek,
  pendingReviewSparkline,
} from '../../lib/kpiBuckets.js';
import { StatSparklineTile } from '../../components/dashboard/StatSparklineTile.jsx';
const ProjectDashboardCharts = lazy(() => import('./ProjectDashboardCharts.jsx'));
const InspectionDonutCard = lazy(() =>
  import('./ProjectDashboardCharts.jsx').then((m) => ({ default: m.InspectionDonutCard })),
);

// Tile-key → endpoint loader + label + "View all" link. Round-34
// Feature 4 turned each StatTile into an accordion button: clicking
// expands an InlineDrillPanel below the section, showing ≤10 rows of
// the matching bucket scoped to the selected project. "View all →"
// still navigates to the full admin queue so admins can drill deeper.
//
// Endpoint contract (per api.js):
//   getDprs        — /dpr        ?projectName=&projectId=&exactProjectName=&status=&from=&to=&limit=
//   getInspections — /inspection ?projectId=&status=&from=&to=&limit=
//   getBoqItems    — /boq        ?projectId=&limit=
//   getVariations  — /variations ?projectId=&status=&limit=
//
// DR-013: exact identity is load-bearing — the KPI counts rows by
// exact `projectName` (KPI handler at projects.js:1534) so the drill
// rows must use the same exact scope; otherwise "Tower" leaks into a
// "Tower Annex" bucket. Two paths:
//   1. Registered project → use projectId FK (exact match, no name join).
//   2. Discovered project → use projectName + exactProjectName=1 so the
//      backend's DPR list switches from `contains` to `equals` (mode
//      insensitive). Without this flag, a substring match leaks rows
//      from similarly named projects.
// R38.1: when the selection is the "All projects" sentinel
// (`p.id === '__all__'`), drop the scope so the list endpoint returns
// its org-wide queue — same pattern the chart-list loader uses.
function drillScope(p) {
  if (!p) return {};
  if (p.id === '__all__') return {};
  if (p.id) return { projectId: p.id };
  if (p.name) return { projectName: p.name, exactProjectName: '1' };
  return {};
}

// DR-013: the KPI window is a half-open [fromDay, toDayExclusive) range
// over UTC-midnight Dates (projects.js computeKpiWindow). The DPR /
// Inspection list endpoints take inclusive YYYY-MM-DD `from` / `to`. We
// translate deliberately: fromDay passes through, toDayExclusive must
// become the previous calendar day so the inclusive `to` does not pull
// in rows from the next day. `null` / missing bounds stay omitted so a
// "View all" link without window opens the full queue.
//
// Inspection "OPEN" tile is intentionally all-date (the OPEN backlog is
// the org-wide "what's waiting on me" tile, see kpiHandler:1562). The
// loader ignores `from`/`to` for that tile only.
function drillWindow(kpis, tileKey) {
  if (tileKey === 'inspection.open') return {};
  const w = kpis?.window;
  if (!w || !w.from || !w.to) return {};
  // `to` is exclusive in the KPI response — convert to inclusive YYYY-MM-DD
  // by stepping back one calendar day. parseStrictISODate keeps us in UTC
  // (no local-tz drift).
  const toDay = new Date(`${w.to}T00:00:00.000Z`);
  toDay.setUTCDate(toDay.getUTCDate() - 1);
  const toInclusive = toDay.toISOString().slice(0, 10);
  return { from: w.from, to: toInclusive };
}

const TILE_META = {
  'dpr.submitted': {
    label: 'Submitted DPRs',
    loader: (p, t, kpis) => {
      const w = drillWindow(kpis, 'dpr.submitted');
      return api.getDprs({ ...drillScope(p), status: 'SUBMITTED', limit: 10, ...w }, t).then((d) => d.dprs || []);
    },
    viewAll: (p, kpis) => {
      const w = drillWindow(kpis, 'dpr.submitted');
      // R38.1 — all-projects mode drops the projectId so the queue is unscoped.
      const params = { status: 'SUBMITTED', ...w };
      if (p && p.id !== '__all__') params.projectId = encodeURIComponent(p.id || `name:${p.name}`);
      return `/portal/admin/dpr?${new URLSearchParams(params).toString()}`;
    },
  },
  'dpr.pendingReview': {
    label: 'DPRs Pending Review',
    // DR-014: KPI tile's `pendingReviewCount` is the SUM of SUBMITTED +
    // UNDER_REVIEW (admin queue size), so the drill must include both
    // statuses — otherwise the tile reads "5" but the panel shows the
    // UNDER_REVIEW subset (typically 1-2) and the user thinks the page
    // is blank. Two parallel fetches (5+5) keep the panel ≤10 rows.
    loader: (p, t, kpis) => {
      const w = drillWindow(kpis, 'dpr.pendingReview');
      const scope = drillScope(p);
      return Promise.all([
        api.getDprs({ ...scope, status: 'SUBMITTED', limit: 5, ...w }, t).then((d) => d.dprs || []),
        api.getDprs({ ...scope, status: 'UNDER_REVIEW', limit: 5, ...w }, t).then((d) => d.dprs || []),
      ]).then(([a, b]) => [...a, ...b]);
    },
    viewAll: (p, kpis) => {
      const w = drillWindow(kpis, 'dpr.pendingReview');
      const params = { ...w };
      if (p && p.id !== '__all__') params.projectId = encodeURIComponent(p.id || `name:${p.name}`);
      return `/portal/admin/dpr?${new URLSearchParams(params).toString()}`;
    },
  },
  'dpr.approved': {
    label: 'Approved DPRs',
    loader: (p, t, kpis) => {
      const w = drillWindow(kpis, 'dpr.approved');
      return api.getDprs({ ...drillScope(p), status: 'APPROVED', limit: 10, ...w }, t).then((d) => d.dprs || []);
    },
    viewAll: (p, kpis) => {
      const w = drillWindow(kpis, 'dpr.approved');
      const params = { status: 'APPROVED', ...w };
      if (p && p.id !== '__all__') params.projectId = encodeURIComponent(p.id || `name:${p.name}`);
      return `/portal/admin/dpr?${new URLSearchParams(params).toString()}`;
    },
  },
  'dpr.rejected': {
    label: 'Rejected DPRs',
    loader: (p, t, kpis) => {
      const w = drillWindow(kpis, 'dpr.rejected');
      return api.getDprs({ ...drillScope(p), status: 'REJECTED', limit: 10, ...w }, t).then((d) => d.dprs || []);
    },
    viewAll: (p, kpis) => {
      const w = drillWindow(kpis, 'dpr.rejected');
      const params = { status: 'REJECTED', ...w };
      if (p && p.id !== '__all__') params.projectId = encodeURIComponent(p.id || `name:${p.name}`);
      return `/portal/admin/dpr?${new URLSearchParams(params).toString()}`;
    },
  },
  'inspection.total': {
    label: 'Inspections',
    loader: (p, t, kpis) => {
      const w = drillWindow(kpis, 'inspection.total');
      return api.getInspections({ ...drillScope(p), limit: 10, ...w }, t).then((d) => d.inspections || d.records || []);
    },
    viewAll: (p, kpis) => {
      const w = drillWindow(kpis, 'inspection.total');
      const params = { ...w };
      if (p && p.id !== '__all__') params.projectId = encodeURIComponent(p.id || `name:${p.name}`);
      return `/portal/admin/inspection?${new URLSearchParams(params).toString()}`;
    },
  },
  'inspection.open': {
    // DR-013: OPEN backlog is intentionally all-date (org-wide "what's
    // waiting on me" — see kpiHandler:1562). The drill ignores the KPI
    // window so old OPEN inspections stay visible.
    label: 'Open Inspections',
    loader: (p, t) => api.getInspections({ ...drillScope(p), status: 'OPEN', limit: 10 }, t).then((d) => d.inspections || d.records || []),
    viewAll: (p) => {
      const params = { status: 'OPEN' };
      if (p && p.id !== '__all__') params.projectId = encodeURIComponent(p.id || `name:${p.name}`);
      return `/portal/admin/inspection?${new URLSearchParams(params).toString()}`;
    },
  },
  'boq.items': {
    label: 'BOQ Items',
    loader: (p, t) => api.getBoqItems({ ...drillScope(p), limit: 10 }, t).then((d) => d.items || d.boq || []),
    viewAll: (p) => {
      if (p && p.id === '__all__') return `/portal/admin/boq`;
      const idParam = encodeURIComponent(p.id || `name:${p.name}`);
      return `/portal/admin/boq?projectId=${idParam}`;
    },
  },
  'boq.variance': {
    label: 'BOQ Variance Items',
    loader: (p, t) => api.getBoqItems({ ...drillScope(p), varianceOnly: true, limit: 10 }, t).then((d) => d.items || d.boq || []),
    viewAll: (p) => {
      if (p && p.id === '__all__') return `/portal/admin/boq`;
      const idParam = encodeURIComponent(p.id || `name:${p.name}`);
      return `/portal/admin/boq?projectId=${idParam}`;
    },
  },
};

// N17 (Project-level dashboard with KPI tiles): PM's daily landing page.
//
// One page that surfaces five roll-up buckets scoped to a single project:
//   1. Daily Reports  — submitted / pending / approved / rejected / drafts
//   2. Inspections    — total (window), open (org-wide), breakdown by type
//   3. BOQ Variance   — item count, contract INR, executed INR, variance %
//   4. People         — on leave today, pending leave, overdue training
// (Round-29: the standalone Cube Tests section was dropped; cube
// testing is captured under the cube_casting / cube_testing
// InspectionRecord sub-types.)
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
//
// Round-34 Feature 4: this used to be a `<Link>` that drilled through
// to the filtered admin queue. The user wants the data inline instead
// — so every actionable tile is now an accordion `<button>` that
// toggles `expandedTile` and renders an InlineDrillPanel below the
// section. `to` is gone; the in-page navigation is the new affordance.
function StatTile({ icon, number, label, tone = 'neutral', sub, tileKey, isExpanded, onToggle }) {
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
  const inner = (
    <>
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
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem',
        }}
      >
        <span>{label}</span>
        {tileKey ? (
          <span aria-hidden="true" style={{
            fontSize: '0.78rem',
            color: 'var(--blue, #0066FF)',
            transform: isExpanded ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.15s ease',
          }}>▾</span>
        ) : null}
      </div>
      {sub ? (
        <div style={{ fontSize: '0.78rem', color: 'var(--steel, #64748b)' }}>{sub}</div>
      ) : null}
    </>
  );

  const cardStyle = {
    padding: '1rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    minHeight: 110,
    textAlign: 'left',
    cursor: tileKey ? 'pointer' : 'default',
    background: 'white',
  };

  // Accordion toggle — only when tileKey is provided. Without it we
  // render the passive `<div>` (Drafts / On Leave Today are not
  // actionable enough to merit an inline panel).
  if (tileKey) {
    return (
      <button
        type="button"
        onClick={() => onToggle(tileKey)}
        aria-expanded={!!isExpanded}
        aria-controls={`drill-${tileKey}`}
        className="dpr-card dpr-tile-link"
        style={{ ...cardStyle, textDecoration: 'none', color: 'inherit', border: 'none' }}
      >
        {inner}
      </button>
    );
  }
  return (
    <div className="dpr-card" style={cardStyle}>
      {inner}
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
  // Round-29: ICONS.cube REMOVED — the standalone cube-test feature is
  // gone; cube testing is captured by the cube_casting / cube_testing
  // InspectionRecord sub-types.
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

// R38.1 — all-projects KPI aggregation helpers. These run client-side
// over an array of single-project KPI payloads fetched in parallel
// (loadKpis fan-out path). No backend endpoint change — the per-project
// /projects/:id/kpis response is the unit; we just sum the buckets.

// Empty KPI payload — same shape as a real response so downstream code
// (the tile renderers + chart consumers) doesn't need to special-case
// "no projects yet".
function emptyKpiPayload() {
  return {
    window: { from: null, to: null },
    dpr: {
      submittedCount: 0,
      pendingReviewCount: 0,
      approvedCount: 0,
      rejectedCount: 0,
      draftCount: 0,
    },
    inspections: { totalCount: 0, openCount: 0, byType: {} },
    boq: { itemCount: 0, contractValue: 0, executedValue: 0, variancePct: 0 },
    people: { onLeaveTodayCount: 0, pendingLeaveCount: 0, overdueTrainingCount: 0 },
    cubeTests: { dueSoonCount: 0, overdueCount: 0, passedCount: 0 },
    pendingReviewTrend: [],
    warnings: [],
  };
}

// Sum an array of single-project KPI payloads into one org-wide
// payload. Counts and money totals add; the byType map is the union of
// every project (same key in two projects → counts combine); the
// pendingReviewTrend is appended across projects then re-sorted by
// date bucket (the project endpoint returns one row per UTC-midnight
// date; combining across projects is a true merge).
function sumKpiPayloads(payloads) {
  const out = emptyKpiPayload();
  const trend = new Map();
  payloads.forEach((p) => {
    if (!p) return;
    if (p.window && p.window.from) {
      // Earliest from — earliest wins; latest to — latest wins; the
      // window is "where the data lives" so the union window is the
      // widest plausible one.
      if (!out.window.from || p.window.from < out.window.from) out.window.from = p.window.from;
      if (!out.window.to || p.window.to > out.window.to) out.window.to = p.window.to;
    }
    if (p.dpr) {
      out.dpr.submittedCount += Number(p.dpr.submittedCount) || 0;
      out.dpr.pendingReviewCount += Number(p.dpr.pendingReviewCount) || 0;
      out.dpr.approvedCount += Number(p.dpr.approvedCount) || 0;
      out.dpr.rejectedCount += Number(p.dpr.rejectedCount) || 0;
      out.dpr.draftCount += Number(p.dpr.draftCount) || 0;
    }
    if (p.inspections) {
      out.inspections.totalCount += Number(p.inspections.totalCount) || 0;
      out.inspections.openCount += Number(p.inspections.openCount) || 0;
      if (p.inspections.byType && typeof p.inspections.byType === 'object') {
        Object.entries(p.inspections.byType).forEach(([k, v]) => {
          out.inspections.byType[k] = (out.inspections.byType[k] || 0) + (Number(v) || 0);
        });
      }
    }
    if (p.boq) {
      out.boq.itemCount += Number(p.boq.itemCount) || 0;
      out.boq.contractValue += Number(p.boq.contractValue) || 0;
      out.boq.executedValue += Number(p.boq.executedValue) || 0;
      // variancePct is a derived ratio — recompute from the summed
      // contract / executed so it stays mathematically consistent.
      // (We can't just average or it'll drift.)
    }
    if (p.people) {
      out.people.onLeaveTodayCount += Number(p.people.onLeaveTodayCount) || 0;
      out.people.pendingLeaveCount += Number(p.people.pendingLeaveCount) || 0;
      out.people.overdueTrainingCount += Number(p.people.overdueTrainingCount) || 0;
    }
    if (Array.isArray(p.pendingReviewTrend)) {
      p.pendingReviewTrend.forEach((row) => {
        const key = row.date || row.day || row.label;
        if (!key) return;
        const prev = trend.get(key) || { date: key, submitted: 0, underReview: 0 };
        prev.submitted += Number(row.submitted) || 0;
        prev.underReview += Number(row.underReview) || 0;
        trend.set(key, prev);
      });
    }
    if (Array.isArray(p.warnings)) out.warnings.push(...p.warnings);
  });
  // Recompute variancePct from summed contract + executed so the
  // "All projects" tile reads the same number it would if there were
  // a single org-wide BOQ row.
  if (out.boq.contractValue > 0) {
    out.boq.variancePct = ((out.boq.executedValue - out.boq.contractValue) / out.boq.contractValue) * 100;
  } else {
    out.boq.variancePct = 0;
  }
  // Sort trend by date key so the chart's X axis stays monotonic.
  out.pendingReviewTrend = Array.from(trend.values()).sort((a, b) =>
    String(a.date).localeCompare(String(b.date)),
  );
  return out;
}

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
  //
  // R38.1: the `id: '__all__'` sentinel selects "All projects" — the
  // dashboard then fans out per-project KPI calls + fetches unscoped
  // chart lists so the tiles + charts roll up across every project the
  // admin can see. The sentinel is intentionally a non-UUID string
  // so a route like `#/portal/admin/project-dashboard` lands on the
  // org-wide view by default.
  const ALL_PROJECTS_ID = '__all__';
  const [selectedProject, setSelectedProject] = useState({ id: ALL_PROJECTS_ID, name: 'All projects', isRegistered: false });
  // TDZ note: `isAllProjects` MUST come AFTER the `useState` call
  // above — it reads `selectedProject`, and `const`-declared bindings
  // are not initialised until the line that declares them runs. Live
  // crash on f0a574b: "Cannot access 'p' before initialization" because
  // the declaration was above the useState. Don't reorder.
  const isAllProjects = (selectedProject && selectedProject.id === ALL_PROJECTS_ID) || false;

  // KPI payload from /api/projects/:idOrName/kpis
  const [kpis, setKpis] = useState(null);
  const [loadingKpis, setLoadingKpis] = useState(false);
  const [kpisError, setKpisError] = useState('');

  // DR-012 — selection churn guard. Wrap setSelectedProject so an
  // effect-driven re-evaluation (URL match, list reload) doesn't churn
  // state for the same canonical project. Without this, every load
  // re-issued the selection and the mount effect re-fired loadProjects
  // + loadKpis (15 project-list + 14 KPI requests in 2,498ms while idle).
  const setSelectedProjectIfChanged = useCallback((next) => {
    setSelectedProject((prev) => {
      if (!prev) return next;
      if (prev.id && next.id && prev.id === next.id) return prev;
      if (!prev.id && !next.id && prev.name === next.name) return prev;
      return next;
    });
  }, []);

  // DR-012 — mirror the selectedProject into a ref so loadProjects can
  // consult it without having `selectedProject` in its deps. The deps
  // entry was the loop source: every selection churn re-bound
  // loadProjects, which re-fired the mount effect (which calls
  // loadProjects again). Refs keep the callback stable across selection
  // changes.
  const selectedProjectRef = useRef(null);
  useEffect(() => {
    selectedProjectRef.current = selectedProject;
  }, [selectedProject]);

  // R38.1 — mirror the registered projects list into a ref so the
  // all-projects KPI fan-out (loadKpis) can read it without re-binding
  // loadKpis on every project-list refresh. Same DR-012 pattern as
  // selectedProjectRef above.
  const projectsRef = useRef([]);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  // Lookback window in days. 30 = default. "all" is sent as 365 — the
  // backend clamps to 365 and we surface that in the window sub-line.
  const [days, setDays] = useState(30);

  // Round-34 Feature 4: inline drill-down accordion state. Single-open
  // — only one tile can be expanded at a time across the whole
  // dashboard. Mirrors the Round-33 Projects.jsx `expandedKey` pattern
  // so the mental model is consistent.
  const [searchParams, setSearchParams] = useSearchParams();
  const urlTile = searchParams.get('tile') || '';
  // DR-014: `?project=<id-or-name>` deep-link from the registry
  // (ProjectsAdmin → "Open dashboard" on row click) was previously
  // ignored — the dashboard auto-selected the first registered project
  // instead. Read it as the canonical selection once the project list
  // lands; until then we fall back to the existing auto-select.
  const urlProject = searchParams.get('project') || '';
  const [expandedTile, setExpandedTile] = useState(urlTile || null);
  // Mirror URL → state when the user lands on a tile=… link or
  // back-navigates to one. Same pattern as DprDashboard.jsx:70-81.
  useEffect(() => {
    if (urlTile !== expandedTile) setExpandedTile(urlTile || null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlTile]);
  // Mirror state → URL on every expansion change so the panel is
  // shareable / bookmark-able. Guard against the echo from the URL→
  // state effect above so we don't churn history on mount.
  useEffect(() => {
    const current = searchParams.get('tile') || '';
    if ((expandedTile || '') === current) return;
    const next = new URLSearchParams(searchParams);
    if (expandedTile) next.set('tile', expandedTile);
    else next.delete('tile');
    setSearchParams(next, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedTile]);

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
      const data = await api.getProjects({ scope: 'all' }, accessToken);
      if (!mountedRef.current) return;
      const list = data.projects || [];
      const disc = data.discovered || [];
      setProjects(list);
      setDiscovered(disc);
      // Auto-select first project (registered wins over discovered —
      // they have richer metadata). Reads selectedProjectRef so this
      // callback does NOT depend on selectedProject (DR-012 — was the
      // source of the request cycle: selection churn re-bound
      // loadProjects, which re-fired the mount effect, which called
      // loadProjects + loadKpis again).
      if (!selectedProjectRef.current && list.length > 0) {
        setSelectedProjectIfChanged({ id: list[0].id, name: list[0].name, isRegistered: true });
      } else if (!selectedProjectRef.current && disc.length > 0) {
        setSelectedProjectIfChanged({ id: null, name: disc[0].name, isRegistered: false });
      }
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err?.message || 'Failed to load projects';
      toast.push(msg, 'error');
    } finally {
      if (mountedRef.current) setLoadingProjects(false);
    }
  }, [accessToken, toast, setSelectedProjectIfChanged]);

  // DR-012 — consume `?project=<id-or-name>` after the project list lands.
  // Three passes, in priority order:
  //   1. Exact UUID match against registered projects (preferred — this
  //      is what the registry button now emits).
  //   2. Decoded name match against registered projects (legacy
  //      bookmarks / shared links emitted encoded names).
  //   3. Decoded name match against discovered (not-yet-registered)
  //      names. Discovered entries have no id, so name is the only key.
  // When matched, this REPLACES the auto-selected first project so the
  // URL controls the dashboard. setSelectedProjectIfChanged guards
  // against re-issuing the same selection (which would re-fire the
  // load chain). Empty / no-match `?project=` falls through to the
  // auto-select.
  useEffect(() => {
    if (!urlProject) return;
    if (projects.length === 0 && discovered.length === 0) return;
    const decoded = decodeURIComponent(urlProject);
    const reg = projects.find((p) => p.id === urlProject);
    if (reg) {
      setSelectedProjectIfChanged({ id: reg.id, name: reg.name, isRegistered: true });
      return;
    }
    const regByName = projects.find((p) => p.name === decoded);
    if (regByName) {
      setSelectedProjectIfChanged({ id: regByName.id, name: regByName.name, isRegistered: true });
      return;
    }
    const disc = discovered.find((d) => d.name === decoded);
    if (disc) {
      setSelectedProjectIfChanged({ id: null, name: disc.name, isRegistered: false });
    }
  }, [urlProject, projects, discovered, setSelectedProjectIfChanged]);

  // DR-012 — KPI request epoch. Each load increments the counter; an
  // older in-flight load bails out in its then()/catch instead of
  // overwriting fresh state. Same pattern as InlineDrillPanel's
  // epochRef below — applied to the top-level KPI load so a delayed
  // response for project A can't overwrite current project B.
  const kpiEpochRef = useRef(0);

  // KPI fetch — depends on (selectedProject, days). Aborts on unmount
  // and on superseded requests (epoch mismatch).
  const loadKpis = useCallback(async () => {
    if (!selectedProject) return;
    const myEpoch = ++kpiEpochRef.current;
    setLoadingKpis(true);
    setKpisError('');
    try {
      let data;
      if (isAllProjects) {
        // R38.1 — fan-out per registered project and sum the buckets on
        // the client. No new backend endpoint: each call is the same
        // /projects/:id/kpis the single-project path already hits.
        // Skips discovered (name-only) projects — they have no id and
        // the per-project kpis endpoint requires one. If no registered
        // projects, return an empty payload so the chart shell renders
        // a clean "0" rather than crashing.
        const refs = projectsRef.current.map((p) => p.id);
        if (refs.length === 0) {
          data = emptyKpiPayload();
        } else {
          const results = await Promise.all(
            refs.map((id) =>
              api.getProjectKpis(id, days, accessToken).catch((err) => {
                console.warn('All-projects KPI fan-out failed for', id, err?.message);
                return null;
              }),
            ),
          );
          if (!mountedRef.current || myEpoch !== kpiEpochRef.current) return;
          data = sumKpiPayloads(results.filter(Boolean));
        }
      } else {
        // The backend accepts id OR name. We forward whichever we have —
        // id first if registered, otherwise the name. encodeURIComponent
        // inside api.getProjectKpis handles spaces + slashes.
        const ref = selectedProject.id || selectedProject.name;
        data = await api.getProjectKpis(ref, days, accessToken);
      }
      if (!mountedRef.current || myEpoch !== kpiEpochRef.current) return; // stale or unmounted
      setKpis(data);
      // If the backend reported warnings (a sibling roll-up failed),
      // surface the first one as a non-blocking toast. The dashboard
      // still renders — the missing bucket just shows zeros + an empty
      // state sub-line.
      if (Array.isArray(data.warnings) && data.warnings.length > 0) {
        toast.push(
          `Some KPIs could not be loaded: ${data.warnings[0]}`,
          'warning',
        );
      }
    } catch (err) {
      if (!mountedRef.current || myEpoch !== kpiEpochRef.current) return; // stale or unmounted
      const msg = err?.message || 'Failed to load KPIs';
      setKpisError(msg);
      toast.push(msg, 'error');
    } finally {
      if (mountedRef.current && myEpoch === kpiEpochRef.current) setLoadingKpis(false);
    }
  }, [selectedProject, isAllProjects, days, accessToken, toast]);

  // DR-012 — separate mount/visibility-listener ownership from
  // selection churn. The previous effect re-bound whenever loadProjects
  // or loadKpis changed identity, and (because selectedProject was in
  // loadProjects' deps) every selection churn re-registered the
  // visibility listener and re-fired the initial fetch. We now mirror
  // the loaders into refs so this effect runs exactly once at mount.
  const loadProjectsRef = useRef(null);
  const loadKpisRef = useRef(null);
  useEffect(() => { loadProjectsRef.current = loadProjects; }, [loadProjects]);
  useEffect(() => { loadKpisRef.current = loadKpis; }, [loadKpis]);

  // Effects — mount guard + refresh-on-focus so a quick review + back
  // shows fresh counts without a manual reload (same pattern as
  // AdminOverview).
  useEffect(() => {
    mountedRef.current = true;
    loadProjectsRef.current?.();
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        loadProjectsRef.current?.();
        loadKpisRef.current?.();
        loadChartListsRef.current?.();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      mountedRef.current = false;
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // When the selection or window changes, kick a fresh KPI load. The
  // mountedRef guard inside loadKpis prevents a race between the old
  // fetch (in flight when the user clicked) and the new one.
  useEffect(() => {
    if (selectedProject) loadKpis();
  }, [selectedProject, days, loadKpis]);

  // R38: chart data — the three lists we need to aggregate on the
  // client. Loaded in parallel with the KPI call so a project switch
  // does not produce a KPI-then-charts two-step render. Each list
  // is null while its first load is in flight (so the chart sections
  // can render their own "Loading…" sub-line) and stays null when
  // the load fails (the empty-state path takes over).
  const [chartLists, setChartLists] = useState({ dprs: null, inspections: null, boq: null });
  const chartEpochRef = useRef(0);

  const loadChartLists = useCallback(async () => {
    if (!selectedProject) return;
    const myEpoch = ++chartEpochRef.current;
    // R38.1 — all-projects mode drops the projectId/projectName filter
    // so the list endpoints return their org-wide view (the admin queue
    // without a scope). The chart components are unchanged; they consume
    // the rows the same way they consume per-project rows.
    const scope = isAllProjects ? {} : drillScope(selectedProject);
    const w = drillWindow({ window: { from: null, to: null } }, 'dpr.submitted');
    // Use the same window as the KPI call so the trend chart matches
    // the tile counts. For the "all-date" inspection.open path we
    // intentionally pass an empty window so OPEN inspections from
    // any date are counted.
    const inspScope = { ...scope, limit: 200, ...(days ? {} : {}) };
    const dprScope = { ...scope, limit: 200, ...w };
    const boqScope = { ...scope, limit: 200 };
    try {
      const [dprsRes, inspRes, boqRes] = await Promise.all([
        api.getDprs(dprScope, accessToken).catch(() => ({ dprs: [] })),
        api.getInspections(inspScope, accessToken).catch(() => ({ inspections: [] })),
        api.getBoqItems(boqScope, accessToken).catch(() => ({ items: [] })),
      ]);
      if (!mountedRef.current || myEpoch !== chartEpochRef.current) return; // stale
      setChartLists({
        dprs: Array.isArray(dprsRes?.dprs) ? dprsRes.dprs : [],
        inspections: Array.isArray(inspRes?.inspections) ? inspRes.inspections : (Array.isArray(inspRes?.records) ? inspRes.records : []),
        boq: Array.isArray(boqRes?.items) ? boqRes.items : (Array.isArray(boqRes?.boq) ? boqRes.boq : []),
      });
    } catch (err) {
      if (!mountedRef.current || myEpoch !== chartEpochRef.current) return; // stale
      // Fall through to empty state — the chart components handle
      // null/empty data with their own "No data yet" message.
      setChartLists({ dprs: [], inspections: [], boq: [] });
    }
  }, [selectedProject, isAllProjects, days, accessToken]);

  useEffect(() => {
    if (selectedProject) loadChartLists();
  }, [selectedProject, days, loadChartLists]);

  // Mirror the chart loader into a ref so the visibility listener
  // can re-fire it without a deps churn (same pattern as
  // loadProjectsRef / loadKpisRef above).
  const loadChartListsRef = useRef(null);
  useEffect(() => { loadChartListsRef.current = loadChartLists; }, [loadChartLists]);

  // Refresh hook so the page-level "Refresh" button pulls the chart
  // lists in addition to the KPI payload. We add the call to the
  // existing onClick via a ref so we don't have to re-derive it.
  const refreshChartListsRef = useRef(null);
  useEffect(() => { refreshChartListsRef.current = () => loadChartLists(); }, [loadChartLists]);

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
            {/* [DR-025] Drop "Cube Tests" — the Cube Tests TileSection was removed
            in round-29; cube testing is now surfaced through the cube_casting
            / cube_testing InspectionRecord sub-types.
            [R38.1] Subtitle flips in "All projects" mode to make the
            org-wide roll-up obvious to anyone scanning the page. */}
          {isAllProjects
            ? 'KPIs across DPR, Inspections, BOQ, and People — rolled up across every project.'
            : 'KPIs across DPR, Inspections, BOQ, and People — scoped to a single project.'}
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
              // R38.1 — "All projects" sentinel. Selected by default and
              // pinned at the top of the dropdown so the dashboard lands
              // on the org-wide view without the admin needing to
              // re-pick it after every nav.
              if (v === ALL_PROJECTS_ID) {
                setSelectedProjectIfChanged({ id: ALL_PROJECTS_ID, name: 'All projects', isRegistered: false });
                return;
              }
              // Selector values: UUID for registered, "name:<x>" for discovered.
              if (v.startsWith('name:')) {
                setSelectedProjectIfChanged({ id: null, name: v.slice(5), isRegistered: false });
              } else {
                const p = projects.find((x) => x.id === v);
                if (p) setSelectedProjectIfChanged({ id: p.id, name: p.name, isRegistered: true });
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
            {/* R38.1 — all-projects option pinned at the top. Lands the
                dashboard on the org-wide roll-up by default; admins can
                narrow down to a single project from the Registered
                optgroup below. */}
            <option value={ALL_PROJECTS_ID}>All projects</option>
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
            onClick={() => { loadProjects(); loadKpis(); refreshChartListsRef.current?.(); }}
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
          expandedTile={expandedTile}
          setExpandedTile={setExpandedTile}
          accessToken={accessToken}
          chartLists={chartLists}
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
//
// Round-34 Feature 4: receives `expandedTile` / `setExpandedTile` so
// each tile is an accordion toggle. TileSection also gets the
// `tileKeys` array it owns so the InlineDrillPanel only renders
// inside the matching section.
function ProjectKpiView({ kpis, loading, selectedProject, days, expandedTile, setExpandedTile, accessToken, chartLists }) {
  if (loading && !kpis) {
    return (
      <div className="dpr-card" style={{ padding: '2rem', textAlign: 'center', color: 'var(--steel, #64748b)' }}>
        Loading KPIs&hellip;
      </div>
    );
  }
  if (!kpis) return null;

  const project = kpis.project || { name: selectedProject.name, isRegistered: selectedProject.isRegistered };
  // R38.1: in all-projects mode the sentinel `id: '__all__'` would
  // otherwise trip `isDiscovered` (because we stamp `isRegistered:
  // false` on the sentinel object), which then renders an amber "Not
  // yet registered" badge + a "Register this project →" link — wrong
  // and confusing for the org-wide roll-up view. Suppress that branch
  // when the sentinel is active.
  const isAllProjectsView = selectedProject && selectedProject.id === '__all__';
  const isDiscovered = !isAllProjectsView && project.isRegistered === false;
  // Each section owns a list of tile keys so the InlineDrillPanel
  // renders in the correct one when expanded. Drafts / people tiles
  // are not actionable (no list endpoint to drill into), so they
  // stay passive.
  const dprTileKeys = ['dpr.submitted', 'dpr.pendingReview', 'dpr.approved', 'dpr.rejected'];
  const inspectionTileKeys = ['inspection.total', 'inspection.open'];
  const boqTileKeys = ['boq.items', 'boq.variance'];
  const toggle = useCallback((key) => {
    setExpandedTile((curr) => (curr === key ? null : key));
  }, [setExpandedTile]);

  // R38 chart data — pure aggregations over the lists we already
  // fetched in parallel with the KPI call (chartLists). Each block
  // is useMemo'd so the chart components don't re-bucket on every
  // unrelated parent re-render.
  const dprTrendBuckets = useMemo(() => {
    const rows = bucketByDay(chartLists?.dprs || [], days, 'reportDate').rows;
    // Fold the per-day counts into per-day per-status buckets. We do
    // this in one pass so the chart's <Area dataKey> matches the
    // field name and we don't loop the list 4 times.
    const byDay = Object.create(null);
    rows.forEach((r) => { byDay[r.day] = { day: r.day, submitted: 0, underReview: 0, approved: 0, rejected: 0 }; });
    (chartLists?.dprs || []).forEach((row) => {
      if (!row) return;
      const day = (row.reportDate || '').slice(0, 10);
      if (!(day in byDay)) return; // outside the window
      const status = String(row.status || '').toUpperCase();
      if (status === 'SUBMITTED') byDay[day].submitted += 1;
      else if (status === 'UNDER_REVIEW') byDay[day].underReview += 1;
      else if (status === 'APPROVED') byDay[day].approved += 1;
      else if (status === 'REJECTED') byDay[day].rejected += 1;
    });
    return rows.map((r) => byDay[r.day]);
  }, [chartLists?.dprs, days]);

  const boqTopN = useMemo(() => byLineItemTopN(chartLists?.boq || [], 10).rows, [chartLists?.boq]);

  const peopleBuckets = useMemo(() => {
    // Combine DPR + Inspection rows. Both shapes carry
    // reportDate + an employee identifier (submittedById /
    // inspectedById). The kpiBuckets function does the bucket math.
    const combined = [
      ...(chartLists?.dprs || []),
      ...(chartLists?.inspections || []),
    ];
    return byEmployeeWeek(combined, 28);
  }, [chartLists?.dprs, chartLists?.inspections]);

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

      <TileSection
        title="Daily Reports"
        tileKeys={dprTileKeys}
        expandedTile={expandedTile}
        setExpandedTile={setExpandedTile}
        project={project}
        kpis={kpis}
        accessToken={accessToken}
      >
        <StatTile
          icon={ICONS.dpr}
          number={kpis.dpr?.submittedCount ?? 0}
          label="Submitted"
          sub={`${kpis.dpr?.pendingReviewCount ?? 0} awaiting review`}
          tileKey="dpr.submitted"
          isExpanded={expandedTile === 'dpr.submitted'}
          onToggle={toggle}
        />
        <StatSparklineTile
          icon={ICONS.pending}
          number={kpis.dpr?.pendingReviewCount ?? 0}
          label="Pending Review"
          tone={(kpis.dpr?.pendingReviewCount ?? 0) > 0 ? 'warning' : 'neutral'}
          sub="Submitted + Under Review · 14-day trend"
          // R38 plan §6: embedded sparkline — last 14 days of
          // SUBMITTED + UNDER_REVIEW counts. The function returns
          // 14 zero-count rows for an empty input so the sparkline
          // SVG renders a flat baseline (not "no chart at all").
          points={pendingReviewSparkline(
            (chartLists?.dprs || []).filter(
              (r) => r && (r.status === 'SUBMITTED' || r.status === 'UNDER_REVIEW'),
            ),
          ).rows}
          tileKey="dpr.pendingReview"
          isExpanded={expandedTile === 'dpr.pendingReview'}
          onToggle={toggle}
        />
        <StatTile
          icon={ICONS.check}
          number={kpis.dpr?.approvedCount ?? 0}
          label="Approved"
          tone={(kpis.dpr?.approvedCount ?? 0) > 0 ? 'good' : 'neutral'}
          tileKey="dpr.approved"
          isExpanded={expandedTile === 'dpr.approved'}
          onToggle={toggle}
        />
        <StatTile
          icon={ICONS.reject}
          number={kpis.dpr?.rejectedCount ?? 0}
          label="Rejected"
          tone={(kpis.dpr?.rejectedCount ?? 0) > 0 ? 'critical' : 'neutral'}
          tileKey="dpr.rejected"
          isExpanded={expandedTile === 'dpr.rejected'}
          onToggle={toggle}
        />
        <StatTile
          icon={ICONS.draft}
          number={kpis.dpr?.draftCount ?? 0}
          label="Drafts"
          sub="Owner-only, not yet submitted"
        />
      </TileSection>

      <TileSection
        title="Inspections"
        tileKeys={inspectionTileKeys}
        expandedTile={expandedTile}
        setExpandedTile={setExpandedTile}
        project={project}
        kpis={kpis}
        accessToken={accessToken}
      >
        <StatTile
          icon={ICONS.inspection}
          number={kpis.inspections?.totalCount ?? 0}
          label="Total (window)"
          sub={`${kpis.inspections?.openCount ?? 0} currently open`}
          tileKey="inspection.total"
          isExpanded={expandedTile === 'inspection.total'}
          onToggle={toggle}
        />
        <StatTile
          icon={ICONS.pending}
          number={kpis.inspections?.openCount ?? 0}
          label="Open"
          tone={(kpis.inspections?.openCount ?? 0) > 0 ? 'warning' : 'neutral'}
          sub="Across all of this project"
          tileKey="inspection.open"
          isExpanded={expandedTile === 'inspection.open'}
          onToggle={toggle}
        />
        {/* R38 chart #2 — inspection-type donut. We pull
            kpis.inspections.byType (already server-aggregated) and
            pass the slice colour from the same status palette the
            tile numbers use, so a glance at the donut matches the
            glance at the chips it replaced. The donut itself is
            loaded via React.lazy so recharts only enters the chunk
            when an admin opens this page (see ProjectDashboardCharts.jsx
            for the actual render + empty-state handling). */}
        <React.Suspense fallback={<ChartLoadingPlaceholder variant="donut" />}>
          <InspectionDonutCard
            byType={kpis.inspections?.byType || {}}
            totalCount={kpis.inspections?.totalCount ?? 0}
          />
        </React.Suspense>
      </TileSection>

      {/* Round-29: Cube Tests TileSection REMOVED — the standalone
          cube-test feature is gone; cube testing is captured by the
          cube_casting / cube_testing InspectionRecord sub-types. */}

      <TileSection
        title="BOQ Variance"
        tileKeys={boqTileKeys}
        expandedTile={expandedTile}
        setExpandedTile={setExpandedTile}
        project={project}
        kpis={kpis}
        accessToken={accessToken}
      >
        <StatTile
          icon={ICONS.cube}
          number={kpis.boqVariance?.itemsCount ?? 0}
          label="Items"
          sub="Active line items in BOQ"
          tileKey="boq.items"
          isExpanded={expandedTile === 'boq.items'}
          onToggle={toggle}
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
          tileKey="boq.variance"
          isExpanded={expandedTile === 'boq.variance'}
          onToggle={toggle}
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

      {/* R38 charts #1, #3, #4, #5 — lazy-loaded chart chunk. The
          recharts-using pieces (area chart, BOQ bar, inspection
          funnel, people heatmap) all live in ProjectDashboardCharts.jsx
          so they don't add ~50 kB gz to every admin page. While
          the chunk loads, the four ChartLoadingPlaceholder cards
          keep the page layout stable so the rest of the dashboard
          doesn't shift. */}
      <React.Suspense
        fallback={
          <ChartLoadingPlaceholderGroup count={4} />
        }
      >
        <ProjectDashboardCharts
          kpis={kpis}
          dprTrendBuckets={dprTrendBuckets}
          boqTopN={boqTopN}
          peopleBuckets={peopleBuckets}
        />
      </React.Suspense>

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
//
// Round-34 Feature 4: `to` is gone (was a section-level drill Link).
// Each tile is now its own accordion toggle; this container just
// renders the grid + an InlineDrillPanel as a full-width child when
// one of its `tileKeys` matches the parent's `expandedTile`.
//
// `tileKeys` is the list of accordion keys this section owns —
// required so a single expandedTile only renders in one section.
function TileSection({ title, tileKeys, expandedTile, setExpandedTile, project, kpis, accessToken, children }) {
  const expandedInSection = expandedTile && tileKeys && tileKeys.includes(expandedTile);
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
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
        }}
      >
        {title}
        {expandedInSection ? (
          <button
            type="button"
            onClick={() => setExpandedTile(null)}
            aria-label={`Close ${title} panel`}
            style={{
              marginLeft: 'auto',
              fontSize: '0.78rem',
              color: 'var(--blue, #0066FF)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              textTransform: 'none',
              letterSpacing: 'normal',
              fontWeight: 600,
            }}
          >
            Close ✕
          </button>
        ) : null}
      </h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: '0.75rem',
        }}
      >
        {children}
        {expandedInSection ? (
          <div style={{ gridColumn: '1 / -1' }} key={`drill-wrap-${expandedTile}`}>
            <InlineDrillPanel
              tileKey={expandedTile}
              project={project}
              kpis={kpis}
              accessToken={accessToken}
              onClose={() => setExpandedTile(null)}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

// InlineDrillPanel — the rows-below-the-tile list. Round-34 Feature 4:
// clicking a tile (e.g. "Submitted") fetches the same backend list
// endpoint the admin queue uses, scoped by `projectId`, and renders
// up to 10 rows with a "View all →" footer link to the full admin
// queue. Same shape regardless of bucket (DPR vs Inspection vs BOQ)
// — content is driven by TILE_META + a small renderRow function
// that picks the fields each bucket exposes (date / subject /
// status / amount).
//
// DR-013: drill loaders now take `kpis` so they can pass the same
// window + status + exact-project scope as the tile. View-all links
// carry the same params so the queue page opens pre-filtered.
//
// Stale-response guard: each load stores a per-tile epoch counter in
// a ref. A tile click while a previous load is still in flight just
// increments the epoch, so the older load's then() bails out instead
// of overwriting the fresh state.
function InlineDrillPanel({ tileKey, project, kpis, accessToken, onClose }) {
  const meta = TILE_META[tileKey];
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState('idle'); // idle | loading | ready | error
  const [errorMsg, setErrorMsg] = useState('');
  const epochRef = useRef(0);

  useEffect(() => {
    if (!meta) return;
    const myEpoch = ++epochRef.current;
    setStatus('loading');
    setErrorMsg('');
    setRows([]);
    meta.loader(project, accessToken, kpis)
      .then((data) => {
        if (myEpoch !== epochRef.current) return; // stale
        setRows(Array.isArray(data) ? data : []);
        setStatus('ready');
      })
      .catch((err) => {
        if (myEpoch !== epochRef.current) return; // stale
        setErrorMsg(err?.message || 'Failed to load rows');
        setStatus('error');
      });
    // We intentionally re-bind on tileKey so flipping between tiles
    // re-fetches. project/accessToken are stable per selection.
  }, [tileKey, project?.id, project?.name, accessToken, kpis, meta]);

  if (!meta) return null;
  const viewAllHref = meta.viewAll(project, kpis);

  return (
    <div
      id={`drill-${tileKey}`}
      className="dpr-card"
      style={{ padding: '1rem 1.25rem' }}
      role="region"
      aria-label={meta.label}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.6rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 600, fontSize: '0.95rem', color: 'var(--navy, #0f172a)' }}>
          {meta.label}
        </div>
        <div style={{ fontSize: '0.78rem', color: 'var(--steel, #64748b)' }}>
          {status === 'ready' ? `${rows.length} row${rows.length === 1 ? '' : 's'}` : ''}
        </div>
      </div>

      {status === 'loading' ? (
        <div style={{ fontSize: '0.85rem', color: 'var(--steel, #64748b)', padding: '0.5rem 0' }}>Loading…</div>
      ) : status === 'error' ? (
        <div style={{ fontSize: '0.85rem', color: 'var(--red, #dc2626)', padding: '0.5rem 0' }}>{errorMsg}</div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: '0.85rem', color: 'var(--steel, #64748b)', padding: '0.5rem 0' }}>
          No items in this bucket. <Link to={viewAllHref} style={{ color: 'var(--blue, #0066FF)', fontWeight: 600 }}>View all →</Link>
        </div>
      ) : (
        <>
          <div role="list" style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {rows.map((row) => (
              <DrillRow key={row.id} row={row} tileKey={tileKey} />
            ))}
          </div>
          <div style={{ marginTop: '0.75rem', borderTop: '1px solid var(--steel, #e2e8f0)', paddingTop: '0.6rem' }}>
            <Link to={viewAllHref} style={{ color: 'var(--blue, #0066FF)', fontWeight: 600, fontSize: '0.88rem' }}>
              View all → full queue
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

// DrillRow — one row per record. Driven by tileKey so DPR rows
// show reportDate + status, Inspection rows show reportDate + type +
// status, BOQ rows show itemDescription + variance%. We deliberately
// keep this small (no second-level action buttons) — drill-through
// happens by clicking the row link to the matching queue/detail page.
//
// DR-013: drill rows open real mounted routes with a `focus=<id>`
// consumer so the destination queue auto-scrolls to + highlights the
// row. Invented `/admin/dpr/:id` etc. were 404s; the existing mounted
// surfaces are the admin DPR / Inspection / BOQ queues (focus consumer)
// and the existing `/portal/inspection/:id` detail page (no admin-only
// duplicate exists). Project + window + status travel in the URL so the
// queue opens pre-filtered.
function DrillRow({ row, tileKey }) {
  const isDpr = tileKey.startsWith('dpr.');
  const isInspection = tileKey.startsWith('inspection.');
  const isBoq = tileKey.startsWith('boq.');

  let detailHref = '#';
  let primary = '';
  let secondary = '';
  let statusLabel = '';

  if (isDpr) {
    // Real mounted queue with focus highlight — admin/dpr is DprDashboard.jsx.
    detailHref = `/portal/admin/dpr?focus=${encodeURIComponent(row.id)}`;
    primary = row.subject || `DPR ${String(row.id).slice(0, 8)}`;
    secondary = row.reportDate ? formatShortDate(row.reportDate) : '';
    statusLabel = row.status || '';
  } else if (isInspection) {
    // Inspection has a real detail route at /portal/inspection/:id
    // (InspectionDetail.jsx). It renders for admins as well as the
    // submitter — the existing detail surface already carries all the
    // inspection metadata + photos.
    detailHref = `/portal/inspection/${row.id}`;
    primary = row.subject || prettyInspectionType(row.subWorkType || row.type) || `Inspection ${String(row.id).slice(0, 8)}`;
    secondary = row.reportDate ? formatShortDate(row.reportDate) : '';
    statusLabel = row.status || '';
  } else if (isBoq) {
    // BoqAdmin has no /:id detail — open the queue with focus highlight.
    detailHref = `/portal/admin/boq?focus=${encodeURIComponent(row.id)}`;
    primary = row.itemDescription || row.description || `Item ${String(row.id).slice(0, 8)}`;
    secondary = row.contractValue ? `Contract ₹${Number(row.contractValue).toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '';
    statusLabel = row.variancePercent != null ? `${Number(row.variancePercent).toFixed(1)}%` : '';
  }

  return (
    <Link
      to={detailHref}
      role="listitem"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '0.75rem',
        padding: '0.5rem 0.75rem',
        borderRadius: 6,
        border: '1px solid var(--steel, #e2e8f0)',
        textDecoration: 'none',
        color: 'inherit',
        background: 'white',
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{
          fontSize: '0.88rem',
          fontWeight: 600,
          color: 'var(--navy, #0f172a)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>{primary}</div>
        {secondary ? (
          <div style={{ fontSize: '0.78rem', color: 'var(--steel, #64748b)', marginTop: 2 }}>{secondary}</div>
        ) : null}
      </div>
      {statusLabel ? (
        <StatusBadge label={statusLabel} />
      ) : null}
      <span aria-hidden="true" style={{ color: 'var(--blue, #0066FF)', fontSize: '0.95rem' }}>→</span>
    </Link>
  );
}

// ──── R38 chart loaders ───────────────────────────────────────────────────
//
// The recharts-using chart components live in ProjectDashboardCharts.jsx
// so they only enter the bundle when an admin opens
// /portal/admin/project-dashboard (lazy import at the top of this
// file). The placeholders below are intentionally tiny and have NO
// recharts dependency so they render synchronously during the Suspense
// window — the user sees stable-sized "Loading chart…" cards rather
// than layout shift when the chunk lands.

// ChartLoadingPlaceholder — one card. The `variant` lets us keep
// the donut placeholder narrower than the section placeholders so
// the inspection TileSection doesn't grow a tall blank column.
function ChartLoadingPlaceholder({ variant = 'section' }) {
  const isDonut = variant === 'donut';
  return (
    <div
      className="dpr-card"
      style={{
        padding: '1rem 1.25rem',
        minHeight: isDonut ? 220 : 180,
        gridColumn: isDonut ? '1 / -1' : undefined,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--steel, #64748b)',
        fontSize: '0.85rem',
      }}
      role="status"
      aria-live="polite"
    >
      Loading chart…
    </div>
  );
}

// ChartLoadingPlaceholderGroup — renders N section placeholders for
// the lazy ProjectDashboardCharts chunk. The donut placeholder is
// rendered separately by the TileSection's own Suspense.
function ChartLoadingPlaceholderGroup({ count = 4 }) {
  const cards = [];
  for (let i = 0; i < count; i += 1) cards.push(<ChartLoadingPlaceholder key={i} variant="section" />);
  return <>{cards}</>;
}