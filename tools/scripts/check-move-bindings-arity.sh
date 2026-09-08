#!/usr/bin/env bash
# Fail if generated Move bindings (web TS + C#) do not match server Move arity/fields.
# Also asserts PlayerPose VelY / LastGroundedMicros in C# and vel_y / last_grounded_micros
# in web player_pose_table.ts (#166).
# Usage (repo root): ./tools/scripts/check-move-bindings-arity.sh
# Exit 0 = OK; non-zero = mismatch (print expected vs found).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

server_lib="server/spacetimedb/Lib.cs"
web_move="web/src/module_bindings/move_reducer.ts"
web_pose="web/src/module_bindings/player_pose_table.ts"
csharp_move="client/Assets/Scripts/Spacetime/Generated/Reducers/Move.g.cs"
csharp_pose="client/Assets/Scripts/Spacetime/Generated/Types/PlayerPose.g.cs"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -f "$server_lib" ]] || fail "missing $server_lib"
[[ -f "$web_move" ]] || fail "missing $web_move"
[[ -f "$web_pose" ]] || fail "missing $web_pose"
[[ -f "$csharp_move" ]] || fail "missing $csharp_move"
[[ -f "$csharp_pose" ]] || fail "missing $csharp_pose"

# Expected Move params from server: public static void Move(ReducerContext ctx, float dx, float dz, bool jump ...)
server_sig="$(
  python3 - <<'PY' "$server_lib"
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
# Prefer reducer Move with ReducerContext
m = re.search(
    r"public\s+static\s+void\s+Move\s*\(\s*ReducerContext\s+\w+\s*,([^)]*)\)",
    text,
)
if not m:
    raise SystemExit("server Move(ReducerContext, ...) not found")
params = m.group(1)
names = []
for part in params.split(","):
    part = part.strip()
    if not part:
        continue
    # e.g. "float dx" / "bool jump = false"
    part = part.split("=")[0].strip()
    tok = part.split()
    if len(tok) < 2:
        raise SystemExit(f"unparseable param: {part!r}")
    names.append(tok[-1])
print(",".join(names))
PY
)" || fail "could not parse server Move signature"

[[ "$server_sig" == "dx,dz,jump" ]] || fail "unexpected server Move params '$server_sig' (expected dx,dz,jump)"

# Web: move_reducer.ts default export fields
web_fields="$(
  python3 - <<'PY' "$web_move"
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
# export default { dx: ..., dz: ..., jump: ... }
m = re.search(r"export\s+default\s*\{([^}]+)\}", text, re.S)
if not m:
    raise SystemExit("export default { ... } not found in move_reducer.ts")
body = m.group(1)
names = re.findall(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:", body, re.M)
print(",".join(names))
PY
)" || fail "could not parse web move_reducer.ts fields"

[[ "$web_fields" == "$server_sig" ]] || fail "web move_reducer.ts fields '$web_fields' != server '$server_sig'"

# C#: Move(float dx, float dz, bool jump) + DataMember jump
csharp_method="$(
  python3 - <<'PY' "$csharp_move"
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r"public\s+void\s+Move\s*\(([^)]*)\)", text)
if not m:
    raise SystemExit("public void Move(...) not found in Move.g.cs")
params = m.group(1)
names = []
for part in params.split(","):
    part = part.strip()
    if not part:
        continue
    tok = part.split()
    names.append(tok[-1])
print(",".join(names))
PY
)" || fail "could not parse C# Move method"

[[ "$csharp_method" == "$server_sig" ]] || fail "C# Move.g.cs method params '$csharp_method' != server '$server_sig'"

if ! grep -q '\[DataMember(Name = "jump")\]' "$csharp_move"; then
  fail "C# Move.g.cs missing DataMember jump"
fi

# PlayerPose vertical fields (paired with #83 jump) — C# + web (#166)
if ! grep -q '\[DataMember(Name = "vel_y")\]' "$csharp_pose"; then
  fail "C# PlayerPose.g.cs missing DataMember vel_y / VelY"
fi
if ! grep -q '\[DataMember(Name = "last_grounded_micros")\]' "$csharp_pose"; then
  fail "C# PlayerPose.g.cs missing DataMember last_grounded_micros / LastGroundedMicros"
fi
if ! grep -q 'public float VelY' "$csharp_pose"; then
  fail "C# PlayerPose.g.cs missing VelY property"
fi
if ! grep -q 'public long LastGroundedMicros' "$csharp_pose"; then
  fail "C# PlayerPose.g.cs missing LastGroundedMicros property"
fi

# Web generated table must expose wire names matching server (#166 / #112 class)
if ! grep -q '.name("vel_y")' "$web_pose"; then
  fail "web player_pose_table.ts missing vel_y (.name(\"vel_y\"))"
fi
if ! grep -q '.name("last_grounded_micros")' "$web_pose"; then
  fail "web player_pose_table.ts missing last_grounded_micros (.name(\"last_grounded_micros\"))"
fi
if ! grep -q 'velY:' "$web_pose"; then
  fail "web player_pose_table.ts missing velY field"
fi
if ! grep -q 'lastGroundedMicros:' "$web_pose"; then
  fail "web player_pose_table.ts missing lastGroundedMicros field"
fi

ok "server Move($server_sig) matches web + C# generated bindings"
ok "PlayerPose VelY + LastGroundedMicros present in C# generated types"
ok "web player_pose_table.ts has vel_y + last_grounded_micros"
