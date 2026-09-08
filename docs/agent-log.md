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

### 2026-09-08 — humanoid,flinch — pack clip is RecieveHit (sic)
- **Cause:** Quaternius names the hit react `RecieveHit`, not ReceiveHit. `includes('RecieveHit')` can also match RecieveHit_Attacking.
- **Do this:** Prefer `/recievehit$/i`. One-shot then resume Idle/Walk. Do not cancel Move intents.
- **Seen in:** #330

### 2026-09-08 — humanoid,cast — Spell1 one-shot ends before Emberbolt CastEndsAt
- **Cause:** `playHumanoidCast` is a one-shot. Wizard.glb Spell1 is shorter than the windup, so Idle returns while the cast bar is still up.
- **Do this:** `setHumanoidCasting` loops Spell until CastEndsAt / cancel / interrupt. Spark stays the one-shot. Do not treat animation-end as the windup end.
- **Seen in:** #331

### 2026-09-08 — humanoid,cast — cancel stops Spell before Idle and flashes bind-T
- **Cause:** `setHumanoidCasting(false)` called `stopIfPlaying(cast)` then `setHumanoidMoving(false)`. One CPU-skin frame has no playing group → bind-T pop mid-Spell1. Recover via `setHumanoidMoving` also no-ops: that helper `return`s while `a.cast?.isPlaying`.
- **Do this:** Do not go through `setHumanoidMoving`. `applyStaffClips` + `startLoop(a.idle)` while Spell still plays, then `stopIfPlaying(a.cast)`. `?ve=cast-cancel-pose` persistMark names the recover clip + `skinned`. Do not change `?ve=cast-cancel` chrome mark.
- **Seen in:** #431 / #441

### 2026-09-08 — npc,smoke — first `Npc.Iter()` living row is not Dummy after hostiles
- **Cause:** #354 inserts Kind=2 yard hostiles. `if (n.Hp > 0) break` can pick a hostile; dummy thorns never fire.
- **Do this:** Find Dummy by `Kind == Combat.NpcKindDummy` (1). Do not assume Iter() order.
- **Seen in:** #354

### 2026-09-08 — place,path — polar `a ∈ (0.15, 0.55)` only opens the SE strip
- **Cause:** Mid/understory keep-out used polar angle, so a north/bent path stayed walled in and `?ve=place-wow` (looking north) never showed a receding trail.
- **Do this:** Keep-out with distance-to-polyline (`distToPath` in `forest.ts`). Polar SE skip does not follow a bent path.
- **Seen in:** #342

### 2026-09-08 — humanoid,staff — far play-cam Idle reads as a T
- **Cause:** `Wizard_Staff` is a rigid child of joint `Weapon.R`, not skinned. `Skeleton.clone` / IBM `updateMatrix` after Assimp *100 can leave bones on the container source, so the staff stays bind-T while CPU-skin Idle deforms the body. A StandardMaterial stick also vanishes into #39 fog at 12–20 m.
- **Do this:** After IBM compensate, `linkTransformNode` onto the cloned `Weapon.R`. Keep staff parented to that node (`alwaysSelectAsActiveMesh`). Keep loader PBR on the staff. Do not rigid-clone. Do not `skeleton=null`.
- **Seen in:** #332

### 2026-09-08 — camera,rmb — play RMB hides the cursor; ?ve=rmb-look is grabbing chrome
- **Cause:** #154 VE asserts `canvas.style.cursor === 'grabbing'`. WoW RMB-hold hides the pointer. One `setRmbLookArmed` drives both.
- **Do this:** Play / `?ve=rmb-orbit` → `cursor: none`. Keep grabbing only when `veRmbLookLock` (`?ve=rmb-look`). Do not fail RmbOrbitSmoke: persistMark still `/^RMB orbit OK/` + `dAlpha`.
- **Seen in:** #353 / #154 / #366

### 2026-09-08 — npc,aggro — CastRangeSmoke far-pose sits 3.6m from hostile pad B
- **Cause:** Pad B is (−7, 3). CastRangeSmoke walks to x=DummySpawnX−(range+2) ≈ −5, z=0. Dist to B is ~3.6m.
- **Do this:** Keep `Combat.HostileAggroRadius` under 3.6 so dummy-range smokes do not pull B. Origin is ~7.6m from both pads.
- **Seen in:** #355

### 2026-09-08 — humanoid,remote — remotes T while Walk isPlaying
- **Cause:** Per-clone Assimp IBM compensate multiplies `A` again on later `instantiateModelsToScene` copies (clone bind already has `A`). Local Idle reads; remotes collapse into a seated bind-T while clips `isPlaying`. `animationGroup.clone` can also keep container targets. After #327, full-step remotes select `Run_Weapon` so persistMark `/walk/` never matches.
- **Do this:** Compensate IBM once on the container in preload; relink + retarget cloned groups onto the instance pivot/bones. Drive remotes with Walk (not Run) from PoseInterp `vx,vz` hold. persistMark via `readHumanoidPlayback`: `Remote walk OK` + Walk named + `skinned` ≥ 1. `T-POSE` if skeleton=0. `?ve=remote-walk` needs `tools/SecondClient` (local `sendMove` is not a remote XZ delta). Mutate `camera.target` in place for the remote close-up — do not `setTarget`.
- **Seen in:** #333 / #313

### 2026-09-08 — camera,smoke — inertial inject is not RMB orbit
- **Cause:** `?ve=rmb-orbit` did `inertialAlphaOffset += 0.45`. RmbOrbitSmoke passed persistMark while a dead pointer path (or a new follow-loop zero) could still leave live RMB look dead. `?ve=rmb-look` is grabbing chrome.
- **Do this:** Observe `camera.alpha` after a Playwright `mouse.down({ button: 'right' })` drag on the play follow. persistMark OK only if `|dAlpha| > 0.15` after the drag. Fail if persistMark is OK before the drag. Seat Vite `window.__qa.getState().camera`. Do not `__qa.lookDelta`. Do not inject inertia.
- **Seen in:** #389 / #366

### 2026-09-08 — npc,combat-log — Character.Hp drop log is hardcoded Thorns
- **Cause:** Dummy was the only player-HP source. `pushCombatLog('damage', 'Thorns −…')` on any decrease.
- **Do this:** If a Kind=2 row is Aggroed, label Hostile. Dummy thorns stays Thorns when no hostile is pulled.
- **Seen in:** #356

### 2026-09-08 — humanoid,gait — Walk at 4.5 m/s slides / remotes moonwalk on lerp
- **Cause:** Wizard Walk stride is ~2.2 m/s (in-place clip; armature translation 0). Grounded wish is `MOVE_SPEED` 4.5. Remote grounded interp parks at `u=1` so the root eases then stops while feet cycle.
- **Do this:** `setHumanoidMoving(..., speedMps)` sets `speedRatio = clamp(mps / walk-or-run ref)`. Snap grounded remote XZ (same as local). Refresh Walk hold from the snap delta — snap zeros `vx`, so the #313 `u<1` hold would die.
- **Seen in:** #334

### 2026-09-08 — humanoid,scale — 1.8m from bind AABB leaves Idle feet off dirt
- **Cause:** Scale+plant used T-pose bounds before Idle_Weapon CPU-skin. Idle is shorter; feet float. A second scaled ancestor breaks Assimp IBM.
- **Do this:** Scale the existing pivot only. Re-plant after the first Idle CPU-skin (`onBeforeRender` once). persistMark height 1.5–2.15 m. Do not scale forest.
- **Seen in:** #336

### 2026-09-08 — place,hero — CommonTree hero still uses 0.52 author bole
- **Cause:** `boleRadiusWorld` used kind==='hero' → TwistedTree 1.18. A unique CommonTree at 5.8× then got a ~6.8 m keep-out (visual bole is ~3 m).
- **Do this:** Pass pack author (TwistedTree 1.18 / CommonTree 0.52). Kind stays `hero` for camera collision. Do not import extra megakit files.
- **Seen in:** #344

### 2026-09-08 — place,shadow — player blob vanishes on the dirt pad
- **Cause:** A grass-tuned radial disc (~0.6 center alpha) matches worn-dirt value, so spawn `?ve=place-wow` looks like no contact shadow. Hero blobs on grass still read.
- **Do this:** Separate player vs hero blob mats. Player center alpha ~0.88. Disc y≈0.058 above path; `disableDepthWrite`. Do not use cascade `ShadowGenerator` (E9.3 fillrate).
- **Seen in:** #346

### 2026-09-08 — humanoid,mat — clothLift on shared Wizard_Texture tints Face indigo
- **Cause:** Face and Wizard.001 share one PBR. `albedoColor` indigo multiply + `texture.level` 2.2 crushes atlas peach skin / blue cloth / brown hair into one robe.
- **Do this:** Clone a Face skin PBR (warm albedo, no robe multiply). Mild cloth multiply so the atlas still reads. Staff keeps wood PBR + a small tip orb. Do not `StandardMaterial` on Wizard.001.
- **Seen in:** #337

### 2026-09-08 — npc,tab — connection.cycleTarget still sorts Dummy first
- **Cause:** Pre-hostiles Tab sorted Kind=1 ahead of Kind=2. Hunt Tab lives in `cyclePreferHostiles` in `main.ts`.
- **Do this:** Play Tab uses the main.ts helper (in-range hostiles, then dummy). Do not call `net.cycleTarget()` for hunt. `?ve=tab-target` still `setTarget(dummy)`.
- **Seen in:** #358

### 2026-09-08 — place,fog — LINEAR fogEnd 200 bands the 480 m forest
- **Cause:** Fog hits 100% at 200 m while unfogged mountains continue, so the forest rim reads as a stacked band / halo vs sky=fogColor.
- **Do this:** LINEAR start 22 / end 260. Do not raise end to reach ridges (`applyFog=false` + baked steps). Do not switch EXP2. Sky lower band = fogColor.
- **Seen in:** #348

### 2026-09-08 — ve,npc — fight VE Tab can select the other in-range hostile
- **Cause:** From pad A melee both yard hostiles sit inside CastRange. `cyclePreferHostiles` sorts by id, so one Tab may land on pad B while pad A is the one swinging.
- **Do this:** Session fight VEs (`?ve=encounter`) `setTarget` the pulled pad. Do not treat one Tab as the aggroed NPC.
- **Seen in:** #361

### 2026-09-08 — humanoid,remote,cast — SecondClient 45s patrol + (-3,3) never sticks Emberbolt
- **Cause:** `tools/SecondClient` walked 45s then stood at (−3, 3). Dummy is (5, 0); CastRange 8 m so that pad is OOR. Move during windup also cancels. `?ve=remote-cast` timed out on Idle/Walk HUD while CastingSpellId stayed 0.
- **Do this:** Patrol in-range pads, EquipStaff, stand-cast Emberbolt immediately (no Move during CastEndsAt). persistMark via `readHumanoidPlayback`: `Remote cast OK` + Spell named + `skinned` ≥ 1. Mutate `camera.target` for `?ve=remote-cast` (do not `setTarget`). Env `FARDEL_SPACETIME_URI` + `FARDEL_DB` — never `:3000` / db `fardel`.
- **Seen in:** #403

### 2026-09-08 — humanoid,remote,flinch — remotes stay Idle/Walk on HP drop
- **Cause:** `playHumanoidFlinch` returned while `a.casting`. SecondClient Emberbolt thorns land on the CastEndsAt tick; `syncRemoteCastFx` runs after `syncRemoteMeshes`, so the HP delta is recorded under last-frame Spell and never retried. `setHumanoidDead` was never called for remotes, so Hp=0 kept Walk.
- **Do this:** Interrupt Spell for RecieveHit (`playHumanoidFlinch` clears `casting`). `setHumanoidDead` on remote Hp=0. Do not stomp a playing flinch with Spell. `?ve=remote-death` + `FARDEL_SECOND_DIE=1` DummyStrike. persistMark names Death/RecieveHit + `skinned`. Mutate `camera.target` (do not `setTarget`).
- **Seen in:** #429

### 2026-09-08 — ve,hostile — ?ve=hostile-body fails 1/2 after a Kind=2 kill
- **Cause:** Harness required `hp > 0` Idle. Dead Kind=2 still occupy pads and do not respawn; #404 corpse is still a skinned person. Seat VE after RecieveHit/Death then read 1/2 living.
- **Do this:** Count Kind=2 skinned `Idle|Death`. Require ≥1 living Idle + dummy trainer (no humanoid). persistMark `Hostile body OK` + Idle_Weapon + `skinned` ≥ 1. `capsule` / `T-POSE` = fail. Do not add a respawn reducer from this lane.
- **Seen in:** #405

### 2026-09-08 — npc,smoke — Hostile* smokes pin Kind==2 on pads A/B
- **Cause:** `CountHostiles` / `LivingHostiles` / `FindHostileNear` require `Kind == NpcKindHostile`. Flipping pad B to Kind=3 makes HostileSpawnSmoke `living.Count < 2`.
- **Do this:** Keep pads A/B Kind=2. Second type is Kind=3 on pad C (`HostileSpawnC*`). `Combat.IsHostileKind` for aggro/leash/swing. Find Dummy by `Kind == 1`. Keep `HostileAggroRadius` under 3.6. `#423` asserts both types.
- **Seen in:** #418

### 2026-09-08 — npc,kick — Kick(Identity) is PvP; Dummy is not a Kick target
- **Cause:** Kick looks up Character + PlayerCombat on Identity. NPCs have ulong NpcId. Hostiles do not cast. Origin is ~7.6m from pads A/B/C — inside KickRange 8, outside AggroRadius 3.
- **Do this:** KickNpc(ulong) for living Dummy + IsHostileKind. Dummy stays planted (no shove, no thorns). Hostiles: delay NextSwingAtMicros + shove away. Keep Kick(Identity) for KickSmoke PvP. FindHostileNear pins Kind==2.
- **Seen in:** #419

### 2026-09-08 — npc,stun — Stun(Identity) is PvP; StunRange 5 misses yard pads
- **Cause:** Stun looks up Character + PlayerCombat on Identity. Dummy at 5m is in StunRange; pads A/B/C are ~7.6m (KickRange 8 reached them from origin). Hostiles do not Move/Cast, so the lock is Npc.StunnedUntilMicros.
- **Do this:** StunNpc(ulong) for living Dummy + IsHostileKind. Dummy stays planted. Hostiles: StunnedUntilMicros + skip chase/swing for StunNpcLockMs. VE walks to ~4m (inside 5, outside AggroRadius 3). Keep Stun(Identity) for StunSmoke PvP. FindHostileNear pins Kind==2.
- **Seen in:** #420

### 2026-09-08 — humanoid,staff — unequip still plays Idle_Weapon (floating grip)
- **Cause:** `findAnim(..., 'Idle')` is `includes`, so it returns Idle_Weapon. `setHumanoidStaffEquipped(false)` hid the stick then returned without swapping the clip.
- **Do this:** Exact bare clip names (`Idle` ≠ `Idle_Weapon`, `Run` ≠ `Run_Weapon`). Unequip selects unarmed Idle/Run. `?ve=idle` still Idle_Weapon + skinned. `?ve=sheathed` persistMark `Sheathed OK` + `Idle` (no Weapon) + skinned, staff mesh off.
- **Seen in:** #430

### 2026-09-08 — humanoid,npc — Kind=3 violet robe washed to the same pink as Kind=2
- **Cause:** `createPlayerHumanoid` lifts cloth as `0.72 + robe*0.55`, so brigand violet and hostile crimson both land near white-lavender under #39 fog. Same wizard staff silhouette.
- **Do this:** `variant: 'brigand'` skips the wash, hides staff/pads, starts unarmed Idle. persistMark names both clips + `skinned`. Dummy stays scarecrow. Do not flip pad Kind (pads A/B stay Kind=2).
- **Seen in:** #428
