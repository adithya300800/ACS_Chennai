#!/usr/bin/env bash
# db-host-guard.sh — refuse any DB write whose host is production Supabase.
# Source this script (or call it) before running prisma migrate / db push / any
# node script that talks to the DB. Exits non-zero if the URL host is one of
# the production Supabase project hosts.
#
# Usage:
#   source scripts/db-host-guard.sh                 # exports DB_HOST_OK=1 on pass
#   ./scripts/db-host-guard.sh "$DATABASE_URL"      # exits 0 / 1 with message
#
# The script is INTENTIONALLY chatty — every reject prints the offending host
# to stderr so the operator sees it.

set -u

PROD_HOSTS_REGEX='(\.supabase\.(co|io)|tqmmspqvqtajbijbbsii|db\.tqmmspqvqtajbijbbsii)'

# Hosts we DO allow for local/throwaway work.
ALLOWED_HOSTS_REGEX='^(localhost|127\.0\.0\.1|postgres|::1)$'

check_url() {
  local url="${1:-}"
  if [ -z "$url" ]; then
    echo "[db-host-guard] DATABASE_URL is empty" >&2
    return 1
  fi
  # Strip scheme and optional credentials: postgres://user:pw@host:port/db?...
  local host
  host="$(printf '%s' "$url" | sed -E 's#^[a-zA-Z0-9+.-]+://([^@]+@)?([^/?]+).*#\2#')"
  if [ -z "$host" ] || [ "$host" = "$url" ]; then
    echo "[db-host-guard] could not parse host from DATABASE_URL" >&2
    return 1
  fi
  # Strip port for matching.
  local host_no_port="${host%%:*}"
  if printf '%s' "$host_no_port" | grep -qE "$PROD_HOSTS_REGEX"; then
    echo "[db-host-guard] REFUSED: host '$host_no_port' matches production Supabase" >&2
    return 1
  fi
  if ! printf '%s' "$host_no_port" | grep -qE "$ALLOWED_HOSTS_REGEX"; then
    echo "[db-host-guard] REFUSED: host '$host_no_port' is not in the allowlist (localhost|127.0.0.1|postgres|::1)" >&2
    return 1
  fi
  echo "[db-host-guard] OK: host '$host_no_port' is local/throwaway"
  return 0
}

if [ "${1:-}" != "" ]; then
  check_url "$1"
  exit $?
fi

# No arg: check the env var.
if check_url "${DATABASE_URL:-}"; then
  export DB_HOST_OK=1
fi
