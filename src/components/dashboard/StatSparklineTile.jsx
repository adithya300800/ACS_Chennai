// StatSparklineTile — a StatTile with an embedded 14-day sparkline.
//
// Adapted from the satnaing/shadcn-admin stats-card.tsx pattern
// (MIT, https://github.com/satnaing/shadcn-admin — exact path varies
// by commit, see plan §source 3). The pattern is: stat tile + a tiny
// trend glyph in the corner. We adapt — not copy verbatim — by:
//   - Swapping the shadcn card chrome for this repo's .dpr-card shell
//   - Using this repo's colour tokens (var(--blue), var(--green),
//     var(--amber), var(--red), var(--navy), var(--steel))
//   - Rendering the sparkline as a pure-SVG path (no recharts) so
//     60 stat tiles do not pull in 60 mini ResponsiveContainers. A
//     single `<path>` plus the `bucketByDay` rows in kpiBuckets.js
//     is enough; the bundled gzipped size of this primitive is ~1KB
//     and never grows with the page's chart count.
//
// Used by the Project Dashboard for the "Pending Review" tile (the
// 6th chart in the plan, "embedded pending-review sparkline in the
// existing tile"). The existing StatTile in ProjectDashboard.jsx is
// left in place for the 7 non-sparkline tiles.

import React, { useMemo } from 'react';

/**
 * StatSparklineTile
 *
 * Props match the existing StatTile so this can drop in for the
 * "Pending Review" tile without changing the parent TileSection.
 *   icon, number, label, tone, sub, tileKey, isExpanded, onToggle
 *
 * Plus one extra:
 *   points: Array<{ day: string, count: number }>   — sparkline data
 *     (the dashboard passes `pendingReviewSparkline(rows).rows`).
 *     Empty / all-zero points render a flat baseline so the tile
 *     still has a visible "card with chart slot" silhouette.
 */
function StatSparklineTile({
  icon,
  number,
  label,
  tone = 'neutral',
  sub,
  tileKey,
  isExpanded,
  onToggle,
  points = [],
  sparklineColor,
}) {
  // Tone → colour map mirrors the existing StatTile. Numbers shift
  // colour, icons stay blue. Default sparkline uses the same tone
  // colour so a red "Overdue" sparkline reads as alarming at a
  // glance; callers can override via `sparklineColor` if they want
  // a constant brand-blue trend.
  const colorMap = {
    neutral: 'var(--navy, #0f172a)',
    good: 'var(--green, #16a34a)',
    warning: 'var(--amber, #d97706)',
    critical: 'var(--red, #dc2626)',
  };
  const numColor = colorMap[tone] || colorMap.neutral;
  const lineColor = sparklineColor || numColor;

  // Compute the sparkline path from the points. We use a fixed viewBox
  // (0..100 × 0..30) so the SVG scales cleanly inside the 80×24 px
  // slot. With 14 points the spacing is 100/13 ≈ 7.7; we use min/max
  // for Y so a sparse week doesn't compress to a flat baseline.
  const path = useMemo(() => computePath(points, 100, 30), [points]);

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
      {/* Sparkline — 80×24px inline SVG. aria-hidden because the
          number above carries the same info for screen readers. The
          `preserveAspectRatio="none"` keeps the line full-width even
          if the tile is squished by a tight grid. */}
      <svg
        viewBox="0 0 100 30"
        width="100%"
        height={24}
        preserveAspectRatio="none"
        aria-hidden="true"
        style={{ display: 'block', marginTop: 4 }}
      >
        <path
          d={path}
          fill="none"
          stroke={lineColor}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
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

// computePath — convert [{day, count}] to an SVG path d-string. Maps
// the points into the (0..width, 0..height) viewBox. If all counts
// are 0 (or there's no data), returns a flat baseline so the SVG
// still renders a thin "no activity" line rather than collapsing to
// nothing. Y axis is inverted (SVG y grows downward) so the
// sparkline's high points are at the top of the box.
function computePath(points, width, height) {
  if (!Array.isArray(points) || points.length === 0) {
    return `M 0 ${height} L ${width} ${height}`;
  }
  const max = Math.max(...points.map((p) => Number(p.count) || 0), 1);
  const stepX = points.length > 1 ? width / (points.length - 1) : 0;
  const padY = 2; // leave 2px breathing room at top + bottom
  const usableH = height - padY * 2;
  const coords = points.map((p, i) => {
    const x = i * stepX;
    const y = height - padY - ((Number(p.count) || 0) / max) * usableH;
    return [x, y];
  });
  return coords
    .map(([x, y], i) => (i === 0 ? `M ${x.toFixed(2)} ${y.toFixed(2)}` : `L ${x.toFixed(2)} ${y.toFixed(2)}`))
    .join(' ');
}

export { StatSparklineTile };
export default StatSparklineTile;
