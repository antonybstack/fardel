#!/usr/bin/env bash
# Upload a VE PNG to Cloudflare R2 bucket fardel-ve and print the public URL.
# Usage: tools/scripts/ve-upload.sh <local.png> <object-key>
# Example: tools/scripts/ve-upload.sh /tmp/chat.png 98/chat-read.png
set -euo pipefail
LOCAL=${1:?local png path}
KEY=${2:?object key e.g. 98/chat-read.png}
ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID:-6ea5db25020bce6cbefd6c1cc999bef3}
BUCKET=${FARDEL_VE_BUCKET:-fardel-ve}
PUBLIC_BASE=${FARDEL_VE_PUBLIC_BASE:-https://ve.sparkify.dev}

if [[ ! -f "$LOCAL" ]]; then
  echo "missing file: $LOCAL" >&2
  exit 1
fi
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "CLOUDFLARE_API_TOKEN not set on this box — ping Lead (do NOT ask Antony to sign into GitHub)." >&2
  exit 2
fi

# Prefer wrangler when available
if command -v npx >/dev/null 2>&1; then
  npx --yes wrangler@4 r2 object put "${BUCKET}/${KEY}" --file="$LOCAL" --content-type=image/png --remote 2>/dev/null \
    || npx --yes wrangler@4 r2 object put "${BUCKET}/${KEY}" --file="$LOCAL" --content-type=image/png
else
  echo "npx/wrangler required" >&2
  exit 3
fi

URL="${PUBLIC_BASE}/${KEY}"
echo "$URL"
