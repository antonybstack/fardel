# Scope contract

This page keeps Fardel **on the yard path**. Ambition lives in [VISION.md](VISION.md); **execution order** lives here and in [MVP.md](MVP.md).

If a task does not move the current slice’s **Done when**, it waits.

## North-star demo (POC complete)

> Two browser clients in a **forest clearing** with huge trees and distant mountains: **RS-simple** staff/robe humans, WASD + RMB camera, tab-target a dummy, cast **Spark** and **Emberbolt** on a **shared GCD**, refresh and keep XP + loadout, without subscribing the whole map.

That sentence is the finish line. Everything else is either a slice toward it or **out of scope**.

## One active slice

- Work **one** MVP slice at a time (0 → 4).
- Do not start slice N+1 features “while we’re here” until slice N’s **Done when** is met (or explicitly waived in chat + a one-line note here).
- Proof > polish: a failing smoke script blocks “slice done.”

## Now / next / not now

### Now (until POC north-star)

| In | Out (park it) |
|---|---|
| Slice 0–4 only ([MVP.md](MVP.md)) | Open world, zones, mounts, trading |
| Staff/robes + 2 spells + GCD | Skill trees, more spells, talents |
| Kitbash forest + mountains + humanoid ([ASSETS.md](ASSETS.md)) | Custom character creator, photoreal, cinema VFX |
| Chunk AOI as designed ([ADR 0001](adr/0001-aoi-interest.md)) | Coarse network LOD, LOS interest, multiple shards |
| SpacetimeDB module + Shared + headless smokes | Second client engine / custom WebGPU from scratch |
| Babylon.js web client (active) — [ADR 0003](adr/0003-babylon-web-client.md) | Unity client (paused on `checkpoint/unity-webgl`) |
| `play` Pages + `dev-db` preview tunnel | Prod MainCloud / `db.sparkify.dev` hard cutover |
| Span-first / zero-heap **discipline** in new C# | Premature micro-optim hunt with no slice-4 numbers |

### Next (after north-star — still not “now”)

- Pick real asset packs + fill credits ledger
- Prod authority host decision
- Party / always-relevant wiring beyond self+target
- Optional: staff-unequip affects casts (slice 3 nice-to-have)
- Coarse pose tier only if metrics demand (ADR 0001 follow-up)

### Not now (explicit anti-goals)

Do **not** start these until the north-star demo exists:

- Full classless skillscape / RS skill list
- Auction house, clans, quests, housing
- Action combat / lock-on souls hybrid
- Dual client (Unity + Babylon in parallel for players)
- Replacing SpacetimeDB or rewriting in Rust “for perf”
- Perfect UI chrome, settings menus, tutorial systems
- World editor / content pipeline beyond placing pack assets in one yard scene
- Mobile-native client
- Monetization / accounts product surface beyond SpacetimeDB identity

## Distraction triggers (say no)

If an idea sounds like any of these, park it in a note — don’t branch the plan:

- “While we’re in the scene, let’s add a second biome / cave / town.”
- “We should build the full bag UI before move feels good.”
- “Let’s evaluate Stride / Bevy / custom WebGPU again.”
- “We need 20 spells so combat isn’t boring.”
- “Prod scale / 10k CCU design before two clients share a dummy.”
- “General-purpose engine framework for future games.”
- “Bring Unity back onto main before Babylon Connect is green.”

## Decision gate

| Kind of change | What to do |
|---|---|
| Moves current slice Done when | Just do it |
| Changes locked stack / AOI / client host | ADR + update STACK/ARCHITECTURE |
| New gameplay system not in north-star | Add to **Not now**; do not implement |
| Art pack choice | Fits [ASSETS.md](ASSETS.md); one env + one character; record credits |
| Unsure | Default **no**; ask in chat with the slice id |

## Locked docs (don’t re-litigate weekly)

| Topic | Where |
|---|---|
| Fantasy / pillars | [VISION.md](VISION.md) |
| Stack | [STACK.md](STACK.md) |
| Net / sim / C# perf | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Slices | [MVP.md](MVP.md) |
| Art bar | [ASSETS.md](ASSETS.md) |
| AOI | [ADR 0001](adr/0001-aoi-interest.md) |
| Client host (active) | [ADR 0003](adr/0003-babylon-web-client.md) |
| Historical Unity / WebGPU | [ADR 0002](adr/0002-client-host-webgpu.md) (superseded for active host) |
| Babylon plan | [PLAN_BABYLON.md](PLAN_BABYLON.md) |

Revisit locks only with a new ADR (or an explicit superseding decision), not drive-by chat.

## Proof culture (execution)

Prove authority with headless smokes first; Babylon presentation follows:

- `tools/ConnectSmoke` (slice 0)
- `tools/MoveSmoke` (slice 1)
- `tools/CombatSmoke` (slice 2)
- `tools/PersistSmoke` (slice 3)
- `tools/AoiSmoke` (slice 4)

Browser Connect / yard art lives in `web/` (Vite + Babylon). Unity is not required for slice gates.

## Weekly focus check

Before starting work, answer:

1. Which **slice** am I on?
2. Does this task change that slice’s **Done when**?
3. If no — stop, or file under Not now.

## Status

- **Phase:** **post-slice-4 invent** — AOI presentation green; forest kitbash in Babylon yard
- **Web milestone (Unity):** checkpointed on `checkpoint/unity-webgl` (`ca9b7d5`); Unity tree removed from `main`
- **Active client:** **Babylon.js + TypeScript** (code-first); SpacetimeDB C# module + headless smokes unchanged (see ADR 0003)
- **Babylon presentation:** Connect / Move / Combat / Persist / **AOI** green; **forest kitbash** (`ve/babylon-forest.png`); **humanoid+staff**; **second-client shared yard** green (`ve/babylon-two-client.png`); **remote cast/target telegraphs** (`ve/babylon-remote-cast.png`); **floating damage numbers** (`ve/babylon-damage-text.png`)
- **POC north-star:** closer — remaining invent: credited art packs for humanoid; party / always-relevant polish; redeploy Pages
