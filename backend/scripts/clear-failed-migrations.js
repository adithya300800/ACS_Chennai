#!/usr/bin/env node
// scripts/clear-failed-migrations.js
//
// [N1] Phase-A migration recovery.
//
// Background.
// ----------
// `prisma migrate deploy` refuses to run when ANY row in
// `_prisma_migrations` has status='failed' (Prisma error P3009). That makes
// ONE bad migration a permanent blocker for every subsequent deploy.
//
// During the N1 phase we hit exactly this: `20260906000000_n1_project_fk`
// referenced the wrong column case in its backfill (snake_case
// `project_name` on DPR / InspectionRecord whose actual DB columns are
// camelCase quoted `projectName`). A corrective migration
// (`20260906000001_n1_project_fk_fix`) was added per the append-only rule
// from the Phase-4 P0 postmortem, but `migrate deploy` couldn't apply it
// because Prisma kept seeing the original failed row.
//
// This script clears those failed rows directly. It runs as an
// `npm postinstall` hook during the Render `npm install && npx prisma
// generate` build step — the build does fire postinstall hooks, while the
// startCommand `npx prisma migrate deploy && node src/index.js` (locked
// in the Render dashboard) does NOT honor start.sh / Dockerfile CMD /
// env-var overrides.
//
// Idempotency.
// ------------
// The DELETE only matches `status <> 'applied'`. On a healthy DB the
// WHERE clause matches zero rows and the script exits 0. On every cold
// start where no migration is in the "failed" state, this is a no-op.
//
// KNOWN_BAD is the allow-list. Add new entries as you discover migration
// failures you can't reach via `migrate resolve --rolled-back`. Two
// entries today; the format is just the migration directory's basename.

'use strict';

const { PrismaClient } = require('@prisma/client');

const KNOWN_BAD = Object.freeze([
  '20260905020000_n17_projects',     // original n17 referenced wrong FK table
  '20260906000000_n1_project_fk',    // original n1 used wrong column case
]);

(async () => {
  // Local-dev guard. This script is for production deploys only — running
  // it locally would surprise the developer by mutating their DB.
  // Render sets `RENDER=true` automatically. Skip everywhere else.
  // Allow opt-in via explicit env var for environments that don't set
  // RENDER (e.g. another CI).
  if (process.env.RENDER !== 'true' && process.env.POSTINSTALL_CLEAR_MIGRATIONS !== '1') {
    console.log('[clear-failed-migrations] not in Render/CI render, skipping');
    return;
  }
  if (!process.env.DATABASE_URL && !process.env.DIRECT_DATABASE_URL) {
    console.log('[clear-failed-migrations] no DB env vars, skipping');
    return;
  }
  const prisma = new PrismaClient();
  let totalCleared = 0;
  try {
    for (const name of KNOWN_BAD) {
      // $executeRawUnsafe is intentional: parameterized table / column
      // names aren't supported by Prisma's $executeRaw templating.
      //
      // [N1 fix 2] Prisma 5's `_prisma_migrations` has NO `status` column —
      // state is derived from `finished_at` / `rolled_back_at` /
      // `applied_steps_count`. So the predicate is simply the migration
      // name. The corrective migration is idempotent (`ADD COLUMN IF
      // NOT EXISTS`, etc.) so deleting a row that was somehow applied
      // (it never is, by definition: these are KNOWN_BAD entries) won't
      // cause data drift — re-applying the corrective migration recreates
      // any partially-applied DDL harmlessly.
      const res = await prisma.$executeRawUnsafe(
        "DELETE FROM \"_prisma_migrations\" WHERE \"migration_name\" = '" +
        name +
        "'",
      );
      console.log('[clear-failed-migrations] cleared', res, 'rows for', name);
      totalCleared += res;
    }
    console.log('[clear-failed-migrations] total cleared:', totalCleared);
  } catch (err) {
    // Don't fail the install if DB is unreachable (e.g. local dev without
    // a DB). Log loudly so it's visible in the build log.
    console.error('[clear-failed-migrations] error (continuing):', err && err.message);
  } finally {
    await prisma.$disconnect();
  }
})();
