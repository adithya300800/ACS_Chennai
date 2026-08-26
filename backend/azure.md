# Azure Deployment Guide — ACS Portal Backend

## Prerequisites
- Azure account with active credits
- Azure CLI installed (`az login`)

---

## Step 1: Create Resource Group

```bash
az group create \
  --name acs-portal-rg \
  --location eastus
```

## Step 2: Create PostgreSQL Database

```bash
# Create Azure Database for PostgreSQL - Flexible Server (Free tier B1ms)
az postgres flexible-server create \
  --name acs-portal-db \
  --resource-group acs-portal-rg \
  --location eastus \
  --tier Burstable \
  --sku-name Standard_B1ms \
  --storage-size 32 \
  --admin-user postgresadmin \
  --admin-password "YourStrongPassword123!" \
  --public-all \
  --ssl-enforcement Disabled

# Get connection string
az postgres flexible-server show-connection-string \
  --name acs-portal-db \
  --admin-user postgresadmin \
  --admin-password "YourStrongPassword123!"
```

**Important:** After creating, go to Azure Portal → PostgreSQL → Networking → add firewall rule allowing ALL Azure services (`0.0.0.0` to `0.0.0.0` for Azure services).

## Step 3: Create App Service Plan

```bash
az appservice plan create \
  --name acs-portal-plan \
  --resource-group acs-portal-rg \
  --location eastus \
  --is-linux \
  --sku B1
```

## Step 4: Create Web App (App Service)

```bash
az webapp create \
  --name acs-portal-api \
  --resource-group acs-portal-rg \
  --plan acs-portal-plan \
  --runtime "NODE|20-lts" \
  --deployment-container-image-name mcr.microsoft.com/azure-cli:latest
```

## Step 5: Configure App Settings

```bash
az webapp config appsettings set \
  --name acs-portal-api \
  --resource-group acs-portal-rg \
  --settings \
    WEBSITE_RUN_FROM_PACKAGE="1" \
    DATABASE_URL="postgresql://postgresadmin:YourStrongPassword123!@acs-portal-db.postgres.database.azure.com:5432/acs_portal" \
    JWT_SECRET="generate-a-very-long-random-secret-here" \
    JWT_REFRESH_SECRET="another-long-random-secret-here" \
    NODE_ENV="production" \
    PORT="3000" \
    FRONTEND_URL="https://adithyamohanavel.github.io"
```

## Step 6: Deploy via GitHub Actions

1. Push backend to a GitHub repo
2. Go to Azure Portal → App Service → Deployment Center → GitHub
3. Authorize GitHub, select repo and `main` branch
4. Azure creates a workflow file in your repo
5. The backend will auto-deploy on push

## Step 7: Initialize Database

After first deploy, run this from your local machine (or via Azure Cloud Shell):

```bash
# Set DATABASE_URL locally first, then:
cd backend
npm install
npx prisma db push
npm run db:seed
```

## Step 8: Verify Deployment

```bash
curl https://acs-portal-api.azurewebsites.net/health
# Should return: {"status":"ok","timestamp":"..."}
```

---

## Connecting Frontend to Backend

In your frontend `.env`:
```
VITE_API_URL=https://acs-portal-api.azurewebsites.net
```

In GitHub Secrets (for the frontend deploy workflow):
- `RESEND_API_KEY` (already set)
- `VITE_API_URL=https://acs-portal-api.azurewebsites.net`
