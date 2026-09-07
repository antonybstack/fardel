import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';

/** Art brief (#46): cool cyan-white Spark vs warm ember Emberbolt; readable at 8–15m. */

export const SPARK_COLOR = new Color3(0.45, 0.85, 1.0);
export const SPARK_CORE = new Color3(1.0, 1.0, 1.0);
export const EMBER_COLOR = new Color3(1.0, 0.45, 0.15);
export const EMBER_CORE = new Color3(1.0, 0.92, 0.45);

/** Snappy Spark travel ≤150–200ms. */
export const SPARK_BOLT_MS = 180;
/** Emberbolt travel after release — obvious arc, not cinema. */
export const EMBER_BOLT_MS = 380;
export const IMPACT_POP_MS = 280;
export const CAST_FLASH_MS = 160;
/** Windup aim telegraph diameter (thin; charge orb carries cast-start read). */
export const EMBER_BEAM_DIAMETER = 0.14;
/** Emberbolt projectile diameter ~0.25–0.4m. */
export const EMBER_PROJECTILE_DIAMETER = 0.32;
/** Spark head diameter (play-cam readable poke). */
export const SPARK_HEAD_DIAMETER = 0.22;

export type SparkBolt = {
  head: Mesh;
  headMat: StandardMaterial;
  core: Mesh;
  coreMat: StandardMaterial;
  trail: Mesh[];
  trailMats: StandardMaterial[];
  from: Vector3;
  to: Vector3;
  bornMs: number;
  lifeMs: number;
  impactColor: Color3;
  impactScale: number;
  kind: 'spark' | 'ember';
  done: boolean;
  pooled: boolean;
};

export type ImpactPop = {
  core: Mesh;
  coreMat: StandardMaterial;
  ring: Mesh;
  ringMat: StandardMaterial;
  bornMs: number;
  lifeMs: number;
  baseScale: number;
  pooled: boolean;
};

export type CastFlash = {
  glow: Mesh;
  glowMat: StandardMaterial;
  core: Mesh;
  coreMat: StandardMaterial;
  bornMs: number;
  lifeMs: number;
  baseScale: number;
  pooled: boolean;
};

/** Emberbolt windup charge on staff orb. */
export type EmberCharge = {
  glow: Mesh;
  glowMat: StandardMaterial;
  core: Mesh;
  coreMat: StandardMaterial;
};

export type EmberBeam = {
  beam: Mesh;
  beamMat: StandardMaterial;
};

const sparkBoltPool: SparkBolt[] = [];
const emberBoltPool: SparkBolt[] = [];
const impactPool: ImpactPop[] = [];
const flashPool: CastFlash[] = [];

/** Approximate staff-orb world position from a humanoid root at feet. */
export function casterMuzzle(rootPos: Vector3): Vector3 {
  return rootPos.add(new Vector3(0.42, 1.88, 0.14));
}

export function targetHitPoint(rootPos: Vector3): Vector3 {
  return rootPos.add(new Vector3(0, 0.95, 0));
}

export function placeBeam(beam: Mesh, from: Vector3, to: Vector3): void {
  const dir = to.subtract(from);
  const len = dir.length();
  if (len < 0.05) {
    beam.setEnabled(false);
    return;
  }
  beam.setEnabled(true);
  beam.position.copyFrom(from.add(to).scale(0.5));
  beam.scaling.set(1, len, 1);
  const nx = dir.x / len;
  const ny = dir.y / len;
  const nz = dir.z / len;
  beam.rotation.x = Math.acos(Math.max(-1, Math.min(1, ny)));
  beam.rotation.y = Math.atan2(nx, nz);
  beam.rotation.z = 0;
}

export function createEmberBeam(scene: Scene, key: string): EmberBeam {
  const beamMat = new StandardMaterial(`emberBeamMat_${key}`, scene);
  beamMat.diffuseColor = EMBER_COLOR.clone();
  beamMat.emissiveColor = new Color3(1.1, 0.38, 0.08);
  beamMat.disableLighting = true;
  beamMat.specularColor = new Color3(0.2, 0.08, 0.02);
  beamMat.alpha = 0.55;
  beamMat.transparencyMode = 2;
  const beam = MeshBuilder.CreateCylinder(
    `emberBeam_${key}`,
    { height: 1, diameter: EMBER_BEAM_DIAMETER, tessellation: 10 },
    scene,
  );
  beam.material = beamMat;
  beam.isPickable = false;
  beam.setEnabled(false);
  return { beam, beamMat };
}

export function createEmberCharge(scene: Scene, key: string): EmberCharge {
  const glowMat = new StandardMaterial(`emberChargeGlowMat_${key}`, scene);
  glowMat.diffuseColor = EMBER_COLOR.clone();
  glowMat.emissiveColor = new Color3(1.35, 0.5, 0.12);
  glowMat.disableLighting = true;
  glowMat.alpha = 0.55;
  glowMat.transparencyMode = 2;
  // Charge glow ~0.5–0.8m on staff orb.
  const glow = MeshBuilder.CreateSphere(
    `emberChargeGlow_${key}`,
    { diameter: 0.65, segments: 8 },
    scene,
  );
  glow.material = glowMat;
  glow.isPickable = false;
  glow.setEnabled(false);

  const coreMat = new StandardMaterial(`emberChargeCoreMat_${key}`, scene);
  coreMat.diffuseColor = EMBER_CORE.clone();
  coreMat.emissiveColor = new Color3(1.5, 1.2, 0.55);
  coreMat.disableLighting = true;
  coreMat.alpha = 0.95;
  coreMat.transparencyMode = 2;
  const core = MeshBuilder.CreateSphere(
    `emberChargeCore_${key}`,
    { diameter: 0.28, segments: 8 },
    scene,
  );
  core.material = coreMat;
  core.isPickable = false;
  core.setEnabled(false);

  return { glow, glowMat, core, coreMat };
}

export function placeEmberCharge(c: EmberCharge, at: Vector3, now: number): void {
  c.glow.setEnabled(true);
  c.core.setEnabled(true);
  c.glow.position.copyFrom(at);
  c.core.position.copyFrom(at);
  const pulse = 0.85 + 0.2 * Math.sin(now / 70);
  c.glow.scaling.setAll(pulse);
  c.core.scaling.setAll(0.9 + 0.25 * Math.sin(now / 55));
  c.glowMat.emissiveColor = new Color3(1.35 * pulse, 0.5 * pulse, 0.12);
  c.glowMat.alpha = 0.45 + 0.2 * (0.5 + 0.5 * Math.sin(now / 70));
}

export function hideEmberCharge(c: EmberCharge): void {
  c.glow.setEnabled(false);
  c.core.setEnabled(false);
}

function buildBoltMeshes(
  scene: Scene,
  key: string,
  kind: 'spark' | 'ember',
): Omit<
  SparkBolt,
  'from' | 'to' | 'bornMs' | 'lifeMs' | 'impactColor' | 'impactScale' | 'kind' | 'done' | 'pooled'
> {
  const isSpark = kind === 'spark';
  const headDiam = isSpark ? SPARK_HEAD_DIAMETER : EMBER_PROJECTILE_DIAMETER;
  const body = isSpark ? SPARK_COLOR : EMBER_COLOR;
  const coreCol = isSpark ? SPARK_CORE : EMBER_CORE;

  const headMat = new StandardMaterial(`${kind}HeadMat_${key}`, scene);
  headMat.diffuseColor = body.clone();
  headMat.emissiveColor = isSpark
    ? new Color3(0.55, 1.05, 1.35)
    : new Color3(1.4, 0.55, 0.12);
  headMat.disableLighting = true;
  headMat.specularColor = new Color3(0, 0, 0);
  const head = MeshBuilder.CreateSphere(
    `${kind}Head_${key}`,
    { diameter: headDiam, segments: 8 },
    scene,
  );
  head.material = headMat;
  head.isPickable = false;
  head.setEnabled(false);

  const coreMat = new StandardMaterial(`${kind}CoreMat_${key}`, scene);
  coreMat.diffuseColor = coreCol.clone();
  coreMat.emissiveColor = isSpark
    ? new Color3(1.4, 1.4, 1.5)
    : new Color3(1.5, 1.25, 0.55);
  coreMat.disableLighting = true;
  const core = MeshBuilder.CreateSphere(
    `${kind}Core_${key}`,
    { diameter: headDiam * 0.45, segments: 6 },
    scene,
  );
  core.material = coreMat;
  core.isPickable = false;
  core.setEnabled(false);

  const trail: Mesh[] = [];
  const trailMats: StandardMaterial[] = [];
  const trailCount = isSpark ? 5 : 4;
  for (let i = 0; i < trailCount; i++) {
    const tm = new StandardMaterial(`${kind}TrailMat_${key}_${i}`, scene);
    const t = 1 - i * 0.16;
    if (isSpark) {
      tm.diffuseColor = new Color3(0.45 * t, 0.85 * t, 1 * t);
      tm.emissiveColor = new Color3(0.5 * t, 1.0 * t, 1.35 * t);
    } else {
      tm.diffuseColor = new Color3(1 * t, 0.45 * t, 0.12 * t);
      tm.emissiveColor = new Color3(1.25 * t, 0.5 * t, 0.1 * t);
    }
    tm.disableLighting = true;
    tm.alpha = 0.7 - i * 0.11;
    tm.transparencyMode = 2;
    const m = MeshBuilder.CreateSphere(
      `${kind}Trail_${key}_${i}`,
      { diameter: headDiam * (0.72 - i * 0.1), segments: 6 },
      scene,
    );
    m.material = tm;
    m.isPickable = false;
    m.setEnabled(false);
    trail.push(m);
    trailMats.push(tm);
  }

  return { head, headMat, core, coreMat, trail, trailMats };
}

function acquireBolt(
  scene: Scene,
  kind: 'spark' | 'ember',
  from: Vector3,
  to: Vector3,
  opts?: { lifeMs?: number; key?: string },
): SparkBolt {
  const pool = kind === 'spark' ? sparkBoltPool : emberBoltPool;
  let b = pool.pop();
  const lifeMs =
    opts?.lifeMs ?? (kind === 'spark' ? SPARK_BOLT_MS : EMBER_BOLT_MS);
  const impactScale = kind === 'spark' ? 0.8 : 1.2;
  const impactColor =
    kind === 'spark' ? SPARK_COLOR.clone() : EMBER_COLOR.clone();

  if (!b) {
    const key =
      opts?.key ?? `${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const meshes = buildBoltMeshes(scene, key, kind);
    b = {
      ...meshes,
      from: from.clone(),
      to: to.clone(),
      bornMs: Date.now(),
      lifeMs,
      impactColor,
      impactScale,
      kind,
      done: false,
      pooled: true,
    };
  } else {
    b.from.copyFrom(from);
    b.to.copyFrom(to);
    b.bornMs = Date.now();
    b.lifeMs = lifeMs;
    b.impactColor.copyFrom(impactColor);
    b.impactScale = impactScale;
    b.kind = kind;
    b.done = false;
  }

  b.head.setEnabled(true);
  b.core.setEnabled(true);
  b.head.position.copyFrom(from);
  b.core.position.copyFrom(from);
  for (const m of b.trail) {
    m.setEnabled(true);
    m.position.copyFrom(from);
  }
  return b;
}

export function spawnSparkBolt(
  scene: Scene,
  from: Vector3,
  to: Vector3,
  opts?: { lifeMs?: number; key?: string },
): SparkBolt {
  return acquireBolt(scene, 'spark', from, to, opts);
}

export function spawnEmberBolt(
  scene: Scene,
  from: Vector3,
  to: Vector3,
  opts?: { lifeMs?: number; key?: string },
): SparkBolt {
  return acquireBolt(scene, 'ember', from, to, opts);
}

function buildImpact(scene: Scene, key: string): ImpactPop {
  const coreMat = new StandardMaterial(`impactCoreMat_${key}`, scene);
  coreMat.disableLighting = true;
  coreMat.alpha = 0.95;
  coreMat.transparencyMode = 2;
  const core = MeshBuilder.CreateSphere(
    `impactCore_${key}`,
    { diameter: 1, segments: 8 },
    scene,
  );
  core.material = coreMat;
  core.isPickable = false;
  core.setEnabled(false);

  const ringMat = new StandardMaterial(`impactRingMat_${key}`, scene);
  ringMat.disableLighting = true;
  ringMat.alpha = 0.7;
  ringMat.transparencyMode = 2;
  const ring = MeshBuilder.CreateSphere(
    `impactRing_${key}`,
    { diameter: 1, segments: 8 },
    scene,
  );
  ring.material = ringMat;
  ring.isPickable = false;
  ring.setEnabled(false);
  ring.scaling.set(1, 0.35, 1);

  return {
    core,
    coreMat,
    ring,
    ringMat,
    bornMs: Date.now(),
    lifeMs: IMPACT_POP_MS,
    baseScale: 0.8,
    pooled: true,
  };
}

export function spawnImpactPop(
  scene: Scene,
  at: Vector3,
  color: Color3,
  opts?: { lifeMs?: number; key?: string; scale?: number },
): ImpactPop {
  const lifeMs = opts?.lifeMs ?? IMPACT_POP_MS;
  // Spark ~0.6–1.0m; Emberbolt ~1.0–1.4m (diameter via baseScale on unit sphere).
  const baseScale = opts?.scale ?? 0.8;
  let p = impactPool.pop();
  if (!p) {
    const key =
      opts?.key ?? `imp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    p = buildImpact(scene, key);
  }
  p.bornMs = Date.now();
  p.lifeMs = lifeMs;
  p.baseScale = baseScale;
  p.coreMat.diffuseColor = color.clone();
  p.coreMat.emissiveColor = color.scale(1.35);
  p.coreMat.alpha = 0.95;
  p.ringMat.diffuseColor = color.clone();
  p.ringMat.emissiveColor = color.scale(1.05);
  p.ringMat.alpha = 0.7;
  p.core.position.copyFrom(at);
  p.ring.position.copyFrom(at);
  p.core.scaling.setAll(baseScale);
  p.ring.scaling.set(baseScale, baseScale * 0.35, baseScale);
  p.core.setEnabled(true);
  p.ring.setEnabled(true);
  return p;
}

function buildFlash(scene: Scene, key: string): CastFlash {
  const glowMat = new StandardMaterial(`castFlashGlowMat_${key}`, scene);
  glowMat.disableLighting = true;
  glowMat.alpha = 0.65;
  glowMat.transparencyMode = 2;
  const glow = MeshBuilder.CreateSphere(
    `castFlashGlow_${key}`,
    { diameter: 1, segments: 8 },
    scene,
  );
  glow.material = glowMat;
  glow.isPickable = false;
  glow.setEnabled(false);

  const coreMat = new StandardMaterial(`castFlashCoreMat_${key}`, scene);
  coreMat.disableLighting = true;
  coreMat.alpha = 1;
  const core = MeshBuilder.CreateSphere(
    `castFlashCore_${key}`,
    { diameter: 0.35, segments: 6 },
    scene,
  );
  core.material = coreMat;
  core.isPickable = false;
  core.setEnabled(false);

  return {
    glow,
    glowMat,
    core,
    coreMat,
    bornMs: Date.now(),
    lifeMs: CAST_FLASH_MS,
    baseScale: 0.55,
    pooled: true,
  };
}

/** Cast-start muzzle flash on staff orb / hands. Spark ~0.4–0.7m. */
export function spawnCastFlash(
  scene: Scene,
  at: Vector3,
  color: Color3,
  coreColor: Color3,
  opts?: { lifeMs?: number; key?: string; scale?: number },
): CastFlash {
  const lifeMs = opts?.lifeMs ?? CAST_FLASH_MS;
  const baseScale = opts?.scale ?? 0.55;
  let f = flashPool.pop();
  if (!f) {
    const key =
      opts?.key ?? `flash_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    f = buildFlash(scene, key);
  }
  f.bornMs = Date.now();
  f.lifeMs = lifeMs;
  f.baseScale = baseScale;
  f.glowMat.diffuseColor = color.clone();
  f.glowMat.emissiveColor = color.scale(1.25);
  f.glowMat.alpha = 0.7;
  f.coreMat.diffuseColor = coreColor.clone();
  f.coreMat.emissiveColor = coreColor.scale(1.4);
  f.glow.position.copyFrom(at);
  f.core.position.copyFrom(at);
  f.glow.scaling.setAll(baseScale);
  f.core.scaling.setAll(baseScale * 0.45);
  f.glow.setEnabled(true);
  f.core.setEnabled(true);
  return f;
}

export function releaseSparkBolt(b: SparkBolt): void {
  b.head.setEnabled(false);
  b.core.setEnabled(false);
  for (const m of b.trail) m.setEnabled(false);
  b.done = true;
  const pool = b.kind === 'spark' ? sparkBoltPool : emberBoltPool;
  if (b.pooled && pool.length < 12) pool.push(b);
  else {
    b.head.dispose();
    b.headMat.dispose();
    b.core.dispose();
    b.coreMat.dispose();
    for (const m of b.trail) m.dispose();
    for (const m of b.trailMats) m.dispose();
  }
}

/** @deprecated prefer releaseSparkBolt (pooled). Kept for call-site clarity. */
export function disposeSparkBolt(b: SparkBolt): void {
  releaseSparkBolt(b);
}

export function releaseImpactPop(p: ImpactPop): void {
  p.core.setEnabled(false);
  p.ring.setEnabled(false);
  if (p.pooled && impactPool.length < 16) impactPool.push(p);
  else {
    p.core.dispose();
    p.coreMat.dispose();
    p.ring.dispose();
    p.ringMat.dispose();
  }
}

export function disposeImpactPop(p: ImpactPop): void {
  releaseImpactPop(p);
}

export function releaseCastFlash(f: CastFlash): void {
  f.glow.setEnabled(false);
  f.core.setEnabled(false);
  if (f.pooled && flashPool.length < 12) flashPool.push(f);
  else {
    f.glow.dispose();
    f.glowMat.dispose();
    f.core.dispose();
    f.coreMat.dispose();
  }
}

export function disposeEmberBeam(b: EmberBeam): void {
  b.beam.dispose();
  b.beamMat.dispose();
}

export function disposeEmberCharge(c: EmberCharge): void {
  c.glow.dispose();
  c.glowMat.dispose();
  c.core.dispose();
  c.coreMat.dispose();
}

/**
 * Advance bolts. Returns bolts that just arrived (for impact spawn).
 */
export function tickSparkBolts(
  bolts: SparkBolt[],
  now: number,
  dtSec: number,
): SparkBolt[] {
  void dtSec;
  const arrived: SparkBolt[] = [];
  for (let i = bolts.length - 1; i >= 0; i--) {
    const b = bolts[i]!;
    const t = Math.min(1, Math.max(0, (now - b.bornMs) / b.lifeMs));
    const ease = t * t * (3 - 2 * t);
    const pos = Vector3.Lerp(b.from, b.to, ease);
    b.head.position.copyFrom(pos);
    b.core.position.copyFrom(pos);
    const pulse = 0.92 + 0.12 * Math.sin(now / 35);
    b.head.scaling.setAll(pulse);
    b.core.scaling.setAll(pulse * 1.05);
    for (let ti = 0; ti < b.trail.length; ti++) {
      const back = Math.max(0, ease - (ti + 1) * (b.kind === 'spark' ? 0.06 : 0.08));
      b.trail[ti]!.position.copyFrom(Vector3.Lerp(b.from, b.to, back));
      b.trailMats[ti]!.alpha = Math.max(0, (0.7 - ti * 0.11) * (1 - t * 0.45));
    }
    if (t >= 1 && !b.done) {
      b.done = true;
      arrived.push(b);
      releaseSparkBolt(b);
      bolts.splice(i, 1);
    }
  }
  return arrived;
}

export function tickImpactPops(pops: ImpactPop[], now: number): void {
  for (let i = pops.length - 1; i >= 0; i--) {
    const p = pops[i]!;
    const t = Math.min(1, Math.max(0, (now - p.bornMs) / p.lifeMs));
    const grow = p.baseScale * (1 + t * 1.6);
    p.core.scaling.setAll(grow * (1 - t * 0.3));
    p.coreMat.alpha = 0.95 * (1 - t);
    const ring = p.baseScale * (1 + t * 2.8);
    p.ring.scaling.set(ring, p.baseScale * (0.28 + t * 0.15), ring);
    p.ringMat.alpha = 0.7 * (1 - t);
    if (t >= 1) {
      releaseImpactPop(p);
      pops.splice(i, 1);
    }
  }
}

export function tickCastFlashes(flashes: CastFlash[], now: number): void {
  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i]!;
    const t = Math.min(1, Math.max(0, (now - f.bornMs) / f.lifeMs));
    const s = f.baseScale * (1 + t * 0.85);
    f.glow.scaling.setAll(s * (1 - t * 0.2));
    f.core.scaling.setAll(f.baseScale * 0.45 * (1 - t * 0.5));
    f.glowMat.alpha = 0.7 * (1 - t);
    f.coreMat.alpha = 1 - t;
    if (t >= 1) {
      releaseCastFlash(f);
      flashes.splice(i, 1);
    }
  }
}
