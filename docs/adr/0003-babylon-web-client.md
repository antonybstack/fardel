# ADR 0003 — Babylon.js web client (Unity paused)

**Status:** Accepted (2026-09-07)  
**Context:** Unity 6 WebGL/WebGPU client was viable for visuals but a poor agent iteration loop (Editor locks, long batchmode builds, Pages compression quirks, GUI-only VE). MVP needs a code-first client Grok Bot can build/serve/smoke on the Mac without Unity Hub.

**Decision:** Pause Unity as the active client. Keep SpacetimeDB C# module + headless smokes as the authority path. Build the browser client with **Babylon.js + TypeScript** (Vite), SpacetimeDB JS/TS SDK, code-first (no PlayCanvas editor).

**Checkpoint:** Unity work frozen at `checkpoint/unity-webgl` (commit `ca9b7d5` and ancestors). May resume later; not on the MVP critical path.

**Main branch:** The Unity project tree (`client/`) and Unity-only tooling (`tools/scripts/serve-webgl.py`, `webgl-pages-headers`) are **removed from `main`**. Recover history from `checkpoint/unity-webgl` if needed. Do **not** delete that remote branch.

**Consequences:**
- Active client lives under `web/` (Vite + Babylon `@babylonjs/core@9.0.0`), deploys to `play.sparkify.dev`.
- Reuse existing module tables/reducers (Connect → Move → Combat → Persist → AOI).
- Prefer CLI/browser smokes over Editor VE.
- bitECS optional later; start with simple Maps/typed arrays until AOI load demands it.
- See [PLAN_BABYLON.md](../PLAN_BABYLON.md) for the full plan.
