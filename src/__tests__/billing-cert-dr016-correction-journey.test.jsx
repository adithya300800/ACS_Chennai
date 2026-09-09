// DR-016 (audit, 2026-09-08) — COP correction needs an editable,
// reversible correction journey.
//
// Audit verdict (Code review by SOL/ACS-Portal-Repair-Reassessment-
// 2026-09-08-7cc65ca.md, lines 409-425):
//
//   "Correct certification created a DRAFT with copied amounts and no PDF,
//    immediately superseded the original, and opened read-only detail.
//    There was no Edit, previous-version navigation, or cancel/restore
//    action."
//
// Acceptance for this round:
//   1. Correction DRAFT is editable — the existing form modal can be
//      re-opened in PATCH mode, prefilled from the DRAFT's stored
//      values (amounts / remarks / attachment metadata).
//   2. Previous-version navigation exists — the detail modal exposes a
//      "View original" button when parentCertificationId is set, that
//      loads the parent row in place.
//   3. Cancel / abandon exists — the DRAFT correction can be soft-
//      deleted (Abandon correction), with explicit messaging that the
//      original stays superseded (no silent cancellation on close).
//   4. Edit / abandon submit against the existing PATCH / DELETE
//      endpoints; the version pin on edit matches the DR-015 wire
//      shape (`expectedVersion` in the body).
//   5. The original's PDF remains reachable from the detail modal
//      (it carries blobPath / filename; the existing handleViewPdf
//      flow stays unchanged).
//
// Pin these against the source file so a future refactor cannot
// silently drop the new correction-journey controls.
//
// Note: this suite is mount-free per the App.test.jsx header
// (PortalLayout exhausts jest memory). It greps the source-text of
// src/pages/admin/BillingCertificationsAdmin.jsx for the wire
// contracts that drive the admin detail modal + the form modal.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const pagePath = resolvePath(
  __dirname,
  '../pages/admin/BillingCertificationsAdmin.jsx',
);
const pageSrc = readFileSync(pagePath, 'utf8');

describe('DR-016 — COP correction DRAFT is editable / navigable / reversible (admin page)', () => {
  test('1. CertificationFormModal accepts a `mode` prop and an `initialCert` prop for edit-mode pre-fill', () => {
    // The form modal's function signature carries the edit-mode
    // props (mode + initialCert + expectedVersion) so the PATCH
    // submit branch fires when opened from the detail modal.
    expect(pageSrc).toMatch(/function\s+CertificationFormModal\s*\(/);
    expect(pageSrc).toMatch(
      /function\s+CertificationFormModal\s*\(\s*\{[\s\S]*?mode\s*=\s*['"]create['"][\s\S]*?initialCert\s*=\s*null[\s\S]*?expectedVersion\s*=\s*null/s,
    );
  });

  test('2. Edit-mode submit calls updateBillingCertification (PATCH) — not createBillingCertification', () => {
    // The submit handler branches on mode: 'edit' → PATCH; 'create'
    // → POST. The PATCH wrapper already exists in src/lib/api.js
    // (line ~1034, DR-015) and accepts the same payload shape plus
    // expectedVersion.
    expect(pageSrc).toMatch(
      /mode\s*===\s*['"]edit['"][\s\S]*?api\.updateBillingCertification\(\s*initialCert\.id[\s\S]*?\)/,
    );
    expect(pageSrc).toMatch(
      /api\.updateBillingCertification\(\s*initialCert\.id\s*,\s*payload\s*,\s*accessToken\s*\)/,
    );
  });

  test('3. Edit-mode payload pins expectedVersion so a stale tab cannot overwrite a concurrent write on the same DRAFT', () => {
    // The wire shape mirrors DR-015: `expectedVersion` is included
    // in the PATCH body when in edit mode and the displayed version
    // is non-null. Backend PATCH reads this field and stamps it on
    // the conditional WHERE (see backend/src/routes/billingCertifications.js).
    expect(pageSrc).toMatch(
      /mode\s*===\s*['"]edit['"][\s\S]*?expectedVersion\s*!=\s*null\s*\?\s*\{\s*expectedVersion\s*\}\s*:\s*\{\}/,
    );
  });

  test('4. Detail modal renders an "Edit DRAFT" button when the row is a non-superseded DRAFT', () => {
    // The button is gated on status === 'DRAFT' && !supersededAt so
    // it never appears on a CERTIFIED / DISPUTED / superseded row.
    // Pin both the conditional AND the button label so the audit's
    // "no Edit" defect is regression-protected.
    expect(pageSrc).toMatch(
      /detailCert\.status\s*===\s*['"]DRAFT['"][\s\S]*?!detailCert\.supersededAt[\s\S]*?Edit DRAFT/,
    );
    // The button wires to a handler that opens the modal in edit
    // mode — pin the testid so a future refactor cannot silently
    // drop the entry point.
    expect(pageSrc).toMatch(/data-testid="bc-edit-draft"/);
    expect(pageSrc).toMatch(/onClick=\{\(\)\s*=>\s*openEdit\(detailCert\)\}/);
  });

  test('5. Detail modal renders a "View original" button when parentCertificationId is set', () => {
    // The chain-walk is gated on parentCertificationId existing —
    // non-correction rows never expose the button.
    expect(pageSrc).toMatch(
      /detailCert\.parentCertificationId[\s\S]*?View original/,
    );
    expect(pageSrc).toMatch(/data-testid="bc-view-original"/);
    // The handler loads the parent row in place — the detail modal
    // swaps to the loaded cert so the chain is walkable forward and
    // backward.
    expect(pageSrc).toMatch(/openOriginal/);
    expect(pageSrc).toMatch(
      /api\.getBillingCertification\(\s*parentId\s*,\s*accessToken\s*\)/,
    );
  });

  test('6. Detail modal renders an "Abandon correction" button gated on DRAFT + parent link', () => {
    // Only correction DRAFTs expose the abandon button — a stand-
    // alone DRAFT (never corrected from anything) must not show it,
    // and a CERTIFIED / DISPUTED / superseded row must not show it.
    expect(pageSrc).toMatch(
      /detailCert\.status\s*===\s*['"]DRAFT['"][\s\S]*?detailCert\.parentCertificationId[\s\S]*?Abandon correction/,
    );
    expect(pageSrc).toMatch(/data-testid="bc-abandon-correction"/);
  });

  test('7. Abandon correction calls the existing DELETE wrapper (soft-delete via deletedAt)', () => {
    // The fix reuses the existing DELETE endpoint — no new backend
    // route is added. The wire shape is `api.deleteBillingCertification
    // (id, token)`. The original stays superseded (the supersede
    // stamp does NOT auto-revert).
    expect(pageSrc).toMatch(
      /api\.deleteBillingCertification\(\s*abandoningCert\.id\s*,\s*accessToken\s*\)/,
    );
    expect(pageSrc).toMatch(/setAbandoningCert/);
  });

  test('8. Abandon confirmation modal explicitly warns the original stays superseded', () => {
    // "Closing is not silently treated as cancellation" — the abandon
    // confirm dialog must include the explicit warning. Pin the
    // substring so a future copy edit cannot drop it.
    expect(pageSrc).toMatch(/stays\s*<strong>\s*superseded\s*<\/strong>/);
    expect(pageSrc).toMatch(/abandoning a correction does not[\s\S]*?restore the original/);
    expect(pageSrc).toMatch(/data-testid="bc-abandon-confirm"/);
    expect(pageSrc).toMatch(/data-testid="bc-abandon-confirm-btn"/);
  });

  test('9. Edit modal initial state pre-fills from initialCert (numeric fields, billDate, attachment metadata)', () => {
    // The pre-fill helper maps each DRAFT field onto the form shape:
    // numeric fields round-trip via String() (so the user can clear
    // / retype), billDate passes through as YYYY-MM-DD, attachment
    // metadata is shown in the form footer ("Current: filename")
    // and is only replaced when the user picks a new file.
    expect(pageSrc).toMatch(
      /function\s+initialiseFormState\(\s*initialCert\s*,\s*mode\s*\)/,
    );
    expect(pageSrc).toMatch(/c\.billDate\s*\|\|\s*todayLocalDate\(\)/);
    expect(pageSrc).toMatch(/c\.claimedAmount\s*!=\s*null\s*\?\s*String\(c\.claimedAmount\)/);
    // Show existing attachment in edit mode + warn that empty input
    // means "keep the existing PDF".
    expect(pageSrc).toMatch(/Current:\s*\{initialCert\.filename\}/);
    expect(pageSrc).toMatch(/leave the field empty to keep this attachment/);
  });

  test('10. Edit modal title + submit button label flip to "Edit correction" / "Save correction"', () => {
    // Title and submit label both reflect edit mode so the admin
    // does not mistake the PATCH flow for a new POST. The em-dash
    // in the title is matched via its literal code-point — JS regex
    // /-u/ handles Unicode em-dash directly.
    expect(pageSrc).toMatch(
      /Edit correction DRAFT[^\n]+\{initialCert\?\.billNumber/,
    );
    expect(pageSrc).toMatch(/Save correction/);
  });

  test('11. Edit-mode project select is disabled so the parent/child chain identity is preserved', () => {
    // The correction DRAFT already carries the original's projectId
    // forward verbatim. Allowing project changes inside the edit
    // modal would break the parent/child relationship — the field
    // is therefore read-only in edit mode.
    expect(pageSrc).toMatch(
      /disabled=\{projectsLoading\s*\|\|\s*submitting\s*\|\|\s*mode\s*===\s*['"]edit['"]\}/,
    );
  });

  test('12. Edit-mode onSaved refreshes detailCert in place when the detail modal is on the same row', () => {
    // If the admin edits a row while the detail modal is open on
    // it, the modal must swap to the saved row so the post-edit
    // amounts / version render without a manual reload.
    expect(pageSrc).toMatch(
      /detailCert\s*&&\s*detailCert\.id\s*===\s*saved\.id[\s\S]*?setDetailCert\(saved\)/,
    );
    // And the mutation still refreshes the list + aggregates
    // (DR-029 invariant).
    expect(pageSrc).toMatch(/await\s+fetchCerts\(\)/);
    expect(pageSrc).toMatch(/await\s+fetchAggregates\(\)/);
  });
});
