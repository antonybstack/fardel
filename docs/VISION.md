# Vision

## One line

A browser MMORPG where **the fardel is the class**: classless progression (skills + gear + inventory), hordes.io control feel, WoW-scale world ambition, SpacetimeDB authority.

## Pillars

1. **Bag-as-build** — No warrior/mage lock-in. What you train and what you carry defines the character (RuneScape-shaped design space).
2. **Browser-first** — Primary client is a web build. Native Unity editor is for development; players click a link.
3. **Tab-target combat** — hordes.io / classic WoW cadence: Tab target, hotbar skills, readable telegraphs. Not Souls-like timing in v1.
4. **Server authority** — SpacetimeDB owns truth. Clients send **intents**, never authoritative positions.
5. **Performance as a design constraint** — Hundreds on-screen at 60–120 FPS; thousands in-world via AOI. Do not promise thousands of skinned characters in one view.

## Control feel (MVP target)

| Input | Action |
|---|---|
| Hold RMB | Orbit / look camera |
| WASD | Move (camera-relative) |
| Tab | Cycle nearest hostile / target |
| 1–N | Skills on current target |
| Esc | Free cursor / cancel |

## Fantasy

You are a traveler defined by weight: tools, trophies, reagents, weapons. Progress is training skills and filling the pack with things that matter — not picking a class at character create.

## What we are not building (v1)

- Elden Ring / sheathe-draw action combat (that was unbound’s experiment; out of scope here)
- Full WoW trilogy content breadth
- Custom engine from scratch (Unity hosts; we enforce data-oriented presentation inside it)
- Stride or a second client stack in parallel
- Perfect 120 FPS with thousands of unique skinned actors on one screen

## Success for the vision doc

Someone new can read this page and know the game’s soul, controls, and hard nos without opening any code.
