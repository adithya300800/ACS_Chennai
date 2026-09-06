// N3-employee — Drawing Register employee-facing surface.
//
// Pins the source so the read-only employee browse + the matching
// sidebar entry can't silently regress to admin-only. Mirrors the
// mount-free PortalLayout.nav-groups.test.jsx pattern: source-text
// checks are deterministic and run in <1ms (mounting PortalLayout in
// the jest sandbox exhausts memory — see App.test.jsx header for the
// same constraint).
//
// [Round-30] Adds three new contracts for the typeahead picker:
//   - The page calls api.getProjects with scope: 'assigned' (the new
//     employee-narrowed scope, not the default ?scope=mine).
//   - The page imports + uses api.resolveProject so an employee can
//     type a fresh name and have it created.
//   - The page renders a <input type="search"> typeahead, NOT a
//     static <select>. The old <select id="drawings-browse-project">
//     is gone.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const layoutPath = resolvePath(__dirname, '../components/PortalLayout.jsx');
const appPath = resolvePath(__dirname, '../App.jsx');
const browsePath = resolvePath(__dirname, '../pages/portal/DrawingsBrowse.jsx');
const detailPath = resolvePath(__dirname, '../pages/portal/DrawingBrowseDetail.jsx');
const layoutSrc = readFileSync(layoutPath, 'utf8');
const appSrc = readFileSync(appPath, 'utf8');
const browseSrc = readFileSync(browsePath, 'utf8');
const detailSrc = readFileSync(detailPath, 'utf8');

describe('N3-employee — Drawing Register employee-facing surface', () => {
  test('PortalLayout has a "My Drawings" entry in the shared (employee-visible) My Reports group', () => {
    // The entry must live OUTSIDE the admin-only `...(employee?.isAdmin ? [...])`
    // block — employees need to see it. Sits under the "My Reports"
    // section label like DprList / InspectionList do.
    expect(layoutSrc).toMatch(/label:\s*['"]My Drawings['"]/);
    expect(layoutSrc).toMatch(/to:\s*['"]\/portal\/drawings['"]/);
  });

  test('"My Drawings" entry appears in the same source block as the "My Reports" label', () => {
    // Anti-regression: catches a future refactor that moves the entry
    // out of the shared group (e.g. into the admin-only block).
    expect(layoutSrc).toMatch(
      /label:\s*['"]My Reports['"][\s\S]{0,2500}label:\s*['"]My Drawings['"]/,
    );
  });

  test('App.jsx registers the employee drawing list + detail routes (literal-before-param)', () => {
    // Both routes must exist AND the literal /drawings path must come
    // before the param /drawings/:id (round-20 lesson, same as the
    // /admin/drawings pair and /projects pair).
    expect(appSrc).toMatch(/path="drawings"/);
    expect(appSrc).toMatch(/path="drawings\/:id"/);
    // Source-order check — grep the index of each match.
    const litIdx = appSrc.search(/path="drawings"/);
    const paramIdx = appSrc.search(/path="drawings\/:id"/);
    expect(litIdx).toBeGreaterThan(0);
    expect(paramIdx).toBeGreaterThan(litIdx);
  });

  test('DrawingsBrowse locks the status filter to ACTIVE (no admin curation controls)', () => {
    // The employee list is ACTIVE-only by design. The page should NOT
    // accept a status filter from the user and should NOT include the
    // "+ New drawing" or per-card "Supersede"/"Archive" affordances
    // that DrawingsAdmin has.
    expect(browseSrc).toMatch(/status:\s*['"]ACTIVE['"]/);
    // Strip line comments before checking for the curation strings —
    // the employee page's own header comment enumerates the admin
    // features it deliberately omits, which would otherwise trip the
    // negative matcher.
    const browseCodeOnly = browseSrc
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n');
    expect(browseCodeOnly).not.toMatch(/\+\s*New drawing/);
    expect(browseCodeOnly).not.toMatch(/Supersede/);
    expect(browseCodeOnly).not.toMatch(/Archive/);
  });

  test('DrawingBrowseDetail does not render the admin DrawingFormModal or any curation actions', () => {
    // Read-only — no modal imports, no Edit/Supersede/Archive text
    // (the file's own comment header enumerates these by name to
    // document what was removed, so we filter comment lines first).
    const detailCodeOnly = detailSrc
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n');
    expect(detailCodeOnly).not.toMatch(/DrawingFormModal/);
    expect(detailCodeOnly).not.toMatch(/>\s*Edit\s*</);
    expect(detailCodeOnly).not.toMatch(/>\s*Supersede\s*</);
    expect(detailCodeOnly).not.toMatch(/>\s*Archive\s*</);
  });

  // ── Round-30: typeahead picker contracts ──────────────────────────────

  test('DrawingsBrowse uses a <input type="search"> typeahead, NOT a static <select>', () => {
    // The previous picker was a <select id="drawings-browse-project">;
    // round-30 replaced it with a typeahead input. Pin both shapes:
    //   1. The new <input type="search"> with id="drawings-browse-project"
    //      is present.
    //   2. The old <select> tag is gone (filter comments to avoid
    //      header-comment false positives).
    expect(browseSrc).toMatch(/<input[\s\S]{0,200}id=["']drawings-browse-project["']/);
    expect(browseSrc).toMatch(/type=["']search["']/);
    const browseCodeOnly = browseSrc
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n');
    expect(browseCodeOnly).not.toMatch(/<select/);
  });

  test('DrawingsBrowse calls api.getProjects with the assigned scope', () => {
    // The picker narrows to projects the employee has personally
    // touched or created via ?scope=assigned. Pin the call shape so
    // a future refactor can't silently drop the scope and regress
    // back to the org-wide default.
    expect(browseSrc).toMatch(
      /api\.getProjects\(\s*\{\s*scope:\s*['"]assigned['"]\s*\}\s*,\s*accessToken\s*\)/,
    );
  });

  test('DrawingsBrowse imports + uses api.resolveProject for typed-name resolution', () => {
    // The typeahead lets an employee type a project name that doesn't
    // exist yet and have it created via POST /api/projects/resolve.
    // Pin both the import AND the call site.
    // Import: `api.resolveProject` is destructured from the api module.
    expect(browseSrc).toMatch(/resolveProject/);
    // Call site: handleResolveTyped awaits api.resolveProject(name, accessToken).
    expect(browseSrc).toMatch(
      /api\.resolveProject\(\s*name\s*,\s*accessToken\s*\)/,
    );
  });

  test('DrawingsBrowse debounces the typed query into the URL (?q=)', () => {
    // The user requested shareable typeahead state — pin the debounce
    // + URL-sync code so a future refactor doesn't accidentally drop it.
    expect(browseSrc).toMatch(/sp\.set\(\s*['"]q['"]\s*,\s*query\s*\)/);
    // The 200ms timeout is hard-coded in the implementation; pin the
    // literal so silent drift doesn't accumulate.
    expect(browseSrc).toMatch(/,\s*200\s*\)/);
  });

  test('DrawingsBrowse declares `filtered` BEFORE the keyboard handler (TDZ guard)', () => {
    // Regression guard for the round-30 TDZ crash. The
    // handleQueryKeyDown useCallback had `filtered` in its dependency
    // array, but `filtered` was declared further down the function body.
    // useCallback evaluates its dep array at call time → "Cannot access
    // 'filtered' before initialization" → ErrorBoundary on Render.
    // The fix hoists the `const filtered = ...` line above the handler.
    const filteredIdx = browseSrc.search(/const\s+filtered\s*=/);
    const keyDownIdx = browseSrc.search(/handleQueryKeyDown\s*=\s*useCallback/);
    expect(filteredIdx).toBeGreaterThan(0);
    expect(keyDownIdx).toBeGreaterThan(0);
    expect(filteredIdx).toBeLessThan(keyDownIdx);
  });

  // ── Round-31: "+ Add drawing" UX contracts ────────────────────────────
  //
  // Round-31 wires POST /api/drawings (now requireAuth) into the
  // employee browse page via a header button + an empty-state CTA +
  // a DrawingFormModal mount. The CTA is disabled when no project is
  // picked; the modal's project dropdown is pre-filled + locked to the
  // URL ?projectId= so the engineer can't upload against a different
  // project. handleSave calls api.createDrawing + refreshes the grid.

  test('DrawingsBrowse imports DrawingFormModal (Round-31 + Add drawing CTA)', () => {
    // The modal is the only way an employee can register a new drawing
    // revision without leaving the page. Pin the import so a tree-shake
    // accident or a wrong-path refactor doesn't silently break the
    // employee upload flow.
    expect(browseSrc).toMatch(/import\s+DrawingFormModal\s+from\s+['"]\.\.\/\.\.\/components\/DrawingFormModal\.jsx['"]/);
  });

  test('DrawingsBrowse renders a `+ Add drawing` button with the correct a11y + disabled-when-no-project shape', () => {
    // Two renders of the same button (header + empty state), each must:
    //   - carry aria-label="Add drawing" for screen readers
    //   - be disabled when !projectId OR creating
    // The `disabled={!projectId || creating}` shape is what keeps the
    // button from being clickable before a project is picked — the
    // modal pre-fills the project from the URL, so opening it with no
    // project would render a form with an empty locked dropdown.
    expect(browseSrc).toMatch(/aria-label=["']Add drawing["']/);
    expect(browseSrc).toMatch(/disabled=\{!projectId\s*\|\|\s*creating\}/);
    // Title attribute is the cheap-and-cheerful hover hint that explains
    // why the button is disabled.
    expect(browseSrc).toMatch(/Pick a project first/);
  });

  test('DrawingsBrowse mounts DrawingFormModal with the correct props (projects + initialProjectId + onSave)', () => {
    // The modal must receive:
    //   - projects = allProjects (the merged list — curated + extra from
    //     resolveProject). Passing projects=projects would lose the
    //     freshly-resolved project for the rest of the session.
    //   - initialProjectId = projectId (locks the dropdown to the URL
    //     ?projectId= so the engineer can't change it).
    //   - onSave = handleSave (the function that calls createDrawing +
    //     refreshes).
    expect(browseSrc).toMatch(/projects=\{allProjects\}/);
    expect(browseSrc).toMatch(/initialProjectId=\{projectId\}/);
    expect(browseSrc).toMatch(/onSave=\{handleSave\}/);
  });

  test('DrawingsBrowse handleSave calls api.createDrawing and refreshes the grid (no full page reload)', () => {
    // The Round-30 handler refresh pattern was a `setLoading(true)` +
    // re-fetch. Pin both halves of the new handleSave so a future
    // refactor doesn't accidentally drop the auto-refresh — leaving the
    // user on a stale grid where their new drawing doesn't show until
    // they manually refresh.
    expect(browseSrc).toMatch(/api\.createDrawing\(\s*payload\s*,\s*accessToken\s*\)/);
    expect(browseSrc).toMatch(/await\s+fetchDrawings\(\)/);
    // The success toast — "Drawing added." — is the one clear signal the
    // user gets; without it the modal closing is easy to miss.
    expect(browseSrc).toMatch(/toast\.push\(\s*['"]Drawing added\.[^'"]*['"]\s*,\s*['"]success['"]\s*\)/);
  });
});
