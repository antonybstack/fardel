#!/usr/bin/env bash
# Show prod health + claimed/free developer and QA seats.
set -euo pipefail

_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=seat-lib.sh
source "${_script_dir}/seat-lib.sh"

fardel_assert_layout

prod="DOWN"
if fardel_prod_ping; then
  prod="up"
fi
lead_vite="down"
if [[ -n "$(fardel_listener_pid "$FARDEL_PROD_VITE_PORT")" ]]; then
  lead_vite="up"
fi

echo "PROD  stdb ${FARDEL_PROD_STDB_URI}  ${prod}   db=${FARDEL_PROD_DB}   data=${FARDEL_PROD_STDB_DATA}"
echo "LEAD  vite 127.0.0.1:${FARDEL_PROD_VITE_PORT}  ${lead_vite}   (not Pages; play.sparkify.dev is Cloudflare)"
echo "TUNNEL dev-db.sparkify.dev → 127.0.0.1:${FARDEL_PROD_STDB_PORT}  (do not add agent ports)"
echo

print_pool() {
  local role="$1" max="$2"
  local i slug claim stdb vite line
  i=1
  while [[ "$i" -le "$max" ]]; do
    slug="${role}-${i}"
    fardel_fill_env "$slug" >/dev/null
    claim="free"
    if [[ -f "$FARDEL_CLAIM_FILE" ]]; then
      claim="CLAIMED"
    fi
    stdb="-"
    vite="-"
    if [[ -n "$(fardel_listener_pid "$FARDEL_SPACETIME_PORT")" ]]; then
      stdb="stdb"
    fi
    if [[ -n "$(fardel_listener_pid "$FARDEL_VITE_PORT")" ]]; then
      vite="vite"
    fi
    line="$slug  ${FARDEL_SPACETIME_PORT}/${FARDEL_VITE_PORT}  ${FARDEL_DB}  $claim"
    if [[ "$claim" == "CLAIMED" || "$stdb" != "-" || "$vite" != "-" ]]; then
      line="$line  ${stdb} ${vite}"
    fi
    echo "$line"
    i=$((i + 1))
  done
}

echo "DEV  (1..$FARDEL_DEV_SLOTS)  stdb $((FARDEL_DEV_STDB_BASE + 1))-$((FARDEL_DEV_STDB_BASE + FARDEL_DEV_SLOTS))  vite $((FARDEL_DEV_VITE_BASE + 1))-$((FARDEL_DEV_VITE_BASE + FARDEL_DEV_SLOTS))"
print_pool dev "$FARDEL_DEV_SLOTS"
echo
echo "QA   (1..$FARDEL_QA_SLOTS)  stdb $((FARDEL_QA_STDB_BASE + 1))-$((FARDEL_QA_STDB_BASE + FARDEL_QA_SLOTS))  vite $((FARDEL_QA_VITE_BASE + 1))-$((FARDEL_QA_VITE_BASE + FARDEL_QA_SLOTS))"
print_pool qa "$FARDEL_QA_SLOTS"
