#!/usr/bin/env bash
# Round-26 / LPR-015: pre-deploy database backup.
#
# Render does not auto-snapshot Supabase on deploy, so every release that
# touches the schema should run this BEFORE the migration step. Output is a
# timestamped .dump.gz on the local runner. The deployment workflow is the
# only consumer; do not run interactively against prod without verifying
# DATABASE_URL points at the correct cluster.
#
# Restore rehearsal: see scripts/restore-database.sh — runs against a
# disposable Supabase project (BACKUP_RESTORE_URL). RTO/RPO targets documented
# in docs/OPERATIONS.md.
#
# Owner action: pipe the .dump.gz into Supabase point-in-time recovery or
# off-site R2 archival. This script intentionally does not upload anywhere;
# the workflow author chooses the destination (e.g. AWS S3, R2, encrypted
# git-annex repo).

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set (full postgres://...string)}"
: "${BACKUP_DIR:=./backups}"

mkdir -p "$BACKUP_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$BACKUP_DIR/acs-portal-${STAMP}.dump.gz"

echo "[backup] DATABASE_URL host=$(echo "$DATABASE_URL" | sed -E 's|.*@([^/]+)/.*|\1|')"
echo "[backup] writing $OUT"

# pg_dump custom (-Fc) → gzip. Custom format is what pg_restore expects and
# compresses ~5x for our row counts. We force --no-owner / --no-privileges
# so a restore to a fresh role doesn't trip permission mismatches.
pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  --dbname="$DATABASE_URL" \
  | gzip -9 > "$OUT"

echo "[backup] done $(du -h "$OUT" | cut -f1) — verify with:"
echo "        gunzip -c '$OUT' | pg_restore --list | head"