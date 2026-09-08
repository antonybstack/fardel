import {
  AnimationGroup,
  AssetContainer,
  Color3,
  Matrix,
  Mesh,
  MeshBuilder,
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
  /**
   * Kind=3: unarmed Idle, hide staff/pads, saturated robe (no 0.72 wash).
   * Kind=2 / player keep wizard staff + Idle_Weapon.
   */
  variant?: 'player' | 'hostile' | 'brigand';
};

type HumanoidAnim = {
  idle: AnimationGroup | null;
  idleWeapon: AnimationGroup | null;
  idleUnarmed: AnimationGroup | null;
  walk: AnimationGroup | null;
  run: AnimationGroup | null;
  runWeapon: AnimationGroup | null;
  runUnarmed: AnimationGroup | null;
  /** Jump/Fall if the GLB has one; Wizard.glb does not. */
  air: AnimationGroup | null;
  death: AnimationGroup | null;
  flinch: AnimationGroup | null;
  cast: AnimationGroup | null;
  airborne: boolean;
  dead: boolean;
  /** Emberbolt windup hold — not the Spark one-shot. */
  casting: boolean;
  /** Stationary yaw — Idle held so feet stay planted. */
  turning: boolean;
  staffEquipped: boolean;
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
      // Compensate Assimp IBM once on the container. Per-clone compensate
      // multiplies A*A on later instantiates → remotes collapse while local Idle
      // still reads (clone copies an already-fixed bind, then A again).
      let armature: TransformNode | null = null;
      for (const n of c.transformNodes) {
        if (n.name.includes('CharacterArmature')) armature = n;
      }
      for (const n of c.meshes) {
        if (n.name.includes('CharacterArmature')) armature = n;
      }
      if (armature) {
        for (const s of c.skeletons) compensateAssimpIbm(s, armature);
      }
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

function clipBare(name: string): string {
  const i = name.lastIndexOf('|');
  return i >= 0 ? name.slice(i + 1) : name;
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

/** Bare clip name after `|`. `Idle` must not match `Idle_Weapon`. */
function findAnimExact(
  groups: AnimationGroup[],
  needle: string,
): AnimationGroup | null {
  const n = needle.toLowerCase();
  return groups.find((g) => clipBare(g.name).toLowerCase() === n) ?? null;
}

function applyStaffClips(a: HumanoidAnim): void {
  a.idle = a.staffEquipped
    ? (a.idleWeapon ?? a.idleUnarmed)
    : (a.idleUnarmed ?? a.idleWeapon);
  a.run = a.staffEquipped
    ? (a.runWeapon ?? a.runUnarmed)
    : (a.runUnarmed ?? a.runWeapon);
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

function collectTransformNodes(pivot: TransformNode): TransformNode[] {
  const nodes: TransformNode[] = [];
  const visit = (n: Node): void => {
    if (n instanceof TransformNode) nodes.push(n);
    for (const c of n.getChildren()) visit(c);
  };
  visit(pivot);
  return nodes;
}

/** Skeleton.clone / IBM updateMatrix can leave bones on the container source. */
function relinkSkeletonToClones(
  skel: Skeleton,
  pivot: TransformNode,
  prefix: string,
): void {
  const nodes = collectTransformNodes(pivot);
  for (const bone of skel.bones) {
    const bn = bone.name;
    const tn =
      nodes.find((n) => n.name === bn) ??
      nodes.find((n) => n.name.endsWith(bn)) ??
      nodes.find((n) => bareName(n.name, prefix) === bn);
    if (tn) bone.linkTransformNode(tn);
  }
}

/**
 * instantiateModelsToScene clone() falls back to container targets when the
 * conversion map misses a bone. Remotes then isPlaying Walk on the hidden
 * source while the CPU-skin clone stays bind-T.
 */
function retargetAnimGroupsToClones(
  groups: AnimationGroup[],
  pivot: TransformNode,
  skel: Skeleton | null,
  prefix: string,
): void {
  const nodes = collectTransformNodes(pivot);
  const nodeByBare = new Map<string, TransformNode>();
  for (const n of nodes) {
    nodeByBare.set(n.name, n);
    nodeByBare.set(bareName(n.name, prefix), n);
  }
  const boneByName = new Map<string, Skeleton['bones'][number]>();
  if (skel) {
    for (const b of skel.bones) {
      boneByName.set(b.name, b);
      boneByName.set(bareName(b.name, prefix), b);
    }
  }
  for (const g of groups) {
    for (const ta of g.targetedAnimations) {
      const t = ta.target as { name?: string; getClassName?: () => string } | null;
      if (!t?.name) continue;
      const cn = t.getClassName?.() ?? '';
      if (cn === 'Bone') {
        const b = boneByName.get(t.name) ?? boneByName.get(bareName(t.name, prefix));
        if (b && b !== t) ta.target = b;
        continue;
      }
      const hit =
        nodeByBare.get(t.name) ??
        nodeByBare.get(bareName(t.name, prefix));
      if (hit && hit !== t) ta.target = hit;
    }
  }
}

/** Wizard_Staff is a rigid child of joint Weapon.R — not skinned. */
function attachStaffToWeaponBone(
  staffMesh: AbstractMesh,
  skel: Skeleton | null,
  skinned: AbstractMesh | null,
): void {
  staffMesh.alwaysSelectAsActiveMesh = true;
  if (!skel) return;
  const weapon =
    skel.bones.find((b) => /weapon\.r$/i.test(b.name)) ??
    skel.bones.find((b) => /weapon/i.test(b.name));
  if (!weapon) return;
  const grip = weapon.getTransformNode();
  if (grip) {
    if (staffMesh.parent !== grip) staffMesh.parent = grip;
    return;
  }
  if (skinned) staffMesh.attachToBone(weapon, skinned);
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
  const brigand = opts.variant === 'brigand';
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

  let staffMesh: AbstractMesh | null = null;
  const staffMeshes: AbstractMesh[] = [];
  const robeMeshes: AbstractMesh[] = [];
  for (const m of meshes) {
    const bare = bareName(m.name, prefix);
    if (/staff/i.test(bare)) {
      staffMeshes.push(m);
      if (!staffMesh) staffMesh = m;
    }
    if (/shoulderpad|pouch/i.test(bare)) {
      robeMeshes.push(m);
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
    relinkSkeletonToClones(skel, pivot, prefix);
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
        if (staffMesh) {
          staffMesh.computeWorldMatrix(true);
          try {
            if (staffMesh.getClassName() === 'Mesh') {
              (staffMesh as Mesh).refreshBoundingInfo(true, true);
            }
          } catch {
            /* optional */
          }
        }
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

  const TARGET_HEIGHT = 1.8;
  const plantToTargetHeight = (): void => {
    for (const m of meshes) m.computeWorldMatrix(true);
    let bounds = worldBounds(meshes.filter((m) => !!m.skeleton));
    if (!bounds) bounds = worldBounds(meshes);
    if (!bounds) return;
    const height = Math.max(0.01, bounds.max.y - bounds.min.y);
    const s = TARGET_HEIGHT / height;
    pivot.scaling = new Vector3(
      pivot.scaling.x * s,
      pivot.scaling.y * s,
      pivot.scaling.z * s,
    );
    for (const m of meshes) m.computeWorldMatrix(true);
    bounds = worldBounds(meshes.filter((m) => !!m.skeleton)) ?? bounds;
    pivot.position.y -= bounds.min.y;
  };
  // Bind AABB first (no extra ancestor — scale lives on the existing pivot).
  plantToTargetHeight();

  // Staff: parent to Weapon.R (Idle_Weapon grip). Equip API still toggles the GLB mesh.
  const skinnedBody = meshes.find((m) => !!m.skeleton) ?? null;
  if (staffMesh && !brigand) {
    attachStaffToWeaponBone(staffMesh, skinnedBody?.skeleton ?? null, skinnedBody);
  }
  retargetAnimGroupsToClones(
    animGroups,
    pivot,
    skinnedBody?.skeleton ?? null,
    prefix,
  );

  // Wire equip hide: when staff/robes containers toggle, mirror onto real meshes.
  const syncStaff = () => {
    const on = staff.isEnabled();
    const hide = staffMeshes.length > 0 ? staffMeshes : staffMesh ? [staffMesh] : [];
    for (const m of hide) {
      m.setEnabled(on);
      m.isVisible = on;
      m.visibility = on ? 1 : 0;
      m.alwaysSelectAsActiveMesh = on;
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

  // Atlas already has cloth/skin/hair. A strong albedo multiply tints Face
  // indigo and collapses material separation. Do not StandardMaterial Wizard.001.
  // Kind=3 skips the 0.72 wash so violet actually reads vs Kind=2 crimson.
  if (brigand) {
    robeMat.diffuseColor = new Color3(
      Math.min(1, robeDiffuse.r * 1.08),
      Math.min(1, robeDiffuse.g * 0.95),
      Math.min(1, robeDiffuse.b * 1.05),
    );
    robeMat.emissiveColor = new Color3(
      Math.min(0.16, robeDiffuse.r * 0.22),
      Math.min(0.08, robeDiffuse.g * 0.16),
      Math.min(0.22, robeDiffuse.b * 0.28),
    );
  } else {
    robeMat.diffuseColor = new Color3(
      0.72 + robeDiffuse.r * 0.55,
      0.70 + robeDiffuse.g * 0.50,
      0.78 + robeDiffuse.b * 0.45,
    );
    robeMat.emissiveColor = new Color3(
      Math.min(0.1, robeDiffuse.r * ROBE_EMISSIVE_SCALE),
      Math.min(0.11, robeDiffuse.g * ROBE_EMISSIVE_SCALE),
      Math.min(0.16, robeDiffuse.b * ROBE_EMISSIVE_SCALE + 0.02),
    );
  }
  robeMat.specularColor = new Color3(0.05, 0.06, 0.08);
  robeMat.ambientColor = brigand
    ? new Color3(0.28, 0.18, 0.42)
    : new Color3(0.38, 0.42, 0.52);
  robeMat.backFaceCulling = false;

  const clothPbrs: PBRMaterial[] = [];
  const tuneCloth = (pbr: PBRMaterial) => {
    pbr.albedoColor.copyFrom(robeMat.diffuseColor);
    pbr.emissiveColor.copyFrom(robeMat.emissiveColor);
    pbr.emissiveIntensity = brigand ? 0.42 : 0.28;
    pbr.metallic = 0;
    pbr.roughness = 0.9;
    pbr.backFaceCulling = false;
    pbr.transparencyMode = PBRMaterial.PBRMATERIAL_OPAQUE;
    if (pbr.albedoTexture) {
      const tex = pbr.albedoTexture as Texture;
      // Lower atlas lift so Kind=3 violet albedo actually reads vs Kind=2.
      tex.level = brigand ? 0.85 : 1.65;
      tex.hasAlpha = false;
    }
  };
  const tuneSkin = (pbr: PBRMaterial) => {
    pbr.albedoColor = new Color3(1.14, 0.96, 0.84);
    pbr.emissiveColor = new Color3(0.07, 0.035, 0.02);
    pbr.emissiveIntensity = 0.22;
    pbr.metallic = 0;
    pbr.roughness = 0.64;
    pbr.backFaceCulling = false;
    pbr.transparencyMode = PBRMaterial.PBRMATERIAL_OPAQUE;
    if (pbr.albedoTexture) {
      const tex = pbr.albedoTexture as Texture;
      tex.level = 1.4;
      tex.hasAlpha = false;
    }
  };
  const tuneWood = (pbr: PBRMaterial) => {
    pbr.albedoColor = new Color3(1.08, 0.78, 0.48);
    pbr.emissiveColor = new Color3(0.09, 0.045, 0.015);
    pbr.emissiveIntensity = 0.28;
    pbr.metallic = 0;
    pbr.roughness = 0.8;
    pbr.backFaceCulling = false;
    pbr.transparencyMode = PBRMaterial.PBRMATERIAL_OPAQUE;
    if (pbr.albedoTexture) {
      const tex = pbr.albedoTexture as Texture;
      tex.level = 1.55;
      tex.hasAlpha = false;
    }
  };

  for (const m of meshes) {
    const bare = bareName(m.name, prefix);
    if (m === staffMesh || /staff/i.test(bare)) continue;
    const matl = m.material;
    if (matl instanceof PBRMaterial) {
      if (/^face$/i.test(bare)) {
        const skin = matl.clone(`${prefix}__SkinMat`) as PBRMaterial;
        m.material = skin;
        tuneSkin(skin);
        if (m.skeleton) skin.markDirty(true);
      } else {
        tuneCloth(matl);
        clothPbrs.push(matl);
        if (m.skeleton) matl.markDirty(true);
      }
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
    for (const pbr of clothPbrs) tuneCloth(pbr);
  });

  if (staffMesh && !brigand) {
    const sm = staffMesh.material;
    if (sm instanceof PBRMaterial) {
      tuneWood(sm);
    }
    staffMesh.computeWorldMatrix(true);
    try {
      if (staffMesh.getClassName() === 'Mesh') {
        (staffMesh as Mesh).refreshBoundingInfo(true, true);
      }
    } catch {
      /* optional */
    }
    const bi = staffMesh.getBoundingInfo();
    const min = bi.minimum;
    const max = bi.maximum;
    const span = Math.max(0.05, max.y - min.y);
    const orb = MeshBuilder.CreateSphere(
      `${prefix}__StaffOrb`,
      { diameter: span * 0.09, segments: 8 },
      scene,
    );
    orb.parent = staffMesh;
    orb.position.set(
      (min.x + max.x) * 0.5,
      max.y - span * 0.06,
      (min.z + max.z) * 0.5,
    );
    const orbMat = new PBRMaterial(`${prefix}__StaffOrbMat`, scene);
    orbMat.albedoColor = new Color3(0.55, 0.62, 0.74);
    orbMat.emissiveColor = new Color3(0.1, 0.18, 0.32);
    orbMat.emissiveIntensity = 0.38;
    orbMat.metallic = 0.08;
    orbMat.roughness = 0.32;
    orbMat.backFaceCulling = false;
    orb.material = orbMat;
    orb.alwaysSelectAsActiveMesh = true;
  }

  const idleWeapon = findAnimExact(animGroups, 'Idle_Weapon');
  const idleUnarmed = findAnimExact(animGroups, 'Idle');
  // E8.2: Run_Weapon for fast/forward; Walk for slow/strafe. Do not alias Run as Walk.
  const runWeapon = findAnimExact(animGroups, 'Run_Weapon');
  const runUnarmed = findAnimExact(animGroups, 'Run');
  const walk = findAnimExact(animGroups, 'Walk') ?? runWeapon ?? runUnarmed;
  const air = findAnim(animGroups, 'Jump', 'Falling', 'Fall');
  const death = findAnim(animGroups, 'Death');
  // Pack spelling is RecieveHit (not Receive). Prefer the non-Attacking clip.
  const flinch =
    animGroups.find((g) => /recievehit$/i.test(g.name)) ??
    findAnim(animGroups, 'RecieveHit');
  const cast = findAnim(animGroups, 'Spell1', 'Spell2', 'Staff_Attack');
  for (const g of animGroups) {
    g.stop();
  }
  const anim: HumanoidAnim = {
    idle: idleWeapon ?? idleUnarmed ?? (animGroups.length > 0 ? animGroups[0]! : null),
    idleWeapon,
    idleUnarmed,
    walk,
    run: runWeapon ?? runUnarmed,
    runWeapon,
    runUnarmed,
    air,
    death,
    flinch,
    cast,
    airborne: false,
    dead: false,
    casting: false,
    turning: false,
    staffEquipped: !brigand,
  };
  applyStaffClips(anim);
  if (anim.idle) {
    anim.idle.start(true, 1.0, anim.idle.from, anim.idle.to, false);
  }
  if (brigand) {
    staff.setEnabled(false);
    for (const m of robeMeshes) {
      m.setEnabled(false);
      m.isVisible = false;
    }
  }
  // Idle deforms vs bind; re-plant after the first CPU skin so feet sit on y=0
  // at ~1.8 m. Do not introduce another scaled ancestor (breaks Assimp IBM).
  scene.onBeforeRenderObservable.addOnce(() => {
    plantToTargetHeight();
  });
  animByRoot.set(root, anim);

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
  height: number;
};

export function readHumanoidPlayback(parts: HumanoidParts): HumanoidPlayback {
  const a = animByRoot.get(parts.root);
  let skinned = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const m of parts.root.getChildMeshes(false)) {
    if (m.skeleton && m.isEnabled() && m.isVisible && m.visibility > 0) {
      skinned += 1;
      m.computeWorldMatrix(true);
      const bb = m.getBoundingInfo().boundingBox;
      minY = Math.min(minY, bb.minimumWorld.y);
      maxY = Math.max(maxY, bb.maximumWorld.y);
    }
  }
  const height = Number.isFinite(minY) ? Math.max(0, maxY - minY) : 0;
  const playing = a?.dead && a.death
    ? a.death.name
    : a?.death?.isPlaying
      ? a.death.name
      : a?.casting && a.cast
        ? a.cast.name
        : a?.cast?.isPlaying
          ? a.cast.name
          : a?.flinch?.isPlaying
            ? a.flinch.name
            : a?.air?.isPlaying
              ? a.air.name
              : a?.run?.isPlaying
                ? a.run.name
                : a?.walk?.isPlaying
                  ? a.walk.name
                  : a?.idle?.isPlaying
                    ? a.idle.name
                    : null;
  return { skinned, playing, idle: a?.idle?.name ?? null, height };
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

/** Airborne hold: Jump/Fall if present, else frozen Idle_Weapon. No squash.
 * Remotes use the same hold — Walk must not keep cycling in the air. */
export function setHumanoidAirborne(
  parts: HumanoidParts,
  airborne: boolean,
): void {
  const a = animByRoot.get(parts.root);
  if (!a || a.dead) return;
  a.airborne = airborne;
  if (!airborne) {
    stopIfPlaying(a.air);
    if (a.idle) a.idle.speedRatio = 1;
    return;
  }
  if (a.casting || a.cast?.isPlaying) return;
  stopIfPlaying(a.flinch);
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

/** In-place Walk stride ~2.2 m/s; Run_Weapon ~5 m/s. Wish is 4.5. */
const WALK_REF_MPS = 2.2;
const RUN_REF_MPS = 5.0;

/**
 * Grounded Walk named (not Run). NPC chase/leash and remotes pass snap m/s
 * so speedRatio matches XZ. `running=true` is the local W sprint only.
 * Remotes share this Idle-first stop — do not keep Walk at 0 wish (#450 / #478).
 */
export function setHumanoidMoving(
  parts: HumanoidParts,
  moving: boolean,
  running = false,
  speedMps = 0,
): void {
  const a = animByRoot.get(parts.root);
  if (!a) return;
  if (a.dead || a.airborne || a.casting) return;
  if (a.cast?.isPlaying) return;
  if (a.flinch?.isPlaying) return;
  stopIfPlaying(a.death);
  applyStaffClips(a);
  if (a.idle) a.idle.speedRatio = 1;
  if (!moving) {
    // Start Idle while Walk/Run still play, then stop them. Stopping first
    // leaves one CPU-skin frame of mid-stride Walk at 0 wish (skate) or no
    // group (bind-T). Same order as cast-cancel.
    if (a.walk) a.walk.speedRatio = 0;
    if (a.run) a.run.speedRatio = 0;
    if (a.runWeapon) a.runWeapon.speedRatio = 0;
    if (a.runUnarmed) a.runUnarmed.speedRatio = 0;
    startLoop(a.idle);
    stopIfPlaying(a.walk, a.idle);
    stopIfPlaying(a.run, a.idle);
    stopIfPlaying(a.runWeapon, a.idle);
    stopIfPlaying(a.runUnarmed, a.idle);
    stopIfPlaying(a.idleWeapon, a.idle);
    stopIfPlaying(a.idleUnarmed, a.idle);
    return;
  }
  const loc = running && a.run ? a.run : (a.walk ?? a.run);
  if (!loc) {
    startLoop(a.idle);
    return;
  }
  stopIfPlaying(a.idle, loc);
  stopIfPlaying(a.idleWeapon, loc);
  stopIfPlaying(a.idleUnarmed, loc);
  stopIfPlaying(a.walk, loc);
  stopIfPlaying(a.run, loc);
  stopIfPlaying(a.runWeapon, loc);
  stopIfPlaying(a.runUnarmed, loc);
  startLoop(loc);
  // Clip is in-place (armature translation 0). Match cycle to XZ so feet don't slide.
  const ref = loc === a.run ? RUN_REF_MPS : WALK_REF_MPS;
  const mps = speedMps > 0.15 ? speedMps : ref;
  loc.speedRatio = Math.max(0.7, Math.min(1.85, mps / ref));
}

/** NPC chase / leash return: Walk clip, never Run, never Idle-slide. */
export function setHumanoidGroundWalk(
  parts: HumanoidParts,
  moving: boolean,
  speedMps = 0,
): void {
  setHumanoidMoving(parts, moving, false, speedMps);
}

/**
 * Stationary yaw: hold Idle_Weapon (speed 0) so feet stay planted.
 * No-op while Walk/Run/#334 gait is playing. Callers must not plant
 * while sendMove is translating (that is moonwalk).
 */
export function setHumanoidTurning(
  parts: HumanoidParts,
  turning: boolean,
): void {
  const a = animByRoot.get(parts.root);
  if (!a) return;
  if (a.dead || a.airborne || a.casting) {
    a.turning = false;
    return;
  }
  if (a.walk?.isPlaying || a.run?.isPlaying || a.flinch?.isPlaying || a.cast?.isPlaying) {
    a.turning = false;
    return;
  }
  a.turning = turning;
  startLoop(a.idle);
  if (a.idle) a.idle.speedRatio = turning ? 0 : 1;
}

/**
 * Equip: show staff + Idle_Weapon / Run_Weapon (grip, not bind-T).
 * Unequip: hide the stick and play unarmed Idle / Run (not a floating grip).
 * Remotes must follow Character.staffEquipped — hiding the mesh is not enough
 * (`Idle_Weapon` is an includes-match on `Idle`).
 */
export function setHumanoidStaffEquipped(
  parts: HumanoidParts,
  equipped: boolean,
): void {
  parts.staff.setEnabled(equipped);
  const a = animByRoot.get(parts.root);
  if (!a) return;
  a.staffEquipped = equipped;
  const prevIdle = a.idle;
  const prevRun = a.run;
  applyStaffClips(a);
  if (a.dead || a.airborne || a.casting) return;
  if (a.flinch?.isPlaying || a.cast?.isPlaying) return;
  stopIfPlaying(a.death);
  if (a.walk?.isPlaying) return;
  if (prevRun?.isPlaying && a.run && a.run !== prevRun) {
    stopIfPlaying(prevRun);
    startLoop(a.run);
    return;
  }
  if (a.run?.isPlaying) return;
  stopIfPlaying(prevIdle, a.idle);
  stopIfPlaying(a.idleWeapon, a.idle);
  stopIfPlaying(a.idleUnarmed, a.idle);
  stopIfPlaying(a.walk);
  stopIfPlaying(a.run);
  if (a.idle) {
    a.idle.speedRatio = 1;
    if (!a.idle.isPlaying) a.idle.start(true, 1.0, a.idle.from, a.idle.to, false);
  }
}

/** Play Death once and hold the fallen pose. Respawn restores Idle_Weapon. */
export function setHumanoidDead(parts: HumanoidParts, dead: boolean): void {
  const a = animByRoot.get(parts.root);
  if (!a) return;
  if (a.dead === dead) {
    if (dead && a.death && !a.death.isPlaying) {
      a.death.start(false, 1.0, a.death.to, a.death.to, false);
      a.death.speedRatio = 0;
    }
    return;
  }
  a.dead = dead;
  if (!dead) {
    stopIfPlaying(a.death);
    if (a.death) a.death.speedRatio = 1;
    startLoop(a.idle);
    return;
  }
  a.airborne = false;
  a.casting = false;
  stopIfPlaying(a.idle);
  stopIfPlaying(a.walk);
  stopIfPlaying(a.run);
  stopIfPlaying(a.cast);
  stopIfPlaying(a.air);
  stopIfPlaying(a.flinch);
  if (!a.death) return;
  a.death.speedRatio = 1;
  a.death.onAnimationGroupEndObservable.addOnce(() => {
    if (!a.dead || !a.death) return;
    a.death.start(false, 1.0, a.death.to, a.death.to, false);
    a.death.speedRatio = 0;
  });
  a.death.start(false, 1.0, a.death.from, a.death.to, false);
}

/** One-shot hit react. Does not touch Move intents; loco resumes after. */
export function playHumanoidFlinch(parts: HumanoidParts): void {
  const a = animByRoot.get(parts.root);
  if (!a?.flinch || a.airborne || a.dead) return;
  // HP drop can land on the same tick as CastEndsAt. Do not keep Spell over RecieveHit.
  a.casting = false;
  a.turning = false;
  stopIfPlaying(a.cast);
  if (a.cast) a.cast.speedRatio = 1;
  stopIfPlaying(a.idle);
  stopIfPlaying(a.walk);
  stopIfPlaying(a.run);
  if (a.idle) a.idle.speedRatio = 1;
  stopIfPlaying(a.flinch);
  a.flinch.onAnimationGroupEndObservable.addOnce(() => {
    if (a.dead || a.casting) return;
    setHumanoidMoving(parts, false);
  });
  a.flinch.start(false, 1.0, a.flinch.from, a.flinch.to, false);
}

/** Windup: loop Spell until CastEndsAt / cancel / interrupt (local + remotes). */
export function setHumanoidCasting(
  parts: HumanoidParts,
  casting: boolean,
): void {
  const a = animByRoot.get(parts.root);
  if (!a) return;
  if (!casting) {
    if (!a.casting) return;
    a.casting = false;
    a.turning = false;
    // setHumanoidMoving returns while a.cast isPlaying — start Idle first.
    applyStaffClips(a);
    if (a.idle) a.idle.speedRatio = 1;
    if (!a.dead && !a.airborne) startLoop(a.idle);
    stopIfPlaying(a.cast);
    if (a.cast) a.cast.speedRatio = 1;
    return;
  }
  if (a.dead || !a.cast) return;
  // RecieveHit owns the body until the one-shot ends (remote DummyStrike / Emberbolt land).
  if (a.flinch?.isPlaying) return;
  const already = a.casting;
  a.casting = true;
  a.turning = false;
  a.airborne = false;
  stopIfPlaying(a.idle);
  stopIfPlaying(a.walk);
  stopIfPlaying(a.run);
  stopIfPlaying(a.air);
  stopIfPlaying(a.flinch);
  if (a.idle) a.idle.speedRatio = 1;
  if (already && a.cast.isPlaying) return;
  if (a.cast.isPlaying) a.cast.stop();
  a.cast.start(true, 1.0, a.cast.from, a.cast.to, false);
}

/** Play a one-shot cast clip (Spell1) then return to idle/walk. Spark path. */
export function playHumanoidCast(parts: HumanoidParts): void {
  const a = animByRoot.get(parts.root);
  if (!a?.cast || a.dead || a.casting) return;
  stopIfPlaying(a.flinch);
  if (a.idle?.isPlaying) a.idle.stop();
  if (a.walk?.isPlaying) a.walk.stop();
  if (a.run?.isPlaying) a.run.stop();
  stopIfPlaying(a.air);
  a.airborne = false;
  if (a.idle) a.idle.speedRatio = 1;
  a.cast.onAnimationGroupEndObservable.addOnce(() => {
    if (a.casting || a.dead) return;
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

/** Crimson robe for Kind=2 yard hostiles — distinct from local indigo / remotes. */
export function hostileRobeColor(): Color3 {
  return new Color3(0.78, 0.22, 0.18);
}

/** Saturated violet for Kind=3 — skip the 0.72 cloth wash so it reads vs crimson. */
export function brigandRobeColor(): Color3 {
  return new Color3(0.42, 0.16, 0.68);
}
