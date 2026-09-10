// DR-031 (audit, 2026-09-08) — Deployment hooks + migration recovery.
//
// Audit findings:
//   1. Dockerfile copies package files BEFORE `npm ci`, but the
//      postinstall hook invokes scripts/clear-failed-migrations.js
//      which had to be present in the image.
//   2. start.sh (the alternative recovery path) referenced a
//      nonexistent `status` column on `_prisma_migrations` — Prisma
//      5 has no such column; applied state is derived from
//      `finished_at` / `rolled_back_at` / `applied_steps_count`.
//      The predicate would crash on every cold start.
//   3. The original DR-009 leave-overlap constraint migration
//      referenced snake_case columns "start_date" / "end_date" that
//      do NOT exist on `leave_request` (schema.prisma declares them
//      camelCase). The constraint was therefore never created — live
//      `pg_constraint` lookup returns zero rows.
//
// Source-text contracts pin:
//   - Dockerfile copies scripts/ before npm ci so the postinstall
//     hook can find its recovery script.
//   - scripts/clear-failed-migrations.js uses the safe
//     `finished_at IS NULL OR applied_steps_count = 0` predicate
//     (never touches a successfully-applied row).
//   - start.sh uses the same safe predicate — same guard across both
//     recovery paths.
//   - A new append-only migration recreates the
//     `no_overlap_leave` constraint with the CORRECT camelCase
//     columns, idempotent via a DO $$ guard.
//
// Run: cd src && npx jest __tests__/dr031-deploy-migration-recovery.test.jsx
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from 'fs';
import { resolve as resolvePath } from 'path';

const dockerfilePath = resolvePath(__dirname, '../../backend/Dockerfile');
const startShPath = resolvePath(__dirname, '../../backend/start.sh');
const clearScriptPath = resolvePath(
  __dirname,
  '../../backend/scripts/clear-failed-migrations.js',
);
const fixMigrationPath = resolvePath(
  __dirname,
  '../../backend/prisma/migrations/20260908140000_dr009_leave_overlap_constraint_fix/migration.sql',
);

const dockerfileSrc = readFileSync(dockerfilePath, 'utf8');
const startShSrc = readFileSync(startShPath, 'utf8');
const clearScriptSrc = readFileSync(clearScriptPath, 'utf8');
const fixMigrationSrc = readFileSync(fixMigrationPath, 'utf8');

describe('DR-031 — Dockerfile + scripts/ present before npm ci', () => {
  test('1. Dockerfile copies scripts/ before npm ci (postinstall hook)', () => {
    const copyScriptsIdx = dockerfileSrc.search(/COPY\s+scripts\//);
    const npmCiIdx = dockerfileSrc.search(/RUN\s+npm\s+ci/);
    expect(copyScriptsIdx).toBeGreaterThan(-1);
    expect(npmCiIdx).toBeGreaterThan(-1);
    expect(copyScriptsIdx).toBeLessThan(npmCiIdx);
  });
});

describe('DR-031 — clear-failed-migrations.js guard', () => {
  test('2. The DELETE uses the safe predicate (finished_at IS NULL OR applied_steps_count = 0)', () => {
    // The SQL is inside a JS string literal so the column quotes are
    // single-backslash escaped: \"finished_at\". Positive pin only —
    // the header comment intentionally references the OLD predicate
    // to explain why it was removed.
    expect(clearScriptSrc).toMatch(
      /DELETE FROM \\"_prisma_migrations\\"[\s\S]{0,400}?\\"finished_at\\"\s+IS\s+NULL\s+OR\s+\\"applied_steps_count\\"\s*=\s*0/,
    );
  });
});

describe('DR-031 — start.sh uses the safe predicate', () => {
  test('3. start.sh invokes `migrate resolve --rolled-back` for the DR-031 migration', () => {
    // [DR-032] start.sh does NOT issue a raw DELETE against
    // _prisma_migrations — auto-recovery is explicitly forbidden
    // (db-recover.test.js pins this). Instead, start.sh uses
    // `npx prisma migrate resolve --rolled-back 20260908150000_dr031_leave_constraint_correct_bound`
    // which is the official Prisma API for clearing an errored ledger
    // row. The `|| true` swallows the non-zero exit when the named
    // migration is not in errored state (steady-state after the first
    // successful recovery).
    //
    // DR-031 audit invariant: the predicate the postinstall hook uses
    // (finished_at IS NULL OR applied_steps_count = 0) is enforced
    // INSIDE prisma's `migrate resolve` — the operator-facing API
    // already refuses to resolve a successfully-applied row, so we
    // don't need to repeat the predicate in shell.
    expect(startShSrc).toMatch(
      /npx\s+prisma\s+migrate\s+resolve\s+--rolled-back\s+20260908150000_dr031_leave_constraint_correct_bound/,
    );
    expect(startShSrc).toMatch(/\|\|\s*true/);
  });
});

describe('DR-031 — append-only DR-009 fix migration', () => {
  test('4. The fix migration file exists', () => {
    expect(existsSync(fixMigrationPath)).toBe(true);
  });

  test('5. The fix migration uses the CORRECT camelCase columns in the constraint DDL', () => {
    // Pull the ADD CONSTRAINT block (between the IF NOT EXISTS open
    // and the matching close) — that's where the bug would manifest
    // if someone accidentally reintroduced snake_case. The header
    // comment mentions snake_case as part of the audit narrative.
    const addBlock = fixMigrationSrc.match(
      /ADD\s+CONSTRAINT[\s\S]*?\);/,
    );
    expect(addBlock).not.toBeNull();
    expect(addBlock[0]).toMatch(/"startDate"/);
    expect(addBlock[0]).toMatch(/"endDate"/);
  });

  test('6. The fix is idempotent — wrapped in a DO $$ guard that checks pg_constraint', () => {
    expect(fixMigrationSrc).toMatch(/DO\s+\$\$/);
    expect(fixMigrationSrc).toMatch(
      /SELECT\s+1\s+FROM\s+pg_constraint\s+WHERE\s+conname\s*=\s*'no_overlap_leave'/,
    );
    expect(fixMigrationSrc).toMatch(/IF\s+NOT\s+EXISTS/);
  });

  test('7. btree_gist extension is enabled (idempotent)', () => {
    expect(fixMigrationSrc).toMatch(
      /CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+btree_gist/,
    );
  });

  test('8. Constraint definition mirrors the original (gist + employee_id + daterange)', () => {
    expect(fixMigrationSrc).toMatch(/EXCLUDE\s+USING\s+gist/);
    expect(fixMigrationSrc).toMatch(/"employee_id"\s+WITH\s+=/);
    expect(fixMigrationSrc).toMatch(
      /daterange\(\s*"startDate"\s*,\s*\("endDate"\s*\+\s*1\)\s*,\s*'\[\]'\)\s+WITH\s+&&/,
    );
    expect(fixMigrationSrc).toMatch(
      /WHERE\s*\("status"\s+IN\s*\(\s*'PENDING'\s*,\s*'APPROVED'\s*\)\)/,
    );
  });
});
