#!/bin/sh
# start.sh — Render container start command
#
# Replaces the inline `npx prisma migrate deploy && node src/index.js` that
# render.yaml previously held. The inline form couldn't recover from a failed
# Prisma migration row in `_prisma_migrations` — once Prisma marks a migration
# as failed it refuses to apply any new ones, blocking every subsequent
# deploy (P3009). This script runs the recovery before migrate deploy.
#
# Recovery steps (idempotent — safe on every cold start, no-op when no failed
# rows exist):
#   1. DELETE non-applied rows from `_prisma_migrations` for known-bad
#      migrations. `migrate resolve` only handles the FIRST failed row by
#      name; this belt-and-suspenders DELETE clears the table before the
#      resolve call, so resolve always sees a clean slate.
#   2. `prisma migrate resolve --rolled-back <name>` for each known-bad
#      migration. This is the official path Prisma documents; migrate
#      status reads it.
#
# Known-bad migrations handled here (append as new failures are discovered):
#   - 20260905020000_n17_projects    — original n17 migration referenced the
#       wrong table for the FK (employee singular vs employees plural); the
#       corrective migration 20260905030000_fix_n17_employee_fk recreates
#       the project table correctly.
#   - 20260906000000_n1_project_fk    — original n1 migration referenced
#       snake_case "project_name" in the backfill, but the DPR /
#       InspectionRecord columns are camelCase quoted "projectName" (no
#       @map on the schema field). The corrective migration
#       20260906000001_n1_project_fk_fix re-runs the DDL with corrected
#       backfill column names.

set +e  # don't abort on the first failed DELETE / resolve; we want all of them to attempt

echo "[start.sh] Recovery: clearing non-applied rows for known-bad migrations"

node -e "
  const { PrismaClient } = require('@prisma/client');
  const p = new PrismaClient();
  (async () => {
    try {
      const KNOWN_BAD = [
        '20260905020000_n17_projects',
        '20260906000000_n1_project_fk',
      ];
      let totalDeleted = 0;
      for (const name of KNOWN_BAD) {
        try {
          const res = await p.\$executeRawUnsafe(
            \"DELETE FROM \\\"_prisma_migrations\\\" WHERE migration_name = '\" + name + \"' AND status <> 'applied'\"
          );
          console.log('[start.sh] cleared', res, 'failed/rolled_back rows for', name);
          totalDeleted += res;
        } catch (e) {
          console.log('[start.sh] DELETE failed for', name, '(continuing):', e.message);
        }
      }
      console.log('[start.sh] total cleared:', totalDeleted);
    } catch (e) {
      console.log('[start.sh] recovery outer error (continuing):', e.message);
    } finally {
      await p.\$disconnect();
    }
  })();
" 2>&1

echo "[start.sh] Recovery: running migrate resolve --rolled-back for known-bad migrations"
npx prisma migrate resolve --rolled-back 20260905020000_n17_projects 2>&1
echo "[start.sh] resolve n17_projects rc=$?"
npx prisma migrate resolve --rolled-back 20260906000000_n1_project_fk 2>&1
echo "[start.sh] resolve n1_project_fk rc=$?"

echo "[start.sh] Running prisma migrate deploy"
npx prisma migrate deploy 2>&1
RC=$?
if [ "$RC" -ne 0 ]; then
  echo "[start.sh] prisma migrate deploy FAILED with rc=$RC"
  exit $RC
fi

echo "[start.sh] Starting node src/index.js"
exec node src/index.js
