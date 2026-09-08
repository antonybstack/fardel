# Agent log

Reusable traps from farm PRs. **Not** the design keep/leave list ([LEARNINGS.md](LEARNINGS.md)). **Not** farm process ([ORCHESTRATION.md](ORCHESTRATION.md)).

Write when you lost real time on something the next seat will hit. Skip happy-path narration, one-off typos, and anything already below. Newest at the bottom. Procedure: [`.grok/skills/fardel-agent-log/SKILL.md`](../.grok/skills/fardel-agent-log/SKILL.md).

```
### YYYY-MM-DD — tag,tag — one-line symptom
- **Cause:** …
- **Do this:** …
- **Seen in:** #PR / #Issue
```

---

### 2026-09-08 — jump,feel — squash on `parts.root.scaling` + camera dip reads as rubber-band + slam
- **Cause:** `#139` scaled the wizard root and dipped the camera on jump. Live play felt like a stretch/recoil, not a WoW hop.
- **Do this:** Do not reintroduce `setHumanoidJumpSquash` or `jumpCamDipY` as hop juice. Helper leftover is P2 #283 — delete it, don't wire it back.
- **Seen in:** #139, revert #281 / #252, leftover #283

### 2026-09-08 — humanoid,babylon — Wizard.glb clips exist but the model draws T-pose
- **Cause:** `humanoid.ts` sets `m.skeleton = null` on meshes (workaround). Idle/Walk/Spell clips are on the GLB; they cannot run without the skeleton.
- **Do this:** Restore the skeleton before expecting clips. Do not "fix T-pose" by swapping in a capsule or another mesh.
- **Seen in:** #260 (E2.1)

### 2026-09-08 — place,fog — EXP2 fog bands; sky doesn't match the volume
- **Cause:** Sky dome color drifted from `scene.fogColor`. EXP2 + mismatched horizon reads as stacked bands.
- **Do this:** Keep sky = `fogColor`. Lighting/fog lock is #32/#39; density ~0.015, color ~(0.34, 0.55, 0.7). Place north star: https://ve.sparkify.dev/parity/hordes-place-ref.jpg
- **Seen in:** #282 / #270

### 2026-09-08 — ve — `python urllib` HEAD of `ve.sparkify.dev` returns 403
- **Cause:** The bucket/CDN rejects that client's User-Agent on HEAD.
- **Do this:** `curl -sI` for HTTP 200 / `image/png`. Do not treat a Python HEAD 403 as a missing VE.
- **Seen in:** Reviewer drain, campaign 2026-09-08

### 2026-09-08 — ve — `ve-upload.sh` prints "token unset" from bash
- **Cause:** `CLOUDFLARE_API_TOKEN` is set in Fish `~/.config/fish/config.fish`, not bash.
- **Do this:** `fish -c '/Users/antbly/dev/fardel/tools/scripts/ve-upload.sh <png> <pr>/<name>.png'`. Never print the token. Never commit `ve/*.png`.
- **Seen in:** LOOP.md; every UI PR

### 2026-09-08 — ve,playwright — Playwright MCP Chrome times out on `about:blank`
- **Cause:** MCP browser cannot launch/interact reliably on this host.
- **Do this:** Prove feel with harness `?ve=` + screenshot + `ve-upload.sh`, or a local Playwright script against the **seat** Vite (`:520N` + `?db=&module=`), never prod `:3000`.
- **Seen in:** Lead playpass; Dev4 VE capture

### 2026-09-08 — place,mountain — LINEAR fogEnd flattens distant ridges into a cardboard wall
- **Cause:** Scene LINEAR `fogEnd` (95 / 200) fully fogs any mesh past the forest. Peaks sitting on that plane read as a 2D strip.
- **Do this:** Backdrop mountains: `applyFog=false` + `fogEnabled=false` and bake dusk-blue value steps. Do not raise `fogEnd` just to “reach” the range (that clears the forest haze).
- **Seen in:** #295 / #273

### 2026-09-08 — ve,camera — establishing `?ve=` pose is eaten by the follow loop
- **Cause:** `ArcRotateCamera.setTarget(player)` each frame rebuilds alpha/beta/radius from the current camera position.
- **Do this:** Lock `?ve=sky-horizon` / `?ve=place-wow` (and similar establishing shots) inside the follow branch every frame. A one-shot set after connect is not enough.
- **Seen in:** #295 / #273, #276

### 2026-09-08 — place,disc — CreateDisc scaling.z after rotation.x=π/2 is a no-op
- **Cause:** `MeshBuilder.CreateDisc` is XY. `rotation.x = π/2` lays it on XZ; local Z becomes the disc normal (world Y). `scaling.z` does not squash world Z, so DummySpawn (5,0) sat on grass (ellipse 1.008).
- **Do this:** After that rotation, world-Z ellipse squash is `scaling.y`. Or use `CreateGround` (already XZ). Helper: `placeGroundDisc` in `forest.ts`.
- **Seen in:** #296 / #299

### 2026-09-08 — humanoid,babylon,skin — GPU skin of Wizard.glb is a sail, not a body
- **Cause:** Assimp FBX→glTF puts `CharacterArmature` scale 100 (not a joint) and glTF AUTO `__root__` `(1,1,-1)`. Extra parent `pivot.scaling` lands in `mesh.world` but not `boneFinal`, so IBM 0.01 no longer cancels. GPU/CPU skin is a degenerate triangle. Shared `StandardMaterial` compiled without BONES also yields zero fill. Crowd-proxy capsules at origin hide a slim body.
- **Do this:** Do not `m.skeleton = null`. Do not 1.8m-normalize with an extra scaled ancestor unless IBM is compensated. Hide `proxy_*` for character VE. `computeBonesUsingShaders=false` still double-skins if the effect has BONES (`useBones` ignores that flag).
- **Seen in:** #303 / #260

### 2026-09-08 — humanoid,babylon,skin — CPU skin deforms the visible wizard; rigid `__draw` is still T-pose
- **Cause:** GPU bone path + Assimp `CharacterArmature` *100 / -90X (not a joint) is a sail. CPU `applySkeleton` writes that leftover into mesh-local verts; `mesh.world` already has the armature, so the body vanishes unless IBM is multiplied by the armature local matrix. `instantiateModelsToScene` clones share geometry with the container source. `useBones` ignores `computeBonesUsingShaders`; a cached BONES effect double-skins. A `__draw` clone with `skeleton=null` is the old T-pose detach.
- **Do this:** Keep the skeleton on the **visible** mesh. `makeGeometryUnique`, hide container originals, multiply IBM by CharacterArmature local (scale+rot), `computeBonesUsingShaders=false`, strip JOINTS/WEIGHTS after each `applySkeleton` so the effect has no BONES. Do not rigid-clone. Do not assign a shared `StandardMaterial` onto Wizard.001. Hide `proxy_*` for character VE.
- **Seen in:** #303 / #260
