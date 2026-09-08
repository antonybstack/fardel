# Team seats (agent worktrees)

Parallel coding + QA agents on the **Mac Studio** (or the Linux box) without colliding with each other **or with production**.

For Mac Studio + Grok CLI setup, see [MAC_STUDIO_GROK_CLI.md](MAC_STUDIO_GROK_CLI.md). Historical 3001–3005 ports are **retired** — they sat next to prod `:3000`.

Production on this Studio is live:

| Surface | Binding | Who uses it |
|---------|---------|-------------|
| SpacetimeDB preview/prod | `0.0.0.0:3000` · data `~/.local/share/spacetime/data` · db **`fardel`** | `dev-db.sparkify.dev` tunnel · [play.sparkify.dev](https://play.sparkify.dev) |
| Cloudflare Pages | `play.sparkify.dev` | Players (not local Vite) |
| Human lead Vite | `127.0.0.1:5173` | You, on this checkout |

**Agents never bind 3000 or 5173, never publish db `fardel`, never use the prod data dir, never add ports to cloudflared.**

Scale: **2 seats** (1 dev + 1 QA) up to **12 developers + 8 QA** (`tools/scripts/seats.conf`). Formula ports sit far from prod:

| Role | Slug | Spacetime | Vite | Database |
|------|------|-----------|------|----------|
| lead (prod) | `lead` | 3000 | 5173 | `fardel` |
| developer | `dev-1` … `dev-12` | 3201–3212 | 5201–5212 | `fardel-dev-1` … |
| QA | `qa-1` … `qa-8` | 3241–3248 | 5241–5248 | `fardel-qa-1` … |

Aliases: `dev1` → `dev-1`, `qa-bugs` → `qa-1`, `qa-feel` → `qa-2`. `lead` is **read-only** for agent scripts (they refuse it).

## Git workflow

| Branch | Role |
|--------|------|
| `main` | **Release** / production tip. Do not open feature PRs against `main`. |
| `develop` | **PR target** for day-to-day work. |
| `seats/<slug>` | Per-seat worktree branch created by `seat-claim.sh`. |

Worktrees: `$HOME/dev/wt/<slug>` (override `FARDEL_WT_ROOT` in `tools/scripts/seats.local.conf`). This path is **not** derived from the script checkout — running from `~/dev/wt/dev-1` still uses `~/dev/wt`, never `~/dev/wt/wt`. The release clone stays at `/Users/antbly/dev/fardel` (`FARDEL_LEAD_ROOT`). Grok Bot box: `FARDEL_WT_ROOT=/workspace/wt`.

Do **not** delete existing worktrees.

Claims: `$HOME/.local/share/fardel-seats/claims/<slug>`.  
Agent Spacetime data: `$HOME/.local/share/fardel-wt/<slug>` — **not** `~/.local/share/spacetime/data`.

## Commands

```bash
# 1 developer + 1 QA  (or loop 6× --role dev and 4× --role qa)
./tools/scripts/seat-claim.sh --role dev
./tools/scripts/seat-claim.sh --role qa

./tools/scripts/seat-list.sh

# Start isolated stdb + publish module + Vite (prod :3000 stays up)
./tools/scripts/seat-up.sh dev-1
./tools/scripts/seat-up.sh qa-1

# Client URL always carries db+module so the tab cannot hit prod
./tools/scripts/seat-url.sh qa-1
# → http://127.0.0.1:5241/?db=http://127.0.0.1:3241&module=fardel-qa-1

source tools/scripts/wt-env.sh qa-1
dotnet run --project tools/ConnectSmoke

# Playwright (QA seats) — Metal, unique profile, refuses prod URL
(cd tools/qa && npm ci && npx playwright install chromium)
node tools/qa/play.mjs --seat qa-1 screenshot
node tools/qa/play.mjs --seat qa-1 move --key w --ms 800

./tools/scripts/seat-down.sh qa-1          # stop processes, keep claim
./tools/scripts/seat-release.sh qa-1       # free the slot
```

`seat-up.sh` pings prod before and after; if `:3000` dies, it exits 3 and does **not** restart prod.

Headless smokes honor `FARDEL_SPACETIME_URI` / `FARDEL_DB` via `GameConstants.ResolveLocalUri()` / `ResolveDatabaseName()`.

## Prod safety (non-negotiable)

1. `ensure-local-spacetime.sh` is the **human prod/preview** helper. Agents that have `FARDEL_SEAT` set are refused.
2. `ensure-seat-spacetime.sh` / `seat-up` / `seat-down` / `seat-release` / `tools/qa/play.mjs` refuse `lead`, port 3000, port 5173, db `fardel`, `dev-db.sparkify.dev`, and the prod data dir.
3. Agent SpacetimeDB listens on **`127.0.0.1:32xx` only** (not `0.0.0.0`). The tunnel stays pointed at `:3000`.
4. Do not add `5200`/`3200` hostnames to `~/.cloudflared/config.yml`.
5. Do not `pkill spacetime` / `killall node`. `seat-down` kills **that seat’s listen port** after checking it is not prod.
6. Do not write `web/.env.local` in the lead checkout. `--no-worktree` uses `?db=` / `?module=` instead.
7. Playwright never opens `play.sparkify.dev`.
8. `window.__qa` exists in **Vite dev** only (not the Pages build).

## Isolation vs share

| Share on the host | Isolate per seat |
|-------------------|------------------|
| OS, Homebrew, .NET, Node, `spacetime` CLI, Playwright browsers, GPU | git worktree (`seats/<slug>`) |
| Model API keys | SpacetimeDB `--listen-addr` + `--data-dir` + **db name** |
| `web/node_modules` (symlinked from lead if missing) | Vite port + `.env.local` in the worktree |
| | Playwright `userDataDir` + artifact folder |

Do **not** isolate by moving the real macOS mouse. Drive the game with Playwright + `window.__qa` (`holdMove`, `lookDelta`, `screenshotScene`). Authority proof stays `tools/*Smoke`.

## Proof

```bash
./tools/scripts/seat-selftest.sh
```

Claims one `dev-*` and one `qa-*`, starts extra SpacetimeDBs, asserts unique ports/db names, downs them, asserts the original `:3000` pid is unchanged.

## Linux box

Historical `/workspace/wt/dev1` + ports 3001–3005 are **retired** — they sat next to prod 3000. Use this formula everywhere. Overlay paths with `tools/scripts/seats.local.conf` (`FARDEL_WT_ROOT=/workspace/wt`).
