# Scope contract

This page keeps Fardel **on the yard path**. Ambition lives in [VISION.md](VISION.md); **execution order** lives here and in [MVP.md](MVP.md).

If a task does not move the **active wave’s session Done-when** on [play.sparkify.dev](https://play.sparkify.dev), it waits. Waves: [CAMPAIGN.md](CAMPAIGN.md).

## North-star demo (POC complete)

> Two browser clients in a **forest clearing** with huge trees and distant mountains: **RS-simple** staff/robe humans, WASD + RMB camera, tab-target a dummy, cast **Spark** and **Emberbolt** on a **shared GCD**, refresh and keep XP + loadout, without subscribing the whole map.

That sentence is **met** on `develop` (party, loot, trade, vendor, rest, bandage, mana, HUD). Shipping it to Pages is **Wave 0**. After that, the finish line is the **campaign session**, not more toast chrome.

## One active wave

- Work **one** campaign wave at a time ([CAMPAIGN.md](CAMPAIGN.md)).
- Do not start wave N+1 until wave N’s session Done-when is true **on Pages** (or explicitly waived here).
- Proof > polish: a failing smoke script blocks “wave done.”

## Now / next / not now

### Now (campaign)

| In | Out (park it) |
|---|---|
| Active wave in [CAMPAIGN.md](CAMPAIGN.md) (12h character / place / encounter) | Continents, mounts, auction house |
| Classless bag-as-build; intents not positions | Class lock-in, client-sent positions |
| Kitbash until Wave 5 free/OSS pack pass ([ASSETS.md](ASSETS.md)) | Custom character creator, photoreal, cinema VFX, **paid** packs |
| Chunk AOI as designed ([ADR 0001](adr/0001-aoi-interest.md)) | Coarse network LOD, LOS interest, multiple shards |
| SpacetimeDB module + Shared + headless smokes | Second client engine / custom WebGPU from scratch |
| Babylon.js web client (active) — [ADR 0003](adr/0003-babylon-web-client.md) | Unity client (paused on `checkpoint/unity-webgl`) |
| `play` Pages + `dev-db` preview tunnel | Prod MainCloud / `db.sparkify.dev` hard cutover |
| Span-first / zero-heap **discipline** in new C# | Premature micro-optim hunt with no slice-4 numbers |

### Next (after the current wave is on Pages)

- File the next wave’s Issues from [CAMPAIGN.md](CAMPAIGN.md) only after E8–E10 are on Pages (PvP → second zone → 4-spell book → look-language)
- Pick real **free/OSS** asset packs + fill credits ledger (Wave 5)
- Prod authority host decision
- Coarse pose tier only if metrics demand (ADR 0001 follow-up)

### Not now (explicit anti-goals)

Do **not** start these as a substitute for the active wave:

- Full classless skillscape / RS skill list
- Auction house, clans, quests, housing
- Action combat / lock-on souls hybrid
- Dual client (Unity + Babylon in parallel for players)
- Replacing SpacetimeDB or rewriting in Rust “for perf”
- Perfect UI chrome, settings menus, tutorial systems (Wave 0/1 are not toast tickets)
- World editor / content pipeline beyond placing pack assets in the active wave’s places
- Mobile-native client
- Monetization / accounts product surface beyond SpacetimeDB identity

## Distraction triggers (say no)

If an idea sounds like any of these, park it in a note — don’t branch the plan:

- “While we’re in the scene, let’s add a second biome / cave / town.”
- “We should build the full bag UI before move feels good.”
- “Let’s evaluate Stride / Bevy / custom WebGPU again.”
- “We need 20 spells so combat isn’t boring.” (Wave 4 is **four** skills, not twenty.)
- “Prod scale / 10k CCU design before two clients share a dummy.”
- “General-purpose engine framework for future games.”
- “Bring Unity back onto main before Babylon Connect is green.”

## Decision gate

| Kind of change | What to do |
|---|---|
| Moves current **wave** session Done-when ([CAMPAIGN.md](CAMPAIGN.md)) | Just do it |
| Changes locked stack / AOI / client host | ADR + update STACK/ARCHITECTURE |
| New gameplay system not in north-star | Add to **Not now**; do not implement |
| Art pack choice | Fits [ASSETS.md](ASSETS.md); one env + one character; record credits |
| Unsure | Default **no**; ask in chat with the slice id |

## Locked docs (don’t re-litigate weekly)

| Topic | Where |
|---|---|
| Fantasy / pillars | [VISION.md](VISION.md) |
| Stack | [STACK.md](STACK.md) |
| Net / sim / C# perf | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Slices | [MVP.md](MVP.md) |
| Post-POC campaign waves | [CAMPAIGN.md](CAMPAIGN.md) |
| Art bar | [ASSETS.md](ASSETS.md) |
| AOI | [ADR 0001](adr/0001-aoi-interest.md) |
| Client host (active) | [ADR 0003](adr/0003-babylon-web-client.md) |
| Historical Unity / WebGPU | [ADR 0002](adr/0002-client-host-webgpu.md) (superseded for active host) |
| Babylon plan | [PLAN_BABYLON.md](PLAN_BABYLON.md) |

Revisit locks only with a new ADR (or an explicit superseding decision), not drive-by chat.

## Proof culture (execution)

Prove authority with headless smokes first; Babylon presentation follows:

- `tools/ConnectSmoke` (slice 0)
- `tools/MoveSmoke` (slice 1)
- `tools/CombatSmoke` (slice 2)
- `tools/PersistSmoke` (slice 3)
- `tools/StaffEquipSmoke` (slice 3 optional — unequip blocks Cast)
- `tools/AoiSmoke` (slice 4)
- `tools/PartySmoke` (party / always-relevant invent)
- `tools/LootSmoke` (world loot / pickup invent)
- `tools/TradeSmoke` (player trade invent)
- `tools/VendorSmoke` (yard vendor buy/sell invent)
- `tools/TonicSmoke` (yard tonic use invent)
- `tools/PartyXpSmoke` (party XP share invent)
- `tools/PartyLootSmoke` (party loot share invent)
- `tools/RestSmoke` (out-of-combat Rest invent)
- `tools/BandageSmoke` (yard bandage consumable invent)
- `tools/ManaSmoke` (mana / focus pool invent)
- `tools/CastCancelSmoke` (Emberbolt cancel / move-interrupt invent)
- `tools/CastPushbackSmoke` (dummy-thorns windup pushback invent)
- `tools/HardInterruptSmoke` (hard-interrupt threshold invent)
- `tools/CastSilenceSmoke` (post-interrupt silence invent)

Browser Connect / yard art lives in `web/` (Vite + Babylon). Unity is not required for slice gates.

## Weekly focus check

Before starting work, answer:

1. Which **wave** am I on ([CAMPAIGN.md](CAMPAIGN.md))?
2. Does this task change that wave’s **session Done-when** on Pages?
3. If no — stop, or file under Not now.

## Status

- **Phase:** **campaign** — POC north-star met on `develop`; Wave 0 is Pages cut; then hunt/PvP/second place ([CAMPAIGN.md](CAMPAIGN.md))
- **Web milestone (Unity):** checkpointed on `checkpoint/unity-webgl` (`ca9b7d5`); Unity tree removed from `main`
- **Active client:** **Babylon.js + TypeScript** (code-first); SpacetimeDB C# module + headless smokes unchanged (see ADR 0003)
- **Babylon presentation:** Connect / Move / Combat / Persist / **AOI** green; **forest kitbash** (`ve/babylon-forest.png`); **humanoid+staff** (`ve/babylon-humanoid.png`); **humanoid polish** (`ve/babylon-humanoid-polish.png`); **path/ground polish** (`ve/babylon-path-ground.png`); **sky/horizon silhouette** (`ve/babylon-sky-horizon.png`); **training dummy scarecrow** (`ve/babylon-dummy.png`); **second-client shared yard** green (`ve/babylon-two-client.png`); **remote cast/target telegraphs** (`ve/babylon-remote-cast.png`); **floating damage numbers** (`ve/babylon-damage-text.png`); **floater stacking clarity** (`ve/babylon-floaters.png`); **floater readability** (`ve/babylon-floater-read.png`); **party / always-relevant** (`ve/babylon-party.png`); **staff unequip gates casts** (`ve/babylon-staff-equip.png`); **minimap / compass HUD** (`ve/babylon-minimap.png`); **world nameplates** (`ve/babylon-nameplates.png`); **selected-target frame HUD** (`ve/babylon-target-frame.png`); **target contrast** (`ve/babylon-target-contrast.png`); **cast bar readability** (`ve/babylon-castbar-read.png`); **GCD bar chrome readability** (`?ve=gcd-read`); **spell hotbar** (`ve/babylon-hotbar.png`); **self-frame + bag/loadout** (`ve/babylon-bag.png`); **party member frames** (`ve/babylon-party-frames.png`); **robes mesh visual** (`ve/babylon-robes-equip.png`); **combat log strip** (`ve/babylon-combat-log.png`); **FPS / perf overlay** (`ve/babylon-fps.png` — 30 fps floor stated on box ref); **system toast banner** (`ve/babylon-toasts.png`); **toast readability** (`?ve=toast-read`); **dummy death / respawn VFX** (`ve/babylon-death.png`); **chat / public Say** (`ve/babylon-say.png`); **Say rate-limit** (1s/identity + toast `rate`); **XP floater** (`ve/babylon-xp-float.png`); **party/whisper chat channels** (`ve/babylon-party-chat.png` / `ve/babylon-whisper.png`); **world loot / pickup** (`ve/babylon-loot.png`); **player trade** (`ve/babylon-trade.png`); **yard vendor** (`ve/babylon-vendor.png`); **vendor stall silhouette** (`ve/babylon-vendor-stall.png`); **vendor panel chrome** (`?ve=vendor-panel`); **yard tonic use** (`ve/babylon-tonic.png`); **player HP / death-respawn** (`ve/babylon-player-hp.png`); **death UX clarity** (`ve/babylon-death-ux.png`); **self thorns floaters + ghost tint while dead**; **party frames HP** (`ve/babylon-party-hp.png`); **party XP share** (`ve/babylon-party-xp.png`); **party loot share** (`ve/babylon-party-loot.png`); **minimap party blips** (`ve/babylon-minimap-party.png`); **character level from XP** (`ve/babylon-level.png`); **out-of-combat Rest** (`ve/babylon-rest.png`); **yard bandage** (`ve/babylon-bandage.png`); **mana pool** (`ve/babylon-mana.png`)
- **POC north-star:** closer — remaining invent: credited art packs for humanoid (loot/pickup + player trade + yard vendor + yard tonic + player HP + party frames HP + party XP share + party loot share + minimap party blips + character level + Rest + yard bandage + mana invent done; art packs still blocked)

- `tools/KickSmoke` (Kick / Counterspell interrupt invent)
- `tools/StunSmoke` (Stun / Bash hard-CC invent)
