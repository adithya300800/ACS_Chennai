// ChartContainer + ChartTooltip + ChartTooltipContent — hand-translated
// from shadcn/ui's official `chart.tsx` (MIT-licensed, see
// https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/ui/chart.tsx).
//
// Translation notes:
//   - Drop the `cn()` import — this repo does not use clsx/tailwind-merge
//     (per the hard-constraint "Do not add clsx or tailwind-merge"). We
//     concatenate class names with a tiny `joinClasses` helper.
//   - Drop the dark-mode `THEMES.dark = ".dark"` mapping. The project
//     skips dark mode for the Project Dashboard page (per plan).
//   - Drop the `cn(...)` className blocks. Instead the wrapper itself
//     is rendered with inline styles + a data-chart attribute that the
//     recharts primitives style against via the `--color-*` CSS vars
//     emitted by ChartStyle below.
//   - Keep the chart-id + `<style>` injection (ChartStyle) so the
//     `--color-<key>: <value>` CSS vars land on the chart's data-chart
//     selector — that is the load-bearing piece shadcn added on top of
//     raw recharts.
//
// JSDoc throughout to make the contract explicit for the dashboard
// integration. Everything here is a pure render — no API calls, no
// state, fully unit-testable in isolation.

import React, { createContext, useContext, useId, useMemo } from 'react';
import * as RechartsPrimitive from 'recharts';

// joinClasses — minimal className combiner. The full shadcn `cn()` is
// `twMerge(clsx(...))`; we only need to support the "always string
// className, possibly undefined extra classes" case the shadcn chart
// primitives actually use here.
function joinClasses(...parts) {
  return parts.filter(Boolean).join(' ');
}

// THEMES — kept as a literal so future work that re-enables dark mode
// can drop in a `.dark` selector without re-deriving the shape. Today
// only the light theme is wired (per plan: dark mode skipped for this
// page).
const THEMES = { light: '' };

// INITIAL_DIMENSION — the SSR-safe default size for ResponsiveContainer
// so the first paint doesn't collapse to 0×0. Matches shadcn's default.
const INITIAL_DIMENSION = { width: 320, height: 200 };

/**
 * ChartConfig — the per-series label + colour map. Shadcn's contract:
 *   { [seriesKey]: { label, color | theme: { light, dark } } }
 *
 * Callers pass this once to <ChartContainer config={...} /> and recharts
 * primitives reference the colour via the `fill` / `stroke` attributes
 * (we wire them to `var(--color-<key>)` so ChartStyle does the actual
 * colour resolution).
 */
const ChartContext = createContext(null);

function useChart() {
  const context = useContext(ChartContext);
  if (!context) {
    throw new Error('useChart must be used within a <ChartContainer />');
  }
  return context;
}

/**
 * ChartContainer — the shell around any recharts primitive. Establishes
 * the CSS-var context, emits the `<style>` that maps ChartConfig colours
 * to `--color-<key>` CSS vars, and renders a ResponsiveContainer so the
 * chart fills its parent.
 *
 * Usage:
 *   <ChartContainer config={{ submitted: { label: 'Submitted', color: 'var(--blue)' } }}>
 *     <AreaChart data={rows}>...</AreaChart>
 *   </ChartContainer>
 */
function ChartContainer({ id, className, children, config, style, ...props }) {
  const uniqueId = useId();
  const chartId = `chart-${id || uniqueId.replace(/:/g, '')}`;

  const ctxValue = useMemo(() => ({ config }), [config]);

  return (
    <ChartContext.Provider value={ctxValue}>
      <div
        data-slot="chart"
        data-chart={chartId}
        className={joinClasses('chart-container', className)}
        style={{
          display: 'flex',
          justifyContent: 'center',
          textTransform: 'none',
          // shadcn's original aspect-video: keep height responsive to
          // width. Override via `style` prop when a specific chart
          // (e.g. inspection status funnel) wants a fixed height.
          aspectRatio: '16 / 9',
          minHeight: 0,
          width: '100%',
          ...style,
        }}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer
          initialDimension={INITIAL_DIMENSION}
          width="100%"
          height="100%"
        >
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

/**
 * ChartStyle — emits a `<style>` tag with one block per theme. Each
 * block declares `--color-<key>: <value>` so recharts primitives that
 * use `fill="var(--color-<key>)"` get the right colour. Skips silently
 * if no series in the config has a colour.
 */
function ChartStyle({ id, config }) {
  const colorConfig = Object.entries(config).filter(
    ([, item]) => (item && item.theme && item.theme.light) || item.color,
  );

  if (colorConfig.length === 0) return null;

  return (
    <style
      dangerouslySetInnerHTML={{
        __html: Object.entries(THEMES)
          .map(
            ([theme, prefix]) => `
${prefix} [data-chart=${id}] {
${colorConfig
  .map(([key, itemConfig]) => {
    const color =
      (itemConfig.theme && itemConfig.theme[theme]) || itemConfig.color;
    return color ? `  --color-${key}: ${color};` : null;
  })
  .filter(Boolean)
  .join('\n')}
}
`,
          )
          .join('\n'),
      }}
    />
  );
}

/**
 * ChartTooltip + ChartTooltipContent — shadcn's tooltip wrapper.
 * Recharts' built-in tooltip accepts a `content` prop with a React
 * component; we expose the same shape and pre-style the bubble to
 * match this repo's card chrome (no border-shadow drama, light
 * grey background, Plus Jakarta Sans number).
 */
const ChartTooltip = RechartsPrimitive.Tooltip;

function ChartTooltipContent({
  active,
  payload,
  className,
  indicator = 'dot',
  hideLabel = false,
  hideIndicator = false,
  label,
  labelFormatter,
  labelClassName,
  formatter,
  color,
  nameKey,
  labelKey,
}) {
  const { config } = useChart();

  const tooltipLabel = useMemo(() => {
    if (hideLabel || !payload || !payload.length) return null;
    const [item] = payload;
    const key = `${labelKey || (item && item.dataKey) || (item && item.name) || 'value'}`;
    const itemConfig = getPayloadConfigFromPayload(config, item, key);
    const value =
      !labelKey && typeof label === 'string'
        ? (config[label] && config[label].label) || label
        : itemConfig && itemConfig.label;

    if (labelFormatter) {
      return (
        <div className={joinClasses('font-medium', labelClassName)}>
          {labelFormatter(value, payload)}
        </div>
      );
    }
    if (!value) return null;
    return <div className={joinClasses('font-medium', labelClassName)}>{value}</div>;
  }, [label, labelFormatter, payload, hideLabel, labelClassName, config, labelKey]);

  if (!active || !payload || !payload.length) return null;

  const nestLabel = payload.length === 1 && indicator !== 'dot';

  return (
    <div
      className={joinClasses('chart-tooltip', className)}
      style={{
        background: 'white',
        border: '1px solid var(--steel, #cbd5e1)',
        borderRadius: 8,
        padding: '0.5rem 0.625rem',
        fontSize: '0.78rem',
        color: 'var(--navy, #0f172a)',
        boxShadow: '0 4px 12px rgba(15, 23, 42, 0.08)',
        minWidth: 120,
        fontFamily: "'Plus Jakarta Sans', sans-serif",
      }}
    >
      {!nestLabel ? tooltipLabel : null}
      <div style={{ display: 'grid', gap: 6, marginTop: tooltipLabel ? 6 : 0 }}>
        {payload
          .filter((item) => item.type !== 'none')
          .map((item, index) => {
            const key = `${nameKey || item.name || item.dataKey || 'value'}`;
            const itemConfig = getPayloadConfigFromPayload(config, item, key);
            const indicatorColor = color || (item.payload && item.payload.fill) || item.color;

            return (
              <div
                key={index}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  flexWrap: 'wrap',
                }}
              >
                {formatter && item.value !== undefined && item.name ? (
                  formatter(item.value, item.name, item, index, item.payload)
                ) : (
                  <>
                    {!hideIndicator ? (
                      <span
                        aria-hidden="true"
                        style={{
                          display: 'inline-block',
                          width: indicator === 'line' ? 2 : 8,
                          height: indicator === 'line' ? 12 : 8,
                          borderRadius: indicator === 'dot' ? 2 : 0,
                          background: indicatorColor,
                          flexShrink: 0,
                        }}
                      />
                    ) : null}
                    <span style={{ color: 'var(--steel, #64748b)' }}>
                      {itemConfig ? itemConfig.label : item.name}
                    </span>
                    {item.value != null ? (
                      <span
                        style={{
                          marginLeft: 'auto',
                          fontFamily: "'Plus Jakarta Sans', sans-serif",
                          fontWeight: 700,
                          color: 'var(--navy, #0f172a)',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {typeof item.value === 'number'
                          ? item.value.toLocaleString()
                          : String(item.value)}
                      </span>
                    ) : null}
                  </>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}

/**
 * ChartLegend + ChartLegendContent — shadcn's legend wrapper. We render
 * a tiny horizontal flex of colour swatches + labels, one per series.
 * `nameKey` lets the caller override the key used to look up the label
 * in the ChartConfig.
 */
const ChartLegend = RechartsPrimitive.Legend;

function ChartLegendContent({ className, hideIcon = false, payload, verticalAlign = 'bottom', nameKey }) {
  const { config } = useChart();

  if (!payload || !payload.length) return null;

  return (
    <div
      className={joinClasses('chart-legend', className)}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: 12,
        paddingTop: verticalAlign === 'top' ? 0 : 8,
        paddingBottom: verticalAlign === 'top' ? 8 : 0,
        fontSize: '0.78rem',
        color: 'var(--steel, #64748b)',
      }}
    >
      {payload
        .filter((item) => item.type !== 'none')
        .map((item, index) => {
          const key = `${nameKey || item.dataKey || 'value'}`;
          const itemConfig = getPayloadConfigFromPayload(config, item, key);
          return (
            <div
              key={index}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              {itemConfig && itemConfig.icon && !hideIcon ? (
                <itemConfig.icon />
              ) : (
                <span
                  aria-hidden="true"
                  style={{
                    display: 'inline-block',
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: item.color,
                    flexShrink: 0,
                  }}
                />
              )}
              {itemConfig ? itemConfig.label : item.value}
            </div>
          );
        })}
    </div>
  );
}

// getPayloadConfigFromPayload — shadcn's helper for resolving the
// ChartConfig entry for a given tooltip/legend payload. Mirrored as JS
// (the original is TS).
function getPayloadConfigFromPayload(config, payload, key) {
  if (typeof payload !== 'object' || payload === null) return undefined;

  const payloadPayload =
    'payload' in payload &&
    typeof payload.payload === 'object' &&
    payload.payload !== null
      ? payload.payload
      : undefined;

  let configLabelKey = key;
  if (key in payload && typeof payload[key] === 'string') {
    configLabelKey = payload[key];
  } else if (
    payloadPayload &&
    key in payloadPayload &&
    typeof payloadPayload[key] === 'string'
  ) {
    configLabelKey = payloadPayload[key];
  }

  return configLabelKey in config ? config[configLabelKey] : config[key];
}

export {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
};
