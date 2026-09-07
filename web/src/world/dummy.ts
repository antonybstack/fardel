import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
} from '@babylonjs/core';

/**
 * Procedural training dummy / scarecrow (no art packs).
 * Wood post + crossbeam + canvas torso pad + sack head — readable TARGET
 * at play-cam 8–15m under #39 cool hemi / warm sun / cyan fog.
 * Total height ~1.8m. Root/assembly at feet (y=0); caller parents under npc root.
 */
export type TrainingDummyParts = {
  /** Visual assembly (stake/crossbeam/torso/head). Parent under npc root. */
  body: Mesh;
  /** Primary cloth mat — cast flash / death fade. */
  mat: StandardMaterial;
  /** Secondary mats faded with primary on death (wood/head/straps/straw). */
  extraMats: StandardMaterial[];
};

function mat(
  scene: Scene,
  name: string,
  diffuse: Color3,
  emissiveScale = 0.04,
): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = diffuse;
  m.specularColor = new Color3(0.07, 0.06, 0.05);
  m.emissiveColor = diffuse.scale(emissiveScale);
  return m;
}

/**
 * Build a scarecrow/practice-dummy silhouette from DIY primitives.
 * `body` is an empty transform at y=0; parts are children in local space.
 */
export function createTrainingDummy(
  scene: Scene,
  prefix = 'dummy',
): TrainingDummyParts {
  const body = new Mesh(`${prefix}_body`, scene);

  // Warm wood — readable vs cyan fog; matches staff wood family, slightly darker stake.
  const woodMat = mat(
    scene,
    `${prefix}WoodMat`,
    new Color3(0.46, 0.28, 0.13),
    0.03,
  );
  woodMat.specularColor = new Color3(0.1, 0.07, 0.04);

  // Desaturated canvas / straw cloth — warm, matte, not neon under warm sun.
  const clothMat = mat(
    scene,
    `${prefix}ClothMat`,
    new Color3(0.58, 0.48, 0.34),
    0.035,
  );
  clothMat.specularColor = new Color3(0.06, 0.05, 0.04);

  // Head sack — slightly lighter canvas for silhouette break vs torso.
  const headMat = mat(
    scene,
    `${prefix}HeadMat`,
    new Color3(0.64, 0.55, 0.4),
    0.03,
  );
  headMat.specularColor = new Color3(0.05, 0.05, 0.04);

  // Vertical stake ~1.75m (feet → just under head).
  const stake = MeshBuilder.CreateCylinder(
    `${prefix}_stake`,
    { height: 1.72, diameter: 0.13, tessellation: 8 },
    scene,
  );
  stake.parent = body;
  stake.position.y = 0.86;
  stake.material = woodMat;
  stake.isPickable = false;

  // Crossbeam at shoulder height — classic scarecrow T.
  const beam = MeshBuilder.CreateCylinder(
    `${prefix}_beam`,
    { height: 1.15, diameter: 0.1, tessellation: 8 },
    scene,
  );
  beam.parent = body;
  beam.position.y = 1.38;
  beam.rotation.z = Math.PI / 2;
  beam.material = woodMat;
  beam.isPickable = false;

  // Small wood pegs / rope wraps at beam joints (silhouette ticks at distance).
  for (const side of [-1, 1] as const) {
    const wrap = MeshBuilder.CreateCylinder(
      `${prefix}_wrap_${side}`,
      { height: 0.08, diameter: 0.16, tessellation: 6 },
      scene,
    );
    wrap.parent = body;
    wrap.position.set(side * 0.42, 1.38, 0);
    wrap.rotation.z = Math.PI / 2;
    wrap.material = woodMat;
    wrap.isPickable = false;
  }

  // Torso pad — canvas sack on the post (practice-dummy “hit me” mass).
  const torso = MeshBuilder.CreateBox(
    `${prefix}_torso`,
    { width: 0.58, height: 0.72, depth: 0.28 },
    scene,
  );
  torso.parent = body;
  torso.position.y = 0.98;
  torso.material = clothMat;
  torso.isPickable = false;

  // X-mark straps on torso — reads as target/practice pad at 8–15m.
  const strapMat = mat(
    scene,
    `${prefix}StrapMat`,
    new Color3(0.38, 0.28, 0.18),
    0.025,
  );
  strapMat.specularColor = new Color3(0.04, 0.03, 0.02);
  for (const [sx, sy, rotZ] of [
    [1, 1, 0.55],
    [1, 1, -0.55],
  ] as const) {
    const strap = MeshBuilder.CreateBox(
      `${prefix}_strap_${rotZ}`,
      { width: 0.07, height: 0.78, depth: 0.04 },
      scene,
    );
    strap.parent = body;
    strap.position.set(0, 0.98, 0.15);
    strap.rotation.z = rotZ;
    strap.scaling.set(sx, sy, 1);
    strap.material = strapMat;
    strap.isPickable = false;
  }

  // Sack head on the post top.
  const head = MeshBuilder.CreateSphere(
    `${prefix}_head`,
    { diameter: 0.4, segments: 10 },
    scene,
  );
  head.parent = body;
  head.position.y = 1.72;
  head.scaling.set(1, 1.08, 0.95);
  head.material = headMat;
  head.isPickable = false;

  // Straw tufts from head + beam ends — scarecrow energy, cheap primitives.
  const strawMat = mat(
    scene,
    `${prefix}StrawMat`,
    new Color3(0.7, 0.58, 0.28),
    0.04,
  );
  strawMat.specularColor = new Color3(0.05, 0.04, 0.02);
  const tuftSpecs: Array<[number, number, number, number, number]> = [
    // x, y, z, rotZ, rotX
    [0.12, 1.9, 0.02, 0.35, 0.2],
    [-0.1, 1.88, -0.04, -0.4, 0.15],
    [0.02, 1.92, 0.1, 0.1, -0.35],
    [0.58, 1.38, 0, 1.15, 0.25],
    [-0.58, 1.38, 0, -1.15, 0.25],
  ];
  tuftSpecs.forEach(([x, y, z, rotZ, rotX], i) => {
    const tuft = MeshBuilder.CreateCylinder(
      `${prefix}_straw_${i}`,
      { height: 0.22, diameterTop: 0.01, diameterBottom: 0.05, tessellation: 5 },
      scene,
    );
    tuft.parent = body;
    tuft.position.set(x, y, z);
    tuft.rotation.z = rotZ;
    tuft.rotation.x = rotX;
    tuft.material = strawMat;
    tuft.isPickable = false;
  });

  return {
    body,
    mat: clothMat,
    extraMats: [woodMat, headMat, strapMat, strawMat],
  };
}
