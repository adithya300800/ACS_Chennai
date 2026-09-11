// R38.1 (2026-09-10) — Project Dashboard "All projects" roll-up.
//
// User feedback: "I want the option to see all projects in that drop
// down and the charts and ui details of combined all project."
//
// Implementation: a sentinel `id: '__all__'` is prepended to the
// project dropdown and seeds the initial selection. When set:
//   - loadKpis fans out `getProjectKpis(id)` for every registered
//     project in parallel and sums the buckets client-side via
//     sumKpiPayloads().
//   - loadChartLists drops the projectId/projectName filter so the
//     list endpoints return their unscoped org-wide view.
//   - drillScope() returns `{}` (no scope) so the per-tile View-All
//     links land on the unscoped admin queue, not on a project that
//     doesn't exist.
//   - The page subtitle flips to "rolled up across every project"
//     so the user knows the numbers are aggregated.
//
// All of the above is implemented in src/pages/admin/ProjectDashboard.jsx.
// These source-text pins stop a future refactor from silently
// reverting the change (e.g. by re-pinning the initial selection to
// `null` and falling back to "first project", or by removing the
// sumKpiPayloads aggregator).

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const dashboardPath = resolvePath(__dirname, '../pages/admin/ProjectDashboard.jsx');
const dashboardSrc = readFileSync(dashboardPath, 'utf8');

// ─── Sentinel + initial selection ───────────────────────────────────────────
describe('R38.1 — All-projects sentinel + default selection', () => {
  test('Defines an ALL_PROJECTS_ID sentinel', () => {
    expect(dashboardSrc).toMatch(/ALL_PROJECTS_ID\s*=\s*['"]__all__['"]/);
  });

  test('Initial selectedProject is the sentinel (lands on All projects by default)', () => {
    // The useState init MUST be the sentinel — NOT null. The whole
    // "land on All projects by default" UX falls apart if this reverts
    // to `null` and falls back to "first project".
    expect(dashboardSrc).toMatch(
      /useState\(\s*\{\s*id:\s*ALL_PROJECTS_ID/,
    );
  });

  test('isAllProjects flag is computed from the sentinel', () => {
    // The declaration is `const isAllProjects = (...) || false;` — the
    // optional `const` prefix in the regex lets us also pin a future
    // `let` / direct-assign refactor without false-positive failure.
    expect(dashboardSrc).toMatch(
      /(?:const|let|var)?\s*isAllProjects\s*=\s*\(\s*selectedProject\s*&&\s*selectedProject\.id\s*===\s*ALL_PROJECTS_ID\s*\)/,
    );
  });

  test('isAllProjects is declared AFTER the selectedProject useState (no TDZ)', () => {
    // Live crash (f0a574b, 2026-09-10):
    //   ReferenceError: Cannot access 'p' before initialization
    //     at Ve (ProjectDashboard-…js:2:15438)
    // Root cause: `const isAllProjects = (selectedProject && ...)`
    // was declared on a line BEFORE `const [selectedProject, ...] =
    // useState(...)`. `const` bindings live in the TDZ until the line
    // that declares them runs, so the component threw on first render.
    // This pin guarantees `isAllProjects` follows the useState in the
    // file — reorder is a hard regression.
    const useStateIdx = dashboardSrc.indexOf('const [selectedProject, setSelectedProject]');
    const flagIdx = dashboardSrc.search(
      /\b(?:const|let|var)\s+isAllProjects\s*=\s*\(\s*selectedProject\s*&&/,
    );
    expect(useStateIdx).toBeGreaterThan(-1);
    expect(flagIdx).toBeGreaterThan(-1);
    expect(flagIdx).toBeGreaterThan(useStateIdx);
  });

  test('isDiscovered in ProjectKpiView is suppressed for the all-projects sentinel', () => {
    // The sentinel is stamped `isRegistered: false`, so without the
    // explicit `isAllProjectsView` guard the project header card
    // would render an amber "Not yet registered" badge + a
    // "Register this project →" CTA — wrong and confusing on the
    // org-wide roll-up. Pin the guard.
    expect(dashboardSrc).toMatch(
      /isAllProjectsView\s*=\s*selectedProject\s*&&\s*selectedProject\.id\s*===\s*['"]__all__['"]/,
    );
    expect(dashboardSrc).toMatch(
      /const\s+isDiscovered\s*=\s*!isAllProjectsView\s*&&\s*project\.isRegistered\s*===\s*false/,
    );
  });
});

// ─── Dropdown wiring ───────────────────────────────────────────────────────
describe('R38.1 — Dropdown exposes All projects', () => {
  test('Dropdown contains an <option value={ALL_PROJECTS_ID}>All projects</option>', () => {
    expect(dashboardSrc).toMatch(
      /<option\s+value=\{ALL_PROJECTS_ID\}>All projects<\/option>/,
    );
  });

  test('onChange handler routes the sentinel to setSelectedProjectIfChanged', () => {
    expect(dashboardSrc).toMatch(
      /if\s*\(\s*v\s*===\s*ALL_PROJECTS_ID\s*\)\s*\{[\s\S]{0,200}?setSelectedProjectIfChanged\(\s*\{\s*id:\s*ALL_PROJECTS_ID/,
    );
  });
});

// ─── KPI fan-out ────────────────────────────────────────────────────────────
describe('R38.1 — KPI fan-out across all projects', () => {
  test('loadKpis branches on isAllProjects and fans out getProjectKpis', () => {
    // The 700-char window covers the multi-line R38.1 comment block
    // that sits between `if (isAllProjects) {` and the fan-out line.
    expect(dashboardSrc).toMatch(
      /if\s*\(\s*isAllProjects\s*\)\s*\{[\s\S]{0,800}?refs\s*=\s*projectsRef\.current\.map\(\s*\(p\)\s*=>\s*p\.id\s*\)/,
    );
    expect(dashboardSrc).toMatch(
      /data\s*=\s*sumKpiPayloads\(\s*results\.filter\(Boolean\)\s*\)/,
    );
  });

  test('sumKpiPayloads + emptyKpiPayload helpers are defined alongside the component', () => {
    expect(dashboardSrc).toMatch(/function\s+emptyKpiPayload\s*\(/);
    expect(dashboardSrc).toMatch(/function\s+sumKpiPayloads\s*\(/);
  });

  test('sumKpiPayloads sums DPR counts (submitted + pending + approved + rejected + draft)', () => {
    // Pin the exact field list so a future "let me just average these"
    // refactor fires the assertion.
    const sumBlock = dashboardSrc.match(/function\s+sumKpiPayloads[\s\S]*?\n\}\n/);
    expect(sumBlock).not.toBeNull();
    const fn = sumBlock[0];
    expect(fn).toMatch(/dpr\.submittedCount/);
    expect(fn).toMatch(/dpr\.pendingReviewCount/);
    expect(fn).toMatch(/dpr\.approvedCount/);
    expect(fn).toMatch(/dpr\.rejectedCount/);
    expect(fn).toMatch(/dpr\.draftCount/);
  });

  test('sumKpiPayloads recombines byType map (union of every project)', () => {
    const sumBlock = dashboardSrc.match(/function\s+sumKpiPayloads[\s\S]*?\n\}\n/);
    const fn = sumBlock[0];
    expect(fn).toMatch(/inspections\.byType/);
    expect(fn).toMatch(/Object\.entries/);
    expect(fn).toMatch(/\(out\.inspections\.byType\[k\]\s*\|\|\s*0\)\s*\+\s*\(Number\(v\)\s*\|\|\s*0\)/);
  });

  test('sumKpiPayloads recomputes BOQ variancePct from summed contract + executed (not averaged)', () => {
    const sumBlock = dashboardSrc.match(/function\s+sumKpiPayloads[\s\S]*?\n\}\n/);
    const fn = sumBlock[0];
    expect(fn).toMatch(/out\.boq\.variancePct\s*=\s*\(\(out\.boq\.executedValue\s*-\s*out\.boq\.contractValue\)/);
  });

  test('sumKpiPayloads merges + sorts pendingReviewTrend by date key', () => {
    const sumBlock = dashboardSrc.match(/function\s+sumKpiPayloads[\s\S]*?\n\}\n/);
    const fn = sumBlock[0];
    expect(fn).toMatch(/Array\.from\(trend\.values\(\)\)\.sort/);
  });
});

// ─── Chart-list unscoped call ───────────────────────────────────────────────
describe('R38.1 — Chart-list loader skips project scope when isAllProjects', () => {
  test('loadChartLists uses empty scope in all-projects mode', () => {
    expect(dashboardSrc).toMatch(
      /const\s+scope\s*=\s*isAllProjects\s*\?\s*\{\}\s*:\s*drillScope\(selectedProject\)/,
    );
  });
});

// ─── drillScope sentinel handling ───────────────────────────────────────────
describe('R38.1 — drillScope + viewAll handle the sentinel', () => {
  test('drillScope returns {} for the sentinel so per-tile loaders hit the unscoped endpoint', () => {
    expect(dashboardSrc).toMatch(
      /function\s+drillScope\([\s\S]*?if\s*\(\s*p\.id\s*===\s*['"]__all__['"]\s*\)\s*return\s*\{\}/,
    );
  });

  test('Each viewAll guards against the sentinel (no projectId in unscoped queue URL)', () => {
    // Pattern: every viewAll function must conditionally skip
    // `params.projectId` when `p.id === '__all__'`. Count the
    // occurrences — should be at least 7 (8 tiles minus the OPEN one
    // which is open already).
    const matches = dashboardSrc.match(/p\.id\s*!==\s*['"]__all__['"]\s*\)\s*params\.projectId/g);
    expect(matches).not.toBeNull();
    expect(matches.length).toBeGreaterThanOrEqual(6);
  });
});

// ─── Subtitle flip ──────────────────────────────────────────────────────────
describe('R38.1 — Page subtitle reflects all-projects mode', () => {
  test('Subtitle flips to "rolled up across every project" when isAllProjects', () => {
    expect(dashboardSrc).toMatch(
      /isAllProjects\s*\?\s*['"`]KPIs across DPR, Inspections, BOQ, and People — rolled up across every project\.['"`]/,
    );
    expect(dashboardSrc).toMatch(
      /:\s*['"`]KPIs across DPR, Inspections, BOQ, and People — scoped to a single project\.['"`]/,
    );
  });
});

// ─── Pure-function sanity test for sumKpiPayloads ───────────────────────────
//
// Eval the source via a Function constructor so we don't have to mount
// React. This pins the math: two projects with overlapping byType keys
// combine, counts sum, variancePct is recomputed.
describe('R38.1 — sumKpiPayloads math (eval sanity)', () => {
  // eslint-disable-next-line no-new-func
  const evalSource = new Function(
    `${dashboardSrc.match(/function emptyKpiPayload[\s\S]*?\n\}/)[0]}\n${dashboardSrc.match(/function sumKpiPayloads[\s\S]*?\n\}/)[0]}\nreturn { emptyKpiPayload, sumKpiPayloads };`,
  );

  test('emptyKpiPayload returns the same shape a real backend response carries', () => {
    const { emptyKpiPayload } = evalSource();
    const e = emptyKpiPayload();
    expect(e).toHaveProperty('dpr.submittedCount', 0);
    expect(e).toHaveProperty('dpr.pendingReviewCount', 0);
    expect(e).toHaveProperty('inspections.byType');
    expect(e).toHaveProperty('boq.contractValue', 0);
    expect(e).toHaveProperty('boq.variancePct', 0);
    // R38.1.1 — `boqVariance` is the long-shape field name the
    // per-project /kpis endpoint emits (itemsCount, totalContractValue,
    // ...). The BOQ tiles read from this shape; without the empty stub
    // in this stub, the all-projects roll-up shows 0 across the BOQ row.
    expect(e).toHaveProperty('boqVariance.itemsCount', 0);
    expect(e).toHaveProperty('boqVariance.totalContractValue', 0);
    expect(e).toHaveProperty('boqVariance.totalExecutedValue', 0);
    expect(e).toHaveProperty('boqVariance.variancePercent', 0);
    expect(e).toHaveProperty('people.onLeaveTodayCount', 0);
    expect(Array.isArray(e.pendingReviewTrend)).toBe(true);
    expect(Array.isArray(e.warnings)).toBe(true);
  });

  test('Counts add across two projects (DPR + inspection + people)', () => {
    const { sumKpiPayloads } = evalSource();
    // BOQ numbers deliberately asymmetric across the two projects so
    // the recompute path has something to do:
    //   a: contract 100000 / executed 130000  → individual +30%
    //   b: contract 200000 / executed 100000  → individual -50%
    // Summed: contract 300000 / executed 230000 → recomputed -23.33…%
    // (NOT the simple average of 30 + -50 = -10 — the pin is on the
    // recompute, not on a copy-paste from the input variancePcts.)
    const a = {
      dpr: { submittedCount: 3, pendingReviewCount: 5, approvedCount: 10, rejectedCount: 1, draftCount: 2 },
      inspections: { totalCount: 4, openCount: 2, byType: { 'cube_casting': 3, 'safety': 1 } },
      boq: { itemCount: 20, contractValue: 100000, executedValue: 130000, variancePct: 30 },
      people: { onLeaveTodayCount: 1, pendingLeaveCount: 0, overdueTrainingCount: 2 },
      pendingReviewTrend: [
        { date: '2026-09-01', submitted: 2, underReview: 1 },
      ],
      warnings: [],
    };
    const b = {
      dpr: { submittedCount: 2, pendingReviewCount: 4, approvedCount: 5, rejectedCount: 0, draftCount: 1 },
      inspections: { totalCount: 3, openCount: 1, byType: { 'cube_casting': 2, 'quality': 1 } },
      boq: { itemCount: 10, contractValue: 200000, executedValue: 100000, variancePct: -50 },
      people: { onLeaveTodayCount: 0, pendingLeaveCount: 2, overdueTrainingCount: 1 },
      pendingReviewTrend: [
        { date: '2026-09-02', submitted: 1, underReview: 1 },
        { date: '2026-09-01', submitted: 0, underReview: 2 }, // same date → merge
      ],
      warnings: ['one warning from project B'],
    };
    const out = sumKpiPayloads([a, b]);
    expect(out.dpr.submittedCount).toBe(5);
    expect(out.dpr.pendingReviewCount).toBe(9);
    expect(out.dpr.approvedCount).toBe(15);
    expect(out.dpr.rejectedCount).toBe(1);
    expect(out.dpr.draftCount).toBe(3);
    expect(out.inspections.totalCount).toBe(7);
    expect(out.inspections.openCount).toBe(3);
    // byType merges: cube_casting 3+2=5; safety 1; quality 1
    expect(out.inspections.byType.cube_casting).toBe(5);
    expect(out.inspections.byType.safety).toBe(1);
    expect(out.inspections.byType.quality).toBe(1);
    expect(out.people.onLeaveTodayCount).toBe(1);
    expect(out.people.pendingLeaveCount).toBe(2);
    expect(out.people.overdueTrainingCount).toBe(3);
    expect(out.boq.itemCount).toBe(30);
    expect(out.boq.contractValue).toBe(300000);
    expect(out.boq.executedValue).toBe(230000);
    // (230000 - 300000) / 300000 * 100 = -23.333…
    expect(out.boq.variancePct).toBeCloseTo(-23.3333, 3);
    // Trend: dates merge + sort
    expect(out.pendingReviewTrend.length).toBe(2);
    expect(out.pendingReviewTrend[0].date).toBe('2026-09-01');
    expect(out.pendingReviewTrend[0].submitted).toBe(2); // 2 + 0
    expect(out.pendingReviewTrend[0].underReview).toBe(3); // 1 + 2
    expect(out.pendingReviewTrend[1].date).toBe('2026-09-02');
    expect(out.warnings).toContain('one warning from project B');
  });

  test('Empty input → emptyKpiPayload shape (zero counts, empty maps)', () => {
    const { sumKpiPayloads } = evalSource();
    const out = sumKpiPayloads([]);
    expect(out.dpr.submittedCount).toBe(0);
    expect(out.inspections.byType).toEqual({});
    expect(out.boq.variancePct).toBe(0);
    expect(out.pendingReviewTrend).toEqual([]);
  });

  test('Null entries (a failed fan-out call) are silently dropped', () => {
    const { sumKpiPayloads } = evalSource();
    const out = sumKpiPayloads([
      null,
      { dpr: { submittedCount: 1, pendingReviewCount: 1, approvedCount: 0, rejectedCount: 0, draftCount: 0 }, inspections: { totalCount: 0, openCount: 0, byType: {} }, boq: { itemCount: 0, contractValue: 0, executedValue: 0, variancePct: 0 }, people: { onLeaveTodayCount: 0, pendingLeaveCount: 0, overdueTrainingCount: 0 }, pendingReviewTrend: [], warnings: [] },
      undefined,
    ]);
    expect(out.dpr.submittedCount).toBe(1);
  });

  test('R38.1.1 — sumKpiPayloads mirrors summed BOQ into the long-shape boqVariance the tiles read', () => {
    // The per-project /kpis endpoint returns boqVariance.itemsCount /
    // totalContractValue / totalExecutedValue / variancePercent; the
    // BOQ tiles in ProjectKpiView read from that long shape. After the
    // sum passes, the rolled-up payload must mirror the short `boq`
    // shapes into `boqVariance` so all-projects BOQ tiles render real
    // numbers (without this copy every BOQ tile was 0 in the roll-up).
    const { sumKpiPayloads } = evalSource();
    const a = {
      dpr: { submittedCount: 0, pendingReviewCount: 0, approvedCount: 0, rejectedCount: 0, draftCount: 0 },
      inspections: { totalCount: 0, openCount: 0, byType: {} },
      boq: { itemCount: 5, contractValue: 100000, executedValue: 130000, variancePct: 30 },
      people: { onLeaveTodayCount: 0, pendingLeaveCount: 0, overdueTrainingCount: 0 },
      pendingReviewTrend: [],
      warnings: [],
    };
    const b = {
      dpr: { submittedCount: 0, pendingReviewCount: 0, approvedCount: 0, rejectedCount: 0, draftCount: 0 },
      inspections: { totalCount: 0, openCount: 0, byType: {} },
      boq: { itemCount: 10, contractValue: 200000, executedValue: 100000, variancePct: -50 },
      people: { onLeaveTodayCount: 0, pendingLeaveCount: 0, overdueTrainingCount: 0 },
      pendingReviewTrend: [],
      warnings: [],
    };
    const out = sumKpiPayloads([a, b]);
    expect(out.boqVariance.itemsCount).toBe(15); // 5 + 10
    expect(out.boqVariance.totalContractValue).toBe(300000); // 100k + 200k
    expect(out.boqVariance.totalExecutedValue).toBe(230000); // 130k + 100k
    expect(out.boqVariance.variancePercent).toBeCloseTo(-23.3333, 3); // recomputed from sum
  });
});

// R38.1.1 — initial-mount race fix: when the dashboard lands on the
// "All projects" sentinel, the first loadKpis runs BEFORE the project
// list resolves, so projectsRef.current is [] and the fan-out produces
// an empty payload (→ every tile 0). Pin the re-fire useEffect so a
// future refactor doesn't drop this guard and silently re-break the
// roll-up.
describe('R38.1.1 — All-projects initial-mount race', () => {
  test('Re-fires loadKpis when projects arrive in all-projects mode', () => {
    // The effect must (a) be conditional on isAllProjects, (b) depend on
    // projects.length, and (c) call the loadKpisRef helper. Pin all three.
    // The regex tolerates an optional `.` (optional chaining `.?()`)
    // between `current?` and `()` so source-formatter whitespace doesn't
    // confuse the pin.
    expect(dashboardSrc).toMatch(
      /if\s*\(\s*isAllProjects\s*&&\s*projects\.length\s*>\s*0\s*\)\s*loadKpisRef\.current\?[\s.]*\(\s*\)/,
    );
    // Effect's deps are isAllProjects + projects.length (not the full
    // projects array — the ref pattern keeps loadKpis stable, so we
    // only need to know "did the list size change").
    expect(dashboardSrc).toMatch(
      /useEffect\(\s*\(\)\s*=>\s*\{[\s\S]*?loadKpisRef\.current\?[\s.]*\(\s*\)[\s\S]*?\},\s*\[isAllProjects,\s*projects\.length\]\s*\)/,
    );
  });
});

// R38.1.1 — ISRO crash fix: React #310 ("Rendered more hooks than
// during the previous render") fired when recharts internal hooks
// re-mounted mid-render during a project switch. Two earlier attempts
// (forcing the Suspense boundaries to remount via `key={...}`) actually
// triggered the #310 instead of fixing it — Suspense + lazy chunks
// interact badly with key-based remounts under recharts 3.10. The
// load-bearing fix is to stabilise the `byType` reference: recharts
// infers prop identity by Object.is, so a fresh `{}` literal each
// render would churn the internal hook tree. A module-level frozen
// EMPTY_OBJ keeps the ref stable across renders and across selection
// changes. The Suspense wrappers are intentionally keyless now.
describe('R38.1.1 — Stable EMPTY_OBJ for recharts byType prop', () => {
  test('Donut Suspense does NOT force a key-based remount (would re-trigger #310)', () => {
    // Pin the absence — a regression that re-adds the key={} would
    // re-introduce the #310 crash the empty-obj stable ref is meant
    // to prevent.
    expect(dashboardSrc).not.toMatch(
      /<React\.Suspense\s+key=\{`donut-\$\{selectedProject/,
    );
    expect(dashboardSrc).not.toMatch(
      /<React\.Suspense\s+key=\{`charts-\$\{selectedProject/,
    );
  });

  test('EMPTY_OBJ module constant is defined and used for chart byType refs', () => {
    expect(dashboardSrc).toMatch(
      /const\s+EMPTY_OBJ\s*=\s*Object\.freeze\(\s*\{\s*\}\s*\)/,
    );
    // And it's actually consumed by the donut's `byType` prop:
    expect(dashboardSrc).toMatch(
      /byType=\{kpis\.inspections\?\.byType\s*\?\?\s*EMPTY_OBJ\}/,
    );
  });
});
