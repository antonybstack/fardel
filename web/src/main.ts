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
  gcdRemainingMs,
  SPELL_EMBERBOLT,
  SPELL_SPARK,
  EMBERBOLT_CAST_MS,
  NPC_KIND_DUMMY,
  type ConnectionStatus,
  type GameNet,
  type NpcView,
} from './net/connection';

/** Match shared/Fardel.Shared Movement.MaxStepMeters. */
const MAX_STEP_METERS = 0.75;
/** Client wish speed (m/s); each reducer call is clamped server-side. */
const MOVE_SPEED = 4.5;

type NpcMesh = {
  root: Mesh;
  body: Mesh;
  ring: Mesh;
  mat: StandardMaterial;
  ringMat: StandardMaterial;
};

function setStatus(text: string): void {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}

function setGcdBar(remainingMs: number, castingMs: number, castingTotal: number): void {
  const fill = document.getElementById('gcdFill');
  const label = document.getElementById('gcdLabel');
  const castFill = document.getElementById('castFill');
  const castLabel = document.getElementById('castLabel');
  if (fill) {
    const pct = Math.min(100, (remainingMs / 1200) * 100);
    fill.style.width = `${pct}%`;
    fill.classList.toggle('ready', remainingMs <= 0);
  }
  if (label) {
    label.textContent =
      remainingMs > 0 ? `GCD ${ (remainingMs / 1000).toFixed(1) }s` : 'GCD ready';
  }
  if (castFill && castLabel) {
    if (castingTotal > 0 && castingMs > 0) {
      const pct = Math.min(100, ((castingTotal - castingMs) / castingTotal) * 100);
      castFill.style.width = `${pct}%`;
      castLabel.textContent = `Casting… ${ (castingMs / 1000).toFixed(1) }s`;
      castFill.parentElement?.classList.remove('hidden');
    } else {
      castFill.style.width = '0%';
      castLabel.textContent = '—';
      castFill.parentElement?.classList.add('hidden');
    }
  }
}

function formatStatus(s: ConnectionStatus, nowMs: number): string {
  if (s.state === 'connected') {
    const poseLine = s.pose
      ? `pos: (${s.pose.x.toFixed(2)}, ${s.pose.y.toFixed(2)}, ${s.pose.z.toFixed(2)})`
      : 'pos: —';
    const tgt = s.targetNpc;
    const targetLine = tgt
      ? `target: ${tgt.kind === NPC_KIND_DUMMY ? 'Dummy' : 'NPC'} #${tgt.npcId} HP ${tgt.hp}/${tgt.maxHp}`
      : 'target: (none — Tab)';
    const gcd = gcdRemainingMs(s.combat, nowMs);
    const gcdLine = gcd > 0 ? `GCD: ${(gcd / 1000).toFixed(2)}s` : 'GCD: ready';
    const castLine = s.castFeedback ? `cast: ${s.castFeedback}` : 'cast: —';
    return [
      'Connected',
      `identity: ${s.identityHex}`,
      poseLine,
      targetLine,
      gcdLine,
      castLine,
      'keys: WASD move · RMB look · Tab target · 1 Spark · 2 Emberbolt',
      `uri: ${s.uri}`,
      `db: ${s.database}`,
    ].join('\n');
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

function makeNpcMesh(scene: Scene, npc: NpcView): NpcMesh {
  const root = new Mesh(`npc_${npc.npcId}`, scene);
  root.position = new Vector3(npc.x, 0, npc.z);

  const isDummy = npc.kind === NPC_KIND_DUMMY;
  const body = isDummy
    ? MeshBuilder.CreateCylinder(
        `npcBody_${npc.npcId}`,
        { height: 1.6, diameter: 0.9 },
        scene,
      )
    : MeshBuilder.CreateCapsule(
        `npcBody_${npc.npcId}`,
        { height: 1.6, radius: 0.32 },
        scene,
      );
  body.parent = root;
  body.position.y = 0.8;

  const mat = new StandardMaterial(`npcMat_${npc.npcId}`, scene);
  mat.diffuseColor = isDummy
    ? new Color3(0.75, 0.55, 0.35)
    : new Color3(0.7, 0.35, 0.35);
  mat.specularColor = new Color3(0.1, 0.1, 0.1);
  body.material = mat;

  const ring = MeshBuilder.CreateTorus(
    `npcRing_${npc.npcId}`,
    { diameter: 1.4, thickness: 0.06, tessellation: 32 },
    scene,
  );
  ring.parent = root;
  ring.position.y = 0.05;
  ring.rotation.x = Math.PI / 2;
  const ringMat = new StandardMaterial(`npcRingMat_${npc.npcId}`, scene);
  ringMat.diffuseColor = new Color3(0.2, 0.2, 0.2);
  ringMat.emissiveColor = new Color3(0, 0, 0);
  ring.material = ringMat;
  ring.setEnabled(false);

  return { root, body, ring, mat, ringMat };
}

function bindInput(opts: {
  onCycleTarget: () => void;
  onCast: (spellId: number) => void;
}): { keys: Set<string>; dispose: () => void } {
  const keys = new Set<string>();
  const down = (e: KeyboardEvent) => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === 'w' || k === 'a' || k === 's' || k === 'd') {
      keys.add(k);
      e.preventDefault();
      return;
    }
    if (k === 'tab') {
      e.preventDefault();
      opts.onCycleTarget();
      return;
    }
    if (e.key === '1') {
      e.preventDefault();
      opts.onCast(SPELL_SPARK);
      return;
    }
    if (e.key === '2') {
      e.preventDefault();
      opts.onCast(SPELL_EMBERBOLT);
      return;
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

function flashMesh(mat: StandardMaterial, color: Color3, ms: number): void {
  const prev = mat.emissiveColor.clone();
  mat.emissiveColor = color;
  window.setTimeout(() => {
    mat.emissiveColor = prev;
  }, ms);
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

  let net: GameNet | null = null;
  let latestStatus: ConnectionStatus = {
    state: 'connecting',
    uri: '…',
    database: '…',
  };
  let selectedTargetId: bigint = 0n;
  let castUntilMs = 0;
  let castTotalMs = 0;
  let lastCastSpell = 0;
  const npcMeshes = new Map<string, NpcMesh>();
  let moveAccumulator = 0;
  const MOVE_SEND_HZ = 20;

  const { keys } = bindInput({
    onCycleTarget: () => {
      if (!net) return;
      const id = net.cycleTarget();
      if (id != null) selectedTargetId = id;
    },
    onCast: (spellId) => {
      if (!net) return;
      const combat = net.getCombat();
      if (gcdRemainingMs(combat) > 0) {
        latestStatus =
          latestStatus.state === 'connected'
            ? { ...latestStatus, castFeedback: 'GCD' }
            : latestStatus;
        return;
      }
      if (!combat || combat.targetNpcId === 0n) {
        // Auto-pick first target if none.
        const cycle = net.getTargetCycle();
        if (cycle.length === 0) {
          latestStatus =
            latestStatus.state === 'connected'
              ? { ...latestStatus, castFeedback: 'No target' }
              : latestStatus;
          return;
        }
        net.setTarget(cycle[0]!.npcId);
        selectedTargetId = cycle[0]!.npcId;
      }
      if (spellId === SPELL_EMBERBOLT) {
        castTotalMs = EMBERBOLT_CAST_MS;
        castUntilMs = Date.now() + EMBERBOLT_CAST_MS;
      } else {
        castTotalMs = 0;
        castUntilMs = 0;
      }
      lastCastSpell = spellId;
      net.cast(spellId);

      // Visual telegraph / flash on selected target + player.
      const playerMat = player.material as StandardMaterial;
      flashMesh(
        playerMat,
        spellId === SPELL_SPARK
          ? new Color3(0.4, 0.7, 1)
          : new Color3(1, 0.45, 0.15),
        spellId === SPELL_SPARK ? 180 : 400,
      );
      const tid = net.getCombat()?.targetNpcId ?? selectedTargetId;
      const mesh = npcMeshes.get(tid.toString());
      if (mesh) {
        flashMesh(
          mesh.mat,
          spellId === SPELL_SPARK
            ? new Color3(0.6, 0.85, 1)
            : new Color3(1, 0.35, 0.05),
          spellId === SPELL_SPARK ? 220 : Math.min(800, EMBERBOLT_CAST_MS),
        );
      }
    },
  });

  const syncNpcMeshes = (npcs: NpcView[]) => {
    const seen = new Set<string>();
    for (const npc of npcs) {
      const key = npc.npcId.toString();
      seen.add(key);
      let mesh = npcMeshes.get(key);
      if (!mesh) {
        mesh = makeNpcMesh(scene, npc);
        npcMeshes.set(key, mesh);
      }
      mesh.root.position.x = npc.x;
      mesh.root.position.z = npc.z;
      mesh.root.setEnabled(npc.hp > 0);
      const selected = selectedTargetId === npc.npcId;
      mesh.ring.setEnabled(selected);
      if (selected) {
        mesh.ringMat.emissiveColor = new Color3(0.95, 0.75, 0.2);
        mesh.ringMat.diffuseColor = new Color3(0.95, 0.75, 0.2);
        mesh.mat.emissiveColor = new Color3(0.15, 0.1, 0.02);
      } else {
        mesh.ringMat.emissiveColor = new Color3(0, 0, 0);
        mesh.mat.emissiveColor = new Color3(0, 0, 0);
      }
    }
    for (const [key, mesh] of npcMeshes) {
      if (!seen.has(key)) {
        mesh.root.dispose();
        npcMeshes.delete(key);
      }
    }
  };

  engine.runRenderLoop(() => {
    const dt = engine.getDeltaTime() / 1000;
    const now = Date.now();

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

    // Keep highlight in sync with server combat target.
    if (net) {
      const c = net.getCombat();
      if (c) selectedTargetId = c.targetNpcId;
      syncNpcMeshes(net.getNpcs());
    }

    const gcdLeft = gcdRemainingMs(
      latestStatus.state === 'connected' ? latestStatus.combat : null,
      now,
    );
    const castLeft = Math.max(0, castUntilMs - now);
    setGcdBar(gcdLeft, castLeft, castTotalMs);
    if (latestStatus.state === 'connected') {
      setStatus(formatStatus(latestStatus, now));
    }

    camera.setTarget(player.position.add(new Vector3(0, 0.6, 0)));
    scene.render();
  });
  window.addEventListener('resize', () => engine.resize());

  setStatus('Connecting to SpacetimeDB…');
  const onStatus = (s: ConnectionStatus) => {
    latestStatus = s;
    if (s.state === 'connected' && s.combat) {
      selectedTargetId = s.combat.targetNpcId;
    }
    setStatus(formatStatus(s, Date.now()));
  };

  net = await connectToSpacetime(
    onStatus,
    (pose) => {
      player.position.x = pose.x;
      player.position.y = pose.y + 0.9;
      player.position.z = pose.z;
      player.rotation.y = pose.yaw;
    },
    (npcs) => {
      syncNpcMeshes(npcs);
    },
    (combat) => {
      if (combat) selectedTargetId = combat.targetNpcId;
    },
  );

  // Optional VE / autotest: ?ve=combat targets dummy and casts Spark once.
  const params = new URLSearchParams(window.location.search);
  if (net && params.get('ve') === 'combat') {
    const tryCast = () => {
      if (!net) return;
      net.ensureTrainingDummy();
      const cycle = net.getTargetCycle();
      const dummy = cycle.find((n) => n.kind === NPC_KIND_DUMMY) ?? cycle[0];
      if (!dummy) {
        window.setTimeout(tryCast, 250);
        return;
      }
      net.setTarget(dummy.npcId);
      selectedTargetId = dummy.npcId;
      window.setTimeout(() => {
        if (!net) return;
        lastCastSpell = SPELL_SPARK;
        net.cast(SPELL_SPARK);
        const playerMat = player.material as StandardMaterial;
        flashMesh(playerMat, new Color3(0.4, 0.7, 1), 220);
        const mesh = npcMeshes.get(dummy.npcId.toString());
        if (mesh) flashMesh(mesh.mat, new Color3(0.6, 0.85, 1), 280);
      }, 400);
    };
    window.setTimeout(tryCast, 600);
  }

  void lastCastSpell;
}

main().catch((err: unknown) => {
  console.error(err);
  setStatus(`Boot failed: ${err instanceof Error ? err.message : String(err)}`);
});
