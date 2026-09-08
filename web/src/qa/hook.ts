/**
 * Dev/QA harness for agent Playwright. Installed only in Vite dev or when
 * VITE_FARDEL_QA=1 — never in the Pages production build.
 */
import type { ArcRotateCamera, Engine, Mesh, Scene } from '@babylonjs/core';
import { CreateScreenshotAsync } from '@babylonjs/core';
import type { ConnectionStatus, GameNet } from '../net/connection';

export type QaState = {
  connected: boolean;
  uri: string;
  database: string;
  identityHex: string | null;
  player: { x: number; y: number; z: number };
  camera: { alpha: number; beta: number; radius: number };
  keys: string[];
  targetNpcId: string | null;
  hp: number | null;
  mana: number | null;
};

export type QaApi = {
  getEngine: () => Engine;
  getScene: () => Scene;
  getCamera: () => ArcRotateCamera;
  getPlayer: () => Mesh;
  getKeys: () => Set<string>;
  getNet: () => GameNet | null;
  getStatus: () => ConnectionStatus;
};

export type QaHook = {
  getState: () => QaState;
  lookDelta: (dx: number, dy: number) => void;
  holdMove: (dir: 'w' | 'a' | 's' | 'd', ms: number) => Promise<void>;
  screenshotScene: () => Promise<string>;
};

declare global {
  interface Window {
    __qa?: QaHook;
  }
}

export function qaEnabled(): boolean {
  if (import.meta.env.VITE_FARDEL_QA === '1') return true;
  return import.meta.env.DEV === true;
}

export function installQaHook(api: QaApi): void {
  if (!qaEnabled()) return;

  const hook: QaHook = {
    getState: () => {
      const status = api.getStatus();
      const net = api.getNet();
      const player = api.getPlayer();
      const camera = api.getCamera();
      const combat = net?.getCombat() ?? null;
      const ch = net?.getCharacter() ?? null;
      return {
        connected: status.state === 'connected',
        uri: status.uri,
        database: status.database,
        identityHex: status.state === 'connected' ? status.identityHex : null,
        player: { x: player.position.x, y: player.position.y, z: player.position.z },
        camera: { alpha: camera.alpha, beta: camera.beta, radius: camera.radius },
        keys: [...api.getKeys()],
        targetNpcId: combat && combat.targetNpcId !== 0n ? combat.targetNpcId.toString() : null,
        hp: ch?.hp ?? null,
        mana: ch?.mana ?? null,
      };
    },
    lookDelta: (dx: number, dy: number) => {
      const camera = api.getCamera();
      camera.alpha -= dx * 0.005;
      const next = camera.beta + dy * 0.005;
      camera.beta = Math.min(Math.PI - 0.2, Math.max(0.2, next));
    },
    holdMove: (dir, ms) => {
      const keys = api.getKeys();
      keys.add(dir);
      const wait = Math.max(0, ms);
      return new Promise((resolve) => {
        window.setTimeout(() => {
          keys.delete(dir);
          resolve();
        }, wait);
      });
    },
    screenshotScene: async () => {
      return CreateScreenshotAsync(api.getEngine(), api.getCamera(), {
        width: 1280,
        height: 800,
      });
    },
  };

  window.__qa = hook;
}
