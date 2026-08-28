#!/bin/bash
set -e

# Azure provides PORT dynamically — do NOT hardcode
export PORT=${PORT:-8080}
export DATABASE_URL="${DATABASE_URL}"
export JWT_SECRET="${JWT_SECRET}"
export JWT_REFRESH_SECRET="${JWT_REFRESH_SECRET}"
export NODE_ENV="production"
export FRONTEND_URL="${FRONTEND_URL:-https://acschennai.com}"
export AZURE_STORAGE_ACCOUNT_NAME="${AZURE_STORAGE_ACCOUNT_NAME}"
export AZURE_STORAGE_ACCOUNT_KEY="${AZURE_STORAGE_ACCOUNT_KEY}"
export ZOHO_CLIENT_ID="${ZOHO_CLIENT_ID}"
export ZOHO_CLIENT_SECRET="${ZOHO_CLIENT_SECRET}"
export ZOHO_REDIRECT_URI="${ZOHO_REDIRECT_URI}"

echo "[startup] ACS Portal API starting..."
echo "[startup] PORT=$PORT"
echo "[startup] NODE_ENV=$NODE_ENV"
echo "[startup] Cleaning old files..."
rm -rf /home/site/wwwroot/tmp 2>/dev/null || true

# Fallback: run npm install if node_modules is missing (handles cases where
# SCM_DO_BUILD_DURING_DEPLOYMENT was false and Oryx skipped the build)
if [ ! -d "/home/site/wwwroot/node_modules" ]; then
  echo "[startup] node_modules missing — running npm install..."
  cd /home/site/wwwroot
  npm install --omit=dev 2>/dev/null || npm install
fi

echo "[startup] Running Prisma migrations..."
cd /home/site/wwwroot
npx prisma migrate deploy --schema /home/site/wwwroot/prisma/schema.prisma 2>/dev/null || true

echo "[startup] Starting Node.js on PORT $PORT..."
exec node /home/site/wwwroot/src/index.js
