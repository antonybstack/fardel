# Campaign

How Fardel moves from the **yard POC** toward a **hordes.io / WoW-readable session** on [play.sparkify.dev](https://play.sparkify.dev).

Ambition: [VISION.md](VISION.md). Leash: [SCOPE.md](SCOPE.md). Day-to-day loop: [ORCHESTRATION.md](ORCHESTRATION.md).

**Source of work items:** GitHub Issues only. This page is the **wave plan**, not a second backlog. Lead files the active wave’s Issues, then assigns.

## Scoreboard

A change counts when it is on **`main` + Pages**. `develop` merges are not the product.

Score the farm on this session, not PR count:

> A stranger opens https://play.sparkify.dev, lasts about 10 minutes, and the loop feels like hordes (tab-target, GCD, corpses, other people) in a place that reads like a small WoW yard — not a HUD demo.

## One active wave

- Work **one** wave at a time.
- Each wave is 4–8 Issues and a **session Done-when** you can feel on Pages.
- Do not file or implement the next wave until the current wave is **on Pages** (or explicitly waived here).
- Empty Issues board → Lead (or Art) files the **next wave from this page**. Do not invent HUD chrome to keep seats busy.

## Waves

| Wave | Status | Session Done-when on play.sparkify.dev |
|------|--------|----------------------------------------|
| **0. Ship the yard** | **in flight** | Frozen-pin cut of `develop` @ `00cfbcfe` → `main` → Pages. Live site has the post-#199 feel/smoke work (interpolation, jump presence, loot F, rest exit, fog chrome, …). |
| **1. The yard hunts back** | next | 2–3 hostile types, aggro/leash, corpse loot as the reason to stay. Dummy is a trainer, not the game. |
| **2. Other players matter** | later | You can fight or contest another client in the yard. Death/loot rules readable. |
| **3. A second place** | later | A path to a second clearing (not an open world). Minimap N means somewhere. |
| **4. A deeper book** | later | 4 hotbar skills with roles (filler / windup / interrupt / self). Shared GCD stays. |
| **5. Look-language** | later | One credited/free pack pass for humanoid + forest vs kitbash ([ASSETS.md](ASSETS.md) #31). Art files Issues; Devs implement. |

### Wave 0 — Ship the yard

- **Done-when:** `https://play.sparkify.dev` HTTP 200 on the pin; VE `https://ve.sparkify.dev/release/<pin>/play.png`; no open P0 on the pin.
- **How:** branch `release/<shortsha>` from the frozen SHA; PR **that branch** → `main` (never live `develop`). Bindings arity + smoke matrix (exit code + `results.tsv`). Then Pages deploy.
- **Must not:** merge a `develop`→`main` PR whose head follows later merges (#224 failure mode).

### Wave 1 — The yard hunts back (file when Wave 0 is on Pages)

Session Done-when: in one browser on Pages, you can pull a hostile, kill it, loot the corpse, and another hostile can aggro you if you stay close. Dummy may remain as a trainer.

Suggested Issues (Lead files; do not invent past these):

1. `lane:server` — Hostile NPC type + spawn in the yard (not only Dummy). Smoke: pack/hostile HP + death.
2. `lane:server` — Aggro / leash (intent-based; no client positions). Smoke: enter/leave range.
3. `lane:server` + `lane:client` — Corpse loot on hostile death (reuse WorldLoot). VE `?ve=hunt-loot`.
4. `lane:client` `feel` — Hostile telegraph / nameplate vs Dummy (readable at play cam). VE `?ve=hostile-read`.

Serialize the schema tickets (one Dev at a time). Client feel can parallel after spawn exists.

### Waves 2–5

File only when the previous wave’s session Done-when is true on Pages. Keep 4–8 Issues. Same labels. No auction house, continents, 20-spell books, paid packs — see SCOPE **Not now**.

## Empty board

If Devs are idle and there is no open wave Issue:

1. Is the **active wave** Done-when true on Pages? If no, file the missing wave Issue or unstick Release.
2. If yes, mark the wave done here, file the **next** wave’s Issues, assign.
3. Never farm P2 toast/chrome tickets to occupy seats.

## Parallelism

- One `lane:server` schema Dev at a time.
- Second Dev: client presentation / feel on files the schema Dev is not touching.
- Do not put two Devs in `web/src/main.ts` for cosmetics during a systems wave.
- Cap 2 Devs until a wave has three non-overlapping lanes. Do not add Dev4 because the board is empty.
