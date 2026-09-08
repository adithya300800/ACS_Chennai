// R37: Billing Certifications Admin — frontend source-text contracts.
//
// Mount-free per the App.test.jsx header (PortalLayout exhausts jest
// memory). Pins the wire surface between:
//   - backend/src/routes/billingCertifications.js
//   - src/lib/api.js (the new billing-cert helpers + reused helpers)
//   - src/lib/constants.js (the status label map the page consumes)
//   - src/pages/admin/BillingCertificationsAdmin.jsx (the page itself)
//   - src/App.jsx (the /portal/admin/billing-certifications route)
//   - src/components/PortalLayout.jsx (the sidebar entry + BILLING_ICON)
//
// Coverage matrix:
//   api helper (src/lib/api.js)
//     1. exports getBillingCertifications pointing at /billing-certifications
//     2. exports getBillingCertificationAggregates pointing at /billing-certifications/aggregates
//     3. exports certifyBillingCertification / disputeBillingCertification
//     4. exports getBillingCertSasUrl + confirmBillingCertUpload with `billing/` prefix
//   constants (src/lib/constants.js)
//     5. exports BILLING_CERTIFICATION_STATUSES + BILLING_CERTIFICATION_STATUS_LABELS
//   page (src/pages/admin/BillingCertificationsAdmin.jsx)
//     6. consumes the 6 expected api helpers
//     7. imports BILLING_CERTIFICATION_STATUSES + BILLING_CERTIFICATION_STATUS_LABELS
//     8. renders the filter row + card grid scaffold + status chips
//     9. embeds the CertificationFormModal with the 4-step upload pipeline
//   PortalLayout sidebar
//    10. sidebar nav contains the Billing Certifications entry
//    11. PortalLayout declares the BILLING_ICON SVG constant
//   App.jsx route
//    12. App.jsx lazy-imports BillingCertificationsAdmin.jsx
//    13. App.jsx mounts <Route path="admin/billing-certifications" />

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const apiPath = resolvePath(__dirname, '../lib/api.js');
const constantsPath = resolvePath(__dirname, '../lib/constants.js');
const pagePath = resolvePath(__dirname, '../pages/admin/BillingCertificationsAdmin.jsx');
const layoutPath = resolvePath(__dirname, '../components/PortalLayout.jsx');
const appPath = resolvePath(__dirname, '../App.jsx');

const apiSrc = readFileSync(apiPath, 'utf8');
const constantsSrc = readFileSync(constantsPath, 'utf8');
const pageSrc = readFileSync(pagePath, 'utf8');
const layoutSrc = readFileSync(layoutPath, 'utf8');
const appSrc = readFileSync(appPath, 'utf8');

describe('R37 — Billing Certifications Admin: api helpers (src/lib/api.js)', () => {
  test('1. exports getBillingCertifications pointing at /billing-certifications', () => {
    expect(apiSrc).toMatch(/getBillingCertifications\s*:\s*\(\s*params\s*=\s*\{\}\s*,\s*token\s*\)\s*=>/);
    expect(apiSrc).toMatch(/api\.get\(\s*`\/billing-certifications\$\{[^}]*\}\s*`/);
  });

  test('2. exports getBillingCertificationAggregates pointing at /billing-certifications/aggregates', () => {
    expect(apiSrc).toMatch(/getBillingCertificationAggregates\s*:\s*\(\s*params\s*=\s*\{\}\s*,\s*token\s*\)\s*=>/);
    expect(apiSrc).toMatch(/api\.get\(\s*`\/billing-certifications\/aggregates\$\{[^}]*\}\s*`/);
  });

  test('3. exports certify / dispute / delete / read-sas / update / create / get-one', () => {
    expect(apiSrc).toMatch(/certifyBillingCertification\s*:\s*\(\s*id\s*,\s*token\s*\)\s*=>/);
    expect(apiSrc).toMatch(/api\.post\(\s*`\/billing-certifications\/\$\{id\}\/certify`/);
    expect(apiSrc).toMatch(/disputeBillingCertification\s*:\s*\(\s*id\s*,\s*reason\s*,\s*token\s*\)\s*=>/);
    expect(apiSrc).toMatch(/api\.post\(\s*`\/billing-certifications\/\$\{id\}\/dispute`/);
    expect(apiSrc).toMatch(/deleteBillingCertification\s*:\s*\(\s*id\s*,\s*token\s*\)\s*=>/);
    expect(apiSrc).toMatch(/api\.delete\(\s*`\/billing-certifications\/\$\{id\}`/);
    expect(apiSrc).toMatch(/getBillingCertificationReadSas\s*:\s*\(\s*id\s*,\s*token\s*\)\s*=>/);
    expect(apiSrc).toMatch(/api\.get\(\s*`\/billing-certifications\/\$\{id\}\/read-sas`/);
    expect(apiSrc).toMatch(/getBillingCertification\s*:\s*\(\s*id\s*,\s*token\s*\)\s*=>/);
    expect(apiSrc).toMatch(/api\.get\(\s*`\/billing-certifications\/\$\{id\}`/);
    expect(apiSrc).toMatch(/createBillingCertification\s*:\s*\(\s*payload\s*,\s*token\s*\)\s*=>/);
    expect(apiSrc).toMatch(/api\.post\(\s*['"]\/billing-certifications['"]/);
    expect(apiSrc).toMatch(/updateBillingCertification\s*:\s*\(\s*id\s*,\s*payload\s*,\s*token\s*\)\s*=>/);
  });

  test('4. exports getBillingCertSasUrl + confirmBillingCertUpload with `billing/` prefix', () => {
    expect(apiSrc).toMatch(/getBillingCertSasUrl\s*:\s*\(\s*filename\s*,\s*contentType\s*,\s*token\s*\)\s*=>/);
    expect(apiSrc).toMatch(/filename:\s*`billing\/\$\{filename\}`/);
    expect(apiSrc).toMatch(/container:\s*['"]dpr-documents['"]/);
    expect(apiSrc).toMatch(/confirmBillingCertUpload\s*:\s*\(\s*ulid\s*,\s*filename\s*,\s*contentType\s*,\s*sizeBytes\s*,\s*token\s*\)\s*=>/);
    expect(apiSrc).toMatch(/api\.post\(\s*['"]\/dpr\/confirm-upload['"]/);
  });
});

describe('R37 — Billing Certifications Admin: constants (src/lib/constants.js)', () => {
  test('5. exports BILLING_CERTIFICATION_STATUSES + BILLING_CERTIFICATION_STATUS_LABELS', () => {
    expect(constantsSrc).toMatch(/BILLING_CERTIFICATION_STATUSES\s*=\s*\{/);
    expect(constantsSrc).toMatch(/BILLING_CERTIFICATION_STATUS_LABELS\s*=\s*\{/);
    expect(constantsSrc).toMatch(/DRAFT:/);
    expect(constantsSrc).toMatch(/CERTIFIED:/);
    expect(constantsSrc).toMatch(/DISPUTED:/);
  });
});

describe('R37 — Billing Certifications Admin: page wiring', () => {
  test('6. consumes the 6 expected api helpers', () => {
    expect(pageSrc).toMatch(/api\.getBillingCertifications\(/);
    expect(pageSrc).toMatch(/api\.getBillingCertificationAggregates\(/);
    expect(pageSrc).toMatch(/api\.getBillingCertification\(/);
    expect(pageSrc).toMatch(/api\.createBillingCertification\(/);
    expect(pageSrc).toMatch(/api\.certifyBillingCertification\(/);
    expect(pageSrc).toMatch(/api\.disputeBillingCertification\(/);
    expect(pageSrc).toMatch(/api\.deleteBillingCertification\(/);
    expect(pageSrc).toMatch(/api\.getBillingCertificationReadSas\(/);
    // Also uses getBillingCertSasUrl + confirmBillingCertUpload for the
    // 4-step upload pipeline inside the embedded form modal.
    expect(pageSrc).toMatch(/api\.getBillingCertSasUrl\(/);
    expect(pageSrc).toMatch(/api\.confirmBillingCertUpload\(/);
  });

  test('7. imports BILLING_CERTIFICATION_STATUSES + BILLING_CERTIFICATION_STATUS_LABELS', () => {
    expect(pageSrc).toMatch(/import[\s\S]*?BILLING_CERTIFICATION_STATUSES[\s\S]*?from\s+['"]\.\.\/\.\.\/lib\/constants\.js['"]/);
    expect(pageSrc).toMatch(/BILLING_CERTIFICATION_STATUS_LABELS/);
  });

  test('8. renders the filter row + card grid scaffold + status chips', () => {
    // Project dropdown labelled "Project"
    expect(pageSrc).toMatch(/htmlFor="bc-project"[\s\S]*?All projects/);
    // Contractor input
    expect(pageSrc).toMatch(/htmlFor="bc-contractor"[\s\S]*?type="search"/);
    // Date inputs
    expect(pageSrc).toMatch(/htmlFor="bc-from"[\s\S]*?type="date"/);
    expect(pageSrc).toMatch(/htmlFor="bc-to"[\s\S]*?type="date"/);
    // Status chips — buttons with aria-pressed
    expect(pageSrc).toMatch(/aria-pressed=\{active\}[\s\S]*?setStatus\(active\s*\?\s*['"]['"]\s*:\s*s\)/);
    // Card grid (auto-fill, minmax 320px)
    expect(pageSrc).toMatch(/repeat\(auto-fill,\s*minmax\(min\(100%,\s*320px\),\s*1fr\)\)/);
    // Cursor pagination via fetchCerts({append, cursor})
    expect(pageSrc).toMatch(/fetchCerts\(\{\s*append:\s*true,\s*cursor:\s*nextCursor\s*\}\)/);
  });

  test('9. embeds the CertificationFormModal with the 4-step upload pipeline', () => {
    // Form modal declared as a local function component + used via
    // <CertificationFormModal … /> in the page render.
    expect(pageSrc).toMatch(/function\s+CertificationFormModal\s*\(/);
    expect(pageSrc).toMatch(/<CertificationFormModal/);
    // 4-step upload pipeline: mint SAS, upload, confirm, POST row.
    expect(pageSrc).toMatch(/api\.getBillingCertSasUrl\(/);
    expect(pageSrc).toMatch(/uploadBlob\(\s*sasUrl/);
    expect(pageSrc).toMatch(/api\.confirmBillingCertUpload\(/);
    expect(pageSrc).toMatch(/api\.createBillingCertification\(/);
  });
});

describe('R37 — Billing Certifications Admin: PortalLayout sidebar entry', () => {
  test('10. sidebar nav contains the Billing Certifications entry', () => {
    expect(layoutSrc).toMatch(
      /to:\s*['"]\/portal\/admin\/billing-certifications['"][\s\S]*?label:\s*['"]Billing Certifications['"][\s\S]*?icon:\s*BILLING_ICON/,
    );
  });

  test('11. PortalLayout declares the BILLING_ICON SVG constant', () => {
    expect(layoutSrc).toMatch(/const\s+BILLING_ICON\s*=/);
    expect(layoutSrc).toMatch(/BILLING_ICON[\s\S]*?stroke="currentColor"[\s\S]*?viewBox="0 0 24 24"/);
  });
});

describe('R37 — Billing Certifications Admin: App.jsx route', () => {
  test('12. App.jsx lazy-imports BillingCertificationsAdmin.jsx', () => {
    expect(appSrc).toMatch(
      /const\s+BillingCertificationsAdmin\s*=\s*React\.lazy\(\(\)\s*=>\s*import\(['"]\.\/pages\/admin\/BillingCertificationsAdmin\.jsx['"]\)\)/,
    );
  });

  test('13. App.jsx mounts <Route path="admin/billing-certifications" element={<BillingCertificationsAdmin />} />', () => {
    expect(appSrc).toMatch(
      /<Route\s+path="admin\/billing-certifications"\s+element=\{[\s\S]*<BillingCertificationsAdmin\s*\/>[\s\S]*}\s*\/>/,
    );
  });
});

// [DR-018] The admin-labelled route must require isAdmin on top of
// authentication. The page's existing render-time guard (inside
// BillingCertificationsAdmin.jsx) is still there as defence in depth,
// but the route itself now goes through <ProtectedRoute requireAdmin>
// so a non-admin navigating directly to /portal/admin/billing-certifications
// is bounced to /portal/dashboard before the admin shell renders.
describe('DR-018 — Billing Certifications Admin: client-side admin route guard', () => {
  test('14. ProtectedRoute accepts a `requireAdmin` prop', () => {
    const protectedSrc = readFileSync(resolvePath(__dirname, '../components/ProtectedRoute.jsx'), 'utf8');
    expect(protectedSrc).toMatch(/requireAdmin\s*=\s*false/);
    expect(protectedSrc).toMatch(/requireAdmin\s*&&\s*!isAdmin/);
    expect(protectedSrc).toMatch(/<Navigate\s+to="\/portal\/dashboard"\s+replace/);
  });

  test('15. App.jsx wraps admin/billing-certifications in <ProtectedRoute requireAdmin>', () => {
    // The admin-labelled register route must use the requireAdmin wrapper
    // so a non-admin direct-navigation is bounced, and the underlying
    // API rejects with 403 if they bypass the client (server-side
    // ADMIN_ONLY gate on GET / and GET /aggregates).
    expect(appSrc).toMatch(
      /<Route\s+path="admin\/billing-certifications"[\s\S]*?<ProtectedRoute\s+requireAdmin>[\s\S]*<BillingCertificationsAdmin\s*\/>[\s\S]*<\/ProtectedRoute>[\s\S]*\/>/,
    );
  });
});
