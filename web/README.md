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

| Query | Proof |
|---|---|
| `?ve=two-client` | Wait for remote `PlayerPose` humanoids; HUD `remotes:` + `Two-client OK` |
| `?ve=minimap` | Seed crowd + dummy; prove top-right 2D minimap dots (`ve/babylon-minimap.png`) |
| `?ve=bag` | Prove You+XP self-frame, staff/Spark/Emberbolt loadout strip, B bag panel (`ve/babylon-bag.png`) |
| `?ve=hotbar` / `?ve=target-frame` | Select Dummy + cast Spark/Emberbolt; prove target frame + spell hotbar (`ve/babylon-hotbar.png`) |
| `?ve=target-frame` | Tab-select Dummy; prove compact name+HP frame above combat bars (`ve/babylon-target-frame.png`) |
| `?ve=cast-cancel` | Emberbolt windup → Move interrupt; clear cast bar + CANCEL toast (`ve/babylon-cast-cancel.png`) |
| `?ve=humanoid` | Frame local procedural humanoid + staff |
| `?ve=forest` / `?ve=aoi` / `?ve=combat` / `?ve=persist` | Slice presentation shots |

Headless second identity (shared-yard): `dotnet run --project ../tools/SecondClient` while Vite watches remotes.

