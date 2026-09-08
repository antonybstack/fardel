# WoW / hordes parity

Long-term plan for [play.sparkify.dev](https://play.sparkify.dev) to *feel* like a tab-target MMO: **hordes.io control**, **WoW-scale place**, **readable human**. Not a HUD demo.

This page is the **epic map**. GitHub Issues are the work. [CAMPAIGN.md](CAMPAIGN.md) points at the **active** slice. [VISION.md](VISION.md) is the soul. [SCOPE.md](SCOPE.md) still parks continents, auction houses, 20-spell books, paid packs.

**Scoreboard:** a change counts on `main` + Pages. Play the live URL.

## Why this exists

The 2026-09-08 Pages cut (`00cfbcfe`) shipped a working *session* (connect, WASD, Tab, 1/2, dummy, vendor, loot). Play on that build still fails three **body** tests:

1. **Hop** — `#139` squash/stretch on `root.scaling` rubber-bands the wizard; `jumpCamDipY` slams the camera on land; `Move` applies full XZ wish in air (not WoW air-control).
2. **Body** — `humanoid.ts` **detaches skeletons** (`m.skeleton = null`) and nulls Idle/Walk/Spell groups because skinned draw was a black mesh. Live character is a T-pose bind-pose. Clips are in the GLB; we turned them off.
3. **Place** — 120 m disc, orange debug capsules, locked `#39` EXP2 cyan fog (`density 0.015`) fighting the sky dome. Kitbash, not a WoW/hordes clearing. **Frame of reference (ignore blocky characters):** [hordes Guardstone Forest](https://ve.sparkify.dev/parity/hordes-place-ref.jpg) — player tiny vs trunks, path receding into dusk-blue volume, lush understory. Do not copy those meshes.

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
| **E3 Place** | Toy pad, fog artifacts, capsules | Match [hordes place ref](https://ve.sparkify.dev/parity/hordes-place-ref.jpg): scale, receding path, dusk-blue depth, no capsules | Pack pass, understory, second clearing |
| **E4 Camera** | Orbit clips trunks; zoom has no stops | Folded into **E10** | — |
| **E5 Combat body** | Two spells work; body must sell them | Cast hold + flinch in **E8** | 4-skill book **parked** |
| **E6 Hunt** | Dummy is the game | Folded into **E10** | Extra hostile types later |
| **E7 Others** | Party exists | Parked | PvP, second zone |
| **E8 Character** | Idle OK up close; far cam / remotes / run / death still weak | 12h Dev3 queue #326–#338 | Pack swap (Wave 5) |
| **E9 Environment** | Kitbash clearing, ghost through trees, fillrate risk | 12h Dev4 queue #339–#350 | Second zone |
| **E10 Encounter** | No hostiles, camera clips | 12h Dev2 queue #321 + #351–#362 | PvP |

**24h E1–E3 first slice is on Pages** (`2d869151`, Idle OK). **Active work = E8 + E9 + E10** (~12h, three non-overlapping file lanes).

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
| **dev-2** | E10 Encounter | `Lib.cs` / `shared/` NPC-aggro-loot, `main.ts` camera/Tab/nameplates, `tools/IdleSmoke` `HostileSmoke` | `humanoid.ts`, `forest.ts` |
| **dev-3** | E8 Character | `humanoid.ts`, `main.ts` **only** `setHumanoid*` / playback / death-pose | `forest.ts`, `Movement.cs`, NPC schema |
| **dev-4** | E9 Environment | `forest.ts`, `vendorStall.ts`, dummy placement | `humanoid.ts`, `Movement.cs` |

## Session Done-whens (24h) — **met on Pages**

Pin `2d869151` / #320. VE https://ve.sparkify.dev/release/2d869151/idle.png persistMark `Idle OK · Idle_Weapon · skinned 1`.

1. **Hop:** Space is a rigid hop. Character does **not** stretch. Camera does **not** slam. Holding A/D in air does **not** equal ground strafe.
2. **Body:** Wizard is not T-pose at `?ve=idle`. Walk cycle on WASD. Yaw follows move. Cast plays a clip.
3. **Place:** No orange capsules in the beauty shot. Fog has no banding/halos. Trees/mountains read **large**.

Hunt is no longer parked — it is **E10**. Default `/` far-cam Idle still needs E8.1 so it does not *read* T.

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

**Visual lock (ignore characters):** [hordes.io Guardstone Forest](https://ve.sparkify.dev/parity/hordes-place-ref.jpg)

| Copy | Do not copy |
|------|-------------|
| Player **tiny vs trunks**; canopy leaves the frame | Blocky cube avatars, hordes HUD, chat |
| Path that **recedes into dusk-blue volume** | 120 m dirt disc |
| Layered cool fog; distant trees dissolve | Cyan EXP2 banding / sky-fog mismatch |
| Lush grass + understory beside the path | Plastic green pad + orange capsules |
| Cool forest interior light | Midday toy lighting |

Judge `?ve=place-wow` against that shot. Free/OSS or our kitbash only — do not rip hordes meshes.

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

## 12h session Done-whens (active)

Play [play.sparkify.dev](https://play.sparkify.dev) after a frozen cut:

1. **Character (E8):** default play cam is a person — staff gripped Idle (not T from far), Walk and Run, jump/fall pose with no squash, death pose not a grey T, remotes Idle/Walk, Emberbolt holds Spell. VE `?ve=character-wow`.
2. **Environment (E9):** cannot walk through hero trunks; mid-forest instanced (not unique ALPHATEST clones); ≥30 FPS on Pages; path recedes to a second silhouette. VE `?ve=place-wow` vs [hordes place ref](https://ve.sparkify.dev/parity/hordes-place-ref.jpg).
3. **Encounter (E10):** RMB orbit does not clip trunks; mousewheel zoom has min/max stops; Tab a hostile; it hits back; kill; loot the corpse. Dummy stays a trainer. VE `?ve=encounter`.

If Character or Environment fail, do not start PvP or a 4-spell book.

## 12h milestone lists (filed)

GitHub milestone **12h: character / place / encounter**.

### E8 Character — Dev3 (`humanoid.ts`)

#323 parent. Queue: #326 play-cam Idle → #327 Run → #328 jump/fall pose → #329 death pose → #330 flinch → #331 Emberbolt Spell hold → #332 staff grip/IBM → #333 remotes Idle/Walk → #334 foot lock → #336 scale vs trunks → #337 materials → #338 `?ve=character-wow`.

### E9 Environment — Dev4 (`forest.ts`)

#324 parent. Queue: #339 trunk collision → #340 instanced mid → #341 Pages FPS 30 → #342 receding path → #343 ground relief → #344 hero variety → #345 understory instances → #346 blob shadows → #347 dummy/vendor on dirt → #348 fog → #349 far impostors → #350 `?ve=place-wow`.

If GroundY / server obstacles are required, **stop** and file `lane:server` for Dev2.

### E10 Encounter — Dev2 (camera + hunt)

#325 parent. Queue: #321 IdleSmoke (PR #335) → #351 cam collision → #352 zoom stops → #353 RMB orbit → #354 hostile spawn (schema) → #355 aggro → #356 auto-attack → #357 corpse loot → #358 Tab hostiles → #359 nameplates → #360 `?ve=aggro` → #361 `?ve=encounter` → #362 HostileSmoke.

Serialize #354–#357 and #362 (one open schema PR). Camera tickets do not wait on hunt.

## After 12h (do not file until E8–E10 are on Pages)

- **E5** four-skill book only after the body sells the two we have.
- **E7** other players / PvP / a second *zone* (E9.4 is only a silhouette).

## Play-test gate (Lead)

After each user-facing merge: open Pages (or seat Vite if not yet cut), hop, walk, look at fog. If rubber-band, T-pose, or capsules return, **REQUEST-style COMMENT** (own-PR → COMMENT) and do not merge more of that lane until fixed.
