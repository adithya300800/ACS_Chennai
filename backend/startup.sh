#!/bin/bash
set -e

# PORT is provided by the platform dynamically
export PORT=${PORT:-8080}
export NODE_ENV="production"

# Fail fast if required secrets are missing. Use ${VAR:?} which aborts the
# script (set -e) if VAR is unset OR empty — closing a silent-empty-string hole
# that previously let the app boot with `JWT_SECRET=""`.
: "${DATABASE_URL:?DATABASE_URL must be set}"
: "${JWT_SECRET:?JWT_SECRET must be set}"
: "${JWT_REFRESH_SECRET:?JWT_REFRESH_SECRET must be set}"
# Round-7 fail-fast: PII_LOG_SALT is required at module load by pii.js
: "${PII_LOG_SALT:?PII_LOG_SALT must be set}"

# Storage: at least one of (connection string) OR (account id + key) is required.
if [ -z "${R2_CONNECTION_STRING:-}" ]; then
  : "${R2_ACCOUNT_ID:?R2_ACCOUNT_ID or R2_CONNECTION_STRING must be set}"
  : "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID or R2_CONNECTION_STRING must be set}"
fi

# Re-export the (now-validated) values so child processes inherit them.
export DATABASE_URL JWT_SECRET JWT_REFRESH_SECRET
export R2_CONNECTION_STRING="${R2_CONNECTION_STRING:-}"
export R2_ACCOUNT_ID="${R2_ACCOUNT_ID:-}"
export R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-}"
export FRONTEND_URL="${FRONTEND_URL:-}"
export ZOHO_CLIENT_ID="${ZOHO_CLIENT_ID:-}"
export ZOHO_CLIENT_SECRET="${ZOHO_CLIENT_SECRET:-}"
export ZOHO_REDIRECT_URI="${ZOHO_REDIRECT_URI:-}"
export ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-${FRONTEND_URL}}"
export RESEND_API_KEY="${RESEND_API_KEY:-}"

echo "[startup] ACS Portal API starting..."
echo "[startup] PORT=$PORT NODE_ENV=$NODE_ENV"
echo "[startup] Storage mode: $([ -n "$R2_CONNECTION_STRING" ] && echo 'connection-string' || echo 'shared-key')"
echo "[startup] Allowed origins: $ALLOWED_ORIGINS"

echo "[startup] Cleaning old tmp..."
rm -rf /home/site/wwwroot/tmp 2>/dev/null || true

# Fallback: run npm install if node_modules is missing (handles cases where
# SCM_DO_BUILD_DURING_DEPLOYMENT was false and Oryx skipped the build)
if [ ! -d "/home/site/wwwroot/node_modules" ]; then
  echo "[startup] node_modules missing — running npm install..."
  cd /home/site/wwwroot
  npm install --omit=dev 2>/dev/null || npm install
fi

echo "[startup] Running Prisma migrate deploy..."
cd /home/site/wwwroot
# LPR-001: switched from `prisma db push` to `prisma migrate deploy`.
#
# Why the switch:
#   - `db push` accepts destructive schema changes (no migration history) and
#     reconciles the database directly to schema.prisma, which can drop
#     columns / data without warning. The `--accept-data-loss=false` flag was
#     only a partial guard; it cannot stop an unrelated custom constraint or
#     data backfill from being silently skipped.
#   - `migrate deploy` applies only the checked-in SQL migrations under
#     prisma/migrations/, is fully idempotent (skips already-applied ones),
#     and writes every applied migration to `_prisma_migrations` so the
#     release process is auditable.
#   - The round-11b (Supabase session-mode pooler) DDL port-5432 caveat
#     still applies — migrations must run against the session-mode pooler,
#     not the transaction-mode pooler on port 6543 that the app uses for
#     queries. The DATABASE_URL in the Render runtime is the query URL
#     (port 6543); for migrations we resolve to the session-mode pooler.
npx prisma migrate deploy --schema /home/site/wwwroot/prisma/schema.prisma

echo "[startup] Starting Node.js on PORT $PORT..."
exec node /home/site/wwwroot/src/index.js
