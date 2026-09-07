#!/usr/bin/env bash
# Start (or reuse) a per-seat SpacetimeDB on the seat's listen port + data dir.
# Usage: ./tools/scripts/ensure-seat-spacetime.sh <slug>
set -euo pipefail
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_slug="${1:-}"
if [[ -z "$_slug" ]]; then
  echo "usage: $0 <slug>" >&2
  exit 1
fi

# shellcheck source=wt-env.sh
source "${_script_dir}/wt-env.sh" "$_slug"

URI="${FARDEL_SPACETIME_URI}"
PING_URL="${URI%/}/v1/ping"
PORT="${FARDEL_SPACETIME_PORT}"
DATA_DIR="${FARDEL_DATA_DIR}"
LOG="${FARDEL_SPACETIME_LOG:-${DATA_DIR}/spacetime-start.log}"

if curl -sf "$PING_URL" >/dev/null; then
  echo "spacetime already up ($PING_URL) seat=${FARDEL_SEAT}"
  exit 0
fi

mkdir -p "$DATA_DIR" "$(dirname "$LOG")"

# New session so agent shell teardown cannot kill the DB.
# --non-interactive: fail fast if port busy instead of prompting.
# Per-seat --listen-addr + --data-dir isolate instances.
if command -v setsid >/dev/null 2>&1; then
  setsid -f spacetime start \
    --listen-addr "127.0.0.1:${PORT}" \
    --data-dir "$DATA_DIR" \
    --non-interactive >>"$LOG" 2>&1
else
  (
    nohup spacetime start \
      --listen-addr "127.0.0.1:${PORT}" \
      --data-dir "$DATA_DIR" \
      --non-interactive >>"$LOG" 2>&1 &
    disown || true
  ) &
fi

for i in $(seq 1 40); do
  if curl -sf "$PING_URL" >/dev/null; then
    echo "spacetime up ($PING_URL) seat=${FARDEL_SEAT} after ${i}s"
    exit 0
  fi
  sleep 1
done

echo "FAIL: spacetime did not answer $PING_URL (seat=${FARDEL_SEAT})" >&2
tail -40 "$LOG" >&2 || true
exit 1
