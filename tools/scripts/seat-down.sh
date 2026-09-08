#!/usr/bin/env bash
# Stop this seat's Vite + SpacetimeDB. Never kills :3000 / :5173 / prod data dir.
# Usage: ./tools/scripts/seat-down.sh <slug>
set -euo pipefail

_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=seat-lib.sh
source "${_script_dir}/seat-lib.sh"

SLUG="${1:-}"
if [[ -z "$SLUG" ]]; then
  echo "usage: $0 <slug>" >&2
  exit 1
fi

fardel_fill_env "$SLUG"
fardel_apply_claim
fardel_assert_agent

PROD_WAS_UP=0
if fardel_prod_ping; then
  PROD_WAS_UP=1
fi

fardel_safe_kill_port "$FARDEL_VITE_PORT" "vite"
fardel_safe_kill_port "$FARDEL_SPACETIME_PORT" "spacetime"

if [[ -f "${FARDEL_DATA_DIR}/vite.pid" ]]; then
  rm -f "${FARDEL_DATA_DIR}/vite.pid"
fi

if [[ "$PROD_WAS_UP" -eq 1 ]] && ! fardel_prod_ping; then
  echo "FAIL: prod SpacetimeDB on :$FARDEL_PROD_STDB_PORT went down during seat-down." >&2
  exit 3
fi

echo "DOWN $FARDEL_SEAT (claim kept — seat-release.sh to free the slot)"
echo "prod $(fardel_prod_ping && echo up || echo DOWN)"
