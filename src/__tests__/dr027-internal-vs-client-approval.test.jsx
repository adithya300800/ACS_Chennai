// DR-027 (audit, 2026-09-08) — Internal approval is not clearly
// distinguished from client authority.
//
// Audit findings:
//   1. A Variation Order reached APPROVED while Client approval
//      required remained true and no client decision/evidence step
//      was used. The audit noted the product "may intentionally
//      record internal approval" — that's a defensible choice —
//      "but the current language does not establish external
//      authorization".
//   2. The variation timeline row rendered a generic "Approved"
//      label for any admin approval, regardless of whether the
//      variation was flagged for client authorization.
//
// Source-text contracts pin:
//   - When status===APPROVED AND clientApprovalRequired is true,
//     the timeline label splits to "Internal approval" so a billing
//     engineer reading the timeline understands the client
//     authorization step is still owed.
//   - The metadata block shows "Required — pending decision" in
//     orange when the VO is APPROVED-but-client-pending so the
//     gap is visible at the top of the detail page too.
//   - A yellow footer banner restates the gate ("cannot be invoiced
//     until the client authorises the change").
//
// Run: cd src && npx jest __tests__/dr027-internal-vs-client-approval.test.jsx
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const voDetailPath = resolvePath(__dirname, '../pages/VariationOrderDetail.jsx');
const voDetailSrc = readFileSync(voDetailPath, 'utf8');

describe('DR-027 — internal vs client approval labels', () => {
  test('1. Timeline "Approved" label switches to "Internal approval" when clientApprovalRequired', () => {
    expect(voDetailSrc).toMatch(/variation\.status\s*===\s*['"]APPROVED['"][\s\S]*?<strong>\{variation\.clientApprovalRequired\s*\?\s*['"]Internal approval['"]\s*:\s*['"]Approved['"]\}/);
  });

  test('2. Footer banner explains the invoicing gate when clientApprovalRequired', () => {
    // The yellow callout is rendered inside the same <li> as the
    // APPROVED timeline row, gated on clientApprovalRequired. The
    // exact copy explains WHY the variation can't be invoiced yet.
    // [DR-033] The opener switched from "Client decision pending"
    // (which inferred a fact the portal does not track) to "Client
    // approval required — tracked outside this portal." The
    // invoicing-gate clause that this test was actually pinning is
    // preserved verbatim. (Source uses capital "This" — the regex
    // mirrors it exactly.)
    expect(voDetailSrc).toMatch(/tracked outside this portal[\s\S]*?This variation cannot be invoiced/);
  });

  test('3. Metadata block shows "Required — tracked outside this portal" when status=APPROVED & clientApprovalRequired', () => {
    // [DR-033] "Required — pending decision" was misleading: the
    // portal has no model + no action to record a client decision,
    // so "pending" inferred a fact the system does not track. The
    // new copy is honest about that.
    expect(voDetailSrc).toMatch(/Required\s*—\s*tracked outside this portal/);
    expect(voDetailSrc).toMatch(/variation\.clientApprovalRequired\s*\?\s*\([\s\S]*?Required\s*—\s*tracked outside this portal[\s\S]*?\)/);
  });

  test('4. The audit\'s "execution gate" language is present', () => {
    // The audit asks for "a downstream execution gate" — the
    // footer explicitly says the variation CANNOT be invoiced
    // until client authorisation. Even without the schema-level
    // gating, the language makes the gap visible to any user.
    expect(voDetailSrc).toMatch(/cannot be invoiced until/i);
  });
});
