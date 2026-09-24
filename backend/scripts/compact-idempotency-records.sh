#!/usr/bin/env bash
# compact-idempotency-records.sh — body-compaction + identity-deletion
# sweep for the durable `request_dedupe` idempotency table.
#
# [DR-037 2026-09-24] The Fresh24 audit flagged that the COMPLETED
# response-body retention on `request_dedupe` had no owned janitor. The
# in-line `expires_at < now()` cleanup referenced in the codebase was a
# documented admin query, never wired to a cron, and never observable.
#
# This script is the owned janitor. It calls the in-process
# `compactIdempotencyRecords()` helper exported by
# `backend/src/lib/idempotency.js`, which runs two bounded passes
# (COMPACT bodies, then DELETE identities). The two TTL knobs
# (`IDEMPOTENCY_BODY_TTL_HOURS` default 72,
# `IDEMPOTENCY_IDENTITY_TTL_HOURS` default 720 = 30d) are
# env-overridable.
#
# Invocation:
#
#   sh backend/scripts/compact-idempotency-records.sh
#
# The script expects `DATABASE_URL` to be set in the environment
# (Render / GH Actions provide it for the live DB). It exits:
#   - 0 on success (regardless of compactedCount / deletedCount — a
#     day with zero compaction is a valid signal that the TTLs are
#     loose enough, not a failure)
#   - non-zero if the helper itself throws (DB unreachable, schema
#     drift, missing prisma artefact). The GH Actions workflow treats
#     non-zero as a failed cron run.
#
# Operational ownership:
#   - GH Actions workflow `.github/workflows/compact-idempotency.yml`
#     invokes this script daily at 03:30 UTC (off-peak for the
#     portal's burst traffic).
#   - The R40 retention cron (AppLog sweep) lives on the same host
#     (GH Actions, NOT Render cron — free plan blocks TCP/587
#     cron expressions).
#   - Compact + delete counts are surfaced in the workflow log so a
#     persistent zero is observable as "the TTLs are too generous".

set -e

if [ -z "$DATABASE_URL" ]; then
  echo "[compact-idempotency] DATABASE_URL is required" >&2
  echo "[compact-idempotency] Example: DATABASE_URL=postgresql://user:pass@host/db \\" >&2
  echo "[compact-idempotency]          sh backend/scripts/compact-idempotency-records.sh" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

echo "[compact-idempotency] invoking compactIdempotencyRecords()…"
node -e '
  const path = require("path");
  const lib = require(path.join(process.cwd(), "src/lib/idempotency.js"));
  const { PrismaClient } = require(path.join(process.cwd(), "node_modules/@prisma/client"));
  (async () => {
    const prisma = new PrismaClient();
    try {
      const result = await lib.compactIdempotencyRecords({ prisma });
      console.log(JSON.stringify(result));
    } finally {
      await prisma.$disconnect();
    }
  })().catch((err) => {
    console.error("[compact-idempotency] FAILED:", err && err.stack || err);
    process.exit(1);
  });
'

echo "[compact-idempotency] OK"
