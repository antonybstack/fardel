import {
  ArcRotateCamera,
  Color3,
  Color4,
  Engine,
  HemisphericLight,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';
import { connectToSpacetime, type ConnectionStatus } from './net/connection';

function setStatus(text: string): void {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}

function createScene(engine: Engine): Scene {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.05, 0.07, 0.12, 1);

  const camera = new ArcRotateCamera(
    'camera',
    Math.PI / 3,
    Math.PI / 3.2,
    14,
    new Vector3(0, 1, 0),
    scene,
  );
  camera.attachControl(engine.getRenderingCanvas(), true);
  camera.lowerRadiusLimit = 4;
  camera.upperRadiusLimit = 40;
  camera.wheelPrecision = 30;

  const light = new HemisphericLight('hemi', new Vector3(0.2, 1, 0.3), scene);
  light.intensity = 0.95;
  light.groundColor = new Color3(0.15, 0.18, 0.22);

  const ground = MeshBuilder.CreateGround('ground', { width: 40, height: 40 }, scene);
  const groundMat = new StandardMaterial('groundMat', scene);
  groundMat.diffuseColor = new Color3(0.18, 0.28, 0.2);
  groundMat.specularColor = new Color3(0.05, 0.05, 0.05);
  ground.material = groundMat;

  const player = MeshBuilder.CreateCapsule(
    'player',
    { height: 1.8, radius: 0.35 },
    scene,
  );
  player.position = new Vector3(0, 0.9, 0);
  const playerMat = new StandardMaterial('playerMat', scene);
  playerMat.diffuseColor = new Color3(0.55, 0.7, 0.95);
  player.material = playerMat;

  return scene;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('renderCanvas');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('Missing #renderCanvas');
  }

  const engine = new Engine(canvas, true, {
    preserveDrawingBuffer: true,
    stencil: true,
  });
  const scene = createScene(engine);

  engine.runRenderLoop(() => {
    scene.render();
  });
  window.addEventListener('resize', () => engine.resize());

  setStatus('Connecting to SpacetimeDB…');
  const onStatus = (s: ConnectionStatus) => {
    if (s.state === 'connected') {
      setStatus(`Connected\nidentity: ${s.identityHex}\nuri: ${s.uri}\ndb: ${s.database}`);
    } else if (s.state === 'connecting') {
      setStatus(`Connecting…\nuri: ${s.uri}\ndb: ${s.database}`);
    } else if (s.state === 'error') {
      setStatus(`Error: ${s.message}\nuri: ${s.uri}\ndb: ${s.database}`);
    } else {
      setStatus(`Disconnected\nuri: ${s.uri}\ndb: ${s.database}`);
    }
  };

  await connectToSpacetime(onStatus);
}

main().catch((err: unknown) => {
  console.error(err);
  setStatus(`Boot failed: ${err instanceof Error ? err.message : String(err)}`);
});
