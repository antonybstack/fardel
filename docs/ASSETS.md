# Assets (POC)

## Goal

The playable yard should feel like a **place**, not a physics demo: a forest clearing with **huge trees**, **overwhelming mountains** in the distance, and a **human** traveler (RuneScape-default energy — readable person, not a capsule, not a cinematic hero).

We **avoid greybox-as-identity**. Capsules are allowed only as temporary stand-ins during slice 0 connect, or as **crowd proxies** in slice 4 perf tests — not as the player fantasy.

Stylized **low/mid-poly** is fine (RS / hordes readable). We are **not** chasing high-poly film assets in the browser.

## Principles

1. **Atmosphere early** — kitbash a strong silhouette scene before custom art pipeline maturity.
2. **Web budget first** — every pack is guilty until a WebGL2 player build stays smooth.
3. **One look language** — stylized fantasy; don’t mix hyper-real photogrammetry with chibi kits.
4. **License ledger** — every third-party pack listed with license + URL (see below). **Free only:** CC0 / OSS / similar commercial-use-free. Never purchase packs.
5. **Presentation laws still win** — hero trees can be unique meshes; dense forest uses LOD, impostors/billboards, GPU instancing ([ARCHITECTURE.md](ARCHITECTURE.md), [ADR 0002](adr/0002-client-host-webgpu.md)).

## Visual north star (Issue #31)

**Mood:** hordes.io / RuneScape / WoW-readable fantasy — a lush forest clearing that feels like a *place*, not a kitbash demo. Antony’s mood reference: dense ancient canopy, atmospheric **blue/cyan fog** depth, soft canopy-filtered light, vibrant undergrowth + readable path, classic MMO HUD scale. Painterly stylized (bold color, exaggerated forms) — **not** photoreal. The cyan-cube / capsule placeholder is exactly what we leave behind.

### Do

- Cool blue/cyan fog with visible mid→far depth layers
- Warm directional sun + cooler ambient/hemi fill; soft diffuse canopy feel
- Huge gnarled hero-tree silhouettes + dense instanced mid forest
- Lush ground: grass variation (ferns/flowers optional later); path readable vs grass
- Player as a readable humanoid (head/torso/limbs + robes + staff) at play-camera distance (~8–15m)
- One look language: stylized fantasy; saturated but not neon

### Don’t

- Capsule / cyan cube / greybox as player identity
- Mixing photogrammetry with low-poly kits
- Flat unfogged lighting or sterile grey ground
- Photoreal / Nanite-style density
- Inventing new gameplay systems for art’s sake
- **Purchasing** asset packs (paid itch/store tiers, Asset Store, etc.)

### Material / lighting targets (Issue #32)

- Fog denser than current procedural kitbash; tint toward blue-cyan
- Sun warmer; fill cooler; ground albedo richer greens with path contrast
- Foliage mostly matte (low specular); avoid plastic shine
- VE: `?ve=atmosphere` (or similar) + embedded shot; FPS still playable

### Character targets (Issue #33)

- Clear limb/robe/staff silhouette under new lighting
- Cloth vs skin vs wood staff material separation; staff orb readable
- Still kitbash-OK until free packs land; must read as a *person*
- VE: `?ve=humanoid-polish`
- Training dummy scarecrow (#45): `?ve=dummy` (`ve/babylon-dummy.png`)
- Combat floater readability (#59): thick outline + matte tints under #39 fog; `?ve=floater-read` (`ve/babylon-floater-read.png`)
- Hotbar affordance polish (#63): empty vs STAFF vs OOM clarity; `?ve=hotbar-afford` (`ve/babylon-hotbar-afford.png`)
- Target frame / reticule contrast (#69): gold select chrome crisp vs #39 cyan fog; `?ve=target-contrast` (`ve/babylon-target-contrast.png`)
- Party/self HP bar readability (#67): dark track + saturated green→amber→red fills; `?ve=frame-hp` (`ve/babylon-frame-hp.png`)
- Combat log strip readability (#78): dark plate + damage/heal/kill/system distinct (no neon); `?ve=combat-log-read` (`ve/babylon-combat-log-read.png`)

### Path / ground targets (Issue #44)

- Clearer dirt/stone trail vs lush grass at play cam under locked #39 fog/sun
- Warm grey-brown path albedo ~`(0.45–0.52, 0.34–0.40, 0.24–0.30)`; soft moss/dirt edge; matte / low specular / no bright emissive
- Keep lush grass `~(0.26, 0.52, 0.18)`; procedural DIY (trail strip, stone flecks, faint moss patches); no paid packs
- VE: `?ve=path-ground`

### Sky / horizon silhouette targets (Issue #55)

- Distant cool grey-blue mountain silhouettes readable through locked #39 cyan fog at 8–30m play cam
- 2–3 soft layered ranges (near/mid/far value steps); low detail / mood backdrop; soft snow caps (not neon)
- Sky dome soft gradient into fog color `(0.34, 0.55, 0.7)` — no harsh horizon seam; slightly warmer zenith OK
- Do **not** change fog dens / fogColor / hemi / sun lock; procedural DIY only
- VE: `?ve=sky-horizon`

### Loot sparkle / pickup readability targets (Issue #56)

- Ground loot bags/sparkles read clearly at play-cam (8–20m) under #39 fog without neon bloom
- Warm amber markers contrast vs cyan fog; distinct from path/grass; low emissive (0.03–0.04 range)
- Keep locked #39 atmosphere (fog dens/color, hemi, sun) intact
- Procedural DIY only; preserve existing pickup UX
- VE: `?ve=loot-sparkle`

### Vendor stall targets (Issue #58)

- Yard vendor reads as a **shop** at play cam under locked #39 fog — upright posts + counter + cloth awning (not green block, not scarecrow)
- Warm wood posts/counter (dirt-path warmth family); desaturated canvas/stripe awning (mid value, pops in cyan fog without neon); matte / low specular
- Footprint on path/clearing edge; readable vs lush grass at 8–20m; procedural DIY only; do **not** touch fog/sun/hemi
- VE: `?ve=vendor-stall`

### Forest targets (Issue #34)

- More mid-tree variety + stronger hero silhouettes; LOD/instancing discipline (see Principles)
- Clearing feels grand; FPS floor respected
- VE shot required

### Priority order

1. Lighting / atmosphere (#32) — biggest mood win without packs
2. Humanoid polish (#33)
3. Forest density (#34)
4. Free CC0/OSS mesh packs (or keep improving procedural) — **never buy**

### Pack shortlist (FREE ONLY)

**Hard rule (Antony):** no purchasing assets — ever. Only free open-source / CC0 (or similar commercial-use-free) packs, or original/procedural work we develop ourselves. Ignore paid “Pro / Source / Extra” tiers; use the free download tier only. Prefer **one free env pack + one free character pack**, or stay procedural.

Verify license on download. Prefer glTF (or convertible FBX) for Babylon. When imported, place under `web/public/third-party/<pack>/` and fill the credits ledger in the **same PR**.

**Environment (pick one — all free CC0)**

| Rank | Pack | License | Why | URL |
|---|---|---|---|---|
| Rec | Quaternius Stylized Nature MegaKit (Standard / free) | CC0 | 40 trees, plants, rocks; Ghibli-adjacent lush; FBX/OBJ/glTF | https://quaternius.itch.io/stylized-nature-megakit |
| Alt | KayKit Forest Nature Pack (FREE tier) | CC0 | 100+ free models; single atlas (web draw-call friendly); FBX/GLTF/OBJ | https://kaylousberg.itch.io/kaykit-forest |
| DIY | Procedural upgrades in `forest.ts` | original (Fardel) | Keep iterating hero/mid trees + understory without third-party meshes | — |

**Character (pick one — all free CC0)**

| Rank | Pack | License | Why | URL |
|---|---|---|---|---|
| Rec | Quaternius LowPoly RPG Characters | CC0 | 6 rigged+animated fantasy chars; wizard-energy traveler; FBX/OBJ/Blend | https://opengameart.org/content/lowpoly-rpg-characters |
| Alt | Quaternius Modular Character Outfits – Fantasy (Standard / free) | CC0 | Includes Male Wizard outfit; humanoid rig; FBX/glTF | https://quaternius.itch.io/modular-character-outfits-fantasy |
| Alt | LOWPO Adventure Character Pack (free base: Healer + staff, FBX) | CC0 | Lightweight shared atlas; use free tier only | https://standout7.itch.io/adventure-character-pack |
| DIY | Procedural upgrades in `humanoid.ts` | original (Fardel) | Silhouette/material polish without third-party meshes | — |

Dropped from shortlist: any paid-minimum itch/store packs (e.g. AssetQuest Stylized Forest Kit). Art owns ledger updates; Devs land import PRs with credits filled.

## POC kit (what “good enough” means)

| Layer | Target | Notes |
|---|---|---|
| Player | Simple humanoid + **staff** + **wizard robes** | RS-default readability; one skinned mesh or simple modular set; idle/walk/cast enough |
| Dummy | Obvious training dummy / scarecrow | Readable target, low cost |
| Vendor / stall | Shop silhouette: posts + counter + cloth awning | Warm wood + canvas; buy cue, not attack |
| Ground | Flat or gentle clearing | Dirt/grass material; no full open-world terrain system yet |
| Forest | **Huge** tree hero meshes (few uniques) + instanced mid trees | Scale sells grandeur; don’t place 10k unique high-poly trunks |
| Mountains | Distant **mesh or skybox + silhouette** range | Overwhelming backdrop; not a hikeable alpine sim in MVP |
| Sky / light | Simple sky + directional + ambient | Mood > volumetric soup on web |
| VFX | Spark / Emberbolt readable telegraphs | Particles OK if pooled; no AAA spell cinema |

## Current POC (Babylon)

- `web/src/world/forest.ts` — **Quaternius Stylized Nature MegaKit Standard (CC0)** glTF
  hero TwistedTree + mid CommonTree variants + understory (grass/fern/rock/bush);
  distant mountains stay **procedural**; sky dome + locked #32/#39 cyan fog / warm sun / cool hemi.
  Procedural fallback keeps post-#40 ThinInstance density + LOD if the pack fails to load.
- `web/src/world/humanoid.ts` — local/remote players use **Quaternius LowPoly RPG Wizard**
  (CC0 skinned `Wizard.glb`) under the `HumanoidParts` API from #43 (staff/robes equip
  hide/show; mid-sat cloth tint under cyan fog). CrowdProxies remain amber capsules;
  training dummy is procedural scarecrow (wood post + crossbeam + canvas/sack; `web/src/world/dummy.ts`, #45).
- `web/src/world/vendorStall.ts` — procedural yard **shop stall** (posts + counter + cloth awning +
  crate/goods hints); warm wood / desaturated canvas under locked #39 fog (#58).

Env pack: `web/public/third-party/quaternius-stylized-nature/` (see ledger).
Character pack: `web/public/third-party/quaternius-lowpoly-rpg-characters/` + `LICENSE`
(see ledger). Modular Fantasy Standard was evaluated for Male Wizard but free tier only
ships Peasant/Ranger — Wizard is Source-tier; OGA LowPoly RPG Wizard used instead (CC0).
Visual north star remains Issue #31 / mood brief above.

## How we source (v1)

- Pull a **free** coherent pack (CC0 / OSS itch or OpenGameArt) for: stylized forest, mountain/sky backdrop, basic RPG humanoid — **or** keep upgrading procedural kitbash.
- Prefer **one free environment pack + one free character pack** over five mismatched freebies.
- Keep sources under something like `web/public/third-party/<pack>/` (or former Unity `client/Assets/ThirdParty/`) with a `LICENSE` or root `docs/asset-credits.md` entry.
- **Do not** commit huge binary packs until chosen; this doc locks *intent*. Add credits in the same PR as the import.
- **Never purchase** packs or paid tiers.

## Pipeline (POC-simple)

- Unity project owns imports; compress textures for web (ASTC/DXT as Unity web build dictates).
- Start with **direct scene references**; introduce Addressables only when payload demands it.
- LODs on trees; hard cull distance on forest instances; mountains are backdrop (almost never “gameplay collide”).
- Characters: one material set where possible; avoid per-player unique heavy maps in POC.

## Slice mapping

| Slice | Art bar |
|---|---|
| 0 Connect | Empty / neutral scene OK |
| 1 Yard + move | **Forest clearing + mountain backdrop + humanoid (or clearly human temporary)** — not a permanent capsule yard |
| 2 Combat | Staff/robes readable; dummy placed; spell VFX placeholders OK |
| 3 Persist | No new art required |
| 4 Perf | Extra crowd may be **capsules/impostors** on purpose; player/env keep the grand look |

## Non-goals (POC)

- Custom character creator
- Photoreal trees / Nanite-style density
- Full world streaming art pipeline
- Hand-authored unique hero mountain you can climb end-to-end
- Purchased / paid asset packs

## Credits ledger

*(Fill as free packs are chosen. Art owns ledger intent; import PRs fill rows.)*

| Pack / asset | License | Used for | URL |
|---|---|---|---|
| Quaternius Stylized Nature MegaKit **Standard** (free) | CC0 1.0 | Hero TwistedTree + mid CommonTree + understory grass/fern/rock/bush (`web/public/third-party/quaternius-stylized-nature/`) | https://quaternius.itch.io/stylized-nature-megakit · import mirror https://opengameart.org/sites/default/files/stylized_nature_megakitstandard.zip · https://opengameart.org/content/stylized-nature-megakit |
| Procedural mountains/sky (`web/src/world/forest.ts`) | original (Fardel) | Distant mountain silhouettes + sky dome (hybrid; pack mountains skipped for web budget) | — |
| Quaternius LowPoly RPG Characters — Wizard (`web/public/third-party/quaternius-lowpoly-rpg-characters/`) | CC0 1.0 | Local/remote skinned wizard + staff; idle/walk/cast | https://opengameart.org/content/lowpoly-rpg-characters |
| HumanoidParts staff/robes containers (`web/src/world/humanoid.ts`) | original (Fardel) | Equip hide/show API preserved from #43 | — |
