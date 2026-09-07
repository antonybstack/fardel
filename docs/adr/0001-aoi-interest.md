# ADR 0001: Area of Interest (interest management)

- **Status:** Accepted
- **Date:** 2026-09-06
- **Deciders:** Fardel (Antony + Unbound Team Lead)

## Context

Fardel needs **hundreds** of entities on-screen at 60–120 FPS in the browser, and **thousands** concurrent in a shard — not by syncing the whole world to every client.

Interest management (AOI) decides **which world rows each connection receives**. On SpacetimeDB that is primarily **subscription set membership**, not a custom Hordes/Unreal-style bitstream.

Constraints and lessons:

- Authority: intents-not-positions; SpacetimeDB is the world ([ARCHITECTURE.md](../ARCHITECTURE.md)).
- Combat fantasy: tab-target / auto-targeted skills — lower net precision needs than hitscan shooters.
- dek / hordes.io: **bucket-based proximity culling**, **dynamic tick** under load, **diff / change detection**, simple move validation over full shooter reconciliation ([LEARNINGS.md](../LEARNINGS.md), [dek.engineer](https://dek.engineer/), [Web Game Dev interview](https://www.webgamedev.com/interviews/dek-hordes)).
- Cadence already split conceptually: pose/combat hot; bag/skills/XP cold.

## Decision

### 1. Partition = stable grid chunks (buckets)

The world is divided into a regular **2D chunk grid** (XZ). Chunk size is a tunable constant (start in the **32–64 m** range once the yard has meters; exact value is not sacred).

Each movable entity has a **home chunk** derived from server pose. Chunk id is cheap to recompute on move.

**Rejected as primary mechanism:** continuous radius (“everything within N meters”) as the subscription key — harder to express as stable SpacetimeDB filters and thrashier at borders.

### 2. Neighborhood subscribe

A connection’s spatial interest is:

**current chunk + Moore neighborhood (8 neighbors)** → up to 9 chunks.

That set is what hot gameplay tables filter on (pose, vitals, cast, target/threat, short combat events).

### 3. Hysteresis on boundary crossing

Do not swap the subscription set on the first millimeter into a new chunk. Require **deeper entry** (e.g. cross an inner margin) or a short **dwell** before rebuilding neighborhood membership. Goal: no flicker / resubscribe storms when strafing chunk edges.

### 4. Cadence-split tables (non-negotiable)

| Cadence | Examples | Subscription |
|---|---|---|
| Hot / AOI | Pose, vitals, cast state, target, short combat events | Neighborhood (+ always-relevant) |
| Cold | Bag, equipment, skills, XP | Login / UI open — **never** on AOI hot path |

Do **not** put inventory or progression fields on the 20 Hz pose row.

### 5. Always-relevant overrides

Regardless of chunk, always include (when applicable):

- Local player (self)
- Party members (when party exists)
- Current tab-target
- Entities in an active cast / combat relationship with the local player

### 6. Load shed = pose rate / fidelity, not correctness

Under spike load (hordes lesson):

1. Lower **pose publish rate** (dynamic tick on imprecise data).
2. Optionally drop mid/far network LOD tiers when those exist.
3. **Never** degrade gold / XP / inventory / skill correctness to save bandwidth.

Even a low pose Hz (dek cited ~10 updates/s as still playable) beats a melted instance.

### 7. Network LOD — phased

- **v1 / MVP (through slice 4 scaffold):** one fine pose tier inside the neighborhood. No mandatory coarse tier yet.
- **Follow-up when metrics demand:** add a low-Hz / quantized **coarse pose** projection (separate table or projected rows) for outer interest if SpacetimeDB cannot rate-limit per subscriber. Do not invent this until slice 4 numbers say so.

### 8. Diff-friendly row shape

Prefer small, dirty-friendly hot rows. Avoid fat “Player” documents that mix cold and hot state. Only ship what changed where the stack allows.

### 9. Authority vs presentation

The server still simulates the shard/instance. AOI only limits **what clients subscribe to**. Unsubscribed ≠ nonexistent.

### 10. Prediction stays narrow

Unchanged: predict local WASD + cast windup only. No shooter-grade rollback for v1.

## Consequences

**Good**

- Maps cleanly to SpacetimeDB subscriptions (chunk keys / filters).
- Matches dek’s bucket + dynamic-tick spirit without copying the JS stack.
- Keeps table design honest before slice 1 schemas harden.
- Load behavior is explicit and testable.

**Tradeoffs**

- Chunk borders need hysteresis and good debug viz (draw chunk overlays in dev).
- Moore neighborhood can still be busy in a city square — load shed and later network LOD are required for true density.
- Exact chunk meters and publish Hz are tunables; treat them as data, not identity.

## Alternatives considered

| Option | Why not for v1 |
|---|---|
| Continuous radius AOI | Smoother feel; poor stable subscription unit; more churn |
| Whole-world subscribe | Fails shard-scale goals immediately |
| Server LOS / frustum interest | Valuable later; overkill for tab-target yard MVP |
| Shooter reconciliation / rollback | Wrong combat fantasy; complexity tax |
| Radius-only “soft” AOI in docs | Left decision ambiguous; this ADR closes it |

## SpacetimeDB implementation notes

- Express interest as **filters on chunk id** (and always-relevant ids), not per-frame “query all entities in radius then subscribe.”
- Prefer **moving the player’s subscription set** when the hysteresis gate fires, over continuous resubscribe.
- Keep hot and cold in **separate tables** so cold never rides AOI.
- If/when coarse LOD lands, prefer an explicit coarse table over overloading the fine pose row.
- Profile subscription churn and row update volume in slice 4; numbers drive chunk size and Hz, not vibes.

## Open follow-ups

- Lock initial `ChunkSizeMeters` and pose publish Hz in code constants once the yard exists.
- Party table + always-relevant wiring (post-MVP party is fine; leave the hook).
- ADR or amendment for `PoseCoarse` if slice 4 metrics demand network LOD.
- Debug: chunk boundary overlay + subscription-set HUD for QA.

## References

- [ARCHITECTURE.md](../ARCHITECTURE.md) — authority, cadence, prediction
- [MVP.md](../MVP.md) — slice 4 perf / AOI scaffold
- [STACK.md](../STACK.md) — perf honesty targets
- dek.engineer Real-time Networking (bucket culling, dynamic tick, diff checker)
