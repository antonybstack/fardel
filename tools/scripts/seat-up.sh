#!/usr/bin/env bash
# Start this seat's SpacetimeDB + Vite. Never touches :3000 / db fardel / prod data.
# Usage: ./tools/scripts/seat-up.sh <slug> [--no-publish] [--no-vite]
set -euo pipefail

_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=seat-lib.sh
source "${_script_dir}/seat-lib.sh"

SLUG="${1:-}"
PUBLISH=1
START_VITE=1
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-publish) PUBLISH=0; shift ;;
    --no-vite) START_VITE=0; shift ;;
    *) echo "usage: $0 <slug> [--no-publish] [--no-vite]" >&2; exit 1 ;;
  esac
done

if [[ -z "$SLUG" ]]; then
  echo "usage: $0 <slug> [--no-publish] [--no-vite]" >&2
  exit 1
fi

fardel_fill_env "$SLUG"
fardel_apply_claim
fardel_assert_agent
fardel_assert_layout
if [[ ! -f "$FARDEL_CLAIM_FILE" ]]; then
  echo "FAIL: $FARDEL_SEAT is not claimed. Run ${_script_dir}/seat-claim.sh --slug $FARDEL_SEAT" >&2
  exit 1
fi

PROD_WAS_UP=0
if fardel_prod_ping; then
  PROD_WAS_UP=1
fi

mkdir -p "$FARDEL_DATA_DIR" "$FARDEL_ARTIFACT_DIR" "$FARDEL_PLAYWRIGHT_PROFILE"
fardel_write_env_files

# Homebrew wasm-opt 132 corrupts WASI publishes on this machine (same as lead).
if [[ -e /opt/homebrew/bin/wasm-opt ]]; then
  mv /opt/homebrew/bin/wasm-opt /opt/homebrew/bin/wasm-opt.fardel-disabled 2>/dev/null || true
fi

# ~/.dotnet on this Studio is 8.0 preview-only; global.json wants 8.0.100 stable.
if [[ -x /usr/local/share/dotnet/dotnet ]]; then
  export DOTNET_ROOT=/usr/local/share/dotnet
  export PATH="/usr/local/share/dotnet:${PATH}"
fi

"${_script_dir}/ensure-seat-spacetime.sh" "$FARDEL_SEAT"

if [[ "$PUBLISH" -eq 1 ]]; then
  echo "publish $FARDEL_DB → $FARDEL_SPACETIME_URI (from $FARDEL_WT/server)"
  (
    cd "$FARDEL_WT/server"
    spacetime publish "$FARDEL_DB" -y --env local -s "$FARDEL_SPACETIME_URI"
  )
fi

if [[ "$START_VITE" -eq 1 ]]; then
  if [[ -z "$(fardel_listener_pid "$FARDEL_VITE_PORT")" ]]; then
    fardel_link_node_modules
    local_web="$FARDEL_WT/web"
    if [[ ! -d "$local_web" ]]; then
      echo "FAIL: missing $local_web" >&2
      exit 1
    fi
    echo "vite http://127.0.0.1:${FARDEL_VITE_PORT}"
    (
      cd "$local_web"
      export VITE_FARDEL_URI="$FARDEL_SPACETIME_URI"
      export VITE_FARDEL_DB="$FARDEL_DB"
      export VITE_FARDEL_QA=1
      export FARDEL_VITE_PORT
      nohup ./node_modules/.bin/vite --host 127.0.0.1 --port "$FARDEL_VITE_PORT" --strictPort \
        >>"${FARDEL_DATA_DIR}/vite.log" 2>&1 &
      echo $! >"${FARDEL_DATA_DIR}/vite.pid"
      disown || true
    )
    i=0
    while [[ "$i" -lt 40 ]]; do
      if curl -sf -o /dev/null --max-time 1 "http://127.0.0.1:${FARDEL_VITE_PORT}/"; then
        break
      fi
      i=$((i + 1))
      sleep 0.25
    done
    if ! curl -sf -o /dev/null --max-time 1 "http://127.0.0.1:${FARDEL_VITE_PORT}/"; then
      echo "FAIL: vite did not listen on ${FARDEL_VITE_PORT}" >&2
      tail -40 "${FARDEL_DATA_DIR}/vite.log" >&2 || true
      exit 1
    fi
  else
    local_cmd="$(ps -p "$(fardel_listener_pid "$FARDEL_VITE_PORT")" -o command= 2>/dev/null || true)"
    case "$local_cmd" in
      *vite*) echo "vite already up on $FARDEL_VITE_PORT" ;;
      *)
        echo "FAIL: port $FARDEL_VITE_PORT is in use but is not vite ($local_cmd)" >&2
        exit 1
        ;;
    esac
  fi
fi

FARDEL_STDB_PID="$(fardel_listener_pid "$FARDEL_SPACETIME_PORT" || true)"
FARDEL_VITE_PID="$(fardel_listener_pid "$FARDEL_VITE_PORT" || true)"
if [[ -f "$FARDEL_CLAIM_FILE" ]]; then
  fardel_write_claim
fi

if [[ "$PROD_WAS_UP" -eq 1 ]]; then
  if ! fardel_prod_ping; then
    echo "FAIL: prod SpacetimeDB on :$FARDEL_PROD_STDB_PORT went down during seat-up. Do not continue; inspect without restarting unless you are the human owning prod." >&2
    exit 3
  fi
fi

echo "UP $FARDEL_SEAT"
fardel_print_env
echo "prod     ${FARDEL_PROD_STDB_URI} still $(fardel_prod_ping && echo up || echo DOWN)"
