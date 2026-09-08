#!/usr/bin/env bash
# Prod-isolation + allocator smoke. Does not publish, does not kill :3000.
set -euo pipefail
_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=seat-lib.sh
source "${_script_dir}/seat-lib.sh"

fail() { echo "SELFTEST FAIL: $*" >&2; exit 1; }

fardel_assert_layout || fail "layout"

if ! fardel_prod_ping; then
  fail "prod SpacetimeDB :$FARDEL_PROD_STDB_PORT is down — not starting a selftest that cannot check isolation"
fi
PROD_PID="$(fardel_listener_pid "$FARDEL_PROD_STDB_PORT" || true)"
[[ -n "$PROD_PID" ]] || fail "no pid on prod port"

echo "== refuse lead / prod =="
if "${_script_dir}/ensure-seat-spacetime.sh" lead 2>/tmp/fardel-selftest-lead.err; then
  fail "ensure-seat-spacetime.sh lead should refuse"
fi
grep -q REFUSE /tmp/fardel-selftest-lead.err || fail "lead refuse missing REFUSE"

if "${_script_dir}/seat-url.sh" lead >/dev/null 2>/tmp/fardel-selftest-url.err; then
  fail "seat-url.sh lead should refuse"
fi

echo "== claim two seats (no worktree — do not touch lead checkout) =="
DEV_SLUG="$("${_script_dir}/seat-claim.sh" --role dev --no-worktree | awk '/^CLAIMED/{print $2}')"
QA_SLUG="$("${_script_dir}/seat-claim.sh" --role qa --no-worktree | awk '/^CLAIMED/{print $2}')"
[[ -n "$DEV_SLUG" && -n "$QA_SLUG" ]] || fail "claim slugs"
[[ "$DEV_SLUG" != "$QA_SLUG" ]] || fail "same slug twice"

fardel_fill_env "$DEV_SLUG"
DEV_PORT="$FARDEL_SPACETIME_PORT"
DEV_DB="$FARDEL_DB"
fardel_fill_env "$QA_SLUG"
QA_PORT="$FARDEL_SPACETIME_PORT"
QA_DB="$FARDEL_DB"

[[ "$DEV_PORT" != "$FARDEL_PROD_STDB_PORT" ]] || fail "dev port is prod"
[[ "$QA_PORT" != "$FARDEL_PROD_STDB_PORT" ]] || fail "qa port is prod"
[[ "$DEV_PORT" != "$QA_PORT" ]] || fail "dev/qa share stdb port"
[[ "$DEV_DB" != "$FARDEL_PROD_DB" && "$QA_DB" != "$FARDEL_PROD_DB" ]] || fail "prod db name leaked"
[[ "$DEV_DB" != "$QA_DB" ]] || fail "dev/qa share db name"

echo "== start spacetime only (no vite, no publish) =="
"${_script_dir}/seat-up.sh" "$DEV_SLUG" --no-publish --no-vite
"${_script_dir}/seat-up.sh" "$QA_SLUG" --no-publish --no-vite

curl -sf "${FARDEL_PROD_STDB_URI%/}/v1/ping" >/dev/null || fail "prod ping died after seat-up"
curl -sf "http://127.0.0.1:${DEV_PORT}/v1/ping" >/dev/null || fail "dev stdb ping"
curl -sf "http://127.0.0.1:${QA_PORT}/v1/ping" >/dev/null || fail "qa stdb ping"

AFTER_PID="$(fardel_listener_pid "$FARDEL_PROD_STDB_PORT" || true)"
[[ "$AFTER_PID" == "$PROD_PID" ]] || fail "prod spacetime pid changed ($PROD_PID -> $AFTER_PID)"

echo "== down seats; prod must stay =="
"${_script_dir}/seat-down.sh" "$DEV_SLUG"
"${_script_dir}/seat-down.sh" "$QA_SLUG"
curl -sf "${FARDEL_PROD_STDB_URI%/}/v1/ping" >/dev/null || fail "prod ping died after seat-down"
if curl -sf --max-time 1 "http://127.0.0.1:${DEV_PORT}/v1/ping" >/dev/null; then
  fail "dev stdb still up after down"
fi
if curl -sf --max-time 1 "http://127.0.0.1:${QA_PORT}/v1/ping" >/dev/null; then
  fail "qa stdb still up after down"
fi

"${_script_dir}/seat-release.sh" "$DEV_SLUG"
"${_script_dir}/seat-release.sh" "$QA_SLUG"

echo "SELFTEST OK  prod pid=$PROD_PID still up  claimed/released $DEV_SLUG + $QA_SLUG"
