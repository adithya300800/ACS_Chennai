// N3-employee — Drawing Register employee-facing surface.
//
// Pins the source so the read-only employee browse + the matching
// sidebar entry can't silently regress to admin-only. Mirrors the
// mount-free PortalLayout.nav-groups.test.jsx pattern: source-text
// checks are deterministic and run in <1ms (mounting PortalLayout in
// the jest sandbox exhausts memory — see App.test.jsx header for the
// same constraint).

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
});
