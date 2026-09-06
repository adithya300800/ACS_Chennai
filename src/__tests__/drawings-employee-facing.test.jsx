// N3-employee — Drawing Register employee-facing surface.
//
// Pins the source so the read-only employee browse + the matching
// sidebar entry can't silently regress to admin-only. Mirrors the
// mount-free PortalLayout.nav-groups.test.jsx pattern: source-text
// checks are deterministic and run in <1ms (mounting PortalLayout in
// the jest sandbox exhausts memory — see App.test.jsx header for the
// same constraint).
//
// [Round-30] Adds three new contracts for the picker:
//   - The page calls api.getProjects with scope: 'assigned' (the new
//     employee-narrowed scope, not the default ?scope=mine).
//   - The page imports + uses api.resolveProject for inline create.
//   - The page renders a <input type="search"> typeahead (replaced in
//     Round-32 by a real <select>; the typeahead-only contracts are
//     gone — see "Round-32: <select> dropdown contracts" below).
//
// [Round-32] Reverts the typeahead back to a <select> dropdown at the
// user's request — they found the typeahead hard to scan, and the
// picker only ever holds a small employee-scoped list. The new
// contracts pin:
//   - The page renders a <select id="drawings-browse-project"> (the
//     typeahead <input type="search"> is gone).
//   - The select contains a sentinel "+ Create new project…" option
//     that triggers an inline name input + Create/Cancel pair.
//   - The inline form submits via api.resolveProject(name, accessToken)
//     and adds the resolved project to the dropdown on success.
//   - The debounce + TDZ contracts from the typeahead are gone (no
//     query state, no debounced URL ?q=).

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

  // ── Round-30: picker scope + resolveProject contracts ─────────────────

  test('DrawingsBrowse calls api.getProjects with the assigned scope', () => {
    // The picker narrows to projects the employee has personally
    // touched or created via ?scope=assigned. Pin the call shape so
    // a future refactor can't silently drop the scope and regress
    // back to the org-wide default.
    expect(browseSrc).toMatch(
      /api\.getProjects\(\s*\{\s*scope:\s*['"]assigned['"]\s*\}\s*,\s*accessToken\s*\)/,
    );
  });

  test('DrawingsBrowse imports + uses api.resolveProject for the inline create-project form', () => {
    // The "+ Create new project…" affordance calls api.resolveProject
    // so an employee can spin up a fresh project on the spot without
    // bouncing to an admin. Pin both the import AND the call site.
    // Import: `api.resolveProject` is destructured from the api module.
    expect(browseSrc).toMatch(/resolveProject/);
    // Call site: handleCreateProject awaits api.resolveProject(name, accessToken).
    expect(browseSrc).toMatch(
      /api\.resolveProject\(\s*name\s*,\s*accessToken\s*\)/,
    );
  });

  // ── Round-32: <select> dropdown picker contracts ──────────────────────
  //
  // Replaces the round-30 typeahead. The new picker is a real <select>
  // because the assigned scope only ever holds a small handful of project
  // names — a typeahead was overkill. The "create new project" affordance
  // is a sentinel <option value="__create__"> that flips the picker into
  // an inline name input + Create/Cancel pair.

  test('DrawingsBrowse uses a <select> dropdown for the project picker (no typeahead)', () => {
    // The round-32 picker is a <select id="drawings-browse-project">.
    // The round-30 typeahead was an <input type="search"> with the same
    // id; pin both halves so a future refactor can't silently flip back.
    expect(browseSrc).toMatch(/<select[\s\S]{0,400}id=["']drawings-browse-project["']/);
    // The typeahead input must be gone (filter comments to avoid false
    // positives from the file-header paragraph that describes the
    // round-30 typeahead in past tense).
    const browseCodeOnly = browseSrc
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n');
    expect(browseCodeOnly).not.toMatch(/<input[\s\S]{0,200}id=["']drawings-browse-project["']/);
    expect(browseCodeOnly).not.toMatch(/type=["']search["']/);
  });

  test('DrawingsBrowse <select> has a + Create new project… sentinel option', () => {
    // The sentinel value="__create__" triggers the inline create-mode
    // form; pin both the value and the visible label so a future
    // refactor can't silently drop the affordance.
    expect(browseSrc).toMatch(/value=["']__create__["']/);
    expect(browseSrc).toMatch(/\+\s*Create new project/);
  });

  test('DrawingsBrowse inline create form: name input + Create + Cancel', () => {
    // createMode renders an inline name input + Create/Cancel pair.
    // Pin the affordance shapes:
    //   - the new-project-name input id,
    //   - the Enter key handler that fires handleCreateProject,
    //   - a Create button that calls handleCreateProject,
    //   - a Cancel button that flips createMode off.
    expect(browseSrc).toMatch(/id=["']drawings-browse-new-project["']/);
    expect(browseSrc).toMatch(/handleCreateProject\(\)/);
    expect(browseSrc).toMatch(/setCreateMode\(false\)/);
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
    //   - projects = projects (the curated list + any project the
    //     employee just created via handleCreateProject's
    //     setProjects([...prev, proj])). Passing a snapshot would lose
    //     the freshly-resolved project for the rest of the session.
    //   - initialProjectId = projectId (locks the dropdown to the URL
    //     ?projectId= so the engineer can't change it).
    //   - onSave = handleSave (the function that calls createDrawing +
    //     refreshes).
    expect(browseSrc).toMatch(/projects=\{projects\}/);
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

  // ── Round-32.1 bugfix contracts ───────────────────────────────────────
  //
  // Live user feedback: the dropdown was missing project names the
  // employee had filed DPRs against (because all of employee1's DPRs
  // use legacy projectName with projectId=NULL — they only live in
  // `data.discovered`, which the picker previously ignored), and a
  // project the employee had merely created (createdById) was leaking
  // in. Two paired contracts pin the fix:
  //   1. Dropdown merges `data.discovered` into the projects list so
  //      employee-filed DPR projectNames surface in the picker.
  //   2. Backend `?scope=assigned` excludes createdById-only matches
  //      (covered in backend/__tests__/project-scope-assigned.test.js
  //      round-32.1 suite).

  test('DrawingsBrowse merges data.discovered into the dropdown (auto-discovered DPR/Inspection names)', () => {
    // The earlier implementation only took `data.projects`. Pin the
    // merge — without it, every DPR a field engineer filed with the
    // legacy projectName string (no Project row) is silently missing
    // from their picker.
    expect(browseSrc).toMatch(/data\?\.discovered/);
    // Discovered entries are tagged with isRegistered: false so the
    // dropdown can render the "· not registered" suffix.
    expect(browseSrc).toMatch(/isRegistered:\s*false/);
    expect(browseSrc).toMatch(/isRegistered:\s*true/);
    // The dropdown renders the suffix on the discovered entries.
    expect(browseSrc).toMatch(/not\s*registered/);
    // Anti-regression: discovered <option>s must NOT be disabled.
    // Disabling them would block the user from picking a discovered
    // name to register it — defeating the whole point of the
    // __disc__:<name> sentinel flow. Earlier Round-32.1 shipped
    // `disabled={!p.id && !p.isRegistered}` which made them irrelevant;
    // the live check failed for that exact reason.
    expect(browseSrc).not.toMatch(/disabled=\{!p\.id\s*&&\s*!p\.isRegistered\}/);
  });

  test('DrawingsBrowse handles the __disc__:<name> sentinel for discovered entries', () => {
    // Picked value "__disc__:<name>" flips into create-mode with the
    // name pre-filled. Pin the sentinel shape + the prefill behavior
    // so a future refactor can't silently drop the registration flow.
    expect(browseSrc).toMatch(/__disc__:/);
    // The onChange handler must strip the sentinel prefix and seed
    // newProjectName with the bare name.
    expect(browseSrc).toMatch(/val\.startsWith\(\s*['"]__disc__:['"]\s*\)/);
    expect(browseSrc).toMatch(/setNewProjectName\(\s*name\s*\)/);
  });
});
