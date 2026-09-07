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

- Self-frame/bag HUD reads Character (XP, Hp/MaxHp, staff/robes, known spells, tonic); HP bar is authority-backed — do not invent client-only health.

- Party member frames are client-only Cosmetics over `PartyMember` + remotes + wholesale `Character` (hex, leader, distance, **Hp/MaxHp** bars for You + mates). Character is Public wholesale — no separate always-relevant Character SQL; cache via `getCharacterFor`. Do not invent client-only health.
- Robes mesh follows `Character.robesEquipped` like staff: hide hood/skirt/shoulders group; tint torso/arms drab when unequipped (casts remain staff-gated).

- Combat log is client-only Cosmetics over existing signals (cast intent, npc HP deltas, Character equip flips, PartyMember size) — no new combat-event table; keeps module/smokes unchanged.

- Public `Say` + `ChatMessage` is the multi-client chat path: Enter compose → reducer → wholesale `chat_message` insert → strip/toast (no optimistic echo). `tools/ChatSmoke` proves A→B.

- Say rate-limit is module-side over existing `ChatMessage.SentAt` (no new table): reject if last row from same identity is within `Chat.SayMinIntervalMs`. Client catches reducer `SenderError` and toasts kind `rate` — keeps ChatSmoke / wholesale chat path unchanged aside from the reject proof.
- XP floater reuses the damage-number billboard path (`spawnWorldFloater`) on `Character.Xp` deltas near the local player — Cosmetics only; no XP-event table.

- Browser `PartySay` adds a **local self-echo** after reducer commit when the RLS row has not yet appeared in `party_chat_message` (JS + AOI resubscribe can miss sender inserts). Headless `ChatSmoke` still proves true RLS: mate sees, outsider does not. Prefer fixing delivery later over trusting echo for authority.
- `PartySay` + `PartyChatMessage` uses SpacetimeDB RLS (`ClientVisibilityFilter` join on `party_member.party_id`) so `SubscribeToAllTables` still hides party rows from outsiders — prove with a third client in ChatSmoke, not client-side filtering alone. Join columns need `[Index.BTree]` (`PartyId` on both tables). RLS is STDB_UNSTABLE — keep the pragma on the module.
- `Whisper` + `WhisperMessage` uses RLS `sender = :sender OR recipient = :sender` (BTree on both identity columns). Headless ChatSmoke: A→B visible to A+B, hidden from C. Web `/w <hexprefix> text` resolves via live `player_pose` hex prefix (must be unique).
- Web `/p ` (or `/party `) prefix routes compose to `partySay`; party lines use `[P]` + green styling; toast kind `partySay`. Solo `CreateParty` is enough for `?ve=party-chat` screenshot; outsider proof stays headless. Whisper VE needs `tools/SecondClient` for a remote target (`?ve=whisper`).
- Minimal player trade: session-scoped `TradeOffer` (PK = recipient) mirrors `PartyInvite`; Offer/Accept re-check XZ range; transfer `HasEmberShard` and/or capped XP on `Character` — no new inventory table. Headless `TradeSmoke` proves range reject + cancel + shard/XP transfer; browser `?ve=trade` + `TradeMate` auto-accept for bag/toast shot.
- Yard vendor: public `YardVendor` (seeded on connect) + range-checked `BuyFromVendor`/`SellToVendor` transferring XP↔`HasEmberShard` (no new inventory table); headless `VendorSmoke` proves out-of-range + buy/sell XP restore; Babylon **E** buy-or-sell from bag flag (`?ve=vendor`).

- Yard tonic use: `Character.HasYardTonic` + `TonicExpiresAt`; `BuyYardTonic` (vendor XP) grants bag flag; `UseYardTonic` consumes it for a 15s move-speed buff (`Tonic.MoveSpeedMult` on Move clamp). Headless `TonicSmoke` proves empty/range reject + buffed step; Babylon **V** use + self-frame buff timer (`?ve=tonic`).

- Player HP / death/respawn: durable `Character.Hp`/`MaxHp` + dummy thorns on `ApplyDamage` (keeps Cast NPC-only so CombatSmoke stays green); `PendingPlayerRespawn` schedules yard-origin full-HP revive; Move/Cast gate on `Hp≤0`. Headless `PlayerHpSmoke`; Babylon self-frame HP + death greyout + self thorns floaters + ghost robe tint while dead (`?ve=player-hp`).
- Party frames HP: same `Character.Hp`/`MaxHp` wired into left-column party roster (`?ve=party-hp` + PartyMate thorns so mate bar is mid); keep `PartySmoke` / `PlayerHpSmoke` green — no module change.
- Party XP share: on dummy/NPC kill, killer still gets `Combat.XpPerKill`; each other `PartyMember` mate gets `Combat.PartyXpSharePerMate` (50%, always-relevant — no distance gate). Headless `PartyXpSmoke`; Babylon mate toast/floater via existing `Character.Xp` delta path (`?ve=party-xp` + PartyMate share kill). Keep `CombatSmoke` green.
- Party loot share: on dummy death WorldLoot drop, each other `PartyMember` mate within `Loot.PartyShareRangeMeters` of the corpse gets an extra `ember_shard` WorldLoot near their pose (killer keeps primary drop). Headless `PartyLootSmoke`; Babylon toast/log on nearby share insert (`?ve=party-loot` + PartyMate share kill). Keep `LootSmoke` / `CombatSmoke` green.
- Minimap party blips: client-only over subscribed remotes — `RemotePose.party` already marks always-relevant mates; draw distinct green halo + rim chevron when beyond compass range (poses already arrive via party identity SQL). `?ve=minimap-party` + PartyMate far pose; no module change.
- Character level from XP: shared `Progression.LevelFromXp` (L2 at 10 XP / one kill); persist `Character.Level` high-water on kill / party share / loot / trade / vendor sell; Connect syncs pre-schema rows; headless `LevelSmoke`; Babylon `Lv N` on self/nameplate/party/bag + toast `level` + floater (`?ve=level`). Keep `CombatSmoke` / `PersistSmoke` green.
- Out-of-combat Rest: `Rest` reducer heals `Character.Hp` by `Rest.HealAmount` toward `MaxHp` with `RestReadyAt` cooldown; gates on `PlayerCombat.CastingSpellId` and `LastDamagedAt` (`Rest.CombatLockMs`); ApplyPlayerDamage stamps LastDamagedAt; headless `RestSmoke`; Babylon **R** + heal floater/toast (`?ve=rest`). Keep `CombatSmoke` / `PlayerHpSmoke` green.
- Mana pool: `Character.Mana`/`MaxMana`; Spark/Emberbolt spend at Cast start (`Combat.SparkManaCost`/`EmberboltManaCost`); reject `Insufficient mana`; lazy regen via `LastManaTickAt` + Rest `ManaRestore`; headless `ManaSmoke`; Babylon self-frame mana bar, hotbar `lowMana` dim, toast `mana` (`?ve=mana`). Keep `CombatSmoke` green (costs fit ~7 Sparks + Emberbolt).
- Cast cancel / move-interrupt: Move during Emberbolt windup (or `CancelCast` / Esc) deletes `PendingCast`, clears `CastingSpellId`, refunds mana spent at Cast start; `ResolveCast` no-ops if casting cleared. Headless `CastCancelSmoke`; Babylon clear cast bar + toast `castCancel` (`?ve=cast-cancel`). Keep `CombatSmoke` / `ManaSmoke` green.
- Cast pushback: non-lethal player damage during Emberbolt windup delays `CastEndsAt` by `Combat.CastPushbackMs` and reschedules `PendingCast` (still casting, **no mana refund**). Opt-in `DummyStrike` applies dummy thorns so CombatSmoke / ManaSmoke Emberbolt land timing is unchanged. Headless `CastPushbackSmoke`; Babylon rewound cast bar + toast `castPushback` (`?ve=cast-pushback`). Keep `CastCancelSmoke` / `CombatSmoke` / `ManaSmoke` green.
