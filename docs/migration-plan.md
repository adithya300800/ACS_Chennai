# Migration Plan: Azure App Service → Render + Supabase + R2

**Project:** ACS Chennai Portal Backend
**Date:** 2026-08-29
**Status:** Planning

---

## 1. Executive Summary

Migrate the backend from Azure App Service (Node.js/Express/Prisma) to:
- **Render** — Node.js hosting (replaces Azure App Service)
- **Supabase** — PostgreSQL database (replaces Azure Database for PostgreSQL)
- **Cloudflare R2** — Object storage (already in use, replaces Azure Blob)

All three target platforms have **official MCP servers** that enable full agent-driven deployment and debugging.

### MCP Servers Available
| Platform | MCP Server | Key Capabilities |
|---|---|---|
| **Render** | `mcp-render` (GitHub: render-oss/render-mcp-server) | Deploy, logs, metrics, Postgres management |
| **Supabase** | `@supabase/mcp-server-supabase` | Database queries, schema, migrations |
| **Cloudflare R2** | `@cloudflare/mcp-server-cloudflare` | Workers, R2, KV, D1 storage |

---

## 2. Architecture Comparison

### Current (Azure)
```
GitHub Actions
     ↓
Azure App Service (Node.js 22)
     ↓
Azure Database for PostgreSQL (ElephantSQL)
     ↓
Azure Blob Storage (→ R2 already)
```

### Target (Render + Supabase + R2)
```
GitHub Actions
     ↓
Render Web Service (Node.js)
     ↓
Supabase PostgreSQL
     ↓
Cloudflare R2 (already connected)
```

---

## 3. Migration Phases

### Phase 1 — Supabase Database Setup (Lowest Risk)
**Goal:** Create Supabase project, migrate schema and seed data, validate connection.

**Steps:**
1. Create Supabase project at supabase.com
2. Install MCP server for Supabase
3. Use MCP to create database schema (or run `npx prisma db push`)
4. Migrate data from Azure PostgreSQL → Supabase (using `pg_dump` + `psql`)
5. Update `DATABASE_URL` in `.env`
6. Validate: run `npm test` against Supabase

**MCP Tools Used:**
- `supabase_mcp_list_projects`
- `supabase_mcp_query_database` (read-only validation)
- `supabase_mcp_run_sql` (schema push)

**MCP Setup:**
```bash
# Install
npm install -g @supabase/mcp-server-supabase

# Add to ~/.claude/settings.json MCP servers:
# (see Section 5 below)
```

**Secrets Required:**
- `SUPABASE_PROJECT_REF` — found in Supabase project settings
- `SUPABASE_DB_PASSWORD` — database password
- Connection string format: `postgresql://postgres:[PASSWORD]@db.[PROJECT_REF].supabase.co:5432/postgres`

**Verification:**
```bash
npx prisma db push --schema=backend/prisma/schema.prisma
npm test
```

---

### Phase 2 — Render Deployment Setup (Medium Risk)
**Goal:** Get Express app running on Render with zero code changes.

**Steps:**
1. Create Render account and connect GitHub repo
2. Install Render MCP server for agent access
3. Create Web Service via MCP or Render dashboard:
   - Root directory: `backend`
   - Build command: `npm install && npx prisma generate`
   - Start command: `node src/index.js`
   - Environment: Node
4. Set environment variables via Render dashboard or MCP:
   - `DATABASE_URL` → Supabase connection string
   - `JWT_SECRET` → Generate new secure value
   - `JWT_REFRESH_SECRET` → Generate new secure value
   - `FRONTEND_URL` → `https://acschennai.com`
   - `ALLOWED_ORIGINS` → `https://acschennai.com`
   - `AZURE_STORAGE_ACCOUNT_NAME` → R2 account name
   - `AZURE_STORAGE_ACCOUNT_KEY` → R2 access key
   - `R2_ACCOUNT_ID` → Cloudflare account ID
   - `R2_ACCESS_KEY_ID` → R2 access key ID
   - `R2_SECRET_ACCESS_KEY` → R2 secret access key
   - `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, etc.
5. Deploy via MCP or `git push`
6. Validate: GET `/health` returns 200

**MCP Tools Used:**
- `render_mcp_create_service`
- `render_mcp_list_services`
- `render_mcp_get_service_logs`
- `render_mcp_trigger_deploy`

**MCP Setup:**
```bash
# Install
npm install -g mcp-render

# Configure with Render API key
# (see Section 5 below)
```

**Verification:**
```bash
curl https://acs-portal-api.onrender.com/health
# Expected: {"status":"ok","timestamp":"..."}
```

---

### Phase 3 — DNS Cutover (Low Risk)
**Goal:** Point `acs-portal-api.azurewebsites.net` → Render deployment.

**Steps:**
1. Get Render deployment URL (e.g., `acs-portal-api.onrender.com`)
2. In Azure Portal or DNS provider: add CNAME or update A record
3. Wait for DNS propagation
4. Test with live HAR capture from browser
5. Decommission Azure App Service (stop billing)

**Verification:**
```bash
# Browser DevTools → Network → check all API calls return 200 with CORS headers
```

---

### Phase 4 — R2 Integration (Already Partially Done)
**Goal:** Verify DPR photo uploads work with R2.

**Steps:**
1. Confirm R2 bucket exists with correct CORS policy
2. Verify `@azure/storage-blob` is replaced with `@aws-sdk/client-s3` (already done in DPR routes)
3. Test upload flow: POST `/api/dpr/sas-url` → PUT to R2 → POST `/api/dpr/confirm-upload`
4. Verify DPR photos load in frontend

**MCP Tools Used:**
- `cloudflare_mcp_list_buckets`
- `cloudflare_mcp_upload_object` (via Workers Bindings server)

**MCP Setup:**
```bash
# Cloudflare MCP uses remote server URL (no install needed)
# Add to settings.json with API token
```

---

## 4. Environment Variables Reference

### Current (Azure)
```
DATABASE_URL=postgresql://postgresadmin:...@acs-portal-db.postgres.database.azure.com:5432/acs_portal
JWT_SECRET=<hex>
JWT_REFRESH_SECRET=<hex>
AZURE_STORAGE_ACCOUNT_NAME=acsstoragedpr
AZURE_STORAGE_ACCOUNT_KEY=<base64>
FRONTEND_URL=https://acschennai.com
NODE_ENV=production
ALLOWED_ORIGINS=https://acschennai.com
ZOHO_CLIENT_ID=
ZOHO_CLIENT_SECRET=
ZOHO_REDIRECT_URI=https://acs-portal-api.azurewebsites.net/api/auth/zoho/callback
RESEND_API_KEY=
```

### Target (Render + Supabase)
```
DATABASE_URL=postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres
JWT_SECRET=<generate new>
JWT_REFRESH_SECRET=<generate new>
# R2 (keep same keys, just different env var names if needed)
R2_ACCOUNT_ID=<cloudflare-account-id>
R2_ACCESS_KEY_ID=<r2-access-key-id>
R2_SECRET_ACCESS_KEY=<r2-secret-key>
FRONTEND_URL=https://acschennai.com
ALLOWED_ORIGINS=https://acschennai.com
NODE_ENV=production
ZOHO_CLIENT_ID=
ZOHO_CLIENT_SECRET=
ZOHO_REDIRECT_URI=https://acs-portal-api.onrender.com/api/auth/zoho/callback
RESEND_API_KEY=
PII_LOG_SALT=<generate new>
```

---

## 5. MCP Server Configuration

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "render": {
      "command": "npx",
      "args": ["-y", "mcp-render"],
      "env": {
        "RENDER_API_KEY": "<your-render-api-key>"
      }
    },
    "supabase": {
      "command": "npx",
      "args": ["-y", "@supabase/mcp-server-supabase"],
      "env": {
        "SUPABASE_ACCESS_TOKEN": "<your-supabase-access-token>"
      }
    },
    "cloudflare-r2": {
      "command": "npx",
      "args": ["-y", "@cloudflare/mcp-server-cloudflare"],
      "env": {
        "CLOUDFLARE_API_TOKEN": "<your-cloudflare-api-token>"
      }
    }
  }
}
```

### Getting API Keys

**Render:**
1. Go to Render Dashboard → Account Settings → API Keys
2. Create new API key
3. Scopes needed: `deploys:all`, `services:read`, `services:write`, `blueprints:read`

**Supabase:**
1. Go to Supabase Dashboard → Account Settings → Access Tokens
2. Create new personal access token
3. Project ref: Found in Project Settings → General

**Cloudflare:**
1. Go to My Profile → API Tokens
2. Create Custom Token with:
   - Account: `Account Settings:Read`
   - Workers Scripts: `Edit`
   - R2: `Read + Write`
3. Or use `Edit Cloudflare Workers` template

---

## 6. GitHub Actions Workflow Changes

The current `.github/workflows/backend-deploy.yml` deploys to Azure. This needs to be replaced with a Render deployment.

### Option A: Render GitHub Integration (Recommended)
Render has native GitHub integration — connect repo in Render dashboard, auto-deploy on push.

### Option B: Render Deploy API via GitHub Actions
```yaml
- name: Deploy to Render
  run: |
    curl -X POST https://api.render.com/v1/services/[SERVICE_ID]/deploys \
      -H "Authorization: Bearer ${{ secrets.RENDER_API_KEY }}" \
      -H "Content-Type: application/json" \
      -d '{"clearCache": true}'
```

### Workflow Changes Required
1. Remove `azure/login` step
2. Remove `azure/webapps-deploy` step
3. Remove Azure app settings steps
4. Add Render deploy trigger step
5. Keep `npm test` step (run before deploy)
6. Add smoke test against Render URL after deploy

---

## 7. Testing Strategy

### Unit Tests (already in codebase)
```bash
npm test
# Runs in <30s, no DB needed
```

### Integration Tests (against Supabase)
```bash
DATABASE_URL=<supabase-connection-string> npm test
```

### Smoke Tests (after Render deploy)
```bash
# Test health
curl https://acs-portal-api.onrender.com/health

# Test CORS preflight
curl -X OPTIONS \
  -H "Origin: https://acschennai.com" \
  -H "Access-Control-Request-Method: GET" \
  https://acs-portal-api.onrender.com/api/attendance

# Test DPR routes
curl https://acs-portal-api.onrender.com/api/dpr
# Expected: 401 (auth required, not 404)
```

---

## 8. Rollback Plan

If Render deployment fails:
1. Azure App Service still running — no data loss
2. Revert DNS if cutover started
3. Investigate logs via Render MCP: `render_mcp_get_service_logs`
4. Fix and redeploy

If Supabase migration has issues:
1. Azure Database still accepting writes
2. Re-export data and re-push
3. Debug with `supabase_mcp_query_database`

---

## 9. Estimated Timeline

| Phase | Effort | Time |
|---|---|---|
| Supabase setup + migration | 2-3 hours | Day 1 |
| Render deployment | 1-2 hours | Day 1 |
| DNS cutover + validation | 1 hour | Day 1 |
| R2 verification | 1 hour | Day 2 |
| Decommission Azure | 30 min | Day 2 |

**Total: ~6-8 hours over 2 days**

---

## 10. Files to Change

| File | Changes |
|---|---|
| `backend/prisma/schema.prisma` | No change (Supabase is standard PostgreSQL) |
| `backend/src/lib/blobStorage.js` | May need R2 env var name updates |
| `backend/src/index.js` | May need PORT handling adjustment for Render |
| `.github/workflows/backend-deploy.yml` | Replace Azure steps with Render deploy |
| `.env` (local dev) | Update `DATABASE_URL` to Supabase |
| `docs/migration-plan.md` | This document |

---

## 11. Verification Checklist

### Supabase
- [ ] Project created at supabase.com
- [ ] MCP server configured and tested
- [ ] Schema pushed: `npx prisma db push`
- [ ] Connection string works from local machine
- [ ] `npm test` passes against Supabase

### Render
- [ ] Service created via dashboard or MCP
- [ ] GitHub integration connected (or deploy key set)
- [ ] All env vars set in Render dashboard
- [ ] First deploy succeeds
- [ ] `/health` returns 200
- [ ] DPR routes return 401 (not 404)
- [ ] CORS headers present on all responses

### DNS Cutover
- [ ] Render URL resolves and works
- [ ] Browser HAR shows all requests succeeding
- [ ] CORS preflight returns correct `Access-Control-Allow-Origin`

### R2
- [ ] Photo uploads work end-to-end
- [ ] DPR photos visible in frontend

---

## 12. Open Questions / Decisions Needed

1. **R2 env var names**: Should we rename `AZURE_STORAGE_*` to `R2_*` for clarity, or keep for backward compatibility?
2. **Render plan**: Free tier? Starter at $7/mo? Determine based on traffic.
3. **Supabase plan**: Free tier (500MB DB) or paid? DPR photo metadata won't be large.
4. **Zero-downtime migration**: Keep Azure running while testing Render, then switch DNS.
5. **Existing Azure DB data**: Export via `pg_dump` and import to Supabase. Need downtime window or use replication.
