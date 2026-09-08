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

/**
 * Ground-plane disc. CreateDisc is XY; after rotation.x = π/2, world-Z squash
 * is scaling.y (local Z is the disc normal). scaling.z is a no-op (#299).
 */
function placeGroundDisc(
  scene: Scene,
  name: string,
  x: number,
  z: number,
  y: number,
  radius: number,
  tessellation: number,
  sx: number,
  sz: number,
  material: StandardMaterial,
): Mesh {
  const d = MeshBuilder.CreateDisc(name, { radius, tessellation }, scene);
  d.rotation.x = Math.PI / 2;
  d.position.set(x, y, z);
  d.scaling.x = sx;
  d.scaling.y = sz;
  d.material = material;
  return d;
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
 * Thin-instance a pack tree. Merge to one mesh so the glTF source at origin
 * does not also draw in the clearing (SetBuffer still renders the parented
 * child bind-pose at 0,0).
 */
function thinInstancePackRoot(root: TransformNode, matrices: Matrix[]): void {
  if (matrices.length === 0) {
    hideTemplate(root);
    return;
  }
  root.setEnabled(true);
  root.position.set(0, 0, 0);
  root.scaling.setAll(1);
  root.rotation.setAll(0);
  const sources: Mesh[] = [];
  const consider = (m: AbstractMesh): void => {
    if (m instanceof Mesh && m.getTotalVertices() > 0) sources.push(m);
  };
  if (root instanceof Mesh) consider(root);
  for (const m of root.getChildMeshes(true)) consider(m);
  if (sources.length === 0) {
    hideTemplate(root);
    return;
  }
  for (const s of sources) s.computeWorldMatrix(true);
  const merged = Mesh.MergeMeshes(sources, false, true, undefined, false, true);
  hideTemplate(root);
  if (merged) {
    merged.name = `${root.name}_inst`;
    merged.isPickable = false;
    merged.applyFog = true;
    merged.position.set(0, 0, 0);
    merged.setEnabled(true);
    merged.isVisible = true;
    thinInstanceFromMatrices(merged, matrices);
    return;
  }
  for (const m of sources) {
    m.setEnabled(true);
    m.isVisible = true;
    m.isPickable = false;
    m.applyFog = true;
    thinInstanceFromMatrices(m, matrices);
  }
}

/**
 * Fog / sky (#270) + lighting (#277, lifts #39). Stylized dusk forest, not photoreal.
 *
 * | Param        | #39                         | now                                       |
 * | fog mode     | EXP2 dens 0.015             | LINEAR start 16 / end 200 (#272)          |
 * | fog color    | (0.34, 0.55, 0.7)           | unchanged                                 |
 * | clearColor   | (0.24, 0.36, 0.46)          | matches fogColor                          |
 * | hemi         | 0.78 cool (0.68,0.78,0.86)  | 0.88 cooler canopy fill (#277)            |
 * | sun          | 0.98 warm (1.0,0.82,0.52)   | 0.48 cool-dusk key (#277)                 |
 */
const FOG_COLOR = new Color3(0.34, 0.55, 0.7);
const FOG_START = 16;
/** #272: 120 m pad is gone — fog must reach the larger forest, not clip at 95. */
const FOG_END = 200;
/** Grass plane extent (m). 120 was the toy disc. */
const GROUND_EXTENT = 480;

/** Dummy / vendor XZ — keep these reachable (matches Combat/Vendor spawn). */
const YARD_DUMMY_X = 5;
const YARD_DUMMY_Z = 0;
const YARD_VENDOR_X = -2.5;
const YARD_VENDOR_Z = 2;

/** Dirt-disc top. Dummy post / vendor feet plant here — not grass y=0 (#347). */
export const DIRT_SURFACE_Y = 0.036;

/** North landmark hero — `?ve=collision` walks into this bole. */
export const COLLISION_VE_HERO = { x: 6, z: -40 } as const;

/**
 * Receding path polyline (#342): pad → west of the north hero bole → bend →
 * a second clearing silhouette in fog. Not a second zone / biome.
 * Polar `a ∈ (0.15, 0.55)` was the old SE strip and hid this from `?ve=place-wow`.
 */
const PATH_POINTS: ReadonlyArray<{ x: number; z: number }> = [
  { x: 0.4, z: 1.0 },
  { x: -3.5, z: -12 },
  { x: -10, z: -32 },
  { x: 2, z: -50 },
  { x: 12, z: -68 },
  { x: 16, z: -88 },
];
const SECOND_CLEARING = { x: 12, z: -68 } as const;
const PATH_TREE_KEEP = 7.5;
const PATH_UNDER_KEEP = 5.5;
const SECOND_CLEARING_R = 11;

function distPointToSeg(
  x: number,
  z: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-8) return Math.hypot(x - ax, z - az);
  let t = ((x - ax) * dx + (z - az) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (ax + t * dx), z - (az + t * dz));
}

function distToPath(x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < PATH_POINTS.length - 1; i++) {
    const a = PATH_POINTS[i]!;
    const b = PATH_POINTS[i + 1]!;
    const d = distPointToSeg(x, z, a.x, a.z, b.x, b.z);
    if (d < best) best = d;
  }
  return best;
}

function inSecondClearing(x: number, z: number, extra = 0): boolean {
  return Math.hypot(x - SECOND_CLEARING.x, z - SECOND_CLEARING.z) < SECOND_CLEARING_R + extra;
}

function pathBlocksTree(x: number, z: number): boolean {
  return inSecondClearing(x, z, 1) || distToPath(x, z) < PATH_TREE_KEEP;
}

function pathBlocksUnderstory(x: number, z: number): boolean {
  return inSecondClearing(x, z, 2) || distToPath(x, z) < PATH_UNDER_KEEP;
}

export type TrunkCapsule = {
  x: number;
  z: number;
  radius: number;
  kind: 'hero' | 'mid';
};

/** Player XZ radius vs bole capsules. Intent slide only — not client positions. */
export const PLAYER_TRUNK_RADIUS = 0.42;

const trunkCapsules: TrunkCapsule[] = [];

export function getTrunkCapsules(): readonly TrunkCapsule[] {
  return trunkCapsules;
}

export function nearestTrunk(
  px: number,
  pz: number,
  kind?: TrunkCapsule['kind'],
): TrunkCapsule | null {
  let best: TrunkCapsule | null = null;
  let bestD = Infinity;
  for (const c of trunkCapsules) {
    if (kind && c.kind !== kind) continue;
    const d = (c.x - px) * (c.x - px) + (c.z - pz) * (c.z - pz);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

function yardPropBlocked(x: number, z: number, radius: number): boolean {
  const pad = PLAYER_TRUNK_RADIUS + 3.2;
  const dummyR = radius + pad;
  const dxD = x - YARD_DUMMY_X;
  const dzD = z - YARD_DUMMY_Z;
  if (dxD * dxD + dzD * dzD < dummyR * dummyR) return true;
  const vendorR = radius + pad + 1.2;
  const dxV = x - YARD_VENDOR_X;
  const dzV = z - YARD_VENDOR_Z;
  return dxV * dxV + dzV * dzV < vendorR * vendorR;
}

function registerTrunk(x: number, z: number, radius: number, kind: TrunkCapsule['kind']): void {
  if (!(radius > 0) || !Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius)) {
    return;
  }
  if (yardPropBlocked(x, z, radius)) return;
  trunkCapsules.push({ x, z, radius, kind });
}

/**
 * Pack bark radius at chest height (p90 of y∈[0,1.2] verts) × instance XZ scale.
 * Do not use the full bark AABB — branches inflate it, then a 3.4 clamp sinks
 * the player into the visual bole.
 */
function boleRadiusWorld(xzScale: number, kind: TrunkCapsule['kind']): number {
  const author = kind === 'hero' ? 1.18 : 0.52;
  return Math.max(kind === 'hero' ? 1.6 : 0.55, author * xzScale);
}

/**
 * Slide an XZ wish against hero/mid bole capsules. Still an intent (dx/dz);
 * server Move is unchanged. Far trees / mountains are not solids.
 */
export function slideAgainstTrunks(
  px: number,
  pz: number,
  dx: number,
  dz: number,
  playerR = PLAYER_TRUNK_RADIUS,
): { dx: number; dz: number; blocked: boolean } {
  if (trunkCapsules.length === 0) return { dx, dz, blocked: false };
  const inLen = Math.hypot(dx, dz);
  let nx = px + dx;
  let nz = pz + dz;
  let blocked = false;
  for (let iter = 0; iter < 6; iter++) {
    let hit = false;
    for (const c of trunkCapsules) {
      const minD = c.radius + playerR;
      let ox = nx - c.x;
      let oz = nz - c.z;
      let d2 = ox * ox + oz * oz;
      if (d2 >= minD * minD) continue;
      hit = true;
      blocked = true;
      if (d2 < 1e-10) {
        ox = px - c.x;
        oz = pz - c.z;
        d2 = ox * ox + oz * oz;
        if (d2 < 1e-10) {
          ox = 1;
          oz = 0;
          d2 = 1;
        }
      }
      const d = Math.sqrt(d2);
      const k = minD / d;
      nx = c.x + ox * k;
      nz = c.z + oz * k;
    }
    if (!hit) break;
  }
  let odx = nx - px;
  let odz = nz - pz;
  if (inLen < 1e-8) return { dx: 0, dz: 0, blocked };
  const outLen = Math.hypot(odx, odz);
  if (outLen > inLen && outLen > 1e-8) {
    const s = inLen / outLen;
    odx *= s;
    odz *= s;
  }
  return { dx: odx, dz: odz, blocked };
}

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

/** Matte foliage/bark (#275). Alpha-test only on hero canopies — mid/far/under
 *  unique GLTF clones with ALPHATEST ate fillrate and made WASD feel late (#315). */
function mattePackMaterials(meshes: AbstractMesh[], alphaTestLeaves: boolean): void {
  const seen = new Set<Material>();
  for (const mesh of meshes) {
    mesh.applyFog = true;
    const mat = mesh.material;
    if (!mat || seen.has(mat)) continue;
    seen.add(mat);
    const leafish = /leaf|leaves|grass|fern|bush|plant/i.test(mat.name || mesh.name || '');
    if (mat instanceof PBRMaterial) {
      mat.metallic = 0;
      mat.roughness = 0.94;
      mat.emissiveColor = new Color3(0, 0, 0);
      mat.environmentIntensity = 0.22;
      mat.specularIntensity = 0.08;
      if (leafish) {
        mat.albedoColor = new Color3(0.55, 0.85, 0.42);
        if (alphaTestLeaves) {
          mat.useAlphaFromAlbedoTexture = true;
          mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
          mat.alphaCutOff = 0.42;
        } else {
          // Pack glTF ships MASK on CommonTree leaves; keep ALPHATEST on heroes only (#340).
          mat.transparencyMode = PBRMaterial.PBRMATERIAL_OPAQUE;
          mat.useAlphaFromAlbedoTexture = false;
        }
      }
    } else if (mat instanceof StandardMaterial) {
      mat.specularColor = new Color3(0.02, 0.02, 0.015);
      mat.emissiveColor = new Color3(0, 0, 0);
      mat.fogEnabled = true;
      if (leafish) {
        mat.diffuseColor = new Color3(0.45, 0.7, 0.32);
        if (alphaTestLeaves) {
          mat.useAlphaFromDiffuseTexture = true;
          mat.transparencyMode = Material.MATERIAL_ALPHATEST;
          mat.alphaCutOff = 0.42;
        } else {
          mat.transparencyMode = Material.MATERIAL_OPAQUE;
          mat.useAlphaFromDiffuseTexture = false;
        }
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
  alphaTestLeaves = false,
  forThinInstance = false,
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

    mattePackMaterials(result.meshes, alphaTestLeaves);
    if (forThinInstance) {
      // Instance source must sit at origin; parking at -500 culls every instance.
      root.position.set(0, 0, 0);
      root.setEnabled(true);
    } else {
      root.position.set(0, -500, 0);
      hideTemplate(root);
    }
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
    m.applyFog = true;
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
    const t = await loadPackRoot(scene, heroFiles[i]!, `heroTemplate_${i}`, true);
    if (t) heroTemplates.push(t);
  }
  if (heroTemplates.length === 0) return false;

  // Mid: 2–4 variants for ring (classic / tall / stubby). ThinInstances — not unique clones (#340).
  const midFiles = ['CommonTree_1.gltf', 'CommonTree_3.gltf', 'CommonTree_5.gltf'] as const;
  const midTemplates: TransformNode[] = [];
  for (let i = 0; i < midFiles.length; i++) {
    const t = await loadPackRoot(scene, midFiles[i]!, `midTemplate_${i}`, false, true);
    if (t) midTemplates.push(t);
  }
  if (midTemplates.length === 0) return false;

  // #272: Quaternius author-scale is toy-yard; WoW/hordes read is player-tiny vs trunks.
  // Heroes sit on the clearing rim so play-cam is not inside a canopy.
  const heroSpots: Array<{ name: string; x: number; z: number; scale: number; yaw: number; ti: number }> = [
    { name: 'heroTreeN', x: COLLISION_VE_HERO.x, z: COLLISION_VE_HERO.z, scale: 5.2, yaw: 0.18, ti: 1 },
    { name: 'heroTreeNE', x: 34, z: -28, scale: 4.6, yaw: 0.45, ti: 0 },
    { name: 'heroTreeNW', x: -36, z: -24, scale: 4.8, yaw: -0.55, ti: 1 },
    { name: 'heroTreeSW', x: -32, z: 34, scale: 4.4, yaw: 2.15, ti: 0 },
    { name: 'heroTreeSE', x: 30, z: 38, scale: 4.2, yaw: 1.05, ti: 2 },
  ];
  for (const h of heroSpots) {
    const tmpl = heroTemplates[h.ti % heroTemplates.length]!;
    placeClone(tmpl, h.name, h.x, h.z, h.scale, h.yaw);
    registerTrunk(h.x, h.z, boleRadiusWorld(h.scale, 'hero'), 'hero');
  }

  const midMats: Matrix[][] = midTemplates.map(() => []);
  const ringCount = 24;
  const innerR = 48;
  const outerR = 110;
  for (let i = 0; i < ringCount; i++) {
    const a = (i / ringCount) * Math.PI * 2 + hash01(i * 3) * 0.35;
    const r = innerR + hash01(i * 7) * (outerR - innerR);
    const mx = Math.cos(a) * r;
    const mz = Math.sin(a) * r;
    if (pathBlocksTree(mx, mz)) continue;
    const ti = i % midTemplates.length;
    const s = 2.4 + hash01(i * 11) * 1.6;
    const yMul = i % 3 === 1 ? 1.28 : i % 3 === 2 ? 0.82 : 1.0;
    midMats[ti]!.push(
      composeInstanceMatrix(
        mx,
        mz,
        s,
        s * yMul,
        s,
        hash01(i * 17) * Math.PI * 2,
      ),
    );
    // Named empty root so #351 camera collision still finds mid boles (no unique mesh).
    const mark = new TransformNode(`midTree_${i}`, scene);
    mark.position.set(mx, 0, mz);
    mark.scaling.setAll(s);
    registerTrunk(mx, mz, boleRadiusWorld(s, 'mid'), 'mid');
  }

  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + 0.4;
    const r = 135 + hash01(i * 19) * 40;
    const mx = Math.cos(a) * r;
    const mz = Math.sin(a) * r;
    if (pathBlocksTree(mx, mz)) continue;
    const ti = i % midTemplates.length;
    const s = 2.0 + hash01(i * 23) * 1.4;
    midMats[ti]!.push(
      composeInstanceMatrix(mx, mz, s, s, s, hash01(i * 29) * Math.PI * 2),
    );
  }
  // Second clearing ring — fogged tree silhouette, path mouth left open (#342).
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + 0.35;
    const rr = 13 + hash01(i * 91) * 4;
    const mx = SECOND_CLEARING.x + Math.cos(a) * rr;
    const mz = SECOND_CLEARING.z + Math.sin(a) * rr;
    if (distToPath(mx, mz) < 5.5) continue;
    const ti = i % midTemplates.length;
    const s = 2.2 + hash01(i * 93) * 1.2;
    const yMul = i % 3 === 1 ? 1.22 : 1.0;
    midMats[ti]!.push(
      composeInstanceMatrix(
        mx,
        mz,
        s,
        s * yMul,
        s,
        hash01(i * 97) * Math.PI * 2,
      ),
    );
    const mark = new TransformNode(`midTree_clearing_${i}`, scene);
    mark.position.set(mx, 0, mz);
    mark.scaling.setAll(s);
    registerTrunk(mx, mz, boleRadiusWorld(s, 'mid'), 'mid');
  }
  for (let i = 0; i < midTemplates.length; i++) {
    thinInstancePackRoot(midTemplates[i]!, midMats[i]!);
  }

  // Understory: pack grass/fern/rock/bush as ThinInstances only (#345).
  // Unique GLTF clones (even 24) still cost MASK/draw. Opaque merge + instances.
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
    const t = await loadPackRoot(scene, underFiles[i]!, `underTemplate_${i}`, false, true);
    if (t) underTemplates.push(t);
  }
  const underMats: Matrix[][] = underTemplates.map(() => []);
  const underCount = 36;
  for (let i = 0; i < underCount && underTemplates.length > 0; i++) {
    const a = hash01(i * 41) * Math.PI * 2;
    const r = 12 + hash01(i * 43) * 95;
    if (r < 11) continue;
    const ux = Math.cos(a) * r;
    const uz = Math.sin(a) * r;
    if (pathBlocksUnderstory(ux, uz)) continue;
    const plantish = i % 8 < 6;
    const ti = plantish ? i % 3 : 3 + (i % 3);
    const tmplI = ti % underTemplates.length;
    const tmpl = underTemplates[tmplI]!;
    const isRock = tmpl.name.includes('Rock') || tmplI >= 4;
    const s = isRock ? 1.2 + hash01(i * 47) * 1.6 : 1.5 + hash01(i * 47) * 2.4;
    underMats[tmplI]!.push(
      composeInstanceMatrix(
        ux,
        uz,
        s,
        s,
        s,
        hash01(i * 53) * Math.PI * 2,
      ),
    );
  }
  for (let i = 0; i < underTemplates.length; i++) {
    thinInstancePackRoot(underTemplates[i]!, underMats[i]!);
  }

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
    if (pathBlocksUnderstory(s.x, s.z)) continue;
    placeGroundDisc(scene, `limeMoss_${i}`, s.x, s.z, 0.025, s.r, 16, 1, 1, limeMat);
  }

  const trunkMatA = makeTrunkMat(scene, 'trunkMatA', new Color3(0.32, 0.28, 0.24));
  const trunkMatB = makeTrunkMat(scene, 'trunkMatB', new Color3(0.26, 0.22, 0.18));
  const foliageA = makeFoliageMat(scene, 'foliageA', new Color3(0.12, 0.3, 0.14));
  const foliageB = makeFoliageMat(scene, 'foliageB', new Color3(0.09, 0.24, 0.12));
  const foliageC = makeFoliageMat(scene, 'foliageC', new Color3(0.16, 0.34, 0.16));
  const underMat = makeUnderstoryMat(scene, 'understoryMat', new Color3(0.2, 0.42, 0.16));

  const registerProcHero = (
    x: number,
    z: number,
    scale: number,
    silhouette: 'landmark' | 'sentinel' | 'standard',
  ): void => {
    const tr = (silhouette === 'landmark' ? 1.7 : silhouette === 'sentinel' ? 1.25 : 1.05) * scale;
    registerTrunk(x, z, Math.min(3.4, Math.max(1.35, tr * 1.05)), 'hero');
  };
  placeHeroTree(scene, 'heroElderN', 6, -40, 3.4, 0.18, trunkMatA, foliageB, 'landmark');
  registerProcHero(6, -40, 3.4, 'landmark');
  placeHeroTree(scene, 'heroElderSW', -32, 34, 3.0, 2.15, trunkMatB, foliageA, 'landmark');
  registerProcHero(-32, 34, 3.0, 'landmark');
  placeHeroTree(scene, 'heroSentNE', 34, -28, 2.7, 0.45, trunkMatA, foliageA, 'sentinel');
  registerProcHero(34, -28, 2.7, 'sentinel');
  placeHeroTree(scene, 'heroSentNW', -36, -24, 2.8, -0.55, trunkMatB, foliageB, 'sentinel');
  registerProcHero(-36, -24, 2.8, 'sentinel');
  placeHeroTree(scene, 'heroSentSE', 30, 38, 2.4, 1.05, trunkMatA, foliageC, 'standard');
  registerProcHero(30, 38, 2.4, 'standard');
  placeHeroTree(scene, 'heroSentW', -28, 6, 2.5, -1.2, trunkMatB, foliageC, 'sentinel');
  registerProcHero(-28, 6, 2.5, 'sentinel');

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
    const mx = Math.cos(a) * r;
    const mz = Math.sin(a) * r;
    if (pathBlocksTree(mx, mz)) continue;
    const s = 1.6 + hash01(i * 11) * 1.4;
    const sy = s * (0.88 + hash01(i * 13) * 0.38);
    const m = composeInstanceMatrix(
      mx,
      mz,
      s,
      sy,
      s,
      hash01(i * 17) * Math.PI * 2,
    );
    const pick = hash01(i * 41);
    if (pick < 0.38) matsClassic.push(m);
    else if (pick < 0.72) matsTall.push(m);
    else matsStubby.push(m);
    const bole =
      pick < 0.38 ? 1.1 : pick < 0.72 ? 0.95 : 1.35;
    registerTrunk(
      mx,
      mz,
      Math.min(1.55, Math.max(0.55, (bole * 0.5) * s * 0.95)),
      'mid',
    );
  }

  const midCount = 40;
  for (let i = 0; i < midCount; i++) {
    const a = (i / midCount) * Math.PI * 2 + 0.22 + hash01(i * 5) * 0.2;
    const r = 100 + hash01(i * 9) * 28;
    const mx = Math.cos(a) * r;
    const mz = Math.sin(a) * r;
    if (pathBlocksTree(mx, mz)) continue;
    const s = 1.5 + hash01(i * 15) * 1.1;
    const m = composeInstanceMatrix(
      mx,
      mz,
      s,
      s * (0.95 + hash01(i * 21) * 0.25),
      s,
      hash01(i * 27) * Math.PI * 2,
    );
    const pick = hash01(i * 33);
    if (pick < 0.45) matsClassic.push(m);
    else if (pick < 0.78) matsTall.push(m);
    else matsStubby.push(m);
    const bole = pick < 0.45 ? 1.1 : pick < 0.78 ? 0.95 : 1.35;
    registerTrunk(
      mx,
      mz,
      Math.min(1.55, Math.max(0.55, (bole * 0.5) * s * 0.95)),
      'mid',
    );
  }

  const farCount = 48;
  for (let i = 0; i < farCount; i++) {
    const a = (i / farCount) * Math.PI * 2 + hash01(i * 19) * 0.15;
    const r = 135 + hash01(i * 23) * 40;
    const mx = Math.cos(a) * r;
    const mz = Math.sin(a) * r;
    if (pathBlocksTree(mx, mz)) continue;
    const s = 1.6 + hash01(i * 29) * 1.2;
    matsFar.push(
      composeInstanceMatrix(
        mx,
        mz,
        s,
        s * (1.05 + hash01(i * 31) * 0.35),
        s,
        hash01(i * 37) * Math.PI * 2,
      ),
    );
  }

  // #278 fallback: ThinInstance understory (shared mesh). Same 30 FPS floor.
  const underCount = 110;
  for (let i = 0; i < underCount; i++) {
    const a = (i / underCount) * Math.PI * 2 + hash01(i * 43) * 0.4;
    const band = hash01(i * 47);
    const r =
      band < 0.35
        ? 14 + hash01(i * 53) * 16
        : 32 + hash01(i * 53) * 40;
    const ux = Math.cos(a) * r;
    const uz = Math.sin(a) * r;
    if (pathBlocksUnderstory(ux, uz)) continue;
    const s = 1.1 + hash01(i * 59) * 1.4;
    matsUnder.push(
      composeInstanceMatrix(
        ux,
        uz,
        s * (0.8 + hash01(i * 61) * 0.5),
        s,
        s * (0.8 + hash01(i * 67) * 0.5),
        hash01(i * 71) * Math.PI * 2,
      ),
    );
  }

  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + 0.35;
    const rr = 13 + hash01(i * 91) * 4;
    const mx = SECOND_CLEARING.x + Math.cos(a) * rr;
    const mz = SECOND_CLEARING.z + Math.sin(a) * rr;
    if (distToPath(mx, mz) < 5.5) continue;
    const s = 1.8 + hash01(i * 93) * 1.0;
    const m = composeInstanceMatrix(
      mx,
      mz,
      s,
      s * (i % 3 === 1 ? 1.22 : 1.0),
      s,
      hash01(i * 97) * Math.PI * 2,
    );
    if (i % 3 === 0) matsClassic.push(m);
    else if (i % 3 === 1) matsTall.push(m);
    else matsStubby.push(m);
    registerTrunk(mx, mz, Math.min(1.55, Math.max(0.55, 0.52 * s)), 'mid');
  }

  thinInstanceFromMatrices(midClassic, matsClassic);
  thinInstanceFromMatrices(midTall, matsTall);
  thinInstanceFromMatrices(midStubby, matsStubby);
  thinInstanceFromMatrices(farLod, matsFar);
  thinInstanceFromMatrices(understory, matsUnder);
}

/**
 * #278: GPU-instanced fern/grass beside the path. Two merged clusters,
 * ThinInstances (not unique meshes). Floor: 30 fps (`fpsHud.FPS_FLOOR`).
 */
function placeThinUnderstory(scene: Scene): void {
  const matA = makeUnderstoryMat(scene, 'thinUnderA', new Color3(0.18, 0.4, 0.14));
  const matB = makeUnderstoryMat(scene, 'thinUnderB', new Color3(0.23, 0.46, 0.16));
  const clusterA = buildUnderstoryCluster(scene, 'thinUnderClusterA', matA);
  const clusterB = buildUnderstoryCluster(scene, 'thinUnderClusterB', matB);
  const matsA: Matrix[] = [];
  const matsB: Matrix[] = [];
  const count = 128;
  for (let i = 0; i < count; i++) {
    const a = hash01(i * 73) * Math.PI * 2;
    const r = 16 + hash01(i * 79) * 72;
    if (r < 12) continue;
    const ux = Math.cos(a) * r;
    const uz = Math.sin(a) * r;
    if (pathBlocksUnderstory(ux, uz)) continue;
    const s = 1.15 + hash01(i * 83) * 1.55;
    const m = composeInstanceMatrix(
      ux,
      uz,
      s * (0.75 + hash01(i * 89) * 0.5),
      s,
      s * (0.75 + hash01(i * 97) * 0.5),
      hash01(i * 101) * Math.PI * 2,
    );
    if (i % 2 === 0) matsA.push(m);
    else matsB.push(m);
  }
  thinInstanceFromMatrices(clusterA, matsA);
  thinInstanceFromMatrices(clusterB, matsB);
}

/**
 * Clearing path (#274 / #342): dirt vs grass, not a shiny disc. Worn pad
 * hollows plus a trail that *bends* north around the hero bole into a second
 * clearing silhouette (trees/fog) — not a second zone.
 */
function buildClearingPath(scene: Scene): void {
  const matteDirt = (name: string, diff: Color3, emit: Color3): StandardMaterial => {
    const m = new StandardMaterial(name, scene);
    m.diffuseColor = diff;
    m.specularColor = new Color3(0.006, 0.005, 0.004);
    m.emissiveColor = emit;
    return m;
  };

  // Small irregular worn hollows at spawn — not a concentric disc pad.
  // DummySpawn (5, 0) and vendor (−2.5, 2) must sit on dirt (ellipse < 1) (#347).
  const hollowMat = matteDirt('dirtMat', new Color3(0.46, 0.34, 0.24), new Color3(0.012, 0.009, 0.006));
  const hollows: Array<{ x: number; z: number; r: number; sx: number; sz: number; y?: number }> = [
    { x: 0.4, z: 0.2, r: 3.4, sx: 1.52, sz: 0.82 },
    { x: 2.6, z: 2.8, r: 2.2, sx: 1.4, sz: 0.65 },
    { x: -2.2, z: -1.4, r: 1.8, sx: 0.9, sz: 1.2 },
    { x: 1.2, z: -2.6, r: 1.5, sx: 1.5, sz: 0.7 },
    { x: 5.0, z: 0.0, r: 2.05, sx: 1.28, sz: 1.05, y: DIRT_SURFACE_Y - 0.006 },
    { x: -2.5, z: 2.0, r: 1.95, sx: 1.22, sz: 1.08, y: DIRT_SURFACE_Y - 0.006 },
  ];
  for (let i = 0; i < hollows.length; i++) {
    const h = hollows[i]!;
    placeGroundDisc(
      scene,
      `dirtHollow_${i}`,
      h.x,
      h.z,
      h.y ?? 0.028,
      h.r,
      16,
      h.sx,
      h.sz,
      hollowMat,
    );
  }

  const trailMat = matteDirt('pathTrailMat', new Color3(0.45, 0.33, 0.23), new Color3(0.011, 0.008, 0.005));
  for (let i = 0; i < PATH_POINTS.length - 1; i++) {
    const a = PATH_POINTS[i]!;
    const b = PATH_POINTS[i + 1]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    const t = MeshBuilder.CreateGround(
      `pathTrail_${i}`,
      { width: 3.15 - i * 0.32, height: len + 1.4, subdivisions: 2 },
      scene,
    );
    t.position.set((a.x + b.x) * 0.5, 0.03 - i * 0.002, (a.z + b.z) * 0.5);
    t.rotation.y = Math.atan2(dx, dz);
    t.material = trailMat;
    t.isPickable = false;
  }
  for (let i = 1; i < PATH_POINTS.length - 1; i++) {
    const p = PATH_POINTS[i]!;
    const t = i / (PATH_POINTS.length - 1);
    placeGroundDisc(
      scene,
      `pathBend_${i}`,
      p.x,
      p.z,
      0.032,
      2.4 - t * 0.6,
      14,
      1,
      1,
      trailMat,
    );
  }

  // Second clearing — a worn hollow in fog, same dirt language as the pad.
  placeGroundDisc(
    scene,
    'secondClearingHollow',
    SECOND_CLEARING.x,
    SECOND_CLEARING.z,
    0.027,
    6.4,
    18,
    1.15,
    0.88,
    hollowMat,
  );
  placeGroundDisc(
    scene,
    'secondClearingHollow2',
    SECOND_CLEARING.x + 2.4,
    SECOND_CLEARING.z - 1.6,
    0.026,
    3.6,
    14,
    1.2,
    0.75,
    hollowMat,
  );

  // Faint moss patches near path — soft grass→dirt value variation (no terrain system).
  const mossPatchMat = new StandardMaterial('pathMossPatchMat', scene);
  mossPatchMat.diffuseColor = new Color3(0.24, 0.46, 0.17);
  mossPatchMat.specularColor = new Color3(0.01, 0.014, 0.008);
  mossPatchMat.emissiveColor = new Color3(0.028, 0.055, 0.018);
  const mossPatches: Array<{ x: number; z: number; r: number }> = [
    { x: -7.2, z: 3.4, r: 1.1 },
    { x: 6.8, z: -5.5, r: 0.95 },
    { x: -8.2, z: -18, r: 1.05 },
    { x: 1.8, z: -48, r: 0.9 },
    { x: 8.8, z: -72, r: 1.0 },
  ];
  for (let i = 0; i < mossPatches.length; i++) {
    const p = mossPatches[i]!;
    placeGroundDisc(scene, `pathMossPatch_${i}`, p.x, p.z, 0.018, p.r, 12, 1, 1, mossPatchMat);
  }

  // Cobble-ish worn patches along trail (cheap discs, shared mat) — warm stone.
  const cobbleMat = new StandardMaterial('pathCobbleMat', scene);
  cobbleMat.diffuseColor = new Color3(0.46, 0.4, 0.32);
  cobbleMat.specularColor = new Color3(0.012, 0.01, 0.008);
  cobbleMat.emissiveColor = new Color3(0.01, 0.008, 0.006);
  const cobbleSpots: Array<{ x: number; z: number; r: number }> = [];
  for (let i = 0; i < 10; i++) {
    const u = i / 9;
    const seg = Math.min(PATH_POINTS.length - 2, Math.floor(u * (PATH_POINTS.length - 1)));
    const a = PATH_POINTS[seg]!;
    const b = PATH_POINTS[seg + 1]!;
    const tt = u * (PATH_POINTS.length - 1) - seg;
    cobbleSpots.push({
      x: a.x + (b.x - a.x) * tt + (hash01(i * 71) - 0.5) * 1.4,
      z: a.z + (b.z - a.z) * tt + (hash01(i * 73) - 0.5) * 1.2,
      r: 0.5 - i * 0.016,
    });
  }
  for (let i = 0; i < cobbleSpots.length; i++) {
    const s = cobbleSpots[i]!;
    placeGroundDisc(scene, `pathCobble_${i}`, s.x, s.z, 0.04, s.r, 10, 1, 1, cobbleMat);
  }

  // Tiny stone flecks — shared mat, few instances, web-cheap, warm grey.
  const stoneMat = new StandardMaterial('pathStoneMat', scene);
  stoneMat.diffuseColor = new Color3(0.5, 0.44, 0.36);
  stoneMat.specularColor = new Color3(0.014, 0.012, 0.01);
  stoneMat.emissiveColor = new Color3(0.01, 0.008, 0.006);
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
    const u = i / 15;
    const seg = Math.min(PATH_POINTS.length - 2, Math.floor(u * (PATH_POINTS.length - 1)));
    const a = PATH_POINTS[seg]!;
    const b = PATH_POINTS[seg + 1]!;
    const tt = u * (PATH_POINTS.length - 1) - seg;
    const x = a.x + (b.x - a.x) * tt + (hash01(i * 41) - 0.5) * 2.0;
    const z = a.z + (b.z - a.z) * tt + (hash01(i * 47) - 0.5) * 1.8;
    inst.position.set(x, 0.045, z);
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
  trunkCapsules.length = 0;

  // Atmosphere: #270 fog/sky + #277 cool forest interior (lifts #39 midday key).
  scene.clearColor = new Color4(FOG_COLOR.r, FOG_COLOR.g, FOG_COLOR.b, 1);
  scene.fogMode = Scene.FOGMODE_LINEAR;
  scene.fogStart = FOG_START;
  scene.fogEnd = FOG_END;
  scene.fogColor = FOG_COLOR.clone();

  const hemi = new HemisphericLight('hemiForest', new Vector3(0.08, 1, 0.18), scene);
  hemi.intensity = 0.88;
  hemi.diffuse = new Color3(0.48, 0.62, 0.78);
  hemi.groundColor = new Color3(0.1, 0.18, 0.12);
  hemi.specular = new Color3(0.06, 0.08, 0.1);

  const sun = new DirectionalLight('sunForest', new Vector3(-0.72, -0.38, -0.28), scene);
  sun.position = new Vector3(62, 38, 22);
  sun.intensity = 0.48;
  sun.diffuse = new Color3(0.62, 0.72, 0.88);
  sun.specular = new Color3(0.18, 0.2, 0.24);

  const ground = MeshBuilder.CreateGround(
    'clearing',
    { width: GROUND_EXTENT, height: GROUND_EXTENT, subdivisions: 1 },
    scene,
  );
  const groundMat = new StandardMaterial('clearingMat', scene);
  // Lush grass, matte — the old emissive made a plastic pad (#274).
  groundMat.diffuseColor = new Color3(0.24, 0.48, 0.17);
  groundMat.specularColor = new Color3(0.006, 0.01, 0.005);
  groundMat.emissiveColor = new Color3(0.018, 0.038, 0.012);
  ground.material = groundMat;
  ground.freezeWorldMatrix();

  // Scattered moss clumps — grass variation, not a ring-pad.
  const mossMat = new StandardMaterial('mossMat', scene);
  mossMat.diffuseColor = new Color3(0.2, 0.44, 0.15);
  mossMat.specularColor = new Color3(0.006, 0.01, 0.005);
  mossMat.emissiveColor = new Color3(0.016, 0.036, 0.012);
  const mossClumps: Array<{ x: number; z: number; r: number }> = [
    { x: -5.5, z: 4.2, r: 2.4 },
    { x: 6.5, z: -3.8, r: 2.0 },
    { x: -8.4, z: -20, r: 1.7 },
    { x: -14, z: -40, r: 1.9 },
    { x: 6, z: -70, r: 2.0 },
    { x: 20, z: -80, r: 1.8 },
  ];
  for (let i = 0; i < mossClumps.length; i++) {
    const c = mossClumps[i]!;
    placeGroundDisc(
      scene,
      `mossClump_${i}`,
      c.x,
      c.z,
      0.014,
      c.r,
      14,
      1.2 + hash01(i * 3) * 0.4,
      0.75 + hash01(i * 7) * 0.35,
      mossMat,
    );
  }

  // #44 path/ground polish — readable trail vs lush grass under locked #39 fog/sun.
  // Art warm grey-brown multi-tone dirt (not chalky) + cheap procedural detail.
  buildClearingPath(scene);

  const packed = await placeQuaterniusForest(scene);
  if (!packed) {
    console.warn('[forest] Quaternius pack unavailable — procedural fallback (post-#40 density)');
    placeProceduralForest(scene);
  }
  placeThinUnderstory(scene);

  // Hybrid: mountains stay procedural (pack mountains optional / heavy).
  buildMountainBackdrop(scene);
  buildSkyDome(scene);

  return { ground, hemi, sun };
}
