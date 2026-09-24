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
const appCssPath = resolvePath(__dirname, '../App.css');
const pageSrc = readFileSync(pagePath, 'utf8');
const appSrc = readFileSync(appPath, 'utf8');
const layoutSrc = readFileSync(layoutPath, 'utf8');
const appCssSrc = readFileSync(appCssPath, 'utf8');

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

  test('9. page calls api.getProjects with `{ scope: "all" }` for admins, `{ scope: "assigned" }` for employees', () => {
    // Admins need every project's reports so they can review them
    // (S7 round-2 admin review action bar). Employees keep `assigned`
    // which now requires an active ProjectAssignment row (no historical
    // evidence leak — see projects.dr010/dr012 tests + backend
    // src/routes/projects.js). Backend rejects scope=all for non-admins,
    // so the `isAdmin ?` gate MUST be pinned at the call site.
    expect(pageSrc).toMatch(
      /api\.getProjects\(\s*\{\s*scope:\s*isAdmin\s*\?\s*['"]all['"]\s*:\s*['"]assigned['"]\s*\}\s*,\s*accessToken/,
    );
    // Sanity: both literals must appear in source so neither branch
    // is accidentally dropped. Match the quoted string literally
    // (looser than `scope:\\s*['"]assigned['"]` — the latter fails
    // because the literal sits at the END of the ternary, not
    // immediately after `scope:`).
    expect(pageSrc).toMatch(/['"]assigned['"]/);
    expect(pageSrc).toMatch(/['"]all['"]/);
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

  // ─── DR-046 (2026-09-23) — Mobile report cards responsive layout ──
  // The prior card used an inline `auto 1fr auto auto auto` grid. Under
  // that grid the only flexible `1fr` column collapsed to 0px at 320/375px
  // because the 3 fixed-width `auto` tracks (type pill + 3 action buttons,
  // none of which can wrap) consumed all the available width. Result:
  // title text wrapped onto ~820px of vertical height and the user saw
  // blank cards with floating action buttons. Fix = move to a responsive
  // class that stacks under 768px and uses 3 columns from 768px up.
  // These tests pin the BEM-ish classnames, the DOM structure (actions
  // grouped under one wrapper), and the contract that the fix did NOT
  // silently regress to the audit's banned approaches (overflow:hidden
  // hiding content, or shrinking text).

  test('25. card outer div uses the responsive class "mpr-card" (not inline grid)', () => {
    // Banned shape: inline `gridTemplateColumns: 'auto 1fr auto auto'`
    // on the card-level div. Acceptable shape: `className="mpr-card"`
    // with the responsive CSS in App.css.
    // Source uses bare JSX attributes (not expression containers) for
    // these static class names — accept either form.
    expect(pageSrc).toMatch(
      /<div[\s\S]*?key=\{r\.id\}[\s\S]*?className=(?:\{['"]mpr-card['"]\s*\}|['"]mpr-card['"])/
    );
    // Also assert no inline `gridTemplateColumns` sits near the card
    // div — an inline style would override the responsive CSS and
    // silently re-break mobile. Take a window from the key up to
    // ~600 chars to cover the open + first few attributes without
    // trying to track the closing-tag stack (the card div has 5+
    // nested children so a close-tag regex is brittle).
    const keyIdx = pageSrc.search(/key=\{r\.id\}/);
    expect(keyIdx).toBeGreaterThan(-1);
    const cardOpener = pageSrc.slice(keyIdx, keyIdx + 600);
    expect(cardOpener).not.toMatch(/gridTemplateColumns/);
  });

  test('26. type pill, content, and actions each have their own grid-area class', () => {
    // Each card-level child must own one named grid area so the mobile
    // single-column stack and the desktop 3-column grid both address
    // the same nodes via `grid-template-areas`.
    expect(pageSrc).toMatch(/className=(?:\{['"]mpr-card__type['"]\s*\}|['"]mpr-card__type['"])/);
    expect(pageSrc).toMatch(/className=(?:\{['"]mpr-card__content['"]\s*\}|['"]mpr-card__content['"])/);
    expect(pageSrc).toMatch(/className=(?:\{['"]mpr-card__actions['"]\s*\}|['"]mpr-card__actions['"])/);
  });

  test('27. Download / Replace / Delete buttons are all wrapped in .mpr-card__actions', () => {
    // The fix's contract: the 3 action buttons that previously each
    // occupied their own `auto` grid column must now be siblings under
    // one wrapper. If a future refactor moves any of them OUT of that
    // wrapper (or adds a fourth standalone button), the responsive
    // flex-wrap will silently stop working on phones because the buttons
    // would no longer share their own flex container.
    const openTag = pageSrc.indexOf('className="mpr-card__actions"');
    expect(openTag).toBeGreaterThan(-1);
    // The wrapper opens with a `<div` and closes with a matching `</div>`
    // before the parent card's `</div>`. Capture up to the next
    // `</div>` (the actions wrapper close tag) — this is accurate
    // because the parent card is the next enclosing element.
    const wrapperEnd = pageSrc.indexOf('</div>', openTag);
    expect(wrapperEnd).toBeGreaterThan(openTag);
    const wrapperBody = pageSrc.slice(openTag, wrapperEnd);
    expect(wrapperBody).toMatch(/handleDownload\(\s*r\s*\)/);
    // Replace and Delete are conditional — assert their handler symbols
    // appear inside the wrapper body so they stay grouped.
    expect(wrapperBody).toMatch(/startReplaceFile\(\s*r\s*\)/);
    expect(wrapperBody).toMatch(/handleDelete\(\s*r\s*\)/);
  });

  test('28. App.css defines a mobile-first responsive card with a single-column phone stack', () => {
    // Mobile-first contract (the audit's "give title/project/status a
    // full-width row" requirement): under 768px the card is single-
    // column with three vertically-stacked grid areas.
    expect(appCssSrc).toMatch(/\.mpr-card\s*\{/);
    expect(appCssSrc).toMatch(/grid-template-areas:\s*\n?\s*"type"\s+"content"\s+"actions"/);
    // Default (mobile) grid must be one column — not the prior broken
    // `auto 1fr auto auto`.
    const mprCardBlockMatch = appCssSrc.match(/\.mpr-card\s*\{([\s\S]*?)\}/);
    expect(mprCardBlockMatch).not.toBeNull();
    expect(mprCardBlockMatch[1]).toMatch(/grid-template-columns:\s*1fr/);
  });

  test('29. App.css switches to a 3-column grid at the tablet+ breakpoint (DR-046 acceptance: desktop behavior preserved)', () => {
    // Acceptance: "Desktop behavior and actual download/review actions
    // still work." Pin the @media rule that promotes the layout from
    // single-column to the 3-column desktop grid, and the columns
    // themselves.
    expect(appCssSrc).toMatch(/@media\s*\(\s*min-width:\s*768px\s*\)\s*\{[\s\S]*?\.mpr-card\s*\{/);
    expect(appCssSrc).toMatch(/grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/);
    // Grid areas at desktop must be horizontal: type | content | actions.
    expect(appCssSrc).toMatch(/"type\s+content\s+actions"/);
  });

  test('30. fix did NOT ban-list the audit-rejected approaches (no overflow:hidden, no title font shrink)', () => {
    // The audit explicitly rejected both as repair paths: "Do not
    // repair this by hiding more overflow or shrinking text." Even the
    // title's existing `overflowWrap: 'anywhere'` is preserved (it lets
    // the title wrap *within* its track instead of pushing the card
    // past the viewport — that's the opposite of hiding overflow).
    expect(appCssSrc).not.toMatch(/\.mpr-card[^{]*\{[^}]*overflow:\s*hidden/);
    // Source-side: no `font-size` shrinking on the title row.
    const titleRow = pageSrc.match(/<div[^>]*color:\s*['"]var\(--navy\)['"][^>]*>/);
    expect(titleRow).not.toBeNull();
    expect(titleRow[0]).not.toMatch(/font-size/);
  });

  test('31. actions wrapper has flex-wrap so Download+Replace+Delete fit on a 375px row', () => {
    // Pin flex-wrap on the actions container — without it the 3
    // buttons (each ~80-95px) could overflow the actions row on narrow
    // tablets. flex-wrap is the mobile-friendly complement to the grid
    // switch.
    expect(appCssSrc).toMatch(/\.mpr-card__actions\s*\{[\s\S]*?flex-wrap:\s*wrap/);
  });
});
