#!/bin/bash
set -e

# Azure provides PORT dynamically — do NOT hardcode
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

# Storage: at least one of (connection string) OR (account name + key) is required.
if [ -z "${AZURE_STORAGE_CONNECTION_STRING:-}" ]; then
  : "${AZURE_STORAGE_ACCOUNT_NAME:?AZURE_STORAGE_ACCOUNT_NAME or AZURE_STORAGE_CONNECTION_STRING must be set}"
  : "${AZURE_STORAGE_ACCOUNT_KEY:?AZURE_STORAGE_ACCOUNT_KEY or AZURE_STORAGE_CONNECTION_STRING must be set}"
fi

# Re-export the (now-validated) values so child processes inherit them.
export DATABASE_URL JWT_SECRET JWT_REFRESH_SECRET
export AZURE_STORAGE_CONNECTION_STRING="${AZURE_STORAGE_CONNECTION_STRING:-}"
export AZURE_STORAGE_ACCOUNT_NAME="${AZURE_STORAGE_ACCOUNT_NAME:-}"
export AZURE_STORAGE_ACCOUNT_KEY="${AZURE_STORAGE_ACCOUNT_KEY:-}"
export FRONTEND_URL="${FRONTEND_URL:-}"
export ZOHO_CLIENT_ID="${ZOHO_CLIENT_ID:-}"
export ZOHO_CLIENT_SECRET="${ZOHO_CLIENT_SECRET:-}"
export ZOHO_REDIRECT_URI="${ZOHO_REDIRECT_URI:-}"
export ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-${FRONTEND_URL}}"
export RESEND_API_KEY="${RESEND_API_KEY:-}"

echo "[startup] ACS Portal API starting..."
echo "[startup] PORT=$PORT NODE_ENV=$NODE_ENV"
echo "[startup] Storage mode: $([ -n "$AZURE_STORAGE_CONNECTION_STRING" ] && echo 'connection-string' || echo 'shared-key')"
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

echo "[startup] Running Prisma db push..."
cd /home/site/wwwroot
# Use `db push` (not `migrate deploy`) because this project does not use
# migration files — schema is the single source of truth. `db push` makes
# additive changes (new columns, new indexes) without dropping data, and
# errors out if the local schema would require destructive changes. Round-8
# confirmed this was the fix for F5/F6 (POST /api/dpr and admin queue 500s
# caused by deployed DB schema drifting from the deployed Prisma client).
npx prisma db push --accept-data-loss=false --schema /home/site/wwwroot/prisma/schema.prisma

echo "[startup] Starting Node.js on PORT $PORT..."
exec node /home/site/wwwroot/src/index.js
