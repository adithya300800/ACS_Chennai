# ACS Portal Operations Runbook

**Last updated:** 2026-09-03 (Round-26, LPR-015 closure)
**Owner:** Platform / SRE
**Live URL:** `https://acs-chennai.onrender.com`
**Database:** Supabase (project `tqmmspqvqtajbijbbsii`)
**Object storage:** Cloudflare R2 (`acs-portal` account)

---

## 1. Release identity contract

Every production deploy MUST satisfy these three checks after Render reports the deploy is "live":

| Check | Endpoint | Auth | Pass criterion |
|---|---|---|---|
| Health | `GET /health` | none | HTTP 200, body `{"status":"ok"}` |
| Readiness | `GET /ready` | none | HTTP 200, `checks.db === 'ok'`, every required R2 bucket returns `ok: true` |
| Version match | `GET /version` | header `X-Internal-Token: $INTERNAL_API_TOKEN` | `matches === true` (deploySha === expectedSha) |

The CI workflow records `EXPECTED_SHA = github.event.head_sha` before triggering the Render deploy and the container receives `DEPLOY_SHA` as its build-time identity.

**If `/version` returns `matches === false`**:** the running code is older than the requested release. Do NOT proceed — invoke the rollback procedure.

## 2. Backup policy

| Artifact | Tool | Where | Retention | Owner evidence |
|---|---|---|---|---|
| Production Postgres | `scripts/backup-database.sh` | `backups/acs-portal-<UTC>.dump.gz` in the workflow runner + manual archive to R2 (encrypted) bucket | 90 days | Workflow artifact upload step |
| R2 `dpr-photos`, `inspection-photos`, `training-materials` | R2 lifecycle rule `acs-portal-uploads-archive` | R2 IA tier | 365 days | R2 bucket lifecycle config |

A pre-deploy backup is part of the deploy workflow (`backend-deploy.yml`). It runs the new `scripts/backup-database.sh` step, uploads the artifact to the GH Actions artifact store (90 days), and prints a checksum that ops can verify.

## 3. Restore rehearsal

**RTO target:** 30 minutes from incident declaration.
**RPO target:** 1 hour (last backup before incident).

Rehearsal steps (run quarterly):

1. Create a fresh Supabase project (free tier). Copy its `DATABASE_URL`.
2. Run `BACKUP_RESTORE_URL=<disposable-url> BACKUP_FILE=./backups/<latest>.dump.gz scripts/restore-database.sh`.
3. `psql $BACKUP_RESTORE_URL -c 'select count(*) from employees;'` — must be > 0.
4. `psql $BACKUP_RESTORE_URL -c 'select count(*) from dpr;'` — must equal the dashboard's "Total Active DPRs" aggregate.
5. Time the run. Record elapsed seconds in the SRE change log as RTO evidence.

Rehearsal results are required before LPR-015 can be marked Done for a quarter.

## 4. Orphan upload cleanup

Two layers, deliberately kept distinct:

- **Hot-path eviction.** `pendingUploads` Map + `setTimeout` in
  `lib/uploadRoutes.js` — instant cleanup while the process lives, but
  does NOT survive a restart. Owner: platform.
- **Durable sweep (S3-7).** `POST /api/internal/upload/sweep` is the
  restart-surviving replacement. Wired by GH Actions cron
  `*/15 * * * *` (`cron-upload-sweep.yml`). Three passes share one time
  budget:
  1. `PENDING` past its 20-min upload TTL → `EXPIRED` + deleteBlob.
  2. `CONFIRMED` with no binding past the 1h grace → `EXPIRED` +
     deleteBlob (the silent orphan class LPR-012 left open).
  3. `EXPIRED` whose delete previously failed, older than 24h → retry
     delete and stamp `boundType='swept'` so the pass terminates.
  Atomic guards (`where: { id, status: { in: [...] }, boundAt: null }`)
  are the serialization point against a concurrent DPR/Inspection POST
  binding the row. A bounded stop returns 200 with `stoppedReason` and
  `remainingEstimate` — see the workflow's grep-echo for log signals.
  Owner: platform.

Env vars (defaults shown):

- `UPLOAD_SWEEP_BATCH` — findMany `take` per batch (500)
- `UPLOAD_SWEEP_RUN_MAX` — total actions per fire (2000)
- `UPLOAD_SWEEP_RUN_BUDGET_MS` — wall-clock cap per fire (110000,
  leaves slack under the 180s GH Actions curl timeout)
- `UPLOAD_SWEEP_CONFIRMED_GRACE_MS` — pass-2 grace window (3600000 = 1h)
- `UPLOAD_SWEEP_EXPIRED_VERIFY_MS` — pass-3 retry window
  (86400000 = 24h)

## 5. Digest run recovery

A `DigestRun` row left in `PENDING` for > 1 hour is stale. The backend now has a `recoverStalePendingRuns()` function (LPR-010 fix) that should be called by the same daily cron at `47 2 * * *`. Owner: notifications.

## 6. Email retention

`EmailLog` rows older than 90 days are subject to GDPR/retention pruning. Implement in a future round — current LPR-015 closure documents the policy but not the cron.

## 7. Cold-start warm-up

`/api/internal/warmup/ping` keeps the Render free-tier container warm (15-min idle sleep). GH Actions cron at `*/13 * * * *` (see `cron-warmup.yml`). Owner: platform.

## 7a. Default branch and scheduled workflows

GitHub scheduled events run from the repository's **default branch**, not from whichever branch a workflow YAML lives on. The audit (DR-007) caught that the portal's cron workflows (`cron-backup.yml`, `cron-upload-sweep.yml`, `cron-admin-emails.yml`, `cron-warmup.yml`, `digest.yml`) were committed to `add-react-website` while `main` was still the default — so the schedules silently never fired against the live environment.

**Required state:** the default branch must be `add-react-website` for the schedules to execute. This is a repo Settings → Branches change; it cannot be made from a commit. The `branch-workflows-guardrail.yml` CI job (added with DR-007) fails any push that detects a default branch with zero `schedule:`-triggered workflows — so the gap cannot be silently re-introduced.

If the workflows ever need to live on a separate `ops` branch (e.g. to keep app code isolated from schedule code), set `ops` as the default and pin the workflow YAMLs there. Until that's a deliberate decision, `add-react-website` is the intended default.

## 8. Incident response owners

| Domain | Owner | Contact |
|---|---|---|
| Platform / deploy / backups | TBD (assign) | GitHub `@adithya300800` |
| Identity / OAuth | TBD (assign) | GitHub `@adithya300800` |
| Attendance / HR data | TBD (assign) | GitHub `@adithya300800` |
| DPR / Inspection workflows | TBD (assign) | GitHub `@adithya300800` |
| Training / Email notifications | TBD (assign) | GitHub `@adithya300800` |
| Storage / R2 | TBD (assign) | GitHub `@adithya300800` |

Replace TBD rows before declaring prod-cutover complete.

---

## Out-of-band (still owed for full LPR-015 closure)

- Live restore rehearsal against a disposable Supabase cluster (manual, requires owner).
- Quarterly backup retention check (scripted cron).
- Real alerting wired to Render logs (out of repo scope).
- EmailLog retention cron (post LPR-010 follow-up).