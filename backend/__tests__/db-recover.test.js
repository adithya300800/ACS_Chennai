/**
 * DR-032 followup — db:recover is the ONLY operator-triggered
 * recovery path. This test pins:
 *
 *  1. Without `--confirmed-abandoned` AND without
 *     RENDER / POSTINSTALL_CLEAR_MIGRATIONS env vars: the script
 *     short-circuits (no DB call). This is the safe default for any
 *     accidental invocation (`npm run db:recover` in dev without
 *     intent to mutate).
 *
 *  2. Without `--confirmed-abandoned` but WITH RENDER=true or
 *     POSTINSTALL_CLEAR_MIGRATIONS=1: the script runs a READ-ONLY
 *     inspection. SELECT only — never DELETE. Exits non-zero if
 *     non-applied rows are found.
 *
 *  3. With `--confirmed-abandoned`: the script runs the destructive
 *     DELETE. The DELETE SQL must include the NOT-applied guard
 *     (DR-031), so a successfully-applied row can never be clobbered.
 *
 *  4. `start.sh` does NOT auto-recover in general. The ONLY exception
 *     is the [DR-031-SQLFIX] bootstrap block (one-shot `migrate
 *     resolve --rolled-back` for migration
 *     20260908150000_dr031_leave_constraint_correct_bound), which
 *     is narrowly scoped, idempotent (`|| true` swallows the non-zero
 *     exit when the migration isn't in errored state), and exists
 *     because the deploy at commit cf697e7 failed with a SQL syntax
 *     bug and the production DB is locked behind that errored row.
 *     The pins below allow THAT resolve call and pin its narrow scope;
 *     any future auto-recovery addition is a red flag that needs
 *     re-justification.
 *
 *  5. The CI workflow runs a read-only inspection step that points
 *     operators at `npm run db:recover -- --confirmed-abandoned`
 *     when non-applied rows are found.
 *
 * Together these pins prevent silent auto-recovery from being
 * re-introduced — the DR-031-SQLFIX exception is the only allowed
 * auto-recovery, and it is documented in source as a one-shot.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const CLEAR_SCRIPT = path.join(REPO, 'backend', 'scripts', 'clear-failed-migrations.js');
const START_SH = path.join(REPO, 'backend', 'start.sh');
const CI_WORKFLOW = path.join(REPO, '.github', 'workflows', 'backend-deploy.yml');
const PKG_JSON = path.join(REPO, 'backend', 'package.json');

// ---------- 1. Source-file pins ----------

describe('db:recover — operator-only recovery', () => {
  const clearSrc = fs.readFileSync(CLEAR_SCRIPT, 'utf8');
  const startSrc = fs.readFileSync(START_SH, 'utf8');
  const ciSrc = fs.readFileSync(CI_WORKFLOW, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(PKG_JSON, 'utf8'));

  test('package.json exposes db:recover wired to the operator script', () => {
    expect(pkg.scripts['db:recover']).toBe('node scripts/clear-failed-migrations.js');
  });

  test('package.json has no postinstall hook (install stays DB-free)', () => {
    expect(pkg.scripts).not.toHaveProperty('postinstall');
  });

  test('clear-failed-migrations.js destructive path requires --confirmed-abandoned arg', () => {
    // CONFIRMED_ABANDONED must be derived from process.argv, not from
    // an env var alone — operator intent is required at the CLI level.
    expect(clearSrc).toMatch(/process\.argv\.includes\(['"]--confirmed-abandoned['"]\)/);
  });

  test('clear-failed-migrations.js inspection exits non-zero on non-applied rows', () => {
    expect(clearSrc).toMatch(/process\.exitCode\s*=\s*1/);
  });

  test('clear-failed-migrations.js inspection is read-only ($queryRawUnsafe, not DELETE)', () => {
    // inspectLedger() must use SELECT, never DELETE.
    expect(clearSrc).toMatch(/inspectLedger[\s\S]+?\$queryRawUnsafe/);
    expect(clearSrc).toMatch(/FROM\s+"\\_prisma_migrations"|FROM\s+"_prisma_migrations"/);
  });

  test('clear-failed-migrations.js destructive DELETE has the NOT-applied guard', () => {
    // [DR-031] guard preserved in the destructive path.
    // The source uses JS-escaped quotes inside a string literal
    // (`\"_prisma_migrations\"`) — match flexibly, ignoring the
    // backslash escapes and pinning only the table identifier.
    expect(clearSrc).toMatch(/DELETE\s+FROM[^_]*_prisma_migrations/);
    expect(clearSrc).toMatch(/rolled_back_at.*IS\s+NULL/s);
    expect(clearSrc).toMatch(/finished_at.*IS\s+NULL.*applied_steps_count.*=\s*0/s);
  });

  test('start.sh no longer auto-deletes _prisma_migrations rows', () => {
    expect(startSrc).not.toMatch(/DELETE\s+FROM[^_]*_prisma_migrations/i);
  });

  test('start.sh no longer auto-runs prisma migrate resolve (DR-035 retired bootstrap-resolve)', () => {
    // DR-035 (2026-09-24) retired the bootstrap-resolve loop entirely.
    // Pre-DR-035, start.sh auto-issued `prisma migrate resolve
    // --rolled-back` for a narrow allowlist (DR-031 + S7) on every
    // cold start — exactly the "ordinary startup still performs
    // migration recovery exceptions" hazard DR-035 calls out. The
    // recovery loop body now lives in
    // `backend/scripts/reconcile-failed-migrations.sh`, invoked
    // explicitly via the DR031_RECONCILE=1 gated CI step OR by an
    // operator running the script directly. Ordinary pushes do NOT
    // set DR031_RECONCILE, so Render startup never sees the reconcile
    // loop. The failure message that start.sh prints DOES still
    // document the explicit tool (see the next test).
    //
    // Note: start.sh references `prisma migrate resolve` in the
    // header comment explaining what DR-035 retired. Filter
    // comment lines before counting resolve invocations.
    const codeOnly = startSrc
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    const resolveCalls = codeOnly.match(/prisma\s+migrate\s+resolve[^\n]*/g) || [];
    expect(resolveCalls.length).toBe(0);
    // The known-bad migration names documented in start.sh (DR-031 +
    // S7 + DR-025) appear only in COMMENTS, never as a for-loop
    // iterable that gets fed into `prisma migrate resolve`.
    expect(codeOnly).not.toMatch(/for\s+MIG\s+in[\s\S]*prisma\s+migrate\s+resolve/);
  });

  test('start.sh runs prisma migrate deploy and fails fast on non-zero exit', () => {
    expect(startSrc).toMatch(/prisma migrate deploy/);
    expect(startSrc).toMatch(/RC=\$\?/);
    expect(startSrc).toMatch(/exit \$?RC/);
  });

  test('start.sh tells operators to use db:recover on failure', () => {
    expect(startSrc).toMatch(/npm run db:recover/);
  });

  test('CI workflow never auto-deletes ledger rows', () => {
    expect(ciSrc).not.toMatch(/DELETE\s+FROM[^_]*_prisma_migrations/i);
  });

  test('CI workflow points operators at db:recover -- --confirmed-abandoned', () => {
    expect(ciSrc).toMatch(/npm run db:recover\s+--\s+--confirmed-abandoned/);
  });
});

// ---------- 2. Runtime confirmation-guard test ----------

describe('db:recover — confirmation guard at runtime', () => {
  // Mock @prisma/client so we never touch a real DB. Track every
  // query / execute so we can assert that the destructive path is
  // gated by the CLI flag.
  const capturedQueries = [];
  let mockExecuteRawUnsafe;
  let mockQueryRawUnsafe;
  let mockDisconnect;

  function loadScriptWithMocks(argv, env) {
    jest.resetModules();
    capturedQueries.length = 0;
    mockExecuteRawUnsafe = jest.fn((sql) => {
      capturedQueries.push({ kind: 'execute', sql });
      return Promise.resolve(0);
    });
    mockQueryRawUnsafe = jest.fn((sql) => {
      capturedQueries.push({ kind: 'query', sql });
      return Promise.resolve([]);
    });
    mockDisconnect = jest.fn(() => Promise.resolve());
    jest.doMock('@prisma/client', () => ({
      PrismaClient: jest.fn().mockImplementation(() => ({
        $executeRawUnsafe: mockExecuteRawUnsafe,
        $queryRawUnsafe: mockQueryRawUnsafe,
        $disconnect: mockDisconnect,
      })),
    }));
    const originalArgv = process.argv;
    const originalEnv = { ...process.env };
    process.argv = argv;
    Object.assign(process.env, env);
    return { originalArgv, originalEnv };
  }

  function unloadScript(originals) {
    process.argv = originals.originalArgv;
    for (const [k, v] of Object.entries(originals.originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    jest.unmock('@prisma/client');
    jest.dontMock('@prisma/client');
  }

  test('without --confirmed-abandoned AND without RENDER/POSTINSTALL: short-circuits', async () => {
    const o = loadScriptWithMocks(
      ['node', 'clear-failed-migrations.js'],
      {
        DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
        // RENDER and POSTINSTALL_CLEAR_MIGRATIONS deliberately unset
      },
    );
    delete process.env.RENDER;
    delete process.env.POSTINSTALL_CLEAR_MIGRATIONS;
    try {
      require('../scripts/clear-failed-migrations.js');
      await Promise.resolve(); // flush microtasks
      expect(mockExecuteRawUnsafe).not.toHaveBeenCalled();
      expect(mockQueryRawUnsafe).not.toHaveBeenCalled();
    } finally {
      unloadScript(o);
    }
  });

  test('with --confirmed-abandoned: destructive DELETE runs (DR-031 guard preserved)', async () => {
    const o = loadScriptWithMocks(
      ['node', 'clear-failed-migrations.js', '--confirmed-abandoned'],
      {
        DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      },
    );
    try {
      require('../scripts/clear-failed-migrations.js');
      // Wait for the IIFE to settle.
      await new Promise((resolve) => setImmediate(resolve));
      const executes = capturedQueries.filter((q) => q.kind === 'execute');
      expect(executes.length).toBeGreaterThan(0);
      executes.forEach(({ sql }) => {
        expect(sql).toMatch(/_prisma_migrations/);
        expect(sql).toMatch(/migration_name/);
        // NOT-applied guard.
        expect(sql).toMatch(/"rolled_back_at"\s+IS\s+NULL/);
        expect(sql).toMatch(/"finished_at"\s+IS\s+NULL/);
        expect(sql).toMatch(/"applied_steps_count"\s*=\s*0/);
      });
    } finally {
      unloadScript(o);
    }
  });

  test('inspection path (RENDER=true, no flag): SELECT only — no DELETE', async () => {
    const o = loadScriptWithMocks(
      ['node', 'clear-failed-migrations.js'],
      {
        RENDER: 'true',
        DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      },
    );
    try {
      require('../scripts/clear-failed-migrations.js');
      await new Promise((resolve) => setImmediate(resolve));
      const executes = capturedQueries.filter((q) => q.kind === 'execute');
      expect(executes).toHaveLength(0);
      const queries = capturedQueries.filter((q) => q.kind === 'query');
      expect(queries.length).toBeGreaterThan(0);
      queries.forEach(({ sql }) => {
        expect(sql).toMatch(/FROM\s+"_prisma_migrations"/);
        expect(sql).not.toMatch(/DELETE/);
      });
    } finally {
      unloadScript(o);
    }
  });
});

// ---------- 3. start.sh detection logic ----------

describe('start.sh — detection logic for failed migrations', () => {
  // We don't run the whole start.sh (it requires a real DB); we test
  // that the script's source pins the detection contract:
  //   1. Runs ONLY `prisma migrate deploy` (no DELETE / resolve).
  //   2. Captures the exit code via `RC=$?`.
  //   3. Exits non-zero on failure with a message that points at
  //      `npm run db:recover -- --confirmed-abandoned`.

  const startSrc = fs.readFileSync(START_SH, 'utf8');

  test('does not invoke any auto-recovery helper (DR-035 retired all bootstrap-resolve)', () => {
    // Auto-recovery hooks that must be absent from start.sh.
    // Note: start.sh legitimately documents `--confirmed-abandoned` in
    // comments + the failure message that points operators at
    // db:recover. What we pin here is the absence of any actual
    // *execution* of the recovery script.
    //
    // DR-035 (2026-09-24) retired the bootstrap-resolve loop entirely
    // — the previous DR-031-SQLFIX exception is no longer present in
    // start.sh. Filter comments so the header doc-block explaining
    // what was retired doesn't false-positive the resolve-call count.
    const codeOnly = startSrc
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    const resolveCalls = codeOnly.match(/prisma\s+migrate\s+resolve[^\n]*/g) || [];
    expect(resolveCalls.length).toBe(0);
    expect(codeOnly).not.toMatch(/clear-failed-migrations/);
    expect(codeOnly).not.toMatch(/POSTINSTALL_CLEAR_MIGRATIONS/);
    expect(codeOnly).not.toMatch(/OPS_RECONCILE_FAILED_MIGRATIONS/);
    expect(codeOnly).not.toMatch(/node\s+scripts\//);
    expect(codeOnly).not.toMatch(/node\s+-e/);
    // The known-bad migration names documented in start.sh appear
    // only in comments. The bootstrap loop body is gone.
    expect(codeOnly).not.toMatch(/20260908150000_dr031_leave_constraint_correct_bound/);
  });

  test('runs prisma migrate deploy and surfaces its exit code', () => {
    expect(startSrc).toMatch(/npx\s+prisma\s+migrate\s+deploy/);
    expect(startSrc).toMatch(/RC=\$\?/);
  });

  test('exits non-zero BEFORE exec-ing node on migrate deploy failure', () => {
    // The script must check the exit code and exit before `exec node`.
    // Capture the substring before "exec node" and assert the
    // exit-non-zero branch lives there.
    const execNodeIdx = startSrc.search(/exec\s+node\s+src\/index\.js/);
    expect(execNodeIdx).toBeGreaterThan(-1);
    const beforeExec = startSrc.slice(0, execNodeIdx);
    expect(beforeExec).toMatch(/exit\s+\$?RC/);
  });

  test('on failure, logs an actionable operator instruction', () => {
    // The failure message must tell the operator exactly what to do.
    // DR-035 (2026-09-24) reordered the failure-path pointers: the new
    // primary pointer is the DR031_RECONCILE flow + the
    // reconcile-failed-migrations.sh script (the explicit operations
    // tool extracted from the retired inline bootstrap loop). The
    // legacy `npm run db:recover -- --confirmed-abandoned` remains as
    // a fallback for operators who already have the destructive
    // workflow in their hands.
    expect(startSrc).toMatch(/set DR031_RECONCILE=1 on the deploy workflow/);
    expect(startSrc).toMatch(/scripts\/reconcile-failed-migrations\.sh/);
    expect(startSrc).toMatch(/npm run db:recover\s+--\s+--confirmed-abandoned/);
  });

  test('exec node src/index.js on success (the last line before exit)', () => {
    // Sanity: the success path is `exec node src/index.js`.
    expect(startSrc.trim().endsWith('exec node src/index.js')).toBe(true);
  });
});
