# Slice 0 — local connect

## Prereqs

1. SpacetimeDB CLI 2.10+
2. .NET 10 SDK (+ WASI workload if macOS module publish requires it):

```bash
sudo dotnet workload install wasi-experimental
```

3. JS runtime 22+ (for `web/` Vite client)
4. Pin `@babylonjs/core@9.0.0` in `web/`

## Run (authority)

```bash
# Terminal A — prefer keepalive helper
./tools/scripts/ensure-local-spacetime.sh

# Terminal B
cd server
spacetime publish
```

Headless gate:

```bash
dotnet run --project tools/ConnectSmoke
```

Expect: `OK: connected identity …`

## Run (Babylon presentation)

```bash
# Generate TS bindings when local module is up:
spacetime generate --lang typescript --out-dir web/src/module_bindings --project-path server

cd web
# install deps via package manager, then:
#   run the Vite dev script (see web/README.md)
```

**Done when:** ConnectSmoke is green; browser HUD shows **Connected** and an identity.

Unity Editor / `client/` is **not** required on `main` (see `checkpoint/unity-webgl`).

## Local SpacetimeDB keepalive

Do **not** start `spacetime` as a bare background job inside an agent shell (`spacetime start &`). Those shells get aborted and take the DB with them (connection refused, empty crash log).

Use:

```bash
./tools/scripts/ensure-local-spacetime.sh
```

It pings first, disables corrupting Homebrew `wasm-opt`, and starts with a detached session (`setsid` / `nohup`+`disown`) plus `--non-interactive`.
