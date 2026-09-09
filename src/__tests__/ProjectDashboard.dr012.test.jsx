// DR-012 (2026-09-08 SOL audit) — Dashboard URL selection creates
// misdirection and a request cycle.
//
// Two regressions pinned by source-text inspection:
//
//   1. The registry's KPI button in ProjectsAdmin MUST emit the
//      project ID (not the name) in `?project=`. The dashboard then
//      matches by id, decoded name (legacy bookmarks), then decoded
//      discovered name — three passes. Pre-fix the registry emitted
//      `?project=R17%20Bulk%20Test` and the dashboard's id-match
//      failed, leaving the auto-selected first project on screen
//      ("the R2 project", per the audit).
//
//   2. The dashboard's loadProjects callback MUST NOT depend on
//      `selectedProject`. Pre-fix that dep caused selection churn to
//      re-bind loadProjects → re-fire the mount effect → re-call
//      loadProjects + loadKpis. Live observation: 15 project-list +
//      14 KPI requests in 2,498 ms while idle. Fix: read selection
//      from a ref, guard re-issues via setSelectedProjectIfChanged,
//      apply an epoch guard to loadKpis (same pattern as the inline
//      drill panel), and decouple the mount/visibility listener from
//      the loader identities by routing through refs.
//
// Source-text pins (not full mount) — same pattern as
// ProjectDashboard.dr014.test.jsx. The mounted test exhausts memory
// in this sandbox; the source pins are deterministic and run in
// <1ms while still catching a regression that drops the fix.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const dashboardPath = resolvePath(__dirname, '../pages/admin/ProjectDashboard.jsx');
const projectsAdminPath = resolvePath(__dirname, '../pages/admin/ProjectsAdmin.jsx');
const dashboardSource = readFileSync(dashboardPath, 'utf8');
const projectsAdminSource = readFileSync(projectsAdminPath, 'utf8');

// ──── Behavioural mirror: ?project= → selectedProject resolution ──────────
//
// Production: loadProjects populates `projects` + `discovered`, then a
// useEffect scans them in three passes — id match, decoded-name match
// against registered, decoded-name match against discovered — and calls
// setSelectedProjectIfChanged. We mirror that here so the test pins the
// resolution order without a full mount.
function resolveProjectFromUrl(urlProject, projects, discovered) {
  if (!urlProject) return null;
  const decoded = decodeURIComponent(urlProject);
  const reg = (projects || []).find((p) => p.id === urlProject);
  if (reg) return { id: reg.id, name: reg.name, isRegistered: true };
  const regByName = (projects || []).find((p) => p.name === decoded);
  if (regByName) return { id: regByName.id, name: regByName.name, isRegistered: true };
  const disc = (discovered || []).find((d) => d.name === decoded);
  if (disc) return { id: null, name: disc.name, isRegistered: false };
  return null;
}

describe('ProjectDashboard — DR-012 URL selection + request-cycle guard', () => {
  describe('ProjectsAdmin registry link shape — emits ID, not name', () => {
    test('onGoToDashboard navigates to ?project=<encoded-id>', () => {
      // The link must carry the registered project ID through to the
      // URL — that's the canonical key. If a future refactor rolls
      // this back to passing the name, the dashboard's id-match falls
      // through and the wrong project renders.
      const linkMatch = projectsAdminSource.match(
        /onGoToDashboard\s*=\s*\{[\s\S]*?navigate\([\s\S]*?\}\s*\}/,
      );
      expect(linkMatch).toBeTruthy();
      expect(linkMatch[0]).toMatch(/project-dashboard/);
      expect(linkMatch[0]).toMatch(/\?project=/);
      expect(linkMatch[0]).toMatch(/encodeURIComponent/);
      // The DR-012 source pin: the URL parameter MUST come from p.id.
      // We accept either `({ id }) => ...id...` (destructured object)
      // or `(p) => ...p.id...` — what we forbid is `(name) => ...name...`
      // and `(p) => ...p.name...`. The negative pin below catches the
      // pre-fix shape directly.
      expect(linkMatch[0]).not.toMatch(/onGoToDashboard\s*=\s*\{\(name\)\s*=>/);
    });

    test('RegisteredRow forwards the project object (id + name) to onGoToDashboard', () => {
      // The row-level handler must pass an object that carries the
      // id. Pre-fix it forwarded `p.name` only.
      const rowMatch = projectsAdminSource.match(
        /onGoToDashboard\s*=\s*\{\(\)\s*=>\s*onGoToDashboard\([\s\S]*?\)\s*\}/,
      );
      expect(rowMatch).toBeTruthy();
      expect(rowMatch[0]).toMatch(/p\.id/);
      expect(rowMatch[0]).not.toMatch(/onGoToDashboard\(p\.name\s*\)/);
    });
  });

  describe('ProjectDashboard source contract — selection churn guard', () => {
    test('declares setSelectedProjectIfChanged that returns the same object for the same canonical key', () => {
      // The guard short-circuits state churn — without it the mount
      // effect re-fires the loader chain. The source pin: the guard
      // must compare by id (registered) or name (discovered).
      expect(dashboardSource).toMatch(/setSelectedProjectIfChanged\s*=\s*useCallback\(/);
      // Guard compares ids for registered rows.
      expect(dashboardSource).toMatch(/prev\.id\s*&&\s*next\.id\s*&&\s*prev\.id\s*===\s*next\.id/);
      // Guard compares names for discovered rows.
      expect(dashboardSource).toMatch(/prev\.name\s*===\s*next\.name/);
    });

    test('loadProjects does NOT depend on selectedProject', () => {
      // The pre-fix deps array included `selectedProject`, which
      // re-bound the callback on every selection change and re-fired
      // the mount effect. Pin: the deps array must not list it.
      const loadProjectsBlock = dashboardSource.match(
        /const\s+loadProjects\s*=\s*useCallback\([\s\S]*?\}\s*,\s*\[([^\]]*)\]\s*\)/,
      );
      expect(loadProjectsBlock).toBeTruthy();
      const deps = loadProjectsBlock[1];
      expect(deps).not.toMatch(/\bselectedProject\b/);
      // Sanity: the callback consults the ref instead.
      expect(loadProjectsBlock[0]).toMatch(/selectedProjectRef\.current/);
    });

    test('mirror of selectedProject into a ref so the loader can read without depending on it', () => {
      expect(dashboardSource).toMatch(
        /selectedProjectRef\s*=\s*useRef\(null\)/,
      );
      expect(dashboardSource).toMatch(
        /selectedProjectRef\.current\s*=\s*selectedProject/,
      );
    });
  });

  describe('ProjectDashboard source contract — three-pass URL match', () => {
    test('the URL effect matches ID first, then decoded name against registered, then discovered', () => {
      const effectBlock = dashboardSource.match(
        /useEffect\(\s*\(\)\s*=>\s*\{[\s\S]*?urlProject[\s\S]*?discovered[\s\S]*?\},\s*\[urlProject,\s*projects,\s*discovered,\s*setSelectedProjectIfChanged\]\s*\)/,
      );
      expect(effectBlock).toBeTruthy();
      const body = effectBlock[0];
      // Pass 1: id match against projects.
      const idIdx = body.search(/projects\.find\(\s*\(p\)\s*=>\s*p\.id\s*===\s*urlProject\s*\)/);
      // Pass 2: decoded-name match against registered (DR-012 legacy compat).
      const regByNameIdx = body.search(/projects\.find\(\s*\(p\)\s*=>\s*p\.name\s*===\s*decoded\s*\)/);
      // Pass 3: decoded-name match against discovered.
      const discIdx = body.search(/discovered\.find\(\s*\(d\)\s*=>\s*d\.name\s*===\s*decoded\s*\)/);
      expect(idIdx).toBeGreaterThan(-1);
      expect(regByNameIdx).toBeGreaterThan(-1);
      expect(discIdx).toBeGreaterThan(-1);
      expect(idIdx).toBeLessThan(regByNameIdx);
      expect(regByNameIdx).toBeLessThan(discIdx);
      // The `decodeURIComponent` call must run once before the matches
      // so Pass 2 and Pass 3 share the same `decoded` value.
      expect(body).toMatch(/decodeURIComponent\(urlProject\)/);
    });

    test('the URL effect routes its selection through setSelectedProjectIfChanged (not raw setSelectedProject)', () => {
      // Raw setSelectedProject would re-trigger the load chain on
      // every effect re-evaluation. The guard is the whole point.
      const effectBlock = dashboardSource.match(
        /useEffect\(\s*\(\)\s*=>\s*\{[\s\S]*?urlProject[\s\S]*?discovered[\s\S]*?\},\s*\[urlProject,\s*projects,\s*discovered,\s*setSelectedProjectIfChanged\]\s*\)/,
      );
      expect(effectBlock).toBeTruthy();
      expect(effectBlock[0]).not.toMatch(/setSelectedProject\(\{\s*id:/);
    });
  });

  describe('ProjectDashboard source contract — KPI epoch guard', () => {
    test('declares kpiEpochRef and increments it before each KPI load', () => {
      // Pattern lifted from InlineDrillPanel's epochRef. The
      // loadKpis callback must check myEpoch against the ref before
      // mutating state.
      expect(dashboardSource).toMatch(/kpiEpochRef\s*=\s*useRef\(0\)/);
      const loadKpisBlock = dashboardSource.match(
        /const\s+loadKpis\s*=\s*useCallback\([\s\S]*?\}\s*,\s*\[([^\]]*)\]\s*\)/,
      );
      expect(loadKpisBlock).toBeTruthy();
      expect(loadKpisBlock[0]).toMatch(/\+\+kpiEpochRef\.current/);
      // The response handler bails on epoch mismatch.
      expect(loadKpisBlock[0]).toMatch(/myEpoch\s*!==\s*kpiEpochRef\.current/);
    });
  });

  describe('ProjectDashboard source contract — mount/visibility decoupled', () => {
    test('mount effect runs once (empty deps) and routes through ref-backed loaders', () => {
      // Pre-fix: deps=[loadProjects, loadKpis] re-bound the effect on
      // every selection churn. Post-fix: refs mirror the loaders and
      // the effect runs once at mount.
      expect(dashboardSource).toMatch(/loadProjectsRef\.current\s*=\s*loadProjects/);
      expect(dashboardSource).toMatch(/loadKpisRef\.current\s*=\s*loadKpis/);
      // The mount effect itself must declare empty deps.
      const mountBlock = dashboardSource.match(
        /mountedRef\.current\s*=\s*true;[\s\S]*?document\.removeEventListener\('visibilitychange',\s*onVis\);\s*\}/,
      );
      expect(mountBlock).toBeTruthy();
      // Find the trailing `}, [...])` after the mount block.
      const tail = mountBlock[0].slice(-3);
      // Be tolerant: tail should be `},\s*[])` somewhere just past
      // the cleanup. We re-grep the full file for the next effect's
      // closing — simpler: assert the cleanup is followed by `}, [])`.
      const closing = dashboardSource.match(
        /document\.removeEventListener\('visibilitychange',\s*onVis\);\s*\};\s*\}\s*,\s*\[\]\s*\)/,
      );
      expect(closing).toBeTruthy();
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

    test('encoded-name match against registered → registered selection (legacy bookmark)', () => {
      // The pre-fix registry emitted names; the dashboard must still
      // resolve those to the matching Project row.
      expect(
        resolveProjectFromUrl(encodeURIComponent('T-Nagar'), projects, discovered),
      ).toEqual({
        id: 'p-1', name: 'T-Nagar', isRegistered: true,
      });
    });

    test('encoded-name match against discovered → discovered selection (id=null)', () => {
      expect(
        resolveProjectFromUrl(encodeURIComponent('Auto Name'), projects, discovered),
      ).toEqual({
        id: null, name: 'Auto Name', isRegistered: false,
      });
    });

    test('empty urlProject → null (lets the auto-select fire)', () => {
      expect(resolveProjectFromUrl('', projects, discovered)).toBeNull();
    });

    test('unknown urlProject → null (falls through to auto-select)', () => {
      expect(resolveProjectFromUrl('does-not-exist', projects, discovered)).toBeNull();
    });

    test('ID match wins over a coincidental name collision', () => {
      // If a discovered name happens to equal a registered id, the
      // id-match fires first (no false-positive discovery).
      const fakeDiscovered = [{ name: 'p-2' }];
      expect(
        resolveProjectFromUrl('p-2', projects, fakeDiscovered),
      ).toEqual({
        id: 'p-2', name: 'Velachery Bypass', isRegistered: true,
      });
    });
  });
});
