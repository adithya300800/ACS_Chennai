/**
 * DR-032 — Installation-time migration recovery can delete unfinished
 * ledger evidence.
 *
 * Audit citation:
 *   backend/package.json:17 — `postinstall` hook fired
 *   scripts/clear-failed-migrations.js on every `npm install`. The DELETE
 *   matched `KNOWN_BAD` migration rows whose `finished_at` was NULL or
 *   `applied_steps_count` was 0 — which ALSO describes an in-progress
 *   migration from another release. An allowlist is not proof of
 *   abandonment.
 *
 *   Recovery was duplicated (postinstall + start.sh) and CI's
 *   `.github/workflows/backend-deploy.yml` still used
 *   `WHERE status <> 'applied'` — a predicate that crashes on Prisma 5
 *   (no `status` column on `_prisma_migrations`).
 *
 *   Dockerfile CMD started node directly without proving a migration
 *   prerequisite.
 *
 * Smallest complete fix:
 *   1. Make `npm install` database-free (remove `postinstall` hook).
 *   2. Consolidate recovery into one serialized procedure (start.sh).
 *   3. Rename the operator opt-in env var; remove RENDER auto-fire from
 *      the script (no lifecycle auto-fire).
 *   4. Fix CI's status-column query to the same NOT-applied predicate.
 *   5. Declare the native/Docker release contract in the Dockerfile.
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

describe('DR-032 — install is database-free; recovery consolidated to start.sh', () => {
  const pkg = JSON.parse(fs.readFileSync(PKG_JSON, 'utf8'));
  const clearSrc = fs.readFileSync(CLEAR_SCRIPT, 'utf8');
  const startSrc = fs.readFileSync(START_SH, 'utf8');
  const dockerSrc = fs.readFileSync(DOCKERFILE, 'utf8');
  const ciSrc = fs.readFileSync(CI_WORKFLOW, 'utf8');

  test('package.json has no postinstall hook (npm install is DB-free)', () => {
    expect(pkg.scripts).not.toHaveProperty('postinstall');
  });

  test('package.json scripts.no-skipped-tests and pretest still wired', () => {
    // Sanity: the `pretest` is allowed (it's a no-skipped-tests guard,
    // NOT a DB-touching hook). Pin so removing it accidentally is caught.
    expect(pkg.scripts).toHaveProperty('pretest');
    expect(pkg.scripts.pretest).toBe('node scripts/no-skipped-tests.js');
  });

  test('clear-failed-migrations.js has no RENDER auto-fire', () => {
    // Pre-DR-032 the script ran whenever RENDER='true'. That was an
    // auto-fire — even if no operator asked. After DR-032 the script
    // must require explicit `OPS_RECONCILE_FAILED_MIGRATIONS=1`.
    expect(clearSrc).not.toMatch(/process\.env\.RENDER\s*===\s*'true'/);
    expect(clearSrc).not.toMatch(/process\.env\.POSTINSTALL_CLEAR_MIGRATIONS/);
  });

  test('clear-failed-migrations.js requires OPS_RECONCILE_FAILED_MIGRATIONS=1', () => {
    expect(clearSrc).toMatch(/OPS_RECONCILE_FAILED_MIGRATIONS\s*!==\s*'1'/);
  });

  test('clear-failed-migrations.js DELETE still uses the NOT-applied predicate', () => {
    // DR-031 guard preserved. A successfully-applied row has
    // finished_at NOT NULL AND applied_steps_count > 0 AND
    // rolled_back_at IS NULL — never touched.
    expect(clearSrc).toMatch(/rolled_back_at.*IS\s+NULL/s);
    expect(clearSrc).toMatch(/finished_at.*IS\s+NULL.*applied_steps_count.*=\s*0/s);
  });

  test('start.sh is the sole recovery procedure (DELETE + resolve + migrate deploy)', () => {
    // start.sh must still contain the serialized recovery sequence.
    // The DELETE is inside a node -e heredoc so the SQL is backslash-
    // escaped; use a flexible match that tolerates the escaping.
    expect(startSrc).toMatch(/DELETE FROM[^_]*_prisma_migrations/);
    expect(startSrc).toMatch(/prisma migrate resolve --rolled-back/);
    expect(startSrc).toMatch(/prisma migrate deploy/);
  });

  test('start.sh uses NOT-applied predicate (no status column)', () => {
    // Sanity: the inline DELETE in start.sh uses the same predicate as
    // the script and CI. Anything else would re-introduce the
    // status-column bug.
    expect(startSrc).toMatch(/rolled_back_at.*IS\s+NULL/s);
    expect(startSrc).toMatch(/finished_at.*IS\s+NULL.*applied_steps_count.*=\s*0/s);
    // And must NOT contain the broken `status <> 'applied'` predicate
    // in SQL context. Pin SQL form (preceded by `migration_name =` or a
    // `_prisma_migrations` reference) so comments that mention the
    // broken pattern for documentation don't false-positive this test.
    expect(startSrc).not.toMatch(
      /(?:migration_name\s*=|_prisma_migrations)[^#\n]*?\bstatus\s*<>\s*'applied'/,
    );
  });

  test('start.sh fails before serving if migrate deploy fails', () => {
    // Pin the failure-before-serving gate. The script must check the
    // exit code of `prisma migrate deploy` and exit non-zero BEFORE
    // exec-ing node.
    expect(startSrc).toMatch(/RC=\$\?/);
    expect(startSrc).toMatch(/if.*RC.*ne.*0/m);
    expect(startSrc).toMatch(/exit \$?RC/);
  });

  test('CI workflow does NOT use the broken status-column SQL predicate', () => {
    // Pre-DR-032 the CI LPR-029 step had a `$executeRawUnsafe` call with:
    //   DELETE FROM "_prisma_migrations" WHERE migration_name = '…'
    //     AND status <> 'applied'
    // which crashes on Prisma 5 (no `status` column on
    // `_prisma_migrations`). The new predicate uses
    // rolled_back_at / finished_at / applied_steps_count instead.
    // Pin the SQL form (preceded by `migration_name =` or a
    // `_prisma_migrations` reference) so comments that mention the
    // broken pattern for documentation don't false-positive this test.
    expect(ciSrc).not.toMatch(
      /(?:migration_name\s*=|_prisma_migrations)[^#\n]*?\bstatus\s*<>\s*'applied'/,
    );
  });

  test('CI workflow LPR-029 uses the NOT-applied predicate', () => {
    // The CI DELETE must mirror start.sh + clear-failed-migrations.js
    // so all three recovery paths use the same guard.
    const lprSection = ciSrc.split('LPR-029').slice(-1)[0];
    expect(lprSection).toMatch(/rolled_back_at.*IS\s+NULL/s);
    expect(lprSection).toMatch(/finished_at.*IS\s+NULL.*applied_steps_count.*=\s*0/s);
  });

  test('Dockerfile declares the production release contract (start.sh)', () => {
    // The contract: production runs start.sh; this Dockerfile CMD is a
    // dev/local fallback that requires an external migration step.
    expect(dockerSrc).toMatch(/start\.sh/);
    expect(dockerSrc).toMatch(/DR-032/);
  });

  test('Dockerfile does NOT copy scripts/ for a postinstall hook (DR-032 marker)', () => {
    // The Dockerfile can still COPY scripts/ as a documentation/operator
    // reference — that's allowed. But the prior comment "postinstall runs
    // scripts/clear-failed-migrations.js — must be present before `npm ci`"
    // must be gone. That comment was the only reason scripts/ had to be
    // copied before `npm ci`; the new contract allows it either way.
    expect(dockerSrc).not.toMatch(/postinstall runs scripts\/clear-failed-migrations\.js/);
  });
});
