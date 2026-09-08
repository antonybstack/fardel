# WoW / hordes parity

Long-term plan for [play.sparkify.dev](https://play.sparkify.dev) to *feel* like a tab-target MMO: **hordes.io control**, **WoW-scale place**, **readable human**. Not a HUD demo.

This page is the **epic map**. GitHub Issues are the work. [CAMPAIGN.md](CAMPAIGN.md) points at the **active** slice. [VISION.md](VISION.md) is the soul. [SCOPE.md](SCOPE.md) still parks continents, auction houses, 20-spell books, paid packs.

**Scoreboard:** a change counts on `main` + Pages. Play the live URL.

## Why this exists

The 2026-09-08 Pages cut (`00cfbcfe`) shipped a working *session* (connect, WASD, Tab, 1/2, dummy, vendor, loot). Play on that build still fails three **body** tests:

1. **Hop** — `#139` squash/stretch on `root.scaling` rubber-bands the wizard; `jumpCamDipY` slams the camera on land; `Move` applies full XZ wish in air (not WoW air-control).
2. **Body** — `humanoid.ts` **detaches skeletons** (`m.skeleton = null`) and nulls Idle/Walk/Spell groups because skinned draw was a black mesh. Live character is a T-pose bind-pose. Clips are in the GLB; we turned them off.
3. **Place** — 120 m disc, orange debug capsules, locked `#39` EXP2 cyan fog (`density 0.015`) fighting the sky dome. Kitbash, not a WoW clearing.

Hunt NPCs and toast chrome do not fix these. This document is the replacement north star until hop, body, and place are on Pages.

## Parity, not clone

| We match | We do not match (v1) |
|----------|----------------------|
| WoW/hordes **tab-target + GCD** cadence | WoW trilogy content, dungeons, raids |
| WoW **hop**: rigid body, weak air strafe, camera that does not punch | Souls timing, shooter air-control |
| hordes **readable human** that walks, looks, casts | Photoreal / cinematic hero |
| WoW **place**: huge trees, layered fog, mountains that read far | Full continents, cities, instances |
| Intents, not client positions | Client-authoritative physics |

## Epics

| Epic | Live failure | 24h first slice | Later |
|------|----------------|-----------------|-------|
| **E1 Hop** | Rubber-band + camera slam + full air-strafe | Revert squash/dip; damp air XZ; retune jump; camera spring | Slopes, fall distance, collision, jump-queue |
| **E2 Body** | T-pose, no look, no walk/cast | Skinned draw + Idle/Walk/yaw + cast clip | Jump/fall poses, remotes, death, look-at |
| **E3 Place** | Toy pad, fog artifacts, capsules | Fog/sky match; hide capsules; scale trees/mountains; lift `#39` | Pack pass, understory, second clearing |
| **E4 Camera** | Orbit exists; slam/collision do not | Covered under E1 camera spring | Camera collision vs trees, zoom stops, RMB feel |
| **E5 Combat body** | Spells work; body does not sell them | Cast clip in E2 | 4-skill book, telegraphs that match anim |
| **E6 Hunt** | Dummy is the game | **Parked** until E1–E3 on Pages | Hostiles, aggro, corpse loot |
| **E7 Others** | Party exists | Parked | PvP, second place |

**24-hour active work = E1 + E2 + E3 first milestones only.** E6 hunt stays in CAMPAIGN as later.

## 24-hour operating rules (Antony away)

- One Lead (parent). **No nested Team Leads** — same GitHub user, same north star, no extra merge policy.
- Three Devs, three file ownerships. They do not edit each other’s files.
- Each Dev has a **queue of Issues** in their epic. Finish one → take the next open Issue in that epic **in the same run**. Do not idle.
- Serialize `lane:server` schema (`Movement.cs`, `Lib.cs` Move). E1 air-control/jump constants go through **one** Dev (Dev2).
- Reviewer: COMMENT + Lead-merge, never PENDING. Cap 2 PRs/tick. VE required for user-facing.
- Empty board in an epic → Lead files the **next milestone from this page**, not a toast ticket.
- Cuts: frozen `release/<sha>` → `main` when a slice’s session Done-when is true. Never live `develop`.

### File ownership

| Seat | Epic | May touch | Must not touch |
|------|------|-----------|----------------|
| **dev-2** | E1 Hop | `shared/Fardel.Shared/Movement.cs`, `server/spacetimedb/Lib.cs` (Move only), `web/src/main.ts` **jump/camera follow only**, `tools/JumpSmoke` | `humanoid.ts`, `forest.ts` |
| **dev-3** | E2 Body | `web/src/world/humanoid.ts`, call sites in `main.ts` **only** `setHumanoidMoving` / yaw / cast clip | Jump squash, fog, forest |
| **dev-4** | E3 Place | `web/src/world/forest.ts`, sky/fog/ground/tree placement, hide debug capsules | Movement.cs, skeleton detach |

## Session Done-whens (24h)

Play [play.sparkify.dev](https://play.sparkify.dev) after a frozen cut:

1. **Hop:** Space is a rigid hop. Character does **not** stretch. Camera does **not** slam. Holding A/D in air does **not** equal ground strafe.
2. **Body:** Wizard is not T-pose. Walk cycle on WASD. Yaw follows move. Cast plays a clip (or a clear one-shot pose).
3. **Place:** No orange capsules in the beauty shot. Fog has no banding/halos. Trees/mountains read **large**. Establishing VE at play cam.

If any of the three fail, do not start hunt/PvP.

## Milestone lists (file as Issues; keep this table in sync)

### E1 Hop — Dev2

| Order | Issue intent | Lane | Notes |
|-------|----------------|------|-------|
| 1 | Revert `#139` squash/stretch + `jumpCamDipY` slam | client | Unblocks E2 (root.scaling fights skin). |
| 2 | Air control: scale XZ wish while `Y > GroundY` (no new tables) | server | WoW-like; JumpSmoke. |
| 3 | JumpSmoke asserts airborne XZ << grounded step | qa/server | |
| 4 | Retune `JumpVelocity` / `Gravity` for a readable hop | server | Constants only. |
| 5 | Camera follow spring; land does not punch Y | client | `main.ts` follow only. |
| 6 | `?ve=hop-wow` rigid hop, no squash, no slam | client | VE required. |
| 7 | Airborne interpolation (no snapshot pop at apex) | client | Related `#212`. |
| 8 | Optional: jump-queue if Space before land | server | After 2–4. |

### E2 Body — Dev3

| Order | Issue intent | Lane | Notes |
|-------|----------------|------|-------|
| 1 | Stop detaching skeleton; skinned wizard **draws** | client | Hard; this is the T-pose root cause. |
| 2 | Bind Idle clip | client | |
| 3 | Bind Walk clip to wish | client | |
| 4 | Yaw root toward camera-relative wish | client | |
| 5 | Cast clip (or one-shot) on Spark/Emberbolt | client | |
| 6 | `?ve=walk` legs move at play cam | client | |
| 7 | `?ve=cast-anim` | client | |
| 8 | Remotes: walk/idle from pose delta | client | After 3. |
| 9 | Jump/fall: stop walk; hold a pose (no squash) | client | After E1.1. |
| 10 | Optional: look-at / head toward target | client | After yaw. |

### E3 Place — Dev4

| Order | Issue intent | Lane | Notes |
|-------|----------------|------|-------|
| 1 | Fog artifacts: sky dome vs `fogColor`, EXP2 banding | art | `#39` may move; document new lock. |
| 2 | Hide orange debug capsules in default play | client/art | Collision may stay; must not render. |
| 3 | Scale: ground extent + hero trees at WoW-huge play-cam | art | 120 m disc is the toy. |
| 4 | Mountains: farther, taller, layered silhouettes | art | |
| 5 | Ground/path: not a plastic pad | art | |
| 6 | Tree/fog intersection cleanup | art | |
| 7 | `?ve=place-wow` establishing shot | art | |
| 8 | Lighting: lift `#39` with a **new** documented lock + VE | art | User asked for gorgeous; lock was the leash. |
| 9 | Optional: understory density with FPS floor | art | After 3. |

## After 24h (do not file until hop+body+place are on Pages)

- **E4** camera collision vs trees; zoom stops that feel like WoW.
- **E5** four-skill book only after the body sells the two we have.
- **E6** hunt (hostiles, aggro, corpse loot) — previous CAMPAIGN Wave 1.
- **E7** other players / PvP / second clearing.

## Play-test gate (Lead)

After each user-facing merge: open Pages (or seat Vite if not yet cut), hop, walk, look at fog. If rubber-band, T-pose, or capsules return, **REQUEST-style COMMENT** (own-PR → COMMENT) and do not merge more of that lane until fixed.
