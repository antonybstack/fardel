/**
 * Client-only FPS / AOI performance overlay.
 * Floor: 30 fps for VE proof on the box reference machine; 60 target.
 */

export const FPS_FLOOR = 30;
export const FPS_TARGET = 60;

export type FpsHudCounts = {
  nearProxies: number;
  farProxies: number;
  remotes: number;
  npcs: number;
};

export type FpsHudSnapshot = {
  fps: number;
  floor: number;
  target: number;
  counts: FpsHudCounts;
  band: 'green' | 'amber' | 'red';
};

/** Color band vs stated VE floor (green ≥ floor, amber ≥ floor/2, else red). */
export function fpsBand(fps: number, floor = FPS_FLOOR): FpsHudSnapshot['band'] {
  if (fps >= floor) return 'green';
  if (fps >= floor * 0.5) return 'amber';
  return 'red';
}

export function readFpsHudDom(): {
  visible: boolean;
  fpsText: string;
  near: number;
} {
  const root = document.getElementById('fpsHud');
  if (!root) return { visible: false, fpsText: '', near: 0 };
  const style = window.getComputedStyle(root);
  const visible =
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    (root as HTMLElement).offsetWidth > 0;
  const fpsEl = document.getElementById('fpsValue');
  const nearEl = document.getElementById('fpsNear');
  const near = nearEl ? Number.parseInt(nearEl.textContent || '0', 10) || 0 : 0;
  return { visible, fpsText: fpsEl?.textContent ?? '', near };
}

/**
 * Update the FPS HUD DOM from Babylon engine.getFps() + AOI/crowd counts.
 * Call ~4Hz from the render loop (throttle in caller).
 */
export function updateFpsHud(
  fpsRaw: number,
  counts: FpsHudCounts,
): FpsHudSnapshot {
  const fps = Math.max(0, Math.round(fpsRaw));
  const band = fpsBand(fps);
  const root = document.getElementById('fpsHud');
  const fpsEl = document.getElementById('fpsValue');
  const floorEl = document.getElementById('fpsFloor');
  const nearEl = document.getElementById('fpsNear');
  const farEl = document.getElementById('fpsFar');
  const remotesEl = document.getElementById('fpsRemotes');
  const npcsEl = document.getElementById('fpsNpcs');

  if (root) {
    root.classList.remove('fps-green', 'fps-amber', 'fps-red');
    root.classList.add(`fps-${band}`);
    root.setAttribute('data-fps', String(fps));
    root.setAttribute('data-near', String(counts.nearProxies));
  }
  if (fpsEl) fpsEl.textContent = String(fps);
  if (floorEl) {
    floorEl.textContent = `floor ${FPS_FLOOR} · target ${FPS_TARGET}`;
  }
  if (nearEl) nearEl.textContent = String(counts.nearProxies);
  if (farEl) farEl.textContent = String(counts.farProxies);
  if (remotesEl) remotesEl.textContent = String(counts.remotes);
  if (npcsEl) npcsEl.textContent = String(counts.npcs);

  return {
    fps,
    floor: FPS_FLOOR,
    target: FPS_TARGET,
    counts,
    band,
  };
}
