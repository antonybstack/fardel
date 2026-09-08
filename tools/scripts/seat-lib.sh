# shellcheck shell=bash
# Shared seat helpers. Source only — never execute.
# Compatible with macOS /bin/bash 3.2.

_FARDEL_SEAT_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fardel_load_conf() {
  # shellcheck source=seats.conf
  source "${_FARDEL_SEAT_LIB_DIR}/seats.conf"
  if [[ -f "${_FARDEL_SEAT_LIB_DIR}/seats.local.conf" ]]; then
    # shellcheck disable=SC1091
    source "${_FARDEL_SEAT_LIB_DIR}/seats.local.conf"
  fi
  FARDEL_PROD_STDB_DATA="${FARDEL_PROD_STDB_DATA:-$FARDEL_PROD_STDB_DATA_DEFAULT}"
  # Checkout that contains these scripts (may itself be an agent worktree).
  FARDEL_REPO_ROOT="${FARDEL_REPO_ROOT:-$(cd "${_FARDEL_SEAT_LIB_DIR}/../.." && pwd)}"
  # Primary/release clone — first entry from `git worktree list` (never nest).
  if [[ -z "${FARDEL_LEAD_ROOT:-}" ]]; then
    FARDEL_LEAD_ROOT="$(git -C "$FARDEL_REPO_ROOT" worktree list --porcelain 2>/dev/null | awk '/^worktree / { print $2; exit }')"
    if [[ -z "$FARDEL_LEAD_ROOT" ]]; then
      FARDEL_LEAD_ROOT="$FARDEL_REPO_ROOT"
    fi
  fi
  # Absolute wt root. Must NOT be parent(this checkout)/wt or a worktree at
  # ~/dev/wt/dev-1 computes ~/dev/wt/wt and fights the release clone.
  if [[ -z "${FARDEL_WT_ROOT:-}" ]]; then
    if [[ -d /workspace/wt ]]; then
      FARDEL_WT_ROOT="/workspace/wt"
    else
      FARDEL_WT_ROOT="${HOME}/dev/wt"
    fi
  fi
  FARDEL_CLAIM_ROOT="${FARDEL_CLAIM_ROOT:-$HOME/.local/share/fardel-seats/claims}"
  FARDEL_LOCK_DIR="${FARDEL_LOCK_DIR:-$HOME/.local/share/fardel-seats/lock}"
  FARDEL_ARTIFACT_ROOT="${FARDEL_ARTIFACT_ROOT:-$HOME/dev/fardel-artifacts}"
  FARDEL_PROD_STDB_URI="${FARDEL_PROD_STDB_URI:-http://127.0.0.1:${FARDEL_PROD_STDB_PORT}}"
}

fardel_load_conf

fardel_fail() {
  echo "FAIL: $*" >&2
  return 1
}

fardel_normalize_slug() {
  local raw="${1:-}"
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  case "$raw" in
    "") echo ""; return 1 ;;
    lead|prod|preview) echo "lead"; return 0 ;;
    qa-bugs) echo "qa-1"; return 0 ;;
    qa-feel) echo "qa-2"; return 0 ;;
    dev[0-9]|dev[0-9][0-9]) echo "dev-${raw#dev}"; return 0 ;;
    qa[0-9]|qa[0-9][0-9]) echo "qa-${raw#qa}"; return 0 ;;
    *) echo "$raw"; return 0 ;;
  esac
}

# Sets FARDEL_PARSE_ROLE / FARDEL_PARSE_SLOT from a normalized slug.
fardel_parse_slug() {
  local slug="$1"
  FARDEL_PARSE_ROLE=""
  FARDEL_PARSE_SLOT=""
  case "$slug" in
    lead)
      FARDEL_PARSE_ROLE="lead"
      FARDEL_PARSE_SLOT=0
      return 0
      ;;
    dev-*)
      FARDEL_PARSE_ROLE="dev"
      FARDEL_PARSE_SLOT="${slug#dev-}"
      ;;
    qa-*)
      FARDEL_PARSE_ROLE="qa"
      FARDEL_PARSE_SLOT="${slug#qa-}"
      ;;
    *)
      return 1
      ;;
  esac
  case "$FARDEL_PARSE_SLOT" in
    ''|*[!0-9]*) return 1 ;;
  esac
  if [[ "$FARDEL_PARSE_SLOT" -lt 1 ]]; then
    return 1
  fi
  return 0
}

fardel_slot_in_range() {
  local role="$1" slot="$2"
  case "$role" in
    dev) [[ "$slot" -ge 1 && "$slot" -le "$FARDEL_DEV_SLOTS" ]] ;;
    qa)  [[ "$slot" -ge 1 && "$slot" -le "$FARDEL_QA_SLOTS" ]] ;;
    lead) return 0 ;;
    *) return 1 ;;
  esac
}

# Fill FARDEL_* from a (possibly raw) slug. Does not claim.
fardel_fill_env() {
  local raw="${1:-}"
  local slug
  slug="$(fardel_normalize_slug "$raw")" || return 1
  fardel_parse_slug "$slug" || {
    echo "FAIL: unknown seat slug '$raw' (want lead | dev-N | qa-N)" >&2
    return 1
  }
  fardel_slot_in_range "$FARDEL_PARSE_ROLE" "$FARDEL_PARSE_SLOT" || {
    echo "FAIL: slug $slug out of pool (dev 1..$FARDEL_DEV_SLOTS, qa 1..$FARDEL_QA_SLOTS)" >&2
    return 1
  }

  export FARDEL_SEAT="$slug"
  export FARDEL_SEAT_ROLE="$FARDEL_PARSE_ROLE"
  export FARDEL_SEAT_SLOT="$FARDEL_PARSE_SLOT"

  if [[ "$FARDEL_SEAT_ROLE" == "lead" ]]; then
    export FARDEL_SEAT_IS_PROD=1
    export FARDEL_SPACETIME_PORT="$FARDEL_PROD_STDB_PORT"
    export FARDEL_VITE_PORT="$FARDEL_PROD_VITE_PORT"
    export FARDEL_CDP_PORT=""
    export FARDEL_DB="$FARDEL_PROD_DB"
    export FARDEL_SPACETIME_URI="$FARDEL_PROD_STDB_URI"
    export FARDEL_DATA_DIR="$FARDEL_PROD_STDB_DATA"
    export FARDEL_WT="$FARDEL_REPO_ROOT"
    export FARDEL_CLAIM_FILE=""
    export FARDEL_ARTIFACT_DIR="$FARDEL_ARTIFACT_ROOT/lead"
    export FARDEL_PLAYWRIGHT_PROFILE="$HOME/.local/share/fardel-seats/profiles/lead"
    return 0
  fi

  export FARDEL_SEAT_IS_PROD=0
  local stdb_base vite_base cdp_base
  if [[ "$FARDEL_SEAT_ROLE" == "dev" ]]; then
    stdb_base="$FARDEL_DEV_STDB_BASE"
    vite_base="$FARDEL_DEV_VITE_BASE"
    cdp_base="$FARDEL_DEV_CDP_BASE"
  else
    stdb_base="$FARDEL_QA_STDB_BASE"
    vite_base="$FARDEL_QA_VITE_BASE"
    cdp_base="$FARDEL_QA_CDP_BASE"
  fi

  export FARDEL_SPACETIME_PORT=$((stdb_base + FARDEL_SEAT_SLOT))
  export FARDEL_VITE_PORT=$((vite_base + FARDEL_SEAT_SLOT))
  export FARDEL_CDP_PORT=$((cdp_base + FARDEL_SEAT_SLOT))
  export FARDEL_DB="fardel-${slug}"
  export FARDEL_SPACETIME_URI="http://127.0.0.1:${FARDEL_SPACETIME_PORT}"
  export FARDEL_DATA_DIR="${HOME}/.local/share/fardel-wt/${slug}"
  export FARDEL_WT="${FARDEL_WT_ROOT}/${slug}"
  export FARDEL_CLAIM_FILE="${FARDEL_CLAIM_ROOT}/${slug}"
  export FARDEL_ARTIFACT_DIR="${FARDEL_ARTIFACT_ROOT}/${slug}"
  export FARDEL_PLAYWRIGHT_PROFILE="${HOME}/.local/share/fardel-seats/profiles/${slug}"
  export FARDEL_CLIENT_URL="http://127.0.0.1:${FARDEL_VITE_PORT}/?db=${FARDEL_SPACETIME_URI}&module=${FARDEL_DB}"
}

# Refuse anything that could touch play.sparkify.dev / dev-db.sparkify.dev.
fardel_assert_agent() {
  if [[ "${FARDEL_SEAT_IS_PROD:-1}" == "1" || "${FARDEL_SEAT_ROLE:-}" == "lead" ]]; then
    echo "REFUSE: seat '${FARDEL_SEAT:-?}' is the prod/preview surface (port ${FARDEL_PROD_STDB_PORT}, db ${FARDEL_PROD_DB}, play.sparkify.dev → dev-db.sparkify.dev). Use ensure-local-spacetime.sh only as a human on lead." >&2
    return 2
  fi
  if [[ "${FARDEL_SPACETIME_PORT:-}" == "$FARDEL_PROD_STDB_PORT" ]]; then
    echo "REFUSE: spacetime port ${FARDEL_SPACETIME_PORT} is reserved for prod." >&2
    return 2
  fi
  if [[ "${FARDEL_VITE_PORT:-}" == "$FARDEL_PROD_VITE_PORT" ]]; then
    echo "REFUSE: vite port ${FARDEL_VITE_PORT} is reserved for lead." >&2
    return 2
  fi
  if [[ "${FARDEL_DB:-}" == "$FARDEL_PROD_DB" ]]; then
    echo "REFUSE: database name '${FARDEL_DB}' is reserved for prod/preview." >&2
    return 2
  fi
  case "${FARDEL_SPACETIME_URI:-}" in
    *":${FARDEL_PROD_STDB_PORT}"*|*"localhost:${FARDEL_PROD_STDB_PORT}"*|*"dev-db.sparkify.dev"*)
      echo "REFUSE: URI ${FARDEL_SPACETIME_URI} targets prod/preview." >&2
      return 2
      ;;
  esac
  local prod_data agent_data
  prod_data="$(cd "$FARDEL_PROD_STDB_DATA" 2>/dev/null && pwd)" || prod_data="$FARDEL_PROD_STDB_DATA"
  agent_data="${FARDEL_DATA_DIR:-}"
  if [[ -z "$agent_data" ]]; then
    echo "REFUSE: missing FARDEL_DATA_DIR" >&2
    return 2
  fi
  if [[ "$agent_data" == "$prod_data" || "$agent_data" == "$FARDEL_PROD_STDB_DATA" ]]; then
    echo "REFUSE: data dir $agent_data is the prod SpacetimeDB disk." >&2
    return 2
  fi
  case "$agent_data" in
    "$prod_data"/*|"$FARDEL_PROD_STDB_DATA"/*)
      echo "REFUSE: data dir $agent_data sits under prod SpacetimeDB disk." >&2
      return 2
      ;;
  esac
  return 0
}

fardel_prod_ping() {
  curl -sf -o /dev/null --max-time 2 "${FARDEL_PROD_STDB_URI%/}/v1/ping"
}

fardel_seat_ping() {
  curl -sf -o /dev/null --max-time 2 "${FARDEL_SPACETIME_URI%/}/v1/ping"
}

fardel_listener_pid() {
  local port="$1"
  lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -n1 || true
}

fardel_assert_layout() {
  if [[ $((FARDEL_DEV_STDB_BASE + FARDEL_DEV_SLOTS)) -ge $FARDEL_QA_STDB_BASE ]]; then
    echo "FAIL: DEV spacetime ports overlap QA (raise FARDEL_QA_STDB_BASE or cut FARDEL_DEV_SLOTS)" >&2
    return 1
  fi
  if [[ $((FARDEL_DEV_VITE_BASE + FARDEL_DEV_SLOTS)) -ge $FARDEL_QA_VITE_BASE ]]; then
    echo "FAIL: DEV vite ports overlap QA" >&2
    return 1
  fi
  local p
  for p in \
    $((FARDEL_DEV_STDB_BASE + 1)) \
    $((FARDEL_QA_STDB_BASE + 1)) \
    $((FARDEL_DEV_VITE_BASE + 1)) \
    $((FARDEL_QA_VITE_BASE + 1)); do
    if [[ "$p" -eq "$FARDEL_PROD_STDB_PORT" || "$p" -eq "$FARDEL_PROD_VITE_PORT" ]]; then
      echo "FAIL: agent pool includes prod port $p" >&2
      return 1
    fi
  done
}

fardel_with_lock() {
  local i now mtime
  mkdir -p "$(dirname "$FARDEL_LOCK_DIR")"
  i=0
  while ! mkdir "$FARDEL_LOCK_DIR" 2>/dev/null; do
    now="$(date +%s)"
    mtime="$(stat -f %m "$FARDEL_LOCK_DIR" 2>/dev/null || stat -c %Y "$FARDEL_LOCK_DIR" 2>/dev/null || echo 0)"
    if [[ "$mtime" -gt 0 && $((now - mtime)) -gt 120 ]]; then
      rmdir "$FARDEL_LOCK_DIR" 2>/dev/null || true
      continue
    fi
    i=$((i + 1))
    if [[ "$i" -gt 300 ]]; then
      echo "FAIL: timed out waiting for $FARDEL_LOCK_DIR" >&2
      return 1
    fi
    sleep 0.1
  done
  # shellcheck disable=SC2064
  trap 'rmdir "$FARDEL_LOCK_DIR" 2>/dev/null || true' EXIT INT TERM
}

fardel_unlock() {
  rmdir "$FARDEL_LOCK_DIR" 2>/dev/null || true
  trap - EXIT INT TERM
}

# After fill_env, honor a claimed worktree (e.g. --no-worktree stored repo root).
fardel_apply_claim() {
  if [[ -z "${FARDEL_CLAIM_FILE:-}" || ! -f "$FARDEL_CLAIM_FILE" ]]; then
    return 0
  fi
  local line key val
  while IFS= read -r line; do
    key="${line%%=*}"
    val="${line#*=}"
    case "$key" in
      worktree) export FARDEL_WT="$val" ;;
      stdb_pid) FARDEL_STDB_PID="$val" ;;
      vite_pid) FARDEL_VITE_PID="$val" ;;
    esac
  done <"$FARDEL_CLAIM_FILE"
}

fardel_write_claim() {
  mkdir -p "$FARDEL_CLAIM_ROOT"
  cat >"$FARDEL_CLAIM_FILE" <<EOF
slug=$FARDEL_SEAT
role=$FARDEL_SEAT_ROLE
slot=$FARDEL_SEAT_SLOT
claimed_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
claimed_by=${USER:-unknown}
worktree=$FARDEL_WT
spacetime_port=$FARDEL_SPACETIME_PORT
vite_port=$FARDEL_VITE_PORT
cdp_port=$FARDEL_CDP_PORT
db=$FARDEL_DB
uri=$FARDEL_SPACETIME_URI
data_dir=$FARDEL_DATA_DIR
client_url=$FARDEL_CLIENT_URL
artifact_dir=$FARDEL_ARTIFACT_DIR
playwright_profile=$FARDEL_PLAYWRIGHT_PROFILE
stdb_pid=${FARDEL_STDB_PID:-}
vite_pid=${FARDEL_VITE_PID:-}
EOF
}

# True only for $FARDEL_WT_ROOT/<slug> — never the lead clone or --no-worktree cwd.
fardel_is_dedicated_worktree() {
  [[ -n "${FARDEL_SEAT:-}" && -n "${FARDEL_WT_ROOT:-}" && -n "${FARDEL_WT:-}" && "$FARDEL_WT" == "${FARDEL_WT_ROOT}/${FARDEL_SEAT}" ]]
}

fardel_write_env_files() {
  mkdir -p "$FARDEL_DATA_DIR" "$FARDEL_ARTIFACT_DIR" "$FARDEL_PLAYWRIGHT_PROFILE"
  if [[ -z "${FARDEL_WT:-}" || ! -d "${FARDEL_WT}" ]]; then
    return 0
  fi
  if ! fardel_is_dedicated_worktree; then
    echo "note: skipping .env.local (not dedicated worktree $FARDEL_WT_ROOT/$FARDEL_SEAT; use ?db=&module=)"
    return 0
  fi
  cat >"${FARDEL_WT}/.env.seat" <<EOF
FARDEL_SEAT=$FARDEL_SEAT
FARDEL_SEAT_ROLE=$FARDEL_SEAT_ROLE
FARDEL_SPACETIME_PORT=$FARDEL_SPACETIME_PORT
FARDEL_VITE_PORT=$FARDEL_VITE_PORT
FARDEL_CDP_PORT=$FARDEL_CDP_PORT
FARDEL_DB=$FARDEL_DB
FARDEL_SPACETIME_URI=$FARDEL_SPACETIME_URI
FARDEL_DATA_DIR=$FARDEL_DATA_DIR
FARDEL_WT=$FARDEL_WT
FARDEL_CLIENT_URL=$FARDEL_CLIENT_URL
FARDEL_ARTIFACT_DIR=$FARDEL_ARTIFACT_DIR
FARDEL_PLAYWRIGHT_PROFILE=$FARDEL_PLAYWRIGHT_PROFILE
EOF
  mkdir -p "${FARDEL_WT}/web"
  cat >"${FARDEL_WT}/web/.env.local" <<EOF
VITE_FARDEL_URI=$FARDEL_SPACETIME_URI
VITE_FARDEL_DB=$FARDEL_DB
VITE_FARDEL_QA=1
EOF
}

fardel_ensure_worktree() {
  mkdir -p "$FARDEL_WT_ROOT"
  if [[ -d "$FARDEL_WT/.git" || -f "$FARDEL_WT/.git" ]]; then
    echo "worktree exists $FARDEL_WT"
    return 0
  fi
  if [[ -d "$FARDEL_WT" ]]; then
    echo "FAIL: $FARDEL_WT exists but is not a git worktree" >&2
    return 1
  fi
  local branch="seats/${FARDEL_SEAT}"
  local git_base="$FARDEL_LEAD_ROOT"
  if [[ ! -d "$git_base/.git" && ! -f "$git_base/.git" ]]; then
    git_base="$FARDEL_REPO_ROOT"
  fi
  git -C "$git_base" fetch origin develop 2>/dev/null || true
  if git -C "$git_base" show-ref --verify --quiet "refs/heads/${branch}"; then
    git -C "$git_base" worktree add "$FARDEL_WT" "$branch"
  elif git -C "$git_base" rev-parse --verify --quiet origin/develop >/dev/null; then
    git -C "$git_base" worktree add -b "$branch" "$FARDEL_WT" origin/develop
  else
    git -C "$git_base" worktree add -b "$branch" "$FARDEL_WT"
  fi
}

fardel_link_node_modules() {
  local main_nm="${FARDEL_LEAD_ROOT}/web/node_modules"
  local wt_nm="${FARDEL_WT}/web/node_modules"
  if [[ ! -d "$FARDEL_WT/web" ]]; then
    return 0
  fi
  if [[ -e "$wt_nm" ]]; then
    return 0
  fi
  if [[ -d "$main_nm" ]]; then
    ln -s "$main_nm" "$wt_nm"
    echo "linked $wt_nm -> $main_nm"
  fi
}

# Kill the process listening on $1 only if it is this seat (never prod).
# `spacetime start` prepends the default prod --data-dir on the command line
# even when we pass a second --data-dir, so we key off listen-addr + our dir.
fardel_safe_kill_port() {
  local port="$1"
  local why="${2:-seat}"
  if [[ "$port" == "$FARDEL_PROD_STDB_PORT" || "$port" == "$FARDEL_PROD_VITE_PORT" ]]; then
    echo "REFUSE: will not kill listener on reserved port $port" >&2
    return 2
  fi
  local pid
  pid="$(fardel_listener_pid "$port")"
  if [[ -z "$pid" ]]; then
    echo "no listener on $port ($why)"
    return 0
  fi
  local cmd
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$why" in
    spacetime)
      case "$cmd" in
        *"--listen-addr 127.0.0.1:${port}"*) ;;
        *)
          echo "REFUSE: pid $pid on $port is not this seat's spacetime ($cmd)" >&2
          return 2
          ;;
      esac
      case "$cmd" in
        *"--data-dir ${FARDEL_DATA_DIR}"*) ;;
        *)
          echo "REFUSE: pid $pid data-dir is not ${FARDEL_DATA_DIR}" >&2
          return 2
          ;;
      esac
      ;;
    vite)
      case "$cmd" in
        *vite*) ;;
        *)
          echo "REFUSE: pid $pid on $port is not vite ($cmd)" >&2
          return 2
          ;;
      esac
      ;;
  esac
  echo "stop $why pid=$pid port=$port"
  kill "$pid" 2>/dev/null || true
  sleep 0.3
  local still
  still="$(fardel_listener_pid "$port")"
  if [[ -n "$still" ]]; then
    kill -9 "$still" 2>/dev/null || true
  fi
}

fardel_print_env() {
  cat <<EOF
seat     $FARDEL_SEAT  role=$FARDEL_SEAT_ROLE slot=$FARDEL_SEAT_SLOT prod=${FARDEL_SEAT_IS_PROD}
stdb     $FARDEL_SPACETIME_URI  db=$FARDEL_DB
vite     http://127.0.0.1:${FARDEL_VITE_PORT}
data     $FARDEL_DATA_DIR
worktree $FARDEL_WT
url      ${FARDEL_CLIENT_URL:-}
EOF
}

fardel_next_free_slot() {
  local role="$1"
  local max=0
  case "$role" in
    dev) max="$FARDEL_DEV_SLOTS" ;;
    qa)  max="$FARDEL_QA_SLOTS" ;;
    *) echo "FAIL: role must be dev or qa" >&2; return 1 ;;
  esac
  local i slug
  i=1
  while [[ "$i" -le "$max" ]]; do
    slug="${role}-${i}"
    if [[ ! -f "${FARDEL_CLAIM_ROOT}/${slug}" ]]; then
      echo "$i"
      return 0
    fi
    i=$((i + 1))
  done
  echo "FAIL: no free $role seats (0/${max} left). Release one, or raise FARDEL_$(printf '%s' "$role" | tr '[:lower:]' '[:upper:]')_SLOTS in seats.conf." >&2
  return 1
}
