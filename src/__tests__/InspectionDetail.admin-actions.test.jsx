// S6/UI-6 (2026-09-11): InspectionDetail admin action bar.
//
// The employee-facing InspectionDetail page was missing admin ack/close/
// reject buttons. Admin reviewers had to back out to the inspection
// dashboard to act on one row. The backend already exposes
// POST /api/inspection/:id/{acknowledge,close,reject} with the canonical
// transition matrix in backend/src/routes/inspection.js:
//
//   ACK_FROM      = OPEN
//   CLOSE_FROM    = ACKNOWLEDGED | IN_PROGRESS | PENDING_VERIFICATION
//   REJECT_FROM   = OPEN | ACKNOWLEDGED | IN_PROGRESS | PENDING_VERIFICATION
//
// The detail page now mirrors those three sets as module-level
// constants (ACK_ALLOWED_FROM / CLOSE_ALLOWED_FROM / REJECT_ALLOWED_FROM)
// and renders the corresponding buttons when `useAuth().isAdmin` is true
// AND the current status is in any of them. DRAFT / CLOSED / REJECTED
// stay hidden (DRAFT is owner-only; CLOSED + REJECTED are terminal).
//
// Coverage:
//   1. source: three allowed-from Sets are declared with the backend's values
//   2. source: action bar renders when isAdmin AND status is in any set
//   3. source: action bar is hidden when no transition applies
//   4. source: Acknowledge button calls api.acknowledgeInspection
//   5. source: Close button calls api.closeInspection
//   6. source: Reject button calls api.rejectInspection with the reason
//   7. source: Reject button is disabled while the reason is empty
//   8. source: an in-flight actionBusy flag guards double-click

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const pagePath = resolvePath(__dirname, '../pages/portal/InspectionDetail.jsx');
const pageSrc = readFileSync(pagePath, 'utf8');

describe('S6/UI-6 — InspectionDetail admin action bar source contracts', () => {
  test('1. three allowed-from Sets mirror the backend transition matrix', () => {
    // ACK_FROM in backend = {'OPEN'}
    expect(pageSrc).toMatch(/const\s+ACK_ALLOWED_FROM\s*=\s*new Set\(\s*\[\s*['"]OPEN['"]\s*\]\s*\)/);
    // CLOSE_FROM in backend = {ACKNOWLEDGED, IN_PROGRESS, PENDING_VERIFICATION}
    expect(pageSrc).toMatch(/const\s+CLOSE_ALLOWED_FROM\s*=\s*new Set\(\s*\[\s*['"]ACKNOWLEDGED['"]\s*,\s*['"]IN_PROGRESS['"]\s*,\s*['"]PENDING_VERIFICATION['"]\s*\]\s*\)/);
    // REJECT_FROM in backend = {OPEN, ACKNOWLEDGED, IN_PROGRESS, PENDING_VERIFICATION}
    expect(pageSrc).toMatch(/const\s+REJECT_ALLOWED_FROM\s*=\s*new Set\(\s*\[\s*['"]OPEN['"]\s*,\s*['"]ACKNOWLEDGED['"]\s*,\s*['"]IN_PROGRESS['"]\s*,\s*['"]PENDING_VERIFICATION['"]\s*\]\s*\)/);
  });

  test('2. action bar renders when isAdmin AND status is in any allowed-from set', () => {
    // The combined gate: isAdmin AND (ACK has status OR CLOSE has status OR REJECT has status).
    // A future refactor that narrows this (e.g. drops CLOSE_ALLOWED_FROM.has(...))
    // would silently disable the Close button on ACKNOWLEDGED rows.
    expect(pageSrc).toMatch(
      /\{\s*isAdmin\s*&&\s*\(\s*ACK_ALLOWED_FROM\.has\(\s*record\.status\s*\)\s*\|\|\s*CLOSE_ALLOWED_FROM\.has\(\s*record\.status\s*\)\s*\|\|\s*REJECT_ALLOWED_FROM\.has\(\s*record\.status\s*\)\s*\)/
    );
  });

  test('3. action bar wrapper has role="toolbar" + aria-label="Admin actions" (a11y)', () => {
    expect(pageSrc).toMatch(/role\s*=\s*['"]toolbar['"][\s\S]{0,200}aria-label\s*=\s*['"]Admin actions['"]/);
  });

  test('4. Acknowledge button calls api.acknowledgeInspection with the record id', () => {
    expect(pageSrc).toMatch(/onClick\s*=\s*\{\s*\(\s*\)\s*=>\s*runAdminAction\(\s*['"]acknowledge['"]\s*,\s*\{\s*\}\s*\)\s*\}/);
    // runAdminAction must invoke api.acknowledgeInspection with the record id
    expect(pageSrc).toMatch(/api\.acknowledgeInspection\(\s*record\.id/);
  });

  test('5. Close button calls api.closeInspection with the record id', () => {
    expect(pageSrc).toMatch(/onClick\s*=\s*\{\s*\(\s*\)\s*=>\s*runAdminAction\(\s*['"]close['"]\s*,\s*\{\s*\}\s*\)\s*\}/);
    expect(pageSrc).toMatch(/api\.closeInspection\(\s*record\.id/);
  });

  test('6. Reject button calls api.rejectInspection with the trimmed reason', () => {
    expect(pageSrc).toMatch(/onClick\s*=\s*\{\s*\(\s*\)\s*=>\s*runAdminAction\(\s*['"]reject['"]\s*,\s*\{\s*reason:\s*rejectReason\.trim\(\s*\)\s*\}\s*\)\s*\}/);
    expect(pageSrc).toMatch(/api\.rejectInspection\(\s*record\.id\s*,\s*body\.reason/);
  });

  test('7. Reject button is disabled while the reason is empty', () => {
    // Backend 400s with REASON_REQUIRED if the reason is missing, so the
    // button must stay disabled until the input has trimmed content.
    expect(pageSrc).toMatch(/disabled\s*=\s*\{[^}]*actionBusy\s*\|\|\s*!rejectReason\.trim\(\s*\)[^}]*\}/);
  });

  test('8. an in-flight actionBusy flag guards double-click across all three actions', () => {
    // Sibling to the existing `publishing` flag on the DRAFT banner.
    // All three handler invocations must check actionBusy before firing.
    expect(pageSrc).toMatch(/const\s+\[actionBusy\s*,\s*setActionBusy\]\s*=\s*useState\(\s*false\s*\)/);
    expect(pageSrc).toMatch(/if\s*\(\s*actionBusy\s*\)\s*return/);
    // Each of the three buttons must bind disabled={actionBusy}
    expect(pageSrc).toMatch(/disabled=\{actionBusy\}/);
  });

  test('9. rejection reason input is bound to local state + max 1000 chars', () => {
    // Backend rejects reason > 1000 chars (REASON_TOO_LONG). Mirror the
    // limit on the input so a user who pastes a giant blob gets cut off
    // before the round trip.
    expect(pageSrc).toMatch(/value=\{rejectReason\}/);
    expect(pageSrc).toMatch(/onChange=\{[^}]*setRejectReason[^}]*\}/);
    expect(pageSrc).toMatch(/maxLength=\{1000\}/);
  });

  test('10. useAuth destructure exposes isAdmin (DR-018 live regression guard)', () => {
    // DR-018 (2026-09-08) — a missing `isAdmin` in AuthContext's value
    // bounced every admin from admin-labelled routes. The destructure
    // here is the gate for the action bar; pin it so a future
    // AuthContext refactor that drops `isAdmin` fails this test instead
    // of silently demoting every admin to a no-actions viewer.
    expect(pageSrc).toMatch(/const\s*\{\s*accessToken\s*,\s*employee\s*,\s*isAdmin\s*\}\s*=\s*useAuth\(\s*\)/);
  });
});
