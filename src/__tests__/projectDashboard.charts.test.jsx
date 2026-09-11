// R38 (2026-09-10) — Project Dashboard charts: chart integration
// source-text contract tests.
//
// Pattern: same source-text pinning approach as the existing
// ProjectDashboard.dr012/dr014/empty-state tests. We do NOT mount
// the full page (PortalLayout exhausts jest memory in this
// sandbox) — we verify the chart primitives are imported, the
// chart sections are wired with the right titles / data hooks,
// and the kpiBuckets.js output shape is what the chart components
// expect.
//
// After the bundle-split round (Phase 3), the recharts-using
// pieces live in src/pages/admin/ProjectDashboardCharts.jsx and
// are loaded via React.lazy. So:
//   - dashboardSrc (ProjectDashboard.jsx) — owns the data wiring,
//     the Suspense fallback placeholders, and the lazy import.
//   - chartsSrc   (ProjectDashboardCharts.jsx) — owns the recharts
//     imports + the chart components themselves.
//
// Six charts pinned (per the R38 plan §6):
//   1. DPR trend area chart
//   2. Inspection-type donut
//   3. BOQ top-10 grouped bar
//   4. Inspection status funnel
//   5. People workload heatmap
//   6. Embedded pending-review sparkline (inside StatSparklineTile)

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const dashboardPath = resolvePath(__dirname, '../pages/admin/ProjectDashboard.jsx');
const chartsPath = resolvePath(__dirname, '../pages/admin/ProjectDashboardCharts.jsx');
const sparklineTilePath = resolvePath(__dirname, '../components/dashboard/StatSparklineTile.jsx');
const areaChartPath = resolvePath(__dirname, '../components/ui/chart/AreaChart.jsx');
const donutChartPath = resolvePath(__dirname, '../components/ui/chart/DonutChart.jsx');
const containerPath = resolvePath(__dirname, '../components/ui/chart/ChartContainer.jsx');
const kpiBucketsPath = resolvePath(__dirname, '../lib/kpiBuckets.js');

const dashboardSrc = readFileSync(dashboardPath, 'utf8');
const chartsSrc = readFileSync(chartsPath, 'utf8');
const sparklineTileSrc = readFileSync(sparklineTilePath, 'utf8');
const areaChartSrc = readFileSync(areaChartPath, 'utf8');
const donutChartSrc = readFileSync(donutChartPath, 'utf8');
const containerSrc = readFileSync(containerPath, 'utf8');
const kpiBucketsSrc = readFileSync(kpiBucketsPath, 'utf8');

describe('R38 — Project Dashboard chart integration', () => {
  describe('imports — chart primitives are wired', () => {
    test('ProjectDashboard imports the kpiBuckets pure functions (bucketByDay, byLineItemTopN, byEmployeeWeek, pendingReviewSparkline)', () => {
      // The parent owns the data bucketing — pure helpers stay in
      // the main chunk so the dashboard can derive buckets without
      // waiting for the lazy recharts chunk to load.
      expect(dashboardSrc).toMatch(/import\s*\{[^}]*bucketByDay[^}]*\}\s*from\s*['"]\.\.\/\.\.\/lib\/kpiBuckets\.jsx?['"]/);
      expect(dashboardSrc).toMatch(/byLineItemTopN/);
      expect(dashboardSrc).toMatch(/byEmployeeWeek/);
      expect(dashboardSrc).toMatch(/pendingReviewSparkline/);
    });

    test('ProjectDashboard imports the StatSparklineTile for the embedded pending-review sparkline', () => {
      // Sparkline tile has no recharts dependency, so it stays in
      // the eager chunk (the parent renders it directly).
      expect(dashboardSrc).toMatch(/import\s*\{[^}]*StatSparklineTile[^}]*\}\s*from\s*['"]\.\.\/\.\.\/components\/dashboard\/StatSparklineTile\.jsx?['"]/);
    });

    test('ProjectDashboard lazy-loads the recharts-using chart chunk (no recharts imports in the main chunk)', () => {
      // Pin the lazy import — the dashboard uses lazy(() => …) so
      // recharts only loads when an admin opens the page. We also
      // pin the absence of a direct recharts import (the whole
      // point of the split).
      expect(dashboardSrc).toMatch(/\blazy\(\s*\(\s*\)\s*=>\s*import\(/);
      expect(dashboardSrc).toMatch(/import\(\s*['"]\.\/ProjectDashboardCharts\.jsx?['"]\s*\)/);
      expect(dashboardSrc).not.toMatch(/from\s*['"]recharts['"]/);
    });

    test('ProjectDashboardCharts imports recharts BarChart + Bar primitives for the inline BOQ top-10 chart', () => {
      // The recharts-using primitives now live in the lazy chunk.
      expect(chartsSrc).toMatch(/import\s*\{[^}]*BarChart\s+as\s+RechartsBarChart[^}]*\}\s*from\s*['"]recharts['"]/);
      expect(chartsSrc).toMatch(/Bar\s+as\s+RechartsBar/);
    });

    test('ProjectDashboardCharts imports the shared ChartContainer + ChartTooltip from the chart wrapper file', () => {
      expect(chartsSrc).toMatch(/import\s*\{[^}]*ChartContainer[^}]*\}\s*from\s*['"]\.\.\/\.\.\/components\/ui\/chart\/ChartContainer\.jsx?['"]/);
      expect(chartsSrc).toMatch(/ChartTooltip/);
    });

    test('ProjectDashboardCharts imports the area + donut chart primitives', () => {
      expect(chartsSrc).toMatch(/import\s*\{[^}]*DashboardAreaChart[^}]*\}\s*from\s*['"]\.\.\/\.\.\/components\/ui\/chart\/AreaChart\.jsx?['"]/);
      expect(chartsSrc).toMatch(/import\s*\{[^}]*DashboardDonutChart[^}]*\}\s*from\s*['"]\.\.\/\.\.\/components\/ui\/chart\/DonutChart\.jsx?['"]/);
    });
  });

  describe('lazy wiring — ProjectDashboard.jsx wraps the chart chunk in Suspense', () => {
    test('declares the ProjectDashboardCharts + InspectionDonutCard lazy loaders', () => {
      // The chunk exports both ProjectDashboardCharts (the 4
      // sections) AND InspectionDonutCard (which lives inside the
      // TileSection's grid, so it gets its own Suspense boundary).
      expect(dashboardSrc).toMatch(/const\s+ProjectDashboardCharts\s*=\s*lazy\(\s*\(\s*\)\s*=>\s*import\(\s*['"]\.\/ProjectDashboardCharts\.jsx?['"]\s*\)/);
      expect(dashboardSrc).toMatch(/const\s+InspectionDonutCard\s*=\s*lazy\(/);
    });

    test('wraps ProjectDashboardCharts in <Suspense fallback={…}>', () => {
      // Suspense boundary so the page chrome stays interactive
      // while the recharts chunk streams in. The fallback is the
      // eagerly-loaded ChartLoadingPlaceholderGroup so we don't
      // recurse into another lazy load. The R38.1.1 follow-up
      // REMOVED a `key={...}` prop that was forcing a Suspense
      // remount on every selection change — that pattern was
      // causing React #310 inside recharts, not preventing it.
      // Regex window widened to {0,250} to tolerate prop ordering.
      expect(dashboardSrc).toMatch(/React\.Suspense[\s\S]{0,250}ChartLoadingPlaceholderGroup/);
    });

    test('wraps the InspectionDonutCard inside its own Suspense boundary inside the Inspections TileSection', () => {
      // The donut lives inside the Inspections TileSection grid,
      // not after it, so it gets its own Suspense boundary with
      // the donut-sized fallback (gridColumn: 1 / -1). The
      // `key={...}` Suspense prop is intentionally absent (see
      // above). Regex window widened to {0,250} to tolerate
      // prop ordering between the open tag and the child.
      expect(dashboardSrc).toMatch(/React\.Suspense[\s\S]{0,250}InspectionDonutCard/);
      expect(dashboardSrc).toMatch(/InspectionDonutCard\s+byType=\{kpis\.inspections\?\.byType/);
      expect(dashboardSrc).toMatch(/totalCount=\{kpis\.inspections\?\.totalCount/);
    });

    test('declares inline ChartLoadingPlaceholder + ChartLoadingPlaceholderGroup (eager, no recharts)', () => {
      // The Suspense fallback MUST be eager — if it were lazy
      // too, the user would see nothing during the load window.
      // These two helpers have no recharts dependency, so they
      // can live in the main chunk.
      expect(dashboardSrc).toMatch(/function\s+ChartLoadingPlaceholder\s*\(/);
      expect(dashboardSrc).toMatch(/function\s+ChartLoadingPlaceholderGroup\s*\(/);
    });
  });

  describe('chart sections — 6 chart primitives are wired (4 in the lazy chunk, 2 inline)', () => {
    test('ProjectDashboardCharts renders DashboardAreaChart for the DPR activity section (chart 1)', () => {
      expect(chartsSrc).toMatch(/DPR activity/);
      expect(chartsSrc).toMatch(/<DashboardAreaChart\b/);
      expect(chartsSrc).toMatch(/submitted[\s\S]*?underReview[\s\S]*?approved[\s\S]*?rejected/);
    });

    test('ProjectDashboardCharts renders DashboardDonutChart for the inspection-by-type card (chart 2)', () => {
      expect(chartsSrc).toMatch(/Inspections by type/);
      expect(chartsSrc).toMatch(/<DashboardDonutChart\b/);
      expect(chartsSrc).toMatch(/prettyInspectionType/);
    });

    test('ProjectDashboardCharts renders BoqTopNBar for the BOQ top variances section (chart 3)', () => {
      expect(chartsSrc).toMatch(/BOQ top variances/);
      expect(chartsSrc).toMatch(/<BoqTopNBar\b/);
      expect(chartsSrc).toMatch(/function\s+BoqTopNBar\s*\(/);
    });

    test('ProjectDashboardCharts renders InspectionFunnel for the inspection status section (chart 4)', () => {
      expect(chartsSrc).toMatch(/Inspection status/);
      expect(chartsSrc).toMatch(/<InspectionFunnel\b/);
      expect(chartsSrc).toMatch(/function\s+InspectionFunnel\s*\(/);
      expect(chartsSrc).toMatch(/InspectionFunnel[\s\S]{0,200}total=\{kpis\?\.inspections\?\.totalCount/);
      expect(chartsSrc).toMatch(/open=\{kpis\?\.inspections\?\.openCount/);
    });

    test('ProjectDashboardCharts renders PeopleHeatmap for the people workload section (chart 5)', () => {
      expect(chartsSrc).toMatch(/People workload/);
      expect(chartsSrc).toMatch(/<PeopleHeatmap\b/);
      expect(chartsSrc).toMatch(/function\s+PeopleHeatmap\s*\(/);
      expect(chartsSrc).toMatch(/PeopleHeatmap\s+buckets=\{peopleBuckets/);
    });

    test('StatSparklineTile is used in the parent for the Pending Review tile (chart 6, stays eager)', () => {
      // Chart 6 (embedded sparkline) has no recharts dependency so
      // it lives in the main chunk — the StatSparklineTile is
      // imported eagerly in ProjectDashboard.jsx, not lazy.
      expect(dashboardSrc).toMatch(/<StatSparklineTile\b/);
      expect(dashboardSrc).toMatch(/tileKey="dpr\.pendingReview"/);
      expect(dashboardSrc).toMatch(/pendingReviewSparkline\(/);
      expect(dashboardSrc).toMatch(/r\.status\s*===\s*['"]SUBMITTED['"][\s\S]*?r\.status\s*===\s*['"]UNDER_REVIEW['"]/);
    });
  });

  describe('chart data wiring — kpiBuckets.js output shapes are consumed correctly', () => {
    test('the DPR trend data is built from bucketByDay(rows, days, reportDate) in the parent', () => {
      // The parent does the bucketing (pure, eager). The lazy
      // chunk only receives the bucket arrays.
      expect(dashboardSrc).toMatch(/bucketByDay\(chartLists\?\.dprs\s*\|\|\s*\[\],\s*days,\s*['"]reportDate['"]\)/);
    });

    test('the BOQ top-10 calls byLineItemTopN(chartLists.boq, 10) in the parent', () => {
      expect(dashboardSrc).toMatch(/byLineItemTopN\(chartLists\?\.boq\s*\|\|\s*\[\],\s*10\)/);
    });

    test('the people workload merges DPR + Inspection lists before bucketing byEmployeeWeek', () => {
      expect(dashboardSrc).toMatch(/\[\s*\.\.\.\(chartLists\?\.dprs\s*\|\|\s*\[\]\)[\s\S]*?\.\.\.\(chartLists\?\.inspections\s*\|\|\s*\[\]\)/);
      expect(dashboardSrc).toMatch(/byEmployeeWeek\(combined,\s*28\)/);
    });
  });

  describe('chart data fetcher — loadChartLists fires in parallel with loadKpis', () => {
    test('declares loadChartLists that fetches /dprs, /inspections, /boq in parallel', () => {
      expect(dashboardSrc).toMatch(/api\.getDprs\(/);
      expect(dashboardSrc).toMatch(/api\.getInspections\(/);
      expect(dashboardSrc).toMatch(/api\.getBoqItems\(/);
      expect(dashboardSrc).toMatch(/Promise\.all\(\s*\[\s*api\.getDprs/);
    });

    test('loadChartLists has an epoch guard (stale-response protection)', () => {
      expect(dashboardSrc).toMatch(/chartEpochRef\s*=\s*useRef\(0\)/);
      expect(dashboardSrc).toMatch(/\+\+chartEpochRef\.current/);
      expect(dashboardSrc).toMatch(/myEpoch\s*!==\s*chartEpochRef\.current/);
    });

    test('loadChartLists is called on selection / days change AND on the visibility listener', () => {
      expect(dashboardSrc).toMatch(/refreshChartListsRef\.current\?\.\(\)/);
      expect(dashboardSrc).toMatch(/loadChartListsRef\.current\?\.\(\)/);
    });
  });

  describe('empty-state handling — every chart has a graceful no-data path', () => {
    test('DashboardAreaChart renders the "No data yet" empty state when the rows are all zero', () => {
      expect(areaChartSrc).toMatch(/function\s+EmptyChartMessage\b/);
      expect(areaChartSrc).toMatch(/hasData\s*=\s*Array\.isArray\(data\)/);
    });

    test('DashboardAreaChart calls all hooks BEFORE the empty-state early-return (no #310)', () => {
      // R38.1.1 — the real root cause of the React #310 was a
      // conditional hook call: `useMemo` + `useId` sat AFTER
      // `if (!hasData) return <EmptyChartMessage />`. When data
      // went from empty → non-empty between renders, hooks appeared
      // and recharts/React threw "Rendered more hooks than during
      // the previous render". Pin the order so a future refactor
      // doesn't re-introduce the bug.
      const hasDataIdx = areaChartSrc.search(/hasData\s*=\s*Array\.isArray/);
      const configIdx = areaChartSrc.search(/const\s+config\s*=\s*useMemo/);
      const gradIdIdx = areaChartSrc.search(/const\s+gradId\s*=\s*useId/);
      const earlyReturnIdx = areaChartSrc.search(/if\s*\(\s*!hasData\s*\)\s*\{/);
      expect(hasDataIdx).toBeGreaterThan(-1);
      expect(configIdx).toBeGreaterThan(-1);
      expect(gradIdIdx).toBeGreaterThan(-1);
      expect(earlyReturnIdx).toBeGreaterThan(-1);
      expect(hasDataIdx).toBeLessThan(configIdx);
      expect(configIdx).toBeLessThan(gradIdIdx);
      expect(gradIdIdx).toBeLessThan(earlyReturnIdx);
    });

    test('DashboardDonutChart renders the "No data yet" empty state when totalValue is 0', () => {
      expect(donutChartSrc).toMatch(/function\s+EmptyDonutMessage\b/);
      expect(donutChartSrc).toMatch(/const\s+totalValue\s*=\s*useMemo/);
    });

    test('DashboardDonutChart calls all hooks BEFORE the empty-state early-return (no #310)', () => {
      // Same anti-pattern as DashboardAreaChart — `useMemo` for
      // config + legendRows was after the `if (!hasData)` return.
      // Pin the order here too.
      const totalValueIdx = donutChartSrc.search(/const\s+totalValue\s*=\s*useMemo/);
      const configIdx = donutChartSrc.search(/const\s+config\s*=\s*useMemo/);
      const legendRowsIdx = donutChartSrc.search(/const\s+legendRows\s*=\s*useMemo/);
      const earlyReturnIdx = donutChartSrc.search(/if\s*\(\s*!hasData\s*\)\s*\{/);
      expect(totalValueIdx).toBeGreaterThan(-1);
      expect(configIdx).toBeGreaterThan(-1);
      expect(legendRowsIdx).toBeGreaterThan(-1);
      expect(earlyReturnIdx).toBeGreaterThan(-1);
      expect(totalValueIdx).toBeLessThan(configIdx);
      expect(configIdx).toBeLessThan(legendRowsIdx);
      expect(legendRowsIdx).toBeLessThan(earlyReturnIdx);
    });

    test('BoqTopNBar renders an inline empty-state when rows is empty', () => {
      // The empty-state branch lives in the lazy chunk now.
      expect(chartsSrc).toMatch(/function\s+BoqTopNBar[\s\S]{0,1500}No BOQ line items/);
    });

    test('InspectionFunnel renders an inline empty-state when total === 0', () => {
      expect(chartsSrc).toMatch(/function\s+InspectionFunnel[\s\S]{0,1500}No inspections recorded/);
    });

    test('PeopleHeatmap renders an inline empty-state when rows is empty', () => {
      expect(chartsSrc).toMatch(/function\s+PeopleHeatmap[\s\S]{0,1500}No people activity/);
    });
  });

  describe('chart section ordering — DPR activity comes before BOQ top variances (etc.)', () => {
    test('sections render in plan order: DPR activity → BOQ → Inspection → People', () => {
      const dprIdx = chartsSrc.indexOf('DPR activity');
      const boqIdx = chartsSrc.indexOf('BOQ top variances');
      const inspIdx = chartsSrc.indexOf('Inspection status');
      const peopleIdx = chartsSrc.indexOf('People workload');
      expect(dprIdx).toBeGreaterThan(-1);
      expect(boqIdx).toBeGreaterThan(-1);
      expect(inspIdx).toBeGreaterThan(-1);
      expect(peopleIdx).toBeGreaterThan(-1);
      expect(dprIdx).toBeLessThan(boqIdx);
      expect(boqIdx).toBeLessThan(inspIdx);
      expect(inspIdx).toBeLessThan(peopleIdx);
    });
  });

  describe('source attribution — MIT license is preserved on the adapted files', () => {
    test('ChartContainer.jsx cites shadcn/ui', () => {
      expect(containerSrc).toMatch(/shadcn\/ui/);
    });

    test('AreaChart.jsx cites shadcn dashboard-01', () => {
      expect(areaChartSrc).toMatch(/shadcn/);
      expect(areaChartSrc).toMatch(/dashboard-01/);
    });

    test('StatSparklineTile.jsx cites satnaing shadcn-admin', () => {
      expect(sparklineTileSrc).toMatch(/satnaing/);
    });
  });

  describe('existing fixtures are not silently broken', () => {
    test('kpiBuckets.js still exports the four pure functions the page imports', () => {
      expect(kpiBucketsSrc).toMatch(/export\s+function\s+bucketByDay\b/);
      expect(kpiBucketsSrc).toMatch(/export\s+function\s+byLineItemTopN\b/);
      expect(kpiBucketsSrc).toMatch(/export\s+function\s+byEmployeeWeek\b/);
      expect(kpiBucketsSrc).toMatch(/export\s+function\s+pendingReviewSparkline\b/);
    });
  });
});
