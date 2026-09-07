# MVP slices

Goal: a **playable browser yard** with Fardel’s controls and classless seed — before art, before open world.

## Definition of playable

- RMB camera + WASD move (server-auth intents)
- Tab target + at least one skill
- A dummy that takes damage
- Second client sees you (interpolation)
- Refresh browser → character skills/XP/bag seed still there
- Scripted proof (bot or second headless client) fails the build if the above breaks

## Slices

### 0 — Connect
- SpacetimeDB `basic-cs` (or equivalent) module publishes locally
- Unity project connects with C# SDK
- `FrameTick()` in `Update`
- Empty scene + connection HUD

**Done when:** editor play mode shows connected identity.

### 1 — Yard + move
- Capsule in a flat yard
- RMB look + WASD
- `Move` intent reducer → server pose → client reconcile/predict

**Done when:** two editor instances (or editor + web) move without rubber-banding disasters.

### 2 — Tab-target + cast + dummy
- Tab cycles targets
- One skill on hotbar
- Dummy with HP; server applies damage
- Basic cast windup VFX (client predict ok)

**Done when:** killing the dummy grants XP on the character row.

### 3 — Persist + bag seed
- Character row survives disconnect/refresh
- Minimal bag (even 1–2 item slots) proving classless seed: equip or use something that changes a skill/stat

**Done when:** refresh keeps XP and bag; scripted reconnect proof passes.

### 4 — Perf scaffold
- Instanced crowd proxy (capsules OK)
- Alloc budget check in a smoke path
- AOI chunk-neighborhood subscriptions per [ADR 0001](adr/0001-aoi-interest.md) documented and enforced

**Done when:** N proxies on-screen with a stated FPS floor on a reference machine; clients subscribe only the chunk neighborhood (+ always-relevant), not the whole map.

## Out of MVP

- Full skill tree, professions, trading, housing
- Open world streaming
- Polished character art
- Action-combat mode

## Proof culture

Prefer a `scripts/` smoke (connect → move → cast → persist) over manual “seems fine.” Carry unbound’s `mvp_check` attitude into C#.
