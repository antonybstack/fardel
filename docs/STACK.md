# Stack

Locked for Fardel v1. Change only with an explicit architecture decision record.

## Locked choices

| Layer | Choice | Why |
|---|---|---|
| World authority | **SpacetimeDB ≥ 2.3** | In-memory relational truth, reducers, binary row sync; already proven in unbound POCs |
| Server module | **C# → WASI/WASM** | Language symmetry with client; Blackholio has a C# server path |
| Shared rules | **Pure C# class library** (no `UnityEngine`) | Same move/combat/skill math on module + client prediction |
| Client host | **Unity 6.6+** | Official SpacetimeDB C# / Unity path; WebGPU no longer experimental |
| Graphics | **WebGPU primary, WebGL 2 fallback** | Compute + modern GPU path; keep WebGL2 for reach |
| Client compile | **IL2CPP** web builds | No Mono-interpreted browser client |
| Net SDK | **SpacetimeDB C# SDK** | Call `FrameTick()` every frame; do not invent a second protocol |
| Presentation law | **Data-oriented** | GPU instancing + VAT/compute skinning for crowds; zero alloc in hot loops |

## Explicit non-choices (v1)

| Rejected | Reason |
|---|---|
| Stride | Weaker SpacetimeDB/browser proof vs Blackholio + Unity 6 |
| Rust module + C# client | Breaks the symmetry goal; revisit only if C# module tick becomes the bottleneck |
| Bevy / unbound continuation | Wrong combat fantasy and language for this reboot |
| Custom WebGPU engine from day one | Too much runway before fun; enforce hordes-like batching *inside* Unity first |

## Perf honesty

- **Target:** 60–120 FPS in browser on a mid-range laptop with **hundreds** of entities on-screen.
- **Scale:** **Thousands** of concurrent players in a shard via AOI / chunk subscriptions — not all rendered at once.
- Hordes.io’s own published lessons: dynamic tick under load, proximity culling, custom batching — we adopt the *ideas*, not a JS rewrite.

## Tooling baseline

- SpacetimeDB CLI (`spacetime start`, `publish`, `generate --lang csharp`)
- Unity Hub + Unity 6.6+ with Web platform support
- `gh` + this repo as source of truth
- Headless / scripted proofs before art (see [MVP.md](MVP.md))

## Reference projects

- [Blackholio](https://github.com/clockworklabs/Blackholio) — Unity + SpacetimeDB (C# or Rust server)
- SpacetimeDB `basic-cs` template — module + bindings bootstrap
- Prior POCs: unbound, spacetimedb-mmo-poc (lessons only)
