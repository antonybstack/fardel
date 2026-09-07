# Plan: Babylon.js web client

## Why pivot

Unity 6 WebGL/WebGPU worked for visuals and reached a Connect milestone on
`play.sparkify.dev`, but it is a poor **agent iteration loop**: Editor locks,
long batchmode builds, Pages compression quirks, and GUI-only visual eval.
MVP needs a **code-first** browser client that agents and humans can edit,
install, serve, and smoke on the Mac without Unity Hub.

SpacetimeDB **C# module** + headless smokes (`tools/*Smoke`) stay the authority
path. Only the presentation host changes.

Unity work is frozen on branch **`checkpoint/unity-webgl`** at commit
**`ca9b7d5`**. That branch must not be deleted. Resume later if needed; it is
not on the MVP critical path. See [ADR 0003](adr/0003-babylon-web-client.md).

## Architecture

```
[ Babylon.js 9 + Vite + TypeScript ]     [ SpacetimeDB ]
  input → intents                          C# module (tables + reducers)
  predict move + cast windup               authoritative sim tick
  interpolate remotes                      AOI / subscriptions
  GPU-friendly presentation                durable character + bag + skills
            \                                /
             \______ WebSocket binary ______/
```

| Layer | Choice |
|---|---|
| Client host | **Babylon.js `@babylonjs/core@9.0.0`** + TypeScript + Vite (`web/`) |
| Net SDK | SpacetimeDB **JS/TS SDK** (`spacetimedb` package) + generated bindings |
| World authority | SpacetimeDB ≥ 2.3 (local 2.10+) C# → WASM module (`server/`) |
| Shared rules | Pure C# `shared/` (module + future prediction helpers) |
| Proof | Headless `tools/*Smoke` unchanged |

Client host decision: [ADR 0003](adr/0003-babylon-web-client.md) (supersedes active host in ADR 0002).

## Reuse existing module / smokes

Do **not** rewrite reducers for the client swap. Reuse:

| Slice | Headless gate | Client presentation goal |
|---|---|---|
| 0 Connect | `tools/ConnectSmoke` | Connect HUD + identity |
| 1 Move | `tools/MoveSmoke` | WASD + RMB camera; server pose |
| 2 Combat | `tools/CombatSmoke` | Tab-target, Spark/Emberbolt, GCD |
| 3 Persist | `tools/PersistSmoke` | Refresh keeps XP + loadout |
| 4 AOI | `tools/AoiSmoke` | Chunk neighborhood presentation |

## Slice path (presentation)

1. **Connect** — Vite app boots Babylon scene; SpacetimeDB URI `http://127.0.0.1:3000`, database `fardel`; show Connected + identity.
2. **Move** — send `Move` intents; reconcile local capsule/humanoid to `PlayerPose`.
3. **Combat** — tab-target dummy; cast Spark/Emberbolt; GCD UI; cast telegraphs.
4. **Persist** — token in localStorage; refresh restores character.
5. **AOI presentation** — subscribe chunk neighborhood; crowd proxies as instanced meshes.

bitECS optional later; start with Maps / typed arrays until AOI load demands it.

## Deploy

- Build: `web/` → package scripts → static `dist/`
- Host: Cloudflare Pages project `fardel` → **`play.sparkify.dev`**
- Dev DB: `dev-db.sparkify.dev` (Mac cloudflared → local SpacetimeDB)
- Prod DB: `db.sparkify.dev` / MainCloud when ready (see [DEPLOY.md](DEPLOY.md))

Override URI with `?db=` / `?database=` query params (same idea as the Unity Connect build).

## Checkpoint branch note

| Ref | Meaning |
|---|---|
| `checkpoint/unity-webgl` @ `ca9b7d5` | Last Unity WebGL Connect milestone (preserved) |
| `main` | Babylon.js + TS active client; Unity tree **removed** from `main` |

Do **not** delete `origin/checkpoint/unity-webgl`.

## Env requirements

| Tool | Requirement |
|---|---|
| .NET | **10.x** SDK (module + Shared + smokes) |
| SpacetimeDB CLI | **2.10+** (`spacetime start` / `publish` / `generate`) |
| JS runtime | **22+** preferred (Vite + SDK) |
| Babylon | pin **`@babylonjs/core@9.0.0`** |
| SpacetimeDB client lib | pin a real `spacetimedb` version compatible with CLI 2.10 |

Local keepalive:

```bash
./tools/scripts/ensure-local-spacetime.sh
```

Generate TS bindings (when module is published locally):

```bash
spacetime generate --lang typescript --out-dir web/src/module_bindings --project-path server
```

Run the client (from `web/`):

```bash
# install deps, then:
#   package-manager install
#   package-manager run dev
```

See `web/README.md` for exact commands.

## Status

- Docs + Unity removal from `main`: done
- Scaffold: `web/` Vite + Babylon 9 + generated TS bindings
- **Connect (presentation):** green in browser (HUD Connected + identity)
- **Move (presentation):** WASD → `Move` reducer; RMB ArcRotate look; capsule
  reconciles to `PlayerPose`; HUD shows Connected + `pos`
- Next: Combat presentation (tab-target dummy, Spark/Emberbolt, GCD UI)
