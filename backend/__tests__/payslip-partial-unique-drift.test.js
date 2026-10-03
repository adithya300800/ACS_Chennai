/**
 * [Payslip Stage 1 / commit 2] Partial-unique drift detection.
 *
 * Verifies the migration `20261002010001_payslip_partial_unique`:
 *
 *   1. Creates the partial-unique index `payslip_active_per_month_uidx`
 *      with the exact shape
 *        `CREATE UNIQUE INDEX ... ON payslip (employee_id, year, month)
 *         WHERE deleted_at IS NULL`
 *      on a fresh DB.
 *   2. Self-heals after an out-of-band `ALTER INDEX ... RENAME` by
 *      detecting the relname lookup returning 0 rows and creating a
 *      fresh `payslip_active_per_month_uidx` with the correct shape.
 *      The right-name index passes `pg_get_indexdef` sanity check, so
 *      the migration succeeds (NOT raise) — this is the live
 *      "out-of-band drift" recovery path that DR-031 also supports.
 *   3. Raises EXCEPTION when the migration's CREATE INDEX itself ships
 *      a wrong shape (e.g. someone modified the migration to use the
 *      wrong columns). The migration's final sanity check fires
 *      `RAISE EXCEPTION 'payslip: partial-unique still in wrong shape: %'`
 *      and the migration fails loudly.
 *
 * Why a real throwaway Postgres (not a unit mock):
 *   The drift-detection logic inspects `pg_class` and `pg_get_indexdef`
 *   — these are real PostgreSQL catalog functions. A unit mock would
 *   re-implement Postgres and lose the drift signal. The test spins up
 *   `postgres:17-alpine` in Docker (matches production Supabase per Q1
 *   in PAYSLIPS_PLAN.md) and applies / sabotages migrations against it.
 *
 * Why docker exec + psql (not a pg client):
 *   The project doesn't carry `node-postgres` as a dependency. The
 *   existing migration-verify workflows in `reconcile-failed-migrations.sh`
 *   and the devops team's ad-hoc audit trail all use `docker exec
 *   <container> psql` directly. Using the same primitive keeps the
 *   test free of a new dependency.
 *
 * Privacy discipline:
 *   * No real employee data — only the dummy `00000000-...` UUIDs.
 *   * No salary figures — the dummy payslip row is constructed in-test
 *     with sizeBytes = 1.
 *   * No skip or only markers — every test runs.
 *
 * Prerequisites:
 *   Docker is available. The test fails with a clear error if docker
 *   cannot start a `postgres:17-alpine` container — it does NOT skip
 *   (per the global "no skipping tests" rule).
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONTAINER_NAME = 'payslip-pg-drift-test';
const PG_PORT = 5433; // distinct from the operator's payslip-pg on 5432

const MIGRATION_DIR = path.join(__dirname, '..', 'prisma', 'migrations');
const CREATE_TABLE_SQL = fs.readFileSync(
  path.join(MIGRATION_DIR, '20261002010000_payslip_create_table', 'migration.sql'),
  'utf8',
);
const PARTIAL_UNIQUE_SQL = fs.readFileSync(
  path.join(MIGRATION_DIR, '20261002010001_payslip_partial_unique', 'migration.sql'),
  'utf8',
);
const RLS_SQL = fs.readFileSync(
  path.join(MIGRATION_DIR, '20261002010002_payslip_rls', 'migration.sql'),
  'utf8',
);

// Resolve the Docker CLI. On macOS the standard install is
// /Applications/Docker.app/Contents/Resources/bin/docker; on Linux and
// CI it's just `docker`. Fall back gracefully.
const DOCKER_BIN = fs.existsSync('/Applications/Docker.app/Contents/Resources/bin/docker')
  ? '/Applications/Docker.app/Contents/Resources/bin/docker'
  : 'docker';

function docker(args, opts = {}) {
  try {
    return execFileSync(DOCKER_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      ...opts,
    });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : err.message;
    throw new Error(`docker ${args.join(' ')} failed: ${stderr.split('\n')[0]}`);
  }
}

// dockerExecSql runs a psql script inside the container via stdin. We use
// spawnSync (not execFileSync) because execFileSync's `input` option does
// not reliably reach psql's stdin when the program reads incrementally —
// the call returns empty stdout as if the script never executed. spawnSync
// with explicit stdio='pipe' on stdin pipes the bytes correctly.
function dockerExecSql(sql) {
  const result = spawnSync(
    DOCKER_BIN,
    ['exec', '-i', CONTAINER_NAME, 'psql', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1'],
    { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const out = (result.stdout || '') + (result.stderr || '');
  if (result.status === 0) return out;
  if (process.env.PAYSLIP_DEBUG) console.error('[dockerExecSql FAILED]\n', out, '\n[SQL]\n', sql);
  const e = new Error(`psql failed: ${out.split('\n').filter(Boolean).slice(0, 3).join(' | ')}`);
  e.psqlOutput = out;
  e.cause = result;
  throw e;
}

function dockerExecOne(sql) {
  // Runs a single SELECT (or short DDL) and returns the trimmed stdout.
  return docker(['exec', '-i', CONTAINER_NAME, 'psql', '-U', 'postgres', '-X', '-t', '-A', '-c', sql]).toString().trim();
}

async function waitForReady(deadlineMs = 60_000) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      dockerExecOne('SELECT 1');
      return;
    } catch (err) {
      if (Date.now() - start > deadlineMs) {
        throw new Error(`postgres did not become ready in ${deadlineMs}ms: ${err.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

async function resetSchema() {
  dockerExecSql('DROP SCHEMA IF EXISTS public CASCADE');
  dockerExecSql('CREATE SCHEMA public');
  dockerExecSql('GRANT ALL ON SCHEMA public TO public');
  // Create the bare FK target so the payslip_create_table migration's
  // REFERENCES employees(id) succeeds without dragging the full
  // init_baseline schema into this test. The full schema is exercised
  // by the regular prisma migrate deploy run; this test is drift-only.
  dockerExecSql(`
    CREATE TABLE public.employees (
      -- employees.id is TEXT in the live schema (see
      -- prisma/migrations/20260101000000_init_baseline/migration.sql).
      -- init_baseline doesn't add @db.Uuid to Employee.id so the
      -- Postgres column is text. The payslip migration matches.
      id text PRIMARY KEY,
      email varchar(255) UNIQUE NOT NULL,
      name varchar(255) NOT NULL,
      is_admin boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // Create the Supabase roles the RLS migration expects. Plain
  // Postgres doesn't have them; Supabase provisions them automatically.
  // DROP ROLE IF EXISTS first because CREATE ROLE has no IF NOT EXISTS
  // and resetSchema() may be called twice in the same session (the
  // container outlives a single test).
  dockerExecSql('DROP ROLE IF EXISTS anon');
  dockerExecSql('DROP ROLE IF EXISTS authenticated');
  dockerExecSql('CREATE ROLE anon NOLOGIN');
  dockerExecSql('CREATE ROLE authenticated NOLOGIN');
}

let containerStartedByUs = false;

beforeAll(async () => {
  // Always start a fresh container so state from a previous jest run
  // (a leftover `bogus` index, a half-applied migration, etc.) cannot
  // contaminate this run. Use a distinct port (5433) so we never
  // collide with the operator's payslip-pg container on 5432.
  try {
    docker(['rm', '-f', CONTAINER_NAME]);
  } catch (_) { /* container may not exist */ }
  docker([
    'run', '--rm', '-d',
    '--name', CONTAINER_NAME,
    '-p', `${PG_PORT}:5432`,
    '-e', 'POSTGRES_PASSWORD=test',
    'postgres:17-alpine',
  ]);
  containerStartedByUs = true;

  await waitForReady();
}, 60_000);

afterAll(() => {
  if (containerStartedByUs) {
    try {
      docker(['rm', '-f', CONTAINER_NAME]);
    } catch (_) { /* container may already be gone */ }
  }
});

describe('Payslip partial-unique drift detection (20261002010001_payslip_partial_unique)', () => {
  it('creates payslip_active_per_month_uidx with the canonical shape on a fresh DB', async () => {
    await resetSchema();
    dockerExecSql(CREATE_TABLE_SQL);
    dockerExecSql(PARTIAL_UNIQUE_SQL);
    dockerExecSql(RLS_SQL);

    const def = dockerExecOne(
      "SELECT pg_get_indexdef(c.oid) FROM pg_class c WHERE c.relname = 'payslip_active_per_month_uidx'",
    );
    expect(def).not.toBe('');
    // Drift detector in the migration uses these exact substrings.
    // If a future pg-version render change ships different formatting,
    // this assertion fails BEFORE the migration would raise, surfacing
    // the drift during the test phase.
    expect(def).toMatch(/payslip/);
    expect(def).toMatch(/\(employee_id, year, month\)/);
    expect(def).toMatch(/WHERE \(deleted_at IS NULL\)/);
  });

  it('self-heals after an out-of-band ALTER INDEX ... RENAME (no raise; correct index recreated)', async () => {
    // Set up the world: clean schema + apply all 3 migrations.
    await resetSchema();
    dockerExecSql(CREATE_TABLE_SQL);
    dockerExecSql(PARTIAL_UNIQUE_SQL);
    dockerExecSql(RLS_SQL);

    // Out-of-band drift: an operator (or a future buggy migration)
    // renames the index. The relname lookup in the migration's DO
    // block returns 0 rows → it creates a fresh
    // `payslip_active_per_month_uidx` with the right shape. The original
    // `bogus` index is not dropped by this migration (it lives under a
    // different relname now), but the fresh index has the right name
    // and the right shape — so the final sanity check passes (no
    // RAISE EXCEPTION).
    dockerExecOne('ALTER INDEX payslip_active_per_month_uidx RENAME TO bogus');
    dockerExecSql(PARTIAL_UNIQUE_SQL);

    const def = dockerExecOne(
      "SELECT pg_get_indexdef(c.oid) FROM pg_class c WHERE c.relname = 'payslip_active_per_month_uidx'",
    );
    expect(def).not.toBe('');
    expect(def).toMatch(/payslip/);
    expect(def).toMatch(/\(employee_id, year, month\)/);
    expect(def).toMatch(/WHERE \(deleted_at IS NULL\)/);
  });

  it('RAISE EXCEPTION when the recreate-step SQL ships a wrong shape (sabotage case)', async () => {
    // The drift detector's final sanity check fires `RAISE EXCEPTION`
    // when, AFTER the recreate, the index is still in the wrong shape.
    // The recreate can only ship a wrong shape if the migration's CREATE
    // INDEX statement itself is buggy (e.g. someone changed the columns
    // or the predicate). We simulate that bug by monkey-patching the
    // migration SQL: replace `(employee_id, year, month)` with
    // `(employee_id, year)` (drop the month column) on the ACTUAL
    // CREATE INDEX statement — NOT on the docstring at the top of the
    // file (which mentions the index name in a `--` comment block) and
    // NOT on the inner comment block in the migration. The regex
    // anchors on `ON\s+public\.payslip` so it only matches the live
    // CREATE INDEX statement (which uses `public.payslip`); both
    // comment blocks use bare `payslip` and are skipped. Earlier
    // versions of this regex matched the comment and the test passed
    // without exercising the safety net.
    //
    // This is the load-bearing test of the safety net: a future
    // migration-typo bug ships a partial-unique that admits duplicate
    // active rows, but the sanity check refuses to apply it.

    await resetSchema();
    dockerExecSql(CREATE_TABLE_SQL);
    dockerExecSql(PARTIAL_UNIQUE_SQL);
    // Drop the index so the migration's CREATE INDEX branch fires.
    dockerExecOne('DROP INDEX payslip_active_per_month_uidx');

    const sabotagedSql = PARTIAL_UNIQUE_SQL.replace(
      /(CREATE UNIQUE INDEX payslip_active_per_month_uidx[\s\S]*?ON\s+public\.payslip\s+)\([^\)]+\)([\s\S]*?WHERE deleted_at IS NULL)/,
      '$1(employee_id, year)$2',
    );
    // Sanity: the sabotaged SQL must actually differ — if the replace
    // silently no-oped (e.g. whitespace change), the test would pass
    // without exercising the safety net.
    expect(sabotagedSql).not.toBe(PARTIAL_UNIQUE_SQL);

    let raised = null;
    try {
      dockerExecSql(sabotagedSql);
    } catch (err) {
      raised = err;
    }

    // The RAISE EXCEPTION inside the DO block aborts the transaction
    // and surfaces as a query error to psql. The message must include
    // the canonical safety-net phrase from the migration's final
    // sanity check.
    expect(raised).not.toBeNull();
    expect(String(raised.psqlOutput || raised.message)).toMatch(/payslip: partial-unique still in wrong shape/);
  });

  // ─── REAL sabotage cases ────────────────────────────────────────────────
  // The drift detector must self-heal (DROP + recreate) when the index
  // exists but in the wrong shape, and refuse (RAISE EXCEPTION) when the
  // recreate-step SQL is itself wrong. Both halves are covered by the
  // "RAISE EXCEPTION when recreate ships wrong shape" test above.
  //
  // These tests below exercise the SELF-HEAL path with concrete shape
  // breakages: predicate drop, column list change, column list reorder.
  // After each self-heal, EXACTLY ONE `payslip_active_per_month_uidx`
  // index must exist with the canonical shape.

  it('self-heals when the WHERE predicate is dropped (deleted_at removed)', async () => {
    await resetSchema();
    dockerExecSql(CREATE_TABLE_SQL);
    dockerExecSql(PARTIAL_UNIQUE_SQL);
    dockerExecSql(RLS_SQL);

    // Sabotage: drop and recreate WITHOUT the WHERE clause. The drift
    // detector must detect the missing predicate, drop, and recreate.
    dockerExecOne('DROP INDEX payslip_active_per_month_uidx');
    dockerExecOne(
      'CREATE UNIQUE INDEX payslip_active_per_month_uidx ' +
      'ON public.payslip (employee_id, year, month)',
    );

    // Confirm the sabotaged state really is missing the predicate.
    const sabotagedDef = dockerExecOne(
      "SELECT pg_get_indexdef(c.oid) FROM pg_class c WHERE c.relname = 'payslip_active_per_month_uidx'",
    );
    expect(sabotagedDef).not.toMatch(/WHERE/);

    // Re-run migration → drift detector drops + recreates with canonical shape.
    dockerExecSql(PARTIAL_UNIQUE_SQL);

    const def = dockerExecOne(
      "SELECT pg_get_indexdef(c.oid) FROM pg_class c WHERE c.relname = 'payslip_active_per_month_uidx'",
    );
    expect(def).toMatch(/payslip/);
    expect(def).toMatch(/\(employee_id, year, month\)/);
    expect(def).toMatch(/WHERE \(deleted_at IS NULL\)/);

    // Exactly one partial-unique index must exist after self-heal.
    const count = dockerExecOne(
      "SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid " +
      "WHERE c.relname = 'payslip_active_per_month_uidx'",
    );
    expect(count).toBe('1');
  });

  it('self-heals when the column list is changed (drops the month column)', async () => {
    await resetSchema();
    dockerExecSql(CREATE_TABLE_SQL);
    dockerExecSql(PARTIAL_UNIQUE_SQL);
    dockerExecSql(RLS_SQL);

    // Sabotage: recreate without `month`. This is a real shape break —
    // a (employee_id, year) UNIQUE allows two active payslips in the
    // same year (Jan payslip + Dec payslip both for employee X for
    // 2026, neither for the tombstone predicate). Drift detector
    // catches the missing `(employee_id, year, month)` substring.
    dockerExecOne('DROP INDEX payslip_active_per_month_uidx');
    dockerExecOne(
      'CREATE UNIQUE INDEX payslip_active_per_month_uidx ' +
      'ON public.payslip (employee_id, year) WHERE deleted_at IS NULL',
    );

    dockerExecSql(PARTIAL_UNIQUE_SQL);

    const def = dockerExecOne(
      "SELECT pg_get_indexdef(c.oid) FROM pg_class c WHERE c.relname = 'payslip_active_per_month_uidx'",
    );
    expect(def).toMatch(/\(employee_id, year, month\)/);
    expect(def).toMatch(/WHERE \(deleted_at IS NULL\)/);

    const count = dockerExecOne(
      "SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid " +
      "WHERE c.relname = 'payslip_active_per_month_uidx'",
    );
    expect(count).toBe('1');
  });

  it('self-heals when columns are reordered (year, employee_id, month)', async () => {
    await resetSchema();
    dockerExecSql(CREATE_TABLE_SQL);
    dockerExecSql(PARTIAL_UNIQUE_SQL);
    dockerExecSql(RLS_SQL);

    // Sabotage: reorder columns to (year, employee_id, month). The
    // leading-column uniqueness semantics change — the index becomes
    // unique on year first, then employee_id. Two employees with
    // different years, same year-employee pair would still conflict
    // because of the WHERE predicate... wait, actually Postgres
    // doesn't reorder columns on its own (verified empirically —
    // pg_get_indexdef preserves the declared column order). The
    // drift detector's substring check on `(employee_id, year,
    // month)` correctly fails.
    dockerExecOne('DROP INDEX payslip_active_per_month_uidx');
    dockerExecOne(
      'CREATE UNIQUE INDEX payslip_active_per_month_uidx ' +
      'ON public.payslip (year, employee_id, month) WHERE deleted_at IS NULL',
    );

    dockerExecSql(PARTIAL_UNIQUE_SQL);

    const def = dockerExecOne(
      "SELECT pg_get_indexdef(c.oid) FROM pg_class c WHERE c.relname = 'payslip_active_per_month_uidx'",
    );
    expect(def).toMatch(/\(employee_id, year, month\)/);

    const count = dockerExecOne(
      "SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid " +
      "WHERE c.relname = 'payslip_active_per_month_uidx'",
    );
    expect(count).toBe('1');
  });

  // ─── Counter-evidence to an earlier (now retracted) claim ─────────────
  // Earlier checkpoints reported "Postgres silently collapses extra
  // unique-index columns that don't affect uniqueness." That claim
  // is FALSE. Empirical reproduction (2026-10-03, throwaway Postgres
  // 17-alpine):
  //
  //   A canonical  (employee_id, year, month)
  //     → pg_get_indexdef reports 3 columns (indkey = 2 3 4)
  //   B + upload_intent_ulid  (UNIQUE constraint of its own)
  //     → pg_get_indexdef reports 4 columns (indkey = 2 3 4 6)
  //   C + size_bytes  (no uniqueness of its own)
  //     → pg_get_indexdef reports 4 columns (indkey = 2 3 4 9)
  //
  // Postgres does NOT collapse redundant columns out of a UNIQUE
  // index. The drift detector's substring check on
  // `(employee_id, year, month)` therefore reliably detects the
  // column-list break — there is no implicit guard from PG itself.
  // The following test pins the no-collapse behavior so a future PG
  // version that DOES start collapsing surfaces as a test failure.

  it('Postgres does NOT collapse extra columns from a UNIQUE partial index', async () => {
    await resetSchema();
    dockerExecSql(CREATE_TABLE_SQL);

    // Create the partial unique index plus an extra redundant column.
    dockerExecOne(
      'CREATE UNIQUE INDEX payslip_active_per_month_uidx ' +
      'ON public.payslip (employee_id, year, month, upload_intent_ulid) ' +
      'WHERE deleted_at IS NULL',
    );

    const numCols = dockerExecOne(
      "SELECT indnatts FROM pg_index WHERE indexrelid = 'payslip_active_per_month_uidx'::regclass",
    );
    const colKeys = dockerExecOne(
      "SELECT indkey::text FROM pg_index WHERE indexrelid = 'payslip_active_per_month_uidx'::regclass",
    );

    // The index must carry ALL FOUR, including the extra
    // `upload_intent_ulid` (column attnum 6 in payslip). If a future
    // PG version starts collapsing, this assertion catches the
    // behavior change before a deploy ships with a partial-unique
    // that admits duplicate active rows.
    expect(numCols).toBe('4');
    expect(colKeys).toBe('2 3 4 6');
  });

  it('RLS migration (20261002010002_payslip_rls) enables RLS + 2 deny policies + is idempotent', async () => {
    await resetSchema();
    dockerExecSql(CREATE_TABLE_SQL);
    dockerExecSql(PARTIAL_UNIQUE_SQL);
    dockerExecSql(RLS_SQL);

    const rls = dockerExecOne("SELECT relrowsecurity FROM pg_class WHERE relname = 'payslip'");
    expect(rls).toBe('t');

    const policyCount = dockerExecOne(
      "SELECT count(*) FROM pg_policy WHERE polrelid = 'public.payslip'::regclass",
    );
    // Two deny policies: payslip_deny_anon + payslip_deny_authenticated.
    expect(policyCount).toBe('2');

    const policyNames = dockerExecOne(
      "SELECT string_agg(polname, ',' ORDER BY polname) FROM pg_policy WHERE polrelid = 'public.payslip'::regclass",
    );
    expect(policyNames).toBe('payslip_deny_anon,payslip_deny_authenticated');

    // Re-running the RLS migration must be a no-op (idempotency).
    dockerExecSql(RLS_SQL);
    const policyCount2 = dockerExecOne(
      "SELECT count(*) FROM pg_policy WHERE polrelid = 'public.payslip'::regclass",
    );
    expect(policyCount2).toBe('2');
  });
});