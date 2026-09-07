# Architecture

## Shape

```
[ Babylon.js 9 + Vite + TypeScript ]     [ SpacetimeDB ]
  input → intents                          C# module (tables + reducers)
  predict move + cast windup               authoritative sim tick
  interpolate remotes                      AOI / subscriptions
  GPU-friendly presentation                durable character + bag + skills
            \                                /
             \______ WebSocket binary ______/
```

Active client host: [ADR 0003](adr/0003-babylon-web-client.md). Historical Unity decision: [ADR 0002](adr/0002-client-host-webgpu.md).

## Authority rules (non-negotiable)

1. **Intents, not positions.** Client sends `Move`, `SetTarget`, `Cast`, `Interact`. Server writes poses and outcomes.
2. **Tab-target combat.** Server resolves hits against the current target. Client may predict windup/VFX only.
3. **SpacetimeDB is the world.** No parallel gameplay DB for v1 hot state.
4. **Frame tick every animation frame** on the client connection (TS: requestAnimationFrame / engine.runRenderLoop).

## Data layout (conceptual)

| Concern | Cadence | Notes |
|---|---|---|
| Pose / vitals / cast state | High | Tight AOI subscription |
| Targets, threat, short combat events | High | Prefer small event rows over chatty RPCs where possible |
| Bag, equipment, skills, XP | Low | Subscribe on login / UI open; not every tick |
| World statics | Rare | Bake or load once; don’t stream every frame |

Exact table schemas land with slice 1+ code — this doc owns the *rules*.

## Interest management

**Decision:** chunk-grid AOI — see [ADR 0001](adr/0001-aoi-interest.md).

Summary:

- Partition the world into **stable chunks**; subscribe **current + Moore neighborhood** (not whole-world, not continuous radius as the primary key).
- **Hysteresis** on chunk borders to avoid resubscribe thrash.
- Hot only: pose / vitals / cast / target / short combat events. Bag / skills / XP stay cold.
- **Always-relevant:** self, party, tab-target, active combat/cast partners.
- Under load: **degrade pose publish rate** (hordes-style dynamic tick), never gold/XP correctness.
- Network LOD (coarse pose tier) is a **follow-up** when metrics demand it — not a v1 requirement.

## Combat cadence (POC)

- Tab-target; server resolves damage against current target.
- **Shared GCD** gates the spellbook (server clock; client may predict GCD UI).
- Starter kit: staff + robes presentation; **two** spells (see [MVP.md](MVP.md)). Cast state (windup / GCD) is hot AOI data; spell definitions and unlocks are colder.

## Client prediction (narrow)

Predict only:

- Local WASD movement (reconcile on server pose)
- Local cast start / windup presentation

Do **not** build full shooter-style rollback for v1. Tab-target MMOs tolerate simpler reconciliation (dek/hordes lesson).

## Shared rules library

`Fardel.Shared` (name TBD in code):

- Pure C# on **.NET 10** / **C# 14** (or the newest TFM SpacetimeDB can consume)
- No engine APIs, no SpacetimeDB attributes
- Movement clamps, skill validation helpers, damage formulas used by both module reducers and client prediction
- **Span-first:** public hot APIs take/return `Span<T>` / `ReadOnlySpan<T>` (or `ref`/`in` structs) instead of allocating arrays/strings per call
- **Zero heap on the sim tick:** no LINQ in combat/move; no per-call `List<T>` unless pooled; prefer `stackalloc` / pooled buffers for scratch

Module references Shared. Browser client may reimplement narrow prediction helpers in TS or call shared constants; duplication of **authority rules** is a bug — reducers own truth.

## C# hot-path rules (module + Shared + smokes)

These apply to reducers, shared sim, and headless tools:

1. **Measure allocations** in release builds (`dotnet-trace` / BenchmarkDotNet) — debug GC lies.
2. Prefer **`Span`/`ReadOnlySpan`**, `ref struct`, and value-type state over class graphs on the tick.
3. **Pool** anything larger than a stack frame (`ArrayPool<T>`, reusable buffers).
4. Ban on hot paths unless ADR: LINQ, allocating enumerators, string interpolation for gameplay net, boxing enums/interfaces per entity.
5. Batch work: one pass over entities beats per-entity helper that allocates.
6. When .NET 10 APIs exist on that surface, prefer them over older allocating equivalents.

## Presentation laws (Babylon)

- Hot paths should avoid per-frame object churn (reuse meshes/materials; prefer instancing for crowds).
- Crowds: GPU instancing / thin proxies — not hundreds of full skinned skeletons in the POC.
- Treat Babylon + Vite as **host** (input, UI, packaging) per [ADR 0003](adr/0003-babylon-web-client.md).
- **WebGPU** preferred where available; **WebGL** remains a playable path via Babylon’s engine.
- Profile player builds early; editor/dev FPS lies.

## Identity & persistence

- One durable **character** row per identity (skills, XP, bag).
- Browser: persist SpacetimeDB token via the SDK’s recommended web path (e.g. localStorage).
- Multi-client / multi-tab: one identity per connection policy documented when code lands (avoid unbound’s “two natives one token ≠ 1v1” trap).

## Security basics

- All economy and inventory mutations in reducers.
- Validate skill requirements, range, cooldown, and bag constraints server-side.
- Client VFX is cosmetic; never trust client damage numbers.
