# ADR 0002: Client host (Unity) and WebGPU

- **Status:** Accepted (historical) — **superseded for active client host by [ADR 0003](0003-babylon-web-client.md)** (Babylon.js + TypeScript). Unity checkpoint retained on `checkpoint/unity-webgl` @ `ca9b7d5`.
- **Date:** 2026-09-06
- **Deciders:** Fardel (Antony + Unbound Team Lead)

## Context

Fardel is browser-first: players click a link; Unity Editor is for development. The locked stack already names **Unity 6.6+**, **WebGPU primary / WebGL 2 fallback**, and **IL2CPP** web builds ([STACK.md](../STACK.md)).

Open question this ADR closes: is Unity a forever choice, and how hard do we lean on WebGPU?

Related constraints:

- SpacetimeDB **C# SDK** + `FrameTick()` every frame — strongest path today is Unity.
- Sim and rules live in **`Fardel.Shared`** + the SpacetimeDB module — client host should stay replaceable in *architecture*, not by running two clients in parallel ([VISION.md](../VISION.md)).
- Perf honesty: hundreds on-screen; presentation must stay data-oriented (instancing / VAT), whether or not Unity remains the host.
- hordes.io / dek proved a **custom WebGL** client can win on raw browser perf — that is a future option, not a v1 plan.

## Decision

### 1. Unity is the **v1 client host**, not a forever religion

- Build MVP and early live on **Unity 6.6+** (Web platform, IL2CPP).
- Treat Unity as **host**: input, UI, packaging, audio, asset pipeline.
- Keep gameplay authority and shared math **out** of `MonoBehaviour` soup — module + `Fardel.Shared` own truth and formulas.
- **No dual-client** in v1 (no parallel Stride / custom engine track).

### 2. WebGPU is the preferred path; WebGL 2 is the ship safety net

- **Primary:** WebGPU where the browser/device supports it (compute, instancing, future crowd/VAT work).
- **Fallback:** WebGL 2 must remain a **playable** path.
- **Ship criteria:** the game is considered shippable on the **fallback**. WebGPU is the fast path, not the only path.
- Profile **player/web builds** early (from slice 1–2). Editor FPS does not count.

### 3. Architecture exit hatch (replace Unity only when earned)

Revisit replacing Unity **only after** `Fardel.Shared` + module APIs are stable **and** at least one **kill criterion** fails:

| Kill criterion | Meaning |
|---|---|
| Web payload / startup | IL2CPP web download or cold start is unacceptable after real content + honest stripping |
| Crowd ceiling | Data-oriented Unity web presentation still cannot hit stated on-screen FPS floors |
| Funded custom client | We deliberately fund a custom WebGPU (or other) client *and* SpacetimeDB client bindings remain viable |

Until then: optimize inside Unity (batching, stripping, addressables/asset hygiene) — do not start a second client.

### 4. What a future replacement would look like (non-binding)

If a kill criterion trips, prefer **one** successor, not a zoo:

- Custom **WebGPU** browser client (hordes/dek-shaped), or another **C#-friendly** host with a maintained SpacetimeDB SDK path.
- Reuse **Shared** + generated bindings; do not fork game rules into the new client.
- Still no long-term dual-client: migrate, then drop Unity for players.

## Consequences

**Good**

- Unblocks slice 0 without re-litigating Stride vs Unity.
- Forces Shared/module purity so a later client swap is possible.
- Honest about WebGPU maturity: fallback is first-class.

**Tradeoffs**

- Unity web payload and toolchain pain are accepted for v1 speed.
- Custom-renderer peak FPS (dek path) is deferred.
- Team must resist “just one more MonoBehaviour system” that would glue us to Unity forever.

## Alternatives considered

| Option | Why not now |
|---|---|
| Stride as v1 client | Weaker SpacetimeDB/browser proof vs Unity + Blackholio path |
| Custom WebGPU client from day one | Too much runway before fun; VISION rejects custom engine day one |
| WebGPU-only (no WebGL2) | Too brittle for browser matrix at MVP |
| Dual clients in parallel | Doubles cost; forbidden for v1 |

## Follow-ups

- Measure first IL2CPP web template size at slice 0; record a budget in STACK or LEARNINGS when numbers exist.
- Slice 4: confirm WebGPU and WebGL2 both hit the stated FPS floor with crowd proxies.
- If a kill criterion trips, write **ADR 000x: client host migration** before coding the replacement.

## References

- [STACK.md](../STACK.md) — locked choices
- [VISION.md](../VISION.md) — browser-first, no second client stack
- [ARCHITECTURE.md](../ARCHITECTURE.md) — presentation laws
- [ADR 0001](0001-aoi-interest.md) — scale via AOI, not “render everyone”
