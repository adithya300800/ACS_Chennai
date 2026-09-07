// R37.1 — Employee "My Certifications" — frontend source-text contracts.
//
// Mirrors the R37 admin-page test pattern (mount-free, source-text
// pin). Pins the wire surface between:
//   - backend/src/routes/billingCertifications.js (RBAC split + ?scope=assigned)
//   - src/lib/api.js (re-used getBillingCertifications helper)
//   - src/pages/portal/MyCertifications.jsx (this page)
//   - src/App.jsx (the /portal/certifications route)
//   - src/components/PortalLayout.jsx (the My Reports group entry)
//
// Coverage matrix:
//   page (src/pages/portal/MyCertifications.jsx)
//     1. passes scope=assigned on every list call
//     2. consumes getBillingCertifications + getBillingCertification +
//        getBillingCertificationReadSas (read-only surface)
//     3. does NOT consume any write helper (create / patch / delete /
//        certify / dispute) — employee is read-only
//     4. consumes the same status-enum constants as the admin page
//   PortalLayout sidebar
//     5. My Reports nav contains the My Certifications entry
//     6. My Certifications entry is NOT gated by isAdmin (visible to
//        every employee) and reuses the admin-side BILLING_ICON
//   App.jsx route
//     7. App.jsx lazy-imports MyCertifications.jsx
//     8. App.jsx mounts <Route path="certifications" />

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const apiPath = resolvePath(__dirname, '../lib/api.js');
const pagePath = resolvePath(__dirname, '../pages/portal/MyCertifications.jsx');
const layoutPath = resolvePath(__dirname, '../components/PortalLayout.jsx');
const appPath = resolvePath(__dirname, '../App.jsx');

const apiSrc = readFileSync(apiPath, 'utf8');
const pageSrc = readFileSync(pagePath, 'utf8');
const layoutSrc = readFileSync(layoutPath, 'utf8');
const appSrc = readFileSync(appPath, 'utf8');

describe('R37.1 — My Certifications: api helper (src/lib/api.js)', () => {
  test('1. exports getBillingCertifications so the employee view can pass scope=assigned', () => {
    // The admin page already calls getBillingCertifications — the
    // employee view re-uses the same helper, just with scope=assigned
    // baked into the params object. Pin both ends here so a future
    // refactor can't silently drop the `params` argument.
    expect(apiSrc).toMatch(/getBillingCertifications\s*:\s*\(\s*params\s*=\s*\{\}\s*,\s*token\s*\)\s*=>/);
    expect(apiSrc).toMatch(/api\.get\(\s*`\/billing-certifications\$\{[^}]*\}\s*`/);
  });
});

describe('R37.1 — My Certifications: page (src/pages/portal/MyCertifications.jsx)', () => {
  test('2. passes scope=assigned on every list call (the core R37.1 contract)', () => {
    // The whole point of R37.1 is that the employee view never sees
    // COPs against projects they have no context on. The backend's
    // getAssignedProjectIds() helper narrows the response set when
    // ?scope=assigned is present. Pin that the page sends it on every
    // load — both the initial fetch and the "Load more" cursor fetch
    // share the same buildListParams() helper, so a single regex is
    // enough.
    expect(pageSrc).toMatch(/scope:\s*['"]assigned['"]/);
  });

  test('3. consumes the read-only api surface (list + detail + read-sas)', () => {
    expect(pageSrc).toMatch(/api\.getBillingCertifications\(/);
    expect(pageSrc).toMatch(/api\.getBillingCertification\(/);
    expect(pageSrc).toMatch(/api\.getBillingCertificationReadSas\(/);
  });

  test('4. does NOT consume any write helper (employee is read-only)', () => {
    // The five admin write endpoints — POST / PATCH / DELETE /
    // certify / dispute — must never appear in this file. A typo
    // would surface here as a test failure before the SPA ships a
    // broken "Mark Certified" button that 403s on click.
    expect(pageSrc).not.toMatch(/api\.createBillingCertification\(/);
    expect(pageSrc).not.toMatch(/api\.updateBillingCertification\(/);
    expect(pageSrc).not.toMatch(/api\.deleteBillingCertification\(/);
    expect(pageSrc).not.toMatch(/api\.certifyBillingCertification\(/);
    expect(pageSrc).not.toMatch(/api\.disputeBillingCertification\(/);
  });

  test('5. consumes the same status-enum constants as the admin page', () => {
    // The status pill palette + label map is the single source of
    // truth in src/lib/constants.js. Re-using it keeps the two pages
    // pixel-identical aside from the action buttons.
    expect(pageSrc).toMatch(/BILLING_CERTIFICATION_STATUSES/);
    expect(pageSrc).toMatch(/BILLING_CERTIFICATION_STATUS_LABELS/);
  });

  test('6. handles the 404-not-found case for detail (out-of-scope guard)', () => {
    // The backend returns 404 for an employee requesting a COP against
    // a project they're not assigned to. The page must NOT crash on
    // that status — surface a friendly "no longer available" message
    // instead. The string match is loose so the message copy can be
    // tweaked without rewriting this test.
    expect(pageSrc).toMatch(/no longer available/i);
  });
});

describe('R37.1 — My Certifications: PortalLayout sidebar entry', () => {
  test('7. My Reports nav contains the My Certifications entry', () => {
    // The new entry sits in the per-user "My Reports" group (not the
    // admin-only Records group) and points at /portal/certifications.
    // Re-uses BILLING_ICON from the admin entry so the two pages feel
    // like siblings in the sidebar.
    expect(layoutSrc).toMatch(
      /to:\s*['"]\/portal\/certifications['"][\s\S]*?label:\s*['"]My Certifications['"][\s\S]*?icon:\s*BILLING_ICON/,
    );
  });

  test('8. My Certifications is NOT behind the isAdmin gate', () => {
    // The My Reports group itself is rendered unconditionally for
    // every authenticated user. Pin that the new entry is INSIDE the
    // shared group, not in the admin-only `...(employee?.isAdmin ?
    // [...] : [])` block. Anchor on the first spread-gate
    // `...(employee?.isAdmin` — there are earlier uses (e.g.
    // goAttendance on line 109) but those are unrelated.
    const myReportsIdx = layoutSrc.indexOf("label: 'My Reports'");
    const adminGateIdx = layoutSrc.indexOf('...(employee?.isAdmin');
    expect(myReportsIdx).toBeGreaterThan(-1);
    expect(adminGateIdx).toBeGreaterThan(myReportsIdx);
    const myCertIdx = layoutSrc.indexOf("label: 'My Certifications'");
    expect(myCertIdx).toBeGreaterThan(myReportsIdx);
    expect(myCertIdx).toBeLessThan(adminGateIdx);
  });
});

describe('R37.1 — My Certifications: App.jsx route', () => {
  test('9. App.jsx lazy-imports MyCertifications.jsx', () => {
    expect(appSrc).toMatch(
      /const\s+MyCertifications\s*=\s*React\.lazy\(\(\)\s*=>\s*import\(['"]\.\/pages\/portal\/MyCertifications\.jsx['"]\)\)/,
    );
  });

  test('10. App.jsx mounts <Route path="certifications" element={<MyCertifications />} />', () => {
    expect(appSrc).toMatch(
      /<Route\s+path="certifications"\s+element=\{<MyCertifications\s*\/>}\s*\/>/,
    );
  });
});
