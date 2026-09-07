import { Color3, Mesh, MeshBuilder, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';
import type { GroundItemView as GIV } from '../net/connection';

export type GroundSparkle = { root: Mesh; glow: Mesh; mat: StandardMaterial; glowMat: StandardMaterial; bobPhase: number };

export function makeGroundSparkle(scene: Scene, item: GIV): GroundSparkle {
  const key = item.lootId.toString();
  const root = new Mesh('g_' + key, scene);
  root.position = new Vector3(item.x, item.y, item.z);
  const core = MeshBuilder.CreateSphere('gc_' + key, { diameter: 0.35, segments: 8 }, scene);
  core.parent = root;
  const mat = new StandardMaterial('gm_' + key, scene);
  mat.diffuseColor = new Color3(1.0, 0.45, 0.12);
  mat.emissiveColor = new Color3(0.95, 0.35, 0.05);
  core.material = mat;
  const glow = MeshBuilder.CreateSphere('gg_' + key, { diameter: 0.7, segments: 8 }, scene);
  glow.parent = root;
  const glowMat = new StandardMaterial('ggm_' + key, scene);
  glowMat.diffuseColor = new Color3(1.0, 0.6, 0.15);
  glowMat.emissiveColor = new Color3(0.8, 0.35, 0.05);
  glowMat.alpha = 0.35;
  glowMat.disableLighting = true;
  glow.material = glowMat;
  glow.isPickable = false; core.isPickable = false; root.isPickable = false;
  return { root, glow, mat, glowMat, bobPhase: Math.random() * Math.PI * 2 };
}

export function syncGroundSparkles(scene: Scene, items: GIV[], map: Map<string, GroundSparkle>, nowSec: number): void {
  const seen = new Set<string>();
  for (const item of items) {
    const key = item.lootId.toString();
    seen.add(key);
    let s = map.get(key);
    if (!s) { s = makeGroundSparkle(scene, item); map.set(key, s); }
    const bob = 0.08 * Math.sin(nowSec * 3.2 + s.bobPhase);
    s.root.position.set(item.x, item.y + 0.25 + bob, item.z);
    s.root.rotation.y = nowSec * 1.5 + s.bobPhase;
    s.root.setEnabled(true);
  }
  for (const [key, s] of map) {
    if (!seen.has(key)) { s.root.dispose(); map.delete(key); }
  }
}
