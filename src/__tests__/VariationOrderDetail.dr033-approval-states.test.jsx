// DR-033 (audit, 2026-09-24) — Client-approval display represents an
// untracked decision as pending.
//
// Audit findings:
//   1. An internally approved variation with clientApprovalRequired=true
//      rendered "Client decision pending" / "Required — pending decision"
//      even when no decision has actually been recorded offline — the
//      requirement flag was being promoted to a *state* claim the system
//      does not track.
//   2. There is no client-decision model or action in the schema, so the
//      portal cannot honestly say a decision is pending. Saying so
//      inferred a fact the system does not know.
//
// Resolution (minimal): the UI is rewritten to say it explicitly does
// not track that fact — "tracked outside this portal" — instead of
// "pending decision". The invoicing gate (cannot-be-invoiced-until)
// is preserved verbatim so DR-027's downstream-execution contract
// is not weakened. No schema migration, no new admin action.
//
// Source-text contracts pin:
//   - The timeline yellow banner now opens with "Client approval
//     required — tracked outside this portal" rather than
//     "Client decision pending".
//   - The "cannot be invoiced" gate clause (DR-027 test 4) is
//     preserved verbatim so a billing engineer still sees the
//     execution gap.
//   - The metadata "Required — pending decision" label is replaced
//     with "Required — tracked outside this portal".
//   - When status is APPROVED but clientApprovalRequired is false,
//     the label is still "Approved" (the DR-027 plain-Approved path
//     is not regressed).
//   - The banner is gated by both status===APPROVED and
//     clientApprovalRequired — non-APPROVED statuses must not show
//     the misleading copy.
//
// Run: cd src && npx jest __tests__/VariationOrderDetail.dr033-approval-states.test.jsx
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const voDetailPath = resolvePath(__dirname, '../pages/VariationOrderDetail.jsx');
const voDetailSrc = readFileSync(voDetailPath, 'utf8');

describe('DR-033 — client-approval display does not infer a tracked decision', () => {
  test('1. Timeline banner for APPROVED+clientApprovalRequired says "tracked outside this portal"', () => {
    // The yellow callout inside the APPROVED timeline row must no
    // longer claim a decision is "pending" — that word infers a
    // fact the portal does not record. The honest copy states the
    // fact that the decision is tracked outside this portal.
    expect(voDetailSrc).toMatch(/Client approval required\s*—\s*tracked outside this portal/);
  });

  test('2. The "this variation cannot be invoiced" gate clause is preserved (DR-027 not weakened)', () => {
    // DR-027's downstream-execution contract says a billing
    // engineer must see WHY the variation cannot be invoiced.
    // DR-033 narrows the wording above this clause; it must NOT
    // delete the gate clause itself. (Source uses capital "This" —
    // the regex mirrors that exactly so it doesn't drift on case
    // if anyone re-phrases the sentence later.)
    expect(voDetailSrc).toMatch(/tracked outside this portal[\s\S]*?This variation cannot be invoiced/);
    expect(voDetailSrc).toMatch(/cannot be invoiced until/i);
  });

  test('3. Metadata label "Required — pending decision" is replaced with "Required — tracked outside this portal"', () => {
    // Old copy is gone — the old "pending decision" wording
    // inferred an untracked state and is the literal bug.
    expect(voDetailSrc).not.toMatch(/Required\s*—\s*pending decision/);
    // New copy is in the ternary on the APPROVED+required arm.
    expect(voDetailSrc).toMatch(/variation\.clientApprovalRequired\s*\?\s*\([\s\S]*?Required\s*—\s*tracked outside this portal[\s\S]*?\)/);
  });

  test('4. When clientApprovalRequired is false, the metadata label stays "Not required"', () => {
    // DR-027 contract — the "Not required" branch must not be
    // touched by the DR-033 copy change.
    expect(voDetailSrc).toMatch(/variation\.clientApprovalRequired\s*\?\s*\([\s\S]*?['"]Not required['"]/);
  });

  test('5. The yellow banner remains gated on status===APPROVED — DRAFT/SUBMITTED/REJECTED must not show the new copy outside the timeline', () => {
    // The new "tracked outside this portal" copy lives ONLY in the
    // timeline yellow banner (gated on status===APPROVED) and in
    // the metadata block's APPROVED arm. We assert the banner copy
    // appears inside an APPROVED-gated block, not bare in the file.
    // Find the APPROVED block — the copy should be inside it.
    const approvedMatch = voDetailSrc.match(/variation\.status\s*===\s*['"]APPROVED['"][\s\S]*?<\/li>/);
    expect(approvedMatch).not.toBeNull();
    expect(approvedMatch[0]).toMatch(/tracked outside this portal/);
  });

  test('6. DR-027 plain-Approved label ("Approved" when clientApprovalRequired is false) is not regressed', () => {
    // The ternary still distinguishes "Internal approval" vs
    // "Approved" — DR-027's primary contract. DR-033 only
    // narrows surrounding copy; it must not regress this split.
    expect(voDetailSrc).toMatch(/variation\.clientApprovalRequired\s*\?\s*['"]Internal approval['"]\s*:\s*['"]Approved['"]/);
  });
});