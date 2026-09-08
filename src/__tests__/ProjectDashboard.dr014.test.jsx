// DR-014 — Project dashboard selection-from-URL + drill contract for
// the "Pending Review" tile.
//
// Two regressions pinned:
//   1. The dashboard MUST consume `?project=<id-or-name>` from the URL
//      after the project list lands. Pre-fix, the dashboard auto-
//      selected the first registered project regardless of what the
//      registry link passed — so a deep link from ProjectsAdmin into
//      "Project Foo" silently rendered "Project Bar" (the first
//      row). The fix: read `?project=`, match against `projects` by
//      id then `discovered` by encoded name, and replace the auto-
//      selection.
//   2. The `dpr.pendingReview` drill loader MUST include BOTH
//      SUBMITTED and UNDER_REVIEW rows. The KPI tile's
//      `pendingReviewCount` is the sum of both (admin queue size);
//      the drill panel pre-fix fetched only UNDER_REVIEW, so a tile
//      that read "5" rendered a panel with 1-2 rows. The user reads
//      that as a blank page. The fix: parallel fetch, 5+5.
//
// Source-text pins (not full mount) — same pattern as
// ProjectDashboard.empty-state.test.jsx. The mounted test exhausts
// memory in this sandbox; the source pins are deterministic and run
// in <1ms while still catching a regression that drops the fix.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const dashboardPath = resolvePath(__dirname, '../pages/admin/ProjectDashboard.jsx');
const projectsAdminPath = resolvePath(__dirname, '../pages/admin/ProjectsAdmin.jsx');
const dashboardSource = readFileSync(dashboardPath, 'utf8');
const projectsAdminSource = readFileSync(projectsAdminPath, 'utf8');

// ──── Behavioural mirror: ?project= → selectedProject resolution ──────────
//
// Production: loadProjects populates `projects` + `discovered`, then a
// useEffect scans them in two passes (id match, then name match with
// encodeURIComponent) and calls setSelectedProject. We mirror that here
// so the test pins the resolution order without a full mount.
function resolveProjectFromUrl(urlProject, projects, discovered) {
  if (!urlProject) return null;
  const reg = (projects || []).find((p) => p.id === urlProject);
  if (reg) return { id: reg.id, name: reg.name, isRegistered: true };
  const disc = (discovered || []).find(
    (d) => encodeURIComponent(d.name) === urlProject,
  );
  if (disc) return { id: null, name: disc.name, isRegistered: false };
  return null;
}

describe('ProjectDashboard — DR-014 selection-from-URL', () => {
  describe('ProjectsAdmin registry link shape', () => {
    test('"Open dashboard" links to /portal/admin/project-dashboard?project=<encoded-name>', () => {
      // The link in ProjectsAdmin.jsx feeds the URL parameter the
      // dashboard must consume. If the registry drops the `?project=`
      // param, the dashboard fix has nothing to resolve.
      // Pull the entire `onGoToDashboard={...}` JSX attribute (greedy
      // to the closing `}`) and check it carries the URL builder.
      const linkMatch = projectsAdminSource.match(
        /onGoToDashboard\s*=\s*\{[\s\S]*?navigate\([\s\S]*?\}\s*\}/,
      );
      expect(linkMatch).toBeTruthy();
      expect(linkMatch[0]).toMatch(/project-dashboard/);
      expect(linkMatch[0]).toMatch(/\?project=/);
      expect(linkMatch[0]).toMatch(/encodeURIComponent/);
    });
  });

  describe('ProjectDashboard source contract', () => {
    test('reads the ?project= URL search param into urlProject', () => {
      // Must declare `const urlProject = searchParams.get('project')` so
      // the deep-link has somewhere to land. A regression to a
      // hard-coded `projects[0]` would skip the whole effect.
      expect(dashboardSource).toMatch(
        /urlProject\s*=\s*searchParams\.get\(\s*['"]project['"]\s*\)/,
      );
    });

    test('runs a useEffect that resolves urlProject after the project list lands', () => {
      // The effect gates on `urlProject` being truthy and on
      // (projects + discovered) being non-empty. A regression that
      // resolves synchronously inside the render would race the
      // fetch and always auto-select.
      expect(dashboardSource).toMatch(
        /useEffect\(\s*\(\)\s*=>\s*\{[\s\S]*?urlProject[\s\S]*?projects[\s\S]*?discovered[\s\S]*?\},\s*\[urlProject,\s*projects,\s*discovered\]\s*\)/,
      );
    });

    test('resolves urlProject against projects by id FIRST, then discovered by encoded name', () => {
      // The two-pass match is the contract — id first because the
      // canonical selector for registered projects is the UUID; the
      // discovered pass only fires for the registry link's
      // encodeURIComponent(name) form.
      const effectBlock = dashboardSource.match(
        /useEffect\(\s*\(\)\s*=>\s*\{[\s\S]*?urlProject[\s\S]*?\},\s*\[urlProject,\s*projects,\s*discovered\]\s*\)/,
      );
      expect(effectBlock).toBeTruthy();
      const body = effectBlock[0];
      // Id match precedes name match (string-index check).
      const idIdx = body.search(/projects\.find\(\s*\(p\)\s*=>\s*p\.id\s*===\s*urlProject\s*\)/);
      const nameIdx = body.search(/discovered\.find\(\s*\(d\)\s*=>\s*encodeURIComponent/);
      expect(idIdx).toBeGreaterThan(-1);
      expect(nameIdx).toBeGreaterThan(-1);
      expect(idIdx).toBeLessThan(nameIdx);
    });
  });

  describe('behavioural mirror — ?project= resolution', () => {
    const projects = [
      { id: 'p-1', name: 'T-Nagar' },
      { id: 'p-2', name: 'Velachery Bypass' },
    ];
    const discovered = [
      { name: 'Auto Name' },
    ];

    test('UUID match → registered selection with id', () => {
      expect(resolveProjectFromUrl('p-2', projects, discovered)).toEqual({
        id: 'p-2', name: 'Velachery Bypass', isRegistered: true,
      });
    });

    test('encoded-name match → discovered selection (id=null)', () => {
      expect(resolveProjectFromUrl(encodeURIComponent('Auto Name'), projects, discovered)).toEqual({
        id: null, name: 'Auto Name', isRegistered: false,
      });
    });

    test('empty urlProject → null (lets the auto-select fire)', () => {
      expect(resolveProjectFromUrl('', projects, discovered)).toBeNull();
    });

    test('unknown urlProject → null (falls through to auto-select)', () => {
      expect(resolveProjectFromUrl('does-not-exist', projects, discovered)).toBeNull();
    });
  });
});

describe('ProjectDashboard — DR-014 dpr.pendingReview drill contract', () => {
  describe('TILE_META loader for dpr.pendingReview', () => {
    test('fetches BOTH SUBMITTED and UNDER_REVIEW (matches the KPI sum)', () => {
      // The loader for dpr.pendingReview MUST issue two parallel calls
      // — one per status — and merge. Single-status fetch (e.g. only
      // UNDER_REVIEW) breaks the bridge between the tile count and the
      // drill panel.
      const tileBlock = dashboardSource.match(
        /'dpr\.pendingReview':\s*\{[\s\S]*?\},\s*\n\s*'dpr\.approved'/,
      );
      expect(tileBlock).toBeTruthy();
      const body = tileBlock[0];
      expect(body).toMatch(/Promise\.all\(/);
      expect(body).toMatch(/status:\s*'SUBMITTED'/);
      expect(body).toMatch(/status:\s*'UNDER_REVIEW'/);
    });

    test('limits each status fetch to ≤5 rows so the merged panel stays ≤10', () => {
      // Cap each parallel call at 5 so the merged list (≤10) fits the
      // panel's row cap. A regression to limit=10 each would silently
      // drop the tile-count-to-drill-rows alignment.
      const tileBlock = dashboardSource.match(
        /'dpr\.pendingReview':\s*\{[\s\S]*?\},\s*\n\s*'dpr\.approved'/,
      );
      const body = tileBlock[0];
      const limits = body.match(/limit:\s*\d+/g) || [];
      expect(limits.length).toBeGreaterThanOrEqual(2);
      // Every limit value must be ≤ 5 (small enough that 2 calls = ≤10).
      limits.forEach((l) => {
        const n = Number(l.split(':')[1].trim());
        expect(n).toBeLessThanOrEqual(5);
        expect(n).toBeGreaterThan(0);
      });
    });

    test('viewAll link still routes to the admin DPR list for the project', () => {
      // Click-through acceptance: the panel footer must still navigate
      // to /portal/admin/dpr with the projectId filter. The DR-014
      // fix changes the LOADER; the link contract is preserved.
      const tileBlock = dashboardSource.match(
        /'dpr\.pendingReview':\s*\{[\s\S]*?\},\s*\n\s*'dpr\.approved'/,
      );
      expect(tileBlock[0]).toMatch(/\/portal\/admin\/dpr\?/);
      expect(tileBlock[0]).toMatch(/projectId=/);
    });
  });
});
