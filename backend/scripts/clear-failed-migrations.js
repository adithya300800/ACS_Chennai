#!/usr/bin/env node
// scripts/clear-failed-migrations.js
//
// [DR-032] Migration ledger recovery — operator tool. NO LONGER auto-delete.
//
// History
// -------
// Originally a `postinstall` hook that auto-deleted non-applied rows from
// `_prisma_migrations` to unblock P3009. That made install/upgrade
// destructive: any concurrent unfinished migration (which also matches
// "null finished/rolled-back timestamps") would be silently deleted by the
// allowlist. Recovery is now an EXPLICIT operator action — install is
// database-free, the start script fails before serving if migrate-deploy
// fails, and an operator must inspect the ledger and run this script with
// `--confirmed-abandoned` to clear rows.
//
// Default behavior (no flag): READ-ONLY inspection
//   - Lists rows matching the allowlist with their state
//   - PRESERVES all rows — never touches the ledger
//   - Exits 1 with a recovery message if any non-applied rows exist
//     (operator decides what to do)
//
// --confirmed-abandoned: DESTRUCTIVE cleanup
//   - DELETES allowlisted rows where rolled_back_at IS NULL AND
//     (finished_at IS NULL OR applied_steps_count = 0)
//   - Use ONLY after inspecting partial DDL and verifying backup readiness
//
// Operator usage:
//   # Inspect the ledger (safe, default):
//   npm run db:recover
//
//   # After confirming DDL is safe and backup is fresh:
//   npm run db:recover -- --confirmed-abandoned
//
// KNOWN_BAD allowlist (append as new failures are discovered):
//   - 20260905020000_n17_projects (DR-031 history)
//   - 20260906000000_n1_project_fk (DR-031 history)

'use strict';

const { PrismaClient } = require('@prisma/client');

const KNOWN_BAD = Object.freeze([
  '20260905020000_n17_projects',     // original n17 referenced wrong FK table
  '20260906000000_n1_project_fk',    // original n1 used wrong column case
]);

const CONFIRMED_ABANDONED = process.argv.includes('--confirmed-abandoned');

function nameListForSql() {
  // KNOWN_BAD is fixed at module load — no user input. Hand-rolled IN clause
  // because $queryRawUnsafe doesn't take parameter arrays like $queryRaw.
  return KNOWN_BAD.map((n) => "'" + n.replace(/'/g, "''") + "'").join(',');
}

async function inspectLedger(prisma) {
  return prisma.$queryRawUnsafe(
    'SELECT migration_name, finished_at, rolled_back_at, applied_steps_count, started_at ' +
    'FROM "_prisma_migrations" ' +
    'WHERE migration_name IN (' + nameListForSql() + ') ' +
    'ORDER BY started_at ASC',
  );
}

async function deleteAbandonedRows(prisma) {
  // [DR-031] Prisma 5's `_prisma_migrations` has NO `status` column —
  // state is derived from `finished_at` / `rolled_back_at` /
  // `applied_steps_count`. Mirror the DR-031 guard: a successfully-
  // applied row (finished_at NOT NULL AND applied_steps_count > 0 AND
  // rolled_back_at IS NULL) is NEVER touched — a name collision or typo
  // cannot clobber a legitimate ledger row.
  //
  // [DR-032] Only invoked with --confirmed-abandoned. The postinstall
  // path no longer calls this script (postinstall is DB-free).
  let totalCleared = 0;
  for (const name of KNOWN_BAD) {
    const res = await prisma.$executeRawUnsafe(
      "DELETE FROM \"_prisma_migrations\" WHERE \"migration_name\" = '" +
      name +
      "' AND \"rolled_back_at\" IS NULL AND (\"finished_at\" IS NULL OR \"applied_steps_count\" = 0)",
    );
    console.log('[clear-failed-migrations] cleared', res, 'rows for', name);
    totalCleared += res;
  }
  return totalCleared;
}

(async () => {
  // Local-dev guard. The destructive path is for production deploys only —
  // running it locally would surprise the developer by mutating their DB.
  // Render sets `RENDER=true` automatically. Skip everywhere else.
  // Allow opt-in via explicit env var for environments that don't set
  // RENDER (e.g. another CI). --confirmed-abandoned is operator intent and
  // bypasses the guard.
  if (
    !CONFIRMED_ABANDONED &&
    process.env.RENDER !== 'true' &&
    process.env.POSTINSTALL_CLEAR_MIGRATIONS !== '1'
  ) {
    console.log('[clear-failed-migrations] not in Render/CI render, skipping');
    return;
  }
  if (!process.env.DATABASE_URL && !process.env.DIRECT_DATABASE_URL) {
    console.log('[clear-failed-migrations] no DB env vars, skipping');
    return;
  }
  const prisma = new PrismaClient();
  try {
    if (CONFIRMED_ABANDONED) {
      const totalCleared = await deleteAbandonedRows(prisma);
      console.log('[clear-failed-migrations] total cleared:', totalCleared);
      console.log('[clear-failed-migrations] --confirmed-abandoned acknowledged; ledger evidence DESTROYED');
    } else {
      // Read-only inspection — never writes.
      const rows = await inspectLedger(prisma);
      if (rows.length === 0) {
        console.log('[clear-failed-migrations] no allowlisted rows found — ledger clean');
        return;
      }
      console.log('[clear-failed-migrations] inspection — found', rows.length, 'allowlisted rows:');
      let nonAppliedCount = 0;
      for (const r of rows) {
        const finished = r.finished_at === null ? 'NOT FINISHED' : 'finished';
        const applied = r.applied_steps_count > 0 ? 'applied' : 'NOT APPLIED';
        const rolled = r.rolled_back_at === null ? 'NOT ROLLED BACK' : 'rolled back';
        const isNonApplied = r.rolled_back_at === null && (r.finished_at === null || r.applied_steps_count === 0);
        if (isNonApplied) nonAppliedCount += 1;
        console.log(
          '  - ' + r.migration_name +
          ': ' + finished + ' | ' + applied + ' | ' + rolled +
          (isNonApplied ? '  <-- NON-APPLIED' : ''),
        );
      }
      if (nonAppliedCount > 0) {
        console.log('[clear-failed-migrations] PRESERVING ledger evidence (default; install/CI never auto-delete per DR-032).');
        console.log('[clear-failed-migrations] To clear after inspecting partial DDL and verifying backup readiness, run:');
        console.log('  npm run db:recover -- --confirmed-abandoned');
        // Exit non-zero so CI / start.sh can fail-fast on unfinished rows.
        process.exitCode = 1;
      } else {
        console.log('[clear-failed-migrations] all allowlisted rows are applied — ledger is healthy');
      }
    }
  } catch (err) {
    // Don't fail the install if DB is unreachable (e.g. local dev without
    // a DB). Log loudly so it's visible in the build log.
    console.error('[clear-failed-migrations] error (continuing):', err && err.message);
  } finally {
    await prisma.$disconnect();
  }
})();
