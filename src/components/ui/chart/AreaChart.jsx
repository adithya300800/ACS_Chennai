// DashboardAreaChart — DPR-trend / people-workload area chart.
//
// Adapted from the shadcn `chart-area-interactive.tsx` block (MIT, see
// https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/blocks/dashboard-01/components/chart-area-interactive.tsx).
//
// What we kept:
//   - ChartContainer wrapper (defined in ChartContainer.jsx) as the
//     CSS-var-driven shell
//   - Gradient fill stops on the Area (a thin `--color-<key>` linear
//     gradient)
//   - The shadcn XAxis tick formatter (short month + day)
//   - CartesianGrid + hidden axis line for a clean grid
//
// What we cut:
//   - The time-range ToggleGroup + Select (the page-level days selector
//     already controls the window; a per-chart time filter would be
//     duplicate state).
//   - The Card shell. The dashboard wraps each chart in its own
//     .dpr-card so chart-card consistency lives at the page level, not
//     inside this primitive.
//   - The two stacked series + toggle. The dashboard passes its own
//     `series: [{ key, label, color }]` so a single instance can serve
//     DPR trend (one series), pending-review sparkline (one series),
//     and people-workload (two stacked series).
//
// Translation notes:
//   - .ts → .jsx, no type annotations.
//   - Replaced shadcn's Card/CardHeader wrapper with the .dpr-card shell
//     at the call site (page-level).
//   - The fill gradient uses inline SVG <defs> so no extra CSS needed.

import React, { useId, useMemo } from 'react';
import {
  Area,
  AreaChart as RechartsAreaChart,
  CartesianGrid,
  XAxis,
  YAxis,
  ResponsiveContainer,
} from 'recharts';

import { ChartContainer, ChartTooltip, ChartTooltipContent } from './ChartContainer.jsx';

/**
 * DashboardAreaChart — a thin area chart with the repo's chart styling
 * baked in. Renders one or more series with the gradient fill, the
 * XAxis date formatter, the y-axis hidden (counts are obvious from
 * gridlines + tooltip).
 *
 * Props:
 *   data: Array<{ [key: string]: number | string }>     — rows; key axis is xKey
 *   xKey: string                                         — column to plot on X
 *   series: Array<{ key, label, color, stack? }>         — one Area per entry
 *   height?: number                                      — pixel height override (default auto via ResponsiveContainer)
 *   xTickFormatter?: (value) => string                   — default: 'short month + day' for date strings
 *   tooltipLabelFormatter?: (value) => ReactNode        — default: same as xTickFormatter
 *   emptyMessage?: string                                — message when data.length === 0
 */
function DashboardAreaChart({
  data,
  xKey,
  series,
  height,
  xTickFormatter,
  tooltipLabelFormatter,
  emptyMessage = 'No data yet',
  ariaLabel,
}) {
  // Defensive: if no rows (or only zero-value rows), render the
  // empty-state message inside the .dpr-card shell. The page wires
  // every chart through this so a sparse project (no DPRs filed in
  // the last 30 days) gets a clean "No data yet" rather than a
  // broken Recharts render.
  const hasData = Array.isArray(data) && data.length > 0
    && data.some((row) => series.some((s) => Number(row[s.key]) > 0));

  if (!hasData) {
    return <EmptyChartMessage message={emptyMessage} ariaLabel={ariaLabel} />;
  }

  // Config for the shadcn chart wrapper — one entry per series. Each
  // entry's `color` is resolved by ChartStyle into a `--color-<key>`
  // CSS var the Area primitive reads back.
  const config = useMemo(() => {
    const out = {};
    series.forEach((s) => {
      out[s.key] = { label: s.label, color: s.color };
    });
    return out;
  }, [series]);

  // Inline gradient defs: one per series, fading from ~70% alpha at
  // the top to 0% at the bottom. We use the resolved colour from CSS
  // var → getComputedStyle is unavailable in SSR, so we resolve the
  // color from the prop directly in the <stop> stopColor attr. That
  // requires us to know the colour as a string (we use the same hex
  // the tokens define — the fallback in `var(--blue, #0066FF)` etc.).
  const gradId = useId().replace(/:/g, '');

  const defaultXFormatter = (value) => {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) {
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      }
    }
    return String(value);
  };

  const fmtX = xTickFormatter || defaultXFormatter;
  const fmtTooltipLabel = tooltipLabelFormatter || ((value) => defaultXFormatter(value));

  return (
    <div role="img" aria-label={ariaLabel || 'Area chart'}>
      <ChartContainer config={config} style={height ? { aspectRatio: 'auto', height } : undefined}>
        <RechartsAreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <defs>
            {series.map((s) => (
              <linearGradient
                key={s.key}
                id={`fill-${s.key}-${gradId}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="5%" stopColor={s.color} stopOpacity={0.5} />
                <stop offset="95%" stopColor={s.color} stopOpacity={0.05} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid stroke="var(--steel, #cbd5e1)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey={xKey}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={24}
            tickFormatter={fmtX}
            tick={{ fontSize: 11, fill: 'var(--steel, #64748b)' }}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tickMargin={4}
            width={36}
            tick={{ fontSize: 11, fill: 'var(--steel, #64748b)' }}
            allowDecimals={false}
          />
          <ChartTooltip
            cursor={{ stroke: 'var(--steel, #cbd5e1)', strokeDasharray: '3 3' }}
            content={
              <ChartTooltipContent
                labelFormatter={fmtTooltipLabel}
                indicator="line"
              />
            }
          />
          {series.map((s) => (
            <Area
              key={s.key}
              dataKey={s.key}
              type="monotone"
              fill={`url(#fill-${s.key}-${gradId})`}
              stroke={s.color}
              strokeWidth={2}
              stackId={s.stack}
              isAnimationActive={false}
            />
          ))}
        </RechartsAreaChart>
      </ChartContainer>
    </div>
  );
}

// EmptyChartMessage — used both for "no rows" and "all rows are zero".
// Pinned to the same .dpr-card-free inline chrome (the caller already
// wraps the chart in a .dpr-card so the message just sits in the
// chart's slot).
//
// Bug fix (R38 audit, 2026-09-10): the original used
//   background: 'var(--steel, rgba(100,116,139,0.04))'
// but the CSS-var fallback chain resolved to the literal hex value
// `#475569` (slate-600) on the live bundle, NOT the low-alpha rgba.
// Result: a solid 71,85,105 block where the message text blended into
// the background. Fix: pass the low-alpha rgba directly as the value
// AND pin `color` to a stronger contrast token (--navy).
function EmptyChartMessage({ message, ariaLabel }) {
  return (
    <div
      role="img"
      aria-label={ariaLabel || 'Empty chart'}
      style={{
        height: 180,
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

export { DashboardAreaChart };
export default DashboardAreaChart;
