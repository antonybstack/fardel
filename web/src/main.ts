import {
  ArcRotateCamera,
  ArcRotateCameraPointersInput,
  Color3,
  Color4,
  Engine,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';
import {
  connectToSpacetime,
  type ConnectionStatus,
  type GameNet,
} from './net/connection';

/** Match shared/Fardel.Shared Movement.MaxStepMeters. */
const MAX_STEP_METERS = 0.75;
/** Client wish speed (m/s); each reducer call is clamped server-side. */
const MOVE_SPEED = 4.5;

function setStatus(text: string): void {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}

function formatStatus(s: ConnectionStatus): string {
  if (s.state === 'connected') {
    const poseLine = s.pose
      ? `pos: (${s.pose.x.toFixed(2)}, ${s.pose.y.toFixed(2)}, ${s.pose.z.toFixed(2)})`
      : 'pos: —';
    return `Connected\nidentity: ${s.identityHex}\n${poseLine}\nuri: ${s.uri}\ndb: ${s.database}`;
  }
  if (s.state === 'connecting') {
    return `Connecting…\nuri: ${s.uri}\ndb: ${s.database}`;
  }
  if (s.state === 'error') {
    return `Error: ${s.message}\nuri: ${s.uri}\ndb: ${s.database}`;
  }
  return `Disconnected\nuri: ${s.uri}\ndb: ${s.database}`;
}

function createScene(engine: Engine): {
  scene: Scene;
  camera: ArcRotateCamera;
  player: Mesh;
} {
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
  const canvas = engine.getRenderingCanvas();
  camera.attachControl(canvas, true);
  camera.lowerRadiusLimit = 4;
  camera.upperRadiusLimit = 40;
  camera.wheelPrecision = 30;
  camera.panningSensibility = 0;

  // RMB orbit (third-person look); disable LMB rotate / RMB pan.
  const pointers = camera.inputs.attached.pointers as
    | ArcRotateCameraPointersInput
    | undefined;
  if (pointers) {
    pointers.buttons = [2];
  }

  if (canvas) {
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

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

  return { scene, camera, player };
}

function bindWasd(): { keys: Set<string>; dispose: () => void } {
  const keys = new Set<string>();
  const down = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (k === 'w' || k === 'a' || k === 's' || k === 'd') {
      keys.add(k);
      e.preventDefault();
    }
  };
  const up = (e: KeyboardEvent) => {
    keys.delete(e.key.toLowerCase());
  };
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  return {
    keys,
    dispose: () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    },
  };
}

/** Camera-relative XZ wish from WASD. */
function wishFromKeys(
  keys: Set<string>,
  camera: ArcRotateCamera,
): { dx: number; dz: number } {
  let x = 0;
  let z = 0;
  if (keys.has('w')) z += 1;
  if (keys.has('s')) z -= 1;
  if (keys.has('a')) x -= 1;
  if (keys.has('d')) x += 1;
  if (x === 0 && z === 0) return { dx: 0, dz: 0 };

  const camPos = camera.position;
  const target = camera.getTarget();
  const fwd = target.subtract(camPos);
  fwd.y = 0;
  if (fwd.lengthSquared() < 1e-8) {
    fwd.set(0, 0, 1);
  } else {
    fwd.normalize();
  }
  const right = Vector3.Cross(Vector3.Up(), fwd).normalize();

  const wish = fwd.scale(z).add(right.scale(x));
  if (wish.lengthSquared() < 1e-8) return { dx: 0, dz: 0 };
  wish.normalize();
  return { dx: wish.x, dz: wish.z };
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
  const { scene, camera, player } = createScene(engine);
  const { keys } = bindWasd();

  let net: GameNet | null = null;
  let moveAccumulator = 0;
  const MOVE_SEND_HZ = 20;

  engine.runRenderLoop(() => {
    const dt = engine.getDeltaTime() / 1000;
    if (net && keys.size > 0) {
      const wish = wishFromKeys(keys, camera);
      if (wish.dx !== 0 || wish.dz !== 0) {
        moveAccumulator += dt;
        const interval = 1 / MOVE_SEND_HZ;
        while (moveAccumulator >= interval) {
          moveAccumulator -= interval;
          let dx = wish.dx * MOVE_SPEED * interval;
          let dz = wish.dz * MOVE_SPEED * interval;
          const len = Math.hypot(dx, dz);
          if (len > MAX_STEP_METERS) {
            const s = MAX_STEP_METERS / len;
            dx *= s;
            dz *= s;
          }
          if (Math.abs(dx) > 1e-6 || Math.abs(dz) > 1e-6) {
            net.sendMove(dx, dz);
          }
        }
      } else {
        moveAccumulator = 0;
      }
    } else {
      moveAccumulator = 0;
    }

    camera.setTarget(player.position.add(new Vector3(0, 0.6, 0)));
    scene.render();
  });
  window.addEventListener('resize', () => engine.resize());

  setStatus('Connecting to SpacetimeDB…');
  const onStatus = (s: ConnectionStatus) => setStatus(formatStatus(s));

  net = await connectToSpacetime(onStatus, (pose) => {
    // Capsule center is height/2 above feet.
    player.position.x = pose.x;
    player.position.y = pose.y + 0.9;
    player.position.z = pose.z;
    player.rotation.y = pose.yaw;
  });
}

main().catch((err: unknown) => {
  console.error(err);
  setStatus(`Boot failed: ${err instanceof Error ? err.message : String(err)}`);
});
