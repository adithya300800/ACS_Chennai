// ProjectDashboardCharts — all recharts-using chart sections for the
// Project Dashboard, in their own module so the parent page can
// `React.lazy()` it. The split is intentional: recharts is a ~50 kB
// gz dependency and only admins who open /portal/admin/project-dashboard
// need it. Keeping it out of the main ProjectDashboard chunk keeps
// every other admin page at its old bundle size (Phase 2 — the
// original chunk was 452.76 kB / 129.06 kB gz, +81.8% over budget;
// lazy-loading drops the main chunk to its pre-R38 size and puts
// recharts into a separate chunk that only loads on demand).
//
// This file is loaded once when the dashboard opens. Inside it we
// import the shadcn chart wrappers + recharts primitives directly,
// plus the kpiBuckets helpers. The parent page owns the data
// fetching (loadChartLists) and passes the bucketed rows in as
// props so this module stays a pure render layer.

import React, { useMemo } from 'react';
import { DashboardAreaChart } from '../../components/ui/chart/AreaChart.jsx';
import { DashboardDonutChart } from '../../components/ui/chart/DonutChart.jsx';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '../../components/ui/chart/ChartContainer.jsx';
import {
  BarChart as RechartsBarChart,
  Bar as RechartsBar,
  CartesianGrid,
  XAxis,
  YAxis,
} from 'recharts';

// prettyInspectionType — mirrors the helper inlined in the parent
// page's Inspections section. We keep a local copy here so the lazy
// chunk has no eager runtime dependency on the parent's source.
function prettyInspectionType(slug) {
  if (!slug) return '';
  return String(slug)
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// ChartSection — the .dpr-card shell for the chart panels. Mirrors
// the TileSection heading style (uppercase, 0.78rem, steel,
// 0.06em tracking) so the eye reads "Daily Reports / Inspections /
// People / DPR activity / BOQ top variances / ..." as one column.
function ChartSection({ title, subtitle, children }) {
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
      <div className="dpr-card" style={{ padding: '1rem 1.25rem' }}>
        {subtitle ? (
          <div
            style={{
              fontSize: '0.78rem',
              color: 'var(--steel, #64748b)',
              marginBottom: 12,
            }}
          >
            {subtitle}
          </div>
        ) : null}
        {children}
      </div>
    </section>
  );
}

// InspectionDonutCard — the "Inspections by type" donut, originally
// rendered inline inside the Inspections TileSection. The parent
// page passes the byType map + the window total; we wrap the donut
// in the same .dpr-card shell it had inline.
function InspectionDonutCard({ byType, totalCount }) {
  const data = useMemo(() => {
    return Object.entries(byType || {}).map(([type, count], i) => ({
      key: type,
      name: prettyInspectionType(type),
      value: Number(count) || 0,
      // Use a fixed sequence of brand-token colours so the donut
      // reads as one chart even if backend adds a new sub-work-type.
      // Beyond 8 types the colour wraps — fine, the legend names
      // the type.
      color: [
        'var(--blue, #0066FF)',
        'var(--green, #16a34a)',
        'var(--amber, #d97706)',
        'var(--red, #dc2626)',
        '#0ea5e9',
        '#7c3aed',
        '#db2777',
        '#0d9488',
      ][i % 8],
    }));
  }, [byType]);

  return (
    <div
      className="dpr-card"
      style={{ padding: '1rem' }}
      data-chart-section="inspection-by-type"
    >
      <div
        style={{
          fontFamily: "'Plus Jakarta Sans', sans-serif",
          fontWeight: 600,
          fontSize: '0.85rem',
          color: 'var(--navy, #0f172a)',
          marginBottom: '0.5rem',
        }}
      >
        Inspections by type
      </div>
      <DashboardDonutChart
        data={data}
        centerLabel={String(totalCount || 0)}
        centerSubLabel="inspections"
        emptyMessage="No inspections recorded in this window yet."
        ariaLabel={`Inspection type breakdown. ${totalCount || 0} inspections total.`}
      />
    </div>
  );
}

// BoqTopNBar — horizontal grouped bar of contract vs. executed
// values, sorted by the byLineItemTopN order (highest absolute
// variance first). Uses recharts primitives directly with the
// shared ChartContainer so the colour-token convention is the
// same as the area + donut charts above.
function BoqTopNBar({ rows }) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return (
      <div
        role="img"
        aria-label="Empty BOQ variance chart"
        style={{
          height: 220,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '0.85rem',
          color: 'var(--navy, #0f172a)',
          background: 'rgba(100,116,139,0.04)',
          borderRadius: 8,
          border: '1px dashed var(--steel, #cbd5e1)',
        }}
      >
        No BOQ line items in the selected window.
      </div>
    );
  }

  const config = {
    contract: { label: 'Contract', color: 'var(--blue, #0066FF)' },
    executed: { label: 'Executed', color: 'var(--amber, #d97706)' },
  };

  return (
    <div role="img" aria-label="Top 10 BOQ line items by absolute variance">
      <ChartContainer
        config={config}
        style={{
          aspectRatio: 'auto',
          height: Math.max(220, rows.length * 28 + 60),
          width: '100%',
        }}
      >
        <RechartsBarChart
          data={rows}
          layout="vertical"
          margin={{ top: 8, right: 24, left: 0, bottom: 8 }}
        >
          <CartesianGrid stroke="var(--steel, #cbd5e1)" strokeDasharray="3 3" horizontal={false} />
          <XAxis
            type="number"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: 'var(--steel, #64748b)' }}
            tickFormatter={(v) => {
              const n = Number(v) || 0;
              if (n >= 10000000) return `${(n / 10000000).toFixed(1)}Cr`;
              if (n >= 100000) return `${(n / 100000).toFixed(1)}L`;
              if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
              return String(n);
            }}
          />
          <YAxis
            type="category"
            dataKey="label"
            tickLine={false}
            axisLine={false}
            width={120}
            tick={{ fontSize: 11, fill: 'var(--navy, #0f172a)' }}
          />
          <ChartTooltip
            cursor={{ fill: 'rgba(100,116,139,0.06)' }}
            content={
              <ChartTooltipContent
                hideLabel
                formatter={(value, name) => {
                  const n = Number(value) || 0;
                  return (
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 12,
                        width: '100%',
                      }}
                    >
                      <span style={{ color: 'var(--steel, #64748b)' }}>{name}</span>
                      <span
                        style={{
                          fontFamily: "'Plus Jakarta Sans', sans-serif",
                          fontWeight: 700,
                          color: 'var(--navy, #0f172a)',
                        }}
                      >
                        ₹{n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                      </span>
                    </div>
                  );
                }}
              />
            }
          />
          <RechartsBar dataKey="contractValue" fill="var(--blue, #0066FF)" isAnimationActive={false} name="Contract" />
          <RechartsBar dataKey="executedValue" fill="var(--amber, #d97706)" isAnimationActive={false} name="Executed" />
        </RechartsBarChart>
      </ChartContainer>
    </div>
  );
}

// InspectionFunnel — two horizontal bands (OPEN, CLOSED) with
// widths proportional to their share of total. The data is
// already on the KPI response (totalCount + openCount) so this
// is a pure render — no new fetch, no new list.
function InspectionFunnel({ total, open }) {
  const totalN = Math.max(0, Number(total) || 0);
  const openN = Math.max(0, Number(open) || 0);
  const closedN = Math.max(0, totalN - openN);

  if (totalN === 0) {
    return (
      <div
        role="img"
        aria-label="Empty inspection status funnel"
        style={{
          padding: '1.25rem 0',
          fontSize: '0.85rem',
          color: 'var(--navy, #0f172a)',
          textAlign: 'center',
          background: 'rgba(100,116,139,0.04)',
          borderRadius: 8,
          border: '1px dashed var(--steel, #cbd5e1)',
        }}
      >
        No inspections recorded in the selected window.
      </div>
    );
  }

  const openPct = (openN / totalN) * 100;
  const closedPct = 100 - openPct;

  return (
    <div
      role="img"
      aria-label={`Inspection status funnel: ${openN} open, ${closedN} closed, ${totalN} total`}
    >
      <div
        style={{
          display: 'flex',
          height: 36,
          borderRadius: 8,
          overflow: 'hidden',
          border: '1px solid var(--steel, #cbd5e1)',
        }}
      >
        <div
          style={{
            width: `${openPct}%`,
            background: 'var(--amber, #d97706)',
            color: 'white',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '0.78rem',
            fontWeight: 700,
            fontFamily: "'Plus Jakarta Sans', sans-serif",
            transition: 'width 0.3s ease',
          }}
          title={`Open: ${openN}`}
        >
          {openN > 0 ? openN : ''}
        </div>
        <div
          style={{
            width: `${closedPct}%`,
            background: 'var(--green, #16a34a)',
            color: 'white',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '0.78rem',
            fontWeight: 700,
            fontFamily: "'Plus Jakarta Sans', sans-serif",
            transition: 'width 0.3s ease',
          }}
          title={`Closed: ${closedN}`}
        >
          {closedN > 0 ? closedN : ''}
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: 8,
          fontSize: '0.78rem',
          color: 'var(--steel, #64748b)',
        }}
      >
        <div>
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: 2,
              background: 'var(--amber, #d97706)',
              marginRight: 6,
              verticalAlign: 'middle',
            }}
          />
          Open · {openN} ({openPct.toFixed(0)}%)
        </div>
        <div>
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: 2,
              background: 'var(--green, #16a34a)',
              marginRight: 6,
              verticalAlign: 'middle',
            }}
          />
          Closed · {closedN} ({closedPct.toFixed(0)}%)
        </div>
      </div>
    </div>
  );
}

// PeopleHeatmap — hand-rolled CSS grid, no library. Rows are
// employees (top-8 by total activity), columns are week buckets
// returned by byEmployeeWeek. The cell colour intensity scales
// with the cell count vs. the row's max so a sparse employee
// doesn't render as a fully-saturated block.
function PeopleHeatmap({ buckets }) {
  const rows = (buckets && buckets.rows) || [];
  const weekLabels = (buckets && buckets.weekLabels) || [];

  if (rows.length === 0) {
    return (
      <div
        role="img"
        aria-label="Empty people workload heatmap"
        style={{
          padding: '1.5rem 0',
          fontSize: '0.85rem',
          color: 'var(--steel, #64748b)',
          textAlign: 'center',
          background: 'rgba(100,116,139,0.04)',
          borderRadius: 8,
          border: '1px dashed var(--steel, #cbd5e1)',
        }}
      >
        No people activity in the selected window.
      </div>
    );
  }

  return (
    <div role="img" aria-label="People workload heatmap, top 8 employees by week">
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `160px repeat(${weekLabels.length}, 1fr)`,
          gap: 4,
          alignItems: 'center',
          fontSize: '0.72rem',
          color: 'var(--steel, #64748b)',
          marginBottom: 6,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}
      >
        <div />
        {weekLabels.map((label, i) => {
          const d = new Date(`${label}T00:00:00.000Z`);
          const text = Number.isNaN(d.getTime())
            ? label
            : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          return <div key={i} style={{ textAlign: 'center' }}>{text}</div>;
        })}
      </div>
      {rows.map((row) => {
        const max = Math.max(...row.weeks, 1);
        return (
          <div
            key={row.employeeId}
            style={{
              display: 'grid',
              gridTemplateColumns: `160px repeat(${weekLabels.length}, 1fr)`,
              gap: 4,
              alignItems: 'center',
              marginBottom: 4,
            }}
          >
            <div
              style={{
                fontSize: '0.82rem',
                color: 'var(--navy, #0f172a)',
                fontWeight: 600,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                paddingRight: 8,
              }}
              title={row.employeeName}
            >
              {row.employeeName}
            </div>
            {row.weeks.map((count, i) => {
              const alpha = count === 0 ? 0.04 : 0.18 + (count / max) * 0.7;
              return (
                <div
                  key={i}
                  style={{
                    background: `rgba(0,102,255,${alpha.toFixed(2)})`,
                    height: 28,
                    borderRadius: 4,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '0.78rem',
                    fontWeight: 600,
                    color: count > max * 0.5 ? 'white' : 'var(--navy, #0f172a)',
                  }}
                  title={`${row.employeeName} · week of ${weekLabels[i]} · ${count} ${count === 1 ? 'item' : 'items'}`}
                >
                  {count > 0 ? count : ''}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ProjectDashboardCharts — the bundle entry. Renders 5 chart
// pieces (donut + 4 sections). The parent page wraps this in
// <Suspense> so recharts only loads when an admin opens the page.
function ProjectDashboardCharts({
  kpis,
  dprTrendBuckets,
  boqTopN,
  peopleBuckets,
}) {
  return (
    <>
      {/* Donut: rendered into the Inspections TileSection by the
          parent page (it lives inside the section's grid). We
          export it as a separate named component so the parent
          can drop it into the section's children without
          re-mounting the section on a Suspense tick. */}
      <InspectionDonutCard
        byType={kpis?.inspections?.byType || {}}
        totalCount={kpis?.inspections?.totalCount || 0}
      />
      <ChartSection title="DPR activity" subtitle="Daily reports by status — last 30 days">
        <DashboardAreaChart
          data={dprTrendBuckets || []}
          xKey="day"
          series={[
            { key: 'submitted', label: 'Submitted', color: 'var(--blue, #0066FF)' },
            { key: 'underReview', label: 'Under review', color: 'var(--amber, #d97706)' },
            { key: 'approved', label: 'Approved', color: 'var(--green, #16a34a)' },
            { key: 'rejected', label: 'Rejected', color: 'var(--red, #dc2626)' },
          ]}
          height={220}
          emptyMessage="No DPRs filed in the selected window yet."
          ariaLabel="DPR activity trend, by status, last 30 days"
        />
      </ChartSection>
      <ChartSection
        title="BOQ top variances"
        subtitle="Biggest contract vs. executed gaps (absolute variance %)"
      >
        <BoqTopNBar rows={boqTopN || []} />
      </ChartSection>
      <ChartSection
        title="Inspection status"
        subtitle="Open vs. closed in the selected window"
      >
        <InspectionFunnel
          total={kpis?.inspections?.totalCount || 0}
          open={kpis?.inspections?.openCount || 0}
        />
      </ChartSection>
      <ChartSection
        title="People workload"
        subtitle="DPR + inspection activity per employee, by week"
      >
        <PeopleHeatmap buckets={peopleBuckets || { rows: [], weekLabels: [] }} />
      </ChartSection>
    </>
  );
}

// ChartLoadingFallback — the Suspense fallback. Renders 5 placeholder
// cards the same size as the real charts so the page layout doesn't
// shift when the chunk lands. The parent page wraps ProjectDashboardCharts
// in <Suspense fallback={<ChartLoadingFallback />}>.
function ChartLoadingFallback() {
  const placeholder = (key) => (
    <div
      key={key}
      className="dpr-card"
      style={{
        padding: '1rem 1.25rem',
        minHeight: 180,
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
  return (
    <>
      {placeholder('donut')}
      {placeholder('dpr')}
      {placeholder('boq')}
      {placeholder('funnel')}
      {placeholder('people')}
    </>
  );
}

export {
  ProjectDashboardCharts,
  InspectionDonutCard,
  ChartLoadingFallback,
};
export default ProjectDashboardCharts;
