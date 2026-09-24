#!/usr/bin/env bash
# reconcile-failed-migrations.sh — explicit operations tool for clearing
# allowlisted errored ledger rows from `_prisma_migrations`.
#
# [DR-035 2026-09-24] Retired from the ordinary startup path (start.sh)
# and from the default CI deploy path (.github/workflows/backend-deploy.yml).
# Pre-DR-035, the same loop body ran unconditionally on every cold start
# and on every push — meaning ordinary releases could silently reclassify
# a newly failed migration (the audit's "ordinary startup still performs
# migration recovery exceptions" finding).
#
# This script is the canonical recovery path for the same allowlist the
# pre-DR-035 inline loops used. Operators invoke it explicitly when the
# deployment pipeline is allowed to recover a known errored migration.
#
# Two invocation patterns:
#
#   1. From CI: set the workflow-level env var DR031_RECONCILE=1 (the
#      explicit gate in .github/workflows/backend-deploy.yml). The
#      reconcile step then calls `sh scripts/reconcile-failed-migrations.sh`
#      and the rest of the deploy proceeds. Default `push` triggers do
#      NOT set the env var, so ordinary pushes skip it.
#
#   2. From a local shell with DATABASE_URL / DIRECT_DATABASE_URL set:
#        sh backend/scripts/reconcile-failed-migrations.sh
#      Inspect the ledger (`npm run db:check`) before invoking, and verify
#      backup readiness for partial DDL.
#
# Allowlist (preserved verbatim from the pre-DR-035 inline loops):
#
#   - 20260908150000_dr031_leave_constraint_correct_bound
#       DR-031-SQLFIX 2026-09-10. Shipped with a doubled-quote literal
#       (`''[]''` parsed as empty-string + stray-array + empty-string).
#       SQL fixed in place; this script clears the errored ledger row
#       so the next `prisma migrate deploy` re-applies the corrected SQL.
#
#   - 20260912070000_s7_project_attachment_review
#       S7-SQLFIX 2026-09-12. FK referenced singular "employee"; live
#       DB has the plural snake_case "employees". SQL fixed in place.
#
#   - 20260924100000_dr025_correction_cancelled
#       DR-025 2026-09-24. ALTER TYPE referenced the lowercase
#       `billing_certification_status` identifier; Prisma emits the
#       PascalCase quoted `"BillingCertificationStatus"`. SQL fixed in
#       place (no sibling migration; sibling pattern regressed in
#       commit aef38d4 because Prisma's migrator re-applies the
#       rolled-back original before reaching a sibling).
#
#   - 20260924150000_dr037_idempotency_body_compaction
#       DR-037 2026-09-24. The migration's giant ASCII-art header
#       contained a bare "─ Backward compatibility ─" line WITHOUT
#       the `--` prefix; Postgres parsed it as SQL and threw 42601
#       "syntax error at or near '─'". Edit removed the decorative
#       box-drawing characters and replaced with plain `--` comment
#       lines. The DDL itself (ALTER TABLE + CREATE INDEX) is
#       unchanged.
#
# Idempotency:
#   - If the migration is in errored state: rc=0, row is cleared.
#   - If the migration is in applied state: rc=non-zero, swallowed.
#   - If the migration is rolled-back: rc=non-zero, swallowed.
# After the first successful re-apply, every subsequent run is a no-op.

set -e

KNOWN_BAD="
20260908150000_dr031_leave_constraint_correct_bound
20260912070000_s7_project_attachment_review
20260924100000_dr025_correction_cancelled
20260924150000_dr037_idempotency_body_compaction
"

echo "[reconcile-failed-migrations] one-shot ledger resolve for known errored rows…"
for MIG in $KNOWN_BAD; do
  echo "[reconcile-failed-migrations]   $MIG"
  # `|| true` swallows the steady-state non-zero exit (applied or
  # already-rolled-back). DB-unreachable failures still bubble up via
  # `set -e` on any LATER step — this script does not need to be
  # failure-tolerable at the loop boundary.
  npx prisma migrate resolve --rolled-back "$MIG" >/dev/null 2>&1 || true
done
echo "[reconcile-failed-migrations] OK"