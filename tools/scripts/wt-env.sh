#!/usr/bin/env bash
# Source with a seat slug to export per-seat Fardel env vars.
# Usage: source tools/scripts/wt-env.sh <slug>
#        . tools/scripts/wt-env.sh <slug>
set -euo pipefail

_slug="${1:-}"
if [[ -z "$_slug" ]]; then
  echo "usage: source tools/scripts/wt-env.sh <slug>" >&2
  return 1 2>/dev/null || exit 1
fi

_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_map="${_script_dir}/fardel-seats.env"
if [[ ! -f "$_map" ]]; then
  echo "FAIL: missing seat map $_map" >&2
  return 1 2>/dev/null || exit 1
fi

_line="$(grep -E "^${_slug}\|" "$_map" | head -n1 || true)"
if [[ -z "$_line" ]]; then
  echo "FAIL: unknown seat slug '$_slug' (see $_map)" >&2
  return 1 2>/dev/null || exit 1
fi

IFS='|' read -r FARDEL_SEAT FARDEL_SPACETIME_PORT FARDEL_VITE_PORT FARDEL_DB FARDEL_WT <<<"$_line"
export FARDEL_SEAT
export FARDEL_SPACETIME_PORT
export FARDEL_VITE_PORT
export FARDEL_DB
export FARDEL_WT
export FARDEL_SPACETIME_URI="http://127.0.0.1:${FARDEL_SPACETIME_PORT}"
export FARDEL_DATA_DIR="${HOME}/.local/share/fardel-wt/${FARDEL_SEAT}"

unset _slug _script_dir _map _line
