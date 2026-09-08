#!/bin/sh
# Lead / human Vite on :5173. Agents must use tools/scripts/seat-up.sh (52xx).
export PATH="$HOME/.local/node22/bin:$HOME/.dotnet:$HOME/.local/bin:/opt/homebrew/bin:$PATH"
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/web"
exec ./node_modules/.bin/vite --host 127.0.0.1 --port 5173
