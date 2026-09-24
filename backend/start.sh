#!/bin/sh
# start.sh — Render container start command
#
# [DR-035 2026-09-24] Bootstrap-resolve is RETIRED from ordinary
# startup. Pre-DR-035, start.sh auto-issued `prisma migrate resolve
# --rolled-back` for an allowlisted set (DR-031 + S7) on every cold
# start. That meant a newly failed migration matching the allowlist
# would be silently reclassified by ordinary startup — exactly the
# "ordinary startup still performs migration recovery exceptions"
# hazard DR-035 calls out.
#
# The recovery loop body now lives in backend/scripts/reconcile-failed-migrations.sh
# and is invoked EXPLICITLY — either by setting DR031_RECONCILE=1 on
# the CI deploy workflow (which then calls the script from a gated
# step), or by an operator running the script directly after
# inspecting partial DDL. Ordinary pushes do NOT set DR031_RECONCILE,
# so the gated CI step is skipped and Render's startup never sees
# the reconcile loop.
#
# [DR-032] Recovery is NOT performed at start time. Operators run
# `npm run db:recover -- --confirmed-abandoned` explicitly after
# inspecting the ledger and verifying backup readiness — install/upgrade
# is now DB-free, and recovery is not duplicated between postinstall
# and start.
#
# This script's only job is to apply pending migrations and fail before
# serving if anything is wrong (failure-before-serving):
#   1. `npx prisma migrate deploy` runs against $DATABASE_URL /
#      $DIRECT_DATABASE_URL. P3009 (failed migrations in the target DB)
#      will exit non-zero here, and the container does NOT start.
#   2. On success, `node src/index.js` execs and serves.
#
# Known-bad migrations that operators may need to clear via the
# reconcile script (kept here as documentation; the script no longer
# touches them — see backend/scripts/reconcile-failed-migrations.sh
# for the operations tool):
#   - 20260908150000_dr031_leave_constraint_correct_bound — broken `''[]''`
#       literal (DR-031-SQLFIX 2026-09-10). SQL fixed in place.
#   - 20260912070000_s7_project_attachment_review         — singular "employee"
#       FK target (S7-SQLFIX 2026-09-12). SQL corrected to "employees".
#   - 20260924100000_dr025_correction_cancelled           — lowercase
#       enum identifier (DR-025 2026-09-24). SQL corrected to PascalCase.

set -e

echo "[start.sh] Running prisma migrate deploy (failure-before-serving; no auto-recovery)"
npx prisma migrate deploy
RC=$?
if [ "$RC" -ne 0 ]; then
  echo "[start.sh] prisma migrate deploy FAILED with rc=$RC"
  echo "[start.sh] If this is a known-bad allowlisted migration, set DR031_RECONCILE=1 on the deploy workflow to clear it before retrying."
  echo "[start.sh] For one-off / partial DDL inspection, run: sh backend/scripts/reconcile-failed-migrations.sh"
  echo "[start.sh] Or: npm run db:recover -- --confirmed-abandoned"
  exit $RC
fi

echo "[start.sh] Migrate deploy OK; starting node src/index.js"
exec node src/index.js