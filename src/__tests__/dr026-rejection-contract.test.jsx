// DR-026 (audit, 2026-09-08) — rejection has no explicit correction or
// terminal-disposal contract.
//
// Audit findings:
//   1. A rejected DPR silently omitted the rejection reason in the
//      My-DPRs detail modal — the employee saw "REJECTED" with no
//      context. The bell notification carried the reason, but the
//      detail page did not (DprList.jsx detail modal at line 838+).
//   2. There was no correction/resubmission action. The backend treats
//      REJECTED as a terminal state (backend/src/routes/dpr.js:1593 —
//      409 on PUT after REJECTED), so correction must happen by filing
//      a NEW report for a DIFFERENT reportDate, not by editing the
//      rejected snapshot.
//
// Source-text contracts pin:
//   - The DprList employee detail modal now renders the rejection
//     reason inline for status=REJECTED rows.
//   - The terminal-contract footer tells the employee what to do next
//     (file a new report for a different date, or contact the reviewer).
//
// Run: cd src && npx jest __tests__/dr026-rejection-contract.test.jsx
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const dprListPath = resolvePath(__dirname, '../pages/portal/DprList.jsx');
const dprListSrc = readFileSync(dprListPath, 'utf8');

describe('DR-026 — rejection correction / terminal contract', () => {
  test('1. DprList employee detail modal renders rejection reason inline', () => {
    // Pin the exact status gate so a future rename of the enum value
    // fires this test (the value is uppercase in the rest of the file).
    expect(dprListSrc).toMatch(/expandedDpr\.status\s*===\s*['"]REJECTED['"]/);
    // The modal renders the rejectionReason text in plain text — not
    // hidden behind a tooltip or behind a "click to view" affordance.
    expect(dprListSrc).toMatch(/\{expandedDpr\.rejectionReason\s*&&\s*\(/);
    // Mirror the admin DprAll pattern — adminNotes are optional secondary.
    expect(dprListSrc).toMatch(/expandedDpr\.adminNotes\s*&&/);
  });

  test('2. The detail modal declares an explicit next-allowed-action footer', () => {
    // The audit-required text: tell the employee that rejection is
    // terminal AND what they should do next.
    expect(dprListSrc).toMatch(/file a new report for a different date/);
    // The audit also required "Show the actual rejecting actor" — the
    // dropdown row in the modal already shows "Submitted by" but for
    // rejection we surface the reviewer. Pin the new line:
    expect(dprListSrc).toMatch(/Rejected by reviewer/);
  });

  test('3. The rejection banner uses the same alert pattern as DprAll / InspectionDetail', () => {
    // Same role="alert" + red-tinted bg / border-left / color combination
    // so visual language stays consistent across modules.
    expect(dprListSrc).toMatch(/role="alert"/);
    expect(dprListSrc).toMatch(/#fef2f2/);
    expect(dprListSrc).toMatch(/#fecaca/);
    expect(dprListSrc).toMatch(/var\(--danger/);
  });
});
