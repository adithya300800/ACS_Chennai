// DashboardDonutChart — inspection-type donut + label.
//
// Adapted from the shadcn `chart-pie-donut.tsx` pattern (referenced in
// the plan; the official shadcn/ui dashboard-01 block doesn't ship a
// donut file, so this is composed from the same primitives the shadcn
// chart-pattern docs recommend: Recharts PieChart + Pie + Cell with
// an innerRadius > 0 to render a donut rather than a pie).
//
// What we kept (from the shadcn chart.tsx wrapper):
//   - The ChartContainer shell with the CSS-var-driven config
//   - The ChartTooltip + ChartTooltipContent primitives
//   - The "label = series key, colour = --color-<key>" pattern
//
// What we added (project-specific):
//   - The centre label slot (used to render the total inspection count
//     in the middle of the donut).
//   - The legend table under the chart (label / count / % share) —
//     recharts' built-in legend is fine, but the per-row % share is
//     something the dashboard wants in text form so a screen reader
//     user gets the same info as the visual donut.
//
// Translation notes:
//   - .ts → .jsx, no type annotations.
//   - Skipped dark-mode theme for this page (per plan).

import React, { useMemo } from 'react';
import { PieChart, Pie, Cell } from 'recharts';

import { ChartContainer, ChartTooltip, ChartTooltipContent } from './ChartContainer.jsx';

/**
 * DashboardDonutChart — donut viz with a centre label + a tabular
 * legend below.
 *
 * Props:
 *   data: Array<{ name: string, value: number, key: string, color: string }>
 *   centerLabel: string                — text rendered in the middle (e.g. total count)
 *   centerSubLabel?: string            — sub-line under the centre label
 *   height?: number                    — pixel height (default 220)
 *   emptyMessage?: string              — message when data is empty or all zero
 *   ariaLabel?: string                 — accessible label for the chart group
 */
function DashboardDonutChart({
  data,
  centerLabel,
  centerSubLabel,
  height = 220,
  emptyMessage = 'No data yet',
  ariaLabel,
}) {
  // Sum for the centre label is the caller's responsibility (the
  // inspection total lives on kpis.inspections.totalCount — passing it
  // in keeps this component purely visual).
  const safeData = Array.isArray(data) ? data : [];
  const totalValue = useMemo(
    () => safeData.reduce((acc, d) => acc + (Number(d.value) || 0), 0),
    [safeData],
  );
  const hasData = totalValue > 0;

  if (!hasData) {
    return <EmptyDonutMessage message={emptyMessage} ariaLabel={ariaLabel} height={height} />;
  }

  // ChartConfig — one entry per slice. Shadcn's wrapper uses
  // `--color-<key>` so recharts' `Cell fill={...}` needs to point at
  // the same var. We pass the colour through both the config (for the
  // tooltip) and the Cell `fill` (for the actual slice).
  const config = useMemo(() => {
    const out = {};
    safeData.forEach((d) => {
      out[d.key] = { label: d.name, color: d.color };
    });
    return out;
  }, [safeData]);

  // Tabular legend rows — one per slice, with absolute count and
  // share-of-total. Hidden behind the chart in a small two-column
  // table so the reader can scan types + counts without hovering.
  const legendRows = useMemo(
    () =>
      safeData
        .map((d) => ({
          ...d,
          share: totalValue > 0 ? Math.round((Number(d.value) / totalValue) * 100) : 0,
        }))
        .sort((a, b) => b.value - a.value),
    [safeData, totalValue],
  );

  return (
    <div
      role="img"
      aria-label={ariaLabel || 'Donut chart'}
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <div style={{ position: 'relative', width: '100%', height }}>
        <ChartContainer
          config={config}
          style={{ aspectRatio: 'auto', height, width: '100%' }}
        >
          <PieChart>
            <ChartTooltip
              content={
                <ChartTooltipContent
                  hideLabel
                  formatter={(value, name) => (
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
                        {typeof value === 'number' ? value.toLocaleString() : String(value)}
                      </span>
                    </div>
                  )}
                />
              }
            />
            <Pie
              data={safeData}
              dataKey="value"
              nameKey="name"
              innerRadius="58%"
              outerRadius="88%"
              paddingAngle={1}
              stroke="white"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {safeData.map((d) => (
                <Cell key={d.key} fill={d.color} />
              ))}
            </Pie>
          </PieChart>
        </ChartContainer>
        {/* Centre label — sits on top of the donut via absolute
            positioning. The total + a sub-line is the standard
            "donut" composition used in analytics dashboards. */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              fontFamily: "'Plus Jakarta Sans', sans-serif",
              fontWeight: 700,
              fontSize: '1.5rem',
              lineHeight: 1.1,
              color: 'var(--navy, #0f172a)',
            }}
          >
            {centerLabel}
          </div>
          {centerSubLabel ? (
            <div
              style={{
                fontSize: '0.78rem',
                color: 'var(--steel, #64748b)',
                marginTop: 4,
              }}
            >
              {centerSubLabel}
            </div>
          ) : null}
        </div>
      </div>
      {/* Tabular legend — visible by default. The donut's slices are
          already colour-coded; the table adds the share-% column so a
          reader can see "Foundation 8 (53%)" without hovering. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto auto',
          gap: 6,
          fontSize: '0.78rem',
        }}
      >
        {legendRows.map((row) => (
          <React.Fragment key={row.key}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                color: 'var(--navy, #0f172a)',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: row.color,
                  flexShrink: 0,
                }}
              />
              {row.name}
            </div>
            <div
              style={{
                color: 'var(--steel, #64748b)',
                fontVariantNumeric: 'tabular-nums',
                textAlign: 'right',
                paddingLeft: 12,
              }}
            >
              {row.value}
            </div>
            <div
              style={{
                color: 'var(--steel, #64748b)',
                fontVariantNumeric: 'tabular-nums',
                textAlign: 'right',
                minWidth: 40,
              }}
            >
              {row.share}%
            </div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

// EmptyDonutMessage — used when there are no inspection types in
// the window. Renders a dashed-border slot the same height as the
// real donut so the surrounding .dpr-card keeps a consistent shape.
//
// Bug fix (R38 audit, 2026-09-10): the original used
//   background: 'var(--steel, rgba(100,116,139,0.04))'
// but the CSS-var fallback chain resolved to the literal hex value
// `#475569` (slate-600) on the live bundle, NOT the low-alpha rgba.
// Result: a solid 71,85,105 block where the message text blended into
// the background (color + bg both = var(--steel)). Fix: pass the
// low-alpha rgba directly as the value AND pin `color` to a stronger
// contrast token (--navy) so the empty-state message stays readable.
function EmptyDonutMessage({ message, ariaLabel, height }) {
  return (
    <div
      role="img"
      aria-label={ariaLabel || 'Empty chart'}
      style={{
        height,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '0.85rem',
        color: 'var(--navy, #0f172a)',
        background: 'rgba(100, 116, 139, 0.04)',
        borderRadius: 8,
        border: '1px dashed var(--steel, #cbd5e1)',
      }}
    >
      {message}
    </div>
  );
}

export { DashboardDonutChart };
export default DashboardDonutChart;
