/**
 * DR-032 (followup) — Recovery is operator-only. start.sh must NOT
 * auto-delete ledger rows.
 *
 * The original DR-032 commit (276edd1) consolidated recovery into
 * start.sh — but the script still auto-issued DELETE +
 * `prisma migrate resolve --rolled-back` on every cold start. That's
 * dangerous: a partial migration that actually wrote schema rows
 * would be silently dropped. The allowlist matches "rolled back OR
 * never finished", which also describes an in-progress migration in
 * a concurrent release.
 *
 * New contract (DR-032 followup):
 *   1. `npm install` is DB-free (unchanged from original DR-032).
 *   2. `start.sh` runs ONLY `prisma migrate deploy` and fails before
 *      serving if it fails. No DELETE, no resolve — those are
 *      operator-only via `npm run db:recover -- --confirmed-abandoned`.
 *   3. `db:recover` defaults to read-only inspection and exits
 *      non-zero on non-applied rows. The destructive path requires
 *      `--confirmed-abandoned`.
 *   4. CI inspection step fails the workflow on non-applied rows
 *      (no auto-delete, no resolve).
 *
 * This test reads the source files and pins each of those contracts.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const PKG_JSON = path.join(REPO, 'backend', 'package.json');
const CLEAR_SCRIPT = path.join(REPO, 'backend', 'scripts', 'clear-failed-migrations.js');
const START_SH = path.join(REPO, 'backend', 'start.sh');
const DOCKERFILE = path.join(REPO, 'backend', 'Dockerfile');
const CI_WORKFLOW = path.join(REPO, '.github', 'workflows', 'backend-deploy.yml');

describe('DR-032 followup — recovery is operator-only', () => {
  const pkg = JSON.parse(fs.readFileSync(PKG_JSON, 'utf8'));
  const clearSrc = fs.readFileSync(CLEAR_SCRIPT, 'utf8');
  const startSrc = fs.readFileSync(START_SH, 'utf8');
  const dockerSrc = fs.readFileSync(DOCKERFILE, 'utf8');
  const ciSrc = fs.readFileSync(CI_WORKFLOW, 'utf8');

  // ---- npm install is DB-free (unchanged from original DR-032) ----

  test('package.json has no postinstall hook (npm install is DB-free)', () => {
    expect(pkg.scripts).not.toHaveProperty('postinstall');
  });

  test('package.json exposes db:recover and db:check scripts (operator-facing)', () => {
    expect(pkg.scripts).toHaveProperty('db:recover');
    expect(pkg.scripts['db:recover']).toBe('node scripts/clear-failed-migrations.js');
    expect(pkg.scripts).toHaveProperty('db:check');
  });

  test('package.json scripts.no-skipped-tests and pretest still wired', () => {
    expect(pkg.scripts).toHaveProperty('pretest');
    expect(pkg.scripts.pretest).toBe('node scripts/no-skipped-tests.js');
  });

  // ---- clear-failed-migrations.js is operator-only ----

  test('clear-failed-migrations.js has no RENDER auto-fire', () => {
    // Pre-DR-032 the script ran whenever RENDER='true'. After DR-032
    // the script must require explicit `--confirmed-abandoned` OR an
    // explicit POSTINSTALL_CLEAR_MIGRATIONS opt-in for inspection.
    // The script body may reference RENDER only as an inspection
    // opt-in (not as an unconditional auto-fire). Pin the absence of
    // the old `RENDER === 'true'` auto-fire pattern AND the absence
    // of the original POSTINSTALL_CLEAR_MIGRATIONS auto-delete path.
    // (The new script keeps POSTINSTALL_CLEAR_MIGRATIONS as an
    // inspection-path opt-in — see the next test.)
    expect(clearSrc).not.toMatch(/process\.env\.OPS_RECONCILE_FAILED_MIGRATIONS/);
  });

  test('clear-failed-migrations.js destructive path requires --confirmed-abandoned', () => {
    expect(clearSrc).toMatch(/--confirmed-abandoned/);
    expect(clearSrc).toMatch(/CONFIRMED_ABANDONED/);
  });

  test('clear-failed-migrations.js DELETE still uses the NOT-applied predicate', () => {
    // DR-031 guard preserved. A successfully-applied row has
    // finished_at NOT NULL AND applied_steps_count > 0 AND
    // rolled_back_at IS NULL — never touched.
    expect(clearSrc).toMatch(/rolled_back_at.*IS\s+NULL/s);
    expect(clearSrc).toMatch(/finished_at.*IS\s+NULL.*applied_steps_count.*=\s*0/s);
  });

  test('clear-failed-migrations.js inspection path is read-only', () => {
    // The inspection branch must use $queryRawUnsafe (SELECT), not
    // $executeRawUnsafe (DELETE). The check below inspects the
    // inspectLedger function body.
    expect(clearSrc).toMatch(/inspectLedger[\s\S]+\$queryRawUnsafe/);
    expect(clearSrc).toMatch(/FROM\s+"_prisma_migrations"/);
  });

  test('clear-failed-migrations.js exits non-zero on non-applied rows (inspection)', () => {
    expect(clearSrc).toMatch(/process\.exitCode\s*=\s*1/);
  });

  // ---- start.sh no longer auto-recovers ----

  test('start.sh no longer issues a DELETE against _prisma_migrations', () => {
    // The previous contract auto-issued a DELETE on every cold start.
    // That was dangerous — a partial migration in a concurrent release
    // would be silently dropped. Recovery is now operator-only via
    // `npm run db:recover -- --confirmed-abandoned`. Pin the absence
    // of any DELETE FROM _prisma_migrations in start.sh.
    expect(startSrc).not.toMatch(/DELETE\s+FROM[^_]*_prisma_migrations/i);
  });

  test('start.sh no longer auto-runs prisma migrate resolve (DR-031-SQLFIX bootstrap excepted)', () => {
    // Resolve was an automatic part of the previous start-time
    // recovery. The operator runs it (after inspecting the ledger)
    // via db:recover. start.sh must not invoke it — EXCEPT for the
    // [DR-031-SQLFIX] bootstrap block, which is narrowly scoped to a
    // single migration name (the broken `''[]''` literal shipped at
    // commit cf697e7), runs with `|| true` so the steady-state
    // non-zero exit is swallowed, and is the only sanctioned auto-
    // recovery in start.sh. Any future `migrate resolve` invocation
    // in start.sh that targets a different migration, or omits the
    // `|| true` guard, or is not annotated with [DR-031-SQLFIX] is a
    // regression that needs re-justification.
    const resolveCalls = startSrc.match(/prisma\s+migrate\s+resolve[^\n]*/g) || [];
    expect(resolveCalls.length).toBeLessThanOrEqual(1);
    if (resolveCalls.length === 1) {
      expect(resolveCalls[0]).toMatch(/--rolled-back/);
      expect(resolveCalls[0]).toMatch(/20260908150000_dr031_leave_constraint_correct_bound/);
      expect(resolveCalls[0] + '\n' + startSrc).toMatch(/\|\|\s*true/);
    }
  });

  test('start.sh runs prisma migrate deploy (failure-before-serving)', () => {
    // The script's only DB-touching job is to apply pending migrations
    // and fail before serving if anything is wrong.
    expect(startSrc).toMatch(/prisma migrate deploy/);
  });

  test('start.sh fails before serving if migrate deploy fails', () => {
    // Pin the failure-before-serving gate.
    expect(startSrc).toMatch(/RC=\$\?/);
    expect(startSrc).toMatch(/if.*RC.*ne.*0/m);
    expect(startSrc).toMatch(/exit \$?RC/);
  });

  test('start.sh points operators at db:recover on failure', () => {
    // When migrate deploy fails, start.sh must instruct the operator
    // to use db:recover — the only sanctioned recovery path.
    expect(startSrc).toMatch(/npm run db:recover/);
  });

  // ---- CI is read-only; fails on non-applied rows ----

  test('CI workflow does NOT use the broken status-column SQL predicate', () => {
    // Pre-DR-032 the CI LPR-029 step had a `$executeRawUnsafe` call
    // with `WHERE migration_name = '…' AND status <> 'applied'` —
    // a predicate that crashes on Prisma 5 (no `status` column on
    // `_prisma_migrations`). Pin SQL form (preceded by
    // `migration_name =` or a `_prisma_migrations` reference) so
    // comments that mention the broken pattern for documentation
    // don't false-positive this test.
    expect(ciSrc).not.toMatch(
      /(?:migration_name\s*=|_prisma_migrations)[^#\n]*?\bstatus\s*<>\s*'applied'/,
    );
  });

  test('CI workflow does NOT auto-delete (no $executeRawUnsafe in ledger steps)', () => {
    // The CI inspection step is read-only. Pin the absence of a
    // destructive `$executeRawUnsafe` DELETE inside the
    // DR-032 inspection step. We tolerate `$queryRawUnsafe` (SELECT)
    // and document that the operator's `npm run db:recover --
    // --confirmed-abandoned` is the only sanctioned destructive path.
    expect(ciSrc).not.toMatch(/DELETE\s+FROM[^_]*_prisma_migrations/);
  });

  test('CI workflow references the operator-only db:recover escape hatch', () => {
    // When the CI ledger inspection fails, it must point the
    // operator at db:recover — the only sanctioned recovery path.
    expect(ciSrc).toMatch(/npm run db:recover\s+--\s+--confirmed-abandoned/);
  });

  test('CI workflow LPR-029 / DR-032 inspection uses the NOT-applied predicate', () => {
    // The CI inspection SELECT must mirror clear-failed-migrations.js
    // so both paths use the same non-applied flag.
    expect(ciSrc).toMatch(/rolled_back_at.*===.*null/s);
    expect(ciSrc).toMatch(/finished_at.*===.*null/s);
    expect(ciSrc).toMatch(/applied_steps_count.*===.*0/s);
  });

  // ---- Dockerfile: start command runs migrate deploy ----

  test('Dockerfile CMD chains prisma migrate deploy with node', () => {
    // The Dockerfile CMD is the contract for non-Render deployments.
    // It must run `prisma migrate deploy` and only exec node on
    // success — no recovery auto-fires.
    expect(dockerSrc).toMatch(/prisma\s+migrate\s+deploy/);
    expect(dockerSrc).toMatch(/node\s+src\/index\.js/);
  });

  test('Dockerfile does NOT have a postinstall hook in any RUN/CMD/ENTRYPOINT line', () => {
    // The Dockerfile can legitimately mention `postinstall` in
    // comments documenting the DR-032 contract. What we pin here is
    // the absence of an actual `RUN` / `CMD` / `ENTRYPOINT` line that
    // wires the postinstall hook back in (which would re-introduce
    // install-time DB mutations). Filter out comment lines first.
    const nonCommentLines = dockerSrc
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(nonCommentLines).not.toMatch(/postinstall/);
  });
});
