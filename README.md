# Fardel

Browser-first, classless MMORPG: **your pack is your build**.

*Fardel* (archaic): a pack, a burden, the load a traveler carries. There are no locked classes — skills, gear, and what you keep in the bag decide who you are (RuneScape soul, Reliquary fantasy).

**Feel:** [hordes.io](https://hordes.io/play)-like controls (RMB camera, WASD, tab-target) with WoW-scale ambition.  
**Stack:** SpacetimeDB **C#** modules + **Babylon.js 9 / TypeScript / Vite** browser client (`web/`).  
**Status:** module + headless smokes through slice 4 (AOI); active client is Babylon (see [ADR 0003](docs/adr/0003-babylon-web-client.md)).

**Live hosts:** [play.sparkify.dev](https://play.sparkify.dev) · [dev-db.sparkify.dev](https://dev-db.sparkify.dev) (SpacetimeDB preview)

## Docs

| Doc | What it covers |
|---|---|
| [docs/SCOPE.md](docs/SCOPE.md) | Focus contract: north-star, now/not-now |
| [docs/VISION.md](docs/VISION.md) | Pillars, fantasy, what we are not building |
| [docs/STACK.md](docs/STACK.md) | Locked tech choices and why |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Netcode, AOI, sim authority, perf laws |
| [docs/MVP.md](docs/MVP.md) | Slice plan to a playable yard |
| [docs/PLAN_BABYLON.md](docs/PLAN_BABYLON.md) | Babylon.js client plan + env |
| [docs/ASSETS.md](docs/ASSETS.md) | POC art: forest, mountains, RS-like humanoid |
| [docs/LEARNINGS.md](docs/LEARNINGS.md) | What we take from prior POCs + hordes/dek |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Cloudflare / sparkify.dev / Mac tunnel |
| [docs/adr/0001-aoi-interest.md](docs/adr/0001-aoi-interest.md) | AOI: chunk neighborhood, hysteresis, load shed |
| [docs/adr/0002-client-host-webgpu.md](docs/adr/0002-client-host-webgpu.md) | Historical Unity host (superseded for active host) |
| [docs/adr/0003-babylon-web-client.md](docs/adr/0003-babylon-web-client.md) | Active client: Babylon.js + TypeScript |

## Quick start (local)

```bash
./tools/scripts/ensure-local-spacetime.sh
# publish module from server/, then:
dotnet run --project tools/ConnectSmoke
# browser client:
cd web && # install + run Vite (see web/README.md)
```

Unity WebGL checkpoint (not on `main`): branch `checkpoint/unity-webgl` @ `ca9b7d5`.

## Prior art (not this repo)

- [antonybstack/unbound](https://github.com/antonybstack/unbound) — Rust / Bevy / SpacetimeDB action-RPG POC
- [antonybstack/spacetimedb-mmo-poc](https://github.com/antonybstack/spacetimedb-mmo-poc) — earlier SpacetimeDB experiments

Fardel is a **greenfield** reboot: keep the SpacetimeDB and intent-netcode lessons; ship tab-target / classless progression with a C# module and a code-first web client.

## License

MIT — see [LICENSE](LICENSE).
