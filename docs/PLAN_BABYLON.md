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
6. **Forest kitbash** — procedural/huge trees + mountain backdrop + mood sky (web-cheap).

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
  reconciles to `PlayerPose` (humanoid root); HUD shows Connected + `pos`
- **Combat (presentation):** Tab cycles NPC targets; hotkeys 1=Spark / 2=Emberbolt
  → `Cast`; `EnsureTrainingDummy` on subscribe; GCD + cast bars in HUD; selected
  target highlight + cast flash (`ve/babylon-combat.png`)
- **Persist (presentation):** auth token in `localStorage`; refresh restores same
  identity + Character XP + starter loadout (staff/robes + Spark/Emberbolt);
  HUD shows XP/loadout + restore proof (`ve/babylon-persist.png`);
  `tools/PersistSmoke` green
- **AOI (presentation):** Moore-neighborhood SQL subscribe (ADR 0001) for
  `player_pose` + `crowd_proxy`; `SeedCrowdProxies`; amber instanced capsules
  distinct from local blue player; HUD interest chunk + near/far proxy counts
  (`ve/babylon-aoi.png`); `tools/AoiSmoke` green
- **Forest kitbash (presentation):** procedural clearing — huge hero trunks +
  instanced mid trees, distant snow-capped mountain silhouette, dusk sky/fog +
  hemi/sun mood lighting (`web/src/world/forest.ts`); (`ve/babylon-forest.png`)
- **Humanoid + staff (presentation):** local player procedural body+head+limbs +
  staff (`web/src/world/humanoid.ts`); CrowdProxies stay capsules; dummy unchanged
  (`ve/babylon-humanoid.png`)
- **Second-client shared yard (presentation):** remote `PlayerPose` identities
  render as distinct tinted humanoids; HUD `remotes:` line; `?ve=two-client` +
  `tools/SecondClient` headless mover (`ve/babylon-two-client.png`)
- **Remote cast / target (presentation):** `PlayerCombat` carries `CastingSpellId`
  / `CastEndsAt` / `LastSpellId` / `LastCastAt`; remotes show Emberbolt windup
  beam+bar, Spark/impact flash, cyan target rings on NPCs selected by others;
  HUD `remote-target` / `remote-cast`; `?ve=remote-cast` + SecondClient cast loop
  (`ve/babylon-remote-cast.png`)
- **Floating damage / combat text (presentation):** NPC `hp` table deltas spawn
  rising billboard numbers above the target (Spark yellow / Emberbolt orange);
  cosmetic only — authority HP remains source of truth; `?ve=damage-text`
  (`ve/babylon-damage-text.png`)
- **Party / always-relevant (presentation):** `PartyMember` + `PartyInvite` tables;
  CreateParty / InviteToParty / AcceptPartyInvite / LeaveParty; neighborhood SQL
  also wholesale-subscribes `party_member` + per-identity `player_pose` for party
  mates outside Moore; green party remote tint; HUD `party: N`; hotkeys P/O;
  `?ve=party` + `tools/PartySmoke` / `tools/PartyMate` (`ve/babylon-party.png`)
- **Minimap / compass HUD (presentation):** top-right 2D canvas minimap — local (blue), remotes (magenta / party green), training dummy (tan), crowd proxies (amber near / dim far); north-up; `?ve=minimap` (`ve/babylon-minimap.png`)
- **World nameplates (presentation):** billboard labels — local **You**, remotes hex prefix (party green tint), training dummy **Dummy** + HP pip; `?ve=nameplates` (`ve/babylon-nameplates.png`)
- **Selected-target frame HUD (presentation):** compact DOM name + HP bar (+ short npc id) for current Tab target, stacked above combat GCD/cast bars; client-only; `?ve=target-frame` (`ve/babylon-target-frame.png`)
- **Target frame + spell hotbar HUD (presentation):** bottom-center Spark (1) / Emberbolt (2) slots with keybind + GCD sweep + Emberbolt cast fill; dim when staff unequipped; `?ve=hotbar` / `?ve=target-frame` (`ve/babylon-hotbar.png`)
- **Player self-frame + bag/loadout strip (presentation):** bottom-left **You** + XP self-frame; compact staff/Spark/Emberbolt loadout chips from Character; **B** toggles bag panel; client-only (no player HP table yet); `?ve=bag` (`ve/babylon-bag.png`)
- **Party member frames HUD (presentation):** compact left-column roster from `PartyMember` + remotes — You/hex, leader tag, distance + pose hint; `?ve=party-frames` + PartyMate/SecondClient (`ve/babylon-party-frames.png`)
- **Combat log strip (presentation):** client-only scrolling right-column log — Cast start, HP-delta damage, staff/robes equip, party join; `?ve=combat-log` (`ve/babylon-combat-log.png`)
- **Robes mesh visual (presentation):** `EquipRobes`/`UnequipRobes`; hotkeys **J/K**; hood/skirt/shoulders hide + drab tunic tint follow `Character.robesEquipped` (mirrors staff U/I); `tools/RobesEquipSmoke`; `?ve=robes-equip` (`ve/babylon-robes-equip.png`)
- **Pages:** Vite `web/dist` → Cloudflare Pages `fardel` → `play.sparkify.dev`
  (default URI `https://dev-db.sparkify.dev` when not localhost; live Connected
  needs Mac tunnel)
- **Staff unequip / cast gate:** `UnequipStaff` / `EquipStaff`; hotkeys U/I; staff mesh
  follows `Character.staffEquipped`; HUD blocked cast; `tools/StaffEquipSmoke`;
  `?ve=staff-equip` (`ve/babylon-staff-equip.png`)
- Next (north-star): credited art packs when licenses land; Pages redeploy after combat-log (art packs still blocked)
