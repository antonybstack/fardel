import {
  Color3,
  Color4,
  DirectionalLight,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';

/** Deterministic pseudo-random in [0,1) from integer seed. */
function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function makeTrunkMat(scene: Scene, name: string, tint: Color3): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = tint;
  m.specularColor = new Color3(0.015, 0.012, 0.01);
  m.emissiveColor = tint.scale(0.04);
  return m;
}

function makeFoliageMat(scene: Scene, name: string, tint: Color3): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = tint;
  m.specularColor = new Color3(0.008, 0.012, 0.008);
  m.emissiveColor = tint.scale(0.06);
  return m;
}

/**
 * Build a single stylized tree as a parent mesh (trunk + stacked canopy cones).
 * Used for unique hero trees (not instanced).
 */
function buildTreeMesh(
  scene: Scene,
  name: string,
  opts: {
    trunkHeight: number;
    trunkRadius: number;
    canopyLevels: number;
    canopyBase: number;
    trunkMat: StandardMaterial;
    foliageMat: StandardMaterial;
  },
): Mesh {
  const root = new Mesh(name, scene);

  const trunk = MeshBuilder.CreateCylinder(
    `${name}_trunk`,
    {
      height: opts.trunkHeight,
      diameterTop: opts.trunkRadius * 1.2,
      diameterBottom: opts.trunkRadius * 2.4,
      tessellation: 8,
    },
    scene,
  );
  trunk.parent = root;
  trunk.position.y = opts.trunkHeight * 0.5;
  trunk.material = opts.trunkMat;

  let y = opts.trunkHeight * 0.55;
  for (let i = 0; i < opts.canopyLevels; i++) {
    const t = i / Math.max(1, opts.canopyLevels - 1);
    const dia = opts.canopyBase * (1 - t * 0.55);
    const h = opts.canopyBase * (0.55 - t * 0.12);
    const cone = MeshBuilder.CreateCylinder(
      `${name}_canopy_${i}`,
      {
        height: h,
        diameterTop: 0.05,
        diameterBottom: dia,
        tessellation: 8,
      },
      scene,
    );
    cone.parent = root;
    cone.position.y = y + h * 0.35;
    cone.material = opts.foliageMat;
    y += h * 0.42;
  }

  return root;
}

function placeHeroTree(
  scene: Scene,
  name: string,
  x: number,
  z: number,
  scale: number,
  yaw: number,
  trunkMat: StandardMaterial,
  foliageMat: StandardMaterial,
): Mesh {
  const tree = buildTreeMesh(scene, name, {
    trunkHeight: 14 * scale,
    trunkRadius: 1.1 * scale,
    canopyLevels: 4,
    canopyBase: 12 * scale,
    trunkMat,
    foliageMat,
  });
  tree.position.set(x, 0, z);
  tree.rotation.y = yaw;
  return tree;
}

/** Single-mesh mid tree (trunk + canopy cones merged) for GPU instances. */
function buildMergedMidTree(
  scene: Scene,
  name: string,
  trunkMat: StandardMaterial,
  foliageMat: StandardMaterial,
): Mesh {
  const trunk = MeshBuilder.CreateCylinder(
    `${name}_trunk`,
    {
      height: 7.5,
      diameterTop: 0.55,
      diameterBottom: 1.1,
      tessellation: 7,
    },
    scene,
  );
  trunk.position.y = 3.75;
  trunk.material = trunkMat;

  const parts: Mesh[] = [trunk];
  let y = 4.2;
  for (let i = 0; i < 3; i++) {
    const dia = 5.2 * (1 - i * 0.28);
    const h = 3.2 - i * 0.35;
    const cone = MeshBuilder.CreateCylinder(
      `${name}_canopy_${i}`,
      { height: h, diameterTop: 0.08, diameterBottom: dia, tessellation: 7 },
      scene,
    );
    cone.position.y = y + h * 0.3;
    cone.material = foliageMat;
    parts.push(cone);
    y += h * 0.4;
  }

  const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, true);
  if (!merged) {
    throw new Error('Failed to merge mid-tree meshes');
  }
  merged.name = name;
  return merged;
}

function buildMountainBackdrop(scene: Scene): void {
  const rockMat = new StandardMaterial('mountainMat', scene);
  rockMat.diffuseColor = new Color3(0.28, 0.32, 0.38);
  rockMat.specularColor = new Color3(0.02, 0.02, 0.03);
  rockMat.emissiveColor = new Color3(0.04, 0.05, 0.07);

  const snowMat = new StandardMaterial('snowCapMat', scene);
  snowMat.diffuseColor = new Color3(0.78, 0.82, 0.88);
  snowMat.specularColor = new Color3(0.15, 0.15, 0.18);
  snowMat.emissiveColor = new Color3(0.08, 0.09, 0.1);

  const peaks: Array<{ x: number; z: number; h: number; w: number; yaw: number }> = [
    { x: -90, z: -140, h: 95, w: 70, yaw: 0.1 },
    { x: -20, z: -155, h: 120, w: 85, yaw: -0.15 },
    { x: 55, z: -145, h: 105, w: 75, yaw: 0.25 },
    { x: 120, z: -130, h: 80, w: 60, yaw: -0.3 },
    { x: -140, z: -100, h: 70, w: 55, yaw: 0.4 },
    { x: 30, z: -170, h: 88, w: 50, yaw: 0.05 },
  ];

  for (let i = 0; i < peaks.length; i++) {
    const p = peaks[i]!;
    const mtn = MeshBuilder.CreateCylinder(
      `mountain_${i}`,
      {
        height: p.h,
        diameterTop: 0.5,
        diameterBottom: p.w,
        tessellation: 5,
      },
      scene,
    );
    mtn.position.set(p.x, p.h * 0.42, p.z);
    mtn.rotation.y = p.yaw;
    mtn.scaling.x = 1.4 + (i % 3) * 0.15;
    mtn.scaling.z = 1.1;
    mtn.material = rockMat;

    const cap = MeshBuilder.CreateCylinder(
      `snow_${i}`,
      {
        height: p.h * 0.18,
        diameterTop: 0.2,
        diameterBottom: p.w * 0.28,
        tessellation: 5,
      },
      scene,
    );
    cap.position.set(p.x, p.h * 0.78, p.z);
    cap.rotation.y = p.yaw;
    cap.scaling.x = mtn.scaling.x;
    cap.scaling.z = mtn.scaling.z;
    cap.material = snowMat;
  }

  for (let i = 0; i < 8; i++) {
    const x = -100 + i * 30 + hash01(i + 50) * 10;
    const z = -105 - hash01(i + 70) * 20;
    const h = 28 + hash01(i + 90) * 22;
    const ridge = MeshBuilder.CreateCylinder(
      `foothill_${i}`,
      {
        height: h,
        diameterTop: 2,
        diameterBottom: 38 + hash01(i) * 20,
        tessellation: 6,
      },
      scene,
    );
    ridge.position.set(x, h * 0.35, z);
    ridge.material = rockMat;
  }
}

function buildSkyDome(scene: Scene): void {
  const sky = MeshBuilder.CreateSphere('skyDome', { diameter: 420, segments: 16 }, scene);
  sky.infiniteDistance = true;
  const skyMat = new StandardMaterial('skyMat', scene);
  skyMat.backFaceCulling = false;
  skyMat.disableLighting = true;
  // Soft blue-cyan haze dome — matches atmospheric fog depth.
  skyMat.emissiveColor = new Color3(0.36, 0.54, 0.68);
  skyMat.diffuseColor = new Color3(0, 0, 0);
  sky.material = skyMat;
}

/**
 * Procedural / kitbash forest clearing: huge hero trunks, instanced mid trees,
 * distant mountain silhouettes, denser fog + warm sun/hemi, lush ground. Web-cheap (StandardMaterial + instances).
 */
export function buildForestClearing(scene: Scene): {
  ground: Mesh;
  hemi: HemisphericLight;
  sun: DirectionalLight;
} {
  // Atmosphere pass (#32): blue/cyan fog mid→far, warm sun + cool hemi, lush ground.
  // Mood > volumetric soup — StandardMaterial + EXP2 fog only (web-cheap).
  // Hemi/sun locked for Dev4 (#33) robe mats — report finals in PR; do not flip casually.
  scene.clearColor = new Color4(0.24, 0.36, 0.46, 1);
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogDensity = 0.015;
  scene.fogColor = new Color3(0.34, 0.55, 0.7);

  const hemi = new HemisphericLight('hemiForest', new Vector3(0.12, 1, 0.22), scene);
  hemi.intensity = 0.78;
  // Cool canopy-filtered fill (stable for #33) + green ground bounce.
  hemi.diffuse = new Color3(0.68, 0.78, 0.86);
  hemi.groundColor = new Color3(0.16, 0.26, 0.14);
  hemi.specular = new Color3(0.1, 0.12, 0.14);

  const sun = new DirectionalLight('sunForest', new Vector3(-0.5, -0.68, -0.4), scene);
  sun.position = new Vector3(48, 55, 28);
  sun.intensity = 0.98;
  // Warmer golden-hour key for fantasy clearing readability.
  sun.diffuse = new Color3(1.0, 0.82, 0.52);
  sun.specular = new Color3(0.42, 0.32, 0.18);

  const ground = MeshBuilder.CreateGround(
    'clearing',
    { width: 120, height: 120, subdivisions: 2 },
    scene,
  );
  const groundMat = new StandardMaterial('clearingMat', scene);
  // Richer saturated grass albedo vs cyan fog.
  groundMat.diffuseColor = new Color3(0.26, 0.52, 0.18);
  groundMat.specularColor = new Color3(0.012, 0.018, 0.01);
  groundMat.emissiveColor = new Color3(0.035, 0.07, 0.022);
  ground.material = groundMat;

  // Soft moss ring around the dirt clearing — dirt/grass transition without new packs.
  const moss = MeshBuilder.CreateDisc('mossRing', { radius: 14, tessellation: 32 }, scene);
  moss.rotation.x = Math.PI / 2;
  moss.position.y = 0.015;
  const mossMat = new StandardMaterial('mossMat', scene);
  mossMat.diffuseColor = new Color3(0.22, 0.48, 0.16);
  mossMat.specularColor = new Color3(0.01, 0.016, 0.008);
  mossMat.emissiveColor = new Color3(0.03, 0.065, 0.02);
  moss.material = mossMat;

  const dirt = MeshBuilder.CreateDisc('dirtPatch', { radius: 9, tessellation: 28 }, scene);
  dirt.rotation.x = Math.PI / 2;
  dirt.position.y = 0.03;
  const dirtMat = new StandardMaterial('dirtMat', scene);
  // Grey-brown packed path — clearer contrast vs lush grass.
  dirtMat.diffuseColor = new Color3(0.42, 0.36, 0.26);
  dirtMat.specularColor = new Color3(0.02, 0.018, 0.012);
  dirtMat.emissiveColor = new Color3(0.04, 0.032, 0.02);
  dirt.material = dirtMat;

  const trunkMatA = makeTrunkMat(scene, 'trunkMatA', new Color3(0.28, 0.18, 0.1));
  const trunkMatB = makeTrunkMat(scene, 'trunkMatB', new Color3(0.22, 0.14, 0.08));
  const foliageA = makeFoliageMat(scene, 'foliageA', new Color3(0.12, 0.4, 0.16));
  const foliageB = makeFoliageMat(scene, 'foliageB', new Color3(0.08, 0.3, 0.14));
  const foliageC = makeFoliageMat(scene, 'foliageC', new Color3(0.16, 0.44, 0.18));

  placeHeroTree(scene, 'heroTreeNE', 22, -18, 1.35, 0.4, trunkMatA, foliageA);
  placeHeroTree(scene, 'heroTreeNW', -24, -16, 1.55, -0.6, trunkMatB, foliageB);
  placeHeroTree(scene, 'heroTreeSE', 18, 26, 1.2, 1.1, trunkMatA, foliageC);
  placeHeroTree(scene, 'heroTreeSW', -20, 22, 1.45, 2.2, trunkMatB, foliageA);
  placeHeroTree(scene, 'heroTreeN', 4, -32, 1.7, 0.2, trunkMatA, foliageB);

  const midMerged = buildMergedMidTree(scene, 'midTreeMerged', trunkMatB, foliageB);
  midMerged.position.set(0, -200, 0);
  midMerged.isVisible = false;
  midMerged.setEnabled(false);

  const ringCount = 36;
  const innerR = 28;
  const outerR = 52;
  for (let i = 0; i < ringCount; i++) {
    const a = (i / ringCount) * Math.PI * 2 + hash01(i * 3) * 0.35;
    const r = innerR + hash01(i * 7) * (outerR - innerR);
    if (a > 0.15 && a < 0.55 && r < 34) continue;
    const inst = midMerged.createInstance(`midTree_${i}`);
    const s = 0.75 + hash01(i * 11) * 0.85;
    inst.scaling.set(s, s * (0.9 + hash01(i * 13) * 0.35), s);
    inst.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    inst.rotation.y = hash01(i * 17) * Math.PI * 2;
    inst.setEnabled(true);
  }

  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2 + 0.4;
    const r = 55 + hash01(i * 19) * 18;
    const inst = midMerged.createInstance(`farTree_${i}`);
    const s = 0.55 + hash01(i * 23) * 0.5;
    inst.scaling.set(s, s * 1.1, s);
    inst.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    inst.rotation.y = hash01(i * 29) * Math.PI * 2;
  }

  buildMountainBackdrop(scene);
  buildSkyDome(scene);

  return { ground, hemi, sun };
}
