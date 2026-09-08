#!/usr/bin/env bash
# PROD / preview keepalive — the instance tunneled as dev-db.sparkify.dev
# (play.sparkify.dev connects here). Listens on :3000 with the default data dir.
#
# Agents MUST NOT run this. Use ensure-seat-spacetime.sh / seat-up.sh so a
# second instance binds 127.0.0.1:32xx with its own data dir and db name.
#
# Root cause of flakes: `spacetime start &` stayed in the agent shell process
# group and died when that shell was aborted / pkilled. Use a new session.
set -euo pipefail
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"

if [[ -n "${FARDEL_SEAT:-}" && "${FARDEL_SEAT}" != "lead" ]]; then
  echo "REFUSE: FARDEL_SEAT=${FARDEL_SEAT} — agents use tools/scripts/ensure-seat-spacetime.sh (never :3000)." >&2
  exit 2
fi

echo "note: ensure-local-spacetime.sh is the PROD/preview helper (:3000 / db fardel / play.sparkify.dev)"

URI="${FARDEL_SPACETIME_URI:-http://127.0.0.1:3000}"
PING_URL="${URI%/}/v1/ping"
LOG="${FARDEL_SPACETIME_LOG:-$(pwd)/spacetime-start.log}"
PIDFILE="${FARDEL_SPACETIME_PIDFILE:-$(pwd)/.spacetime-standalone.pid}"

# Homebrew wasm-opt (binaryen 132) corrupts WASI publishes on this machine.
if [[ -e /opt/homebrew/bin/wasm-opt ]]; then
  mv /opt/homebrew/bin/wasm-opt /opt/homebrew/bin/wasm-opt.fardel-disabled 2>/dev/null || true
fi

if curl -sf "$PING_URL" >/dev/null; then
  echo "spacetime already up ($PING_URL)"
  exit 0
fi

mkdir -p "$(dirname "$LOG")"
# New session so agent shell teardown cannot kill the DB.
# --non-interactive: fail fast if port busy instead of prompting.
if command -v setsid >/dev/null 2>&1; then
  setsid -f spacetime start --non-interactive >>"$LOG" 2>&1
else
  # macOS often lacks setsid; fall back to nohup + disown in a subshell
  (
    nohup spacetime start --non-interactive >>"$LOG" 2>&1 &
    echo $! >"$PIDFILE"
    disown || true
  ) &
fi

for i in $(seq 1 40); do
  if curl -sf "$PING_URL" >/dev/null; then
    echo "spacetime up ($PING_URL) after ${i}s"
    exit 0
  fi
  sleep 1
done

echo "FAIL: spacetime did not answer $PING_URL" >&2
tail -40 "$LOG" >&2 || true
exit 1
