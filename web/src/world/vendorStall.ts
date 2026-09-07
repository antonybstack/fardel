import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
} from '@babylonjs/core';

/**
 * Procedural yard vendor stall (no art packs).
 * Upright posts + counter + cloth awning — reads as a SHOP at play-cam 8–20m
 * under #39 cool hemi / warm sun / cyan fog. Warm wood (path-warmth family) +
 * desaturated canvas cloth; matte / low specular. Says "buy", not "attack".
 */
export type VendorStallParts = {
  /** Visual assembly at feet (y=0). Parent under vendor root. */
  body: Mesh;
  /** Primary wood mat (API parity with prior green body mat). */
  mat: StandardMaterial;
};

function mat(
  scene: Scene,
  name: string,
  diffuse: Color3,
  emissiveScale = 0.035,
): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = diffuse;
  m.specularColor = new Color3(0.06, 0.05, 0.04);
  m.emissiveColor = diffuse.scale(emissiveScale);
  return m;
}

/**
 * Build a market-stall silhouette from DIY primitives.
 * Footprint ~2.0m W × 1.35m D; ridge ~2.15m. Root at y=0.
 */
export function createVendorStall(
  scene: Scene,
  prefix = 'vendorStall',
): VendorStallParts {
  const body = new Mesh(`${prefix}_body`, scene);

  // Warm wood — dirt-path warmth family (~0.46–0.52, 0.30–0.36, 0.18–0.24).
  const woodMat = mat(
    scene,
    `${prefix}WoodMat`,
    new Color3(0.5, 0.33, 0.19),
    0.03,
  );
  woodMat.specularColor = new Color3(0.09, 0.07, 0.04);

  // Darker plank / crate wood for counter top + goods.
  const plankMat = mat(
    scene,
    `${prefix}PlankMat`,
    new Color3(0.4, 0.26, 0.14),
    0.025,
  );
  plankMat.specularColor = new Color3(0.08, 0.06, 0.03);

  // Desaturated canvas awning — mid-high value so it pops in cyan fog without neon.
  // Warm terracotta-canvas (distinct from darker post wood; not gold neon).
  const clothMat = mat(
    scene,
    `${prefix}ClothMat`,
    new Color3(0.72, 0.48, 0.34),
    0.055,
  );
  clothMat.specularColor = new Color3(0.04, 0.035, 0.03);

  // Stripe valance — lighter canvas band for silhouette break at 8–20m.
  const stripeMat = mat(
    scene,
    `${prefix}StripeMat`,
    new Color3(0.68, 0.58, 0.4),
    0.05,
  );
  stripeMat.specularColor = new Color3(0.04, 0.035, 0.03);

  const postH = 2.05;
  const halfW = 0.95;
  const halfD = 0.62;
  const postD = 0.11;

  // Four upright corner posts.
  for (const [sx, sz, tag] of [
    [-1, -1, 'fl'],
    [1, -1, 'fr'],
    [-1, 1, 'bl'],
    [1, 1, 'br'],
  ] as const) {
    const post = MeshBuilder.CreateBox(
      `${prefix}_post_${tag}`,
      { width: postD, height: postH, depth: postD },
      scene,
    );
    post.parent = body;
    post.position.set(sx * halfW, postH * 0.5, sz * halfD);
    post.material = woodMat;
    post.isPickable = false;
  }

  // Ridge beams (front/back) + side beams under awning.
  for (const [z, tag] of [
    [-halfD, 'front'],
    [halfD, 'back'],
  ] as const) {
    const beam = MeshBuilder.CreateBox(
      `${prefix}_beam_${tag}`,
      { width: halfW * 2 + 0.08, height: 0.09, depth: 0.09 },
      scene,
    );
    beam.parent = body;
    beam.position.set(0, postH - 0.04, z);
    beam.material = woodMat;
    beam.isPickable = false;
  }
  for (const [x, tag] of [
    [-halfW, 'L'],
    [halfW, 'R'],
  ] as const) {
    const side = MeshBuilder.CreateBox(
      `${prefix}_side_${tag}`,
      { width: 0.09, height: 0.09, depth: halfD * 2 + 0.08 },
      scene,
    );
    side.parent = body;
    side.position.set(x, postH - 0.04, 0);
    side.material = woodMat;
    side.isPickable = false;
  }

  // Cloth awning / canopy — slightly oversized for readable shop silhouette.
  const awning = MeshBuilder.CreateBox(
    `${prefix}_awning`,
    { width: 2.35, height: 0.09, depth: 1.7 },
    scene,
  );
  awning.parent = body;
  awning.position.set(0, postH + 0.08, -0.1);
  // Mild front pitch so canopy reads as fabric roof, not flat lid.
  awning.rotation.x = -0.16;
  awning.material = clothMat;
  awning.isPickable = false;

  // Front stripe valance — lighter canvas band under awning lip (shop cue).
  const valance = MeshBuilder.CreateBox(
    `${prefix}_valance`,
    { width: 2.3, height: 0.32, depth: 0.06 },
    scene,
  );
  valance.parent = body;
  valance.position.set(0, postH - 0.22, -halfD - 0.12);
  valance.material = stripeMat;
  valance.isPickable = false;

  // Counter / serving table across the front (shop silhouette key).
  const counterTop = MeshBuilder.CreateBox(
    `${prefix}_counterTop`,
    { width: 1.85, height: 0.1, depth: 0.55 },
    scene,
  );
  counterTop.parent = body;
  counterTop.position.set(0, 0.92, -halfD + 0.12);
  counterTop.material = plankMat;
  counterTop.isPickable = false;

  // Counter apron / front panel.
  const apron = MeshBuilder.CreateBox(
    `${prefix}_apron`,
    { width: 1.8, height: 0.72, depth: 0.08 },
    scene,
  );
  apron.parent = body;
  apron.position.set(0, 0.42, -halfD + 0.02);
  apron.material = woodMat;
  apron.isPickable = false;

  // Rear shelf board (goods silhouette behind counter).
  const shelf = MeshBuilder.CreateBox(
    `${prefix}_shelf`,
    { width: 1.7, height: 0.08, depth: 0.32 },
    scene,
  );
  shelf.parent = body;
  shelf.position.set(0, 1.15, halfD - 0.22);
  shelf.material = plankMat;
  shelf.isPickable = false;

  const backboard = MeshBuilder.CreateBox(
    `${prefix}_backboard`,
    { width: 1.7, height: 0.55, depth: 0.06 },
    scene,
  );
  backboard.parent = body;
  backboard.position.set(0, 1.42, halfD - 0.08);
  backboard.material = woodMat;
  backboard.isPickable = false;

  // Goods hints — small crates / jars (shop, not combat dummy).
  const crateL = MeshBuilder.CreateBox(
    `${prefix}_crateL`,
    { width: 0.32, height: 0.28, depth: 0.28 },
    scene,
  );
  crateL.parent = body;
  crateL.position.set(-0.55, 1.11, -halfD + 0.1);
  crateL.material = plankMat;
  crateL.isPickable = false;

  const crateR = MeshBuilder.CreateBox(
    `${prefix}_crateR`,
    { width: 0.26, height: 0.22, depth: 0.26 },
    scene,
  );
  crateR.parent = body;
  crateR.position.set(0.58, 1.08, -halfD + 0.08);
  crateR.material = woodMat;
  crateR.isPickable = false;

  // Stacked jar / goods blob on shelf (warm mid cloth-adjacent value).
  const jarMat = mat(
    scene,
    `${prefix}JarMat`,
    new Color3(0.55, 0.36, 0.22),
    0.03,
  );
  jarMat.specularColor = new Color3(0.08, 0.06, 0.04);
  const jar = MeshBuilder.CreateCylinder(
    `${prefix}_jar`,
    { height: 0.28, diameter: 0.18, tessellation: 8 },
    scene,
  );
  jar.parent = body;
  jar.position.set(0.15, 1.33, halfD - 0.22);
  jar.material = jarMat;
  jar.isPickable = false;

  const jar2 = MeshBuilder.CreateCylinder(
    `${prefix}_jar2`,
    { height: 0.22, diameter: 0.15, tessellation: 8 },
    scene,
  );
  jar2.parent = body;
  jar2.position.set(-0.25, 1.3, halfD - 0.2);
  jar2.material = jarMat;
  jar2.isPickable = false;

  return { body, mat: woodMat };
}
