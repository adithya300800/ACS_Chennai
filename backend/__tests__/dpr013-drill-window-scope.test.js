/**
 * DR-013 (2026-09-08 SOL audit, drilldown half): "KPI drilldowns do not
 * preserve the tile's population or destination".
 *
 * Three contract pins this file guards (acceptance criteria from the audit):
 *
 *   1. EXACT SCOPE: a `?exactProjectName=1` query flag on /api/dpr flips
 *      the projectName filter from a substring `contains` search to a
 *      case-insensitive `equals` match. The KPI handler already filters
 *      by exact `projectName` (projects.js:1534), so drill rows must use
 *      the same exact scope — otherwise "Tower" leaks into a "Tower
 *      Annex" bucket. The substring behaviour stays the default so the
 *      existing admin filter panel (DprAll.jsx) keeps its free-text
 *      search.
 *
 *   2. WINDOW: the ProjectDashboard drill loaders (TILE_META in
 *      src/pages/admin/ProjectDashboard.jsx) must thread the
 *      `kpis.window.{from,to}` half-open range through to the list
 *      endpoint as inclusive YYYY-MM-DD `from`/`to`. Drill rows must
 *      match the same window the tile displays.
 *
 *   3. ALL-DATE OPEN: the `inspection.open` tile's KPI count is the
 *      ORG-wide OPEN backlog (kpiHandler:1562), intentionally not
 *      windowed. The drill loader must NOT pass a window for that tile
 *      so old OPEN inspections stay visible.
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';

const fs = require('fs');
const path = require('path');

const DPR_JS = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'dpr.js'),
  'utf8',
);
const PROJECT_DASHBOARD_JSX = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'pages', 'admin', 'ProjectDashboard.jsx'),
  'utf8',
);

describe('SOL DR-013 — drilldown scope, window, and OPEN preservation', () => {
  // ─── Acceptance 1: exactProjectName flag ────────────────────────────────
  describe('1. exactProjectName query flag flips projectName filter to equals', () => {
    test('1a. backend parses exactProjectName from the query', () => {
      // The destructured query object must include exactProjectName. A
      // future refactor that drops the param would silently regress all
      // exact-scope drill rows back to contains-match.
      const handlerStart = DPR_JS.indexOf("router.get('/'");
      // Find the first /api/dpr list handler (the one that takes
      // projectName as a substring search). We rely on the destructure
      // being unique enough.
      expect(DPR_JS).toMatch(/exactProjectName/);
    });

    test('1b. backend uses equals when flag is set', () => {
      // The where-clause builder must branch on the flag — substring
      // search stays the default so the admin filter panel keeps its
      // free-text search behaviour.
      expect(DPR_JS).toMatch(/exactProjectName\s*===\s*['"]1['"]\s*\|\|\s*exactProjectName\s*===\s*['"]true['"]/);
      expect(DPR_JS).toMatch(/equals:\s*projectName,\s*mode:\s*['"]insensitive['"]/);
    });

    test('1c. frontend ProjectDashboard forwards exactProjectName for discovered projects', () => {
      // drillScope() must emit exactProjectName: '1' when only projectName
      // is available, so the substring leak disappears.
      expect(PROJECT_DASHBOARD_JSX).toMatch(/exactProjectName:\s*['"]1['"]/);
    });
  });

  // ─── Acceptance 2: window threads through ───────────────────────────────
  describe('2. drill loaders thread kpis.window into the list endpoint', () => {
    test('2a. TILE_META loader signature accepts (project, token, kpis)', () => {
      // The loader is invoked from InlineDrillPanel with kpis so the
      // window can be passed through. The handler must destructure it.
      // We grep for the loader call site to prove it forwards kpis.
      expect(PROJECT_DASHBOARD_JSX).toMatch(/meta\.loader\(project,\s*accessToken,\s*kpis\)/);
    });

    test('2b. drillWindow() converts toDayExclusive to inclusive YYYY-MM-DD', () => {
      // The KPI window is half-open [from, toExclusive). The list
      // endpoint expects inclusive from/to. The drillWindow helper
      // subtracts one day from `to` so the range stays equivalent.
      expect(PROJECT_DASHBOARD_JSX).toMatch(/drillWindow/);
      expect(PROJECT_DASHBOARD_JSX).toMatch(/setUTCDate\(toDay\.getUTCDate\(\)\s*-\s*1\)/);
    });

    test('2c. dpr.submitted drill passes from/to to getDprs', () => {
      // Pin the per-tile contract: dpr.submitted drill must spread
      // drillWindow into the api.getDprs params (alongside status +
      // exact scope).
      expect(PROJECT_DASHBOARD_JSX).toMatch(/drillWindow\(kpis,\s*['"]dpr\.submitted['"]\)/);
    });

    test('2d. viewAll links include from/to + status', () => {
      // View-all links must carry the same window so the queue page
      // opens pre-filtered to the same bucket the tile showed.
      expect(PROJECT_DASHBOARD_JSX).toMatch(/new URLSearchParams\(\{\s*projectId:\s*idParam,\s*status:\s*['"]APPROVED['"],\s*\.\.\.w\s*\}\)/);
    });
  });

  // ─── Acceptance 3: OPEN inspection tile keeps all-date ──────────────────
  describe('3. inspection.open drill preserves all-date OPEN backlog', () => {
    test('3a. drillWindow returns {} for inspection.open (no window)', () => {
      // The early-return on inspection.open is the only thing keeping
      // old OPEN inspections in the drill panel. A regression that
      // removes the branch would re-introduce the window on OPEN.
      expect(PROJECT_DASHBOARD_JSX).toMatch(/tileKey\s*===\s*['"]inspection\.open['"]\s*\)\s*return\s*\{\s*\}\s*;/);
    });

    test('3b. inspection.open loader does not call drillWindow', () => {
      // The loader function for the OPEN tile must not pull the window
      // helper — the helper is the one that would inject from/to.
      // We assert the OPEN loader signature stays a 2-arg (p, t) closure.
      expect(PROJECT_DASHBOARD_JSX).toMatch(/['"]inspection\.open['"]:\s*\{[\s\S]*?loader:\s*\(p,\s*t\)\s*=>/);
    });
  });
});
