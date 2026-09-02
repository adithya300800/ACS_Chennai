# Backend scripts

Out-of-band operational scripts. Run from the repo root or `backend/`
directory; each script is a standalone Node program (`node scripts/<name>.js`).

## `provisionR2.js` — R2 bucket + CORS provisioning (DR-017)

**Purpose.** Canonical, one-shot replacement for the per-boot
`applyR2Cors()` call in `src/lib/blobStorage.js`. Creates missing buckets
and applies the CORS policy that allows the browser preflight to the
presigned PUT URL to succeed.

**Why this is a script and not boot logic.** Boot-time control-plane
calls (`s3:CreateBucket`, `s3:PutBucketCors`) require broad IAM scope.
Moving them to a deploy-time script lets the runtime R2 key hold only
`s3:PutObject` / `s3:GetObject` / `s3:DeleteObject` (least privilege).
It also removes a race where `/ready` could report healthy before the
bucket policy was actually in place.

**Invocation.**

```bash
# Provision a single bucket
node scripts/provisionR2.js --bucket dpr-photos

# Provision both photo buckets + the future training bucket
node scripts/provisionR2.js --bucket dpr-photos --bucket inspection-photos --bucket training-materials

# No args → every bucket in ALLOWED_R2_BUCKETS ∪ REQUIRED_BUCKETS
node scripts/provisionR2.js

# Add an extra AllowedOrigin (repeatable)
node scripts/provisionR2.js --bucket dpr-photos --origin http://localhost:5173

# Print the plan without calling R2
node scripts/provisionR2.js --bucket dpr-photos --dry-run

# Apply CORS only (skip CreateBucket — useful when the bucket exists but policy drifted)
node scripts/provisionR2.js --bucket dpr-photos --no-create
```

**Required env vars.**

```
R2_ACCOUNT_ID          Cloudflare account ID (used as endpoint suffix)
R2_ACCESS_KEY_ID       R2 Access Key ID with s3:* on the bucket paths
R2_SECRET_ACCESS_KEY   R2 Secret Access Key
ALLOWED_ORIGINS        Optional; comma-separated AllowedOrigins. Default: https://acschennai.com
R2_BUCKET_DPR_PHOTOS          Optional override; default dpr-photos
R2_BUCKET_DPR_DOCUMENTS       Optional override; default dpr-documents
R2_BUCKET_INSPECTION_PHOTOS   Optional override; default inspection-photos
R2_BUCKET_TRAINING_MATERIALS  Optional override; default training-materials
```

**Recommended CI step.** Run as a `preDeploy` job (Render "Pre-Deploy
Command" or equivalent) so a missing bucket or stale CORS fails the
deploy before user traffic routes to a broken instance:

```yaml
# render.yaml excerpt
preDeployCommand: |
  node scripts/provisionR2.js --bucket dpr-photos
  node scripts/provisionR2.js --bucket inspection-photos
  node scripts/provisionR2.js --bucket training-materials
```

**Exit codes.**

| Code | Meaning |
|---|---|
| 0   | Every bucket reached the desired state |
| 1   | At least one bucket failed (printed per-bucket) |
| 2   | Bad CLI args or missing env |

## `sweepOrphanUploads.js` — nightly orphan blob cleanup (DR-017)

**Purpose.** Walks every required R2 bucket, lists every object, then
compares against the `DPRPhoto` and `InspectionPhoto` tables. Any object
older than 24 hours whose key has no matching DB row is deleted — these
are uploads that the user started (got a presigned PUT) but never
confirmed, or whose DPR/Inspection record was deleted out from under the
blob. Without this sweep, R2 accumulates dead bytes forever and the bill
creeps up silently.

**Why nightly.** Presigned PUT URLs are valid for 15 minutes and the
confirm-upload path runs server-side blob verification (round-13). 24
hours is the safe floor: a user who closed the tab at upload time gets
a full day to come back, retry, and confirm before the bytes are
reclaimed.

**Invocation.**

```bash
# Dry run — print what would be deleted, no R2 mutations
node scripts/sweepOrphanUploads.js --dry-run

# Default sweep — 24h threshold, every required bucket
node scripts/sweepOrphanUploads.js

# Tighten the threshold (e.g. for the first few days after deploy)
node scripts/sweepOrphanUploads.js --older-than-hours 6

# Only one bucket
node scripts/sweepOrphanUploads.js --bucket dpr-photos
```

**Recommended Render cron.** Add a cron job that runs nightly at 03:15
IST (off-peak, after the daily DPR submit window):

```
node scripts/sweepOrphanUploads.js
```

**Exit codes.**

| Code | Meaning |
|---|---|
| 0   | Sweep completed (with or without deletions) |
| 1   | Fatal error — R2 unreachable, DB unreachable, etc. |
| 2   | Bad CLI args or missing env |

## Existing scripts

| Script | Purpose |
|---|---|
| `round13-tests.js` | Standalone test runner for the round-13 leave + timesheet rules (jest hangs in the Mac sandbox; this is the workaround). |

## Adding new scripts

Keep the operational concerns separated from the runtime:

- One script = one job. No multi-purpose "ops" scripts that read stdin.
- All scripts must read env, validate at start, and exit non-zero on
  failure so CI / Render cron can detect a broken sweep.
- Never `require('../src/index')` from a script — boot-time side
  effects (Express listen, R2 CORS) will fire. Import only the
  library modules you need (`lib/blobStorage`, `lib/cursor`, etc.).
- Log with a `[scriptName]` prefix so Render logs are filterable.
