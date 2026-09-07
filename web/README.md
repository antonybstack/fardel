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
