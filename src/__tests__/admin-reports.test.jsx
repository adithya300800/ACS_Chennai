// R36: Admin "Project Reports" — frontend source-text contracts.
//
// Mount-free per the App.test.jsx header (PortalLayout exhausts jest
// memory). Pins the wire surface between:
//   - backend/src/routes/adminReports.js (the new /api/admin/reports)
//   - src/lib/api.js (getAdminReports + reused helpers)
//   - src/lib/constants.js (the type label maps the page consumes)
//   - src/pages/admin/ReportsAdmin.jsx (the page itself)
//   - src/App.jsx (the /portal/admin/reports route)
//   - src/components/PortalLayout.jsx (the sidebar entry)
//
// Coverage matrix:
//   1. api.js exports getAdminReports pointing at /admin/reports
//   2. ReportsAdmin.jsx consumes the 3 expected api helpers
//      (getAdminReports, getProjectAttachmentReadSas, deleteProjectAttachment)
//   3. ReportsAdmin.jsx imports PROJECT_REPORT_TYPES + PROJECT_REPORT_TYPE_LABELS
//   4. ReportsAdmin.jsx renders the filter row scaffold + the card grid
//   5. PortalLayout sidebar contains { to: '/portal/admin/reports', label: 'Project Reports' }
//   6. PortalLayout declares the REPORT_ICON SVG constant
//   7. App.jsx lazy-imports ReportsAdmin.jsx
//   8. App.jsx mounts <Route path="admin/reports" element={<ReportsAdmin />} />
//   9. constants.js still exports PROJECT_REPORT_TYPES + PROJECT_REPORT_TYPE_LABELS

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const apiPath = resolvePath(__dirname, '../lib/api.js');
const constantsPath = resolvePath(__dirname, '../lib/constants.js');
const pagePath = resolvePath(__dirname, '../pages/admin/ReportsAdmin.jsx');
const layoutPath = resolvePath(__dirname, '../components/PortalLayout.jsx');
const appPath = resolvePath(__dirname, '../App.jsx');

const apiSrc = readFileSync(apiPath, 'utf8');
const constantsSrc = readFileSync(constantsPath, 'utf8');
const pageSrc = readFileSync(pagePath, 'utf8');
const layoutSrc = readFileSync(layoutPath, 'utf8');
const appSrc = readFileSync(appPath, 'utf8');

describe('R36 — Admin Project Reports: api helper (src/lib/api.js)', () => {
  test('1. api.js exports getAdminReports pointing at /admin/reports', () => {
    expect(apiSrc).toMatch(/getAdminReports\s*:\s*\(\s*params\s*=\s*\{\}\s*,\s*token\s*\)\s*=>/);
    expect(apiSrc).toMatch(/api\.get\(\s*`\/admin\/reports\$\{[^}]*\}\s*`/);
  });
});

describe('R36 — Admin Project Reports: ReportsAdmin page wiring', () => {
  test('2. ReportsAdmin.jsx consumes the 3 expected api helpers', () => {
    expect(pageSrc).toMatch(/api\.getAdminReports\(/);
    expect(pageSrc).toMatch(/api\.getProjectAttachmentReadSas\(/);
    expect(pageSrc).toMatch(/api\.deleteProjectAttachment\(/);
    // Also uses getProjects + listAdminEmployees for the filter dropdowns.
    expect(pageSrc).toMatch(/api\.getProjects\(/);
    expect(pageSrc).toMatch(/api\.listAdminEmployees\(/);
  });

  test('3. ReportsAdmin.jsx imports PROJECT_REPORT_TYPES + PROJECT_REPORT_TYPE_LABELS', () => {
    expect(pageSrc).toMatch(/import[\s\S]*?PROJECT_REPORT_TYPES[\s\S]*?from\s+['"]\.\.\/\.\.\/lib\/constants\.js['"]/);
    expect(pageSrc).toMatch(/PROJECT_REPORT_TYPE_LABELS/);
  });

  test('4. ReportsAdmin.jsx renders the filter row + card grid scaffold', () => {
    // Project dropdown labelled "Project" (optional, defaults to all)
    expect(pageSrc).toMatch(/htmlFor="reports-project"[\s\S]*?All projects/);
    // Uploader dropdown labelled "Uploaded by"
    expect(pageSrc).toMatch(/htmlFor="reports-uploader"[\s\S]*?Any employee/);
    // Date inputs
    expect(pageSrc).toMatch(/htmlFor="reports-from"[\s\S]*?type="date"/);
    expect(pageSrc).toMatch(/htmlFor="reports-to"[\s\S]*?type="date"/);
    // Type chips — buttons with aria-pressed
    expect(pageSrc).toMatch(/aria-pressed=\{active\}[\s\S]*?toggleType\(t\)/);
    // Card grid (auto-fill, minmax 300px)
    expect(pageSrc).toMatch(/repeat\(auto-fill,\s*minmax\(min\(100%,\s*300px\),\s*1fr\)\)/);
    // Load more cursor pagination
    expect(pageSrc).toMatch(/fetchReports\(\{\s*append:\s*true,\s*cursor:\s*nextCursor\s*\}\)/);
  });
});

describe('R36 — Admin Project Reports: PortalLayout sidebar entry', () => {
  test('5. Sidebar nav contains the Project Reports entry', () => {
    expect(layoutSrc).toMatch(
      /to:\s*['"]\/portal\/admin\/reports['"][\s\S]*?label:\s*['"]Project Reports['"][\s\S]*?icon:\s*REPORT_ICON/,
    );
  });

  test('6. PortalLayout declares the REPORT_ICON SVG constant', () => {
    expect(layoutSrc).toMatch(/const\s+REPORT_ICON\s*=/);
    // The icon should be a small SVG with stroke + viewBox, similar to the
    // other registry icons (DRAWING_ICON, LIST_ICON, etc).
    expect(layoutSrc).toMatch(/REPORT_ICON[\s\S]*?stroke="currentColor"[\s\S]*?viewBox="0 0 24 24"/);
  });
});

describe('R36 — Admin Project Reports: App.jsx route', () => {
  test('7. App.jsx lazy-imports ReportsAdmin.jsx', () => {
    expect(appSrc).toMatch(
      /const\s+ReportsAdmin\s*=\s*React\.lazy\(\(\)\s*=>\s*import\(['"]\.\/pages\/admin\/ReportsAdmin\.jsx['"]\)\)/,
    );
  });

  test('8. App.jsx mounts <Route path="admin/reports" element={<ReportsAdmin />} />', () => {
    expect(appSrc).toMatch(/<Route\s+path="admin\/reports"\s+element=\{<ReportsAdmin\s*\/>}\s*\/>/);
  });
});

describe('R36 — Admin Project Reports: constants regression (R35)', () => {
  test('9. constants.js still exports PROJECT_REPORT_TYPES + PROJECT_REPORT_TYPE_LABELS', () => {
    // Regression guard — the admin page consumes these labels for the
    // type-filter chips + the per-card badge. A refactor that renames
    // the keys would break the page silently because the route's
    // backend takes the enum value as ?type=, not the label.
    expect(constantsSrc).toMatch(/PROJECT_REPORT_TYPES\s*=\s*Object\.keys\(PROJECT_REPORT_TYPE_LABELS\)/);
    expect(constantsSrc).toMatch(/WEEKLY_REPORT:/);
    expect(constantsSrc).toMatch(/MONTHLY_REPORT:/);
    expect(constantsSrc).toMatch(/DUE_DILIGENCE_REPORT:/);
    expect(constantsSrc).toMatch(/QUALITY_REPORT:/);
    expect(constantsSrc).toMatch(/OTHER:/);
  });
});
