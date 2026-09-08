#!/bin/sh
# Lead / human Vite on :5173. Agents must use tools/scripts/seat-up.sh (52xx).
export PATH="$HOME/.local/node22/bin:$HOME/.dotnet:$HOME/.local/bin:/opt/homebrew/bin:$PATH"
ROOT="$(cd "$(dirname "$0")" && pwd)"
if [ -n "${FARDEL_SEAT:-}" ] && [ "${FARDEL_SEAT}" != "lead" ]; then
  echo "REFUSE: FARDEL_SEAT=${FARDEL_SEAT} — agents use tools/scripts/seat-up.sh (never :5173)." >&2
  exit 2
fi
case "$ROOT" in
  */wt/*|*/fardel-wt/*|/workspace/wt/*)
    echo "REFUSE: $ROOT is an agent worktree. Use tools/scripts/seat-up.sh (52xx), not :5173." >&2
    exit 2
    ;;
esac
cd "$ROOT/web"
exec ./node_modules/.bin/vite --host 127.0.0.1 --port 5173
