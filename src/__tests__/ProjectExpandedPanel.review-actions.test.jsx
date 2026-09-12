// S7/MyReports — admin review action bar inside ReportSection
// (ProjectExpandedPanel.jsx).
//
// The in-accordion Reports section is the FIRST place an admin lands
// when they click into a project from My Projects. Without the action
// bar here, admins would have to back out to the cross-project
// /portal/reports page to act on a single row — a UX cliff for the
// most common review flow. Mirrors the source-text pins on
// MyProjectReports.test.jsx so the two surfaces offer identical
// affordances for the same status.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const pagePath = resolvePath(__dirname, '../pages/portal/ProjectExpandedPanel.jsx');
const pageSrc = readFileSync(pagePath, 'utf8');

describe('S7/MyReports — ReportSection admin action bar source contracts', () => {
  test('1. three allowed-from Sets mirror the backend state machine', () => {
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

  test('2. ReportSection calls api.reviewProjectAttachment with projectKey + att.id', () => {
    // Unlike the cross-project page (which derives the project key from
    // att.projectId || projects.find(...).id), ReportSection already
    // owns projectKey as a prop. Wire shape must mirror the cross-
    // project surface so a backend regression is caught at both call
    // sites.
    expect(pageSrc).toMatch(
      /api\.reviewProjectAttachment\(\s*projectKey\s*,\s*att\.id\s*,\s*\{\s*status:\s*action\s*,\s*reviewNotes/,
    );
  });

  test('3. action bar gate: isAdmin AND (canApprove || canRevise || canReject)', () => {
    expect(pageSrc).toMatch(
      /showReviewBar\s*=\s*isAdmin\s*&&\s*\(\s*canApprove\s*\|\|\s*canRevise\s*\|\|\s*canReject\s*\)/,
    );
  });

  test('4. Reject + Request-revision buttons are disabled while reviewNotes is empty', () => {
    // The action bar in the accordion uses `attNotes` (not `rNotes`
    // like MyProjectReports). Pin the local name so a future refactor
    // that drops the trim() check is caught here too.
    expect(pageSrc).toMatch(
      /disabled\s*=\s*\{[^}]*actionBusy\s*\|\|\s*!attNotes\.trim\(\s*\)[^}]*\}/,
    );
  });

  test('5. actionBusy flag guards double-click across all three actions', () => {
    expect(pageSrc).toMatch(/const\s+\[actionBusy\s*,\s*setActionBusy\]\s*=\s*useState\(\s*false\s*\)/);
    // ReportSection uses an `if (actionBusy) return` gate inside
    // runReviewAction, not the same closure shape as MyProjectReports.
    expect(pageSrc).toMatch(/if\s*\(\s*actionBusy\s*\)\s*return/);
  });

  test('6. on success the parent is notified via onUploaded() to re-fetch', () => {
    // ReportSection lives inside the parent ProjectExpandedPanel which
    // owns the data. The child can't optimistically patch the parent's
    // reports array — easier to ask the parent to re-pull.
    expect(pageSrc).toMatch(/onUploaded\s*&&\s*onUploaded\(\s*\)/);
  });

  test('7. STATUS_LABEL map covers all four enum values', () => {
    // The status pill is visible to everyone (employee + admin) so
    // uploaders can see whether their report is still pending review.
    // Pin the four-value map so a new enum value lands here too.
    expect(pageSrc).toMatch(/PENDING_REVIEW\s*:\s*['"]Pending review['"]/);
    expect(pageSrc).toMatch(/APPROVED\s*:\s*['"]Approved['"]/);
    expect(pageSrc).toMatch(/REVISION_REQUESTED\s*:\s*['"]Revision requested['"]/);
    expect(pageSrc).toMatch(/REJECTED\s*:\s*['"]Rejected['"]/);
  });
});
