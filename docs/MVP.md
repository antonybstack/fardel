# MVP slices

Goal: a **playable browser yard** with Fardel’s controls and a **simple starter loadout** — before art, before open world.

Long-term the game stays **classless** (bag / skills / gear). The POC does **not** invent a Wizard class lock — it ships one readable traveler kit so combat and persistence are testable.

## POC combat seed (locked)

| Piece | POC choice | Notes |
|---|---|---|
| Look | **Staff + wizard robes** | Placeholder meshes / capsules with props OK |
| Skills | **Spellbook of 2 spells** | Both on hotbar (`1` / `2`); tab-target |
| Timing | **Shared GCD** | Any cast starts the global cooldown; blocks the other spell until GCD ends |
| Target | Tab-target dummy (+ later players) | Server resolves hits |

### Spell roles (names are placeholders — swap freely)

1. **Spark** — short cast / near-instant direct damage. Proves tab-target + GCD + damage apply.
2. **Emberbolt** — longer windup, higher damage. Proves cast-bar predict / server cast state.

Exact numbers (damage, cast ms, GCD ms) are tunables in Shared data — start with something like **GCD ≈ 1.0–1.5 s**, Spark fast, Emberbolt clearly slower.

### Bag / equip seed (slice 3)

- Equipped: staff (weapon slot), robes (body)
- Known: the two spell ids (spellbook unlocks, not a class flag)
- Killing the dummy grants XP on the character row; refresh keeps XP + loadout

## Definition of playable

- RMB camera + WASD move (server-auth intents)
- Tab target + **both** starter spells on GCD
- A dummy that takes damage
- Second client sees you (interpolation) and cast telegraphs
- Refresh browser → character XP + equipped staff/robes + known spells still there
- Scripted proof (bot or second headless client) fails the build if the above breaks

## Slices

### 0 — Connect
- SpacetimeDB `basic-cs` (or equivalent) module publishes locally — prefer **.NET 10** when scaffolding
- Unity project connects with C# SDK
- `FrameTick()` in `Update`
- Empty scene + connection HUD

**Done when:** editor play mode shows connected identity.

### 1 — Yard + move
- Capsule (later: robed staff figure) in a flat yard
- RMB look + WASD
- `Move` intent reducer → server pose → client reconcile/predict

**Done when:** two editor instances (or editor + web) move without rubber-banding disasters.

### 2 — Tab-target + cast + dummy
- Tab cycles targets
- Hotbar: **Spark** + **Emberbolt**
- **Shared GCD** after cast start (server-authoritative; client may predict UI)
- Dummy with HP; server applies damage
- Cast windup VFX for Emberbolt (client predict ok); Spark can be near-instant

**Done when:** both spells can kill the dummy under GCD rules; killing grants XP on the character row.

### 3 — Persist + bag seed
- Character row survives disconnect/refresh
- Bag/equip seed: **staff + robes** equipped; **2 spells** known
- Optional: unequipping the staff disables or weakens casts (light proof that gear matters) — nice-to-have, not required to close the slice

**Done when:** refresh keeps XP, equip, and spellbook; scripted reconnect proof passes.

### 4 — Perf scaffold
- Instanced crowd proxy (capsules OK)
- Alloc budget check in a smoke path
- AOI chunk-neighborhood subscriptions per [ADR 0001](adr/0001-aoi-interest.md) documented and enforced

**Done when:** N proxies on-screen with a stated FPS floor on a reference machine; clients subscribe only the chunk neighborhood (+ always-relevant), not the whole map.

## Out of MVP

- Full skill tree, professions, trading, housing
- More than 2 spells / deep talenting
- Open world streaming
- Polished character art (robes/staff can be obvious placeholders)
- Action-combat mode
- Hard class selection screen

## Proof culture

Prefer a `scripts/` smoke (connect → move → cast both spells under GCD → persist) over manual “seems fine.” Carry unbound’s `mvp_check` attitude into C#.
