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

mapfile -t SMOKES < <(ls -d tools/*Smoke 2>/dev/null | xargs -n1 basename | sort)
if [[ ${#SMOKES[@]} -eq 0 ]]; then
  log "FAIL: no tools/*Smoke projects found"
  exit 1
fi

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
  if rg -q "OK: .* passed|RESULT: *PASS" "$logf" 2>/dev/null; then result=PASS; fi
  if [[ "$ec" -ne 0 ]]; then result=FAIL; fi
  echo "$result"
}

log "=== MATRIX START sha=$(git rev-parse --short HEAD) count=${#SMOKES[@]} $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
log "SMOKES: ${SMOKES[*]}"
log "FAIL_FAST=$FAIL_FAST RETRY=$RETRY LOGDIR=$LOGDIR"

# Preflight: compile first smoke once so CS0111 dies before the full loop
first="${SMOKES[0]}"
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
  dotnet run --project "tools/$name" -c Release >"$logf" 2>&1
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
    dotnet run --project "tools/$name" -c Release >"$log2" 2>&1
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

log "=== MATRIX GATE pass=$pass_n fail=$fail_n flake=$flake_n allow_flake=$ALLOW_FLAKE ==="
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
