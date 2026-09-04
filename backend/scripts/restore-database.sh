#!/usr/bin/env bash
# Round-26 / LPR-015: restore rehearsal against a disposable target.
#
# NEVER point this at production. The expected use is a fresh Supabase
# project created solely to verify a backup file is valid + recoverable
# before relying on it in an incident. Set BACKUP_RESTORE_URL to that
# disposable cluster's DATABASE_URL.
#
# Workflow:
#   1. Run `scripts/backup-database.sh` against prod. Capture the .dump.gz.
#   2. Create a fresh Supabase project (free tier is fine).
#   3. Copy DATABASE_URL → BACKUP_RESTORE_URL; export it before invoking.
#   4. Run this script with the path to the backup. Verify row counts.
#   5. Document the elapsed time as the rehearsal RTO evidence.

set -euo pipefail

: "${BACKUP_RESTORE_URL:?BACKUP_RESTORE_URL must be set (disposable cluster; never prod)}"
: "${BACKUP_FILE:?BACKUP_FILE must be set (path to a .dump.gz from backup-database.sh)}"

START=$(date +%s)
echo "[restore] target=$(echo "$BACKUP_RESTORE_URL" | sed -E 's|.*@([^/]+)/.*|\1|')"
echo "[restore] source=$BACKUP_FILE"

# pg_restore --clean drops objects first so re-running this script against the
# same disposable cluster is idempotent. --if-exists suppresses "does not
# exist" errors on first run. --no-owner matches the dump's flags.
gunzip -c "$BACKUP_FILE" | pg_restore \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --dbname="$BACKUP_RESTORE_URL" \
  --jobs=4

ELAPSED=$(( $(date +%s) - START ))
echo "[restore] done in ${ELAPSED}s — verify with:"
echo "        psql \"$BACKUP_RESTORE_URL\" -c 'select count(*) from \"Employee\";'"