# Stack

Locked for Fardel v1. Change only with an explicit architecture decision record.

## Locked choices

| Layer | Choice | Why |
|---|---|---|
| World authority | **SpacetimeDB ≥ 2.3** | In-memory relational truth, reducers, binary row sync; already proven in unbound POCs |
| Server module | **C# → WASM** (.NET 10 NativeAOT-LLVM preferred) | Language symmetry; SpacetimeDB supports .NET 10 AOT alongside legacy .NET 8 |
| Shared rules | **Pure C# class library** (no engine APIs) | Same move/combat/skill math on module + client prediction |
| C# / .NET target | **.NET 10 + C# 14** where the host allows | Span-first, zero-heap hot paths; SpacetimeDB module prefers .NET 10 NativeAOT-LLVM |
| Client host | **Babylon.js 9 + TypeScript + Vite** (`web/`) | Code-first browser path agents can iterate; see [ADR 0003](adr/0003-babylon-web-client.md) |
| Graphics | **WebGPU preferred, WebGL fallback** (Babylon engine) | Fast path + playable fallback in modern browsers |
| Net SDK | **SpacetimeDB JS/TS SDK** (`spacetimedb`) | Generated bindings + `DbConnection`; call frame tick every animation frame |
| Presentation law | **Data-oriented** | Instancing / thin meshes for crowds; avoid per-frame heap churn in hot loops |

## Explicit non-choices (v1)

| Rejected | Reason |
|---|---|
| Unity as **active** v1 host | Paused — poor agent loop; preserved on `checkpoint/unity-webgl` ([ADR 0003](adr/0003-babylon-web-client.md)) |
| Stride | Weaker SpacetimeDB/browser proof vs current stack |
| Rust module + TS client | Breaks C# module symmetry goal; revisit only if C# module tick becomes the bottleneck |
| Bevy / unbound continuation | Wrong combat fantasy and language for this reboot |
| Custom WebGPU engine from day one | Too much runway before fun; ship Babylon first |
| PlayCanvas editor / dual clients | Code-first only; no second client track in MVP |

## Perf honesty

- **Target:** 60–120 FPS in browser on a mid-range laptop with **hundreds** of entities on-screen.
- **Scale:** **Thousands** of concurrent players in a shard via AOI / chunk subscriptions — not all rendered at once.
- Hordes.io’s own published lessons: dynamic tick under load, proximity culling, custom batching — we adopt the *ideas*, not a JS rewrite of their engine.

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
| Browser client (TS) | V8 / browser GC | Keep hot presentation loops lean; prefer typed arrays / pooled scratch over per-frame object churn |

**Kill criteria:** a reducer tick that allocates on the hot path in a release build is a bug unless explicitly justified in an ADR.

## Tooling baseline

- SpacetimeDB CLI (`spacetime start`, `publish`, `generate --lang typescript` / `csharp`)
- .NET 10 SDK (module + shared library + headless smokes)
- JS runtime **22+** + package manager (Vite client under `web/`)
- Pin **`@babylonjs/core@9.0.0`**
- `gh` + this repo as source of truth
- Headless / scripted proofs before art (see [MVP.md](MVP.md))

## Client host policy

**Babylon.js + TypeScript** is the **active** browser host ([ADR 0003](adr/0003-babylon-web-client.md)). Unity remains archived on `checkpoint/unity-webgl` @ `ca9b7d5` and is **not** on the MVP critical path. ADR 0002 still documents the historical Unity/WebGPU decision and exit criteria; it is **superseded for the active client host**.

## Reference projects

- SpacetimeDB TypeScript client docs + `spacetimedb` package
- SpacetimeDB `basic-cs` template — module + bindings bootstrap
- Prior POCs: unbound, spacetimedb-mmo-poc (lessons only)
- Unity checkpoint: `checkpoint/unity-webgl` (historical; not active)
