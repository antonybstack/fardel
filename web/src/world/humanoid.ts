import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';

/** Robe cloth emissive scale — keep restores in main.ts in sync. */
/** Modest cloth fill — avoid neon under warmer #32 sun (~0.98). */
export const ROBE_EMISSIVE_SCALE = 0.065;

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

/**
 * Procedural readable humanoid + staff (no art packs).
 * Root at feet (y=0). Total height ~1.8m. Robes + wood staff silhouette.
 * Tuned for forest hemi/sun readability at play-camera distance (RS-simple).
 */
export function createPlayerHumanoid(
  scene: Scene,
  opts: HumanoidOptions = {},
): HumanoidParts {
  const prefix = opts.name ?? 'player';
  // Mid-sat indigo cloth vs final #32 lock (cool hemi + warm sun + cyan fog dens 0.015).
  // Slightly higher midtone/value so cyan fog does not muddy robes; emissive stays low (not neon).
  const robeDiffuse = opts.robeColor ?? new Color3(0.3, 0.4, 0.72);
  const root = new Mesh(prefix, scene);

  const robeMat = mat(
    scene,
    `${prefix}RobeMat`,
    robeDiffuse.clone(),
    ROBE_EMISSIVE_SCALE,
  );
  // Soft cloth specular — warm sun rim without metallic / neon sheen.
  robeMat.specularColor = new Color3(0.09, 0.1, 0.14);

  // Warm skin — person contrast vs cool mist + indigo robes (not cyan mass).
  const skinMat = mat(
    scene,
    `${prefix}SkinMat`,
    new Color3(0.88, 0.68, 0.5),
    0.035,
  );
  skinMat.specularColor = new Color3(0.11, 0.09, 0.07);

  // Dark boots vs skirt for limb separation under fog.
  const bootMat = mat(
    scene,
    `${prefix}BootMat`,
    new Color3(0.14, 0.1, 0.08),
    0.02,
  );
  // Deep navy trim — hood/cuff silhouette without cyan glow.
  const trimMat = mat(
    scene,
    `${prefix}TrimMat`,
    new Color3(0.09, 0.11, 0.22),
    0.03,
  );
  trimMat.specularColor = new Color3(0.05, 0.05, 0.07);

  // Warm wood shaft — readable vs cool mist; not dark mud under fog 0.012.
  const staffMat = mat(
    scene,
    `${prefix}StaffMat`,
    new Color3(0.5, 0.31, 0.14),
    0.04,
  );
  staffMat.specularColor = new Color3(0.13, 0.09, 0.05);
  // Brass band/ferrule accent under warmer sun.
  const bandMat = mat(
    scene,
    `${prefix}StaffBandMat`,
    new Color3(0.66, 0.5, 0.2),
    0.09,
  );
  bandMat.specularColor = new Color3(0.38, 0.3, 0.14);
  // Soft cool orb tip only — readable glow; traveler stays cloth+wood, not cyan blob.
  const orbMat = mat(
    scene,
    `${prefix}StaffOrbMat`,
    new Color3(0.5, 0.78, 0.92),
    0.36,
  );
  orbMat.specularColor = new Color3(0.4, 0.6, 0.8);

  // Legs: slightly clearer separation + boot mass under skirt.
  const legL = MeshBuilder.CreateBox(
    `${prefix}LegL`,
    { width: 0.2, height: 0.7, depth: 0.24 },
    scene,
  );
  legL.parent = root;
  legL.position = new Vector3(-0.16, 0.35, 0);
  legL.material = bootMat;

  const legR = MeshBuilder.CreateBox(
    `${prefix}LegR`,
    { width: 0.2, height: 0.7, depth: 0.24 },
    scene,
  );
  legR.parent = root;
  legR.position = new Vector3(0.16, 0.35, 0);
  legR.material = bootMat;

  const torso = MeshBuilder.CreateBox(
    `${prefix}Torso`,
    { width: 0.56, height: 0.7, depth: 0.32 },
    scene,
  );
  torso.parent = root;
  torso.position = new Vector3(0, 1.1, 0);
  torso.material = robeMat;

  // Neck: breaks torso→head capsule silhouette.
  const neck = MeshBuilder.CreateCylinder(
    `${prefix}Neck`,
    { height: 0.1, diameter: 0.14, tessellation: 8 },
    scene,
  );
  neck.parent = root;
  neck.position = new Vector3(0, 1.5, 0);
  neck.material = skinMat;

  const robes = new Mesh(`${prefix}Robes`, scene);
  robes.parent = root;

  // Fuller skirt volume so robes read at mid-camera.
  const skirt = MeshBuilder.CreateCylinder(
    `${prefix}Skirt`,
    {
      height: 0.46,
      diameterTop: 0.5,
      diameterBottom: 0.82,
      tessellation: 8,
    },
    scene,
  );
  skirt.parent = robes;
  skirt.position = new Vector3(0, 0.7, 0);
  skirt.material = robeMat;

  // Dark hem ring for boot-vs-skirt contrast.
  const skirtHem = MeshBuilder.CreateTorus(
    `${prefix}SkirtHem`,
    { diameter: 0.78, thickness: 0.04, tessellation: 10 },
    scene,
  );
  skirtHem.parent = robes;
  skirtHem.position = new Vector3(0, 0.48, 0);
  skirtHem.rotation.x = Math.PI / 2;
  skirtHem.material = trimMat;

  const head = MeshBuilder.CreateSphere(
    `${prefix}Head`,
    { diameter: 0.34, segments: 10 },
    scene,
  );
  head.parent = root;
  head.position = new Vector3(0, 1.66, 0);
  head.material = skinMat;

  const hood = MeshBuilder.CreateSphere(
    `${prefix}Hood`,
    { diameter: 0.4, segments: 8 },
    scene,
  );
  hood.parent = robes;
  hood.position = new Vector3(0, 1.7, -0.03);
  hood.scaling = new Vector3(1.08, 0.72, 1.14);
  hood.material = robeMat;

  // Dark hood brim/edge for head silhouette against robes.
  const hoodEdge = MeshBuilder.CreateTorus(
    `${prefix}HoodEdge`,
    { diameter: 0.34, thickness: 0.035, tessellation: 10 },
    scene,
  );
  hoodEdge.parent = robes;
  hoodEdge.position = new Vector3(0, 1.58, 0.02);
  hoodEdge.rotation.x = Math.PI / 2.4;
  hoodEdge.material = trimMat;

  const armL = MeshBuilder.CreateBox(
    `${prefix}ArmL`,
    { width: 0.16, height: 0.58, depth: 0.18 },
    scene,
  );
  armL.parent = root;
  armL.position = new Vector3(-0.44, 1.14, 0);
  armL.material = robeMat;

  const armR = MeshBuilder.CreateBox(
    `${prefix}ArmR`,
    { width: 0.16, height: 0.58, depth: 0.18 },
    scene,
  );
  armR.parent = root;
  armR.position = new Vector3(0.44, 1.14, 0);
  armR.material = robeMat;

  const handL = MeshBuilder.CreateBox(
    `${prefix}HandL`,
    { width: 0.13, height: 0.13, depth: 0.15 },
    scene,
  );
  handL.parent = root;
  handL.position = new Vector3(-0.44, 0.8, 0.02);
  handL.material = skinMat;

  const handR = MeshBuilder.CreateBox(
    `${prefix}HandR`,
    { width: 0.13, height: 0.13, depth: 0.15 },
    scene,
  );
  handR.parent = root;
  handR.position = new Vector3(0.44, 0.8, 0.02);
  handR.material = skinMat;

  const staff = new Mesh(`${prefix}Staff`, scene);
  staff.parent = root;
  staff.position = new Vector3(0.56, 0.52, 0.12);
  staff.rotation.z = -0.18;
  staff.rotation.x = 0.08;

  // Thicker shaft so staff reads at play-camera distance.
  const shaft = MeshBuilder.CreateCylinder(
    `${prefix}StaffShaft`,
    {
      height: 1.55,
      diameterTop: 0.065,
      diameterBottom: 0.085,
      tessellation: 6,
    },
    scene,
  );
  shaft.parent = staff;
  shaft.position.y = 0.75;
  shaft.material = staffMat;

  // Brass/wood band accent mid-staff.
  const band = MeshBuilder.CreateCylinder(
    `${prefix}StaffBand`,
    {
      height: 0.06,
      diameter: 0.1,
      tessellation: 8,
    },
    scene,
  );
  band.parent = staff;
  band.position.y = 1.05;
  band.material = bandMat;

  // Ferrule at foot of staff.
  const ferrule = MeshBuilder.CreateCylinder(
    `${prefix}StaffFerrule`,
    {
      height: 0.08,
      diameter: 0.095,
      tessellation: 8,
    },
    scene,
  );
  ferrule.parent = staff;
  ferrule.position.y = 0.02;
  ferrule.material = bandMat;

  // Brighter, slightly larger orb for staff tip readability.
  const orb = MeshBuilder.CreateSphere(
    `${prefix}StaffOrb`,
    { diameter: 0.2, segments: 8 },
    scene,
  );
  orb.parent = staff;
  orb.position.y = 1.56;
  orb.material = orbMat;

  // Broader shoulders so equipped robes read as a robe, not a tunic.
  const shoulderL = MeshBuilder.CreateBox(
    `${prefix}ShoulderL`,
    { width: 0.26, height: 0.16, depth: 0.32 },
    scene,
  );
  shoulderL.parent = robes;
  shoulderL.position = new Vector3(-0.38, 1.42, 0);
  shoulderL.material = robeMat;

  const shoulderR = MeshBuilder.CreateBox(
    `${prefix}ShoulderR`,
    { width: 0.26, height: 0.16, depth: 0.32 },
    scene,
  );
  shoulderR.parent = robes;
  shoulderR.position = new Vector3(0.38, 1.42, 0);
  shoulderR.material = robeMat;

  // Dark cuff trim on shoulders for silhouette edge.
  const cuffL = MeshBuilder.CreateBox(
    `${prefix}CuffL`,
    { width: 0.28, height: 0.05, depth: 0.34 },
    scene,
  );
  cuffL.parent = robes;
  cuffL.position = new Vector3(-0.38, 1.33, 0);
  cuffL.material = trimMat;

  const cuffR = MeshBuilder.CreateBox(
    `${prefix}CuffR`,
    { width: 0.28, height: 0.05, depth: 0.34 },
    scene,
  );
  cuffR.parent = robes;
  cuffR.position = new Vector3(0.38, 1.33, 0);
  cuffR.material = trimMat;

  root.material = robeMat;
  root.position = new Vector3(0, 0, 0);

  return {
    root,
    mat: robeMat,
    staff,
    robes,
    robeBaseColor: robeDiffuse.clone(),
  };
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
