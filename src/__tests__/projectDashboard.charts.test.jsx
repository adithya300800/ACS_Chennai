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
const sparklineTilePath = resolvePath(__dirname, '../components/dashboard/StatSparklineTile.jsx');
const areaChartPath = resolvePath(__dirname, '../components/ui/chart/AreaChart.jsx');
const donutChartPath = resolvePath(__dirname, '../components/ui/chart/DonutChart.jsx');
const containerPath = resolvePath(__dirname, '../components/ui/chart/ChartContainer.jsx');
const kpiBucketsPath = resolvePath(__dirname, '../lib/kpiBuckets.js');

const dashboardSrc = readFileSync(dashboardPath, 'utf8');
const sparklineTileSrc = readFileSync(sparklineTilePath, 'utf8');
const areaChartSrc = readFileSync(areaChartPath, 'utf8');
const donutChartSrc = readFileSync(donutChartPath, 'utf8');
const containerSrc = readFileSync(containerPath, 'utf8');
const kpiBucketsSrc = readFileSync(kpiBucketsPath, 'utf8');

describe('R38 — Project Dashboard chart integration', () => {
  describe('imports — chart primitives are wired into ProjectDashboard', () => {
    test('imports the kpiBuckets pure functions (bucketByDay, byLineItemTopN, byEmployeeWeek, pendingReviewSparkline)', () => {
      expect(dashboardSrc).toMatch(/import\s*\{[^}]*bucketByDay[^}]*\}\s*from\s*['"]\.\.\/\.\.\/lib\/kpiBuckets\.jsx?['"]/);
      expect(dashboardSrc).toMatch(/byLineItemTopN/);
      expect(dashboardSrc).toMatch(/byEmployeeWeek/);
      expect(dashboardSrc).toMatch(/pendingReviewSparkline/);
    });

    test('imports the area + donut chart primitives', () => {
      expect(dashboardSrc).toMatch(/import\s*\{[^}]*DashboardAreaChart[^}]*\}\s*from\s*['"]\.\.\/\.\.\/components\/ui\/chart\/AreaChart\.jsx?['"]/);
      expect(dashboardSrc).toMatch(/import\s*\{[^}]*DashboardDonutChart[^}]*\}\s*from\s*['"]\.\.\/\.\.\/components\/ui\/chart\/DonutChart\.jsx?['"]/);
    });

    test('imports the StatSparklineTile for the embedded pending-review sparkline', () => {
      expect(dashboardSrc).toMatch(/import\s*\{[^}]*StatSparklineTile[^}]*\}\s*from\s*['"]\.\.\/\.\.\/components\/dashboard\/StatSparklineTile\.jsx?['"]/);
    });

    test('imports recharts BarChart + Bar primitives for the inline BOQ top-10 chart', () => {
      expect(dashboardSrc).toMatch(/import\s*\{[^}]*BarChart\s+as\s+RechartsBarChart[^}]*\}\s*from\s*['"]recharts['"]/);
      expect(dashboardSrc).toMatch(/Bar\s+as\s+RechartsBar/);
    });

    test('imports the shared ChartContainer + ChartTooltip from the chart wrapper file', () => {
      expect(dashboardSrc).toMatch(/import\s*\{[^}]*ChartContainer[^}]*\}\s*from\s*['"]\.\.\/\.\.\/components\/ui\/chart\/ChartContainer\.jsx?['"]/);
      expect(dashboardSrc).toMatch(/ChartTooltip/);
    });
  });

  describe('chart sections — 6 chart primitives are wired into ProjectKpiView', () => {
    test('renders DashboardAreaChart for the DPR activity section (chart 1)', () => {
      // Chart 1: DPR trend. Pinned by the section title + the
      // DashboardAreaChart usage + the 4-status series array.
      expect(dashboardSrc).toMatch(/DPR activity/);
      expect(dashboardSrc).toMatch(/<DashboardAreaChart\b/);
      // The series array carries the 4 status fields so the area
      // chart can show submitted / underReview / approved / rejected
      // as four stacked bands.
      expect(dashboardSrc).toMatch(/submitted[\s\S]*?underReview[\s\S]*?approved[\s\S]*?rejected/);
    });

    test('renders DashboardDonutChart for the inspection-by-type card (chart 2)', () => {
      // Chart 2: Inspection-type donut. Pinned by the card title
      // and the DashboardDonutChart usage.
      expect(dashboardSrc).toMatch(/Inspections by type/);
      expect(dashboardSrc).toMatch(/<DashboardDonutChart\b/);
      // The donut is fed kpis.inspections.byType (the server-
      // aggregated map) — pinned so a future refactor can't
      // silently swap to a second fetch.
      expect(dashboardSrc).toMatch(/kpis\.inspections\?\.byType/);
    });

    test('renders BoqTopNBar (inline component) for the BOQ top variances section (chart 3)', () => {
      // Chart 3: BOQ top-10. The wrapper is a same-file component
      // (BoqTopNBar) rather than a new chart wrapper file — pinned
      // by the section title and the inline component reference.
      expect(dashboardSrc).toMatch(/BOQ top variances/);
      expect(dashboardSrc).toMatch(/<BoqTopNBar\b/);
      expect(dashboardSrc).toMatch(/function\s+BoqTopNBar\s*\(/);
    });

    test('renders InspectionFunnel (inline component) for the inspection status section (chart 4)', () => {
      // Chart 4: Inspection funnel. Pinned by the section title
      // and the inline component reference. Data shape:
      // { total, open } — derived from kpis.inspections.totalCount
      // + openCount, NOT a new fetch.
      expect(dashboardSrc).toMatch(/Inspection status/);
      expect(dashboardSrc).toMatch(/<InspectionFunnel\b/);
      expect(dashboardSrc).toMatch(/function\s+InspectionFunnel\s*\(/);
      expect(dashboardSrc).toMatch(/InspectionFunnel\s+total=\{kpis\.inspections\?\.totalCount/);
      expect(dashboardSrc).toMatch(/open=\{kpis\.inspections\?\.openCount/);
    });

    test('renders PeopleHeatmap (inline component) for the people workload section (chart 5)', () => {
      // Chart 5: People workload heatmap. Pinned by the section
      // title and the inline component reference. The heatmap is
      // fed the result of byEmployeeWeek(...) — pinned so a
      // future refactor can't silently change the data source.
      expect(dashboardSrc).toMatch(/People workload/);
      expect(dashboardSrc).toMatch(/<PeopleHeatmap\b/);
      expect(dashboardSrc).toMatch(/function\s+PeopleHeatmap\s*\(/);
      expect(dashboardSrc).toMatch(/PeopleHeatmap\s+buckets=\{peopleBuckets\}/);
    });

    test('StatSparklineTile is used for the Pending Review tile (chart 6)', () => {
      // Chart 6: Embedded sparkline inside the Pending Review tile.
      // Pinned by the StatSparklineTile usage and the points
      // prop being fed pendingReviewSparkline(...) over
      // chartLists.dprs filtered to SUBMITTED + UNDER_REVIEW.
      expect(dashboardSrc).toMatch(/<StatSparklineTile\b/);
      expect(dashboardSrc).toMatch(/tileKey="dpr\.pendingReview"/);
      expect(dashboardSrc).toMatch(/pendingReviewSparkline\(/);
      expect(dashboardSrc).toMatch(/r\.status\s*===\s*['"]SUBMITTED['"][\s\S]*?r\.status\s*===\s*['"]UNDER_REVIEW['"]/);
    });
  });

  describe('chart data wiring — kpiBuckets.js output shapes are consumed correctly', () => {
    test('the DPR trend data is built from bucketByDay(rows, days, reportDate)', () => {
      // Pin the useMemo so a future refactor can't silently switch
      // the date column or the window size.
      expect(dashboardSrc).toMatch(/bucketByDay\(chartLists\?\.dprs\s*\|\|\s*\[\],\s*days,\s*['"]reportDate['"]\)/);
    });

    test('the BOQ top-10 calls byLineItemTopN(chartLists.boq, 10)', () => {
      expect(dashboardSrc).toMatch(/byLineItemTopN\(chartLists\?\.boq\s*\|\|\s*\[\],\s*10\)/);
    });

    test('the people workload merges DPR + Inspection lists before bucketing byEmployeeWeek', () => {
      // The combiner pushes both lists into a single array and
      // passes it to byEmployeeWeek. Pinned so a future change
      // doesn't accidentally drop one of the two sources.
      expect(dashboardSrc).toMatch(/\[\s*\.\.\.\(chartLists\?\.dprs\s*\|\|\s*\[\]\)[\s\S]*?\.\.\.\(chartLists\?\.inspections\s*\|\|\s*\[\]\)/);
      expect(dashboardSrc).toMatch(/byEmployeeWeek\(combined,\s*28\)/);
    });
  });

  describe('chart data fetcher — loadChartLists fires in parallel with loadKpis', () => {
    test('declares loadChartLists that fetches /dprs, /inspections, /boq in parallel', () => {
      // The plan explicitly defers a backend aggregation endpoint
      // and reuses the existing list endpoints. Pin the three
      // API calls so a future refactor can't drop one (a missing
      // call would silently empty a chart).
      expect(dashboardSrc).toMatch(/api\.getDprs\(/);
      expect(dashboardSrc).toMatch(/api\.getInspections\(/);
      expect(dashboardSrc).toMatch(/api\.getBoqItems\(/);
      expect(dashboardSrc).toMatch(/Promise\.all\(\s*\[\s*api\.getDprs/);
    });

    test('loadChartLists has an epoch guard (stale-response protection)', () => {
      // The kpiEpochRef pattern is mirrored here so a fast project
      // switch can't let a stale list overwrite the fresh one.
      expect(dashboardSrc).toMatch(/chartEpochRef\s*=\s*useRef\(0\)/);
      expect(dashboardSrc).toMatch(/\+\+chartEpochRef\.current/);
      expect(dashboardSrc).toMatch(/myEpoch\s*!==\s*chartEpochRef\.current/);
    });

    test('loadChartLists is called on selection / days change AND on the visibility listener', () => {
      // The page-level "Refresh" button + the visibility listener
      // must re-pull the chart lists, otherwise the charts can
      // drift out of sync with the KPI tile counts.
      expect(dashboardSrc).toMatch(/refreshChartListsRef\.current\?\.\(\)/);
      expect(dashboardSrc).toMatch(/loadChartListsRef\.current\?\.\(\)/);
    });
  });

  describe('empty-state handling — every chart has a graceful no-data path', () => {
    test('DashboardAreaChart renders the "No data yet" empty state when the rows are all zero', () => {
      // The wrapper checks `data.length > 0 && data.some(...)` and
      // renders <EmptyChartMessage> otherwise. Pinned so a future
      // refactor can't silently drop the guard.
      expect(areaChartSrc).toMatch(/function\s+EmptyChartMessage\b/);
      expect(areaChartSrc).toMatch(/hasData\s*=\s*Array\.isArray\(data\)/);
    });

    test('DashboardDonutChart renders the "No data yet" empty state when totalValue is 0', () => {
      expect(donutChartSrc).toMatch(/function\s+EmptyDonutMessage\b/);
      expect(donutChartSrc).toMatch(/const\s+totalValue\s*=\s*useMemo/);
    });

    test('BoqTopNBar renders an inline empty-state when rows is empty (the plan calls this out explicitly)', () => {
      // The plan §edge case: "Test this specifically with a project
      // that has no DPRs in the last 30 days." The same rule
      // applies to BOQ — a project with no BOQ items must render
      // a clean "no data" message. The empty-state branch sits
      // inside the function body so we widen the look-ahead to
      // match across the JSX block.
      expect(dashboardSrc).toMatch(/function\s+BoqTopNBar[\s\S]{0,1500}No BOQ line items/);
    });

    test('InspectionFunnel renders an inline empty-state when total === 0', () => {
      expect(dashboardSrc).toMatch(/function\s+InspectionFunnel[\s\S]{0,1500}No inspections recorded/);
    });

    test('PeopleHeatmap renders an inline empty-state when rows is empty', () => {
      expect(dashboardSrc).toMatch(/function\s+PeopleHeatmap[\s\S]{0,1500}No people activity/);
    });
  });

  describe('chart section ordering — DPR activity comes before BOQ top variances (etc.)', () => {
    // The plan orders the four new sections: DPR activity → BOQ
    // variances → Inspection status → People workload. Pin the
    // ordering so a refactor can't accidentally move the people
    // workload up before the BOQ chart.
    test('sections render in plan order: DPR activity → BOQ → Inspection → People', () => {
      const dprIdx = dashboardSrc.indexOf('DPR activity');
      const boqIdx = dashboardSrc.indexOf('BOQ top variances');
      const inspIdx = dashboardSrc.indexOf('Inspection status');
      const peopleIdx = dashboardSrc.indexOf('People workload');
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
    // The plan requires a short comment at the top of each adapted
    // file citing the source. Pin the citation header so a future
    // "lint: clean up" refactor can't silently strip the attribution.
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
