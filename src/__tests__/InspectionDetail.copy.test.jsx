// [§8.4 Fresh24 audit, 2026-09-24] — NCR review state vs filing
// condition labels.
//
// The audit caught an NCR row whose top-level review state was CLOSED
// beside an embedded `Status: Open` field from the filing form — both
// labelled "Status", both visible side-by-side. The two concepts are
// distinct:
//
//   • Top-level `record.status`  — workflow / review state mutated by
//     the admin ack/close/reject action bar (OPEN, ACKNOWLEDGED,
//     IN_PROGRESS, PENDING_VERIFICATION, CLOSED, REJECTED).
//   • Embedded `record.data.status` — the engineer-reported filing
//     condition (Open / In Progress / Pending Verification / Closed /
//     Rejected at time of filing).
//
// Post-fix:
//   • The top-level badge sits under an explicit "Review state" heading.
//   • The embedded data row's `status` key is relabelled "Reported
//     condition" so it can't be visually conflated with the review
//     state. Same vocabulary as BillingCertificationsAdmin's
//     "Certification — Bill X" / status split.
//
// Source-text pins (mount-free per InspectionDetail.admin-actions.test.jsx
// header). The page is not rendered — the audit's complaint was about
// the rendered label vocabulary, so pin the JSX that produces the labels.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const pagePath = resolvePath(__dirname, '../pages/portal/InspectionDetail.jsx');
const pageSrc = readFileSync(pagePath, 'utf8');

describe('§8.4 Fresh24 — InspectionDetail distinguishes review state from filing condition', () => {
  test('1. "Review state" label is rendered above the top-level status badge', () => {
    // The audit's first requirement: explicit "Review state" heading
    // sits beside the workflow badge so the reader sees the label
    // BEFORE they read the state value (not after).
    expect(pageSrc).toMatch(/Review state/);
  });

  test('2. the top-level review badge is rendered alongside the new heading', () => {
    // The badge label is the review state value (CLOSED, OPEN, etc.)
    // — the same label that pre-existed, just visually paired with
    // the "Review state" heading now. The badge rendering still uses
    // `record.status` and humanises the workflow enum via
    // `.replace(/_/g, ' ')`. We don't pin the exact adjacency — the
    // "Review state" heading is in the same flex column as the badge
    // in the JSX, which the runtime renderer enforces.
    expect(pageSrc).toMatch(/Review state/);
    expect(pageSrc).toMatch(/record\.status/);
    expect(pageSrc).toMatch(/dpr-status-/);
  });

  test('3. the embedded `status` key is relabelled "Reported condition"', () => {
    // The structured-fields loop overrides `key === 'status'` so the
    // embedded filing condition renders as "Reported condition: …",
    // not "Status: …". This is the audit's specific fix.
    expect(pageSrc).toMatch(/key\s*===\s*['"]status['"]\s*\?\s*['"]Reported condition['"]/);
  });

  test('4. both labels are visible in the rendered output paths', () => {
    // "Review state" + "Reported condition" both appear in the JSX —
    // when an NCR row carries both a review badge (record.status) and
    // a filing-condition field (record.data.status), the page surfaces
    // BOTH labels so the engineer can tell the two apart.
    expect(pageSrc).toMatch(/Review state/);
    expect(pageSrc).toMatch(/Reported condition/);
  });

  test('5. the literal `Status: Open` pattern is broken for embedded filings', () => {
    // Pre-fix the structured-fields loop called labelize('status')
    // which produced "Status" — so a record.data.status of "Open"
    // rendered as "Status: Open" in the same paragraph as the
    // top-level CLOSED review badge. Post-fix the embedded row's
    // label is overridden to "Reported condition" before the colon,
    // so "Status: Open" no longer appears in the structured-fields
    // render path. The labelize function itself still exists for
    // OTHER keys (camelCase → Title Case), so we pin the specific
    // override path instead of forbidding the function.
    //
    // Specifically: the override ternary must short-circuit the
    // `status` key BEFORE labelize fires.
    expect(pageSrc).toMatch(
      /const\s+label\s*=\s*key\s*===\s*['"]status['"]\s*\?\s*['"]Reported condition['"]\s*:\s*labelize\(key\)/,
    );
    // The override must be applied at the render site, not as a
    // global labelize patch — labelize stays generic.
    expect(pageSrc).toMatch(/labelize\(key\)/);
  });

  test('6. label vocabulary matches BillingCertificationsAdmin (consistency)', () => {
    // The audit asked us to use the same label vocabulary as the
    // Billing Certifications register. That page uses short uppercase
    // section headers (e.g. "Certification — Bill X", "Certified
    // liability", "Disputed amounts"). "Review state" + "Reported
    // condition" follow the same short-direct convention.
    //
    // Both new labels live in InspectionDetail.jsx (not in the
    // billing page) — but neither should drift back to a verbose
    // phrasing like "Review state (workflow)" or "Filing condition".
    expect(pageSrc).not.toMatch(/Review state\s*\(workflow\)/);
    expect(pageSrc).not.toMatch(/Filing condition/);
  });
});
