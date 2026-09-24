#!/usr/bin/env bash
# check-schema-parity.sh — explicit operations tool for detecting
# model-only schema drift.
#
# [DR-035 2026-09-24] Audit acceptance: "A model-only change is detected
# even when migration history says up to date." Prisma's
# `migrate diff` replays the migration history into a shadow database
# then diffs the resulting schema against the live schema.prisma. If
# they diverge, the model has changed without a matching SQL migration
# — exactly the silent-drift hazard the audit calls out.
#
# NOT wired into ordinary startup or CI. Operators invoke explicitly:
#
#   SHADOW_DATABASE_URL=postgresql://user:pass@host:5432/shadow \
#     sh backend/scripts/check-schema-parity.sh
#
# The shadow database must be reachable from the runner and is destroyed
# by Prisma after the diff completes (no persistent state). Use a
# throwaway connection — never point this at prod.
#
# Exit codes:
#   0 = schema.prisma matches migration SQL (no drift)
#   1 = drift detected (model change without matching SQL)
#   2 = missing SHADOW_DATABASE_URL, missing prisma artefacts, or
#       `prisma migrate diff` itself failed

set -e

if [ -z "$SHADOW_DATABASE_URL" ]; then
  echo "[check-schema-parity] SHADOW_DATABASE_URL is required (Postgres URL to a temporary shadow DB)." >&2
  echo "[check-schema-parity] Example: SHADOW_DATABASE_URL=postgresql://user:pass@host:5432/shadow \\" >&2
  echo "[check-schema-parity]          sh backend/scripts/check-schema-parity.sh" >&2
  exit 2
fi

if [ ! -d "./prisma/migrations" ]; then
  echo "[check-schema-parity] ./prisma/migrations not found — run from backend/ (the working directory)." >&2
  exit 2
fi

if [ ! -f "./prisma/schema.prisma" ]; then
  echo "[check-schema-parity] ./prisma/schema.prisma not found — run from backend/ (the working directory)." >&2
  exit 2
fi

echo "[check-schema-parity] replaying migrations into shadow DB and diffing against schema.prisma…"
# Capture stdout + stderr. `migrate diff` exits 0 even when there IS
# drift (it just prints the diff); we have to inspect the output to
# decide pass/fail. Capture the exit code separately so a genuine
# failure (e.g. shadow DB unreachable) bubbles up as rc=2 below.
set +e
OUTPUT=$(npx prisma migrate diff \
  --from-migrations ./prisma/migrations \
  --to-schema-datamodel ./prisma/schema.prisma \
  --shadow-database-url "$SHADOW_DATABASE_URL" 2>&1)
RC=$?
set -e

if [ "$RC" -ne 0 ]; then
  echo "[check-schema-parity] prisma migrate diff FAILED (rc=$RC):" >&2
  echo "$OUTPUT" >&2
  echo "[check-schema-parity] Inspect the shadow DB connectivity / Prisma client generation, then retry." >&2
  exit 2
fi

# Prisma's `migrate diff` exits 0 with empty stdout when the two schemas
# match — a non-empty stdout is the drift signal.
if [ -z "$OUTPUT" ]; then
  echo "[check-schema-parity] schema.prisma matches migration SQL — no model-only drift"
  exit 0
fi

echo "[check-schema-parity] DRIFT DETECTED — schema.prisma differs from migration history:" >&2
echo "----- begin prisma migrate diff output -----" >&2
echo "$OUTPUT" >&2
echo "----- end prisma migrate diff output -----" >&2
echo "[check-schema-parity] Either add a new migration under prisma/migrations/ capturing the change, OR revert schema.prisma." >&2
exit 1