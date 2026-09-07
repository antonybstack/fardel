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

- Default: `http://127.0.0.1:3000`, database `fardel`
- Default URI: `http://127.0.0.1:3000` on localhost; `https://dev-db.sparkify.dev` when hosted (e.g. play.sparkify.dev)
- Query override: `?db=https://dev-db.sparkify.dev` (also accepts `?database=`)

## Visual eval hooks

**VE policy (Lead):** capture proof with `?ve=…`, then **paste the PNG into the GitHub PR** (user-attachments embed). Do **not** commit routine `ve/*.png` for new work. Historical `ve/` paths in the table below are legacy references only.


| Query | Proof |
|---|---|
| `?ve=two-client` | Wait for remote `PlayerPose` humanoids; HUD `remotes:` + `Two-client OK` |
| `?ve=minimap` | Seed crowd + dummy; prove top-right 2D minimap dots (`ve/babylon-minimap.png`) |
| `?ve=minimap-read` | Party + self blips + compass readability vs grass/cyan fog (#61) (`ve/babylon-minimap-read.png`) |
| `?ve=bag` | Prove You+XP self-frame, staff/Spark/Emberbolt loadout strip, B bag panel (`ve/babylon-bag.png`) |
| `?ve=hotbar` / `?ve=target-frame` | Select Dummy + cast; prove empty slots + STAFF disabled + OOM affordances (`ve/babylon-hotbar.png`) |
| `?ve=hotbar-afford` | Affordance polish proof: empty vs STAFF vs OOM at play cam (`ve/babylon-hotbar-afford.png`) |
| `?ve=gcd` | Thicker GCD sweep + Emberbolt cast fill on hotbar slots (`ve/babylon-gcd.png`) |
| `?ve=debug-hud` | Force `#status` + `#fpsHud` visible; HUD `Debug HUD OK · status visible · F3/?debug=1` (`ve/babylon-debug-hud.png`) |
| `?ve=target-frame` | Tab-select Dummy; prove compact name+HP frame above combat bars (`ve/babylon-target-frame.png`) |
| `?ve=reticule` | Select Dummy; prove gold ring + overhead marker (`ve/babylon-reticule.png`); HUD `Reticule OK · … · gold ring+marker` |
| `?ve=target-contrast` | Select Dummy; prove gold `#targetFrame` + world reticule crisp under #39 cyan fog (`ve/babylon-target-contrast.png`); HUD `Target-contrast OK · gold frame+reticule · … · fog crisp` |
| `?ve=keys` | Open keybind legend overlay (H); HUD `Keys legend OK · …` (`ve/babylon-keys.png`) |
| `?ve=death-ux` | Kill self via Dummy; prove stronger greyout + live respawn countdown + death toast (`ve/babylon-death-ux.png`); HUD `Death UX OK · …` |
| `?ve=cast-range` | Move beyond CastRangeMeters; outOfRange toast + dim hotbar (`ve/babylon-cast-range.png`) |
| `?ve=cast-range-ring` | Selected Dummy beyond cast range; Babylon ground reach ring (`ve/babylon-cast-range-ring.png`); HUD `Cast-range ring OK · …` |
| `?ve=cast-cancel` | Emberbolt windup → Move interrupt; clear cast bar + CANCEL toast (`ve/babylon-cast-cancel.png`) |
| `?ve=cast-feedback` | Prominent Emberbolt cast bar + CANCEL ≠ LOCKOUT toasts + Rest enter chrome (`ve/babylon-cast-feedback.png`) |
| `?ve=castbar-read` | Cast / CANCEL / LOCKOUT chrome readable over #39 cyan fog (`ve/babylon-castbar-read.png`); HUD `Castbar-read OK · … · fog chrome` |
| `?ve=bandage` | BuyYardBandage + UseBandage HP heal; toast/bag (`ve/babylon-bandage.png`) |
| `?ve=humanoid` | Frame local procedural humanoid + staff |
| `?ve=dummy` | Frame scarecrow/practice dummy (wood+canvas) under #39 lights (`ve/babylon-dummy.png`) |
| `?ve=floater-read` | Damage/heal/XP floaters with thick outline under #39 fog (`ve/babylon-floater-read.png`) |
| `?ve=quaternius-char` | Quaternius CC0 wizard at 8–15m under #39 lights (`ve/babylon-quaternius-char.png`) |
| `?ve=frame-hp` | Self + party HP bars mid/low contrast over cyan fog (#67) (`ve/babylon-frame-hp.png`) |
| `?ve=combat-log-read` | Combat log strip readability over cyan fog (#78) (`ve/babylon-combat-log-read.png`) |
| `?ve=atmosphere` | Yard mood: blue/cyan fog + warm sun/cool hemi + lush ground (`ve/babylon-atmosphere.png`) |
| `?ve=spell-vfx` | Spark cyan flash+bolt+impact + Emberbolt staff charge→projectile→impact (`ve/babylon-spell-vfx.png`) |
| `?ve=path-ground` | Dirt/stone trail vs lush grass (#44) (`ve/babylon-path-ground.png`) |
| `?ve=sky-horizon` | Layered mountain silhouette + fog-matched sky (#55) (`ve/babylon-sky-horizon.png`) |
| `?ve=vendor-stall` | Shop silhouette posts+counter+awning under #39 fog (#58) (`ve/babylon-vendor-stall.png`) |
| `?ve=forest` / `?ve=quaternius-env` / `?ve=aoi` / `?ve=combat` / `?ve=persist` | Forest / Quaternius Standard env (`ve/babylon-quaternius-env.png`) |


Debug HUD (`#status` identity/AOI wall + `#fpsHud`) is **hidden by default**. Show with `?debug=1` / `?debug=true`, or toggle with **F3** (ignored while `#chatInput` is focused). `#persistMark` stays available for any `?ve=` mode.

Headless second identity (shared-yard): `dotnet run --project ../tools/SecondClient` while Vite watches remotes.

