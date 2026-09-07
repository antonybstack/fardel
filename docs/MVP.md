# MVP slices

> Focus rules: [SCOPE.md](SCOPE.md) — one active slice; north-star demo before side quests.

Goal: a **playable browser yard** with Fardel’s controls, a **simple starter loadout**, and an **early atmosphere kit** (forest + mountains + humanoid) — before custom art pipeline, before open world. See [ASSETS.md](ASSETS.md).

Long-term the game stays **classless** (bag / skills / gear). The POC does **not** invent a Wizard class lock — it ships one readable traveler kit so combat and persistence are testable.

## POC combat seed (locked)

| Piece | POC choice | Notes |
|---|---|---|
| Look | **Staff + wizard robes** on a **simple humanoid** | RuneScape-default energy; not a capsule as the player fantasy ([ASSETS.md](ASSETS.md)) |
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
- **Headless gate:** `tools/ConnectSmoke` connects and prints identity
- Babylon/`web/` client connects with SpacetimeDB JS/TS SDK
- Frame tick every animation frame
- Empty scene + connection HUD

**Done when:** headless ConnectSmoke is green; browser HUD shows connected identity.

### 1 — Yard + move
- **Headless gate:** `tools/MoveSmoke` connects, sends `Move`, asserts server pose updates (Unity not required)
- Forest clearing: **huge trees** + **distant mountains** backdrop (kitbash OK)
- Player: **simple humanoid** with staff/robes intent (temp mesh OK if clearly a person)
- RMB look + WASD
- `Move` intent reducer → server pose → client reconcile/predict

**Done when:** two clients move in a scene that already sells “grand clearing,” not a greybox void.

### 2 — Tab-target + cast + dummy
- **Headless gate:** `tools/CombatSmoke` — Spark kill + XP, GCD block, Emberbolt windup
- Tab cycles targets
- Hotbar: **Spark** + **Emberbolt**
- **Shared GCD** after cast start (server-authoritative; client may predict UI)
- Dummy with HP; server applies damage
- Cast windup VFX for Emberbolt (client predict ok); Spark can be near-instant
- Cast projectile / beam polish: Spark bolt+trail + Emberbolt thicker beam (local+remote) + impact pop (`web/src/world/castVfx.ts`; `?ve=projectile`)
- Cast cancel / move-interrupt: Move or Esc/`CancelCast` during Emberbolt windup refunds mana + clears cast bar (`CastCancelSmoke`, `?ve=cast-cancel`)
- Cast pushback: dummy thorns (`DummyStrike`) during Emberbolt windup delays `CastEndsAt` without cancel/refund (`CastPushbackSmoke`, `?ve=cast-pushback`)
- Hard interrupt threshold: after `CastPushbackHardAfter` pushbacks (or remain < `CastHardInterruptRemainMs`), next `DummyStrike` cancels windup with **no mana refund** (`HardInterruptSmoke`, `?ve=hard-interrupt`)
- Post-interrupt silence: hard interrupt sets `CastLockedUntil`; Emberbolt `Cast` rejects with toast `silenced` until expiry (`CastSilenceSmoke`, `?ve=cast-silence`)
- Kick / Counterspell: `Kick(target)` hard-interrupts nearby windup + same silence without DummyStrike (`KickSmoke`, `?ve=kick`)

**Done when:** both spells can kill the dummy under GCD rules; killing grants XP on the character row.

### 3 — Persist + bag seed
- Character row survives disconnect/refresh
- Bag/equip seed: **staff + robes** equipped; **2 spells** known
- Casts require known spell + staff equipped (loadout gate)
- Optional: unequipping the staff disables casts — **done** (`UnequipStaff`/`EquipStaff`, StaffEquipSmoke, Babylon U/I + mesh hide)
- Robes equip/unequip presentation — **done** (`UnequipRobes`/`EquipRobes`, RobesEquipSmoke, Babylon J/K + robes mesh)
- **Headless gate:** `tools/PersistSmoke` — earn XP → disconnect → reconnect with saved token → same identity + Character.Xp

**Done when:** refresh keeps XP, equip, and spellbook; scripted reconnect proof passes.

### 4 — Perf scaffold
- Instanced crowd proxy (capsules OK)
- Alloc budget check in a smoke path
- AOI chunk-neighborhood subscriptions per [ADR 0001](adr/0001-aoi-interest.md) documented and enforced
- InterestChunk hysteresis on `PlayerPose`; `CrowdProxy` seed; Moore SQL subscribe
- **Headless gate:** `tools/AoiSmoke` — hysteresis + neighborhood subscribe excludes far proxies
- Browser FPS floor: **tracked** via Babylon FPS overlay (`engine.getFps()`, green ≥ 30 / target 60 on box reference; `?ve=fps`) — not a headless blocker

**Done when:** headless neighborhood subscribe proven; N proxies on-screen with a stated FPS floor on a reference machine (**box:** 30 fps floor / 60 target via FPS HUD + `ve/babylon-fps.png`); clients subscribe only the chunk neighborhood (+ always-relevant), not the whole map.

## Out of MVP

Full anti-goal list and distraction triggers: [SCOPE.md](SCOPE.md).

- Full skill tree, professions, trading, housing
- More than 2 spells / deep talenting
- Open world streaming
- Polished character art / character creator (POC humanoid can be pack-default)
- Photoreal or high-poly cinema assets
- Action-combat mode
- Hard class selection screen

## Proof culture

Prefer a smoke (connect → move → cast both spells under GCD → persist) over manual “seems fine.” Carry unbound’s `mvp_check` attitude into C# headless tools + browser checks.
