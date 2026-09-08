#!/usr/bin/env bash
# Claim the next free developer or QA seat (worktree + env). Does not start processes.
# Usage:
#   ./tools/scripts/seat-claim.sh --role dev|qa
#   ./tools/scripts/seat-claim.sh --slug qa-3
#   ./tools/scripts/seat-claim.sh --role qa --no-worktree
set -euo pipefail

_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=seat-lib.sh
source "${_script_dir}/seat-lib.sh"

fardel_assert_layout

ROLE=""
SLUG=""
MAKE_WT=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) ROLE="${2:-}"; shift 2 ;;
    --slug) SLUG="${2:-}"; shift 2 ;;
    --no-worktree) MAKE_WT=0; shift ;;
    -h|--help)
      sed -n '2,7p' "$0"
      exit 0
      ;;
    *)
      echo "usage: $0 --role dev|qa [--no-worktree] | --slug <slug>" >&2
      exit 1
      ;;
  esac
done

if [[ -n "$SLUG" && -n "$ROLE" ]]; then
  echo "FAIL: pass --role or --slug, not both" >&2
  exit 1
fi
if [[ -z "$SLUG" && -z "$ROLE" ]]; then
  echo "FAIL: need --role dev|qa or --slug" >&2
  exit 1
fi

fardel_with_lock
mkdir -p "$FARDEL_CLAIM_ROOT"

if [[ -n "$SLUG" ]]; then
  fardel_fill_env "$SLUG"
else
  SLOT="$(fardel_next_free_slot "$ROLE")"
  fardel_fill_env "${ROLE}-${SLOT}"
fi

fardel_assert_agent

if [[ -f "$FARDEL_CLAIM_FILE" ]]; then
  echo "FAIL: $FARDEL_SEAT already claimed ($(cat "$FARDEL_CLAIM_FILE" | head -n 6))" >&2
  fardel_unlock
  exit 1
fi

if [[ "$MAKE_WT" -ne 1 ]]; then
  FARDEL_WT="$FARDEL_REPO_ROOT"
  echo "note: --no-worktree uses $FARDEL_WT (no .env.local; use ?db=&module=)"
fi

fardel_write_claim
fardel_unlock

if [[ "$MAKE_WT" -eq 1 ]]; then
  if ! fardel_ensure_worktree; then
    rm -f "$FARDEL_CLAIM_FILE"
    exit 1
  fi
  fardel_link_node_modules
  fardel_write_env_files
fi

echo "CLAIMED $FARDEL_SEAT"
fardel_print_env
echo "next     ${_script_dir}/seat-up.sh $FARDEL_SEAT"
echo "source   source ${_script_dir}/wt-env.sh $FARDEL_SEAT"
