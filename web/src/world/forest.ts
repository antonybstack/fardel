import {
  AbstractMesh,
  Color3,
  Color4,
  DirectionalLight,
  DynamicTexture,
  HemisphericLight,
  ImportMeshAsync,
  Material,
  Matrix,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Quaternion,
  Scene,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import '@babylonjs/loaders/glTF';

/** Vendored free Quaternius Stylized Nature MegaKit Standard (CC0) glTF root. */
const PACK_ROOT = '/third-party/quaternius-stylized-nature/glTF/';

/** Deterministic pseudo-random in [0,1) from integer seed. */
function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function makeTrunkMat(scene: Scene, name: string, tint: Color3): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = tint;
  m.specularColor = new Color3(0.04, 0.03, 0.02);
  m.emissiveColor = tint.scale(0.05);
  return m;
}

function makeFoliageMat(scene: Scene, name: string, tint: Color3): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = tint;
  m.specularColor = new Color3(0.02, 0.04, 0.02);
  // Matte — do not fight cyan fog with emissive leaves.
  m.emissiveColor = tint.scale(0.04);
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
 * Used by procedural fallback if Quaternius glTF fails to load.
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

/**
 * Fog / sky lock (#270 E3.1). Sun/hemi stay on the #39 values (E3.8 may lift).
 *
 * | Param        | #39                         | #270                                      |
 * | fog mode     | EXP2 dens 0.015             | LINEAR start 16 / end 200 (#272 scale)    |
 * | fog color    | (0.34, 0.55, 0.7)           | unchanged                                 |
 * | clearColor   | (0.24, 0.36, 0.46)          | matches fogColor (was a horizon halo)     |
 * | sky          | 420-dome, fog on, 64px tex  | fog off, horizon = fogColor, 256px clamp  |
 *
 * EXP2 + a fogged low-tess sky painted latitude bands and a color fight vs the
 * dome. LINEAR + an unfogged fog-matched dome is the hordes dusk-volume read
 * without the 8-bit halo. Density unused in LINEAR.
 */
const FOG_COLOR = new Color3(0.34, 0.55, 0.7);
const FOG_START = 16;
/** #272: 120 m pad is gone — fog must reach the larger forest, not clip at 95. */
const FOG_END = 200;
/** Grass plane extent (m). 120 was the toy disc. */
const GROUND_EXTENT = 480;

function fogCss(c: Color3): string {
  return `rgb(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})`;
}

/**
 * Distant mountain silhouettes (#273): farther / taller layered ranges.
 * LINEAR fogEnd 200 would flatten anything past the forest into a cardboard
 * wall, so ridges use applyFog=false and baked dusk-blue value steps.
 * Procedural DIY — no packs.
 */
function buildMountainBackdrop(scene: Scene): void {
  const silMat = (name: string, glow: Color3): StandardMaterial => {
    const m = new StandardMaterial(name, scene);
    m.diffuseColor = Color3.Black();
    m.specularColor = Color3.Black();
    m.emissiveColor = glow;
    m.disableLighting = true;
    m.fogEnabled = false;
    return m;
  };

  // Darker near → paler far (atmospheric perspective into FOG_COLOR).
  const nearRock = silMat('mountainNearMat', new Color3(0.13, 0.19, 0.26));
  const midRock = silMat('mountainMidMat', new Color3(0.21, 0.34, 0.46));
  const farRock = silMat('mountainFarMat', new Color3(0.30, 0.48, 0.62));
  const snowMid = silMat('snowMidMat', new Color3(0.48, 0.58, 0.68));
  const snowFar = silMat('snowFarMat', new Color3(0.38, 0.51, 0.64));

  type Layer = 'near' | 'mid' | 'far';
  type Peak = {
    r: number;
    yaw: number;
    h: number;
    w: number;
    layer: Layer;
    snow?: boolean;
  };

  const xz = (r: number, yaw: number): { x: number; z: number } => ({
    x: r * Math.sin(yaw),
    z: -r * Math.cos(yaw),
  });

  const dress = (mesh: Mesh, mat: StandardMaterial, yaw: number, sx: number, sz: number): void => {
    mesh.rotation.y = yaw;
    mesh.scaling.x = sx;
    mesh.scaling.z = sz;
    mesh.isPickable = false;
    mesh.applyFog = false;
    mesh.material = mat;
  };

  const sxFor = (layer: Layer): number =>
    layer === 'far' ? 2.4 : layer === 'mid' ? 2.05 : 1.7;

  const placePeak = (name: string, p: Peak, rock: StandardMaterial, snow: StandardMaterial | null, idx: number): void => {
    const { x, z } = xz(p.r, p.yaw);
    const tess = 7;
    const sx = sxFor(p.layer);
    const mtn = MeshBuilder.CreateCylinder(
      name,
      { height: p.h, diameterTop: p.w * 0.1, diameterBottom: p.w, tessellation: tess },
      scene,
    );
    mtn.position.set(x, p.h * 0.34, z);
    dress(mtn, rock, p.yaw, sx, 0.72);

    const side = idx % 2 === 0 ? 1 : -1;
    const sh = xz(p.r + 12, p.yaw + side * 0.07);
    const shoulder = MeshBuilder.CreateCylinder(
      `${name}_s`,
      {
        height: p.h * 0.55,
        diameterTop: p.w * 0.12,
        diameterBottom: p.w * 0.7,
        tessellation: tess,
      },
      scene,
    );
    shoulder.position.set(sh.x, p.h * 0.24, sh.z);
    dress(shoulder, rock, p.yaw + side * 0.35, sx * 0.85, 0.78);

    if (snow) {
      const cap = MeshBuilder.CreateCylinder(
        `${name}_snow`,
        {
          height: p.h * 0.1,
          diameterTop: p.w * 0.04,
          diameterBottom: p.w * 0.18,
          tessellation: tess,
        },
        scene,
      );
      cap.position.set(x, p.h * 0.72, z);
      dress(cap, snow, p.yaw, sx, 0.72);
    }
  };

  // Far range ~750–900 m, mid ~480–560 m, near foothills past the 175 m tree ring.
  const farPeaks: Peak[] = [
    { r: 820, yaw: -0.92, h: 300, w: 180, layer: 'far' },
    { r: 870, yaw: -0.62, h: 380, w: 220, layer: 'far', snow: true },
    { r: 900, yaw: -0.32, h: 440, w: 250, layer: 'far', snow: true },
    { r: 880, yaw: -0.02, h: 460, w: 260, layer: 'far', snow: true },
    { r: 850, yaw: 0.3, h: 400, w: 230, layer: 'far', snow: true },
    { r: 800, yaw: 0.58, h: 340, w: 200, layer: 'far', snow: true },
    { r: 760, yaw: 0.88, h: 280, w: 170, layer: 'far' },
  ];
  const midPeaks: Peak[] = [
    { r: 500, yaw: -0.85, h: 170, w: 140, layer: 'mid' },
    { r: 540, yaw: -0.52, h: 210, w: 160, layer: 'mid', snow: true },
    { r: 560, yaw: -0.18, h: 240, w: 175, layer: 'mid', snow: true },
    { r: 545, yaw: 0.18, h: 220, w: 165, layer: 'mid', snow: true },
    { r: 510, yaw: 0.5, h: 185, w: 150, layer: 'mid' },
    { r: 485, yaw: 0.82, h: 155, w: 130, layer: 'mid' },
  ];
  const nearPeaks: Peak[] = [
    { r: 345, yaw: -0.8, h: 48, w: 95, layer: 'near' },
    { r: 360, yaw: -0.48, h: 58, w: 105, layer: 'near' },
    { r: 375, yaw: -0.14, h: 64, w: 115, layer: 'near' },
    { r: 365, yaw: 0.22, h: 60, w: 110, layer: 'near' },
    { r: 350, yaw: 0.54, h: 52, w: 100, layer: 'near' },
    { r: 335, yaw: 0.86, h: 46, w: 90, layer: 'near' },
  ];

  const allPeaks = [...farPeaks, ...midPeaks, ...nearPeaks];
  for (let i = 0; i < allPeaks.length; i++) {
    const p = allPeaks[i]!;
    const rock = p.layer === 'near' ? nearRock : p.layer === 'mid' ? midRock : farRock;
    const snow = !p.snow ? null : p.layer === 'far' ? snowFar : snowMid;
    placePeak(`mountain_${p.layer}_${i}`, p, rock, snow, i);
  }

  const placeRidge = (
    prefix: string,
    radius: number,
    count: number,
    hBase: number,
    hVar: number,
    wBase: number,
    mat: StandardMaterial,
    yaw0: number,
    yaw1: number,
  ): void => {
    for (let i = 0; i < count; i++) {
      const yaw = yaw0 + ((i + 0.5) / count) * (yaw1 - yaw0);
      const r = radius + hash01(i + radius) * 22 - 11;
      const h = hBase + hash01(i * 3 + radius) * hVar;
      const { x, z } = xz(r, yaw);
      const ridge = MeshBuilder.CreateCylinder(
        `${prefix}_${i}`,
        {
          height: h,
          diameterTop: wBase * 0.18,
          diameterBottom: wBase,
          tessellation: 7,
        },
        scene,
      );
      ridge.position.set(x, h * 0.28, z);
      dress(ridge, mat, yaw, 2.0, 0.7);
    }
  };

  placeRidge('foothill', 310, 9, 28, 18, 80, nearRock, -0.95, 0.95);
  placeRidge('midridge', 470, 8, 88, 36, 110, midRock, -0.9, 0.9);
  placeRidge('farridge', 720, 8, 130, 50, 160, farRock, -0.95, 0.95);
}

/**
 * Painterly sky dome (#55 / #270): vertical gradient into FOG_COLOR so the
 * horizon has no seam vs LINEAR fog. Fog disabled on the mesh — a fogged
 * 20-seg sphere is what painted the banding/halos. Procedural DIY, no packs.
 */
function buildSkyDome(scene: Scene): void {
  const sky = MeshBuilder.CreateSphere('skyDome', { diameter: 2000, segments: 32 }, scene);
  sky.infiniteDistance = true;
  sky.isPickable = false;
  sky.applyFog = false;

  // V-up gradient: zenith (top) → fog-matched horizon (equator and below).
  // Sphere UVs: v~0 at +Y. DynamicTexture invertY default maps canvas-top → v=0.
  const size = 256;
  const tex = new DynamicTexture('skyGradTex', { width: 32, height: size }, scene, false);
  tex.wrapU = Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  const ctx = tex.getContext();
  const grad = ctx.createLinearGradient(0, 0, 0, size);
  const fog = fogCss(FOG_COLOR);
  // Slightly lighter zenith; wide lower band is exact fogColor (no halo).
  grad.addColorStop(0.0, 'rgb(112, 152, 192)');
  grad.addColorStop(0.22, 'rgb(100, 146, 186)');
  grad.addColorStop(0.48, fog);
  grad.addColorStop(1.0, fog);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 32, size);
  tex.hasAlpha = false;
  tex.update();

  const skyMat = new StandardMaterial('skyMat', scene);
  skyMat.backFaceCulling = false;
  skyMat.disableLighting = true;
  skyMat.fogEnabled = false;
  skyMat.diffuseColor = new Color3(0, 0, 0);
  skyMat.specularColor = new Color3(0, 0, 0);
  skyMat.emissiveColor = new Color3(1, 1, 1);
  skyMat.emissiveTexture = tex;
  sky.material = skyMat;
}

/** Matte foliage/bark — keep specular low; kill emissive so cyan fog wins. */
function mattePackMaterials(meshes: AbstractMesh[]): void {
  const seen = new Set<Material>();
  for (const mesh of meshes) {
    const mat = mesh.material;
    if (!mat || seen.has(mat)) continue;
    seen.add(mat);
    const leafish = /leaf|leaves|grass|fern|bush|plant/i.test(mat.name || mesh.name || '');
    if (mat instanceof PBRMaterial) {
      mat.metallic = 0;
      mat.roughness = 0.92;
      mat.emissiveColor = new Color3(0, 0, 0);
      mat.environmentIntensity = 0.3;
      mat.specularIntensity = 0.12;
      if (leafish) {
        // Bias toward lush green under cyan fog (pack _C leaf cards can read warm/red).
        mat.albedoColor = new Color3(0.55, 0.85, 0.42);
      }
    } else if (mat instanceof StandardMaterial) {
      mat.specularColor = new Color3(0.03, 0.03, 0.02);
      mat.emissiveColor = new Color3(0, 0, 0);
      if (leafish) {
        mat.diffuseColor = new Color3(0.45, 0.7, 0.32);
      }
    }
  }
}

function hideTemplate(root: TransformNode): void {
  root.setEnabled(false);
  root.getChildMeshes(true).forEach((m) => {
    m.isVisible = false;
    m.isPickable = false;
    m.checkCollisions = false;
  });
}

async function loadPackRoot(
  scene: Scene,
  fileName: string,
  templateName: string,
): Promise<TransformNode | null> {
  try {
    const result = await ImportMeshAsync(fileName, scene, { rootUrl: PACK_ROOT });
    const meshes = result.meshes.filter((m): m is Mesh => m instanceof Mesh);
    if (meshes.length === 0) return null;

    // Prefer an empty root / first mesh as hierarchy parent.
    let root: TransformNode = meshes[0]!;
    const named = meshes.find((m) => m.name === '__root__' || m.name === fileName.replace(/\.gltf$/i, ''));
    if (named) root = named;

    // If multiple top-level meshes, parent them under a transform for cloning.
    const topLevel = meshes.filter((m) => !m.parent);
    if (topLevel.length > 1) {
      const holder = new TransformNode(templateName, scene);
      for (const m of topLevel) {
        m.parent = holder;
      }
      root = holder;
    } else {
      root.name = templateName;
    }

    mattePackMaterials(result.meshes);
    // Freeze world matrix after we place clones; templates stay hidden at origin.
    root.position.set(0, -500, 0);
    hideTemplate(root);
    return root;
  } catch (err) {
    console.warn(`[forest] failed to load ${fileName}`, err);
    return null;
  }
}

function placeClone(
  template: TransformNode,
  name: string,
  x: number,
  z: number,
  scale: number,
  yaw: number,
): TransformNode {
  const clone = template.clone(name, null);
  if (!clone) {
    throw new Error(`Failed to clone ${name}`);
  }
  clone.setEnabled(true);
  clone.getChildMeshes(true).forEach((m) => {
    m.isVisible = true;
    m.isPickable = false;
  });
  clone.position.set(x, 0, z);
  clone.rotation.y = yaw;
  clone.scaling.setAll(scale);
  // Cull far understory / mid trees — Babylon frustum cull handles most; harden with distance.
  clone.getChildMeshes(true).forEach((m) => {
    if (m instanceof Mesh) {
      m.doNotSyncBoundingInfo = false;
      m.alwaysSelectAsActiveMesh = false;
    }
  });
  return clone;
}

async function placeQuaterniusForest(scene: Scene): Promise<boolean> {
  // Heroes: few unique large TwistedTree trunks/canopies.
  const heroFiles = ['TwistedTree_1.gltf', 'TwistedTree_2.gltf', 'TwistedTree_3.gltf'] as const;
  const heroTemplates: TransformNode[] = [];
  for (let i = 0; i < heroFiles.length; i++) {
    const t = await loadPackRoot(scene, heroFiles[i]!, `heroTemplate_${i}`);
    if (t) heroTemplates.push(t);
  }
  if (heroTemplates.length === 0) return false;

  // Mid: 2–4 variants for ring (classic / tall / stubby).
  const midFiles = ['CommonTree_1.gltf', 'CommonTree_3.gltf', 'CommonTree_5.gltf'] as const;
  const midTemplates: TransformNode[] = [];
  for (let i = 0; i < midFiles.length; i++) {
    const t = await loadPackRoot(scene, midFiles[i]!, `midTemplate_${i}`);
    if (t) midTemplates.push(t);
  }
  if (midTemplates.length === 0) return false;

  // #272: Quaternius author-scale is toy-yard; WoW/hordes read is player-tiny vs trunks.
  // Heroes sit on the clearing rim so play-cam is not inside a canopy.
  const heroSpots: Array<{ name: string; x: number; z: number; scale: number; yaw: number; ti: number }> = [
    { name: 'heroTreeN', x: 6, z: -40, scale: 6.8, yaw: 0.18, ti: 1 },
    { name: 'heroTreeNE', x: 34, z: -28, scale: 5.8, yaw: 0.45, ti: 0 },
    { name: 'heroTreeNW', x: -36, z: -24, scale: 6.2, yaw: -0.55, ti: 1 },
    { name: 'heroTreeSW', x: -32, z: 34, scale: 5.4, yaw: 2.15, ti: 0 },
    { name: 'heroTreeSE', x: 30, z: 38, scale: 5.0, yaw: 1.05, ti: 2 },
    { name: 'heroTreeW', x: -28, z: 6, scale: 4.8, yaw: -1.2, ti: 0 },
  ];
  for (const h of heroSpots) {
    const tmpl = heroTemplates[h.ti % heroTemplates.length]!;
    placeClone(tmpl, h.name, h.x, h.z, h.scale, h.yaw);
  }

  const ringCount = 36;
  const innerR = 48;
  const outerR = 110;
  for (let i = 0; i < ringCount; i++) {
    const a = (i / ringCount) * Math.PI * 2 + hash01(i * 3) * 0.35;
    const r = innerR + hash01(i * 7) * (outerR - innerR);
    // Keep south-east approach / path readable.
    if (a > 0.15 && a < 0.55 && r < 62) continue;
    const tmpl = midTemplates[i % midTemplates.length]!;
    const s = 2.4 + hash01(i * 11) * 1.6;
    // Variant personality: classic / taller / stubbier via Y scale.
    const yMul = i % 3 === 1 ? 1.28 : i % 3 === 2 ? 0.82 : 1.0;
    const clone = placeClone(
      tmpl,
      `midTree_${i}`,
      Math.cos(a) * r,
      Math.sin(a) * r,
      s,
      hash01(i * 17) * Math.PI * 2,
    );
    clone.scaling.y *= yMul;
  }

  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2 + 0.4;
    const r = 135 + hash01(i * 19) * 40;
    const tmpl = midTemplates[i % midTemplates.length]!;
    const s = 2.0 + hash01(i * 23) * 1.4;
    placeClone(
      tmpl,
      `farTree_${i}`,
      Math.cos(a) * r,
      Math.sin(a) * r,
      s,
      hash01(i * 29) * Math.PI * 2,
    );
  }

  // Understory: grass / fern / rock / bush clusters (budget-friendly counts).
  const underFiles = [
    'Grass_Common_Tall.gltf',
    'Grass_Wispy_Short.gltf',
    'Fern_1.gltf',
    'Bush_Common.gltf',
    'Rock_Medium_1.gltf',
    'Rock_Medium_2.gltf',
  ] as const;
  const underTemplates: TransformNode[] = [];
  for (let i = 0; i < underFiles.length; i++) {
    const t = await loadPackRoot(scene, underFiles[i]!, `underTemplate_${i}`);
    if (t) underTemplates.push(t);
  }

  let underPlaced = 0;
  for (let i = 0; i < 28 && underTemplates.length > 0; i++) {
    const a = hash01(i * 41) * Math.PI * 2;
    const r = 14 + hash01(i * 43) * 90;
    if (r < 12) continue;
    if (a > 0.15 && a < 0.55 && r < 28) continue; // path/clearing readable
    const tmpl = underTemplates[i % underTemplates.length]!;
    const isRock = tmpl.name.includes('Rock') || (i % underTemplates.length) >= 4;
    const s = isRock ? 1.2 + hash01(i * 47) * 1.6 : 1.4 + hash01(i * 47) * 2.2;
    placeClone(
      tmpl,
      `under_${i}`,
      Math.cos(a) * r,
      Math.sin(a) * r,
      s,
      hash01(i * 53) * Math.PI * 2,
    );
    underPlaced++;
  }
  void underPlaced;

  return true;
}

function placeProceduralForest(scene: Scene): void {
  // Post-#40 density fallback: landmark/sentinel heroes + ThinInstance mid variety + far LOD + understory.
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

  const trunkMatA = makeTrunkMat(scene, 'trunkMatA', new Color3(0.32, 0.28, 0.24));
  const trunkMatB = makeTrunkMat(scene, 'trunkMatB', new Color3(0.26, 0.22, 0.18));
  const foliageA = makeFoliageMat(scene, 'foliageA', new Color3(0.12, 0.3, 0.14));
  const foliageB = makeFoliageMat(scene, 'foliageB', new Color3(0.09, 0.24, 0.12));
  const foliageC = makeFoliageMat(scene, 'foliageC', new Color3(0.16, 0.34, 0.16));
  const underMat = makeUnderstoryMat(scene, 'understoryMat', new Color3(0.2, 0.42, 0.16));

  placeHeroTree(scene, 'heroElderN', 6, -40, 3.4, 0.18, trunkMatA, foliageB, 'landmark');
  placeHeroTree(scene, 'heroElderSW', -32, 34, 3.0, 2.15, trunkMatB, foliageA, 'landmark');
  placeHeroTree(scene, 'heroSentNE', 34, -28, 2.7, 0.45, trunkMatA, foliageA, 'sentinel');
  placeHeroTree(scene, 'heroSentNW', -36, -24, 2.8, -0.55, trunkMatB, foliageB, 'sentinel');
  placeHeroTree(scene, 'heroSentSE', 30, 38, 2.4, 1.05, trunkMatA, foliageC, 'standard');
  placeHeroTree(scene, 'heroSentW', -28, 6, 2.5, -1.2, trunkMatB, foliageC, 'sentinel');

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

  const innerCount = 68;
  const innerR0 = 58;
  const innerR1 = 95;
  for (let i = 0; i < innerCount; i++) {
    const a = (i / innerCount) * Math.PI * 2 + hash01(i * 3) * 0.28;
    const r = innerR0 + hash01(i * 7) * (innerR1 - innerR0);
    if (a > 0.12 && a < 0.52 && r < 72) continue;
    const s = 1.6 + hash01(i * 11) * 1.4;
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
    const r = 100 + hash01(i * 9) * 28;
    const s = 1.5 + hash01(i * 15) * 1.1;
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

  const farCount = 48;
  for (let i = 0; i < farCount; i++) {
    const a = (i / farCount) * Math.PI * 2 + hash01(i * 19) * 0.15;
    const r = 135 + hash01(i * 23) * 40;
    const s = 1.6 + hash01(i * 29) * 1.2;
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

  const underCount = 64;
  for (let i = 0; i < underCount; i++) {
    const a = (i / underCount) * Math.PI * 2 + hash01(i * 43) * 0.4;
    const band = hash01(i * 47);
    const r =
      band < 0.35
        ? 14 + hash01(i * 53) * 16
        : 32 + hash01(i * 53) * 40;
    if (r < 14 && a > 0.15 && a < 0.55) continue;
    const s = 1.1 + hash01(i * 59) * 1.4;
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
}


/**
 * Procedural clearing path (#44): warm grey-brown dirt/stone + soft moss/dirt
 * edge + trail strip + cheap stone flecks. Readable vs lush grass under cyan
 * fog without fighting #39 lighting lock. FPS-friendly (few discs/boxes).
 */
function buildClearingPath(scene: Scene): void {
  // Soft moss/dirt blend ring — subtle edge vs lush grass (not a hard dark rim).
  const edge = MeshBuilder.CreateDisc('pathEdge', { radius: 9.6, tessellation: 28 }, scene);
  edge.rotation.x = Math.PI / 2;
  edge.position.y = 0.022;
  const edgeMat = new StandardMaterial('pathEdgeMat', scene);
  edgeMat.diffuseColor = new Color3(0.34, 0.32, 0.18);
  edgeMat.specularColor = new Color3(0.012, 0.014, 0.01);
  edgeMat.emissiveColor = new Color3(0.02, 0.022, 0.012);
  edge.material = edgeMat;

  // Main packed path — Art #44 warm grey-brown (not chalky cool / not neon).
  const dirt = MeshBuilder.CreateDisc('dirtPatch', { radius: 8.4, tessellation: 28 }, scene);
  dirt.rotation.x = Math.PI / 2;
  dirt.position.y = 0.03;
  const dirtMat = new StandardMaterial('dirtMat', scene);
  dirtMat.diffuseColor = new Color3(0.48, 0.36, 0.26);
  dirtMat.specularColor = new Color3(0.02, 0.016, 0.012);
  dirtMat.emissiveColor = new Color3(0.022, 0.016, 0.01);
  dirt.material = dirtMat;

  // Inner worn center — slightly richer warm tone for multi-tone read at play cam.
  const worn = MeshBuilder.CreateDisc('pathWorn', { radius: 4.2, tessellation: 22 }, scene);
  worn.rotation.x = Math.PI / 2;
  worn.position.y = 0.036;
  const wornMat = new StandardMaterial('pathWornMat', scene);
  wornMat.diffuseColor = new Color3(0.5, 0.38, 0.28);
  wornMat.specularColor = new Color3(0.022, 0.018, 0.014);
  wornMat.emissiveColor = new Color3(0.024, 0.018, 0.012);
  worn.material = wornMat;

  // Elongated trail strip toward the mid-tree gap (SE) — readable from play cam.
  const trail = MeshBuilder.CreateGround(
    'pathTrail',
    { width: 3.4, height: 18, subdivisions: 1 },
    scene,
  );
  trail.position.set(5.5, 0.034, 6.5);
  trail.rotation.y = -0.55;
  const trailMat = new StandardMaterial('pathTrailMat', scene);
  trailMat.diffuseColor = new Color3(0.46, 0.34, 0.24);
  trailMat.specularColor = new Color3(0.018, 0.014, 0.01);
  trailMat.emissiveColor = new Color3(0.02, 0.014, 0.01);
  trail.material = trailMat;

  // Faint moss patches near path — soft grass→dirt value variation (no terrain system).
  const mossPatchMat = new StandardMaterial('pathMossPatchMat', scene);
  mossPatchMat.diffuseColor = new Color3(0.24, 0.46, 0.17);
  mossPatchMat.specularColor = new Color3(0.01, 0.014, 0.008);
  mossPatchMat.emissiveColor = new Color3(0.028, 0.055, 0.018);
  const mossPatches: Array<{ x: number; z: number; r: number }> = [
    { x: -7.2, z: 3.4, r: 1.1 },
    { x: 6.8, z: -5.5, r: 0.95 },
    { x: -4.5, z: -7.0, r: 1.05 },
    { x: 8.8, z: 2.2, r: 0.85 },
  ];
  for (let i = 0; i < mossPatches.length; i++) {
    const p = mossPatches[i]!;
    const m = MeshBuilder.CreateDisc(`pathMossPatch_${i}`, { radius: p.r, tessellation: 12 }, scene);
    m.rotation.x = Math.PI / 2;
    m.position.set(p.x, 0.018, p.z);
    m.material = mossPatchMat;
  }

  // Cobble-ish worn patches along trail (cheap discs, shared mat) — warm stone.
  const cobbleMat = new StandardMaterial('pathCobbleMat', scene);
  cobbleMat.diffuseColor = new Color3(0.46, 0.4, 0.32);
  cobbleMat.specularColor = new Color3(0.03, 0.026, 0.022);
  cobbleMat.emissiveColor = new Color3(0.02, 0.016, 0.012);
  const cobbleSpots: Array<{ x: number; z: number; r: number }> = [
    { x: 0.8, z: 1.2, r: 0.55 },
    { x: -1.4, z: -0.6, r: 0.42 },
    { x: 2.2, z: -2.1, r: 0.48 },
    { x: -2.6, z: 2.4, r: 0.38 },
    { x: 4.6, z: 4.0, r: 0.5 },
    { x: 6.8, z: 7.2, r: 0.44 },
    { x: 8.4, z: 9.6, r: 0.4 },
    { x: 3.1, z: 5.5, r: 0.36 },
  ];
  for (let i = 0; i < cobbleSpots.length; i++) {
    const s = cobbleSpots[i]!;
    const c = MeshBuilder.CreateDisc(`pathCobble_${i}`, { radius: s.r, tessellation: 10 }, scene);
    c.rotation.x = Math.PI / 2;
    c.position.set(s.x, 0.04, s.z);
    c.material = cobbleMat;
  }

  // Tiny stone flecks — shared mat, few instances, web-cheap, warm grey.
  const stoneMat = new StandardMaterial('pathStoneMat', scene);
  stoneMat.diffuseColor = new Color3(0.5, 0.44, 0.36);
  stoneMat.specularColor = new Color3(0.035, 0.03, 0.026);
  stoneMat.emissiveColor = new Color3(0.02, 0.017, 0.014);
  const stoneProto = MeshBuilder.CreateBox(
    'pathStoneProto',
    { width: 0.28, height: 0.06, depth: 0.22 },
    scene,
  );
  stoneProto.position.set(0, -200, 0);
  stoneProto.isVisible = false;
  stoneProto.setEnabled(false);
  stoneProto.material = stoneMat;
  for (let i = 0; i < 16; i++) {
    const inst = stoneProto.createInstance(`pathStone_${i}`);
    const a = hash01(i * 41) * Math.PI * 2;
    const r = 1.2 + hash01(i * 47) * 6.5;
    inst.position.set(Math.cos(a) * r, 0.045, Math.sin(a) * r);
    inst.rotation.y = hash01(i * 53) * Math.PI;
    const s = 0.55 + hash01(i * 59) * 0.9;
    inst.scaling.set(s, 0.7 + hash01(i * 61) * 0.5, s * (0.7 + hash01(i * 67) * 0.5));
    inst.setEnabled(true);
  }
}

/**
 * Forest clearing: Quaternius Standard heroes + mid + understory (CC0),
 * procedural mountain silhouettes (#273), #39 sun/hemi + #270 LINEAR fog/sky lock.
 * Path/ground polish #44 via buildClearingPath; sky/horizon silhouette #55.
 * Procedural fallback uses post-#40 ThinInstance density + LOD.
 */
export async function buildForestClearing(scene: Scene): Promise<{
  ground: Mesh;
  hemi: HemisphericLight;
  sun: DirectionalLight;
}> {
  // Atmosphere: #39 sun/hemi kept. Fog/sky is the #270 lock (see FOG_COLOR).
  // Mood > volumetric soup — StandardMaterial + LINEAR fog (web-cheap).
  scene.clearColor = new Color4(FOG_COLOR.r, FOG_COLOR.g, FOG_COLOR.b, 1);
  scene.fogMode = Scene.FOGMODE_LINEAR;
  scene.fogStart = FOG_START;
  scene.fogEnd = FOG_END;
  scene.fogColor = FOG_COLOR.clone();

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
    { width: GROUND_EXTENT, height: GROUND_EXTENT, subdivisions: 40 },
    scene,
  );
  const groundMat = new StandardMaterial('clearingMat', scene);
  // Richer saturated grass albedo vs cyan fog (#44 keeps this lush).
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

  // #44 path/ground polish — readable trail vs lush grass under locked #39 fog/sun.
  // Art warm grey-brown multi-tone dirt (not chalky) + cheap procedural detail.
  buildClearingPath(scene);

  const packed = await placeQuaterniusForest(scene);
  if (!packed) {
    console.warn('[forest] Quaternius pack unavailable — procedural fallback (post-#40 density)');
    placeProceduralForest(scene);
  }

  // Hybrid: mountains stay procedural (pack mountains optional / heavy).
  buildMountainBackdrop(scene);
  buildSkyDome(scene);

  return { ground, hemi, sun };
}
