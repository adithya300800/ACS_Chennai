// Round-31 — My Projects (employee-facing) must scope the curated
// project list to projects the employee has personally touched or
// created, NOT the org-wide curated list.
//
// The My Projects page sat on the legacy no-param path → backend
// defaulted to `?scope=mine` → returned every active project in the
// DB. The backend `?scope=assigned` filter was built in Round-30
// (commit 94b0235) but only DrawingsBrowse adopted it. This test
// pins the Projects.jsx call shape so a future refactor can't silently
// regress the employee-facing page back to the org-wide default.
//
// Source-text checks (no mount) per the App.test.jsx header — mounting
// PortalLayout blows jest memory.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const projectsPath = resolvePath(__dirname, '../pages/portal/Projects.jsx');
const projectsSrc = readFileSync(projectsPath, 'utf8');

describe('Round-31 — My Projects (employee-facing) project scope', () => {
  test('Projects.jsx calls api.getProjects with the assigned scope (not the org-wide default)', () => {
    // The narrowing contract. The page must pass { scope: 'assigned' } as
    // the FIRST arg AND accessToken as the SECOND — the api wrapper's
    // signature is (params, token). Pin both halves.
    expect(projectsSrc).toMatch(
      /api\.getProjects\(\s*\{\s*scope:\s*['"]assigned['"]\s*\}\s*,\s*accessToken\s*\)/,
    );
  });

  test('Projects.jsx does NOT use the legacy no-param form (regression guard)', () => {
    // Anti-regression: catches a future refactor that drops the scope
    // object — would silently regress to the org-wide curated list.
    // Match `api.getProjects(accessToken)` with the token as the first
    // and only argument. The fix's call site must include `{ scope:`.
    expect(projectsSrc).not.toMatch(/api\.getProjects\(\s*accessToken\s*\)/);
  });

  test('Projects.jsx is mounted on /portal/projects (regression guard)', () => {
    // The route must remain under the employee PortalLayout group, not
    // the admin group. Sanity check that no one moved the file path
    // during the round-31 narrowing.
    const appSrc = readFileSync(resolvePath(__dirname, '../App.jsx'), 'utf8');
    expect(appSrc).toMatch(/path=["']projects["']/);
    expect(appSrc).toMatch(/path=["']projects\/:id["']/);
  });

  test('Projects.jsx merges the curated + discovered lists without a client-side archive filter (DR-012 contract)', () => {
    // The DR-012 archive-rediscover fix lives entirely server-side
    // (backend/src/routes/projects.js filters discovered names against
    // archived Project rows before returning). The frontend merges
    // curated + discovered from the response and trusts the server's
    // filter — pinning that here means a future "let me filter
    // archived on the client" PR can't silently double-filter or skip
    // the server's response.
    expect(projectsSrc).toMatch(/data\.projects/);
    expect(projectsSrc).toMatch(/data\.discovered/);
    // The merge happens by concatenation of the two server-provided
    // arrays; there is no extra predicate against `isActive` on the
    // discovered side (the server already does that).
    expect(projectsSrc).not.toMatch(/discovered\.filter\([^)]*isActive[^)]*\)/);
  });
});
