# Learnings

What Fardel keeps from prior work — and what it leaves behind.

## From unbound (Rust / Bevy / SpacetimeDB)

**Keep**
- SpacetimeDB as authority
- Intents, not client positions
- Shared sim math crate/library
- Browser-first ambition + one-machine E2E loop
- Thin automated proofs before cosmetics
- Audio/feature footguns: enable the formats you actually ship (Bevy `wav` lesson)

**Leave**
- Bevy + Rust client
- Sheathe/draw Elden Ring combat fantasy for v1
- “Bag is your class” as flavor text only — Fardel makes classless progression the center

## From spacetimedb-mmo-poc

**Keep**
- Early SpacetimeDB wiring lessons and local publish habits
- Willingness to throw away a POC when the fantasy is wrong

**Leave**
- POC structure as production architecture

## From dek / hordes.io

**Keep**
- Binary, minimal deltas — don’t resend what the client can simulate
- Chunk / proximity culling and selective visibility
- Dynamic tick under load for imprecise streams
- Tab-target / soft-target MMOs don’t need FPS rollback
- Custom **batching mindset** for crowds (even inside Unity)
- Feel over perfect determinism

**Leave**
- Node + Postgres as the live gameplay store (SpacetimeDB replaces that role for hot state)
- Rewriting a bespoke JS renderer on day one

## From Gemini planning pass

**Keep**
- C# symmetry (module + client + shared)
- IL2CPP / AOT for web
- Zero-allocation hot loops, `Span<T>`, pooling
- GPU instancing / VAT direction for density

**Temper**
- “120 FPS + thousands of players in one browser tab” → hundreds on-screen, thousands in-shard via AOI

## Design north star

**Classless like RuneScape, carried like a Reliquary, controlled like hordes.io, scaled like a careful WoW shard.**

The name **Fardel** is the reminder: the load you carry *is* the character.

## C# performance stance

Treat **.NET 10 / C# 14 Span-first, zero-heap hot paths** as a first-class design constraint (see [STACK.md](STACK.md) / [ARCHITECTURE.md](ARCHITECTURE.md)). Unity and SpacetimeDB WASM may lag desktop BCL features — Shared stays on full .NET 10 so we don’t invent a second, sloppy dialect.

## AOI (interest management)

Fardel follows dek/hordes **bucket culling + dynamic tick** ideas via SpacetimeDB subscriptions: stable chunks, Moore neighborhood, hysteresis, pose-rate load shed. Decision: [ADR 0001](adr/0001-aoi-interest.md).

## Client host / WebGPU

Unity is v1 only; keep Shared pure so a custom WebGPU client stays possible later. WebGL2 stays playable. Decision: [ADR 0002](adr/0002-client-host-webgpu.md).

