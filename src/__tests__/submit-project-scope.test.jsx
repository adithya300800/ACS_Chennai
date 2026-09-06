// R34 — DPR + Inspection submit forms must scope their project picker
// to projects the employee has actually touched (the `?scope=assigned`
// filter), and must expose a `+ Create new project…` sentinel + inline
// create form so the engineer can register a brand-new site name
// without dropping to a "submit and hope the backend auto-creates"
// round-trip.
//
// The submit forms sat on the legacy no-param path (`api.getProjects(
// accessToken)`) → backend defaulted to `?scope=mine` → returned every
// active project in the DB, leaking admin test rigs (NEW-TYPED-PROJECT-
// XYZ, R32-DROPDOWN-PROBE, RESOLVE-TEST-PROJECT-NEW) into every field
// engineer's dropdown. The `?scope=assigned` filter has existed since
// Round-30; R34 brings the two submit forms in line with My Projects
// (Round-31) and My Drawings (Round-30 + 32.1).
//
// Source-text checks (no mount) per the App.test.jsx header — mounting
// PortalLayout blows jest memory.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const dprSubmitPath = resolvePath(__dirname, '../pages/portal/DprSubmit.jsx');
const inspectionSubmitPath = resolvePath(__dirname, '../pages/portal/InspectionSubmit.jsx');
const dprSubmitSrc = readFileSync(dprSubmitPath, 'utf8');
const inspectionSubmitSrc = readFileSync(inspectionSubmitPath, 'utf8');

describe('R34 — DPR + Inspection submit form project picker', () => {
  describe('DprSubmit.jsx', () => {
    test('calls api.getProjects with the assigned scope (not the org-wide default)', () => {
      // The narrowing contract. Same shape as Projects.jsx + DrawingsBrowse
      // (Round-30 + 31): pass { scope: 'assigned' } as the FIRST arg and
      // accessToken as the SECOND. Pin both halves of the api wrapper
      // signature.
      expect(dprSubmitSrc).toMatch(
        /api\.getProjects\(\s*\{\s*scope:\s*['"]assigned['"]\s*\}\s*,\s*accessToken\s*\)/,
      );
    });

    test('does NOT use the legacy no-param form (regression guard)', () => {
      // Anti-regression: catches a future refactor that drops the scope
      // object — would silently regress to the org-wide curated list
      // (every active project in the DB, including admin test rigs).
      expect(dprSubmitSrc).not.toMatch(/api\.getProjects\(\s*accessToken\s*\)/);
    });

    test('merges data.discovered into the picker (auto-discovered DPR projectNames)', () => {
      // Discovered names only have `name` (no `id`). The merge is what
      // lets an employee pick a project that's only in the
      // `DPR.projectName` denormalized column — same pattern as
      // My Projects + My Drawings.
      expect(dprSubmitSrc).toMatch(/data\.discovered/);
      expect(dprSubmitSrc).toMatch(/isRegistered:\s*false/);
    });

    test('exposes the "+ Create new project…" sentinel option', () => {
      // Mirrors DrawingsBrowse.jsx (Round-32). The option must be
      // rendered inside the project <select> so a field engineer with
      // zero curated projects can still file a DPR against a brand-new
      // site name. The sentinel value is `__create__`; onChange branches
      // into create-mode.
      expect(dprSubmitSrc).toMatch(
        /<option\s+value=["']__create__["']>\s*\+\s*Create new project[^<]*<\/option>/,
      );
    });

    test('branches on `__create__` in handleProjectChange to enter create-mode', () => {
      // The onChange handler must explicitly handle the sentinel —
      // otherwise the user picks "+ Create new project…" and nothing
      // happens (the option is filtered out by the `projects.find(...)`
      // lookup).
      expect(dprSubmitSrc).toMatch(
        /if\s*\(\s*value\s*===\s*['"]__create__['"]\s*\)/,
      );
      expect(dprSubmitSrc).toMatch(/setCreateMode\(\s*true\s*\)/);
    });

    test('has a handleCreateProject that calls api.resolveProject(name, accessToken)', () => {
      // The Create button + Enter-on-name-input both call
      // handleCreateProject, which POSTs to /api/projects/resolve.
      // Same pattern as DrawingsBrowse.jsx#handleCreateProject.
      expect(dprSubmitSrc).toMatch(/api\.resolveProject\(\s*\w+\s*,\s*accessToken\s*\)/);
      // The function name is the contract — pin the shape.
      expect(dprSubmitSrc).toMatch(/handleCreateProject/);
    });

    test('renders the inline create-mode name input with id="dpr-new-project-name"', () => {
      // The input lives below the <select> in create-mode. id is the
      // contract — same pattern as `drawings-browse-new-project` so the
      // QA tooling can locate it without grep'ing CSS selectors.
      expect(dprSubmitSrc).toMatch(/id=["']dpr-new-project-name["']/);
    });

    test('shows the create-mode sentinel as the current value when createMode is true', () => {
      // `value={createMode ? '__create__' : ...}` so the user sees the
      // sentinel option highlighted while they're in create-mode (rather
      // than the select silently snapping back to "" or the previous
      // selection).
      expect(dprSubmitSrc).toMatch(/value=\{createMode\s*\?\s*['"]__create__['"]\s*:/);
    });
  });

  describe('InspectionSubmit.jsx', () => {
    test('calls api.getProjects with the assigned scope (not the org-wide default)', () => {
      expect(inspectionSubmitSrc).toMatch(
        /api\.getProjects\(\s*\{\s*scope:\s*['"]assigned['"]\s*\}\s*,\s*accessToken\s*\)/,
      );
    });

    test('does NOT use the legacy no-param form (regression guard)', () => {
      expect(inspectionSubmitSrc).not.toMatch(/api\.getProjects\(\s*accessToken\s*\)/);
    });

    test('merges data.discovered into the picker', () => {
      expect(inspectionSubmitSrc).toMatch(/data\.discovered/);
      expect(inspectionSubmitSrc).toMatch(/isRegistered:\s*false/);
    });

    test('exposes the "+ Create new project…" sentinel option', () => {
      expect(inspectionSubmitSrc).toMatch(
        /<option\s+value=["']__create__["']>\s*\+\s*Create new project[^<]*<\/option>/,
      );
    });

    test('branches on `__create__` in handleProjectChange to enter create-mode', () => {
      expect(inspectionSubmitSrc).toMatch(
        /if\s*\(\s*value\s*===\s*['"]__create__['"]\s*\)/,
      );
      expect(inspectionSubmitSrc).toMatch(/setCreateMode\(\s*true\s*\)/);
    });

    test('has a handleCreateProject that calls api.resolveProject(name, accessToken)', () => {
      expect(inspectionSubmitSrc).toMatch(/api\.resolveProject\(\s*\w+\s*,\s*accessToken\s*\)/);
      expect(inspectionSubmitSrc).toMatch(/handleCreateProject/);
    });

    test('renders the inline create-mode name input with id="inspection-new-project-name"', () => {
      // Different id prefix from DPR — keeps the QA + e2e selectors
      // unambiguous when both forms are tested in the same session.
      expect(inspectionSubmitSrc).toMatch(/id=["']inspection-new-project-name["']/);
    });

    test('shows the create-mode sentinel as the current value when createMode is true', () => {
      expect(inspectionSubmitSrc).toMatch(/value=\{createMode\s*\?\s*['"]__create__['"]\s*:/);
    });
  });

  describe('Cross-form regression guards', () => {
    test('both forms handle the legacy PROJECT_INACTIVE 409 with a friendly message', () => {
      // Backend returns 409 PROJECT_INACTIVE when the typed name matches
      // an archived project. Mirror DrawingsBrowse: surface a clear
      // "ask an admin to reactivate" message instead of a raw error.
      expect(dprSubmitSrc).toMatch(/PROJECT_INACTIVE/);
      expect(inspectionSubmitSrc).toMatch(/PROJECT_INACTIVE/);
      expect(dprSubmitSrc).toMatch(/archived/i);
      expect(inspectionSubmitSrc).toMatch(/archived/i);
    });

    test('both forms implement Escape-to-cancel on the create-mode name input', () => {
      // Keyboard contract — pressing Escape in the new-project name
      // input dismisses create-mode without submitting. Same pattern
      // as DrawingsBrowse.
      expect(dprSubmitSrc).toMatch(/e\.key\s*===\s*['"]Escape['"]/);
      expect(inspectionSubmitSrc).toMatch(/e\.key\s*===\s*['"]Escape['"]/);
    });

    test('both forms wire Enter-on-name-input to handleCreateProject', () => {
      // Keyboard contract — pressing Enter in the name input calls
      // handleCreateProject without losing focus to the form's default
      // submit behavior.
      expect(dprSubmitSrc).toMatch(/e\.key\s*===\s*['"]Enter['"]/);
      expect(inspectionSubmitSrc).toMatch(/e\.key\s*===\s*['"]Enter['"]/);
    });
  });
});
