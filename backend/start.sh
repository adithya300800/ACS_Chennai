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

set -e

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
