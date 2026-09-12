// S7/MyReports — admin review state machine for project attachments.
//
// User feedback (2026-09-12): the Project Reports page exposed upload +
// list + download + delete but admins had no way to Approve / Request
// Revision / Reject a submitted report. Every uploaded report sat in
// the same implicit "unreviewed" state forever.
//
// Backend contract (backend/src/routes/projectAttachments.js#PATCH):
//
//   requireFreshAdmin                   → 403 NOT_ADMIN for non-admins
//   target in {APPROVED, REVISION_REQUESTED, REJECTED} → 400 INVALID_STATUS
//   REVISION_REQUESTED + REJECTED require non-empty reviewNotes
//                                          → 400 REVIEW_NOTES_REQUIRED
//   state machine:
//     PENDING_REVIEW     → APPROVED | REVISION_REQUESTED | REJECTED
//     REVISION_REQUESTED → APPROVED | REJECTED
//     APPROVED / REJECTED → terminal (409 INVALID_TRANSITION)
//   atomic stamp: status + reviewedById + reviewedAt + reviewNotes
//
// This is a SOURCE-TEXT test (not a full integration suite) — it pins
// the wire contract so a future refactor that drops a Set entry, drops
// the requireFreshAdmin gate, or re-orders the validation pipeline
// fails this test instead of silently shipping a regression.
//
// The integration coverage (mocked Prisma, real request → response)
// lives in the existing project-attachments.test.js; here we pin the
// non-negotiable structural pieces that must stay aligned with the
// MyProjectReports + ReportSection UI sources.

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';

const { readFileSync } = require('fs');
const { resolve: resolvePath } = require('path');

const routePath = resolvePath(__dirname, '../src/routes/projectAttachments.js');
const schemaPath = resolvePath(__dirname, '../prisma/schema.prisma');
const migrationPath = resolvePath(
  __dirname,
  '../prisma/migrations/20260912070000_s7_project_attachment_review/migration.sql',
);
const routeSrc = readFileSync(routePath, 'utf8');
const schemaSrc = readFileSync(schemaPath, 'utf8');
const migrationSrc = readFileSync(migrationPath, 'utf8');

describe('S7/MyReports — admin review state machine contracts', () => {
  test('1. PATCH /:attachmentId route is registered with requireFreshAdmin gate', () => {
    // requireFreshAdmin (NOT requireAdmin) — the fresh-DB-read contract
    // mirrors the DR-001 / R36 mutator pattern. A JWT carrying stale
    // isAdmin=true after an admin was demoted would otherwise be
    // trusted; the fresh re-read closes that gap.
    expect(routeSrc).toMatch(
      /router\.patch\(\s*['"]\/:attachmentId['"]\s*,\s*requireFreshAdmin\s*,\s*asyncHandler/,
    );
  });

  test('2. PATCH handler validates target status against the allowed set', () => {
    // The body must be one of APPROVED | REVISION_REQUESTED | REJECTED.
    // Anything outside the set is a 400 INVALID_STATUS (NOT a 500 from
    // a Prisma enum cast failure).
    expect(routeSrc).toMatch(
      /const\s+ALLOWED_TARGETS\s*=\s*new Set\(\s*\[\s*['"]APPROVED['"]\s*,\s*['"]REVISION_REQUESTED['"]\s*,\s*['"]REJECTED['"]\s*\]\s*\)/,
    );
    expect(routeSrc).toMatch(/INVALID_STATUS/);
  });

  test('3. reviewNotes is required for REVISION_REQUESTED + REJECTED', () => {
    // The trim + length-cap is a single block; the missing-notes gate
    // fires before the DB write. Pin the gate so a future refactor that
    // makes notes optional for the wrong branch is caught here.
    expect(routeSrc).toMatch(
      /REVISION_REQUESTED['"]\s*\|\|\s*nextStatus\s*===\s*['"]REJECTED['"]\s*\)\s*&&\s*!reviewNotes/,
    );
    expect(routeSrc).toMatch(/REVIEW_NOTES_REQUIRED/);
  });

  test('4. state machine: PENDING_REVIEW → {APPROVED, REVISION_REQUESTED, REJECTED}', () => {
    // Mirrors the InspectionDetail ALLOWED_FROM Sets — keeps wire + UI
    // aligned by source-text contract.
    expect(routeSrc).toMatch(
      /PENDING_REVIEW\s*:\s*new Set\(\s*\[\s*['"]APPROVED['"]\s*,\s*['"]REVISION_REQUESTED['"]\s*,\s*['"]REJECTED['"]\s*\]\s*\)/,
    );
  });

  test('5. state machine: REVISION_REQUESTED → {APPROVED, REJECTED}', () => {
    // A revised copy that the admin accepts closes the review with
    // APPROVED; if the revised copy is still unacceptable the admin
    // can reject directly. Re-revising would be circular noise.
    expect(routeSrc).toMatch(
      /REVISION_REQUESTED\s*:\s*new Set\(\s*\[\s*['"]APPROVED['"]\s*,\s*['"]REJECTED['"]\s*\]\s*\)/,
    );
  });

  test('6. APPROVED + REJECTED are terminal (empty transition sets)', () => {
    // A closed review cannot be silently re-opened. Returning empty
    // Sets makes every would-be transition return 409 INVALID_TRANSITION.
    // Allow both `new Set()` and `new Set([])` shapes — both are valid
    // empty-Sets and the route file currently uses the former.
    expect(routeSrc).toMatch(/APPROVED\s*:\s*new Set\(\s*\[\s*\]\s*\)|APPROVED\s*:\s*new Set\(\s*\)/);
    expect(routeSrc).toMatch(/REJECTED\s*:\s*new Set\(\s*\[\s*\]\s*\)|REJECTED\s*:\s*new Set\(\s*\)/);
    expect(routeSrc).toMatch(/INVALID_TRANSITION/);
  });

  test('7. PATCH stamps reviewedById + reviewedAt + reviewNotes atomically', () => {
    // The lockstep stamp is the audit contract — without it the
    // reviewedAt timestamp could be set without a reviewedById (or
    // vice versa), making the "Reviewed by" UI render an unattributed
    // row. Pin the four-field data object so the lockstep survives.
    const updateMatch = routeSrc.match(
      /data\s*:\s*\{[\s\S]*?status\s*:[\s\S]*?reviewedById\s*:\s*req\.employeeId[\s\S]*?reviewedAt\s*:\s*new Date\(\)[\s\S]*?reviewNotes[\s\S]*?\}/,
    );
    expect(updateMatch).not.toBeNull();
  });

  test('8. schema.prisma declares the ProjectAttachmentStatus enum + 4 columns', () => {
    // The enum + the four columns + the reviewer relation must all
    // exist in the schema — otherwise `prisma generate` would strip the
    // migration's column-level typing and the route handler's
    // status write would silently cast to text.
    expect(schemaSrc).toMatch(/enum\s+ProjectAttachmentStatus\s*\{/);
    expect(schemaSrc).toMatch(/PENDING_REVIEW/);
    expect(schemaSrc).toMatch(/APPROVED/);
    expect(schemaSrc).toMatch(/REVISION_REQUESTED/);
    expect(schemaSrc).toMatch(/REJECTED/);
    // status is NOT NULL with a default (the migration uses DEFAULT
    // PENDING_REVIEW), so the field shape is `status ProjectAttachmentStatus`
    // not `status ProjectAttachmentStatus?`.
    expect(schemaSrc).toMatch(/status\s+ProjectAttachmentStatus(?!\s*\?)/);
    // Prisma format is `TypeName?` (no space before ?) for nullable
    // scalar columns. The regex tolerates both `TypeName?` and
    // `TypeName ?` so it survives prettier reformats.
    expect(schemaSrc).toMatch(/reviewedById\s+String\??/);
    expect(schemaSrc).toMatch(/reviewedAt\s+DateTime\??/);
    expect(schemaSrc).toMatch(/reviewNotes\s+String\??/);
  });

  test('9. migration is idempotent + uses the same enum + 4 columns', () => {
    // The migration is additive — `IF NOT EXISTS` guards on every
    // step. Pin the structure so a future re-run on a DB that already
    // has the schema is a no-op (no P2010 enum-already-exists crash).
    expect(migrationSrc).toMatch(/CREATE TYPE\s+"ProjectAttachmentStatus"/);
    expect(migrationSrc).toMatch(/ADD COLUMN IF NOT EXISTS\s+"status"/);
    expect(migrationSrc).toMatch(/ADD COLUMN IF NOT EXISTS\s+"reviewed_by_id"/);
    expect(migrationSrc).toMatch(/ADD COLUMN IF NOT EXISTS\s+"reviewed_at"/);
    expect(migrationSrc).toMatch(/ADD COLUMN IF NOT EXISTS\s+"review_notes"/);
    expect(migrationSrc).toMatch(/project_attachment_status_project_id_idx/);
  });

  test('10. FK references the plural snake_case "employees" table (NOT "employee" or "Employee")', () => {
    // [S7-SQLFIX 2026-09-12] The original S7 migration referenced the
    // singular "employee" table; the live DB has the plural snake_case
    // "employees" (matches the existing uploadedById FK + the
    // 20260905030000_fix_n17_employee_fk corrective migration). The
    // first deploy failed at FK ADD with `42P01: relation "employee"
    // does not exist`. Pin so a future refactor that drops the "s"
    // (or uses the Prisma-default PascalCase "Employee") is caught
    // here at test time instead of at deploy time.
    expect(migrationSrc).toMatch(/REFERENCES\s+"employees"\("id"\)/);
    expect(migrationSrc).not.toMatch(/REFERENCES\s+"employee"\(/);
    expect(migrationSrc).not.toMatch(/REFERENCES\s+"Employee"\(/);
  });
});
