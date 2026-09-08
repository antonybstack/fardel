# Fardel web client (Babylon.js 9)

Vite + TypeScript + `@babylonjs/core@9.0.0` browser client for SpacetimeDB.

## Prereqs

- JS runtime 22+ recommended
- Local SpacetimeDB (`../tools/scripts/ensure-local-spacetime.sh`)
- Published `fardel` module under `../server`

## Install and run

From `web/`:

1. Install dependencies with your package manager (`install`).
2. Start Vite with the `dev` script.
3. Open the printed local URL (default `http://127.0.0.1:5173`).

```text
cd web
# package-manager install
# package-manager run dev
```

## Build

```text
# package-manager run build
```

Output: `dist/` (deploy to Cloudflare Pages → `play.sparkify.dev`).

Typecheck note: package-manager run build runs tsc then vite; keep it green (no vite-only workaround).

After server schema changes (Move.jump, PlayerPose.velY / lastGroundedMicros), regenerate bindings. Checked-in src/module_bindings/ should match develop module.

## Generate bindings

With local spacetime + published module:

```bash
spacetime generate --lang typescript --out-dir web/src/module_bindings --project-path server
```

Until generate succeeds, the HUD shows a TODO and the Babylon scene still boots.

## URI overrides

Resolution order (first match wins):

1. `?db=` / `?database=` and `?module=` / `?name=` — **required for agent seats**
2. Vite `VITE_FARDEL_URI` / `VITE_FARDEL_DB` (worktree `web/.env.local` from `seat-up.sh`)
3. Default: `http://127.0.0.1:3000` / `fardel` on localhost; `https://dev-db.sparkify.dev` when hosted (`play.sparkify.dev`)

Agent seats must not rely on (3). Example:

```text
http://127.0.0.1:5241/?db=http://127.0.0.1:3241&module=fardel-qa-1
```

See [docs/TEAM_SEATS.md](../docs/TEAM_SEATS.md).

## Visual eval hooks

**VE policy (Lead):** capture proof with `?ve=…`, then **paste the PNG into the GitHub PR** (user-attachments embed). Do **not** commit routine `ve/*.png` for new work. Historical `ve/` paths in the table below are legacy references only.


| Query | Proof |
|---|---|
| `?ve=two-client` | Wait for remote `PlayerPose` humanoids; HUD `remotes:` + `Two-client OK` |
| `?ve=minimap` | Seed crowd + dummy; prove top-right 2D minimap dots (`ve/babylon-minimap.png`) |
| `?ve=minimap-read` | Plate + blips + N vs #39 cyan fog at play cam (#103 / #61) |
| `?ve=minimap-pip` | Self pip + north readable while WASDing (#164); pulse/halo/N on top of sliding blips |
| `?ve=bag` | Prove You+XP self-frame, staff/Spark/Emberbolt loadout strip, B bag panel (`ve/babylon-bag.png`) |
| `?ve=hotbar` / `?ve=target-frame` | Select Dummy + cast; prove empty slots + STAFF disabled + OOM affordances (`ve/babylon-hotbar.png`) |
| `?ve=hotbar-afford` | Affordance polish proof: empty vs STAFF vs OOM at play cam (`ve/babylon-hotbar-afford.png`) |
| `?ve=gcd` | Thicker GCD sweep + Emberbolt cast fill on hotbar slots (`ve/babylon-gcd.png`) |
| `?ve=debug-hud` | Force `#status` + `#fpsHud` visible; HUD `Debug HUD OK · status visible · F3/?debug=1` (`ve/babylon-debug-hud.png`) |
| `?ve=status-read` | Prove Connected · online vs Connecting vs GCD idle are lexically distinct (#129); HUD `Status-read OK · Connected · online · GCD idle · #129` |
| `?ve=rmb-look` | Prove RMB-look armed clarity (#154): canvas `grabbing` + legend `LOOKING` chip + status `camera: looking`; HUD `RMB-look OK · armed · grabbing · legend LOOKING · status looking · #154` |
| `?ve=rmb-orbit` | Prove RMB orbit moves `camera.alpha` on the **play follow** path after a **real pointer RMB-drag** (#366 / #389). Do not inject `inertialAlphaOffset`. Chrome-only `?ve=rmb-look` is not enough. HUD `RMB orbit OK · dAlpha …` / `RMB orbit FAIL` |
| `?ve=hostile-spawn` | Two yard hostiles as red capsules; dummy stays trainer (#354); HUD `Hostile spawn OK · n=2 · capsule · dummy trainer · #354` |
| `?ve=leash` | Walk into aggro, hostile leaves pad, run out, it returns (#355); HUD `Leash OK · pulled · returned · #355`. |
| `?ve=aggro` | Same pull-then-leash session shot (#360); HUD `Aggro OK · pulled · leashed · #360`. |
| `?ve=auto-attack` | Pull pad A, HP drops on cadence, run out, HP stops (#356); HUD `Auto-attack OK · hp … · stopped · #356`. |
| `?ve=hunt-loot` | Kill pad A from outside aggro, corpse ember_shard, F pickup (#357); HUD `Hunt-loot OK · corpse shard · F pickup · #357`. |
| `?ve=target-frame` | Tab-select Dummy; prove compact name+HP frame above combat bars (`ve/babylon-target-frame.png`) |
| `?ve=reticule` | Select Dummy; prove gold ring + overhead marker (`ve/babylon-reticule.png`); HUD `Reticule OK · … · gold ring+marker` |
| `?ve=target-contrast` | Select Dummy; prove gold `#targetFrame` + world reticule crisp under #39 cyan fog (`ve/babylon-target-contrast.png`); HUD `Target-contrast OK · gold frame+reticule · … · fog crisp` |
| `?ve=tab-target` | Tab-select Dummy; world gold nameplate + HP pip + ring + marker (#142); HUD `Tab-target OK · world gold plate+ring · … · #142` |
| `?ve=tab-hostile` | Tab prefers in-range hostiles; dummy still in cycle (#358); HUD `Tab-hostile OK · Hostile #… · dummy selectable · #358`. |
| `?ve=hostile-read` | Hostile coral plate vs Dummy parchment vs Vendor mint at play cam (#359); HUD `Hostile-read OK · Hostile coral · Dummy parchment · Vendor mint · #359`. |
| `?ve=hostile-types` | Kind=2 Hostile coral vs Kind=3 Brigand violet vs Dummy parchment vs Vendor mint (#418); HUD `Hostile-types OK · Hostile coral · Brigand violet · Dummy parchment · Vendor mint · #418`. |
| `?ve=kick` | KickNpc Kind=2 interrupt + dummy still kickable (#419); HUD `Kick OK · Hostile #… · interrupt · dummy kickable · #419`. |
| `?ve=stun` | StunNpc Kind=2 lock + dummy still stunnable (#420); HUD `Stun OK · Hostile #… · lock · dummy stunnable · #420`. Walk to ~4m (StunRange 5, AggroRadius 3). |
| `?ve=respawn` | Kill pad A from origin (outside aggro), linger revive at home pad (#421); HUD `Respawn OK · pad A · dummy trainer · #421`. Do not walk into AggroRadius. Dummy stays trainer. |
| `?ve=encounter` | Pull pad A, Tab, take a swing among trees with nameplate on and cam out of trunks (#361); HUD `Encounter OK · fighting · plate · cam clear · #361`. |
| `?ve=keys` | Open keybind legend overlay (H); HUD `Keys legend OK · …` (`ve/babylon-keys.png`) |
| `?ve=keys-read` | Keybind legend chrome readability under #39 cyan fog (#115); HUD `Keys-read OK · …` |
| `?ve=first-session` | First-connect H legend flash + canvas-focus toast (#134); HUD `First-session OK · H legend · canvas focus · #134` |
| `?ve=death-ux` | Kill self via Dummy; prove stronger greyout + live respawn countdown + death toast (`ve/babylon-death-ux.png`); HUD `Death UX OK · …` |
| `?ve=no-target-cast` | Empty/no-target cast failure: CANCEL-class toast + combat log (#190); HUD `No-target-cast OK · …` |
| `?ve=dead-target-cast` | Dead/invalid **existing** target Cast cancel: CANCEL-class toast + combat log (#131); HUD `Dead-target-cast OK · …` |
| `?ve=cast-range` | Move beyond CastRangeMeters; outOfRange toast + dim hotbar (`ve/babylon-cast-range.png`) |
| `?ve=cast-range-ring` | Selected Dummy beyond cast range; Babylon ground reach ring (`ve/babylon-cast-range-ring.png`); HUD `Cast-range ring OK · …` |
| `?ve=cast-cancel` | Emberbolt windup → Move interrupt; clear cast bar + CANCEL toast (`ve/babylon-cast-cancel.png`) |
| `?ve=cast-feedback` | Prominent Emberbolt cast bar + CANCEL ≠ LOCKOUT toasts + Rest enter chrome (`ve/babylon-cast-feedback.png`) |
| `?ve=castbar-read` | Cast / CANCEL / LOCKOUT chrome readable over #39 cyan fog (`ve/babylon-castbar-read.png`); HUD `Castbar-read OK · … · fog chrome` |
| `?ve=gcd-block` | GCD-blocked cast press shows cool blue/silver toast + combat-log (#188); HUD `GCD-block OK · toast GCD blue/silver · combat-log · #188` |
| `?ve=gcd-read` | Cool blue/silver `#gcdBar` mid-sweep (+ cast amber contrast) under #39 fog (#117); HUD `GCD-read OK · … · cool≠amber · fog chrome` |
| `?ve=bandage` | BuyYardBandage + UseBandage HP heal; toast/bag (`ve/babylon-bandage.png`) |
| `?ve=humanoid` | Frame local procedural humanoid + staff |
| `?ve=dummy` | Frame scarecrow/practice dummy (wood+canvas) under #39 lights (`ve/babylon-dummy.png`) |
| `?ve=floater-read` | Damage/heal/XP floaters with thick outline under #39 fog (`ve/babylon-floater-read.png`) |
| `?ve=quaternius-char` | Quaternius CC0 wizard at 8–15m under #39 lights (`ve/babylon-quaternius-char.png`) |
| `?ve=frame-hp` | Self + party HP bars mid/low contrast over cyan fog (#67) (`ve/babylon-frame-hp.png`) |
| `?ve=loadout-buff` | Mixed equipped/missing loadout chips + active tonic buff (#91); paste PNG to PR user-attachments |
| `?ve=combat-log-read` | Combat log strip readability over cyan fog (#78 / #102) |
| `?ve=toast-read` | System toast stack readability vs #39 fog (#90) — invite/XP/death plates; paste PNG to PR user-attachments |
| `?ve=toast-combat` | Trade/XP toasts quiet during GCD/cast so combat keeps focus (#141) |
| `?ve=trade-feel` | Trade offer flow state clarity (#162) — incoming/waiting/accepted/cancelled chrome cycles; HUD `Trade-feel OK · …` |
| `?ve=chat-read` | Chat/say plate readability over cyan fog — say/party/whisper distinct (#88); HUD `Chat-read OK · …` |
| `?ve=atmosphere` | Yard mood: blue/cyan fog + warm sun/cool hemi + lush ground (`ve/babylon-atmosphere.png`) |
| `?ve=spell-vfx` | Spark cyan flash+bolt+impact + Emberbolt staff charge→projectile→impact (`ve/babylon-spell-vfx.png`) |
| `?ve=path-ground` | Dirt/stone trail vs lush grass (#44) (`ve/babylon-path-ground.png`) |
| `?ve=sky-horizon` | Distant layered mountain ranges + fog-matched sky (#55 / #273) (`ve/babylon-sky-horizon.png`) |
| `?ve=place-wow` | Establishing shot vs hordes place ref (#276 / #342); path recedes to a second silhouette |
| `?ve=collision` | Local WASD blocked/sliding on a hero bole (#339); HUD `Collision OK · blocked against a hero trunk` |
| `?ve=fps` | Dense play-cam FPS HUD ≥30 (#341); persistMark `FPS OK · N fps (floor 30) · dense play-cam` |
| `?ve=vendor-panel` | Vendor buy/sell panel chrome vs #39 fog (#106) — bronze buy / mint sell on silver plate; interim capture `/workspace/ve-capture/pr-vendor-panel.png` (no `ve/*.png` commit) |
| `?ve=vendor-stall` | Shop silhouette posts+counter+awning under #39 fog (#58) (`ve/babylon-vendor-stall.png`) |
| `?ve=vendor-interact` | Approach YardVendor into 4.5m range; toast-only affordance (panel closed); framed stall |
| `?ve=loot-f` | Approach WorldLoot into 3m pickup range; toast-only F-pickup affordance (no auto-pickup) |
| `?ve=forest` / `?ve=quaternius-env` / `?ve=aoi` / `?ve=combat` / `?ve=persist` | Forest / Quaternius Standard env (`ve/babylon-quaternius-env.png`) |


Debug HUD (`#status` identity/AOI wall + `#fpsHud`) is **hidden by default**. Show with `?debug=1` / `?debug=true`, or toggle with **F3** (ignored while `#chatInput` is focused). `#persistMark` stays available for any `?ve=` mode.

Headless second identity (shared-yard): `dotnet run --project ../tools/SecondClient` while Vite watches remotes.

