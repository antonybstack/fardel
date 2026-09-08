#!/usr/bin/env bash
# Node/Playwright IdleSmoke (#321). Invoked by run-smoke-matrix.sh via run.sh
# because this dir has no csproj. Seat Vite + seat db only — never :3000 / fardel.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ -z "${FARDEL_VITE_PORT:-}" || -z "${FARDEL_DB:-}" || -z "${FARDEL_SPACETIME_URI:-}" ]]; then
  slug=""
  case "$root" in
    */wt/dev-*|*/wt/qa-*) slug="$(basename "$root")" ;;
  esac
  if [[ -n "$slug" && -f "$root/tools/scripts/wt-env.sh" ]]; then
    # shellcheck disable=SC1091
    source "$root/tools/scripts/wt-env.sh" "$slug"
  fi
fi

if [[ -z "${FARDEL_VITE_PORT:-}" || -z "${FARDEL_DB:-}" || -z "${FARDEL_SPACETIME_URI:-}" ]]; then
  echo "FAIL: IdleSmoke needs FARDEL_VITE_PORT / FARDEL_DB / FARDEL_SPACETIME_URI (source tools/scripts/wt-env.sh <slug> + seat-up). Do not use lead :3000 / db fardel." >&2
  exit 2
fi

if [[ "$FARDEL_VITE_PORT" == "5173" || "$FARDEL_DB" == "fardel" || "$FARDEL_SPACETIME_URI" == *":3000"* ]]; then
  echo "FAIL: IdleSmoke refusing prod/lead vite=$FARDEL_VITE_PORT db=$FARDEL_DB uri=$FARDEL_SPACETIME_URI" >&2
  exit 2
fi

export IDLE_SMOKE_OUT="${IDLE_SMOKE_OUT:-/tmp/fardel-idle-smoke.png}"
exec node "$root/tools/qa/idle-smoke.mjs" --out "$IDLE_SMOKE_OUT"
