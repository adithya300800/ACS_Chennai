#!/usr/bin/env bash
# Round-26 / LPR-015: restore rehearsal against a disposable target.
#
# NEVER point this at production. The expected use is a fresh Supabase
# project created solely to verify a backup file is valid + recoverable
# before relying on it in an incident. Set BACKUP_RESTORE_URL to that
# disposable cluster's DATABASE_URL.
#
# Workflow:
#   1. Run `scripts/backup-database.sh` against prod OR download a
#      cron-produced .dump from R2.
#   2. Create a fresh Supabase project (free tier is fine).
#   3. Copy DATABASE_URL → BACKUP_RESTORE_URL; export it before invoking.
#   4. Run this script with the path to the backup. Verify row counts.
#   5. Document the elapsed time as the rehearsal RTO evidence.
#
# Accepted formats (DR-008):
#   *.dump     — raw custom-format dump (cron-backup.yml off-site)
#   *.dump.gz  — gzip-wrapped custom-format dump (backup-database.sh
#                pre-deploy). This is what the script historically
#                assumed, which made it impossible to verify cron
#                off-site backups — the very artifact we'd need in
#                an incident.

set -euo pipefail

: "${BACKUP_RESTORE_URL:?BACKUP_RESTORE_URL must be set (disposable cluster; never prod)}"
: "${BACKUP_FILE:?BACKUP_FILE must be set (path to a .dump or .dump.gz)}"

START=$(date +%s)
echo "[restore] target=$(echo "$BACKUP_RESTORE_URL" | sed -E 's|.*@([^/]+)/.*|\1|')"
echo "[restore] source=$BACKUP_FILE"

# DR-008: dispatch on filename suffix so this script handles BOTH the
# pre-deploy .dump.gz artifact AND the cron off-site .dump artifact.
# The pre-fix script unconditionally piped through `gunzip -c`, which
# errors on a non-gzip file — leaving us unable to verify the very
# artifact the incident-response runbook tells us to restore from.
case "$BACKUP_FILE" in
  *.dump.gz)
    echo "[restore] format: gzip-wrapped custom dump"
    gunzip -c "$BACKUP_FILE" | pg_restore \
      --clean \
      --if-exists \
      --no-owner \
      --no-privileges \
      --dbname="$BACKUP_RESTORE_URL" \
      --jobs=4
    ;;
  *.dump)
    echo "[restore] format: raw custom dump"
    pg_restore \
      --clean \
      --if-exists \
      --no-owner \
      --no-privileges \
      --dbname="$BACKUP_RESTORE_URL" \
      --jobs=4 \
      "$BACKUP_FILE"
    ;;
  *)
    echo "[restore] ERROR: BACKUP_FILE must end in .dump or .dump.gz (got: $BACKUP_FILE)" >&2
    exit 2
    ;;
esac

ELAPSED=$(( $(date +%s) - START ))
echo "[restore] done in ${ELAPSED}s — verify with:"
echo "        psql \"$BACKUP_RESTORE_URL\" -c 'select count(*) from employees;'"
echo "        psql \"$BACKUP_RESTORE_URL\" -c 'select count(*) from dpr;'"
echo "        psql \"$BACKUP_RESTORE_URL\" -c 'select count(*) from inspection_record;'"