# Assets (POC)

## Goal

The playable yard should feel like a **place**, not a physics demo: a forest clearing with **huge trees**, **overwhelming mountains** in the distance, and a **human** traveler (RuneScape-default energy — readable person, not a capsule, not a cinematic hero).

We **avoid greybox-as-identity**. Capsules are allowed only as temporary stand-ins during slice 0 connect, or as **crowd proxies** in slice 4 perf tests — not as the player fantasy.

Stylized **low/mid-poly** is fine (RS / hordes readable). We are **not** chasing high-poly film assets in the browser.

## Principles

1. **Atmosphere early** — kitbash a strong silhouette scene before custom art pipeline maturity.
2. **Web budget first** — every pack is guilty until a WebGL2 player build stays smooth.
3. **One look language** — stylized fantasy; don’t mix hyper-real photogrammetry with chibi kits.
4. **License ledger** — every third-party pack listed with license + URL (see below). Prefer CC0 / commercial-use store packs.
5. **Presentation laws still win** — hero trees can be unique meshes; dense forest uses LOD, impostors/billboards, GPU instancing ([ARCHITECTURE.md](ARCHITECTURE.md), [ADR 0002](adr/0002-client-host-webgpu.md)).

## POC kit (what “good enough” means)

| Layer | Target | Notes |
|---|---|---|
| Player | Simple humanoid + **staff** + **wizard robes** | RS-default readability; one skinned mesh or simple modular set; idle/walk/cast enough |
| Dummy | Obvious training dummy / scarecrow | Readable target, low cost |
| Ground | Flat or gentle clearing | Dirt/grass material; no full open-world terrain system yet |
| Forest | **Huge** tree hero meshes (few uniques) + instanced mid trees | Scale sells grandeur; don’t place 10k unique high-poly trunks |
| Mountains | Distant **mesh or skybox + silhouette** range | Overwhelming backdrop; not a hikeable alpine sim in MVP |
| Sky / light | Simple sky + directional + ambient | Mood > volumetric soup on web |
| VFX | Spark / Emberbolt readable telegraphs | Particles OK if pooled; no AAA spell cinema |

## Current POC (Babylon)

Until a credited pack lands, the Babylon client uses **procedural kitbash**:

- `web/src/world/forest.ts` — cylinder/cone hero trees, GPU-instanced mid trees,
  distant mountain cones with snow caps, sky dome + fog + hemi/sun mood.
- `web/src/world/humanoid.ts` — local player **body+head+limbs + staff** (robes
  silhouette); CrowdProxies remain amber capsules; training dummy stays cylinder.

No third-party mesh packs are vendored yet — replace with licensed kits when
credits are chosen (see ledger below).

## How we source (v1)

- **Buy or pull a small coherent pack** (itch / CC0 / store) for: stylized forest, mountain/sky backdrop, basic RPG humanoid.
- Prefer **one environment pack + one character pack** over five mismatched freebies.
- Keep sources under something like `web/public/third-party/<pack>/` (or former Unity `client/Assets/ThirdParty/`) with a `LICENSE` or root `docs/asset-credits.md` entry.
- **Do not** commit huge binary packs until chosen; this doc locks *intent*. Add credits in the same PR as the import.

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

## Credits ledger

*(Fill as packs are chosen.)*

| Pack / asset | License | Used for | URL |
|---|---|---|---|
| Procedural kitbash (`web/src/world/forest.ts`) | original (Fardel) | POC forest clearing, mountains, sky | — |
| Procedural humanoid (`web/src/world/humanoid.ts`) | original (Fardel) | local player body+head+limbs + staff | — |
| _credited pack TBD_ | | replace procedural trees/mountains + humanoid | |
