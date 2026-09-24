// DR-021 — Bulk DPR execution can include records absent from the confirmation
//
// Audit finding (Fresh-Product-Audit-2026-09-24-71f183a.md, lines 322-332):
//   Selection resets on status but can survive other scope/page changes.
//   Confirmation displays the visible intersection, while execution sends
//   all selected IDs.
//
// Acceptance: Select A, change scope, confirm visible B: hidden A is never
//   mutated. Counts, record labels and request IDs agree.
//
// Minimal implementation (per audit): "Clear selection when scope changes,
// as the inspection dashboard already does."
//
// Why source-text instead of a full mount:
//   DprDashboard pulls in AuthContext + ToastContext + api.js (with global
//   fetch wrapper) + react-router. A mount would require mocking every
//   one of those, and a structural regression in the reset hook would not
//   necessarily break the mock-stripped render. The structural fix lives in
//   the dependency array of the `setSelectedIds` reset useEffect, so we
//   pin that array as source text — same approach as the other DR-NNN
//   regression tests (dr032, dr040, dr020 etc).

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const dprDashboardPath = resolvePath(__dirname, '../pages/admin/DprDashboard.jsx');
const source = readFileSync(dprDashboardPath, 'utf8');

describe('DR-021 — DprDashboard clears bulk selection on every scope filter change', () => {
  test('the setSelectedIds reset effect lists all four scope filters in its dependency array', () => {
    // Find the useEffect that calls setSelectedIds(new Set()). The audit
    // requires that ALL scope filters (status, project, from, to) clear
    // the selection — not just status (filter). Mirror the InspectionDashboard
    // pattern (5 filters there, because it also has filterType).
    //
    // We anchor the match on `setSelectedIds(new Set())` (the clearing
    // call) and assert that the next-line dependency array includes all
    // four scope-filter identifiers. Regex is loose enough to allow
    // comment changes between the call and the array.
    const match = source.match(
      /setSelectedIds\(new Set\(\)\)([\s\S]{0,400}?)\[filter,\s*projectFilter,\s*fromFilter,\s*toFilter\]/
    );
    expect(match).not.toBeNull();
  });

  test('the reset effect also clears the pending confirmation dialog on scope change', () => {
    // Audit says: "invalidate the dialog on context change." The bulk
    // confirmation captures ids:[...selectedIds] at click time, but the
    // handler `runConfirmedAction -> handleBulkAction -> [...selectedIds]`
    // reads from current state — so if scope changes between open and
    // confirm, the dialog would target a stale set. Closing it via
    // setConfirmAction(null) inside the same reset hook keeps the
    // confirmation list a faithful preview of what will be executed.
    const match = source.match(
      /setSelectedIds\(new Set\(\)\)([\s\S]{0,400}?)\[filter,\s*projectFilter,\s*fromFilter,\s*toFilter\]/
    );
    expect(match).not.toBeNull();
    // The matched region (between the reset call and the dep array) must
    // include a setConfirmAction(null) call.
    expect(match[1]).toMatch(/setConfirmAction\(\s*null\s*\)/);
  });

  test('a comment block cites DR-021 so the next reader knows why this hook exists', () => {
    // Pin the audit citation so a future cleanup doesn't drop the
    // dep list back to `[filter]` thinking it was over-cautious.
    const match = source.match(
      /\/\/[^\n]*DR-021[\s\S]{0,1200}?\[filter,\s*projectFilter,\s*fromFilter,\s*toFilter\]/
    );
    expect(match).not.toBeNull();
  });

  test('the bulk confirmation captures an immutable ids array at click time (unchanged)', () => {
    // The audit also requires: "Capture an immutable displayed ID set
    // and reason when opening confirmation." Verify the three bulk
    // buttons still snapshot ids:[...selectedIds] — the captured set is
    // what the confirmation list renders against.
    const bulkCaptures = source.match(/kind:\s*'bulk'[\s\S]{0,300}?ids:\s*\[\.\.\.selectedIds\]/g) || [];
    // Three bulk actions: Mark for Review, Approve, Reject.
    expect(bulkCaptures.length).toBeGreaterThanOrEqual(3);
  });
});