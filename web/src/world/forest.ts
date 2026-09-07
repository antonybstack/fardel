import {
  Color3,
  Color4,
  DirectionalLight,
  HemisphericLight,
  Matrix,
  Mesh,
  MeshBuilder,
  Quaternion,
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

function makeUnderstoryMat(scene: Scene, name: string, tint: Color3): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = tint;
  m.specularColor = new Color3(0.01, 0.02, 0.01);
  m.emissiveColor = new Color3(0.015, 0.03, 0.012);
  m.backFaceCulling = false;
  return m;
}

type TreeBuildOpts = {
  trunkHeight: number;
  trunkRadius: number;
  canopyLevels: number;
  canopyBase: number;
  trunkMat: StandardMaterial;
  foliageMat: StandardMaterial;
  /** Canopy lean / asymmetry for stronger silhouettes (hero only). */
  canopyLean?: number;
  /** Extra trunk knots / secondary bole for gnarled look. */
  gnarl?: boolean;
  tessellation?: number;
};

/**
 * Unique hero tree — thick gnarled bole + asymmetric canopy (not ThinInstanced).
 */
function buildTreeMesh(scene: Scene, name: string, opts: TreeBuildOpts): Mesh {
  const root = new Mesh(name, scene);
  const tess = opts.tessellation ?? 8;
  const lean = opts.canopyLean ?? 0;

  const trunk = MeshBuilder.CreateCylinder(
    `${name}_trunk`,
    {
      height: opts.trunkHeight,
      diameterTop: opts.trunkRadius * 1.05,
      diameterBottom: opts.trunkRadius * 2.9,
      tessellation: tess,
    },
    scene,
  );
  trunk.parent = root;
  trunk.position.y = opts.trunkHeight * 0.5;
  trunk.rotation.z = lean * 0.04;
  trunk.material = opts.trunkMat;

  if (opts.gnarl) {
    // Secondary bole bulge + knot spheres → readable gnarled silhouette without high-poly.
    const bulge = MeshBuilder.CreateCylinder(
      `${name}_bulge`,
      {
        height: opts.trunkHeight * 0.35,
        diameterTop: opts.trunkRadius * 1.6,
        diameterBottom: opts.trunkRadius * 2.2,
        tessellation: 6,
      },
      scene,
    );
    bulge.parent = root;
    bulge.position.set(opts.trunkRadius * 0.35, opts.trunkHeight * 0.28, 0);
    bulge.rotation.z = 0.35;
    bulge.material = opts.trunkMat;

    const knot = MeshBuilder.CreateSphere(
      `${name}_knot`,
      { diameter: opts.trunkRadius * 1.4, segments: 5 },
      scene,
    );
    knot.parent = root;
    knot.position.set(-opts.trunkRadius * 0.55, opts.trunkHeight * 0.42, opts.trunkRadius * 0.2);
    knot.scaling.set(1.2, 0.7, 1);
    knot.material = opts.trunkMat;

    const rootFlare = MeshBuilder.CreateCylinder(
      `${name}_flare`,
      {
        height: opts.trunkHeight * 0.12,
        diameterTop: opts.trunkRadius * 2.4,
        diameterBottom: opts.trunkRadius * 3.6,
        tessellation: 6,
      },
      scene,
    );
    rootFlare.parent = root;
    rootFlare.position.y = opts.trunkHeight * 0.05;
    rootFlare.material = opts.trunkMat;
  }

  let y = opts.trunkHeight * 0.48;
  for (let i = 0; i < opts.canopyLevels; i++) {
    const t = i / Math.max(1, opts.canopyLevels - 1);
    const dia = opts.canopyBase * (1 - t * 0.58);
    const h = opts.canopyBase * (0.5 - t * 0.1);
    const cone = MeshBuilder.CreateCylinder(
      `${name}_canopy_${i}`,
      {
        height: h,
        diameterTop: 0.05,
        diameterBottom: dia,
        tessellation: tess,
      },
      scene,
    );
    cone.parent = root;
    const side = lean * (1 - t) * (i % 2 === 0 ? 1 : -0.7);
    cone.position.set(side, y + h * 0.35, lean * 0.4 * (1 - t));
    cone.rotation.z = lean * 0.1 * (1 - t);
    cone.material = opts.foliageMat;
    y += h * 0.38;
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
  silhouette: 'landmark' | 'sentinel' | 'standard' = 'standard',
): Mesh {
  const landmark = silhouette === 'landmark';
  const sentinel = silhouette === 'sentinel';
  const tree = buildTreeMesh(scene, name, {
    trunkHeight: (landmark ? 17 : sentinel ? 14.5 : 13) * scale,
    trunkRadius: (landmark ? 1.7 : sentinel ? 1.25 : 1.05) * scale,
    canopyLevels: landmark ? 5 : 4,
    canopyBase: (landmark ? 13.5 : sentinel ? 11.8 : 11) * scale,
    trunkMat,
    foliageMat,
    canopyLean: landmark ? 1.1 : sentinel ? 0.55 : 0.25,
    gnarl: landmark || sentinel,
    tessellation: landmark ? 9 : 7,
  });
  tree.position.set(x, 0, z);
  tree.rotation.y = yaw;
  return tree;
}

type MidVariantOpts = {
  trunkHeight: number;
  trunkTop: number;
  trunkBot: number;
  levels: number;
  canopyBase: number;
  canopyH0: number;
  tess: number;
};

/** Merged mid tree for ThinInstances. */
function buildMergedMidTree(
  scene: Scene,
  name: string,
  trunkMat: StandardMaterial,
  foliageMat: StandardMaterial,
  variant: MidVariantOpts,
): Mesh {
  const trunk = MeshBuilder.CreateCylinder(
    `${name}_trunk`,
    {
      height: variant.trunkHeight,
      diameterTop: variant.trunkTop,
      diameterBottom: variant.trunkBot,
      tessellation: variant.tess,
    },
    scene,
  );
  trunk.position.y = variant.trunkHeight * 0.5;
  trunk.material = trunkMat;

  const parts: Mesh[] = [trunk];
  let y = variant.trunkHeight * 0.55;
  for (let i = 0; i < variant.levels; i++) {
    const t = i / Math.max(1, variant.levels - 1);
    const dia = variant.canopyBase * (1 - t * 0.32);
    const h = variant.canopyH0 - i * 0.32;
    const cone = MeshBuilder.CreateCylinder(
      `${name}_canopy_${i}`,
      { height: h, diameterTop: 0.08, diameterBottom: dia, tessellation: variant.tess },
      scene,
    );
    cone.position.y = y + h * 0.3;
    cone.material = foliageMat;
    parts.push(cone);
    y += h * 0.4;
  }

  const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, true);
  if (!merged) {
    throw new Error(`Failed to merge mid-tree meshes (${name})`);
  }
  merged.name = name;
  // Stay at origin: ThinInstance world matrices + BI refresh (parking at -400 culls all).
  merged.isPickable = false;
  return merged;
}

/** Far LOD: trunk + one canopy — few segments. */
function buildFarLodTree(
  scene: Scene,
  name: string,
  trunkMat: StandardMaterial,
  foliageMat: StandardMaterial,
): Mesh {
  const trunk = MeshBuilder.CreateCylinder(
    `${name}_trunk`,
    {
      height: 6.5,
      diameterTop: 0.4,
      diameterBottom: 0.85,
      tessellation: 5,
    },
    scene,
  );
  trunk.position.y = 3.25;
  trunk.material = trunkMat;

  const canopy = MeshBuilder.CreateCylinder(
    `${name}_canopy`,
    {
      height: 4.2,
      diameterTop: 0.1,
      diameterBottom: 4.8,
      tessellation: 5,
    },
    scene,
  );
  canopy.position.y = 7.0;
  canopy.material = foliageMat;

  const merged = Mesh.MergeMeshes([trunk, canopy], true, true, undefined, false, true);
  if (!merged) {
    throw new Error('Failed to merge far-LOD tree');
  }
  merged.name = name;
  merged.isPickable = false;
  return merged;
}

/** Cheap fern/grass cluster (two crossed blades) for understory ThinInstances. */
function buildUnderstoryCluster(
  scene: Scene,
  name: string,
  mat: StandardMaterial,
): Mesh {
  const a = MeshBuilder.CreateCylinder(
    `${name}_a`,
    { height: 1.1, diameterTop: 0.02, diameterBottom: 0.55, tessellation: 4 },
    scene,
  );
  a.position.y = 0.55;
  a.material = mat;

  const b = MeshBuilder.CreateCylinder(
    `${name}_b`,
    { height: 0.95, diameterTop: 0.02, diameterBottom: 0.48, tessellation: 4 },
    scene,
  );
  b.position.set(0.12, 0.48, 0.08);
  b.rotation.y = 1.1;
  b.rotation.z = 0.25;
  b.material = mat;

  const c = MeshBuilder.CreateCylinder(
    `${name}_c`,
    { height: 0.75, diameterTop: 0.02, diameterBottom: 0.35, tessellation: 4 },
    scene,
  );
  c.position.set(-0.1, 0.38, -0.06);
  c.rotation.y = -0.8;
  c.rotation.z = -0.2;
  c.material = mat;

  const merged = Mesh.MergeMeshes([a, b, c], true, true, undefined, false, true);
  if (!merged) {
    throw new Error('Failed to merge understory cluster');
  }
  merged.name = name;
  merged.isPickable = false;
  return merged;
}

function composeInstanceMatrix(
  x: number,
  z: number,
  scaleX: number,
  scaleY: number,
  scaleZ: number,
  yaw: number,
): Matrix {
  return Matrix.Compose(
    new Vector3(scaleX, scaleY, scaleZ),
    Quaternion.FromEulerAngles(0, yaw, 0),
    new Vector3(x, 0, z),
  );
}

function thinInstanceFromMatrices(mesh: Mesh, matrices: Matrix[]): void {
  if (matrices.length === 0) return;
  const buffer = new Float32Array(matrices.length * 16);
  for (let i = 0; i < matrices.length; i++) {
    matrices[i]!.copyToArray(buffer, i * 16);
  }
  mesh.thinInstanceSetBuffer('matrix', buffer, 16, true);
  mesh.thinInstanceRefreshBoundingInfo(true);
}

function buildMountainBackdrop(scene: Scene): void {
  const rockMat = new StandardMaterial('mountainMat', scene);
  rockMat.diffuseColor = new Color3(0.26, 0.3, 0.36);
  rockMat.specularColor = new Color3(0.02, 0.02, 0.03);
  rockMat.emissiveColor = new Color3(0.03, 0.04, 0.06);

  const snowMat = new StandardMaterial('snowCapMat', scene);
  snowMat.diffuseColor = new Color3(0.72, 0.78, 0.86);
  snowMat.specularColor = new Color3(0.12, 0.12, 0.15);
  snowMat.emissiveColor = new Color3(0.06, 0.07, 0.09);

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
 * Procedural / kitbash forest clearing: gnarled landmark heroes, ThinInstanced
 * mid-tree variety + far LOD, understory clusters. Fog/hemi/sun from #39 lock.
 * Web-cheap (shared StandardMaterials + ThinInstances). Art #34 mood.
 */
export function buildForestClearing(scene: Scene): {
  ground: Mesh;
  hemi: HemisphericLight;
  sun: DirectionalLight;
} {
  // Atmosphere lock from #39/develop: blue/cyan fog, warm sun + cool hemi, lush ground.
  // Mood > volumetric soup — StandardMaterial + EXP2 fog only (web-cheap).
  // Hemi/sun locked for Dev4 (#33) robe mats — do not flip casually.
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

  // Lime moss patches — place highlights like mood ref (not neon).
  const limeMat = new StandardMaterial('limeMossMat', scene);
  limeMat.diffuseColor = new Color3(0.42, 0.62, 0.22);
  limeMat.specularColor = new Color3(0.02, 0.03, 0.01);
  limeMat.emissiveColor = new Color3(0.04, 0.07, 0.02);
  const limeSpots: Array<{ x: number; z: number; r: number }> = [
    { x: -6, z: 4, r: 3.2 },
    { x: 8, z: -3, r: 2.6 },
    { x: 2, z: 10, r: 2.2 },
    { x: -11, z: -6, r: 2.8 },
    { x: 12, z: 8, r: 2.0 },
    { x: -3, z: -12, r: 2.4 },
  ];
  for (let i = 0; i < limeSpots.length; i++) {
    const s = limeSpots[i]!;
    const patch = MeshBuilder.CreateDisc(`limeMoss_${i}`, { radius: s.r, tessellation: 16 }, scene);
    patch.rotation.x = Math.PI / 2;
    patch.position.set(s.x, 0.025, s.z);
    patch.material = limeMat;
  }

  // Shared mats: grey-brown bark + muted deep greens (Art — no neon).
  const trunkMatA = makeTrunkMat(scene, 'trunkMatA', new Color3(0.32, 0.28, 0.24));
  const trunkMatB = makeTrunkMat(scene, 'trunkMatB', new Color3(0.26, 0.22, 0.18));
  const foliageA = makeFoliageMat(scene, 'foliageA', new Color3(0.12, 0.3, 0.14));
  const foliageB = makeFoliageMat(scene, 'foliageB', new Color3(0.09, 0.24, 0.12));
  const foliageC = makeFoliageMat(scene, 'foliageC', new Color3(0.16, 0.34, 0.16));
  const underMat = makeUnderstoryMat(scene, 'understoryMat', new Color3(0.2, 0.42, 0.16));

  // Landmark gnarled heroes — thick bole silhouettes at rim.
  placeHeroTree(scene, 'heroElderN', 3, -34, 1.9, 0.18, trunkMatA, foliageB, 'landmark');
  placeHeroTree(scene, 'heroElderSW', -22, 24, 1.7, 2.15, trunkMatB, foliageA, 'landmark');
  placeHeroTree(scene, 'heroSentNE', 24, -17, 1.4, 0.45, trunkMatA, foliageA, 'sentinel');
  placeHeroTree(scene, 'heroSentNW', -26, -15, 1.5, -0.55, trunkMatB, foliageB, 'sentinel');
  placeHeroTree(scene, 'heroSentSE', 19, 27, 1.25, 1.05, trunkMatA, foliageC, 'standard');
  placeHeroTree(scene, 'heroSentE', 30, 6, 1.35, -1.2, trunkMatB, foliageC, 'sentinel');

  const midClassic = buildMergedMidTree(scene, 'midClassic', trunkMatB, foliageB, {
    trunkHeight: 7.5,
    trunkTop: 0.55,
    trunkBot: 1.1,
    levels: 3,
    canopyBase: 5.2,
    canopyH0: 3.2,
    tess: 7,
  });
  const midTall = buildMergedMidTree(scene, 'midTall', trunkMatA, foliageA, {
    trunkHeight: 9.2,
    trunkTop: 0.42,
    trunkBot: 0.95,
    levels: 4,
    canopyBase: 4.4,
    canopyH0: 2.85,
    tess: 6,
  });
  const midStubby = buildMergedMidTree(scene, 'midStubby', trunkMatB, foliageC, {
    trunkHeight: 5.8,
    trunkTop: 0.7,
    trunkBot: 1.35,
    levels: 2,
    canopyBase: 6.4,
    canopyH0: 3.6,
    tess: 6,
  });

  const farLod = buildFarLodTree(scene, 'farLodTree', trunkMatB, foliageB);
  const understory = buildUnderstoryCluster(scene, 'understoryCluster', underMat);

  const matsClassic: Matrix[] = [];
  const matsTall: Matrix[] = [];
  const matsStubby: Matrix[] = [];
  const matsFar: Matrix[] = [];
  const matsUnder: Matrix[] = [];

  // Dense inner ring (approach gap kept so clearing reads as a place).
  const innerCount = 68;
  const innerR0 = 22;
  const innerR1 = 38;
  for (let i = 0; i < innerCount; i++) {
    const a = (i / innerCount) * Math.PI * 2 + hash01(i * 3) * 0.28;
    const r = innerR0 + hash01(i * 7) * (innerR1 - innerR0);
    if (a > 0.12 && a < 0.52 && r < 32) continue;
    const s = 0.72 + hash01(i * 11) * 0.9;
    const sy = s * (0.88 + hash01(i * 13) * 0.38);
    const m = composeInstanceMatrix(
      Math.cos(a) * r,
      Math.sin(a) * r,
      s,
      sy,
      s,
      hash01(i * 17) * Math.PI * 2,
    );
    const pick = hash01(i * 41);
    if (pick < 0.38) matsClassic.push(m);
    else if (pick < 0.72) matsTall.push(m);
    else matsStubby.push(m);
  }

  const midCount = 40;
  for (let i = 0; i < midCount; i++) {
    const a = (i / midCount) * Math.PI * 2 + 0.22 + hash01(i * 5) * 0.2;
    const r = 42 + hash01(i * 9) * 14;
    const s = 0.65 + hash01(i * 15) * 0.7;
    const m = composeInstanceMatrix(
      Math.cos(a) * r,
      Math.sin(a) * r,
      s,
      s * (0.95 + hash01(i * 21) * 0.25),
      s,
      hash01(i * 27) * Math.PI * 2,
    );
    const pick = hash01(i * 33);
    if (pick < 0.45) matsClassic.push(m);
    else if (pick < 0.78) matsTall.push(m);
    else matsStubby.push(m);
  }

  // Far LOD — fog eats these into silhouette mass.
  const farCount = 48;
  for (let i = 0; i < farCount; i++) {
    const a = (i / farCount) * Math.PI * 2 + hash01(i * 19) * 0.15;
    const r = 58 + hash01(i * 23) * 22;
    const s = 0.7 + hash01(i * 29) * 0.85;
    matsFar.push(
      composeInstanceMatrix(
        Math.cos(a) * r,
        Math.sin(a) * r,
        s,
        s * (1.05 + hash01(i * 31) * 0.35),
        s,
        hash01(i * 37) * Math.PI * 2,
      ),
    );
  }

  // Understory grass/fern clusters around clearing rim + near dirt (budget ThinInstances).
  const underCount = 64;
  for (let i = 0; i < underCount; i++) {
    const a = (i / underCount) * Math.PI * 2 + hash01(i * 43) * 0.4;
    const band = hash01(i * 47);
    const r =
      band < 0.35
        ? 10 + hash01(i * 53) * 8
        : 18 + hash01(i * 53) * 12;
    if (r < 11 && a > 0.15 && a < 0.55) continue;
    const s = 0.7 + hash01(i * 59) * 1.1;
    matsUnder.push(
      composeInstanceMatrix(
        Math.cos(a) * r,
        Math.sin(a) * r,
        s * (0.8 + hash01(i * 61) * 0.5),
        s,
        s * (0.8 + hash01(i * 67) * 0.5),
        hash01(i * 71) * Math.PI * 2,
      ),
    );
  }

  thinInstanceFromMatrices(midClassic, matsClassic);
  thinInstanceFromMatrices(midTall, matsTall);
  thinInstanceFromMatrices(midStubby, matsStubby);
  thinInstanceFromMatrices(farLod, matsFar);
  thinInstanceFromMatrices(understory, matsUnder);

  buildMountainBackdrop(scene);
  buildSkyDome(scene);

  return { ground, hemi, sun };
}
