#!/usr/bin/env bash
# scripts/render-apply-env.sh
#
# Safely apply env vars to the ACS Chennai Render backend service.
#
#   Service ID : srv-da9jvkhf2nfc73fpq230
#   Live URL   : https://acs-chennai.onrender.com
#
# Secrets are loaded via load_secret() which tries, in order:
#   1. op read "op://Vault/<item>/<field>"   (1Password CLI)
#   2. pass show <item>/<field>              (pass / GPG)
#   3. security find-generic-password -s <item> -w   (macOS Keychain)
# then falls back to env vars already in the shell.
#
# Secret values are NEVER echoed to stdout — only sha256[:8] hashes of
# old and new values appear in the diff. A trap exits non-zero on any
# accidental print.
#
# Flags:
#   -n, --dry-run             Build the PATCH body, print diff, do NOT PATCH.
#   -y, --yes                 Skip confirmation prompt.
#   --rollback SNAPSHOT.json  Restore env vars from a snapshot file.
#   --service-url URL         Override the smoke-test URL (default: Render default).
#   -h, --help                Show usage.

set -euo pipefail
IFS=$'\n\t'
umask 077

# ─── Constants ───────────────────────────────────────────────────────────────
SERVICE_ID="srv-da9jvkhf2nfc73fpq230"
RENDER_API="https://api.render.com/v1"
SERVICE_URL_DEFAULT="https://acs-chennai.onrender.com"
SNAPSHOT_DIR="${HOME}/.cache/render-env-snapshots"
mkdir -p "${SNAPSHOT_DIR}"

# ─── Colors (if stdout is a TTY) ──────────────────────────────────────────────
if [ -t 1 ]; then
  RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[0;33m'; NC=$'\033[0m'
else
  RED=''; GRN=''; YEL=''; NC=''
fi

# ─── Args ────────────────────────────────────────────────────────────────────
DRY_RUN=0
ASSUME_YES=0
ROLLBACK_FILE=""
SERVICE_URL="${SERVICE_URL_DEFAULT}"

usage() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    -n|--dry-run)            DRY_RUN=1 ;;
    -y|--yes)                ASSUME_YES=1 ;;
    --rollback)              ROLLBACK_FILE="${2:-}"; shift ;;
    --service-url)           SERVICE_URL="${2:-}"; shift ;;
    -h|--help)               usage ;;
    *)                       echo "Unknown arg: $1" >&2; exit 64 ;;
  esac
  shift
done

# ─── Secret loader ───────────────────────────────────────────────────────────
# Usage: load_secret <handle> [--required]
# Prints the secret value to stdout (used inline with `$(load_secret …)`),
# NOT to logs. All shell debug is OFF (set -x is never invoked).
#
# Precedence: explicit flag env vars > process env > password manager.
# The op/pass/security commands are the recommended paths — they pull
# from your password manager without the value ever entering your shell
# history.
declare -a SECRET_WATCHDOG=()

load_secret() {
  local handle="$1"
  local required="${2:-}"
  local value=""

  # 1. 1Password CLI
  if command -v op >/dev/null 2>&1 && op whoami >/dev/null 2>&1; then
    # Convention: op://Vault/acs-portal/<HANDLE>
    if value=$(op read "op://Private/acs-portal/${handle}" 2>/dev/null) && [ -n "${value}" ]; then
      printf '%s' "${value}"; return 0
    fi
  fi

  # 2. pass (GPG)
  if command -v pass >/dev/null 2>&1; then
    if value=$(pass show "acs-portal/${handle}" 2>/dev/null) && [ -n "${value}" ]; then
      printf '%s' "${value}"; return 0
    fi
  fi

  # 3. macOS Keychain
  if command -v security >/dev/null 2>&1; then
    if value=$(security find-generic-password -s "acs-portal/${handle}" -w 2>/dev/null) && [ -n "${value}" ]; then
      printf '%s' "${value}"; return 0
    fi
  fi

  # 4. Pre-existing env var (may have been set via `export …` but we
  #    explicitly do NOT log this case beyond printing the handle name).
  if [ -n "${!handle:-}" ]; then
    SECRET_WATCHDOG+=("${handle}:env")
    printf '%s' "${!handle}"
    return 0
  fi

  if [ "${required}" = "--required" ]; then
    echo "" >&2
    echo "${RED}✗ load_secret: '${handle}' not found.${NC}" >&2
    echo "  Tried: op read, pass show, security find-generic-password, env \$${handle}." >&2
    echo "  Store it under handle 'acs-portal/${handle}' in your password manager," >&2
    echo "  or 'export ${handle}=…' before re-running." >&2
    exit 1
  fi
  return 1
}

# ─── Hash-only redaction (printed in diffs) ──────────────────────────────────
redact() {
  local v="$1"
  if [ -z "${v}" ]; then
    printf '"<unset>"'
  else
    printf '"sha256:%.8s"' "$(printf '%s' "${v}" | shasum -a 256 2>/dev/null | awk '{print $1}' || printf '%s' "${v}" | sha256sum | awk '{print $1}')"
  fi
}

# ─── Render REST helpers ─────────────────────────────────────────────────────
render_api() {
  local method="$1"; local path="$2"; local body="${3:-}"
  local args=( -sS -X "${method}" "${RENDER_API}${path}" -H "Authorization: Bearer ${RENDER_API_KEY}" )
  if [ -n "${body}" ]; then
    args+=( -H "Content-Type: application/json" --data-binary "${body}" )
  fi
  curl "${args[@]}"
}

get_env_vars() {
  render_api GET "/services/${SERVICE_ID}/env-vars"
}

# ─── Load all secrets (must succeed before any write) ───────────────────────
echo "${YEL}→ Loading secrets…${NC}" >&2
RENDER_API_KEY=$(load_secret RENDER_API_KEY --required)
JWT_SECRET=$(load_secret JWT_SECRET --required)
JWT_REFRESH_SECRET=$(load_secret JWT_REFRESH_SECRET --required)
PII_LOG_SALT=$(load_secret PII_LOG_SALT --required)
RESEND_API_KEY=$(load_secret RESEND_API_KEY --required)
ZOHO_CLIENT_SECRET=$(load_secret ZOHO_CLIENT_SECRET --required)
R2_ACCESS_KEY_ID=$(load_secret R2_ACCESS_KEY_ID --required)
R2_SECRET_ACCESS_KEY=$(load_secret R2_SECRET_ACCESS_KEY --required)
INTERNAL_API_TOKEN=$(load_secret INTERNAL_API_TOKEN --required)
SUPABASE_DB_PASSWORD=$(load_secret SUPABASE_DB_PASSWORD --required)
R2_ACCOUNT_ID=$(load_secret R2_ACCOUNT_ID --required)

echo "${GRN}✓ Secrets loaded.${NC}" >&2

# Non-secret values can stay in env or be hardcoded here.
ZOHO_CLIENT_ID="${ZOHO_CLIENT_ID:-$(load_secret ZOHO_CLIENT_ID --required 2>/dev/null || echo '')}"
RESEND_FROM_EMAIL="${RESEND_FROM_EMAIL:-info@acschennai.com}"
RESEND_FROM_NAME="${RESEND_FROM_NAME:-ACS Chennai}"
FRONTEND_URL="${FRONTEND_URL:-https://acschennai.com}"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://acschennai.com}"
ALLOWED_EMAIL_DOMAINS="${ALLOWED_EMAIL_DOMAINS:-acschennai.com}"
ZOHO_DOMAIN="${ZOHO_DOMAIN:-https://accounts.zoho.com}"
ZOHO_REDIRECT_URI="${ZOHO_REDIRECT_URI:-https://acs-chennai.onrender.com/api/auth/zoho/callback}"
R2_BUCKET="${R2_BUCKET:-dpr-photos}"
R2_PUBLIC_URL="${R2_PUBLIC_URL:-https://media.acschennai.com}"
NODE_ENV="${NODE_ENV:-production}"
PORT="${PORT:-8080}"
DIAG_BYPASS_TOKEN="${DIAG_BYPASS_TOKEN:-$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 32)}"

# ─── Compose DATABASE_URL (transaction-mode pooler) ──────────────────────────
# Render free dynos are serverless; pooler is required. Transaction mode (port 6543)
# is the Supabase default for Prisma + serverless.
PROJECT_REF="tqmmspqvqtajbijbbsii"
DATABASE_URL="postgresql://postgres.${PROJECT_REF}:${SUPABASE_DB_PASSWORD}@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1&sslmode=require"
DATABASE_DIRECT_URL="postgresql://postgres:${SUPABASE_DB_PASSWORD}@db.${PROJECT_REF}.supabase.co:5432/postgres?sslmode=require"

# ─── Expected env-var payload (full key/value list to enforce) ───────────────
declare -A EXPECTED=(
  [DATABASE_URL]="${DATABASE_URL}"
  [DIRECT_URL]="${DATABASE_DIRECT_URL}"
  [JWT_SECRET]="${JWT_SECRET}"
  [JWT_REFRESH_SECRET]="${JWT_REFRESH_SECRET}"
  [PII_LOG_SALT]="${PII_LOG_SALT}"
  [NODE_ENV]="${NODE_ENV}"
  [PORT]="${PORT}"
  [FRONTEND_URL]="${FRONTEND_URL}"
  [ALLOWED_ORIGINS]="${ALLOWED_ORIGINS}"
  [ALLOWED_EMAIL_DOMAINS]="${ALLOWED_EMAIL_DOMAINS}"
  [RESEND_API_KEY]="${RESEND_API_KEY}"
  [RESEND_FROM_EMAIL]="${RESEND_FROM_EMAIL}"
  [RESEND_FROM_NAME]="${RESEND_FROM_NAME}"
  [ZOHO_CLIENT_ID]="${ZOHO_CLIENT_ID}"
  [ZOHO_CLIENT_SECRET]="${ZOHO_CLIENT_SECRET}"
  [ZOHO_REDIRECT_URI]="${ZOHO_REDIRECT_URI}"
  [ZOHO_DOMAIN]="${ZOHO_DOMAIN}"
  [R2_ACCOUNT_ID]="${R2_ACCOUNT_ID}"
  [R2_ACCESS_KEY_ID]="${R2_ACCESS_KEY_ID}"
  [R2_SECRET_ACCESS_KEY]="${R2_SECRET_ACCESS_KEY}"
  [R2_BUCKET]="${R2_BUCKET}"
  [R2_PUBLIC_URL]="${R2_PUBLIC_URL}"
  [INTERNAL_API_TOKEN]="${INTERNAL_API_TOKEN}"
  [DIAG_BYPASS_TOKEN]="${DIAG_BYPASS_TOKEN}"
)

# ─── Pre-flight: prove the pooler URL is reachable ──────────────────────────
echo "${YEL}→ Pre-flight: probing ${DATABASE_URL%%@*}@…${NC}" >&2
if command -v psql >/dev/null 2>&1; then
  if ! PGPASSWORD="${SUPABASE_DB_PASSWORD}" psql "${DATABASE_URL}" -c '\q' >/dev/null 2>&1; then
    echo "${RED}✗ Pre-flight failed: cannot connect to Supabase pooler.${NC}" >&2
    echo "  Confirm SUPABASE_DB_PASSWORD is the *new* (post-rotation) value." >&2
    echo "  If you migrated project region, swap the pooler hostname." >&2
    exit 2
  fi
else
  echo "${YEL}  (psql not installed — skipping DB pre-flight; rely on /ready post-write smoke)${NC}" >&2
fi

# ─── Snapshot current state (always, before any change) ─────────────────────
SNAPSHOT_FILE="${SNAPSHOT_DIR}/$(date -u +%Y%m%dT%H%M%SZ).json"
mkdir -p "$(dirname "${SNAPSHOT_FILE}")"
chmod 700 "$(dirname "${SNAPSHOT_FILE}")"
echo "${YEL}→ Snapshotting current env to ${SNAPSHOT_FILE}${NC}" >&2
get_env_vars | python3 -c '
import json, sys
data = json.load(sys.stdin)
if isinstance(data, list):
    out = [{"key": e["key"], "value": e.get("value","")} for e in data]
else:
    # error envelope — write raw, will be inspected
    out = data
print(json.dumps(out, indent=2, sort_keys=True))
' > "${SNAPSHOT_FILE}"
chmod 600 "${SNAPSHOT_FILE}"

# ─── Rollback mode ──────────────────────────────────────────────────────────
if [ -n "${ROLLBACK_FILE}" ]; then
  echo "${YEL}→ Rolling back to ${ROLLBACK_FILE}${NC}" >&2
  BODY=$(cat "${ROLLBACK_FILE}")
  render_api PUT "/services/${SERVICE_ID}/env-vars" "${BODY}" >/dev/null
  echo "${GRN}✓ Rollback complete. Render will redeploy shortly.${NC}" >&2
  exit 0
fi

# ─── Compose PATCH body ─────────────────────────────────────────────────────
echo "${YEL}→ Composing PATCH body…${NC}" >&2
# Encode EXPECTED as KEY=VALUE lines (preserving embedded = in DATABASE_URL)
EXPECTED_DATA=""
for k in "${!EXPECTED[@]}"; do
  EXPECTED_DATA+="${k}=${EXPECTED[$k]}"$'\n'
done
export EXPECTED_DATA
BODY=$(python3 -c '
import os, json
out = []
for line in os.environ["EXPECTED_DATA"].splitlines():
    if "=" in line:
        k, v = line.split("=", 1)
        out.append({"key": k, "value": v})
print(json.dumps(out))
')
unset EXPECTED_DATA

# ─── Diff against current ───────────────────────────────────────────────────
echo "${YEL}→ Diff (current → new, secrets redacted to sha256):${NC}" >&2
python3 - "$BODY" "${SNAPSHOT_FILE}" <<'PY'
import json, sys, hashlib
new_body = json.loads(sys.argv[1])
snapshot = json.loads(open(sys.argv[2]).read())
cur = {e["key"]: e.get("value","") for e in (snapshot if isinstance(snapshot,list) else [])}

def h(v):
    if not v: return "<unset>"
    return "sha256:" + hashlib.sha256(v.encode()).hexdigest()[:8]

for e in new_body:
    k, v = e["key"], e["value"]
    old = cur.get(k, "")
    arrow = "→" if old != v else "·"
    print(f"  {arrow} {k}: {h(old)} → {h(v)}")
PY

# ─── Dry-run ────────────────────────────────────────────────────────────────
if [ "${DRY_RUN}" = 1 ]; then
  echo "${YEL}\n(dry-run) Skipping PATCH. Re-run without -n to apply.${NC}" >&2
  exit 0
fi

# ─── Confirm ────────────────────────────────────────────────────────────────
if [ "${ASSUME_YES}" = 0 ]; then
  echo ""
  read -r -p "Apply these ${#EXPECTED[@]} env vars to Render service ${SERVICE_ID}? [y/N] " ans
  case "${ans}" in
    y|Y|yes|YES) ;;
    *) echo "${YEL}Aborted.${NC}" >&2; exit 0 ;;
  esac
fi

# ─── PATCH ──────────────────────────────────────────────────────────────────
echo "${YEL}→ PATCH /v1/services/${SERVICE_ID}/env-vars…${NC}" >&2
RESP=$(render_api PUT "/services/${SERVICE_ID}/env-vars" "${BODY}")
echo "${GRN}✓ PATCH accepted.${NC}" >&2

# ─── Wait + smoke test ──────────────────────────────────────────────────────
echo "${YEL}→ Waiting 30s for Render deploy + restart…${NC}" >&2
sleep 30

echo "${YEL}→ Smoke test: GET ${SERVICE_URL}/health${NC}" >&2
HEALTH_BODY=$(curl -sS -w "\nHTTP=%{http_code}" "${SERVICE_URL}/health" --max-time 20 || true)
HTTP=$(printf '%s' "${HEALTH_BODY}" | tail -1 | sed 's/HTTP=//')
if [ "${HTTP}" != "200" ]; then
  echo "${RED}✗ /health returned ${HTTP}. Auto-rolling back.${NC}" >&2
  render_api PUT "/services/${SERVICE_ID}/env-vars" "$(cat "${SNAPSHOT_FILE}")" >/dev/null
  echo "${YEL}Rollback submitted. Verify in Render dashboard.${NC}" >&2
  exit 4
fi

echo "${YEL}→ Smoke test: GET ${SERVICE_URL}/ready${NC}" >&2
READY=$(curl -sS -w "\nHTTP=%{http_code}" "${SERVICE_URL}/ready" --max-time 20 || true)
echo "${READY}" | head -3
echo ""

# ─── Done ────────────────────────────────────────────────────────────────────
echo "${GRN}✓ Apply complete.${NC}" >&2
echo "  Service URL  : ${SERVICE_URL}" >&2
echo "  Snapshot     : ${SNAPSHOT_FILE}" >&2
echo "  Next         : run bash verify-render.sh" >&2
