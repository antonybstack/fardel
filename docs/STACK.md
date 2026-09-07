# Stack

Locked for Fardel v1. Change only with an explicit architecture decision record.

## Locked choices

| Layer | Choice | Why |
|---|---|---|
| World authority | **SpacetimeDB ≥ 2.3** | In-memory relational truth, reducers, binary row sync; already proven in unbound POCs |
| Server module | **C# → WASM** (.NET 10 NativeAOT-LLVM preferred) | Language symmetry; SpacetimeDB supports .NET 10 AOT alongside legacy .NET 8 |
| Shared rules | **Pure C# class library** (no `UnityEngine`) | Same move/combat/skill math on module + client prediction |
| C# / .NET target | **.NET 10 + C# 14** where the host allows | Span-first, zero-heap hot paths; SpacetimeDB module prefers .NET 10 NativeAOT-LLVM |
| Client host | **Unity 6.6+** (v1 host) | Official SpacetimeDB C# path; not forever — see [ADR 0002](adr/0002-client-host-webgpu.md) |
| Graphics | **WebGPU primary, WebGL 2 fallback** | Fast path + playable fallback; ship criteria = fallback ([ADR 0002](adr/0002-client-host-webgpu.md)) |
| Render pipeline | **URP** (Unity 6) | Built-in RP deprecated; matches WebGPU/stylized path |
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

## C# performance law

Fardel C# is written for **high-throughput, low-allocation** code — not “idiomatic LINQ everywhere.” Prefer the modern BCL performance surface (.NET 10 / C# 14 and forward):

- **`Span<T>` / `ReadOnlySpan<T>`** for slicing buffers, parsing, and hot loops without copying
- **`Memory<T>` / `ReadOnlyMemory<T>`** when spans must cross `async` or be stored briefly
- **`ref struct`**, **`stackalloc`**, and **inline arrays** for short-lived scratch that must not hit the heap
- **`ArrayPool<T>`** / reusable buffers for larger scratch; return in `finally`
- Avoid **LINQ**, **string concat in loops**, boxing, and per-tick `List`/`Dictionary` growth on hot paths

### Where each runtime applies

| Surface | Runtime reality | Rule |
|---|---|---|
| `Fardel.Shared` + tools/tests | Full **.NET 10** SDK | Strictest zero-alloc discipline; this is the reference implementation |
| SpacetimeDB module | **.NET 10 NativeAOT-LLVM → WASM** when tooling allows (else documented .NET 8 fallback) | Same APIs/principles; profile WASM carefully — AOT is the preferred path |
| Unity client | Unity’s shipped C# / IL2CPP profile (may lag desktop .NET) | Same *discipline* (no per-frame heap churn); use Span/pooling APIs Unity exposes; don’t assume every .NET 10 API exists |

**Kill criteria:** a reducer tick or client `Update` path that allocates on the hot path in a release/player build is a bug unless explicitly justified in an ADR.

## Tooling baseline

- SpacetimeDB CLI (`spacetime start`, `publish`, `generate --lang csharp`)
- .NET 10 SDK (module + shared library; prefer `spacetime init --lang csharp --dotnet-version 10` when scaffolding)
- Unity Hub + Unity 6.6+ with Web platform support
- `gh` + this repo as source of truth
- Headless / scripted proofs before art (see [MVP.md](MVP.md))

## Client host policy

Unity is the **v1** browser host. WebGPU preferred; **WebGL 2 must stay playable**. Replace Unity only after Shared is stable and a documented kill criterion fails (payload, crowd ceiling, or funded custom client). Details: [ADR 0002](adr/0002-client-host-webgpu.md).

## Reference projects

- [Blackholio](https://github.com/clockworklabs/Blackholio) — Unity + SpacetimeDB (C# or Rust server)
- SpacetimeDB `basic-cs` template — module + bindings bootstrap
- Prior POCs: unbound, spacetimedb-mmo-poc (lessons only)
