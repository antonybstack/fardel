#!/usr/bin/env bash
# Keep local SpacetimeDB alive across agent shell aborts.
# Root cause of flakes: `spacetime start &` stayed in the agent shell process
# group and died when that shell was aborted / pkilled. Use a new session.
set -euo pipefail
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

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
