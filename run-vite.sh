#!/bin/sh
export PATH="$HOME/.local/node22/bin:$HOME/.dotnet:$HOME/.local/bin:$PATH"
cd /workspace/fardel/web
exec ./node_modules/.bin/vite --host 127.0.0.1 --port 5173
