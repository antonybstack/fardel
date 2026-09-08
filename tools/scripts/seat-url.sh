#!/usr/bin/env bash
# Print the isolated client URL for a seat (query params win even without .env.local).
set -euo pipefail
_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=seat-lib.sh
source "${_script_dir}/seat-lib.sh"
SLUG="${1:-}"
if [[ -z "$SLUG" ]]; then
  echo "usage: $0 <slug>" >&2
  exit 1
fi
fardel_fill_env "$SLUG"
fardel_assert_agent
printf '%s\n' "$FARDEL_CLIENT_URL"
