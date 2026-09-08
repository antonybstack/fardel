import {
  AnimationGroup,
  AssetContainer,
  Color3,
  Matrix,
  Mesh,
  PBRMaterial,
  Scene,
  SceneLoader,
  Skeleton,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Node } from '@babylonjs/core/node';
import '@babylonjs/loaders/glTF';

/** Robe cloth emissive scale — keep restores in main.ts in sync. */
/** Modest cloth fill — mid-sat under #39 cyan fog; avoid neon/white-out. */
export const ROBE_EMISSIVE_SCALE = 0.08;

/** Public path to vendored Quaternius wizard (CC0). */
export const QUATERNIUS_WIZARD_URL =
  '/third-party/quaternius-lowpoly-rpg-characters/Wizard.glb';

export type HumanoidParts = {
  /** Root at feet; rotate yaw on this. */
  root: Mesh;
  /** Primary material used for cast flash / tint (torso/arms robe cloth). */
  mat: StandardMaterial;
  staff: Mesh;
  /** Hood + skirt + shoulders group — hide when robes unequipped. */
  robes: Mesh;
  /** Base robe diffuse (restore when re-equipped). */
  robeBaseColor: Color3;
};

export type HumanoidOptions = {
  /** Mesh name prefix (default "player"). */
  name?: string;
  /** Robe / cloth diffuse (local blue, remotes teal/green/magenta). */
  robeColor?: Color3;
};

type HumanoidAnim = {
  idle: AnimationGroup | null;
  walk: AnimationGroup | null;
  run: AnimationGroup | null;
  /** Jump/Fall if the GLB has one; Wizard.glb does not. */
  air: AnimationGroup | null;
  cast: AnimationGroup | null;
  airborne: boolean;
};

const animByRoot = new WeakMap<Mesh, HumanoidAnim>();

let sharedContainer: AssetContainer | null = null;
let sharedLoad: Promise<AssetContainer> | null = null;

function mat(
  scene: Scene,
  name: string,
  diffuse: Color3,
  emissiveScale = 0.06,
): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = diffuse;
  m.specularColor = new Color3(0.08, 0.08, 0.1);
  m.emissiveColor = diffuse.scale(emissiveScale);
  return m;
}

/** Preload vendored wizard GLB once per scene (call before createPlayerHumanoid). */
export function preloadPlayerHumanoid(scene: Scene): Promise<AssetContainer> {
  if (sharedContainer && sharedContainer.scene === scene) {
    return Promise.resolve(sharedContainer);
  }
  if (!sharedLoad) {
    sharedLoad = SceneLoader.LoadAssetContainerAsync(
      QUATERNIUS_WIZARD_URL,
      undefined,
      scene,
    ).then((c) => {
      sharedContainer = c;
      // Container originals share geometry with clones. Hide them so a GPU
      // sail on the source cannot overwrite instance vertex buffers.
      for (const m of c.meshes) {
        m.setEnabled(false);
        m.isVisible = false;
      }
      return c;
    });
  }
  return sharedLoad;
}

function findAnim(
  groups: AnimationGroup[],
  ...needles: string[]
): AnimationGroup | null {
  for (const n of needles) {
    const hit = groups.find((g) =>
      g.name.toLowerCase().includes(n.toLowerCase()),
    );
    if (hit) return hit;
  }
  return null;
}

function bareName(name: string, prefix: string): string {
  const p = `${prefix}__`;
  return name.startsWith(p) ? name.slice(p.length) : name;
}

/**
 * Assimp leaves CharacterArmature *100 / -90X off the joint list, so IBM is
 * 0.01 and a 90° leftover. CPU apply writes that leftover into mesh-local
 * verts; mesh.world already has the armature, so the body collapses unless
 * IBM is multiplied by the armature local matrix.
 */
function compensateAssimpIbm(skel: Skeleton, armature: TransformNode): void {
  const rot = armature.rotationQuaternion;
  const A = rot
    ? Matrix.Compose(armature.scaling, rot, Vector3.Zero())
    : Matrix.Scaling(armature.scaling.x, armature.scaling.y, armature.scaling.z);
  for (const bone of skel.bones) {
    const ibm = bone.getAbsoluteInverseBindMatrix().clone();
    A.multiplyToRef(ibm, ibm);
    const bind = ibm.clone();
    bind.invert();
    const parent = bone.getParent();
    if (parent) {
      bind.multiplyToRef(parent.getAbsoluteInverseBindMatrix(), bind);
    }
    bone.updateMatrix(bind, false, false);
    bone._updateAbsoluteBindMatrices(undefined, false);
  }
}

function collectMeshes(roots: Node[]): AbstractMesh[] {
  const meshes: AbstractMesh[] = [];
  for (const n of roots) {
    const cn = n.getClassName();
    if (cn === 'Mesh' || cn === 'AbstractMesh' || cn === 'InstancedMesh') {
      meshes.push(n as AbstractMesh);
    }
    for (const d of n.getDescendants(false)) {
      const dcn = d.getClassName();
      if (dcn === 'Mesh' || dcn === 'AbstractMesh' || dcn === 'InstancedMesh') {
        meshes.push(d as AbstractMesh);
      }
    }
  }
  return meshes;
}

function worldBounds(meshes: AbstractMesh[]): {
  min: Vector3;
  max: Vector3;
} | null {
  let min: Vector3 | null = null;
  let max: Vector3 | null = null;
  for (const m of meshes) {
    m.computeWorldMatrix(true);
    const bb = m.getBoundingInfo().boundingBox;
    if (!min) {
      min = bb.minimumWorld.clone();
      max = bb.maximumWorld.clone();
    } else {
      min.minimizeInPlace(bb.minimumWorld);
      max!.maximizeInPlace(bb.maximumWorld);
    }
  }
  return min && max ? { min, max } : null;
}

/**
 * Quaternius LowPoly RPG wizard (CC0) under the HumanoidParts API from #43.
 * Root at feet (y=0). Target height ~1.8m. Staff + robe pads hide/show for equip.
 * Idle/Walk/Spell clips for yard locomotion / cast flash.
 */
export function createPlayerHumanoid(
  scene: Scene,
  opts: HumanoidOptions = {},
): HumanoidParts {
  const prefix = opts.name ?? 'player';
  // Mid-sat indigo cloth vs final #32/#39 lock (cool hemi + warm sun + cyan fog).
  const robeDiffuse = opts.robeColor ?? new Color3(0.34, 0.45, 0.78);
  const root = new Mesh(prefix, scene);

  const robeMat = mat(
    scene,
    `${prefix}RobeMat`,
    robeDiffuse.clone(),
    ROBE_EMISSIVE_SCALE,
  );
  robeMat.specularColor = new Color3(0.09, 0.1, 0.14);

  // Equip containers — hide/show via setEnabled (main.ts U/I · J/K).
  const staff = new Mesh(`${prefix}Staff`, scene);
  staff.parent = root;
  const robes = new Mesh(`${prefix}Robes`, scene);
  robes.parent = root;

  const container = sharedContainer;
  if (!container) {
    root.material = robeMat;
    return {
      root,
      mat: robeMat,
      staff,
      robes,
      robeBaseColor: robeMat.diffuseColor.clone(),
    };
  }

  // Clone (not GPU-instance) so skinned meshes keep skeletons.
  const inst = container.instantiateModelsToScene(
    (name) => `${prefix}__${name}`,
    true,
    { doNotInstantiate: true },
  );

  const roots = inst.rootNodes;
  const meshes = collectMeshes(roots);
  const animGroups = inst.animationGroups;

  // Wrap under a pivot so we can normalize orientation/scale without breaking bones.
  const pivot = new TransformNode(`${prefix}Pivot`, scene);
  pivot.parent = root;
  for (const n of roots) {
    n.parent = pivot;
  }

  let armature: TransformNode | null = null;
  for (const n of roots) {
    if (n.name.includes('CharacterArmature')) armature = n as TransformNode;
    for (const d of n.getDescendants(false)) {
      if (d.name.includes('CharacterArmature')) armature = d as TransformNode;
    }
  }

  for (const m of meshes) {
    m.setEnabled(true);
    m.isVisible = true;
    m.visibility = 1;
    const skel = m.skeleton;
    if (!skel) continue;
    // Assimp *100 lives on CharacterArmature (not a joint). GPU skin of that
    // bind is a degenerate sail. CPU-skin the visible mesh so Idle_Weapon
    // deforms the 1.8m body. computeBonesUsingShaders=false + dirty defines
    // so NUM_BONE_INFLUENCERS=0 (useBones ignores the flag; a cached BONES
    // effect would double-skin). Do not skeleton=null / hide behind a clone.
    m.alwaysSelectAsActiveMesh = true;
    m.numBoneInfluencers = 4;
    skel.useTextureToStoreBoneMatrices = false;
    if (armature) compensateAssimpIbm(skel, armature);
    if (m.getClassName() === 'Mesh') {
      const mesh = m as Mesh;
      mesh.makeGeometryUnique();
      mesh.computeBonesUsingShaders = false;
      mesh._markSubMeshesAsAttributesDirty();
      skel.prepare(true);
      const jointIdx = mesh.getVerticesData('matricesIndices');
      const jointWts = mesh.getVerticesData('matricesWeights');
      const cpuSkin = () => {
        if (!jointIdx || !jointWts) return;
        mesh.setVerticesData('matricesIndices', jointIdx, true);
        mesh.setVerticesData('matricesWeights', jointWts, true);
        mesh.applySkeleton(skel);
        mesh.removeVerticesData('matricesIndices');
        mesh.removeVerticesData('matricesWeights');
      };
      cpuSkin();
      if (jointIdx && jointWts) {
        mesh.onBeforeRenderObservable.add(() => {
          skel.prepare();
          cpuSkin();
        });
      }
      try {
        mesh.refreshBoundingInfo(false, true);
      } catch {
        /* optional */
      }
    } else {
      skel.prepare(true);
    }
    m.material?.markDirty(true);
  }

  // Normalize height ~1.8m and plant feet on y=0 (assimp glTF is Y-up).
  let bounds = worldBounds(meshes.filter((m) => !!m.skeleton));
  if (!bounds) bounds = worldBounds(meshes);
  if (bounds) {
    const height = Math.max(0.01, bounds.max.y - bounds.min.y);
    const scale = 1.8 / height;
    pivot.scaling = new Vector3(scale, scale, scale);
    bounds = worldBounds(meshes);
  }
  if (bounds) {
    pivot.position.y -= bounds.min.y;
  }

  // Staff: keep armature parenting; also mirror under staff group for equip API
  // by parenting a thin proxy and toggling the real mesh in setEnabled observers.
  let staffMesh: AbstractMesh | null = null;
  const robeMeshes: AbstractMesh[] = [];
  for (const m of meshes) {
    const bare = bareName(m.name, prefix);
    if (/wizard_staff|^staff$/i.test(bare) || bare === 'Wizard_Staff') {
      staffMesh = m;
    }
    if (/shoulderpad|pouch/i.test(bare)) {
      robeMeshes.push(m);
    }
  }

  // Wire equip hide: when staff/robes containers toggle, mirror onto real meshes.
  const syncStaff = () => {
    const on = staff.isEnabled();
    if (staffMesh) {
      staffMesh.setEnabled(on);
      staffMesh.isVisible = on;
    }
  };
  const syncRobes = () => {
    const on = robes.isEnabled();
    for (const m of robeMeshes) {
      m.setEnabled(on);
      m.isVisible = on;
    }
  };
  // Mirror container setEnabled onto real GLB meshes (equip U/I · J/K).
  const staffSetEnabled = staff.setEnabled.bind(staff);
  staff.setEnabled = (v: boolean) => {
    staffSetEnabled(v);
    syncStaff();
  };
  const robesSetEnabled = robes.setEnabled.bind(robes);
  robes.setEnabled = (v: boolean) => {
    robesSetEnabled(v);
    syncRobes();
  };

  // Mid-sat cloth under #39 fog. Keep loader PBR on meshes — assigning a shared
  // StandardMaterial to skinned Wizard.001 yields a full AABB but zero body pixels.
  // Lift navy Wizard_Texture via albedoColor multiply + texture.level.
  const clothLift = new Color3(
    Math.min(2.8, robeDiffuse.r * 3.5 + 0.45),
    Math.min(2.6, robeDiffuse.g * 3.0 + 0.38),
    Math.min(3.0, robeDiffuse.b * 2.7 + 0.5),
  );
  robeMat.diffuseColor = clothLift.clone();
  robeMat.emissiveColor = new Color3(
    Math.min(0.16, clothLift.r * ROBE_EMISSIVE_SCALE),
    Math.min(0.18, clothLift.g * ROBE_EMISSIVE_SCALE),
    Math.min(0.24, clothLift.b * ROBE_EMISSIVE_SCALE + 0.02),
  );
  robeMat.specularColor = new Color3(0.05, 0.06, 0.08);
  robeMat.ambientColor = new Color3(0.38, 0.42, 0.52);
  robeMat.backFaceCulling = false;

  const clothPbrs: PBRMaterial[] = [];
  const liftPbr = (pbr: PBRMaterial) => {
    pbr.albedoColor.copyFrom(robeMat.diffuseColor);
    pbr.emissiveColor.copyFrom(robeMat.emissiveColor);
    pbr.emissiveIntensity = 0.4;
    pbr.metallic = 0;
    pbr.roughness = 0.88;
    pbr.backFaceCulling = false;
    pbr.transparencyMode = PBRMaterial.PBRMATERIAL_OPAQUE;
    if (pbr.albedoTexture) {
      const tex = pbr.albedoTexture as Texture;
      tex.level = 2.2;
      tex.hasAlpha = false;
    }
  };

  for (const m of meshes) {
    const bare = bareName(m.name, prefix);
    if (m === staffMesh || /staff/i.test(bare)) continue;
    const matl = m.material;
    if (matl instanceof PBRMaterial) {
      liftPbr(matl);
      clothPbrs.push(matl);
      if (m.skeleton) matl.markDirty(true);
    } else if (!m.skeleton) {
      m.material = robeMat;
    }
  }

  const prevD = robeMat.diffuseColor.clone();
  const prevE = robeMat.emissiveColor.clone();
  scene.onBeforeRenderObservable.add(() => {
    if (
      robeMat.diffuseColor.equals(prevD) &&
      robeMat.emissiveColor.equals(prevE)
    ) {
      return;
    }
    prevD.copyFrom(robeMat.diffuseColor);
    prevE.copyFrom(robeMat.emissiveColor);
    for (const pbr of clothPbrs) liftPbr(pbr);
  });

  if (staffMesh) {
    const staffMat = mat(
      scene,
      `${prefix}StaffWoodMat`,
      new Color3(0.62, 0.42, 0.2),
      0.06,
    );
    staffMat.specularColor = new Color3(0.2, 0.14, 0.06);
    const sm = staffMesh.material;
    if (sm instanceof PBRMaterial && sm.albedoTexture) {
      try {
        staffMat.diffuseTexture = sm.albedoTexture as Texture;
        staffMat.diffuseColor = new Color3(1.2, 1.05, 0.9);
      } catch {
        /* wood */
      }
    }
    staffMesh.material = staffMat;
  }

  const idle =
    findAnim(animGroups, 'Idle_Weapon', 'Idle') ??
    (animGroups.length > 0 ? animGroups[0]! : null);
  // E8.2: Run_Weapon for fast/forward; Walk for slow/strafe. Do not alias Run as Walk.
  const run = findAnim(animGroups, 'Run_Weapon', 'Run');
  const walk = findAnim(animGroups, 'Walk') ?? run;
  const air = findAnim(animGroups, 'Jump', 'Falling', 'Fall');
  const cast = findAnim(animGroups, 'Spell1', 'Spell2', 'Staff_Attack');
  for (const g of animGroups) {
    g.stop();
  }
  if (idle) {
    idle.start(true, 1.0, idle.from, idle.to, false);
  }
  animByRoot.set(root, { idle, walk, run, air, cast, airborne: false });

  root.material = robeMat;
  root.position = new Vector3(0, 0, 0);

  return {
    root,
    mat: robeMat,
    staff,
    robes,
    // Texture multiply lift (may be >1) for equip restore under #39 fog.
    robeBaseColor: robeMat.diffuseColor.clone(),
  };
}

/** Playback snapshot for VE — Reviewer must reject persistMark `T-POSE`. */
export type HumanoidPlayback = {
  skinned: number;
  playing: string | null;
  idle: string | null;
};

export function readHumanoidPlayback(parts: HumanoidParts): HumanoidPlayback {
  const a = animByRoot.get(parts.root);
  let skinned = 0;
  for (const m of parts.root.getChildMeshes(false)) {
    if (m.skeleton && m.isEnabled() && m.isVisible && m.visibility > 0) skinned += 1;
  }
  const playing = a?.cast?.isPlaying
    ? a.cast.name
    : a?.air?.isPlaying
      ? a.air.name
      : a?.run?.isPlaying
        ? a.run.name
        : a?.walk?.isPlaying
          ? a.walk.name
          : a?.idle?.isPlaying
            ? a.idle.name
            : null;
  return { skinned, playing, idle: a?.idle?.name ?? null };
}

function stopIfPlaying(
  g: AnimationGroup | null,
  except?: AnimationGroup | null,
): void {
  if (g && g !== except && g.isPlaying) g.stop();
}

function startLoop(g: AnimationGroup | null): void {
  if (g && !g.isPlaying) g.start(true, 1.0, g.from, g.to, false);
}

/** Airborne hold: Jump/Fall if present, else frozen Idle_Weapon. No squash. */
export function setHumanoidAirborne(
  parts: HumanoidParts,
  airborne: boolean,
): void {
  const a = animByRoot.get(parts.root);
  if (!a) return;
  a.airborne = airborne;
  if (!airborne) {
    stopIfPlaying(a.air);
    if (a.idle) a.idle.speedRatio = 1;
    return;
  }
  if (a.cast?.isPlaying) return;
  stopIfPlaying(a.walk);
  stopIfPlaying(a.run);
  if (a.air) {
    stopIfPlaying(a.idle);
    if (!a.air.isPlaying) {
      a.air.start(false, 1.0, a.air.from, a.air.to, false);
    }
    return;
  }
  // Wizard.glb has no Jump/Fall — hold Idle_Weapon (not Walk, not T).
  startLoop(a.idle);
  if (a.idle) a.idle.speedRatio = 0;
}

/** Switch Idle ↔ Walk/Run. `running` is fast/forward gait (no-op if clips missing). */
export function setHumanoidMoving(
  parts: HumanoidParts,
  moving: boolean,
  running = false,
): void {
  const a = animByRoot.get(parts.root);
  if (!a) return;
  if (a.airborne) return;
  if (a.cast?.isPlaying) return;
  if (a.idle) a.idle.speedRatio = 1;
  if (!moving) {
    stopIfPlaying(a.walk);
    stopIfPlaying(a.run);
    startLoop(a.idle);
    return;
  }
  const loc = running && a.run ? a.run : (a.walk ?? a.run);
  if (!loc) {
    startLoop(a.idle);
    return;
  }
  stopIfPlaying(a.idle, loc);
  stopIfPlaying(a.walk, loc);
  stopIfPlaying(a.run, loc);
  startLoop(loc);
}

/** Play a one-shot cast clip (Spell1) then return to idle/walk. */
export function playHumanoidCast(parts: HumanoidParts): void {
  const a = animByRoot.get(parts.root);
  if (!a?.cast) return;
  if (a.idle?.isPlaying) a.idle.stop();
  if (a.walk?.isPlaying) a.walk.stop();
  if (a.run?.isPlaying) a.run.stop();
  stopIfPlaying(a.air);
  a.airborne = false;
  if (a.idle) a.idle.speedRatio = 1;
  a.cast.onAnimationGroupEndObservable.addOnce(() => {
    setHumanoidMoving(parts, false);
  });
  a.cast.start(false, 1.0, a.cast.from, a.cast.to, false);
}

/** Stable robe tint from identity hex (distinct from local blue). */
export function remoteRobeColor(identityHex: string): Color3 {
  let h = 0;
  for (let i = 0; i < identityHex.length; i++) {
    h = (h * 31 + identityHex.charCodeAt(i)) >>> 0;
  }
  const palette = [
    new Color3(0.18, 0.62, 0.42),
    new Color3(0.72, 0.28, 0.55),
    new Color3(0.85, 0.55, 0.18),
    new Color3(0.45, 0.32, 0.78),
  ];
  return palette[h % palette.length]!;
}

/** Bright green robe for always-relevant party remotes (distinct from local blue). */
export function partyRobeColor(): Color3 {
  return new Color3(0.15, 0.85, 0.28);
}
