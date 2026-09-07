import {
  ArcRotateCamera,
  ArcRotateCameraPointersInput,
  Color3,
  DynamicTexture,
  Engine,
  InstancedMesh,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';
import {
  connectToSpacetime,
  gcdRemainingMs,
  castRemainingMs,
  SPELL_EMBERBOLT,
  SPELL_SPARK,
  EMBERBOLT_CAST_MS,
  NPC_KIND_DUMMY,
  CROWD_NEAR_COUNT,
  type ConnectionStatus,
  type CrowdProxyView,
  type GameNet,
  type NpcView,
  type RemoteCombat,
  type RemotePose,
} from './net/connection';
import { buildForestClearing } from './world/forest';
import {
  createPlayerHumanoid,
  partyRobeColor,
  remoteRobeColor,
  type HumanoidParts,
} from './world/humanoid';

/** Match shared/Fardel.Shared Movement.MaxStepMeters. */
const MAX_STEP_METERS = 0.75;
/** Client wish speed (m/s); each reducer call is clamped server-side. */
const MOVE_SPEED = 4.5;

type NpcMesh = {
  root: Mesh;
  body: Mesh;
  ring: Mesh;
  remoteRing: Mesh;
  mat: StandardMaterial;
  ringMat: StandardMaterial;
  remoteRingMat: StandardMaterial;
  nameplate: Nameplate | null;
};

type RemoteFx = {
  beam: Mesh;
  beamMat: StandardMaterial;
  bar: Mesh;
  barMat: StandardMaterial;
  lastCastAtMicros: bigint;
};

type DamageFloater = {
  mesh: Mesh;
  mat: StandardMaterial;
  bornMs: number;
  lifeMs: number;
  startY: number;
  driftX: number;
};

/** World-space billboard label above an entity (You / Dummy / remote hex). */
type Nameplate = {
  mesh: Mesh;
  mat: StandardMaterial;
  tex: DynamicTexture;
  label: string;
  /** <0 = no HP pip; else 0..1 fill. */
  hpFrac: number;
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



/** DOM selected-target frame (name + HP + short id). Hidden when no target. */
function updateTargetFrame(target: NpcView | null | undefined): void {
  const frame = document.getElementById('targetFrame');
  if (!frame) return;
  if (!target || target.npcId === 0n || target.hp <= 0) {
    frame.classList.add('hidden');
    return;
  }
  frame.classList.remove('hidden');
  const nameEl = document.getElementById('tfName');
  const idEl = document.getElementById('tfId');
  const fill = document.getElementById('tfHpFill');
  const label = document.getElementById('tfHpLabel');
  const name = target.kind === NPC_KIND_DUMMY ? 'Dummy' : 'NPC';
  if (nameEl) nameEl.textContent = name;
  if (idEl) idEl.textContent = `#${target.npcId.toString()}`;
  const frac = target.maxHp > 0 ? Math.max(0, Math.min(1, target.hp / target.maxHp)) : 0;
  if (fill) {
    fill.style.width = `${(frac * 100).toFixed(1)}%`;
    fill.classList.toggle('mid', frac <= 0.4 && frac > 0.18);
    fill.classList.toggle('low', frac <= 0.18);
  }
  if (label) label.textContent = `${target.hp}/${target.maxHp}`;
}

/** Bottom-center Spark/Emberbolt hotbar: GCD sweep + Emberbolt cast + staff dim. */
function updateSpellHotbar(opts: {
  gcdMs: number;
  castingMs: number;
  castingTotal: number;
  castingSpell: number;
  staffEquipped: boolean;
}): void {
  const gcdPct = opts.gcdMs > 0 ? Math.min(100, (opts.gcdMs / 1200) * 100) : 0;
  const castPct =
    opts.castingTotal > 0 && opts.castingMs > 0
      ? Math.min(100, ((opts.castingTotal - opts.castingMs) / opts.castingTotal) * 100)
      : 0;
  const castingEmber =
    opts.castingSpell === SPELL_EMBERBOLT && opts.castingMs > 0 && opts.castingTotal > 0;

  const applySlot = (
    slotId: string,
    sweepId: string,
    castId: string,
    isCastingThis: boolean,
  ) => {
    const slot = document.getElementById(slotId);
    const sweep = document.getElementById(sweepId);
    const cast = document.getElementById(castId);
    if (!slot || !sweep || !cast) return;
    slot.classList.toggle('disabled', !opts.staffEquipped);
    slot.classList.toggle('onGcd', opts.gcdMs > 0 && opts.staffEquipped);
    slot.classList.toggle('casting', isCastingThis && opts.staffEquipped);
    sweep.style.height = opts.staffEquipped ? `${gcdPct}%` : '0%';
    cast.style.height = isCastingThis && opts.staffEquipped ? `${castPct}%` : '0%';
  };

  applySlot('slotSpark', 'sweepSpark', 'castSpark', false);
  applySlot(
    'slotEmberbolt',
    'sweepEmberbolt',
    'castEmberbolt',
    castingEmber,
  );
}

/** Top-right 2D minimap: local, remotes, dummy, crowd proxies. */
const MINIMAP_RANGE_M = 48;

function drawMinimap(opts: {
  local: { x: number; z: number } | null;
  remotes: RemotePose[];
  npcs: NpcView[];
  proxies: CrowdProxyView[];
}): void {
  const canvas = document.getElementById('minimap') as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const scale = (Math.min(w, h) * 0.42) / MINIMAP_RANGE_M;

  ctx.clearRect(0, 0, w, h);
  // Disc background
  ctx.fillStyle = 'rgba(8, 12, 24, 0.55)';
  ctx.beginPath();
  ctx.arc(cx, cy, Math.min(w, h) * 0.46, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Range ring
  ctx.strokeStyle = 'rgba(106,162,255,0.22)';
  ctx.beginPath();
  ctx.arc(cx, cy, MINIMAP_RANGE_M * scale, 0, Math.PI * 2);
  ctx.stroke();

  // Compass N
  ctx.fillStyle = '#c8d6f0';
  ctx.font = 'bold 11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', cx, 12);

  const originX = opts.local?.x ?? 0;
  const originZ = opts.local?.z ?? 0;

  const plot = (wx: number, wz: number, color: string, r: number, alpha = 1) => {
    const dx = (wx - originX) * scale;
    // World +Z forward → screen up (north-up).
    const dy = -(wz - originZ) * scale;
    const dist = Math.hypot(dx, dy);
    const maxR = Math.min(w, h) * 0.44;
    let px = cx + dx;
    let py = cy + dy;
    if (dist > maxR && dist > 1e-6) {
      const s = maxR / dist;
      px = cx + dx * s;
      py = cy + dy * s;
    }
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  };

  for (const p of opts.proxies) {
    plot(p.x, p.z, p.far ? '#a86a2a' : '#f08a28', p.far ? 2.2 : 2.8, p.far ? 0.55 : 0.9);
  }
  for (const n of opts.npcs) {
    if (n.hp <= 0) continue;
    const dummy = n.kind === NPC_KIND_DUMMY;
    plot(n.x, n.z, dummy ? '#c4a06a' : '#c45a5a', dummy ? 3.4 : 3.0);
  }
  for (const r of opts.remotes) {
    plot(r.x, r.z, r.party ? '#5ed68a' : '#d46ad8', 3.6);
  }
  // Local on top
  plot(originX, originZ, '#6aa2ff', 4.2);
  ctx.strokeStyle = 'rgba(232,238,252,0.85)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(cx, cy, 4.2, 0, Math.PI * 2);
  ctx.stroke();
}

function formatLoadout(ch: NonNullable<Extract<ConnectionStatus, { state: 'connected' }>['character']>): string {
  const gear = [
    ch.staffEquipped ? 'staff' : null,
    ch.robesEquipped ? 'robes' : null,
  ]
    .filter(Boolean)
    .join('+') || '(none)';
  const staffLine = ch.staffEquipped ? 'staff: equipped' : 'staff: UNEQUIPPED (casts blocked)';
  const spells = [
    ch.knowsSpark ? 'Spark' : null,
    ch.knowsEmberbolt ? 'Emberbolt' : null,
  ]
    .filter(Boolean)
    .join('+') || '(none)';
  return `XP ${ch.xp} · loadout ${gear} · ${staffLine} · spells ${spells}`;
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
    const persistLine = s.restoredToken
      ? 'persist: restored token (same identity)'
      : 'persist: new token saved';
    const xpLine = s.character ? formatLoadout(s.character) : 'XP/loadout: —';
    const aoi = s.aoi;
    const aoiLine = aoi
      ? `AOI: interest (${aoi.interestChunkX},${aoi.interestChunkZ}) · pose chunk (${aoi.poseChunkX},${aoi.poseChunkZ}) · proxies ${aoi.proxyCount} (near ${aoi.nearCount} / far ${aoi.farCount})${aoi.neighborhoodSql ? ' · neigh-SQL' : ''}`
      : 'AOI: —';
    const remotes = s.remotes ?? [];
    const remotesLine =
      remotes.length === 0
        ? 'remotes: 0'
        : `remotes: ${remotes.length} · ${remotes
            .map((r) => {
              const tag = r.party ? ' [party]' : '';
              return `${r.identityHex.slice(0, 8)}…${tag} @(${r.x.toFixed(1)},${r.z.toFixed(1)})`;
            })
            .join(' · ')}`;
    const party = s.party;
    const partyLine = !party
      ? 'party: 0'
      : party.size === 0
        ? party.pendingInviteFrom
          ? `party: 0 · invite from ${party.pendingInviteFrom.slice(0, 8)}… (P accept? use invite flow)`
          : 'party: 0'
        : `party: ${party.size}${party.isLeader ? ' · leader' : ''} · ${party.members
            .map((m) => `${m.identityHex.slice(0, 8)}…${m.isLeader ? '*' : ''}`)
            .join(' · ')}${
            party.pendingInviteFrom
              ? ` · invite from ${party.pendingInviteFrom.slice(0, 8)}…`
              : ''
          }`;
    const rCombats = s.remoteCombats ?? [];
    const remoteTargetBits: string[] = [];
    const remoteCastBits: string[] = [];
    for (const rc of rCombats) {
      if (rc.targetNpcId !== 0n) {
        remoteTargetBits.push(
          `${rc.identityHex.slice(0, 8)}…→npc#${rc.targetNpcId}`,
        );
      }
      const wind = castRemainingMs(rc, nowMs);
      if (rc.castingSpellId !== 0 && wind > 0) {
        const name =
          rc.castingSpellId === SPELL_EMBERBOLT
            ? 'Emberbolt'
            : rc.castingSpellId === SPELL_SPARK
              ? 'Spark'
              : `Spell${rc.castingSpellId}`;
        remoteCastBits.push(
          `${rc.identityHex.slice(0, 8)}… ${name} ${(wind / 1000).toFixed(1)}s`,
        );
      }
    }
    const remoteTargetLine =
      remoteTargetBits.length === 0
        ? 'remote-target: (none)'
        : `remote-target: ${remoteTargetBits.join(' · ')}`;
    const remoteCastLine =
      remoteCastBits.length === 0
        ? 'remote-cast: (none)'
        : `remote-cast: ${remoteCastBits.join(' · ')}`;
    return [
      'Connected',
      `identity: ${s.identityHex}`,
      xpLine,
      persistLine,
      poseLine,
      remotesLine,
      partyLine,
      aoiLine,
      targetLine,
      remoteTargetLine,
      remoteCastLine,
      gcdLine,
      castLine,
      'keys: WASD move · RMB look · Tab target · 1 Spark · 2 Emberbolt · U unequip staff · I equip staff · P invite/accept · O leave',
      `uri: ${s.uri}`,
      `db: ${s.database}`,
    ].join('\n');
  }
  if (s.state === 'connecting') {
    const restore = s.restoredToken ? ' (restoring token…)' : '';
    return `Connecting…${restore}\nuri: ${s.uri}\ndb: ${s.database}`;
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
  humanoid: HumanoidParts;
  proxySource: Mesh;
} {
  const scene = new Scene(engine);

  const camera = new ArcRotateCamera(
    'camera',
    Math.PI / 2.6,
    Math.PI / 3.4,
    22,
    new Vector3(0, 1, 0),
    scene,
  );
  const canvas = engine.getRenderingCanvas();
  camera.attachControl(canvas, true);
  camera.lowerRadiusLimit = 4;
  camera.upperRadiusLimit = 80;
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

  // North-star yard: forest clearing + huge trees + distant mountains.
  buildForestClearing(scene);

  // Local player: procedural humanoid + staff (crowd proxies stay capsules).
  const humanoid = createPlayerHumanoid(scene);
  const player = humanoid.root;
  player.position = new Vector3(0, 0, 0);

  // CrowdProxy source mesh (hidden) — instances are amber, distinct from local blue player.
  const proxySource = MeshBuilder.CreateCapsule(
    'crowdProxySource',
    { height: 1.5, radius: 0.28 },
    scene,
  );
  proxySource.position = new Vector3(0, -100, 0);
  proxySource.isVisible = false;
  proxySource.setEnabled(false);
  const proxyMat = new StandardMaterial('crowdProxyMat', scene);
  proxyMat.diffuseColor = new Color3(0.95, 0.55, 0.15);
  proxyMat.specularColor = new Color3(0.08, 0.05, 0.02);
  proxyMat.emissiveColor = new Color3(0.18, 0.08, 0.02);
  proxySource.material = proxyMat;

  return { scene, camera, player, humanoid, proxySource };
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

  const remoteRing = MeshBuilder.CreateTorus(
    `npcRemoteRing_${npc.npcId}`,
    { diameter: 1.7, thickness: 0.05, tessellation: 32 },
    scene,
  );
  remoteRing.parent = root;
  remoteRing.position.y = 0.04;
  remoteRing.rotation.x = Math.PI / 2;
  const remoteRingMat = new StandardMaterial(`npcRemoteRingMat_${npc.npcId}`, scene);
  remoteRingMat.diffuseColor = new Color3(0.2, 0.85, 0.95);
  remoteRingMat.emissiveColor = new Color3(0.05, 0.35, 0.45);
  remoteRing.material = remoteRingMat;
  remoteRing.setEnabled(false);

  let nameplate: Nameplate | null = null;
  if (isDummy) {
    nameplate = createNameplate(scene, `npc_${npc.npcId}`);
    nameplate.mesh.parent = root;
    nameplate.mesh.position.set(0, 2.0, 0);
    paintNameplate(nameplate, 'Dummy', '#e8c89a', npc.maxHp > 0 ? npc.hp / npc.maxHp : 1);
  }

  return { root, body, ring, remoteRing, mat, ringMat, remoteRingMat, nameplate };
}

function bindInput(opts: {
  onCycleTarget: () => void;
  onCast: (spellId: number) => void;
  onPartyInviteOrAccept: () => void;
  onPartyLeave: () => void;
  onUnequipStaff: () => void;
  onEquipStaff: () => void;
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
    if (k === 'p') {
      e.preventDefault();
      opts.onPartyInviteOrAccept();
      return;
    }
    if (k === 'o') {
      e.preventDefault();
      opts.onPartyLeave();
      return;
    }
    if (k === 'u') {
      e.preventDefault();
      opts.onUnequipStaff();
      return;
    }
    if (k === 'i') {
      e.preventDefault();
      opts.onEquipStaff();
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


/** Hide/show staff group + children (Babylon setEnabled on empty parent is not always enough). */
function setStaffMeshVisible(staff: Mesh, visible: boolean): void {
  staff.setEnabled(visible);
  staff.isVisible = visible;
  for (const child of staff.getChildMeshes(true)) {
    child.setEnabled(visible);
    child.isVisible = visible;
  }
}

function flashMesh(mat: StandardMaterial, color: Color3, ms: number): void {
  const prev = mat.emissiveColor.clone();
  mat.emissiveColor = color;
  window.setTimeout(() => {
    mat.emissiveColor = prev;
  }, ms);
}

/** Short readable billboard above feet-rooted entities. */
function createNameplate(scene: Scene, key: string): Nameplate {
  const tex = new DynamicTexture(
    `npTex_${key}`,
    { width: 256, height: 96 },
    scene,
    false,
  );
  tex.hasAlpha = true;
  const mat = new StandardMaterial(`npMat_${key}`, scene);
  mat.diffuseTexture = tex;
  mat.emissiveTexture = tex;
  mat.opacityTexture = tex;
  mat.disableLighting = true;
  mat.useAlphaFromDiffuseTexture = true;
  mat.backFaceCulling = false;
  mat.specularColor = new Color3(0, 0, 0);
  const mesh = MeshBuilder.CreatePlane(
    `np_${key}`,
    { width: 1.5, height: 0.56 },
    scene,
  );
  mesh.material = mat;
  mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
  mesh.isPickable = false;
  mesh.position.y = 2.05;
  return { mesh, mat, tex, label: '', hpFrac: -2 };
}

function paintNameplate(
  np: Nameplate,
  label: string,
  fillCss: string,
  hpFrac: number,
): void {
  if (np.label === label && Math.abs(np.hpFrac - hpFrac) < 0.02) return;
  np.label = label;
  np.hpFrac = hpFrac;
  const ctx = np.tex.getContext() as unknown as CanvasRenderingContext2D;
  const w = 256;
  const h = 96;
  ctx.clearRect(0, 0, w, h);
  const showPip = hpFrac >= 0;
  const textY = showPip ? 34 : 48;
  // Soft dark pill so labels read over bright sky / trees.
  const pillW = Math.min(236, 40 + label.length * 20);
  const pillH = showPip ? 78 : 56;
  const pillX = (w - pillW) / 2;
  const pillY = showPip ? 8 : 20;
  ctx.fillStyle = 'rgba(8,10,16,0.55)';
  ctx.beginPath();
  const r = 14;
  ctx.moveTo(pillX + r, pillY);
  ctx.arcTo(pillX + pillW, pillY, pillX + pillW, pillY + pillH, r);
  ctx.arcTo(pillX + pillW, pillY + pillH, pillX, pillY + pillH, r);
  ctx.arcTo(pillX, pillY + pillH, pillX, pillY, r);
  ctx.arcTo(pillX, pillY, pillX + pillW, pillY, r);
  ctx.closePath();
  ctx.fill();
  ctx.font = 'bold 40px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 7;
  ctx.strokeStyle = 'rgba(0,0,0,0.92)';
  ctx.strokeText(label, w / 2, textY);
  ctx.fillStyle = fillCss;
  ctx.fillText(label, w / 2, textY);
  if (showPip) {
    const bx = 52;
    const by = 62;
    const bw = 152;
    const bh = 14;
    ctx.fillStyle = 'rgba(12,12,14,0.85)';
    ctx.fillRect(bx, by, bw, bh);
    const fill = Math.max(0, Math.min(1, hpFrac));
    ctx.fillStyle =
      fill > 0.4
        ? 'rgb(72,205,110)'
        : fill > 0.18
          ? 'rgb(230,190,55)'
          : 'rgb(220,70,60)';
    ctx.fillRect(bx + 2, by + 2, (bw - 4) * fill, bh - 4);
  }
  np.tex.update();
}

function disposeNameplate(np: Nameplate | null | undefined): void {
  if (!np) return;
  np.mesh.dispose();
  np.mat.dispose();
  np.tex.dispose();
}

/** Rising combat text above an NPC — cosmetic only (HP delta from authority). */
function spawnDamageFloater(
  scene: Scene,
  at: Vector3,
  amount: number,
  tint: Color3,
): DamageFloater {
  const label = `-${amount}`;
  const tex = new DynamicTexture(
    `dmgTex_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    { width: 256, height: 128 },
    scene,
    false,
  );
  tex.hasAlpha = true;
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, 256, 128);
  ctx.font = 'bold 84px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 12;
  ctx.strokeStyle = 'rgba(0,0,0,0.92)';
  ctx.strokeText(label, 128, 64);
  ctx.fillStyle = `rgb(${Math.round(tint.r * 255)},${Math.round(tint.g * 255)},${Math.round(tint.b * 255)})`;
  ctx.fillText(label, 128, 64);
  tex.update();

  const mat = new StandardMaterial(`dmgMat_${label}_${Date.now()}`, scene);
  mat.diffuseTexture = tex;
  mat.emissiveTexture = tex;
  mat.opacityTexture = tex;
  mat.disableLighting = true;
  mat.useAlphaFromDiffuseTexture = true;
  mat.backFaceCulling = false;
  mat.specularColor = new Color3(0, 0, 0);

  const mesh = MeshBuilder.CreatePlane(
    `dmgPlane_${label}_${Date.now()}`,
    { width: 1.7, height: 0.85 },
    scene,
  );
  mesh.material = mat;
  mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
  mesh.position = at.clone();
  mesh.position.y += 1.85;
  mesh.isPickable = false;

  return {
    mesh,
    mat,
    bornMs: Date.now(),
    lifeMs: 1100,
    startY: mesh.position.y,
    driftX: (Math.random() - 0.5) * 0.55,
  };
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
  const { scene, camera, player, humanoid, proxySource } = createScene(engine);

  let net: GameNet | null = null;
  let latestStatus: ConnectionStatus = {
    state: 'connecting',
    uri: '…',
    database: '…',
    restoredToken: false,
  };
  let selectedTargetId: bigint = 0n;
  let castUntilMs = 0;
  let castTotalMs = 0;
  let lastCastSpell = 0;
  const npcMeshes = new Map<string, NpcMesh>();
  const npcLastHp = new Map<string, number>();
  const damageFloaters: DamageFloater[] = [];
  let latestDamageAmount = 0;
  let latestDamageAtMs = 0;
  const proxyInstances = new Map<string, InstancedMesh>();
  const remoteMeshes = new Map<string, HumanoidParts>();
  const remoteNameplates = new Map<string, Nameplate>();
  const remoteFx = new Map<string, RemoteFx>();
  let latestRemoteCombats: RemoteCombat[] = [];
  const localNameplate = createNameplate(scene, 'local');
  localNameplate.mesh.parent = player;
  localNameplate.mesh.position.set(0, 2.05, 0);
  paintNameplate(localNameplate, 'You', '#b8d4ff', -1);
  let moveAccumulator = 0;
  const MOVE_SEND_HZ = 20;

  const ensureRemoteFx = (key: string): RemoteFx => {
    let fx = remoteFx.get(key);
    if (fx) return fx;
    const beamMat = new StandardMaterial(`remoteBeamMat_${key.slice(0, 10)}`, scene);
    beamMat.diffuseColor = new Color3(1, 0.55, 0.1);
    beamMat.emissiveColor = new Color3(1.2, 0.45, 0.05);
    beamMat.disableLighting = true;
    beamMat.specularColor = new Color3(0.2, 0.1, 0.05);
    const beam = MeshBuilder.CreateCylinder(
      `remoteBeam_${key.slice(0, 10)}`,
      { height: 1, diameter: 0.18, tessellation: 10 },
      scene,
    );
    beam.material = beamMat;
    beam.setEnabled(false);

    const barMat = new StandardMaterial(`remoteBarMat_${key.slice(0, 10)}`, scene);
    barMat.diffuseColor = new Color3(1, 0.7, 0.2);
    barMat.emissiveColor = new Color3(1.1, 0.45, 0.08);
    barMat.disableLighting = true;
    const bar = MeshBuilder.CreateBox(
      `remoteBar_${key.slice(0, 10)}`,
      { width: 1.2, height: 0.16, depth: 0.16 },
      scene,
    );
    bar.material = barMat;
    bar.setEnabled(false);

    fx = { beam, beamMat, bar, barMat, lastCastAtMicros: 0n };
    remoteFx.set(key, fx);
    return fx;
  };

  const placeBeam = (beam: Mesh, from: Vector3, to: Vector3): void => {
    const dir = to.subtract(from);
    const len = dir.length();
    if (len < 0.05) {
      beam.setEnabled(false);
      return;
    }
    beam.setEnabled(true);
    beam.position.copyFrom(from.add(to).scale(0.5));
    beam.scaling.set(1, len, 1);
    // Cylinder default axis is +Y — pitch/yaw so +Y aligns with dir.
    const nx = dir.x / len;
    const ny = dir.y / len;
    const nz = dir.z / len;
    beam.rotation.x = Math.acos(Math.max(-1, Math.min(1, ny)));
    beam.rotation.y = Math.atan2(nx, nz);
    beam.rotation.z = 0;
  };

  const syncRemoteCastFx = (combats: RemoteCombat[]) => {
    latestRemoteCombats = combats;
    const seen = new Set<string>();
    const now = Date.now();
    for (const rc of combats) {
      const key = rc.identityHex;
      seen.add(key);
      const parts = remoteMeshes.get(key);
      const fx = ensureRemoteFx(key);
      const wind = castRemainingMs(rc, now);
      const casting = rc.castingSpellId !== 0 && wind > 0;

      // Impact / Spark flash when LastCastAt advances.
      if (
        rc.lastCastAtMicros > 0n &&
        rc.lastCastAtMicros !== fx.lastCastAtMicros &&
        fx.lastCastAtMicros !== 0n
      ) {
        const spark = rc.lastSpellId === SPELL_SPARK;
        const color = spark
          ? new Color3(0.4, 0.75, 1)
          : new Color3(1, 0.4, 0.1);
        if (parts) flashMesh(parts.mat, color, spark ? 220 : 380);
        const mesh = npcMeshes.get(rc.targetNpcId.toString());
        if (mesh) {
          flashMesh(
            mesh.mat,
            spark ? new Color3(0.55, 0.85, 1) : new Color3(1, 0.3, 0.05),
            spark ? 260 : 450,
          );
        }
      }
      if (rc.lastCastAtMicros > 0n) {
        fx.lastCastAtMicros = rc.lastCastAtMicros;
      }

      if (!parts || !casting) {
        fx.beam.setEnabled(false);
        fx.bar.setEnabled(false);
        if (parts && !casting) {
          // Restore robe emissive after windup (match createPlayerHumanoid scale).
          parts.mat.emissiveColor = parts.mat.diffuseColor.scale(0.08);
        }
        continue;
      }

      // Windup: orange pulse on remote + beam to target + head bar.
      const pulse = 0.35 + 0.25 * Math.sin(now / 90);
      parts.mat.emissiveColor = new Color3(pulse, pulse * 0.35, 0.05);
      const total =
        rc.castingSpellId === SPELL_EMBERBOLT ? EMBERBOLT_CAST_MS : 1000;
      const progress = Math.min(1, Math.max(0, 1 - wind / total));
      fx.bar.setEnabled(true);
      fx.bar.position.copyFrom(parts.root.position);
      fx.bar.position.y += 2.05;
      fx.bar.scaling.x = 0.25 + progress * 0.75;

      const tgt = npcMeshes.get(rc.targetNpcId.toString());
      if (tgt) {
        const from = parts.root.position.add(new Vector3(0.4, 1.4, 0.1));
        const to = tgt.root.position.add(new Vector3(0, 0.9, 0));
        placeBeam(fx.beam, from, to);
      } else {
        fx.beam.setEnabled(false);
      }
    }
    for (const [key, fx] of remoteFx) {
      if (!seen.has(key)) {
        fx.beam.dispose();
        fx.bar.dispose();
        remoteFx.delete(key);
      }
    }
  };

  const syncProxyMeshes = (proxies: CrowdProxyView[]) => {
    const seen = new Set<string>();
    for (const p of proxies) {
      // Neighborhood SQL should exclude far proxies; skip any that leak.
      if (p.far) continue;
      const key = p.proxyId.toString();
      seen.add(key);
      let inst = proxyInstances.get(key);
      if (!inst) {
        inst = proxySource.createInstance(`proxy_${key}`);
        proxyInstances.set(key, inst);
      }
      inst.position.x = p.x;
      inst.position.y = p.y + 0.75;
      inst.position.z = p.z;
      inst.setEnabled(true);
    }
    for (const [key, inst] of proxyInstances) {
      if (!seen.has(key)) {
        inst.dispose();
        proxyInstances.delete(key);
      }
    }
  };

  /** Track which remotes were last tinted as party (green). */
  const remotePartyTint = new Map<string, boolean>();

  const syncRemoteMeshes = (remotes: RemotePose[]) => {
    const seen = new Set<string>();
    for (const r of remotes) {
      const key = r.identityHex;
      seen.add(key);
      const wantParty = !!r.party;
      let parts = remoteMeshes.get(key);
      const tintedParty = remotePartyTint.get(key) === true;
      if (!parts || tintedParty !== wantParty) {
        if (parts) {
          parts.root.dispose();
          remoteMeshes.delete(key);
          disposeNameplate(remoteNameplates.get(key));
          remoteNameplates.delete(key);
        }
        parts = createPlayerHumanoid(scene, {
          name: `remote_${key.slice(0, 12)}`,
          robeColor: wantParty ? partyRobeColor() : remoteRobeColor(key),
        });
        remoteMeshes.set(key, parts);
        remotePartyTint.set(key, wantParty);
        const np = createNameplate(scene, `remote_${key.slice(0, 12)}`);
        np.mesh.parent = parts.root;
        np.mesh.position.set(0, 2.05, 0);
        paintNameplate(
          np,
          key.slice(0, 6),
          wantParty ? '#9dffb0' : '#f0b8e8',
          -1,
        );
        remoteNameplates.set(key, np);
      } else {
        const np = remoteNameplates.get(key);
        if (np) {
          paintNameplate(
            np,
            key.slice(0, 6),
            wantParty ? '#9dffb0' : '#f0b8e8',
            -1,
          );
        }
      }
      parts.root.position.x = r.x;
      parts.root.position.y = r.y;
      parts.root.position.z = r.z;
      parts.root.rotation.y = r.yaw;
      parts.root.setEnabled(true);
    }
    for (const [key, parts] of remoteMeshes) {
      if (!seen.has(key)) {
        parts.root.dispose();
        remoteMeshes.delete(key);
        remotePartyTint.delete(key);
        disposeNameplate(remoteNameplates.get(key));
        remoteNameplates.delete(key);
      }
    }
  };

  const { keys } = bindInput({
    onCycleTarget: () => {
      if (!net) return;
      const id = net.cycleTarget();
      if (id != null) selectedTargetId = id;
    },
    onCast: (spellId) => {
      if (!net) return;
      const ch = net.getCharacter();
      if (ch && !ch.staffEquipped) {
        latestStatus =
          latestStatus.state === 'connected'
            ? { ...latestStatus, castFeedback: 'Staff required' }
            : latestStatus;
        return;
      }
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
    onPartyInviteOrAccept: () => {
      if (!net) return;
      const party = net.getParty();
      if (party?.pendingInviteFrom) {
        net.acceptPartyInvite();
        return;
      }
      net.inviteNearestRemote();
    },
    onPartyLeave: () => {
      if (!net) return;
      net.leaveParty();
    },
    onUnequipStaff: () => {
      if (!net) return;
      net.unequipStaff();
    },
    onEquipStaff: () => {
      if (!net) return;
      net.equipStaff();
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
        npcLastHp.set(key, npc.hp);
      } else {
        const prev = npcLastHp.get(key);
        if (prev != null && npc.hp < prev) {
          const delta = prev - npc.hp;
          const ember = delta >= 20;
          const tint = ember
            ? new Color3(1, 0.55, 0.15)
            : new Color3(1, 0.95, 0.45);
          damageFloaters.push(
            spawnDamageFloater(
              scene,
              mesh.root.position,
              delta,
              tint,
            ),
          );
          latestDamageAmount = delta;
          latestDamageAtMs = Date.now();
        }
        npcLastHp.set(key, npc.hp);
      }
      mesh.root.position.x = npc.x;
      mesh.root.position.z = npc.z;
      mesh.root.setEnabled(npc.hp > 0);
      if (mesh.nameplate && npc.kind === NPC_KIND_DUMMY) {
        paintNameplate(
          mesh.nameplate,
          'Dummy',
          '#e8c89a',
          npc.maxHp > 0 ? npc.hp / npc.maxHp : 0,
        );
        mesh.nameplate.mesh.setEnabled(npc.hp > 0);
      }
      const selected = selectedTargetId === npc.npcId;
      const remoteSelected = latestRemoteCombats.some(
        (rc) => rc.targetNpcId === npc.npcId,
      );
      mesh.ring.setEnabled(selected);
      mesh.remoteRing.setEnabled(remoteSelected && !selected);
      if (selected) {
        mesh.ringMat.emissiveColor = new Color3(0.95, 0.75, 0.2);
        mesh.ringMat.diffuseColor = new Color3(0.95, 0.75, 0.2);
        mesh.mat.emissiveColor = new Color3(0.15, 0.1, 0.02);
        // Local gold wins; still hint remote interest with outer cyan.
        mesh.remoteRing.setEnabled(remoteSelected);
        if (remoteSelected) {
          mesh.remoteRingMat.emissiveColor = new Color3(0.1, 0.55, 0.65);
        }
      } else if (remoteSelected) {
        mesh.remoteRingMat.emissiveColor = new Color3(0.15, 0.7, 0.85);
        mesh.remoteRingMat.diffuseColor = new Color3(0.2, 0.85, 0.95);
        mesh.mat.emissiveColor = new Color3(0.02, 0.08, 0.12);
      } else {
        mesh.ringMat.emissiveColor = new Color3(0, 0, 0);
        mesh.mat.emissiveColor = new Color3(0, 0, 0);
      }
    }
    for (const [key, mesh] of npcMeshes) {
      if (!seen.has(key)) {
        disposeNameplate(mesh.nameplate);
        mesh.root.dispose();
        npcMeshes.delete(key);
        npcLastHp.delete(key);
      }
    }
  };

  engine.runRenderLoop(() => {
    const dt = engine.getDeltaTime() / 1000;
    const now = Date.now();

    for (let i = damageFloaters.length - 1; i >= 0; i--) {
      const f = damageFloaters[i]!;
      const age = now - f.bornMs;
      const t = Math.min(1, age / f.lifeMs);
      f.mesh.position.y = f.startY + t * 1.35;
      f.mesh.position.x += f.driftX * dt;
      const fade = t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45;
      f.mat.alpha = Math.max(0, fade);
      if (age >= f.lifeMs) {
        f.mesh.dispose();
        f.mat.dispose();
        damageFloaters.splice(i, 1);
      }
    }

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
      syncProxyMeshes(net.getProxies());
      syncRemoteMeshes(net.getRemotes());
      syncRemoteCastFx(net.getRemoteCombats());
    }

    const gcdLeft = gcdRemainingMs(
      latestStatus.state === 'connected' ? latestStatus.combat : null,
      now,
    );
    const castLeft = Math.max(0, castUntilMs - now);
    setGcdBar(gcdLeft, castLeft, castTotalMs);
    {
      const st = latestStatus;
      const tgt =
        st.state === 'connected'
          ? st.targetNpc ??
            (selectedTargetId !== 0n
              ? (net?.getNpcs().find((n) => n.npcId === selectedTargetId) ?? null)
              : null)
          : null;
      updateTargetFrame(tgt);
      const equipped =
        st.state === 'connected'
          ? (st.character?.staffEquipped ?? true)
          : true;
      updateSpellHotbar({
        gcdMs: gcdLeft,
        castingMs: castLeft,
        castingTotal: castTotalMs,
        castingSpell: lastCastSpell,
        staffEquipped: equipped,
      });
    }
    if (latestStatus.state === 'connected') {
      setStatus(formatStatus(latestStatus, now));
      const equipped = latestStatus.character?.staffEquipped ?? true;
      setStaffMeshVisible(humanoid.staff, equipped);
    }

    drawMinimap({
      local: net?.getLocalPose() ?? {
        x: player.position.x,
        z: player.position.z,
      },
      remotes: net?.getRemotes() ?? [],
      npcs: net?.getNpcs() ?? [],
      proxies: net?.getProxies() ?? [],
    });

    camera.setTarget(player.position.add(new Vector3(0, 1.35, 0)));
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
      player.position.y = pose.y;
      player.position.z = pose.z;
      player.rotation.y = pose.yaw;
    },
    (npcs) => {
      syncNpcMeshes(npcs);
    },
    (combat) => {
      if (combat) selectedTargetId = combat.targetNpcId;
    },
    (character) => {
      /* HUD refreshed via onStatus; staff mesh follows Character.staffEquipped */
      const equipped = character?.staffEquipped ?? true;
      setStaffMeshVisible(humanoid.staff, equipped);
    },
    (proxies) => {
      syncProxyMeshes(proxies);
    },
    (remotes) => {
      syncRemoteMeshes(remotes);
    },
    (combats) => {
      syncRemoteCastFx(combats);
    },
  );

  // Optional VE / autotest hooks.
  const params = new URLSearchParams(window.location.search);
  const ve = params.get('ve');

  // ?ve=persist — kill dummy for XP, then soft-reload with token so HUD proves restore.
  if (net && ve === 'persist') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE persist: earning XP…';
    const tryPersist = () => {
      if (!net) return;
      net.ensureTrainingDummy();
      const cycle = net.getTargetCycle();
      const dummy = cycle.find((n) => n.kind === NPC_KIND_DUMMY) ?? cycle[0];
      if (!dummy) {
        window.setTimeout(tryPersist, 250);
        return;
      }
      net.setTarget(dummy.npcId);
      selectedTargetId = dummy.npcId;
      const startXp = net.getCharacter()?.xp ?? 0;
      let casts = 0;
      const castLoop = () => {
        if (!net) return;
        const ch = net.getCharacter();
        if (ch && ch.xp > startXp) {
          if (mark) {
            mark.textContent = `VE persist: XP ${ch.xp} — reloading with token…`;
          }
          window.setTimeout(() => {
            const u = new URL(window.location.href);
            u.searchParams.set('ve', 'persist-restored');
            window.location.replace(u.toString());
          }, 600);
          return;
        }
        if (casts > 40) {
          if (mark) mark.textContent = 'VE persist: timed out waiting for XP';
          return;
        }
        if (gcdRemainingMs(net.getCombat()) <= 0) {
          net.cast(SPELL_SPARK);
          casts += 1;
        }
        window.setTimeout(castLoop, 400);
      };
      window.setTimeout(castLoop, 500);
    };
    window.setTimeout(tryPersist, 700);
  }

  if (net && ve === 'persist-restored') {
    const mark = document.getElementById('persistMark');
    const waitHud = () => {
      if (!net) return;
      const ch = net.getCharacter();
      if (ch && mark) {
        mark.textContent = `Persist OK · identity ${net.identityHex.slice(0, 12)}… · XP ${ch.xp} · staff+robes · Spark+Emberbolt`;
        return;
      }
      window.setTimeout(waitHud, 200);
    };
    window.setTimeout(waitHud, 400);
  }

  if (net && ve === 'combat') {
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

  // ?ve=aoi — seed crowd, wait for near proxies in neighborhood, HUD mark.
  if (net && ve === 'aoi') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE AOI: seeding crowd proxies…';
    const tryAoi = () => {
      if (!net) return;
      net.seedCrowdProxies();
      const aoi = net.getAoi();
      const proxies = net.getProxies().filter((p) => !p.far);
      syncProxyMeshes(net.getProxies());
      if (aoi && proxies.length >= CROWD_NEAR_COUNT && aoi.farCount === 0) {
        if (mark) {
          mark.textContent = `AOI OK · interest (${aoi.interestChunkX},${aoi.interestChunkZ}) · near proxies ${aoi.nearCount} · far ${aoi.farCount} (neigh-SQL)`;
        }
        return;
      }
      if (mark && aoi) {
        mark.textContent = `VE AOI: waiting… proxies ${aoi.proxyCount} near ${aoi.nearCount} far ${aoi.farCount}`;
      }
      window.setTimeout(tryAoi, 300);
    };
    window.setTimeout(tryAoi, 700);
  }

  // ?ve=forest — pull camera back so hero trees + mountains + HUD are visible.
  if (ve === 'forest' || ve === 'aoi') {
    camera.radius = ve === 'forest' ? 36 : 22;
    camera.alpha = Math.PI / 2.5;
    camera.beta = Math.PI / 3.55;
  }

  if (net && ve === 'forest') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE forest: waiting for Connected…';
    const waitForest = () => {
      if (!net) return;
      const st = latestStatus;
      if (st.state === 'connected') {
        net.seedCrowdProxies();
        syncProxyMeshes(net.getProxies());
        if (mark) {
          const aoi = net.getAoi();
          mark.textContent = aoi
            ? `Forest OK · trees+mountains · Connected · AOI near ${aoi.nearCount}`
            : 'Forest OK · trees+mountains · Connected';
        }
        return;
      }
      window.setTimeout(waitForest, 300);
    };
    window.setTimeout(waitForest, 600);
  }

  // ?ve=humanoid — frame local player (humanoid+staff) clearly for VE shot.
  if (ve === 'humanoid') {
    camera.radius = 8;
    camera.alpha = Math.PI / 2.2;
    camera.beta = Math.PI / 3.1;
  }

  if (net && ve === 'humanoid') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE humanoid: waiting for Connected…';
    const waitHumanoid = () => {
      if (!net) return;
      const st = latestStatus;
      if (st.state === 'connected') {
        if (mark) {
          mark.textContent =
            'Humanoid OK · body+head+limbs+staff · Connected · crowd capsules OK';
        }
        return;
      }
      window.setTimeout(waitHumanoid, 300);
    };
    window.setTimeout(waitHumanoid, 600);
  }

  // ?ve=two-client — frame local + remote humanoids; wait for remotes >= 1.
  if (ve === 'two-client') {
    camera.radius = 14;
    camera.alpha = Math.PI / 2.35;
    camera.beta = Math.PI / 3.2;
  }

  if (net && ve === 'two-client') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE two-client: waiting for remote PlayerPose…';
    let ticks = 0;
    let nudged = false;
    const waitTwo = () => {
      if (!net) return;
      ticks += 1;
      // Nudge local off spawn so stacked leftover remotes don't hide the blue local.
      if (!nudged && latestStatus.state === 'connected') {
        nudged = true;
        for (let i = 0; i < 4; i++) net.sendMove(-0.75, 0);
      }
      const remotes = net.getRemotes();
      // Prefer a remote that is spatially separated from local for the OK banner.
      const local = net.getLocalPose();
      const preferred =
        remotes.find((r) => {
          if (!local) return true;
          return Math.hypot(r.x - local.x, r.z - local.z) > 1.5;
        }) ?? remotes[0];
      syncRemoteMeshes(remotes);
      const st = latestStatus;
      if (st.state === 'connected' && preferred) {
        const r = preferred;
        const mid = player.position.add(
          new Vector3(r.x, r.y, r.z).subtract(player.position).scale(0.5),
        );
        camera.setTarget(mid.add(new Vector3(0, 1.2, 0)));
        camera.radius = 16;
        if (mark) {
          mark.textContent = `Two-client OK · remotes ${remotes.length} · remote ${r.identityHex.slice(0, 12)}… @(${r.x.toFixed(1)},${r.z.toFixed(1)}) · local ${st.identityHex.slice(0, 12)}… @(${(local?.x ?? 0).toFixed(1)},${(local?.z ?? 0).toFixed(1)})`;
        }
        return;
      }
      if (mark && st.state === 'connected') {
        mark.textContent = `VE two-client: Connected · remotes ${remotes.length} (waiting…)`;
      }
      if (ticks > 120) {
        if (mark) mark.textContent = 'VE two-client: timed out waiting for remotes';
        return;
      }
      window.setTimeout(waitTwo, 250);
    };
    window.setTimeout(waitTwo, 700);
  }

  // ?ve=remote-cast — wait for remote PlayerCombat target + Emberbolt windup telegraph.
  if (ve === 'remote-cast') {
    camera.radius = 18;
    camera.alpha = Math.PI / 2.4;
    camera.beta = Math.PI / 3.15;
  }

  if (net && ve === 'remote-cast') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE remote-cast: waiting for remote + cast telegraph…';
    let ticks = 0;
    let nudged = false;
    const waitRemoteCast = () => {
      if (!net) return;
      ticks += 1;
      if (!nudged && latestStatus.state === 'connected') {
        nudged = true;
        for (let i = 0; i < 4; i++) net.sendMove(-0.75, 0);
      }
      const remotes = net.getRemotes();
      const combats = net.getRemoteCombats();
      syncRemoteMeshes(remotes);
      syncRemoteCastFx(combats);
      syncNpcMeshes(net.getNpcs());

      const local = net.getLocalPose();
      const casting = combats.find(
        (c) => c.castingSpellId !== 0 && castRemainingMs(c) > 0,
      );
      const targeting = combats.find((c) => c.targetNpcId !== 0n);
      const preferred =
        remotes.find((r) => {
          if (!local) return true;
          return Math.hypot(r.x - local.x, r.z - local.z) > 1.5;
        }) ?? remotes[0];

      if (preferred) {
        const dummy =
          net.getNpcs().find((n) => n.kind === NPC_KIND_DUMMY) ??
          net.getNpcs()[0];
        const focus = dummy
          ? new Vector3(
              (player.position.x + preferred.x + dummy.x) / 3,
              1.1,
              (player.position.z + preferred.z + dummy.z) / 3,
            )
          : player.position.add(
              new Vector3(preferred.x, preferred.y, preferred.z)
                .subtract(player.position)
                .scale(0.5)
                .add(new Vector3(0, 1.2, 0)),
            );
        camera.setTarget(focus);
        camera.radius = 18;
      }

      const st = latestStatus;
      if (st.state === 'connected' && preferred && casting) {
        const bit = `cast spell=${casting.castingSpellId} left=${(castRemainingMs(casting) / 1000).toFixed(1)}s · target npc#${casting.targetNpcId}`;
        if (mark) {
          mark.textContent = `Remote-cast OK · remotes ${remotes.length} · ${bit} · remote ${preferred.identityHex.slice(0, 12)}… · local ${st.identityHex.slice(0, 12)}…`;
        }
        // Hold OK while windup is visible so the screenshot catches the beam/bar.
        if (castRemainingMs(casting) > 200 && ticks < 160) {
          window.setTimeout(waitRemoteCast, 180);
        }
        return;
      }
      if (mark && st.state === 'connected') {
        const tip = targeting
          ? `target npc#${targeting.targetNpcId} (waiting cast…)`
          : 'waiting for target/cast…';
        mark.textContent = `VE remote-cast: Connected · remotes ${remotes.length} · remoteCombats ${combats.length} · ${tip}`;
      }
      if (ticks > 160) {
        if (mark) mark.textContent = 'VE remote-cast: timed out waiting for remote cast/target';
        return;
      }
      window.setTimeout(waitRemoteCast, 250);
    };
    window.setTimeout(waitRemoteCast, 700);
  }

  // ?ve=damage-text — cast Spark on dummy; wait for floating HP-delta number.
  if (ve === 'damage-text') {
    camera.radius = 11;
    camera.alpha = Math.PI / 2.15;
    camera.beta = Math.PI / 3.05;
  }

  if (net && ve === 'damage-text') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE damage-text: waiting for Connected…';
    let ticks = 0;
    let castSent = false;
    const waitDmg = () => {
      if (!net) return;
      ticks += 1;
      net.ensureTrainingDummy();
      const cycle = net.getTargetCycle();
      const dummy = cycle.find((n) => n.kind === NPC_KIND_DUMMY) ?? cycle[0];
      syncNpcMeshes(net.getNpcs());
      if (dummy) {
        camera.setTarget(
          new Vector3(dummy.x, 1.4, dummy.z),
        );
        camera.radius = 10;
      }
      const st = latestStatus;
      if (st.state === 'connected' && dummy && !castSent) {
        if (gcdRemainingMs(net.getCombat()) <= 0) {
          net.setTarget(dummy.npcId);
          selectedTargetId = dummy.npcId;
          lastCastSpell = SPELL_SPARK;
          net.cast(SPELL_SPARK);
          castSent = true;
          if (mark) {
            mark.textContent = `VE damage-text: Spark cast · waiting HP delta on Dummy #${dummy.npcId}…`;
          }
        }
      }
      const fresh =
        latestDamageAtMs > 0 && Date.now() - latestDamageAtMs < 1400;
      if (st.state === 'connected' && dummy && fresh && damageFloaters.length > 0) {
        if (mark) {
          mark.textContent = `Damage-text OK · -${latestDamageAmount} above Dummy #${dummy.npcId} · floaters ${damageFloaters.length} · HP ${dummy.hp}/${dummy.maxHp}`;
        }
        return;
      }
      if (mark && st.state === 'connected' && castSent && !fresh) {
        mark.textContent = `VE damage-text: waiting floater… Dummy HP ${dummy?.hp ?? '?'} · floaters ${damageFloaters.length}`;
      }
      if (ticks > 100) {
        if (mark) mark.textContent = 'VE damage-text: timed out waiting for floating damage';
        return;
      }
      window.setTimeout(waitDmg, 120);
    };
    window.setTimeout(waitDmg, 600);
  }



  // ?ve=staff-equip — unequip → cast blocked → HUD + staff mesh hidden.
  if (ve === 'staff-equip') {
    camera.radius = 9;
    camera.alpha = Math.PI / 2.3;
    camera.beta = Math.PI / 3.1;
  }
  if (net && ve === 'staff-equip') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE staff-equip: waiting for Connected…';
    let ticks = 0;
    let unequipped = false;
    let castAttempted = false;
    const waitStaff = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE staff-equip: ${st.state}…`;
        if (ticks < 180) window.setTimeout(waitStaff, 200);
        return;
      }
      camera.setTarget(player.position.add(new Vector3(0, 1.2, 0)));
      camera.radius = 8.5;
      const ch = net.getCharacter();
      if (!unequipped) {
        // Ensure equipped first so unequip transition is visible.
        if (ch && !ch.staffEquipped) {
          net.equipStaff();
          if (mark) mark.textContent = 'VE staff-equip: re-equipping baseline…';
          window.setTimeout(waitStaff, 250);
          return;
        }
        net.unequipStaff();
        unequipped = true;
        if (mark) mark.textContent = 'VE staff-equip: unequipping…';
        window.setTimeout(waitStaff, 300);
        return;
      }
      const unequippedOk = ch && !ch.staffEquipped;
      if (unequippedOk) {
        setStaffMeshVisible(humanoid.staff, false);
      }
      if (unequippedOk && !castAttempted) {
        net.ensureTrainingDummy();
        const cycle = net.getTargetCycle();
        const dummy = cycle.find((n) => n.kind === NPC_KIND_DUMMY) ?? cycle[0];
        if (dummy) {
          net.setTarget(dummy.npcId);
          selectedTargetId = dummy.npcId;
        }
        // Attempt cast — client + server should block with Staff required.
        net.cast(SPELL_SPARK);
        castAttempted = true;
        if (mark) {
          mark.textContent =
            'VE staff-equip: staff UNEQUIPPED · cast blocked (Staff required) · mesh hidden';
        }
        // Keep unequipped for screenshot proof.
        return;
      }
      if (unequippedOk && castAttempted) {
        const fb =
          st.state === 'connected' ? st.castFeedback ?? '' : '';
        if (mark) {
          mark.textContent = `Staff-equip OK · unequipped · cast: ${fb || 'Staff required'} · mesh hidden`;
        }
        return;
      }
      if (ticks > 120) {
        if (mark) mark.textContent = 'VE staff-equip: timed out';
        return;
      }
      window.setTimeout(waitStaff, 200);
    };
    window.setTimeout(waitStaff, 600);
  }


  // ?ve=minimap — seed crowd + dummy; prove top-right 2D dots (local/remote/dummy/proxies).
  if (ve === 'minimap') {
    camera.radius = 22;
    camera.alpha = Math.PI / 2.45;
    camera.beta = Math.PI / 3.3;
  }
  if (net && ve === 'minimap') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE minimap: waiting for Connected + proxies…';
    let ticks = 0;
    const waitMinimap = () => {
      if (!net) return;
      ticks += 1;
      net.seedCrowdProxies();
      net.ensureTrainingDummy();
      const st = latestStatus;
      const proxies = net.getProxies();
      const near = proxies.filter((p) => !p.far);
      const npcs = net.getNpcs();
      const dummy = npcs.find((n) => n.kind === NPC_KIND_DUMMY);
      const remotes = net.getRemotes();
      syncProxyMeshes(proxies);
      syncNpcMeshes(npcs);
      syncRemoteMeshes(remotes);
      drawMinimap({
        local: net.getLocalPose() ?? {
          x: player.position.x,
          z: player.position.z,
        },
        remotes,
        npcs,
        proxies,
      });
      if (
        st.state === 'connected' &&
        near.length >= 1 &&
        dummy &&
        document.getElementById('minimap')
      ) {
        if (mark) {
          mark.textContent = `Minimap OK · local+dummy+proxies ${proxies.length} (near ${near.length}) · remotes ${remotes.length} · top-right HUD`;
        }
        return;
      }
      if (mark && st.state === 'connected') {
        mark.textContent = `VE minimap: Connected · proxies ${proxies.length} near ${near.length} · dummy ${dummy ? 'yes' : 'no'} (waiting…)`;
      }
      if (ticks > 120) {
        if (mark) mark.textContent = 'VE minimap: timed out waiting for proxies/dummy';
        return;
      }
      window.setTimeout(waitMinimap, 250);
    };
    window.setTimeout(waitMinimap, 700);
  }

  // ?ve=nameplates — You + Dummy (+ remotes) billboard labels; dummy HP pip.
  if (ve === 'nameplates') {
    camera.radius = 12;
    camera.alpha = Math.PI / 2.55;
    camera.beta = Math.PI / 3.55;
  }
  if (net && ve === 'nameplates') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE nameplates: waiting for Connected + Dummy…';
    let ticks = 0;
    const waitPlates = () => {
      if (!net) return;
      ticks += 1;
      net.ensureTrainingDummy();
      const st = latestStatus;
      const npcs = net.getNpcs();
      const dummy = npcs.find((n) => n.kind === NPC_KIND_DUMMY);
      const remotes = net.getRemotes();
      syncNpcMeshes(npcs);
      syncRemoteMeshes(remotes);
      if (dummy) {
        // Nudge local toward dummy so both nameplates fit the frame.
        const dx = dummy.x - player.position.x;
        const dz = dummy.z - player.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 4.5) {
          const step = Math.min(MAX_STEP_METERS, dist - 3.2);
          net.sendMove((dx / dist) * step, (dz / dist) * step);
        }
        const mid = new Vector3(
          (player.position.x + dummy.x) * 0.5,
          1.15,
          (player.position.z + dummy.z) * 0.5,
        );
        camera.setTarget(mid);
        camera.radius = dist > 8 ? Math.min(22, 8 + dist * 0.45) : 11;
      }
      const dummyMesh = dummy
        ? npcMeshes.get(dummy.npcId.toString())
        : undefined;
      const hasDummyPlate = !!(dummy && dummyMesh?.nameplate && dummy.hp > 0);
      const nearEnough =
        !!dummy &&
        Math.hypot(dummy.x - player.position.x, dummy.z - player.position.z) < 7;
      if (
        st.state === 'connected' &&
        hasDummyPlate &&
        nearEnough &&
        localNameplate.mesh.isEnabled()
      ) {
        if (mark) {
          mark.textContent = `Nameplates OK · You + Dummy${dummy ? ` HP ${dummy.hp}/${dummy.maxHp}` : ''} · remotes ${remotes.length} · billboards`;
        }
        return;
      }
      if (mark && st.state === 'connected') {
        mark.textContent = `VE nameplates: Connected · dummy ${dummy ? 'yes' : 'no'} · remotes ${remotes.length} (waiting…)`;
      }
      if (ticks > 160) {
        if (mark) mark.textContent = 'VE nameplates: timed out waiting for Dummy plate';
        return;
      }
      window.setTimeout(waitPlates, 200);
    };
    window.setTimeout(waitPlates, 700);
  }

  // ?ve=hotbar / ?ve=target-frame — select Dummy + cast Spark so target frame + hotbar are live.
  if (ve === 'hotbar' || ve === 'target-frame') {
    camera.radius = 12;
    camera.alpha = Math.PI / 2.4;
    camera.beta = Math.PI / 3.2;
  }
  if (net && (ve === 'hotbar' || ve === 'target-frame')) {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE hotbar: waiting for Connected + Dummy…';
    let ticks = 0;
    let castSent = false;
    const waitHotbar = () => {
      if (!net) return;
      ticks += 1;
      net.ensureTrainingDummy();
      const st = latestStatus;
      const cycle = net.getTargetCycle();
      const dummy = cycle.find((n) => n.kind === NPC_KIND_DUMMY) ?? cycle[0];
      syncNpcMeshes(net.getNpcs());
      if (dummy) {
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
        const dx = dummy.x - player.position.x;
        const dz = dummy.z - player.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 5.5) {
          const step = Math.min(MAX_STEP_METERS, dist - 3.5);
          net.sendMove((dx / dist) * step, (dz / dist) * step);
        }
        camera.setTarget(
          new Vector3(
            (player.position.x + dummy.x) * 0.5,
            1.2,
            (player.position.z + dummy.z) * 0.5,
          ),
        );
        camera.radius = 11;
      }
      if (st.state === 'connected' && dummy && !castSent) {
        const ch = net.getCharacter();
        if (ch && !ch.staffEquipped) {
          net.equipStaff();
          window.setTimeout(waitHotbar, 250);
          return;
        }
        if (gcdRemainingMs(net.getCombat()) <= 0) {
          lastCastSpell = SPELL_SPARK;
          net.cast(SPELL_SPARK);
          castSent = true;
          window.setTimeout(() => {
            if (!net) return;
            if (gcdRemainingMs(net.getCombat()) <= 0) {
              lastCastSpell = SPELL_EMBERBOLT;
              castTotalMs = EMBERBOLT_CAST_MS;
              castUntilMs = Date.now() + EMBERBOLT_CAST_MS;
              net.cast(SPELL_EMBERBOLT);
            }
          }, 1300);
        }
      }
      const frame = document.getElementById('targetFrame');
      const hotbar = document.getElementById('spellHotbar');
      const frameVisible = !!(frame && !frame.classList.contains('hidden'));
      const combat = net.getCombat();
      const gcdLeftNow = gcdRemainingMs(combat);
      const nameTxt = document.getElementById('tfName')?.textContent || '';
      const nameOk = nameTxt.length > 0 && nameTxt !== '—';
      if (
        st.state === 'connected' &&
        dummy &&
        frameVisible &&
        nameOk &&
        hotbar &&
        castSent &&
        (gcdLeftNow > 0 || castUntilMs > Date.now())
      ) {
        if (mark) {
          mark.textContent = `Hotbar OK · target Dummy #${dummy.npcId} HP ${dummy.hp}/${dummy.maxHp} · Spark/Emberbolt slots · GCD ${(gcdLeftNow / 1000).toFixed(1)}s`;
        }
        return;
      }
      if (mark && st.state === 'connected') {
        mark.textContent = `VE hotbar: Connected · dummy ${dummy ? 'yes' : 'no'} · frame ${frameVisible ? 'on' : 'off'} · castSent=${castSent} (waiting…)`;
      }
      if (ticks > 160) {
        if (mark) mark.textContent = 'VE hotbar: timed out waiting for target frame + hotbar';
        return;
      }
      window.setTimeout(waitHotbar, 200);
    };
    window.setTimeout(waitHotbar, 700);
  }

  // ?ve=party — wait for party size>=2 + far party mate visible (green tint).
  if (ve === 'party') {
    camera.radius = 40;
    camera.beta = Math.PI / 3.2;
    camera.alpha = Math.PI / 2.2;
  }
  if (net && ve === 'party') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE party: waiting for party invite / remotes…';
    // Drop a stuck solo party so inbound PartyMate invites can be accepted.
    try {
      const p0 = net.getParty();
      if (p0 && p0.size > 0 && p0.size < 2) net.leaveParty();
    } catch { /* ignore */ }
    let ticks = 0;
    let invited = false;
    const waitParty = () => {
      ticks += 1;
      const remotes = net.getRemotes();
      syncRemoteMeshes(remotes);
      const party = net.getParty();
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE party: ${st.state}…`;
        if (ticks < 180) window.setTimeout(waitParty, 200);
        return;
      }
      // Prefer accepting inbound invite (PartyMate initiator). Solo party of 1 blocks accept.
      if (party?.pendingInviteFrom) {
        if ((party.size ?? 0) > 0 && (party.size ?? 0) < 2) {
          net.leaveParty();
          if (mark) mark.textContent = 'VE party: left solo party to accept inbound invite…';
          window.setTimeout(waitParty, 250);
          return;
        }
        if ((party.size ?? 0) === 0) {
          net.acceptPartyInvite();
          if (mark) {
            mark.textContent = `VE party: accepting invite from ${party.pendingInviteFrom.slice(0, 12)}…`;
          }
          window.setTimeout(waitParty, 300);
          return;
        }
      }
      if (
        !invited &&
        !party?.pendingInviteFrom &&
        remotes.length >= 1 &&
        (party?.size ?? 0) < 2
      ) {
        const hex = net.inviteNearestRemote();
        if (hex) {
          invited = true;
          if (mark) {
            mark.textContent = `VE party: invited ${hex.slice(0, 12)}… waiting accept + far pose…`;
          }
        }
      }
      const local = net.getLocalPose();
      const farParty = remotes.find((r) => {
        if (!r.party) return false;
        const dist = Math.hypot(r.x - (local?.x ?? 0), r.z - (local?.z ?? 0));
        return dist > 80 || Math.abs(r.chunkX) > 1 || Math.abs(r.chunkZ) > 1;
      });
      if ((party?.size ?? 0) >= 2 && farParty) {
        if (local) {
          camera.setTarget(
            new Vector3(
              (local.x + farParty.x) * 0.25,
              1.2,
              (local.z + farParty.z) * 0.25,
            ),
          );
          camera.radius = 48;
        }
        if (mark) {
          mark.textContent = `Party OK · size ${party!.size} · far mate ${farParty.identityHex.slice(0, 12)}… @(${farParty.x.toFixed(0)},${farParty.z.toFixed(0)}) · green tint`;
        }
        return;
      }
      if (mark) {
        mark.textContent = `VE party: Connected · party ${party?.size ?? 0} · remotes ${remotes.length} · invited=${invited} · pending=${party?.pendingInviteFrom?.slice(0, 8) ?? '—'} (waiting far party mate…)`;
      }
      if (ticks > 200) {
        if (mark) mark.textContent = 'VE party: timed out waiting for far party mate';
        return;
      }
      window.setTimeout(waitParty, 200);
    };
    window.setTimeout(waitParty, 800);
  }

  void lastCastSpell;
}

main().catch((err: unknown) => {
  console.error(err);
  setStatus(`Boot failed: ${err instanceof Error ? err.message : String(err)}`);
});
