/**
 * DR-035 — auto bootstrap-resolve is retired from ordinary startup
 * and CI deploy paths. Recovery is now an explicit operations step,
 * gated behind the DR031_RECONCILE env var in the CI workflow and
 * shipped as a standalone script operators invoke by hand.
 *
 * Audit citation (pre-DR-035):
 *   - backend/start.sh auto-issued `prisma migrate resolve --rolled-back`
 *     on every cold start for an allowlisted set (DR-031 + S7).
 *   - .github/workflows/backend-deploy.yml "Bootstrap resolve" step
 *     ran the same loop unconditionally on every push, including the
 *     DR-025 row.
 *   - Net effect: ordinary releases could silently reclassify a
 *     newly failed migration because the allowlist was checked on
 *     every deploy, not on operator confirmation.
 *
 * New contract (DR-035):
 *   1. `start.sh` runs ONLY `prisma migrate deploy` and fails before
 *      serving if it fails. No `prisma migrate resolve` call. No
 *      shell-out to reconcile-failed-migrations.sh.
 *   2. CI deploy workflow gates the reconcile step behind
 *      `DR031_RECONCILE=1` and calls
 *      `backend/scripts/reconcile-failed-migrations.sh`. Default push
 *      triggers do NOT set the variable → step skipped.
 *   3. `backend/scripts/reconcile-failed-migrations.sh` exists with
 *      the same allowlist (DR-031 + S7 + DR-025) so operators still
 *      have the recovery tool under the explicit gate.
 *   4. `backend/scripts/check-schema-parity.sh` exists for the
 *      "isolated schema replay/parity check" the audit added —
 *      detects model-only changes even when migration history says
 *      up to date.
 *
 * Regression preservation: the DR-031 / S7 / DR-025 recovery path
 * remains functional — operators can still call the script under
 * the explicit gate, or invoke db:recover / db:check. This test does
 * NOT delete or alter those pre-existing operator surfaces.
 *
 * This test reads the source files and pins each contract — no DB,
 * no shell-out, no actual Prisma invocation. Matches the DR-032
 * source-text-pin pattern in dr032-install-db-free.test.js.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const START_SH = path.join(REPO, 'backend', 'start.sh');
const CI_WORKFLOW = path.join(REPO, '.github', 'workflows', 'backend-deploy.yml');
const RECONCILE_SCRIPT = path.join(REPO, 'backend', 'scripts', 'reconcile-failed-migrations.sh');
const PARITY_SCRIPT = path.join(REPO, 'backend', 'scripts', 'check-schema-parity.sh');

describe('DR-035 — auto bootstrap-resolve is retired; reconcile is explicit', () => {
  const startSrc = fs.readFileSync(START_SH, 'utf8');
  const ciSrc = fs.readFileSync(CI_WORKFLOW, 'utf8');
  const reconcileSrc = fs.readFileSync(RECONCILE_SCRIPT, 'utf8');
  const paritySrc = fs.readFileSync(PARITY_SCRIPT, 'utf8');

  // ---- start.sh no longer auto-resolves ----

  test('start.sh does not invoke prisma migrate resolve', () => {
    // The pre-DR-035 bootstrap loop used
    // `npx prisma migrate resolve --rolled-back "$MIG"` on every cold
    // start. Pin the absence of any `migrate resolve` call in start.sh
    // — ordinary startup is migrate-deploy-only and fails-before-serving.
    // The header comment legitimately mentions "prisma migrate resolve"
    // as a documentation reference to the pre-DR-035 behaviour, so we
    // strip # comments and echo "..." documentation messages before
    // regex matching.
    const codeOnly = startSrc
      .split('\n')
      .filter((line) => !line.trim().startsWith('#') && !/^\s*echo\s+["']/.test(line))
      .join('\n');
    expect(codeOnly).not.toMatch(/prisma\s+migrate\s+resolve/);
  });

  test('start.sh does not shell out to reconcile-failed-migrations.sh', () => {
    // The reconcile script is operations-only; ordinary startup must
    // not invoke it even by indirection. Pin the absence of the
    // script reference in start.sh's executable code (the header
    // comment and the failure-path echo message legitimately mention
    // it as documentation — we filter those out and check the
    // remaining executable lines for an actual invocation).
    const codeOnly = startSrc
      .split('\n')
      .filter((line) => !line.trim().startsWith('#') && !/^\s*echo\s+["']/.test(line))
      .join('\n');
    expect(codeOnly).not.toMatch(/reconcile-failed-migrations\.sh/);
  });

  test('start.sh cites DR-035 with a pointer to the reconcile script', () => {
    // Header comment must explain the DR-035 contract so future
    // contributors understand why the inline bootstrap was removed
    // and where to find the operations tool.
    expect(startSrc).toMatch(/\[DR-035/);
    expect(startSrc).toMatch(/reconcile-failed-migrations\.sh/);
  });

  test('start.sh still runs prisma migrate deploy (failure-before-serving)', () => {
    // Reuse the DR-032 contract: startup applies migrations and
    // fails before serving. The prisma migrate deploy call must
    // remain; only the bootstrap-resolve loop is removed.
    expect(startSrc).toMatch(/prisma migrate deploy/);
    expect(startSrc).toMatch(/RC=\$\?/);
    expect(startSrc).toMatch(/exit \$?RC/);
  });

  test('start.sh points operators at DR031_RECONCILE on migrate deploy failure', () => {
    // When migrate deploy fails, start.sh must direct the operator
    // to the new opt-in gate (in addition to the existing db:recover
    // pointer). Pin both messages so a regression that drops either
    // one is caught.
    expect(startSrc).toMatch(/DR031_RECONCILE=1/);
    expect(startSrc).toMatch(/npm run db:recover/);
  });

  // ---- CI deploy workflow gates the reconcile step ----

  test('CI workflow defines DR031_RECONCILE at the workflow scope', () => {
    // Workflow-level env: DR031_RECONCILE must be defined at the
    // workflow scope so the step's `if:` check sees a defined value.
    // The pattern `${{ vars.DR031_RECONCILE || '' }}` defaults to
    // empty string when the operator hasn't set the repo variable,
    // which is exactly what we want for ordinary pushes.
    expect(ciSrc).toMatch(/^\s*DR031_RECONCILE:/m);
    expect(ciSrc).toMatch(/vars\.DR031_RECONCILE/);
  });

  test('CI workflow reconcile step is gated by env.DR031_RECONCILE', () => {
    // The reconcile step must have an `if:` condition that references
    // env.DR031_RECONCILE so ordinary push triggers (which do not set
    // the env var) skip the step. Pin both halves: the `if:` line
    // AND the comparison to the literal '1'.
    expect(ciSrc).toMatch(/if:\s*env\.DR031_RECONCILE\s*==\s*'1'/);
  });

  test('CI workflow reconcile step calls reconcile-failed-migrations.sh', () => {
    // The reconcile loop is no longer inlined; the step must call the
    // extracted operations script.
    expect(ciSrc).toMatch(/reconcile-failed-migrations\.sh/);
  });

  test('CI workflow does not invoke prisma migrate resolve directly', () => {
    // Pre-DR-035 the reconcile step inlined
    // `for MIG in ... 20260908150000_dr031_leave_constraint_correct_bound ...`
    // followed by `npx prisma migrate resolve --rolled-back "$MIG"`.
    // The exact DR-035 contract is: the workflow file MUST NOT call
    // `prisma migrate resolve` directly at all. The migration names
    // themselves legitimately still appear in the DR-032 ledger-
    // inspection step's KNOWN_BAD list (that's a read-only SELECT,
    // not a resolve invocation) — so we pin the precise contract
    // here rather than the absolute absence of the names.
    expect(ciSrc).not.toMatch(/prisma\s+migrate\s+resolve/);
  });

  test('CI workflow DR-032 inspection step still lists the same KNOWN_BAD migrations', () => {
    // Regression preservation: the DR-032 ledger inspection step's
    // KNOWN_BAD allowlist is unchanged — same migration names the
    // pre-DR-035 inspection step checked. The names legitimately
    // appear here (the inspection is read-only, no `migrate resolve`
    // is invoked), but they're the source of truth that flags when
    // a deploy hits an errored ledger row.
    expect(ciSrc).toMatch(/20260908150000_dr031_leave_constraint_correct_bound/);
    expect(ciSrc).toMatch(/20260912070000_s7_project_attachment_review/);
  });

  test('CI workflow still points operators at db:recover on inspection failure', () => {
    // The DR-032 contract: the CI inspection step fails the workflow
    // on non-applied rows and points the operator at db:recover —
    // unchanged by DR-035 (the inspection step lives further down in
    // the workflow; this is a regression-guard rather than a
    // new-contract assertion).
    expect(ciSrc).toMatch(/npm run db:recover\s+--\s+--confirmed-abandoned/);
  });

  // ---- Operations scripts exist with the right shape ----

  test('reconcile-failed-migrations.sh exists and is executable', () => {
    const stat = fs.statSync(RECONCILE_SCRIPT);
    expect(stat.isFile()).toBe(true);
    // Executable bit set — matches the bash-script convention used
    // by backup-database.sh / restore-database.sh in the same dir.
    expect(stat.mode & 0o111).not.toBe(0);
  });

  test('reconcile-failed-migrations.sh carries the DR-031 + S7 + DR-025 allowlist', () => {
    // Regression preservation: the same three allowlisted migration
    // names that pre-DR-035 lived in start.sh and the CI workflow.
    // Operators under the DR031_RECONCILE gate must still hit the
    // same allowlist the pre-DR-035 inline loops hit.
    expect(reconcileSrc).toMatch(/20260908150000_dr031_leave_constraint_correct_bound/);
    expect(reconcileSrc).toMatch(/20260912070000_s7_project_attachment_review/);
    expect(reconcileSrc).toMatch(/20260924100000_dr025_correction_cancelled/);
  });

  test('reconcile-failed-migrations.sh runs prisma migrate resolve --rolled-back', () => {
    // The script is the canonical recovery path; it must still
    // issue the resolve command the inline loop used to issue.
    expect(reconcileSrc).toMatch(/prisma\s+migrate\s+resolve\s+--rolled-back/);
  });

  test('reconcile-failed-migrations.sh swallows the steady-state non-zero exit', () => {
    // Pre-DR-035 the inline loop used `|| true` to swallow the
    // non-zero exit from `migrate resolve --rolled-back` when the
    // migration is already in applied / rolled-back state. The
    // script preserves this idempotency contract.
    expect(reconcileSrc).toMatch(/\|\|\s*true/);
  });

  test('check-schema-parity.sh exists and is executable', () => {
    const stat = fs.statSync(PARITY_SCRIPT);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o111).not.toBe(0);
  });

  test('check-schema-parity.sh runs prisma migrate diff against the migrations folder and schema.prisma', () => {
    // Audit acceptance: "A model-only change is detected even when
    // migration history says up to date" — that's exactly what
    // `prisma migrate diff --from-migrations --to-schema-datamodel`
    // does when a shadow database URL is provided. Pin all four
    // pieces (the subcommand + the two `--from` / `--to` flags + the
    // shadow URL flag).
    expect(paritySrc).toMatch(/prisma\s+migrate\s+diff/);
    expect(paritySrc).toMatch(/--from-migrations/);
    expect(paritySrc).toMatch(/--to-schema-datamodel/);
    expect(paritySrc).toMatch(/--shadow-database-url/);
  });

  test('check-schema-parity.sh requires SHADOW_DATABASE_URL', () => {
    // `prisma migrate diff --from-migrations` requires a shadow
    // database URL — without it, the command fails. The script must
    // surface that requirement clearly and exit non-zero when it's
    // missing, so operators don't get a confusing Prisma error.
    expect(paritySrc).toMatch(/SHADOW_DATABASE_URL/);
  });
});