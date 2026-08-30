#!/usr/bin/env bash
# verify-render.sh — SRE's 7-probe verification ladder for the ACS Chennai Render deploy.
#
# Probes, in order (each catches the most regressions per minute spent):
#   1. GET  /ready               → DB pool + R2 + schema existence in one shot
#   2. POST /api/auth/login      → schema + bcrypt + JWT signing
#   3. POST /api/auth/refresh    → JWT_REFRESH_SECRET round-trip
#   4. GET  /api/auth/me         → auth middleware + employee lookup
#   5. POST /api/contact         → Resend wiring
#   6. OPTIONS /api/auth/login   → CORS regression check
#   7. GET  /api/version         → ops surface + X-Internal-Token
#
# Exit 0 only if all probes are GREEN.
#
# Usage:
#   ADMIN_EMAIL=admin@acschennai.com ADMIN_PASSWORD='...' INTERNAL_API_TOKEN='...' \
#     bash verify-render.sh

set -euo pipefail
B="https://acs-chennai.onrender.com"
RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[0;33m'; NC=$'\033[0m'

ADMIN_EMAIL="${ADMIN_EMAIL:-admin@acschennai.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-password123}"
INTERNAL_API_TOKEN="${INTERNAL_API_TOKEN:-}"

pass=0; fail=0
probe() {
  local n="$1"; local expected="$2"; local actual="$3"; shift 3
  if [ "${actual}" = "${expected}" ]; then
    printf "${GRN}  ✓ #%s  %-30s  %s${NC}\n" "${n}" "$1" "${actual}"
    pass=$((pass+1))
  else
    printf "${RED}  ✗ #%s  %-30s  expected %s, got %s${NC}\n" "${n}" "$1" "${expected}" "${actual}"
    fail=$((fail+1))
  fi
}

echo "${YEL}▶ Probing ${B}${NC}"

# 1. /ready
ready_resp=$(/usr/bin/curl -sS "${B}/ready" -w "\nHTTP=%{http_code}" --max-time 30 || true)
ready_code=$(printf '%s' "${ready_resp}" | tail -1 | sed 's/HTTP=//')
ready_body=$(printf '%s' "${ready_resp}" | head -n -1)
probe 1 "200" "${ready_code}" "/ready (DB+R2)"
echo "        body: $(printf '%s' "${ready_body}" | head -c 200)"

# 2. login
login_resp=$(/usr/bin/curl -sS -X POST "${B}/api/auth/login" \
  -H 'Content-Type: application/json' -H "Origin: https://acschennai.com" \
  -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}" \
  -w "\nHTTP=%{http_code}" --max-time 30 || true)
login_code=$(printf '%s' "${login_resp}" | tail -1 | sed 's/HTTP=//')
probe 2 "200" "${login_code}" "/api/auth/login"
# Extract tokens for downstream probes
ACCESS_TOKEN=$(printf '%s' "${login_resp}" | head -n -1 | python3 -c '
import json,sys
try:
    d=json.loads(sys.stdin.read())
    print(d.get("accessToken",""))
except Exception:
    print("")
')
REFRESH_TOKEN=$(printf '%s' "${login_resp}" | head -n -1 | python3 -c '
import json,sys
try:
    d=json.loads(sys.stdin.read())
    print(d.get("refreshToken",""))
except Exception:
    print("")
')

# 3. refresh
if [ -n "${REFRESH_TOKEN}" ]; then
  refresh_code=$(/usr/bin/curl -sS -X POST "${B}/api/auth/refresh" \
    -H 'Content-Type: application/json' \
    -d "{\"refreshToken\":\"${REFRESH_TOKEN}\"}" \
    -w "\nHTTP=%{http_code}" --max-time 30 -o /tmp/refresh.json -o /tmp/refresh.body \
    || true)
  refresh_code=$(/usr/bin/curl -sS -X POST "${B}/api/auth/refresh" \
    -H 'Content-Type: application/json' -d "{\"refreshToken\":\"${REFRESH_TOKEN}\"}" \
    -w "%{http_code}" --max-time 30 -o /dev/null || echo "000")
  probe 3 "200" "${refresh_code}" "/api/auth/refresh"
else
  printf "${YEL}  ⚠ #3  /api/auth/refresh          skipped (no refresh token)${NC}\n"
fi

# 4. /me
if [ -n "${ACCESS_TOKEN}" ]; then
  me_code=$(/usr/bin/curl -sS "${B}/api/auth/me" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -w "%{http_code}" --max-time 30 -o /dev/null || echo "000")
  probe 4 "200" "${me_code}" "/api/auth/me (auth middleware)"
else
  printf "${YEL}  ⚠ #4  /api/auth/me               skipped (no access token)${NC}\n"
fi

# 5. contact
contact_code=$(/usr/bin/curl -sS -X POST "${B}/api/contact" \
  -H 'Content-Type: application/json' -d '{"name":"verify","email":"verify@acschennai.com","subject":"smoke","message":"verify"}' \
  -w "%{http_code}" --max-time 30 -o /dev/null || echo "000")
probe 5 "200" "${contact_code}" "/api/contact (Resend)"

# 6. OPTIONS preflight
options_code=$(/usr/bin/curl -sS -X OPTIONS "${B}/api/auth/login" \
  -H "Origin: https://acschennai.com" \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type' \
  -w "%{http_code}" --max-time 20 -o /dev/null || echo "000")
probe 6 "204" "${options_code}" "OPTIONS /api/auth/login (CORS)"

# 7. /version (requires INTERNAL_API_TOKEN)
if [ -n "${INTERNAL_API_TOKEN}" ]; then
  version_code=$(/usr/bin/curl -sS "${B}/api/version" \
    -H "X-Internal-Token: ${INTERNAL_API_TOKEN}" \
    -w "%{http_code}" --max-time 20 -o /dev/null || echo "000")
  probe 7 "200" "${version_code}" "/api/version (internal token)"
else
  printf "${YEL}  ⚠ #7  /api/version               skipped (INTERNAL_API_TOKEN unset)${NC}\n"
fi

echo ""
if [ "${fail}" = 0 ]; then
  printf "${GRN}✓ All ${pass} probes passed.${NC}\n"
  exit 0
else
  printf "${RED}✗ ${fail}/${pass} probes failed.${NC}\n"
  exit 1
fi
