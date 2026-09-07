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
export function createPlayerHumanoid(scene: Scene): HumanoidParts {
  const root = new Mesh('player', scene);

  const robeMat = mat(scene, 'playerRobeMat', new Color3(0.28, 0.38, 0.72), 0.08);
  const skinMat = mat(scene, 'playerSkinMat', new Color3(0.86, 0.68, 0.52), 0.04);
  const bootMat = mat(scene, 'playerBootMat', new Color3(0.22, 0.16, 0.12), 0.03);
  const staffMat = mat(scene, 'playerStaffMat', new Color3(0.45, 0.28, 0.14), 0.05);
  const orbMat = mat(scene, 'playerStaffOrbMat', new Color3(0.35, 0.75, 1.0), 0.35);
  orbMat.specularColor = new Color3(0.4, 0.6, 0.9);

  // Legs (slight gap) — boots
  const legL = MeshBuilder.CreateBox(
    'playerLegL',
    { width: 0.22, height: 0.72, depth: 0.26 },
    scene,
  );
  legL.parent = root;
  legL.position = new Vector3(-0.14, 0.36, 0);
  legL.material = bootMat;

  const legR = MeshBuilder.CreateBox(
    'playerLegR',
    { width: 0.22, height: 0.72, depth: 0.26 },
    scene,
  );
  legR.parent = root;
  legR.position = new Vector3(0.14, 0.36, 0);
  legR.material = bootMat;

  // Torso / robes (wider than capsule for readability)
  const torso = MeshBuilder.CreateBox(
    'playerTorso',
    { width: 0.58, height: 0.72, depth: 0.34 },
    scene,
  );
  torso.parent = root;
  torso.position = new Vector3(0, 1.08, 0);
  torso.material = robeMat;

  // Hip / robe skirt flare
  const skirt = MeshBuilder.CreateCylinder(
    'playerSkirt',
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

  // Head
  const head = MeshBuilder.CreateSphere(
    'playerHead',
    { diameter: 0.34, segments: 10 },
    scene,
  );
  head.parent = root;
  head.position = new Vector3(0, 1.62, 0);
  head.material = skinMat;

  // Hood / hair cap (robes)
  const hood = MeshBuilder.CreateSphere(
    'playerHood',
    { diameter: 0.38, segments: 8 },
    scene,
  );
  hood.parent = root;
  hood.position = new Vector3(0, 1.66, -0.02);
  hood.scaling = new Vector3(1.05, 0.7, 1.1);
  hood.material = robeMat;

  // Arms
  const armL = MeshBuilder.CreateBox(
    'playerArmL',
    { width: 0.18, height: 0.62, depth: 0.2 },
    scene,
  );
  armL.parent = root;
  armL.position = new Vector3(-0.42, 1.12, 0);
  armL.material = robeMat;

  const armR = MeshBuilder.CreateBox(
    'playerArmR',
    { width: 0.18, height: 0.62, depth: 0.2 },
    scene,
  );
  armR.parent = root;
  armR.position = new Vector3(0.42, 1.12, 0);
  armR.material = robeMat;

  // Hands (skin)
  const handL = MeshBuilder.CreateBox(
    'playerHandL',
    { width: 0.14, height: 0.14, depth: 0.16 },
    scene,
  );
  handL.parent = root;
  handL.position = new Vector3(-0.42, 0.76, 0.02);
  handL.material = skinMat;

  const handR = MeshBuilder.CreateBox(
    'playerHandR',
    { width: 0.14, height: 0.14, depth: 0.16 },
    scene,
  );
  handR.parent = root;
  handR.position = new Vector3(0.42, 0.76, 0.02);
  handR.material = skinMat;

  // Staff — held in right hand, tip up
  const staff = new Mesh('playerStaff', scene);
  staff.parent = root;
  staff.position = new Vector3(0.55, 0.55, 0.12);
  staff.rotation.z = -0.18;
  staff.rotation.x = 0.08;

  const shaft = MeshBuilder.CreateCylinder(
    'playerStaffShaft',
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
    'playerStaffOrb',
    { diameter: 0.16, segments: 8 },
    scene,
  );
  orb.parent = staff;
  orb.position.y = 1.55;
  orb.material = orbMat;

  // Collar / shoulder pads for silhouette
  const shoulderL = MeshBuilder.CreateBox(
    'playerShoulderL',
    { width: 0.22, height: 0.14, depth: 0.28 },
    scene,
  );
  shoulderL.parent = root;
  shoulderL.position = new Vector3(-0.36, 1.4, 0);
  shoulderL.material = robeMat;

  const shoulderR = MeshBuilder.CreateBox(
    'playerShoulderR',
    { width: 0.22, height: 0.14, depth: 0.28 },
    scene,
  );
  shoulderR.parent = root;
  shoulderR.position = new Vector3(0.36, 1.4, 0);
  shoulderR.material = robeMat;

  // Root carries robe mat for flashMesh (cast telegraph).
  root.material = robeMat;
  root.position = new Vector3(0, 0, 0);

  return { root, mat: robeMat, staff };
}
