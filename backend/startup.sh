#!/bin/bash
# Azure App Service startup script
# Azure provides PORT in environment, defaulting to 8080

export PORT=${PORT:-8080}
export DATABASE_URL="$DATABASE_URL"
export JWT_SECRET="$JWT_SECRET"
export JWT_REFRESH_SECRET="$JWT_REFRESH_SECRET"
export NODE_ENV="production"
export FRONTEND_URL="https://acschennai.com"
export AZURE_STORAGE_ACCOUNT_NAME="$AZURE_STORAGE_ACCOUNT_NAME"
export AZURE_STORAGE_ACCOUNT_KEY="$AZURE_STORAGE_ACCOUNT_KEY"
export ZOHO_CLIENT_ID="$ZOHO_CLIENT_ID"
export ZOHO_CLIENT_SECRET="$ZOHO_CLIENT_SECRET"
export ZOHO_REDIRECT_URI="$ZOHO_REDIRECT_URI"

echo "Starting ACS Portal API..."
echo "PORT=$PORT"
echo "NODE_ENV=$NODE_ENV"

# Run Prisma migrations and start the server
cd /home/site/wwwroot
npx prisma migrate deploy --schema /home/site/wwwroot/prisma/schema.prisma 2>/dev/null || true
node src/index.js
