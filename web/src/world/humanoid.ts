import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';

export type HumanoidParts = {
  /** Root at feet; rotate yaw on this. */
  root: Mesh;
  /** Primary material used for cast flash / tint. */
  mat: StandardMaterial;
  staff: Mesh;
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
 */
export function createPlayerHumanoid(
  scene: Scene,
  opts: HumanoidOptions = {},
): HumanoidParts {
  const prefix = opts.name ?? 'player';
  const robeDiffuse = opts.robeColor ?? new Color3(0.28, 0.38, 0.72);
  const root = new Mesh(prefix, scene);

  const robeMat = mat(scene, `${prefix}RobeMat`, robeDiffuse, 0.08);
  const skinMat = mat(scene, `${prefix}SkinMat`, new Color3(0.86, 0.68, 0.52), 0.04);
  const bootMat = mat(scene, `${prefix}BootMat`, new Color3(0.22, 0.16, 0.12), 0.03);
  const staffMat = mat(scene, `${prefix}StaffMat`, new Color3(0.45, 0.28, 0.14), 0.05);
  const orbMat = mat(scene, `${prefix}StaffOrbMat`, new Color3(0.35, 0.75, 1.0), 0.35);
  orbMat.specularColor = new Color3(0.4, 0.6, 0.9);

  const legL = MeshBuilder.CreateBox(
    `${prefix}LegL`,
    { width: 0.22, height: 0.72, depth: 0.26 },
    scene,
  );
  legL.parent = root;
  legL.position = new Vector3(-0.14, 0.36, 0);
  legL.material = bootMat;

  const legR = MeshBuilder.CreateBox(
    `${prefix}LegR`,
    { width: 0.22, height: 0.72, depth: 0.26 },
    scene,
  );
  legR.parent = root;
  legR.position = new Vector3(0.14, 0.36, 0);
  legR.material = bootMat;

  const torso = MeshBuilder.CreateBox(
    `${prefix}Torso`,
    { width: 0.58, height: 0.72, depth: 0.34 },
    scene,
  );
  torso.parent = root;
  torso.position = new Vector3(0, 1.08, 0);
  torso.material = robeMat;

  const skirt = MeshBuilder.CreateCylinder(
    `${prefix}Skirt`,
    {
      height: 0.38,
      diameterTop: 0.52,
      diameterBottom: 0.72,
      tessellation: 8,
    },
    scene,
  );
  skirt.parent = root;
  skirt.position = new Vector3(0, 0.72, 0);
  skirt.material = robeMat;

  const head = MeshBuilder.CreateSphere(
    `${prefix}Head`,
    { diameter: 0.34, segments: 10 },
    scene,
  );
  head.parent = root;
  head.position = new Vector3(0, 1.62, 0);
  head.material = skinMat;

  const hood = MeshBuilder.CreateSphere(
    `${prefix}Hood`,
    { diameter: 0.38, segments: 8 },
    scene,
  );
  hood.parent = root;
  hood.position = new Vector3(0, 1.66, -0.02);
  hood.scaling = new Vector3(1.05, 0.7, 1.1);
  hood.material = robeMat;

  const armL = MeshBuilder.CreateBox(
    `${prefix}ArmL`,
    { width: 0.18, height: 0.62, depth: 0.2 },
    scene,
  );
  armL.parent = root;
  armL.position = new Vector3(-0.42, 1.12, 0);
  armL.material = robeMat;

  const armR = MeshBuilder.CreateBox(
    `${prefix}ArmR`,
    { width: 0.18, height: 0.62, depth: 0.2 },
    scene,
  );
  armR.parent = root;
  armR.position = new Vector3(0.42, 1.12, 0);
  armR.material = robeMat;

  const handL = MeshBuilder.CreateBox(
    `${prefix}HandL`,
    { width: 0.14, height: 0.14, depth: 0.16 },
    scene,
  );
  handL.parent = root;
  handL.position = new Vector3(-0.42, 0.76, 0.02);
  handL.material = skinMat;

  const handR = MeshBuilder.CreateBox(
    `${prefix}HandR`,
    { width: 0.14, height: 0.14, depth: 0.16 },
    scene,
  );
  handR.parent = root;
  handR.position = new Vector3(0.42, 0.76, 0.02);
  handR.material = skinMat;

  const staff = new Mesh(`${prefix}Staff`, scene);
  staff.parent = root;
  staff.position = new Vector3(0.55, 0.55, 0.12);
  staff.rotation.z = -0.18;
  staff.rotation.x = 0.08;

  const shaft = MeshBuilder.CreateCylinder(
    `${prefix}StaffShaft`,
    {
      height: 1.55,
      diameterTop: 0.045,
      diameterBottom: 0.06,
      tessellation: 6,
    },
    scene,
  );
  shaft.parent = staff;
  shaft.position.y = 0.75;
  shaft.material = staffMat;

  const orb = MeshBuilder.CreateSphere(
    `${prefix}StaffOrb`,
    { diameter: 0.16, segments: 8 },
    scene,
  );
  orb.parent = staff;
  orb.position.y = 1.55;
  orb.material = orbMat;

  const shoulderL = MeshBuilder.CreateBox(
    `${prefix}ShoulderL`,
    { width: 0.22, height: 0.14, depth: 0.28 },
    scene,
  );
  shoulderL.parent = root;
  shoulderL.position = new Vector3(-0.36, 1.4, 0);
  shoulderL.material = robeMat;

  const shoulderR = MeshBuilder.CreateBox(
    `${prefix}ShoulderR`,
    { width: 0.22, height: 0.14, depth: 0.28 },
    scene,
  );
  shoulderR.parent = root;
  shoulderR.position = new Vector3(0.36, 1.4, 0);
  shoulderR.material = robeMat;

  root.material = robeMat;
  root.position = new Vector3(0, 0, 0);

  return { root, mat: robeMat, staff };
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
