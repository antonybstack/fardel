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

### 2026-09-08 — humanoid,yaw — local wizard never turns; pose.yaw is always 0
- **Cause:** `Move` does not write `PlayerPose.Yaw` (spawn 0). Copying `samp.yaw` onto the root each frame fights any client facing.
- **Do this:** Visual yaw from camera-relative wish (shortest-path slerp). Do not send client positions. Do not copy `pose.yaw` onto the local mesh.
- **Seen in:** #263

### 2026-09-08 — feel,perf — grounded WASD feels late on the Place-scale pin
- **Cause:** Local avatar presentation-lerped 20 Hz XZ (up to 50 ms plus a slow frame). `ArcRotateCamera.setTarget` every follow frame rebuilds alpha/beta. Unique GLTF heroes at 5–7× with ALPHATEST on every pack leaf + 80 understory clones melted fillrate.
- **Do this:** Snap local grounded XZ. Mutate `camera.target` in place (do not `setTarget` on the play follow). ALPHATEST on hero canopies only; cap unique pack understory clones (~24). Do not lerp the local walker.
- **Seen in:** #315

### 2026-09-08 — camera,feel — RMB orbit dead after the #316 follow snap
- **Cause:** Play follow zeroed `inertialAlphaOffset` / `inertialBetaOffset` / `inertialRadiusOffset` every frame while mutating `camera.target`. Babylon `ArcRotateCameraPointersInput` applies RMB via `inertialAlphaOffset -= offsetX / angularSensibilityX`.
- **Do this:** Mutate `target.x/y/z` in place. Do **not** zero inertial offsets on the play follow. VE shots that lock alpha/beta may still clear inertia. `?ve=rmb-look` (cursor chrome) is not orbit — use `?ve=rmb-orbit` persistMark `RMB orbit OK · dAlpha`.
- **Seen in:** #366 / #316

### 2026-09-08 — humanoid,interp — remote Walk restarts every 20 Hz snapshot
- **Cause:** Grounded `advancePoseInterp` parks at `u=1` between snapshots. Frame-to-frame `hypot(dx,dz)/dt` on `samplePoseInterp` is 0 most frames, so `setHumanoidMoving(false)` stops Walk and restarts it from frame 0 on the next snap.
- **Do this:** Drive remote Walk from `PoseInterp` `vx,vz` while `u<1`, with ~150ms hold. Do not use parked sample deltas. `?ve=remote-walk` needs a moving other identity (`tools/SecondClient`); local `sendMove` does not create a remote XZ delta.
- **Seen in:** #313 / #267

### 2026-09-08 — ve,rebase — `veFollow` else-if chain conflicts on every E2 VE
- **Cause:** Each body PR adds a `veFollow === '…'` branch next to walk/yaw. Parallel PRs all edit the same else-if.
- **Do this:** Keep idle / walk / yaw / jump-pose / look-at / remote-walk / cast-anim as one chain. OR the new mode in; do not drop `idle` or `jump-pose`.
- **Seen in:** #317 / #269 vs #313/#318

### 2026-09-08 — ve,smoke — HTTP 200 of a T-pose PNG is not Idle VE
- **Cause:** Release/Pages VE treated persistMark `Quaternius char OK` / empty + PNG HTTP 200 as Done. Bind-pose T still GATE PASS 28/28 because the matrix had no client Idle check.
- **Do this:** Screenshot `?ve=idle` on a *seat* Vite (never `:3000` / db `fardel`). Quote persistMark: must match `/^Idle OK/` and contain `Idle_Weapon` + `skinned` ≥ 1. `T-POSE` / empty / `Quaternius char OK` = fail. IdleSmoke (`tools/IdleSmoke/run.sh` → `tools/qa/idle-smoke.mjs`) is the matrix gate.
- **Seen in:** #321 / Pages pin `3b7968d3`

### 2026-09-08 — humanoid,ve — forward W is Run so ?ve=walk would persistMark Run
- **Cause:** E8.2 maps camera-forward W to `Run_Weapon`. `?ve=walk` holds W, and the render-loop gait would override the Walk clip.
- **Do this:** Keep `ve === 'walk'` on Walk. `?ve=run` holds W and requests running. Do not `findAnim(Walk, Run_Weapon)` — Run must not alias as Walk.
- **Seen in:** #327

### 2026-09-08 — place,instance — parented glTF thin instances also draw at origin
- **Cause:** `thinInstanceSetBuffer` on a child of a pack `__root__` still renders the bind-pose mesh at the parent origin, so a CommonTree appeared on the dummy pad.
- **Do this:** `Mesh.MergeMeshes` the pack meshes (don't dispose sources), hide the template, instance the merged mesh at origin. Do not `placeClone` unique mid GLTFs. Parking the parent at y=-500 culls every instance (world = parent × instance).
- **Seen in:** #340

### 2026-09-08 — camera,trunk — Quaternius tree world AABB is not a bole
- **Cause:** TwistedTree bark+leaves share one mesh. Hero scale ~5.2 makes the XZ AABB ~30 m, which swallows the clearing if used as a collision cylinder.
- **Do this:** Discover `heroTree*` / `midTree_*` / `*_trunk` roots and collide a vertical cylinder of `scale * bole` (~1.55 hero / ~0.82 mid). Do not raycast foliage or the full world bbox. Keep E1 Y-spring; do not `setTarget` on the play follow.
- **Seen in:** #351

### 2026-09-08 — place,perf — pack glTF MASK on mid leaves survives unless forced opaque
- **Cause:** CommonTree glTF ships `alphaMode: MASK`. Skipping the ALPHATEST *set* still leaves the loader MASK, so unique or ThinInstance mids alpha-test every leaf (#315 fillrate).
- **Do this:** When `alphaTestLeaves` is false, force `PBRMATERIAL_OPAQUE` / `MATERIAL_OPAQUE` and clear `useAlphaFromAlbedoTexture`. ALPHATEST only on hero canopies. Mid ring is ThinInstances (`thinInstancePackRoot`), not unique clones.
- **Seen in:** #340 / #315

### 2026-09-08 — humanoid,jump — Wizard.glb has no Jump/Fall clip
- **Cause:** Pack clips are Idle/Walk/Run/Spell/Death/RecieveHit/Roll only — no Jump or Falling.
- **Do this:** Airborne: stop Walk/Run, hold Idle_Weapon at speedRatio 0 (staff grip, not T, not a walk cycle). Do not use Roll as a hop. Do not squash `root.scaling`.
- **Seen in:** #328

### 2026-09-08 — place,collision — pack bark AABB is branches, not the walking bole
- **Cause:** TwistedTree bark primitive includes limbs. World AABB × 0.42 then a 3.4 m clamp parks the player inside a ~6 m-scale bole. Server Move has no obstacle table.
- **Do this:** Author-scale chest-height radius × instance XZ (TwistedTree ~1.18, CommonTree ~0.52). Clip the WASD *wish* in `forest.ts`; do not send client positions; do not add Lib.cs capsules on E9.1. Keep dummy (5,0) / vendor (−2.5, 2) outside keep-out.
- **Seen in:** #339

### 2026-09-08 — humanoid,death — greyout still left a standing T
- **Cause:** Death UX only tinted the robe. Idle/Walk kept playing, so a dead wizard read as a grey T or fidgeting Idle.
- **Do this:** `setHumanoidDead` plays `Death` once and holds the last frame (`speedRatio` 0). Respawn starts Idle_Weapon. Loco/cast no-op while `dead`.
- **Seen in:** #329

