# Team seats (agent worktrees)

Parallel agent seats on the shared Linux box. Each seat has its own **git worktree**, **SpacetimeDB port + data dir**, **Vite port**, and **database name** so agents do not stomp each other.

## Git workflow

| Branch | Role |
|--------|------|
| `main` | **Release** / production tip. Do not open feature PRs against `main`. |
| `develop` | **PR target** for day-to-day work. Land features here first. |

Seat worktrees live under `/workspace/wt/<slug>` on branches `seats/<slug>` (except **lead**, which is `/workspace/fardel` on `develop` / `main`).

Do **not** delete existing worktrees under `/workspace/wt/`.

## Roster

| Seat | Spacetime port | Vite port | DB name | Worktree |
|------|----------------|-----------|---------|----------|
| `dev1` | 3001 | 5174 | `fardel-dev1` | `/workspace/wt/dev1` |
| `dev2` | 3002 | 5175 | `fardel-dev2` | `/workspace/wt/dev2` |
| `dev3` | 3003 | 5176 | `fardel-dev3` | `/workspace/wt/dev3` |
| `dev4` | 3004 | 5177 | `fardel-dev4` | `/workspace/wt/dev4` |
| `dev5` | 3005 | 5178 | `fardel-dev5` | `/workspace/wt/dev5` |
| `qa-bugs` | 3011 | 5184 | `fardel-qa-bugs` | `/workspace/wt/qa-bugs` |
| `qa-feel` | 3012 | 5185 | `fardel-qa-feel` | `/workspace/wt/qa-feel` |
| `lead` | 3000 | 5173 | `fardel` | `/workspace/fardel` |

Canonical map file: [`tools/scripts/fardel-seats.env`](../tools/scripts/fardel-seats.env) (`slug|spacetime_port|vite_port|db_name|worktree_path`).

Per-seat Spacetime data: `$HOME/.local/share/fardel-wt/<slug>`.

## Commands

1. Load seat env: `tools/scripts/wt-env.sh` — pass the seat slug as the first argument and **source** the script. Exports `FARDEL_SEAT`, `FARDEL_SPACETIME_PORT`, `FARDEL_SPACETIME_URI`, `FARDEL_DB`, `FARDEL_VITE_PORT`, `FARDEL_DATA_DIR`, and `FARDEL_WT`.

2. Ensure SpacetimeDB for that seat: run `tools/scripts/ensure-seat-spacetime.sh` with the same slug. It sources `wt-env.sh`, starts a detached instance listening on `127.0.0.1:$FARDEL_SPACETIME_PORT` with `--data-dir $FARDEL_DATA_DIR` and `--non-interactive`, then polls `$FARDEL_SPACETIME_URI/v1/ping` until ready.

3. Publish module (env loaded): from `$FARDEL_WT/server`, publish database name `$FARDEL_DB` to server `$FARDEL_SPACETIME_URI` (local env, non-interactive yes).

4. Vite client: from `$FARDEL_WT/web`, start the Vite dev server on port `$FARDEL_VITE_PORT` bound to `127.0.0.1`.

Lead seat (`lead` / ports 3000 + 5173) matches the historical single-instance defaults documented in [DEV_BOX.md](DEV_BOX.md).
