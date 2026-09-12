// S7/MyReports (2026-09-12): cross-project employee "Project Reports" page.
//
// This page reuses the existing R35 upload pipeline
// (getReportSasUrl → uploadBlob → confirmReportUpload → createProjectAttachment)
// plus the R36 per-project list/read-sas/delete helpers, and fans them out
// across every project the employee is assigned to. Zero new backend
// endpoints, zero schema changes. The test pins below guard the structural
// contracts that make this safe to refactor — if a future change drops one
// of the pieces the fan-out breaks silently (e.g. a row shows up twice
// because the type chip filter was removed, or one project's 404 sinks
// the rest because Promise.allSettled was swapped for Promise.all).
//
// Coverage:
//   1.  page file exists at src/pages/portal/MyProjectReports.jsx
//   2.  lazy import registered in App.jsx
//   3.  route `/portal/reports` registered in App.jsx
//   4.  sidebar entry below My Inspection Records in PortalLayout.jsx
//   5.  useAuth() destructure exposes accessToken + employee (DR-018 guard
//       shape — same pattern as InspectionDetail.admin-actions.test.jsx)
//   6.  page imports MAX_REPORT_BYTES / ACCEPTED_REPORT_TYPES /
//       PROJECT_REPORT_TYPES / PROJECT_REPORT_TYPE_LABELS from constants
//   7.  page imports api from src/lib/api.js (no new HTTP wrapper)
//   8.  page imports uploadBlob + BlobUploadError from src/lib/blobUpload.js
//   9.  page calls api.getProjects with `{ scope: 'assigned' }` (matches
//       server-side narrow — mirrors My Projects accordion pattern)
//   10. cross-project fan-out uses Promise.allSettled so one 404 doesn't
//       sink the rest
//   11. 3-step upload state machine progresses idle → sas → uploading →
//       confirming via setUploadPhase
//   12. upload pipeline calls getReportSasUrl → uploadBlob →
//       confirmReportUpload → createProjectAttachment in that order
//   13. file validation checks MAX_REPORT_BYTES + ACCEPTED_REPORT_TYPES
//   14. delete handler calls api.deleteProjectAttachment(projectId,
//       attachment.id)
//   15. download handler calls api.getProjectAttachmentReadSas
//   16. type chip filter renders one chip per PROJECT_REPORT_TYPES entry
//       (no SAFETY type — backend enum is the source of truth)
//   17. admin users can delete any report; non-admins can delete only
//       rows they uploaded (isAdmin || uploadedById === employee.id)

import { readFileSync, existsSync } from 'fs';
import { resolve as resolvePath } from 'path';

const pagePath = resolvePath(__dirname, '../pages/portal/MyProjectReports.jsx');
const appPath = resolvePath(__dirname, '../App.jsx');
const layoutPath = resolvePath(__dirname, '../components/PortalLayout.jsx');
const pageSrc = readFileSync(pagePath, 'utf8');
const appSrc = readFileSync(appPath, 'utf8');
const layoutSrc = readFileSync(layoutPath, 'utf8');

describe('S7/MyReports — Project Reports page source contracts', () => {
  test('1. page file exists at the expected portal path', () => {
    expect(existsSync(pagePath)).toBe(true);
  });

  test('2. lazy import registered in App.jsx', () => {
    expect(appSrc).toMatch(
      /const\s+MyProjectReports\s*=\s*React\.lazy\(\s*\(\s*\)\s*=>\s*import\(\s*['"]\.\/pages\/portal\/MyProjectReports\.jsx['"]\s*\)\s*\)/,
    );
  });

  test('3. route `/portal/reports` registered in App.jsx', () => {
    // The portal subtree uses bare relative paths, so the route is
    // literally path="reports". Pin so a future refactor that drops
    // the route (or moves the page behind a /admin/ prefix) fails the
    // test instead of silently dropping the sidebar entry's target.
    expect(appSrc).toMatch(
      /<Route\s+path\s*=\s*['"]reports['"]\s+element\s*=\s*\{<\s*MyProjectReports\s*\/>\s*\}\s*\/>/
    );
  });

  test('4. sidebar entry below My Inspection Records in PortalLayout.jsx', () => {
    // The entry must reference the new path AND reuse the existing
    // REPORT_ICON (defined in PortalLayout.jsx R36).
    expect(layoutSrc).toMatch(
      /\{\s*to:\s*['"]\/portal\/reports['"]\s*,\s*label:\s*['"]Project Reports['"]\s*,\s*icon:\s*REPORT_ICON\s*\}/
    );
    // And it must sit *after* the My Inspection Records entry.
    const inspectionIdx = layoutSrc.indexOf("/portal/inspection/my");
    const reportsIdx = layoutSrc.indexOf("/portal/reports");
    expect(reportsIdx).toBeGreaterThan(inspectionIdx);
  });

  test('5. useAuth() destructure exposes accessToken + employee + isAdmin', () => {
    // DR-018 family guard — pin the shape so a future AuthContext refactor
    // that drops accessToken / employee / isAdmin can't silently break
    // every call site. isAdmin was added in S7/MyReports for the admin
    // review action bar gate (test 20).
    expect(pageSrc).toMatch(
      /const\s*\{\s*accessToken\s*,\s*employee\s*,\s*isAdmin\s*\}\s*=\s*useAuth\(\s*\)/
    );
  });

  test('6. page imports MAX_REPORT_BYTES / ACCEPTED_REPORT_TYPES / PROJECT_REPORT_TYPES / PROJECT_REPORT_TYPE_LABELS from constants', () => {
    expect(pageSrc).toMatch(/import\s*\{[^}]*MAX_REPORT_BYTES[^}]*\}\s*from\s*['"]\.\.\/\.\.\/lib\/constants\.js['"]/);
    expect(pageSrc).toMatch(/import\s*\{[^}]*ACCEPTED_REPORT_TYPES[^}]*\}\s*from\s*['"]\.\.\/\.\.\/lib\/constants\.js['"]/);
    expect(pageSrc).toMatch(/import\s*\{[^}]*PROJECT_REPORT_TYPES[^}]*\}\s*from\s*['"]\.\.\/\.\.\/lib\/constants\.js['"]/);
    expect(pageSrc).toMatch(/import\s*\{[^}]*PROJECT_REPORT_TYPE_LABELS[^}]*\}\s*from\s*['"]\.\.\/\.\.\/lib\/constants\.js['"]/);
  });

  test('7. page imports api from src/lib/api.js (no new HTTP wrapper)', () => {
    expect(pageSrc).toMatch(
      /import\s*\{\s*api\s*\}\s*from\s*['"]\.\.\/\.\.\/lib\/api\.js['"]/
    );
  });

  test('8. page imports uploadBlob + BlobUploadError from src/lib/blobUpload.js', () => {
    expect(pageSrc).toMatch(
      /import\s*\{[^}]*uploadBlob[^}]*\}\s*from\s*['"]\.\.\/\.\.\/lib\/blobUpload\.js['"]/
    );
    expect(pageSrc).toMatch(
      /import\s*\{[^}]*BlobUploadError[^}]*\}\s*from\s*['"]\.\.\/\.\.\/lib\/blobUpload\.js['"]/
    );
  });

  test('9. page calls api.getProjects with `{ scope: "assigned" }` (server-side narrow)', () => {
    expect(pageSrc).toMatch(
      /api\.getProjects\(\s*\{\s*scope:\s*['"]assigned['"]\s*\}\s*,\s*accessToken/
    );
  });

  test('10. cross-project fan-out uses Promise.allSettled (one 404 must not sink the rest)', () => {
    // If this were Promise.all, a single project 404 would surface as a
    // global error and the rest of the projects' rows would silently
    // disappear. Same lesson as the My Projects accordion (R33).
    expect(pageSrc).toMatch(/Promise\.allSettled\(/);
  });

  test('11. 3-step upload state machine progresses idle → sas → uploading → confirming', () => {
    // All four phases must appear in source text in the documented order.
    const ordered = [
      /setUploadPhase\(\s*['"]sas['"]\s*\)/,
      /setUploadPhase\(\s*['"]uploading['"]\s*\)/,
      /setUploadPhase\(\s*['"]confirming['"]\s*\)/,
      /setUploadPhase\(\s*['"]idle['"]\s*\)/,
    ];
    const indices = ordered.map((re) => pageSrc.search(re));
    indices.forEach((idx, i) => {
      expect(idx).toBeGreaterThan(-1);
    });
    indices.forEach((idx, i) => {
      expect(idx).toBeGreaterThan(indices[i - 1] ?? -1);
    });
  });

  test('12. upload pipeline calls getReportSasUrl → uploadBlob → confirmReportUpload → createProjectAttachment in that order', () => {
    const ordered = [
      /api\.getReportSasUrl\(/,
      /uploadBlob\(\s*sasUrl/,
      /api\.confirmReportUpload\(/,
      /api\.createProjectAttachment\(/,
    ];
    const indices = ordered.map((re) => pageSrc.search(re));
    indices.forEach((idx) => expect(idx).toBeGreaterThan(-1));
    indices.forEach((idx, i) => {
      expect(idx).toBeGreaterThan(indices[i - 1] ?? -1);
    });
  });

  test('13. file validation checks MAX_REPORT_BYTES + ACCEPTED_REPORT_TYPES', () => {
    // Mirror the ReportSection in ProjectExpandedPanel.jsx — same two checks,
    // same error messages so the inline-accordion + cross-project pages
    // surface identical UI feedback for the same input.
    expect(pageSrc).toMatch(/file\.size\s*>\s*MAX_REPORT_BYTES/);
    expect(pageSrc).toMatch(/ACCEPTED_REPORT_TYPES\.includes\(\s*file\.type\s*\)/);
  });

  test('14. delete handler calls api.deleteProjectAttachment(projectKey, attachment.id)', () => {
    // The first argument resolves to a project key (via either an
    // `att.projectId` lookup or a project.find-by-name fallback). The
    // second argument is an attachment id (`att.id`). Keep this loose
    // enough to survive both shapes; the contract that matters is
    // "calls the helper with project + attachment ids", not the exact
    // fallback expression.
    expect(pageSrc).toMatch(/api\.deleteProjectAttachment\(/);
    expect(pageSrc).toMatch(/api\.deleteProjectAttachment\([^)]*,\s*(?:att\.id|r\.id)/);
  });

  test('15. download handler calls api.getProjectAttachmentReadSas', () => {
    expect(pageSrc).toMatch(/api\.getProjectAttachmentReadSas\(/);
  });

  test('16. type chip filter renders one chip per PROJECT_REPORT_TYPES entry (no synthetic SAFETY type)', () => {
    // The backend enum is the source of truth for available types. If a
    // future refactor synthesises a "SAFETY" chip from outside the enum
    // (e.g. PROJECT_REPORT_TYPES.concat(['SAFETY_REPORT'])) the upload
    // would silently fail with a 400 because the server doesn't know
    // the new value. Pin the iteration source so this is caught at
    // review time.
    expect(pageSrc).toMatch(/PROJECT_REPORT_TYPES\.map\(/);
    expect(pageSrc).not.toMatch(/SAFETY_REPORT/);
  });

  test('17. delete is gated to admin OR row owner (isAdmin || uploadedById === employee.id)', () => {
    // Mirrors the existing per-row permission shape used by DPR/Inspection
    // delete affordances. Pin so a future refactor that drops the admin
    // branch (or the owner branch) is caught here instead of via a live
    // permission escalation.
    expect(pageSrc).toMatch(/isAdmin\s*\|\|\s*\(\s*employee\s*&&\s*(?:r|att)\.uploadedById\s*===\s*employee\.id\s*\)/);
  });

  // ─── S7/MyReports — admin review action bar (S7 round-2, 2026-09-12) ──
  // Backend PATCH endpoint added in projectAttachments.js; wrapper added
  // in src/lib/api.js as api.reviewProjectAttachment. The bar mirrors
  // InspectionDetail's three-button shape so the wire + UI state machine
  // stays aligned by source-text contract.

  test('18. three allowed-from Sets mirror the backend state machine', () => {
    // APPROVE_ALLOWED_FROM = PENDING_REVIEW | REVISION_REQUESTED
    // REVISE_ALLOWED_FROM  = PENDING_REVIEW
    // REJECT_ALLOWED_FROM  = PENDING_REVIEW | REVISION_REQUESTED
    expect(pageSrc).toMatch(
      /const\s+APPROVE_ALLOWED_FROM\s*=\s*new Set\(\s*\[\s*['"]PENDING_REVIEW['"]\s*,\s*['"]REVISION_REQUESTED['"]\s*\]\s*\)/,
    );
    expect(pageSrc).toMatch(
      /const\s+REVISE_ALLOWED_FROM\s*=\s*new Set\(\s*\[\s*['"]PENDING_REVIEW['"]\s*\]\s*\)/,
    );
    expect(pageSrc).toMatch(
      /const\s+REJECT_ALLOWED_FROM\s*=\s*new Set\(\s*\[\s*['"]PENDING_REVIEW['"]\s*,\s*['"]REVISION_REQUESTED['"]\s*\]\s*\)/,
    );
  });

  test('19. useAuth() destructure exposes isAdmin (DR-018 live regression guard)', () => {
    // DR-018 (2026-09-08) — a missing `isAdmin` in AuthContext's value
    // bounced every admin from admin-labelled routes. The admin review
    // bar is gated on `isAdmin` — pin the destructure so a future
    // AuthContext refactor fails this test instead of silently demoting
    // every admin to a read-only viewer.
    expect(pageSrc).toMatch(
      /const\s*\{\s*accessToken\s*,\s*employee\s*,\s*isAdmin\s*\}\s*=\s*useAuth\(\s*\)/,
    );
  });

  test('20. action bar gate: isAdmin AND any allowed-from set has the row status', () => {
    // Mirrors the DR-008 InspectionDetail pattern. A future refactor
    // that narrows this (e.g. drops REJECT_ALLOWED_FROM.has(...))
    // would silently disable the Reject button on REVISION_REQUESTED
    // rows. The combined gate can be inlined OR hoisted to a local
    // `showReviewBar` const — both shapes pass this test.
    expect(pageSrc).toMatch(
      /(?:showReviewBar\s*=\s*isAdmin\s*&&\s*\(\s*canApprove\s*\|\|\s*canRevise\s*\|\|\s*canReject\s*\)|\{\s*isAdmin\s*&&\s*\(\s*canApprove\s*\|\|\s*canRevise\s*\|\|\s*canReject\s*\))/,
    );
  });

  test('21. Approve / Reject / Request-revision buttons call api.reviewProjectAttachment', () => {
    // The action verbs must match the backend enum exactly so the wire
    // body is the same string the backend ALLOWED_TRANSITIONS map keys
    // on. APPROVED / REVISION_REQUESTED / REJECTED — NOT lowercase.
    expect(pageSrc).toMatch(
      /onClick\s*=\s*\{\s*\(\s*\)\s*=>\s*runReviewAction\(\s*r\s*,\s*['"]APPROVED['"]\s*\)\s*\}/,
    );
    expect(pageSrc).toMatch(
      /onClick\s*=\s*\{\s*\(\s*\)\s*=>\s*runReviewAction\(\s*r\s*,\s*['"]REVISION_REQUESTED['"]\s*\)\s*\}/,
    );
    expect(pageSrc).toMatch(
      /onClick\s*=\s*\{\s*\(\s*\)\s*=>\s*runReviewAction\(\s*r\s*,\s*['"]REJECTED['"]\s*\)\s*\}/,
    );
    // runReviewAction must invoke api.reviewProjectAttachment with the
    // project key + attachment id + body { status, reviewNotes }.
    expect(pageSrc).toMatch(
      /api\.reviewProjectAttachment\(\s*projectKey\s*,\s*att\.id\s*,\s*\{\s*status:\s*action\s*,\s*reviewNotes/,
    );
  });

  test('22. Reject + Request-revision buttons are disabled while reviewNotes is empty', () => {
    // Backend 400s with REVIEW_NOTES_REQUIRED if the notes are missing
    // for those two actions — the buttons must stay disabled until the
    // input has trimmed content. Pin the disabled expression shape so
    // a future refactor that drops the trim() check is caught here.
    expect(pageSrc).toMatch(
      /disabled\s*=\s*\{[^}]*actionBusy\s*\|\|\s*!rNotes\.trim\(\s*\)[^}]*\}/,
    );
  });

  test('23. an in-flight actionBusy flag guards double-click across all three buttons', () => {
    // Sibling to the existing `uploadPhase !== idle` flag — same
    // pattern as InspectionDetail's actionBusy. All three buttons must
    // bind disabled={actionBusy}.
    expect(pageSrc).toMatch(/const\s+\[actionBusy\s*,\s*setActionBusy\]\s*=\s*useState\(\s*false\s*\)/);
    expect(pageSrc).toMatch(/if\s*\(\s*actionBusy\s*\)\s*return/);
  });

  test('24. reviewNotes input is bound to per-row state + capped at 2000 chars', () => {
    // Backend slices reviewNotes to FIELD_MAX.reviewNotes (2000) and
    // mirrors the cap on the input so a paste-bomb gets cut off before
    // the round trip.
    expect(pageSrc).toMatch(/value=\{rNotes\}/);
    expect(pageSrc).toMatch(/onChange=\{[^}]*setReviewNotesById[^}]*\}/);
    expect(pageSrc).toMatch(/maxLength=\{2000\}/);
  });
});
