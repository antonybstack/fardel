#!/usr/bin/env bash
# Down the seat, drop the claim. Keeps data dir unless --wipe-data.
# Usage: ./tools/scripts/seat-release.sh <slug> [--wipe-data] [--remove-worktree]
set -euo pipefail

_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=seat-lib.sh
source "${_script_dir}/seat-lib.sh"

SLUG="${1:-}"
WIPEDATA=0
REMOVE_WT=0
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --wipe-data) WIPEDATA=1; shift ;;
    --remove-worktree) REMOVE_WT=1; shift ;;
    *) echo "usage: $0 <slug> [--wipe-data] [--remove-worktree]" >&2; exit 1 ;;
  esac
done

if [[ -z "$SLUG" ]]; then
  echo "usage: $0 <slug> [--wipe-data] [--remove-worktree]" >&2
  exit 1
fi

fardel_fill_env "$SLUG"
fardel_apply_claim
fardel_assert_agent

"${_script_dir}/seat-down.sh" "$FARDEL_SEAT"

fardel_with_lock
rm -f "$FARDEL_CLAIM_FILE"
if fardel_is_dedicated_worktree; then
  rm -f "${FARDEL_WT}/.env.seat"
  if [[ -f "${FARDEL_WT}/web/.env.local" ]] && grep -q "VITE_FARDEL_DB=${FARDEL_DB}" "${FARDEL_WT}/web/.env.local" 2>/dev/null; then
    rm -f "${FARDEL_WT}/web/.env.local"
  fi
fi
fardel_unlock

if [[ "$REMOVE_WT" -eq 1 && "$FARDEL_WT" != "$FARDEL_REPO_ROOT" && -d "$FARDEL_WT" ]]; then
  git -C "$FARDEL_REPO_ROOT" worktree remove --force "$FARDEL_WT" || rm -rf "$FARDEL_WT"
fi

if [[ "$WIPEDATA" -eq 1 ]]; then
  case "$FARDEL_DATA_DIR" in
    "$FARDEL_PROD_STDB_DATA"|"$FARDEL_PROD_STDB_DATA"/*)
      echo "REFUSE: will not wipe prod data dir" >&2
      exit 2
      ;;
  esac
  rm -rf "$FARDEL_DATA_DIR"
fi

echo "RELEASED $FARDEL_SEAT"
