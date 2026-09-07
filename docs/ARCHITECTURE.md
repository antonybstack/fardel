# Architecture

## Shape

```
[ Unity WebGPU / IL2CPP client ]          [ SpacetimeDB ]
  input → intents                         C# module (tables + reducers)
  predict move + cast windup              authoritative sim tick
  interpolate remotes                     AOI / subscriptions
  GPU-instanced presentation              durable character + bag + skills
            \                               /
             \______ WebSocket binary _____/
```

## Authority rules (non-negotiable)

1. **Intents, not positions.** Client sends `Move`, `SetTarget`, `Cast`, `Interact`. Server writes poses and outcomes.
2. **Tab-target combat.** Server resolves hits against the current target. Client may predict windup/VFX only.
3. **SpacetimeDB is the world.** No parallel gameplay DB for v1 hot state.
4. **`FrameTick()` every frame** on the C# client connection (Unity `Update`).

## Data layout (conceptual)

| Concern | Cadence | Notes |
|---|---|---|
| Pose / vitals / cast state | High | Tight AOI subscription |
| Targets, threat, short combat events | High | Prefer small event rows over chatty RPCs where possible |
| Bag, equipment, skills, XP | Low | Subscribe on login / UI open; not every tick |
| World statics | Rare | Bake or load once; don’t stream every frame |

Exact table schemas land with slice 1+ code — this doc owns the *rules*.

## Interest management

- Never subscribe the entire world.
- Slice world into **chunks** or **radius AOI** tables; subscription follows the local player.
- Under load: **degrade pose publish rate** (hordes-style dynamic tick), never degrade gold/XP correctness.

## Client prediction (narrow)

Predict only:

- Local WASD movement (reconcile on server pose)
- Local cast start / windup presentation

Do **not** build full shooter-style rollback for v1. Tab-target MMOs tolerate simpler reconciliation (dek/hordes lesson).

## Shared rules library

`Fardel.Shared` (name TBD in code):

- Pure C#
- No Unity, no SpacetimeDB attributes
- Movement clamps, skill validation helpers, damage formulas used by both module reducers and client prediction

Module references Shared. Client references Shared. Duplication is a bug.

## Presentation laws (Unity)

- Hot paths allocate **nothing** (no LINQ, no per-frame `new`, pool lists/buffers).
- Crowds: GPU instancing; animation via VAT or compute — not 300 full Mecanim skeletons.
- Treat Unity as **host** (input, UI, builds). Entity presentation should feel closer to a batched hordes renderer than a deep `MonoBehaviour` hierarchy.
- Profile Web builds early; editor FPS lies.

## Identity & persistence

- One durable **character** row per identity (skills, XP, bag).
- Browser: persist SpacetimeDB token via the SDK’s recommended web path.
- Multi-client / multi-tab: one identity per connection policy documented when code lands (avoid unbound’s “two natives one token ≠ 1v1” trap).

## Security basics

- All economy and inventory mutations in reducers.
- Validate skill requirements, range, cooldown, and bag constraints server-side.
- Client VFX is cosmetic; never trust client damage numbers.
