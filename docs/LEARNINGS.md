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

## Floating damage text (web)

- Prefer **NPC hp deltas** over a new damage-event table for combat floaters — server already mutates `npc.hp` on Spark/Emberbolt apply; client tracks `npcLastHp` and spawns billboard `DynamicTexture` planes. Keeps CombatSmoke / module unchanged.
- Unify local+remote cast presentation in `web/src/world/castVfx.ts` (Spark bolt+trail, Emberbolt thicker beam, impact pop) — cosmetic only; do not change CombatSmoke / Cast reducer timing.

## Party / always-relevant (invent)

- Session-scoped `PartyMember` (cleared on `ClientDisconnected`) keeps ADR 0001
  always-relevant simple: no durable roster to reconcile after reconnect.
- Prove always-relevant with **unsubscribe → neighborhood SQL + identity pose
  filters**, not `SubscribeToAllTables` — otherwise the smoke cannot show Moore
  exclusion. Identity SQL uses `0x` + `Identity.ToString()` hex.
- Browser: wholesale `party_member` + resubscribe when the always-relevant hex
  set changes so far party mates keep arriving after interest moves.

- Self-frame/bag HUD is client-only Cosmetics over Character (XP, staffEquipped, knowsSpark/Emberbolt); no player HP table yet — omit health rather than invent fake HP.

- Party member frames are client-only Cosmetics over `PartyMember` + remote poses (hex, leader, distance); no party HP table yet — omit health rather than invent fake HP.
- Robes mesh follows `Character.robesEquipped` like staff: hide hood/skirt/shoulders group; tint torso/arms drab when unequipped (casts remain staff-gated).

- Combat log is client-only Cosmetics over existing signals (cast intent, npc HP deltas, Character equip flips, PartyMember size) — no new combat-event table; keeps module/smokes unchanged.

- Public `Say` + `ChatMessage` is the multi-client chat path: Enter compose → reducer → wholesale `chat_message` insert → strip/toast (no optimistic echo). `tools/ChatSmoke` proves A→B.

- Say rate-limit is module-side over existing `ChatMessage.SentAt` (no new table): reject if last row from same identity is within `Chat.SayMinIntervalMs`. Client catches reducer `SenderError` and toasts kind `rate` — keeps ChatSmoke / wholesale chat path unchanged aside from the reject proof.
- XP floater reuses the damage-number billboard path (`spawnWorldFloater`) on `Character.Xp` deltas near the local player — Cosmetics only; no XP-event table.

- Browser `PartySay` adds a **local self-echo** after reducer commit when the RLS row has not yet appeared in `party_chat_message` (JS + AOI resubscribe can miss sender inserts). Headless `ChatSmoke` still proves true RLS: mate sees, outsider does not. Prefer fixing delivery later over trusting echo for authority.
- `PartySay` + `PartyChatMessage` uses SpacetimeDB RLS (`ClientVisibilityFilter` join on `party_member.party_id`) so `SubscribeToAllTables` still hides party rows from outsiders — prove with a third client in ChatSmoke, not client-side filtering alone. Join columns need `[Index.BTree]` (`PartyId` on both tables). RLS is STDB_UNSTABLE — keep the pragma on the module.
- `Whisper` + `WhisperMessage` uses RLS `sender = :sender OR recipient = :sender` (BTree on both identity columns). Headless ChatSmoke: A→B visible to A+B, hidden from C. Web `/w <hexprefix> text` resolves via live `player_pose` hex prefix (must be unique).
- Web `/p ` (or `/party `) prefix routes compose to `partySay`; party lines use `[P]` + green styling; toast kind `partySay`. Solo `CreateParty` is enough for `?ve=party-chat` screenshot; outsider proof stays headless. Whisper VE needs `tools/SecondClient` for a remote target (`?ve=whisper`).

