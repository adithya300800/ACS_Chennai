#!/bin/sh
# start.sh — Render container start command
#
# [DR-032] Recovery is NOT performed at start time. Operators run
# `npm run db:recover -- --confirmed-abandoned` explicitly after inspecting
# the ledger and verifying backup readiness — install/upgrade is now
# DB-free, and recovery is not duplicated between postinstall and start.
#
# This script's only job is to apply pending migrations and fail before
# serving if anything is wrong (failure-before-serving):
#   1. `npx prisma migrate deploy` runs against $DATABASE_URL /
#      $DIRECT_DATABASE_URL. P3009 (failed migrations in the target DB)
#      will exit non-zero here, and the container does NOT start.
#   2. On success, `node src/index.js` execs and serves.
#
# Known-bad migrations that operators may need to clear via db:recover
# (kept here as documentation; the script no longer touches them):
#   - 20260905020000_n17_projects    — original n17 migration referenced
#       the wrong table for the FK (employee singular vs employees
#       plural); the corrective migration 20260905030000_fix_n17_employee_fk
#       recreates the project table correctly.
#   - 20260906000000_n1_project_fk    — original n1 migration referenced
#       snake_case "project_name" in the backfill, but the DPR /
#       InspectionRecord columns are camelCase quoted "projectName" (no
#       @map on the schema field). The corrective migration
#       20260906000001_n1_project_fk_fix re-runs the DDL with corrected
#       backfill column names.
#   - 20260908150000_dr031_leave_constraint_correct_bound — shipped
#       with a SQL syntax bug at lines 82/113 (`''[]''` parsed as
#       empty-string + stray-array + empty-string). Fixed in the
#       migration file (SQL now uses `'[]'`); the bootstrap resolve
#       block below clears the errored ledger row so migrate deploy
#       can re-apply the corrected SQL on the first start after the
#       fix lands. Idempotent: `migrate resolve --rolled-back` on a
#       migration that's not in errored state exits non-zero, so we
#       swallow that. After the first successful re-apply, this block
#       is a no-op on every subsequent start.

set -e

# [DR-031-SQLFIX] Bootstrap recovery: clear the errored ledger row for
# the DR-031 migration so `prisma migrate deploy` can re-apply the
# (now-fixed) SQL. `migrate resolve` exits non-zero when the named
# migration is not in errored state, which is the steady-state for
# every start after the first successful recovery. The `|| true`
# swallows that non-zero exit so we don't fail-fast on the steady
# state. If the DB is unreachable, `migrate resolve` exits
# non-zero AND `migrate deploy` below will also fail — the same
# failure surface as before this block was added, no worse.
#
# NOTE: as of 2026-09-10 the LIVE Render service's dashboard
# startCommand is `npx prisma migrate deploy && node src/index.js`,
# which bypasses this script. render.yaml declares
# `startCommand: sh start.sh` and the dashboard comment notes that
# the dashboard value is authoritative. The bootstrap recovery ALSO
# lives in the backend-deploy.yml workflow's "DR-031-SQLFIX bootstrap
# resolve" step, which runs before the CI triggers Render's deploy,
# so the deploy recovers even while the dashboard is out of sync.
# Once the dashboard is re-synced, this script's bootstrap is the
# canonical path and the CI step is a redundant safety net.
echo "[start.sh] one-shot DR-031 ledger resolve (no-op once recovered)"
npx prisma migrate resolve --rolled-back 20260908150000_dr031_leave_constraint_correct_bound >/dev/null 2>&1 || true

echo "[start.sh] Running prisma migrate deploy (failure-before-serving; no recovery auto-runs)"
npx prisma migrate deploy
RC=$?
if [ "$RC" -ne 0 ]; then
  echo "[start.sh] prisma migrate deploy FAILED with rc=$RC"
  echo "[start.sh] Inspect the ledger with: npm run db:recover"
  echo "[start.sh] After confirming DDL + backup readiness, clear with: npm run db:recover -- --confirmed-abandoned"
  exit $RC
fi

echo "[start.sh] Migrate deploy OK; starting node src/index.js"
exec node src/index.js
