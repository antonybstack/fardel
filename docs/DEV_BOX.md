# Fardel on the Linux box (no Mac)

Self-contained local loop for this shared box agent environment. Paths assume the repo at `/workspace/fardel`.

## Toolchain (as of box setup)

| Tool | Location / version |
|------|--------------------|
| .NET SDK | `$HOME/.dotnet` — **10.0.400** and **8.0.424** (`dotnet --list-sdks`). Module TFM is `net8.0`; smokes/tools use SDK 8 with rollForward. |
| SpacetimeDB CLI | `$HOME/.local/bin/spacetime` → **2.10.0** (`spacetime version use 2.10.0` if needed) |
| SpacetimeDB server | `http://127.0.0.1:3000` (standalone data: `$HOME/.local/share/spacetime/data`) |
| Node | `$HOME/.local/node22/bin` — **v22.19.0** (put on `PATH`) |

Shell profile snippet (already useful in `~/.bashrc`):

```bash
export DOTNET_ROOT=$HOME/.dotnet
export PATH="$HOME/.local/node22/bin:$DOTNET_ROOT:$DOTNET_ROOT/tools:$HOME/.local/bin:$PATH"
```

Install notes:

- .NET: `curl -L https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh && bash /tmp/dotnet-install.sh --channel 10.0` (and `--channel 8.0` for the module TFM).
- WASI: `dotnet workload install wasi-experimental` (CLI may also install packs during first `spacetime publish`).
- SpacetimeDB: `curl -sSf https://install.spacetimedb.com | sh -s -- -y` then `spacetime version install 2.10.0 --use -y`.

## Start local DB (detached)

Do **not** use bare `spacetime start &` in an agent shell — it dies on abort. Use:

```bash
cd /workspace/fardel
./tools/scripts/ensure-local-spacetime.sh
```

Linux path uses `setsid -f spacetime start --non-interactive`. Ping: `http://127.0.0.1:3000/v1/ping`.

Log default: `./spacetime-start.log` under the cwd you launched from.

## Publish C# module

```bash
export DOTNET_ROOT=$HOME/.dotnet
export PATH="$HOME/.local/bin:$DOTNET_ROOT:$PATH"
cd /workspace/fardel/server
spacetime publish fardel -y --env local
```

Uses `spacetime.json` + `spacetime.local.json` (`module-path` `./spacetimedb`, database name `fardel`). Optional: install `wasm-opt` (binaryen) for smaller WASM; publish still works without it.

## Headless smoke

```bash
cd /workspace/fardel
dotnet run --project tools/ConnectSmoke
```

Expect: `OK: connected identity …`. Smokes compile generated C# under `client/Assets/Scripts/Spacetime/Generated/` (bindings only; full Unity client is on `checkpoint/unity-webgl`).

Regenerate C# bindings if the module schema changes:

```bash
spacetime generate --lang csharp \
  --out-dir client/Assets/Scripts/Spacetime/Generated \
  --module-path server/spacetimedb
```

## Web client (Babylon 9)

```bash
export PATH="$HOME/.local/node22/bin:$PATH"
cd /workspace/fardel/web
npm ci          # or npm install
npm run build   # must succeed with @babylonjs/core@9.0.0
npm run dev     # Vite → http://127.0.0.1:5173
```

Generate / refresh TS bindings:

```bash
cd /workspace/fardel
spacetime generate --lang typescript \
  --out-dir web/src/module_bindings \
  --module-path server/spacetimedb
```

Default client URI/DB: `http://127.0.0.1:3000` / `fardel`. Override with `?db=` / `?module=`.

## Ports

| Port | Service |
|------|---------|
| 3000 | SpacetimeDB HTTP/WS |
| 5173 | Vite dev server |

## One-shot checklist

```bash
export DOTNET_ROOT=$HOME/.dotnet
export PATH="$HOME/.local/node22/bin:$DOTNET_ROOT:$HOME/.local/bin:$PATH"
cd /workspace/fardel
./tools/scripts/ensure-local-spacetime.sh
(cd server && spacetime publish fardel -y --env local)
dotnet run --project tools/ConnectSmoke
(cd web && npm ci && npm run build && npm run dev)
```
