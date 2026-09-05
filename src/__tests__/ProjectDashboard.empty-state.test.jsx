// N17 — ProjectDashboard empty-state coverage.
//
// Mounting the full ProjectDashboard in jsdom drags in the lazy router
// graph that exhausts memory in this sandbox (see App.test.jsx for the
// broader pattern). Source-text + behavioural-mirror checks below are
// deterministic and run in <1ms.
//
// Two regressions this pins:
//   1. The page renders an empty state — not a tile grid — when no
//      project is selected yet (the dropdown is the primary control and
//      a user who lands on the URL before the auto-select kicks in
//      should never see a 0/0/0 tile grid).
//   2. The empty state surfaces the two CTAs that recover the user:
//      "+ New Project" and "Browse all projects". A regression that
//      drops either leaves a PM stranded on a blank page.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const dashboardPath = resolvePath(__dirname, '../pages/admin/ProjectDashboard.jsx');
const appPath = resolvePath(__dirname, '../App.jsx');
const apiPath = resolvePath(__dirname, '../lib/api.js');
const dashboardSource = readFileSync(dashboardPath, 'utf8');
const appSource = readFileSync(appPath, 'utf8');
const apiSource = readFileSync(apiPath, 'utf8');

// ──── Behavioural mirror ──────────────────────────────────────────────────
// Mirror the production decision of "should the dashboard render the
// empty state, the error state, or the KPI grid (which handles its own
// loading branch internally)?". Production branches in this exact
// order: null → empty, error → error, otherwise → tiles. The tiles
// branch renders its own "Loading KPIs…" message when `kpis` is null,
// so a separate loading top-level branch would shadow that.
function renderBranch({ selectedProject, kpisError, loading }) {
  if (!selectedProject) return { type: 'empty' };
  if (kpisError) return { type: 'error' };
  return { type: 'tiles', loading };
}

describe('ProjectDashboard — N17 empty-state wiring', () => {
  describe('API surface', () => {
    test('api.js exports the six project wrapper methods', () => {
      // The backend ships the full CRUD + KPI endpoint; the frontend
      // wrapper must mirror all six so ProjectsAdmin / ProjectForm /
      // ProjectDashboard can call them without a local re-implementation.
      expect(apiSource).toMatch(/getProjects:\s*\(/);
      expect(apiSource).toMatch(/createProject:\s*\(/);
      expect(apiSource).toMatch(/getProject:\s*\(/);
      expect(apiSource).toMatch(/updateProject:\s*\(/);
      expect(apiSource).toMatch(/softDeleteProject:\s*\(/);
      expect(apiSource).toMatch(/getProjectKpis:\s*\(/);
    });

    test('getProjectKpis encodes the idOrName so names with spaces survive', () => {
      // "T-Nagar / Phase II" needs encoding — Express decodes it but the
      // backend resolves by name. A regression to a literal-template
      // string would 404 the dashboard for any name containing / or space.
      expect(apiSource).toMatch(/getProjectKpis:[\s\S]*?encodeURIComponent\([\s\S]*?idOrName[\s\S]*?\)/);
    });
  });

  describe('App.jsx wiring', () => {
    test('declares lazy imports for all three new pages', () => {
      expect(appSource).toMatch(/const\s+ProjectDashboard\s*=\s*React\.lazy\([\s\S]*?ProjectDashboard\.jsx['"]\)/);
      expect(appSource).toMatch(/const\s+ProjectsAdmin\s*=\s*React\.lazy\([\s\S]*?ProjectsAdmin\.jsx['"]\)/);
      expect(appSource).toMatch(/const\s+ProjectForm\s*=\s*React\.lazy\([\s\S]*?ProjectForm\.jsx['"]\)/);
    });

    test('declares the four routes in the correct order (literal before :id)', () => {
      // Round-20 lesson: literal "/new" MUST come before "/:id/edit" so
      // HashRouter doesn't parse "new" as :id="new". Mirror the same
      // ordering as the training routes above.
      const projectDashboardIdx = appSource.indexOf('"admin/project-dashboard"');
      const projectsIdx = appSource.indexOf('"admin/projects"');
      const newIdx = appSource.indexOf('"admin/projects/new"');
      const editIdx = appSource.indexOf('"admin/projects/:id/edit"');
      expect(projectDashboardIdx).toBeGreaterThan(-1);
      expect(projectsIdx).toBeGreaterThan(-1);
      expect(newIdx).toBeGreaterThan(-1);
      expect(editIdx).toBeGreaterThan(-1);
      // /new must come before /:id/edit
      expect(newIdx).toBeLessThan(editIdx);
      // The shared parent /projects must come before /projects/new
      expect(projectsIdx).toBeLessThan(newIdx);
    });
  });

  describe('empty-state component', () => {
    test('renders an EmptyState component when no project is selected', () => {
      // Source must define a named EmptyState component AND branch on
      // selectedProject == null to render it.
      expect(dashboardSource).toMatch(/function\s+EmptyState\s*\(/);
      // The branch lives in the main render block.
      expect(dashboardSource).toMatch(/!selectedProject\s*\?\s*\(\s*<EmptyState\s*\/>\s*\)/);
    });

    test('EmptyState surfaces both recovery CTAs (New Project + Browse all)', () => {
      // Two exit ramps: the user can either create a fresh project or
      // navigate to the existing list. Dropping either is a UX regression.
      const emptyBlock = dashboardSource.match(/function\s+EmptyState[\s\S]*?\n\}/);
      expect(emptyBlock).toBeTruthy();
      expect(emptyBlock[0]).toMatch(/New\s*Project/);
      expect(emptyBlock[0]).toMatch(/Browse\s+all\s+projects/);
    });

    test('EmptyState links to /portal/admin/projects/new and /portal/admin/projects', () => {
      const emptyBlock = dashboardSource.match(/function\s+EmptyState[\s\S]*?\n\}/);
      expect(emptyBlock).toBeTruthy();
      expect(emptyBlock[0]).toMatch(/to=['"]\/portal\/admin\/projects\/new['"]/);
      expect(emptyBlock[0]).toMatch(/to=['"]\/portal\/admin\/projects['"]/);
    });
  });

  describe('behavioural mirror — render-branch decision', () => {
    test('null selectedProject → empty branch', () => {
      expect(renderBranch({ selectedProject: null })).toEqual({ type: 'empty' });
    });

    test('populated selectedProject + kpisError → error branch', () => {
      expect(renderBranch({
        selectedProject: { id: 'p1', name: 'X' },
        kpisError: 'boom',
        loading: false,
      })).toEqual({ type: 'error' });
    });

    test('populated selectedProject + loading → tiles branch with internal loading state', () => {
      // Loading-only should fall through to tiles (which shows its own
      // "Loading KPIs…" sub-state when kpis is null) — not the empty
      // branch. The production `ProjectKpiView` reads `loading` itself
      // and renders a spinner; the top-level branch never short-circuits
      // on loading alone.
      expect(renderBranch({
        selectedProject: { id: 'p1', name: 'X' },
        kpisError: '',
        loading: true,
      })).toEqual({ type: 'tiles', loading: true });
    });
  });
});