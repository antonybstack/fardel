#!/usr/bin/env bash
# Source with a seat slug to export per-seat Fardel env vars.
# Usage: source tools/scripts/wt-env.sh <slug>
#        . tools/scripts/wt-env.sh <slug>
#
# Slugs: lead (prod/preview — read-only for agents) | dev-N | qa-N
# Aliases: dev1 → dev-1, qa-bugs → qa-1, qa-feel → qa-2
set -euo pipefail

_fardel_wtenv_slug="${1:-}"
if [[ -z "$_fardel_wtenv_slug" ]]; then
  echo "usage: source tools/scripts/wt-env.sh <slug>" >&2
  echo "  slugs: lead | dev-1..dev-12 | qa-1..qa-8" >&2
  unset _fardel_wtenv_slug
  return 1 2>/dev/null || exit 1
fi

_fardel_wtenv_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=seat-lib.sh
source "${_fardel_wtenv_dir}/seat-lib.sh"

if ! fardel_fill_env "$_fardel_wtenv_slug"; then
  unset _fardel_wtenv_slug _fardel_wtenv_dir
  return 1 2>/dev/null || exit 1
fi

unset _fardel_wtenv_slug _fardel_wtenv_dir
# Leave FARDEL_* exported for the caller.
