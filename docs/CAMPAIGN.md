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
- A wave has a **session Done-when** you can feel on Pages. The 24h hop/body/place slice was ~9 Issues/lane and finished in a few farm hours — the **12h** wave is three fat epics (~12 Issues each) so the seats stay busy.
- Do not file or implement the next wave until the current wave is **on Pages** (or explicitly waived here).
- Empty Issues board → Lead (or Art) files the **next wave from this page**. Do not invent HUD chrome to keep seats busy.

## Waves

| Wave | Status | Session Done-when on play.sparkify.dev |
|------|--------|----------------------------------------|
| **0. Ship the yard** | **done** | Frozen pin `00cfbcfe` on `main` (#246). Pages 200. VE `https://ve.sparkify.dev/release/00cfbcfe/play.png`. |
| **24h hop / body / place** | **done** | Pin `2d869151` / #320. persistMark `Idle OK · Idle_Weapon · skinned 1`. VE https://ve.sparkify.dev/release/2d869151/idle.png. Hop+place were already on the prior pin. |
| **12h character / place / encounter** | **active** | See [PARITY.md](PARITY.md) E8/E9/E10. Person at play cam, denser solid forest at ≥30 FPS, Tab-target hunt + WoW camera. |
| **1. The yard hunts back** | **absorbed** | Hunt tickets live inside E10 (encounter). Do not file a second hunt wave. |
| **2. Other players matter** | later | You can fight or contest another client in the yard. Death/loot rules readable. |
| **3. A second place** | later | A path to a second *zone* (not an open world). E9.4 is only a receding silhouette, not this wave. |
| **4. A deeper book** | later | 4 hotbar skills with roles (filler / windup / interrupt / self). Shared GCD stays. **Parked.** |
| **5. Look-language** | later | One credited/free pack pass for humanoid + forest vs kitbash ([ASSETS.md](ASSETS.md) #31). E8/E9 polish the current packs; do not buy. |

### Wave 0 — Ship the yard

- **Done-when:** `https://play.sparkify.dev` HTTP 200 on the pin; VE `https://ve.sparkify.dev/release/<pin>/play.png`; no open P0 on the pin.
- **How:** branch `release/<shortsha>` from the frozen SHA; PR **that branch** → `main` (never live `develop`). Bindings arity + smoke matrix (exit code + `results.tsv`). Then Pages deploy.
- **Must not:** merge a `develop`→`main` PR whose head follows later merges (#224 failure mode).

### 12h character / place / encounter (active)

Session Done-when on [play.sparkify.dev](https://play.sparkify.dev):

1. **Character** — default play cam is a person (staff gripped Idle, Walk+Run, jump/fall pose, death pose, remotes not T, Emberbolt holds Spell). `?ve=character-wow`.
2. **Environment** — cannot walk through trunks; mid-forest instanced; ≥30 FPS; path recedes to a second silhouette. `?ve=place-wow` vs [hordes place ref](https://ve.sparkify.dev/parity/hordes-place-ref.jpg).
3. **Encounter** — RMB orbit without clipping trunks; zoom stops; Tab a hostile; it hits back; kill; loot. Dummy stays a trainer. `?ve=encounter`.

Epics: **E8** #323 Dev3 (`humanoid.ts`) · **E9** #324 Dev4 (`forest.ts`) · **E10** #325 Dev2 (camera + hunt schema). Queues in `LOOP.md`.

### Wave 1 — absorbed by E10

Do not file a parallel hunt wave. Hostile spawn/aggro/attack/loot are E10.4–E10.7.

### Waves 2–5

File only when the 12h session Done-when is true on Pages. No auction house, continents, 20-spell books, paid packs — see SCOPE **Not now**.

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
