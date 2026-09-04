# ACS Portal — Database Backup Runbook

**Last updated:** 2026-09-04 (Round-26, B-3 closure)
**Owner:** Platform / SRE
**Live URL:** `https://acs-chennai.onrender.com`
**Database:** Supabase (project `tqmmspqvqtajbijbbsii`)
**Object storage:** Cloudflare R2 (`acs-portal` account)

---

## 1. Schedule & destinations

The DB is backed up daily by `.github/workflows/cron-backup.yml` — a
GitHub Actions cron that runs `pg_dump` and uploads the result to R2.
Supabase free tier does not include scheduled snapshots or PITR, so this
workflow is the only off-site copy we have.

| Slot | Cron (UTC) | Cron (IST) | What runs |
|---|---|---|---|
| Daily | `30 2 * * *` | 08:00 IST | `pg_dump` → upload to R2 `daily/` |
| Sunday (within the same run) | `30 2 * * 0` | 08:00 IST | also copy to R2 `weekly/` |

The 02:30 UTC slot is chosen to sit between the `00:30 UTC` training-
overdue sweep and the `13:30 UTC` admin attendance digest, so the backup
IO does not contend with either cron on the shared Supabase project.
GH Actions lag of up to ~30 minutes is acceptable for a daily backup —
worst case is a timestamp ~30 minutes after the nominal slot.

| Prefix in R2 | Retention | Purpose |
|---|---|---|
| `s3://${R2_BUCKET_DB_BACKUPS}/daily/` | 14 days (configurable via `workflow_dispatch`) | hot restore window |
| `s3://${R2_BUCKET_DB_BACKUPS}/weekly/` | 28 days (4 Sundays) | longer-term restore point |

Filename pattern: `acs-portal-YYYY-MM-DDTHHMMSSZ.dump` (and a sibling
`acs-portal-YYYY-MM-DDTHHMMSSZ.dump.sha256`). The YYYY-MM-DD prefix is
what the retention sweep keys off; the HHMMSSZ suffix keeps manual
re-runs from colliding with the scheduled dump.

---

## 2. Required GitHub repository secrets

Before the first scheduled fire (or before a manual test), add these
under **Settings → Secrets and variables → Actions → New repository
secret**:

| Secret | What it is | Source of truth |
|---|---|---|
| `DIRECT_DATABASE_URL` | Supabase **session-mode** Postgres URL (port 5432). Required for `pg_dump`; the transaction-mode pooler (port 6543) cannot service a long-running `COPY` stream. | Render env var `DIRECT_DATABASE_URL` (used by `prisma migrate deploy`). |
| `R2_ACCOUNT_ID` | Cloudflare account ID. | Render env var `R2_ACCOUNT_ID`. |
| `R2_ACCESS_KEY_ID` | R2 access key (preferably a key scoped only to the `db-backups` bucket — see DR-017 in `backend/src/lib/blobStorage.js`). | Render env var `R2_ACCESS_KEY_ID`. |
| `R2_SECRET_ACCESS_KEY` | R2 secret for the key above. | Render env var `R2_SECRET_ACCESS_KEY`. |
| `R2_BUCKET_DB_BACKUPS` | Name of the bucket (default `db-backups`). Must exist before the first fire. | New env var; declared in `render.yaml` for the backend service. |

> **R2 bucket does not auto-create.** The workflow does not carry bucket-
> creation IAM (least privilege). Either create the bucket once in the
> Cloudflare R2 dashboard, or extend `backend/scripts/provisionR2.js` to
> create it (the bucket is now listed in `ALLOWED_R2_BUCKETS` in
> `backend/src/lib/blobStorage.js` so the script picks it up).

### How to add a secret

1. Repo → **Settings** → **Secrets and variables** → **Actions**.
2. **New repository secret**.
3. Name = e.g. `R2_BUCKET_DB_BACKUPS`, value = `db-backups`.
4. Repeat for the four R2 / DB entries above.

---

## 3. Retention policy

| Prefix | Default retention | Override | Notes |
|---|---|---|---|
| `daily/` | 14 days | `workflow_dispatch` input `retention_days` (7 / 14 / 21 / 28 / 30 / 60 / 90) | Strict older-than comparison; today's key is never deleted. |
| `weekly/` | 28 days | edit `WEEKLY_RETENTION_DAYS` in `cron-backup.yml` | Sunday's daily is copied to `weekly/` at the start of each sweep. |

The sweep is idempotent: it computes `cutoff = today − retention_days`
and deletes any object whose embedded `YYYY-MM-DD` date is **strictly
less than** the cutoff. The dump for today is therefore never touched
on the day it was created.

To change retention, either dispatch with a different `retention_days`
(one-off) or edit the cron workflow's `WEEKLY_RETENTION_DAYS` env var
(default `28`).

---

## 4. How to restore

> **Coordinate with the team before running an in-place restore.** This
> section assumes an incident has been declared and a restore point has
> been agreed. For one-off testing, use the scratch-DB procedure only.

### 4a. List available restore points

```bash
# Daily (last 14 by default)
aws --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  s3 ls "s3://${R2_BUCKET_DB_BACKUPS}/daily/" | sort

# Weekly (last 4 Sundays by default)
aws --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  s3 ls "s3://${R2_BUCKET_DB_BACKUPS}/weekly/" | sort
```

### 4b. Download the dump + verify the checksum

```bash
DATE="2026-09-04T080000Z"   # pick from the listing above
DUMP="acs-portal-${DATE}.dump"
SHA="${DUMP}.sha256"

aws --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  s3 cp "s3://${R2_BUCKET_DB_BACKUPS}/daily/${DUMP}" "./${DUMP}"
aws --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  s3 cp "s3://${R2_BUCKET_DB_BACKUPS}/daily/${SHA}" "./${SHA}"

# MUST match before proceeding.
sha256sum -c "${SHA}"
```

### 4c. Restore into a SCRATCH database first (mandatory)

Restore into a disposable Supabase project (free tier) or a local
Postgres. **Never restore directly into production** until the scratch
restore has been verified.

```bash
# 1) Create a fresh Supabase project (free tier) and grab its session-mode
#    DATABASE_URL (port 5432) — same shape as DIRECT_DATABASE_URL.
SCRATCH_URL="postgres://...:5432/postgres"

# 2) Run pg_restore against it.
#    --clean    : drop objects before recreating them.
#    --no-owner : ignore ownership from the dump (the dump was created
#                 with --no-owner so this is a belt-and-suspenders match).
#    --no-acl   : ignore GRANT/REVOKE statements.
#    --jobs=4   : parallel restore (tune to your CPU).
#    -d         : target database (the SCRATCH_URL above).
pg_restore -d "$SCRATCH_URL" \
  --clean --no-owner --no-acl --jobs=4 \
  "./acs-portal-${DATE}.dump"

# 3) Verify row counts against the dashboard's aggregates.
psql "$SCRATCH_URL" -c "SELECT COUNT(*) FROM \"Employee\";"
psql "$SCRATCH_URL" -c "SELECT COUNT(*) FROM \"DPR\";"
psql "$SCRATCH_URL" -c "SELECT COUNT(*) FROM \"Inspection\";"
psql "$SCRATCH_URL" -c "SELECT COUNT(*) FROM \"TrainingEnrollment\";"
psql "$SCRATCH_URL" -c "SELECT COUNT(*) FROM \"LeaveRequest\";"
```

If row counts look wrong, the dump is corrupted or the schema drifted
between dump-time and now. Stop and investigate — do not attempt an
in-place restore.

### 4d. In-place restore (ONLY after scratch verification + coordination)

> Requires a declared incident and sign-off from the owner of
> `docs/OPERATIONS.md` § 1 (release identity contract). Coordinate the
> maintenance window with admins so they don't write to a half-restored
> DB.

```bash
# PAUSE writes first — flip the Render service into maintenance mode, or
# block writes via a Prisma middleware that returns 503 for mutating
# verbs. Then:

PROD_URL="$DIRECT_DATABASE_URL"   # session-mode URL (port 5432)
pg_restore -d "$PROD_URL" \
  --clean --no-owner --no-acl --jobs=4 \
  "./acs-portal-${DATE}.dump"

# Resume traffic. Verify the release identity contract (docs/OPERATIONS.md
# § 1): /health, /ready, and /version must all return 200 before users
# are allowed back in.
```

Cross-reference the round-26 LPR rollback procedure for the full pre-
flight + post-restore verification checklist.

---

## 5. How to verify a backup

Three signals must all hold for a backup to be considered valid:

1. **Workflow run is green.** `gh actions view <run-id>` or the Actions
   UI shows a green check. A red run is a failed backup.
2. **SHA256 matches.** The `.sha256` file alongside the dump is the
   ground-truth checksum. Download both and run `sha256sum -c`.
3. **Scratch restore succeeds.** Procedure in § 4c above. This is the
   only check that proves the dump is actually restorable.

Schedule a quarterly rehearsal (per `docs/OPERATIONS.md` § 3) and record
elapsed seconds in the SRE change log as RTO evidence.

---

## 6. Quick reference — manual fire

```text
GitHub → repo → Actions → "Database backup (off-site to R2)" → Run workflow
```

Optional input: `retention_days` (default `14`). Choose a smaller
window to force a one-off aggressive sweep; choose a larger window if
you want to extend retention for a specific manual fire.

---

## 7. Quick reference — where things live

| Concern | Location |
|---|---|
| Workflow file | `.github/workflows/cron-backup.yml` |
| R2 bucket list (CORS self-heal + `provisionR2.js`) | `backend/src/lib/blobStorage.js` (`ALLOWED_R2_BUCKETS`) |
| Render env var declaration (IaC) | `render.yaml` (backend service `envVars:`) |
| Live Supabase URL / R2 keys | Render dashboard (env vars are `sync: false`) |
| This runbook | `docs/BACKUPS.md` |