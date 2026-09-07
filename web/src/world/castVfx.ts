import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';

/** Fast Spark bolt: glowing sphere + short trail toward target. */
export type SparkBolt = {
  head: Mesh;
  headMat: StandardMaterial;
  trail: Mesh[];
  trailMats: StandardMaterial[];
  from: Vector3;
  to: Vector3;
  bornMs: number;
  lifeMs: number;
  impactColor: Color3;
  done: boolean;
};

/** Expanding core + ring impact pop at hit point. */
export type ImpactPop = {
  core: Mesh;
  coreMat: StandardMaterial;
  ring: Mesh;
  ringMat: StandardMaterial;
  bornMs: number;
  lifeMs: number;
};

/** Emberbolt windup beam (thicker cylinder caster → target). */
export type EmberBeam = {
  beam: Mesh;
  beamMat: StandardMaterial;
};

export const SPARK_BOLT_MS = 300;
export const IMPACT_POP_MS = 320;
export const EMBER_BEAM_DIAMETER = 0.32;

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
  beamMat.diffuseColor = new Color3(1, 0.45, 0.08);
  beamMat.emissiveColor = new Color3(1.35, 0.4, 0.05);
  beamMat.disableLighting = true;
  beamMat.specularColor = new Color3(0.25, 0.1, 0.04);
  beamMat.alpha = 0.92;
  beamMat.transparencyMode = 2;
  const beam = MeshBuilder.CreateCylinder(
    `emberBeam_${key}`,
    { height: 1, diameter: EMBER_BEAM_DIAMETER, tessellation: 12 },
    scene,
  );
  beam.material = beamMat;
  beam.isPickable = false;
  beam.setEnabled(false);
  return { beam, beamMat };
}

export function spawnSparkBolt(
  scene: Scene,
  from: Vector3,
  to: Vector3,
  opts?: { lifeMs?: number; key?: string },
): SparkBolt {
  const key = opts?.key ?? `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const lifeMs = opts?.lifeMs ?? SPARK_BOLT_MS;
  const headMat = new StandardMaterial(`sparkHeadMat_${key}`, scene);
  headMat.diffuseColor = new Color3(0.55, 0.85, 1);
  headMat.emissiveColor = new Color3(0.75, 1.2, 1.6);
  headMat.disableLighting = true;
  headMat.specularColor = new Color3(0, 0, 0);
  const head = MeshBuilder.CreateSphere(
    `sparkHead_${key}`,
    { diameter: 0.28, segments: 8 },
    scene,
  );
  head.material = headMat;
  head.isPickable = false;
  head.position.copyFrom(from);

  const trail: Mesh[] = [];
  const trailMats: StandardMaterial[] = [];
  for (let i = 0; i < 4; i++) {
    const tm = new StandardMaterial(`sparkTrailMat_${key}_${i}`, scene);
    const t = 1 - i * 0.18;
    tm.diffuseColor = new Color3(0.35 * t, 0.7 * t, 1);
    tm.emissiveColor = new Color3(0.4 * t, 0.85 * t, 1.3 * t);
    tm.disableLighting = true;
    tm.alpha = 0.75 - i * 0.12;
    tm.transparencyMode = 2;
    const m = MeshBuilder.CreateSphere(
      `sparkTrail_${key}_${i}`,
      { diameter: 0.18 - i * 0.025, segments: 6 },
      scene,
    );
    m.material = tm;
    m.isPickable = false;
    m.position.copyFrom(from);
    trail.push(m);
    trailMats.push(tm);
  }

  return {
    head,
    headMat,
    trail,
    trailMats,
    from: from.clone(),
    to: to.clone(),
    bornMs: Date.now(),
    lifeMs,
    impactColor: new Color3(0.55, 0.9, 1.4),
    done: false,
  };
}

export function spawnImpactPop(
  scene: Scene,
  at: Vector3,
  color: Color3,
  opts?: { lifeMs?: number; key?: string },
): ImpactPop {
  const key = opts?.key ?? `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const lifeMs = opts?.lifeMs ?? IMPACT_POP_MS;
  const coreMat = new StandardMaterial(`impactCoreMat_${key}`, scene);
  coreMat.diffuseColor = color;
  coreMat.emissiveColor = color.scale(1.4);
  coreMat.disableLighting = true;
  coreMat.alpha = 0.95;
  coreMat.transparencyMode = 2;
  const core = MeshBuilder.CreateSphere(
    `impactCore_${key}`,
    { diameter: 0.45, segments: 8 },
    scene,
  );
  core.material = coreMat;
  core.isPickable = false;
  core.position.copyFrom(at);

  const ringMat = new StandardMaterial(`impactRingMat_${key}`, scene);
  ringMat.diffuseColor = color;
  ringMat.emissiveColor = color.scale(1.1);
  ringMat.disableLighting = true;
  ringMat.alpha = 0.7;
  ringMat.transparencyMode = 2;
  const ring = MeshBuilder.CreateSphere(
    `impactRing_${key}`,
    { diameter: 0.55, segments: 8 },
    scene,
  );
  ring.material = ringMat;
  ring.isPickable = false;
  ring.position.copyFrom(at);
  ring.scaling.set(1, 0.35, 1);

  return { core, coreMat, ring, ringMat, bornMs: Date.now(), lifeMs };
}

export function disposeSparkBolt(b: SparkBolt): void {
  b.head.dispose();
  b.headMat.dispose();
  for (const m of b.trail) m.dispose();
  for (const m of b.trailMats) m.dispose();
  b.trail.length = 0;
  b.trailMats.length = 0;
  b.done = true;
}

export function disposeImpactPop(p: ImpactPop): void {
  p.core.dispose();
  p.coreMat.dispose();
  p.ring.dispose();
  p.ringMat.dispose();
}

export function disposeEmberBeam(b: EmberBeam): void {
  b.beam.dispose();
  b.beamMat.dispose();
}

/**
 * Advance bolts/pops. Returns bolts that just arrived (for impact spawn).
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
    const pulse = 0.9 + 0.15 * Math.sin(now / 40);
    b.head.scaling.setAll(pulse);
    for (let ti = 0; ti < b.trail.length; ti++) {
      const back = Math.max(0, ease - (ti + 1) * 0.07);
      b.trail[ti]!.position.copyFrom(Vector3.Lerp(b.from, b.to, back));
      b.trailMats[ti]!.alpha = Math.max(0, (0.7 - ti * 0.12) * (1 - t * 0.5));
    }
    if (t >= 1 && !b.done) {
      b.done = true;
      arrived.push(b);
      disposeSparkBolt(b);
      bolts.splice(i, 1);
    }
  }
  return arrived;
}

export function tickImpactPops(pops: ImpactPop[], now: number): void {
  for (let i = pops.length - 1; i >= 0; i--) {
    const p = pops[i]!;
    const t = Math.min(1, Math.max(0, (now - p.bornMs) / p.lifeMs));
    const grow = 1 + t * 1.8;
    p.core.scaling.setAll(grow * (1 - t * 0.35));
    p.coreMat.alpha = 0.95 * (1 - t);
    p.ring.scaling.set(1 + t * 3.2, 0.25 + t * 0.2, 1 + t * 3.2);
    p.ringMat.alpha = 0.7 * (1 - t);
    if (t >= 1) {
      disposeImpactPop(p);
      pops.splice(i, 1);
    }
  }
}
