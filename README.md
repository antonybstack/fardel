# Fardel

Browser-first, classless MMORPG: **your pack is your build**.

*Fardel* (archaic): a pack, a burden, the load a traveler carries. There are no locked classes — skills, gear, and what you keep in the bag decide who you are (RuneScape soul, Reliquary fantasy).

**Feel:** [hordes.io](https://hordes.io/play)-like controls (RMB camera, WASD, tab-target) with WoW-scale ambition.  
**Stack:** C# everywhere that matters — SpacetimeDB C# modules + Unity 6.6+ (WebGPU) client.  
**Status:** docs-first. Implementation not started.

**Live hosts:** [play.sparkify.dev](https://play.sparkify.dev) (placeholder) · [dev-db.sparkify.dev](https://dev-db.sparkify.dev) (SpacetimeDB preview)

## Docs

| Doc | What it covers |
|---|---|
| [docs/VISION.md](docs/VISION.md) | Pillars, fantasy, what we are not building |
| [docs/STACK.md](docs/STACK.md) | Locked tech choices and why |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Netcode, AOI, sim authority, perf laws |
| [docs/MVP.md](docs/MVP.md) | Slice plan to a playable yard |
| [docs/LEARNINGS.md](docs/LEARNINGS.md) | What we take from prior POCs + hordes/dek |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Cloudflare / sparkify.dev / Mac tunnel |

## Prior art (not this repo)

- [antonybstack/unbound](https://github.com/antonybstack/unbound) — Rust / Bevy / SpacetimeDB action-RPG POC
- [antonybstack/spacetimedb-mmo-poc](https://github.com/antonybstack/spacetimedb-mmo-poc) — earlier SpacetimeDB experiments

Fardel is a **greenfield** reboot: keep the SpacetimeDB and intent-netcode lessons, drop Bevy/action-combat for C# / Unity / tab-target / classless progression.

## License

MIT — see [LICENSE](LICENSE).
