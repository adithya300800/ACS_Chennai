#!/usr/bin/env node
// scripts/clear-failed-migrations.js
//
// [N1] Phase-A migration recovery — operator-only tool.
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
// [DR-032] Operator-only opt-in.
// -----------------------------
// This script is NOT wired into any npm lifecycle hook (postinstall was
// removed in DR-032 — `npm install` is database-free now). The Render
// deploy path is `start.sh`, which is the SOLE serialized release/
// operator recovery procedure. To invoke this script intentionally
// outside that path, the operator must set
//   OPS_RECONCILE_FAILED_MIGRATIONS=1
// before running it. There is no RENDER auto-fire, no CI auto-fire, no
// lifecycle auto-fire — explicit opt-in only. This guards against a
// concurrent unfinished migration being clobbered by an unrelated
// install/build.
//
// Idempotency.
// ------------
// The DELETE only matches rows that are clearly NOT applied. On a healthy
// DB the WHERE clause matches zero rows and the script exits 0.
//
// KNOWN_BAD is the allow-list. Add new entries as you discover migration
// failures you can't reach via `migrate resolve --rolled-back`. Two
// entries today; the format is just the migration directory's basename.

'use strict';

const { PrismaClient } = require('@prisma/client');

const KNOWN_BAD = Object.freeze([
  '20260905020000_n17_projects',     // original n17 referenced wrong FK table
  '20260906000000_n1_project_fk',    // original n1 used wrong column case
                                     //   (file deleted from disk in d8554a3;
                                     //    failed DB row may still exist from
                                     //    earlier deploys — delete here too)
]);

(async () => {
  // [DR-032] Explicit operator opt-in only. No RENDER auto-fire, no CI
  // auto-fire, no lifecycle auto-fire. `npm install` is DB-free; the
  // Render deploy path is start.sh.
  if (process.env.OPS_RECONCILE_FAILED_MIGRATIONS !== '1') {
    console.log('[clear-failed-migrations] OPS_RECONCILE_FAILED_MIGRATIONS!=1, skipping (DB-free install path)');
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
      // `applied_steps_count`. The corrective migration is idempotent
      // (`ADD COLUMN IF NOT EXISTS`, etc.) so deleting a row that was
      // somehow applied won't cause data drift — re-applying the
      // corrective migration recreates any partially-applied DDL harmlessly.
      //
      // [DR-031] Guard the DELETE so it ONLY matches rows that are clearly
      // NOT applied: rolled back, or never finished. A successfully-applied
      // row has finished_at NOT NULL AND applied_steps_count > 0 AND
      // rolled_back_at IS NULL. Excluding that combination prevents a
      // migration-name collision or typo from clobbering a legitimate
      // ledger row and forcing `migrate deploy` to re-apply DDL.
      const res = await prisma.$executeRawUnsafe(
        "DELETE FROM \"_prisma_migrations\" WHERE \"migration_name\" = '" +
        name +
        "' AND \"rolled_back_at\" IS NULL AND (\"finished_at\" IS NULL OR \"applied_steps_count\" = 0)",
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
