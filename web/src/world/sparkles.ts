import { Color3, Mesh, MeshBuilder, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';
import type { GroundItemView as GIV } from '../net/connection';

export type GroundSparkle = { root: Mesh; glow: Mesh; mat: StandardMaterial; glowMat: StandardMaterial; bobPhase: number };

export function makeGroundSparkle(scene: Scene, item: GIV): GroundSparkle {
  const key = item.lootId.toString();
  const root = new Mesh('g_' + key, scene);
  root.position = new Vector3(item.x, item.y, item.z);
  const core = MeshBuilder.CreateSphere('gc_' + key, { diameter: 0.42, segments: 10 }, scene);
  core.parent = root;
  const mat = new StandardMaterial('gm_' + key, scene);
  mat.diffuseColor = new Color3(0.95, 0.58, 0.22);
  mat.emissiveColor = new Color3(0.038, 0.023, 0.009);
  mat.specularColor = new Color3(0.15, 0.09, 0.04);
  core.material = mat;
  const glow = MeshBuilder.CreateSphere('gg_' + key, { diameter: 0.88, segments: 10 }, scene);
  glow.parent = root;
  const glowMat = new StandardMaterial('ggm_' + key, scene);
  glowMat.diffuseColor = new Color3(0.92, 0.62, 0.26);
  glowMat.emissiveColor = new Color3(0.032, 0.022, 0.009);
  glowMat.alpha = 0.42;
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
