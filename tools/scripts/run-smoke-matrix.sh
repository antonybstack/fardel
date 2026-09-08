#!/usr/bin/env bash
# Run headless *Smoke projects with compile fail-fast + Move.compat preflight (#130).
# Usage (repo root): ./tools/scripts/run-smoke-matrix.sh [logdir]
# Env:
#   FARDEL_MATRIX_FAIL_FAST=1 (default) stop on first compile error
#   FARDEL_MATRIX_RETRY=1 (default) retry once on non-compile FAIL
#   FARDEL_MATRIX_ALLOW_FLAKE=0 (default) FLAKE rows also force non-zero exit (#148)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

export DOTNET_ROOT="${DOTNET_ROOT:-$HOME/.dotnet}"
export PATH="$HOME/.local/node22/bin:$DOTNET_ROOT:$DOTNET_ROOT/tools:$HOME/.local/bin:$PATH"

LOGDIR="${1:-/tmp/fardel-smoke-matrix-$(git rev-parse --short HEAD 2>/dev/null || echo local)}"
FAIL_FAST="${FARDEL_MATRIX_FAIL_FAST:-1}"
RETRY="${FARDEL_MATRIX_RETRY:-1}"

mkdir -p "$LOGDIR"
: > "$LOGDIR/results.tsv"
: > "$LOGDIR/runner.log"

log() { echo "$*" | tee -a "$LOGDIR/runner.log"; }

move_g="client/Assets/Scripts/Spacetime/Generated/Reducers/Move.g.cs"
move_compat="client/Assets/Scripts/Spacetime/Generated/Reducers/Move.compat.cs"

# Optional refuse: Move.compat.cs + still-2-arg Move.g.cs => CS0111 wipe (#130)
if [[ -f "$move_compat" && -f "$move_g" ]]; then
  if grep -qE "public void Move\(float dx, float dz\)" "$move_g" \
    && ! grep -qE "public void Move\(float dx, float dz, bool jump\)" "$move_g"; then
    log "FAIL: $move_compat present while $move_g is still 2-arg (CS0111 footgun)."
    log "Fix: spacetime generate --lang csharp ... (commit 3-arg Move), THEN keep optional compat,"
    log "      or delete Move.compat.cs once 3-arg Move.g.cs is committed. See docs/DEV_BOX.md / ORCHESTRATION."
    exit 2
  fi
fi

# Bindings arity guard when present (#119)
if [[ -x tools/scripts/check-move-bindings-arity.sh ]]; then
  tools/scripts/check-move-bindings-arity.sh | tee -a "$LOGDIR/runner.log"
fi

# Dynamic discovery — never a hardcoded allowlist (#122). New tools/*Smoke
# dirs (e.g. JumpSmoke, IdleSmoke) must appear in the run list and in results.tsv.
#
# Node/Playwright smokes (#321 IdleSmoke): ship tools/<Name>Smoke/run.sh instead
# of a csproj. `ls tools/*Smoke` still discovers the dir. `dotnet run` cannot
# execute a node smoke — exec_smoke runs run.sh when present. IdleSmoke opens
# seat Vite `?ve=idle` (--use-angle=metal) and FAILS on persistMark T-POSE /
# empty / "Quaternius char OK". Source `wt-env.sh <slug>` + seat-up first.
# Never :3000 / db fardel / :5173. HTTP 200 of a T-pose PNG is not Idle VE.
mapfile -t SMOKES < <(ls -d tools/*Smoke 2>/dev/null | xargs -n1 basename | sort)
if [[ ${#SMOKES[@]} -eq 0 ]]; then
  log "FAIL: no tools/*Smoke projects found"
  exit 1
fi
require_discovered() {
  local want="$1"
  if [[ ! -d "tools/$want" ]]; then
    return 0
  fi
  local found=0 _n
  for _n in "${SMOKES[@]}"; do
    if [[ "$_n" == "$want" ]]; then found=1; break; fi
  done
  if [[ "$found" -eq 0 ]]; then
    log "FAIL: tools/$want exists but was not discovered (#122/#321)"
    exit 1
  fi
}
require_discovered JumpSmoke
require_discovered IdleSmoke
require_discovered RmbOrbitSmoke
require_discovered HostileSmoke

is_compile_fail() {
  local logf="$1" ec="$2"
  if [[ "$ec" -eq 0 ]]; then
    return 1
  fi
  if rg -q "error CS[0-9]+|: error CS|The build failed\.|Build FAILED\." "$logf" 2>/dev/null; then
    return 0
  fi
  # dotnet often exits 1 on compile without always printing those strings in quiet modes
  if rg -q "CSC : error|Microsoft\.NET\.Sdk\.targets" "$logf" 2>/dev/null; then
    return 0
  fi
  return 1
}

classify() {
  local logf="$1" ec="$2"
  local result=FAIL
  if [[ "$ec" -eq 0 ]]; then result=PASS; fi
  if rg -q "RESULT: *FAIL|\bFAIL:" "$logf" 2>/dev/null; then result=FAIL; fi
  if [[ "$result" != "FAIL" ]] && rg -q "OK: .* passed|RESULT: *PASS" "$logf" 2>/dev/null; then result=PASS; fi
  if [[ "$ec" -ne 0 ]]; then result=FAIL; fi
  echo "$result"
}

# C# smokes: dotnet run. Node/Playwright smokes (#321): tools/$name/run.sh.
exec_smoke() {
  local name="$1"
  if [[ -f "tools/$name/run.sh" ]]; then
    bash "tools/$name/run.sh"
    return $?
  fi
  if [[ ! -f "tools/$name/$name.csproj" ]]; then
    echo "FAIL: $name has no $name.csproj and no run.sh (node smoke hook #321)"
    return 1
  fi
  dotnet run --project "tools/$name" -c Release
}

log "=== MATRIX START sha=$(git rev-parse --short HEAD) count=${#SMOKES[@]} $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
log "DISCOVERY: ${#SMOKES[@]} tools/*Smoke (JumpSmoke=$([[ -d tools/JumpSmoke ]] && echo present || echo absent) IdleSmoke=$([[ -d tools/IdleSmoke ]] && echo present || echo absent))"
log "SMOKES: ${SMOKES[*]}"
log "FAIL_FAST=$FAIL_FAST RETRY=$RETRY LOGDIR=$LOGDIR"

# Preflight: first C# smoke (skip run.sh-only dirs like IdleSmoke).
first=""
for _n in "${SMOKES[@]}"; do
  if [[ -f "tools/$_n/$_n.csproj" ]]; then
    first="$_n"
    break
  fi
done
if [[ -z "$first" ]]; then
  log "FAIL: no C# tools/*Smoke csproj for preflight"
  exit 1
fi
pre_log="$LOGDIR/preflight-${first}.build.log"
log "=== PREFLIGHT dotnet build tools/$first ==="
set +e
dotnet build "tools/$first" -c Release -v q >"$pre_log" 2>&1
pre_ec=$?
set -e
if [[ "$pre_ec" -ne 0 ]]; then
  log "FAIL: preflight compile failed for $first (ec=$pre_ec) — aborting matrix"
  tail -n 40 "$pre_log" | tee -a "$LOGDIR/runner.log" || true
  echo -e "${first}\tCOMPILE_FAIL\tpreflight ec=$pre_ec" | tee -a "$LOGDIR/results.tsv"
  exit 3
fi
log "OK: preflight compile $first"

for name in "${SMOKES[@]}"; do
  log "=== RUN $name attempt 1 $(date -u +%H:%M:%S) ==="
  logf="$LOGDIR/${name}.a1.log"
  set +e
  exec_smoke "$name" >"$logf" 2>&1
  ec=$?
  set -e

  if is_compile_fail "$logf" "$ec"; then
    echo -e "${name}\tCOMPILE_FAIL\ta1=COMPILE_FAIL ec=$ec" | tee -a "$LOGDIR/results.tsv"
    log "FAIL: compile error in $name — fail-fast abort (set FARDEL_MATRIX_FAIL_FAST=0 to continue)"
    tail -n 30 "$logf" | tee -a "$LOGDIR/runner.log" || true
    if [[ "$FAIL_FAST" == "1" ]]; then
      exit 3
    fi
    continue
  fi

  result="$(classify "$logf" "$ec")"
  if [[ "$result" = "FAIL" && "$RETRY" == "1" ]]; then
    log "=== RETRY $name attempt 2 $(date -u +%H:%M:%S) ==="
    log2="$LOGDIR/${name}.a2.log"
    set +e
    exec_smoke "$name" >"$log2" 2>&1
    ec2=$?
    set -e
    if is_compile_fail "$log2" "$ec2"; then
      echo -e "${name}\tCOMPILE_FAIL\ta1=FAIL a2=COMPILE_FAIL ec1=$ec ec2=$ec2" | tee -a "$LOGDIR/results.tsv"
      log "FAIL: compile error on retry $name — fail-fast abort"
      if [[ "$FAIL_FAST" == "1" ]]; then
        exit 3
      fi
      continue
    fi
    result2="$(classify "$log2" "$ec2")"
    if [[ "$result2" = "PASS" ]]; then
      echo -e "${name}\tFLAKE\ta1=FAIL a2=PASS ec1=$ec ec2=$ec2" | tee -a "$LOGDIR/results.tsv"
    else
      echo -e "${name}\tFAIL\ta1=FAIL a2=FAIL ec1=$ec ec2=$ec2" | tee -a "$LOGDIR/results.tsv"
    fi
  else
    echo -e "${name}\t${result}\ta1=${result} ec=$ec" | tee -a "$LOGDIR/results.tsv"
  fi
done

log "=== MATRIX DONE ==="
cat "$LOGDIR/results.tsv"
date -u +%Y-%m-%dT%H:%M:%SZ

# Aggregate results.tsv — never soft-green on FAIL (#148)
ALLOW_FLAKE="${FARDEL_MATRIX_ALLOW_FLAKE:-0}"
fail_n=0
flake_n=0
pass_n=0
while IFS=$'\t' read -r _name status _rest || [[ -n "${_name:-}" ]]; do
  [[ -z "${_name:-}" ]] && continue
  case "$status" in
    PASS) pass_n=$((pass_n + 1)) ;;
    FLAKE) flake_n=$((flake_n + 1)) ;;
    FAIL|COMPILE_FAIL) fail_n=$((fail_n + 1)) ;;
    *) fail_n=$((fail_n + 1)) ;; # unknown status → treat as fail
  esac
done < "$LOGDIR/results.tsv"

# Every discovered tools/*Smoke must have a results.tsv row (#122).
missing=()
for name in "${SMOKES[@]}"; do
  if ! grep -q $'^'"${name}"$'\t' "$LOGDIR/results.tsv"; then
    missing+=("$name")
  fi
done
if [[ ${#missing[@]} -gt 0 ]]; then
  log "FAIL: results.tsv missing ${#missing[@]} discovered smoke(s): ${missing[*]} (#122)"
  fail_n=$((fail_n + ${#missing[@]}))
fi
log "=== MATRIX GATE pass=$pass_n fail=$fail_n flake=$flake_n discovered=${#SMOKES[@]} allow_flake=$ALLOW_FLAKE ==="
if [[ "$fail_n" -gt 0 ]]; then
  log "GATE: FAIL — $fail_n row(s) FAIL/COMPILE_FAIL in $LOGDIR/results.tsv (do not treat 'script completed' as green)"
  exit 1
fi
if [[ "$flake_n" -gt 0 && "$ALLOW_FLAKE" != "1" ]]; then
  log "GATE: FAIL — $flake_n FLAKE row(s); set FARDEL_MATRIX_ALLOW_FLAKE=1 to allow"
  exit 1
fi
log "GATE: PASS"
exit 0
