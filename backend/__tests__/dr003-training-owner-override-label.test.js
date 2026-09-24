// SOL DR-003 — an enrollment owner cannot label their own completion as
// administrator override.
//
// Audit source: ACS-Portal-Fresh-Product-Audit-2026-09-24-71f183a.md
// (DR-003, lines 104-114).
//
// Threat: validateCompletePayload accepts `evidenceClass: 'ADMIN_OVERRIDE'`
// as a valid enum value. The PUT /enrollments/:id/complete route then
// persists it as ADMIN_OVERRIDE_COMPLETED on the enrollment row. The row's
// `evidenceClass` column carries the authority claim, and the badge /
// reports surface it as "Admin override". The actual actor (completedBy)
// is still the employee, but the badge misleads anyone reading the row.
//
// Server-side authority for ADMIN_OVERRIDE lives in
// POST /enrollments/:id/admin-override, which is gated by requireFreshAdmin
// and a separate audit trail. The owner path cannot produce an admin
// actor, so ADMIN_OVERRIDE on the owner path is normalized to
// SELF_ATTESTED. completedBy still records the employee, which is the
// provenance signal the badge reads.
//
// Acceptance criteria:
//   - owner submitting { evidenceClass: 'ADMIN_OVERRIDE' } is normalized
//     to SELF_ATTESTED before markComplete() runs (no ADMIN_OVERRIDE label
//     persists from the owner path)
//   - admin submitting { evidenceClass: 'ADMIN_OVERRIDE' } on a non-owner
//     row still flows through the existing fresh-admin check unchanged
//   - the explicit PLAYER_OBSERVED / PROVIDER_VERIFIED rejection block is
//     preserved (DR-010 contract)

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';

const fs = require('fs');
const path = require('path');

const ROUTE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'training.js'),
  'utf8',
);

// Slice the manual-complete handler so the source-text pin stays local to
// the relevant code rather than matching the whole file. The /complete
// route is the one that accepts an owner-supplied evidenceClass.
const COMPLETE_START = ROUTE_SRC.indexOf("router.put('/enrollments/:id/complete'");
const COMPLETE_END = ROUTE_SRC.indexOf("router.put('/enrollments/:id/progress'", COMPLETE_START);
// Defensive: if a future refactor moves /progress above /complete, fall
// back to the next POST. Either way we want the slice to end before the
// admin-override route (which has its own ADMIN_OVERRIDE handling that
// MUST remain).
const sliceEnd = COMPLETE_END > COMPLETE_START
  ? COMPLETE_END
  : ROUTE_SRC.indexOf("router.post('/enrollments/:id/admin-override'", COMPLETE_START);
const COMPLETE_SLICE = ROUTE_SRC.slice(COMPLETE_START, sliceEnd);

describe('SOL DR-003 — owner-supplied ADMIN_OVERRIDE is normalized to SELF_ATTESTED', () => {
  test('1. manual-complete handler normalizes ADMIN_OVERRIDE when isOwner', () => {
    // The owner-path normalization must come AFTER the `let evidenceClass
    // = result.value.evidenceClass` assignment and BEFORE markComplete()
    // runs. This regex captures the canonical shape: an explicit branch
    // that, when isOwner is true and evidenceClass equals ADMIN_OVERRIDE,
    // rewrites the variable to SELF_ATTESTED.
    expect(COMPLETE_SLICE).toMatch(
      /isOwner\s*&&\s*evidenceClass\s*===\s*['"]ADMIN_OVERRIDE['"]/,
    );
    // The same branch must set evidenceClass back to SELF_ATTESTED —
    // anything else (return / throw / status change) would break the
    // owner self-attestation happy path.
    const branchIdx = COMPLETE_SLICE.indexOf("isOwner && evidenceClass === 'ADMIN_OVERRIDE'");
    expect(branchIdx).toBeGreaterThan(-1);
    const branchTail = COMPLETE_SLICE.slice(branchIdx, branchIdx + 1200);
    expect(branchTail).toMatch(/evidenceClass\s*=\s*['"]SELF_ATTESTED['"]/);
  });

  test('2. normalization branch is gated on isOwner (admin path is untouched)', () => {
    // The fix must not blanket-reject ADMIN_OVERRIDE — admin callers on a
    // non-owner row still need ADMIN_OVERRIDE to flow through to
    // markComplete() so it can persist ADMIN_OVERRIDE_COMPLETED with the
    // admin actor. Pin: the new branch condition includes isOwner (and
    // does NOT have an unconditional rejection of ADMIN_OVERRIDE for
    // every caller).
    expect(COMPLETE_SLICE).not.toMatch(
      /evidenceClass\s*===\s*['"]ADMIN_OVERRIDE['"]\s*\)\s*\{[^}]*return\s+res\.status/,
    );
  });

  test('3. PLAYER_OBSERVED + PROVIDER_VERIFIED rejection block is preserved', () => {
    // DR-010 contract: the player/provider paths are exclusive to
    // PUT /progress. DR-003 only adds a normalization branch; it must
    // not swallow or weaken the existing 400 EVIDENCE_REQUIRED
    // rejection for those two classes on the /complete route.
    expect(COMPLETE_SLICE).toMatch(
      /evidenceClass\s*===\s*['"]PLAYER_OBSERVED['"][\s\S]*evidenceClass\s*===\s*['"]PROVIDER_VERIFIED['"][\s\S]*code:\s*['"]EVIDENCE_REQUIRED['"]/,
    );
  });

  test('4. default-branch evidence-class derivation is preserved', () => {
    // Pin: when evidenceClass is omitted, owners still default to
    // SELF_ATTESTED and admins still default to ADMIN_OVERRIDE. The fix
    // only intercepts an EXPLICIT owner-supplied override label.
    expect(COMPLETE_SLICE).toMatch(
      /evidenceClass\s*=\s*isOwner\s*\?\s*['"]SELF_ATTESTED['"]\s*:\s*['"]ADMIN_OVERRIDE['"]/,
    );
  });

  test('5. fix is documented with the DR-003 attribution comment', () => {
    // Regression guard for the audit attribution: the comment block
    // naming DR-003 must sit inside the /complete handler so a future
    // move/rename of the route is caught at test time.
    expect(COMPLETE_SLICE).toMatch(/DR-003/);
  });

  test('6. admin-override route still hard-sets ADMIN_OVERRIDE (no regression)', () => {
    // The dedicated admin-override POST is the legitimate writer for the
    // ADMIN_OVERRIDE label. Pin: it must still write ADMIN_OVERRIDE
    // (not SELF_ATTESTED) — DR-003 only addresses the owner path on
    // PUT /complete.
    const adminStart = ROUTE_SRC.indexOf("router.post('/enrollments/:id/admin-override'");
    expect(adminStart).toBeGreaterThan(-1);
    const adminSlice = ROUTE_SRC.slice(adminStart, adminStart + 4000);
    expect(adminSlice).toMatch(/ADMIN_OVERRIDE/);
  });
});
