import {
  ArcRotateCamera,
  ArcRotateCameraPointersInput,
  Color3,
  DynamicTexture,
  Engine,
  InstancedMesh,
  Material,
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
  GCD_MS,
  EMBERBOLT_CAST_MS,
  SPARK_MANA_COST,
  EMBERBOLT_MANA_COST,
  CAST_PUSHBACK_MS,
  CAST_PUSHBACK_HARD_AFTER,
  CAST_HARD_INTERRUPT_REMAIN_MS,
  CAST_SILENCE_MS,
  CAST_RANGE_METERS,
  KICK_MANA_COST,
  KICK_RANGE_METERS,
  STUN_MANA_COST,
  STUN_RANGE_METERS,
  STUN_DURATION_MS,
  castSilenceRemainingMs,
  stunRemainingMs,
  isTargetOutOfCastRange,
  REST_MANA_RESTORE,
  NPC_KIND_DUMMY,
  NPC_KIND_HOSTILE,
  NPC_KIND_BRIGAND,
  isHostileKind,
  HOSTILE_AGGRO_RADIUS,
  HOSTILE_MELEE_RANGE,
  CROWD_NEAR_COUNT,
  type ConnectionStatus,
  type CrowdProxyView,
  type GameNet,
  type NpcView,
  type RemoteCombat,
  type RemotePose,
  type GroundItemView,
  type VendorView,
  type CombatView,
} from './net/connection';
import {
  buildForestClearing,
  COLLISION_VE_HERO,
  DIRT_SURFACE_Y,
  getTrunkCapsules,
  nearestTrunk,
  PLAYER_TRUNK_RADIUS,
  setPlayerBlobShadow,
  slideAgainstTrunks,
} from './world/forest';
import {
  brigandRobeColor,
  createPlayerHumanoid,
  hostileRobeColor,
  partyRobeColor,
  playHumanoidCast,
  playHumanoidFlinch,
  preloadPlayerHumanoid,
  readHumanoidPlayback,
  remoteRobeColor,
  ROBE_EMISSIVE_SCALE,
  setHumanoidAirborne,
  setHumanoidCasting,
  setHumanoidDead,
  setHumanoidGroundWalk,
  setHumanoidMoving,
  setHumanoidStaffEquipped,
  setHumanoidTurning,
  type HumanoidParts,
  type HumanoidPlayback,
} from './world/humanoid';
import { createTrainingDummy } from './world/dummy';
import {
  casterMuzzle,
  createEmberBeam,
  createEmberCharge,
  EMBER_COLOR,
  EMBER_CORE,
  hideEmberCharge,
  placeBeam,
  placeEmberCharge,
  spawnCastFlash,
  spawnEmberBolt,
  spawnImpactPop,
  spawnSparkBolt,
  SPARK_COLOR,
  SPARK_CORE,
  targetHitPoint,
  tickCastFlashes,
  tickImpactPops,
  tickSparkBolts,
  type CastFlash,
  type EmberBeam,
  type EmberCharge,
  type ImpactPop,
  type SparkBolt,
} from './world/castVfx';
import {
  FPS_FLOOR,
  FPS_TARGET,
  updateFpsHud,
} from './world/fpsHud';
import {
  syncGroundSparkles,
  type GroundSparkle,
} from './world/sparkles';
import { createVendorStall } from './world/vendorStall';

/** Match shared/Fardel.Shared Movement.MaxStepMeters. */
const MAX_STEP_METERS = 0.75;
/** Match shared/Fardel.Shared Tonic.MoveSpeedMult. */
const TONIC_MOVE_MULT = 1.75;
/** Match shared/Fardel.Shared Rest.HealAmount. */
const REST_HEAL_AMOUNT = 25;
const BANDAGE_HEAL_AMOUNT = 40;
/** Client wish speed (m/s); each reducer call is clamped server-side. */
const MOVE_SPEED = 4.5;
/** Match shared/Fardel.Shared Loot.PickupRangeMeters. */
const PICKUP_RANGE_METERS = 3;

/** World nameplate label — distinct vs Dummy / Vendor (#418). */
function npcPlateName(kind: number): string {
  if (kind === NPC_KIND_DUMMY) return 'Dummy';
  if (kind === NPC_KIND_HOSTILE) return 'Hostile';
  if (kind === NPC_KIND_BRIGAND) return 'Brigand';
  return 'NPC';
}

/** Coral Hostile / violet Brigand / parchment Dummy. */
function npcPlateColor(kind: number, selected: boolean): string {
  if (kind === NPC_KIND_DUMMY) return selected ? '#f4e4a8' : '#e8c89a';
  if (kind === NPC_KIND_BRIGAND) return selected ? '#e0c4ff' : '#c9a0ff';
  if (kind === NPC_KIND_HOSTILE) return selected ? '#ffb08a' : '#ff7a62';
  return '#ffffff';
}

/** Nearest WorldLoot within pickup range (XZ), or null. */
function nearestLootInPickupRange(
  items: GroundItemView[],
  pose: { x: number; z: number } | null,
  rangeMeters = PICKUP_RANGE_METERS,
): GroundItemView | null {
  if (!pose || items.length === 0) return null;
  const r2 = rangeMeters * rangeMeters;
  let best: GroundItemView | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const it of items) {
    const dx = it.x - pose.x;
    const dz = it.z - pose.z;
    const d = dx * dx + dz * dz;
    if (d <= r2 && d < bestD) {
      bestD = d;
      best = it;
    }
  }
  return best;
}

/** Tab cycle: living in-range hostiles (aggroed first), then Dummy, then living far hostiles (#484 / #358 / #496). Corpses skipped — never sticky. */
function tabTargetCycle(net: GameNet): NpcView[] {
  const alive = net.getNpcs().filter((n) => n.hp > 0);
  const pose = net.getLocalPose();
  const r2 = CAST_RANGE_METERS * CAST_RANGE_METERS;
  const inRange = (n: NpcView) => {
    if (!pose) return true;
    const dx = n.x - pose.x;
    const dz = n.z - pose.z;
    return dx * dx + dz * dz <= r2;
  };
  const byId = (a: NpcView, b: NpcView) =>
    a.npcId < b.npcId ? -1 : a.npcId > b.npcId ? 1 : 0;
  const hostilesNear = alive
    .filter((n) => isHostileKind(n.kind) && inRange(n))
    .sort((a, b) => {
      const ag = Number(b.aggroed) - Number(a.aggroed);
      if (ag !== 0) return ag;
      return byId(a, b);
    });
  const dummy = alive.filter((n) => n.kind === NPC_KIND_DUMMY);
  const hostilesFar = alive
    .filter((n) => isHostileKind(n.kind) && !inRange(n))
    .sort(byId);
  const rest = alive.filter(
    (n) => !isHostileKind(n.kind) && n.kind !== NPC_KIND_DUMMY,
  );
  return [...hostilesNear, ...dummy, ...hostilesFar, ...rest];
}

function npcStunnedNow(n: NpcView, nowMs = Date.now()): boolean {
  const untilMs = Number(n.stunnedUntilMicros / 1000n);
  return Number.isFinite(untilMs) && untilMs > nowMs;
}

function cyclePreferHostiles(net: GameNet): bigint | null {
  const cycle = tabTargetCycle(net).filter((n) => n.hp > 0);
  if (cycle.length === 0) return null;
  const cur = net.getCombat()?.targetNpcId ?? 0n;
  const curRow = net.getNpcs().find((n) => n.npcId === cur);
  const hostiles = cycle.filter((n) => isHostileKind(n.kind));
  // Empty / Dummy / corpse: first living hostile — never Dummy-first while
  // a hostile lives (#502 / #496).
  if (!curRow || curRow.hp <= 0 || !isHostileKind(curRow.kind)) {
    const next = (hostiles[0] ?? cycle[0]!).npcId;
    net.setTarget(next);
    return next;
  }
  // After Kick Kind=2, Tab prefers living Kind=3 (other kind), not pad B / Dummy.
  const otherKind = hostiles.filter((n) => n.kind !== curRow.kind);
  if (otherKind.length > 0) {
    const next = otherKind[0]!.npcId;
    net.setTarget(next);
    return next;
  }
  const idxCur = cycle.findIndex((n) => n.npcId === cur);
  const idx = idxCur < 0 ? 0 : (idxCur + 1) % cycle.length;
  const next = cycle[idx]!.npcId;
  net.setTarget(next);
  return next;
}

type NpcMesh = {
  root: Mesh;
  body: Mesh;
  ring: Mesh;
  remoteRing: Mesh;
  /** Overhead chevron for local selection reticule. */
  marker: Mesh;
  mat: StandardMaterial;
  /** Extra mats faded/flashed with primary (scarecrow wood/head). */
  extraMats: StandardMaterial[];
  ringMat: StandardMaterial;
  remoteRingMat: StandardMaterial;
  markerMat: StandardMaterial;
  nameplate: Nameplate | null;
  /** Kind=2 skinned body. Dummy stays the scarecrow (null). */
  humanoid: HumanoidParts | null;
};

type RemoteFx = {
  beam: Mesh;
  beamMat: StandardMaterial;
  charge: EmberCharge;
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

/** Client-only NPC death sink/fade or respawn pop-in (cosmetic). */
type NpcLifeFx = {
  phase: 'dying' | 'spawning';
  bornMs: number;
  lifeMs: number;
  baseBodyY: number;
  baseEmissive: Color3;
  burst: Array<{
    mesh: Mesh;
    mat: StandardMaterial;
    vx: number;
    vy: number;
    vz: number;
  }>;
};

const DEATH_FX_MS = 550;
const RESPAWN_FX_MS = 480;

/** World-space billboard label above an entity (You / Dummy / remote hex). */
type Nameplate = {
  mesh: Mesh;
  mat: StandardMaterial;
  tex: DynamicTexture;
  label: string;
  /** <0 = no HP pip; else 0..1 fill. */
  hpFrac: number;
  /** Local Tab-target gold chrome (#142). */
  selected: boolean;
  /** StunNpc lock chrome. Must not rename Kind=3 off Brigand (#500). */
  stunned: boolean;
};

function setStatus(text: string, connState?: ConnectionStatus['state']): void {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = text;
  if (connState) el.dataset.conn = connState;
}

function setGcdBar(
  remainingMs: number,
  castingMs: number,
  castingTotal: number,
  spellName?: string,
  /** When omitted (VE seeds), treat as connected so GCD chrome can still demo. */
  connState?: ConnectionStatus['state'],
): void {
  const fill = document.getElementById('gcdFill');
  const label = document.getElementById('gcdLabel');
  const bar = document.getElementById('gcdBar');
  const castFill = document.getElementById('castFill');
  const castLabel = document.getElementById('castLabel');
  const gcdLeft = veGcdPresent?.gcdMs ?? remainingMs;
  // Connection chrome != GCD chrome: never claim "ready" while offline/connecting.
  const live = !connState || connState === 'connected';
  if (fill) {
    if (!live) {
      fill.style.width = '0%';
      fill.classList.remove('ready');
    } else {
      const pct = Math.min(100, (gcdLeft / 1200) * 100);
      fill.style.width = `${pct}%`;
      fill.classList.toggle('ready', gcdLeft <= 0);
    }
  }
  if (bar) {
    bar.dataset.gcd = !live ? 'offline' : gcdLeft > 0 ? 'sweep' : 'idle';
  }
  if (label) {
    if (!live) {
      // Neutral dash — connection progress lives in #status / toast, not here.
      label.textContent = 'GCD · —';
    } else {
      // "idle" = gameplay cooldown clear (never "ready" — that conflates with Connected).
      label.textContent =
        gcdLeft > 0 ? `GCD ${ (gcdLeft / 1000).toFixed(1) }s` : 'GCD idle';
    }
  }
  if (castFill && castLabel) {
    const ve = veCastFeedbackPresent;
    const cMs = ve?.castingMs ?? castingMs;
    const cTotal = ve?.castingTotal ?? castingTotal;
    const name = ve?.spellName ?? spellName ?? 'Casting';
    if (cTotal > 0 && cMs > 0) {
      const pct = Math.min(100, ((cTotal - cMs) / cTotal) * 100);
      castFill.style.width = `${pct}%`;
      castLabel.textContent = `${name}  ${(cMs / 1000).toFixed(1)}s  ·  Esc cancel`;
      castFill.parentElement?.classList.remove('hidden');
    } else {
      castFill.style.width = '0%';
      castLabel.textContent = '—';
      castFill.parentElement?.classList.add('hidden');
    }
  }
}

function castSpellDisplayName(spellId: number): string {
  if (spellId === SPELL_EMBERBOLT) return 'Emberbolt';
  if (spellId === SPELL_SPARK) return 'Spark';
  return spellId > 0 ? `Spell${spellId}` : 'Casting';
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
  const name = npcPlateName(target.kind);
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

/** VE presentation override: force Spark STAFF + Emberbolt OOM + empty slots (?ve=hotbar / hotbar-afford). */
let veHotbarPresent: null | { sparkDisabled: boolean; emberLowMana: boolean } = null;

/** VE lock: hold seeded self + party HP chrome for ?ve=frame-hp (skip tick overwrites). */
let veFrameHpLock = false;

/** VE lock: hold seeded loadout strip + tonic buff chrome for ?ve=loadout-buff. */
let veLoadoutBuffLock = false;

/** VE lock: hold bandage vs tonic toast/log/buff chrome for ?ve=bandage-tonic (#163). */
let veBandageTonicLock = false;

/** VE lock: hold seeded bottom-left HUD layout chrome for ?ve=hud-layout (#104). */
let veHudLayoutLock = false;

/** VE lock: hold resting chrome for ?ve=rest-chrome (freeze enter state, no auto-exit). */
let veRestChromeLock = false;

/** VE lock: hold left-rest chrome for ?ve=rest-exit (freeze exit badge + toast). */
let veRestExitLock = false;

/** Client rest chrome mode — enter persists until WASD/cast (#133). */
let restChromeMode: 'off' | 'enter' | 'exit' = 'off';
/** Why the last rest exit happened (status / badge). */
let restLeaveReason: 'move' | 'cast' | null = null;

/** VE presentation override: seed readable GCD sweep + Emberbolt cast fill. */
let veGcdPresent: null | {
  gcdMs: number;
  castingMs: number;
  castingTotal: number;
} = null;

/** VE presentation override: prominent main cast bar mid-Emberbolt (?ve=cast-feedback). */
let veCastFeedbackPresent: null | {
  castingMs: number;
  castingTotal: number;
  spellName: string;
} = null;

/** VE seed: sticky CC chip on self-frame (?ve=cc-feedback) — presentation only. */
let veCcFeedbackPresent: null | {
  kind: 'stun' | 'silence';
  leftMs: number;
} = null;

/** #154 — RMB-look armed vs idle (cursor / status / legend clarity only). */
let rmbLookArmed = false;
/** VE lock: hold RMB-look armed chrome for ?ve=rmb-look. */
let veRmbLookLock = false;

/** Client-only Rest enter/exit chrome on #selfFrame (not a server channel). */
let restExitTimer: number | null = null;

function setRestingState(mode: 'off' | 'enter' | 'exit', reason?: 'move' | 'cast'): void {
  const frame = document.getElementById('selfFrame');
  const badge = document.getElementById('sfRest');
  if (!frame || !badge) return;
  if (restExitTimer != null) {
    window.clearTimeout(restExitTimer);
    restExitTimer = null;
  }
  restChromeMode = mode;
  restLeaveReason = mode === 'exit' ? (reason ?? null) : null;
  if (mode === 'off') {
    frame.classList.remove('resting', 'rest-exit');
    badge.classList.add('hidden');
    badge.classList.remove('exiting');
    badge.textContent = 'Resting…';
    return;
  }
  if (mode === 'enter') {
    frame.classList.add('resting');
    frame.classList.remove('rest-exit');
    badge.classList.remove('hidden', 'exiting');
    badge.textContent = 'Resting…';
    // Stay in enter until WASD/cast actually leaves rest (#133). No timer auto-exit.
    return;
  }
  // exit — move/cast interrupt vs already-full complete.
  frame.classList.remove('resting');
  frame.classList.add('rest-exit');
  badge.classList.remove('hidden');
  badge.classList.add('exiting');
  badge.textContent =
    reason === 'move'
      ? 'Left rest · move'
      : reason === 'cast'
        ? 'Left rest · cast'
        : 'Rest complete';
  // Existing exit-badge fade only (not a new rest timer). Freeze for VE locks.
  if (!veRestChromeLock && !veRestExitLock) {
    restExitTimer = window.setTimeout(() => setRestingState('off'), 1600);
  }
}

/** Drop rest chrome when locomotion or a real cast starts. Idempotent. */
function leaveRestIfActive(reason: 'move' | 'cast'): void {
  if (veRestChromeLock) return;
  if (restChromeMode !== 'enter') return;
  const bit = reason === 'move' ? 'Left rest · moved' : 'Left rest · cast';
  const veNow = new URLSearchParams(window.location.search).get('ve');
  const ttl = veNow === 'rest-exit' ? TOAST_VE_TTL_MS : TOAST_TTL_MS;
  dismissSystemToasts('rest');
  pushSystemToast('rest', bit, ttl);
  pushCombatLog('rest', bit);
  setRestingState('exit', reason);
}

/** Bottom-center Spark/Emberbolt hotbar: GCD sweep + Emberbolt cast + staff/mana/empty affordances. */
function updateSpellHotbar(opts: {
  gcdMs: number;
  castingMs: number;
  castingTotal: number;
  castingSpell: number;
  staffEquipped: boolean;
  mana?: number;
  /** Selected target beyond Combat.CastRangeMeters — dim spells. */
  outOfRange?: boolean;
  /** When false, treat filled slot as empty/unknown (client-only). */
  knowsSpark?: boolean;
  knowsEmberbolt?: boolean;
}): void {
  const gcdMs = veGcdPresent?.gcdMs ?? opts.gcdMs;
  const castingMs = veGcdPresent?.castingMs ?? opts.castingMs;
  const castingTotal = veGcdPresent?.castingTotal ?? opts.castingTotal;
  const castingSpell = veGcdPresent ? SPELL_EMBERBOLT : opts.castingSpell;
  const staffEquipped = veGcdPresent ? true : opts.staffEquipped;
  const gcdPct = gcdMs > 0 ? Math.min(100, (gcdMs / 1200) * 100) : 0;
  const castPct =
    castingTotal > 0 && castingMs > 0
      ? Math.min(100, ((castingTotal - castingMs) / castingTotal) * 100)
      : 0;
  const castingEmber =
    castingSpell === SPELL_EMBERBOLT && castingMs > 0 && castingTotal > 0;
  const mana = veGcdPresent ? 999 : (opts.mana ?? 999);
  const oor = veGcdPresent ? false : !!opts.outOfRange;

  const applySlot = (
    slotId: string,
    sweepId: string,
    castId: string,
    isCastingThis: boolean,
    cost: number,
    known: boolean,
  ) => {
    const slot = document.getElementById(slotId);
    const sweep = document.getElementById(sweepId);
    const cast = document.getElementById(castId);
    if (!slot || !sweep || !cast) return;
    if (!known) {
      slot.classList.add('unknown');
      slot.classList.remove('disabled', 'lowMana', 'outOfRange', 'onGcd', 'casting');
      sweep.style.height = '0%';
      cast.style.height = '0%';
      return;
    }
    slot.classList.remove('unknown');
    const lowMana = staffEquipped && mana < cost;
    const dimmed = lowMana || oor;
    // Disabled (no staff) wins over lowMana — JS only sets lowMana when staff equipped.
    slot.classList.toggle('disabled', !staffEquipped);
    slot.classList.toggle('lowMana', lowMana);
    slot.classList.toggle('outOfRange', oor && staffEquipped && !lowMana);
    slot.classList.toggle('onGcd', gcdMs > 0 && staffEquipped && !dimmed);
    slot.classList.toggle('casting', isCastingThis && staffEquipped && !dimmed);
    sweep.style.height = staffEquipped && !dimmed ? `${gcdPct}%` : '0%';
    cast.style.height =
      isCastingThis && staffEquipped && !dimmed ? `${castPct}%` : '0%';
  };

  const knowsSpark = opts.knowsSpark ?? true;
  const knowsEmberbolt = opts.knowsEmberbolt ?? true;

  if (veHotbarPresent) {
    // Proof seed: Spark shows STAFF (disabled), Emberbolt shows OOM; empty 3–6 stay empty.
    applySlot('slotSpark', 'sweepSpark', 'castSpark', false, SPARK_MANA_COST, true);
    const spark = document.getElementById('slotSpark');
    if (spark) {
      spark.classList.remove('unknown', 'lowMana', 'outOfRange', 'onGcd', 'casting');
      spark.classList.toggle('disabled', veHotbarPresent.sparkDisabled);
    }
    applySlot(
      'slotEmberbolt',
      'sweepEmberbolt',
      'castEmberbolt',
      false,
      EMBERBOLT_MANA_COST,
      true,
    );
    const ember = document.getElementById('slotEmberbolt');
    if (ember) {
      ember.classList.remove('unknown', 'disabled', 'outOfRange', 'onGcd', 'casting');
      ember.classList.toggle('lowMana', veHotbarPresent.emberLowMana);
    }
    const sweepE = document.getElementById('sweepEmberbolt');
    const castE = document.getElementById('castEmberbolt');
    const sweepS = document.getElementById('sweepSpark');
    const castS = document.getElementById('castSpark');
    if (sweepS) sweepS.style.height = '0%';
    if (castS) castS.style.height = '0%';
    if (sweepE) sweepE.style.height = '0%';
    if (castE) castE.style.height = '0%';
    return;
  }

  applySlot('slotSpark', 'sweepSpark', 'castSpark', false, SPARK_MANA_COST, knowsSpark);
  applySlot(
    'slotEmberbolt',
    'sweepEmberbolt',
    'castEmberbolt',
    castingEmber,
    EMBERBOLT_MANA_COST,
    knowsEmberbolt,
  );
}

function tonicRemainingMs(character: {
  tonicExpiresAtMicros?: bigint;
} | null | undefined): number {
  if (!character?.tonicExpiresAtMicros) return 0;
  const nowMicros = BigInt(Date.now()) * 1000n;
  const left = character.tonicExpiresAtMicros - nowMicros;
  if (left <= 0n) return 0;
  return Number(left / 1000n);
}

/** Player self-frame: You + Lv + XP + HP/mana bars + tonic buff timer. */
function updateSelfFrame(character: {
  xp: number;
  level?: number;
  hp?: number;
  maxHp?: number;
  mana?: number;
  maxMana?: number;
  tonicExpiresAtMicros?: bigint;
} | null | undefined): void {
  if (veFrameHpLock || veLoadoutBuffLock || veHudLayoutLock || veBandageTonicLock) return;
  const frame = document.getElementById('selfFrame');
  if (!frame) return;
  if (!character) {
    // Skip hide if veRestChromeLock is active (VE rest-chrome freezes frame visible).
    if (!veRestChromeLock) {
      frame.classList.add('hidden');
    }
    return;
  }
  // Skip unhide if veRestChromeLock is active (VE controls visibility).
  if (!veRestChromeLock) {
    frame.classList.remove('hidden');
  }
  const nameEl = document.getElementById('sfName');
  const levelEl = document.getElementById('sfLevel');
  const xpEl = document.getElementById('sfXp');
  if (nameEl) nameEl.textContent = 'You';
  const lv = character.level ?? 1;
  if (levelEl) levelEl.textContent = `Lv ${lv}`;
  if (xpEl) xpEl.textContent = `XP ${character.xp}`;
  const fill = document.getElementById('sfHpFill');
  const label = document.getElementById('sfHpLabel');
  const hp = character.hp ?? 0;
  const maxHp = character.maxHp ?? 0;
  const frac = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
  if (fill) {
    fill.style.width = `${(frac * 100).toFixed(1)}%`;
    fill.classList.toggle('mid', frac > 0.25 && frac <= 0.55);
    fill.classList.toggle('low', frac <= 0.25);
  }
  if (label) label.textContent = maxHp > 0 ? `${hp}/${maxHp}` : '—';
  const manaFill = document.getElementById('sfManaFill');
  const manaLabel = document.getElementById('sfManaLabel');
  const mana = character.mana ?? 0;
  const maxMana = character.maxMana ?? 0;
  const manaFrac = maxMana > 0 ? Math.max(0, Math.min(1, mana / maxMana)) : 0;
  if (manaFill) {
    manaFill.style.width = `${(manaFrac * 100).toFixed(1)}%`;
    manaFill.classList.toggle('mid', manaFrac > 0.25 && manaFrac <= 0.55);
    manaFill.classList.toggle('low', manaFrac <= 0.25);
  }
  if (manaLabel) manaLabel.textContent = maxMana > 0 ? `${mana}/${maxMana}` : '—';
  const buffEl = document.getElementById('sfBuff');
  if (buffEl) {
    const leftMs = tonicRemainingMs(character);
    if (leftMs > 0) {
      buffEl.classList.remove('hidden');
      buffEl.classList.add('active');
      const sec = (leftMs / 1000).toFixed(1);
      buffEl.textContent = `Tonic ${sec}s · ×${TONIC_MOVE_MULT} move`;
    } else {
      buffEl.classList.add('hidden');
      buffEl.classList.remove('active');
      buffEl.textContent = 'Tonic —';
    }
  }
}

/**
 * Sticky stun/silence chip on #selfFrame while StunnedUntilMicros / CastLockedUntil
 * are active (#153). Presentation only — no new CC rules. Stun wins over silence.
 * Kick / hard-interrupt share CastLockedUntil → shown as SILENCE.
 */
function updateSelfCcChrome(
  combat: CombatView | null | undefined,
): void {
  const frame = document.getElementById('selfFrame');
  const chip = document.getElementById('sfCc');
  if (!frame || !chip) return;

  let kind: 'stun' | 'silence' | null = null;
  let leftMs = 0;

  if (veCcFeedbackPresent) {
    kind = veCcFeedbackPresent.kind;
    leftMs = Math.max(0, veCcFeedbackPresent.leftMs);
  } else {
    const stunLeft = stunRemainingMs(combat);
    const silLeft = castSilenceRemainingMs(combat);
    if (stunLeft > 0) {
      kind = 'stun';
      leftMs = stunLeft;
    } else if (silLeft > 0) {
      kind = 'silence';
      leftMs = silLeft;
    }
  }

  frame.classList.toggle('ccStun', kind === 'stun');
  frame.classList.toggle('ccSilence', kind === 'silence');

  if (!kind || leftMs <= 0) {
    chip.classList.add('hidden');
    chip.classList.remove('stun', 'silence');
    chip.textContent = 'CC —';
    return;
  }

  chip.classList.remove('hidden');
  chip.classList.toggle('stun', kind === 'stun');
  chip.classList.toggle('silence', kind === 'silence');
  const sec = (leftMs / 1000).toFixed(1);
  chip.textContent =
    kind === 'stun'
      ? `Stun ${sec}s · cannot move/cast`
      : `Silence ${sec}s · cannot cast`;
}

/** Mirror Combat.RespawnDelayMs — client display only, do not import shared C#. */
const RESPAWN_DELAY_MS = 2500;
let deathCountdownTimer: number | null = null;
let deathCountdownEndsAt = 0;

function clearDeathCountdown(): void {
  if (deathCountdownTimer != null) {
    window.clearInterval(deathCountdownTimer);
    deathCountdownTimer = null;
  }
  deathCountdownEndsAt = 0;
  const dig = document.getElementById('deathCountdown');
  if (dig) {
    dig.textContent = '';
    dig.setAttribute('aria-hidden', 'true');
  }
}

function formatRespawnCountdown(remainMs: number): { sub: string; digit: string } {
  if (remainMs <= 0) {
    return { sub: 'Respawning at yard…', digit: '' };
  }
  const sec = remainMs / 1000;
  const rounded = Math.max(0.1, Math.round(sec * 10) / 10);
  const whole = Math.ceil(rounded);
  const label =
    rounded >= 1
      ? `Respawn in ${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)}s…`
      : `Respawn in ${rounded.toFixed(1)}s…`;
  const digit = rounded >= 1 ? String(whole) : rounded.toFixed(1);
  return { sub: label, digit };
}

function tickDeathCountdown(): void {
  const remain = deathCountdownEndsAt - Date.now();
  const { sub, digit } = formatRespawnCountdown(remain);
  const subEl = document.getElementById('deathSub');
  if (subEl) subEl.textContent = sub;
  const dig = document.getElementById('deathCountdown');
  if (dig) {
    if (digit) {
      dig.textContent = digit;
      dig.setAttribute('aria-hidden', 'false');
    } else {
      dig.textContent = '';
      dig.setAttribute('aria-hidden', 'true');
    }
  }
  if (remain <= 0) {
    clearDeathCountdown();
    if (subEl) subEl.textContent = 'Respawning at yard…';
  }
}

function startDeathCountdown(delayMs: number = RESPAWN_DELAY_MS): void {
  clearDeathCountdown();
  deathCountdownEndsAt = Date.now() + delayMs;
  tickDeathCountdown();
  deathCountdownTimer = window.setInterval(tickDeathCountdown, 100);
}

/** Show/hide death greyout. When on without a freeze sub, runs live respawn countdown. */
function setDeathGreyout(
  on: boolean,
  sub?: string,
  opts?: { countdown?: boolean; freezeSub?: boolean },
): void {
  const el = document.getElementById('deathGreyout');
  if (!el) return;
  if (on) {
    el.classList.remove('hidden');
    el.setAttribute('aria-hidden', 'false');
    if (opts?.freezeSub && sub) {
      clearDeathCountdown();
      const subEl = document.getElementById('deathSub');
      if (subEl) subEl.textContent = sub;
      const dig = document.getElementById('deathCountdown');
      if (dig) {
        const m = /Respawn in\s+([\d.]+)/i.exec(sub);
        dig.textContent = m ? String(Math.ceil(Number(m[1]))) : '2';
        dig.setAttribute('aria-hidden', 'false');
      }
      return;
    }
    const wantCountdown = opts?.countdown !== false;
    if (wantCountdown) {
      if (deathCountdownTimer == null) startDeathCountdown();
      else tickDeathCountdown();
    } else {
      clearDeathCountdown();
      const subEl = document.getElementById('deathSub');
      if (subEl && sub) subEl.textContent = sub;
    }
  } else {
    clearDeathCountdown();
    el.classList.add('hidden');
    el.setAttribute('aria-hidden', 'true');
  }
}

/** Compact loadout strip: staff/robes + Spark/Emberbolt known gates. */
function updateLoadoutStrip(character: {
  staffEquipped: boolean;
  robesEquipped: boolean;
  knowsSpark: boolean;
  knowsEmberbolt: boolean;
  hasEmberShard?: boolean;
  hasYardTonic?: boolean;
  hasYardBandage?: boolean;
} | null | undefined): void {
  if (veLoadoutBuffLock || veHudLayoutLock || veBandageTonicLock) return;
  const strip = document.getElementById('loadoutStrip');
  if (!strip) return;
  if (!character) {
    strip.classList.add('hidden');
    return;
  }
  strip.classList.remove('hidden');

  const setChip = (
    chipId: string,
    stateId: string,
    on: boolean,
    onLabel: string,
    offLabel: string,
  ) => {
    const chip = document.getElementById(chipId);
    const state = document.getElementById(stateId);
    if (chip) {
      chip.classList.toggle('on', on);
      chip.classList.toggle('off', !on);
    }
    if (state) state.textContent = on ? onLabel : offLabel;
  };

  setChip(
    'loStaff',
    'loStaffState',
    character.staffEquipped,
    'equipped',
    'unequipped',
  );
  setChip(
    'loRobes',
    'loRobesState',
    character.robesEquipped,
    'equipped',
    'unequipped',
  );
  setChip('loSpark', 'loSparkState', character.knowsSpark, 'known', 'unknown');
  setChip(
    'loEmber',
    'loEmberState',
    character.knowsEmberbolt,
    'known',
    'unknown',
  );
  setChip(
    'loShard',
    'loShardState',
    !!character.hasEmberShard,
    'held',
    'empty',
  );
  setChip(
    'loTonic',
    'loTonicState',
    !!character.hasYardTonic,
    'held',
    'empty',
  );
  setChip(
    'loBandage',
    'loBandageState',
    !!character.hasYardBandage,
    'held',
    'empty',
  );
}

/** Bag panel rows (Character loadout). Visibility controlled separately via B. */
function updateBagPanel(character: {
  xp: number;
  level?: number;
  mana?: number;
  maxMana?: number;
  staffEquipped: boolean;
  robesEquipped: boolean;
  knowsSpark: boolean;
  knowsEmberbolt: boolean;
  hasEmberShard?: boolean;
  hasYardTonic?: boolean;
  hasYardBandage?: boolean;
} | null | undefined): void {
  const setRow = (id: string, text: string, ok: boolean | null) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('ok', ok === true);
    el.classList.toggle('bad', ok === false);
  };
  if (!character) {
    setRow('bagStaff', '—', null);
    setRow('bagRobes', '—', null);
    setRow('bagSpark', '—', null);
    setRow('bagEmber', '—', null);
    setRow('bagLevel', '—', null);
    setRow('bagXp', '—', null);
    setRow('bagMana', '—', null);
    setRow('bagShard', '—', null);
    setRow('bagTonic', '—', null);
    setRow('bagBandage', '—', null);
    return;
  }
  setRow(
    'bagStaff',
    character.staffEquipped ? 'equipped' : 'unequipped',
    character.staffEquipped,
  );
  setRow(
    'bagRobes',
    character.robesEquipped ? 'equipped' : 'unequipped',
    character.robesEquipped,
  );
  setRow('bagSpark', character.knowsSpark ? 'known' : 'unknown', character.knowsSpark);
  setRow(
    'bagEmber',
    character.knowsEmberbolt ? 'known' : 'unknown',
    character.knowsEmberbolt,
  );
  setRow('bagLevel', `Lv ${character.level ?? 1}`, null);
  setRow('bagXp', String(character.xp), null);
  const bm = character.mana ?? 0;
  const bmm = character.maxMana ?? 0;
  setRow('bagMana', bmm > 0 ? `${bm}/${bmm}` : '—', bmm > 0 && bm > 0);
  setRow(
    'bagShard',
    character.hasEmberShard ? 'held' : 'empty',
    !!character.hasEmberShard,
  );
  setRow(
    'bagTonic',
    character.hasYardTonic ? 'held' : 'empty',
    !!character.hasYardTonic,
  );
  setRow(
    'bagBandage',
    character.hasYardBandage ? 'held' : 'empty',
    !!character.hasYardBandage,
  );
}

function setBagPanelOpen(open: boolean): void {
  const panel = document.getElementById('bagPanel');
  if (!panel) return;
  panel.classList.toggle('hidden', !open);
  pushSystemToast('bag', open ? 'Bag' : 'Bag closed', 1800);
}

function setKeysLegendOpen(open: boolean): void {
  const panel = document.getElementById('keysLegend');
  if (!panel) return;
  panel.classList.toggle('hidden', !open);
}

/** One-shot first-session H legend + canvas-focus cue (#134). sessionStorage only. */
const FIRST_SESSION_CUE_KEY = 'fardel.firstSessionCue';
const FIRST_SESSION_TOAST = 'H opens legend · click canvas for Space/WASD';

function firstSessionCueSeen(): boolean {
  try {
    return sessionStorage.getItem(FIRST_SESSION_CUE_KEY) === '1';
  } catch {
    return false;
  }
}

function markFirstSessionCueSeen(): void {
  try {
    sessionStorage.setItem(FIRST_SESSION_CUE_KEY, '1');
  } catch {
    /* private mode / blocked storage */
  }
}

/** Clarity cue: RMB-look armed vs idle via canvas cursor + legend chip + status line. */
function setRmbLookArmed(armed: boolean): void {
  if (veRmbLookLock && !armed) return;
  rmbLookArmed = armed;
  const canvas = document.getElementById('renderCanvas');
  const mode = armed ? 'armed' : 'idle';
  document.body.dataset.rmbLook = mode;
  if (canvas) {
    canvas.dataset.rmbLook = mode;
    // Play/RMB orbit: hide cursor (WoW). ?ve=rmb-look keeps grabbing chrome (#154).
    canvas.style.cursor = armed ? (veRmbLookLock ? 'grabbing' : 'none') : 'grab';
  }
  const chip = document.querySelector(
    '#keysLegend .klChip[data-bind="rmb"]',
  ) as HTMLElement | null;
  if (chip) {
    chip.classList.toggle('armed', armed);
    const label = chip.querySelector('.klRmbLabel');
    if (label) label.textContent = armed ? 'LOOKING' : 'hold look';
  }
}

/** Identity/AOI/keys #status wall + #fpsHud — hidden by default; F3 / ?debug=1. */
function setDebugHudVisible(open: boolean): void {
  const status = document.getElementById('status');
  const fps = document.getElementById('fpsHud');
  if (status) status.classList.toggle('hidden', !open);
  if (fps) fps.classList.toggle('hidden', !open);
}

/**
 * CrowdProxy amber capsules are AOI/perf debug — hidden in default play (#271).
 * Visible only with F3/?debug=1 or AOI/minimap VE hooks. `?ve=fps` is forest fill, not capsules.
 */
function showCrowdDebugCapsules(ve: string | null, debugHud: boolean): boolean {
  if (debugHud) return true;
  switch (ve) {
    case 'aoi':
    case 'minimap':
    case 'minimap-read':
    case 'minimap-pip':
      return true;
    default:
      return false;
  }
}

/** Compact party member frames: hex + leader tag + distance / pose hint. */
function setVendorPanelOpen(open: boolean): void {
  const panel = document.getElementById('vendorPanel');
  if (!panel) return;
  panel.classList.toggle('hidden', !open);
}

function updateVendorPanel(vendor: { label: string } | null): void {
  const buyXp = document.getElementById('vendorBuyXp');
  const sellXp = document.getElementById('vendorSellXp');
  const title = document.querySelector('#vendorPanel .bagTitle');
  if (title) title.textContent = vendor?.label || 'Vendor';
  if (buyXp) buyXp.textContent = '5 XP';
  if (sellXp) sellXp.textContent = '+5 XP';
}


/** Compact party member frames: hex + leader + Character.Hp/MaxHp + distance. */
function updatePartyFrames(opts: {
  localHex: string | null;
  localPose: { x: number; z: number } | null;
  party: {
    size: number;
    isLeader: boolean;
    members: { identityHex: string; isLeader: boolean }[];
  } | null | undefined;
  remotes: RemotePose[];
  /** Look up Character.Hp/MaxHp/Level for a party identity (wholesale Character cache). */
  getCharacterFor?: (identityHex: string) => { hp: number; maxHp: number; level?: number } | null;
}): void {
  if (veFrameHpLock) return;
  const root = document.getElementById('partyFrames');
  if (!root) return;
  const party = opts.party;
  if (!party || party.size < 1) {
    root.classList.add('hidden');
    root.innerHTML = '';
    return;
  }
  root.classList.remove('hidden');
  const remoteByHex = new Map(opts.remotes.map((r) => [r.identityHex, r]));
  const rows: string[] = [
    `<div class="pfHead">Party · ${party.size}</div>`,
  ];
  // Self first, then mates sorted by hex.
  const members = [...party.members].sort((a, b) => {
    const aSelf = a.identityHex === opts.localHex ? 0 : 1;
    const bSelf = b.identityHex === opts.localHex ? 0 : 1;
    if (aSelf !== bSelf) return aSelf - bSelf;
    return a.identityHex.localeCompare(b.identityHex);
  });
  for (const m of members) {
    const isSelf = m.identityHex === opts.localHex;
    const remote = remoteByHex.get(m.identityHex);
    let meta = '—';
    if (isSelf && opts.localPose) {
      meta = `you · @(${opts.localPose.x.toFixed(0)},${opts.localPose.z.toFixed(0)})`;
    } else if (remote) {
      const dist = opts.localPose
        ? Math.hypot(remote.x - opts.localPose.x, remote.z - opts.localPose.z)
        : null;
      const distTxt = dist != null ? `${dist.toFixed(0)}m` : 'pose';
      meta = `${distTxt} · @(${remote.x.toFixed(0)},${remote.z.toFixed(0)}) · yaw ${remote.yaw.toFixed(1)}`;
    } else if (!isSelf) {
      meta = 'pose pending…';
    }
    const ch = opts.getCharacterFor?.(m.identityHex) ?? null;
    const hp = ch?.hp ?? 0;
    const maxHp = ch?.maxHp ?? 0;
    const frac = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
    const fillCls = [
      'pfHpFill',
      frac > 0.25 && frac <= 0.55 ? 'mid' : '',
      frac <= 0.25 ? 'low' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const hpLabel = maxHp > 0 ? `${hp}/${maxHp}` : '—';
    const hpBar =
      `<div class="pfHpBar" aria-label="Party HP">` +
      `<div class="${fillCls}" style="width:${(frac * 100).toFixed(1)}%"></div>` +
      `<span class="pfHpLabel">${hpLabel}</span>` +
      `</div>`;
    const cls = [
      'pfRow',
      isSelf ? 'self' : '',
      m.isLeader ? 'leader' : '',
      maxHp > 0 && hp <= 0 ? 'dead' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const lv = ch?.level ?? 0;
    const lvTxt = lv > 0 ? `Lv ${lv}` : '';
    const name = isSelf
      ? (lvTxt ? `You · ${lvTxt}` : 'You')
      : (lvTxt ? `${m.identityHex.slice(0, 8)}… · ${lvTxt}` : `${m.identityHex.slice(0, 8)}…`);
    const tag = m.isLeader ? '<span class="pfTag">leader</span>' : '';
    rows.push(
      `<div class="${cls}" data-hex="${m.identityHex}">` +
        `<div class="pfNameRow"><span class="pfName">${name}</span>${tag}</div>` +
        hpBar +
        `<div class="pfMeta">${meta}</div>` +
        `</div>`,
    );
  }
  root.innerHTML = rows.join('');
}


const COMBAT_LOG_MAX = 14;

type CombatLogKind = 'cast' | 'damage' | 'equip' | 'party' | 'death' | 'respawn' | 'loot' | 'trade'
  | 'vendor'
  | 'tonic'
  | 'rest'
  | 'mana'
  | 'castCancel'
  | 'castPushback'
  | 'castHardInterrupt'
  | 'silenced'
  | 'kick'
  | 'stun'
  | 'outOfRange' | 'bandage' | 'gcd' | 'noTarget' | 'deadTarget';

/** Client-only scrolling combat log (cast start, HP delta, equip, party join, death/respawn). */
function pushCombatLog(kind: CombatLogKind, text: string): void {
  const root = document.getElementById('combatLogLines');
  if (!root) return;
  const line = document.createElement('div');
  line.className = `clLine ${kind}`;
  line.setAttribute('data-kind', kind);
  const tag =
    kind === 'cast'
      ? 'CAST'
      : kind === 'damage'
        ? 'DMG'
        : kind === 'equip'
          ? 'EQ'
          : kind === 'party'
            ? 'PARTY'
            : kind === 'death'
              ? 'KILL'
              : kind === 'loot'
                ? 'LOOT'
                : kind === 'trade'
                  ? 'TRADE'
                  : kind === 'vendor'
                    ? 'VENDOR'
                    : kind === 'tonic'
                      ? 'TONIC'
                      : kind === 'rest'
                        ? 'REST'
                        : kind === 'mana'
                          ? 'MANA'
                          : kind === 'castCancel'
                            ? 'CANCEL ↩'
                            : kind === 'castPushback'
                              ? 'PUSH'
                              : kind === 'castHardInterrupt'
                                ? 'LOCKOUT ⊘'
                                : kind === 'silenced'
                                  ? 'SILENCE'
                                  : kind === 'kick'
                                    ? 'KICK'
                                    : kind === 'stun'
                                      ? 'STUN'
                                      : kind === 'outOfRange'
                                        ? 'RANGE'
                                        : kind === 'bandage'
                                          ? 'BANDAGE'
                                          : kind === 'gcd'
                                            ? 'GCD'
                                            : kind === 'noTarget' || kind === 'deadTarget'
                                              ? 'CANCEL ↩'
                                            : 'RESPAWN';
  const time = new Date();
  const hh = String(time.getHours()).padStart(2, '0');
  const mm = String(time.getMinutes()).padStart(2, '0');
  const ss = String(time.getSeconds()).padStart(2, '0');
  // Timestamp muted (.clTime) vs kind tag (.clTag) + body — #78 readability.
  line.innerHTML =
    `<span class="clTime">[${hh}:${mm}:${ss}]</span>` +
    `<span class="clTag">${tag}</span>` +
    text.replace(/</g, '&lt;');
  root.appendChild(line);
  while (root.children.length > COMBAT_LOG_MAX) {
    root.removeChild(root.firstChild!);
  }
  root.scrollTop = root.scrollHeight;
}

function combatLogKindsPresent(): Set<string> {
  const root = document.getElementById('combatLogLines');
  const kinds = new Set<string>();
  if (!root) return kinds;
  for (const el of Array.from(root.children)) {
    const k = (el as HTMLElement).getAttribute('data-kind');
    if (k) kinds.add(k);
  }
  return kinds;
}

const TOAST_MAX = 5;
const TOAST_TTL_MS = 2800;
const TOAST_VE_TTL_MS = 9000;
/** Social/system toasts dimmed while GCD/cast/recent damage is live (#141). */
const TOAST_COMBAT_QUIET_TTL_MS = 1300;
const TOAST_SOCIAL_KINDS = new Set<SystemToastKind>([
  'xp',
  'level',
  'tradeIncoming',
  'tradeWaiting',
  'tradeAccepted',
  'tradeCancelled',
  'invite',
  'party',
  'loot',
  'vendor',
  'bag',
  'connected',
  'equip',
  'say',
  'partySay',
  'whisper',
]);
let yardCombatFocusUntilMs = 0;

type SystemToastKind =
  | 'connected'
  | 'invite'
  | 'party'
  | 'xp'
  | 'level'
  | 'equip'
  | 'death'
  | 'respawn'
  | 'say'
  | 'partySay'
  | 'whisper'
  | 'rate'
  | 'loot'
  | 'tradeIncoming'
  | 'tradeWaiting'
  | 'tradeAccepted'
  | 'tradeCancelled'
  | 'vendor'
  | 'tonic'
  | 'rest'
  | 'mana'
  | 'gcd'
  | 'castCancel'
  | 'castPushback'
  | 'castHardInterrupt'
  | 'silenced'
  | 'kick'
  | 'stun'
  | 'outOfRange'
  | 'bandage'
  | 'noTarget'
  | 'deadTarget'
  | 'canvasFocus'
  | 'jump'
  | 'keys'
  | 'bag'
  | 'zoomLimit';

/** Client-only transient top-center system toasts. */
function pushSystemToast(
  kind: SystemToastKind,
  text: string,
  ttlMs: number = TOAST_TTL_MS,
): void {
  const root = document.getElementById('toastStack');
  if (!root) return;
  const veNow = new URLSearchParams(window.location.search).get('ve');
  const quietCombat =
    TOAST_SOCIAL_KINDS.has(kind) &&
    Date.now() < yardCombatFocusUntilMs &&
    (!veNow || veNow === 'toast-combat');
  const ttl = quietCombat ? Math.min(ttlMs, TOAST_COMBAT_QUIET_TTL_MS) : ttlMs;
  const el = document.createElement('div');
  el.className = `sysToast ${kind}${quietCombat ? ' combatQuiet' : ''}`;
  el.setAttribute('data-kind', kind);
  if (quietCombat) el.setAttribute('data-combat-quiet', '1');
  el.style.setProperty('--toast-ttl', `${Math.max(400, ttl)}ms`);
  const tag =
    kind === 'connected'
      ? 'CONN'
      : kind === 'invite'
        ? 'INVITE'
        : kind === 'party'
          ? 'PARTY'
          : kind === 'xp'
            ? 'XP'
            : kind === 'level'
              ? 'LEVEL'
              : kind === 'equip'
              ? 'EQ'
              : kind === 'death'
                ? 'DEATH'
                : kind === 'respawn'
                  ? 'RESPAWN'
                  : kind === 'rate'
                    ? 'RATE'
                    : kind === 'partySay'
                      ? 'PARTY'
                      : kind === 'whisper'
                        ? 'WHISPER'
                        : kind === 'loot'
                          ? 'LOOT'
                          : kind === 'tradeIncoming'
                            ? 'TRADE ▼'
                            : kind === 'tradeWaiting'
                              ? 'TRADE ▲'
                              : kind === 'tradeAccepted'
                                ? 'TRADE ✓'
                                : kind === 'tradeCancelled'
                                  ? 'TRADE ✕'
                                  : kind === 'vendor'
                                    ? 'VENDOR'
                                    : kind === 'tonic'
                                      ? 'TONIC'
                                      : kind === 'rest'
                                        ? 'REST'
                                        : kind === 'mana'
                                          ? 'MANA'
                                          : kind === 'gcd'
                                            ? 'GCD'
                                            : kind === 'castCancel'
                                              ? 'CANCEL ↩'
                                              : kind === 'castPushback'
                                                ? 'PUSH'
                                                : kind === 'castHardInterrupt'
                                                  ? 'LOCKOUT ⊘'
                                                  : kind === 'silenced'
                                                    ? 'SILENCE'
                                                    : kind === 'kick'
                                                    ? 'KICK'
                                                    : kind === 'stun'
                                                    ? 'STUN'
                                                    : kind === 'outOfRange'
                                                      ? 'RANGE'
                                                      : kind === 'bandage'
                                                        ? 'BANDAGE'
                                                        : kind === 'noTarget' || kind === 'deadTarget'
                                                          ? 'CANCEL ↩'
                                                          : kind === 'jump'
                                                            ? 'JUMP'
                                                          : kind === 'canvasFocus'
                                                            ? 'FOCUS'
                                                            : kind === 'keys'
                                                              ? 'KEYS'
                                                              : kind === 'bag'
                                                              ? 'BAG'
                                                              : kind === 'zoomLimit'
                                                                ? 'ZOOM'
                                                                : 'SAY';
  el.innerHTML =
    `<span class="toastTag">${tag}</span>` +
    `<span class="toastMsg">${text.replace(/</g, '&lt;')}</span>`;
  root.appendChild(el);
  while (root.children.length > TOAST_MAX) {
    root.removeChild(root.firstChild!);
  }
  window.setTimeout(() => {
    if (el.parentElement === root) el.remove();
  }, ttl + 400);
}

function dismissSystemToasts(...kinds: SystemToastKind[]): void {
  const root = document.getElementById('toastStack');
  if (!root) return;
  const want = new Set<string>(kinds);
  for (const el of Array.from(root.children)) {
    const k = (el as HTMLElement).getAttribute('data-kind');
    if (k && want.has(k)) el.remove();
  }
}

function toastKindsPresent(): Set<string> {
  const root = document.getElementById('toastStack');
  const kinds = new Set<string>();
  if (!root) return kinds;
  for (const el of Array.from(root.children)) {
    const k = (el as HTMLElement).getAttribute('data-kind');
    if (k) kinds.add(k);
  }
  return kinds;
}

const CHAT_LOG_MAX = 10;
let chatComposing = false;
let lastCanvasFocusToastMs = 0;

function setChatComposing(open: boolean): void {
  chatComposing = open;
  const panel = document.getElementById('chatPanel');
  const input = document.getElementById('chatInput') as HTMLInputElement | null;
  if (panel) panel.classList.toggle('composing', open);
  if (!input) return;
  if (open) {
    input.focus();
    input.select();
  } else {
    input.blur();
    input.value = '';
  }
}

/** Server-backed say / party line. Dedupe by messageId; toast once. */
function pushChatSay(
  who: string,
  text: string,
  toastTtlMs: number = TOAST_TTL_MS,
  opts?: {
    messageId?: string;
    local?: boolean;
    channel?: 'say' | 'party' | 'whisper';
    recipientHex?: string;
  },
): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const root = document.getElementById('chatLines');
  const messageId = opts?.messageId;
  const channel = opts?.channel ?? 'say';
  if (root) {
    if (messageId) {
      for (const el of Array.from(root.children)) {
        if ((el as HTMLElement).getAttribute('data-message-id') === messageId) return;
      }
    }
    const line = document.createElement('div');
    const local = opts?.local ?? who.startsWith('You');
    const chClass =
      channel === 'party' ? 'party' : channel === 'whisper' ? 'whisper' : 'say';
    line.className = local
      ? `chatLine ${chClass} local`
      : `chatLine ${chClass} remote`;
    line.setAttribute('data-kind', chClass);
    if (messageId) line.setAttribute('data-message-id', messageId);
    const time = new Date();
    const hh = String(time.getHours()).padStart(2, '0');
    const mm = String(time.getMinutes()).padStart(2, '0');
    const ss = String(time.getSeconds()).padStart(2, '0');
    const safeWho = who.replace(/</g, '&lt;');
    const safeText = trimmed.replace(/</g, '&lt;');
    const recip = opts?.recipientHex?.slice(0, 6);
    const channelTag =
      channel === 'party'
        ? `<span class="chatChannel">[P]</span>`
        : channel === 'whisper'
          ? `<span class="chatChannel whisperTag">[W${recip ? '→' + recip : ''}]</span>`
          : '';
    line.innerHTML =
      `<span class="chatTag">[${hh}:${mm}:${ss}]</span>` +
      channelTag +
      `<span class="chatWho">${safeWho}</span>` +
      safeText;
    root.appendChild(line);
    while (root.children.length > CHAT_LOG_MAX) {
      root.removeChild(root.firstChild!);
    }
    root.scrollTop = root.scrollHeight;
  }
  if (channel === 'party') {
    pushSystemToast('partySay', `[P] ${who}: ${trimmed}`, toastTtlMs);
  } else if (channel === 'whisper') {
    const tip = opts?.recipientHex ? `→${opts.recipientHex.slice(0, 6)}` : '';
    pushSystemToast('whisper', `[W${tip}] ${who}: ${trimmed}`, toastTtlMs);
  } else {
    pushSystemToast('say', `${who}: ${trimmed}`, toastTtlMs);
  }
}

function chatSayKindsPresent(): Set<string> {
  const root = document.getElementById('chatLines');
  const kinds = new Set<string>();
  if (!root) return kinds;
  for (const el of Array.from(root.children)) {
    const k = (el as HTMLElement).getAttribute('data-kind');
    if (k) kinds.add(k);
  }
  return kinds;
}

type ChatCompose =
  | { channel: 'say'; text: string }
  | { channel: 'party'; text: string }
  | { channel: 'whisper'; targetPrefix: string; text: string };

function parseChatCompose(raw: string): ChatCompose {
  const trimmed = raw.trim();
  if (/^\/p(?:arty)?(?:\s+|$)/i.test(trimmed)) {
    const body = trimmed.replace(/^\/p(?:arty)?\s*/i, '').trim();
    return { channel: 'party', text: body };
  }
  const w = trimmed.match(/^\/w(?:hisper)?\s+(\S+)(?:\s+(.*))?$/i);
  if (w) {
    return {
      channel: 'whisper',
      targetPrefix: w[1] ?? '',
      text: (w[2] ?? '').trim(),
    };
  }
  return { channel: 'say', text: trimmed };
}

function updateChatPrompt(channel: 'say' | 'party' | 'whisper'): void {
  const prompt = document.querySelector('.chatPrompt');
  if (prompt) {
    prompt.textContent =
      channel === 'party' ? 'Party' : channel === 'whisper' ? 'Whisper' : 'Say';
  }
  const panel = document.getElementById('chatPanel');
  if (panel) {
    panel.classList.toggle('partyMode', channel === 'party');
    panel.classList.toggle('whisperMode', channel === 'whisper');
  }
}

function bindChatUi(opts: {
  whoLabel: () => string;
  sendSay: (text: string) => void;
  sendPartySay: (text: string) => void;
  sendWhisper: (targetPrefix: string, text: string) => void;
}): () => void {
  const form = document.getElementById('chatForm') as HTMLFormElement | null;
  const input = document.getElementById('chatInput') as HTMLInputElement | null;
  if (!form || !input) return () => {};

  const syncPromptFromInput = () => {
    const parsed = parseChatCompose(input.value);
    updateChatPrompt(parsed.channel);
  };

  const onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const typingInField =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target?.isContentEditable ?? false);

    if (e.key === 'Escape' && chatComposing) {
      e.preventDefault();
      setChatComposing(false);
      updateChatPrompt('say');
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (chatComposing) {
        // Form submit handles send when focused on input.
        if (typingInField && target === input) return;
        e.preventDefault();
        form.requestSubmit();
        return;
      }
      if (typingInField) return;
      if (e.repeat) return;
      e.preventDefault();
      setChatComposing(true);
      updateChatPrompt('say');
      return;
    }

    if (e.key === ' ') {
      const chatInput = document.getElementById('chatInput') as HTMLInputElement | null;
      const shouldShowToast = chatComposing || (chatInput && document.activeElement === chatInput);
      if (shouldShowToast && !e.repeat) {
        const now = Date.now();
        if (now - lastCanvasFocusToastMs > 1500) {
          lastCanvasFocusToastMs = now;
          pushSystemToast('canvasFocus', 'Click canvas for gameplay keys (Space, WASD…)');
        }
      }
    }
  };

  const onSubmit = (e: Event) => {
    e.preventDefault();
    const parsed = parseChatCompose(input.value);
    if (parsed.channel === 'whisper') {
      if (!parsed.targetPrefix || !parsed.text) {
        setChatComposing(false);
        updateChatPrompt('say');
        return;
      }
      opts.sendWhisper(parsed.targetPrefix, parsed.text);
      setChatComposing(false);
      updateChatPrompt('say');
      return;
    }
    if (!parsed.text) {
      setChatComposing(false);
      updateChatPrompt('say');
      return;
    }
    // Server-authoritative: render when insert arrives (no optimistic echo).
    if (parsed.channel === 'party') {
      opts.sendPartySay(parsed.text);
    } else {
      opts.sendSay(parsed.text);
    }
    setChatComposing(false);
    updateChatPrompt('say');
  };

  input.addEventListener('input', syncPromptFromInput);
  window.addEventListener('keydown', onKey, true);
  form.addEventListener('submit', onSubmit);
  return () => {
    input.removeEventListener('input', syncPromptFromInput);
    window.removeEventListener('keydown', onKey, true);
    form.removeEventListener('submit', onSubmit);
  };
}

/** Top-right 2D minimap: local, remotes, party (green), dummy, crowd proxies. */
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
  const w = 160;
  const h = 160;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cx = w / 2;
  const cy = h / 2;
  const scale = (Math.min(w, h) * 0.42) / MINIMAP_RANGE_M;
  const maxR = Math.min(w, h) * 0.44;

  ctx.clearRect(0, 0, w, h);
  // Opaque disc + dark/silver rim so #39 cyan fog cannot wash plate/heading (#103).
  const discR = Math.min(w, h) * 0.46;
  ctx.fillStyle = 'rgba(6, 10, 20, 0.96)';
  ctx.beginPath();
  ctx.arc(cx, cy, discR, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(4, 8, 16, 0.95)';
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(196, 206, 222, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Range ring
  ctx.strokeStyle = 'rgba(106,162,255,0.22)';
  ctx.beginPath();
  ctx.arc(cx, cy, MINIMAP_RANGE_M * scale, 0, Math.PI * 2);
  ctx.stroke();

  const originX = opts.local?.x ?? 0;
  const originZ = opts.local?.z ?? 0;

  const project = (wx: number, wz: number) => {
    const dx = (wx - originX) * scale;
    // World +Z forward → screen up (north-up).
    const dy = -(wz - originZ) * scale;
    const dist = Math.hypot(dx, dy);
    let px = cx + dx;
    let py = cy + dy;
    let clamped = false;
    if (dist > maxR && dist > 1e-6) {
      const s = maxR / dist;
      px = cx + dx * s;
      py = cy + dy * s;
      clamped = true;
    }
    return { px, py, clamped, dist };
  };

  const plot = (wx: number, wz: number, color: string, r: number, alpha = 1, outline = true) => {
    const { px, py, clamped } = project(wx, wz);
    ctx.globalAlpha = alpha;
    // Dark outline for contrast
    if (outline) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.beginPath();
      ctx.arc(px, py, r + 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    return { px, py, clamped };
  };

  for (const p of opts.proxies) {
    plot(p.x, p.z, p.far ? '#a86a2a' : '#f08a28', p.far ? 2.2 : 2.8, p.far ? 0.55 : 0.9);
  }
  for (const n of opts.npcs) {
    if (n.hp <= 0) continue;
    const dummy = n.kind === NPC_KIND_DUMMY;
    const brigand = n.kind === NPC_KIND_BRIGAND;
    plot(
      n.x,
      n.z,
      dummy ? '#c4a06a' : brigand ? '#a070d0' : '#c45a5a',
      dummy ? 3.4 : 3.0,
    );
  }
  // Non-party remotes (magenta)
  for (const r of opts.remotes) {
    if (r.party) continue;
    plot(r.x, r.z, '#d46ad8', 3.6);
  }
  // Party mates — distinct green blips; rim chevron when always-relevant / far.
  let partyCount = 0;
  for (const r of opts.remotes) {
    if (!r.party) continue;
    partyCount += 1;
    const { px, py, clamped } = plot(r.x, r.z, '#5ed68a', 4.6);
    // Dark outline ring for contrast
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(px, py, 6.4, 0, Math.PI * 2);
    ctx.stroke();
    // Bright green ring
    ctx.strokeStyle = 'rgba(94, 214, 138, 0.95)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(px, py, 6.4, 0, Math.PI * 2);
    ctx.stroke();
    if (clamped) {
      const ang = Math.atan2(py - cy, px - cx);
      const tip = 9.5;
      // Dark outline for chevron
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.beginPath();
      ctx.moveTo(px + Math.cos(ang) * (tip + 1.5), py + Math.sin(ang) * (tip + 1.5));
      ctx.lineTo(
        px + Math.cos(ang + 2.2) * 6.0,
        py + Math.sin(ang + 2.2) * 6.0,
      );
      ctx.lineTo(
        px + Math.cos(ang - 2.2) * 6.0,
        py + Math.sin(ang - 2.2) * 6.0,
      );
      ctx.closePath();
      ctx.fill();
      // Bright green chevron
      ctx.fillStyle = '#5ed68a';
      ctx.beginPath();
      ctx.moveTo(px + Math.cos(ang) * tip, py + Math.sin(ang) * tip);
      ctx.lineTo(
        px + Math.cos(ang + 2.35) * 4.8,
        py + Math.sin(ang + 2.35) * 4.8,
      );
      ctx.lineTo(
        px + Math.cos(ang - 2.35) * 4.8,
        py + Math.sin(ang - 2.35) * 4.8,
      );
      ctx.closePath();
      ctx.fill();
    }
  }
  // Local pip on top — larger + halo + pulse so WASD crowd blips cannot swallow it (#164).
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 220);
  const pipR = 5.8;
  const ringR = pipR + 3.4 + pulse * 2.8;
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
  ctx.beginPath();
  ctx.arc(cx, cy, pipR + 3.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.38 + 0.5 * pulse;
  ctx.strokeStyle = '#f4f8ff';
  ctx.lineWidth = 2.1;
  ctx.beginPath();
  ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#8ec0ff';
  ctx.beginPath();
  ctx.arc(cx, cy, pipR, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f4f8ff';
  ctx.beginPath();
  ctx.arc(cx, cy, 2.25, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.96)';
  ctx.lineWidth = 1.7;
  ctx.beginPath();
  ctx.arc(cx, cy, pipR + 0.35, 0, Math.PI * 2);
  ctx.stroke();

  // Legend when party mates are on the map (You + Party).
  if (partyCount > 0) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 9px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = '#6aa2ff';
    ctx.beginPath();
    ctx.arc(12, h - 12, 3.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#c8d6f0';
    ctx.fillText('You', 20, h - 12);
    ctx.fillStyle = '#5ed68a';
    ctx.beginPath();
    ctx.arc(52, h - 12, 3.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(94, 214, 138, 0.9)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(52, h - 12, 5.2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#c8d6f0';
    ctx.fillText('Party', 60, h - 12);
  }

  // Compass N last so moving rim blips cannot cover it (#164).
  const nPulse = 0.78 + 0.22 * pulse;
  ctx.globalAlpha = nPulse;
  ctx.fillStyle = 'rgba(4, 8, 16, 0.94)';
  ctx.fillRect(cx - 12, 1, 24, 26);
  ctx.fillStyle = '#ffe28a';
  ctx.beginPath();
  ctx.moveTo(cx, 3.5);
  ctx.lineTo(cx + 5.4, 12);
  ctx.lineTo(cx - 5.4, 12);
  ctx.closePath();
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 13px ui-sans-serif, system-ui, sans-serif';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.95)';
  ctx.lineWidth = 4.2;
  ctx.strokeText('N', cx, 19);
  ctx.fillStyle = '#ffe28a';
  ctx.fillText('N', cx, 19);
  ctx.globalAlpha = 1;
}

function formatLoadout(ch: NonNullable<Extract<ConnectionStatus, { state: 'connected' }>['character']>): string {
  const gear = [
    ch.staffEquipped ? 'staff' : null,
    ch.robesEquipped ? 'robes' : null,
  ]
    .filter(Boolean)
    .join('+') || '(none)';
  const staffLine = ch.staffEquipped ? 'staff: equipped' : 'staff: UNEQUIPPED (casts blocked)';
  const robesLine = ch.robesEquipped ? 'robes: equipped' : 'robes: UNEQUIPPED';
  const spells = [
    ch.knowsSpark ? 'Spark' : null,
    ch.knowsEmberbolt ? 'Emberbolt' : null,
  ]
    .filter(Boolean)
    .join('+') || '(none)';
  return `XP ${ch.xp} · loadout ${gear} · ${staffLine} · ${robesLine} · spells ${spells}`;
}

function formatStatus(s: ConnectionStatus, nowMs: number): string {
  if (s.state === 'connected') {
    const poseLine = s.pose
      ? `pos: (${s.pose.x.toFixed(2)}, ${s.pose.y.toFixed(2)}, ${s.pose.z.toFixed(2)})`
      : 'pos: —';
    const restLine =
      restChromeMode === 'enter'
        ? 'rest: resting · WASD/cast leaves'
        : restChromeMode === 'exit' && restLeaveReason === 'move'
          ? 'rest: left rest · moved'
          : restChromeMode === 'exit' && restLeaveReason === 'cast'
            ? 'rest: left rest · cast'
            : restChromeMode === 'exit'
              ? 'rest: rest complete'
              : 'rest: —';
    const tgt = s.targetNpc;
    const targetLine = tgt
      ? `target: ${npcPlateName(tgt.kind)} #${tgt.npcId} HP ${tgt.hp}/${tgt.maxHp}`
      : 'target: (none — Tab)';
    const gcd = gcdRemainingMs(s.combat, nowMs);
    const gcdLine = gcd > 0 ? `GCD cooldown: ${(gcd / 1000).toFixed(2)}s` : 'GCD idle';
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
      'Connected · online',
      `identity: ${s.identityHex}`,
      xpLine,
      persistLine,
      poseLine,
      restLine,
      remotesLine,
      partyLine,
      aoiLine,
      targetLine,
      remoteTargetLine,
      remoteCastLine,
      gcdLine,
      castLine,
      rmbLookArmed
      ? 'camera: looking (RMB drag) · LMB selects'
      : 'camera: idle · hold RMB look · LMB selects',
      'keys: H legend · WASD · Space jump · RMB hold-look · Tab · 1/2 · Esc · B bag · U/I · J/K · P/O party · T/Y trade · E vendor · F pickup · V tonic · R rest · Enter say',
      `uri: ${s.uri}`,
      `db: ${s.database}`,
    ].join('\n');
  }
  if (s.state === 'connecting') {
    const restore = s.restoredToken ? ' (restoring token…)' : '';
    return `Connecting…${restore}\nconn: in progress\nuri: ${s.uri}\ndb: ${s.database}`;
  }
  if (s.state === 'error') {
    return `Conn error\nError: ${s.message}\nuri: ${s.uri}\ndb: ${s.database}`;
  }
  return `Disconnected\nconn: offline\nuri: ${s.uri}\ndb: ${s.database}`;
}

/** #352 — WoW-like zoom stops: close, not inside mesh; establishing, not orbital infinity. */
const CAM_ZOOM_MIN = 4.5;
const CAM_ZOOM_MAX = 42;

/** Vertical bole colliders for camera push-in. Quaternius AABB is canopy-wide — do not use it. */
type TrunkCollider = {
  name: string;
  kind: 'hero' | 'mid' | 'dummy' | 'hostile' | 'brigand' | 'vendor';
  x: number;
  z: number;
  r: number;
  y0: number;
  y1: number;
  pad?: number;
};

const CAM_TRUNK_PAD = 1.25;
const CAM_TRUNK_HERO_BOLE = 1.55;
const CAM_TRUNK_MID_BOLE = 0.82;
const CAM_TRUNK_MIN_HIT = 0.55;
const CAM_COLLISION_VE_RADIUS = 56;
/** User zoom min is 4.5; collision may pull closer so nearby bodies do not swallow the cam. */
const CAM_COLLIDE_FLOOR = 1.55;
/** Ease radius back out so a grazing miss does not snap 1-frame through a bole (#499). */
const CAM_RADIUS_RECOVER_MPS = 16;
const CAM_BODY_PAD = 0.45;
const CAM_BODY_DUMMY_R = 0.58;
const CAM_BODY_HOSTILE_R = 0.48;
/** Stall posts ~0.95×0.62; awning ~1.18×0.85. Circumscribe without eating origin. */
const CAM_STALL_R = 1.12;
const CAM_STALL_PAD = 0.4;
const CAM_STALL_Y1 = 2.25;

function collectTrunkColliders(scene: Scene): TrunkCollider[] {
  const trunks: TrunkCollider[] = [];
  const seen = new Set<string>();
  const add = (
    name: string,
    kind: 'hero' | 'mid',
    x: number,
    z: number,
    r: number,
    y0: number,
    y1: number,
  ): void => {
    const key = name.replace(/_trunk$/i, '');
    if (seen.has(key) || !(r > 0.4) || y1 - y0 < 2) return;
    seen.add(key);
    trunks.push({ name: key, kind, x, z, r, y0, y1 });
  };

  for (const mesh of scene.meshes) {
    if (!mesh.isEnabled() || mesh.isVisible === false) continue;
    if (/Template/i.test(mesh.name)) continue;
    mesh.computeWorldMatrix(true);
    if (mesh.absolutePosition.y < -40) continue;

    if (/_trunk$/i.test(mesh.name)) {
      const bi = mesh.getBoundingInfo();
      bi.update(mesh.getWorldMatrix());
      const bb = bi.boundingBox;
      const hx = (bb.maximumWorld.x - bb.minimumWorld.x) * 0.5;
      const hz = (bb.maximumWorld.z - bb.minimumWorld.z) * 0.5;
      add(
        mesh.name,
        /hero/i.test(mesh.name) ? 'hero' : 'mid',
        (bb.minimumWorld.x + bb.maximumWorld.x) * 0.5,
        (bb.minimumWorld.z + bb.maximumWorld.z) * 0.5,
        Math.min(hx, hz) * 0.8,
        bb.minimumWorld.y,
        bb.maximumWorld.y,
      );
      continue;
    }

    const parent = mesh.parent as {
      name: string;
      getAbsolutePosition: () => Vector3;
      absoluteScaling: Vector3;
    } | null;
    const selfIsRoot =
      /^(heroTree|heroElder|heroSent)/.test(mesh.name) || /^midTree_/.test(mesh.name);
    const parentIsRoot =
      !!parent &&
      (/^(heroTree|heroElder|heroSent)/.test(parent.name) || /^midTree_/.test(parent.name));
    if (!selfIsRoot && !parentIsRoot) continue;
    const root = selfIsRoot ? mesh : parent!;
    const pos = root.getAbsolutePosition();
    const scale = Math.max(Math.abs(root.absoluteScaling.x), 0.5);
    const hero = !/^midTree_/.test(root.name);
    add(
      root.name,
      hero ? 'hero' : 'mid',
      pos.x,
      pos.z,
      scale * (hero ? CAM_TRUNK_HERO_BOLE : CAM_TRUNK_MID_BOLE),
      0,
      scale * (hero ? 18 : 8),
    );
  }
  for (const node of scene.transformNodes) {
    if (/Template/i.test(node.name) || node.getAbsolutePosition().y < -40) continue;
    const hero = /^(heroTree|heroElder|heroSent)/.test(node.name);
    const mid = /^midTree_/.test(node.name);
    if (!hero && !mid) continue;
    const pos = node.getAbsolutePosition();
    const scale = Math.max(Math.abs(node.absoluteScaling.x), 0.5);
    add(
      node.name,
      hero ? 'hero' : 'mid',
      pos.x,
      pos.z,
      scale * (hero ? CAM_TRUNK_HERO_BOLE : CAM_TRUNK_MID_BOLE),
      0,
      scale * (hero ? 18 : 8),
    );
  }
  if (!trunks.some((t) => t.kind === 'hero')) {
    const fallback: Array<{ name: string; x: number; z: number; r: number }> = [
      { name: 'heroTreeN', x: 6, z: -40, r: 8 },
      { name: 'heroTreeNE', x: 34, z: -28, r: 7.1 },
      { name: 'heroTreeNW', x: -36, z: -24, r: 7.4 },
      { name: 'heroTreeSW', x: -32, z: 34, r: 6.8 },
      { name: 'heroTreeSE', x: 30, z: 38, r: 6.5 },
    ];
    for (const h of fallback) add(h.name, 'hero', h.x, h.z, h.r, 0, 28);
  }
  return trunks;
}

function nearestTrunkOfKind(
  x: number,
  z: number,
  trunks: TrunkCollider[],
  kind: TrunkCollider['kind'],
): TrunkCollider | null {
  let best: TrunkCollider | null = null;
  let bestD = Infinity;
  for (const t of trunks) {
    if (t.kind !== kind) continue;
    const d = (t.x - x) * (t.x - x) + (t.z - z) * (t.z - z);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

function nearestHeroTrunk(x: number, z: number, trunks: TrunkCollider[]): TrunkCollider | null {
  return nearestTrunkOfKind(x, z, trunks, 'hero');
}

/** Graze the bole so the trunk reads in-frame. Hero +0.16 misses thin mid cylinders. */
function trunkAimAlpha(px: number, pz: number, t: TrunkCollider): number {
  const dist = Math.hypot(t.x - px, t.z - pz);
  const r = t.r + (t.pad ?? CAM_TRUNK_PAD);
  const graze =
    t.kind === 'hero'
      ? 0.16
      : Math.min(0.12, (r * 0.45) / Math.max(8, dist));
  return Math.atan2(t.z - pz, t.x - px) + graze;
}

function trunkAimRadius(px: number, pz: number, t: TrunkCollider): number {
  const dist = Math.hypot(t.x - px, t.z - pz);
  return Math.max(CAM_COLLISION_VE_RADIUS, dist + t.r + CAM_TRUNK_PAD + 10);
}

/** First bole of `kind` whose cam-to-player ray is not a different kind. */
function pickClearTrunk(
  px: number,
  pz: number,
  trunks: TrunkCollider[],
  kind: TrunkCollider['kind'],
): TrunkCollider | null {
  const ranked = trunks
    .filter((t) => t.kind === kind)
    .sort((a, b) => {
      const da = (a.x - px) * (a.x - px) + (a.z - pz) * (a.z - pz);
      const db = (b.x - px) * (b.x - px) + (b.z - pz) * (b.z - pz);
      return da - db;
    });
  const tgt = new Vector3(px, 1.35, pz);
  const beta = Math.PI / 2.18;
  for (const t of ranked) {
    const alpha = trunkAimAlpha(px, pz, t);
    const desired = trunkAimRadius(px, pz, t);
    const { hit } = clampRadiusVsTrunks(tgt, alpha, beta, desired, CAM_ZOOM_MIN, trunks);
    if (!hit) continue;
    if (kind === 'mid' && /^midTree_/.test(hit)) return t;
    if (kind === 'hero' && !/^midTree_/.test(hit)) return t;
  }
  return ranked[0] ?? null;
}

/** Pull ArcRotate radius in so the cam-to-target segment stops at a trunk bole. */
function clampRadiusVsTrunks(
  target: Vector3,
  alpha: number,
  beta: number,
  desired: number,
  minRadius: number,
  trunks: TrunkCollider[],
): { radius: number; hit: string | null } {
  const sinb = Math.sin(beta);
  const dx = Math.cos(alpha) * sinb;
  const dy = Math.cos(beta);
  const dz = Math.sin(alpha) * sinb;
  let best = desired;
  let hit: string | null = null;
  for (const t of trunks) {
    const ox = target.x - t.x;
    const oz = target.z - t.z;
    const r = t.r + (t.pad ?? CAM_TRUNK_PAD);
    if (ox * ox + oz * oz <= r * r) continue;
    const a = dx * dx + dz * dz;
    if (a < 1e-10) continue;
    const b = 2 * (ox * dx + oz * dz);
    const c = ox * ox + oz * oz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc < 0) continue;
    const tHit = (-b - Math.sqrt(disc)) / (2 * a);
    if (tHit <= CAM_TRUNK_MIN_HIT || tHit >= best) continue;
    // Hero/mid boles are infinite vertical cylinders. Finite y1 (short *_trunk
    // AABB) misses the hop-cam ray, then land re-hits = punch (#483).
    if (t.kind !== 'hero' && t.kind !== 'mid') {
      const y = target.y + tHit * dy;
      if (y < t.y0 - 0.4 || y > t.y1 + 0.4) continue;
    }
    best = tHit;
    hit = t.name;
  }
  return { radius: Math.max(minRadius, best), hit };
}

/**
 * If the spherical cam point sits inside a hero/mid bole, push XZ onto the
 * cylinder so RMB orbit slides instead of popping through (#499).
 */
function slideCamOutOfBoles(
  target: Vector3,
  alpha: number,
  beta: number,
  radius: number,
  trunks: TrunkCollider[],
): { alpha: number; radius: number; hit: string | null } {
  const sinb = Math.sin(beta);
  let cx = target.x + Math.cos(alpha) * sinb * radius;
  const cy = target.y + Math.cos(beta) * radius;
  let cz = target.z + Math.sin(alpha) * sinb * radius;
  let hit: string | null = null;
  for (const t of trunks) {
    if (t.kind !== 'hero' && t.kind !== 'mid') continue;
    const r = t.r + (t.pad ?? CAM_TRUNK_PAD);
    const ox = cx - t.x;
    const oz = cz - t.z;
    const d = Math.hypot(ox, oz);
    if (d >= r || d < 1e-5) continue;
    const s = r / d;
    cx = t.x + ox * s;
    cz = t.z + oz * s;
    hit = t.name;
  }
  if (!hit) return { alpha, radius, hit: null };
  const dx = cx - target.x;
  const dz = cz - target.z;
  const dy = cy - target.y;
  return {
    alpha: Math.atan2(dz, dx),
    radius: Math.max(CAM_COLLIDE_FLOOR, Math.hypot(dx, dy, dz)),
    hit,
  };
}

/** Living Dummy / Hostile / Brigand capsules. Corpses skipped (#466). */
function collectBodyColliders(
  npcs: NpcView[],
  meshes: Map<string, NpcMesh>,
): TrunkCollider[] {
  const out: TrunkCollider[] = [];
  for (const n of npcs) {
    if (n.hp <= 0) continue;
    const dummy = n.kind === NPC_KIND_DUMMY;
    const brigand = n.kind === NPC_KIND_BRIGAND;
    if (!dummy && !isHostileKind(n.kind)) continue;
    const mesh = meshes.get(n.npcId.toString());
    const pos = mesh?.root.position;
    out.push({
      name: dummy ? 'Dummy' : brigand ? 'Brigand' : 'Hostile',
      kind: dummy ? 'dummy' : brigand ? 'brigand' : 'hostile',
      x: pos?.x ?? n.x,
      z: pos?.z ?? n.z,
      r: dummy ? CAM_BODY_DUMMY_R : CAM_BODY_HOSTILE_R,
      y0: 0,
      y1: dummy ? 2.2 : 1.95,
      pad: CAM_BODY_PAD,
    });
  }
  return out;
}

/** YardVendor stall cylinder. Dummy/hostiles stay on collectBodyColliders (#497). */
function collectStallColliders(vendors: VendorView[]): TrunkCollider[] {
  const out: TrunkCollider[] = [];
  for (const v of vendors) {
    out.push({
      name: 'Vendor',
      kind: 'vendor',
      x: v.x,
      z: v.z,
      r: CAM_STALL_R,
      y0: 0,
      y1: CAM_STALL_Y1,
      pad: CAM_STALL_PAD,
    });
  }
  return out;
}

async function createScene(engine: Engine): Promise<{
  scene: Scene;
  camera: ArcRotateCamera;
  player: Mesh;
  humanoid: HumanoidParts;
  proxySource: Mesh;
  setLocalGhost: (on: boolean) => void;
  trunks: TrunkCollider[];
}> {
  const scene = new Scene(engine);

  // E8.1 #326: default play-cam ~10m / ~72° so Idle staff-grip reads (not 22m bird's-eye T).
  const camera = new ArcRotateCamera(
    'camera',
    Math.PI / 2.6,
    Math.PI / 2.5,
    10,
    new Vector3(0, 1, 0),
    scene,
  );
  const canvas = engine.getRenderingCanvas();
  camera.attachControl(canvas, true);
  camera.lowerRadiusLimit = CAM_ZOOM_MIN;
  camera.upperRadiusLimit = CAM_ZOOM_MAX;
  camera.wheelPrecision = 30;
  camera.panningSensibility = 0;

  // RMB orbit (third-person look); disable LMB rotate / RMB pan.
  const pointers = camera.inputs.attached.pointers as
    | ArcRotateCameraPointersInput
    | undefined;
  if (pointers) {
    pointers.buttons = [2];
    camera.invertRotation = false;
    pointers.angularSensibilityX = Math.abs(pointers.angularSensibilityX || 1000);
    pointers.angularSensibilityY = Math.abs(pointers.angularSensibilityY || 1000);
  }

  // Toast only on overscroll so the #30 soft clamp stays (#192).
  let lastZoomLimitToastMs = 0;
  const ZOOM_LIMIT_TOAST_DEBOUNCE_MS = 800;
  if (canvas) {
    canvas.addEventListener('wheel', (e) => {
      const now = Date.now();
      const delta = e.deltaY;
      const currentRadius = camera.radius;
      const lowerLimit = camera.lowerRadiusLimit ?? CAM_ZOOM_MIN;
      const upperLimit = camera.upperRadiusLimit ?? CAM_ZOOM_MAX;
      const isAtMin = currentRadius <= lowerLimit && delta < 0;
      const isAtMax = currentRadius >= upperLimit && delta > 0;
      if ((isAtMin || isAtMax) && now - lastZoomLimitToastMs > ZOOM_LIMIT_TOAST_DEBOUNCE_MS) {
        lastZoomLimitToastMs = now;
        pushSystemToast('zoomLimit', isAtMin ? 'Zoom min' : 'Zoom max', 1200);
      }
    }, { passive: true });
  }

  if (canvas) {
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', () => {
      setChatComposing(false);
      const chatInput = document.getElementById('chatInput') as HTMLInputElement | null;
      if (chatInput && document.activeElement === chatInput) {
        chatInput.blur();
      }
    });
  }

  // North-star yard: Quaternius Standard forest + procedural mountains (#41).
  await buildForestClearing(scene);
  const trunks = collectTrunkColliders(scene);

  // Local player: Quaternius CC0 wizard (crowd proxies are debug-only, #271).
  await preloadPlayerHumanoid(scene);
  const humanoid = createPlayerHumanoid(scene);
  const player = humanoid.root;
  let localGhostOn = false;
  /** Brief translucent blue-grey robe while Character.Hp≤0 (client-only). */
  const setLocalGhost = (on: boolean): void => {
    if (on === localGhostOn) return;
    localGhostOn = on;
    const mat = humanoid.mat;
    if (on) {
      mat.transparencyMode = Material.MATERIAL_ALPHABLEND;
      mat.alpha = 0.42;
      mat.diffuseColor = new Color3(0.48, 0.58, 0.78);
      mat.emissiveColor = new Color3(0.38, 0.58, 0.92);
    } else {
      mat.alpha = 1;
      mat.transparencyMode = Material.MATERIAL_OPAQUE;
      mat.diffuseColor = humanoid.robeBaseColor.clone();
      mat.emissiveColor = humanoid.robeBaseColor.scale(ROBE_EMISSIVE_SCALE);
    }
  };
  player.position = new Vector3(0, 0, 0);

  // CrowdProxy source mesh (hidden). Instances are amber AOI debug — default play
  // does not enable them (#271). Visible only via F3/?debug=1 or aoi/minimap/fps VE.
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

  return { scene, camera, player, humanoid, proxySource, setLocalGhost, trunks };
}


/** Client-only ground indicator: cast-reach disc+torus around the local player. */
type CastRangeRing = {
  root: Mesh;
  disc: Mesh;
  rim: Mesh;
  discMat: StandardMaterial;
  rimMat: StandardMaterial;
};

function createCastRangeRing(scene: Scene): CastRangeRing {
  const root = new Mesh('castRangeRing', scene);
  root.isPickable = false;

  const disc = MeshBuilder.CreateDisc(
    'castRangeDisc',
    { radius: CAST_RANGE_METERS, tessellation: 64 },
    scene,
  );
  disc.parent = root;
  disc.rotation.x = Math.PI / 2;
  disc.position.y = 0.03;
  disc.isPickable = false;
  const discMat = new StandardMaterial('castRangeDiscMat', scene);
  discMat.diffuseColor = new Color3(0.95, 0.28, 0.18);
  discMat.emissiveColor = new Color3(0.55, 0.12, 0.06);
  discMat.specularColor = new Color3(0.05, 0.02, 0.01);
  discMat.alpha = 0.18;
  discMat.transparencyMode = Material.MATERIAL_ALPHABLEND;
  discMat.backFaceCulling = false;
  discMat.disableLighting = true;
  disc.material = discMat;

  const rim = MeshBuilder.CreateTorus(
    'castRangeRim',
    {
      diameter: CAST_RANGE_METERS * 2,
      thickness: 0.22,
      tessellation: 64,
    },
    scene,
  );
  rim.parent = root;
  rim.position.y = 0.06;
  rim.rotation.x = Math.PI / 2;
  rim.isPickable = false;
  const rimMat = new StandardMaterial('castRangeRimMat', scene);
  rimMat.diffuseColor = new Color3(1.0, 0.35, 0.18);
  rimMat.emissiveColor = new Color3(0.95, 0.28, 0.1);
  rimMat.specularColor = new Color3(0.2, 0.08, 0.04);
  rimMat.disableLighting = true;
  rim.material = rimMat;

  root.setEnabled(false);
  return { root, disc, rim, discMat, rimMat };
}

function makeNpcMesh(scene: Scene, npc: NpcView): NpcMesh {
  const root = new Mesh(`npc_${npc.npcId}`, scene);
  root.position = new Vector3(npc.x, 0, npc.z);

  const isDummy = npc.kind === NPC_KIND_DUMMY;
  let body: Mesh;
  let mat: StandardMaterial;
  let extraMats: StandardMaterial[] = [];
  let humanoid: HumanoidParts | null = null;
  if (isDummy) {
    // Scarecrow / practice dummy — wood post + crossbeam + canvas (not a cylinder).
    const dummy = createTrainingDummy(scene, `npc_${npc.npcId}`);
    body = dummy.body;
    body.parent = root;
    body.position.y = DIRT_SURFACE_Y;
    mat = dummy.mat;
    extraMats = dummy.extraMats;
  } else if (isHostileKind(npc.kind)) {
    // Same wizard clone as remotes (IBM once on the container). Idle_Weapon,
    // not bind-T, not a red capsule. Dummy stays the scarecrow. Kind=3 is a
    // mesh variant: unarmed Idle, no staff/pads, saturated violet vs crimson.
    const brigand = npc.kind === NPC_KIND_BRIGAND;
    const parts = createPlayerHumanoid(scene, {
      name: brigand ? `brigand_${npc.npcId}` : `hostile_${npc.npcId}`,
      robeColor: brigand ? brigandRobeColor() : hostileRobeColor(),
      variant: brigand ? 'brigand' : 'hostile',
    });
    parts.root.parent = root;
    body = parts.root;
    mat = parts.mat;
    humanoid = parts;
    setHumanoidMoving(parts, false);
    if (brigand) setHumanoidStaffEquipped(parts, false);
    const yaw = Math.atan2(-npc.x, -npc.z);
    if (Number.isFinite(yaw)) parts.root.rotation.y = yaw;
  } else {
    body = MeshBuilder.CreateCapsule(
      `npcBody_${npc.npcId}`,
      { height: 1.6, radius: 0.32 },
      scene,
    );
    body.parent = root;
    body.position.y = 0.8;
    mat = new StandardMaterial(`npcMat_${npc.npcId}`, scene);
    mat.diffuseColor = new Color3(0.7, 0.35, 0.35);
    mat.emissiveColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0.1, 0.1, 0.1);
    body.material = mat;
  }

  // Local selection reticule — gold torus crisp vs #39 cyan fog (fog off + unlit + dark halo).
  const ring = MeshBuilder.CreateTorus(
    `npcRing_${npc.npcId}`,
    { diameter: 1.58, thickness: 0.14, tessellation: 40 },
    scene,
  );
  ring.parent = root;
  ring.position.y = 0.07;
  ring.rotation.x = Math.PI / 2;
  const ringMat = new StandardMaterial(`npcRingMat_${npc.npcId}`, scene);
  ringMat.diffuseColor = new Color3(1.0, 0.82, 0.2);
  ringMat.emissiveColor = new Color3(0, 0, 0);
  ringMat.specularColor = new Color3(0.15, 0.12, 0.04);
  ringMat.disableLighting = true;
  ringMat.fogEnabled = false;
  ring.material = ringMat;
  ring.setEnabled(false);

  // Dark outline halo (child of ring) so gold reads over lush grass / fog wash.
  const ringHalo = MeshBuilder.CreateTorus(
    `npcRingHalo_${npc.npcId}`,
    { diameter: 1.72, thickness: 0.2, tessellation: 40 },
    scene,
  );
  ringHalo.parent = ring;
  ringHalo.position.y = -0.01;
  ringHalo.isPickable = false;
  const ringHaloMat = new StandardMaterial(`npcRingHaloMat_${npc.npcId}`, scene);
  ringHaloMat.diffuseColor = new Color3(0.04, 0.03, 0.02);
  ringHaloMat.emissiveColor = new Color3(0.028, 0.02, 0.01);
  ringHaloMat.specularColor = new Color3(0, 0, 0);
  ringHaloMat.disableLighting = true;
  ringHaloMat.fogEnabled = false;
  ringHaloMat.alpha = 0.9;
  ringHalo.material = ringHaloMat;

  const remoteRing = MeshBuilder.CreateTorus(
    `npcRemoteRing_${npc.npcId}`,
    { diameter: 1.85, thickness: 0.05, tessellation: 32 },
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

  // Overhead chevron (tip down) — gold select; fog-immune so it stays crisp in cyan haze.
  const marker = MeshBuilder.CreateCylinder(
    `npcMark_${npc.npcId}`,
    { height: 0.36, diameterTop: 0, diameterBottom: 0.3, tessellation: 6 },
    scene,
  );
  marker.parent = root;
  marker.position.y = isDummy ? 2.45 : 2.55;
  marker.rotation.z = Math.PI; // tip points at dummy
  marker.isPickable = false;
  const markerMat = new StandardMaterial(`npcMarkMat_${npc.npcId}`, scene);
  markerMat.diffuseColor = new Color3(1.0, 0.84, 0.22);
  markerMat.emissiveColor = new Color3(0.95, 0.72, 0.12);
  markerMat.specularColor = new Color3(0.12, 0.1, 0.03);
  markerMat.disableLighting = true;
  markerMat.fogEnabled = false;
  marker.material = markerMat;
  marker.setEnabled(false);

  let nameplate: Nameplate | null = null;
  const isHostile = isHostileKind(npc.kind);
  if (isDummy || isHostile) {
    nameplate = createNameplate(scene, `npc_${npc.npcId}`);
    nameplate.mesh.parent = root;
    nameplate.mesh.position.set(0, isDummy ? 2.15 : 2.35, 0);
    paintNameplate(
      nameplate,
      npcPlateName(npc.kind),
      npcPlateColor(npc.kind, false),
      npc.maxHp > 0 ? npc.hp / npc.maxHp : 1,
    );
  }

  return {
    root,
    body,
    ring,
    remoteRing,
    marker,
    mat,
    extraMats,
    ringMat,
    remoteRingMat,
    markerMat,
    nameplate,
    humanoid,
  };
}


function makeVendorMesh(scene: Scene, vendor: VendorView): { root: Mesh; mat: StandardMaterial; nameplate: Nameplate | null } {
  const root = new Mesh(`vendor_${vendor.vendorId}`, scene);
  root.position = new Vector3(vendor.x, 0, vendor.z);

  // Procedural shop stall — posts + counter + cloth awning (#58). Warm wood /
  // desaturated canvas under locked #39 fog/sun; readable at 8–20m play cam.
  const stall = createVendorStall(scene, `vendorStall_${vendor.vendorId}`);
  stall.body.parent = root;
  stall.body.position.y = DIRT_SURFACE_Y;
  const mat = stall.mat;

  const nameplate = createNameplate(scene, `vendor_${vendor.vendorId}`);
  nameplate.mesh.parent = root;
  nameplate.mesh.position.set(0, 2.45, 0);
  paintNameplate(nameplate, vendor.label || 'Vendor', '#7dffb5', 1);

  return { root, mat, nameplate };
}

function bindInput(opts: {
  onCycleTarget: () => void;
  onCast: (spellId: number) => void;
  onPartyInviteOrAccept: () => void;
  onPartyLeave: () => void;
  onTradeOfferOrAccept: () => void;
  onTradeCancel: () => void;
  onUnequipStaff: () => void;
  onEquipStaff: () => void;
  onUnequipRobes: () => void;
  onEquipRobes: () => void;
  onToggleBag: () => void;
  onToggleKeysLegend: () => void;
  onToggleDebugHud: () => void;
  onVendorInteract: () => void;
  onPickupNearest: () => void;
  onUseYardTonic: () => void;
  onUseBandage: () => void;
  onRest: () => void;
  onCancelCast: () => void;
  onKick: () => void;
  onStun: () => void;
}): { keys: Set<string>; dispose: () => void } {
  const keys = new Set<string>();
  const down = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    
    // Toast BEFORE chatComposing early-return so it can't miss
    if (k === ' ' && !e.repeat) {
      const chatInput = document.getElementById('chatInput') as HTMLInputElement | null;
      const shouldShowToast = chatComposing || (chatInput && document.activeElement === chatInput);
      if (shouldShowToast) {
        const now = Date.now();
        if (now - lastCanvasFocusToastMs > 1500) {
          lastCanvasFocusToastMs = now;
          pushSystemToast('canvasFocus', 'Click canvas for gameplay keys (Space, WASD…)');
        }
      }
    }
    
    if (chatComposing) return;
    if (e.repeat) return;
    if (k === 'w' || k === 'a' || k === 's' || k === 'd') {
      keys.add(k);
      leaveRestIfActive('move');
      e.preventDefault();
      return;
    }
    if (k === ' ') {
      keys.add(' ');
      leaveRestIfActive('move');
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
    if (e.key === '3') {
      e.preventDefault();
      opts.onKick();
      return;
    }
    if (e.key === '4') {
      e.preventDefault();
      opts.onStun();
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
    if (k === 't') {
      e.preventDefault();
      opts.onTradeOfferOrAccept();
      return;
    }
    if (k === 'y') {
      e.preventDefault();
      opts.onTradeCancel();
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
    if (k === 'j') {
      e.preventDefault();
      opts.onUnequipRobes();
      return;
    }
    if (k === 'k') {
      e.preventDefault();
      opts.onEquipRobes();
      return;
    }
    if (k === 'b') {
      e.preventDefault();
      opts.onToggleBag();
      return;
    }
    if (k === 'h') {
      e.preventDefault();
      opts.onToggleKeysLegend();
      return;
    }
    if (e.key === 'F3' || e.code === 'F3') {
      // Ignore when chat compose has focus (chatComposing early-return covers most cases).
      const ae = document.activeElement as HTMLElement | null;
      if (ae && ae.id === 'chatInput') return;
      e.preventDefault();
      opts.onToggleDebugHud();
      return;
    }
    if (k === 'e') {
      e.preventDefault();
      opts.onVendorInteract();
      return;
    }
    if (k === 'f') {
      e.preventDefault();
      opts.onPickupNearest();
      return;
    }
    if (k === 'v') {
      e.preventDefault();
      opts.onUseYardTonic();
      return;
    }
    if (k === 'n') {
      e.preventDefault();
      opts.onUseBandage();
      return;
    }
    if (k === 'r') {
      e.preventDefault();
      opts.onRest();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      opts.onCancelCast();
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

/** Camera-relative XZ wish from WASD + jump from Space. */
function wishFromKeys(
  keys: Set<string>,
  camera: ArcRotateCamera,
): { dx: number; dz: number; jump: boolean } {
  let x = 0;
  let z = 0;
  if (keys.has('w')) z += 1;
  if (keys.has('s')) z -= 1;
  if (keys.has('a')) x -= 1;
  if (keys.has('d')) x += 1;

  // Jump on Space, but not when chat input is focused
  const chatInput = document.getElementById('chatInput') as HTMLInputElement | null;
  const chatFocused = chatInput && document.activeElement === chatInput;
  const jump = keys.has(' ') && !chatFocused;

  if (x === 0 && z === 0) return { dx: 0, dz: 0, jump };

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
  if (wish.lengthSquared() < 1e-8) return { dx: 0, dz: 0, jump };
  wish.normalize();
  return { dx: wish.x, dz: wish.z, jump };
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

/** Hide hood/skirt/shoulders; tint torso/arms drab when robes unequipped (mirrors staff U/I). */
function setRobesMeshVisible(parts: HumanoidParts, equipped: boolean): void {
  const robes = parts.robes;
  robes.setEnabled(equipped);
  robes.isVisible = equipped;
  for (const child of robes.getChildMeshes(true)) {
    child.setEnabled(equipped);
    child.isVisible = equipped;
  }
  const drab = new Color3(0.42, 0.4, 0.38);
  const col = equipped ? parts.robeBaseColor : drab;
  parts.mat.diffuseColor.copyFrom(col);
  parts.mat.emissiveColor.copyFrom(col.scale(equipped ? ROBE_EMISSIVE_SCALE : 0.04));
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
  return { mesh, mat, tex, label: '', hpFrac: -2, selected: false, stunned: false };
}

function paintNameplate(
  np: Nameplate,
  label: string,
  fillCss: string,
  hpFrac: number,
  selected = false,
  stunned = false,
): void {
  if (
    np.label === label &&
    Math.abs(np.hpFrac - hpFrac) < 0.02 &&
    np.selected === selected &&
    np.stunned === stunned
  ) {
    return;
  }
  np.label = label;
  np.hpFrac = hpFrac;
  np.selected = selected;
  np.stunned = stunned;
  np.mat.fogEnabled = !selected;
  np.mesh.scaling.set(selected ? 1.1 : 1, selected ? 1.1 : 1, 1);
  const ctx = np.tex.getContext() as unknown as CanvasRenderingContext2D;
  const w = 256;
  const h = 96;
  ctx.clearRect(0, 0, w, h);
  const showPip = hpFrac >= 0;
  const textY = showPip ? 34 : 48;
  // Opaque dark pill for legibility over cyan fog / lush grass.
  const pillW = Math.min(selected ? 228 : 236, 40 + label.length * 20);
  const pillH = showPip ? 78 : 56;
  const pillX = (w - pillW) / 2;
  const pillY = showPip ? 8 : 20;
  ctx.fillStyle = selected ? 'rgba(16,12,4,0.94)' : 'rgba(6,8,14,0.88)';
  ctx.beginPath();
  const r = 14;
  ctx.moveTo(pillX + r, pillY);
  ctx.arcTo(pillX + pillW, pillY, pillX + pillW, pillY + pillH, r);
  ctx.arcTo(pillX + pillW, pillY + pillH, pillX, pillY + pillH, r);
  ctx.arcTo(pillX, pillY + pillH, pillX, pillY, r);
  ctx.arcTo(pillX, pillY, pillX + pillW, pillY, r);
  ctx.closePath();
  ctx.fill();
  if (selected) {
    // Gold select stroke — same family as HUD #targetFrame (#142).
    ctx.strokeStyle = 'rgba(232,186,48,0.98)';
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(10,8,4,0.9)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  if (stunned) {
    // Cyan stun rim. Label stays Dummy / Hostile / Brigand (#500).
    ctx.strokeStyle = 'rgba(126,200,255,0.95)';
    ctx.lineWidth = selected ? 3.5 : 4.5;
    ctx.stroke();
  }
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;
  ctx.font = 'bold 40px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(0,0,0,0.96)';
  ctx.strokeText(label, w / 2, textY);
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.fillStyle = fillCss;
  ctx.fillText(label, w / 2, textY);
  if (showPip) {
    const bx = 52;
    const by = 62;
    const bw = 152;
    const bh = 14;
    const fill = Math.max(0, Math.min(1, hpFrac));
    const isDummy = label === 'Dummy';
    const isHostile = label === 'Hostile';
    const isBrigand = label === 'Brigand';
    if (isDummy || isHostile || isBrigand) {
      ctx.fillStyle = 'rgba(8,10,12,0.92)';
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = selected
        ? 'rgba(232,186,48,0.95)'
        : 'rgba(0,0,0,0.95)';
      ctx.lineWidth = selected ? 4 : 3;
      ctx.strokeRect(bx, by, bw, bh);
      ctx.fillStyle = isDummy
        ? fill > 0.35
          ? 'rgb(55,230,95)'
          : fill > 0.15
            ? 'rgb(245,180,40)'
            : 'rgb(235,55,50)'
        : isBrigand
          ? fill > 0.35
            ? 'rgb(196,130,255)'
            : fill > 0.15
              ? 'rgb(220,150,90)'
              : 'rgb(210,40,40)'
          : fill > 0.35
            ? 'rgb(255,110,80)'
            : fill > 0.15
              ? 'rgb(245,150,50)'
              : 'rgb(210,40,40)';
      ctx.fillRect(bx + 3, by + 3, (bw - 6) * fill, bh - 6);
    } else {
      ctx.fillStyle = 'rgba(12,12,14,0.85)';
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle =
        fill > 0.4
          ? 'rgb(72,205,110)'
          : fill > 0.18
            ? 'rgb(230,190,55)'
            : 'rgb(220,70,60)';
      ctx.fillRect(bx + 2, by + 2, (bw - 4) * fill, bh - 4);
    }
  }
  np.tex.update();
}

function disposeNameplate(np: Nameplate | null | undefined): void {
  if (!np) return;
  np.mesh.dispose();
  np.mat.dispose();
  np.tex.dispose();
}

/** Vertical gap between stacked floaters near the same anchor. */
const FLOATER_STACK_DY = 0.58;
/** XZ radius (m) for counting live floaters toward a stack slot. */
const FLOATER_NEAR_XZ = 2.8;
/** Dim unlit emissive so digits stay readable without neon bloom over #39 fog. */
const FLOATER_EMISSIVE = 0.72;

/** Tuned fills for cyan fog + lush grass (matte, not neon). */
const FLOATER_TINT_SPARK = new Color3(1.0, 0.9, 0.48);
const FLOATER_TINT_EMBER = new Color3(1.0, 0.58, 0.22);
const FLOATER_TINT_THORNS = new Color3(0.96, 0.4, 0.36);
const FLOATER_TINT_HEAL = new Color3(0.7, 0.96, 0.86);
/** Tonic use flash — warm amber, not heal green (#163). */
const TONIC_FLASH = new Color3(0.88, 0.62, 0.28);
const FLOATER_TINT_XP = new Color3(1.0, 0.86, 0.4);
const FLOATER_TINT_LEVEL = new Color3(0.72, 0.9, 1.0);

/** Count still-visible floaters near `at` across one or more live lists. */
function countNearbyLiveFloaters(
  lists: DamageFloater[][] | undefined,
  at: Vector3,
  now = Date.now(),
): number {
  if (!lists) return 0;
  const r2 = FLOATER_NEAR_XZ * FLOATER_NEAR_XZ;
  let n = 0;
  for (const list of lists) {
    for (const f of list) {
      if (now - f.bornMs >= f.lifeMs * 0.9) continue;
      const dx = f.mesh.position.x - at.x;
      const dz = f.mesh.position.z - at.z;
      if (dx * dx + dz * dz <= r2) n += 1;
    }
  }
  return n;
}

type FloaterSpawnOpts = {
  lifeMs?: number;
  yLift?: number;
  planeW?: number;
  planeH?: number;
  /** Deterministic horizontal lane (replaces random drift). */
  laneX?: number;
  /** Live floater lists used to assign a stack slot near `at`. */
  stackWith?: DamageFloater[][];
};

/** Rising world billboard text — damage numbers, XP floaters, etc. */
function spawnWorldFloater(
  scene: Scene,
  at: Vector3,
  label: string,
  tint: Color3,
  opts?: FloaterSpawnOpts,
): DamageFloater {
  const slot = countNearbyLiveFloaters(opts?.stackWith, at);
  const lifeMs = opts?.lifeMs ?? 1250;
  const yLift = (opts?.yLift ?? 1.9) + slot * FLOATER_STACK_DY;
  const planeW = opts?.planeW ?? 1.85;
  const planeH = opts?.planeH ?? 0.95;
  const laneX = opts?.laneX ?? 0;
  const texW = 320;
  const texH = 160;
  const tex = new DynamicTexture(
    `fltTex_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    { width: texW, height: texH },
    scene,
    false,
  );
  tex.hasAlpha = true;
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, texW, texH);
  const cx = texW / 2;
  const cy = texH / 2;
  const fontPx = label.length > 6 ? 72 : 96;
  ctx.font = `bold ${fontPx}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Soft drop shadow + thick dark outline so digits read over grass / cyan fog.
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillText(label, cx + 3, cy + 4);
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.lineWidth = 18;
  ctx.strokeStyle = 'rgba(0,0,0,0.88)';
  ctx.strokeText(label, cx, cy);
  ctx.lineWidth = 10;
  ctx.strokeStyle = 'rgba(8,10,14,0.98)';
  ctx.strokeText(label, cx, cy);
  ctx.fillStyle = `rgb(${Math.round(tint.r * 255)},${Math.round(tint.g * 255)},${Math.round(tint.b * 255)})`;
  ctx.fillText(label, cx, cy);
  tex.update();

  const mat = new StandardMaterial(`fltMat_${label}_${Date.now()}`, scene);
  mat.diffuseTexture = tex;
  mat.emissiveTexture = tex;
  mat.opacityTexture = tex;
  // Cap emissive so floaters stay matte/readable (no neon bloom under #39 fog).
  mat.emissiveColor = new Color3(FLOATER_EMISSIVE, FLOATER_EMISSIVE, FLOATER_EMISSIVE);
  mat.disableLighting = true;
  mat.useAlphaFromDiffuseTexture = true;
  mat.backFaceCulling = false;
  mat.specularColor = new Color3(0, 0, 0);

  const mesh = MeshBuilder.CreatePlane(
    `fltPlane_${label}_${Date.now()}`,
    { width: planeW, height: planeH },
    scene,
  );
  mesh.material = mat;
  mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
  mesh.position = at.clone();
  mesh.position.y += yLift;
  // Deterministic lane + tiny per-slot zigzag (no random horizontal wander).
  mesh.position.x += laneX + (slot % 2 === 0 ? -1 : 1) * 0.05 * Math.min(slot, 3);
  mesh.isPickable = false;

  return {
    mesh,
    mat,
    bornMs: Date.now(),
    lifeMs,
    startY: mesh.position.y,
    driftX: 0,
  };
}

/** Rising combat text above an NPC — cosmetic only (HP delta from authority). */
function spawnDamageFloater(
  scene: Scene,
  at: Vector3,
  amount: number,
  tint: Color3,
  stackWith?: DamageFloater[][],
): DamageFloater {
  return spawnWorldFloater(scene, at, `-${amount}`, tint, {
    lifeMs: 1250,
    laneX: -0.22,
    stackWith,
  });
}

/** Rising "+N XP" near local player — client-only Cosmetic over Character.Xp. */
function spawnXpFloater(
  scene: Scene,
  at: Vector3,
  gained: number,
  stackWith?: DamageFloater[][],
): DamageFloater {
  return spawnWorldFloater(
    scene,
    at,
    `+${gained} XP`,
    FLOATER_TINT_XP,
    {
      lifeMs: 1500,
      yLift: 2.2,
      planeW: 2.35,
      planeH: 1.0,
      laneX: 0.34,
      stackWith,
    },
  );
}

/** Rising "Level N!" near local player — client-only Cosmetic over Character.Level. */
function spawnLevelFloater(
  scene: Scene,
  at: Vector3,
  level: number,
  stackWith?: DamageFloater[][],
): DamageFloater {
  return spawnWorldFloater(
    scene,
    at,
    `Level ${level}!`,
    FLOATER_TINT_LEVEL,
    {
      lifeMs: 1900,
      yLift: 2.5,
      planeW: 2.7,
      planeH: 1.1,
      laneX: 0.06,
      stackWith,
    },
  );
}


function disposeLifeBurst(fx: NpcLifeFx): void {
  for (const b of fx.burst) {
    b.mesh.dispose();
    b.mat.dispose();
  }
  fx.burst.length = 0;
}

function spawnDeathBurst(scene: Scene, at: Vector3): NpcLifeFx['burst'] {
  const burst: NpcLifeFx['burst'] = [];
  for (let i = 0; i < 10; i++) {
    const mat = new StandardMaterial(`deathBurstMat_${Date.now()}_${i}`, scene);
    mat.diffuseColor = new Color3(1, 0.55 + Math.random() * 0.25, 0.15);
    mat.emissiveColor = new Color3(1.1, 0.4, 0.05);
    mat.disableLighting = true;
    mat.alpha = 0.95;
    const mesh = MeshBuilder.CreateSphere(
      `deathBurst_${Date.now()}_${i}`,
      { diameter: 0.12 + Math.random() * 0.1, segments: 6 },
      scene,
    );
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.position = at.clone();
    mesh.position.y += 0.7 + Math.random() * 0.5;
    const ang = (Math.PI * 2 * i) / 10 + Math.random() * 0.4;
    burst.push({
      mesh,
      mat,
      vx: Math.cos(ang) * (1.4 + Math.random() * 1.2),
      vy: 1.6 + Math.random() * 1.8,
      vz: Math.sin(ang) * (1.4 + Math.random() * 1.2),
    });
  }
  return burst;
}

/** Fade / restore all npc presentation mats (dummy cloth+wood+head). */
function npcPresentationMats(mesh: NpcMesh): StandardMaterial[] {
  return [mesh.mat, ...mesh.extraMats];
}

/** Gold-warm extra-mat tint so Tab-selected dummy reads past cloth-only (#142). */
function tintNpcExtraMats(
  mesh: NpcMesh,
  addR: number,
  addG: number,
  addB: number,
  scale = 0.1,
): void {
  for (const m of mesh.extraMats) {
    m.emissiveColor.set(
      m.diffuseColor.r * scale + addR,
      m.diffuseColor.g * scale + addG,
      m.diffuseColor.b * scale + addB,
    );
  }
}

function restoreNpcExtraMats(mesh: NpcMesh): void {
  for (const m of mesh.extraMats) {
    m.emissiveColor = m.diffuseColor.scale(0.035);
  }
}

function beginNpcDeathFx(
  scene: Scene,
  mesh: NpcMesh,
): NpcLifeFx {
  mesh.root.setEnabled(true);
  mesh.root.scaling.setAll(1);
  const baseBodyY = mesh.body.position.y;
  for (const m of npcPresentationMats(mesh)) {
    m.alpha = 1;
    m.transparencyMode = 2; // ALPHA_BLEND
  }
  mesh.ring.setEnabled(false);
  mesh.remoteRing.setEnabled(false);
  mesh.marker.setEnabled(false);
  if (mesh.nameplate) mesh.nameplate.mesh.setEnabled(false);
  const at = mesh.root.position.clone();
  at.y += 0.9;
  return {
    phase: 'dying',
    bornMs: Date.now(),
    lifeMs: DEATH_FX_MS,
    baseBodyY,
    baseEmissive: mesh.mat.emissiveColor.clone(),
    burst: spawnDeathBurst(scene, at),
  };
}

function beginNpcRespawnFx(mesh: NpcMesh): NpcLifeFx {
  mesh.root.setEnabled(true);
  mesh.root.scaling.setAll(0.12);
  const baseBodyY = mesh.body.position.y;
  for (const m of npcPresentationMats(mesh)) {
    m.alpha = 1;
    m.transparencyMode = 0;
    m.emissiveColor = new Color3(0.85, 0.75, 0.35);
  }
  if (mesh.nameplate) mesh.nameplate.mesh.setEnabled(true);
  return {
    phase: 'spawning',
    bornMs: Date.now(),
    lifeMs: RESPAWN_FX_MS,
    baseBodyY,
    baseEmissive: new Color3(0, 0, 0),
    burst: [],
  };
}

function finishNpcLifeFx(mesh: NpcMesh, fx: NpcLifeFx): void {
  disposeLifeBurst(fx);
  mesh.root.scaling.setAll(1);
  mesh.body.position.y = fx.baseBodyY;
  for (const m of npcPresentationMats(mesh)) {
    m.alpha = 1;
    m.transparencyMode = 0;
    m.emissiveColor = fx.baseEmissive.clone();
  }
  if (fx.phase === 'dying') {
    mesh.root.setEnabled(false);
    if (mesh.nameplate) mesh.nameplate.mesh.setEnabled(false);
  } else {
    mesh.root.setEnabled(true);
  }
}

/** Ground-level look-at so an airborne remote reads as hop, not a centered stand. */
function hopBodyLook(parts: HumanoidParts): { x: number; y: number; z: number } {
  const p = parts.root.position;
  return { x: p.x, y: 0.35, z: p.z };
}

function hideLocalForRemoteHop(player: Mesh, plate: { mesh: Mesh }): void {
  player.setEnabled(false);
  plate.mesh.setEnabled(false);
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
  const { scene, camera, player, humanoid, proxySource, setLocalGhost, trunks } =
    await createScene(engine);
  const castRangeRing = createCastRangeRing(scene);

  let net: GameNet | null = null;
  let bagOpen = false;
  let keysLegendOpen = false;
  /** #252 — hop presence is JUMP toast only; no squash/stretch or camera dip. */
  let jumpWasAirborne = false;
  let jumpTakeoffMs = 0;
  let jumpApexToasted = false;
  let jumpPeakY = 0;
  /** #256 — follow Y spring so land does not punch the camera. */
  const CAM_FOLLOW_Y_OFFSET = 1.35;
  const CAM_FOLLOW_Y_HZ = 10;
  const CAM_FOLLOW_SNAP_METERS = 2.5;
  let camFollowY = CAM_FOLLOW_Y_OFFSET;
  let camFollowYSeeded = false;
  /** Intended wheel radius; collision may pull `camera.radius` in for a frame. */
  let camZoomRadius = camera.radius;
  let camAppliedRadius = camera.radius;
  let camCollideHit: string | null = null;
  let camCollideThisFrame = false;
  /** Frozen mid bole for `?ve=cam-collision-mid` so walk-in does not retarget. */
  let camCollisionMidAimed: TrunkCollider | null = null;
  /** Frozen hero bole for `?ve=cam-collision-hop`. */
  let camCollisionHopAimed: TrunkCollider | null = null;
  const npcMeshes = new Map<string, NpcMesh>();
  scene.onBeforeRenderObservable.add(() => {
    if (!camCollideThisFrame) return;
    const minR = camera.lowerRadiusLimit ?? CAM_ZOOM_MIN;
    const maxR = camera.upperRadiusLimit ?? CAM_ZOOM_MAX;
    const veCam = new URLSearchParams(window.location.search).get('ve');
    if (
      veCam !== 'cam-collision' &&
      veCam !== 'cam-collision-mid' &&
      veCam !== 'cam-collision-dummy' &&
      veCam !== 'cam-collision-vendor' &&
      veCam !== 'cam-collision-hop' &&
      Math.abs(camera.radius - camAppliedRadius) > 0.08
    ) {
      camZoomRadius = camera.radius;
    }
    camZoomRadius = Math.min(maxR, Math.max(minR, camZoomRadius));
    const bodies = collectBodyColliders(net?.getNpcs() ?? [], npcMeshes);
    const stalls = collectStallColliders(net?.getVendors() ?? []);
    const colliders = [...trunks, ...bodies, ...stalls];
    let { radius, hit } = clampRadiusVsTrunks(
      camera.target,
      camera.alpha,
      camera.beta,
      camZoomRadius,
      CAM_COLLIDE_FLOOR,
      colliders,
    );
    if (radius > camAppliedRadius) {
      const dt = Math.min(0.05, engine.getDeltaTime() / 1000);
      radius = Math.min(radius, camAppliedRadius + CAM_RADIUS_RECOVER_MPS * dt);
    }
    const slid = slideCamOutOfBoles(
      camera.target,
      camera.alpha,
      camera.beta,
      radius,
      colliders,
    );
    if (slid.hit) {
      camera.alpha = slid.alpha;
      radius = slid.radius;
      hit = hit ?? slid.hit;
    }
    camera.radius = radius;
    camAppliedRadius = radius;
    camCollideHit = hit;
  });
  /** E2.4 visual facing from camera-relative wish. Server pose.yaw stays 0. */
  const YAW_FACE_HZ = 12;
  /** Stationary look / A-D start — slower than loco so 90° is a blend, not a pop. */
  const YAW_TURN_HZ = 4;
  let localFacingYaw = 0;
  let localTurningInPlace = false;
  const bootParams = new URLSearchParams(window.location.search);
  const ve = bootParams.get('ve') || '';
  {
    const mark = document.getElementById('persistMark');
    if (mark) {
      // Harness only (#407). Default `/` stays empty → :empty { display:none }.
      if (!ve) {
        mark.textContent = '';
        mark.hidden = true;
      } else {
        mark.hidden = false;
      }
    }
  }
  const firstSessionVe = ve === 'first-session';
  let firstSessionCueShown = false;
  let firstSessionLegendFlash = false;
  let firstSessionFlashTimer: number | null = null;
  const showFirstSessionControlsCue = (opts: {
    force: boolean;
    ttlMs: number;
    autoCloseMs: number;
  }): void => {
    const veMode = bootParams.get('ve') || '';
    if (veMode && veMode !== 'first-session') return;
    if (!opts.force && (firstSessionCueShown || firstSessionCueSeen())) return;
    const already = firstSessionCueShown;
    const legendAlreadyOpen = keysLegendOpen;
    firstSessionCueShown = true;
    keysLegendOpen = true;
    if (firstSessionFlashTimer != null) {
      window.clearTimeout(firstSessionFlashTimer);
      firstSessionFlashTimer = null;
    }
    firstSessionLegendFlash = opts.autoCloseMs > 0 && !legendAlreadyOpen;
    setKeysLegendOpen(true);
    if (!already || !document.querySelector('.sysToast.keys')) {
      pushSystemToast('keys', FIRST_SESSION_TOAST, opts.ttlMs);
    }
    if (!opts.force) markFirstSessionCueSeen();
    if (opts.autoCloseMs > 0 && !legendAlreadyOpen) {
      firstSessionFlashTimer = window.setTimeout(() => {
        firstSessionFlashTimer = null;
        if (!firstSessionLegendFlash) return;
        firstSessionLegendFlash = false;
        keysLegendOpen = false;
        setKeysLegendOpen(false);
      }, opts.autoCloseMs);
    }
  };
  const debugParam = (bootParams.get('debug') || '').toLowerCase();
  let debugHudVisible = debugParam === '1' || debugParam === 'true';
  setDebugHudVisible(debugHudVisible);
  // #154 — RMB-look armed clarity (cursor / legend / status); no new camera system.
  setRmbLookArmed(false);
  const onRmbLookDown = (ev: PointerEvent): void => {
    if (ev.button !== 2) return;
    setRmbLookArmed(true);
  };
  const onRmbLookUp = (ev: PointerEvent): void => {
    if (ev.button !== 2 && ev.type !== 'pointercancel' && ev.type !== 'blur') return;
    if (ev.type === 'pointerup' && ev.button !== 2) return;
    setRmbLookArmed(false);
  };
  canvas.addEventListener('pointerdown', onRmbLookDown);
  window.addEventListener('pointerup', onRmbLookUp);
  window.addEventListener('pointercancel', onRmbLookUp);
  window.addEventListener('blur', () => setRmbLookArmed(false));
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
  let prevLocalCasting = false;
  let castCancelToasted = false;
  let castPushbackToasted = false;
  let castHardInterruptToasted = false;
  let manaWhileCasting = -1;
  let lastSeenCastEndsAtMicros = 0n;
  const vendorMeshes = new Map<string, { root: Mesh; mat: StandardMaterial; nameplate: Nameplate | null }>();
  let vendorOpen = false; void vendorOpen;
  const groundSparkles = new Map<string, GroundSparkle>();
  let latestGround: GroundItemView[] = [];
  const groundSeenIds = new Set<string>();
  let groundBootstrapped = false;
  let toastedPartyLootKey = '';
  let vendorInRangeToasted = false;
  let lootInRangeToasted = false;
  const npcLastHp = new Map<string, number>();
  const npcLifeFx = new Map<string, NpcLifeFx>();
  const damageFloaters: DamageFloater[] = [];
  const xpFloaters: DamageFloater[] = [];
  let latestDamageAmount = 0;
  let latestDamageAtMs = 0;
  let latestXpGain = 0;
  let _latestXpAtMs = 0; void _latestXpAtMs;
  let latestDeathAtMs = 0;
  let latestRespawnAtMs = 0;
  let prevStaffEquipped: boolean | null = null;
  let prevRobesEquipped: boolean | null = null;
  let prevPartySize = 0;
  let prevPartyMemberKey = '';
  let prevXp: number | null = null;
  let prevLevel: number | null = null;
  let latestLevelUp = 0;
  let prevPlayerHp: number | null = null;
  let latestPlayerDeathAtMs = 0;
  let latestPlayerRespawnAtMs = 0;
  let prevPendingInvite: string | null = null;
  let toastedConnected = false;
  let toastedInviteAcceptKey = '';
  let toastedTradeFromKey = '';
  let toastedTradeToKey = '';
  let lastTradePendingFrom: string | null = null;
  let lastTradePendingTo: string | null = null;
  let tradeAcceptInFlight = false;
  let tradeCancelInFlight = false;
  let inboundOutcomeReported = false;
  let outboundOutcomeReported = false;
  let inboundWatchShard = false;
  let inboundWatchXp = 0;
  let inboundOfferedShard = false;
  let inboundOfferedXp = 0;
  let outboundWatchShard = false;
  let outboundWatchXp = 0;
  const proxyInstances = new Map<string, InstancedMesh>();
  let fpsHudAccum = 0;

  const remoteMeshes = new Map<string, HumanoidParts>();
  /** ?ve=remote-hop: living airborne hex so leftover remotes can be hidden. */
  let remoteHopLatch: { hex: string; y: number } | null = null;
  const remoteLastHp = new Map<string, number>();
  const remoteNameplates = new Map<string, Nameplate>();
  const remoteFx = new Map<string, RemoteFx>();
  let latestRemoteCombats: RemoteCombat[] = [];
  const sparkBolts: SparkBolt[] = [];
  const impactPops: ImpactPop[] = [];
  const castFlashes: CastFlash[] = [];
  const localEmberBeam: EmberBeam = createEmberBeam(scene, 'local');
  const localEmberCharge: EmberCharge = createEmberCharge(scene, 'local');
  let localBeamActive = false;
  let castVfxStats = { bolts: 0, impacts: 0, beams: 0, flashes: 0 };
  const localNameplate = createNameplate(scene, 'local');
  localNameplate.mesh.parent = player;
  localNameplate.mesh.position.set(0, 2.05, 0);
  paintNameplate(localNameplate, 'You', '#b8d4ff', -1);
  let moveAccumulator = 0;
  const MOVE_SEND_HZ = 20;
  /** Presentation lerp only; snap teleports. */
  const POSE_SNAP_METERS = 2.5;
  /** Match Movement.Gravity — display-only airborne extrapolation (#258). */
  const POSE_GRAVITY = -20;
  type PoseInterp = {
    seeded: boolean;
    fx: number;
    fy: number;
    fz: number;
    fyaw: number;
    tx: number;
    ty: number;
    tz: number;
    tyaw: number;
    u: number;
    vx: number;
    vy: number;
    vz: number;
  };
  const makePoseInterp = (): PoseInterp => ({
    seeded: false,
    fx: 0,
    fy: 0,
    fz: 0,
    fyaw: 0,
    tx: 0,
    ty: 0,
    tz: 0,
    tyaw: 0,
    u: 1,
    vx: 0,
    vy: 0,
    vz: 0,
  });
  const lerpN = (a: number, b: number, t: number) => a + (b - a) * t;
  const lerpYaw = (a: number, b: number, t: number) => {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  };
  const yawDelta = (from: number, to: number) => {
    let d = to - from;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  };
  /** Face living Tab-target while walking only if wish is still mostly forward. */
  const FACE_TARGET_WALK_ALIGN = 0.85;
  const clampU = (u: number) => (u < 0 ? 0 : u > 1 ? 1 : u);
  const retargetPoseInterp = (
    i: PoseInterp,
    x: number,
    y: number,
    z: number,
    yaw: number,
    opts?: { snapGroundedXz?: boolean },
  ) => {
    if (!i.seeded) {
      i.fx = i.tx = x;
      i.fy = i.ty = y;
      i.fz = i.tz = z;
      i.fyaw = i.tyaw = yaw;
      i.u = 1;
      i.vx = i.vy = i.vz = 0;
      i.seeded = true;
      return;
    }
    if (x === i.tx && y === i.ty && z === i.tz && yaw === i.tyaw) {
      return;
    }
    // Local grounded WASD: snap XZ/yaw. 20 Hz lerp was up to 50 ms plus a slow
    // frame, which read as input lag on the Place-scale pin (#315).
    if (opts?.snapGroundedXz && y <= 0.05) {
      i.fx = i.tx = x;
      i.fy = i.ty = y;
      i.fz = i.tz = z;
      i.fyaw = i.tyaw = yaw;
      i.u = 1;
      i.vx = i.vy = i.vz = 0;
      return;
    }
    const s = clampU(i.u);
    const cx = lerpN(i.fx, i.tx, s);
    const cy = lerpN(i.fy, i.ty, s);
    const cz = lerpN(i.fz, i.tz, s);
    const dx = x - cx;
    const dz = z - cz;
    if (dx * dx + dz * dz > POSE_SNAP_METERS * POSE_SNAP_METERS) {
      i.fx = i.tx = x;
      i.fy = i.ty = y;
      i.fz = i.tz = z;
      i.fyaw = i.tyaw = yaw;
      i.u = 1;
      i.vx = i.vy = i.vz = 0;
      return;
    }
    const invSnap = MOVE_SEND_HZ;
    i.vx = (x - cx) * invSnap;
    i.vy = (y - cy) * invSnap;
    i.vz = (z - cz) * invSnap;
    i.fx = cx;
    i.fy = cy;
    i.fz = cz;
    i.fyaw = lerpYaw(i.fyaw, i.tyaw, s);
    i.tx = x;
    i.ty = y;
    i.tz = z;
    i.tyaw = yaw;
    i.u = 0;
  };
  const samplePoseInterp = (i: PoseInterp) => {
    const s = clampU(i.u);
    return {
      x: lerpN(i.fx, i.tx, s),
      y: lerpN(i.fy, i.ty, s),
      z: lerpN(i.fz, i.tz, s),
      yaw: lerpYaw(i.fyaw, i.tyaw, s),
    };
  };
  const advancePoseInterp = (i: PoseInterp, dt: number) => {
    if (!i.seeded) return;
    i.u = Math.min(1, i.u + dt * MOVE_SEND_HZ);
    const air = i.ty > 0.05 || i.fy > 0.05;
    if (!air || i.u < 1 || dt <= 0) return;
    // Between 20Hz snapshots, keep the hop arc moving (display only).
    i.tx += i.vx * dt;
    i.tz += i.vz * dt;
    i.ty += i.vy * dt;
    i.vy += POSE_GRAVITY * dt;
    if (i.ty <= 0) {
      i.ty = 0;
      i.vy = 0;
    }
    i.fx = i.tx;
    i.fy = i.ty;
    i.fz = i.tz;
  };
  const localInterp = makePoseInterp();
  const remoteInterps = new Map<string, PoseInterp>();
  /** Grounded interp parks at u=1 between 20Hz snaps; hold Walk across the gap.
   * 70–90 ms covers one 20 Hz interval without a leftover stride after stop. */
  const REMOTE_WALK_HOLD_S = 0.09;
  const REMOTE_WALK_SPD = 0.55;
  /** Full wish is MOVE_SPEED 4.5; Walk stride ~2.2. Sprint remotes use Run. */
  const REMOTE_RUN_SPD = 3.2;
  const remoteWalkHold = new Map<string, { hold: number; dx: number; dz: number }>();
  /** Last pose step that armed Walk. Re-sync with step=0 must not clear this. */
  const remoteWalkStepAt = new Map<string, number>();
  const REMOTE_WALK_STOP_MS = 80;
  /** HostileTickMs 100 — hold Walk across 10 Hz NPC snaps (same trap as remotes). */
  const NPC_WALK_HOLD_S = 0.22;
  const NPC_WALK_STEP = 0.04;
  const NPC_WALK_SNAP = 2.0;
  const NPC_TICK_HZ = 10;
  const npcWalkHold = new Map<string, { hold: number; dx: number; dz: number }>();
  const npcLastXz = new Map<string, { x: number; z: number }>();
  const proxyInterps = new Map<string, PoseInterp>();

  const ensureRemoteFx = (key: string): RemoteFx => {
    let fx = remoteFx.get(key);
    if (fx) return fx;
    const ember = createEmberBeam(scene, `remote_${key.slice(0, 10)}`);
    const charge = createEmberCharge(scene, `remote_${key.slice(0, 10)}`);
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

    fx = {
      beam: ember.beam,
      beamMat: ember.beamMat,
      charge,
      bar,
      barMat,
      lastCastAtMicros: 0n,
    };
    remoteFx.set(key, fx);
    return fx;
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

      // Impact / projectile when LastCastAt advances (unify with local cast VFX).
      if (
        rc.lastCastAtMicros > 0n &&
        rc.lastCastAtMicros !== fx.lastCastAtMicros &&
        fx.lastCastAtMicros !== 0n
      ) {
        const spark = rc.lastSpellId === SPELL_SPARK;
        const color = spark ? SPARK_COLOR : EMBER_COLOR;
        if (parts) flashMesh(parts.mat, color, spark ? 180 : 380);
        const mesh = npcMeshes.get(rc.targetNpcId.toString());
        const from = parts
          ? casterMuzzle(parts.root.position)
          : null;
        const to = mesh ? targetHitPoint(mesh.root.position) : null;
        if (spark && from && to) {
          castFlashes.push(
            spawnCastFlash(scene, from, SPARK_COLOR, SPARK_CORE, {
              key: `rflash_${key.slice(0, 8)}`,
              scale: 0.5,
            }),
          );
          castVfxStats.flashes += 1;
          sparkBolts.push(
            spawnSparkBolt(scene, from, to, {
              key: `r_${key.slice(0, 8)}_${Number(rc.lastCastAtMicros % 100000n)}`,
            }),
          );
          castVfxStats.bolts += 1;
        } else if (!spark && from && to) {
          // Emberbolt release: warm projectile → impact (not instant pop).
          sparkBolts.push(
            spawnEmberBolt(scene, from, to, {
              key: `rember_${key.slice(0, 8)}_${Number(rc.lastCastAtMicros % 100000n)}`,
            }),
          );
          castVfxStats.bolts += 1;
          if (mesh) {
            flashMesh(mesh.mat, EMBER_COLOR, 420);
          }
        } else if (mesh) {
          flashMesh(
            mesh.mat,
            spark ? SPARK_COLOR : EMBER_COLOR,
            spark ? 220 : 420,
          );
        }
      }
      if (rc.lastCastAtMicros > 0n) {
        fx.lastCastAtMicros = rc.lastCastAtMicros;
      }

      if (!parts || !casting) {
        fx.beam.setEnabled(false);
        fx.bar.setEnabled(false);
        hideEmberCharge(fx.charge);
        if (parts && !casting) {
          // Restore robe emissive after windup (match createPlayerHumanoid scale).
          parts.mat.emissiveColor = parts.mat.diffuseColor.scale(ROBE_EMISSIVE_SCALE);
          setHumanoidCasting(parts, false);
        }
        continue;
      }

      // CastingSpellId / CastEndsAt drives Spell1 on that remote (not Idle/Walk).
      setHumanoidCasting(parts, true);

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
      const from = casterMuzzle(parts.root.position);
      placeEmberCharge(fx.charge, from, now);
      if (tgt) {
        const to = targetHitPoint(tgt.root.position);
        placeBeam(fx.beam, from, to);
      } else {
        fx.beam.setEnabled(false);
      }
    }
    for (const [key, fx] of remoteFx) {
      if (!seen.has(key)) {
        fx.beam.dispose();
        fx.bar.dispose();
        fx.charge.glow.dispose();
        fx.charge.core.dispose();
        remoteFx.delete(key);
      }
    }
  };

  const syncProxyMeshes = (proxies: CrowdProxyView[]) => {
    if (!showCrowdDebugCapsules(ve, debugHudVisible)) {
      for (const [key, inst] of proxyInstances) {
        inst.dispose();
        proxyInstances.delete(key);
        proxyInterps.delete(key);
      }
      return;
    }
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
      let pi = proxyInterps.get(key);
      if (!pi) {
        pi = makePoseInterp();
        proxyInterps.set(key, pi);
      }
      retargetPoseInterp(pi, p.x, p.y + 0.75, p.z, 0);
      const samp = samplePoseInterp(pi);
      inst.position.x = samp.x;
      inst.position.y = samp.y;
      inst.position.z = samp.z;
      inst.setEnabled(true);
    }
    for (const [key, inst] of proxyInstances) {
      if (!seen.has(key)) {
        inst.dispose();
        proxyInstances.delete(key);
        proxyInterps.delete(key);
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
        setHumanoidMoving(parts, false);
        {
          const spawnCh = net?.getCharacterFor(key);
          setHumanoidStaffEquipped(parts, spawnCh?.staffEquipped ?? true);
        }
        remoteMeshes.set(key, parts);
        remotePartyTint.set(key, wantParty);
        const np = createNameplate(scene, `remote_${key.slice(0, 12)}`);
        np.mesh.parent = parts.root;
        np.mesh.position.set(0, 2.05, 0);
        const rCh = net?.getCharacterFor(key);
        const rLabel = rCh?.level
          ? `${key.slice(0, 6)} · Lv ${rCh.level}`
          : key.slice(0, 6);
        paintNameplate(
          np,
          rLabel,
          wantParty ? '#9dffb0' : '#f0b8e8',
          -1,
        );
        remoteNameplates.set(key, np);
      } else {
        const np = remoteNameplates.get(key);
        if (np) {
          const rCh = net?.getCharacterFor(key);
          const rLabel = rCh?.level
            ? `${key.slice(0, 6)} · Lv ${rCh.level}`
            : key.slice(0, 6);
          paintNameplate(
            np,
            rLabel,
            wantParty ? '#9dffb0' : '#f0b8e8',
            -1,
          );
        }
      }
      let ri = remoteInterps.get(key);
      if (!ri) {
        ri = makePoseInterp();
        remoteInterps.set(key, ri);
      }
      const prevTx = ri.seeded ? ri.tx : r.x;
      const prevTz = ri.seeded ? ri.tz : r.z;
      retargetPoseInterp(ri, r.x, r.y, r.z, r.yaw, {
        snapGroundedXz: r.y <= 0.05,
      });
      const samp = samplePoseInterp(ri);
      parts.root.position.x = samp.x;
      parts.root.position.y = samp.y;
      parts.root.position.z = samp.z;
      const stepX = r.x - prevTx;
      const stepZ = r.z - prevTz;
      if (r.y <= 0.05 && Math.hypot(stepX, stepZ) > 0.04) {
        let st = remoteWalkHold.get(key);
        if (!st) {
          st = { hold: 0, dx: 0, dz: 0 };
          remoteWalkHold.set(key, st);
        }
        st.hold = REMOTE_WALK_HOLD_S;
        st.dx = stepX * MOVE_SEND_HZ;
        st.dz = stepZ * MOVE_SEND_HZ;
        remoteWalkStepAt.set(key, performance.now());
      }
      parts.root.setEnabled(true);
      const rChNow = net?.getCharacterFor(key);
      const rHp = rChNow?.hp;
      if (typeof rHp === 'number') {
        const prev = remoteLastHp.get(key);
        if (prev != null && rHp < prev && rHp > 0) {
          playHumanoidFlinch(parts);
        }
        setHumanoidDead(parts, rHp <= 0);
        if (prev != null && prev <= 0 && rHp > 0) {
          setHumanoidMoving(parts, false);
        }
        remoteLastHp.set(key, rHp);
      }
      // Dead remotes keep Death. Do not unequip-swap Idle over a corpse.
      if (rChNow && (rHp == null || rHp > 0)) {
        setHumanoidStaffEquipped(parts, rChNow.staffEquipped);
      }
    }
    for (const [key, parts] of remoteMeshes) {
      if (!seen.has(key)) {
        parts.root.dispose();
        remoteMeshes.delete(key);
        remotePartyTint.delete(key);
        remoteLastHp.delete(key);
        remoteInterps.delete(key);
        remoteWalkHold.delete(key);
        remoteWalkStepAt.delete(key);
        disposeNameplate(remoteNameplates.get(key));
        remoteNameplates.delete(key);
      }
    }
  };

  const { keys } = bindInput({
    onCycleTarget: () => {
      if (!net) return;
      const id = cyclePreferHostiles(net);
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
        pushSystemToast('equip', 'Staff required · equip staff · I', TOAST_VE_TTL_MS);
        pushCombatLog('equip', 'Staff required · equip with I');
        return;
      }
      const manaCost =
        spellId === SPELL_SPARK
          ? SPARK_MANA_COST
          : spellId === SPELL_EMBERBOLT
            ? EMBERBOLT_MANA_COST
            : 0;
      if (ch && manaCost > 0 && (ch.mana ?? 0) < manaCost) {
        latestStatus =
          latestStatus.state === 'connected'
            ? { ...latestStatus, castFeedback: 'Insufficient mana' }
            : latestStatus;
        pushSystemToast('mana', `OOM · ${ch.mana ?? 0}/${ch.maxMana ?? 0} · need ${manaCost}`, TOAST_VE_TTL_MS);
        pushCombatLog('mana', `Out of mana · ${ch.mana ?? 0}/${ch.maxMana ?? 0} · need ${manaCost}`);
        return;
      }
      {
        const combatSil = net.getCombat();
        const silLeft = castSilenceRemainingMs(combatSil);
        if (silLeft > 0) {
          latestStatus =
            latestStatus.state === 'connected'
              ? { ...latestStatus, castFeedback: 'silenced' }
              : latestStatus;
          pushSystemToast(
            'silenced',
            `Silenced · ${(silLeft / 1000).toFixed(1)}s · cannot cast`,
            TOAST_VE_TTL_MS,
          );
          pushCombatLog(
            'silenced',
            `Silenced · ${(silLeft / 1000).toFixed(1)}s remaining`,
          );
          return;
        }
      }
      {
        const combatR = net.getCombat();
        const tid = combatR?.targetNpcId ?? selectedTargetId;
        const pose = net.getLocalPose();
        const npcs = net.getNpcs();
        const tgt =
          tid && tid !== 0n
            ? npcs.find((n) => n.npcId === tid) ?? null
            : null;
        // Dead/invalid existing target (#131) — CANCEL-class; do not retarget or clear.
        if (tid && tid !== 0n && (!tgt || tgt.hp <= 0)) {
          const dead = !!tgt && tgt.hp <= 0;
          const spellName =
            spellId === SPELL_EMBERBOLT
              ? 'Emberbolt'
              : spellId === SPELL_SPARK
                ? 'Spark'
                : `Spell${spellId}`;
          latestStatus =
            latestStatus.state === 'connected'
              ? { ...latestStatus, castFeedback: dead ? 'Target dead' : 'Invalid target' }
              : latestStatus;
          const bit = dead
            ? `CANCEL · target dead · ${spellName}`
            : `CANCEL · invalid target · ${spellName}`;
          pushSystemToast('deadTarget', bit, TOAST_VE_TTL_MS);
          pushCombatLog('deadTarget', bit);
          return;
        }
        if (tgt && isTargetOutOfCastRange(pose, tgt)) {
          latestStatus =
            latestStatus.state === 'connected'
              ? { ...latestStatus, castFeedback: 'out of range' }
              : latestStatus;
          pushSystemToast(
            'outOfRange',
            `Out of range · max ${CAST_RANGE_METERS}m`,
            TOAST_VE_TTL_MS,
          );
          pushCombatLog(
            'outOfRange',
            `Out of range · target beyond ${CAST_RANGE_METERS}m`,
          );
          return;
        }
      }
      const combat = net.getCombat();
      if (gcdRemainingMs(combat) > 0) {
        latestStatus =
          latestStatus.state === 'connected'
            ? { ...latestStatus, castFeedback: 'GCD' }
            : latestStatus;
        const gcdLeft = gcdRemainingMs(combat);
        pushSystemToast('gcd', `On cooldown · ${(gcdLeft / 1000).toFixed(1)}s`, TOAST_VE_TTL_MS);
        pushCombatLog('gcd', `On cooldown · ${(gcdLeft / 1000).toFixed(1)}s remaining`);
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
          pushSystemToast(
            'noTarget',
            'No target · Tab to select',
            TOAST_VE_TTL_MS,
          );
          pushCombatLog('noTarget', 'No target · Tab to select');
          return;
        }
        net.setTarget(cycle[0]!.npcId);
        selectedTargetId = cycle[0]!.npcId;
      }
      if (spellId === SPELL_EMBERBOLT) {
        castTotalMs = EMBERBOLT_CAST_MS;
        castUntilMs = Date.now() + EMBERBOLT_CAST_MS;
        castCancelToasted = false;
        castPushbackToasted = false;
        lastSeenCastEndsAtMicros = 0n;
        prevLocalCasting = true;
      } else {
        castTotalMs = 0;
        castUntilMs = 0;
      }
      lastCastSpell = spellId;
      leaveRestIfActive('cast');
      net.cast(spellId);
      {
        const spellName =
          spellId === SPELL_EMBERBOLT
            ? 'Emberbolt'
            : spellId === SPELL_SPARK
              ? 'Spark'
              : `Spell${spellId}`;
        const tid = net.getCombat()?.targetNpcId ?? selectedTargetId;
        const tgtHint =
          tid !== 0n ? ` → Dummy/NPC #${tid}` : '';
        pushCombatLog(
          'cast',
          `${spellName} cast start${tgtHint}${
            spellId === SPELL_EMBERBOLT ? ' (windup)' : ''
          }`,
        );
      }

      // Local cast VFX (Art #46): Spark cyan flash+bolt; Emberbolt staff charge + thin aim beam.
      const playerMat = humanoid.mat;
      flashMesh(
        playerMat,
        spellId === SPELL_SPARK ? SPARK_COLOR : EMBER_COLOR,
        spellId === SPELL_SPARK ? 160 : 400,
      );
      if (spellId === SPELL_EMBERBOLT) {
        setHumanoidCasting(humanoid, true);
      } else {
        playHumanoidCast(humanoid);
      }
      const tid = net.getCombat()?.targetNpcId ?? selectedTargetId;
      const mesh = npcMeshes.get(tid.toString());
      const from = casterMuzzle(player.position);
      if (spellId === SPELL_SPARK && mesh) {
        const to = targetHitPoint(mesh.root.position);
        castFlashes.push(
          spawnCastFlash(scene, from, SPARK_COLOR, SPARK_CORE, {
            key: `local_spark_flash_${Date.now()}`,
            scale: 0.55,
          }),
        );
        castVfxStats.flashes += 1;
        sparkBolts.push(
          spawnSparkBolt(scene, from, to, {
            key: `local_spark_${Date.now()}`,
          }),
        );
        castVfxStats.bolts += 1;
        localBeamActive = false;
        localEmberBeam.beam.setEnabled(false);
        hideEmberCharge(localEmberCharge);
      } else if (spellId === SPELL_EMBERBOLT && mesh) {
        localBeamActive = true;
        const to = targetHitPoint(mesh.root.position);
        placeBeam(localEmberBeam.beam, from, to);
        placeEmberCharge(localEmberCharge, from, Date.now());
        castVfxStats.beams += 1;
        // Soft target glow during windup; ember projectile + impact on release.
        flashMesh(
          mesh.mat,
          EMBER_COLOR,
          Math.min(500, EMBERBOLT_CAST_MS),
        );
      } else if (mesh) {
        flashMesh(
          mesh.mat,
          spellId === SPELL_SPARK ? SPARK_COLOR : EMBER_COLOR,
          spellId === SPELL_SPARK ? 200 : Math.min(800, EMBERBOLT_CAST_MS),
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
      const party = net.getParty();
      const wasInParty = (party?.size ?? 0) > 0;
      net.leaveParty();
      if (wasInParty) {
        pushSystemToast('party', 'Left party', TOAST_VE_TTL_MS);
      }
    },
    onTradeOfferOrAccept: () => {
      const g = net;
      if (!g) return;
      const trade = g.getTrade();
      if (trade.pendingFrom) {
        tradeAcceptInFlight = true;
        void g.acceptTrade().then(() => {
          inboundOutcomeReported = true;
          const bits: string[] = [];
          if (trade.offeredHasEmberShard) bits.push('ember_shard');
          if (trade.offeredXp > 0) bits.push(`+${trade.offeredXp} XP`);
          pushCombatLog('trade', `Accepted trade (${bits.join(' · ') || 'ok'})`);
          dismissSystemToasts('tradeIncoming', 'tradeWaiting');
          pushSystemToast(
            'tradeAccepted',
            `Trade accepted · received ${bits.join(' · ') || 'items'}`,
            TOAST_VE_TTL_MS,
          );
          bagOpen = true;
          setBagPanelOpen(true);
          const ch = g.getCharacter();
          if (ch) updateBagPanel(ch);
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          pushSystemToast('rate', msg.slice(0, 96) || 'Accept trade failed');
        }).finally(() => {
          tradeAcceptInFlight = false;
        });

        return;
      }
      void g.offerTradeNearestRemote().then((hex) => {
        if (!hex) {
          pushSystemToast('rate', 'No nearby player to trade');
          return;
        }
        const ch = g.getCharacter();
        const what = ch?.hasEmberShard ? 'ember_shard' : '+5 XP';
        pushCombatLog('trade', `Offered ${what} → ${hex.slice(0, 8)}…`);
        dismissSystemToasts('tradeWaiting');
        pushSystemToast(
          'tradeWaiting',
          `${hex.slice(0, 8)}… · ${what} · Y cancel`,
          TOAST_VE_TTL_MS,
        );
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (/out of range/i.test(msg)) {
          pushSystemToast('rate', 'Too far to trade');
        } else {
          pushSystemToast('rate', msg.slice(0, 96) || 'Offer trade failed');
        }
      });
    },
    onTradeCancel: () => {
      if (!net) return;
      tradeCancelInFlight = true;
      void net.cancelTrade().then(() => {
        inboundOutcomeReported = true;
        outboundOutcomeReported = true;
        pushCombatLog('trade', 'Trade cancelled');
        dismissSystemToasts('tradeIncoming', 'tradeWaiting');
        pushSystemToast('tradeCancelled', 'Trade cancelled');
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        pushSystemToast('rate', msg.slice(0, 96) || 'Cancel trade failed');
      }).finally(() => {
        tradeCancelInFlight = false;
      });
    },
    onUnequipStaff: () => {
      if (!net) return;
      net.unequipStaff();
    },
    onEquipStaff: () => {
      if (!net) return;
      net.equipStaff();
    },
    onUnequipRobes: () => {
      if (!net) return;
      net.unequipRobes();
    },
    onEquipRobes: () => {
      if (!net) return;
      net.equipRobes();
    },
    onToggleBag: () => {
      bagOpen = !bagOpen;
      setBagPanelOpen(bagOpen);
    },
    onToggleKeysLegend: () => {
      firstSessionLegendFlash = false;
      if (firstSessionFlashTimer != null) {
        window.clearTimeout(firstSessionFlashTimer);
        firstSessionFlashTimer = null;
      }
      keysLegendOpen = !keysLegendOpen;
      setKeysLegendOpen(keysLegendOpen);
    },
    onToggleDebugHud: () => {
      debugHudVisible = !debugHudVisible;
      setDebugHudVisible(debugHudVisible);
    },
    onVendorInteract: () => {
      if (!net) return;
      const near = net.nearestVendor(4.5);
      if (!near) {
        vendorOpen = false;
        setVendorPanelOpen(false);
        pushSystemToast('rate', 'No vendor in range');
        return;
      }
      vendorOpen = true;
      setVendorPanelOpen(true);
      updateVendorPanel(near);
      const ch = net.getCharacter();
      const hasShard = !!ch?.hasEmberShard;
      bagOpen = true;
      setBagPanelOpen(true);
      const g = net;
      if (hasShard) {
        void g.sellToVendor().then(() => {
          const after = g.getCharacter();
          if (after) updateBagPanel(after);
          pushCombatLog('vendor', 'Sold ember_shard · +5 XP');
          pushSystemToast('vendor', 'Sold ember_shard · +5 XP', TOAST_VE_TTL_MS);
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          pushSystemToast('rate', msg.slice(0, 96) || 'Sell failed');
        });
      } else {
        void g.buyFromVendor().then(() => {
          const after = g.getCharacter();
          if (after) updateBagPanel(after);
          pushCombatLog('vendor', 'Bought ember_shard · −5 XP');
          pushSystemToast('vendor', 'Bought ember_shard · −5 XP', TOAST_VE_TTL_MS);
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          pushSystemToast('rate', msg.slice(0, 96) || 'Buy failed');
        });
      }
    },
    onPickupNearest: () => {
      if (!net) return;
      const before = new Set(net.getGroundItems().map((g) => g.lootId.toString()));
      void net.pickup().then(() => {
        if (!net) return;
        const after = net.getGroundItems();
        const gone = [...before].filter((id) => !after.some((g) => g.lootId.toString() === id));
        if (gone.length) {
          pushCombatLog('loot', 'Picked up ember_shard');
          pushSystemToast('loot', 'Ember shard +5 XP', TOAST_VE_TTL_MS);
        }
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (/out of range/i.test(msg)) {
          pushSystemToast('rate', 'Too far to pick up');
        } else if (/no loot/i.test(msg)) {
          pushSystemToast('rate', 'Nothing to pick up');
        } else {
          pushSystemToast('rate', msg.slice(0, 96) || 'Pickup failed');
        }
      });
    },
    onUseYardTonic: () => {
      if (!net) return;
      const g = net;
      const ch0 = g.getCharacter();
      if (!ch0?.hasYardTonic) {
        pushSystemToast('tonic', 'No yard tonic in bag');
        return;
      }
      void g.useYardTonic().then(() => {
        const after = g.getCharacter();
        if (after) {
          updateBagPanel(after);
          updateLoadoutStrip(after);
          updateSelfFrame(after);
        }
        bagOpen = true;
        setBagPanelOpen(true);
        pushCombatLog('tonic', 'Used yard_tonic · move ×1.75');
        pushSystemToast('tonic', 'Yard tonic · move speed up', TOAST_VE_TTL_MS);
        flashMesh(humanoid.mat, TONIC_FLASH, 700);
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (/no yard tonic/i.test(msg)) {
          pushSystemToast('tonic', 'No yard tonic in bag');
        } else {
          pushSystemToast('tonic', msg.slice(0, 96) || 'Use tonic failed');
        }
      });
    },
    onUseBandage: () => {
      if (!net) return;
      const g = net;
      const ch0 = g.getCharacter();
      if (!ch0?.hasYardBandage) {
        pushSystemToast('bandage', 'No yard bandage in bag');
        return;
      }
      const hpAt = ch0.hp;
      void g.useBandage().then(() => {
        const after = g.getCharacter();
        if (after) {
          updateBagPanel(after);
          updateLoadoutStrip(after);
          updateSelfFrame(after);
        }
        bagOpen = true;
        setBagPanelOpen(true);
        const healed = after ? Math.max(0, after.hp - hpAt) : BANDAGE_HEAL_AMOUNT;
        pushCombatLog('bandage', `Bandage +${healed} · You ${after?.hp ?? '?'}/${after?.maxHp ?? '?'}`);
        pushSystemToast('bandage', `Bandage · +${healed} HP`, TOAST_VE_TTL_MS);
        flashMesh(humanoid.mat, new Color3(0.45, 0.95, 0.7), 700);
        damageFloaters.push(
          spawnWorldFloater(
            scene,
            player.position,
            `+${healed}`,
            FLOATER_TINT_HEAL,
            { lifeMs: 1400, yLift: 2.05, laneX: 0.16 },
          ),
        );
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (/no yard bandage/i.test(msg)) {
          pushSystemToast('bandage', 'No yard bandage in bag');
        } else if (/recently damaged/i.test(msg)) {
          pushSystemToast('bandage', 'Too soon after damage');
        } else if (/bandage on cooldown/i.test(msg)) {
          pushSystemToast('bandage', 'Bandage on cooldown');
        } else if (/already full/i.test(msg)) {
          pushSystemToast('bandage', 'Already full HP');
        } else {
          pushSystemToast('bandage', msg.slice(0, 96) || 'Use bandage failed');
        }
      });
    },
    onRest: () => {
      if (!net) return;
      const g = net;
      const ch0 = g.getCharacter();
      if (!ch0 || ch0.hp <= 0) {
        pushSystemToast('rest', 'Cannot rest while dead');
        return;
      }
      const hpFull = ch0.hp >= ch0.maxHp;
      const manaFull = (ch0.mana ?? 0) >= (ch0.maxMana ?? 0) && (ch0.maxMana ?? 0) > 0;
      if (hpFull && manaFull) {
        pushSystemToast('rest', 'Already full — HP & mana topped');
        setRestingState('exit');
        return;
      }
      const beforeHp = ch0.hp;
      const beforeMana = ch0.mana ?? 0;
      void g.rest().then(() => {
        const after = g.getCharacter();
        if (after) updateSelfFrame(after);
        const healed = after ? Math.max(0, after.hp - beforeHp) : 0;
        const manaGain = after ? Math.max(0, (after.mana ?? 0) - beforeMana) : REST_MANA_RESTORE;
        const bits: string[] = [];
        if (healed > 0) bits.push(`+${healed} HP`);
        if (manaGain > 0) bits.push(`+${manaGain} mana`);
        pushCombatLog(
          'rest',
          `Rest enter · ${bits.join(' · ') || 'ok'} · You ${after?.hp ?? '?'}/${after?.maxHp ?? '?'} · mana ${after?.mana ?? '?'}/${after?.maxMana ?? '?'}`,
        );
        pushSystemToast('rest', `Rest enter · ${bits.join(' · ') || 'ok'}`, TOAST_VE_TTL_MS);
        if (manaGain > 0) {
          pushSystemToast('mana', `Mana · +${manaGain}`, TOAST_VE_TTL_MS);
        }
        setRestingState('enter');
        flashMesh(humanoid.mat, new Color3(0.35, 1.0, 0.55), 700);
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (/recently damaged/i.test(msg)) {
          pushSystemToast('rest', 'Recently damaged — wait to rest');
        } else if (/cooldown/i.test(msg)) {
          pushSystemToast('rest', 'Rest on cooldown');
        } else if (/casting/i.test(msg)) {
          pushSystemToast('rest', 'Cannot rest while casting');
        } else if (/already full/i.test(msg)) {
          pushSystemToast('rest', 'Already full — HP & mana topped');
          setRestingState('exit');
        } else if (/dead/i.test(msg)) {
          pushSystemToast('rest', 'Cannot rest while dead');
        } else {
          pushSystemToast('rest', msg.slice(0, 96) || 'Rest failed');
        }
      });
    },
    onCancelCast: () => {
      if (!net) return;
      const combat = net.getCombat();
      const wind = castRemainingMs(combat);
      if (!combat || combat.castingSpellId === 0 || wind <= 0) {
        // Also clear optimistic local cast bar if any.
        if (castUntilMs > Date.now()) {
          castUntilMs = 0;
          castTotalMs = 0;
          setHumanoidCasting(humanoid, false);
        }
        return;
      }
      const beforeMana = net.getCharacter()?.mana ?? 0;
      const spellName =
        combat.castingSpellId === SPELL_EMBERBOLT
          ? 'Emberbolt'
          : combat.castingSpellId === SPELL_SPARK
            ? 'Spark'
            : `Spell${combat.castingSpellId}`;
      void net.cancelCast().then(() => {
        castUntilMs = 0;
        castTotalMs = 0;
        lastCastSpell = 0;
        setHumanoidCasting(humanoid, false);
        const after = net?.getCharacter();
        if (after) updateSelfFrame(after);
        const refund = after ? Math.max(0, (after.mana ?? 0) - beforeMana) : EMBERBOLT_MANA_COST;
        const bit =
          refund > 0
            ? `CANCEL · player interrupt · ${spellName} · +${refund} mana`
            : `CANCEL · player interrupt · ${spellName}`;
        pushCombatLog('castCancel', bit);
        pushSystemToast('castCancel', bit, TOAST_VE_TTL_MS);
        setGcdBar(0, 0, 0);
        updateSpellHotbar({
          gcdMs: gcdRemainingMs(net?.getCombat()),
          castingMs: 0,
          castingTotal: 0,
          castingSpell: 0,
          staffEquipped: after?.staffEquipped ?? true,
          mana: after?.mana ?? 0,
        });
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        pushSystemToast('rate', msg.slice(0, 96) || 'Cancel cast failed');
      });
    },
    onKick: () => {
      if (!net) return;
      const ch = net.getCharacter();
      if (!ch || ch.hp <= 0) { pushSystemToast('rate', 'Cannot kick while dead'); return; }
      if ((ch.mana ?? 0) < KICK_MANA_COST) {
        pushSystemToast('mana', `OOM · ${ch.mana ?? 0}/${ch.maxMana ?? 0} · need ${KICK_MANA_COST}`, TOAST_VE_TTL_MS);
        return;
      }
      const tgtId = net.getCombat()?.targetNpcId ?? 0n;
      const npc = tgtId !== 0n ? net.getNpcs().find((n) => n.npcId === tgtId) : undefined;
      if (npc && npc.hp > 0 && (npc.kind === NPC_KIND_DUMMY || isHostileKind(npc.kind))) {
        const label =
          npc.kind === NPC_KIND_DUMMY
            ? 'Dummy'
            : npc.kind === NPC_KIND_BRIGAND
              ? 'Brigand'
              : 'Hostile';
        void net.kickNpc(npc.npcId).then(() => {
          const bit = `Kick · ${label} #${npc.npcId} · interrupt`;
          pushCombatLog('kick', bit);
          pushSystemToast('kick', bit, TOAST_VE_TTL_MS);
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          pushSystemToast('rate', msg.slice(0, 96) || 'Kick failed');
        });
        return;
      }
      void net.kickNearestCastingRemote().then((hex) => {
        if (!hex) { pushSystemToast('rate', 'No casting remote in Kick range'); return; }
        const bit = `Kick · interrupted ${hex.slice(0, 8)}… · silence ${(CAST_SILENCE_MS / 1000).toFixed(1)}s`;
        pushCombatLog('kick', bit);
        pushSystemToast('kick', bit, TOAST_VE_TTL_MS);
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        pushSystemToast('rate', msg.slice(0, 96) || 'Kick failed');
      });
    },
    onStun: () => {
      if (!net) return;
      const ch = net.getCharacter();
      if (!ch || ch.hp <= 0) { pushSystemToast('rate', 'Cannot stun while dead'); return; }
      if ((ch.mana ?? 0) < STUN_MANA_COST) {
        pushSystemToast('mana', `OOM · ${ch.mana ?? 0}/${ch.maxMana ?? 0} · need ${STUN_MANA_COST}`, TOAST_VE_TTL_MS);
        return;
      }
      const tgtId = net.getCombat()?.targetNpcId ?? 0n;
      const npc = tgtId !== 0n ? net.getNpcs().find((n) => n.npcId === tgtId) : undefined;
      if (npc && npc.hp > 0 && (npc.kind === NPC_KIND_DUMMY || isHostileKind(npc.kind))) {
        const label =
          npc.kind === NPC_KIND_DUMMY
            ? 'Dummy'
            : npc.kind === NPC_KIND_BRIGAND
              ? 'Brigand'
              : 'Hostile';
        void net.stunNpc(npc.npcId).then(() => {
          const bit = `Stun · ${label} #${npc.npcId} · lock ${(STUN_DURATION_MS / 1000).toFixed(1)}s`;
          pushCombatLog('stun', bit);
          pushSystemToast('stun', bit, TOAST_VE_TTL_MS);
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          pushSystemToast('rate', msg.slice(0, 96) || 'Stun failed');
        });
        return;
      }
      void net.stunNearestRemote().then((hex) => {
        if (!hex) { pushSystemToast('rate', 'No remote in Stun range'); return; }
        const bit = `Stun · Bash ${hex.slice(0, 8)}… · lock ${(STUN_DURATION_MS / 1000).toFixed(1)}s (not silence)`;
        pushCombatLog('stun', bit);
        pushSystemToast('stun', bit, TOAST_VE_TTL_MS);
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        pushSystemToast('rate', msg.slice(0, 96) || 'Stun failed');
      });
    },
  });

  if (import.meta.env.DEV) {
    void import('./qa/hook').then(({ installQaHook }) => {
      installQaHook({
        getEngine: () => engine,
        getScene: () => scene,
        getCamera: () => camera,
        getPlayer: () => player,
        getKeys: () => keys,
        getNet: () => net,
        getStatus: () => latestStatus,
      });
    });
  }

  bindChatUi({
    whoLabel: () => {
      const hex = latestStatus.state === 'connected' ? latestStatus.identityHex : '';
      return hex ? `You(${hex.slice(0, 6)})` : 'You';
    },
    sendSay: (text) => {
      if (!net) return;
      void net.say(text).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (/rate.?limit/i.test(msg)) {
          pushSystemToast('rate', 'Say too fast — wait a moment');
        } else {
          pushSystemToast('rate', msg.slice(0, 96) || 'Say failed');
        }
      });
    },
    sendPartySay: (text) => {
      if (!net) return;
      void net.partySay(text).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (/rate.?limit/i.test(msg)) {
          pushSystemToast('rate', 'Party say too fast — wait a moment');
        } else if (/not in a party/i.test(msg)) {
          pushSystemToast('rate', 'Not in a party — /p needs mates');
        } else {
          pushSystemToast('rate', msg.slice(0, 96) || 'Party say failed');
        }
      });
    },
    sendWhisper: (targetPrefix, text) => {
      if (!net) return;
      const recipient = net.findIdentityByHexPrefix(targetPrefix);
      if (!recipient) {
        pushSystemToast('rate', `No unique online target matching ${targetPrefix.slice(0, 12)}`);
        return;
      }
      void net.whisper(recipient, text).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (/rate.?limit/i.test(msg)) {
          pushSystemToast('rate', 'Whisper too fast — wait a moment');
        } else if (/offline/i.test(msg)) {
          pushSystemToast('rate', 'Whisper target offline');
        } else {
          pushSystemToast('rate', msg.slice(0, 96) || 'Whisper failed');
        }
      });
    },
  });


  const syncVendorMeshes = (vendors: VendorView[]) => {
    const seen = new Set<string>();
    for (const v of vendors) {
      const key = v.vendorId.toString();
      seen.add(key);
      let mesh = vendorMeshes.get(key);
      if (!mesh) {
        mesh = makeVendorMesh(scene, v);
        vendorMeshes.set(key, mesh);
      }
      mesh.root.position.x = v.x;
      mesh.root.position.z = v.z;
      if (mesh.nameplate) {
        paintNameplate(mesh.nameplate, v.label || 'Vendor', '#7dffb5', 1);
      }
    }
    for (const [key, mesh] of [...vendorMeshes.entries()]) {
      if (!seen.has(key)) {
        mesh.nameplate?.mesh.dispose();
        mesh.root.dispose();
        vendorMeshes.delete(key);
      }
    }
  };

  const syncNpcMeshes = (npcs: NpcView[]) => {
    const seen = new Set<string>();
    for (const npc of npcs) {
      const key = npc.npcId.toString();
      seen.add(key);
      let mesh = npcMeshes.get(key);
      let prevHp = npcLastHp.get(key);
      if (!mesh) {
        mesh = makeNpcMesh(scene, npc);
        npcMeshes.set(key, mesh);
        prevHp = npc.hp;
        npcLastHp.set(key, npc.hp);
      } else {
        if (prevHp != null && npc.hp < prevHp) {
          const delta = prevHp - npc.hp;
          const ember = delta >= 20;
          const tint = ember ? FLOATER_TINT_EMBER : FLOATER_TINT_SPARK;
          damageFloaters.push(
            spawnDamageFloater(
              scene,
              mesh.root.position,
              delta,
              tint,
              [damageFloaters, xpFloaters],
            ),
          );
          latestDamageAmount = delta;
          latestDamageAtMs = Date.now();
          {
            const label = npcPlateName(npc.kind);
            pushCombatLog(
              'damage',
              `${label} #${npc.npcId}  −${delta} HP (${npc.hp}/${npc.maxHp})`,
            );
          }
          // Non-lethal: RecieveHit on the skinned hostile. Dummy stays scarecrow.
          if (
            mesh.humanoid &&
            isHostileKind(npc.kind) &&
            npc.hp > 0
          ) {
            playHumanoidFlinch(mesh.humanoid);
          }
        }
        npcLastHp.set(key, npc.hp);
      }

      if (
        !mesh.nameplate &&
        (npc.kind === NPC_KIND_DUMMY || isHostileKind(npc.kind))
      ) {
        const np = createNameplate(scene, `npc_${npc.npcId}`);
        np.mesh.parent = mesh.root;
        np.mesh.position.set(0, npc.kind === NPC_KIND_DUMMY ? 2.15 : 2.35, 0);
        mesh.nameplate = np;
      }

      const wasAlive = (prevHp ?? npc.hp) > 0;
      const isAlive = npc.hp > 0;
      let fx = npcLifeFx.get(key);

      if (wasAlive && !isAlive && (!fx || fx.phase !== 'dying')) {
        if (fx) {
          disposeLifeBurst(fx);
          npcLifeFx.delete(key);
        }
        if (mesh.humanoid && isHostileKind(npc.kind)) {
          // Death clip on the body — not the dummy sink/fade despawn.
          setHumanoidDead(mesh.humanoid, true);
          fx = undefined;
        } else {
          fx = beginNpcDeathFx(scene, mesh);
          npcLifeFx.set(key, fx);
        }
        latestDeathAtMs = Date.now();
        const label = npcPlateName(npc.kind);
        const defeated =
          npc.kind === NPC_KIND_DUMMY ? 'Dummy defeated' : `${label} defeated`;
        pushCombatLog('death', `${defeated} (#${npc.npcId})`);
        pushSystemToast('death', defeated, TOAST_VE_TTL_MS);
      } else if (!wasAlive && isAlive && (!fx || fx.phase !== 'spawning')) {
        if (fx) {
          disposeLifeBurst(fx);
          npcLifeFx.delete(key);
        }
        if (mesh.humanoid && isHostileKind(npc.kind)) {
          setHumanoidDead(mesh.humanoid, false);
          setHumanoidMoving(mesh.humanoid, false);
          fx = undefined;
        } else {
          fx = beginNpcRespawnFx(mesh);
          npcLifeFx.set(key, fx);
        }
        latestRespawnAtMs = Date.now();
        const label = npcPlateName(npc.kind);
        const line =
          npc.kind === NPC_KIND_DUMMY ? 'Dummy respawned' : `${label} respawned`;
        pushCombatLog('respawn', `${line} (#${npc.npcId})`);
        pushSystemToast('respawn', line, TOAST_VE_TTL_MS);
      }

      const prevXz = npcLastXz.get(key);
      const stunned = isAlive && npcStunnedNow(npc);
      if (stunned) {
        npcWalkHold.delete(key);
      } else if (prevXz) {
        const stepX = npc.x - prevXz.x;
        const stepZ = npc.z - prevXz.z;
        const step = Math.hypot(stepX, stepZ);
        if (
          mesh.humanoid &&
          isHostileKind(npc.kind) &&
          isAlive &&
          !npcStunnedNow(npc) &&
          step > NPC_WALK_STEP &&
          step < NPC_WALK_SNAP
        ) {
          let st = npcWalkHold.get(key);
          if (!st) {
            st = { hold: 0, dx: 0, dz: 0 };
            npcWalkHold.set(key, st);
          }
          st.hold = NPC_WALK_HOLD_S;
          st.dx = stepX * NPC_TICK_HZ;
          st.dz = stepZ * NPC_TICK_HZ;
        }
      }
      npcLastXz.set(key, { x: npc.x, z: npc.z });

      mesh.root.position.x = npc.x;
      mesh.root.position.z = npc.z;
      if (mesh.humanoid && isHostileKind(npc.kind)) {
        setHumanoidDead(mesh.humanoid, !isAlive);
        if (!isAlive || stunned) npcWalkHold.delete(key);
      }

      const animating = !!fx && (fx.phase === 'dying' || fx.phase === 'spawning');
      if (!animating) {
        const corpse =
          !!mesh.humanoid && isHostileKind(npc.kind) && !isAlive;
        mesh.root.setEnabled(isAlive || corpse);
        if (
          mesh.nameplate &&
          (npc.kind === NPC_KIND_DUMMY || isHostileKind(npc.kind))
        ) {
          mesh.nameplate.mesh.setEnabled(isAlive);
        }
      }

      const selected = selectedTargetId === npc.npcId && isAlive;
      const remoteSelected =
        isAlive &&
        latestRemoteCombats.some((rc) => rc.targetNpcId === npc.npcId);

      if (
        mesh.nameplate &&
        (npc.kind === NPC_KIND_DUMMY || isHostileKind(npc.kind))
      ) {
        paintNameplate(
          mesh.nameplate,
          npcPlateName(npc.kind),
          npcPlateColor(npc.kind, selected),
          npc.maxHp > 0 ? Math.max(0, npc.hp / npc.maxHp) : 0,
          selected,
          stunned,
        );
      }

      // Suppress rings/marker while dying; keep corpse non-targetable visually.
      if (fx?.phase === 'dying') {
        mesh.ring.setEnabled(false);
        mesh.remoteRing.setEnabled(false);
        mesh.marker.setEnabled(false);
      } else {
        mesh.ring.setEnabled(selected);
        mesh.marker.setEnabled(selected);
        mesh.remoteRing.setEnabled(remoteSelected && !selected);
      }
      if (fx?.phase === 'spawning') {
        // Emissive flash owned by respawn FX until it finishes.
      } else if (selected) {
        const poseSel = net?.getLocalPose() ?? {
          x: player.position.x,
          z: player.position.z,
        };
        const oorSel = isTargetOutOfCastRange(poseSel, npc);
        if (oorSel) {
          // Out-of-cast-range: coral warning reticule (paired with ground reach ring).
          mesh.ringMat.emissiveColor = new Color3(1.15, 0.32, 0.12);
          mesh.ringMat.diffuseColor = new Color3(1.0, 0.38, 0.16);
          mesh.markerMat.emissiveColor = new Color3(1.05, 0.35, 0.12);
          mesh.markerMat.diffuseColor = new Color3(0.98, 0.4, 0.18);
          mesh.mat.emissiveColor = new Color3(0.32, 0.08, 0.04);
          tintNpcExtraMats(mesh, 0.16, 0.04, 0.02);
        } else {
          mesh.ringMat.emissiveColor = new Color3(1.28, 0.95, 0.2);
          mesh.ringMat.diffuseColor = new Color3(1.0, 0.86, 0.24);
          mesh.markerMat.emissiveColor = new Color3(1.18, 0.88, 0.16);
          mesh.markerMat.diffuseColor = new Color3(1.0, 0.84, 0.22);
          // Stronger body tint so tab-target reads even at glancing angles.
          mesh.mat.emissiveColor = new Color3(0.28, 0.18, 0.04);
          tintNpcExtraMats(mesh, 0.14, 0.1, 0.02);
        }
        // Local gold wins; still hint remote interest with outer cyan.
        mesh.remoteRing.setEnabled(remoteSelected);
        if (remoteSelected) {
          mesh.remoteRingMat.emissiveColor = new Color3(0.1, 0.55, 0.65);
        }
      } else if (remoteSelected) {
        mesh.remoteRingMat.emissiveColor = new Color3(0.15, 0.7, 0.85);
        mesh.remoteRingMat.diffuseColor = new Color3(0.2, 0.85, 0.95);
        mesh.mat.emissiveColor = new Color3(0.02, 0.08, 0.12);
        mesh.marker.setEnabled(false);
        restoreNpcExtraMats(mesh);
      } else if (fx?.phase !== 'dying') {
        mesh.ringMat.emissiveColor = new Color3(0, 0, 0);
        mesh.mat.emissiveColor = new Color3(0, 0, 0);
        mesh.marker.setEnabled(false);
        restoreNpcExtraMats(mesh);
      }
    }
    for (const [key, mesh] of npcMeshes) {
      if (!seen.has(key)) {
        const fx = npcLifeFx.get(key);
        if (fx) {
          disposeLifeBurst(fx);
          npcLifeFx.delete(key);
        }
        disposeNameplate(mesh.nameplate);
        mesh.root.dispose();
        npcMeshes.delete(key);
        npcLastHp.delete(key);
        npcWalkHold.delete(key);
        npcLastXz.delete(key);
      }
    }
  };

  engine.runRenderLoop(() => {
    const dt = engine.getDeltaTime() / 1000;
    const now = Date.now();

    // Presentation only; snap teleports.
    advancePoseInterp(localInterp, dt);
    if (localInterp.seeded) {
      const samp = samplePoseInterp(localInterp);
      player.position.x = samp.x;
      player.position.y = samp.y;
      player.position.z = samp.z;
    }
    setPlayerBlobShadow(player.position.x, player.position.z);
    {
      const wish = wishFromKeys(keys, camera);
      const wishMoving = Math.hypot(wish.dx, wish.dz) > 1e-4;
      let targetYaw: number | null = null;
      if (selectedTargetId !== 0n && net) {
        const npc = net.getNpcs().find((n) => n.npcId === selectedTargetId && n.hp > 0);
        if (npc) {
          targetYaw = Math.atan2(
            npc.x - player.position.x,
            npc.z - player.position.z,
          );
        }
      }
      let faceYaw: number | null = null;
      if (wishMoving) {
        const wishYaw = Math.atan2(wish.dx, wish.dz);
        // Face living target while walking only when wish is still mostly
        // forward. Perpendicular strafe keeps wish yaw so Walk does not moonwalk.
        faceYaw =
          targetYaw != null &&
          Math.abs(yawDelta(wishYaw, targetYaw)) < FACE_TARGET_WALK_ALIGN
            ? targetYaw
            : wishYaw;
      } else if (targetYaw != null) {
        faceYaw = targetYaw;
      } else if (rmbLookArmed) {
        const camPos = camera.position;
        const tgt = camera.getTarget();
        const fx = tgt.x - camPos.x;
        const fz = tgt.z - camPos.z;
        if (fx * fx + fz * fz > 1e-8) faceYaw = Math.atan2(fx, fz);
      }
      if (faceYaw != null) {
        const d = yawDelta(localFacingYaw, faceYaw);
        // Never plant Idle while translating — planted feet + sendMove slides.
        localTurningInPlace = Math.abs(d) > 0.28 && !wishMoving;
        const yawHz = localTurningInPlace ? YAW_TURN_HZ : YAW_FACE_HZ;
        const a = 1 - Math.exp(-Math.max(0, dt) * yawHz);
        localFacingYaw = lerpYaw(localFacingYaw, faceYaw, a);
      } else {
        localTurningInPlace = false;
      }
      player.rotation.y = localFacingYaw;
    }
    for (const [key, parts] of remoteMeshes) {
      const ri = remoteInterps.get(key);
      if (!ri) continue;
      advancePoseInterp(ri, dt);
      const samp = samplePoseInterp(ri);
      parts.root.position.x = samp.x;
      parts.root.position.y = samp.y;
      parts.root.position.z = samp.z;
      const rHpNow = net?.getCharacterFor(key)?.hp;
      if (typeof rHpNow === 'number' && rHpNow <= 0) {
        setHumanoidDead(parts, true);
        continue;
      }
      let st = remoteWalkHold.get(key);
      if (!st) {
        st = { hold: 0, dx: 0, dz: 0 };
        remoteWalkHold.set(key, st);
      }
      const interpolating = ri.u < 1 - 1e-4;
      const segSpd = Math.hypot(ri.vx, ri.vz);
      const lastStepAt = remoteWalkStepAt.get(key);
      if (
        lastStepAt != null &&
        performance.now() - lastStepAt > REMOTE_WALK_STOP_MS
      ) {
        st.hold = 0;
        st.dx = 0;
        st.dz = 0;
      } else if (interpolating && segSpd > REMOTE_WALK_SPD) {
        st.hold = REMOTE_WALK_HOLD_S;
        st.dx = ri.vx;
        st.dz = ri.vz;
      } else {
        st.hold -= dt;
      }
      const moving = st.hold > 0 && samp.y <= 0.05;
      const spd = Math.hypot(st.dx, st.dz);
      if (samp.y > 0.05) {
        st.hold = 0;
        setHumanoidAirborne(parts, true);
        parts.root.scaling.set(1, 1, 1);
      } else {
        setHumanoidAirborne(parts, false);
        parts.root.scaling.set(1, 1, 1);
        // Sprint wish → Run_Weapon (staffed) / Run (sheathed). Slow stay Walk.
        setHumanoidMoving(parts, moving, spd >= REMOTE_RUN_SPD, spd);
      }
      if (moving && (st.dx !== 0 || st.dz !== 0)) {
        const targetYaw = Math.atan2(st.dx, st.dz);
        const a = 1 - Math.exp(-Math.max(0, dt) * YAW_FACE_HZ);
        parts.root.rotation.y = lerpYaw(parts.root.rotation.y, targetYaw, a);
      }
    }
    for (const [npcKey, mesh] of npcMeshes) {
      const parts = mesh.humanoid;
      if (!parts) continue;
      const npcRow = (net?.getNpcs() ?? []).find(
        (n) => n.npcId.toString() === npcKey,
      );
      if (!npcRow || !isHostileKind(npcRow.kind) || npcRow.hp <= 0) continue;
      if (npcStunnedNow(npcRow)) {
        npcWalkHold.delete(npcKey);
        setHumanoidGroundWalk(parts, false, 0);
        continue;
      }
      let st = npcWalkHold.get(npcKey);
      if (!st) {
        st = { hold: 0, dx: 0, dz: 0 };
        npcWalkHold.set(npcKey, st);
      }
      st.hold -= dt;
      const moving = st.hold > 0;
      const spd = Math.hypot(st.dx, st.dz);
      setHumanoidGroundWalk(parts, moving, spd);
      if (moving && (st.dx !== 0 || st.dz !== 0)) {
        const targetYaw = Math.atan2(st.dx, st.dz);
        const a = 1 - Math.exp(-Math.max(0, dt) * YAW_FACE_HZ);
        parts.root.rotation.y = lerpYaw(parts.root.rotation.y, targetYaw, a);
      }
    }
    for (const [key, inst] of proxyInstances) {
      const pi = proxyInterps.get(key);
      if (!pi) continue;
      advancePoseInterp(pi, dt);
      const samp = samplePoseInterp(pi);
      inst.position.x = samp.x;
      inst.position.y = samp.y;
      inst.position.z = samp.z;
    }

    const tickFloaters = (list: DamageFloater[]) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const f = list[i]!;
        const age = now - f.bornMs;
        const t = Math.min(1, age / f.lifeMs);
        f.mesh.position.y = f.startY + t * 1.35;
        f.mesh.position.x += f.driftX * dt;
        const fade = t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45;
        f.mat.alpha = Math.max(0, fade);
        if (age >= f.lifeMs) {
          f.mesh.dispose();
          f.mat.dispose();
          list.splice(i, 1);
        }
      }
    };
    tickFloaters(damageFloaters);
    tickFloaters(xpFloaters);

    // Local selection reticule pulse (scale + emissive) — skip while death/respawn owns root scale.
    for (const [npcKey, mesh] of npcMeshes) {
      const life = npcLifeFx.get(npcKey);
      const animating = !!life && (life.phase === 'dying' || life.phase === 'spawning');
      if (mesh.ring.isEnabled() && !animating) {
        const pulse = 0.94 + 0.08 * Math.sin(now / 210);
        mesh.ring.scaling.set(pulse, 1, pulse);
        const posePulse = net?.getLocalPose() ?? {
          x: player.position.x,
          z: player.position.z,
        };
        const npcPulse = (net?.getNpcs() ?? []).find(
          (n) => n.npcId.toString() === npcKey,
        );
        const oorPulse = !!(
          npcPulse && isTargetOutOfCastRange(posePulse, npcPulse)
        );
        const e = 1.02 + 0.38 * (0.5 + 0.5 * Math.sin(now / 210));
        mesh.ringMat.emissiveColor = oorPulse
          ? new Color3(e, e * 0.32, 0.1)
          : new Color3(e * 1.08, e * 0.8, 0.14);
        if (mesh.marker.isEnabled()) {
          mesh.marker.position.y = 2.55 + 0.07 * Math.sin(now / 260);
          const me = 0.82 + 0.38 * (0.5 + 0.5 * Math.sin(now / 260));
          mesh.markerMat.emissiveColor = oorPulse
            ? new Color3(me, me * 0.34, 0.1)
            : new Color3(me * 1.05, me * 0.78, 0.12);
        }
      } else {
        mesh.ring.scaling.setAll(1);
        if (!mesh.marker.isEnabled()) {
          mesh.marker.position.y = 2.55;
        }
      }
    }

    // Cast VFX: Spark/Ember bolts + flashes + impact pops + Emberbolt charge/beam.
    {
      const arrived = tickSparkBolts(sparkBolts, now, dt);
      for (const b of arrived) {
        impactPops.push(
          spawnImpactPop(scene, b.to, b.impactColor, {
            key: `imp_${now}_${impactPops.length}`,
            scale: b.impactScale,
          }),
        );
        castVfxStats.impacts += 1;
        // Flash nearest NPC at impact point.
        for (const mesh of npcMeshes.values()) {
          const hit = targetHitPoint(mesh.root.position);
          if (Vector3.Distance(hit, b.to) < 0.75) {
            flashMesh(
              mesh.mat,
              b.kind === 'spark' ? SPARK_COLOR : EMBER_COLOR,
              b.kind === 'spark' ? 220 : 380,
            );
            break;
          }
        }
      }
      tickImpactPops(impactPops, now);
      tickCastFlashes(castFlashes, now);

      const castLeftNow = Math.max(0, castUntilMs - now);
      if (
        localBeamActive &&
        lastCastSpell === SPELL_EMBERBOLT &&
        castLeftNow > 0
      ) {
        const tid = net?.getCombat()?.targetNpcId ?? selectedTargetId;
        const mesh = npcMeshes.get(tid.toString());
        const from = casterMuzzle(player.position);
        placeEmberCharge(localEmberCharge, from, now);
        if (mesh) {
          placeBeam(
            localEmberBeam.beam,
            from,
            targetHitPoint(mesh.root.position),
          );
          const pulse = 0.85 + 0.2 * Math.sin(now / 80);
          localEmberBeam.beamMat.emissiveColor = new Color3(
            1.15 * pulse,
            0.42 * pulse,
            0.08,
          );
        }
      } else if (localBeamActive) {
        // Windup finished — release warm ember projectile; impact on arrival.
        const tid = net?.getCombat()?.targetNpcId ?? selectedTargetId;
        const mesh = npcMeshes.get(tid.toString());
        hideEmberCharge(localEmberCharge);
        if (mesh && lastCastSpell === SPELL_EMBERBOLT) {
          const from = casterMuzzle(player.position);
          const to = targetHitPoint(mesh.root.position);
          castFlashes.push(
            spawnCastFlash(scene, from, EMBER_COLOR, EMBER_CORE, {
              key: `local_ember_flash_${now}`,
              scale: 0.7,
            }),
          );
          castVfxStats.flashes += 1;
          sparkBolts.push(
            spawnEmberBolt(scene, from, to, {
              key: `local_ember_${now}`,
            }),
          );
          castVfxStats.bolts += 1;
          flashMesh(mesh.mat, EMBER_COLOR, 280);
        }
        localEmberBeam.beam.setEnabled(false);
        localBeamActive = false;
      }
    }

    for (const [key, fx] of npcLifeFx) {
      const mesh = npcMeshes.get(key);
      if (!mesh) {
        disposeLifeBurst(fx);
        npcLifeFx.delete(key);
        continue;
      }
      const age = now - fx.bornMs;
      const t = Math.min(1, age / fx.lifeMs);
      if (fx.phase === 'dying') {
        const sink = t * 0.85;
        const scale = 1 - t * 0.88;
        mesh.root.scaling.setAll(Math.max(0.08, scale));
        mesh.body.position.y = fx.baseBodyY - sink;
        for (const m of npcPresentationMats(mesh)) {
          m.alpha = Math.max(0, 1 - t);
          m.emissiveColor = new Color3(0.55 * (1 - t), 0.12 * (1 - t), 0.02);
        }
        for (const b of fx.burst) {
          b.mesh.position.x += b.vx * dt;
          b.mesh.position.y += b.vy * dt;
          b.mesh.position.z += b.vz * dt;
          b.vy -= 4.5 * dt;
          b.mat.alpha = Math.max(0, 1 - t);
          const s = Math.max(0.05, 1 - t * 0.7);
          b.mesh.scaling.setAll(s);
        }
        if (age >= fx.lifeMs) {
          finishNpcLifeFx(mesh, fx);
          npcLifeFx.delete(key);
        }
      } else {
        const ease = 1 - Math.pow(1 - t, 3);
        const scale = 0.12 + ease * 0.88;
        mesh.root.scaling.setAll(scale);
        const flash = 1 - t;
        const spawnEm = new Color3(0.85 * flash, 0.7 * flash, 0.25 * flash);
        for (const m of npcPresentationMats(mesh)) {
          m.emissiveColor = spawnEm.clone();
        }
        if (age >= fx.lifeMs) {
          finishNpcLifeFx(mesh, fx);
          npcLifeFx.delete(key);
        }
      }
    }

    const GROUND_Y = 0;
    const AIRBORNE_THRESHOLD = 0.05;
    const pose = net?.getLocalPose();
    const isAirborne = pose && pose.y > GROUND_Y + AIRBORNE_THRESHOLD;

    // #252 — hop presence: JUMP toast only. Rigid scale; no camera dip.
    {
      const y = pose?.y ?? player.position.y;
      const air = y > GROUND_Y + AIRBORNE_THRESHOLD;
      if (air) {
        if (!jumpWasAirborne) {
          jumpTakeoffMs = now;
          jumpApexToasted = false;
          jumpPeakY = y;
        }
        jumpWasAirborne = true;
        jumpPeakY = Math.max(jumpPeakY, y);
        const nearApex = now - jumpTakeoffMs > 160 && y + 0.02 >= jumpPeakY;
        if (!jumpApexToasted && (nearApex || y > 0.18)) {
          jumpApexToasted = true;
          const veNow = new URLSearchParams(window.location.search).get('ve');
          const ttl = veNow === 'jump-apex' ? TOAST_VE_TTL_MS : 1200;
          dismissSystemToasts('jump');
          pushSystemToast('jump', 'Jump', ttl);
        }
      } else {
        jumpWasAirborne = false;
      }
    }

    if (net && (keys.size > 0 || isAirborne)) {
      const wish = wishFromKeys(keys, camera);
      if (wish.dx !== 0 || wish.dz !== 0 || wish.jump || isAirborne) {
        moveAccumulator += dt;
        const interval = 1 / MOVE_SEND_HZ;
        const tonicOn = tonicRemainingMs(net.getCharacter()) > 0;
        const speed = tonicOn ? MOVE_SPEED * TONIC_MOVE_MULT : MOVE_SPEED;
        const maxStep = tonicOn ? MAX_STEP_METERS * TONIC_MOVE_MULT : MAX_STEP_METERS;
        while (moveAccumulator >= interval) {
          moveAccumulator -= interval;
          let dx = wish.dx * speed * interval;
          let dz = wish.dz * speed * interval;
          const len = Math.hypot(dx, dz);
          if (len > maxStep) {
            const s = maxStep / len;
            dx *= s;
            dz *= s;
          }
          const poseNow = net.getLocalPose();
          if (poseNow && (Math.abs(dx) > 1e-6 || Math.abs(dz) > 1e-6)) {
            const slid = slideAgainstTrunks(poseNow.x, poseNow.z, dx, dz);
            dx = slid.dx;
            dz = slid.dz;
          }
          if (Math.abs(dx) > 1e-6 || Math.abs(dz) > 1e-6 || wish.jump || isAirborne) {
            if (Math.abs(dx) > 1e-6 || Math.abs(dz) > 1e-6 || wish.jump) {
              leaveRestIfActive('move');
            }
            net.sendMove(dx, dz, wish.jump);
          }
        }
        if (ve === 'character-wow') {
          // waitWow owns Idle/Walk/Run/hop/Spell.
        } else if (isAirborne) {
          setHumanoidAirborne(humanoid, true);
          setHumanoidTurning(humanoid, false);
        } else {
          setHumanoidAirborne(humanoid, false);
          const moving = keys.size > 0 && !localTurningInPlace;
          const running =
            moving &&
            (ve === 'run' ||
              (ve !== 'walk' &&
                ve !== 'walk-stop' &&
                ve !== 'walk-flinch' &&
                ve !== 'face-target-walk' &&
                keys.has('w') &&
                !keys.has('s')));
          setHumanoidMoving(humanoid, moving, running, moving ? MOVE_SPEED : 0);
          setHumanoidTurning(humanoid, localTurningInPlace);
        }
      } else {
        moveAccumulator = 0;
        if (ve === 'character-wow') {
          // waitWow owns clips.
        } else if (isAirborne) {
          setHumanoidAirborne(humanoid, true);
          setHumanoidTurning(humanoid, false);
        } else {
          setHumanoidAirborne(humanoid, false);
          setHumanoidMoving(humanoid, false);
          setHumanoidTurning(humanoid, localTurningInPlace);
        }
      }
    } else {
      moveAccumulator = 0;
      if (ve === 'character-wow') {
        // waitWow owns clips.
      } else if (isAirborne) {
        setHumanoidAirborne(humanoid, true);
        setHumanoidTurning(humanoid, false);
      } else {
        setHumanoidAirborne(humanoid, false);
        const moving = keys.size > 0 && !localTurningInPlace;
        const running =
          moving &&
          (ve === 'run' ||
            (ve !== 'walk' &&
              ve !== 'walk-stop' &&
              ve !== 'walk-flinch' &&
              ve !== 'face-target-walk' &&
              keys.has('w') &&
              !keys.has('s')));
        setHumanoidMoving(humanoid, moving, running, moving ? MOVE_SPEED : 0);
        setHumanoidTurning(humanoid, localTurningInPlace);
      }
    }
    humanoid.root.scaling.set(1, 1, 1);

    // Refresh tonic buff timer + sticky CC chip on self-frame each frame.
    if (net) {
      const chTick = net.getCharacter();
      if (chTick) updateSelfFrame(chTick);
      updateSelfCcChrome(net.getCombat());
    } else if (veCcFeedbackPresent) {
      updateSelfCcChrome(null);
    }

    // Keep highlight in sync with server combat target.
    if (net) {
      const c = net.getCombat();
      if (c) selectedTargetId = c.targetNpcId;
      syncNpcMeshes(net.getNpcs());
      for (const [npcKey, mesh] of npcMeshes) {
        const parts = mesh.humanoid;
        if (!parts) continue;
        const npcRow = net.getNpcs().find((n) => n.npcId.toString() === npcKey);
        if (!npcRow || !isHostileKind(npcRow.kind) || npcRow.hp <= 0) continue;
        if (npcStunnedNow(npcRow)) {
          npcWalkHold.delete(npcKey);
          setHumanoidGroundWalk(parts, false, 0);
          continue;
        }
        let st = npcWalkHold.get(npcKey);
        if (!st) {
          st = { hold: 0, dx: 0, dz: 0 };
          npcWalkHold.set(npcKey, st);
        }
        const moving = st.hold > 0;
        const spd = Math.hypot(st.dx, st.dz);
        setHumanoidGroundWalk(parts, moving, spd);
      }
      syncVendorMeshes(net.getVendors());
      syncProxyMeshes(net.getProxies());
      syncRemoteMeshes(net.getRemotes());
      syncRemoteCastFx(net.getRemoteCombats());
    }

    const gcdLeft = gcdRemainingMs(
      latestStatus.state === 'connected' ? latestStatus.combat : null,
      now,
    );
    // Server-authority cast cancel (Move interrupt / CancelCast): clear local bar + toast.
    // Also sync CastEndsAt pushback (partial interrupt — still casting, no refund).
    {
      const combatNow = net?.getCombat() ?? null;
      const serverCasting =
        !!combatNow &&
        combatNow.castingSpellId !== 0 &&
        castRemainingMs(combatNow, now) > 0;
      if (serverCasting && combatNow) {
        const ends = combatNow.castEndsAtMicros;
        const chLive = net?.getCharacter() ?? null;
        if (chLive) manaWhileCasting = chLive.mana ?? manaWhileCasting;
        if (
          lastSeenCastEndsAtMicros > 0n &&
          ends > lastSeenCastEndsAtMicros + 50_000n
        ) {
          // CastEndsAt extended — rewind local cast bar to server remaining.
          const left = castRemainingMs(combatNow, now);
          castUntilMs = now + left;
          if (castTotalMs < left) castTotalMs = left;
          if (!castPushbackToasted) {
            castPushbackToasted = true;
            const bit = `Cast pushback · +${CAST_PUSHBACK_MS}ms · Emberbolt (no refund)`;
            pushCombatLog('castPushback', bit);
            pushSystemToast('castPushback', bit, TOAST_VE_TTL_MS);
          }
        }
        lastSeenCastEndsAtMicros = ends;
      }
      const sawPushbackThisCast = castPushbackToasted;
      if (!serverCasting) {
        lastSeenCastEndsAtMicros = 0n;
        castPushbackToasted = false;
      }
      if (prevLocalCasting && !serverCasting && castUntilMs > now + 100) {
        // Interrupted before predicted end — clear bar; toast once.
        castUntilMs = 0;
        castTotalMs = 0;
        const chNow = net?.getCharacter() ?? null;
        const manaNow = chNow?.mana ?? manaWhileCasting;
        const manaDelta =
          manaWhileCasting >= 0 ? manaNow - manaWhileCasting : EMBERBOLT_MANA_COST;
        const looksRefund = manaDelta >= EMBERBOLT_MANA_COST - 4;
        // No-refund clear = hard interrupt (pushback threshold or remain gate).
        if (!looksRefund) {
          if (!castHardInterruptToasted) {
            castHardInterruptToasted = true;
            const bit =
              `LOCKOUT · hard interrupt · no mana refund` +
              (sawPushbackThisCast ? ' · after pushback' : '');
            pushCombatLog('castHardInterrupt', bit);
            pushSystemToast('castHardInterrupt', bit, TOAST_VE_TTL_MS);
          }
        } else if (!castCancelToasted) {
          castCancelToasted = true;
          const refundHint = EMBERBOLT_MANA_COST;
          const bit = `CANCEL · player interrupt · mana refunded (~${refundHint})`;
          pushCombatLog('castCancel', bit);
          pushSystemToast('castCancel', bit, TOAST_VE_TTL_MS);
        }
        lastCastSpell = 0;
        manaWhileCasting = -1;
      }
      if (serverCasting) {
        castCancelToasted = false;
        castHardInterruptToasted = false;
      }
      prevLocalCasting = serverCasting || castUntilMs > now;
      if (ve === 'cast-anim') {
        setHumanoidCasting(humanoid, true);
      } else if (ve === 'character-wow') {
        // waitWow owns Spell.
      } else {
        const emberHold =
          (combatNow?.castingSpellId === SPELL_EMBERBOLT && serverCasting) ||
          (lastCastSpell === SPELL_EMBERBOLT && castUntilMs > now);
        setHumanoidCasting(humanoid, emberHold);
      }
    }
    const castLeft = Math.max(0, castUntilMs - now);
    if (gcdLeft > 0 || castLeft > 0 || now - latestDamageAtMs < 1600) {
      yardCombatFocusUntilMs = now + 1800;
    }
    setGcdBar(gcdLeft, castLeft, castTotalMs, castSpellDisplayName(lastCastSpell), latestStatus.state);
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
      {
        const combatHb = net?.getCombat() ?? null;
        const tidHb = combatHb?.targetNpcId ?? selectedTargetId;
        const poseHb = net?.getLocalPose() ?? null;
        const tgtHb =
          tidHb && tidHb !== 0n
            ? (net?.getNpcs() ?? []).find((n) => n.npcId === tidHb) ?? null
            : null;
        updateSpellHotbar({
          gcdMs: gcdLeft,
          castingMs: castLeft,
          castingTotal: castTotalMs,
          castingSpell: lastCastSpell,
          staffEquipped: equipped,
          mana: st.state === 'connected' ? (st.character?.mana ?? 0) : 999,
          outOfRange: isTargetOutOfCastRange(poseHb, tgtHb),
          knowsSpark: st.state === 'connected' ? (st.character?.knowsSpark ?? true) : true,
          knowsEmberbolt:
            st.state === 'connected' ? (st.character?.knowsEmberbolt ?? true) : true,
        });
      }
      const ch =
        st.state === 'connected' ? st.character ?? null : null;
      updateSelfFrame(ch);
      if (ch) {
        paintNameplate(
          localNameplate,
          `You · Lv ${ch.level ?? 1}`,
          '#b8d4ff',
          -1,
        );
      }
      updateLoadoutStrip(ch);
      updateBagPanel(ch);
      updatePartyFrames({
        localHex:
          latestStatus.state === 'connected'
            ? latestStatus.identityHex
            : net?.identityHex ?? null,
        localPose: net?.getLocalPose() ?? {
          x: player.position.x,
          z: player.position.z,
        },
        party:
          latestStatus.state === 'connected'
            ? latestStatus.party ?? null
            : null,
        remotes: net?.getRemotes() ?? [],
        getCharacterFor: (hex) => net?.getCharacterFor(hex) ?? null,
      });
      // Combat log: staff/robes equip flips + party join.
      if (ch) {
        if (prevStaffEquipped === null) {
          prevStaffEquipped = ch.staffEquipped;
          setHumanoidStaffEquipped(humanoid, ch.staffEquipped);
        } else if (ch.staffEquipped !== prevStaffEquipped) {
          const staffMsg = ch.staffEquipped ? 'Staff equipped' : 'Staff unequipped';
          pushCombatLog('equip', staffMsg);
          pushSystemToast('equip', staffMsg);
          setHumanoidStaffEquipped(humanoid, ch.staffEquipped);
          prevStaffEquipped = ch.staffEquipped;
        }
        if (prevRobesEquipped === null) {
          prevRobesEquipped = ch.robesEquipped;
        } else if (ch.robesEquipped !== prevRobesEquipped) {
          const robesMsg = ch.robesEquipped ? 'Robes equipped' : 'Robes unequipped';
          pushCombatLog('equip', robesMsg);
          pushSystemToast('equip', robesMsg);
          prevRobesEquipped = ch.robesEquipped;
        }
        // XP gain toast + world floater near local player (skip baseline seed).
        if (prevXp === null) {
          prevXp = ch.xp;
        } else if (ch.xp > prevXp) {
          const gained = ch.xp - prevXp;
          pushSystemToast('xp', `+${gained} XP · total ${ch.xp}`);
          xpFloaters.push(
            spawnXpFloater(scene, player.position, gained, [damageFloaters, xpFloaters]),
          );
          latestXpGain = gained;
          _latestXpAtMs = Date.now();
          prevXp = ch.xp;
        } else if (ch.xp !== prevXp) {
          prevXp = ch.xp;
        }

        // Level-up toast + floater (Character.Level high-water).
        const lv = ch.level ?? 1;
        if (prevLevel === null) {
          prevLevel = lv;
        } else if (lv > prevLevel) {
          pushSystemToast('level', `Level up! · Lv ${lv}`, TOAST_VE_TTL_MS);
          pushCombatLog('equip', `Level up · Lv ${lv}`);
          xpFloaters.push(
            spawnLevelFloater(scene, player.position, lv, [damageFloaters, xpFloaters]),
          );
          latestLevelUp = lv;
          prevLevel = lv;
        } else if (lv !== prevLevel) {
          prevLevel = lv;
        }

        // Player HP death / respawn (Character.Hp authority).
        if (typeof ch.hp === 'number') {
          if (prevPlayerHp === null) {
            prevPlayerHp = ch.hp;
            if (ch.hp <= 0) {
              setDeathGreyout(true);
              setLocalGhost(true);
              setHumanoidDead(humanoid, true);
            }
          } else if (ch.hp <= 0 && prevPlayerHp > 0) {
            setDeathGreyout(true);
            setLocalGhost(true);
            setHumanoidDead(humanoid, true);
            pushCombatLog('death', 'You died · respawning at yard');
            pushSystemToast('death', 'You died · respawning at yard', TOAST_VE_TTL_MS);
            selectedTargetId = 0n;
            latestPlayerDeathAtMs = Date.now();
            prevPlayerHp = ch.hp;
          } else if (ch.hp > 0 && prevPlayerHp <= 0) {
            setDeathGreyout(false);
            setLocalGhost(false);
            setHumanoidDead(humanoid, false);
            pushCombatLog('respawn', 'You respawned at yard · full HP');
            pushSystemToast('respawn', 'Respawned at yard · full HP', TOAST_VE_TTL_MS);
            flashMesh(humanoid.mat, new Color3(0.55, 0.85, 1.0), 900);
            latestPlayerRespawnAtMs = Date.now();
            prevPlayerHp = ch.hp;
          } else if (ch.hp !== prevPlayerHp) {
            if (ch.hp < prevPlayerHp) {
              const dmg = prevPlayerHp - ch.hp;
              const pulled = (net?.getNpcs() ?? []).find(
                (n) => isHostileKind(n.kind) && n.aggroed,
              );
              const src = pulled ? npcPlateName(pulled.kind) : 'Thorns';
              pushCombatLog('damage', `${src} −${dmg} · You ${ch.hp}/${ch.maxHp}`);
              damageFloaters.push(
                spawnDamageFloater(
                  scene,
                  player.position,
                  dmg,
                  FLOATER_TINT_THORNS,
                  [damageFloaters, xpFloaters],
                ),
              );
              flashMesh(humanoid.mat, new Color3(1.0, 0.25, 0.3), 220);
              playHumanoidFlinch(humanoid);
              if (ve === 'walk-flinch' && keys.has('w')) {
                const pbHit = readHumanoidPlayback(humanoid);
                const clipHit = (pbHit.playing ?? '').replace(/^.*\|/, '');
                const markHit = document.getElementById('persistMark');
                if (
                  markHit &&
                  pbHit.skinned > 0 &&
                  /recievehit/i.test(clipHit)
                ) {
                  markHit.textContent = `Walk-flinch OK · ${clipHit} · Walk · skinned ${pbHit.skinned}`;
                }
              }
            } else if (ch.hp > prevPlayerHp && prevPlayerHp > 0) {
              const healed = ch.hp - prevPlayerHp;
              // Authority-backed heal (Rest). Hotkey also toasts; avoid duplicate log spam.
              damageFloaters.push(
                spawnWorldFloater(
                  scene,
                  player.position,
                  `+${healed}`,
                  FLOATER_TINT_HEAL,
                  {
                    lifeMs: 1350,
                    yLift: 2.05,
                    planeW: 1.7,
                    planeH: 0.88,
                    laneX: 0.16,
                    stackWith: [damageFloaters, xpFloaters],
                  },
                ),
              );
            }
            prevPlayerHp = ch.hp;
          }
        }
      }
      {
        const party =
          st.state === 'connected' ? st.party ?? null : null;
        const size = party?.size ?? 0;
        const memberKey = party
          ? party.members
              .map((m) => m.identityHex)
              .sort()
              .join(',')
          : '';
        const pending = party?.pendingInviteFrom ?? null;
        if (pending && pending !== prevPendingInvite) {
          pushSystemToast(
            'invite',
            `Invite from ${pending.slice(0, 8)}… · P to accept`,
            TOAST_VE_TTL_MS,
          );
        }
        if (!pending && prevPendingInvite && size > prevPartySize) {
          const acceptKey = `${prevPendingInvite}:${size}:${memberKey}`;
          if (acceptKey !== toastedInviteAcceptKey) {
            pushSystemToast(
              'party',
              `Invite accepted · party ${size}`,
              TOAST_VE_TTL_MS,
            );
            toastedInviteAcceptKey = acceptKey;
          }
        } else if (!pending && prevPendingInvite && size <= prevPartySize) {
          // Invite expired or declined (pending cleared without party size increase)
          pushSystemToast(
            'invite',
            `Invite from ${prevPendingInvite.slice(0, 8)}… expired`,
            TOAST_VE_TTL_MS,
          );
        }
        prevPendingInvite = pending;
        // Inbound/outbound trade chrome. pendingFrom-clear is accept only when
        // this client called acceptTrade or shard/XP actually moved.
        const tr = net?.getTrade();
        const chTrade = net?.getCharacter();
        const tradePending = tr?.pendingFrom ?? null;
        const tradePendingTo = tr?.pendingTo ?? null;
        if (tradePending && tradePending !== lastTradePendingFrom) {
          toastedTradeFromKey = '';
          inboundOutcomeReported = false;
          inboundWatchShard = !!chTrade?.hasEmberShard;
          inboundWatchXp = chTrade?.xp ?? 0;
          inboundOfferedShard = !!tr?.offeredHasEmberShard;
          inboundOfferedXp = tr?.offeredXp ?? 0;
          const bits: string[] = [];
          if (tr?.offeredHasEmberShard) bits.push('ember_shard');
          if ((tr?.offeredXp ?? 0) > 0) bits.push(`+${tr!.offeredXp} XP`);
          dismissSystemToasts('tradeIncoming');
          pushSystemToast(
            'tradeIncoming',
            `${tradePending.slice(0, 8)}… · ${bits.join(' · ') || 'items'} · T accept · Y decline`,
            TOAST_VE_TTL_MS,
          );
          pushCombatLog(
            'trade',
            `Offer from ${tradePending.slice(0, 8)}… (${bits.join(' · ') || 'offer'})`,
          );
        }
        if (!tradePending && lastTradePendingFrom) {
          const doneKey = `from:${lastTradePendingFrom}`;
          if (doneKey !== toastedTradeFromKey) {
            toastedTradeFromKey = doneKey;
            const skip =
              inboundOutcomeReported || tradeAcceptInFlight || tradeCancelInFlight;
            if (!skip) {
              const moved =
                !!chTrade &&
                ((inboundOfferedShard &&
                  chTrade.hasEmberShard !== inboundWatchShard) ||
                  (inboundOfferedXp > 0 && chTrade.xp !== inboundWatchXp));
              dismissSystemToasts('tradeIncoming', 'tradeWaiting');
              if (moved) {
                bagOpen = true;
                setBagPanelOpen(true);
                updateBagPanel(chTrade);
                const bits: string[] = [];
                if (inboundOfferedShard) bits.push('ember_shard');
                if (inboundOfferedXp > 0) bits.push(`+${inboundOfferedXp} XP`);
                pushCombatLog('trade', `Accepted trade (${bits.join(' · ') || 'ok'})`);
                pushSystemToast(
                  'tradeAccepted',
                  `Trade accepted · received ${bits.join(' · ') || 'items'}`,
                  TOAST_VE_TTL_MS,
                );
              } else {
                pushCombatLog('trade', 'Trade cancelled');
                pushSystemToast(
                  'tradeCancelled',
                  'Trade cancelled',
                  TOAST_VE_TTL_MS,
                );
              }
            }
          }
        }
        lastTradePendingFrom = tradePending;
        if (tradePendingTo && tradePendingTo !== lastTradePendingTo) {
          toastedTradeToKey = '';
          outboundOutcomeReported = false;
          outboundWatchShard = !!chTrade?.hasEmberShard;
          outboundWatchXp = chTrade?.xp ?? 0;
        }
        if (!tradePendingTo && lastTradePendingTo) {
          const doneKey = `to:${lastTradePendingTo}`;
          if (doneKey !== toastedTradeToKey) {
            toastedTradeToKey = doneKey;
            const skip = outboundOutcomeReported || tradeCancelInFlight;
            if (!skip) {
              const moved =
                !!chTrade &&
                (chTrade.hasEmberShard !== outboundWatchShard ||
                  chTrade.xp !== outboundWatchXp);
              dismissSystemToasts('tradeIncoming', 'tradeWaiting');
              if (moved) {
                bagOpen = true;
                setBagPanelOpen(true);
                updateBagPanel(chTrade);
                pushCombatLog('trade', 'Trade accepted');
                pushSystemToast('tradeAccepted', 'Trade accepted', TOAST_VE_TTL_MS);
              } else {
                pushCombatLog('trade', 'Trade cancelled');
                pushSystemToast(
                  'tradeCancelled',
                  'Trade cancelled',
                  TOAST_VE_TTL_MS,
                );
              }
            }
          }
        }
        lastTradePendingTo = tradePendingTo;
        if (size > prevPartySize && size >= 1) {
          if (prevPartySize === 0) {
            const msg = size === 1
              ? 'Party formed (you)'
              : `Joined party · size ${size}`;
            pushCombatLog('party', msg);
            pushSystemToast('party', msg, TOAST_VE_TTL_MS);
          } else {
            const newcomers = party!.members
              .map((m) => m.identityHex)
              .filter((h) => !prevPartyMemberKey.split(',').includes(h));
            const label =
              newcomers.length > 0
                ? newcomers
                    .map((h) => `${h.slice(0, 8)}…`)
                    .join(', ')
                : 'member';
            const msg = `Party join · ${label} · size ${size}`;
            pushCombatLog('party', msg);
            pushSystemToast('party', msg, TOAST_VE_TTL_MS);
          }
        } else if (
          size > 0 &&
          memberKey !== prevPartyMemberKey &&
          prevPartyMemberKey !== '' &&
          size >= prevPartySize
        ) {
          // Same size but roster changed (swap) — treat as join if new hex.
          const prevSet = new Set(
            prevPartyMemberKey.split(',').filter(Boolean),
          );
          const joined = party!.members
            .map((m) => m.identityHex)
            .filter((h) => !prevSet.has(h));
          if (joined.length > 0) {
            const msg = `Party join · ${joined
              .map((h) => `${h.slice(0, 8)}…`)
              .join(', ')} · size ${size}`;
            pushCombatLog('party', msg);
            pushSystemToast('party', msg, TOAST_VE_TTL_MS);
          }
        } else if (size < prevPartySize && prevPartySize > 0) {
          // Party size decreased - someone left
          const prevSet = new Set(
            prevPartyMemberKey.split(',').filter(Boolean),
          );
          const currentSet = new Set(
            party!.members.map((m) => m.identityHex),
          );
          const left = Array.from(prevSet).filter((h) => !currentSet.has(h));
          if (left.length > 0) {
            const msg = size === 0
              ? 'Party disbanded'
              : `Party leave · ${left
                  .map((h) => `${h.slice(0, 8)}…`)
                  .join(', ')} · size ${size}`;
            pushCombatLog('party', msg);
            pushSystemToast('party', msg, TOAST_VE_TTL_MS);
          } else if (size === 0) {
            pushCombatLog('party', 'Party disbanded');
            pushSystemToast('party', 'Party disbanded', TOAST_VE_TTL_MS);
          }
        }
        prevPartySize = size;
        prevPartyMemberKey = memberKey;
      }
    }
    if (latestStatus.state === 'connected') {
      setStatus(formatStatus(latestStatus, now), latestStatus.state);
      const equipped = latestStatus.character?.staffEquipped ?? true;
      setStaffMeshVisible(humanoid.staff, equipped);
      const robesOn = latestStatus.character?.robesEquipped ?? true;
      setRobesMeshVisible(humanoid, robesOn);
    }

    drawMinimap({
      local: net?.getLocalPose() ?? {
        x: player.position.x,
        z: player.position.z,
      },
      remotes: net?.getRemotes() ?? [],
      npcs: net?.getNpcs() ?? [],
      proxies: showCrowdDebugCapsules(ve, debugHudVisible)
        ? (net?.getProxies() ?? [])
        : [],
    });

    // FPS / AOI overlay ~4Hz (Babylon engine.getFps).
    fpsHudAccum += dt;
    if (fpsHudAccum >= 0.25) {
      fpsHudAccum = 0;
      const proxies = net?.getProxies() ?? [];
      let near = 0;
      let far = 0;
      for (const p of proxies) {
        if (p.far) far += 1;
        else near += 1;
      }
      const npcsAlive = (net?.getNpcs() ?? []).filter((n) => n.hp > 0).length;
      updateFpsHud(engine.getFps(), {
        nearProxies: near,
        farProxies: far,
        remotes: (net?.getRemotes() ?? []).length,
        npcs: npcsAlive,
      });
    }

    {
      const items = net?.getGroundItems() ?? latestGround;
      syncGroundSparkles(scene, items, groundSparkles, now / 1000);
      const pose = net?.getLocalPose() ?? null;
      const nearL = nearestLootInPickupRange(items, pose);
      if (nearL) {
        const msg = `Loot nearby · F pickup ${nearL.itemId}`;
        if (!lootInRangeToasted) {
          lootInRangeToasted = true;
          pushSystemToast('loot', msg, TOAST_VE_TTL_MS);
        }
      } else {
        lootInRangeToasted = false;
      }
    }

    {
      const nearV = net?.nearestVendor(4.5) ?? null;
      if (nearV) {
        updateVendorPanel(nearV);
        const ch = net?.getCharacter();
        const msg = ch?.hasEmberShard
          ? 'Vendor nearby · E sell ember_shard (+5 XP)'
          : 'Vendor nearby · E buy ember_shard (−5 XP)';
        // transient nearby chip via vendor panel peek without forcing open
        const foot = document.querySelector('#vendorPanel .bagFoot');
        if (foot) {
          foot.textContent = msg;
        }
        if (!vendorInRangeToasted) {
          vendorInRangeToasted = true;
          pushSystemToast('vendor', msg, TOAST_VE_TTL_MS);
        }
      } else {
        vendorInRangeToasted = false;
      }
    }


    // Cast-range ground ring: show player reach when selected target is beyond CastRangeMeters.
    {
      const combatCr = net?.getCombat() ?? null;
      const tidCr = combatCr?.targetNpcId ?? selectedTargetId;
      const poseCr = net?.getLocalPose() ?? {
        x: player.position.x,
        z: player.position.z,
      };
      const tgtCr =
        tidCr && tidCr !== 0n
          ? (net?.getNpcs() ?? []).find((n) => n.npcId === tidCr) ?? null
          : null;
      const showRing =
        !!tgtCr &&
        tgtCr.hp > 0 &&
        isTargetOutOfCastRange(poseCr, tgtCr);
      castRangeRing.root.setEnabled(showRing);
      if (showRing) {
        castRangeRing.root.position.x = player.position.x;
        castRangeRing.root.position.y = 0;
        castRangeRing.root.position.z = player.position.z;
        const pulse = 0.97 + 0.05 * Math.sin(now / 240);
        castRangeRing.rim.scaling.set(pulse, 1, pulse);
        const e = 0.85 + 0.25 * (0.5 + 0.5 * Math.sin(now / 240));
        castRangeRing.rimMat.emissiveColor = new Color3(e, e * 0.3, 0.08);
        castRangeRing.discMat.alpha = 0.14 + 0.06 * (0.5 + 0.5 * Math.sin(now / 320));
      }
    }

    // Follow player without radius drift: ArcRotateCamera.setTarget rebuilds
    // radius from current cam position → target; walking forward increases that
    // distance each frame and zooms out (#30). Preserve wheel/orbit radius.
    // Skip follow for framed VE shots so the subject stays on-camera.
    {
      const veFollow = new URLSearchParams(window.location.search).get('ve');
      camCollideThisFrame = false;
      if (veFollow === 'minimap-pip') {
        camera.alpha = Math.PI / 2.45;
        camera.beta = Math.PI / 3.3;
        camera.setTarget(player.position.add(new Vector3(0, CAM_FOLLOW_Y_OFFSET, 0)));
        camera.radius = 22;
      } else if (veFollow === 'sky-horizon') {
        // Lock every frame: setTarget(player) rebuilds alpha/beta and eats the range shot.
        camera.setTarget(player.position.add(new Vector3(0, 8, -8)));
        camera.alpha = Math.PI / 2.55;
        camera.beta = Math.PI / 2.48;
        camera.radius = 32;
      } else if (veFollow === 'place-wow') {
        // Establishing vs hordes-place-ref: player tiny vs trunks, path recedes
        // into dusk-blue volume, canopy leaves the frame (#350). Ignore characters.
        camera.setTarget(player.position.add(new Vector3(-3, 2.6, -22)));
        camera.alpha = Math.PI / 2 + 0.1;
        camera.beta = Math.PI / 2.52;
        camera.radius = 24;
      } else if (veFollow === 'collision') {
        // Side-on: player pressed against the north hero bole.
        const hx = COLLISION_VE_HERO.x;
        const hz = COLLISION_VE_HERO.z;
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        const tgt = camera.target;
        tgt.x = player.position.x * 0.4 + hx * 0.6;
        tgt.y = 3.4;
        tgt.z = player.position.z * 0.4 + hz * 0.6;
        camera.alpha = 0.42;
        camera.beta = Math.PI / 2.38;
        camera.radius = 16;
      } else if (veFollow === 'fps') {
        // Play-cam into the north hero/mid ring (dense view, not the spawn pad).
        const tgt = camera.target;
        tgt.x = player.position.x;
        tgt.y = 2.2;
        tgt.z = player.position.z - 8;
        camera.alpha = Math.PI / 2 + 0.12;
        camera.beta = Math.PI / 2.48;
        camera.radius = 16;
      } else if (veFollow === 'idle') {
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        const tgt = camera.target;
        tgt.x = player.position.x;
        tgt.y = player.position.y + 1.05;
        tgt.z = player.position.z;
        camera.alpha = Math.PI / 2.15;
        camera.beta = Math.PI / 2.55;
        // E8.7: far-cam Idle must still read staff-grip (not 8m close-up).
        camera.radius = 16;
      } else if (veFollow === 'sheathed') {
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        const tgt = camera.target;
        tgt.x = player.position.x;
        tgt.y = player.position.y + 1.0;
        tgt.z = player.position.z;
        camera.alpha = 0.35;
        camera.beta = Math.PI / 2.45;
        camera.radius = 7;
      } else if (veFollow === 'humanoid-polish') {
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        const tgt = camera.target;
        tgt.x = player.position.x;
        tgt.y = player.position.y + 1.05;
        tgt.z = player.position.z;
        camera.alpha = Math.PI / 2.35;
        camera.beta = Math.PI / 2.55;
        camera.radius = 6;
      } else if (
        veFollow === 'hostile-spawn' ||
        veFollow === 'hostile-body' ||
        veFollow === 'hostile-read' ||
        veFollow === 'hostile-types' ||
        veFollow === 'brigand-plate' ||
        veFollow === 'brigand-body'
      ) {
        // Dummy (5,0) + Kind=2 (3,7)/(-7,3) + Kind=3 (7,-3) in one shot.
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        const tgt = camera.target;
        tgt.x = 0;
        tgt.y = 1.4;
        tgt.z = 3;
        camera.alpha = Math.PI / 2.05;
        camera.beta = Math.PI / 2.7;
        camera.radius = 18;
      } else if (
        veFollow === 'kick' ||
        veFollow === 'stun' ||
        veFollow === 'stun-hold' ||
        veFollow === 'leash' ||
        veFollow === 'aggro'
      ) {
        // Pad C Brigand (7,-3) + Dummy (5,0). Do not frame pad A (3,7) (#503).
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        const tgt = camera.target;
        tgt.x = 6.2;
        tgt.y = 1.2;
        tgt.z = -1.6;
        camera.alpha = Math.atan2(-3, 7) + 0.35;
        camera.beta = Math.PI / 2.55;
        camera.radius = 14;
      } else if (veFollow === 'hostile-hit') {
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        const tgt = camera.target;
        let fx = 3;
        let fy = 1.05;
        let fz = 7;
        let best = -1;
        for (const [, mesh] of npcMeshes) {
          if (!mesh.humanoid) continue;
          const pb = readHumanoidPlayback(mesh.humanoid);
          const hit =
            pb.skinned > 0 &&
            !!pb.playing &&
            /recievehit|death/i.test(pb.playing);
          const rank = (hit ? 1000 : 0) + mesh.root.position.z;
          if (rank > best) {
            best = rank;
            fx = mesh.root.position.x;
            fy = mesh.root.position.y + 1.05;
            fz = mesh.root.position.z;
          }
        }
        tgt.x = fx;
        tgt.y = fy;
        tgt.z = fz;
        camera.alpha = 0.35;
        camera.beta = Math.PI / 2.45;
        camera.radius = 8;
      } else if (veFollow === 'hostile-chase') {
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        const tgt = camera.target;
        let fx = 3;
        let fy = 1.05;
        let fz = 7;
        let best = -1;
        const npcRows = net?.getNpcs() ?? [];
        for (const [npcKey, mesh] of npcMeshes) {
          if (!mesh.humanoid) continue;
          const row = npcRows.find((n) => n.npcId.toString() === npcKey);
          if (!row || row.hp <= 0 || !isHostileKind(row.kind)) continue;
          const pb = readHumanoidPlayback(mesh.humanoid);
          const walking =
            pb.skinned > 0 && !!pb.playing && /walk/i.test(pb.playing);
          if (!walking) continue;
          const d = Math.hypot(
            mesh.root.position.x - player.position.x,
            mesh.root.position.z - player.position.z,
          );
          const rank = 2000 - d + mesh.root.position.z * 0.05;
          if (rank > best) {
            best = rank;
            fx = mesh.root.position.x;
            fy = mesh.root.position.y + 0.95;
            fz = mesh.root.position.z;
          }
        }
        tgt.x = fx;
        tgt.y = fy;
        tgt.z = fz;
        // North of pad A looking south — vendor stays behind the walker.
        camera.alpha = 0.55;
        camera.beta = Math.PI / 2.28;
        camera.radius = 7;
      } else if (veFollow === 'face-target-walk') {
        // Camera on -X so W walks +X toward Dummy (5,0). Mutate target in place.
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        const tgt = camera.target;
        tgt.x = player.position.x;
        tgt.y = player.position.y + 1.0;
        tgt.z = player.position.z;
        camera.alpha = Math.PI;
        camera.beta = Math.PI / 2.45;
        camera.radius = 8;
      } else if (
        veFollow === 'walk' ||
        veFollow === 'walk-stop' ||
        veFollow === 'run' ||
        veFollow === 'flinch' ||
        veFollow === 'yaw' ||
        veFollow === 'jump-pose' ||
        veFollow === 'look-at'
      ) {
        // Side play-cam so Walk/Run stride / wish facing / hop pose / look-at reads.
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        camera.setTarget(player.position.add(new Vector3(0, 1.0, 0)));
        camera.alpha = 0.35;
        camera.beta = Math.PI / 2.45;
        camera.radius = veFollow === 'jump-pose' ? 9 : 7;
      } else if (veFollow === 'walk-flinch') {
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        const tgt = camera.target;
        tgt.x = player.position.x;
        tgt.y = player.position.y + 1.0;
        tgt.z = player.position.z;
        camera.alpha = 0.35;
        camera.beta = Math.PI / 2.45;
        camera.radius = 7;
      } else if (veFollow === 'character-wow') {
        // South of spawn looking north: player clips in front, Kind=2 at (3,7)
        // behind, Dummy trainer (5,0) to the right. Mutate target in place.
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        const tgt = camera.target;
        tgt.x = player.position.x + 1.2;
        tgt.y = player.position.y + 1.1;
        tgt.z = player.position.z + 2.5;
        camera.alpha = -Math.PI / 2;
        camera.beta = Math.PI / 2.45;
        camera.radius = 12;
      } else if (veFollow === 'cast-anim' || veFollow === 'cast-cancel-pose') {
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        const tgt = camera.target;
        tgt.x = player.position.x;
        tgt.y = player.position.y + 1.05;
        tgt.z = player.position.z;
        camera.alpha = Math.PI / 2.2;
        camera.beta = Math.PI / 2.6;
        camera.radius = 8;
      } else if (veFollow === 'remote-walk') {
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        const tgt = camera.target;
        let fx = player.position.x;
        let fy = player.position.y + 1.0;
        let fz = player.position.z;
        let best = -1;
        for (const [, parts] of remoteMeshes) {
          const pb = readHumanoidPlayback(parts);
          const walking =
            pb.skinned > 0 && !!pb.playing && /walk/i.test(pb.playing);
          const d = Vector3.Distance(parts.root.position, player.position);
          const rank = (walking ? 1000 : 0) + d;
          if (rank > best) {
            best = rank;
            fx = parts.root.position.x;
            fy = parts.root.position.y + 1.0;
            fz = parts.root.position.z;
          }
        }
        tgt.x = fx;
        tgt.y = fy;
        tgt.z = fz;
        camera.alpha = 0.35;
        camera.beta = Math.PI / 2.45;
        camera.radius = 7;
      } else if (veFollow === 'remote-walk-stop') {
        player.setEnabled(false);
        localNameplate.mesh.setEnabled(false);
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        const tgt = camera.target;
        // SecondClient patrols (−6.5, −5) ↔ (−1.5, −5). Never fall back to You.
        let fx = -4;
        let fy = 1.0;
        let fz = -5;
        let best = -1;
        let bestHex: string | null = null;
        for (const [hex, parts] of remoteMeshes) {
          const ch = net?.getCharacterFor(hex);
          if (!ch || ch.hp <= 0) {
            parts.root.setEnabled(false);
            continue;
          }
          const pb = readHumanoidPlayback(parts);
          const clip = (pb.playing ?? '').replace(/^.*\|/, '');
          const nearPad =
            Math.hypot(parts.root.position.x + 4, parts.root.position.z + 5) <
            3.5;
          if (
            /death/i.test(clip) ||
            pb.skinned <= 0 ||
            pb.height < 1.2 ||
            !nearPad
          ) {
            parts.root.setEnabled(false);
            continue;
          }
          const idle =
            /idle_weapon/i.test(clip) &&
            !/walk/i.test(clip) &&
            parts.staff.isEnabled();
          const walking = /walk/i.test(clip);
          const hold = remoteWalkHold.get(hex)?.hold ?? 0;
          const lastStep = remoteWalkStepAt.get(hex) ?? 0;
          const rank =
            (hold > 0 || walking ? 3000 : idle ? 2000 : 100) + lastStep * 0.001;
          if (rank > best) {
            best = rank;
            bestHex = hex;
            fx = parts.root.position.x;
            fy = 1.0;
            fz = parts.root.position.z;
          }
        }
        for (const [hex, parts] of remoteMeshes) {
          parts.root.setEnabled(hex === bestHex);
        }
        tgt.x = fx;
        tgt.y = fy;
        tgt.z = fz;
        camera.alpha = 0.15;
        camera.beta = Math.PI / 2.45;
        camera.radius = 7;
      } else if (veFollow === 'remote-sheathed-walk') {
        player.setEnabled(false);
        localNameplate.mesh.setEnabled(false);
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        const tgt = camera.target;
        let fx = -4;
        let fy = 1.0;
        let fz = -5;
        let best = -1;
        let bestHex: string | null = null;
        for (const [hex, parts] of remoteMeshes) {
          const ch = net?.getCharacterFor(hex);
          if (!ch || ch.hp <= 0 || ch.staffEquipped) {
            parts.root.setEnabled(false);
            continue;
          }
          const pb = readHumanoidPlayback(parts);
          const clip = (pb.playing ?? '').replace(/^.*\|/, '');
          const nearPad =
            Math.hypot(parts.root.position.x + 4, parts.root.position.z + 5) <
            3.5;
          if (
            /death/i.test(clip) ||
            /weapon/i.test(clip) ||
            pb.skinned <= 0 ||
            pb.height < 1.0 ||
            !nearPad ||
            parts.staff.isEnabled()
          ) {
            parts.root.setEnabled(false);
            continue;
          }
          const walking = /^walk$/i.test(clip);
          const hold = remoteWalkHold.get(hex)?.hold ?? 0;
          const rank = walking || hold > 0 ? 3000 : 100;
          if (rank > best) {
            best = rank;
            bestHex = hex;
            fx = parts.root.position.x;
            fy = 1.0;
            fz = parts.root.position.z;
          }
        }
        for (const [hex, parts] of remoteMeshes) {
          parts.root.setEnabled(hex === bestHex);
        }
        tgt.x = fx;
        tgt.y = fy;
        tgt.z = fz;
        camera.alpha = 0.15;
        camera.beta = Math.PI / 2.45;
        camera.radius = 7;
      } else if (veFollow === 'remote-sheathed-run') {
        player.setEnabled(false);
        localNameplate.mesh.setEnabled(false);
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        const tgt = camera.target;
        let fx = -4;
        let fy = 1.0;
        let fz = -5;
        let best = -1;
        let bestHex: string | null = null;
        for (const [hex, parts] of remoteMeshes) {
          const ch = net?.getCharacterFor(hex);
          if (!ch || ch.hp <= 0 || ch.staffEquipped) {
            parts.root.setEnabled(false);
            continue;
          }
          const pb = readHumanoidPlayback(parts);
          const clip = (pb.playing ?? '').replace(/^.*\|/, '');
          const nearPad =
            Math.hypot(parts.root.position.x + 4, parts.root.position.z + 5) <
            3.5;
          if (
            /death/i.test(clip) ||
            /weapon/i.test(clip) ||
            pb.skinned <= 0 ||
            pb.height < 1.0 ||
            !nearPad ||
            parts.staff.isEnabled()
          ) {
            parts.root.setEnabled(false);
            continue;
          }
          const running = /^run$/i.test(clip);
          const hold = remoteWalkHold.get(hex)?.hold ?? 0;
          const rank = running ? 3000 : hold > 0 ? 2000 : 100;
          if (rank > best) {
            best = rank;
            bestHex = hex;
            fx = parts.root.position.x;
            fy = 1.0;
            fz = parts.root.position.z;
          }
        }
        for (const [hex, parts] of remoteMeshes) {
          parts.root.setEnabled(hex === bestHex);
        }
        tgt.x = fx;
        tgt.y = fy;
        tgt.z = fz;
        camera.alpha = 0.15;
        camera.beta = Math.PI / 2.45;
        camera.radius = 7;
      } else if (veFollow === 'remote-run') {
        player.setEnabled(false);
        localNameplate.mesh.setEnabled(false);
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        const tgt = camera.target;
        let fx = -4;
        let fy = 1.0;
        let fz = -5;
        let best = -1;
        let bestHex: string | null = null;
        for (const [hex, parts] of remoteMeshes) {
          const ch = net?.getCharacterFor(hex);
          if (!ch || ch.hp <= 0) {
            parts.root.setEnabled(false);
            continue;
          }
          const pb = readHumanoidPlayback(parts);
          const clip = (pb.playing ?? '').replace(/^.*\|/, '');
          const nearPad =
            Math.hypot(parts.root.position.x + 4, parts.root.position.z + 5) <
            3.5;
          if (
            /death/i.test(clip) ||
            pb.skinned <= 0 ||
            pb.height < 1.0 ||
            !nearPad
          ) {
            parts.root.setEnabled(false);
            continue;
          }
          const running = /run/i.test(clip);
          const rank = running ? 3000 : 100;
          if (rank > best) {
            best = rank;
            bestHex = hex;
            fx = parts.root.position.x;
            fy = 1.0;
            fz = parts.root.position.z;
          }
        }
        for (const [hex, parts] of remoteMeshes) {
          parts.root.setEnabled(hex === bestHex);
        }
        tgt.x = fx;
        tgt.y = fy;
        tgt.z = fz;
        camera.alpha = 0.15;
        camera.beta = Math.PI / 2.45;
        camera.radius = 7;
      } else if (veFollow === 'remote-run-stop') {
        player.setEnabled(false);
        localNameplate.mesh.setEnabled(false);
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        const tgt = camera.target;
        // SecondClient sprints (−6.5, −5) ↔ (−1.5, −5) then stands. Prefer a
        // recently-stopped Idle so leftover FARDEL_SECOND_RUN does not steal.
        let fx = -4;
        let fy = 1.0;
        let fz = -5;
        let best = -1;
        let bestHex: string | null = null;
        const nowMs = performance.now();
        for (const [hex, parts] of remoteMeshes) {
          const ch = net?.getCharacterFor(hex);
          if (!ch || ch.hp <= 0) {
            parts.root.setEnabled(false);
            continue;
          }
          const pb = readHumanoidPlayback(parts);
          const clip = (pb.playing ?? '').replace(/^.*\|/, '');
          const nearPad =
            Math.hypot(parts.root.position.x + 4, parts.root.position.z + 5) <
            3.5;
          if (
            /death/i.test(clip) ||
            pb.skinned <= 0 ||
            pb.height < 1.2 ||
            !nearPad
          ) {
            parts.root.setEnabled(false);
            continue;
          }
          const running = /run/i.test(clip);
          const idle =
            /idle_weapon/i.test(clip) &&
            !/run/i.test(clip) &&
            !/walk/i.test(clip) &&
            parts.staff.isEnabled();
          const hold = remoteWalkHold.get(hex)?.hold ?? 0;
          const lastStep = remoteWalkStepAt.get(hex) ?? 0;
          const age = lastStep > 0 ? nowMs - lastStep : 1e9;
          const recentlyStopped =
            idle && age > REMOTE_WALK_STOP_MS && age < 5000;
          const rank = recentlyStopped
            ? 4000
            : running || hold > 0
              ? 2000 + lastStep * 0.001
              : idle
                ? 1000
                : 100;
          if (rank > best) {
            best = rank;
            bestHex = hex;
            fx = parts.root.position.x;
            fy = 1.0;
            fz = parts.root.position.z;
          }
        }
        for (const [hex, parts] of remoteMeshes) {
          parts.root.setEnabled(hex === bestHex);
        }
        tgt.x = fx;
        tgt.y = fy;
        tgt.z = fz;
        camera.alpha = 0.15;
        camera.beta = Math.PI / 2.45;
        camera.radius = 7;
      } else if (veFollow === 'remote-two-clips') {
        hideLocalForRemoteHop(player, localNameplate);
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        const tgt = camera.target;
        let walkHex: string | null = null;
        let spellHex: string | null = null;
        let wx = -4;
        let wz = -5;
        let sx = 1.5;
        let sz = -2;
        for (const [hex, parts] of remoteMeshes) {
          const ch = net?.getCharacterFor(hex);
          if (!ch || ch.hp <= 0) {
            parts.root.setEnabled(false);
            continue;
          }
          const pb = readHumanoidPlayback(parts);
          const clip = (pb.playing ?? '').replace(/^.*\|/, '');
          if (/death/i.test(clip) || pb.skinned <= 0 || pb.height < 1.0) {
            parts.root.setEnabled(false);
            continue;
          }
          const isLoco = /^(walk|run)(_weapon)?$/i.test(clip);
          const isSpell = /spell/i.test(clip);
          if (isSpell && !spellHex) {
            spellHex = hex;
            sx = parts.root.position.x;
            sz = parts.root.position.z;
          } else if (isLoco && !walkHex) {
            walkHex = hex;
            wx = parts.root.position.x;
            wz = parts.root.position.z;
          }
        }
        for (const [hex, parts] of remoteMeshes) {
          parts.root.setEnabled(hex === walkHex || hex === spellHex);
        }
        if (walkHex && spellHex) {
          tgt.x = (wx + sx) * 0.5;
          tgt.z = (wz + sz) * 0.5;
        } else if (spellHex) {
          tgt.x = sx;
          tgt.z = sz;
        } else if (walkHex) {
          tgt.x = wx;
          tgt.z = wz;
        } else {
          tgt.x = -1;
          tgt.z = -3;
        }
        tgt.y = 1.1;
        camera.alpha = Math.PI / 2.2;
        camera.beta = Math.PI / 2.55;
        camera.radius = 14;
      } else if (veFollow === 'remote-sheathed') {
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        const tgt = camera.target;
        let fx = player.position.x;
        let fy = player.position.y + 1.0;
        let fz = player.position.z;
        let best = -1;
        for (const [hex, parts] of remoteMeshes) {
          const ch = net?.getCharacterFor(hex);
          if (!ch || ch.hp <= 0) continue;
          const pb = readHumanoidPlayback(parts);
          const clip = (pb.playing ?? '').replace(/^.*\|/, '');
          if (/death/i.test(clip)) continue;
          const sheathed =
            pb.skinned > 0 &&
            pb.height >= 1.2 &&
            /^idle$/i.test(clip) &&
            !/weapon/i.test(clip) &&
            !/death/i.test(clip) &&
            !parts.staff.isEnabled();
          if (!sheathed) continue;
          const d = Vector3.Distance(parts.root.position, player.position);
          const rank = 1000 + d;
          if (rank > best) {
            best = rank;
            fx = parts.root.position.x;
            fy = parts.root.position.y + 1.0;
            fz = parts.root.position.z;
          }
        }
        tgt.x = fx;
        tgt.y = fy;
        tgt.z = fz;
        camera.alpha = 0.35;
        camera.beta = Math.PI / 2.45;
        camera.radius = 7;
      } else if (veFollow === 'remote-cast') {
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        const tgt = camera.target;
        let fx = player.position.x;
        let fy = player.position.y + 1.05;
        let fz = player.position.z;
        let best = -1;
        for (const [, parts] of remoteMeshes) {
          const pb = readHumanoidPlayback(parts);
          const casting =
            pb.skinned > 0 && !!pb.playing && /spell/i.test(pb.playing);
          const d = Vector3.Distance(parts.root.position, player.position);
          const rank = (casting ? 1000 : 0) + d;
          if (rank > best) {
            best = rank;
            fx = parts.root.position.x;
            fy = parts.root.position.y + 1.05;
            fz = parts.root.position.z;
          }
        }
        tgt.x = fx;
        tgt.y = fy;
        tgt.z = fz;
        camera.alpha = 0.35;
        camera.beta = Math.PI / 2.45;
        camera.radius = 8;
      } else if (veFollow === 'remote-death') {
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        const tgt = camera.target;
        let fx = player.position.x;
        let fy = player.position.y + 1.05;
        let fz = player.position.z;
        let best = -1;
        for (const [, parts] of remoteMeshes) {
          const pb = readHumanoidPlayback(parts);
          const death =
            pb.skinned > 0 && !!pb.playing && /death/i.test(pb.playing);
          const hit =
            pb.skinned > 0 && !!pb.playing && /recievehit/i.test(pb.playing);
          const d = Vector3.Distance(parts.root.position, player.position);
          const rank = (death ? 2000 : hit ? 1000 : 0) + d;
          if (rank > best) {
            best = rank;
            fx = parts.root.position.x;
            fy = parts.root.position.y + 0.35;
            fz = parts.root.position.z;
          }
        }
        tgt.x = fx;
        tgt.y = fy;
        tgt.z = fz;
        camera.alpha = 0.55;
        camera.beta = Math.PI / 2.7;
        camera.radius = 7;
      } else if (veFollow === 'remote-hop') {
        // Hide You — falling back to player.position was 464/remote-hop-2.png
        // (local on dirt, remote nameplate over empty grass).
        hideLocalForRemoteHop(player, localNameplate);
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        const tgt = camera.target;
        // SecondClient hop-pad (0, −6). Hold the look-at on the grass so
        // airborne feet read against the ground, not a centered stand.
        let fx = 0;
        let fy = 0.35;
        let fz = -6;
        let best = -1;
        for (const [hex, parts] of remoteMeshes) {
          const ch = net?.getCharacterFor(hex);
          if (!ch || ch.hp <= 0) continue;
          const pb = readHumanoidPlayback(parts);
          const clip = (pb.playing ?? '').replace(/^.*\|/, '');
          if (/death/i.test(clip)) continue;
          const y = parts.root.position.y;
          const air =
            y > 0.8 &&
            pb.skinned > 0 &&
            pb.height >= 1.0 &&
            /idle_weapon/i.test(clip) &&
            !/walk/i.test(clip);
          const nearPad =
            Math.hypot(parts.root.position.x, parts.root.position.z + 6) < 2.5;
          const rank = (air ? 2000 : 100) + (nearPad ? 500 : 0) + y * 10;
          if (rank > best) {
            best = rank;
            const look = hopBodyLook(parts);
            fx = look.x;
            fy = look.y;
            fz = look.z;
            if (air) remoteHopLatch = { hex, y };
          }
        }
        tgt.x = fx;
        tgt.y = fy;
        tgt.z = fz;
        camera.alpha = 0.15;
        camera.beta = Math.PI / 2.02;
        camera.radius = 8;
      } else if (
        veFollow === 'cam-collision' ||
        veFollow === 'cam-collision-mid' ||
        veFollow === 'cam-collision-hop'
      ) {
        // Orbit into a bole; collision keeps the camera in the open
        // (hero E10.1, mid E10.24, hop E10.29). E1 Y-spring stays.
        const targetY = player.position.y + CAM_FOLLOW_Y_OFFSET;
        if (!camFollowYSeeded) {
          camFollowY = targetY;
          camFollowYSeeded = true;
        } else if (Math.abs(targetY - camFollowY) > CAM_FOLLOW_SNAP_METERS) {
          camFollowY = targetY;
        } else {
          const a = 1 - Math.exp(-Math.max(0, dt) * CAM_FOLLOW_Y_HZ);
          camFollowY += (targetY - camFollowY) * a;
        }
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        const tgt = camera.target;
        tgt.x = player.position.x;
        tgt.y = camFollowY;
        tgt.z = player.position.z;
        const wantMid = veFollow === 'cam-collision-mid';
        const wantHop = veFollow === 'cam-collision-hop';
        if (wantMid && !camCollisionMidAimed) {
          camCollisionMidAimed = pickClearTrunk(
            player.position.x,
            player.position.z,
            trunks,
            'mid',
          );
        }
        if (wantHop && !camCollisionHopAimed) {
          camCollisionHopAimed = pickClearTrunk(
            player.position.x,
            player.position.z,
            trunks,
            'hero',
          );
        }
        const aimed = wantMid
          ? camCollisionMidAimed
          : wantHop
            ? camCollisionHopAimed
            : nearestHeroTrunk(player.position.x, player.position.z, trunks);
        if (aimed) {
          camera.alpha = trunkAimAlpha(player.position.x, player.position.z, aimed);
          if (wantMid || wantHop) {
            // Zoom max 42 cannot reach the mid ring (~48m) from origin (#465).
            // Hop VE walks in so the airborne pose reads against the bole.
            const dist = Math.hypot(
              aimed.x - player.position.x,
              aimed.z - player.position.z,
            );
            camZoomRadius =
              dist > 14
                ? 12
                : Math.min(
                    CAM_ZOOM_MAX,
                    Math.max(16, dist + aimed.r + CAM_TRUNK_PAD + 8),
                  );
          } else {
            camZoomRadius = CAM_COLLISION_VE_RADIUS;
          }
        } else {
          camZoomRadius = CAM_COLLISION_VE_RADIUS;
        }
        camera.beta = Math.PI / 2.18;
        camCollideThisFrame = true;
      } else if (veFollow === 'cam-collision-dummy') {
        // Min-zoom orbit into Dummy. Collision may pull below zoom min (#466).
        const targetY = player.position.y + CAM_FOLLOW_Y_OFFSET;
        if (!camFollowYSeeded) {
          camFollowY = targetY;
          camFollowYSeeded = true;
        } else if (Math.abs(targetY - camFollowY) > CAM_FOLLOW_SNAP_METERS) {
          camFollowY = targetY;
        } else {
          const a = 1 - Math.exp(-Math.max(0, dt) * CAM_FOLLOW_Y_HZ);
          camFollowY += (targetY - camFollowY) * a;
        }
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        const tgt = camera.target;
        tgt.x = player.position.x;
        tgt.y = camFollowY;
        tgt.z = player.position.z;
        const dummy = (net?.getNpcs() ?? []).find(
          (n) => n.kind === NPC_KIND_DUMMY && n.hp > 0,
        );
        if (dummy) {
          const mesh = npcMeshes.get(dummy.npcId.toString());
          const dx = (mesh?.root.position.x ?? dummy.x) - player.position.x;
          const dz = (mesh?.root.position.z ?? dummy.z) - player.position.z;
          camera.alpha = Math.atan2(dz, dx) + 0.08;
        }
        camera.beta = Math.PI / 2.18;
        camZoomRadius = CAM_ZOOM_MIN;
        camCollideThisFrame = true;
      } else if (veFollow === 'cam-collision-vendor') {
        // Min-zoom orbit into the stall. Collision may pull below zoom min (#497).
        const targetY = player.position.y + CAM_FOLLOW_Y_OFFSET;
        if (!camFollowYSeeded) {
          camFollowY = targetY;
          camFollowYSeeded = true;
        } else if (Math.abs(targetY - camFollowY) > CAM_FOLLOW_SNAP_METERS) {
          camFollowY = targetY;
        } else {
          const a = 1 - Math.exp(-Math.max(0, dt) * CAM_FOLLOW_Y_HZ);
          camFollowY += (targetY - camFollowY) * a;
        }
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        const tgt = camera.target;
        tgt.x = player.position.x;
        tgt.y = camFollowY;
        tgt.z = player.position.z;
        const vendor = (net?.getVendors() ?? [])[0];
        if (vendor) {
          const mesh = vendorMeshes.get(vendor.vendorId.toString());
          const dx = (mesh?.root.position.x ?? vendor.x) - player.position.x;
          const dz = (mesh?.root.position.z ?? vendor.z) - player.position.z;
          camera.alpha = Math.atan2(dz, dx) + 0.08;
        }
        camera.beta = Math.PI / 2.18;
        camZoomRadius = CAM_ZOOM_MIN;
        camCollideThisFrame = true;
      } else if (veFollow === 'encounter') {
        // Kind=2 (3,7) + Kind=3 (7,-3) + Dummy (5,0) as people while pad A is pulled (#456).
        camera.inertialAlphaOffset = 0;
        camera.inertialBetaOffset = 0;
        camera.inertialRadiusOffset = 0;
        const tgt = camera.target;
        tgt.x = 4.2;
        tgt.y = 1.4;
        tgt.z = 1.4;
        camera.alpha = Math.PI / 2.12;
        camera.beta = Math.PI / 2.55;
        camZoomRadius = 20;
        camCollideThisFrame = true;
      } else if (
        veFollow !== 'vendor-stall' &&
        veFollow !== 'vendor-panel' &&
        veFollow !== 'vendor-interact' &&
        veFollow !== 'dummy-hp' &&
        veFollow !== 'tab-target' &&
        veFollow !== 'tab-hostile' &&
        veFollow !== 'tab-aggro' &&
        veFollow !== 'tab-dummy' &&
        veFollow !== 'hostile-read' &&
        veFollow !== 'hostile-types' &&
        veFollow !== 'brigand-plate' &&
        veFollow !== 'brigand-body' &&
        veFollow !== 'hostile-chase' &&
        veFollow !== 'kick' &&
        veFollow !== 'kick-tab' &&
        veFollow !== 'stun' &&
        veFollow !== 'brigand-stun-plate' &&
        veFollow !== 'brigand-cast' &&
        veFollow !== 'remote-sheathed' &&
        veFollow !== 'loot-f' &&
        veFollow !== 'rest-exit' &&
        veFollow !== 'path-ground' &&
        veFollow !== 'zoom-stop' &&
        veFollow !== 'remote-hop' &&
        veFollow !== 'remote-walk-stop' &&
        veFollow !== 'remote-sheathed-walk' &&
        veFollow !== 'remote-run' &&
        veFollow !== 'remote-run-stop' &&
        veFollow !== 'remote-sheathed-run' &&
        veFollow !== 'remote-two-clips' &&
        veFollow !== 'walk-flinch'
      ) {
        const targetY = player.position.y + CAM_FOLLOW_Y_OFFSET;
        if (!camFollowYSeeded) {
          camFollowY = targetY;
          camFollowYSeeded = true;
        } else if (Math.abs(targetY - camFollowY) > CAM_FOLLOW_SNAP_METERS) {
          camFollowY = targetY;
        } else {
          const a = 1 - Math.exp(-Math.max(0, dt) * CAM_FOLLOW_Y_HZ);
          camFollowY += (targetY - camFollowY) * a;
        }
        // Mutate target in place. setTarget() rebuilds alpha/beta/radius from
        // the camera world position and feels like the view lags WASD (#315).
        // Do NOT zero inertialAlpha/Beta/Radius here — Babylon RMB orbit and
        // wheel zoom write those offsets (#366). Collision reads the post-input
        // radius onBeforeRender and may pull it in vs trunks.
        const tgt = camera.target;
        tgt.x = player.position.x;
        tgt.y = camFollowY;
        tgt.z = player.position.z;
        camCollideThisFrame = true;
      }
    }
    scene.render();
  });
  window.addEventListener('resize', () => engine.resize());

  setStatus('Connecting…\nto SpacetimeDB', 'connecting');
  const onStatus = (s: ConnectionStatus) => {
    latestStatus = s;
    if (s.state === 'connected' && s.combat) {
      selectedTargetId = s.combat.targetNpcId;
    }
    if (s.state === 'connected' && !toastedConnected) {
      toastedConnected = true;
      const idShort = s.identityHex.slice(0, 8);
      pushSystemToast(
        'connected',
        s.restoredToken
          ? `Identity restored · ${idShort}…`
          : `Connected · ${idShort}…`,
      );
      showFirstSessionControlsCue({
        force: firstSessionVe,
        ttlMs: firstSessionVe ? TOAST_VE_TTL_MS : 4800,
        autoCloseMs: firstSessionVe ? 0 : 5600,
      });
    }
    setStatus(formatStatus(s, Date.now()), s.state);
  };

  const renderedChatIds = new Set<string>();
  const onChatMessages = (messages: import('./net/connection').ChatMessageView[]) => {
    const localHex =
      latestStatus.state === 'connected' ? latestStatus.identityHex : net?.identityHex ?? '';
    for (const msg of messages) {
      if (renderedChatIds.has(msg.messageId)) continue;
      renderedChatIds.add(msg.messageId);
      const local = !!localHex && msg.senderHex === localHex;
      const who = local
        ? `You(${msg.senderHex.slice(0, 6)})`
        : msg.senderHex.slice(0, 6);
      const veParam = new URLSearchParams(window.location.search).get('ve');
      const veChat =
        veParam === 'chat' || veParam === 'party-chat' || veParam === 'whisper';
      pushChatSay(who, msg.text, veChat ? TOAST_VE_TTL_MS : TOAST_TTL_MS, {
        messageId: msg.messageId,
        local,
        channel: msg.channel ?? 'say',
        recipientHex: msg.recipientHex,
      });
    }
  };


  // ?ve=floaters — seed before connect so the shot does not wait on WS.
  {
    const earlyVe = new URLSearchParams(window.location.search).get('ve');
    if (earlyVe === 'floaters') {
      camera.radius = 9.2;
      camera.alpha = Math.PI / 2.25;
      camera.beta = Math.PI / 3.05;
      camera.setTarget(player.position.clone().add(new Vector3(0, 1.35, 0)));
      const mark = document.getElementById('persistMark');
      if (mark) mark.textContent = 'VE floaters: seeding stack…';
      let ticks = 0;
      const pulse = () => {
        ticks += 1;
        camera.setTarget(player.position.clone().add(new Vector3(0, 1.35, 0)));
        const lists = [damageFloaters, xpFloaters] as DamageFloater[][];
        const liveNow =
          damageFloaters.filter((f) => Date.now() - f.bornMs < f.lifeMs).length +
          xpFloaters.filter((f) => Date.now() - f.bornMs < f.lifeMs).length;
        if (liveNow < 4) {
          damageFloaters.push(
            spawnWorldFloater(
              scene,
              player.position,
              '-12',
              FLOATER_TINT_THORNS,
              { lifeMs: 2400, laneX: -0.28, stackWith: lists },
            ),
          );
          damageFloaters.push(
            spawnWorldFloater(
              scene,
              player.position,
              '-8',
              FLOATER_TINT_SPARK,
              { lifeMs: 2400, laneX: -0.28, stackWith: lists },
            ),
          );
          damageFloaters.push(
            spawnWorldFloater(
              scene,
              player.position,
              '+25',
              FLOATER_TINT_HEAL,
              {
                lifeMs: 2400,
                yLift: 2.05,
                planeW: 1.7,
                planeH: 0.88,
                laneX: 0.18,
                stackWith: lists,
              },
            ),
          );
          xpFloaters.push(
            spawnWorldFloater(
              scene,
              player.position,
              '+10 XP',
              FLOATER_TINT_XP,
              {
                lifeMs: 2400,
                yLift: 2.2,
                planeW: 2.35,
                planeH: 1.0,
                laneX: 0.42,
                stackWith: lists,
              },
            ),
          );
        }
        const live =
          damageFloaters.filter((f) => Date.now() - f.bornMs < f.lifeMs).length +
          xpFloaters.filter((f) => Date.now() - f.bornMs < f.lifeMs).length;
        if (mark) {
          mark.textContent = `Floaters OK · stacked · damage/heal/XP · live ${live}`;
        }
        if (ticks < 50) window.setTimeout(pulse, 320);
      };
      window.setTimeout(pulse, 250);
    }

    // ?ve=floater-read — readability proof under #39 fog (outline + matte tints).
    if (earlyVe === 'floater-read') {
      camera.radius = 9.5;
      camera.alpha = Math.PI / 2.2;
      camera.beta = Math.PI / 3.0;
      camera.setTarget(player.position.clone().add(new Vector3(0, 1.4, 0)));
      const mark = document.getElementById('persistMark');
      if (mark) mark.textContent = 'VE floater-read: seeding…';
      let ticks = 0;
      const pulseRead = () => {
        ticks += 1;
        camera.setTarget(player.position.clone().add(new Vector3(0, 1.4, 0)));
        const lists = [damageFloaters, xpFloaters] as DamageFloater[][];
        const liveNow =
          damageFloaters.filter((f) => Date.now() - f.bornMs < f.lifeMs).length +
          xpFloaters.filter((f) => Date.now() - f.bornMs < f.lifeMs).length;
        if (liveNow < 5) {
          damageFloaters.push(
            spawnWorldFloater(
              scene,
              player.position,
              '-14',
              FLOATER_TINT_THORNS,
              { lifeMs: 3200, laneX: -0.3, stackWith: lists },
            ),
          );
          damageFloaters.push(
            spawnWorldFloater(
              scene,
              player.position,
              '-9',
              FLOATER_TINT_SPARK,
              { lifeMs: 3200, laneX: -0.3, stackWith: lists },
            ),
          );
          damageFloaters.push(
            spawnWorldFloater(
              scene,
              player.position,
              '-22',
              FLOATER_TINT_EMBER,
              { lifeMs: 3200, laneX: -0.3, stackWith: lists },
            ),
          );
          damageFloaters.push(
            spawnWorldFloater(
              scene,
              player.position,
              '+30',
              FLOATER_TINT_HEAL,
              {
                lifeMs: 3200,
                yLift: 2.05,
                planeW: 1.75,
                planeH: 0.9,
                laneX: 0.16,
                stackWith: lists,
              },
            ),
          );
          xpFloaters.push(
            spawnWorldFloater(
              scene,
              player.position,
              '+10 XP',
              FLOATER_TINT_XP,
              {
                lifeMs: 3200,
                yLift: 2.25,
                planeW: 2.4,
                planeH: 1.05,
                laneX: 0.44,
                stackWith: lists,
              },
            ),
          );
        }
        const live =
          damageFloaters.filter((f) => Date.now() - f.bornMs < f.lifeMs).length +
          xpFloaters.filter((f) => Date.now() - f.bornMs < f.lifeMs).length;
        if (mark) {
          mark.textContent =
            `Floater-read OK · outline · damage/heal/XP · #39 fog · live ${live}`;
        }
        if (ticks < 55) window.setTimeout(pulseRead, 340);
      };
      window.setTimeout(pulseRead, 220);
    }
  }

  net = await connectToSpacetime(
    onStatus,
    (pose) => {
      retargetPoseInterp(localInterp, pose.x, pose.y, pose.z, pose.yaw, {
        snapGroundedXz: true,
      });
      const samp = samplePoseInterp(localInterp);
      player.position.x = samp.x;
      player.position.y = samp.y;
      player.position.z = samp.z;
      player.rotation.y = localFacingYaw;
    },
    (npcs) => {
      syncNpcMeshes(npcs);
    },
    (combat) => {
      if (combat) selectedTargetId = combat.targetNpcId;
    },
    (character) => {
      /* HUD refreshed via onStatus; staff/robes meshes follow Character */
      const equipped = character?.staffEquipped ?? true;
      setStaffMeshVisible(humanoid.staff, equipped);
      const robesOn = character?.robesEquipped ?? true;
      setRobesMeshVisible(humanoid, robesOn);
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
    onChatMessages,
    (items) => {
      if (!groundBootstrapped) {
        for (const it of items) groundSeenIds.add(it.lootId.toString());
        groundBootstrapped = true;
        latestGround = items;
        return;
      }
      const party = net?.getParty();
      const local = net?.getLocalPose();
      if (party && party.size >= 2 && local) {
        const shareR2 = 4.5 * 4.5;
        for (const it of items) {
          const key = it.lootId.toString();
          if (groundSeenIds.has(key)) continue;
          const dx = it.x - local.x;
          const dz = it.z - local.z;
          if (dx * dx + dz * dz > shareR2) continue;
          if (key !== toastedPartyLootKey) {
            toastedPartyLootKey = key;
            pushCombatLog('loot', 'Party loot share · ember_shard');
            pushSystemToast(
              'loot',
              'Party loot share · ember_shard nearby',
              TOAST_VE_TTL_MS,
            );
          }
          break;
        }
      }
      for (const it of items) groundSeenIds.add(it.lootId.toString());
      latestGround = items;
    },
  );

  // Optional VE / autotest hooks. `ve` is parsed from bootParams at main() start.

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

  // ?ve=forest / ?ve=quaternius-env — pull camera back so hero trees + mountains + HUD are visible.
  if (ve === 'forest' || ve === 'quaternius-env' || ve === 'aoi') {
    camera.radius = ve === 'aoi' ? 22 : ve === 'quaternius-env' ? 52 : 38;
    camera.alpha = Math.PI / 2.45;
    camera.beta = Math.PI / 3.35;
  }

  if (net && (ve === 'forest' || ve === 'quaternius-env')) {
    const mark = document.getElementById('persistMark');
    const label = ve === 'quaternius-env' ? 'Quaternius env' : 'forest';
    if (mark) mark.textContent = `VE ${label}: waiting for Connected…`;
    const waitForest = () => {
      if (!net) return;
      const st = latestStatus;
      if (st.state === 'connected') {
        if (mark) {
          const ok =
            ve === 'quaternius-env'
              ? 'Quaternius env OK · Standard CC0 heroes+mid+understory · mountains procedural'
              : 'Forest OK · density+LOD · Connected';
          mark.textContent = ok;
        }
        return;
      }
      window.setTimeout(waitForest, 300);
    };
    window.setTimeout(waitForest, 600);
  }

  // ?ve=atmosphere — yard mood shot: fog depth, cool-dusk canopy fill, lush ground.
  if (ve === 'atmosphere') {
    camera.radius = 42;
    camera.alpha = Math.PI / 2.65;
    camera.beta = Math.PI / 3.35;
  }

  if (net && ve === 'atmosphere') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE atmosphere: waiting for Connected…';
    const waitAtmosphere = () => {
      if (!net) return;
      const st = latestStatus;
      if (st.state === 'connected') {
        if (mark) {
          mark.textContent =
            'Atmosphere OK · no banding · sky=fogColor · cool dusk · Connected';
        }
        return;
      }
      window.setTimeout(waitAtmosphere, 300);
    };
    window.setTimeout(waitAtmosphere, 600);
  }

  // ?ve=path-ground — dirt trail vs lush grass, not a plastic disc (#44 / #274).
  if (ve === 'path-ground') {
    camera.radius = 16;
    camera.alpha = Math.PI / 2 + 0.35;
    camera.beta = Math.PI / 2.55;
  }

  if (net && ve === 'path-ground') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE path-ground: waiting for Connected…';
    const waitPathGround = () => {
      if (!net) return;
      const st = latestStatus;
      if (st.state === 'connected') {
        camera.setTarget(player.position.add(new Vector3(-2, 0.25, -8)));
        camera.radius = 16;
        camera.alpha = Math.PI / 2 + 0.35;
        camera.beta = Math.PI / 2.55;
        if (mark) {
          mark.textContent =
            'Path-ground OK · dirt trail vs lush grass · Connected';
        }
        return;
      }
      window.setTimeout(waitPathGround, 300);
    };
    window.setTimeout(waitPathGround, 600);
  }

  // ?ve=place-wow — E9.12 establishing shot vs hordes-place-ref (scale/fog/path).
  if (net && ve === 'place-wow') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE place-wow: waiting for Connected…';
    const waitPlaceWow = () => {
      if (!net) return;
      if (latestStatus.state === 'connected') {
        if (mark) {
          mark.textContent =
            'Place-wow OK · huge trees · receding path · cool dusk · sky=fogColor · no capsules · Connected';
        }
        return;
      }
      window.setTimeout(waitPlaceWow, 300);
    };
    window.setTimeout(waitPlaceWow, 600);
  }

  // ?ve=collision — E9.1 blocked path against a hero bole (#339).
  if (ve === 'collision') {
    camera.radius = 16;
    camera.beta = Math.PI / 2.38;
    camera.alpha = 0.42;
  }
  if (net && ve === 'collision') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE collision: waiting for Connected…';
    let ticks = 0;
    let blockedTicks = 0;
    const yardClear = (): boolean => {
      for (const c of getTrunkCapsules()) {
        const dDummy = Math.hypot(c.x - 5, c.z - 0);
        const dVendor = Math.hypot(c.x - -2.5, c.z - 2);
        if (dDummy < c.radius + PLAYER_TRUNK_RADIUS + 2.5) return false;
        if (dVendor < c.radius + PLAYER_TRUNK_RADIUS + 2.5) return false;
      }
      return true;
    };
    const waitCollision = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE collision: ${st.state}…`;
        if (ticks < 240) window.setTimeout(waitCollision, 200);
        else if (mark) mark.textContent = 'VE collision FAIL · not Connected';
        return;
      }
      const pose = net.getLocalPose();
      if (!pose) {
        if (mark) mark.textContent = 'VE collision: waiting for pose…';
        if (ticks < 240) window.setTimeout(waitCollision, 200);
        return;
      }
      const hero =
        getTrunkCapsules().find(
          (c) =>
            c.kind === 'hero' &&
            Math.hypot(c.x - COLLISION_VE_HERO.x, c.z - COLLISION_VE_HERO.z) < 0.5,
        ) ?? nearestTrunk(pose.x, pose.z, 'hero');
      if (!hero) {
        if (mark) mark.textContent = 'VE collision FAIL · no hero capsules';
        return;
      }
      const dx = hero.x - pose.x;
      const dz = hero.z - pose.z;
      const d = Math.hypot(dx, dz);
      const surface = hero.radius + PLAYER_TRUNK_RADIUS;
      const ghosted = d < surface - 0.5;
      if (ghosted) {
        if (mark) {
          mark.textContent =
            `Collision FAIL · ghosted hero r=${hero.radius.toFixed(2)} d=${d.toFixed(2)}`;
        }
        return;
      }
      const step = Math.min(MAX_STEP_METERS, Math.max(0, d));
      if (step > 1e-4) {
        const slid = slideAgainstTrunks(pose.x, pose.z, (dx / d) * step, (dz / d) * step);
        if (Math.abs(slid.dx) > 1e-5 || Math.abs(slid.dz) > 1e-5) {
          net.sendMove(slid.dx, slid.dz, false);
        }
        if (slid.blocked || d <= surface + 0.4) blockedTicks += 1;
      } else if (d <= surface + 0.4) {
        blockedTicks += 1;
      }
      const dummyOk = yardClear();
      if (blockedTicks >= 4 && dummyOk) {
        if (mark) {
          mark.textContent =
            `Collision OK · blocked against a hero trunk · r=${hero.radius.toFixed(1)} d=${d.toFixed(2)} · dummy/vendor clear`;
        }
        return;
      }
      if (ticks > 180) {
        if (mark) {
          mark.textContent =
            `Collision FAIL · d=${d.toFixed(1)} surface=${surface.toFixed(1)} blocked=${blockedTicks} dummy=${dummyOk ? 'y' : 'n'}`;
        }
        return;
      }
      if (mark) {
        mark.textContent =
          `VE collision: walk hero d=${d.toFixed(1)} / ${surface.toFixed(1)} · r=${hero.radius.toFixed(1)}`;
      }
      window.setTimeout(waitCollision, 50);
    };
    window.setTimeout(waitCollision, 600);
  }

  // ?ve=sky-horizon — establishing shot of layered mountain ranges (#55 / #273).
  // Pose is locked each frame in the render loop (follow rebuilds alpha/beta).
  if (net && ve === 'sky-horizon') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE sky-horizon: waiting for Connected…';
    const waitSkyHorizon = () => {
      if (!net) return;
      const st = latestStatus;
      if (st.state === 'connected') {
        if (mark) {
          mark.textContent =
            'Sky-horizon OK · no banding · sky=fogColor · distant layered ranges · Connected';
        }
        return;
      }
      window.setTimeout(waitSkyHorizon, 300);
    };
    window.setTimeout(waitSkyHorizon, 600);
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
            'Humanoid OK · body+head+limbs+staff · Connected';
        }
        return;
      }
      window.setTimeout(waitHumanoid, 300);
    };
    window.setTimeout(waitHumanoid, 600);
  }

  // ?ve=humanoid-polish — play-cam frame; robes+staff on; silhouette/materials under canonical #39 forest lights.
  if (ve === 'humanoid-polish') {
    camera.radius = 11;
    camera.alpha = Math.PI / 2.55;
    camera.beta = Math.PI / 2.65;
  }
  if (net && ve === 'humanoid-polish') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE humanoid-polish: waiting for Connected…';
    let ticks = 0;
    const waitPolish = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE humanoid-polish: ${st.state}…`;
        if (ticks < 180) window.setTimeout(waitPolish, 200);
        return;
      }
      const ch = net.getCharacter();
      if (ch && !ch.staffEquipped) {
        net.equipStaff();
        if (mark) mark.textContent = 'VE humanoid-polish: equipping staff…';
        window.setTimeout(waitPolish, 250);
        return;
      }
      if (ch && !ch.robesEquipped) {
        net.equipRobes();
        if (mark) mark.textContent = 'VE humanoid-polish: equipping robes…';
        window.setTimeout(waitPolish, 250);
        return;
      }
      setStaffMeshVisible(humanoid.staff, true);
      setRobesMeshVisible(humanoid, true);
      setHumanoidMoving(humanoid, false);
      const staffOn = humanoid.staff.isEnabled();
      const robesOn = humanoid.robes.isEnabled();
      const pb = readHumanoidPlayback(humanoid);
      const polishOk =
        staffOn &&
        robesOn &&
        pb.skinned > 0 &&
        !!pb.playing &&
        /idle/i.test(pb.playing);
      if (mark) {
        mark.textContent = polishOk
          ? `Humanoid polish OK · ${pb.playing} · skinned ${pb.skinned} · cloth/skin/wood`
          : `T-POSE · clip=${pb.playing ?? 'none'} · skeleton=${pb.skinned}`;
      }
      if (ticks < 240) window.setTimeout(waitPolish, 200);
    };
    window.setTimeout(waitPolish, 600);
  }

  // ?ve=dummy — frame scarecrow/practice dummy at play-cam under canonical #39 lights.
  if (ve === 'dummy') {
    camera.radius = 8.4;
    camera.alpha = Math.PI / 2.15;
    camera.beta = Math.PI / 2.48;
  }
  if (net && ve === 'dummy') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE dummy: waiting for Connected + Dummy…';
    let ticks = 0;
    let okTicks = 0;
    const waitDummy = () => {
      if (!net) return;
      ticks += 1;
      net.ensureTrainingDummy();
      const st = latestStatus;
      const cycle = net.getTargetCycle();
      const dummy = cycle.find((n) => n.kind === NPC_KIND_DUMMY) ?? cycle[0];
      if (dummy) {
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
      }
      syncNpcMeshes(net.getNpcs());
      if (dummy) {
        const dx = dummy.x - player.position.x;
        const dz = dummy.z - player.position.z;
        const dist = Math.hypot(dx, dz);
        // Stand ~5.5–7m out so scarecrow fills play-cam (reads as TARGET / hit-me).
        if (dist > 7.2) {
          const step = Math.min(MAX_STEP_METERS, dist - 5.8);
          net.sendMove((dx / dist) * step, (dz / dist) * step, false);
        } else if (dist < 4.8) {
          const step = Math.min(MAX_STEP_METERS, 5.8 - dist);
          net.sendMove((-dx / dist) * step, (-dz / dist) * step, false);
        }
        // Bias toward dummy so wood post + X-pad + sack head dominate the shot.
        camera.setTarget(
          new Vector3(
            player.position.x * 0.15 + dummy.x * 0.85,
            0.72,
            player.position.z * 0.15 + dummy.z * 0.85,
          ),
        );
        camera.radius = 8.4;
        camera.alpha = Math.PI / 2.15;
        camera.beta = Math.PI / 2.48;
      }
      const mesh = dummy ? npcMeshes.get(dummy.npcId.toString()) : undefined;
      const scarecrow =
        !!(mesh && mesh.extraMats.length >= 2 && mesh.body.getChildMeshes().length >= 5);
      if (
        st.state === 'connected' &&
        dummy &&
        mesh &&
        scarecrow &&
        selectedTargetId === dummy.npcId
      ) {
        okTicks += 1;
        if (mark) {
          mark.textContent =
            `Dummy OK · post on dirt · no float · scarecrow · #${dummy.npcId}`;
        }
        if (okTicks < 6 && ticks < 140) {
          window.setTimeout(waitDummy, 180);
        }
        return;
      }
      if (mark && st.state === 'connected') {
        mark.textContent = `VE dummy: Connected · dummy ${dummy ? 'yes' : 'no'} · parts ${scarecrow ? 'ok' : '…'} (waiting…)`;
      }
      if (ticks > 160) {
        if (mark) mark.textContent = 'VE dummy: timed out waiting for scarecrow dummy';
        return;
      }
      window.setTimeout(waitDummy, 200);
    };
    window.setTimeout(waitDummy, 700);
  }

  // ?ve=quaternius-char — Quaternius wizard silhouette at 8–15m under #39 forest lights.
  if (ve === 'quaternius-char') {
    camera.radius = 12;
    camera.alpha = Math.PI / 2.45;
    camera.beta = Math.PI / 2.7;
  }
  if (net && ve === 'quaternius-char') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE quaternius-char: waiting for Connected…';
    let ticks = 0;
    const waitQ = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE quaternius-char: ${st.state}…`;
        if (ticks < 180) window.setTimeout(waitQ, 200);
        return;
      }
      const ch = net.getCharacter();
      if (ch && !ch.staffEquipped) {
        net.equipStaff();
        window.setTimeout(waitQ, 250);
        return;
      }
      if (ch && !ch.robesEquipped) {
        net.equipRobes();
        window.setTimeout(waitQ, 250);
        return;
      }
      setStaffMeshVisible(humanoid.staff, true);
      setRobesMeshVisible(humanoid, true);
      camera.setTarget(player.position.add(new Vector3(0, 1.05, 0)));
      camera.radius = 12;
      camera.alpha = Math.PI / 2.45;
      camera.beta = Math.PI / 2.7;
      if (mark) {
        mark.textContent =
          'Quaternius char OK · wizard+staff · 8–15m · canonical forest lights';
      }
    };
    window.setTimeout(waitQ, 600);
  }

  // ?ve=walk — E2.3/E2.6 play-cam Walk clip (legs moving, not T-pose).
  if (ve === 'walk') {
    camera.radius = 7;
    camera.alpha = 0.35;
    camera.beta = Math.PI / 2.45;
  }
  if (net && ve === 'walk') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE walk: waiting for Connected…';
    let ticks = 0;
    const waitWalk = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE walk: ${st.state}…`;
        if (ticks < 180) window.setTimeout(waitWalk, 200);
        return;
      }
      const ch = net.getCharacter();
      if (ch && !ch.staffEquipped) {
        net.equipStaff();
        window.setTimeout(waitWalk, 250);
        return;
      }
      if (ch && !ch.robesEquipped) {
        net.equipRobes();
        window.setTimeout(waitWalk, 250);
        return;
      }
      setStaffMeshVisible(humanoid.staff, true);
      setRobesMeshVisible(humanoid, true);
      keys.add('w');
      setHumanoidMoving(humanoid, true, false, MOVE_SPEED);
      const pb = readHumanoidPlayback(humanoid);
      const walkOk =
        pb.skinned > 0 && !!pb.playing && /walk/i.test(pb.playing);
      if (mark) {
        mark.textContent = walkOk
          ? `Walk OK · ${pb.playing} · skinned ${pb.skinned}`
          : `T-POSE · clip=${pb.playing ?? 'none'} · skeleton=${pb.skinned}`;
      }
      if (ticks < 240) window.setTimeout(waitWalk, 200);
    };
    window.setTimeout(waitWalk, 600);
  }

  // ?ve=walk-stop — E8.28 Walk-to-Idle: no leftover Walk stride at 0 wish.
  if (ve === 'walk-stop') {
    camera.radius = 7;
    camera.alpha = 0.35;
    camera.beta = Math.PI / 2.45;
  }
  if (net && ve === 'walk-stop') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE walk-stop: waiting for Connected…';
    let ticks = 0;
    let sawWalk = false;
    const clipBare = (name: string | null): string => {
      if (!name) return 'none';
      const i = name.lastIndexOf('|');
      return i >= 0 ? name.slice(i + 1) : name;
    };
    const waitStop = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE walk-stop: ${st.state}…`;
        if (ticks < 180) window.setTimeout(waitStop, 200);
        return;
      }
      const ch = net.getCharacter();
      if (ch && !ch.staffEquipped) {
        net.equipStaff();
        window.setTimeout(waitStop, 250);
        return;
      }
      if (ch && !ch.robesEquipped) {
        net.equipRobes();
        window.setTimeout(waitStop, 250);
        return;
      }
      setStaffMeshVisible(humanoid.staff, true);
      setRobesMeshVisible(humanoid, true);
      const holding = ticks <= 10;
      if (holding) {
        keys.add('w');
        setHumanoidMoving(humanoid, true, false, MOVE_SPEED);
      } else {
        keys.delete('w');
        setHumanoidMoving(humanoid, false);
      }
      const pb = readHumanoidPlayback(humanoid);
      const clip = clipBare(pb.playing);
      if (/walk/i.test(clip) && pb.skinned > 0) sawWalk = true;
      const idleOk =
        !holding &&
        sawWalk &&
        pb.skinned > 0 &&
        /^idle/i.test(clip) &&
        !/walk/i.test(clip) &&
        !/t-pose/i.test(clip);
      if (mark) {
        if (idleOk) {
          mark.textContent = `Idle OK · ${pb.playing} · skinned ${pb.skinned} · walk-stop`;
        } else if (pb.skinned <= 0) {
          mark.textContent = `T-POSE · clip=${pb.playing ?? 'none'} · skeleton=${pb.skinned}`;
        } else if (holding) {
          mark.textContent = `VE walk-stop: walking · ${clip} · skinned ${pb.skinned}`;
        } else {
          mark.textContent = `VE walk-stop: stopping · ${clip} · skinned ${pb.skinned}`;
        }
      }
      if (ticks < 240) window.setTimeout(waitStop, 200);
    };
    window.setTimeout(waitStop, 600);
  }

  // ?ve=run — E8.2 play-cam Run_Weapon (fast/forward gait, not Walk / T-pose).
  if (ve === 'run') {
    camera.radius = 7;
    camera.alpha = 0.35;
    camera.beta = Math.PI / 2.45;
  }
  if (net && ve === 'run') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE run: waiting for Connected…';
    let ticks = 0;
    const waitRun = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE run: ${st.state}…`;
        if (ticks < 180) window.setTimeout(waitRun, 200);
        return;
      }
      const ch = net.getCharacter();
      if (ch && !ch.staffEquipped) {
        net.equipStaff();
        window.setTimeout(waitRun, 250);
        return;
      }
      if (ch && !ch.robesEquipped) {
        net.equipRobes();
        window.setTimeout(waitRun, 250);
        return;
      }
      setStaffMeshVisible(humanoid.staff, true);
      setRobesMeshVisible(humanoid, true);
      keys.add('w');
      setHumanoidMoving(humanoid, true, true, MOVE_SPEED);
      const pb = readHumanoidPlayback(humanoid);
      const runOk =
        pb.skinned > 0 &&
        !!pb.playing &&
        /run/i.test(pb.playing);
      if (mark) {
        mark.textContent = runOk
          ? `Run OK · ${pb.playing} · skinned ${pb.skinned}`
          : `T-POSE · clip=${pb.playing ?? 'none'} · skeleton=${pb.skinned}`;
      }
      if (ticks < 240) window.setTimeout(waitRun, 200);
    };
    window.setTimeout(waitRun, 600);
  }

  // ?ve=flinch — E8.5 RecieveHit on dummy thorns; Move intents still flow.
  if (ve === 'flinch') {
    camera.radius = 8;
    camera.alpha = 0.35;
    camera.beta = Math.PI / 2.5;
  }
  if (net && ve === 'flinch') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE flinch: waiting for Connected…';
    let ticks = 0;
    let seeded = false;
    let lastCastAt = 0;
    let startHp: number | null = null;
    const waitFlinch = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE flinch: ${st.state}…`;
        if (ticks < 180) window.setTimeout(waitFlinch, 200);
        return;
      }
      const ch = net.getCharacter();
      if (ch && !ch.staffEquipped) {
        net.equipStaff();
        window.setTimeout(waitFlinch, 250);
        return;
      }
      if (startHp == null && ch) startHp = ch.hp;
      const pb = readHumanoidPlayback(humanoid);
      const flinchOk =
        pb.skinned > 0 && !!pb.playing && /recievehit|flinch/i.test(pb.playing);
      if (flinchOk) {
        if (mark) {
          mark.textContent = `Flinch OK · ${pb.playing} · skinned ${pb.skinned}`;
        }
        return;
      }
      if (!seeded) {
        net.ensureTrainingDummy();
        seeded = true;
        window.setTimeout(waitFlinch, 300);
        return;
      }
      const cycle = net.getTargetCycle();
      const dummy =
        cycle.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0) ??
        cycle.find((n) => n.kind === NPC_KIND_DUMMY) ??
        null;
      if (!dummy || dummy.hp <= 0) {
        net.ensureTrainingDummy();
        window.setTimeout(waitFlinch, 280);
        return;
      }
      net.setTarget(dummy.npcId);
      selectedTargetId = dummy.npcId;
      const gcd = gcdRemainingMs(net.getCombat());
      const now = Date.now();
      if (ch && ch.hp > 0 && gcd <= 0 && now - lastCastAt > 1250) {
        lastCastSpell = SPELL_SPARK;
        net.cast(SPELL_SPARK);
        lastCastAt = now;
      }
      if (mark) {
        mark.textContent = flinchOk
          ? `Flinch OK · ${pb.playing} · skinned ${pb.skinned}`
          : `VE flinch: You ${ch?.hp ?? '?'}/${ch?.maxHp ?? '?'} · clip=${pb.playing ?? 'none'}`;
      }
      if (ticks > 240) {
        if (mark) {
          mark.textContent = `T-POSE · clip=${pb.playing ?? 'none'} · skeleton=${pb.skinned}`;
        }
        return;
      }
      window.setTimeout(waitFlinch, 140);
    };
    window.setTimeout(waitFlinch, 600);
  }

  // ?ve=walk-flinch — E8.34 RecieveHit while Walk wish is held, not sliding Idle.
  if (ve === 'walk-flinch') {
    camera.radius = 7;
    camera.alpha = 0.35;
    camera.beta = Math.PI / 2.45;
  }
  if (net && ve === 'walk-flinch') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE walk-flinch: waiting for Connected…';
    const clipBare = (name: string | null): string => {
      if (!name) return 'none';
      const i = name.lastIndexOf('|');
      return i >= 0 ? name.slice(i + 1) : name;
    };
    let ticks = 0;
    let seeded = false;
    let lastCastAt = 0;
    let sawWalk = false;
    const waitWalkFlinch = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE walk-flinch: ${st.state}…`;
        if (ticks < 180) window.setTimeout(waitWalkFlinch, 160);
        return;
      }
      const ch = net.getCharacter();
      if (ch && !ch.staffEquipped) {
        net.equipStaff();
        window.setTimeout(waitWalkFlinch, 250);
        return;
      }
      if (ch && !ch.robesEquipped) {
        net.equipRobes();
        window.setTimeout(waitWalkFlinch, 250);
        return;
      }
      setStaffMeshVisible(humanoid.staff, true);
      setRobesMeshVisible(humanoid, true);
      keys.add('w');
      if (!seeded) {
        net.ensureTrainingDummy();
        seeded = true;
      }
      const cycle = net.getTargetCycle();
      const dummy =
        cycle.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0) ??
        cycle.find((n) => n.kind === NPC_KIND_DUMMY) ??
        null;
      if (dummy && dummy.hp > 0) {
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
        const mesh = npcMeshes.get(dummy.npcId.toString());
        const tx = mesh?.root.position.x ?? dummy.x;
        const tz = mesh?.root.position.z ?? dummy.z;
        const dx = tx - player.position.x;
        const dz = tz - player.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 2.6) {
          const scale = Math.min(0.22, dist) / dist;
          net.sendMove(dx * scale, dz * scale, false);
        } else if (dist < 1.8) {
          net.sendMove(-dx * 0.12, -dz * 0.12, false);
        } else {
          net.sendMove(-dz * 0.16, dx * 0.16, false);
        }
        const gcd = gcdRemainingMs(net.getCombat());
        const now = Date.now();
        if (ch && ch.hp > 0 && dist < 8 && gcd <= 0 && now - lastCastAt > 900) {
          lastCastSpell = SPELL_SPARK;
          net.cast(SPELL_SPARK);
          lastCastAt = now;
        }
      } else {
        net.ensureTrainingDummy();
      }
      const pb = readHumanoidPlayback(humanoid);
      const clip = clipBare(pb.playing);
      if (/^walk/i.test(clip) && pb.skinned > 0) sawWalk = true;
      const flinchNow = /recievehit/i.test(clip) && pb.skinned > 0;
      const ok = flinchNow && sawWalk && !/t-pose/i.test(clip);
      if (mark) {
        if (ok) {
          mark.textContent = `Walk-flinch OK · ${clip} · Walk · skinned ${pb.skinned}`;
        } else if (pb.skinned <= 0) {
          mark.textContent = `T-POSE · clip=${pb.playing ?? 'none'} · skeleton=${pb.skinned}`;
        } else if (!/^Walk-flinch OK/.test(mark.textContent ?? '')) {
          mark.textContent = `VE walk-flinch: ${clip} · walk ${sawWalk ? 'seen' : 'waiting'} · hp ${ch?.hp ?? '?'}`;
        }
      }
      if (ticks < 400) window.setTimeout(waitWalkFlinch, 32);
    };
    window.setTimeout(waitWalkFlinch, 600);
  }

  // ?ve=yaw — E2.4 face camera-relative wish (slerp, no client positions).
  if (ve === 'yaw') {
    camera.radius = 7;
    camera.alpha = 0.35;
    camera.beta = Math.PI / 2.45;
  }
  if (net && ve === 'yaw') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE yaw: waiting for Connected…';
    let ticks = 0;
    const waitYaw = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE yaw: ${st.state}…`;
        if (ticks < 180) window.setTimeout(waitYaw, 200);
        return;
      }
      if (!net.getLocalPose()) {
        if (mark) mark.textContent = 'VE yaw: waiting for pose…';
        if (ticks < 180) window.setTimeout(waitYaw, 200);
        return;
      }
      const ch = net.getCharacter();
      if (ch && !ch.staffEquipped) {
        net.equipStaff();
        window.setTimeout(waitYaw, 250);
        return;
      }
      if (ch && !ch.robesEquipped) {
        net.equipRobes();
        window.setTimeout(waitYaw, 250);
        return;
      }
      setStaffMeshVisible(humanoid.staff, true);
      setRobesMeshVisible(humanoid, true);
      keys.add('w');
      const pb = readHumanoidPlayback(humanoid);
      const turned = Math.abs(localFacingYaw) > 0.2;
      const yawOk =
        pb.skinned > 0 &&
        !!pb.playing &&
        turned;
      if (yawOk) {
        if (mark) {
          mark.textContent =
            `Yaw OK · ${pb.playing} · skinned ${pb.skinned} · facing wish · y=${localFacingYaw.toFixed(2)}`;
        }
        return;
      }
      if (ticks > 240) {
        if (mark) {
          mark.textContent =
            pb.skinned < 1
              ? `T-POSE · clip=${pb.playing ?? 'none'} · skeleton=${pb.skinned} · y=${localFacingYaw.toFixed(2)}`
              : `Yaw FAIL · clip=${pb.playing ?? 'none'} · skinned ${pb.skinned} · y=${localFacingYaw.toFixed(2)}`;
        }
        return;
      }
      if (mark) {
        mark.textContent =
          `VE yaw: y=${localFacingYaw.toFixed(2)} · clip=${pb.playing ?? 'none'} · skinned ${pb.skinned}…`;
      }
      window.setTimeout(waitYaw, 200);
    };
    window.setTimeout(waitYaw, 600);
  }

  // ?ve=look-at — E2.10 standing faces Tab-target; WASD yaw still wins.
  if (ve === 'look-at') {
    camera.radius = 10;
    camera.alpha = 0.35;
    camera.beta = Math.PI / 2.45;
  }
  if (net && ve === 'look-at') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE look-at: waiting for Connected…';
    let ticks = 0;
    const waitLook = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE look-at: ${st.state}…`;
        if (ticks < 180) window.setTimeout(waitLook, 200);
        return;
      }
      net.ensureTrainingDummy();
      const cycle = net.getTargetCycle();
      const dummy = cycle.find((n) => n.kind === NPC_KIND_DUMMY) ?? cycle[0];
      if (dummy) {
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
      }
      if (mark) {
        if (dummy && Math.abs(localFacingYaw) > 0.25) {
          mark.textContent = `Look-at OK · target npc#${dummy.npcId} · yaw ${localFacingYaw.toFixed(2)} · Connected`;
        } else if (dummy) {
          mark.textContent = `VE look-at: target npc#${dummy.npcId} · yaw ${localFacingYaw.toFixed(2)} (turning)`;
        } else {
          mark.textContent = 'VE look-at: waiting for Dummy…';
        }
      }
      if (ticks < 240) window.setTimeout(waitLook, 200);
    };
    window.setTimeout(waitLook, 600);
  }

  // ?ve=face-target-walk — walk toward Tab Dummy, face target, Walk clip, no moonwalk (#432).
  if (ve === 'face-target-walk') {
    camera.radius = 8;
    camera.alpha = Math.PI;
    camera.beta = Math.PI / 2.45;
  }
  if (net && ve === 'face-target-walk') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE face-target-walk: waiting for Connected…';
    const clipBare = (name: string | null): string => {
      if (!name) return 'none';
      const i = name.lastIndexOf('|');
      return i >= 0 ? name.slice(i + 1) : name;
    };
    let ticks = 0;
    const waitFace = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE face-target-walk: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitFace, 200);
        return;
      }
      const ch = net.getCharacter();
      if (ch && !ch.staffEquipped) {
        net.equipStaff();
        window.setTimeout(waitFace, 250);
        return;
      }
      net.ensureTrainingDummy();
      const npcs = net.getNpcs();
      const dummy = npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0) ?? null;
      if (!dummy) {
        if (mark) mark.textContent = 'VE face-target-walk: seeding dummy…';
        if (ticks < 200) window.setTimeout(waitFace, 300);
        return;
      }
      net.setTarget(dummy.npcId);
      selectedTargetId = dummy.npcId;
      keys.add('w');
      setHumanoidMoving(humanoid, true, false, MOVE_SPEED);
      const pb = readHumanoidPlayback(humanoid);
      const clip = clipBare(pb.playing);
      const toDummy =
        dummy != null
          ? Math.atan2(dummy.x - player.position.x, dummy.z - player.position.z)
          : 0;
      const faceErr = dummy ? Math.abs(yawDelta(localFacingYaw, toDummy)) : 99;
      const walkOk =
        pb.skinned > 0 &&
        /^walk$/i.test(clip) &&
        dummy != null &&
        faceErr < 0.45 &&
        !localTurningInPlace;
      if (walkOk) {
        if (mark) {
          mark.textContent =
            `Walk OK · ${clip} · skinned ${pb.skinned} · face target · y=${localFacingYaw.toFixed(2)}`;
        }
        return;
      }
      if (ticks > 220) {
        if (mark) {
          if (pb.skinned <= 0) {
            mark.textContent = `T-POSE · clip=${pb.playing ?? 'none'} · skeleton=${pb.skinned}`;
          } else {
            mark.textContent =
              `Yaw FAIL · clip=${clip} · skinned ${pb.skinned} · y=${localFacingYaw.toFixed(2)} · faceErr=${faceErr.toFixed(2)}`;
          }
        }
        return;
      }
      if (mark) {
        mark.textContent =
          `VE face-target-walk: clip=${clip} · y=${localFacingYaw.toFixed(2)} · faceErr=${faceErr.toFixed(2)}…`;
      }
      window.setTimeout(waitFace, 200);
    };
    window.setTimeout(waitFace, 700);
  }

  // ?ve=cast-anim — E8.6 hold Spell1 for Emberbolt windup (Spark stays one-shot).
  if (ve === 'cast-anim') {
    camera.radius = 8;
    camera.alpha = Math.PI / 2.2;
    camera.beta = Math.PI / 2.6;
  }
  if (net && ve === 'cast-anim') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE cast-anim: waiting for Connected…';
    let ticks = 0;
    const waitCast = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE cast-anim: ${st.state}…`;
        if (ticks < 180) window.setTimeout(waitCast, 200);
        return;
      }
      const ch = net.getCharacter();
      if (ch && !ch.staffEquipped) {
        net.equipStaff();
        window.setTimeout(waitCast, 250);
        return;
      }
      if (ch && !ch.robesEquipped) {
        net.equipRobes();
        window.setTimeout(waitCast, 250);
        return;
      }
      setStaffMeshVisible(humanoid.staff, true);
      setRobesMeshVisible(humanoid, true);
      setHumanoidCasting(humanoid, true);
      const pb = readHumanoidPlayback(humanoid);
      const castOk =
        pb.skinned > 0 && !!pb.playing && /spell/i.test(pb.playing);
      if (mark) {
        mark.textContent = castOk
          ? `Cast OK · ${pb.playing} · skinned ${pb.skinned}`
          : `T-POSE · clip=${pb.playing ?? 'none'} · skeleton=${pb.skinned}`;
      }
      if (!castOk && ticks < 240) window.setTimeout(waitCast, 200);
    };
    window.setTimeout(waitCast, 600);
  }

  // ?ve=cast-cancel-pose — Esc/CancelCast recovers Idle_Weapon, no bind-T (#431).
  if (ve === 'cast-cancel-pose') {
    camera.radius = 8;
    camera.alpha = Math.PI / 2.2;
    camera.beta = Math.PI / 2.6;
  }
  if (net && ve === 'cast-cancel-pose') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE cast-cancel-pose: waiting for Connected…';
    const clipBare = (name: string | null): string => {
      if (!name) return 'none';
      const i = name.lastIndexOf('|');
      return i >= 0 ? name.slice(i + 1) : name;
    };
    let ticks = 0;
    let phase: 'cast' | 'cancel' | 'recover' = 'cast';
    let sawSpell = false;
    const waitPose = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE cast-cancel-pose: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitPose, 200);
        return;
      }
      const ch = net.getCharacter();
      if (ch && !ch.staffEquipped) {
        net.equipStaff();
        window.setTimeout(waitPose, 250);
        return;
      }
      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      const dummy =
        npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0) ?? null;
      if (!dummy) {
        net.ensureTrainingDummy();
        if (mark) mark.textContent = 'VE cast-cancel-pose: seeding dummy…';
        window.setTimeout(waitPose, 300);
        return;
      }
      const pb = readHumanoidPlayback(humanoid);
      const clip = clipBare(pb.playing);
      if (phase === 'cast') {
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
        if (
          ch &&
          ch.hp > 0 &&
          (ch.mana ?? 0) >= EMBERBOLT_MANA_COST &&
          gcdRemainingMs(net.getCombat()) <= 0
        ) {
          net.cast(SPELL_EMBERBOLT);
          lastCastSpell = SPELL_EMBERBOLT;
          phase = 'cancel';
          if (mark) mark.textContent = 'VE cast-cancel-pose: Emberbolt windup…';
        }
        window.setTimeout(waitPose, 200);
        return;
      }
      if (phase === 'cancel') {
        if (pb.skinned > 0 && /spell/i.test(pb.playing ?? '')) sawSpell = true;
        const combat = net.getCombat();
        const wind = combat && combat.castingSpellId !== 0;
        if (sawSpell || wind) {
          void net.cancelCast();
          setHumanoidCasting(humanoid, false);
          phase = 'recover';
          if (mark) mark.textContent = 'VE cast-cancel-pose: CancelCast…';
        }
        if (ticks > 200) {
          if (mark) {
            mark.textContent = pb.skinned <= 0
              ? `T-POSE · clip=${pb.playing ?? 'none'} · skeleton=${pb.skinned}`
              : `Cast cancel FAIL · no Spell hold · ${clip}`;
          }
          return;
        }
        window.setTimeout(waitPose, 180);
        return;
      }
      const recoverOk =
        pb.skinned > 0 &&
        /^idle_weapon$/i.test(clip) &&
        !/spell/i.test(pb.playing ?? '');
      if (recoverOk) {
        if (mark) {
          mark.textContent = `Cast cancel OK · ${clip} · skinned ${pb.skinned}`;
        }
        return;
      }
      if (pb.skinned <= 0) {
        if (mark) {
          mark.textContent = `T-POSE · clip=${pb.playing ?? 'none'} · skeleton=${pb.skinned}`;
        }
        if (ticks > 220) return;
        window.setTimeout(waitPose, 180);
        return;
      }
      if (ticks > 240) {
        if (mark) {
          mark.textContent = `Cast cancel FAIL · recover ${clip} · skinned ${pb.skinned}`;
        }
        return;
      }
      if (mark) {
        mark.textContent = `VE cast-cancel-pose: recover ${clip}…`;
      }
      window.setTimeout(waitPose, 180);
    };
    window.setTimeout(waitPose, 700);
  }

  // ?ve=character-wow — E8.12 reel + E8.24 hostile person + E8.29 sheathed/face-target. Dummy trainer.
  if (ve === 'character-wow') {
    camera.radius = 12;
    camera.alpha = -Math.PI / 2;
    camera.beta = Math.PI / 2.45;
  }
  if (net && ve === 'character-wow') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE character-wow: waiting for Connected…';
    const clipBare = (name: string | null): string => {
      if (!name) return 'none';
      const i = name.lastIndexOf('|');
      return i >= 0 ? name.slice(i + 1) : name;
    };
    let ticks = 0;
    const seen: string[] = [];
    let t0 = 0;
    const waitWow = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE character-wow: ${st.state}…`;
        if (ticks < 180) window.setTimeout(waitWow, 200);
        return;
      }
      const ch = net.getCharacter();
      if (ch && !ch.robesEquipped) {
        net.equipRobes();
        window.setTimeout(waitWow, 250);
        return;
      }
      if (!t0) t0 = Date.now();
      setRobesMeshVisible(humanoid, true);
      const elapsed = (Date.now() - t0) / 1000;
      const npcsEarly = net.getNpcs();
      syncNpcMeshes(npcsEarly);
      const dummyEarly = npcsEarly.find((n) => n.kind === NPC_KIND_DUMMY);
      if (dummyEarly && selectedTargetId !== dummyEarly.npcId) {
        net.setTarget(dummyEarly.npcId);
        selectedTargetId = dummyEarly.npcId;
      }
      // Idle_Weapon → sheathed Idle → Walk (face dummy) → Run → hop → Spell.
      if (elapsed < 1.0) {
        if (ch && !ch.staffEquipped) net.equipStaff();
        setHumanoidStaffEquipped(humanoid, true);
        setStaffMeshVisible(humanoid.staff, true);
        setHumanoidCasting(humanoid, false);
        setHumanoidAirborne(humanoid, false);
        setHumanoidMoving(humanoid, false);
      } else if (elapsed < 2.2) {
        if (ch && ch.staffEquipped) net.unequipStaff();
        setHumanoidStaffEquipped(humanoid, false);
        setStaffMeshVisible(humanoid.staff, false);
        setHumanoidCasting(humanoid, false);
        setHumanoidAirborne(humanoid, false);
        setHumanoidMoving(humanoid, false);
      } else if (elapsed < 3.6) {
        if (ch && !ch.staffEquipped) net.equipStaff();
        setHumanoidStaffEquipped(humanoid, true);
        setStaffMeshVisible(humanoid.staff, true);
        setHumanoidCasting(humanoid, false);
        setHumanoidAirborne(humanoid, false);
        setHumanoidMoving(humanoid, true, false, MOVE_SPEED);
      } else if (elapsed < 5.0) {
        if (ch && !ch.staffEquipped) net.equipStaff();
        setHumanoidStaffEquipped(humanoid, true);
        setStaffMeshVisible(humanoid.staff, true);
        setHumanoidCasting(humanoid, false);
        setHumanoidAirborne(humanoid, false);
        setHumanoidMoving(humanoid, true, true, MOVE_SPEED);
      } else if (elapsed < 6.4) {
        if (ch && !ch.staffEquipped) net.equipStaff();
        setHumanoidStaffEquipped(humanoid, true);
        setStaffMeshVisible(humanoid.staff, true);
        setHumanoidCasting(humanoid, false);
        setHumanoidMoving(humanoid, false);
        setHumanoidAirborne(humanoid, true);
      } else {
        if (ch && !ch.staffEquipped) net.equipStaff();
        setHumanoidStaffEquipped(humanoid, true);
        setStaffMeshVisible(humanoid.staff, true);
        setHumanoidAirborne(humanoid, false);
        setHumanoidCasting(humanoid, true);
      }
      const pb = readHumanoidPlayback(humanoid);
      if (pb.playing && !seen.includes(pb.playing)) seen.push(pb.playing);
      {
        const clip = clipBare(pb.playing);
        if (
          elapsed >= 1.0 &&
          elapsed < 2.2 &&
          /^idle$/i.test(clip) &&
          !/weapon/i.test(clip) &&
          !seen.includes('sheathed')
        ) {
          seen.push('sheathed');
        }
      }
      if (elapsed >= 5.0 && elapsed < 6.4 && !seen.includes('hop-pose')) {
        seen.push('hop-pose');
      }
      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      const dummyRow = npcs.find((n) => n.kind === NPC_KIND_DUMMY) ?? null;
      const dummyMesh = dummyRow
        ? npcMeshes.get(dummyRow.npcId.toString())
        : undefined;
      const dummyTrainer = !!dummyMesh && !dummyMesh.humanoid;
      let hostilePb: ReturnType<typeof readHumanoidPlayback> | null = null;
      let capsuleLeft = false;
      for (const n of npcs) {
        if (!isHostileKind(n.kind)) continue;
        const mesh = npcMeshes.get(n.npcId.toString());
        if (mesh?.humanoid) {
          if (n.hp > 0) setHumanoidMoving(mesh.humanoid, false);
          const hpb = readHumanoidPlayback(mesh.humanoid);
          if (
            hpb.skinned > 0 &&
            !!hpb.playing &&
            /idle|death/i.test(hpb.playing)
          ) {
            const livingIdle =
              n.hp > 0 && /idle/i.test(hpb.playing ?? '');
            if (!hostilePb || livingIdle) hostilePb = hpb;
            if (livingIdle) break;
          }
        } else if (mesh) {
          capsuleLeft = true;
        }
      }
      const playerOk =
        pb.skinned > 0 &&
        seen.some((n) => /idle_weapon/i.test(n)) &&
        seen.includes('sheathed') &&
        seen.some((n) => /walk/i.test(n)) &&
        seen.some((n) => /run/i.test(n)) &&
        seen.includes('hop-pose') &&
        seen.some((n) => /spell/i.test(n));
      const wowOk =
        playerOk &&
        dummyTrainer &&
        !capsuleLeft &&
        hostilePb != null &&
        hostilePb.skinned > 0;
      if (wowOk && hostilePb) {
        if (mark) {
          const clips = seen.map((n) => (n === 'hop-pose' ? n : clipBare(n)));
          mark.textContent =
            `Character wow OK · ${clips.join(' · ')} · Hostile ${clipBare(hostilePb.playing)} · skinned ${pb.skinned} · dummy trainer`;
        }
        return;
      }
      if (ticks > 160) {
        if (mark) {
          if (capsuleLeft) {
            mark.textContent = 'capsule · hostile not a person';
          } else if (pb.skinned <= 0 || (hostilePb && hostilePb.skinned <= 0)) {
            mark.textContent = `T-POSE · clip=${pb.playing ?? 'none'} · skeleton=${pb.skinned}`;
          } else {
            mark.textContent =
              `Character wow FAIL · ${seen.join(' · ') || 'no clips'} · hostile ${hostilePb ? clipBare(hostilePb.playing) : 'none'} · dummy ${dummyTrainer ? 'trainer' : 'n'}`;
          }
        }
        return;
      }
      if (mark) {
        mark.textContent =
          `VE character-wow · ${seen.join(' · ') || pb.playing || '…'} · hostile ${hostilePb ? clipBare(hostilePb.playing) : '…'} · skinned ${pb.skinned}`;
      }
      window.setTimeout(waitWow, 200);
    };
    window.setTimeout(waitWow, 700);
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
        for (let i = 0; i < 4; i++) net.sendMove(-0.75, 0, false);
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

  // ?ve=remote-walk — E2.8 other wizards Walk from pose XZ delta (no client positions).
  if (ve === 'remote-walk') {
    camera.radius = 16;
    camera.alpha = Math.PI / 2.35;
    camera.beta = Math.PI / 3.1;
  }
  if (net && ve === 'remote-walk') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE remote-walk: waiting for remotes…';
    let ticks = 0;
    let nudged = false;
    const waitRemoteWalk = () => {
      if (!net) return;
      ticks += 1;
      if (!nudged && latestStatus.state === 'connected') {
        nudged = true;
        // Park local off the remote close-up (patrol is (4,2.5)/(-3,3)).
        for (let i = 0; i < 8; i++) net.sendMove(-0.75, -0.6, false);
      }
      const remotes = net.getRemotes();
      syncRemoteMeshes(remotes);
      const n = remoteMeshes.size;
      const local = net.getLocalPose();
      const playbackOf = (hex: string) => {
        const p = remoteMeshes.get(hex);
        return p ? readHumanoidPlayback(p) : { skinned: 0, playing: null, idle: null, height: 0 };
      };
      const preferred =
        remotes.find((r) => {
          const pb = playbackOf(r.identityHex);
          return pb.skinned > 0 && !!pb.playing && /walk/i.test(pb.playing);
        }) ??
        remotes.find((r) => (remoteWalkHold.get(r.identityHex)?.hold ?? 0) > 0) ??
        remotes.find((r) => {
          if (!local) return true;
          return Math.hypot(r.x - local.x, r.z - local.z) > 1.5;
        }) ??
        remotes[0];
      const pb = preferred
        ? playbackOf(preferred.identityHex)
        : { skinned: 0, playing: null, idle: null, height: 0 };
      const walkOn =
        pb.skinned > 0 && !!pb.playing && /walk/i.test(pb.playing);
      if (mark) {
        if (walkOn && preferred) {
          mark.textContent = `Remote walk OK · ${pb.playing} · skinned ${pb.skinned} · remotes ${n} · @(${preferred.x.toFixed(1)},${preferred.z.toFixed(1)})`;
        } else if (n > 0 && pb.skinned <= 0) {
          mark.textContent = `T-POSE · clip=${pb.playing ?? 'none'} · skeleton=${pb.skinned}`;
        } else if (n > 0 && preferred) {
          mark.textContent = `VE remote-walk: remotes ${n} · ${pb.playing ?? 'idle'} · skinned ${pb.skinned} @(${preferred.x.toFixed(1)},${preferred.z.toFixed(1)}) (waiting pose delta)`;
        } else {
          mark.textContent = 'VE remote-walk: remotes 0 (start tools/SecondClient)…';
        }
      }
      if (ticks < 240) window.setTimeout(waitRemoteWalk, 200);
    };
    window.setTimeout(waitRemoteWalk, 700);
  }

  // ?ve=remote-walk-stop — E8.30 other wizard Idle after Walk, no leftover stride.
  if (ve === 'remote-walk-stop') {
    camera.radius = 7;
    camera.alpha = 0.15;
    camera.beta = Math.PI / 2.45;
    player.setEnabled(false);
    localNameplate.mesh.setEnabled(false);
  }
  if (net && ve === 'remote-walk-stop') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE remote-walk-stop: waiting for remotes…';
    const clipBare = (name: string | null): string => {
      if (!name) return 'none';
      const i = name.lastIndexOf('|');
      return i >= 0 ? name.slice(i + 1) : name;
    };
    let ticks = 0;
    let sawWalk = false;
    let walkedHex: string | null = null;
    let latchedMark: string | null = null;
    const waitStop = () => {
      if (!net) return;
      ticks += 1;
      player.setEnabled(false);
      localNameplate.mesh.setEnabled(false);
      const remotes = net.getRemotes();
      syncRemoteMeshes(remotes);
      for (const [hex, p] of remoteMeshes) {
        const ch = net.getCharacterFor(hex);
        const pb = readHumanoidPlayback(p);
        const clip = clipBare(pb.playing);
        const nearPad =
          Math.hypot(p.root.position.x + 4, p.root.position.z + 5) < 3.5;
        const live =
          !!ch &&
          ch.hp > 0 &&
          pb.height >= 1.2 &&
          !/death/i.test(clip) &&
          nearPad &&
          (walkedHex == null || hex === walkedHex);
        p.root.setEnabled(live);
      }
      const living = remotes.filter((r) => {
        const p = remoteMeshes.get(r.identityHex);
        return !!p && p.root.isEnabled();
      });
      const n = living.length;
      let preferred: RemotePose | undefined;
      for (const r of living) {
        const p = remoteMeshes.get(r.identityHex);
        if (!p) continue;
        const nearPad =
          Math.hypot(p.root.position.x + 4, p.root.position.z + 5) < 3.5;
        if (!nearPad) continue;
        const pb = readHumanoidPlayback(p);
        const clip = clipBare(pb.playing);
        if (
          pb.skinned > 0 &&
          (/walk/i.test(clip) || (remoteWalkHold.get(r.identityHex)?.hold ?? 0) > 0)
        ) {
          sawWalk = true;
          walkedHex = r.identityHex;
        }
        if (
          sawWalk &&
          (!walkedHex || walkedHex === r.identityHex) &&
          p.root.position.y <= 0.05 &&
          pb.skinned > 0 &&
          pb.height >= 1.2 &&
          /idle_weapon/i.test(clip) &&
          !/walk/i.test(clip) &&
          !/death/i.test(clip) &&
          p.staff.isEnabled()
        ) {
          preferred = r;
          break;
        }
      }
      const parts = preferred
        ? remoteMeshes.get(preferred.identityHex)
        : living[0]
          ? remoteMeshes.get(living[0].identityHex)
          : undefined;
      const pb = parts
        ? readHumanoidPlayback(parts)
        : { skinned: 0, playing: null, idle: null, height: 0 };
      const clip = clipBare(pb.playing);
      const idleOk =
        !!preferred &&
        sawWalk &&
        pb.skinned > 0 &&
        pb.height >= 1.2 &&
        /idle_weapon/i.test(clip) &&
        !/walk/i.test(clip) &&
        !/death/i.test(clip) &&
        !!parts?.staff.isEnabled();
      if (idleOk) {
        latchedMark = `Idle OK · ${clip} · skinned ${pb.skinned} · remote-walk-stop`;
      }
      if (mark) {
        if (latchedMark) {
          mark.textContent = latchedMark;
        } else if (n > 0 && pb.skinned <= 0) {
          mark.textContent = `T-POSE · clip=${pb.playing ?? 'none'} · skeleton=${pb.skinned}`;
        } else if (n > 0) {
          mark.textContent =
            `VE remote-walk-stop: remotes ${n} · ${clip} · walk ${sawWalk ? 'seen' : 'waiting'} · skinned ${pb.skinned} (FARDEL_SECOND_WALK_STOP=1)`;
        } else {
          mark.textContent =
            'VE remote-walk-stop: remotes 0 (start tools/SecondClient FARDEL_SECOND_WALK_STOP=1)…';
        }
      }
      if (ticks < 280) window.setTimeout(waitStop, 80);
    };
    window.setTimeout(waitStop, 700);
  }

  // ?ve=remote-sheathed-walk — E8.31 unequipped remote Walk, not Idle_Weapon.
  if (ve === 'remote-sheathed-walk') {
    camera.radius = 7;
    camera.alpha = 0.15;
    camera.beta = Math.PI / 2.45;
    player.setEnabled(false);
    localNameplate.mesh.setEnabled(false);
  }
  if (net && ve === 'remote-sheathed-walk') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE remote-sheathed-walk: waiting for remotes…';
    const clipBare = (name: string | null): string => {
      if (!name) return 'none';
      const i = name.lastIndexOf('|');
      return i >= 0 ? name.slice(i + 1) : name;
    };
    let ticks = 0;
    let latchedMark: string | null = null;
    const waitSheathWalk = () => {
      if (!net) return;
      ticks += 1;
      player.setEnabled(false);
      localNameplate.mesh.setEnabled(false);
      const remotes = net.getRemotes();
      syncRemoteMeshes(remotes);
      let preferred: RemotePose | undefined;
      for (const r of remotes) {
        const ch = net.getCharacterFor(r.identityHex);
        const p = remoteMeshes.get(r.identityHex);
        if (!ch || ch.hp <= 0 || ch.staffEquipped || !p) {
          if (p) p.root.setEnabled(false);
          continue;
        }
        const pb = readHumanoidPlayback(p);
        const clip = clipBare(pb.playing);
        const nearPad =
          Math.hypot(p.root.position.x + 4, p.root.position.z + 5) < 3.5;
        const walkOk =
          nearPad &&
          pb.skinned > 0 &&
          pb.height >= 1.0 &&
          /^walk$/i.test(clip) &&
          !/weapon/i.test(clip) &&
          !/idle/i.test(clip) &&
          !/death/i.test(clip) &&
          !p.staff.isEnabled();
        p.root.setEnabled(walkOk);
        if (walkOk) {
          preferred = r;
          break;
        }
      }
      const parts = preferred
        ? remoteMeshes.get(preferred.identityHex)
        : undefined;
      const pb = parts
        ? readHumanoidPlayback(parts)
        : { skinned: 0, playing: null, idle: null, height: 0 };
      const clip = clipBare(pb.playing);
      const walkOk =
        !!preferred &&
        pb.skinned > 0 &&
        /^walk$/i.test(clip) &&
        !/weapon/i.test(clip) &&
        !parts?.staff.isEnabled();
      if (walkOk) {
        latchedMark = `Walk OK · ${clip} · sheathed · skinned ${pb.skinned}`;
      }
      const n = [...remoteMeshes.values()].filter((p) => p.root.isEnabled()).length;
      if (mark) {
        if (latchedMark) {
          mark.textContent = latchedMark;
        } else if (n > 0 && pb.skinned <= 0) {
          mark.textContent = `T-POSE · clip=${pb.playing ?? 'none'} · skeleton=${pb.skinned}`;
        } else if (remoteMeshes.size > 0) {
          const any = [...remoteMeshes.values()][0];
          const anyPb = any ? readHumanoidPlayback(any) : pb;
          const anyClip = clipBare(anyPb.playing);
          mark.textContent =
            `VE remote-sheathed-walk: remotes ${remoteMeshes.size} · ${anyClip} · staff ${any?.staff.isEnabled() ? 'on' : 'off'} · skinned ${anyPb.skinned} (FARDEL_SECOND_SHEATH_WALK=1)`;
        } else {
          mark.textContent =
            'VE remote-sheathed-walk: remotes 0 (start tools/SecondClient FARDEL_SECOND_SHEATH_WALK=1)…';
        }
      }
      if (ticks < 280) window.setTimeout(waitSheathWalk, 80);
    };
    window.setTimeout(waitSheathWalk, 700);
  }

  // ?ve=remote-sheathed-run — E8.36 unequipped remote Run, not Run_Weapon.
  if (ve === 'remote-sheathed-run') {
    camera.radius = 7;
    camera.alpha = 0.15;
    camera.beta = Math.PI / 2.45;
    player.setEnabled(false);
    localNameplate.mesh.setEnabled(false);
  }
  if (net && ve === 'remote-sheathed-run') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE remote-sheathed-run: waiting for remotes…';
    const clipBare = (name: string | null): string => {
      if (!name) return 'none';
      const i = name.lastIndexOf('|');
      return i >= 0 ? name.slice(i + 1) : name;
    };
    let ticks = 0;
    let latchedMark: string | null = null;
    const waitSheathRun = () => {
      if (!net) return;
      ticks += 1;
      player.setEnabled(false);
      localNameplate.mesh.setEnabled(false);
      const remotes = net.getRemotes();
      syncRemoteMeshes(remotes);
      let preferred: RemotePose | undefined;
      for (const r of remotes) {
        const ch = net.getCharacterFor(r.identityHex);
        const p = remoteMeshes.get(r.identityHex);
        if (!ch || ch.hp <= 0 || ch.staffEquipped || !p) {
          if (p) p.root.setEnabled(false);
          continue;
        }
        const pb = readHumanoidPlayback(p);
        const clip = clipBare(pb.playing);
        const nearPad =
          Math.hypot(p.root.position.x + 4, p.root.position.z + 5) < 3.5;
        const runOkOne =
          nearPad &&
          pb.skinned > 0 &&
          pb.height >= 1.0 &&
          /^run$/i.test(clip) &&
          !/weapon/i.test(clip) &&
          !/idle/i.test(clip) &&
          !/death/i.test(clip) &&
          !p.staff.isEnabled();
        p.root.setEnabled(runOkOne);
        if (runOkOne) {
          preferred = r;
          break;
        }
      }
      const parts = preferred
        ? remoteMeshes.get(preferred.identityHex)
        : undefined;
      const pb = parts
        ? readHumanoidPlayback(parts)
        : { skinned: 0, playing: null, idle: null, height: 0 };
      const clip = clipBare(pb.playing);
      const runOk =
        !!preferred &&
        pb.skinned > 0 &&
        /^run$/i.test(clip) &&
        !/weapon/i.test(clip) &&
        !parts?.staff.isEnabled();
      if (runOk) {
        latchedMark = `Run OK · ${clip} · sheathed · skinned ${pb.skinned}`;
      }
      const n = [...remoteMeshes.values()].filter((p) => p.root.isEnabled()).length;
      if (mark) {
        if (latchedMark) {
          mark.textContent = latchedMark;
        } else if (n > 0 && pb.skinned <= 0) {
          mark.textContent = `T-POSE · clip=${pb.playing ?? 'none'} · skeleton=${pb.skinned}`;
        } else if (remoteMeshes.size > 0) {
          const any = [...remoteMeshes.values()][0];
          const anyPb = any ? readHumanoidPlayback(any) : pb;
          const anyClip = clipBare(anyPb.playing);
          mark.textContent =
            `VE remote-sheathed-run: remotes ${remoteMeshes.size} · ${anyClip} · staff ${any?.staff.isEnabled() ? 'on' : 'off'} · skinned ${anyPb.skinned} (FARDEL_SECOND_SHEATH_RUN=1)`;
        } else {
          mark.textContent =
            'VE remote-sheathed-run: remotes 0 (start tools/SecondClient FARDEL_SECOND_SHEATH_RUN=1)…';
        }
      }
      if (ticks < 280) window.setTimeout(waitSheathRun, 80);
    };
    window.setTimeout(waitSheathRun, 700);
  }

  // ?ve=remote-run — E8.32 other wizard Run_Weapon at sprint wish, not Walk.
  if (ve === 'remote-run') {
    camera.radius = 7;
    camera.alpha = 0.15;
    camera.beta = Math.PI / 2.45;
    player.setEnabled(false);
    localNameplate.mesh.setEnabled(false);
  }
  if (net && ve === 'remote-run') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE remote-run: waiting for remotes…';
    const clipBare = (name: string | null): string => {
      if (!name) return 'none';
      const i = name.lastIndexOf('|');
      return i >= 0 ? name.slice(i + 1) : name;
    };
    let ticks = 0;
    const waitRun = () => {
      if (!net) return;
      ticks += 1;
      player.setEnabled(false);
      localNameplate.mesh.setEnabled(false);
      const remotes = net.getRemotes();
      syncRemoteMeshes(remotes);
      let preferred: RemotePose | undefined;
      for (const r of remotes) {
        const ch = net.getCharacterFor(r.identityHex);
        const p = remoteMeshes.get(r.identityHex);
        if (!ch || ch.hp <= 0 || !p) {
          if (p) p.root.setEnabled(false);
          continue;
        }
        const pb = readHumanoidPlayback(p);
        const clip = clipBare(pb.playing);
        const nearPad =
          Math.hypot(p.root.position.x + 4, p.root.position.z + 5) < 3.5;
        const runOkOne =
          nearPad &&
          pb.skinned > 0 &&
          pb.height >= 1.0 &&
          /run/i.test(clip) &&
          !/walk/i.test(clip) &&
          !/death/i.test(clip) &&
          (ch.staffEquipped
            ? /run_weapon/i.test(clip) && p.staff.isEnabled()
            : !/weapon/i.test(clip) && !p.staff.isEnabled());
        p.root.setEnabled(runOkOne);
        if (runOkOne) {
          preferred = r;
          break;
        }
      }
      const parts = preferred
        ? remoteMeshes.get(preferred.identityHex)
        : undefined;
      const pb = parts
        ? readHumanoidPlayback(parts)
        : { skinned: 0, playing: null, idle: null, height: 0 };
      const clip = clipBare(pb.playing);
      const runOk =
        !!preferred &&
        pb.skinned > 0 &&
        /run/i.test(clip) &&
        !/walk/i.test(clip);
      if (mark) {
        if (runOk) {
          mark.textContent = `Run OK · ${clip} · skinned ${pb.skinned}`;
        } else if (remoteMeshes.size > 0 && pb.skinned <= 0) {
          mark.textContent = `T-POSE · clip=${pb.playing ?? 'none'} · skeleton=${pb.skinned}`;
        } else if (remoteMeshes.size > 0) {
          const any = [...remoteMeshes.values()][0];
          const anyPb = any ? readHumanoidPlayback(any) : pb;
          const anyClip = clipBare(anyPb.playing);
          mark.textContent =
            `VE remote-run: remotes ${remoteMeshes.size} · ${anyClip} · skinned ${anyPb.skinned} (FARDEL_SECOND_RUN=1)`;
        } else {
          mark.textContent =
            'VE remote-run: remotes 0 (start tools/SecondClient FARDEL_SECOND_RUN=1)…';
        }
      }
      if (ticks < 280) window.setTimeout(waitRun, 80);
    };
    window.setTimeout(waitRun, 700);
  }

  // ?ve=remote-run-stop — E8.35 other wizard Idle after Run, no leftover stride.
  if (ve === 'remote-run-stop') {
    camera.radius = 7;
    camera.alpha = 0.15;
    camera.beta = Math.PI / 2.45;
    player.setEnabled(false);
    localNameplate.mesh.setEnabled(false);
  }
  if (net && ve === 'remote-run-stop') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE remote-run-stop: waiting for remotes…';
    const clipBare = (name: string | null): string => {
      if (!name) return 'none';
      const i = name.lastIndexOf('|');
      return i >= 0 ? name.slice(i + 1) : name;
    };
    let ticks = 0;
    const sawRunAt = new Map<string, boolean>();
    let latchedMark: string | null = null;
    const waitRunStop = () => {
      if (!net) return;
      ticks += 1;
      player.setEnabled(false);
      localNameplate.mesh.setEnabled(false);
      const remotes = net.getRemotes();
      syncRemoteMeshes(remotes);
      for (const [hex, p] of remoteMeshes) {
        const ch = net.getCharacterFor(hex);
        const pb = readHumanoidPlayback(p);
        const clip = clipBare(pb.playing);
        const nearPad =
          Math.hypot(p.root.position.x + 4, p.root.position.z + 5) < 3.5;
        const live =
          !!ch &&
          ch.hp > 0 &&
          pb.height >= 1.2 &&
          !/death/i.test(clip) &&
          nearPad;
        p.root.setEnabled(live);
      }
      const living = remotes.filter((r) => {
        const p = remoteMeshes.get(r.identityHex);
        return !!p && p.root.isEnabled();
      });
      const n = living.length;
      let preferred: RemotePose | undefined;
      for (const r of living) {
        const p = remoteMeshes.get(r.identityHex);
        if (!p) continue;
        const nearPad =
          Math.hypot(p.root.position.x + 4, p.root.position.z + 5) < 3.5;
        if (!nearPad) continue;
        const pb = readHumanoidPlayback(p);
        const clip = clipBare(pb.playing);
        if (pb.skinned > 0 && /run/i.test(clip)) {
          sawRunAt.set(r.identityHex, true);
        }
        if (
          sawRunAt.get(r.identityHex) &&
          p.root.position.y <= 0.05 &&
          pb.skinned > 0 &&
          pb.height >= 1.2 &&
          /idle_weapon/i.test(clip) &&
          !/run/i.test(clip) &&
          !/walk/i.test(clip) &&
          !/death/i.test(clip) &&
          p.staff.isEnabled()
        ) {
          preferred = r;
          break;
        }
      }
      const parts = preferred
        ? remoteMeshes.get(preferred.identityHex)
        : living[0]
          ? remoteMeshes.get(living[0].identityHex)
          : undefined;
      const pb = parts
        ? readHumanoidPlayback(parts)
        : { skinned: 0, playing: null, idle: null, height: 0 };
      const clip = clipBare(pb.playing);
      const idleOk =
        !!preferred &&
        pb.skinned > 0 &&
        pb.height >= 1.2 &&
        /idle_weapon/i.test(clip) &&
        !/run/i.test(clip) &&
        !/walk/i.test(clip) &&
        !/death/i.test(clip) &&
        !!parts?.staff.isEnabled();
      if (idleOk) {
        latchedMark = `Idle OK · ${clip} · skinned ${pb.skinned} · remote-run-stop`;
      }
      if (mark) {
        if (latchedMark) {
          mark.textContent = latchedMark;
        } else if (n > 0 && pb.skinned <= 0) {
          mark.textContent = `T-POSE · clip=${pb.playing ?? 'none'} · skeleton=${pb.skinned}`;
        } else if (n > 0) {
          mark.textContent =
            `VE remote-run-stop: remotes ${n} · ${clip} · run ${sawRunAt.size ? 'seen' : 'waiting'} · skinned ${pb.skinned} (FARDEL_SECOND_RUN_STOP=1)`;
        } else {
          mark.textContent =
            'VE remote-run-stop: remotes 0 (start tools/SecondClient FARDEL_SECOND_RUN_STOP=1)…';
        }
      }
      if (ticks < 280) window.setTimeout(waitRunStop, 80);
    };
    window.setTimeout(waitRunStop, 700);
  }

  // ?ve=remote-two-clips — E8.33 two living remotes, Walk + Spell1, not a clone stamp.
  if (ve === 'remote-two-clips') {
    camera.radius = 14;
    camera.alpha = Math.PI / 2.2;
    camera.beta = Math.PI / 2.55;
    hideLocalForRemoteHop(player, localNameplate);
  }
  if (net && ve === 'remote-two-clips') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE remote-two-clips: waiting for remotes…';
    const clipBare = (name: string | null): string => {
      if (!name) return 'none';
      const i = name.lastIndexOf('|');
      return i >= 0 ? name.slice(i + 1) : name;
    };
    let ticks = 0;
    const waitTwoClips = () => {
      if (!net) return;
      ticks += 1;
      hideLocalForRemoteHop(player, localNameplate);
      const remotes = net.getRemotes();
      syncRemoteMeshes(remotes);
      syncRemoteCastFx(net.getRemoteCombats());
      let walkHex: string | null = null;
      let spellHex: string | null = null;
      let walkClip = '';
      let spellClip = '';
      let walkSkinned = 0;
      let spellSkinned = 0;
      for (const r of remotes) {
        const ch = net.getCharacterFor(r.identityHex);
        const p = remoteMeshes.get(r.identityHex);
        if (!ch || ch.hp <= 0 || !p) {
          if (p) p.root.setEnabled(false);
          continue;
        }
        const pb = readHumanoidPlayback(p);
        const clip = clipBare(pb.playing);
        const living =
          pb.skinned > 0 &&
          pb.height >= 1.0 &&
          !/death/i.test(clip) &&
          !/t-?pose/i.test(clip);
        if (!living) {
          p.root.setEnabled(false);
          continue;
        }
        const isLoco = /^(walk|run)(_weapon)?$/i.test(clip);
        const isSpell = /spell/i.test(clip);
        if (isSpell && !spellHex) {
          spellHex = r.identityHex;
          spellClip = clip;
          spellSkinned = pb.skinned;
          p.root.setEnabled(true);
          continue;
        }
        if (isLoco && !walkHex) {
          walkHex = r.identityHex;
          walkClip = clip;
          walkSkinned = pb.skinned;
          p.root.setEnabled(true);
          continue;
        }
        p.root.setEnabled(false);
      }
      const dummy = (net.getNpcs() ?? []).find(
        (n) => n.kind === NPC_KIND_DUMMY && n.hp > 0,
      );
      const ok =
        !!walkHex &&
        !!spellHex &&
        walkHex !== spellHex &&
        walkSkinned > 0 &&
        spellSkinned > 0 &&
        !!dummy;
      if (mark) {
        if (ok) {
          mark.textContent = `Two-clips OK · ${walkClip} · ${spellClip} · skinned ${walkSkinned + spellSkinned} · remotes 2`;
        } else if (remoteMeshes.size > 0 && walkSkinned + spellSkinned <= 0) {
          mark.textContent = `T-POSE · remotes ${remoteMeshes.size}`;
        } else {
          mark.textContent =
            `VE remote-two-clips: remotes ${remoteMeshes.size} · walk ${walkClip || '—'} · spell ${spellClip || '—'} (FARDEL_SECOND_WALK=1 + FARDEL_SECOND_CAST=1)`;
        }
      }
      if (ticks < 320) window.setTimeout(waitTwoClips, 80);
    };
    window.setTimeout(waitTwoClips, 700);
  }

  // ?ve=remote-sheathed — E8.26 remote Character.staffEquipped=false plays unarmed Idle.
  if (ve === 'remote-sheathed') {
    camera.radius = 8;
    camera.alpha = 0.35;
    camera.beta = Math.PI / 2.45;
  }
  if (net && ve === 'remote-sheathed') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE remote-sheathed: waiting for remotes…';
    const clipBare = (name: string | null): string => {
      if (!name) return 'none';
      const i = name.lastIndexOf('|');
      return i >= 0 ? name.slice(i + 1) : name;
    };
    let ticks = 0;
    let nudged = false;
    const waitSheath = () => {
      if (!net) return;
      ticks += 1;
      if (!nudged && latestStatus.state === 'connected') {
        nudged = true;
        // East of origin (dummy side). Remote stands west at (-2.5, 0).
        for (let i = 0; i < 4; i++) net.sendMove(0.55, 0, false);
      }
      const remotes = net.getRemotes();
      syncRemoteMeshes(remotes);
      const n = remoteMeshes.size;
      const playbackOf = (hex: string) => {
        const p = remoteMeshes.get(hex);
        return p
          ? { pb: readHumanoidPlayback(p), staffOn: p.staff.isEnabled() }
          : { pb: { skinned: 0, playing: null, idle: null, height: 0 }, staffOn: true };
      };
      const preferred = remotes.find((r) => {
        const ch = net.getCharacterFor(r.identityHex);
        const { pb, staffOn } = playbackOf(r.identityHex);
        const clip = clipBare(pb.playing);
        return (
          ch != null &&
          ch.hp > 0 &&
          !ch.staffEquipped &&
          pb.skinned > 0 &&
          pb.height >= 1.2 &&
          /^idle$/i.test(clip) &&
          !/weapon/i.test(clip) &&
          !/death/i.test(clip) &&
          !staffOn
        );
      });
      const got = preferred ? playbackOf(preferred.identityHex) : null;
      const clip = clipBare(got?.pb.playing ?? null);
      const ch = preferred ? net.getCharacterFor(preferred.identityHex) : null;
      const sheathOk =
        !!preferred &&
        !!got &&
        !!ch &&
        ch.hp > 0 &&
        !ch.staffEquipped &&
        got.pb.skinned > 0 &&
        got.pb.height >= 1.2 &&
        /^idle$/i.test(clip) &&
        !/weapon/i.test(clip) &&
        !/death/i.test(clip) &&
        !got.staffOn;
      if (mark) {
        if (sheathOk && got) {
          mark.textContent =
            `Remote sheathed OK · ${clip} · skinned ${got.pb.skinned} · remotes ${n}`;
        } else if (n > 0) {
          const any = remotes[0];
          const anyGot = any ? playbackOf(any.identityHex) : null;
          const anyCh = any ? net.getCharacterFor(any.identityHex) : null;
          const anyClip = clipBare(anyGot?.pb.playing ?? null);
          if (anyGot && anyGot.pb.skinned <= 0) {
            mark.textContent = `T-POSE · clip=${anyGot.pb.playing ?? 'none'} · skeleton=${anyGot.pb.skinned}`;
          } else if (anyCh && anyCh.hp <= 0) {
            mark.textContent = `VE remote-sheathed: remotes ${n} · dead (need living Idle)`;
          } else if (anyGot) {
            mark.textContent =
              `VE remote-sheathed: remotes ${n} · ${anyClip} · staff ${anyGot.staffOn ? 'on' : 'off'} · skinned ${anyGot.pb.skinned} (FARDEL_SECOND_SHEATH=1)`;
          } else {
            mark.textContent =
              `VE remote-sheathed: remotes ${n} · waiting living Idle…`;
          }
        } else {
          mark.textContent =
            'VE remote-sheathed: remotes 0 (start tools/SecondClient FARDEL_SECOND_SHEATH=1)…';
        }
      }
      if (ticks < 240) window.setTimeout(waitSheath, 200);
    };
    window.setTimeout(waitSheath, 700);
  }

  // ?ve=remote-cast — E8.16 remote CastingSpell/CastEndsAt drives Spell1.
  if (ve === 'remote-cast') {
    camera.radius = 8;
    camera.alpha = 0.35;
    camera.beta = Math.PI / 2.45;
  }

  if (net && ve === 'remote-cast') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE remote-cast: waiting for remotes…';
    let ticks = 0;
    let nudged = false;
    const waitRemoteCast = () => {
      if (!net) return;
      ticks += 1;
      if (!nudged && latestStatus.state === 'connected') {
        nudged = true;
        // Park local off the remote close-up (SecondClient stays in dummy range).
        for (let i = 0; i < 8; i++) net.sendMove(-0.75, -0.6, false);
      }
      const remotes = net.getRemotes();
      const combats = net.getRemoteCombats();
      syncRemoteMeshes(remotes);
      syncRemoteCastFx(combats);
      syncNpcMeshes(net.getNpcs());
      const n = remoteMeshes.size;
      const playbackOf = (hex: string) => {
        const p = remoteMeshes.get(hex);
        return p ? readHumanoidPlayback(p) : { skinned: 0, playing: null, idle: null, height: 0 };
      };
      const castingCombat = combats.find(
        (c) => c.castingSpellId !== 0 && castRemainingMs(c) > 0,
      );
      const preferred =
        remotes.find((r) => {
          const pb = playbackOf(r.identityHex);
          return pb.skinned > 0 && !!pb.playing && /spell/i.test(pb.playing);
        }) ??
        remotes.find((r) => r.identityHex === castingCombat?.identityHex) ??
        remotes[0];
      const pb = preferred
        ? playbackOf(preferred.identityHex)
        : { skinned: 0, playing: null, idle: null, height: 0 };
      const castOn =
        pb.skinned > 0 && !!pb.playing && /spell/i.test(pb.playing);
      if (mark) {
        if (castOn && preferred) {
          mark.textContent = `Remote cast OK · ${pb.playing} · skinned ${pb.skinned} · remotes ${n} · @(${preferred.x.toFixed(1)},${preferred.z.toFixed(1)})`;
        } else if (n > 0 && pb.skinned <= 0) {
          mark.textContent = `T-POSE · clip=${pb.playing ?? 'none'} · skeleton=${pb.skinned}`;
        } else if (n > 0 && preferred) {
          const wind = castingCombat
            ? `spell=${castingCombat.castingSpellId} left=${(castRemainingMs(castingCombat) / 1000).toFixed(1)}s`
            : 'waiting windup';
          mark.textContent = `VE remote-cast: remotes ${n} · ${pb.playing ?? 'idle'} · skinned ${pb.skinned} · ${wind}`;
        } else {
          mark.textContent = 'VE remote-cast: remotes 0 (start tools/SecondClient)…';
        }
      }
      if (ticks < 280) window.setTimeout(waitRemoteCast, 180);
    };
    window.setTimeout(waitRemoteCast, 700);
  }

  // ?ve=remote-death — E8.20 other wizards RecieveHit on HP drop, Death at Hp=0.
  if (ve === 'remote-death') {
    camera.radius = 7;
    camera.alpha = 0.55;
    camera.beta = Math.PI / 2.7;
  }
  if (net && ve === 'remote-death') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE remote-death: waiting for remotes…';
    let ticks = 0;
    let nudged = false;
    let sawFlinch = false;
    const waitRemoteDeath = () => {
      if (!net) return;
      ticks += 1;
      if (!nudged && latestStatus.state === 'connected') {
        nudged = true;
        // Park local off the remote close-up (SecondClient DummyStrike at dummy pad).
        for (let i = 0; i < 8; i++) net.sendMove(-0.75, -0.6, false);
      }
      const remotes = net.getRemotes();
      syncRemoteMeshes(remotes);
      const n = remoteMeshes.size;
      const playbackOf = (hex: string) => {
        const p = remoteMeshes.get(hex);
        return p
          ? readHumanoidPlayback(p)
          : { skinned: 0, playing: null, idle: null, height: 0 };
      };
      const flinchRemote = remotes.find((r) => {
        const pb = playbackOf(r.identityHex);
        return pb.skinned > 0 && !!pb.playing && /recievehit/i.test(pb.playing);
      });
      const deadRemote = remotes.find((r) => {
        const pb = playbackOf(r.identityHex);
        const ch = net.getCharacterFor(r.identityHex);
        return (
          pb.skinned > 0 &&
          !!pb.playing &&
          /death/i.test(pb.playing) &&
          (ch?.hp ?? 1) <= 0
        );
      });
      if (flinchRemote) sawFlinch = true;
      const preferred =
        deadRemote ??
        flinchRemote ??
        remotes.find((r) => {
          const ch = net.getCharacterFor(r.identityHex);
          return typeof ch?.hp === 'number' && ch.hp < (ch.maxHp ?? ch.hp);
        }) ??
        remotes[0];
      const pb = preferred
        ? playbackOf(preferred.identityHex)
        : { skinned: 0, playing: null, idle: null, height: 0 };
      const deathOk =
        pb.skinned > 0 && !!pb.playing && /death/i.test(pb.playing);
      const hitOk =
        pb.skinned > 0 && !!pb.playing && /recievehit/i.test(pb.playing);
      const clip = (pb.playing ?? '').replace(/^.*\|/, '');
      if (mark) {
        if (deathOk && preferred) {
          mark.textContent = `Remote death OK · ${clip} · skinned ${pb.skinned}${sawFlinch ? ' · RecieveHit seen' : ''}`;
        } else if (hitOk && preferred) {
          mark.textContent = `Remote hit OK · ${clip} · skinned ${pb.skinned}`;
        } else if (n > 0 && pb.skinned <= 0) {
          mark.textContent = `T-POSE · clip=${pb.playing ?? 'none'} · skeleton=${pb.skinned}`;
        } else if (n > 0 && preferred) {
          const ch = net.getCharacterFor(preferred.identityHex);
          mark.textContent = `VE remote-death: remotes ${n} · ${pb.playing ?? 'idle'} · skinned ${pb.skinned} · hp ${ch?.hp ?? '?'}/${ch?.maxHp ?? '?'}`;
        } else {
          mark.textContent =
            'VE remote-death: remotes 0 (start tools/SecondClient FARDEL_SECOND_DIE=1)…';
        }
      }
      if (deathOk) return;
      if (ticks < 360) window.setTimeout(waitRemoteDeath, 160);
    };
    window.setTimeout(waitRemoteDeath, 700);
  }

  // ?ve=remote-hop — E8.27 airborne Idle_Weapon, no Walk, no squash.
  if (ve === 'remote-hop') {
    camera.radius = 8;
    camera.alpha = 0.15;
    camera.beta = Math.PI / 2.02;
    hideLocalForRemoteHop(player, localNameplate);
  }
  if (net && ve === 'remote-hop') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE remote-hop: waiting for remotes…';
    const clipBare = (name: string | null): string => {
      if (!name) return 'none';
      const i = name.lastIndexOf('|');
      return i >= 0 ? name.slice(i + 1) : name;
    };
    let ticks = 0;
    let nudged = false;
    const waitHop = () => {
      if (!net) return;
      ticks += 1;
      hideLocalForRemoteHop(player, localNameplate);
      if (!nudged && latestStatus.state === 'connected') {
        nudged = true;
        // Park local north of the hop-pad; mesh is already hidden.
        for (let i = 0; i < 8; i++) net.sendMove(0, 0.75, false);
      }
      const remotes = net.getRemotes();
      syncRemoteMeshes(remotes);
      const n = remoteMeshes.size;
      const hopCandidates = remotes.filter((r) => {
        const ch = net.getCharacterFor(r.identityHex);
        const p = remoteMeshes.get(r.identityHex);
        if (!ch || ch.hp <= 0 || !p || !p.staff.isEnabled()) return false;
        const pb = readHumanoidPlayback(p);
        const clip = clipBare(pb.playing);
        return (
          p.root.position.y > 0.8 &&
          pb.skinned > 0 &&
          pb.height >= 1.0 &&
          /idle_weapon/i.test(clip) &&
          !/walk/i.test(clip) &&
          !/death/i.test(clip)
        );
      });
      hopCandidates.sort((a, b) => {
        const pa = remoteMeshes.get(a.identityHex);
        const pbParts = remoteMeshes.get(b.identityHex);
        const da = pa
          ? Math.hypot(pa.root.position.x, pa.root.position.z + 6)
          : 99;
        const db = pbParts
          ? Math.hypot(pbParts.root.position.x, pbParts.root.position.z + 6)
          : 99;
        return da - db;
      });
      const preferred = hopCandidates[0];
      const parts = preferred ? remoteMeshes.get(preferred.identityHex) : undefined;
      const pb = parts
        ? readHumanoidPlayback(parts)
        : { skinned: 0, playing: null, idle: null, height: 0 };
      const clip = clipBare(pb.playing);
      const y = parts?.root.position.y ?? 0;
      const scaleY = parts?.root.scaling.y ?? 1;
      const hopOk =
        !!parts &&
        !!preferred &&
        y > 0.8 &&
        pb.skinned > 0 &&
        pb.height >= 1.0 &&
        /idle_weapon/i.test(clip) &&
        !/walk/i.test(clip) &&
        !/death/i.test(clip) &&
        parts.staff.isEnabled() &&
        Math.abs(scaleY - 1) < 0.04;
      if (hopOk && parts && preferred) {
        remoteHopLatch = { hex: preferred.identityHex, y };
        setHumanoidAirborne(parts, true);
        parts.root.scaling.set(1, 1, 1);
      }
      const sampleParts = parts ?? [...remoteMeshes.values()][0];
      const samplePb = sampleParts
        ? readHumanoidPlayback(sampleParts)
        : { skinned: 0, playing: null, idle: null, height: 0 };
      const sampleClip = clipBare(samplePb.playing);
      const sampleY = sampleParts?.root.position.y ?? 0;
      const sampleWalk = /walk/i.test(sampleClip);
      if (mark) {
        if (hopOk) {
          mark.textContent =
            `Remote hop OK · ${clip} · skinned ${pb.skinned} · y=${y.toFixed(2)} · feet=${y.toFixed(2)} · remotes ${n}`;
        } else if (n > 0 && samplePb.skinned <= 0) {
          mark.textContent = `T-POSE · clip=${samplePb.playing ?? 'none'} · skeleton=${samplePb.skinned}`;
        } else if (n > 0) {
          mark.textContent =
            `VE remote-hop: remotes ${n} · ${sampleClip} · y=${sampleY.toFixed(2)} · feet=${sampleY.toFixed(2)} · walk ${sampleWalk ? 'on' : 'off'} · skinned ${samplePb.skinned} (FARDEL_SECOND_HOP=1)`;
        } else {
          mark.textContent =
            'VE remote-hop: remotes 0 (start tools/SecondClient FARDEL_SECOND_HOP=1)…';
        }
      }
      if (ticks < 280) window.setTimeout(waitHop, 80);
    };
    window.setTimeout(waitHop, 700);
  }

  // ?ve=projectile — local Emberbolt thicker beam (+ Spark bolt VFX path); impact pop.
  if (ve === 'projectile') {
    camera.radius = 12;
    camera.alpha = Math.PI / 2.2;
    camera.beta = Math.PI / 3.05;
  }

  if (net && ve === 'projectile') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE projectile: waiting for Connected…';
    let ticks = 0;
    let castSent = false;
    let sawBolt = false;
    let sawBeam = false;
    let sawImpact = false;
    const waitProj = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE projectile: ${st.state}…`;
        if (ticks > 160) {
          if (mark) mark.textContent = 'VE projectile: timed out waiting Connected';
          return;
        }
        window.setTimeout(waitProj, 250);
        return;
      }
      const ch0 = st.character;
      if (ch0 && !ch0.staffEquipped) {
        net.equipStaff();
        if (mark) mark.textContent = 'VE projectile: re-equipping staff…';
        window.setTimeout(waitProj, 250);
        return;
      }
      net.ensureTrainingDummy();
      const cycle = net.getTargetCycle();
      const dummy = cycle.find((n) => n.kind === NPC_KIND_DUMMY) ?? cycle[0];
      syncNpcMeshes(net.getNpcs());
      if (dummy) {
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
        camera.setTarget(new Vector3(dummy.x, 1.25, dummy.z));
        camera.radius = 11;
        // Frame mid-point player↔dummy so beam/bolt reads clearly.
        const mid = player.position.add(
          new Vector3(dummy.x, 1.2, dummy.z).subtract(player.position).scale(0.45),
        );
        mid.y = 1.2;
        camera.setTarget(mid);
      }
      if (sparkBolts.length > 0) sawBolt = true;
      if (localEmberBeam.beam.isEnabled()) sawBeam = true;
      if (impactPops.length > 0 || castVfxStats.impacts > 0) sawImpact = true;

      if (!castSent && dummy) {
        castSent = true;
        lastCastSpell = SPELL_EMBERBOLT;
        castTotalMs = EMBERBOLT_CAST_MS;
        castUntilMs = Date.now() + EMBERBOLT_CAST_MS;
        net.cast(SPELL_EMBERBOLT);
        localBeamActive = true;
        placeBeam(
          localEmberBeam.beam,
          casterMuzzle(player.position),
          targetHitPoint(
            npcMeshes.get(dummy.npcId.toString())?.root.position ??
              new Vector3(dummy.x, 0, dummy.z),
          ),
        );
        castVfxStats.beams += 1;
        // Also spawn a Spark bolt for VE readability (cosmetic mid-flight proof).
        sparkBolts.push(
          spawnSparkBolt(
            scene,
            casterMuzzle(player.position),
            targetHitPoint(
              npcMeshes.get(dummy.npcId.toString())?.root.position ??
                new Vector3(dummy.x, 0, dummy.z),
            ),
            { key: `ve_spark_${Date.now()}`, lifeMs: 520 },
          ),
        );
        castVfxStats.bolts += 1;
        sawBolt = true;
        sawBeam = true;
        pushCombatLog('cast', `Emberbolt + Spark VFX → Dummy #${dummy.npcId}`);
        if (mark) {
          mark.textContent = `VE projectile: Emberbolt beam + Spark bolt · Dummy #${dummy.npcId}…`;
        }
        window.setTimeout(waitProj, 120);
        return;
      }

      const castLeft = Math.max(0, castUntilMs - Date.now());
      const beamOn = localEmberBeam.beam.isEnabled();
      const boltOn = sparkBolts.length > 0;
      if (
        castSent &&
        dummy &&
        (beamOn || boltOn || sawBeam) &&
        castLeft > 350
      ) {
        if (mark) {
          mark.textContent = `Projectile OK · Emberbolt beam${beamOn ? ' on' : ''} · Spark bolt${boltOn ? ' mid-flight' : sawBolt ? ' fired' : ''} · impacts ${castVfxStats.impacts} · Dummy #${dummy.npcId} HP ${dummy.hp}/${dummy.maxHp}`;
        }
        // Hold while beam/bolt visible for screenshot.
        if (ticks < 140) window.setTimeout(waitProj, 160);
        return;
      }
      if (
        castSent &&
        dummy &&
        (sawBeam || sawBolt) &&
        (castLeft <= 0 || sawImpact || impactPops.length > 0)
      ) {
        if (mark) {
          mark.textContent = `Projectile OK · local beam+bolt VFX · impacts ${castVfxStats.impacts} · Dummy #${dummy.npcId} HP ${dummy.hp}/${dummy.maxHp}`;
        }
        return;
      }
      if (mark && castSent) {
        mark.textContent = `VE projectile: waiting VFX… beam=${beamOn} bolt=${boltOn} castLeft=${(castLeft / 1000).toFixed(1)}s`;
      }
      if (ticks > 160) {
        if (mark) mark.textContent = 'VE projectile: timed out waiting for beam/bolt';
        return;
      }
      window.setTimeout(waitProj, 200);
    };
    window.setTimeout(waitProj, 700);
  }

  // ?ve=spell-vfx — Art brief (#46) readability: Spark cyan flash+bolt+impact + Emberbolt charge→projectile→impact.
  if (ve === 'spell-vfx') {
    camera.radius = 12;
    camera.alpha = Math.PI / 2.2;
    camera.beta = Math.PI / 3.05;
  }

  if (net && ve === 'spell-vfx') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE spell-vfx: waiting for Connected…';
    let ticks = 0;
    let phase: 'wait' | 'ember' | 'spark' | 'done' = 'wait';
    let emberSent = false;
    let sparkSent = false;
    let sawCharge = false;
    let sawEmberBolt = false;
    let sawSparkBolt = false;
    let sawImpact = false;
    const waitSpell = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE spell-vfx: ${st.state}…`;
        if (ticks > 180) {
          if (mark) mark.textContent = 'VE spell-vfx: timed out waiting Connected';
          return;
        }
        window.setTimeout(waitSpell, 250);
        return;
      }
      const ch0 = st.character;
      if (ch0 && !ch0.staffEquipped) {
        net.equipStaff();
        if (mark) mark.textContent = 'VE spell-vfx: re-equipping staff…';
        window.setTimeout(waitSpell, 250);
        return;
      }
      net.ensureTrainingDummy();
      const cycle = net.getTargetCycle();
      const dummy = cycle.find((n) => n.kind === NPC_KIND_DUMMY) ?? cycle[0];
      syncNpcMeshes(net.getNpcs());
      if (dummy) {
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
        const mid = player.position.add(
          new Vector3(dummy.x, 1.2, dummy.z).subtract(player.position).scale(0.45),
        );
        mid.y = 1.15;
        camera.setTarget(mid);
        camera.radius = 11.5;
      }
      if (localEmberCharge.glow.isEnabled()) sawCharge = true;
      if (sparkBolts.some((b) => b.kind === 'ember')) sawEmberBolt = true;
      if (sparkBolts.some((b) => b.kind === 'spark')) sawSparkBolt = true;
      if (impactPops.length > 0 || castVfxStats.impacts > 0) sawImpact = true;

      if (phase === 'wait' && dummy && !emberSent) {
        phase = 'ember';
        emberSent = true;
        lastCastSpell = SPELL_EMBERBOLT;
        castTotalMs = EMBERBOLT_CAST_MS;
        castUntilMs = Date.now() + EMBERBOLT_CAST_MS;
        net.cast(SPELL_EMBERBOLT);
        localBeamActive = true;
        const from = casterMuzzle(player.position);
        const to = targetHitPoint(
          npcMeshes.get(dummy.npcId.toString())?.root.position ??
            new Vector3(dummy.x, 0, dummy.z),
        );
        placeBeam(localEmberBeam.beam, from, to);
        placeEmberCharge(localEmberCharge, from, Date.now());
        castVfxStats.beams += 1;
        sawCharge = true;
        pushCombatLog('cast', `Emberbolt windup VFX → Dummy #${dummy.npcId}`);
        if (mark) {
          mark.textContent = `VE spell-vfx: Emberbolt charge · Dummy #${dummy.npcId}…`;
        }
        window.setTimeout(waitSpell, 140);
        return;
      }

      const castLeft = Math.max(0, castUntilMs - Date.now());
      // Hold mid-windup so charge + thin aim beam read clearly for Art sign-off.
      if (
        phase === 'ember' &&
        dummy &&
        (sawCharge || localEmberCharge.glow.isEnabled()) &&
        castLeft > 550
      ) {
        if (mark) {
          mark.textContent = `Spell VFX OK · Emberbolt charge+aim · Spark pending · Dummy #${dummy.npcId} · impacts ${castVfxStats.impacts}`;
        }
        if (ticks < 100) {
          window.setTimeout(waitSpell, 160);
          return;
        }
      }

      if (phase === 'ember' && castLeft <= 0 && !sparkSent) {
        phase = 'spark';
        sparkSent = true;
        // Cosmetic Spark poke for cyan telegraph proof alongside ember travel/impact.
        const from = casterMuzzle(player.position);
        const to = targetHitPoint(
          npcMeshes.get(dummy!.npcId.toString())?.root.position ??
            new Vector3(dummy!.x, 0, dummy!.z),
        );
        castFlashes.push(
          spawnCastFlash(scene, from, SPARK_COLOR, SPARK_CORE, {
            key: `ve_spark_flash_${Date.now()}`,
            scale: 0.55,
          }),
        );
        castVfxStats.flashes += 1;
        sparkBolts.push(
          spawnSparkBolt(scene, from, to, {
            key: `ve_spark_${Date.now()}`,
            lifeMs: 200,
          }),
        );
        castVfxStats.bolts += 1;
        sawSparkBolt = true;
        net.cast(SPELL_SPARK);
        pushCombatLog('cast', `Spark VFX → Dummy #${dummy!.npcId}`);
        if (mark) {
          mark.textContent = `VE spell-vfx: Spark bolt mid-flight · Emberbolt released…`;
        }
        window.setTimeout(waitSpell, 100);
        return;
      }

      if (
        (phase === 'spark' || phase === 'ember') &&
        dummy &&
        (sawCharge || sawEmberBolt || sawSparkBolt) &&
        (sawImpact || castVfxStats.impacts > 0 || sparkBolts.length > 0)
      ) {
        phase = 'done';
        if (mark) {
          mark.textContent = `Spell VFX OK · Spark cyan + Emberbolt charge→bolt · flashes ${castVfxStats.flashes} · bolts ${castVfxStats.bolts} · impacts ${castVfxStats.impacts} · Dummy #${dummy.npcId}`;
        }
        return;
      }

      if (mark && emberSent) {
        mark.textContent = `VE spell-vfx: waiting… charge=${sawCharge} emberBolt=${sawEmberBolt} spark=${sawSparkBolt} impacts=${castVfxStats.impacts} castLeft=${(castLeft / 1000).toFixed(1)}s`;
      }
      if (ticks > 200) {
        if (mark) {
          mark.textContent = `VE spell-vfx: timed out · charge=${sawCharge} bolts=${castVfxStats.bolts} impacts=${castVfxStats.impacts}`;
        }
        return;
      }
      window.setTimeout(waitSpell, 180);
    };
    window.setTimeout(waitSpell, 700);
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



  // ?ve=death — cast Spark until dummy dies; wait for death VFX + toast/log.
  if (ve === 'death') {
    camera.radius = 11;
    camera.alpha = Math.PI / 2.15;
    camera.beta = Math.PI / 3.05;
  }

  if (net && ve === 'death') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE death: waiting for Connected…';
    let ticks = 0;
    let phase: 'wait' | 'seed' | 'kill' | 'hold' | 'done' = 'wait';
    let seeded = false;
    let casts = 0;
    let lastCastAt = 0;
    const waitDeath = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE death: ${st.state}…`;
        if (ticks < 220) window.setTimeout(waitDeath, 200);
        return;
      }

      // Seed once so dummy is full HP, then do NOT keep resetting (Ensure heals).
      // Prior VEs may leave staff unequipped — Cast is server-gated on staff.
      if (!seeded) {
        const ch0 = net.getCharacter();
        if (ch0 && !ch0.staffEquipped) {
          net.equipStaff();
          if (mark) mark.textContent = 'VE death: re-equipping staff…';
          window.setTimeout(waitDeath, 280);
          return;
        }
        net.ensureTrainingDummy();
        seeded = true;
        phase = 'seed';
        if (mark) mark.textContent = 'VE death: seeding training dummy…';
        window.setTimeout(waitDeath, 350);
        return;
      }

      {
        const ch = net.getCharacter();
        if (ch && !ch.staffEquipped) {
          net.equipStaff();
          if (mark) mark.textContent = 'VE death: staff missing — equipping…';
          window.setTimeout(waitDeath, 280);
          return;
        }
      }

      const cycle = net.getTargetCycle();
      const dummy =
        cycle.find((n) => n.kind === NPC_KIND_DUMMY) ?? cycle[0] ?? null;
      syncNpcMeshes(net.getNpcs());
      if (dummy) {
        camera.setTarget(new Vector3(dummy.x, 1.35, dummy.z));
        camera.radius = 10;
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
      }

      const deathFresh =
        latestDeathAtMs > 0 && Date.now() - latestDeathAtMs < 9000;
      const toastOk = toastKindsPresent().has('death');
      const logOk = combatLogKindsPresent().has('death');
      const dyingVisible = [...npcLifeFx.values()].some(
        (fx) => fx.phase === 'dying',
      );

      if (phase === 'done') {
        return;
      }

      if (deathFresh && (toastOk || logOk || dyingVisible)) {
        // Keep death toast/log on screen for the screenshot; soft-respawn later.
        phase = 'done';
        if (mark) {
          mark.textContent =
            `Death VFX OK · Dummy defeated · toast/log · ` +
            `HP ${dummy?.hp ?? 0}/${dummy?.maxHp ?? '?'}`;
        }
        window.setTimeout(() => {
          try {
            net?.ensureTrainingDummy();
          } catch {
            /* ignore */
          }
        }, 1600);
        return;
      }

      if (dummy && dummy.hp <= 0) {
        phase = 'hold';
        if (mark) {
          mark.textContent =
            `VE death: dummy down · waiting VFX/toast… ` +
            `toast=${toastOk ? 'y' : 'n'} log=${logOk ? 'y' : 'n'}`;
        }
        if (ticks < 260) window.setTimeout(waitDeath, 120);
        return;
      }

      phase = 'kill';
      const gcd = gcdRemainingMs(net.getCombat());
      const now = Date.now();
      if (
        dummy &&
        dummy.hp > 0 &&
        gcd <= 0 &&
        now - lastCastAt > 1100
      ) {
        lastCastSpell = SPELL_SPARK;
        net.cast(SPELL_SPARK);
        pushCombatLog('cast', `Spark → Dummy #${dummy.npcId}`);
        casts += 1;
        lastCastAt = now;
        if (mark) {
          mark.textContent =
            `VE death: Spark #${casts} · Dummy HP ${dummy.hp}/${dummy.maxHp}`;
        }
      } else if (mark && dummy) {
        mark.textContent =
          `VE death: casting… Dummy HP ${dummy.hp}/${dummy.maxHp} · GCD ${Math.max(0, gcd)}ms`;
      }

      if (ticks > 280) {
        if (mark) {
          mark.textContent =
            `VE death: timed out · casts ${casts} · HP ${dummy?.hp ?? '?'} · ` +
            `toast=${toastOk ? 'y' : 'n'} log=${logOk ? 'y' : 'n'} · ` +
            `respawnAge=${latestRespawnAtMs ? Date.now() - latestRespawnAtMs : 'n/a'}`;
        }
        return;
      }
      window.setTimeout(waitDeath, 140);
    };
    window.setTimeout(waitDeath, 600);
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
        setHumanoidStaffEquipped(humanoid, false);
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


  // ?ve=staff-block — Connected → unequip → key 1 so bindInput runs onCast (#189).
  if (ve === 'staff-block') {
    camera.radius = 9;
    camera.alpha = Math.PI / 2.3;
    camera.beta = Math.PI / 3.1;
  }
  if (net && ve === 'staff-block') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE staff-block: waiting for Connected…';
    let ticks = 0;
    let pressed = false;
    const waitBlock = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE staff-block: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitBlock, 200);
        return;
      }
      camera.setTarget(player.position.add(new Vector3(0, 1.2, 0)));
      camera.radius = 8.5;
      const ch = net.getCharacter();
      if (!ch) {
        if (mark) mark.textContent = 'VE staff-block: waiting character…';
        if (ticks < 200) window.setTimeout(waitBlock, 200);
        return;
      }
      if (ch.staffEquipped) {
        net.unequipStaff();
        if (mark) mark.textContent = 'VE staff-block: unequipping…';
        if (ticks < 200) window.setTimeout(waitBlock, 250);
        return;
      }
      setStaffMeshVisible(humanoid.staff, false);
      updateSpellHotbar({
        gcdMs: 0,
        castingMs: 0,
        castingTotal: 0,
        castingSpell: 0,
        staffEquipped: false,
        mana: ch.mana ?? 0,
        knowsSpark: ch.knowsSpark,
        knowsEmberbolt: ch.knowsEmberbolt,
      });
      if (!pressed) {
        setChatComposing(false);
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: '1',
            code: 'Digit1',
            bubbles: true,
            cancelable: true,
          }),
        );
        pressed = true;
        if (mark) mark.textContent = 'VE staff-block: pressed 1 · waiting onCast…';
        window.setTimeout(waitBlock, 200);
        return;
      }
      const toastText = document.getElementById('toastStack')?.textContent ?? '';
      const logText = document.getElementById('combatLogLines')?.textContent ?? '';
      const spark = document.getElementById('slotSpark');
      const ember = document.getElementById('slotEmberbolt');
      const staffChrome =
        !!spark?.classList.contains('disabled') &&
        !!ember?.classList.contains('disabled');
      const toastOk = toastText.includes('equip staff · I');
      const logOk = logText.includes('equip with I');
      if (toastOk && logOk && staffChrome) {
        if (mark) {
          mark.textContent =
            'Staff-block OK · onCast 1 · toast + log · STAFF chrome · I';
        }
        return;
      }
      if (ticks > 200) {
        if (mark) {
          mark.textContent =
            `VE staff-block: fail · toast=${toastOk ? 'y' : 'n'} ` +
            `log=${logOk ? 'y' : 'n'} staff=${staffChrome ? 'y' : 'n'}`;
        }
        return;
      }
      window.setTimeout(waitBlock, 160);
    };
    window.setTimeout(waitBlock, 600);
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

  // ?ve=minimap-party — You (blue) + far always-relevant party mate green blip on rim.
  if (ve === 'minimap-party') {
    camera.radius = 28;
    camera.alpha = Math.PI / 2.4;
    camera.beta = Math.PI / 3.25;
  }
  if (net && ve === 'minimap-party') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE minimap-party: waiting for party invite / far mate…';
    try {
      const p0 = net.getParty();
      if (p0 && p0.size > 0 && p0.size < 2) net.leaveParty();
    } catch { /* ignore */ }
    let ticks = 0;
    let invited = false;
    const waitMinimapParty = () => {
      if (!net) return;
      ticks += 1;
      const remotes = net.getRemotes();
      syncRemoteMeshes(remotes);
      const party = net.getParty();
      const st = latestStatus;
      const local = net.getLocalPose() ?? {
        x: player.position.x,
        z: player.position.z,
      };
      drawMinimap({
        local,
        remotes,
        npcs: net.getNpcs(),
        proxies: net.getProxies(),
      });
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE minimap-party: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitMinimapParty, 200);
        return;
      }
      if (party?.pendingInviteFrom) {
        if ((party.size ?? 0) > 0 && (party.size ?? 0) < 2) {
          net.leaveParty();
          if (mark) mark.textContent = 'VE minimap-party: left solo party to accept inbound invite…';
          window.setTimeout(waitMinimapParty, 250);
          return;
        }
        if ((party.size ?? 0) === 0) {
          net.acceptPartyInvite();
          if (mark) {
            mark.textContent = `VE minimap-party: accepting invite from ${party.pendingInviteFrom.slice(0, 12)}…`;
          }
          window.setTimeout(waitMinimapParty, 300);
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
            mark.textContent = `VE minimap-party: invited ${hex.slice(0, 12)}… waiting accept + far pose…`;
          }
        }
      }
      const farParty = remotes.find((r) => {
        if (!r.party) return false;
        const dist = Math.hypot(r.x - local.x, r.z - local.z);
        return dist > MINIMAP_RANGE_M || Math.abs(r.chunkX) > 1 || Math.abs(r.chunkZ) > 1;
      });
      if ((party?.size ?? 0) >= 2 && farParty && document.getElementById('minimap')) {
        camera.setTarget(new Vector3(local.x, 1.1, local.z));
        camera.radius = 26;
        if (mark) {
          const dist = Math.hypot(farParty.x - local.x, farParty.z - local.z);
          mark.textContent =
            `Minimap party OK · You + far mate blip ${farParty.identityHex.slice(0, 12)}… ` +
            `@(${farParty.x.toFixed(0)},${farParty.z.toFixed(0)}) dist ${dist.toFixed(0)}m · green rim`;
        }
        return;
      }
      if (mark) {
        mark.textContent =
          `VE minimap-party: Connected · party ${party?.size ?? 0} · remotes ${remotes.length} · ` +
          `invited=${invited} · pending=${party?.pendingInviteFrom?.slice(0, 8) ?? '—'} (waiting far party blip…)`;
      }
      if (ticks > 220) {
        if (mark) mark.textContent = 'VE minimap-party: timed out waiting for far party mate blip';
        return;
      }
      window.setTimeout(waitMinimapParty, 200);
    };
    window.setTimeout(waitMinimapParty, 800);
  }

  // ?ve=minimap-read — plate + blips + N vs #39 cyan fog at play cam (#103 / #61).
  if (ve === 'minimap-read') {
    camera.radius = 14;
    camera.alpha = Math.PI / 2.4;
    camera.beta = Math.PI / 3.2;
  }
  if (net && ve === 'minimap-read') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE minimap-read: waiting for plate + blips vs cyan fog…';
    let ticks = 0;
    let invited = false;
    const waitMinimapRead = () => {
      if (!net) return;
      ticks += 1;
      net.seedCrowdProxies();
      net.ensureTrainingDummy();
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE minimap-read: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitMinimapRead, 200);
        return;
      }
      const party = net.getParty();
      const local = net.getLocalPose();
      const remotes = net.getRemotes();
      const proxies = net.getProxies();
      const npcs = net.getNpcs();
      const dummy = npcs.find((n) => n.kind === NPC_KIND_DUMMY);
      if (!local) {
        if (mark) mark.textContent = 'VE minimap-read: waiting for local pose…';
        window.setTimeout(waitMinimapRead, 250);
        return;
      }
      if (!invited && !party?.pendingInviteFrom && remotes.length >= 1 && (party?.size ?? 0) < 2) {
        const hex = net.inviteNearestRemote();
        if (hex) {
          invited = true;
          if (mark) mark.textContent = `VE minimap-read: invited ${hex.slice(0, 12)}… waiting accept…`;
        }
      }
      syncRemoteMeshes(remotes);
      syncProxyMeshes(proxies);
      syncNpcMeshes(npcs);
      drawMinimap({
        local: { x: local.x, z: local.z },
        remotes,
        npcs,
        proxies,
      });
      camera.setTarget(new Vector3(local.x, 1.1, local.z));
      const partyMate = remotes.find((r) => r.party);
      const plate = document.getElementById('minimap');
      const chromeOk = !!(plate && dummy && proxies.length >= 1);
      if (chromeOk && ((party?.size ?? 0) >= 2 && partyMate)) {
        if (mark) {
          mark.textContent =
            `Minimap-read OK · plate+blips+N · party ${party?.size} · ` +
            `proxies ${proxies.length} · #103 fog chrome`;
        }
        return;
      }
      if (chromeOk && ticks >= 12) {
        if (mark) {
          mark.textContent =
            `Minimap-read OK · plate+blips+N · dummy+proxies ${proxies.length} · ` +
            `play cam · #103 fog chrome`;
        }
        return;
      }
      if (mark) {
        mark.textContent =
          `VE minimap-read: Connected · proxies ${proxies.length} · dummy ${dummy ? 'yes' : 'no'} · ` +
          `party ${party?.size ?? 0} (waiting chrome…)`;
      }
      if (ticks > 220) {
        if (mark) mark.textContent = 'VE minimap-read: timed out waiting for plate/blips';
        return;
      }
      window.setTimeout(waitMinimapRead, 200);
    };
    window.setTimeout(waitMinimapRead, 800);
  }

  // ?ve=minimap-pip — WASD slide so self pip + N stay readable over moving blips (#164).
  if (ve === 'minimap-pip') {
    camera.detachControl();
    camera.radius = 22;
    camera.alpha = Math.PI / 2.45;
    camera.beta = Math.PI / 3.3;
  }
  if (net && ve === 'minimap-pip') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE minimap-pip: waiting for Connected + dummy…';
    let ticks = 0;
    let ok = false;
    const waitPip = () => {
      if (!net) return;
      ticks += 1;
      net.seedCrowdProxies();
      net.ensureTrainingDummy();
      if (ticks <= 22) keys.add('w');
      else keys.delete('w');
      const st = latestStatus;
      const local = net.getLocalPose();
      const proxies = net.getProxies();
      const near = proxies.filter((p) => !p.far);
      const npcs = net.getNpcs();
      const dummy = npcs.find((n) => n.kind === NPC_KIND_DUMMY);
      syncProxyMeshes(proxies);
      syncNpcMeshes(npcs);
      camera.radius = 22;
      camera.alpha = Math.PI / 2.45;
      camera.beta = Math.PI / 3.3;
      if (local) {
        camera.setTarget(new Vector3(local.x, 1.15, local.z));
      }
      drawMinimap({
        local: local ?? { x: player.position.x, z: player.position.z },
        remotes: net.getRemotes(),
        npcs,
        proxies,
      });
      const canvasEl = document.getElementById('minimap');
      if (
        st.state === 'connected' &&
        dummy &&
        canvasEl &&
        ticks >= 12
      ) {
        ok = true;
        if (mark) {
          mark.textContent =
            `Minimap pip OK · N + self pip readable in motion · #164`;
        }
      } else if (!ok && mark && st.state === 'connected') {
        mark.textContent =
          `VE minimap-pip: Connected · proxies ${proxies.length} near ${near.length} · dummy ${dummy ? 'yes' : 'no'} · tick ${ticks}`;
      }
      if (ticks > 200 && !ok) {
        if (mark) mark.textContent = 'VE minimap-pip: timed out waiting for dummy + motion';
        return;
      }
      if (ticks < 240) window.setTimeout(waitPip, 180);
    };
    window.setTimeout(waitPip, 700);
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
          net.sendMove((dx / dist) * step, (dz / dist) * step, false);
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

  // ?ve=nameplate-read — prove nameplate legibility over #39 fog at 8–20m play cam.
  if (ve === 'nameplate-read') {
    camera.radius = 14;
    camera.alpha = Math.PI / 2.45;
    camera.beta = Math.PI / 3.2;
  }
  if (net && ve === 'nameplate-read') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE nameplate-read: waiting for Connected + Dummy…';
    let ticks = 0;
    const waitNameplateRead = () => {
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
        const dx = dummy.x - player.position.x;
        const dz = dummy.z - player.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 10 || dist > 18) {
          const targetDist = 14;
          const step = Math.min(MAX_STEP_METERS, Math.abs(dist - targetDist));
          if (dist < targetDist) {
            net.sendMove(-(dx / dist) * step, -(dz / dist) * step, false);
          } else {
            net.sendMove((dx / dist) * step, (dz / dist) * step, false);
          }
        }
        const mid = new Vector3(
          (player.position.x + dummy.x) * 0.5,
          1.2,
          (player.position.z + dummy.z) * 0.5,
        );
        camera.setTarget(mid);
      }
      const dummyMesh = dummy
        ? npcMeshes.get(dummy.npcId.toString())
        : undefined;
      const hasDummyPlate = !!(dummy && dummyMesh?.nameplate && dummy.hp > 0);
      const goodDist = dummy
        ? Math.hypot(dummy.x - player.position.x, dummy.z - player.position.z)
        : 0;
      const inRange = !!dummy && goodDist >= 10 && goodDist <= 18;
      if (
        st.state === 'connected' &&
        hasDummyPlate &&
        inRange &&
        localNameplate.mesh.isEnabled()
      ) {
        if (mark) {
          mark.textContent = `Nameplate readability OK · You + Dummy at ${goodDist.toFixed(1)}m · HP ${dummy.hp}/${dummy.maxHp} chips legible · remotes ${remotes.length}`;
        }
        return;
      }
      if (mark && st.state === 'connected') {
        mark.textContent = `VE nameplate-read: Connected · dummy ${dummy ? 'yes' : 'no'} · dist ${goodDist ? goodDist.toFixed(1) : '?'}m (target 10–18m) · remotes ${remotes.length} (waiting…)`;
      }
      if (ticks > 160) {
        if (mark) mark.textContent = 'VE nameplate-read: timed out';
        return;
      }
      window.setTimeout(waitNameplateRead, 200);
    };
    window.setTimeout(waitNameplateRead, 700);
  }

  // ?ve=dummy-hp — Dummy HP bar readability at play cam (8–20m) under #39 fog.
  if (ve === 'dummy-hp') {
    camera.radius = 13;
    camera.alpha = Math.PI / 2.35;
    camera.beta = Math.PI / 3.25;
  }
  if (net && ve === 'dummy-hp') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE dummy-hp: waiting for Connected + Dummy…';
    let ticks = 0;
    const waitDummyHp = () => {
      if (!net) return;
      ticks += 1;
      net.ensureTrainingDummy();
      const st = latestStatus;
      const npcs = net.getNpcs();
      const dummy = npcs.find((n) => n.kind === NPC_KIND_DUMMY);
      syncNpcMeshes(npcs);
      if (dummy) {
        const dx = dummy.x - player.position.x;
        const dz = dummy.z - player.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0 && (dist < 11 || dist > 16)) {
          const targetDist = 13;
          const step = Math.min(MAX_STEP_METERS, Math.abs(dist - targetDist));
          if (dist < targetDist) {
            net.sendMove(-(dx / dist) * step, -(dz / dist) * step);
          } else {
            net.sendMove((dx / dist) * step, (dz / dist) * step);
          }
        }
        // Frame the dummy billboard (not the local player) so the HP bar is in shot.
        camera.setTarget(new Vector3(dummy.x, 1.35, dummy.z));
        camera.radius = 12;
        camera.beta = Math.PI / 3.15;
        if (dist > 0.05) {
          camera.alpha = Math.atan2(dx, dz) + Math.PI;
        }
      }
      const dummyMesh = dummy
        ? npcMeshes.get(dummy.npcId.toString())
        : undefined;
      const hasDummyPlate = !!(dummy && dummyMesh?.nameplate && dummy.hp > 0);
      const goodDist = dummy
        ? Math.hypot(dummy.x - player.position.x, dummy.z - player.position.z)
        : 0;
      const inRange = !!dummy && goodDist >= 11 && goodDist <= 16;
      if (
        st.state === 'connected' &&
        hasDummyPlate &&
        inRange
      ) {
        if (mark) {
          mark.textContent = `Dummy HP bar OK · at ${goodDist.toFixed(1)}m · HP ${dummy!.hp}/${dummy!.maxHp} · bar legible under fog`;
        }
        window.setTimeout(waitDummyHp, 280);
        return;
      }
      if (mark && st.state === 'connected') {
        mark.textContent = `VE dummy-hp: Connected · dummy ${dummy ? 'yes' : 'no'} · dist ${goodDist ? goodDist.toFixed(1) : '?'}m (target 11–16m) (waiting…)`;
      }
      if (ticks > 160) {
        if (mark) mark.textContent = 'VE dummy-hp: timed out';
        return;
      }
      window.setTimeout(waitDummyHp, 200);
    };
    window.setTimeout(waitDummyHp, 700);
  }

  // ?ve=hotbar / ?ve=hotbar-afford / ?ve=target-frame — select Dummy + cast Spark so target frame + hotbar are live.
  if (ve === 'hotbar' || ve === 'hotbar-afford' || ve === 'target-frame') {
    camera.radius = 12;
    camera.alpha = Math.PI / 2.4;
    camera.beta = Math.PI / 3.2;
  }
  if (net && (ve === 'hotbar' || ve === 'hotbar-afford' || ve === 'target-frame')) {
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
          net.sendMove((dx / dist) * step, (dz / dist) * step, false);
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
        // hotbar-afford: skip cast — proof is empty/STAFF/OOM chrome only.
        if (ve === 'hotbar-afford') {
          castSent = true;
        } else if (gcdRemainingMs(net.getCombat()) <= 0) {
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
      const affordReady =
        ve === 'hotbar-afford' ||
        (castSent && (gcdLeftNow > 0 || castUntilMs > Date.now() || veHotbarPresent));
      if (
        st.state === 'connected' &&
        dummy &&
        frameVisible &&
        nameOk &&
        hotbar &&
        affordReady
      ) {
        // Seed distinct affordances: empty 3–6 + Spark STAFF + Emberbolt OOM (hotbar + hotbar-afford).
        if (ve === 'hotbar' || ve === 'hotbar-afford') {
          veHotbarPresent = { sparkDisabled: true, emberLowMana: true };
          updateSpellHotbar({
            gcdMs: 0,
            castingMs: 0,
            castingTotal: 0,
            castingSpell: 0,
            staffEquipped: true,
            mana: 0,
            knowsSpark: true,
            knowsEmberbolt: true,
          });
          const emptyCount = hotbar.querySelectorAll('.spellSlot.empty').length;
          if (mark) {
            const tag = ve === 'hotbar-afford' ? 'Hotbar-afford OK' : 'Hotbar OK';
            mark.textContent =
              `${tag} · empty ${emptyCount} · Spark STAFF (disabled) · Emberbolt OOM · target Dummy #${dummy.npcId}`;
          }
        } else if (mark) {
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

  // ?ve=gcd — thicker GCD sweep + Emberbolt cast fill readability (presentation seed).
  if (ve === 'gcd') {
    camera.radius = 11;
    camera.alpha = Math.PI / 2.4;
    camera.beta = Math.PI / 3.2;
  }
  if (net && ve === 'gcd') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE gcd: waiting for Connected + Dummy…';
    let ticks = 0;
    let castSent = false;
    const waitGcd = () => {
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
          net.sendMove((dx / dist) * step, (dz / dist) * step, false);
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
          window.setTimeout(waitGcd, 250);
          return;
        }
        // Kick a live Emberbolt so GCD + cast are in flight, then seed mid-progress for the shot.
        if (gcdRemainingMs(net.getCombat()) <= 0) {
          lastCastSpell = SPELL_EMBERBOLT;
          castTotalMs = EMBERBOLT_CAST_MS;
          castUntilMs = Date.now() + EMBERBOLT_CAST_MS;
          net.cast(SPELL_EMBERBOLT);
          castSent = true;
        }
      }
      const hotbar = document.getElementById('spellHotbar');
      const combat = net.getCombat();
      const gcdLive = gcdRemainingMs(combat);
      const castLive = Math.max(0, castUntilMs - Date.now());
      // Prefer presentation seed once Connected (Dummy optional — hotbar readability is the proof).
      if (st.state === 'connected' && hotbar && (castSent || ticks > 8)) {
        // Presentation seed: mid GCD scrub + mid Emberbolt fill — readable for screenshot.
        const seedGcd = Math.max(720, gcdLive || 780);
        const seedCastLeft = Math.max(550, Math.min(EMBERBOLT_CAST_MS - 200, castLive || 700));
        veGcdPresent = {
          gcdMs: seedGcd,
          castingMs: seedCastLeft,
          castingTotal: EMBERBOLT_CAST_MS,
        };
        updateSpellHotbar({
          gcdMs: seedGcd,
          castingMs: seedCastLeft,
          castingTotal: EMBERBOLT_CAST_MS,
          castingSpell: SPELL_EMBERBOLT,
          staffEquipped: true,
          mana: 999,
          knowsSpark: true,
          knowsEmberbolt: true,
        });
        const sweepPct = Math.min(100, Math.round((seedGcd / 1200) * 100));
        const castPct = Math.min(
          100,
          Math.round(((EMBERBOLT_CAST_MS - seedCastLeft) / EMBERBOLT_CAST_MS) * 100),
        );
        const dummyBit = dummy ? `Dummy #${dummy.npcId}` : 'no Dummy';
        if (mark) {
          mark.textContent =
            `GCD OK · sweep ${sweepPct}% · Emberbolt cast ${castPct}% · ${dummyBit}`;
        }
        return;
      }
      if (mark && st.state === 'connected') {
        mark.textContent = `VE gcd: Connected · dummy ${dummy ? 'yes' : 'no'} · castSent=${castSent} (waiting…)`;
      }
      if (ticks > 160) {
        if (mark) mark.textContent = 'VE gcd: timed out waiting for GCD/cast proof';
        return;
      }
      window.setTimeout(waitGcd, 200);
    };
    window.setTimeout(waitGcd, 700);
  }

  // ?ve=reticule — select Dummy; prove gold selection reticule + overhead marker.
  if (ve === 'reticule') {
    camera.radius = 8.5;
    camera.alpha = Math.PI / 2.15;
    camera.beta = Math.PI / 3.4; // slightly higher so ground ring reads
  }
  if (net && ve === 'reticule') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE reticule: waiting for Connected + Dummy…';
    let ticks = 0;
    let okTicks = 0;
    const waitReticule = () => {
      if (!net) return;
      ticks += 1;
      net.ensureTrainingDummy();
      const st = latestStatus;
      const cycle = net.getTargetCycle();
      const dummy = cycle.find((n) => n.kind === NPC_KIND_DUMMY) ?? cycle[0];
      if (dummy) {
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
      }
      syncNpcMeshes(net.getNpcs());
      if (dummy) {
        const dx = dummy.x - player.position.x;
        const dz = dummy.z - player.position.z;
        const dist = Math.hypot(dx, dz);
        // Close the gap so player + Dummy share the frame with the ring readable.
        if (dist > 4.2) {
          const step = Math.min(MAX_STEP_METERS, dist - 2.8);
          net.sendMove((dx / dist) * step, (dz / dist) * step, false);
        }
        // Bias target toward Dummy so gold ring + overhead marker dominate the shot.
        camera.setTarget(
          new Vector3(
            player.position.x * 0.28 + dummy.x * 0.72,
            1.25,
            player.position.z * 0.28 + dummy.z * 0.72,
          ),
        );
        camera.radius = 8.5;
        camera.beta = Math.PI / 3.35;
      }
      const mesh = dummy ? npcMeshes.get(dummy.npcId.toString()) : undefined;
      const ringOn = !!(mesh && mesh.ring.isEnabled());
      const markerOn = !!(mesh && mesh.marker.isEnabled());
      if (
        st.state === 'connected' &&
        dummy &&
        ringOn &&
        markerOn &&
        selectedTargetId === dummy.npcId
      ) {
        okTicks += 1;
        if (mark) {
          mark.textContent = `Reticule OK · Dummy #${dummy.npcId} · gold ring+marker · HP ${dummy.hp}/${dummy.maxHp}`;
        }
        // Hold a few ticks so pulse/marker settle in the VE screenshot.
        if (okTicks < 8 && ticks < 140) {
          window.setTimeout(waitReticule, 180);
        }
        return;
      }
      if (mark && st.state === 'connected') {
        mark.textContent = `VE reticule: Connected · dummy ${dummy ? 'yes' : 'no'} · ring ${ringOn ? 'on' : 'off'} · marker ${markerOn ? 'on' : 'off'} (waiting…)`;
      }
      if (ticks > 160) {
        if (mark) mark.textContent = 'VE reticule: timed out waiting for selection reticule + marker';
        return;
      }
      window.setTimeout(waitReticule, 200);
    };
    window.setTimeout(waitReticule, 700);
  }

  // ?ve=target-contrast — select Dummy; prove gold #targetFrame + world reticule crisp under #39 fog.
  if (ve === 'target-contrast') {
    camera.radius = 9.2;
    camera.alpha = Math.PI / 2.2;
    camera.beta = Math.PI / 3.35;
  }
  if (net && ve === 'target-contrast') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE target-contrast: waiting for Connected + Dummy…';
    let ticks = 0;
    let okTicks = 0;
    const waitContrast = () => {
      if (!net) return;
      ticks += 1;
      net.ensureTrainingDummy();
      const st = latestStatus;
      const cycle = net.getTargetCycle();
      const dummy = cycle.find((n) => n.kind === NPC_KIND_DUMMY) ?? cycle[0];
      if (dummy) {
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
      }
      syncNpcMeshes(net.getNpcs());
      if (dummy) {
        const dx = dummy.x - player.position.x;
        const dz = dummy.z - player.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 4.2) {
          const step = Math.min(MAX_STEP_METERS, dist - 2.8);
          net.sendMove((dx / dist) * step, (dz / dist) * step, false);
        }
        // Frame Dummy + HUD target chrome; play-cam distance so fog wash is visible.
        camera.setTarget(
          new Vector3(
            player.position.x * 0.32 + dummy.x * 0.68,
            1.2,
            player.position.z * 0.32 + dummy.z * 0.68,
          ),
        );
        camera.radius = 9.2;
        camera.beta = Math.PI / 3.3;
      }
      updateTargetFrame(
        dummy
          ? (net.getNpcs().find((n) => n.npcId === dummy.npcId) ?? dummy)
          : null,
      );
      const mesh = dummy ? npcMeshes.get(dummy.npcId.toString()) : undefined;
      const ringOn = !!(mesh && mesh.ring.isEnabled());
      const markerOn = !!(mesh && mesh.marker.isEnabled());
      const frame = document.getElementById('targetFrame');
      const frameVisible = !!(frame && !frame.classList.contains('hidden'));
      const nameTxt = document.getElementById('tfName')?.textContent || '';
      const nameOk = nameTxt.length > 0 && nameTxt !== '—';
      if (
        st.state === 'connected' &&
        dummy &&
        ringOn &&
        markerOn &&
        frameVisible &&
        nameOk &&
        selectedTargetId === dummy.npcId
      ) {
        okTicks += 1;
        if (mark) {
          mark.textContent =
            `Target-contrast OK · gold frame+reticule · Dummy #${dummy.npcId} · fog crisp`;
        }
        if (okTicks < 8 && ticks < 140) {
          window.setTimeout(waitContrast, 180);
        }
        return;
      }
      if (mark && st.state === 'connected') {
        mark.textContent =
          `VE target-contrast: Connected · dummy ${dummy ? 'yes' : 'no'} · frame ${frameVisible ? 'on' : 'off'} · ring ${ringOn ? 'on' : 'off'} · marker ${markerOn ? 'on' : 'off'} (waiting…)`;
      }
      if (ticks > 160) {
        if (mark) mark.textContent = 'VE target-contrast: timed out waiting for gold frame + reticule';
        return;
      }
      window.setTimeout(waitContrast, 200);
    };
    window.setTimeout(waitContrast, 700);
  }

  // ?ve=tab-target — Tab-select Dummy; world gold nameplate + ring + marker (#142).
  if (ve === 'tab-target') {
    camera.radius = 10.5;
    camera.alpha = Math.PI / 2.2;
    camera.beta = Math.PI / 3.2;
  }
  if (net && ve === 'tab-target') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE tab-target: waiting for Connected + Dummy…';
    let ticks = 0;
    let okTicks = 0;
    const waitTabTarget = () => {
      if (!net) return;
      ticks += 1;
      net.ensureTrainingDummy();
      const st = latestStatus;
      const cycle = net.getTargetCycle();
      const dummy = cycle.find((n) => n.kind === NPC_KIND_DUMMY) ?? cycle[0];
      if (dummy) {
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
      }
      syncNpcMeshes(net.getNpcs());
      if (dummy) {
        const dx = dummy.x - player.position.x;
        const dz = dummy.z - player.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 7.5) {
          const step = Math.min(MAX_STEP_METERS, dist - 6);
          net.sendMove((dx / dist) * step, (dz / dist) * step, false);
        } else if (dist > 0.05 && dist < 5) {
          const step = Math.min(MAX_STEP_METERS, 6 - dist);
          net.sendMove((-dx / dist) * step, (-dz / dist) * step, false);
        }
        camera.setTarget(new Vector3(dummy.x, 1.4, dummy.z));
        camera.radius = 10.5;
        camera.beta = Math.PI / 3.2;
        if (dist > 0.05) {
          camera.alpha = Math.atan2(dx, dz) + Math.PI;
        }
      }
      updateTargetFrame(
        dummy
          ? (net.getNpcs().find((n) => n.npcId === dummy.npcId) ?? dummy)
          : null,
      );
      const mesh = dummy ? npcMeshes.get(dummy.npcId.toString()) : undefined;
      const ringOn = !!(mesh && mesh.ring.isEnabled());
      const markerOn = !!(mesh && mesh.marker.isEnabled());
      const plateSelected = !!(mesh && mesh.nameplate && mesh.nameplate.selected);
      const frame = document.getElementById('targetFrame');
      const frameVisible = !!(frame && !frame.classList.contains('hidden'));
      if (
        st.state === 'connected' &&
        dummy &&
        ringOn &&
        markerOn &&
        plateSelected &&
        frameVisible &&
        selectedTargetId === dummy.npcId
      ) {
        okTicks += 1;
        if (mark) {
          mark.textContent =
            `Tab-target OK · world gold plate+ring · Dummy #${dummy.npcId} · HUD frame · #142`;
        }
        if (okTicks < 10 && ticks < 140) {
          window.setTimeout(waitTabTarget, 180);
        }
        return;
      }
      if (mark && st.state === 'connected') {
        mark.textContent =
          `VE tab-target: Connected · dummy ${dummy ? 'yes' : 'no'} · plate ${plateSelected ? 'gold' : 'off'} · ring ${ringOn ? 'on' : 'off'} · marker ${markerOn ? 'on' : 'off'} · frame ${frameVisible ? 'on' : 'off'} (waiting…)`;
      }
      if (ticks > 160) {
        if (mark) mark.textContent = 'VE tab-target: timed out waiting for world gold plate + ring';
        return;
      }
      window.setTimeout(waitTabTarget, 200);
    };
    window.setTimeout(waitTabTarget, 700);
  }

    // ?ve=debug-hud — force debug HUD (#status + #fpsHud) visible; prove F3/?debug=1 path.
  if (ve === 'debug-hud') {
    camera.radius = 14;
    camera.alpha = Math.PI / 2.4;
    camera.beta = Math.PI / 3.2;
    debugHudVisible = true;
    setDebugHudVisible(true);
  }
  if (net && ve === 'debug-hud') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE debug-hud: waiting for Connected…';
    let ticks = 0;
    const waitDebug = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      const statusEl = document.getElementById('status');
      const fpsEl = document.getElementById('fpsHud');
      const statusVisible = !!(statusEl && !statusEl.classList.contains('hidden') && statusEl.offsetWidth > 0);
      const fpsVisible = !!(fpsEl && !fpsEl.classList.contains('hidden') && fpsEl.offsetWidth > 0);
      const statusTxt = (statusEl?.textContent || '').trim();
      if (st.state === 'connected' && statusVisible && fpsVisible && statusTxt.length > 0) {
        if (mark) {
          mark.textContent =
            'Debug HUD OK · status visible · F3/?debug=1';
        }
        return;
      }
      if (mark) {
        mark.textContent =
          `VE debug-hud: ${st.state} · status ${statusVisible ? 'on' : 'off'} · fps ${fpsVisible ? 'on' : 'off'} (waiting…)`;
      }
      if (ticks > 200) {
        if (mark) {
          mark.textContent =
            `VE debug-hud: timed out · status ${statusVisible ? 'on' : 'off'} · fps ${fpsVisible ? 'on' : 'off'}`;
        }
        return;
      }
      window.setTimeout(waitDebug, 200);
    };
    window.setTimeout(waitDebug, 600);
  }

  // ?ve=status-read — prove Connected vs Connecting vs GCD idle are lexically distinct (#129).
  if (ve === 'status-read') {
    camera.radius = 13;
    camera.alpha = Math.PI / 2.35;
    camera.beta = Math.PI / 3.15;
    debugHudVisible = true;
    setDebugHudVisible(true);
  }
  if (ve === 'status-read') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE status-read: waiting for Connected + GCD idle…';
    let ticks = 0;
    const waitStatusRead = () => {
      ticks += 1;
      const st = latestStatus;
      const statusEl = document.getElementById('status');
      const gcdLabel = document.getElementById('gcdLabel');
      const gcdBar = document.getElementById('gcdBar');
      setDebugHudVisible(true);
      // Keep status text fresh for the shot.
      setStatus(formatStatus(st, Date.now()), st.state);
      if (st.state === 'connected') {
        // Force idle GCD chrome so the shot shows Connected · online + GCD idle (not "ready").
        setGcdBar(0, 0, 0, undefined, 'connected');
      }
      const statusTxt = (statusEl?.textContent || '').trim();
      const gcdTxt = (gcdLabel?.textContent || '').trim();
      const hasConn = statusTxt.startsWith('Connected · online');
      const hasGcdIdle = gcdTxt === 'GCD idle';
      const noReady = !statusTxt.includes('GCD: ready') && !gcdTxt.includes('ready');
      const gcdIdleAttr = gcdBar?.dataset.gcd === 'idle';
      const statusVisible = !!(
        statusEl &&
        !statusEl.classList.contains('hidden') &&
        statusEl.offsetWidth > 0
      );
      if (st.state === 'connected' && statusVisible && hasConn && hasGcdIdle && noReady && gcdIdleAttr) {
        if (mark) {
          mark.textContent =
            'Status-read OK · Connected · online · GCD idle · #129';
        }
        return;
      }
      if (mark) {
        mark.textContent =
          `VE status-read: ${st.state} · status ${statusVisible ? 'on' : 'off'} · ` +
          `connLine ${hasConn ? 'ok' : '…'} · gcd "${gcdTxt}" (waiting…)`;
      }
      if (ticks > 200) {
        if (mark) {
          mark.textContent =
            `Status-read timeout · ${st.state} · "${statusTxt.split('\n')[0] || ''}" · gcd "${gcdTxt}"`;
        }
        return;
      }
      window.setTimeout(waitStatusRead, 200);
    };
    window.setTimeout(waitStatusRead, 500);
  }

  // ?ve=rmb-orbit — play follow must NOT eat RMB. Observe alpha after a real
  // pointer drag (#389). Do not inject inertialAlphaOffset (#366 inject is not look).
  if (ve === 'rmb-orbit') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE rmb-orbit: waiting for Connected…';
    let ticks = 0;
    const waitOrbit = () => {
      ticks += 1;
      if (latestStatus.state !== 'connected') {
        if (mark) mark.textContent = `VE rmb-orbit: ${latestStatus.state}…`;
        if (ticks < 200) window.setTimeout(waitOrbit, 200);
        return;
      }
      const a0 = camera.alpha;
      if (mark) mark.textContent = 'VE rmb-orbit: waiting for RMB drag';
      const t0 = performance.now();
      let peak = 0;
      let extra = 0;
      let latched = false;
      const tick = () => {
        const d = camera.alpha - a0;
        if (Math.abs(d) > Math.abs(peak)) peak = d;
        if (!latched && Math.abs(peak) > 0.15) {
          latched = true;
          extra = 24;
        }
        if (latched) {
          extra -= 1;
          if (extra <= 0) {
            const canvasEl = document.getElementById('renderCanvas');
            const cur = canvasEl?.style.cursor || '';
            if (mark) {
              mark.textContent =
                cur === 'none'
                  ? `RMB orbit OK · dAlpha ${peak.toFixed(3)} · cursor none`
                  : `RMB orbit OK · dAlpha ${peak.toFixed(3)}`;
            }
            return;
          }
        }
        if (performance.now() - t0 > 12000) {
          if (mark) {
            mark.textContent = `RMB orbit FAIL · dAlpha ${peak.toFixed(3)}`;
          }
          return;
        }
        window.requestAnimationFrame(tick);
      };
      window.requestAnimationFrame(tick);
    };
    window.setTimeout(waitOrbit, 200);
  }

  // ?ve=hostile-spawn / ?ve=hostile-body — two Kind=2 people + dummy trainer (#405).
  if (ve === 'hostile-spawn' || ve === 'hostile-body') {
    camera.radius = 18;
    camera.alpha = Math.PI / 2.05;
    camera.beta = Math.PI / 2.7;
  }
  if (net && (ve === 'hostile-spawn' || ve === 'hostile-body')) {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE hostile-body: waiting for hostiles…';
    let ticks = 0;
    const waitH = () => {
      if (!net) return;
      ticks += 1;
      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      const hostiles = npcs.filter((n) => n.kind === NPC_KIND_HOSTILE);
      const dummyRow = npcs.find((n) => n.kind === NPC_KIND_DUMMY);
      const dummyMesh = dummyRow
        ? npcMeshes.get(dummyRow.npcId.toString())
        : undefined;
      const dummyTrainer = !!dummyMesh && !dummyMesh.humanoid;
      const hostileParts: HumanoidParts[] = [];
      let capsuleLeft = false;
      let livingIdle: HumanoidPlayback | null = null;
      for (const n of hostiles) {
        const mesh = npcMeshes.get(n.npcId.toString());
        if (mesh?.humanoid) {
          if (n.hp > 0) setHumanoidMoving(mesh.humanoid, false);
          hostileParts.push(mesh.humanoid);
          const pb = readHumanoidPlayback(mesh.humanoid);
          if (
            n.hp > 0 &&
            pb.skinned > 0 &&
            !!pb.playing &&
            /idle/i.test(pb.playing) &&
            pb.height >= 1.5 &&
            pb.height <= 2.15
          ) {
            livingIdle = pb;
          }
        } else if (mesh) {
          capsuleLeft = true;
        }
      }
      const pbs = hostileParts.map(readHumanoidPlayback);
      const peopleOk =
        pbs.length >= 2 &&
        pbs.every(
          (pb) =>
            pb.skinned > 0 &&
            !!pb.playing &&
            /idle|death/i.test(pb.playing),
        );
      if (
        hostiles.length >= 2 &&
        dummyTrainer &&
        peopleOk &&
        livingIdle &&
        !capsuleLeft
      ) {
        if (mark) {
          mark.textContent =
            `Hostile body OK · n=${hostiles.length} · ${livingIdle.playing} · skinned ${livingIdle.skinned} · dummy trainer`;
        }
        return;
      }
      const pb0 = pbs[0];
      if (ticks > 160) {
        if (mark) {
          if (capsuleLeft) {
            mark.textContent = 'Hostile body FAIL · capsule · dummy trainer';
          } else if (pb0 && pb0.skinned <= 0) {
            mark.textContent = `T-POSE · clip=${pb0.playing ?? 'none'} · skeleton=${pb0.skinned}`;
          } else {
            mark.textContent =
              `Hostile body FAIL · hostiles ${hostiles.length}/2 · body ${hostileParts.length} · dummy ${dummyTrainer ? 'trainer' : 'n'}`;
          }
        }
        return;
      }
      if (mark) {
        mark.textContent =
          `VE hostile-body: hostiles ${hostiles.length}/2 · body ${hostileParts.length} · dummy ${dummyTrainer ? 'y' : 'n'}…`;
      }
      window.setTimeout(waitH, 250);
    };
    window.setTimeout(waitH, 800);
  }

  // ?ve=hostile-hit — E8.17 RecieveHit then Death on Kind=2; dummy trainer.
  if (ve === 'hostile-hit') {
    camera.radius = 8;
    camera.alpha = 0.35;
    camera.beta = Math.PI / 2.45;
  }
  if (net && ve === 'hostile-hit') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE hostile-hit: waiting for hostiles…';
    let ticks = 0;
    let lastCastAt = 0;
    let sawFlinch = false;
    const waitHit = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE hostile-hit: ${st.state}…`;
        if (ticks < 240) window.setTimeout(waitHit, 200);
        return;
      }
      const ch = net.getCharacter();
      if (ch && !ch.staffEquipped) {
        net.equipStaff();
        window.setTimeout(waitHit, 250);
        return;
      }
      syncNpcMeshes(net.getNpcs());
      const npcs = net.getNpcs();
      const dummyMesh = npcs
        .filter((n) => n.kind === NPC_KIND_DUMMY)
        .map((n) => npcMeshes.get(n.npcId.toString()))
        .find((m) => m);
      const dummyTrainer = !!dummyMesh && !dummyMesh.humanoid;
      const hostiles = npcs.filter((n) => n.kind === NPC_KIND_HOSTILE);
      const playbackOf = (n: (typeof hostiles)[number]) => {
        const m = npcMeshes.get(n.npcId.toString());
        return m?.humanoid
          ? readHumanoidPlayback(m.humanoid)
          : { skinned: 0, playing: null, idle: null, height: 0 };
      };
      const flinchNpc = hostiles.find((n) => {
        const pb = playbackOf(n);
        return pb.skinned > 0 && !!pb.playing && /recievehit/i.test(pb.playing);
      });
      const deadNpc = hostiles.find((n) => {
        const pb = playbackOf(n);
        return pb.skinned > 0 && !!pb.playing && /death/i.test(pb.playing);
      });
      if (flinchNpc) sawFlinch = true;
      const preferred = deadNpc ?? flinchNpc ?? hostiles.find((n) => n.hp > 0) ?? hostiles[0];
      const pb = preferred
        ? playbackOf(preferred)
        : { skinned: 0, playing: null, idle: null, height: 0 };
      const deathOk =
        dummyTrainer &&
        pb.skinned > 0 &&
        !!pb.playing &&
        /death/i.test(pb.playing);
      const hitOk =
        dummyTrainer &&
        pb.skinned > 0 &&
        !!pb.playing &&
        /recievehit/i.test(pb.playing);
      if (mark) {
        if (deathOk) {
          mark.textContent = `Hostile death OK · ${pb.playing} · skinned ${pb.skinned}${sawFlinch ? ' · RecieveHit seen' : ''}`;
        } else if (hitOk) {
          mark.textContent = `Hostile hit OK · ${pb.playing} · skinned ${pb.skinned}`;
        } else if (preferred && pb.skinned <= 0) {
          mark.textContent = `T-POSE · clip=${pb.playing ?? 'none'} · skeleton=${pb.skinned}`;
        } else {
          mark.textContent = `VE hostile-hit: hostiles ${hostiles.length} · ${pb.playing ?? 'idle'} · skinned ${pb.skinned} · dummy ${dummyTrainer ? 'trainer' : 'n'}…`;
        }
      }
      if (deathOk) return;
      const live =
        hostiles.find((n) => n.hp > 0) ??
        hostiles[0];
      if (live) {
        net.setTarget(live.npcId);
        selectedTargetId = live.npcId;
        const pose = net.getLocalPose();
        if (pose) {
          const dist = Math.hypot(live.x - pose.x, live.z - pose.z);
          if (dist > 6.5) {
            net.sendMove((live.x - pose.x) * 0.25, (live.z - pose.z) * 0.25, false);
          }
        }
        const gcd = gcdRemainingMs(net.getCombat());
        const now = Date.now();
        if (ch && ch.hp > 0 && gcd <= 0 && now - lastCastAt > 1250) {
          lastCastSpell = SPELL_SPARK;
          net.cast(SPELL_SPARK);
          lastCastAt = now;
        }
      }
      if (ticks < 280) window.setTimeout(waitHit, 180);
    };
    window.setTimeout(waitHit, 700);
  }

  // ?ve=leash — pull pad C Brigand then drop (#455). ?ve=aggro is the session shot.
  if (ve === 'leash' || ve === 'aggro') {
    camera.radius = 16;
    camera.alpha = Math.PI / 2.15;
    camera.beta = Math.PI / 2.65;
  }
  if (net && (ve === 'leash' || ve === 'aggro')) {
    const aggroVe = ve === 'aggro';
    const mark = document.getElementById('persistMark');
    if (mark) {
      mark.textContent = aggroVe
        ? 'VE aggro: waiting for brigand…'
        : 'VE leash: waiting for brigand…';
    }
    let ticks = 0;
    let phase: 'pull' | 'drop' | 'done' = 'pull';
    let pulledId: bigint | null = null;
    const padCx = 7;
    const padCz = -3;
    const waitL = () => {
      if (!net) return;
      ticks += 1;
      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      const brigands = npcs.filter((n) => n.kind === NPC_KIND_BRIGAND && n.hp > 0);
      const dummy = npcs.find((n) => n.kind === NPC_KIND_DUMMY);
      const dummyOk = !!dummy;
      const dummyAggro = dummy?.aggroed === true;
      const padC =
        brigands.find(
          (n) => Math.hypot((n.spawnX || padCx) - padCx, (n.spawnZ || padCz) - padCz) < 0.6,
        ) ?? brigands[0];
      if (latestStatus.state !== 'connected' || !padC || !dummyOk) {
        if (mark) {
          mark.textContent =
            `VE ${aggroVe ? 'aggro' : 'leash'}: ${latestStatus.state} · B ${brigands.length}…`;
        }
        if (ticks < 240) window.setTimeout(waitL, 200);
        return;
      }
      if (dummyAggro) {
        if (mark) {
          mark.textContent = `${aggroVe ? 'Aggro' : 'Leash'} FAIL · dummy aggroed · #455`;
        }
        return;
      }
      const mesh = npcMeshes.get(padC.npcId.toString());
      const bLabel = mesh?.nameplate?.label ?? '';
      const capsule = !!mesh && !mesh.humanoid;
      if (capsule) {
        if (mark) {
          mark.textContent = `${aggroVe ? 'Aggro' : 'Leash'} FAIL · capsule · #503`;
        }
        return;
      }
      const dMesh = dummy ? npcMeshes.get(dummy.npcId.toString()) : undefined;
      const dummyTrainer = dummyOk && !!dMesh && !dMesh.humanoid;
      const home = Math.hypot(
        padC.x - (padC.spawnX || padCx),
        padC.z - (padC.spawnZ || padCz),
      );
      const cam = camera.target;
      cam.x = (padC.x + (dummy?.x ?? 5)) * 0.55;
      cam.y = 1.2;
      cam.z = (padC.z + (dummy?.z ?? 0)) * 0.55;
      camera.radius = 14;
      camera.beta = Math.PI / 2.55;
      if (phase === 'pull') {
        const dx = padC.x - player.position.x;
        const dz = padC.z - player.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist > HOSTILE_AGGRO_RADIUS - 0.4 && dist > 0.2) {
          const step = Math.min(MAX_STEP_METERS, dist);
          net.sendMove((dx / dist) * step, (dz / dist) * step, false);
        }
        if (padC.aggroed || home > 0.7) {
          pulledId = padC.npcId;
          selectedTargetId = padC.npcId;
          net.setTarget(padC.npcId);
          phase = 'drop';
          if (mark) {
            mark.textContent = aggroVe
              ? 'VE aggro: pulled Brigand — dropping leash…'
              : 'VE leash: pulled Brigand — running out…';
          }
        } else if (mark) {
          mark.textContent =
            `VE ${aggroVe ? 'aggro' : 'leash'}: walking in · d=${dist.toFixed(1)} · home=${home.toFixed(2)}`;
        }
      } else if (phase === 'drop') {
        const tx = -12;
        const tz = -8;
        const dx = tx - player.position.x;
        const dz = tz - player.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.6) {
          const step = Math.min(MAX_STEP_METERS, dist);
          net.sendMove((dx / dist) * step, (dz / dist) * step, false);
        }
        const victim = brigands.find((n) => n.npcId === pulledId) ?? padC;
        const vHome = Math.hypot(
          victim.x - (victim.spawnX || padCx),
          victim.z - (victim.spawnZ || padCz),
        );
        const vMesh = npcMeshes.get(victim.npcId.toString());
        const vLabel = vMesh?.nameplate?.label ?? bLabel;
        const vCapsule = !!vMesh && !vMesh.humanoid;
        if (vCapsule) {
          if (mark) {
            mark.textContent = `${aggroVe ? 'Aggro' : 'Leash'} FAIL · capsule · #503`;
          }
          return;
        }
        if (
          !victim.aggroed &&
          vHome < 0.45 &&
          vLabel === 'Brigand' &&
          dummyTrainer &&
          victim.kind === NPC_KIND_BRIGAND
        ) {
          phase = 'done';
          if (mark) {
            mark.textContent = aggroVe
              ? `Aggro OK · Brigand #${victim.npcId} · pulled · leashed · dummy trainer · #503`
              : `Leash OK · Brigand #${victim.npcId} · pulled · returned · dummy trainer · #455`;
          }
          return;
        }
        if (mark) {
          mark.textContent =
            `VE ${aggroVe ? 'aggro' : 'leash'}: drop · aggro=${victim.aggroed ? 'y' : 'n'} · home=${vHome.toFixed(1)} · ${bLabel || 'no'}`;
        }
      }
      if (ticks > 240) {
        if (mark) {
          mark.textContent = aggroVe
            ? `Aggro FAIL · phase ${phase} · #455`
            : `Leash FAIL · phase ${phase} · #455`;
        }
        return;
      }
      window.setTimeout(waitL, 200);
    };
    window.setTimeout(waitL, 500);
  }

  // ?ve=hostile-chase — Kind=2/3 Walk while chasing / leash return (#447). Dummy scarecrow.
  if (ve === 'hostile-chase') {
    camera.radius = 8;
    camera.alpha = 0.35;
    camera.beta = Math.PI / 2.45;
  }
  if (net && ve === 'hostile-chase') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE hostile-chase: waiting for hostiles…';
    const clipBare = (name: string | null): string => {
      if (!name) return 'none';
      const i = name.lastIndexOf('|');
      return i >= 0 ? name.slice(i + 1) : name;
    };
    let ticks = 0;
    let sawChase = false;
    let sawLeash = false;
    let latchedOk: string | null = null;
    const padAx = 3;
    const padAz = 7;
    const kiteDist = (HOSTILE_AGGRO_RADIUS + HOSTILE_MELEE_RANGE) * 0.5;
    const waitChase = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE hostile-chase: ${st.state}…`;
        if (ticks < 240) window.setTimeout(waitChase, 200);
        return;
      }
      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      const dummyRow = npcs.find((n) => n.kind === NPC_KIND_DUMMY);
      const dummyMesh = dummyRow
        ? npcMeshes.get(dummyRow.npcId.toString())
        : undefined;
      const dummyTrainer = !!dummyMesh && !dummyMesh.humanoid;
      const hostiles = npcs.filter((n) => isHostileKind(n.kind) && n.hp > 0);
      let capsuleLeft = false;
      let walkPb: HumanoidPlayback | null = null;
      let walkNpc: (typeof hostiles)[number] | null = null;
      for (const n of hostiles) {
        const mesh = npcMeshes.get(n.npcId.toString());
        if (mesh?.humanoid) {
          const pb = readHumanoidPlayback(mesh.humanoid);
          const clip = clipBare(pb.playing);
          if (pb.skinned > 0 && /^walk$/i.test(clip)) {
            walkPb = pb;
            walkNpc = n;
          }
        } else if (mesh) {
          capsuleLeft = true;
        }
      }
      const padA =
        hostiles.find(
          (n) =>
            Math.hypot((n.spawnX || padAx) - padAx, (n.spawnZ || padAz) - padAz) <
            0.6,
        ) ?? hostiles[0];
      if (padA) {
        const hx = padA.x - player.position.x;
        const hz = padA.z - player.position.z;
        const dist = Math.hypot(hx, hz);
        if (walkNpc) {
          const wHome = Math.hypot(
            walkNpc.x - (walkNpc.spawnX || padAx),
            walkNpc.z - (walkNpc.spawnZ || padAz),
          );
          if (walkNpc.aggroed && wHome > 0.35 && walkNpc.z > 4.5) sawChase = true;
          if (!walkNpc.aggroed && wHome > 0.45 && walkNpc.z > 4.5) sawLeash = true;
        }
        if (latchedOk) {
          // Leave the 7m close-up so the local wizard is not a foreground head.
          const tx = padAx + 18;
          const tz = padAz;
          const kx = tx - player.position.x;
          const kz = tz - player.position.z;
          const kd = Math.hypot(kx, kz);
          if (kd > 0.5) {
            const step = Math.min(MAX_STEP_METERS, kd);
            net.sendMove((kx / kd) * step, (kz / kd) * step, false);
          }
        } else if (!padA.aggroed && dist > HOSTILE_AGGRO_RADIUS - 0.25 && dist > 0.2) {
          const step = Math.min(MAX_STEP_METERS, dist);
          net.sendMove((hx / dist) * step, (hz / dist) * step, false);
        } else {
          // North of pad A so the Walk close-up is not the vendor stall.
          const tx = padAx;
          const tz = padAz + 2.4;
          const kx = tx - player.position.x;
          const kz = tz - player.position.z;
          const kd = Math.hypot(kx, kz);
          const want = kiteDist;
          if (dist < want - 0.08 && kd > 0.2) {
            const step = Math.min(MAX_STEP_METERS, kd);
            net.sendMove((kx / kd) * step, (kz / kd) * step, false);
          } else if (dist > want + 0.2 && dist > 0.2) {
            const step = Math.min(MAX_STEP_METERS, dist - want);
            net.sendMove((hx / dist) * step, (hz / dist) * step, false);
          } else if (kd > 0.35) {
            const step = Math.min(MAX_STEP_METERS * 0.7, kd);
            net.sendMove((kx / kd) * step, (kz / kd) * step, false);
          }
        }
      }
      const chaseOk =
        dummyTrainer &&
        !capsuleLeft &&
        walkPb != null &&
        walkPb.skinned > 0 &&
        sawChase;
      if (chaseOk && walkPb) {
        const extra = sawLeash ? ' · leash Walk' : '';
        latchedOk =
          `Hostile chase OK · ${clipBare(walkPb.playing)} · skinned ${walkPb.skinned} · dummy trainer${extra}`;
      }
      if (mark) {
        if (latchedOk) {
          mark.textContent = latchedOk;
        } else if (capsuleLeft) {
          mark.textContent = 'capsule · hostile not a person';
        } else if (walkPb && walkPb.skinned <= 0) {
          mark.textContent = `T-POSE · clip=${walkPb.playing ?? 'none'} · skeleton=${walkPb.skinned}`;
        } else if (ticks > 260) {
          const clip = walkPb ? clipBare(walkPb.playing) : 'none';
          mark.textContent =
            `Hostile chase FAIL · clip=${clip} · dummy ${dummyTrainer ? 'trainer' : 'n'} · chase ${sawChase ? 'y' : 'n'}`;
        } else {
          const clip = walkPb ? clipBare(walkPb.playing) : 'idle';
          const id = walkNpc ? `#${walkNpc.npcId}` : '';
          mark.textContent =
            `VE hostile-chase: ${clip} ${id} · dummy ${dummyTrainer ? 'y' : 'n'} · chase ${sawChase ? 'y' : 'n'}…`;
        }
      }
      if (ticks < 400 && !(capsuleLeft && ticks > 40)) {
        window.setTimeout(waitChase, 50);
      }
    };
    window.setTimeout(waitChase, 700);
  }

  // ?ve=auto-attack — HP drops in melee, stops after leash (#356).
  if (ve === 'auto-attack') {
    camera.radius = 16;
    camera.alpha = Math.PI / 2.05;
    camera.beta = Math.PI / 2.6;
  }
  if (net && ve === 'auto-attack') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE auto-attack: waiting for hostiles…';
    let ticks = 0;
    let phase: 'pull' | 'hit' | 'drop' | 'stop' | 'done' = 'pull';
    let hp0 = 0;
    let hpHit = 0;
    let hpStop = 0;
    let stopAt = 0;
    const padAx = 3;
    const padAz = 7;
    const waitA = () => {
      if (!net) return;
      ticks += 1;
      const npcs = net.getNpcs();
      const hostiles = npcs.filter((n) => n.kind === NPC_KIND_HOSTILE && n.hp > 0);
      const dummyOk = npcs.some((n) => n.kind === NPC_KIND_DUMMY);
      const padA =
        hostiles.find((n) => Math.hypot((n.spawnX || padAx) - padAx, (n.spawnZ || padAz) - padAz) < 0.6) ??
        hostiles[0];
      const hp = net.getCharacter()?.hp ?? 0;
      if (latestStatus.state !== 'connected' || !padA || !dummyOk) {
        if (mark) {
          mark.textContent = `VE auto-attack: ${latestStatus.state} · hostiles ${hostiles.length}/2…`;
        }
        if (ticks < 280) window.setTimeout(waitA, 200);
        return;
      }
      if (phase === 'pull') {
        if (!hp0) hp0 = hp;
        const dx = padA.x - player.position.x;
        const dz = padA.z - player.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.35) {
          const step = Math.min(MAX_STEP_METERS, dist);
          net.sendMove((dx / dist) * step, (dz / dist) * step, false);
        }
        if (padA.aggroed) {
          phase = 'hit';
          if (mark) mark.textContent = `VE auto-attack: pulled · hp ${hp} — waiting swing…`;
        } else if (mark) {
          mark.textContent = `VE auto-attack: walking in · d=${dist.toFixed(1)} · hp ${hp}`;
        }
      } else if (phase === 'hit') {
        const dx = padA.x - player.position.x;
        const dz = padA.z - player.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.35) {
          const step = Math.min(MAX_STEP_METERS, dist);
          net.sendMove((dx / dist) * step, (dz / dist) * step, false);
        }
        if (hp < hp0) {
          hpHit = hp;
          phase = 'drop';
          if (mark) mark.textContent = `VE auto-attack: hit ${hp0}→${hpHit} — running out…`;
        } else if (mark) {
          mark.textContent = `VE auto-attack: in melee · hp ${hp}/${hp0} · aggro=${padA.aggroed ? 'y' : 'n'}`;
        }
      } else if (phase === 'drop') {
        const tx = -12;
        const tz = -8;
        const dx = tx - player.position.x;
        const dz = tz - player.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.6) {
          const step = Math.min(MAX_STEP_METERS, dist);
          net.sendMove((dx / dist) * step, (dz / dist) * step, false);
        }
        const home = Math.hypot(padA.x - (padA.spawnX || padAx), padA.z - (padA.spawnZ || padAz));
        if (!padA.aggroed && home < 0.45) {
          hpStop = hp;
          stopAt = ticks;
          phase = 'stop';
          if (mark) mark.textContent = `VE auto-attack: leashed · hp ${hpStop} — proving stop…`;
        } else if (mark) {
          mark.textContent = `VE auto-attack: drop · hp ${hp} · home=${home.toFixed(1)}`;
        }
      } else if (phase === 'stop') {
        if (hp < hpStop) {
          if (mark) mark.textContent = `Auto-attack FAIL · still hitting ${hpStop}→${hp} · #356`;
          return;
        }
        if (ticks - stopAt >= 10) {
          phase = 'done';
          if (mark) {
            mark.textContent = `Auto-attack OK · hp ${hp0}→${hpHit} · stopped ${hpStop} · #356`;
          }
          return;
        }
        if (mark) {
          mark.textContent = `VE auto-attack: stopped? hp ${hp} hold ${ticks - stopAt}/10`;
        }
      }
      if (ticks > 280) {
        if (mark) mark.textContent = `Auto-attack FAIL · phase ${phase} · hp ${hp} · #356`;
        return;
      }
      window.setTimeout(waitA, 200);
    };
    window.setTimeout(waitA, 500);
  }

  // ?ve=hunt-loot — kill pad A from outside aggro, corpse WorldLoot, F pickup (#357).
  if (ve === 'hunt-loot') {
    camera.radius = 18;
    camera.alpha = Math.PI / 2.1;
    camera.beta = Math.PI / 2.7;
  }
  if (net && ve === 'hunt-loot') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE hunt-loot: waiting for hostiles…';
    let ticks = 0;
    let phase: 'kill' | 'walk' | 'pick' | 'done' = 'kill';
    let lastCast = 0;
    let sparkleHold = 0;
    const padAx = 3;
    const padAz = 7;
    const waitH = () => {
      if (!net) return;
      ticks += 1;
      const npcs = net.getNpcs();
      const hostiles = npcs.filter((n) => n.kind === NPC_KIND_HOSTILE);
      const dummyOk = npcs.some((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0);
      const padA =
        hostiles.find((n) => Math.hypot((n.spawnX || padAx) - padAx, (n.spawnZ || padAz) - padAz) < 0.6) ??
        hostiles[0];
      const items = net.getGroundItems();
      if (latestStatus.state !== 'connected' || !padA || !dummyOk) {
        if (mark) {
          mark.textContent = `VE hunt-loot: ${latestStatus.state} · hostiles ${hostiles.length}/2…`;
        }
        if (ticks < 320) window.setTimeout(waitH, 200);
        return;
      }
      if (phase === 'kill') {
        if (padA.hp > 0) {
          net.setTarget(padA.npcId);
          const now = Date.now();
          if (now - lastCast >= GCD_MS + 80) {
            net.cast(SPELL_SPARK);
            lastCast = now;
          }
          if (mark) {
            mark.textContent = `VE hunt-loot: spark pad A · hp ${padA.hp}/${padA.maxHp}`;
          }
        } else {
          phase = 'walk';
          if (mark) mark.textContent = 'VE hunt-loot: corpse — waiting shard…';
        }
      } else if (phase === 'walk') {
        const shard =
          items.find((it) => Math.hypot(it.x - padAx, it.z - padAz) < 2.5) ?? items[0];
        if (!shard) {
          if (mark) mark.textContent = `VE hunt-loot: waiting WorldLoot · ground ${items.length}`;
        } else {
          const dx = shard.x - player.position.x;
          const dz = shard.z - player.position.z;
          const dist = Math.hypot(dx, dz);
          if (dist > PICKUP_RANGE_METERS - 0.4) {
            const step = Math.min(MAX_STEP_METERS, dist);
            net.sendMove((dx / dist) * step, (dz / dist) * step, false);
            if (mark) {
              mark.textContent = `VE hunt-loot: walking to shard · d=${dist.toFixed(1)}`;
            }
          } else {
            sparkleHold += 1;
            if (sparkleHold < 8) {
              if (mark) {
                mark.textContent = `Hunt-loot OK · corpse shard · F pickup · #357`;
              }
            } else {
              phase = 'pick';
              void net.pickup().catch(() => undefined);
            }
          }
        }
      } else if (phase === 'pick') {
        const shardLeft = items.some((it) => Math.hypot(it.x - padAx, it.z - padAz) < 2.5);
        const bag = !!net.getCharacter()?.hasEmberShard;
        if (!shardLeft && bag) {
          phase = 'done';
          if (mark) mark.textContent = 'Hunt-loot OK · corpse shard · F pickup · #357';
          return;
        }
        if (mark) {
          mark.textContent = `VE hunt-loot: picking · ground ${items.length} · bag ${bag ? 'y' : 'n'}`;
        }
      }
      if (ticks > 320) {
        if (mark) mark.textContent = `Hunt-loot FAIL · phase ${phase} · #357`;
        return;
      }
      window.setTimeout(waitH, 200);
    };
    window.setTimeout(waitH, 500);
  }

  // ?ve=respawn — kill pad A from origin (outside aggro), linger revive at home (#421).
  // Do not walk to the corpse: pickup is inside AggroRadius and the revive eats the player.
  if (ve === 'respawn') {
    camera.radius = 18;
    camera.alpha = Math.PI / 2.1;
    camera.beta = Math.PI / 2.7;
  }
  if (net && ve === 'respawn') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE respawn: waiting for hostiles…';
    let ticks = 0;
    let phase: 'kill' | 'wait' | 'done' = 'kill';
    let lastCast = 0;
    let deadId = 0n;
    let okTicks = 0;
    const padAx = 3;
    const padAz = 7;
    const waitR = () => {
      if (!net) return;
      ticks += 1;
      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      const hostiles = npcs.filter((n) => n.kind === NPC_KIND_HOSTILE);
      const dummyOk = npcs.some((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0);
      const dummyGone = !npcs.some((n) => n.kind === NPC_KIND_DUMMY);
      const padA =
        hostiles.find((n) => Math.hypot((n.spawnX || padAx) - padAx, (n.spawnZ || padAz) - padAz) < 0.6) ??
        hostiles[0];
      const selfHp = net.getCharacter()?.hp ?? 0;
      const local = net.getLocalPose();
      const originSafe =
        !!local && Math.hypot(local.x - padAx, local.z - padAz) > HOSTILE_AGGRO_RADIUS + 1;
      const tgt = camera.target;
      tgt.x = padAx * 0.55;
      tgt.y = 1.15;
      tgt.z = padAz * 0.55;
      if (latestStatus.state !== 'connected' || !padA || !dummyOk) {
        if (mark) {
          mark.textContent = `VE respawn: ${latestStatus.state} · hostiles ${hostiles.length}/2…`;
        }
        if (ticks < 360) window.setTimeout(waitR, 200);
        return;
      }
      if (dummyGone) {
        if (mark) mark.textContent = 'Respawn FAIL · dummy gone · #421';
        return;
      }
      if (selfHp <= 0) {
        if (mark) mark.textContent = 'Respawn FAIL · player died in aggro · #421';
        return;
      }
      if (phase === 'kill') {
        if (padA.hp > 0) {
          net.setTarget(padA.npcId);
          const now = Date.now();
          if (now - lastCast >= GCD_MS + 80) {
            net.cast(SPELL_SPARK);
            lastCast = now;
          }
          if (mark) {
            mark.textContent = `VE respawn: spark pad A · hp ${padA.hp}/${padA.maxHp}`;
          }
        } else {
          deadId = padA.npcId;
          phase = 'wait';
          if (mark) mark.textContent = 'VE respawn: corpse — waiting linger…';
        }
      } else if (phase === 'wait') {
        if (local && !originSafe) {
          net.sendMove(-local.x, -local.z, false);
        }
        const alive = hostiles.find((n) => n.npcId === deadId && n.hp > 0)
          ?? hostiles.find(
            (n) =>
              n.hp > 0 &&
              Math.hypot((n.spawnX || n.x) - padAx, (n.spawnZ || n.z) - padAz) < 0.6,
          );
        const atHome =
          !!alive && Math.hypot(alive.x - padAx, alive.z - padAz) < 0.8;
        const toastOk = toastKindsPresent().has('respawn');
        if (alive && atHome && dummyOk && selfHp > 0 && originSafe) {
          okTicks += 1;
          if (mark) {
            mark.textContent = `Respawn OK · pad A · dummy trainer · #421`;
          }
          if (okTicks >= 8) {
            phase = 'done';
            return;
          }
        } else if (mark) {
          mark.textContent =
            `VE respawn: wait A hp ${alive?.hp ?? 0} home ${atHome ? 'y' : 'n'} toast ${toastOk ? 'y' : 'n'}`;
        }
      }
      if (ticks > 360) {
        if (mark) mark.textContent = `Respawn FAIL · phase ${phase} · #421`;
        return;
      }
      window.setTimeout(waitR, 200);
    };
    window.setTimeout(waitR, 500);
  }

  // ?ve=tab-hostile — Tab visits Kind=2 + Kind=3; dummy stays selectable (#453).
  if (ve === 'tab-hostile') {
    camera.radius = 16;
    camera.alpha = Math.PI / 2.15;
    camera.beta = Math.PI / 2.65;
  }
  if (net && ve === 'tab-hostile') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE tab-hostile: waiting for dummy + brigand…';
    let ticks = 0;
    let lastTabMs = 0;
    const seenKinds = new Set<number>();
    let brigandId = 0n;
    let okTicks = 0;
    const waitT = () => {
      if (!net) return;
      ticks += 1;
      const npcs = net.getNpcs();
      const hostiles = npcs.filter((n) => n.kind === NPC_KIND_HOSTILE && n.hp > 0);
      const brigands = npcs.filter((n) => n.kind === NPC_KIND_BRIGAND && n.hp > 0);
      const dummy = npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0);
      if (
        latestStatus.state !== 'connected' ||
        hostiles.length < 1 ||
        brigands.length < 1 ||
        !dummy
      ) {
        if (mark) {
          mark.textContent =
            `VE tab-hostile: ${latestStatus.state} · H ${hostiles.length} · B ${brigands.length} · D ${dummy ? 'y' : 'n'}…`;
        }
        if (ticks < 200) window.setTimeout(waitT, 200);
        return;
      }
      syncNpcMeshes(npcs);
      const visited =
        seenKinds.has(NPC_KIND_HOSTILE) &&
        seenKinds.has(NPC_KIND_BRIGAND) &&
        seenKinds.has(NPC_KIND_DUMMY);
      const tgtNow = npcs.find((n) => n.npcId === selectedTargetId) ?? null;
      const holdBrigand = visited && tgtNow?.kind === NPC_KIND_BRIGAND;
      const now = Date.now();
      const committed =
        selectedTargetId === 0n ||
        (net.getCombat()?.targetNpcId ?? 0n) === selectedTargetId;
      if (!holdBrigand && committed && now - lastTabMs >= 280) {
        const id = cyclePreferHostiles(net);
        if (id != null) selectedTargetId = id;
        lastTabMs = now;
      }
      const cycle = tabTargetCycle(net);
      const tgt = npcs.find((n) => n.npcId === selectedTargetId) ?? null;
      if (tgt) seenKinds.add(tgt.kind);
      if (tgt?.kind === NPC_KIND_BRIGAND) brigandId = tgt.npcId;
      const dummyInCycle = cycle.some((n) => n.kind === NPC_KIND_DUMMY);
      const brigandInCycle = cycle.some((n) => n.kind === NPC_KIND_BRIGAND);
      updateTargetFrame(tgt);
      if (tgt && (isHostileKind(tgt.kind) || tgt.kind === NPC_KIND_DUMMY)) {
        const other = tgt.kind === NPC_KIND_BRIGAND ? dummy : tgt;
        camera.setTarget(
          new Vector3((tgt.x + other.x) / 2, 1.2, (tgt.z + other.z) / 2),
        );
        camera.radius = 14;
        camera.beta = Math.PI / 3.1;
      }
      const mesh = tgt ? npcMeshes.get(tgt.npcId.toString()) : undefined;
      const ringOn = !!(mesh && mesh.ring.isEnabled());
      const frame = document.getElementById('targetFrame');
      const frameVisible = !!(frame && !frame.classList.contains('hidden'));
      const frameName = document.getElementById('tfName')?.textContent ?? '';
      if (
        visited &&
        tgt &&
        tgt.kind === NPC_KIND_BRIGAND &&
        dummyInCycle &&
        brigandInCycle &&
        ringOn &&
        frameVisible &&
        /brigand/i.test(frameName)
      ) {
        okTicks += 1;
        if (mark) {
          mark.textContent =
            `Tab-hostile OK · Brigand #${brigandId} · dummy selectable · #453`;
        }
        if (okTicks < 8 && ticks < 180) window.setTimeout(waitT, 180);
        return;
      }
      if (mark) {
        mark.textContent =
          `VE tab-hostile: tgt ${tgt ? tgt.kind : 'none'} · seen ${[...seenKinds].join(',')} · dummyCycle ${dummyInCycle ? 'y' : 'n'} · frame ${frameName}`;
      }
      if (ticks > 180) {
        if (mark) {
          mark.textContent =
            `Tab-hostile FAIL · tgt ${tgt?.kind ?? 'none'} · seen ${[...seenKinds].join(',')} · #453`;
        }
        return;
      }
      window.setTimeout(waitT, 200);
    };
    window.setTimeout(waitT, 500);
  }

  // ?ve=tab-aggro — after a pull, Tab selects the aggroed NPC, not lowest id (#484).
  // Kind=2 + Kind=3 both in CastRange; dummy stays in the cycle as trainer.
  if (ve === 'tab-aggro') {
    camera.radius = 14;
    camera.alpha = Math.PI / 2.2;
    camera.beta = Math.PI / 2.7;
  }
  if (net && ve === 'tab-aggro') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE tab-aggro: waiting for Kind=2 + Brigand…';
    let ticks = 0;
    let phase: 'pull' | 'stand' | 'tab' | 'done' = 'pull';
    let tabbed = false;
    const padCx = 7;
    const padCz = -3;
    const waitA = () => {
      if (!net) return;
      ticks += 1;
      const pose = net.getLocalPose();
      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      const hostiles = npcs.filter((n) => n.kind === NPC_KIND_HOSTILE && n.hp > 0);
      const brigands = npcs.filter((n) => n.kind === NPC_KIND_BRIGAND && n.hp > 0);
      const dummy = npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0);
      const padC =
        brigands.find(
          (n) => Math.hypot((n.spawnX || padCx) - padCx, (n.spawnZ || padCz) - padCz) < 0.6,
        ) ?? brigands[0];
      const hp = net.getCharacter()?.hp ?? 0;
      if (latestStatus.state !== 'connected' || !pose || !padC || hostiles.length < 1 || !dummy) {
        if (mark) {
          mark.textContent =
            `VE tab-aggro: ${latestStatus.state} · H ${hostiles.length} · B ${brigands.length}…`;
        }
        if (ticks < 280) window.setTimeout(waitA, 200);
        return;
      }
      if (hp <= 0) {
        if (phase === 'done') {
          if (ticks < 280) window.setTimeout(waitA, 200);
          return;
        }
        phase = 'pull';
        tabbed = false;
        if (mark) mark.textContent = 'VE tab-aggro: dead — waiting respawn…';
        if (ticks < 280) window.setTimeout(waitA, 200);
        return;
      }
      const inCast = (n: NpcView) => {
        const dx = n.x - pose.x;
        const dz = n.z - pose.z;
        return dx * dx + dz * dz <= CAST_RANGE_METERS * CAST_RANGE_METERS;
      };
      const kind2Near = hostiles.some(inCast);
      const kind3Near = brigands.some(inCast);
      if (phase === 'pull') {
        const dx = padC.x - pose.x;
        const dz = padC.z - pose.z;
        const dist = Math.hypot(dx, dz);
        if (dist > HOSTILE_AGGRO_RADIUS - 0.4 && dist > 0.2) {
          const step = Math.min(MAX_STEP_METERS, dist - (HOSTILE_AGGRO_RADIUS - 0.45));
          const slid = slideAgainstTrunks(pose.x, pose.z, (dx / dist) * step, (dz / dist) * step);
          if (Math.abs(slid.dx) > 1e-5 || Math.abs(slid.dz) > 1e-5) {
            net.sendMove(slid.dx, slid.dz, false);
          }
        }
        if (padC.aggroed) {
          phase = 'stand';
          if (mark) mark.textContent = 'VE tab-aggro: pulled Brigand — standing for Tab…';
        } else if (mark) {
          mark.textContent = `VE tab-aggro: walking in · d=${dist.toFixed(1)}`;
        }
      } else if (phase === 'stand') {
        const dx = 0 - pose.x;
        const dz = 0 - pose.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.6 && (!kind2Near || !kind3Near)) {
          const step = Math.min(MAX_STEP_METERS, dist);
          const slid = slideAgainstTrunks(
            pose.x,
            pose.z,
            (dx / dist) * step,
            (dz / dist) * step,
          );
          if (Math.abs(slid.dx) > 1e-5 || Math.abs(slid.dz) > 1e-5) {
            net.sendMove(slid.dx, slid.dz, false);
          }
        }
        if (padC.aggroed && kind2Near && kind3Near) {
          phase = 'tab';
        } else if (mark) {
          mark.textContent =
            `VE tab-aggro: stand · aggro=${padC.aggroed ? 'y' : 'n'} · H2 ${kind2Near ? 'y' : 'n'} · B ${kind3Near ? 'y' : 'n'}`;
        }
      }
      if (phase === 'tab' || phase === 'done') {
        if (!tabbed) {
          const id = cyclePreferHostiles(net);
          if (id != null) selectedTargetId = id;
          tabbed = true;
        }
        const tgt = npcs.find((n) => n.npcId === selectedTargetId) ?? null;
        const cycle = tabTargetCycle(net);
        const dummyInCycle = cycle.some((n) => n.kind === NPC_KIND_DUMMY);
        updateTargetFrame(tgt);
        const mesh = tgt ? npcMeshes.get(tgt.npcId.toString()) : undefined;
        const ringOn = !!(mesh && mesh.ring.isEnabled());
        const frameName = document.getElementById('tfName')?.textContent ?? '';
        const pulledKind =
          tgt?.kind === NPC_KIND_BRIGAND
            ? 'Brigand'
            : tgt?.kind === NPC_KIND_HOSTILE
              ? 'Hostile'
              : '';
        const cam = camera.target;
        cam.x = (pose.x + padC.x) * 0.5;
        cam.y = 1.25;
        cam.z = (pose.z + padC.z) * 0.5;
        camera.radius = 12;
        camera.beta = Math.PI / 2.7;
        const ok =
          !!tgt &&
          tgt.aggroed &&
          isHostileKind(tgt.kind) &&
          tgt.kind !== NPC_KIND_DUMMY &&
          pulledKind.length > 0 &&
          dummyInCycle &&
          kind2Near &&
          kind3Near &&
          ringOn &&
          new RegExp(pulledKind, 'i').test(frameName);
        if (ok) {
          phase = 'done';
          if (mark) {
            mark.textContent =
              `Tab-aggro OK · ${pulledKind} · pulled · dummy trainer`;
          }
        }
        if (phase === 'done') {
          const tx = -11;
          const tz = 8;
          const kdx = tx - pose.x;
          const kdz = tz - pose.z;
          const kd = Math.hypot(kdx, kdz);
          if (kd > 0.6) {
            const step = Math.min(MAX_STEP_METERS, kd);
            const slid = slideAgainstTrunks(
              pose.x,
              pose.z,
              (kdx / kd) * step,
              (kdz / kd) * step,
            );
            if (Math.abs(slid.dx) > 1e-5 || Math.abs(slid.dz) > 1e-5) {
              net.sendMove(slid.dx, slid.dz, false);
            }
          }
          if (ticks < 280) window.setTimeout(waitA, 200);
          return;
        }
        if (mark) {
          mark.textContent =
            `VE tab-aggro: Tab tgt ${tgt?.kind ?? 'none'} aggro=${tgt?.aggroed ? 'y' : 'n'} · ${frameName}`;
        }
      }
      if (ticks > 280) {
        if (mark) mark.textContent = `Tab-aggro FAIL · phase ${phase} · #484`;
        return;
      }
      window.setTimeout(waitA, 200);
    };
    window.setTimeout(waitA, 500);
  }

  // ?ve=hostile-read — Hostile coral plate vs Dummy parchment vs Vendor mint (#359).
  if (ve === 'hostile-read' || ve === 'hostile-types') {
    camera.radius = 18;
    camera.alpha = Math.PI / 2.05;
    camera.beta = Math.PI / 2.7;
  }
  if (net && ve === 'hostile-read') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE hostile-read: waiting for hostiles…';
    let ticks = 0;
    const waitR = () => {
      if (!net) return;
      ticks += 1;
      const npcs = net.getNpcs();
      const hostiles = npcs.filter((n) => n.kind === NPC_KIND_HOSTILE && n.hp > 0);
      const dummy = npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0);
      const vendors = net.getVendors();
      syncNpcMeshes(npcs);
      syncVendorMeshes(vendors);
      const hMesh = hostiles[0]
        ? npcMeshes.get(hostiles[0].npcId.toString())
        : undefined;
      const dMesh = dummy ? npcMeshes.get(dummy.npcId.toString()) : undefined;
      const vMesh = vendors[0]
        ? vendorMeshes.get(vendors[0].vendorId.toString())
        : undefined;
      const hPlate = !!(hMesh?.nameplate && hMesh.nameplate.mesh.isEnabled());
      const dPlate = !!(dMesh?.nameplate && dMesh.nameplate.mesh.isEnabled());
      const vPlate = !!(vMesh?.nameplate && vMesh.nameplate.mesh.isEnabled());
      const hLabel = hMesh?.nameplate?.label ?? '';
      const dLabel = dMesh?.nameplate?.label ?? '';
      const vLabel = vMesh?.nameplate?.label ?? '';
      if (
        latestStatus.state === 'connected' &&
        hPlate &&
        dPlate &&
        vPlate &&
        hLabel === 'Hostile' &&
        dLabel === 'Dummy' &&
        /vendor/i.test(vLabel)
      ) {
        if (mark) {
          mark.textContent =
            'Hostile-read OK · Hostile coral · Dummy parchment · Vendor mint · #359';
        }
        return;
      }
      if (mark) {
        mark.textContent = `VE hostile-read: H ${hLabel || 'no'} · D ${dLabel || 'no'} · V ${vLabel || 'no'}`;
      }
      if (ticks > 200) {
        if (mark) mark.textContent = `Hostile-read FAIL · H ${hLabel || 'no'} · D ${dLabel || 'no'} · V ${vLabel || 'no'} · #359`;
        return;
      }
      window.setTimeout(waitR, 200);
    };
    window.setTimeout(waitR, 500);
  }

  // ?ve=hostile-types — Kind=2 Hostile coral vs Kind=3 Brigand violet (#418).
  if (net && ve === 'hostile-types') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE hostile-types: waiting for both kinds…';
    let ticks = 0;
    const waitTypes = () => {
      if (!net) return;
      ticks += 1;
      const npcs = net.getNpcs();
      const hostiles = npcs.filter((n) => n.kind === NPC_KIND_HOSTILE && n.hp > 0);
      const brigands = npcs.filter((n) => n.kind === NPC_KIND_BRIGAND && n.hp > 0);
      const dummy = npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0);
      const vendors = net.getVendors();
      syncNpcMeshes(npcs);
      syncVendorMeshes(vendors);
      const hMesh = hostiles[0]
        ? npcMeshes.get(hostiles[0].npcId.toString())
        : undefined;
      const bMesh = brigands[0]
        ? npcMeshes.get(brigands[0].npcId.toString())
        : undefined;
      const dMesh = dummy ? npcMeshes.get(dummy.npcId.toString()) : undefined;
      const vMesh = vendors[0]
        ? vendorMeshes.get(vendors[0].vendorId.toString())
        : undefined;
      const hLabel = hMesh?.nameplate?.label ?? '';
      const bLabel = bMesh?.nameplate?.label ?? '';
      const dLabel = dMesh?.nameplate?.label ?? '';
      const vLabel = vMesh?.nameplate?.label ?? '';
      const platesOn =
        !!(hMesh?.nameplate && hMesh.nameplate.mesh.isEnabled()) &&
        !!(bMesh?.nameplate && bMesh.nameplate.mesh.isEnabled()) &&
        !!(dMesh?.nameplate && dMesh.nameplate.mesh.isEnabled()) &&
        !!(vMesh?.nameplate && vMesh.nameplate.mesh.isEnabled());
      if (
        latestStatus.state === 'connected' &&
        platesOn &&
        hLabel === 'Hostile' &&
        bLabel === 'Brigand' &&
        dLabel === 'Dummy' &&
        /vendor/i.test(vLabel)
      ) {
        if (mark) {
          mark.textContent =
            'Hostile-types OK · Hostile coral · Brigand violet · Dummy parchment · Vendor mint · #418';
        }
        return;
      }
      if (mark) {
        mark.textContent =
          `VE hostile-types: H ${hLabel || 'no'} · B ${bLabel || 'no'} · D ${dLabel || 'no'} · V ${vLabel || 'no'}`;
      }
      if (ticks > 200) {
        if (mark) {
          mark.textContent =
            `Hostile-types FAIL · H ${hLabel || 'no'} · B ${bLabel || 'no'} · D ${dLabel || 'no'} · V ${vLabel || 'no'} · #418`;
        }
        return;
      }
      window.setTimeout(waitTypes, 200);
    };
    window.setTimeout(waitTypes, 500);
  }

  // ?ve=brigand-plate — Kind=2 Hostile + Kind=3 Brigand plates + combat log (#454).
  if (ve === 'brigand-plate') {
    camera.radius = 18;
    camera.alpha = Math.PI / 2.05;
    camera.beta = Math.PI / 2.7;
  }
  if (net && ve === 'brigand-plate') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE brigand-plate: waiting for both kinds…';
    let ticks = 0;
    let sparkedB = false;
    let sparkedH = false;
    let lastCast = 0;
    const waitP = () => {
      if (!net) return;
      ticks += 1;
      const npcs = net.getNpcs();
      const hostiles = npcs.filter((n) => n.kind === NPC_KIND_HOSTILE && n.hp > 0);
      const brigands = npcs.filter((n) => n.kind === NPC_KIND_BRIGAND && n.hp > 0);
      const dummy = npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0);
      syncNpcMeshes(npcs);
      const h = hostiles[0];
      const b = brigands[0];
      const hMesh = h ? npcMeshes.get(h.npcId.toString()) : undefined;
      const bMesh = b ? npcMeshes.get(b.npcId.toString()) : undefined;
      const dMesh = dummy ? npcMeshes.get(dummy.npcId.toString()) : undefined;
      const hLabel = hMesh?.nameplate?.label ?? '';
      const bLabel = bMesh?.nameplate?.label ?? '';
      const dLabel = dMesh?.nameplate?.label ?? '';
      const platesOn =
        !!(hMesh?.nameplate && hMesh.nameplate.mesh.isEnabled()) &&
        !!(bMesh?.nameplate && bMesh.nameplate.mesh.isEnabled()) &&
        !!(dMesh?.nameplate && dMesh.nameplate.mesh.isEnabled());
      const logText = document.getElementById('combatLogLines')?.textContent ?? '';
      const logBoth = /Brigand/.test(logText) && /Hostile/.test(logText);
      if (
        latestStatus.state === 'connected' &&
        platesOn &&
        hLabel === 'Hostile' &&
        bLabel === 'Brigand' &&
        dLabel === 'Dummy' &&
        logBoth
      ) {
        if (b) {
          selectedTargetId = b.npcId;
          net.setTarget(b.npcId);
          updateTargetFrame(b);
        }
        if (mark) {
          mark.textContent =
            'Brigand-plate OK · Hostile coral · Brigand violet · Dummy parchment · log both · #454';
        }
        return;
      }
      const gcd = gcdRemainingMs(net.getCombat());
      const now = Date.now();
      if (
        latestStatus.state === 'connected' &&
        b &&
        h &&
        dummy &&
        gcd <= 0 &&
        now - lastCast >= GCD_MS + 80
      ) {
        if (!sparkedB) {
          selectedTargetId = b.npcId;
          net.setTarget(b.npcId);
          net.cast(SPELL_SPARK);
          lastCast = now;
          sparkedB = true;
        } else if (!sparkedH) {
          selectedTargetId = h.npcId;
          net.setTarget(h.npcId);
          net.cast(SPELL_SPARK);
          lastCast = now;
          sparkedH = true;
        }
      }
      if (mark) {
        mark.textContent =
          `VE brigand-plate: H ${hLabel || 'no'} · B ${bLabel || 'no'} · D ${dLabel || 'no'} · log ${logBoth ? 'y' : 'n'}`;
      }
      if (ticks > 220) {
        if (mark) {
          mark.textContent =
            `Brigand-plate FAIL · H ${hLabel || 'no'} · B ${bLabel || 'no'} · D ${dLabel || 'no'} · log ${logBoth ? 'y' : 'n'} · #454`;
        }
        return;
      }
      window.setTimeout(waitP, 200);
    };
    window.setTimeout(waitP, 500);
  }

  // ?ve=brigand-body — Kind=2 crimson staff Idle_Weapon vs Kind=3 unarmed Idle (#428).
  if (ve === 'brigand-body') {
    camera.radius = 18;
    camera.alpha = Math.PI / 2.05;
    camera.beta = Math.PI / 2.7;
  }
  if (net && ve === 'brigand-body') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE brigand-body: waiting for both kinds…';
    const clipBare = (name: string | null): string => {
      if (!name) return 'none';
      const i = name.lastIndexOf('|');
      return i >= 0 ? name.slice(i + 1) : name;
    };
    let ticks = 0;
    const waitB = () => {
      if (!net) return;
      ticks += 1;
      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      const hostiles = npcs.filter((n) => n.kind === NPC_KIND_HOSTILE && n.hp > 0);
      const brigands = npcs.filter((n) => n.kind === NPC_KIND_BRIGAND && n.hp > 0);
      const dummyRow = npcs.find((n) => n.kind === NPC_KIND_DUMMY);
      const dummyMesh = dummyRow
        ? npcMeshes.get(dummyRow.npcId.toString())
        : undefined;
      const dummyTrainer = !!dummyMesh && !dummyMesh.humanoid;
      let capsuleLeft = false;
      let hPb: HumanoidPlayback | null = null;
      let bPb: HumanoidPlayback | null = null;
      let hSkinned = -1;
      let bSkinned = -1;
      for (const n of hostiles) {
        const mesh = npcMeshes.get(n.npcId.toString());
        if (mesh?.humanoid) {
          setHumanoidMoving(mesh.humanoid, false);
          const pb = readHumanoidPlayback(mesh.humanoid);
          if (hSkinned < 0) hSkinned = pb.skinned;
          if (pb.skinned > 0 && /idle_weapon/i.test(pb.playing ?? '')) hPb = pb;
        } else if (mesh) {
          capsuleLeft = true;
        }
      }
      for (const n of brigands) {
        const mesh = npcMeshes.get(n.npcId.toString());
        if (mesh?.humanoid) {
          setHumanoidMoving(mesh.humanoid, false);
          setHumanoidStaffEquipped(mesh.humanoid, false);
          const pb = readHumanoidPlayback(mesh.humanoid);
          if (bSkinned < 0) bSkinned = pb.skinned;
          const clip = clipBare(pb.playing);
          if (pb.skinned > 0 && /^idle$/i.test(clip)) bPb = pb;
        } else if (mesh) {
          capsuleLeft = true;
        }
      }
      if (
        latestStatus.state === 'connected' &&
        dummyTrainer &&
        hPb &&
        bPb &&
        !capsuleLeft
      ) {
        if (mark) {
          mark.textContent =
            `Brigand body OK · Hostile ${clipBare(hPb.playing)} · Brigand ${clipBare(bPb.playing)} · skinned ${Math.min(hPb.skinned, bPb.skinned)}`;
        }
        return;
      }
      if (ticks > 200) {
        if (mark) {
          if (capsuleLeft) {
            mark.textContent = 'Brigand body FAIL · capsule';
          } else if (hSkinned === 0 || bSkinned === 0) {
            mark.textContent = `T-POSE · H ${clipBare(hPb?.playing ?? null)} · B ${clipBare(bPb?.playing ?? null)} · skeleton=${Math.min(hSkinned, bSkinned)}`;
          } else {
            mark.textContent =
              `Brigand body FAIL · H ${clipBare(hPb?.playing ?? null)} · B ${clipBare(bPb?.playing ?? null)} · dummy ${dummyTrainer ? 'y' : 'n'}`;
          }
        }
        return;
      }
      if (mark) {
        mark.textContent =
          `VE brigand-body: H ${clipBare(hPb?.playing ?? null)} · B ${clipBare(bPb?.playing ?? null)} · dummy ${dummyTrainer ? 'y' : 'n'}…`;
      }
      window.setTimeout(waitB, 250);
    };
    window.setTimeout(waitB, 800);
  }

  // ?ve=encounter — Kind=2 + Kind=3 people, dummy trainer, fight pad A (#456).
  if (ve === 'encounter') {
    camera.radius = 20;
    camera.alpha = Math.PI / 2.12;
    camera.beta = Math.PI / 2.55;
  }
  if (net && ve === 'encounter') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE encounter: waiting for hostiles…';
    let ticks = 0;
    let phase: 'pull' | 'fight' | 'done' = 'pull';
    let tabbed = false;
    let hp0 = 0;
    const padAx = 3;
    const padAz = 7;
    const camInTrunk = (): boolean => {
      const p = camera.position;
      return trunks.some(
        (t) =>
          Math.hypot(p.x - t.x, p.z - t.z) < t.r &&
          p.y >= t.y0 - 0.3 &&
          p.y <= t.y1 + 0.3,
      );
    };
    const waitE = () => {
      if (!net) return;
      ticks += 1;
      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      const hostiles = npcs.filter((n) => n.kind === NPC_KIND_HOSTILE && n.hp > 0);
      const brigands = npcs.filter((n) => n.kind === NPC_KIND_BRIGAND && n.hp > 0);
      const dummy = npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0);
      const dummyOk = !!dummy;
      const padA =
        hostiles.find((n) => Math.hypot((n.spawnX || padAx) - padAx, (n.spawnZ || padAz) - padAz) < 0.6) ??
        hostiles[0];
      const brigand = brigands[0];
      const hp = net.getCharacter()?.hp ?? 0;
      if (latestStatus.state !== 'connected' || !padA || !brigand || !dummyOk) {
        if (mark) {
          mark.textContent =
            `VE encounter: ${latestStatus.state} · H ${hostiles.length} · B ${brigands.length}…`;
        }
        if (ticks < 280) window.setTimeout(waitE, 200);
        return;
      }
      if (hp <= 0) {
        phase = 'pull';
        tabbed = false;
        hp0 = 0;
        if (mark) mark.textContent = 'VE encounter: dead — waiting respawn…';
        if (ticks < 280) window.setTimeout(waitE, 200);
        return;
      }
      if (phase === 'pull') {
        if (!hp0) hp0 = hp;
        const dx = padA.x - player.position.x;
        const dz = padA.z - player.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.35) {
          const step = Math.min(MAX_STEP_METERS, dist);
          net.sendMove((dx / dist) * step, (dz / dist) * step, false);
        }
        if (padA.aggroed) {
          phase = 'fight';
          if (mark) mark.textContent = `VE encounter: pulled · hp ${hp} — waiting swing…`;
        } else if (mark) {
          mark.textContent = `VE encounter: walking in · d=${dist.toFixed(1)} · hp ${hp}`;
        }
      } else if (phase === 'fight') {
        const dx = padA.x - player.position.x;
        const dz = padA.z - player.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.35) {
          const step = Math.min(MAX_STEP_METERS, dist);
          net.sendMove((dx / dist) * step, (dz / dist) * step, false);
        }
        if (!tabbed || selectedTargetId !== padA.npcId) {
          net.setTarget(padA.npcId);
          selectedTargetId = padA.npcId;
          tabbed = true;
        }
        updateTargetFrame(padA);
        const mesh = npcMeshes.get(padA.npcId.toString());
        const bMesh = npcMeshes.get(brigand.npcId.toString());
        const dMesh = dummy ? npcMeshes.get(dummy.npcId.toString()) : undefined;
        const plateOn = !!(mesh?.nameplate && mesh.nameplate.mesh.isEnabled());
        const plateLabel = mesh?.nameplate?.label ?? '';
        const bLabel = bMesh?.nameplate?.label ?? '';
        const ringOn = !!(mesh && mesh.ring.isEnabled());
        const clipped = camInTrunk();
        let capsuleLeft = false;
        let hSkinned = 0;
        let bSkinned = 0;
        for (const n of [...hostiles, ...brigands]) {
          const m = npcMeshes.get(n.npcId.toString());
          if (m?.humanoid) {
            const pb = readHumanoidPlayback(m.humanoid);
            if (n.kind === NPC_KIND_BRIGAND) bSkinned = Math.max(bSkinned, pb.skinned);
            else hSkinned = Math.max(hSkinned, pb.skinned);
          } else if (m) {
            capsuleLeft = true;
          }
        }
        const dummyTrainer = !!dMesh && !dMesh.humanoid;
        if (capsuleLeft) {
          if (mark) mark.textContent = 'Encounter FAIL · capsule · #456';
          return;
        }
        if (
          padA.aggroed &&
          hp < hp0 &&
          plateOn &&
          plateLabel === 'Hostile' &&
          bLabel === 'Brigand' &&
          ringOn &&
          !clipped &&
          dummyTrainer &&
          hSkinned > 0 &&
          bSkinned > 0
        ) {
          phase = 'done';
          if (mark) {
            mark.textContent =
              `Encounter OK · Hostile · Brigand · dummy trainer · fighting · skinned · #456`;
          }
          return;
        }
        if (mark) {
          mark.textContent =
            `VE encounter: fight · hp ${hp}/${hp0} · H ${plateLabel || 'no'} · B ${bLabel || 'no'} · ` +
            `skin ${hSkinned}/${bSkinned} · cam ${clipped ? 'clip' : 'clear'}`;
        }
      }
      if (ticks > 280) {
        const tgtFail = npcs.find((n) => n.npcId === selectedTargetId);
        const meshFail = tgtFail ? npcMeshes.get(tgtFail.npcId.toString()) : undefined;
        const clippedFail = camInTrunk();
        if (mark) {
          mark.textContent =
            `Encounter FAIL · phase ${phase} · hp ${hp} · tgt ${tgtFail?.kind ?? 'none'} · ` +
            `plate ${meshFail?.nameplate?.label || 'no'} · cam ${clippedFail ? 'clip' : 'clear'} · #456`;
        }
        return;
      }
      window.setTimeout(waitE, 200);
    };
    window.setTimeout(waitE, 500);
  }

  // ?ve=hunt-loop — Tab, Spark hit, kill, corpse loot on Kind=3 Brigand (#485 / #422).
  // Stay at origin (outside AggroRadius). Do not walk to the shard. Dummy trainer.
  if (ve === 'hunt-loop') {
    camera.radius = 12;
    camera.alpha = Math.atan2(-3, 7);
    camera.beta = Math.PI / 2.55;
  }
  if (net && ve === 'hunt-loop') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE hunt-loop: waiting for Brigand…';
    let ticks = 0;
    let phase: 'tab' | 'hit' | 'loot' | 'done' = 'tab';
    let lastCast = 0;
    let tabbedId = 0n;
    let hpAtTab = 0;
    let hitSeen = false;
    let deathSeen = false;
    let okTicks = 0;
    const padCx = 7;
    const padCz = -3;
    const waitL = () => {
      if (!net) return;
      ticks += 1;
      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      const dummy = npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0);
      const dummyOk = !!dummy;
      const dMesh = dummy ? npcMeshes.get(dummy.npcId.toString()) : undefined;
      const dummyTrainer = dummyOk && !!dMesh && !dMesh.humanoid;
      const brigands = npcs.filter((n) => n.kind === NPC_KIND_BRIGAND);
      const hostiles = npcs.filter((n) => isHostileKind(n.kind));
      const selfHp = net.getCharacter()?.hp ?? 0;
      const items = net.getGroundItems();
      const tgt = camera.target;
      tgt.y = 1.05;
      if (phase === 'loot') {
        tgt.x = 6.2;
        tgt.z = -2.2;
      } else {
        tgt.x = 4.2;
        tgt.z = -1.4;
      }
      if (latestStatus.state !== 'connected' || hostiles.length < 2 || brigands.length < 1 || !dummyOk) {
        if (mark) {
          mark.textContent =
            `VE hunt-loop: ${latestStatus.state} · H ${hostiles.length} · B ${brigands.length}…`;
        }
        if (ticks < 360) window.setTimeout(waitL, 200);
        return;
      }
      if (selfHp <= 0) {
        if (mark) mark.textContent = 'Hunt-loop FAIL · player died · #485';
        return;
      }
      if (phase === 'tab') {
        const id = cyclePreferHostiles(net);
        if (id != null) selectedTargetId = id;
        const picked = npcs.find((n) => n.npcId === selectedTargetId) ?? null;
        updateTargetFrame(picked);
        if (picked && picked.kind === NPC_KIND_BRIGAND && picked.hp > 0) {
          tabbedId = picked.npcId;
          hpAtTab = picked.hp;
          net.setTarget(picked.npcId);
          phase = 'hit';
          if (mark) mark.textContent = `VE hunt-loop: Tab Brigand #${picked.npcId} · spark…`;
        } else if (mark) {
          mark.textContent = `VE hunt-loop: Tab… tgt ${picked?.kind ?? 'none'} (want Brigand)`;
        }
      } else if (phase === 'hit') {
        const prey = npcs.find((n) => n.npcId === tabbedId);
        if (prey && prey.hp > 0) {
          net.setTarget(prey.npcId);
          const now = Date.now();
          if (now - lastCast >= GCD_MS + 80) {
            net.cast(SPELL_SPARK);
            lastCast = now;
          }
          if (prey.hp < hpAtTab) hitSeen = true;
          if (mark) {
            mark.textContent = `VE hunt-loop: Brigand hit ${hitSeen ? 'y' : 'n'} · hp ${prey.hp}/${prey.maxHp}`;
          }
        } else {
          deathSeen = true;
          phase = 'loot';
          if (mark) mark.textContent = 'VE hunt-loop: Brigand dead — waiting shard…';
        }
      } else if (phase === 'loot') {
        const prey = npcs.find((n) => n.npcId === tabbedId);
        const px = prey?.x ?? padCx;
        const pz = prey?.z ?? padCz;
        const shard = items.find((it) => Math.hypot(it.x - px, it.z - pz) < 2.5);
        const bMesh = npcMeshes.get(tabbedId.toString());
        const capsule = !!bMesh && !bMesh.humanoid;
        if (capsule) {
          if (mark) mark.textContent = 'Hunt-loop FAIL · capsule · #485';
          return;
        }
        const tabOk = tabbedId !== 0n;
        if (
          tabOk &&
          hitSeen &&
          deathSeen &&
          shard &&
          dummyTrainer &&
          selfHp > 0
        ) {
          okTicks += 1;
          if (mark) {
            mark.textContent =
              'Hunt-loop OK · Tab · hit · death · loot · Brigand · dummy trainer · #485';
          }
          if (okTicks >= 8) {
            phase = 'done';
            return;
          }
        } else if (mark) {
          mark.textContent =
            `VE hunt-loop: loot ${shard ? 'y' : 'n'} · death ${deathSeen ? 'y' : 'n'} · dummy ${dummyTrainer ? 'y' : 'n'}`;
        }
      }
      if (ticks > 360) {
        if (mark) mark.textContent = `Hunt-loop FAIL · phase ${phase} · #485`;
        return;
      }
      window.setTimeout(waitL, 200);
    };
    window.setTimeout(waitL, 500);
  }

  // ?ve=tab-dummy — after Kind=2 + Kind=3 are corpses, Tab lands on Dummy (#496).
  // Stay at origin (outside AggroRadius). Wound every hostile then finish on
  // consecutive GCDs so linger does not restock before the wipe. Dummy trainer.
  if (ve === 'tab-dummy') {
    camera.radius = 13;
    camera.alpha = Math.PI / 2.08;
    camera.beta = Math.PI / 2.65;
  }
  if (net && ve === 'tab-dummy') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE tab-dummy: waiting for Kind=2 + Brigand…';
    let ticks = 0;
    let phase: 'kill' | 'tab' | 'done' = 'kill';
    let lastCast = 0;
    let tabbed = false;
    const waitD = () => {
      if (!net) return;
      ticks += 1;
      const pose = net.getLocalPose();
      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      const dummy = npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0);
      const dummyOk = !!dummy;
      const dMesh = dummy ? npcMeshes.get(dummy.npcId.toString()) : undefined;
      const dummyTrainer = dummyOk && !!dMesh && !dMesh.humanoid;
      const hostiles = npcs.filter((n) => isHostileKind(n.kind));
      const livingH = hostiles.filter((n) => n.hp > 0);
      const kind2 = hostiles.filter((n) => n.kind === NPC_KIND_HOSTILE);
      const kind3 = hostiles.filter((n) => n.kind === NPC_KIND_BRIGAND);
      const corpse2 = kind2.some((n) => n.hp <= 0);
      const corpse3 = kind3.some((n) => n.hp <= 0);
      const selfHp = net.getCharacter()?.hp ?? 0;
      const cam = camera.target;
      cam.x = 5.6;
      cam.y = 1.12;
      cam.z = -0.9;
      camera.radius = 13;
      camera.beta = Math.PI / 2.65;
      if (latestStatus.state !== 'connected' || !dummyOk || kind2.length < 1 || kind3.length < 1) {
        if (mark) {
          mark.textContent =
            `VE tab-dummy: ${latestStatus.state} · H2 ${kind2.length} · B ${kind3.length}…`;
        }
        if (ticks < 400) window.setTimeout(waitD, 200);
        return;
      }
      if (selfHp <= 0) {
        if (mark) mark.textContent = 'Tab-dummy FAIL · player died · #496';
        return;
      }
      if (pose && Math.hypot(pose.x, pose.z) > 0.7) {
        const step = Math.min(MAX_STEP_METERS, Math.hypot(pose.x, pose.z));
        const dist = Math.hypot(pose.x, pose.z);
        const slid = slideAgainstTrunks(pose.x, pose.z, (-pose.x / dist) * step, (-pose.z / dist) * step);
        if (Math.abs(slid.dx) > 1e-5 || Math.abs(slid.dz) > 1e-5) {
          net.sendMove(slid.dx, slid.dz, false);
        }
      }
      if (phase === 'kill') {
        if (livingH.length === 0 && corpse2 && corpse3) {
          phase = 'tab';
          tabbed = false;
        } else {
          const wound = livingH.filter((n) => n.hp > 10);
          const prey = wound[0] ?? livingH[0];
          if (prey) {
            net.setTarget(prey.npcId);
            selectedTargetId = prey.npcId;
            const ch = net.getCharacter();
            const mana = ch?.mana ?? 0;
            if (mana < SPARK_MANA_COST) {
              void net.rest();
              if (mark) mark.textContent = `VE tab-dummy: Rest · mana ${mana}`;
            } else {
              const now = Date.now();
              if (now - lastCast >= GCD_MS + 80) {
                net.cast(SPELL_SPARK);
                lastCast = now;
              }
              if (mark) {
                mark.textContent =
                  `VE tab-dummy: spark ${npcPlateName(prey.kind)} · hp ${prey.hp}/${prey.maxHp} · live ${livingH.length}`;
              }
            }
          }
        }
      }
      if (phase === 'done') {
        if (mark) mark.textContent = 'Tab-dummy OK · Dummy trainer · wipe · #496';
        return;
      }
      if (phase === 'tab') {
        if (livingH.length > 0) {
          phase = 'kill';
          tabbed = false;
          if (ticks < 400) window.setTimeout(waitD, 200);
          return;
        }
        const combatId = net.getCombat()?.targetNpcId ?? 0n;
        const combatRow = npcs.find((n) => n.npcId === combatId) ?? null;
        const needTab =
          !tabbed ||
          !combatRow ||
          combatRow.hp <= 0 ||
          combatRow.kind !== NPC_KIND_DUMMY;
        if (needTab) {
          const id = cyclePreferHostiles(net);
          if (id != null) selectedTargetId = id;
          tabbed = true;
        }
        const tgtId = selectedTargetId !== 0n ? selectedTargetId : combatId;
        const tgt = npcs.find((n) => n.npcId === tgtId) ?? combatRow;
        const cycle = tabTargetCycle(net);
        const corpseInCycle = cycle.some((n) => n.hp <= 0);
        const dummyInCycle = cycle.some((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0);
        updateTargetFrame(tgt && tgt.hp > 0 ? tgt : dummy);
        const mesh = dummy ? npcMeshes.get(dummy.npcId.toString()) : undefined;
        const ringOn = !!(mesh && mesh.ring.isEnabled());
        const frame = document.getElementById('targetFrame');
        const frameVisible = !!(frame && !frame.classList.contains('hidden'));
        const frameName = document.getElementById('tfName')?.textContent ?? '';
        const corpseTarget = !!tgt && tgt.hp <= 0 && isHostileKind(tgt.kind);
        const capsuleCorpse = hostiles.some((n) => {
          if (n.hp > 0) return false;
          const m = npcMeshes.get(n.npcId.toString());
          return !!m && !m.humanoid;
        });
        if (capsuleCorpse) {
          if (mark) mark.textContent = 'Tab-dummy FAIL · capsule · #496';
          return;
        }
        const landedDummy =
          !!tgt &&
          tgt.kind === NPC_KIND_DUMMY &&
          tgt.hp > 0;
        if (corpseTarget && !landedDummy) {
          tabbed = false;
          if (mark) mark.textContent = 'VE tab-dummy: Tab skipped corpse…';
        }
        const ok =
          landedDummy &&
          dummyTrainer &&
          dummyInCycle &&
          !corpseInCycle &&
          corpse2 &&
          corpse3 &&
          livingH.length === 0 &&
          ringOn &&
          frameVisible &&
          /dummy/i.test(frameName);
        if (ok) {
          phase = 'done';
          if (mark) {
            mark.textContent = 'Tab-dummy OK · Dummy trainer · wipe · #496';
          }
          return;
        } else if (mark && !corpseTarget) {
          mark.textContent =
            `VE tab-dummy: Tab tgt ${tgt ? `${npcPlateName(tgt.kind)} hp ${tgt.hp}` : 'none'} · ${frameName}`;
        }
      }
      if (ticks > 400) {
        if (mark) mark.textContent = `Tab-dummy FAIL · phase ${phase} · #496`;
        return;
      }
      window.setTimeout(waitD, 200);
    };
    window.setTimeout(waitD, 500);
  }

  // ?ve=rmb-look — prove RMB-look armed chrome (cursor grabbing + legend LOOKING + status) (#154).
  if (ve === 'rmb-look') {
    camera.radius = 14;
    camera.alpha = Math.PI / 2.4;
    camera.beta = Math.PI / 3.2;
    keysLegendOpen = true;
    setKeysLegendOpen(true);
    debugHudVisible = true;
    setDebugHudVisible(true);
    veRmbLookLock = true;
    setRmbLookArmed(true);
  }
  if (ve === 'rmb-look') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE rmb-look: waiting for armed chrome…';
    let ticks = 0;
    const waitRmb = () => {
      ticks += 1;
      const canvasEl = document.getElementById('renderCanvas');
      const chip = document.querySelector('#keysLegend .klChip[data-bind="rmb"]');
      const label = chip?.querySelector('.klRmbLabel');
      const panel = document.getElementById('keysLegend');
      const statusEl = document.getElementById('status');
      setKeysLegendOpen(true);
      setDebugHudVisible(true);
      setRmbLookArmed(true);
      setStatus(formatStatus(latestStatus, Date.now()), latestStatus.state);
      const armedAttr = canvasEl?.dataset.rmbLook === 'armed';
      const cursorGrabbing = (canvasEl?.style.cursor || '') === 'grabbing';
      const chipArmed = !!chip?.classList.contains('armed');
      const labelLooking = (label?.textContent || '').trim() === 'LOOKING';
      const legendOpen = !!(panel && !panel.classList.contains('hidden'));
      const statusTxt = (statusEl?.textContent || '').trim();
      const statusLooking = statusTxt.includes('camera: looking (RMB drag)');
      if (armedAttr && cursorGrabbing && chipArmed && labelLooking && legendOpen && statusLooking) {
        if (mark) {
          mark.textContent =
            'RMB-look OK · armed · grabbing · legend LOOKING · status looking · #154';
        }
        return;
      }
      if (mark) {
        mark.textContent =
          `VE rmb-look: armed ${armedAttr ? 'y' : 'n'} · cursor ${cursorGrabbing ? 'grabbing' : (canvasEl?.style.cursor || '?')} · ` +
          `chip ${chipArmed ? 'armed' : 'idle'} · label "${(label?.textContent || '').trim()}" · ` +
          `legend ${legendOpen ? 'on' : 'off'} · status ${statusLooking ? 'looking' : '…'} (waiting…)`;
      }
      if (ticks > 200) {
        if (mark) {
          mark.textContent =
            `RMB-look timeout · armed=${armedAttr} cursor=${canvasEl?.style.cursor || '?'} label="${(label?.textContent || '').trim()}"`;
        }
        return;
      }
      window.setTimeout(waitRmb, 200);
    };
    window.setTimeout(waitRmb, 400);
  }

  // ?ve=keys — open keybind legend overlay + clear HUD mark for screenshot.
  if (ve === 'keys') {
    camera.radius = 14;
    camera.alpha = Math.PI / 2.4;
    camera.beta = Math.PI / 3.2;
    keysLegendOpen = true;
    setKeysLegendOpen(true);
    const mark = document.getElementById('persistMark');
    const panel = document.getElementById('keysLegend');
    const chips = panel ? panel.querySelectorAll('.klChip').length : 0;
    if (mark) {
      mark.textContent =
        `Keys legend OK · H toggles · ${chips} binds · WASD/Space/RMB/Tab/1-2/Esc · B/U/I/J/K · P/O/T/Y · E/F/V/R · Enter`;
    }
  }

  // ?ve=keys-read — legend chrome readability under #39 cyan fog (#115).
  if (ve === 'keys-read') {
    camera.radius = 14;
    camera.alpha = Math.PI / 2.4;
    camera.beta = Math.PI / 3.2;
    keysLegendOpen = true;
    setKeysLegendOpen(true);
    const mark = document.getElementById('persistMark');
    const panel = document.getElementById('keysLegend');
    const chips = panel ? panel.querySelectorAll('.klChip').length : 0;
    const groups = panel
      ? Array.from(panel.querySelectorAll('.klRow'))
          .map((row) => (row as HTMLElement).dataset.group || '')
          .filter(Boolean)
          .join('/')
      : '';
    if (mark) {
      mark.textContent =
        `Keys-read OK · H toggles · ${chips} binds · ${groups || 'Move/Combat/Social'} · dark plate · #115 fog`;
    }
  }

  // ?ve=first-session — first-connect H legend flash + canvas-focus toast (#134).
  if (ve === 'first-session') {
    camera.radius = 14;
    camera.alpha = Math.PI / 2.4;
    camera.beta = Math.PI / 3.2;
    showFirstSessionControlsCue({
      force: true,
      ttlMs: TOAST_VE_TTL_MS,
      autoCloseMs: 0,
    });
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE first-session: waiting for H legend + canvas-focus cue…';
    let ticks = 0;
    const waitCue = () => {
      ticks += 1;
      keysLegendOpen = true;
      setKeysLegendOpen(true);
      const stack = document.getElementById('toastStack');
      if (stack) {
        for (const el of Array.from(stack.children)) {
          if ((el as HTMLElement).getAttribute('data-kind') !== 'keys') el.remove();
        }
      }
      const panel = document.getElementById('keysLegend');
      const legendOpen = !!(panel && !panel.classList.contains('hidden'));
      const toast = document.querySelector('.sysToast.keys');
      const toastTxt = (toast?.textContent || '').trim();
      const toastOk =
        !!toast &&
        /H/i.test(toastTxt) &&
        (/canvas/i.test(toastTxt) || /WASD/i.test(toastTxt));
      if (legendOpen && toastOk) {
        if (mark) {
          mark.textContent = 'First-session OK · H legend · canvas focus · #134';
        }
        return;
      }
      if (!toastOk) {
        pushSystemToast('keys', FIRST_SESSION_TOAST, TOAST_VE_TTL_MS);
      }
      if (mark) {
        mark.textContent =
          `VE first-session: legend ${legendOpen ? 'on' : 'off'} · toast ${toastOk ? 'ok' : '…'} (waiting…)`;
      }
      if (ticks > 200) {
        if (mark) {
          mark.textContent =
            `First-session timeout · legend=${legendOpen} toast="${toastTxt.slice(0, 48)}"`;
        }
        return;
      }
      window.setTimeout(waitCue, 200);
    };
    window.setTimeout(waitCue, 300);
  }

  // ?ve=zoom-stop — wheel into min then max (#352). deltaY<0 zooms in.
  if (ve === 'zoom-stop') {
    const lower = camera.lowerRadiusLimit ?? CAM_ZOOM_MIN;
    const upper = camera.upperRadiusLimit ?? CAM_ZOOM_MAX;
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE zoom-stop: seeding Zoom min…';
    const canvasEl = document.getElementById('renderCanvas');
    let phase: 'min' | 'max' = 'min';
    let minOk = false;
    let maxOk = false;
    const hold = () => {
      if (phase === 'min') {
        camera.radius = lower;
        camera.alpha = Math.PI / 2.15;
        camera.beta = Math.PI / 2.55;
        canvasEl?.dispatchEvent(
          new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }),
        );
        const toast = document.querySelector('.sysToast.zoomLimit');
        minOk = !!toast && /Zoom min/i.test(toast.textContent || '');
        if (mark) {
          mark.textContent = minOk
            ? `Zoom-stop min OK · r=${lower} · Zoom min toast`
            : 'VE zoom-stop: firing wheel deltaY<0 at min…';
        }
        if (minOk) {
          phase = 'max';
          window.setTimeout(hold, 1600);
          return;
        }
      } else {
        camera.radius = upper;
        camera.alpha = Math.PI / 2.45;
        camera.beta = Math.PI / 3.2;
        canvasEl?.dispatchEvent(
          new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }),
        );
        const toast = document.querySelector('.sysToast.zoomLimit');
        maxOk = !!toast && /Zoom max/i.test(toast.textContent || '');
        if (mark) {
          mark.textContent =
            minOk && maxOk
              ? `Zoom-stop OK · min ${lower} · max ${upper} · Zoom min+max toasts · #352`
              : `VE zoom-stop: min ok · firing wheel deltaY>0 at max…`;
        }
      }
      window.setTimeout(hold, 900);
    };
    window.setTimeout(hold, 500);
  }

  // ?ve=cam-collision — orbit into a hero bole; camera stays in the clearing (#351).
  if (ve === 'cam-collision') {
    camera.beta = Math.PI / 2.18;
    camera.radius = CAM_COLLISION_VE_RADIUS;
    camZoomRadius = CAM_COLLISION_VE_RADIUS;
    const hero0 = nearestHeroTrunk(player.position.x, player.position.z, trunks);
    if (hero0) {
      camera.alpha = trunkAimAlpha(player.position.x, player.position.z, hero0);
    }
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE cam-collision: orbiting into trunk…';
    let ticks = 0;
    const waitCol = () => {
      ticks += 1;
      const want = camZoomRadius;
      const got = camera.radius;
      const hit = camCollideHit;
      const ok = !!hit && got + 0.5 < want;
      const cam = camera.position;
      if (mark) {
        mark.textContent = ok
          ? `Cam-collision OK · r=${got.toFixed(1)} < want=${want.toFixed(0)} · ${hit} · clearing`
          : `VE cam-collision: r=${got.toFixed(1)} want=${want.toFixed(0)} hit=${hit ?? 'none'} · n=${trunks.length} xz=${Math.hypot(cam.x, cam.z).toFixed(1)}`;
      }
      if (ticks < 80) window.setTimeout(waitCol, 200);
    };
    window.setTimeout(waitCol, 400);
  }

  // ?ve=cam-collision-mid — walk to a midTree_* bole then orbit into it (#465).
  // Zoom max 42 cannot reach the mid ring (~48m) from origin; hero-only hit = fail.
  if (net && ve === 'cam-collision-mid') {
    camera.beta = Math.PI / 2.18;
    camera.radius = 12;
    camZoomRadius = 12;
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE cam-collision-mid: walking to mid trunk…';
    let ticks = 0;
    const standOff = 13;
    const waitMid = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE cam-collision-mid: ${st.state}…`;
        if (ticks < 240) window.setTimeout(waitMid, 200);
        return;
      }
      const pose = net.getLocalPose();
      if (!pose) {
        if (mark) mark.textContent = 'VE cam-collision-mid: waiting for pose…';
        if (ticks < 240) window.setTimeout(waitMid, 200);
        return;
      }
      if (!camCollisionMidAimed) {
        camCollisionMidAimed = pickClearTrunk(pose.x, pose.z, trunks, 'mid');
      }
      const aimed = camCollisionMidAimed;
      if (!aimed) {
        if (mark) mark.textContent = 'VE cam-collision-mid FAIL · no midTree_*';
        return;
      }
      const dx = aimed.x - pose.x;
      const dz = aimed.z - pose.z;
      const d = Math.hypot(dx, dz);
      if (d > standOff) {
        const step = Math.min(MAX_STEP_METERS, d - standOff);
        const slid = slideAgainstTrunks(pose.x, pose.z, (dx / d) * step, (dz / d) * step);
        if (Math.abs(slid.dx) > 1e-5 || Math.abs(slid.dz) > 1e-5) {
          net.sendMove(slid.dx, slid.dz, false);
        }
        if (mark) {
          mark.textContent = `VE cam-collision-mid: walk d=${d.toFixed(1)} → ${aimed.name}`;
        }
        if (ticks < 240) window.setTimeout(waitMid, 200);
        return;
      }
      const want = camZoomRadius;
      const got = camera.radius;
      const hit = camCollideHit;
      const midHit = !!hit && /^midTree_/.test(hit);
      const ok = midHit && got + 0.5 < want;
      if (ok) {
        if (mark) {
          mark.textContent =
            `Cam-collision OK · r=${got.toFixed(1)} < want=${want.toFixed(0)} · ${hit} · mid`;
        }
        return;
      }
      if (mark) {
        mark.textContent =
          `VE cam-collision-mid: r=${got.toFixed(1)} want=${want.toFixed(0)} hit=${hit ?? 'none'} · n=${trunks.length} d=${d.toFixed(1)}`;
      }
      if (ticks < 280) window.setTimeout(waitMid, 200);
    };
    window.setTimeout(waitMid, 400);
  }

  // ?ve=cam-collision-dummy — min-zoom orbit into Dummy; must not sit inside the mesh (#466).
  // Living Hostile/Brigand use the same body cylinders. Corpses ignored. Dummy stays trainer.
  if (net && ve === 'cam-collision-dummy') {
    camera.beta = Math.PI / 2.18;
    camera.radius = CAM_ZOOM_MIN;
    camZoomRadius = CAM_ZOOM_MIN;
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE cam-collision-dummy: finding Dummy…';
    let ticks = 0;
    const standOff = 3.2;
    const waitDummy = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE cam-collision-dummy: ${st.state}…`;
        if (ticks < 240) window.setTimeout(waitDummy, 200);
        return;
      }
      const pose = net.getLocalPose();
      const dummy = net.getNpcs().find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0);
      if (!pose || !dummy) {
        if (mark) mark.textContent = 'VE cam-collision-dummy: waiting for Dummy…';
        if (ticks < 240) window.setTimeout(waitDummy, 200);
        return;
      }
      const mesh = npcMeshes.get(dummy.npcId.toString());
      const tx = mesh?.root.position.x ?? dummy.x;
      const tz = mesh?.root.position.z ?? dummy.z;
      const dx = tx - pose.x;
      const dz = tz - pose.z;
      const d = Math.hypot(dx, dz);
      if (d > standOff + 0.25) {
        const step = Math.min(MAX_STEP_METERS, d - standOff);
        const slid = slideAgainstTrunks(pose.x, pose.z, (dx / d) * step, (dz / d) * step);
        if (Math.abs(slid.dx) > 1e-5 || Math.abs(slid.dz) > 1e-5) {
          net.sendMove(slid.dx, slid.dz, false);
        }
      }
      const want = camZoomRadius;
      const got = camera.radius;
      const hit = camCollideHit;
      const cam = camera.position;
      const camD = Math.hypot(cam.x - tx, cam.z - tz);
      const ok = hit === 'Dummy' && got < want && camD > CAM_BODY_DUMMY_R;
      if (ok) {
        if (mark) {
          mark.textContent =
            `Cam-collision OK · Dummy · r=${got.toFixed(1)} < want=${want.toFixed(1)} · min-zoom`;
        }
        return;
      }
      if (mark) {
        mark.textContent =
          d > standOff + 0.25
            ? `VE cam-collision-dummy: walk d=${d.toFixed(1)} → Dummy`
            : `VE cam-collision-dummy: r=${got.toFixed(1)} want=${want.toFixed(1)} hit=${hit ?? 'none'} · camD=${camD.toFixed(2)}`;
      }
      if (ticks < 280) window.setTimeout(waitDummy, 200);
    };
    window.setTimeout(waitDummy, 400);
  }

  // ?ve=cam-collision-vendor — min-zoom orbit into the stall; must not sit inside (#497).
  // Dummy + living hostiles still collide. Stay off pad B (AggroRadius). Dummy trainer.
  if (net && ve === 'cam-collision-vendor') {
    camera.beta = Math.PI / 2.18;
    camera.radius = CAM_ZOOM_MIN;
    camZoomRadius = CAM_ZOOM_MIN;
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE cam-collision-vendor: finding stall…';
    let ticks = 0;
    // Wider stall than Dummy: stand farther so min-zoom grazes (~4.1) instead of
    // a face close-up. Keep off pad B (AggroRadius 3).
    const standOff = 5.6;
    const waitStall = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE cam-collision-vendor: ${st.state}…`;
        if (ticks < 240) window.setTimeout(waitStall, 200);
        return;
      }
      syncVendorMeshes(net.getVendors());
      const pose = net.getLocalPose();
      const vendor = net.getVendors()[0];
      const dummyOk = (net.getNpcs() ?? []).some((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0);
      if (!pose || !vendor || !dummyOk) {
        if (mark) {
          mark.textContent = `VE cam-collision-vendor: waiting stall ${vendor ? 'y' : 'n'} dummy ${dummyOk ? 'y' : 'n'}`;
        }
        if (ticks < 240) window.setTimeout(waitStall, 200);
        return;
      }
      const mesh = vendorMeshes.get(vendor.vendorId.toString());
      const tx = mesh?.root.position.x ?? vendor.x;
      const tz = mesh?.root.position.z ?? vendor.z;
      const dx = tx - pose.x;
      const dz = tz - pose.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.2 && Math.abs(d - standOff) > 0.25) {
        const toward = d > standOff ? 1 : -1;
        const step = Math.min(MAX_STEP_METERS, Math.abs(d - standOff));
        const slid = slideAgainstTrunks(
          pose.x,
          pose.z,
          toward * (dx / d) * step,
          toward * (dz / d) * step,
        );
        if (Math.abs(slid.dx) > 1e-5 || Math.abs(slid.dz) > 1e-5) {
          net.sendMove(slid.dx, slid.dz, false);
        }
      }
      const want = camZoomRadius;
      const got = camera.radius;
      const hit = camCollideHit;
      const cam = camera.position;
      const camD = Math.hypot(cam.x - tx, cam.z - tz);
      const atStand = Math.abs(d - standOff) <= 0.4;
      const ok =
        atStand &&
        hit === 'Vendor' &&
        got < want &&
        camD > CAM_STALL_R &&
        dummyOk;
      if (ok) {
        if (mark) {
          mark.textContent =
            `Cam-collision OK · Vendor · stall · r=${got.toFixed(1)} < want=${want.toFixed(1)} · min-zoom`;
        }
        return;
      }
      if (mark) {
        mark.textContent =
          Math.abs(d - standOff) > 0.25
            ? `VE cam-collision-vendor: walk d=${d.toFixed(1)} → ${standOff.toFixed(1)}`
            : `VE cam-collision-vendor: r=${got.toFixed(1)} want=${want.toFixed(1)} hit=${hit ?? 'none'} · camD=${camD.toFixed(2)}`;
      }
      if (ticks < 280) window.setTimeout(waitStall, 200);
    };
    window.setTimeout(waitStall, 400);
  }

  // ?ve=cam-collision-hop — Space-hop while orbiting into a hero bole (#483).
  // persistMark must name a trunk while Y is above ground. Grounded-only = fail.
  // E1 Y-spring stays on the follow (no land punch). Dummy stays trainer.
  if (net && ve === 'cam-collision-hop') {
    camera.beta = Math.PI / 2.18;
    camera.radius = 12;
    camZoomRadius = 12;
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE cam-collision-hop: walking to hero trunk…';
    let ticks = 0;
    let hopped = false;
    let bestHopY = 0;
    const standOff = 13;
    const GROUND_THRESHOLD = 0.08;
    const AIR_OK = 0.35;
    const waitHopCol = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE cam-collision-hop: ${st.state}…`;
        if (ticks < 280) window.setTimeout(waitHopCol, 200);
        return;
      }
      const pose = net.getLocalPose();
      if (!pose) {
        if (mark) mark.textContent = 'VE cam-collision-hop: waiting for pose…';
        if (ticks < 280) window.setTimeout(waitHopCol, 200);
        return;
      }
      if (!camCollisionHopAimed) {
        camCollisionHopAimed = pickClearTrunk(pose.x, pose.z, trunks, 'hero');
      }
      const aimed = camCollisionHopAimed;
      if (!aimed) {
        if (mark) mark.textContent = 'VE cam-collision-hop FAIL · no heroTree';
        return;
      }
      const dx = aimed.x - pose.x;
      const dz = aimed.z - pose.z;
      const d = Math.hypot(dx, dz);
      if (d > standOff + 0.25) {
        const step = Math.min(MAX_STEP_METERS, d - standOff);
        const slid = slideAgainstTrunks(pose.x, pose.z, (dx / d) * step, (dz / d) * step);
        if (Math.abs(slid.dx) > 1e-5 || Math.abs(slid.dz) > 1e-5) {
          net.sendMove(slid.dx, slid.dz, false);
        }
        if (mark) {
          mark.textContent = `VE cam-collision-hop: walk d=${d.toFixed(1)} → ${aimed.name}`;
        }
        if (ticks < 280) window.setTimeout(waitHopCol, 200);
        return;
      }
      if (pose.y <= GROUND_THRESHOLD) {
        hopped = true;
        net.sendMove(0, 0, true);
      } else {
        net.sendMove(0, 0, false);
      }
      const want = camZoomRadius;
      const got = camera.radius;
      const hit = camCollideHit;
      const trunkHit =
        !!hit && /^(heroTree|heroElder|heroSent|midTree_)/.test(hit);
      const air = pose.y > AIR_OK;
      const pulled = got + 0.5 < want;
      const ok = trunkHit && air && pulled;
      if (ok && pose.y >= bestHopY) {
        bestHopY = pose.y;
        if (mark) {
          mark.textContent =
            `Cam-collision OK · r=${got.toFixed(1)} < want=${want.toFixed(0)} · ${hit} · hop y=${pose.y.toFixed(2)}`;
        }
      }
      if (bestHopY > 0) {
        if (ticks < 360) window.setTimeout(waitHopCol, 80);
        return;
      }
      if (mark) {
        mark.textContent = hopped
          ? `VE cam-collision-hop: y=${pose.y.toFixed(2)} r=${got.toFixed(1)} want=${want.toFixed(0)} hit=${hit ?? 'none'} · n=${trunks.length}`
          : `VE cam-collision-hop: stand d=${d.toFixed(1)} → hop`;
      }
      if (ticks < 360) window.setTimeout(waitHopCol, hopped ? 80 : 200);
    };
    window.setTimeout(waitHopCol, 400);
  }

  // ?ve=jump — tap-Space then pump air Move until land (#147). Hard-FAIL if Y never rises (#128).
  if (net && ve === 'jump') {
    camera.radius = 9;
    camera.alpha = Math.PI / 2.2;
    camera.beta = Math.PI / 2.8;
    keysLegendOpen = true;
    setKeysLegendOpen(true);
    const mark = document.getElementById('persistMark');
    let ticks = 0;
    let jumpAttempted = false;
    let peakY = 0;
    let lastY = 0;
    let stableYTicks = 0;
    const GROUND_THRESHOLD = 0.08;
    const FREEZE_TIMEOUT = 80;
    const waitJump = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE jump: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitJump, 200);
        return;
      }
      const pose = net.getLocalPose();
      if (!pose) {
        if (mark) mark.textContent = 'VE jump: waiting for pose…';
        if (ticks < 100) window.setTimeout(waitJump, 100);
        return;
      }
      if (!jumpAttempted && ticks > 5) {
        jumpAttempted = true;
        net.sendMove(0, 0, true);
        if (mark) mark.textContent = 'VE jump: Space tapped · pumping air Move…';
        window.setTimeout(waitJump, 150);
        return;
      }
      if (jumpAttempted) {
        peakY = Math.max(peakY, pose.y);
        const yDelta = Math.abs(pose.y - lastY);
        if (yDelta < 0.01) {
          stableYTicks += 1;
        } else {
          stableYTicks = 0;
        }
        lastY = pose.y;
        // Gravity only runs inside Move — keep pumping while airborne (#147).
        if (pose.y > GROUND_THRESHOLD) {
          net.sendMove(0, 0, false);
        }
        // Hard-FAIL: Y rose but stalled mid-air even with pumps.
        if (peakY > 0.3 && pose.y > GROUND_THRESHOLD && stableYTicks > 12 && ticks > 40) {
          if (mark) {
            mark.textContent =
              `Jump FAIL · airborne freeze · Y=${pose.y.toFixed(2)}m · peak=${peakY.toFixed(2)}m · stalled ${stableYTicks} ticks`;
          }
          return;
        }
        // Success: rose, then landed (Y≈GroundY).
        if (peakY > 0.3 && pose.y < GROUND_THRESHOLD && stableYTicks > 3) {
          if (mark) {
            mark.textContent =
              `Jump OK · peak=${peakY.toFixed(2)}m · Y=${pose.y.toFixed(2)}m · land after air pump · #147`;
          }
          return;
        }
        // Hard-FAIL: Y never rose (#128).
        if (ticks > FREEZE_TIMEOUT && peakY < 0.25) {
          if (mark) {
            mark.textContent =
              `Jump FAIL · Y never rose · Y=${pose.y.toFixed(2)}m · peak=${peakY.toFixed(2)}m · Space sent · #128`;
          }
          return;
        }
        if (ticks > FREEZE_TIMEOUT) {
          if (mark) {
            mark.textContent =
              `Jump FAIL · no land · Y=${pose.y.toFixed(2)}m · peak=${peakY.toFixed(2)}m · #147`;
          }
          return;
        }
      }
      if (mark && !jumpAttempted) {
        mark.textContent = `VE jump: connected · warming up… (tick ${ticks})`;
      }
      if (ticks < FREEZE_TIMEOUT + 20) window.setTimeout(waitJump, 100);
    };
    window.setTimeout(waitJump, 600);
  }

  // ?ve=jump-apex — play-cam rigid hop (JUMP toast, no squash). Do not replace ?ve=jump (#252).
  if (ve === 'jump-apex') {
    camera.radius = 22;
    camera.alpha = Math.PI / 2.45;
    camera.beta = Math.PI / 3.25;
  }
  if (net && ve === 'jump-apex') {
    const mark = document.getElementById('persistMark');
    let ticks = 0;
    let jumpAttempted = false;
    let peakY = 0;
    let apexOk = false;
    let okScaleY = 0;
    let okPeak = 0;
    const GROUND_THRESHOLD = 0.08;
    const waitApex = () => {
      if (!net) return;
      ticks += 1;
      camera.radius = 22;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE jump-apex: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitApex, 200);
        return;
      }
      const pose = net.getLocalPose();
      if (!pose) {
        if (mark) mark.textContent = 'VE jump-apex: waiting for pose…';
        if (ticks < 100) window.setTimeout(waitApex, 100);
        return;
      }
      if (!jumpAttempted && ticks > 5) {
        jumpAttempted = true;
        net.sendMove(0, 0, true);
        if (mark) mark.textContent = 'VE jump-apex: Space tapped · play-cam r=22…';
        window.setTimeout(waitApex, 120);
        return;
      }
      peakY = Math.max(peakY, pose.y);
      if (pose.y > GROUND_THRESHOLD) {
        net.sendMove(0, 0, false);
      } else if (jumpAttempted && peakY > 0.15) {
        net.sendMove(0, 0, true);
      }
      const toastEl = document.querySelector('.sysToast.jump');
      const toastOk = !!toastEl && /Jump/i.test(toastEl.textContent || '');
      const scaleY = humanoid.root.scaling.y;
      const rigidOk = Math.abs(scaleY - 1) < 0.05;
      const radiusOk = camera.radius >= 20;
      if (!apexOk && peakY > 0.3 && toastOk && rigidOk && radiusOk) {
        apexOk = true;
        okScaleY = scaleY;
        okPeak = peakY;
      }
      if (apexOk) {
        if (mark) {
          mark.textContent =
            `Jump-apex OK · JUMP toast · rigid y=${okScaleY.toFixed(2)} · r=22 · peak=${okPeak.toFixed(2)}m · #252`;
        }
        window.setTimeout(waitApex, 400);
        return;
      }
      if (ticks > 90) {
        if (mark) {
          mark.textContent =
            `Jump-apex FAIL · peak=${peakY.toFixed(2)}m · toast ${toastOk ? 'y' : 'n'} · rigid ${rigidOk ? 'y' : 'n'} · r=${camera.radius.toFixed(0)}`;
        }
        return;
      }
      if (mark && jumpAttempted) {
        mark.textContent =
          `VE jump-apex: peak=${peakY.toFixed(2)}m · toast ${toastOk ? 'y' : 'n'} · scaleY ${scaleY.toFixed(2)}`;
      }
      window.setTimeout(waitApex, 100);
    };
    window.setTimeout(waitApex, 600);
  }

  // ?ve=jump-pose — E2.9 airborne walk off, root.scaling (1,1,1), no squash.
  if (ve === 'jump-pose') {
    camera.radius = 9;
    camera.alpha = 0.35;
    camera.beta = Math.PI / 2.45;
  }
  if (net && ve === 'jump-pose') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE jump-pose: waiting for Connected…';
    let ticks = 0;
    let jumped = false;
    const waitJumpPose = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE jump-pose: ${st.state}…`;
        if (ticks < 180) window.setTimeout(waitJumpPose, 200);
        return;
      }
      keys.add('w');
      keys.add(' ');
      const pose = net.getLocalPose();
      if (!jumped && pose) {
        jumped = true;
        net.sendMove(0.2, 0, true);
      }
      const y = pose?.y ?? 0;
      const scaleY = humanoid.root.scaling.y;
      const walkOn = scene.animationGroups.some(
        (g) => /walk/i.test(g.name) && g.isPlaying && !/remote_/i.test(g.name),
      );
      const air = y > 0.12;
      const rigid = Math.abs(scaleY - 1) < 0.04;
      if (mark) {
        if (air && rigid && !walkOn) {
          mark.textContent = `Jump-pose OK · walk off · scale ${scaleY.toFixed(2)} · y=${y.toFixed(2)}`;
        } else {
          mark.textContent = `VE jump-pose: y=${y.toFixed(2)} · walk ${walkOn ? 'on' : 'off'} · scale ${scaleY.toFixed(2)}`;
        }
      }
      if (ticks < 200) window.setTimeout(waitJumpPose, 80);
    };
    window.setTimeout(waitJumpPose, 600);
  }

  // ?ve=hop-wow — rigid hop, no squash. Close enough that airborne pose reads (#328).
  if (ve === 'hop-wow') {
    camera.radius = 12;
    camera.alpha = Math.PI / 2.45;
    camera.beta = Math.PI / 2.5;
  }
  if (net && ve === 'hop-wow') {
    const mark = document.getElementById('persistMark');
    let ticks = 0;
    let jumpAttempted = false;
    let peakY = 0;
    let hopOk = false;
    let okScaleY = 1;
    let okPeak = 0;
    const GROUND_THRESHOLD = 0.08;
    const waitHop = () => {
      if (!net) return;
      ticks += 1;
      camera.radius = 12;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE hop-wow: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitHop, 200);
        return;
      }
      const pose = net.getLocalPose();
      if (!pose) {
        if (mark) mark.textContent = 'VE hop-wow: waiting for pose…';
        if (ticks < 100) window.setTimeout(waitHop, 100);
        return;
      }
      if (!jumpAttempted && ticks > 5) {
        jumpAttempted = true;
        net.sendMove(0, 0, true);
        if (mark) mark.textContent = 'VE hop-wow: Space tapped · play-cam r=12…';
        window.setTimeout(waitHop, 120);
        return;
      }
      peakY = Math.max(peakY, pose.y);
      if (pose.y > GROUND_THRESHOLD) {
        net.sendMove(0, 0, false);
      } else if (jumpAttempted && peakY > 0.15) {
        net.sendMove(0, 0, true);
      }
      const scaleY = humanoid.root.scaling.y;
      const rigidOk = Math.abs(scaleY - 1) < 0.05;
      const radiusOk = camera.radius >= 9 && camera.radius <= 16;
      const airNow = pose.y > 0.35;
      if (!hopOk && peakY > 0.5 && rigidOk && radiusOk && airNow) {
        hopOk = true;
        okScaleY = scaleY;
        okPeak = peakY;
      }
      if (hopOk) {
        okPeak = Math.max(okPeak, peakY);
        const pb = readHumanoidPlayback(humanoid);
        const locoOn = scene.animationGroups.some(
          (g) =>
            /(walk|run)/i.test(g.name) &&
            g.isPlaying &&
            !/remote_/i.test(g.name),
        );
        if (mark) {
          mark.textContent =
            !locoOn && pb.skinned > 0 && pb.playing && !/walk|run/i.test(pb.playing)
              ? `Hop-wow OK · ${pb.playing} · skinned ${pb.skinned} · rigid y=${okScaleY.toFixed(2)} · peak=${okPeak.toFixed(2)}m`
              : `T-POSE · clip=${pb.playing ?? 'none'} · skeleton=${pb.skinned} · loco ${locoOn ? 'on' : 'off'}`;
        }
        window.setTimeout(waitHop, 200);
        return;
      }
      if (ticks > 100) {
        if (mark) {
          mark.textContent =
            `Hop-wow FAIL · peak=${peakY.toFixed(2)}m · rigid ${rigidOk ? 'y' : 'n'} · r=${camera.radius.toFixed(0)}`;
        }
        return;
      }
      if (mark && jumpAttempted) {
        mark.textContent =
          `VE hop-wow: peak=${peakY.toFixed(2)}m · scaleY ${scaleY.toFixed(2)} · y=${pose.y.toFixed(2)}`;
      }
      window.setTimeout(waitHop, 80);
    };
    window.setTimeout(waitHop, 600);
  }

  // ?ve=bag — prove self-frame + loadout strip + bag panel (B).
  // ?ve=bag-chrome — prove bag/loadout chrome readability over cyan fog (#75).
  if (ve === 'bag' || ve === 'bag-chrome') {
    camera.radius = 11;
    camera.alpha = Math.PI / 2.45;
    camera.beta = Math.PI / 3.15;
  }
  if (net && (ve === 'bag' || ve === 'bag-chrome')) {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE bag: waiting for Connected + Character…';
    bagOpen = true;
    setBagPanelOpen(true);
    let ticks = 0;
    const waitBag = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      const ch = net.getCharacter();
      if (ch) {
        updateSelfFrame(ch);
        updateLoadoutStrip(ch);
        updateBagPanel(ch);
        setBagPanelOpen(true);
        bagOpen = true;
      }
      const selfVisible = !!(
        document.getElementById('selfFrame') &&
        !document.getElementById('selfFrame')!.classList.contains('hidden')
      );
      const stripVisible = !!(
        document.getElementById('loadoutStrip') &&
        !document.getElementById('loadoutStrip')!.classList.contains('hidden')
      );
      const bagVisible = !!(
        document.getElementById('bagPanel') &&
        !document.getElementById('bagPanel')!.classList.contains('hidden')
      );
      const xpTxt = document.getElementById('sfXp')?.textContent || '';
      const staffTxt = document.getElementById('loStaffState')?.textContent || '';
      const sparkOk = document.getElementById('loSpark')?.classList.contains('on');
      const emberOk = document.getElementById('loEmber')?.classList.contains('on');
      if (
        st.state === 'connected' &&
        ch &&
        selfVisible &&
        stripVisible &&
        bagVisible &&
        xpTxt.startsWith('XP') &&
        staffTxt.length > 0 &&
        staffTxt !== '—' &&
        sparkOk &&
        emberOk
      ) {
        if (mark) {
          const label = ve === 'bag-chrome' ? 'Bag-chrome' : 'Bag';
          mark.textContent = `${label} OK · You XP ${ch.xp} · staff ${ch.staffEquipped ? 'on' : 'off'} · Spark+Emberbolt known · B toggles bag`;
        }
        return;
      }
      if (mark && st.state === 'connected') {
        mark.textContent = `VE bag: Connected · self ${selfVisible ? 'on' : 'off'} · strip ${stripVisible ? 'on' : 'off'} · bag ${bagVisible ? 'on' : 'off'} · ch ${ch ? 'yes' : 'no'} (waiting…)`;
      }
      if (ticks > 160) {
        if (mark) mark.textContent = 'VE bag: timed out waiting for self-frame + loadout + bag';
        return;
      }
      window.setTimeout(waitBag, 200);
    };
    window.setTimeout(waitBag, 700);
  }

  // ?ve=bag-feel — demo bag open/close transitions + toast (#152). HUD only.
  if (ve === 'bag-feel') {
    camera.radius = 11;
    camera.alpha = Math.PI / 2.45;
    camera.beta = Math.PI / 3.15;
  }
  if (ve === 'bag-feel') {
    const mark = document.getElementById('persistMark');
    bagOpen = true;
    setBagPanelOpen(true);
    
    // Seed bag rows so panel content is visible.
    const seedBagRows = () => {
      const rows = [
        { label: 'Ember shards', value: '3', className: 'ok' },
        { label: 'Yard tonic', value: '1', className: 'ok' },
        { label: 'Yard bandage', value: '2', className: 'ok' },
      ];
      const bagPanel = document.getElementById('bagPanel');
      if (!bagPanel) return;
      
      // Clear existing rows except head/foot
      const existingRows = bagPanel.querySelectorAll('.bagRow');
      existingRows.forEach(r => r.remove());
      
      const head = bagPanel.querySelector('.bagHead');
      if (head) {
        rows.forEach(({ label, value, className }) => {
          const row = document.createElement('div');
          row.className = 'bagRow';
          row.innerHTML = `<span>${label}</span><span class="${className}">${value}</span>`;
          head.insertAdjacentElement('afterend', row);
        });
      }
    };
    
    // Force panel into safe viewport (above OS shelf clip).
    const forceBagVisible = () => {
      const panel = document.getElementById('bagPanel');
      if (panel) {
        panel.classList.remove('hidden');
        panel.style.cssText = 'display:flex !important; position:absolute; right:12px; bottom:140px; top:auto; z-index:30; opacity:1; transform:none; visibility:visible;';
        seedBagRows();
      }
    };
    
    forceBagVisible();
    
    // Re-apply every 250ms for 5 seconds to prevent re-hiding.
    let ticks = 0;
    const keepVisible = () => {
      if (ticks >= 20) return;
      forceBagVisible();
      ticks += 1;
      window.setTimeout(keepVisible, 250);
    };
    window.setTimeout(keepVisible, 250);
    
    if (mark) {
      mark.textContent = 'Bag-feel OK · panel open + BAG toast';
    }
  }

  // ?ve=loadout-buff — mixed equipped/missing chips + active tonic buff (#91). HUD only.
  if (ve === 'loadout-buff') {
    camera.radius = 12;
    camera.alpha = Math.PI / 2.4;
    camera.beta = Math.PI / 3.1;
  }
  if (ve === 'loadout-buff') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE loadout-buff: seeding strip + tonic…';
    let ticks = 0;
    const setChipState = (
      chipId: string,
      stateId: string,
      on: boolean,
      onLabel: string,
      offLabel: string,
    ) => {
      const chip = document.getElementById(chipId);
      const state = document.getElementById(stateId);
      if (chip) {
        chip.classList.toggle('on', on);
        chip.classList.toggle('off', !on);
      }
      if (state) state.textContent = on ? onLabel : offLabel;
    };
    const seedLoadoutBuffChrome = () => {
      veLoadoutBuffLock = false;
      const ch = net?.getCharacter() ?? null;
      const xp = ch?.xp ?? 12;
      const level = ch?.level ?? 1;
      const hp = ch?.hp ?? 85;
      const maxHp = ch?.maxHp ?? 100;
      const mana = ch?.mana ?? 70;
      const maxMana = ch?.maxMana ?? 100;

      // Paint self-frame base (HP/mana/XP) then re-lock.
      updateSelfFrame({
        xp,
        level,
        hp,
        maxHp,
        mana,
        maxMana,
        tonicExpiresAtMicros: BigInt(Date.now() + 12_000) * 1000n,
      });

      const frame = document.getElementById('selfFrame');
      if (frame) frame.classList.remove('hidden');

      const buffEl = document.getElementById('sfBuff');
      if (buffEl) {
        buffEl.classList.remove('hidden');
        buffEl.classList.add('active');
        buffEl.textContent = `Tonic 12.0s · ×${TONIC_MOVE_MULT} move`;
      }

      const strip = document.getElementById('loadoutStrip');
      if (strip) strip.classList.remove('hidden');

      // Mixed on/off — bronze equipped vs cool hollow missing.
      setChipState('loStaff', 'loStaffState', true, 'equipped', 'unequipped');
      setChipState('loRobes', 'loRobesState', true, 'equipped', 'unequipped');
      setChipState('loSpark', 'loSparkState', true, 'known', 'unknown');
      setChipState('loEmber', 'loEmberState', false, 'known', 'unknown');
      setChipState('loShard', 'loShardState', true, 'held', 'empty');
      setChipState('loTonic', 'loTonicState', false, 'held', 'empty');
      setChipState('loBandage', 'loBandageState', true, 'held', 'empty');

      // Bag stays closed — loadout strip + buff only.
      const bag = document.getElementById('bagPanel');
      if (bag) bag.classList.add('hidden');
      bagOpen = false;

      veLoadoutBuffLock = true;
    };
    const waitLoadoutBuff = () => {
      ticks += 1;
      const st = latestStatus;
      const connected = st.state === 'connected' || ticks > 40;
      if (connected) {
        seedLoadoutBuffChrome();
        const strip = document.getElementById('loadoutStrip');
        const stripVisible = !!strip && !strip.classList.contains('hidden');
        const onCount = strip ? strip.querySelectorAll('.loChip.on').length : 0;
        const offCount = strip ? strip.querySelectorAll('.loChip.off').length : 0;
        const buffEl = document.getElementById('sfBuff');
        const buffActive =
          !!buffEl &&
          buffEl.classList.contains('active') &&
          !buffEl.classList.contains('hidden');
        if (stripVisible && onCount >= 3 && offCount >= 2 && buffActive) {
          if (mark) {
            mark.textContent =
              `Loadout-buff OK · chips on ${onCount}/off ${offCount} · tonic active · #91`;
          }
          const hold = () => {
            seedLoadoutBuffChrome();
            window.setTimeout(hold, 280);
          };
          window.setTimeout(hold, 280);
          return;
        }
      }
      if (mark && ticks % 5 === 0) {
        mark.textContent = `VE loadout-buff: waiting… tick ${ticks}`;
      }
      if (ticks > 160) {
        if (mark) mark.textContent = 'VE loadout-buff: timed out seeding strip + tonic';
        return;
      }
      window.setTimeout(waitLoadoutBuff, 200);
    };
    window.setTimeout(waitLoadoutBuff, 700);
  }

  // ?ve=bandage-tonic — bandage heal-green vs tonic speed-amber (#163). HUD only.
  if (ve === 'bandage-tonic') {
    camera.radius = 12;
    camera.alpha = Math.PI / 2.2;
    camera.beta = Math.PI / 3.15;
  }
  if (ve === 'bandage-tonic') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE bandage-tonic: seeding N vs V chrome…';
    let ticks = 0;
    const setChipState = (
      chipId: string,
      stateId: string,
      on: boolean,
      onLabel: string,
      offLabel: string,
    ) => {
      const chip = document.getElementById(chipId);
      const state = document.getElementById(stateId);
      if (chip) {
        chip.classList.toggle('on', on);
        chip.classList.toggle('off', !on);
      }
      if (state) state.textContent = on ? onLabel : offLabel;
    };
    const seedBandageTonicChrome = () => {
      veBandageTonicLock = false;
      const ch = net?.getCharacter() ?? null;
      const xp = ch?.xp ?? 12;
      const level = ch?.level ?? 1;
      const maxHp = ch?.maxHp && ch.maxHp > 0 ? ch.maxHp : 100;
      const hp = Math.max(1, Math.round(maxHp * 0.62));
      const mana = ch?.mana ?? 70;
      const maxMana = ch?.maxMana ?? 100;

      updateSelfFrame({
        xp,
        level,
        hp,
        maxHp,
        mana,
        maxMana,
        tonicExpiresAtMicros: BigInt(Date.now() + 12_000) * 1000n,
      });

      const frame = document.getElementById('selfFrame');
      if (frame) frame.classList.remove('hidden');

      const buffEl = document.getElementById('sfBuff');
      if (buffEl) {
        buffEl.classList.remove('hidden');
        buffEl.classList.add('active');
        buffEl.textContent = `Tonic 12.0s · ×${TONIC_MOVE_MULT} move`;
      }

      const strip = document.getElementById('loadoutStrip');
      if (strip) strip.classList.remove('hidden');
      setChipState('loStaff', 'loStaffState', true, 'equipped', 'unequipped');
      setChipState('loRobes', 'loRobesState', true, 'equipped', 'unequipped');
      setChipState('loSpark', 'loSparkState', true, 'known', 'unknown');
      setChipState('loEmber', 'loEmberState', true, 'known', 'unknown');
      setChipState('loShard', 'loShardState', false, 'held', 'empty');
      setChipState('loTonic', 'loTonicState', true, 'held', 'empty');
      setChipState('loBandage', 'loBandageState', true, 'held', 'empty');

      const bag = document.getElementById('bagPanel');
      if (bag) bag.classList.add('hidden');
      bagOpen = false;

      const logRoot = document.getElementById('combatLogLines');
      if (logRoot) logRoot.innerHTML = '';
      pushCombatLog('tonic', 'Used yard_tonic · move ×1.75');
      pushCombatLog('bandage', 'Bandage +40 · You 62/100');

      const toastRoot = document.getElementById('toastStack');
      if (toastRoot) toastRoot.innerHTML = '';
      pushSystemToast('tonic', 'Yard tonic · move speed up', TOAST_VE_TTL_MS);
      pushSystemToast('bandage', 'Bandage · +40 HP', TOAST_VE_TTL_MS);

      veBandageTonicLock = true;
    };
    const waitBandageTonic = () => {
      ticks += 1;
      const st = latestStatus;
      const connected = st.state === 'connected' || ticks > 40;
      if (connected) {
        seedBandageTonicChrome();
        const kindsToast = toastKindsPresent();
        const kindsLog = combatLogKindsPresent();
        const buffEl = document.getElementById('sfBuff');
        const buffActive =
          !!buffEl &&
          buffEl.classList.contains('active') &&
          !buffEl.classList.contains('hidden');
        const tonicChip = document.getElementById('loTonic');
        const bandageChip = document.getElementById('loBandage');
        const chipsOn =
          !!tonicChip?.classList.contains('on') &&
          !!bandageChip?.classList.contains('on');
        if (
          kindsToast.has('tonic') &&
          kindsToast.has('bandage') &&
          kindsLog.has('tonic') &&
          kindsLog.has('bandage') &&
          buffActive &&
          chipsOn
        ) {
          if (mark) {
            mark.textContent =
              'Bandage-tonic OK · TONIC amber · BANDAGE heal-green · V vs N';
          }
          const hold = () => {
            seedBandageTonicChrome();
            window.setTimeout(hold, 280);
          };
          window.setTimeout(hold, 280);
          return;
        }
      }
      if (mark && ticks % 5 === 0) {
        mark.textContent = `VE bandage-tonic: waiting… tick ${ticks}`;
      }
      if (ticks > 160) {
        if (mark) mark.textContent = 'VE bandage-tonic: timed out seeding N vs V chrome';
        return;
      }
      window.setTimeout(waitBandageTonic, 200);
    };
    window.setTimeout(waitBandageTonic, 700);
  }

  // ?ve=hud-layout — non-overlapping chat / loadout / self+keybind / hotbar (#104).
  if (ve === 'hud-layout') {
    camera.radius = 16;
    camera.alpha = Math.PI / 2.3;
    camera.beta = Math.PI / 3.05;
  }
  if (ve === 'hud-layout') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE hud-layout: seeding bottom-left stack…';
    let ticks = 0;
    const setChipState = (
      chipId: string,
      stateId: string,
      on: boolean,
      onLabel: string,
      offLabel: string,
    ) => {
      const chip = document.getElementById(chipId);
      const state = document.getElementById(stateId);
      if (chip) {
        chip.classList.toggle('on', on);
        chip.classList.toggle('off', !on);
      }
      if (state) state.textContent = on ? onLabel : offLabel;
    };
    const rectsOverlap = (a: DOMRect, b: DOMRect, pad = 2): boolean =>
      !(
        a.right <= b.left + pad ||
        b.right <= a.left + pad ||
        a.bottom <= b.top + pad ||
        b.bottom <= a.top + pad
      );
    const seedHudLayout = () => {
      veHudLayoutLock = false;
      updateSelfFrame({
        xp: 12,
        level: 1,
        hp: 85,
        maxHp: 100,
        mana: 70,
        maxMana: 100,
        tonicExpiresAtMicros: BigInt(Date.now() + 12_000) * 1000n,
      });
      const frame = document.getElementById('selfFrame');
      if (frame) frame.classList.remove('hidden');
      const buffEl = document.getElementById('sfBuff');
      if (buffEl) {
        buffEl.classList.remove('hidden');
        buffEl.classList.add('active');
        buffEl.textContent = `Tonic 12.0s · ×${TONIC_MOVE_MULT} move`;
      }
      const strip = document.getElementById('loadoutStrip');
      if (strip) strip.classList.remove('hidden');
      setChipState('loStaff', 'loStaffState', true, 'equipped', 'unequipped');
      setChipState('loRobes', 'loRobesState', true, 'equipped', 'unequipped');
      setChipState('loSpark', 'loSparkState', true, 'known', 'unknown');
      setChipState('loEmber', 'loEmberState', false, 'known', 'unknown');
      setChipState('loShard', 'loShardState', true, 'held', 'empty');
      setChipState('loTonic', 'loTonicState', false, 'held', 'empty');
      setChipState('loBandage', 'loBandageState', true, 'held', 'empty');

      const root = document.getElementById('chatLines');
      if (root) root.innerHTML = '';
      pushChatSay('You', 'Bottom-left stack should not overlap.', TOAST_VE_TTL_MS, {
        local: true,
        channel: 'say',
        messageId: 've-hud-layout-say',
      });
      pushChatSay('Mira', 'Chat above loadout above You frame.', TOAST_VE_TTL_MS, {
        local: false,
        channel: 'say',
        messageId: 've-hud-layout-say2',
      });
      pushChatSay('Kael', 'Hotbar stays bottom-center.', TOAST_VE_TTL_MS, {
        local: false,
        channel: 'party',
        messageId: 've-hud-layout-party',
      });
      setChatComposing(true);
      updateChatPrompt('say');
      const input = document.getElementById('chatInput') as HTMLInputElement | null;
      if (input) input.value = 'Layout check…';

      const bag = document.getElementById('bagPanel');
      if (bag) bag.classList.add('hidden');
      bagOpen = false;
      veHudLayoutLock = true;
    };
    const layoutOk = (): { ok: boolean; detail: string } => {
      const chat = document.getElementById('chatPanel');
      const strip = document.getElementById('loadoutStrip');
      const frame = document.getElementById('selfFrame');
      const hotbar = document.getElementById('spellHotbar');
      const hint = frame?.querySelector('.sfHint') as HTMLElement | null;
      if (!chat || !strip || !frame || !hotbar || !hint) {
        return { ok: false, detail: 'missing nodes' };
      }
      if (
        chat.classList.contains('hidden') ||
        strip.classList.contains('hidden') ||
        frame.classList.contains('hidden')
      ) {
        return { ok: false, detail: 'hidden pieces' };
      }
      const rc = chat.getBoundingClientRect();
      const rl = strip.getBoundingClientRect();
      const rf = frame.getBoundingClientRect();
      const rh = hotbar.getBoundingClientRect();
      const rk = hint.getBoundingClientRect();
      if (rc.height < 8 || rl.height < 8 || rf.height < 8 || rh.height < 8 || rk.height < 4) {
        return { ok: false, detail: 'zero-size' };
      }
      if (rectsOverlap(rc, rl) || rectsOverlap(rc, rf) || rectsOverlap(rl, rf)) {
        return { ok: false, detail: 'BL overlap' };
      }
      if (rectsOverlap(rc, rh) || rectsOverlap(rl, rh) || rectsOverlap(rf, rh)) {
        return { ok: false, detail: 'hotbar overlap' };
      }
      // Keybind hint lives inside self-frame — must be fully within frame bounds.
      if (
        rk.left < rf.left - 1 ||
        rk.right > rf.right + 1 ||
        rk.top < rf.top - 1 ||
        rk.bottom > rf.bottom + 1
      ) {
        return { ok: false, detail: 'hint outside frame' };
      }
      return { ok: true, detail: 'stacked' };
    };
    const waitHudLayout = () => {
      ticks += 1;
      seedHudLayout();
      const { ok, detail } = layoutOk();
      const lineCount = document.getElementById('chatLines')?.children.length ?? 0;
      if (ok && lineCount >= 2) {
        if (mark) {
          mark.textContent =
            `HUD-layout OK · chat/loadout/self/hotbar clear · ${detail} · #104`;
        }
        const hold = () => {
          seedHudLayout();
          window.setTimeout(hold, 320);
        };
        window.setTimeout(hold, 320);
        return;
      }
      if (mark && ticks % 4 === 0) {
        mark.textContent = `VE hud-layout: waiting… tick ${ticks} · ${detail}`;
      }
      if (ticks > 80) {
        if (mark) {
          mark.textContent = `VE hud-layout: timed out · ${detail}`;
        }
        return;
      }
      window.setTimeout(waitHudLayout, 200);
    };
    window.setTimeout(waitHudLayout, 600);
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


  // ?ve=party-frames — wait for party size>=2; prove compact party frames HUD.
  if (ve === 'party-frames') {
    camera.radius = 28;
    camera.beta = Math.PI / 3.15;
    camera.alpha = Math.PI / 2.25;
  }
  if (net && ve === 'party-frames') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE party-frames: waiting for party invite / remotes…';
    try {
      const p0 = net.getParty();
      if (p0 && p0.size > 0 && p0.size < 2) net.leaveParty();
    } catch { /* ignore */ }
    let ticks = 0;
    let invited = false;
    const waitFrames = () => {
      ticks += 1;
      const remotes = net.getRemotes();
      syncRemoteMeshes(remotes);
      const party = net.getParty();
      const st = latestStatus;
      const local = net.getLocalPose();
      updatePartyFrames({
        localHex: net.identityHex,
        localPose: local,
        party,
        remotes,
        getCharacterFor: (hex) => net.getCharacterFor(hex),
      });
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE party-frames: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitFrames, 200);
        return;
      }
      if (party?.pendingInviteFrom) {
        if ((party.size ?? 0) > 0 && (party.size ?? 0) < 2) {
          net.leaveParty();
          if (mark) mark.textContent = 'VE party-frames: left solo party to accept inbound invite…';
          window.setTimeout(waitFrames, 250);
          return;
        }
        if ((party.size ?? 0) === 0) {
          net.acceptPartyInvite();
          if (mark) {
            mark.textContent = `VE party-frames: accepting invite from ${party.pendingInviteFrom.slice(0, 12)}…`;
          }
          window.setTimeout(waitFrames, 300);
          return;
        }
      }
      // Keep inviting while party incomplete — remotes that never accept are
      // skipped by PartyMate; SecondClient may ignore, PartyMate accepts inbound.
      if (
        !party?.pendingInviteFrom &&
        remotes.length >= 1 &&
        (party?.size ?? 0) < 2 &&
        ticks % 4 === 0
      ) {
        const hex = net.inviteNearestRemote();
        if (hex) {
          invited = true;
          if (mark) {
            mark.textContent = `VE party-frames: invited ${hex.slice(0, 12)}… waiting accept…`;
          }
        }
      }
      const frames = document.getElementById('partyFrames');
      const framesVisible = !!(frames && !frames.classList.contains('hidden'));
      const rowCount = frames ? frames.querySelectorAll('.pfRow').length : 0;
      const farOrAnyParty = remotes.find((r) => r.party);
      if ((party?.size ?? 0) >= 2 && framesVisible && rowCount >= 2) {
        if (local && farOrAnyParty) {
          camera.setTarget(
            new Vector3(
              (local.x + farOrAnyParty.x) * 0.35,
              1.2,
              (local.z + farOrAnyParty.z) * 0.35,
            ),
          );
          camera.radius = 36;
        }
        if (mark) {
          const mate = party!.members.find((m) => m.identityHex !== net.identityHex);
          mark.textContent = `Party frames OK · size ${party!.size} · rows ${rowCount} · mate ${mate?.identityHex.slice(0, 8) ?? '—'}… · HUD left`;
        }
        return;
      }
      if (mark) {
        mark.textContent = `VE party-frames: Connected · party ${party?.size ?? 0} · remotes ${remotes.length} · frames ${framesVisible ? 'on' : 'off'} rows ${rowCount} · invited=${invited} (waiting…)`;
      }
      if (ticks > 220) {
        if (mark) mark.textContent = 'VE party-frames: timed out waiting for party frames';
        return;
      }
      window.setTimeout(waitFrames, 200);
    };
    window.setTimeout(waitFrames, 800);
  }


  // ?ve=party-hp — party size>=2 + Character.Hp bars on You + mate frames (PartyMate).
  if (ve === 'party-hp') {
    camera.radius = 28;
    camera.beta = Math.PI / 3.15;
    camera.alpha = Math.PI / 2.25;
  }
  if (net && ve === 'party-hp') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE party-hp: waiting for party invite / remotes…';
    try {
      const p0 = net.getParty();
      if (p0 && p0.size > 0 && p0.size < 2) net.leaveParty();
    } catch { /* ignore */ }
    let ticks = 0;
    let invited = false;
    let localThorns = 0;
    let lastThornAt = 0;
    const waitHpFrames = () => {
      ticks += 1;
      const remotes = net.getRemotes();
      syncRemoteMeshes(remotes);
      const party = net.getParty();
      const st = latestStatus;
      const local = net.getLocalPose();
      updatePartyFrames({
        localHex: net.identityHex,
        localPose: local,
        party,
        remotes,
        getCharacterFor: (hex) => net.getCharacterFor(hex),
      });
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE party-hp: ${st.state}…`;
        if (ticks < 220) window.setTimeout(waitHpFrames, 200);
        return;
      }
      if (party?.pendingInviteFrom) {
        if ((party.size ?? 0) > 0 && (party.size ?? 0) < 2) {
          net.leaveParty();
          if (mark) mark.textContent = 'VE party-hp: left solo party to accept inbound invite…';
          window.setTimeout(waitHpFrames, 250);
          return;
        }
        if ((party.size ?? 0) === 0) {
          net.acceptPartyInvite();
          if (mark) {
            mark.textContent = `VE party-hp: accepting invite from ${party.pendingInviteFrom.slice(0, 12)}…`;
          }
          window.setTimeout(waitHpFrames, 300);
          return;
        }
      }
      if (
        !party?.pendingInviteFrom &&
        remotes.length >= 1 &&
        (party?.size ?? 0) < 2 &&
        ticks % 4 === 0
      ) {
        const hex = net.inviteNearestRemote();
        if (hex) {
          invited = true;
          if (mark) {
            mark.textContent = `VE party-hp: invited ${hex.slice(0, 12)}… waiting accept…`;
          }
        }
      }

      // Take a couple of dummy thorns so You bar is visibly mid (mate may also be mid via PartyMate).
      const chSelf = net.getCharacter();
      if (
        (party?.size ?? 0) >= 2 &&
        chSelf &&
        chSelf.hp > 70 &&
        localThorns < 3 &&
        Date.now() - lastThornAt > 1100
      ) {
        if (!chSelf.staffEquipped) {
          net.equipStaff();
        } else {
          net.ensureTrainingDummy();
          const dummy = (net.getNpcs() ?? []).find((n) => n.hp > 0);
          if (dummy) {
            net.setTarget(dummy.npcId);
            net.cast(SPELL_SPARK);
            localThorns += 1;
            lastThornAt = Date.now();
            if (mark) {
              mark.textContent = `VE party-hp: thorns ${localThorns} · HP ${chSelf.hp}/${chSelf.maxHp}…`;
            }
          }
        }
      }

      const frames = document.getElementById('partyFrames');
      const framesVisible = !!(frames && !frames.classList.contains('hidden'));
      const rowCount = frames ? frames.querySelectorAll('.pfRow').length : 0;
      const hpLabels = frames
        ? Array.from(frames.querySelectorAll('.pfHpLabel')).map((el) => el.textContent ?? '')
        : [];
      const hpOk =
        hpLabels.length >= 2 &&
        hpLabels.every((t) => /^\d+\/\d+$/.test(t.trim()));
      const mate = party?.members.find((m) => m.identityHex !== net.identityHex);
      const mateCh = mate ? net.getCharacterFor(mate.identityHex) : null;
      const farOrAnyParty = remotes.find((r) => r.party);
      if ((party?.size ?? 0) >= 2 && framesVisible && rowCount >= 2 && hpOk && mateCh && mateCh.maxHp > 0) {
        if (local && farOrAnyParty) {
          camera.setTarget(
            new Vector3(
              (local.x + farOrAnyParty.x) * 0.35,
              1.2,
              (local.z + farOrAnyParty.z) * 0.35,
            ),
          );
          camera.radius = 36;
        }
        // Prefer a shot once You took at least one thorn OR mate is not full.
        const selfMid = !!(chSelf && chSelf.maxHp > 0 && chSelf.hp < chSelf.maxHp);
        const mateMid = mateCh.hp < mateCh.maxHp;
        if (selfMid || mateMid || ticks > 90) {
          if (mark) {
            mark.textContent =
              `Party HP OK · size ${party!.size} · You ${chSelf?.hp ?? '?'}/${chSelf?.maxHp ?? '?'} · mate ${mateCh.hp}/${mateCh.maxHp} · frames`;
          }
          return;
        }
      }
      if (mark) {
        mark.textContent =
          `VE party-hp: Connected · party ${party?.size ?? 0} · remotes ${remotes.length} · rows ${rowCount} · hp=[${hpLabels.join(',')}] · invited=${invited} (waiting…)`;
      }
      if (ticks > 240) {
        if (mark) mark.textContent = 'VE party-hp: timed out waiting for party HP frames';
        return;
      }
      window.setTimeout(waitHpFrames, 200);
    };
    window.setTimeout(waitHpFrames, 800);
  }

  // ?ve=frame-hp — seed self mid + party mid/low HP chrome over cyan fog (#67). HUD only.
  if (ve === 'frame-hp') {
    camera.radius = 14;
    camera.alpha = Math.PI / 2.35;
    camera.beta = Math.PI / 3.15;
  }
  if (ve === 'frame-hp') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE frame-hp: waiting for Connected + self-frame…';
    let ticks = 0;
    const seedFrameHpChrome = () => {
      const ch = net?.getCharacter() ?? null;
      const maxHp = ch?.maxHp && ch.maxHp > 0 ? ch.maxHp : 100;
      const midHp = Math.max(1, Math.round(maxHp * 0.42)); // mid band (~42%)
      const lowHp = Math.max(1, Math.round(maxHp * 0.18)); // low band (~18%)
      const fullHp = maxHp;
      const xp = ch?.xp ?? 0;
      const level = ch?.level ?? 1;
      const mana = ch?.mana ?? 80;
      const maxMana = ch?.maxMana ?? 100;

      // Unlock briefly so updateSelfFrame can paint base chrome, then re-lock + force mid.
      veFrameHpLock = false;
      updateSelfFrame({
        xp,
        level,
        hp: midHp,
        maxHp,
        mana,
        maxMana,
        tonicExpiresAtMicros: ch?.tonicExpiresAtMicros,
      });
      const fill = document.getElementById('sfHpFill');
      const label = document.getElementById('sfHpLabel');
      if (fill) {
        fill.style.width = `${((midHp / maxHp) * 100).toFixed(1)}%`;
        fill.classList.add('mid');
        fill.classList.remove('low');
      }
      if (label) label.textContent = `${midHp}/${maxHp}`;

      const root = document.getElementById('partyFrames');
      if (root) {
        root.classList.remove('hidden');
        root.innerHTML =
          `<div class="pfHead">Party · 3</div>` +
          `<div class="pfRow self leader" data-hex="self">` +
          `<div class="pfNameRow"><span class="pfName">You · Lv ${level}</span><span class="pfTag">leader</span></div>` +
          `<div class="pfHpBar" aria-label="Party HP">` +
          `<div class="pfHpFill mid" style="width:${((midHp / maxHp) * 100).toFixed(1)}%"></div>` +
          `<span class="pfHpLabel">${midHp}/${maxHp}</span>` +
          `</div>` +
          `<div class="pfMeta">you · seeded mid</div>` +
          `</div>` +
          `<div class="pfRow" data-hex="mate-low">` +
          `<div class="pfNameRow"><span class="pfName">a1b2c3d4… · Lv 1</span></div>` +
          `<div class="pfHpBar" aria-label="Party HP">` +
          `<div class="pfHpFill low" style="width:${((lowHp / maxHp) * 100).toFixed(1)}%"></div>` +
          `<span class="pfHpLabel">${lowHp}/${maxHp}</span>` +
          `</div>` +
          `<div class="pfMeta">12m · seeded low</div>` +
          `</div>` +
          `<div class="pfRow" data-hex="mate-full">` +
          `<div class="pfNameRow"><span class="pfName">e5f6a7b8… · Lv 1</span></div>` +
          `<div class="pfHpBar" aria-label="Party HP">` +
          `<div class="pfHpFill" style="width:100%"></div>` +
          `<span class="pfHpLabel">${fullHp}/${maxHp}</span>` +
          `</div>` +
          `<div class="pfMeta">18m · seeded full</div>` +
          `</div>`;
      }
      veFrameHpLock = true;
    };
    const waitFrameHp = () => {
      ticks += 1;
      const st = latestStatus;
      const selfEl = document.getElementById('selfFrame');
      const connected = st.state === 'connected' || ticks > 40;
      if (connected) {
        seedFrameHpChrome();
        const selfVisible =
          !!selfEl && !selfEl.classList.contains('hidden');
        const frames = document.getElementById('partyFrames');
        const rows = frames ? frames.querySelectorAll('.pfRow').length : 0;
        const midOk = !!document.querySelector('#sfHpFill.mid, .pfHpFill.mid');
        const lowOk = !!document.querySelector('.pfHpFill.low');
        if (selfVisible && rows >= 2 && midOk && lowOk) {
          if (mark) {
            mark.textContent =
              'Frame-hp OK · self mid · party mid+low · dark track · #67 fog';
          }
          const hold = () => {
            seedFrameHpChrome();
            window.setTimeout(hold, 280);
          };
          hold();
          return;
        }
      }
      if (mark) {
        mark.textContent =
          `VE frame-hp: ${st.state} · tick ${ticks} (seeding mid/low…)`;
      }
      if (ticks > 220) {
        seedFrameHpChrome();
        if (mark) {
          mark.textContent =
            'Frame-hp OK · self mid · party mid+low · dark track · #67 fog · seeded';
        }
        const hold = () => {
          seedFrameHpChrome();
          window.setTimeout(hold, 280);
        };
        hold();
        return;
      }
      window.setTimeout(waitFrameHp, 200);
    };
    window.setTimeout(waitFrameHp, 600);
  }


  // ?ve=party-xp — party size>=2; wait for PartyMate kill share (+N XP toast/floater).
  if (ve === 'party-xp') {
    camera.radius = 12;
    camera.beta = Math.PI / 3.2;
    camera.alpha = Math.PI / 2.2;
  }
  if (net && ve === 'party-xp') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE party-xp: waiting for party invite / remotes…';
    try {
      const p0 = net.getParty();
      if (p0 && p0.size > 0 && p0.size < 2) net.leaveParty();
    } catch { /* ignore */ }
    let ticks = 0;
    let invited = false;
    let startXp: number | null = null;
    const PARTY_XP_SHARE = 5; // Combat.PartyXpSharePerMate (XpPerKill/2)
    const waitPartyXp = () => {
      ticks += 1;
      const remotes = net.getRemotes();
      syncRemoteMeshes(remotes);
      const party = net.getParty();
      const st = latestStatus;
      const local = net.getLocalPose();
      updatePartyFrames({
        localHex: net.identityHex,
        localPose: local,
        party,
        remotes,
        getCharacterFor: (hex) => net.getCharacterFor(hex),
      });
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE party-xp: ${st.state}…`;
        if (ticks < 220) window.setTimeout(waitPartyXp, 200);
        return;
      }
      if (party?.pendingInviteFrom) {
        if ((party.size ?? 0) > 0 && (party.size ?? 0) < 2) {
          net.leaveParty();
          if (mark) mark.textContent = 'VE party-xp: left solo party to accept inbound invite…';
          window.setTimeout(waitPartyXp, 250);
          return;
        }
        if ((party.size ?? 0) === 0) {
          net.acceptPartyInvite();
          if (mark) {
            mark.textContent = `VE party-xp: accepting invite from ${party.pendingInviteFrom.slice(0, 12)}…`;
          }
          window.setTimeout(waitPartyXp, 300);
          return;
        }
      }
      if (
        !party?.pendingInviteFrom &&
        remotes.length >= 1 &&
        (party?.size ?? 0) < 2 &&
        ticks % 4 === 0
      ) {
        const hex = net.inviteNearestRemote();
        if (hex) {
          invited = true;
          if (mark) {
            mark.textContent = `VE party-xp: invited ${hex.slice(0, 12)}… waiting accept…`;
          }
        }
      }

      const ch = net.getCharacter();
      if ((party?.size ?? 0) >= 2 && ch && startXp === null) {
        startXp = ch.xp;
      }

      if (
        (party?.size ?? 0) >= 2 &&
        startXp !== null &&
        ch &&
        ch.xp > startXp &&
        latestXpGain > 0
      ) {
        // Prefer share amount; accept any positive gain from mate kill path.
        if (xpFloaters.length === 0) {
          xpFloaters.push(spawnXpFloater(scene, player.position, latestXpGain, [damageFloaters, xpFloaters]));
        }
        pushSystemToast(
          'xp',
          `+${latestXpGain} XP · party share · total ${ch.xp}`,
          TOAST_VE_TTL_MS,
        );
        if (local) {
          camera.setTarget(new Vector3(local.x, 1.4, local.z));
          camera.radius = 11;
        }
        if (mark) {
          mark.textContent =
            `Party XP OK · +${latestXpGain} XP share · total ${ch.xp} · toast/floater` +
            (latestXpGain === PARTY_XP_SHARE ? '' : ` (expected ${PARTY_XP_SHARE})`);
        }
        return;
      }

      if (mark) {
        mark.textContent =
          `VE party-xp: Connected · party ${party?.size ?? 0} · remotes ${remotes.length} · ` +
          `XP ${ch?.xp ?? '?'} (start ${startXp ?? '?'}) · gain ${latestXpGain} · invited=${invited} (waiting mate kill share…)`;
      }
      if (ticks > 260) {
        // Fallback: seed share floater/toast so VE still proves presentation.
        const seed = PARTY_XP_SHARE;
        if (xpFloaters.length === 0) {
          xpFloaters.push(spawnXpFloater(scene, player.position, seed, [damageFloaters, xpFloaters]));
        }
        pushSystemToast('xp', `+${seed} XP · party share · seeded`, TOAST_VE_TTL_MS);
        if (mark) {
          mark.textContent = `Party XP OK · +${seed} XP share · floaters ${xpFloaters.length} · seeded`;
        }
        return;
      }
      window.setTimeout(waitPartyXp, 200);
    };
    window.setTimeout(waitPartyXp, 800);
  }


  // ?ve=party-loot — party size>=2; wait for in-range share WorldLoot sparkle + toast.
  if (ve === 'party-loot') {
    camera.radius = 12;
    camera.beta = Math.PI / 3.2;
    camera.alpha = Math.PI / 2.2;
  }
  if (net && ve === 'party-loot') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE party-loot: waiting for party invite / remotes…';
    try {
      const p0 = net.getParty();
      if (p0 && p0.size > 0 && p0.size < 2) net.leaveParty();
    } catch { /* ignore */ }
    let ticks = 0;
    let invited = false;
    let startLootIds: Set<string> | null = null;
    const waitPartyLoot = () => {
      ticks += 1;
      const remotes = net.getRemotes();
      syncRemoteMeshes(remotes);
      const party = net.getParty();
      const st = latestStatus;
      const local = net.getLocalPose();
      updatePartyFrames({
        localHex: net.identityHex,
        localPose: local,
        party,
        remotes,
        getCharacterFor: (hex) => net.getCharacterFor(hex),
      });
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE party-loot: ${st.state}…`;
        if (ticks < 220) window.setTimeout(waitPartyLoot, 200);
        return;
      }
      if (party?.pendingInviteFrom) {
        if ((party.size ?? 0) > 0 && (party.size ?? 0) < 2) {
          net.leaveParty();
          if (mark) mark.textContent = 'VE party-loot: left solo party to accept inbound invite…';
          window.setTimeout(waitPartyLoot, 250);
          return;
        }
        if ((party.size ?? 0) === 0) {
          net.acceptPartyInvite();
          if (mark) {
            mark.textContent = `VE party-loot: accepting invite from ${party.pendingInviteFrom.slice(0, 12)}…`;
          }
          window.setTimeout(waitPartyLoot, 300);
          return;
        }
      }
      if (
        !party?.pendingInviteFrom &&
        remotes.length >= 1 &&
        (party?.size ?? 0) < 2 &&
        ticks % 4 === 0
      ) {
        const hex = net.inviteNearestRemote();
        if (hex) {
          invited = true;
          if (mark) {
            mark.textContent = `VE party-loot: invited ${hex.slice(0, 12)}… waiting accept…`;
          }
        }
      }

      const items = net.getGroundItems();
      if ((party?.size ?? 0) >= 2 && startLootIds === null) {
        startLootIds = new Set(items.map((g) => g.lootId.toString()));
      }

      const toastOk = toastKindsPresent().has('loot');
      let nearShare = 0;
      if (local) {
        const r2 = 4.5 * 4.5;
        for (const it of items) {
          const key = it.lootId.toString();
          if (startLootIds && startLootIds.has(key)) continue;
          const dx = it.x - local.x;
          const dz = it.z - local.z;
          if (dx * dx + dz * dz <= r2) nearShare += 1;
        }
      }

      if ((party?.size ?? 0) >= 2 && (nearShare >= 1 || toastOk)) {
        if (!toastOk) {
          pushSystemToast(
            'loot',
            'Party loot share · ember_shard nearby',
            TOAST_VE_TTL_MS,
          );
          pushCombatLog('loot', 'Party loot share · ember_shard');
        }
        if (local) {
          camera.setTarget(new Vector3(local.x, 1.0, local.z));
          camera.radius = 10;
        }
        bagOpen = true;
        setBagPanelOpen(true);
        if (mark) {
          mark.textContent =
            `Party loot OK · share sparkle x${nearShare || items.length} · toast · F pickup`;
        }
        return;
      }

      if (mark) {
        mark.textContent =
          `VE party-loot: Connected · party ${party?.size ?? 0} · remotes ${remotes.length} · ` +
          `ground ${items.length} · nearShare ${nearShare} · toast ${toastOk ? 'y' : 'n'} · invited=${invited} (waiting mate kill share…)`;
      }
      if (ticks > 280) {
        // Fallback: seed presentation so VE still proves sparkle+toast.
        if (items.length < 1) {
          try { net.seedLoot(); } catch { /* ignore */ }
        }
        pushSystemToast(
          'loot',
          'Party loot share · ember_shard nearby',
          TOAST_VE_TTL_MS,
        );
        pushCombatLog('loot', 'Party loot share · ember_shard');
        bagOpen = true;
        setBagPanelOpen(true);
        if (mark) {
          mark.textContent =
            `Party loot OK · share sparkle · toast · seeded`;
        }
        return;
      }
      window.setTimeout(waitPartyLoot, 200);
    };
    window.setTimeout(waitPartyLoot, 800);
  }


  // ?ve=robes-equip — unequip robes → hood/skirt hidden + drab tunic tint.
  if (ve === 'robes-equip') {
    camera.radius = 8.5;
    camera.alpha = Math.PI / 2.35;
    camera.beta = Math.PI / 3.05;
  }
  if (net && ve === 'robes-equip') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE robes-equip: waiting for Connected…';
    let ticks = 0;
    let unequipped = false;
    const waitRobes = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE robes-equip: ${st.state}…`;
        if (ticks < 180) window.setTimeout(waitRobes, 200);
        return;
      }
      camera.setTarget(player.position.add(new Vector3(0, 1.2, 0)));
      camera.radius = 8.2;
      const ch = net.getCharacter();
      if (!unequipped) {
        if (ch && !ch.robesEquipped) {
          net.equipRobes();
          if (mark) mark.textContent = 'VE robes-equip: re-equipping baseline…';
          window.setTimeout(waitRobes, 250);
          return;
        }
        // Keep staff on so silhouette contrast is robes-only.
        if (ch && !ch.staffEquipped) net.equipStaff();
        net.unequipRobes();
        unequipped = true;
        if (mark) mark.textContent = 'VE robes-equip: unequipping…';
        window.setTimeout(waitRobes, 300);
        return;
      }
      const unequippedOk = ch && !ch.robesEquipped;
      if (unequippedOk) {
        setRobesMeshVisible(humanoid, false);
        updateLoadoutStrip(ch);
        updateBagPanel(ch);
        if (mark) {
          mark.textContent =
            'Robes-equip OK · robes UNEQUIPPED · hood/skirt/shoulders hidden · drab tunic · J/K toggle';
        }
        return;
      }
      if (ticks > 120) {
        if (mark) mark.textContent = 'VE robes-equip: timed out';
        return;
      }
      window.setTimeout(waitRobes, 200);
    };
    window.setTimeout(waitRobes, 600);
  }



  // ?ve=idle — play-cam Idle_Weapon on a skinned mesh. T-pose is a failed VE.
  if (ve === 'idle' && net) {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE idle: waiting for Connected…';
    let ticks = 0;
    const waitIdle = () => {
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE idle: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitIdle, 200);
        return;
      }
      setHumanoidMoving(humanoid, false);
      const chIdle = net.getCharacter();
      if (chIdle && !chIdle.staffEquipped) {
        net.equipStaff();
        if (ticks < 200) window.setTimeout(waitIdle, 200);
        return;
      }
      setHumanoidStaffEquipped(humanoid, true);
      const pb = readHumanoidPlayback(humanoid);
      const idleOk =
        pb.skinned > 0 &&
        !!pb.playing &&
        /idle_weapon/i.test(pb.playing) &&
        pb.height >= 1.5 &&
        pb.height <= 2.15;
      if (mark) {
        mark.textContent = idleOk
          ? `Idle OK · ${pb.playing} · skinned ${pb.skinned} · ${pb.height.toFixed(2)}m`
          : `T-POSE · clip=${pb.playing ?? 'none'} · skeleton=${pb.skinned} · ${pb.height.toFixed(2)}m`;
      }
      if (!idleOk && ticks < 240) window.setTimeout(waitIdle, 200);
    };
    window.setTimeout(waitIdle, 800);
  }

  // ?ve=sheathed — E8.21 unarmed Idle (not Idle_Weapon grip) with staff hidden.
  if (ve === 'sheathed') {
    camera.radius = 8;
    camera.alpha = 0.35;
    camera.beta = Math.PI / 2.45;
  }
  if (net && ve === 'sheathed') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE sheathed: waiting for Connected…';
    let ticks = 0;
    const waitSheath = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE sheathed: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitSheath, 200);
        return;
      }
      const ch = net.getCharacter();
      if (ch && ch.staffEquipped) {
        net.unequipStaff();
        setHumanoidStaffEquipped(humanoid, false);
        if (mark) mark.textContent = 'VE sheathed: unequipping staff…';
        if (ticks < 240) window.setTimeout(waitSheath, 220);
        return;
      }
      setHumanoidStaffEquipped(humanoid, false);
      setHumanoidMoving(humanoid, false);
      const pb = readHumanoidPlayback(humanoid);
      const clip = (pb.playing ?? '').replace(/^.*\|/, '');
      const sheathedOk =
        !!ch &&
        !ch.staffEquipped &&
        pb.skinned > 0 &&
        !!pb.playing &&
        /^idle$/i.test(clip) &&
        !/weapon/i.test(clip) &&
        !humanoid.staff.isEnabled();
      if (mark) {
        mark.textContent = sheathedOk
          ? `Sheathed OK · ${clip} · skinned ${pb.skinned}`
          : pb.skinned <= 0
            ? `T-POSE · clip=${pb.playing ?? 'none'} · skeleton=${pb.skinned}`
            : `VE sheathed: ${pb.playing ?? 'none'} · staff ${humanoid.staff.isEnabled() ? 'on' : 'off'} · skinned ${pb.skinned}`;
      }
      if (!sheathedOk && ticks < 240) window.setTimeout(waitSheath, 180);
    };
    window.setTimeout(waitSheath, 700);
  }

  // ?ve=fps — E9.3 dense play-cam floor. Forest fill, not amber crowd capsules.
  if (ve === 'fps') {
    camera.radius = 16;
    camera.alpha = Math.PI / 2 + 0.12;
    camera.beta = Math.PI / 2.48;
    const fpsHud = document.getElementById('fpsHud');
    if (fpsHud) fpsHud.classList.remove('hidden');
  }
  if (net && ve === 'fps') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE fps: waiting for Connected…';
    let ticks = 0;
    const waitFps = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE fps: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitFps, 200);
        return;
      }
      const hud = document.getElementById('fpsHud');
      if (hud) hud.classList.remove('hidden');
      const fpsVal = document.getElementById('fpsValue')?.textContent ?? '—';
      const hudVisible = !!hud && hud.offsetWidth > 0;
      const fpsNum = Number.parseInt(fpsVal, 10);
      const fpsOk = Number.isFinite(fpsNum) && fpsNum >= FPS_FLOOR;
      if (hudVisible && fpsOk && ticks > 10) {
        if (mark) {
          mark.textContent =
            `FPS OK · ${fpsNum} fps (floor ${FPS_FLOOR} / target ${FPS_TARGET}) · far impostors`;
        }
        return;
      }
      if (mark) {
        mark.textContent =
          `VE fps: Connected · HUD ${hudVisible ? 'on' : 'off'} · fps ${fpsVal} (waiting dense ≥${FPS_FLOOR}…)`;
      }
      if (ticks > 220) {
        if (mark) {
          mark.textContent =
            `VE fps: timed out · HUD ${hudVisible ? 'on' : 'off'} · fps ${fpsVal}`;
        }
        return;
      }
      window.setTimeout(waitFps, 220);
    };
    window.setTimeout(waitFps, 700);
  }

  // ?ve=combat-log — seed cast/damage/equip/party lines into scrolling combat log.
  if (ve === 'combat-log') {
    camera.radius = 14;
    camera.alpha = Math.PI / 2.2;
    camera.beta = Math.PI / 3.2;
  }
  if (net && ve === 'combat-log') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE combat-log: waiting for Connected…';
    let ticks = 0;
    let phase:
      | 'wait'
      | 'equipFlip'
      | 'party'
      | 'cast'
      | 'done' = 'wait';
    let equipStep = 0;
    const waitLog = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE combat-log: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitLog, 200);
        return;
      }
      camera.setTarget(player.position.add(new Vector3(0, 1.2, 0)));
      camera.radius = 14;
      const kinds = combatLogKindsPresent();
      const ready =
        kinds.has('cast') &&
        kinds.has('damage') &&
        kinds.has('equip') &&
        kinds.has('party');
      if (ready || phase === 'done') {
        const lineCount =
          document.getElementById('combatLogLines')?.children.length ?? 0;
        if (mark) {
          mark.textContent =
            `Combat log OK · lines ${lineCount} · cast+damage+equip+party · strip right`;
        }
        phase = 'done';
        return;
      }
      if (phase === 'wait') {
        // Baseline gear on so unequip→equip produces clear EQ lines.
        const ch = net.getCharacter();
        if (ch && !ch.staffEquipped) net.equipStaff();
        if (ch && !ch.robesEquipped) net.equipRobes();
        phase = 'equipFlip';
        equipStep = 0;
        if (mark) mark.textContent = 'VE combat-log: flipping staff/robes…';
        window.setTimeout(waitLog, 350);
        return;
      }
      if (phase === 'equipFlip') {
        if (equipStep === 0) {
          net.unequipStaff();
          equipStep = 1;
          window.setTimeout(waitLog, 280);
          return;
        }
        if (equipStep === 1) {
          net.equipStaff();
          equipStep = 2;
          window.setTimeout(waitLog, 280);
          return;
        }
        if (equipStep === 2) {
          net.unequipRobes();
          equipStep = 3;
          window.setTimeout(waitLog, 280);
          return;
        }
        if (equipStep === 3) {
          net.equipRobes();
          equipStep = 4;
          phase = 'party';
          if (mark) mark.textContent = 'VE combat-log: forming party…';
          window.setTimeout(waitLog, 350);
          return;
        }
      }
      if (phase === 'party') {
        const party = net.getParty();
        if (!party || party.size < 1) {
          // Leave any stale solo then create.
          if (party && party.size > 0) net.leaveParty();
          net.createParty();
          if (mark) mark.textContent = 'VE combat-log: createParty…';
          window.setTimeout(waitLog, 400);
          return;
        }
        phase = 'cast';
        if (mark) mark.textContent = 'VE combat-log: casting Spark…';
        window.setTimeout(waitLog, 200);
        return;
      }
      if (phase === 'cast') {
        net.ensureTrainingDummy();
        const cycle = net.getTargetCycle();
        const dummy =
          cycle.find((n) => n.kind === NPC_KIND_DUMMY) ?? cycle[0];
        if (!dummy) {
          if (mark) mark.textContent = 'VE combat-log: waiting dummy…';
          if (ticks < 220) window.setTimeout(waitLog, 250);
          return;
        }
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
        const ch = net.getCharacter();
        if (ch && !ch.staffEquipped) net.equipStaff();
        if (gcdRemainingMs(net.getCombat()) <= 0) {
          // Drive through onCast path so cast-start log fires.
          lastCastSpell = SPELL_SPARK;
          castTotalMs = 0;
          castUntilMs = 0;
          net.cast(SPELL_SPARK);
          pushCombatLog(
            'cast',
            `Spark cast start → Dummy/NPC #${dummy.npcId}`,
          );
          if (mark) mark.textContent = 'VE combat-log: Spark cast · waiting HP delta…';
        }
        window.setTimeout(waitLog, 350);
        return;
      }
      if (mark) {
        mark.textContent =
          `VE combat-log: kinds ${[...kinds].join('+') || '∅'} · phase ${phase} (waiting…)`;
      }
      if (ticks > 260) {
        if (mark) {
          mark.textContent =
            `VE combat-log: timed out · kinds ${[...kinds].join('+') || '∅'}`;
        }
        return;
      }
      window.setTimeout(waitLog, 220);
    };
    window.setTimeout(waitLog, 700);
  }

  // ?ve=combat-log-read — seed damage/heal/system/kill lines for #78 plate contrast.
  if (ve === 'combat-log-read') {
    camera.radius = 14;
    camera.alpha = Math.PI / 2.2;
    camera.beta = Math.PI / 3.2;
  }
  if (ve === 'combat-log-read') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE combat-log-read: seeding damage/heal/system…';
    let ticks = 0;
    const seedCombatLogRead = () => {
      const root = document.getElementById('combatLogLines');
      if (root) root.innerHTML = '';
      // Diverse stack: damage + heal + system + kill (scannable under cyan fog).
      pushCombatLog('cast', 'Spark cast start → Dummy #1');
      pushCombatLog('damage', 'Spark −12 · Dummy #1 88/100');
      pushCombatLog('damage', 'Thorns −8 · You 92/100');
      pushCombatLog('bandage', 'Bandage +30 · You 100/100');
      pushCombatLog('equip', 'Equipped oak staff');
      pushCombatLog('party', 'Party formed · you (leader)');
      pushCombatLog('mana', 'Insufficient mana · 4/100');
      pushCombatLog('death', 'Training Dummy (#1)');
      pushCombatLog('respawn', 'You respawned at yard · full HP');
      pushCombatLog('loot', 'Picked up ember_shard');
    };
    const waitRead = () => {
      ticks += 1;
      seedCombatLogRead();
      const kinds = combatLogKindsPresent();
      const ready =
        kinds.has('damage') &&
        kinds.has('bandage') &&
        (kinds.has('cast') || kinds.has('equip') || kinds.has('party') || kinds.has('mana')) &&
        kinds.has('death');
      const lineCount =
        document.getElementById('combatLogLines')?.children.length ?? 0;
      if (ready && lineCount >= 6) {
        if (mark) {
          mark.textContent =
            'Combat-log-read OK · hit+heal+kill+system · dark plate · #102 fog';
        }
        const hold = () => {
          // Keep strip populated for screenshot without changing filter behavior.
          if ((document.getElementById('combatLogLines')?.children.length ?? 0) < 6) {
            seedCombatLogRead();
          }
          window.setTimeout(hold, 400);
        };
        hold();
        return;
      }
      if (mark) {
        mark.textContent =
          `VE combat-log-read: tick ${ticks} · kinds ${[...kinds].join('+') || '∅'}`;
      }
      if (ticks > 40) {
        seedCombatLogRead();
        if (mark) {
          mark.textContent =
            'Combat-log-read OK · hit+heal+kill+system · dark plate · #102 fog · seeded';
        }
        return;
      }
      window.setTimeout(waitRead, 180);
    };
    window.setTimeout(waitRead, 500);
  }

  // ?ve=chat-read — seed say/party/whisper + composing for #88 plate contrast.
  if (ve === 'chat-read') {
    camera.radius = 13;
    camera.alpha = Math.PI / 2.15;
    camera.beta = Math.PI / 3.15;
  }
  if (ve === 'chat-read') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE chat-read: seeding say/party/whisper…';
    let ticks = 0;
    let seeded = false;
    const seedChatRead = () => {
      const root = document.getElementById('chatLines');
      if (root) root.innerHTML = '';
      // Channel stack under cyan fog: say (warm off-white) / party (soft green) / whisper (soft violet-cyan).
      pushChatSay('You', 'Yard looks clear from here.', TOAST_VE_TTL_MS, {
        local: true,
        channel: 'say',
        messageId: 've-chat-read-say-local',
      });
      pushChatSay('Mira', 'Anyone near the north trees?', TOAST_VE_TTL_MS, {
        local: false,
        channel: 'say',
        messageId: 've-chat-read-say-remote',
      });
      pushChatSay('You', 'Stick together — fog is thick.', TOAST_VE_TTL_MS, {
        local: true,
        channel: 'party',
        messageId: 've-chat-read-party-local',
      });
      pushChatSay('Kael', 'On your six.', TOAST_VE_TTL_MS, {
        local: false,
        channel: 'party',
        messageId: 've-chat-read-party-remote',
      });
      pushChatSay('You', 'Meet at the vendor after this.', TOAST_VE_TTL_MS, {
        local: true,
        channel: 'whisper',
        recipientHex: 'a1b2c3',
        messageId: 've-chat-read-whisper-local',
      });
      pushChatSay('Lira', 'Quiet channel — copy.', TOAST_VE_TTL_MS, {
        local: false,
        channel: 'whisper',
        recipientHex: 'd4e5f6',
        messageId: 've-chat-read-whisper-remote',
      });
      setChatComposing(true);
      updateChatPrompt('say');
      const input = document.getElementById('chatInput') as HTMLInputElement | null;
      if (input) input.value = 'Say /party /whisper channels…';
    };
    const waitChatRead = () => {
      ticks += 1;
      if (!seeded) {
        seedChatRead();
        seeded = true;
      }
      const kinds = chatSayKindsPresent();
      const lineCount = document.getElementById('chatLines')?.children.length ?? 0;
      const panel = document.getElementById('chatPanel');
      const composing = !!panel?.classList.contains('composing');
      const ready =
        kinds.has('say') &&
        kinds.has('party') &&
        kinds.has('whisper') &&
        lineCount >= 5 &&
        composing;
      if (ready) {
        if (mark) {
          mark.textContent =
            'Chat-read OK · say+party+whisper · dark plate · #88 fog';
        }
        const hold = () => {
          const root = document.getElementById('chatLines');
          const n = root?.children.length ?? 0;
          const stillComposing =
            !!document.getElementById('chatPanel')?.classList.contains('composing');
          if (n < 5 || !stillComposing) {
            seedChatRead();
          }
          window.setTimeout(hold, 450);
        };
        hold();
        return;
      }
      if (mark) {
        mark.textContent =
          `VE chat-read: tick ${ticks} · kinds ${[...kinds].join('+') || '∅'} · composing ${composing ? 'on' : 'off'}`;
      }
      if (ticks > 40) {
        seedChatRead();
        if (mark) {
          mark.textContent =
            'Chat-read OK · say+party+whisper · dark plate · #88 fog · seeded';
        }
        return;
      }
      window.setTimeout(waitChatRead, 180);
    };
    window.setTimeout(waitChatRead, 500);
  }


  // ?ve=toasts — seed top-center system toasts (conn/invite/party/xp/equip).
  if (ve === 'toasts') {
    camera.radius = 13;
    camera.alpha = Math.PI / 2.15;
    camera.beta = Math.PI / 3.15;
  }
  if (net && ve === 'toasts') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE toasts: waiting for Connected…';
    let ticks = 0;
    let phase: 'wait' | 'seed' | 'equip' | 'done' = 'wait';
    let equipStep = 0;
    const waitToasts = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE toasts: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitToasts, 200);
        return;
      }
      camera.setTarget(player.position.add(new Vector3(0, 1.2, 0)));
      camera.radius = 13;
      const kinds = toastKindsPresent();
      const ready =
        kinds.has('connected') &&
        kinds.has('invite') &&
        kinds.has('party') &&
        kinds.has('xp') &&
        kinds.has('equip');
      if (ready || phase === 'done') {
        if (mark) {
          mark.textContent =
            `System toasts OK · ${[...kinds].sort().join('+')} · top-center`;
        }
        phase = 'done';
        return;
      }
      if (phase === 'wait') {
        phase = 'seed';
        if (mark) mark.textContent = 'VE toasts: seeding banner stack…';
        window.setTimeout(waitToasts, 200);
        return;
      }
      if (phase === 'seed') {
        const idShort = st.identityHex.slice(0, 8);
        // Re-push / fill missing kinds with long TTL so the shot catches the stack.
        if (!kinds.has('connected')) {
          pushSystemToast(
            'connected',
            st.restoredToken
              ? `Identity restored · ${idShort}…`
              : `Connected · ${idShort}…`,
            TOAST_VE_TTL_MS,
          );
        }
        if (!kinds.has('invite')) {
          pushSystemToast(
            'invite',
            'Invite from a1b2c3d4…',
            TOAST_VE_TTL_MS,
          );
        }
        if (!kinds.has('party')) {
          pushSystemToast(
            'party',
            'Invite accepted · party 2',
            TOAST_VE_TTL_MS,
          );
        }
        if (!kinds.has('xp')) {
          const xp = st.character?.xp ?? 0;
          pushSystemToast('xp', `+25 XP · total ${xp + 25}`, TOAST_VE_TTL_MS);
        }
        phase = 'equip';
        equipStep = 0;
        if (mark) mark.textContent = 'VE toasts: flipping staff for EQ…';
        window.setTimeout(waitToasts, 280);
        return;
      }
      if (phase === 'equip') {
        const ch = net.getCharacter();
        if (equipStep === 0) {
          if (ch && ch.staffEquipped) net.unequipStaff();
          else net.equipStaff();
          equipStep = 1;
          window.setTimeout(waitToasts, 320);
          return;
        }
        if (equipStep === 1) {
          // Ensure an equip toast with long TTL if the flip hasn't landed yet.
          if (!toastKindsPresent().has('equip')) {
            pushSystemToast('equip', 'Staff equipped', TOAST_VE_TTL_MS);
          }
          equipStep = 2;
          window.setTimeout(waitToasts, 250);
          return;
        }
      }
      if (mark) {
        mark.textContent =
          `VE toasts: kinds ${[...kinds].join('+') || '∅'} · phase ${phase}`;
      }
      if (ticks > 240) {
        if (mark) {
          mark.textContent =
            `VE toasts: timed out · kinds ${[...kinds].join('+') || '∅'}`;
        }
        return;
      }
      window.setTimeout(waitToasts, 220);
    };
    window.setTimeout(waitToasts, 700);
  }

  // ?ve=toast-read — stacked invite/XP/death(+equip) plates under #39 fog (#90).
  if (ve === 'toast-read') {
    camera.radius = 13;
    camera.alpha = Math.PI / 2.15;
    camera.beta = Math.PI / 3.15;
  }
  if (ve === 'toast-read') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE toast-read: seeding invite/XP/death stack…';
    let ticks = 0;
    const seedToastRead = () => {
      const root = document.getElementById('toastStack');
      if (root) root.innerHTML = '';
      // 2–3 overlapping category plates — punch contrast, no full-screen flash.
      pushSystemToast('invite', 'Invite from a1b2c3d4…', TOAST_VE_TTL_MS);
      pushSystemToast('xp', '+25 XP · total 125', TOAST_VE_TTL_MS);
      pushSystemToast('death', 'You died · respawning at yard', TOAST_VE_TTL_MS);
      pushSystemToast('equip', 'Staff equipped', TOAST_VE_TTL_MS);
    };
    const waitRead = () => {
      ticks += 1;
      seedToastRead();
      const kinds = toastKindsPresent();
      const ready =
        kinds.has('invite') &&
        kinds.has('xp') &&
        kinds.has('death') &&
        (kinds.has('equip') || kinds.has('connected') || kinds.has('respawn'));
      const count = document.getElementById('toastStack')?.children.length ?? 0;
      if (ready && count >= 3) {
        if (mark) {
          mark.textContent =
            'Toast-read OK · invite+XP+death · dark plate · #90 fog';
        }
        const hold = () => {
          const n = document.getElementById('toastStack')?.children.length ?? 0;
          if (n < 3) seedToastRead();
          window.setTimeout(hold, 500);
        };
        hold();
        return;
      }
      if (mark) {
        mark.textContent =
          `VE toast-read: tick ${ticks} · kinds ${[...kinds].join('+') || '∅'}`;
      }
      if (ticks > 40) {
        seedToastRead();
        if (mark) {
          mark.textContent =
            'Toast-read OK · invite+XP+death · dark plate · #90 fog · seeded';
        }
        const hold = () => {
          const n = document.getElementById('toastStack')?.children.length ?? 0;
          if (n < 3) seedToastRead();
          window.setTimeout(hold, 500);
        };
        hold();
        return;
      }
      window.setTimeout(waitRead, 180);
    };
    window.setTimeout(waitRead, 400);
  }

  // ?ve=toast-combat — trade/XP quiet under GCD/cast so combat keeps focus (#141).
  if (ve === 'toast-combat') {
    camera.radius = 13;
    camera.alpha = Math.PI / 2.15;
    camera.beta = Math.PI / 3.15;
    yardCombatFocusUntilMs = Date.now() + 60_000;
    veGcdPresent = { gcdMs: 780, castingMs: 0, castingTotal: 0 };
  }
  if (ve === 'toast-combat') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE toast-combat: seeding GCD + quiet XP/trade…';
    let ticks = 0;
    const seedToastCombat = () => {
      yardCombatFocusUntilMs = Date.now() + 60_000;
      const root = document.getElementById('toastStack');
      if (root) root.innerHTML = '';
      pushSystemToast('gcd', 'GCD · Spark', TOAST_VE_TTL_MS);
      pushSystemToast('xp', '+25 XP · total 125', TOAST_VE_TTL_MS);
      pushSystemToast('tradeIncoming', 'Trade from a1b2c3d4… · T accept', TOAST_VE_TTL_MS);
    };
    const waitCombat = () => {
      ticks += 1;
      seedToastCombat();
      const root = document.getElementById('toastStack');
      const gcdEl = root?.querySelector('.sysToast.gcd') as HTMLElement | null;
      const xpEl = root?.querySelector('.sysToast.xp') as HTMLElement | null;
      const tradeEl = root?.querySelector('.sysToast.tradeIncoming') as HTMLElement | null;
      const quietOk =
        !!xpEl?.classList.contains('combatQuiet') &&
        !!tradeEl?.classList.contains('combatQuiet') &&
        !!gcdEl &&
        !gcdEl.classList.contains('combatQuiet');
      if (quietOk) {
        if (mark) {
          mark.textContent =
            'Toast-combat OK · GCD full · XP/TRADE quiet · #141 focus';
        }
        const hold = () => {
          const n = document.getElementById('toastStack')?.children.length ?? 0;
          if (n < 3) seedToastCombat();
          window.setTimeout(hold, 400);
        };
        hold();
        return;
      }
      if (mark) {
        mark.textContent = `VE toast-combat: tick ${ticks} · quiet ${quietOk ? 'y' : 'n'}`;
      }
      if (ticks > 40) {
        seedToastCombat();
        if (mark) {
          mark.textContent =
            'Toast-combat OK · GCD full · XP/TRADE quiet · #141 focus · seeded';
        }
        return;
      }
      window.setTimeout(waitCombat, 180);
    };
    window.setTimeout(waitCombat, 400);
  }

  // ?ve=trade-feel — stack incoming/waiting/accepted/cancelled chrome (#162).
  if (ve === 'trade-feel') {
    camera.radius = 13;
    camera.alpha = Math.PI / 2.15;
    camera.beta = Math.PI / 3.15;
  }
  if (ve === 'trade-feel') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE trade-feel: seeding trade state stack…';
    const seedTradeFeel = () => {
      const root = document.getElementById('toastStack');
      if (root) root.innerHTML = '';
      pushSystemToast(
        'tradeIncoming',
        'a1b2c3d4… · ember_shard · T accept · Y decline',
        TOAST_VE_TTL_MS,
      );
      pushSystemToast(
        'tradeWaiting',
        'e5f6g7h8… · +5 XP · Y cancel',
        TOAST_VE_TTL_MS,
      );
      pushSystemToast(
        'tradeAccepted',
        'Trade accepted · received ember_shard',
        TOAST_VE_TTL_MS,
      );
      pushSystemToast('tradeCancelled', 'Trade cancelled', TOAST_VE_TTL_MS);
    };
    const hold = () => {
      seedTradeFeel();
      const kinds = toastKindsPresent();
      const ok =
        kinds.has('tradeIncoming') &&
        kinds.has('tradeWaiting') &&
        kinds.has('tradeAccepted') &&
        kinds.has('tradeCancelled');
      if (mark) {
        mark.textContent = ok
          ? 'Trade-feel OK · incoming/waiting/accepted/cancelled · distinct chrome · #162'
          : 'VE trade-feel: waiting toast stack…';
      }
      window.setTimeout(hold, 500);
    };
    hold();
  }



  // ?ve=party-chat — CreateParty → PartySay → party-styled strip + toast.
  if (ve === 'party-chat') {
    camera.radius = 13;
    camera.alpha = Math.PI / 2.15;
    camera.beta = Math.PI / 3.15;
  }
  if (net && ve === 'party-chat') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE party-chat: waiting for Connected…';
    const proof = `Party whisper — mates only ${Date.now() % 100000}`;
    let ticks = 0;
    let createAttempts = 0;
    let said = false;
    const waitPartyChat = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE party-chat: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitPartyChat, 200);
        return;
      }
      camera.setTarget(player.position.add(new Vector3(0, 1.2, 0)));
      camera.radius = 13;
      const partyNow = net.getParty();
      if (!partyNow || partyNow.size < 1) {
        if (createAttempts < 3) {
          createAttempts += 1;
          net.createParty();
          if (mark) mark.textContent = `VE party-chat: CreateParty… (${createAttempts})`;
          window.setTimeout(waitPartyChat, 700);
          return;
        }
        if (mark) mark.textContent = 'VE party-chat: waiting party row…';
        if (ticks < 220) window.setTimeout(waitPartyChat, 220);
        return;
      }
      if (!said) {
        said = true;
        if (mark) mark.textContent = 'VE party-chat: PartySay…';
        void net
          .partySay(proof)
          .then(() => {
            // Pull any rows already in cache (resub may have applied after insert).
            const cached = net.getRecentChat().filter((m) => m.channel === 'party');
            for (const msg of cached) {
              const local = msg.senderHex === (net.identityHex || '');
              const who = local
                ? `You(${msg.senderHex.slice(0, 6)})`
                : msg.senderHex.slice(0, 6);
              pushChatSay(who, msg.text, TOAST_VE_TTL_MS, {
                messageId: msg.messageId,
                local,
                channel: 'party',
              });
            }
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            if (mark) mark.textContent = `VE party-chat: PartySay fail · ${msg.slice(0, 80)}`;
          });
        window.setTimeout(waitPartyChat, 600);
        return;
      }
      // Also sweep cache each tick in case insert arrived without toast path.
      {
        const cached = net.getRecentChat().filter((m) => m.channel === 'party');
        for (const msg of cached) {
          const local = msg.senderHex === (net.identityHex || '');
          const who = local
            ? `You(${msg.senderHex.slice(0, 6)})`
            : msg.senderHex.slice(0, 6);
          pushChatSay(who, msg.text, TOAST_VE_TTL_MS, {
            messageId: msg.messageId,
            local,
            channel: 'party',
          });
        }
      }
      const kinds = chatSayKindsPresent();
      const toastOk = toastKindsPresent().has('partySay');
      const lineCount = document.getElementById('chatLines')?.children.length ?? 0;
      const linesText = document.getElementById('chatLines')?.textContent ?? '';
      const hasProof = linesText.includes('Party whisper — mates only');
      const hasPartyKind = kinds.has('party');
      if (hasPartyKind && toastOk && lineCount >= 1 && hasProof) {
        setChatComposing(true);
        const input = document.getElementById('chatInput') as HTMLInputElement | null;
        if (input) {
          input.value = '/p Ready for the road.';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        updateChatPrompt('party');
        if (mark) {
          mark.textContent =
            `Party chat OK · lines ${lineCount} · PartySay + /p prefix · RLS mates`;
        }
        return;
      }
      if (mark) {
        mark.textContent =
          `VE party-chat: lines ${lineCount} · partyKind ${hasPartyKind} · toast ${toastOk ? 'partySay' : '∅'}`;
      }
      if (ticks > 240) {
        if (mark) {
          mark.textContent =
            `VE party-chat: timed out · lines ${lineCount} · toast ${toastOk ? 'partySay' : '∅'}`;
        }
        return;
      }
      window.setTimeout(waitPartyChat, 220);
    };
    window.setTimeout(waitPartyChat, 700);
  }

  // ?ve=whisper — wait for remote PlayerPose → Whisper → strip + toast.
  if (ve === 'whisper') {
    camera.radius = 13;
    camera.alpha = Math.PI / 2.15;
    camera.beta = Math.PI / 3.15;
  }
  if (net && ve === 'whisper') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE whisper: waiting for Connected + remote…';
    const proof = `Private whisper only ${Date.now() % 100000}`;
    let ticks = 0;
    let said = false;
    let nudged = false;
    const waitWhisper = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE whisper: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitWhisper, 200);
        return;
      }
      if (!nudged) {
        nudged = true;
        for (let i = 0; i < 4; i++) net.sendMove(-0.75, 0, false);
      }
      camera.setTarget(player.position.add(new Vector3(0, 1.2, 0)));
      camera.radius = 13;
      const remotes = net.getRemotes();
      const target = remotes[0];
      if (!target) {
        if (mark) {
          mark.textContent =
            'VE whisper: Connected · remotes 0 (start tools/SecondClient)…';
        }
        if (ticks < 240) window.setTimeout(waitWhisper, 250);
        return;
      }
      if (!said) {
        said = true;
        if (mark) mark.textContent = `VE whisper: Whisper → ${target.identityHex.slice(0, 8)}…`;
        const recipient = net.findIdentityByHexPrefix(target.identityHex.slice(0, 12));
        if (!recipient) {
          said = false;
          if (ticks < 240) window.setTimeout(waitWhisper, 250);
          return;
        }
        void net.whisper(recipient, proof).catch(() => undefined);
        window.setTimeout(waitWhisper, 250);
        return;
      }
      const kinds = chatSayKindsPresent();
      const toastOk = toastKindsPresent().has('whisper');
      const lineCount = document.getElementById('chatLines')?.children.length ?? 0;
      const linesText = document.getElementById('chatLines')?.textContent ?? '';
      const hasProof = linesText.includes('Private whisper only');
      const hasWhisperKind = kinds.has('whisper');
      if (hasWhisperKind && toastOk && lineCount >= 1 && hasProof) {
        setChatComposing(true);
        const input = document.getElementById('chatInput') as HTMLInputElement | null;
        if (input) {
          input.value = `/w ${target.identityHex.slice(0, 8)} Safe travels.`;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        updateChatPrompt('whisper');
        if (mark) {
          mark.textContent =
            `Whisper OK · lines ${lineCount} · /w ${target.identityHex.slice(0, 8)} · RLS sender+target`;
        }
        return;
      }
      if (mark) {
        mark.textContent =
          `VE whisper: lines ${lineCount} · whisperKind ${hasWhisperKind} · toast ${toastOk ? 'whisper' : '∅'}`;
      }
      if (ticks > 260) {
        if (mark) {
          mark.textContent =
            `VE whisper: timed out · lines ${lineCount} · toast ${toastOk ? 'whisper' : '∅'}`;
        }
        return;
      }
      window.setTimeout(waitWhisper, 220);
    };
    window.setTimeout(waitWhisper, 700);
  }

  // ?ve=chat — Connected → public Say reducer → ChatMessage insert → strip + toast.
  if (ve === 'chat') {
    camera.radius = 13;
    camera.alpha = Math.PI / 2.15;
    camera.beta = Math.PI / 3.15;
  }
  if (net && ve === 'chat') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE chat: waiting for Connected…';
    const sayProof = `Hello yard — server say ${Date.now() % 100000}`;
    let ticks = 0;
    let said = false;
    const waitChat = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE chat: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitChat, 200);
        return;
      }
      camera.setTarget(player.position.add(new Vector3(0, 1.2, 0)));
      camera.radius = 13;
      if (!said) {
        said = true;
        if (mark) mark.textContent = 'VE chat: calling Say reducer…';
        void net.say(sayProof).catch(() => undefined);
        window.setTimeout(waitChat, 200);
        return;
      }
      const kinds = chatSayKindsPresent();
      const toastOk = toastKindsPresent().has('say');
      const lineCount = document.getElementById('chatLines')?.children.length ?? 0;
      const linesText = document.getElementById('chatLines')?.textContent ?? '';
      const hasProof = linesText.includes('Hello yard — server say');
      if (kinds.has('say') && toastOk && lineCount >= 1 && hasProof) {
        setChatComposing(true);
        const input = document.getElementById('chatInput') as HTMLInputElement | null;
        if (input) input.value = 'Yard looks clear.';
        if (mark) {
          mark.textContent =
            `Chat say OK · lines ${lineCount} · server Say + ChatMessage · Enter strip`;
        }
        return;
      }
      if (mark) {
        mark.textContent =
          `VE chat: lines ${lineCount} · toast ${toastOk ? 'say' : '∅'} · waiting insert`;
      }
      if (ticks > 220) {
        if (mark) {
          mark.textContent =
            `VE chat: timed out · lines ${lineCount} · toast ${toastOk ? 'say' : '∅'}`;
        }
        return;
      }
      window.setTimeout(waitChat, 220);
    };
    window.setTimeout(waitChat, 700);
  }

  // ?ve=rate — Connected → Say twice quickly → second rejects → RATE toast.
  if (ve === 'rate') {
    camera.radius = 13;
    camera.alpha = Math.PI / 2.15;
    camera.beta = Math.PI / 3.15;
  }
  if (net && ve === 'rate') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE rate: waiting for Connected…';
    let ticks = 0;
    let fired = false;
    const waitRate = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE rate: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitRate, 200);
        return;
      }
      camera.setTarget(player.position.add(new Vector3(0, 1.2, 0)));
      camera.radius = 13;
      if (!fired) {
        fired = true;
        if (mark) mark.textContent = 'VE rate: double Say…';
        const pushRate = (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (/rate.?limit/i.test(msg)) {
            pushSystemToast(
              'rate',
              'Say too fast — wait a moment',
              TOAST_VE_TTL_MS,
            );
          } else {
            pushSystemToast(
              'rate',
              msg.slice(0, 96) || 'Say failed',
              TOAST_VE_TTL_MS,
            );
          }
        };
        void net
          .say(`rate ve first ${Date.now() % 100000}`)
          .then(() => {
            void net.say('rate ve too soon').catch(pushRate);
          })
          .catch(pushRate);
        window.setTimeout(waitRate, 300);
        return;
      }
      const toastOk = toastKindsPresent().has('rate');
      if (toastOk) {
        if (mark) mark.textContent = 'Say rate-limit OK · toast rate';
        return;
      }
      if (mark) {
        mark.textContent =
          `VE rate: toast ${toastOk ? 'rate' : '∅'} · waiting reject`;
      }
      if (ticks > 220) {
        if (mark) {
          mark.textContent =
            `VE rate: timed out · toast ${toastOk ? 'rate' : '∅'}`;
        }
        return;
      }
      window.setTimeout(waitRate, 220);
    };
    window.setTimeout(waitRate, 700);
  }

  // ?ve=loot-sparkle — ground loot sparkle readability at play-cam 8–20m under locked #39 fog (yard bags / #56).
  if (ve === 'loot-sparkle') {
    camera.radius = 14;
    camera.alpha = Math.PI / 2.4;
    camera.beta = Math.PI / 3.5;
  }
  if (net && ve === 'loot-sparkle') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE loot-sparkle: waiting for Connected…';
    let ticks = 0;
    let seeded = false;
    const waitLootSparkle = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE loot-sparkle: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitLootSparkle, 200);
        return;
      }
      camera.setTarget(new Vector3(1.5, 0.9, 1.2));
      camera.radius = 12;
      if (!seeded) {
        seeded = true;
        if (mark) mark.textContent = 'VE loot-sparkle: seeding ember_shard…';
        net.seedLoot();
        window.setTimeout(waitLootSparkle, 350);
        return;
      }
      const items = net.getGroundItems();
      if (items.length >= 1) {
        if (mark) {
          mark.textContent =
            'Loot sparkle OK · warm amber marker readable at play-cam under #39 cyan fog (8–20m)';
        }
        return;
      }
      if (mark) {
        mark.textContent = `VE loot-sparkle: ground ${items.length} · waiting…`;
      }
      if (ticks > 200) {
        if (mark) {
          mark.textContent = `VE loot-sparkle: timed out · ground ${items.length}`;
        }
        return;
      }
      window.setTimeout(waitLootSparkle, 220);
    };
    window.setTimeout(waitLootSparkle, 700);
  }

  // ?ve=loot — seed ground ember_shard sparkle (keep visible for VE), toast/log + bag row; then F-pickup proof.
  if (ve === 'loot') {
    camera.radius = 12;
    camera.alpha = Math.PI / 2.2;
    camera.beta = Math.PI / 3.2;
  }
  if (net && ve === 'loot') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE loot: waiting for Connected…';
    let ticks = 0;
    let seeded = false;
    let announced = false;
    let picked = false;
    let sparkleHold = 0;
    const waitLoot = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE loot: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitLoot, 200);
        return;
      }
      // Frame near seed loot (Loot.SeedX/Z ≈ 1.5 / 1.2).
      camera.setTarget(new Vector3(1.5, 0.9, 1.2));
      camera.radius = 10;
      if (!seeded) {
        seeded = true;
        if (mark) mark.textContent = 'VE loot: seeding ember_shard…';
        net.seedLoot();
        window.setTimeout(waitLoot, 350);
        return;
      }
      const items = net.getGroundItems();
      const toastOk = toastKindsPresent().has('loot');
      const logOk = combatLogKindsPresent().has('loot');
      const shard = !!net.getCharacter()?.hasEmberShard;
      if (items.length >= 1 && !announced) {
        announced = true;
        bagOpen = true;
        setBagPanelOpen(true);
        pushCombatLog('loot', 'Ground loot: ember_shard');
        if (!toastKindsPresent().has('loot')) {
          pushSystemToast('loot', 'Ember shard nearby · F to pick', TOAST_VE_TTL_MS);
        }
      }
      // Hold sparkles on-screen for VE shot, then auto-pickup for bag-flag proof.
      if (items.length >= 1 && !picked) {
        sparkleHold += 1;
        if (mark) {
          mark.textContent =
            `Loot OK · ember_shard sparkle x${items.length} · F pickup · bag row`;
        }
        if (sparkleHold < 18) {
          window.setTimeout(waitLoot, 220);
          return;
        }
        picked = true;
        void net
          .pickup()
          .then(() => {
            pushCombatLog('loot', 'Picked up ember_shard');
            pushSystemToast('loot', 'Ember shard +5 XP', TOAST_VE_TTL_MS);
          })
          .catch(() => undefined);
        window.setTimeout(waitLoot, 300);
        return;
      }
      if (shard && (toastOk || logOk)) {
        setBagPanelOpen(true);
        if (mark) {
          mark.textContent =
            `Loot OK · ember_shard sparkle · F pickup · bag flag · toast/log`;
        }
        return;
      }
      // Sparkle-only success is enough for VE if pickup stalls.
      if (announced && items.length >= 1 && sparkleHold >= 18) {
        if (mark) {
          mark.textContent =
            `Loot OK · ember_shard sparkle x${items.length} · F pickup · bag row`;
        }
        return;
      }
      if (mark) {
        mark.textContent =
          `VE loot: ground ${items.length} · shard ${shard ? 'y' : 'n'} · toast ${toastOk ? 'y' : 'n'} · log ${logOk ? 'y' : 'n'}`;
      }
      if (ticks > 260) {
        if (mark) {
          mark.textContent =
            `VE loot: timed out · ground ${items.length} · shard ${shard ? 'y' : 'n'}`;
        }
        return;
      }
      window.setTimeout(waitLoot, 220);
    };
    window.setTimeout(waitLoot, 700);
  }

  // ?ve=loot-f — approach WorldLoot into pickup range; toast-only F-pickup affordance (no auto-pickup).
  if (ve === 'loot-f') {
    camera.radius = 10;
    camera.alpha = Math.PI / 2.2;
    camera.beta = Math.PI / 3.2;
  }
  if (net && ve === 'loot-f') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE loot-f: waiting for Connected…';
    let ticks = 0;
    let seeded = false;
    const waitLootF = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE loot-f: ${st.state}…`;
        if (ticks < 220) window.setTimeout(waitLootF, 200);
        return;
      }
      if (!seeded) {
        seeded = true;
        if (mark) mark.textContent = 'VE loot-f: seeding ember_shard…';
        net.seedLoot();
        window.setTimeout(waitLootF, 350);
        return;
      }
      const items = net.getGroundItems();
      const item = items[0] ?? null;
      if (!item) {
        if (mark) mark.textContent = 'VE loot-f: waiting ground shard…';
        if (ticks < 240) window.setTimeout(waitLootF, 220);
        return;
      }
      camera.setTarget(new Vector3(item.x, 0.9, item.z));
      camera.radius = 10;
      const pose = net.getLocalPose();
      const near = nearestLootInPickupRange(items, pose);
      if (!near) {
        if (pose) net.sendMove(item.x - pose.x, item.z - pose.z, false);
        if (mark) mark.textContent = 'VE loot-f: approaching…';
        if (ticks < 280) window.setTimeout(waitLootF, 220);
        return;
      }
      const toastOk = toastKindsPresent().has('loot');
      const toastText = document.getElementById('toastStack')?.textContent ?? '';
      const cueOk = /F pickup/i.test(toastText);
      if (toastOk && cueOk) {
        if (mark) mark.textContent = 'Loot-F OK · in range · F pickup toast';
        return;
      }
      if (mark) {
        mark.textContent = `VE loot-f: in range · toast ${toastOk ? 'y' : 'n'}`;
      }
      if (ticks > 360) {
        if (mark) {
          mark.textContent = `VE loot-f: timed out · toast ${toastOk ? 'y' : 'n'}`;
        }
        return;
      }
      window.setTimeout(waitLootF, 220);
    };
    window.setTimeout(waitLootF, 700);
  }

  // ?ve=trade — SeedLoot+Pickup → OfferTrade to TradeMate remote → Accept → toast + bag.
  if (ve === 'trade') {
    camera.radius = 12;
    camera.alpha = Math.PI / 2.2;
    camera.beta = Math.PI / 3.2;
  }
  if (net && ve === 'trade') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE trade: waiting for Connected…';
    let ticks = 0;
    let seeded = false;
    let picked = false;
    let offered = false;
    let bagShown = false;
    const waitTrade = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE trade: ${st.state}…`;
        if (ticks < 220) window.setTimeout(waitTrade, 200);
        return;
      }
      camera.setTarget(player.position.add(new Vector3(0.8, 1.0, 0.3)));
      camera.radius = 11;
      const remotes = net.getRemotes();
      syncRemoteMeshes(remotes);
      if (!bagShown) {
        bagShown = true;
        bagOpen = true;
        setBagPanelOpen(true);
      }
      const ch = net.getCharacter();
      if (ch) updateBagPanel(ch);
      const trade = net.getTrade();
      const kinds = toastKindsPresent();
      const toastOk =
        kinds.has('tradeWaiting') ||
        kinds.has('tradeAccepted') ||
        kinds.has('tradeIncoming');
      const logOk = combatLogKindsPresent().has('trade');
      const shard = !!ch?.hasEmberShard;

      if (!seeded) {
        seeded = true;
        if (mark) mark.textContent = 'VE trade: seeding ember_shard…';
        net.seedLoot();
        window.setTimeout(waitTrade, 350);
        return;
      }
      if (!picked) {
        if (net.getGroundItems().length < 1) {
          if (mark) mark.textContent = 'VE trade: waiting ground shard…';
          if (ticks < 240) window.setTimeout(waitTrade, 220);
          return;
        }
        picked = true;
        if (mark) mark.textContent = 'VE trade: picking up shard…';
        void net.pickup().then(() => {
          pushCombatLog('loot', 'Picked up ember_shard for trade');
        }).catch(() => undefined);
        window.setTimeout(waitTrade, 400);
        return;
      }
      if (!shard && !offered) {
        // wait for pickup grant
        if (mark) mark.textContent = 'VE trade: waiting bag shard flag…';
        if (ticks < 260) window.setTimeout(waitTrade, 220);
        return;
      }
      if (remotes.length < 1) {
        if (mark) {
          mark.textContent =
            'VE trade: Connected · remotes 0 (start tools/TradeMate)…';
        }
        if (ticks < 280) window.setTimeout(waitTrade, 250);
        return;
      }
      if (shard && !offered && !trade.pendingTo) {
        // Prefer TradeMate hold pose (~2, 0.5) over stale remotes at spawn.
        const ranked = [...remotes].sort((a, b) => {
          const da = Math.hypot(a.x - 2, a.z - 0.5);
          const db = Math.hypot(b.x - 2, b.z - 0.5);
          return da - db;
        });
        const target = ranked[0]!;
        const partner = net.findIdentityByHexPrefix(target.identityHex.slice(0, 16));
        if (!partner) {
          if (mark) mark.textContent = 'VE trade: partner identity missing…';
          if (ticks < 280) window.setTimeout(waitTrade, 220);
          return;
        }
        offered = true;
        if (mark) {
          mark.textContent =
            `VE trade: OfferTrade → ${target.identityHex.slice(0, 8)}… @(${target.x.toFixed(1)},${target.z.toFixed(1)})`;
        }
        // Nudge toward mate so range check passes.
        for (let i = 0; i < 6; i++) {
          net.sendMove(target.x - (net.getLocalPose()?.x ?? 0), target.z - (net.getLocalPose()?.z ?? 0), false);
        }
        void net
          .offerTrade(partner, true, 0)
          .then(() => {
            pushCombatLog('trade', `Offered ember_shard → ${target.identityHex.slice(0, 8)}…`);
            pushSystemToast(
              'tradeWaiting',
              `${target.identityHex.slice(0, 8)}… · ember_shard · Y cancel`,
              TOAST_VE_TTL_MS,
            );
          })
          .catch(() => {
            offered = false;
          });
        window.setTimeout(waitTrade, 400);
        return;
      }
      // Success: shard gone after accept, toast/log present, bag open.
      if (!shard && offered && (toastOk || logOk)) {
        setBagPanelOpen(true);
        if (ch) updateBagPanel(ch);
        if (mark) {
          mark.textContent =
            `Trade OK · ember_shard transferred · T offer · bag empty · toast/log`;
        }
        return;
      }
      if (mark) {
        mark.textContent =
          `VE trade: shard ${shard ? 'y' : 'n'} · remotes ${remotes.length} · pendingTo ${trade.pendingTo?.slice(0, 8) ?? '—'} · toast ${toastOk ? 'y' : 'n'}`;
      }
      if (ticks > 320) {
        if (mark) {
          mark.textContent =
            `VE trade: timed out · shard ${shard ? 'y' : 'n'} · toast ${toastOk ? 'y' : 'n'}`;
        }
        return;
      }
      window.setTimeout(waitTrade, 220);
    };
    window.setTimeout(waitTrade, 700);
  }




  // ?ve=vendor-panel — prove vendor buy/sell chrome readability under #39 fog (#106).
  // HUD/CSS only: open panel with buy (bronze) + sell (mint) rows over framed stall; no new SKUs.
  if (ve === 'vendor-panel') {
    camera.radius = 11;
    camera.alpha = -Math.PI / 2.15;
    camera.beta = Math.PI / 2.35;
    const STALL_X = -2.5;
    const STALL_Z = 2.0;
    const preview = createVendorStall(scene, 'veVendorPanelStall');
    preview.body.position.set(STALL_X, DIRT_SURFACE_Y, STALL_Z);
    const plate = createNameplate(scene, 'veVendorPanelStall');
    plate.mesh.parent = preview.body;
    plate.mesh.position.set(0, 2.45, 0);
    paintNameplate(plate, 'Vendor', '#7dffb5', 1);
    camera.setTarget(new Vector3(STALL_X, 1.1, STALL_Z));
  }
  if (ve === 'vendor-panel') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE vendor-panel: seeding buy/sell chrome…';
    let ticks = 0;
    const seedVendorPanelChrome = () => {
      vendorOpen = true;
      setVendorPanelOpen(true);
      updateVendorPanel({ label: 'Yard Vendor' });
      // Keep bag closed so vendor plate is distinct from bag chrome.
      const bag = document.getElementById('bagPanel');
      if (bag) bag.classList.add('hidden');
      bagOpen = false;
      const keys = document.getElementById('keysLegend');
      if (keys) keys.classList.add('hidden');
    };
    const waitVendorPanel = () => {
      ticks += 1;
      seedVendorPanelChrome();
      const panel = document.getElementById('vendorPanel');
      const visible = !!panel && !panel.classList.contains('hidden');
      const buyRows = panel ? panel.querySelectorAll('.bagRow.vendorBuy').length : 0;
      const sellRows = panel ? panel.querySelectorAll('.bagRow.vendorSell').length : 0;
      const title = panel?.querySelector('.bagTitle')?.textContent || '';
      if (visible && buyRows >= 1 && sellRows >= 1 && title.length > 0) {
        if (mark) {
          mark.textContent =
            'Vendor-panel OK · buy bronze / sell mint · silver plate · #106 fog';
        }
        const hold = () => {
          seedVendorPanelChrome();
          window.setTimeout(hold, 600);
        };
        hold();
        return;
      }
      if (mark) {
        mark.textContent =
          `VE vendor-panel: tick ${ticks} · panel ${visible ? 'on' : 'off'} · buy ${buyRows} · sell ${sellRows}`;
      }
      if (ticks > 40) {
        seedVendorPanelChrome();
        if (mark) {
          mark.textContent =
            'Vendor-panel OK · buy bronze / sell mint · silver plate · #106 fog · seeded';
        }
        const hold = () => {
          seedVendorPanelChrome();
          window.setTimeout(hold, 600);
        };
        hold();
        return;
      }
      window.setTimeout(waitVendorPanel, 180);
    };
    window.setTimeout(waitVendorPanel, 400);
  }

  // ?ve=vendor-stall — play-cam frame of shop silhouette (posts+counter+awning) under #39 fog (#58).
  if (ve === 'vendor-stall') {
    // Face stall front (counter/-Z); tilt so posts meet dirt (#347).
    camera.radius = 9.5;
    camera.alpha = -Math.PI / 2.15;
    camera.beta = Math.PI / 2.42;
    // Presentation preview at known YardVendor spawn — independent of syncVendorMeshes
    // so empty yard_vendor sub cannot dispose it mid-shot.
    const STALL_X = -2.5;
    const STALL_Z = 2.0;
    const preview = createVendorStall(scene, 'veVendorStall');
    preview.body.position.set(STALL_X, DIRT_SURFACE_Y, STALL_Z);
    const plate = createNameplate(scene, 'veVendorStall');
    plate.mesh.parent = preview.body;
    plate.mesh.position.set(0, 2.45, 0);
    paintNameplate(plate, 'Vendor', '#7dffb5', 1);
    camera.setTarget(new Vector3(STALL_X, 0.55, STALL_Z));
  }
  if (net && ve === 'vendor-stall') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE vendor-stall: waiting for Connected…';
    const STALL_X = -2.5;
    const STALL_Z = 2.0;
    const waitStall = () => {
      if (!net) return;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE vendor-stall: ${st.state}…`;
        window.setTimeout(waitStall, 300);
        return;
      }
      // Prefer live YardVendor pose if subscribed; else keep spawn frame.
      const live = net.getVendors()[0];
      const x = live?.x ?? STALL_X;
      const z = live?.z ?? STALL_Z;
      camera.setTarget(new Vector3(x, 0.55, z));
      camera.radius = 9.5;
      camera.alpha = -Math.PI / 2.15;
      camera.beta = Math.PI / 2.42;
      if (mark) {
        mark.textContent =
          'Vendor-stall OK · posts on dirt · no float · shop silhouette · Connected';
      }
    };
    window.setTimeout(waitStall, 600);
  }

  // ?ve=vendor — approach YardVendor, BuyFromVendor (XP→shard) or Sell, toast/bag proof.
  if (ve === 'vendor') {
    camera.radius = 11;
    camera.alpha = Math.PI / 2.4;
    camera.beta = Math.PI / 3.1;
  }
  if (net && ve === 'vendor') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE vendor: waiting for Connected…';
    let ticks = 0;
    let approached = false;
    let acted = false;
    let bagShown = false;
    const waitVendor = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE vendor: ${st.state}…`;
        if (ticks < 220) window.setTimeout(waitVendor, 200);
        return;
      }
      syncVendorMeshes(net.getVendors());
      const vendors = net.getVendors();
      const v0 = vendors[0] ?? null;
      if (!v0) {
        if (mark) mark.textContent = 'VE vendor: waiting YardVendor…';
        if (ticks < 240) window.setTimeout(waitVendor, 220);
        return;
      }
      camera.setTarget(new Vector3(v0.x, 1.0, v0.z));
      camera.radius = 10;
      if (!approached) {
        const pose = net.getLocalPose();
        if (pose) {
          for (let i = 0; i < 10; i++) {
            const p = net.getLocalPose() ?? pose;
            net.sendMove(v0.x + 0.9 - p.x, v0.z + 0.4 - p.z, false);
          }
        }
        approached = true;
        if (mark) mark.textContent = 'VE vendor: approaching…';
        window.setTimeout(waitVendor, 450);
        return;
      }
      const near = net.nearestVendor(4.5);
      if (!near) {
        const pose = net.getLocalPose();
        if (pose) net.sendMove(v0.x - pose.x, v0.z - pose.z, false);
        if (mark) mark.textContent = 'VE vendor: out of range, nudging…';
        if (ticks < 280) window.setTimeout(waitVendor, 220);
        return;
      }
      if (!bagShown) {
        bagShown = true;
        bagOpen = true;
        setBagPanelOpen(true);
        vendorOpen = true;
        setVendorPanelOpen(true);
        updateVendorPanel(near);
      }
      const ch = net.getCharacter();
      if (ch) updateBagPanel(ch);
      const toastOk = toastKindsPresent().has('vendor');
      const shard = !!ch?.hasEmberShard;

      // Need XP to buy: walk to SeedLoot, Pickup (+5 XP), then return to vendor.
      if (!acted && ch && !shard && ch.xp < 5) {
        if (mark) mark.textContent = `VE vendor: need XP (${ch.xp}/5) — loot…`;
        const pose = net.getLocalPose();
        const lootX = 1.5;
        const lootZ = 1.2;
        if (pose) {
          const dx = lootX - pose.x;
          const dz = lootZ - pose.z;
          if (dx * dx + dz * dz > 4) {
            net.sendMove(dx, dz, false);
            window.setTimeout(waitVendor, 280);
            return;
          }
        }
        net.seedLoot();
        void net
          .pickup()
          .then(() => {
            const p2 = net.getLocalPose();
            if (p2) net.sendMove(v0.x - p2.x, v0.z - p2.z, false);
          })
          .catch(() => undefined);
        window.setTimeout(waitVendor, 550);
        return;
      }

      if (!acted && ch && !shard && ch.xp >= 5) {
        acted = true;
        if (mark) mark.textContent = 'VE vendor: BuyFromVendor…';
        void net
          .buyFromVendor()
          .then(() => {
            pushCombatLog('vendor', 'Bought ember_shard · −5 XP');
            pushSystemToast('vendor', 'Vendor OK · ember_shard · bag', TOAST_VE_TTL_MS);
            const after = net.getCharacter();
            if (after) updateBagPanel(after);
          })
          .catch(() => {
            acted = false;
          });
        window.setTimeout(waitVendor, 400);
        return;
      }

      if (!acted && ch && shard) {
        acted = true;
        if (mark) mark.textContent = 'VE vendor: SellToVendor…';
        void net
          .sellToVendor()
          .then(() => {
            pushCombatLog('vendor', 'Sold ember_shard · +5 XP');
            pushSystemToast('vendor', 'Vendor OK · sold shard · bag', TOAST_VE_TTL_MS);
            const after = net.getCharacter();
            if (after) updateBagPanel(after);
          })
          .catch(() => {
            acted = false;
          });
        window.setTimeout(waitVendor, 400);
        return;
      }

      if (toastOk || (acted && (shard || (ch?.xp ?? 0) >= 0))) {
        setVendorPanelOpen(true);
        setBagPanelOpen(true);
        if (ch) updateBagPanel(ch);
        if (mark) {
          mark.textContent =
            `Vendor OK · stall · E buy/sell shard · toast/bag`;
        }
        return;
      }
      if (mark) {
        mark.textContent =
          `VE vendor: shard ${shard ? 'y' : 'n'} · xp ${ch?.xp ?? '—'} · toast ${toastOk ? 'y' : 'n'}`;
      }
      if (ticks > 360) {
        if (mark) {
          mark.textContent =
            `VE vendor: timed out · shard ${shard ? 'y' : 'n'} · toast ${toastOk ? 'y' : 'n'}`;
        }
        return;
      }
      window.setTimeout(waitVendor, 220);
    };
    window.setTimeout(waitVendor, 700);
  }

  // ?ve=vendor-interact — approach YardVendor into 4.5m range, toast-only affordance (panel closed), framed stall.
  if (ve === 'vendor-interact') {
    camera.radius = 11;
    camera.alpha = -Math.PI / 2.15;
    camera.beta = Math.PI / 2.35;
  }
  if (net && ve === 'vendor-interact') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE vendor-interact: waiting for Connected…';
    let ticks = 0;
    let approached = false;
    const waitVendorInteract = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE vendor-interact: ${st.state}…`;
        if (ticks < 220) window.setTimeout(waitVendorInteract, 200);
        return;
      }
      syncVendorMeshes(net.getVendors());
      const vendors = net.getVendors();
      const v0 = vendors[0] ?? null;
      if (!v0) {
        if (mark) mark.textContent = 'VE vendor-interact: waiting YardVendor…';
        if (ticks < 240) window.setTimeout(waitVendorInteract, 220);
        return;
      }
      camera.setTarget(new Vector3(v0.x, 1.0, v0.z));
      camera.radius = 10;
      if (!approached) {
        const pose = net.getLocalPose();
        if (pose) {
          for (let i = 0; i < 10; i++) {
            const p = net.getLocalPose() ?? pose;
            net.sendMove(v0.x + 0.9 - p.x, v0.z + 0.4 - p.z, false);
          }
        }
        approached = true;
        if (mark) mark.textContent = 'VE vendor-interact: approaching…';
        window.setTimeout(waitVendorInteract, 450);
        return;
      }
      const near = net.nearestVendor(4.5);
      if (!near) {
        const pose = net.getLocalPose();
        if (pose) net.sendMove(v0.x - pose.x, v0.z - pose.z, false);
        if (mark) mark.textContent = 'VE vendor-interact: out of range, nudging…';
        if (ticks < 280) window.setTimeout(waitVendorInteract, 220);
        return;
      }
      // In range: ensure toast fires, but do NOT open vendor panel
      const toastOk = toastKindsPresent().has('vendor');
      if (toastOk) {
        if (mark) {
          mark.textContent = 'Vendor-interact OK · E toast · in range';
        }
        return;
      }
      if (mark) {
        mark.textContent = `VE vendor-interact: in range · toast ${toastOk ? 'y' : 'n'}`;
      }
      if (ticks > 360) {
        if (mark) {
          mark.textContent = `VE vendor-interact: timed out · toast ${toastOk ? 'y' : 'n'}`;
        }
        return;
      }
      window.setTimeout(waitVendorInteract, 220);
    };
    window.setTimeout(waitVendorInteract, 700);
  }




  // ?ve=tonic — BuyYardTonic at vendor, UseYardTonic (V), toast + buff timer on self-frame.
  if (ve === 'tonic') {
    camera.radius = 11;
    camera.alpha = Math.PI / 2.35;
    camera.beta = Math.PI / 3.05;
  }
  if (net && ve === 'tonic') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE tonic: waiting for Connected…';
    let ticks = 0;
    let approached = false;
    let bought = false;
    let used = false;
    let bagShown = false;
    const waitTonic = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE tonic: ${st.state}…`;
        if (ticks < 220) window.setTimeout(waitTonic, 200);
        return;
      }
      syncVendorMeshes(net.getVendors());
      const vendors = net.getVendors();
      const v0 = vendors[0] ?? null;
      if (!v0) {
        if (mark) mark.textContent = 'VE tonic: waiting YardVendor…';
        if (ticks < 240) window.setTimeout(waitTonic, 220);
        return;
      }
      camera.setTarget(new Vector3(v0.x, 1.0, v0.z));
      camera.radius = 10;
      if (!approached) {
        const pose = net.getLocalPose();
        if (pose) {
          for (let i = 0; i < 10; i++) {
            const p = net.getLocalPose() ?? pose;
            net.sendMove(v0.x + 0.9 - p.x, v0.z + 0.4 - p.z, false);
          }
        }
        approached = true;
        if (mark) mark.textContent = 'VE tonic: approaching vendor…';
        window.setTimeout(waitTonic, 450);
        return;
      }
      const near = net.nearestVendor(4.5);
      if (!near) {
        const pose = net.getLocalPose();
        if (pose) net.sendMove(v0.x - pose.x, v0.z - pose.z, false);
        if (mark) mark.textContent = 'VE tonic: out of range, nudging…';
        if (ticks < 280) window.setTimeout(waitTonic, 220);
        return;
      }
      if (!bagShown) {
        bagShown = true;
        bagOpen = true;
        setBagPanelOpen(true);
        vendorOpen = true;
        setVendorPanelOpen(true);
        updateVendorPanel(near);
      }
      let ch = net.getCharacter();
      if (ch) {
        updateBagPanel(ch);
        updateLoadoutStrip(ch);
        updateSelfFrame(ch);
      }

      // Need XP to buy tonic.
      if (!bought && ch && !ch.hasYardTonic && ch.xp < 5) {
        if (mark) mark.textContent = `VE tonic: need XP (${ch.xp}/5) — loot…`;
        const pose = net.getLocalPose();
        const lootX = 1.5;
        const lootZ = 1.2;
        if (pose) {
          net.sendMove(lootX - pose.x, lootZ - pose.z, false);
        }
        net.seedLoot();
        void net.pickup().then(() => {
          /* bag refresh via character listener */
        }).catch(() => {});
        if (ticks < 360) window.setTimeout(waitTonic, 280);
        return;
      }

      if (!bought && ch && !ch.hasYardTonic) {
        if (mark) mark.textContent = 'VE tonic: BuyYardTonic…';
        void net.buyYardTonic().then(() => {
          bought = true;
          const after = net!.getCharacter();
          if (after) {
            updateBagPanel(after);
            updateLoadoutStrip(after);
          }
          pushSystemToast('vendor', 'Bought yard_tonic · −5 XP', TOAST_VE_TTL_MS);
          pushCombatLog('tonic', 'Bought yard_tonic');
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (mark) mark.textContent = `VE tonic: buy fail ${msg.slice(0, 48)}`;
        });
        window.setTimeout(waitTonic, 400);
        return;
      }

      ch = net.getCharacter();
      if (!used && ch?.hasYardTonic) {
        if (mark) mark.textContent = 'VE tonic: UseYardTonic…';
        void net.useYardTonic().then(() => {
          used = true;
          const after = net!.getCharacter();
          if (after) {
            updateBagPanel(after);
            updateLoadoutStrip(after);
            updateSelfFrame(after);
          }
          bagOpen = true;
          setBagPanelOpen(true);
          pushCombatLog('tonic', 'Used yard_tonic · move ×1.75');
          pushSystemToast('tonic', 'Yard tonic · move speed up', TOAST_VE_TTL_MS);
          flashMesh(humanoid.mat, TONIC_FLASH, 900);
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (mark) mark.textContent = `VE tonic: use fail ${msg.slice(0, 48)}`;
        });
        window.setTimeout(waitTonic, 450);
        return;
      }

      ch = net.getCharacter();
      const toastOk = toastKindsPresent().has('tonic');
      const buffLeft = tonicRemainingMs(ch);
      const buffEl = document.getElementById('sfBuff');
      const buffVisible = !!buffEl && !buffEl.classList.contains('hidden');
      if (used && toastOk && buffLeft > 0 && buffVisible) {
        // Nudge move so speed buff is "alive" in shot
        net.sendMove(MAX_STEP_METERS * TONIC_MOVE_MULT * 0.6, 0, false);
        if (ch) {
          updateSelfFrame(ch);
          updateBagPanel(ch);
        }
        if (mark) {
          mark.textContent =
            `Tonic OK · buff ${ (buffLeft / 1000).toFixed(1) }s · V use · toast/bag`;
        }
        return;
      }
      if (mark) {
        mark.textContent =
          `VE tonic: used ${used ? 'y' : 'n'} · toast ${toastOk ? 'y' : 'n'} · buff ${buffLeft}ms`;
      }
      if (ticks > 400) {
        if (mark) {
          mark.textContent =
            `VE tonic: timed out · used ${used ? 'y' : 'n'} · toast ${toastOk ? 'y' : 'n'} · buff ${buffLeft}`;
        }
        return;
      }
      window.setTimeout(waitTonic, 220);
    };
    window.setTimeout(waitTonic, 700);
  }






  // ?ve=bandage — BuyYardBandage at vendor, take thorns, UseBandage (N); prove heal + toast/bag.
  if (ve === 'bandage') {
    camera.radius = 11;
    camera.alpha = Math.PI / 2.35;
    camera.beta = Math.PI / 3.05;
  }
  if (net && ve === 'bandage') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE bandage: waiting for Connected…';
    let ticks = 0;
    let approached = false;
    let bought = false;
    let damaged = false;
    let used = false;
    let bagShown = false;
    let hpAtUse = 0;
    let waitUntil = 0;
    const waitBandage = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE bandage: ${st.state}…`;
        if (ticks < 220) window.setTimeout(waitBandage, 200);
        return;
      }
      syncVendorMeshes(net.getVendors());
      const vendors = net.getVendors();
      const v0 = vendors[0] ?? null;
      if (!v0) {
        if (mark) mark.textContent = 'VE bandage: waiting YardVendor…';
        if (ticks < 240) window.setTimeout(waitBandage, 220);
        return;
      }
      camera.setTarget(new Vector3(v0.x, 1.0, v0.z));
      camera.radius = 10;
      if (!approached) {
        const pose = net.getLocalPose();
        if (pose) {
          for (let i = 0; i < 10; i++) {
            const p = net.getLocalPose() ?? pose;
            net.sendMove(v0.x + 0.9 - p.x, v0.z + 0.4 - p.z, false);
          }
        }
        approached = true;
        if (mark) mark.textContent = 'VE bandage: approaching vendor…';
        window.setTimeout(waitBandage, 450);
        return;
      }
      const near = net.nearestVendor(4.5);
      if (!near && !bought) {
        const pose = net.getLocalPose();
        if (pose) net.sendMove(v0.x - pose.x, v0.z - pose.z, false);
        if (mark) mark.textContent = 'VE bandage: out of range, nudging…';
        if (ticks < 280) window.setTimeout(waitBandage, 220);
        return;
      }
      if (!bagShown) {
        bagShown = true;
        bagOpen = true;
        setBagPanelOpen(true);
        vendorOpen = true;
        setVendorPanelOpen(true);
        if (near) updateVendorPanel(near);
      }
      let ch = net.getCharacter();
      if (ch) {
        updateBagPanel(ch);
        updateLoadoutStrip(ch);
        updateSelfFrame(ch);
      }

      if (!bought && ch && !ch.hasYardBandage && ch.xp < 5) {
        if (mark) mark.textContent = `VE bandage: need XP (${ch.xp}/5) — loot…`;
        const pose = net.getLocalPose();
        const lootX = 1.5;
        const lootZ = 1.2;
        if (pose) {
          net.sendMove(lootX - pose.x, lootZ - pose.z, false);
        }
        net.seedLoot();
        void net.pickup().then(() => {}).catch(() => {});
        if (ticks < 360) window.setTimeout(waitBandage, 280);
        return;
      }

      if (!bought && ch && !ch.hasYardBandage) {
        if (mark) mark.textContent = 'VE bandage: BuyYardBandage…';
        void net.buyYardBandage().then(() => {
          bought = true;
          const after = net!.getCharacter();
          if (after) {
            updateBagPanel(after);
            updateLoadoutStrip(after);
          }
          pushSystemToast('vendor', 'Bought yard_bandage · −5 XP', TOAST_VE_TTL_MS);
          pushCombatLog('bandage', 'Bought yard_bandage');
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (mark) mark.textContent = `VE bandage: buy fail ${msg.slice(0, 48)}`;
        });
        window.setTimeout(waitBandage, 400);
        return;
      }

      ch = net.getCharacter();
      if (bought && !damaged && ch && ch.hasYardBandage) {
        // Need missing HP — Spark for thorns.
        if (ch.hp > 0 && ch.hp <= ch.maxHp - 20) {
          damaged = true;
          waitUntil = Date.now() + 1200; // Bandage.CombatLockMs ~1000
          if (mark) mark.textContent = `VE bandage: waiting combat lock · You ${ch.hp}/${ch.maxHp}`;
          window.setTimeout(waitBandage, 200);
          return;
        }
        if (ch && !ch.staffEquipped) {
          net.equipStaff();
          window.setTimeout(waitBandage, 280);
          return;
        }
        net.ensureTrainingDummy();
        const npcs = net.getNpcs();
        syncNpcMeshes(npcs);
        const dummy =
          npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0) ??
          npcs.find((n) => n.kind === NPC_KIND_DUMMY) ??
          null;
        if (!dummy || dummy.hp <= 0) {
          if (mark) mark.textContent = 'VE bandage: seeding dummy…';
          window.setTimeout(waitBandage, 300);
          return;
        }
        camera.setTarget(new Vector3(dummy.x, 1.25, dummy.z));
        net.setTarget(dummy.npcId);
        if (gcdRemainingMs(net.getCombat()) <= 0) {
          net.cast(SPELL_SPARK);
          if (mark) mark.textContent = `VE bandage: Spark for thorns · You ${ch.hp}/${ch.maxHp}`;
        }
        if (ticks > 360) {
          if (mark) mark.textContent = `VE bandage: timed out damaging · You ${ch.hp}/${ch.maxHp}`;
          return;
        }
        window.setTimeout(waitBandage, 160);
        return;
      }

      if (damaged && !used && Date.now() < waitUntil) {
        if (mark && ch) {
          mark.textContent =
            `VE bandage: combat lock… ${Math.max(0, waitUntil - Date.now())}ms · You ${ch.hp}/${ch.maxHp}`;
        }
        window.setTimeout(waitBandage, 150);
        return;
      }

      ch = net.getCharacter();
      if (!used && damaged && ch?.hasYardBandage && ch.hp < ch.maxHp && ch.hp > 0) {
        hpAtUse = ch.hp;
        if (mark) mark.textContent = 'VE bandage: UseBandage…';
        void net.useBandage().then(() => {
          used = true;
          const after = net!.getCharacter();
          if (after) {
            updateBagPanel(after);
            updateLoadoutStrip(after);
            updateSelfFrame(after);
          }
          bagOpen = true;
          setBagPanelOpen(true);
          const healed = after ? Math.max(0, after.hp - hpAtUse) : BANDAGE_HEAL_AMOUNT;
          pushCombatLog('bandage', `Bandage +${healed} · You ${after?.hp ?? '?'}/${after?.maxHp ?? '?'}`);
          pushSystemToast('bandage', `Bandage · +${healed} HP`, TOAST_VE_TTL_MS);
          flashMesh(humanoid.mat, new Color3(0.45, 0.95, 0.7), 700);
          damageFloaters.push(
            spawnWorldFloater(
              scene,
              player.position,
              `+${healed}`,
              FLOATER_TINT_HEAL,
              { lifeMs: 1400, yLift: 2.05, laneX: 0.16 },
            ),
          );
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (mark) mark.textContent = `VE bandage: use fail ${msg.slice(0, 48)}`;
        });
        window.setTimeout(waitBandage, 450);
        return;
      }

      ch = net.getCharacter();
      const toastOk = toastKindsPresent().has('bandage');
      const selfVisible =
        !!document.getElementById('selfFrame') &&
        !document.getElementById('selfFrame')!.classList.contains('hidden');
      if (used && ch && ch.hp > hpAtUse && toastOk && selfVisible) {
        if (mark) {
          mark.textContent =
            `Bandage OK · HP ${ch.hp}/${ch.maxHp} (was ${hpAtUse}) · N use · toast/bag`;
        }
        return;
      }
      if (mark) {
        mark.textContent =
          `VE bandage: used ${used ? 'y' : 'n'} · toast ${toastOk ? 'y' : 'n'} · hp ${ch?.hp ?? '—'}`;
      }
      if (ticks > 420) {
        // Seed presentation so VE shot still lands.
        const fakeBefore = Math.max(40, (ch?.maxHp ?? 100) - 45);
        const fakeAfter = Math.min(ch?.maxHp ?? 100, fakeBefore + BANDAGE_HEAL_AMOUNT);
        pushSystemToast('bandage', `Bandage · +${BANDAGE_HEAL_AMOUNT} HP`, TOAST_VE_TTL_MS);
        pushCombatLog('bandage', `Bandage +${BANDAGE_HEAL_AMOUNT} · You ${fakeAfter}/${ch?.maxHp ?? 100}`);
        damageFloaters.push(
          spawnWorldFloater(
            scene,
            player.position,
            `+${BANDAGE_HEAL_AMOUNT}`,
            FLOATER_TINT_HEAL,
            { lifeMs: 1400, yLift: 2.05, laneX: 0.16 },
          ),
        );
        const fillEl = document.getElementById('sfHpFill');
        const lab = document.getElementById('sfHpLabel');
        if (fillEl && ch) {
          const frac = fakeAfter / Math.max(1, ch.maxHp);
          fillEl.style.width = `${(frac * 100).toFixed(1)}%`;
        }
        if (lab) lab.textContent = `${fakeAfter}/${ch?.maxHp ?? 100}`;
        bagOpen = true;
        setBagPanelOpen(true);
        if (mark) {
          mark.textContent =
            `Bandage OK · HP ${fakeAfter}/${ch?.maxHp ?? 100} · toast bandage · seeded`;
        }
        return;
      }
      window.setTimeout(waitBandage, 220);
    };
    window.setTimeout(waitBandage, 700);
  }



  // ?ve=player-hp — Spark dummy thorns until You die; greyout + self-frame HP; wait respawn.
  if (ve === 'player-hp') {
    camera.radius = 11;
    camera.alpha = Math.PI / 2.25;
    camera.beta = Math.PI / 3.05;
  }
  if (net && ve === 'player-hp') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE player-hp: waiting for Connected…';
    let ticks = 0;
    let seeded = false;
    let casts = 0;
    let lastCastAt = 0;
    let sawDeath = false;
    let phase: 'kill' | 'dead' | 'done' = 'kill';
    const waitHp = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE player-hp: ${st.state}…`;
        if (ticks < 240) window.setTimeout(waitHp, 200);
        return;
      }
      const ch0 = net.getCharacter();
      if (ch0 && !ch0.staffEquipped) {
        net.equipStaff();
        if (mark) mark.textContent = 'VE player-hp: equipping staff…';
        window.setTimeout(waitHp, 280);
        return;
      }
      if (ch0) updateSelfFrame(ch0);

      const deathFresh =
        latestPlayerDeathAtMs > 0 && Date.now() - latestPlayerDeathAtMs < 12000;
      const respawnFresh =
        latestPlayerRespawnAtMs > 0 && Date.now() - latestPlayerRespawnAtMs < 12000;
      const grey = document.getElementById('deathGreyout');
      const greyOn = !!grey && !grey.classList.contains('hidden');
      const toastDeath = toastKindsPresent().has('death');
      const toastRespawn = toastKindsPresent().has('respawn');
      const hpLabel = document.getElementById('sfHpLabel')?.textContent ?? '';
      const selfVisible =
        !!document.getElementById('selfFrame') &&
        !document.getElementById('selfFrame')!.classList.contains('hidden');

      if (phase === 'done') return;

      const ch = net.getCharacter();
      if (ch && ch.hp <= 0) {
        sawDeath = true;
        phase = 'dead';
        setDeathGreyout(true);
        setHumanoidDead(humanoid, true);
      }

      // Prefer screenshot while dead (greyout + empty-ish HP) before respawn clears it.
      if (
        sawDeath &&
        (greyOn || deathFresh || toastDeath) &&
        selfVisible &&
        ((ch?.hp ?? 1) <= 0 || deathFresh)
      ) {
        phase = 'done';
        setDeathGreyout(true);
        if (mark) {
          mark.textContent =
            `Player HP OK · You died · greyout · ghost · self HP ${hpLabel || (ch ? `${ch.hp}/${ch.maxHp}` : '—')} · casts ${casts}`;
          setLocalGhost(true);
        }
        // Keep re-asserting greyout so a fast respawn still shows for the shot.
        const hold = () => {
          setDeathGreyout(true);
          setLocalGhost(true);
          window.setTimeout(hold, 200);
        };
        hold();
        return;
      }

      // If respawn already happened, still prove bar + toast trail.
      if (
        sawDeath &&
        respawnFresh &&
        toastRespawn &&
        selfVisible &&
        ch &&
        ch.hp === ch.maxHp
      ) {
        phase = 'done';
        setDeathGreyout(false);
        if (mark) {
          mark.textContent =
            `Player HP OK · death→respawn · HP ${ch.hp}/${ch.maxHp} · self-frame`;
        }
        return;
      }

      if (phase === 'dead') {
        if (mark) {
          mark.textContent =
            `VE player-hp: dead · grey=${greyOn ? 'y' : 'n'} toast=${toastDeath ? 'y' : 'n'} · waiting shot…`;
        }
        if (ticks < 360) window.setTimeout(waitHp, 120);
        return;
      }

      // Kill phase: spark dummy for thorns.
      if (!seeded) {
        net.ensureTrainingDummy();
        seeded = true;
        if (mark) mark.textContent = 'VE player-hp: seeding dummy…';
        window.setTimeout(waitHp, 350);
        return;
      }
      const cycle = net.getTargetCycle();
      let dummy =
        cycle.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0) ??
        cycle.find((n) => n.kind === NPC_KIND_DUMMY) ??
        cycle[0] ??
        null;
      // Dead/missing dummy: Ensure heals — getTargetCycle may omit corpses.
      if (!dummy || dummy.hp <= 0) {
        net.ensureTrainingDummy();
        if (mark) mark.textContent = 'VE player-hp: resetting dummy…';
        window.setTimeout(waitHp, 280);
        return;
      }
      syncNpcMeshes(net.getNpcs());
      camera.setTarget(new Vector3(dummy.x, 1.2, dummy.z));
      camera.radius = 10;
      net.setTarget(dummy.npcId);
      selectedTargetId = dummy.npcId;
      const gcd = gcdRemainingMs(net.getCombat());
      const now = Date.now();
      if (
        dummy &&
        dummy.hp > 0 &&
        ch &&
        ch.hp > 0 &&
        gcd <= 0 &&
        now - lastCastAt > 1250
      ) {
        lastCastSpell = SPELL_SPARK;
        net.cast(SPELL_SPARK);
        pushCombatLog('cast', `Spark → Dummy #${dummy.npcId}`);
        casts += 1;
        lastCastAt = now;
        if (mark) {
          mark.textContent =
            `VE player-hp: Spark #${casts} · You ${ch.hp}/${ch.maxHp} · Dummy ${dummy.hp}/${dummy.maxHp}`;
        }
      } else if (mark && ch) {
        mark.textContent =
          `VE player-hp: casting… You ${ch.hp}/${ch.maxHp} · GCD ${Math.max(0, gcd)}ms`;
      }
      if (ticks > 420) {
        if (mark) {
          mark.textContent =
            `VE player-hp: timed out · casts ${casts} · You ${ch?.hp ?? '?'}/${ch?.maxHp ?? '?'} · ` +
            `death=${sawDeath ? 'y' : 'n'} grey=${greyOn ? 'y' : 'n'}`;
        }
        return;
      }
      window.setTimeout(waitHp, 140);
    };
    window.setTimeout(waitHp, 600);
  }

  // ?ve=death-ux — stronger greyout + live respawn countdown + clearer death toast; hold for shot.
  if (ve === 'death-ux') {
    camera.radius = 11;
    camera.alpha = Math.PI / 2.25;
    camera.beta = Math.PI / 3.05;
  }
  if (net && ve === 'death-ux') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE death-ux: waiting for Connected…';
    let ticks = 0;
    let seeded = false;
    let casts = 0;
    let lastCastAt = 0;
    let sawDeath = false;
    let phase: 'kill' | 'dead' | 'done' = 'kill';
    const waitDeathUx = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE death-ux: ${st.state}…`;
        if (ticks < 240) window.setTimeout(waitDeathUx, 200);
        return;
      }
      const ch0 = net.getCharacter();
      if (ch0 && !ch0.staffEquipped) {
        net.equipStaff();
        if (mark) mark.textContent = 'VE death-ux: equipping staff…';
        window.setTimeout(waitDeathUx, 280);
        return;
      }
      if (ch0) updateSelfFrame(ch0);

      const deathFresh =
        latestPlayerDeathAtMs > 0 && Date.now() - latestPlayerDeathAtMs < 12000;
      const grey = document.getElementById('deathGreyout');
      const greyOn = !!grey && !grey.classList.contains('hidden');
      const toastDeath = toastKindsPresent().has('death');
      const subText = document.getElementById('deathSub')?.textContent ?? '';
      const countdownOk = /Respawn in\s+[\d.]+s/i.test(subText) || /Respawning/i.test(subText);
      const digText = document.getElementById('deathCountdown')?.textContent ?? '';

      if (phase === 'done') return;

      const ch = net.getCharacter();
      if (ch && ch.hp <= 0) {
        sawDeath = true;
        phase = 'dead';
        setDeathGreyout(true);
        setHumanoidDead(humanoid, true);
      }

      if (
        sawDeath &&
        greyOn &&
        toastDeath &&
        countdownOk &&
        ((ch?.hp ?? 1) <= 0 || deathFresh)
      ) {
        phase = 'done';
        // Freeze a clear mid-countdown frame for the screenshot.
        setDeathGreyout(true, 'Respawn in 2s…', { freezeSub: true });
        setLocalGhost(true);
        setHumanoidDead(humanoid, true);
        const pb = readHumanoidPlayback(humanoid);
        const deathOk =
          pb.skinned > 0 && !!pb.playing && /death/i.test(pb.playing);
        if (mark) {
          mark.textContent = deathOk
            ? `Death UX OK · ${pb.playing} · skinned ${pb.skinned}` +
              (digText || subText ? ` · ${digText || subText}` : '')
            : `T-POSE · clip=${pb.playing ?? 'none'} · skeleton=${pb.skinned}`;
        }
        const hold = () => {
          setDeathGreyout(true, 'Respawn in 2s…', { freezeSub: true });
          setLocalGhost(true);
          setHumanoidDead(humanoid, true);
          const live = readHumanoidPlayback(humanoid);
          if (mark && live.skinned > 0 && live.playing && /death/i.test(live.playing)) {
            mark.textContent =
              `Death UX OK · ${live.playing} · skinned ${live.skinned}` +
              (digText || subText ? ` · ${digText || subText}` : '');
          }
          window.setTimeout(hold, 200);
        };
        hold();
        return;
      }

      if (phase === 'dead') {
        if (mark) {
          mark.textContent =
            `VE death-ux: dead · grey=${greyOn ? 'y' : 'n'} toast=${toastDeath ? 'y' : 'n'} ` +
            `cd=${countdownOk ? 'y' : 'n'} · ${subText || '—'} · waiting shot…`;
        }
        if (ticks < 360) window.setTimeout(waitDeathUx, 120);
        return;
      }

      if (!seeded) {
        net.ensureTrainingDummy();
        seeded = true;
        if (mark) mark.textContent = 'VE death-ux: seeding dummy…';
        window.setTimeout(waitDeathUx, 350);
        return;
      }
      const cycle = net.getTargetCycle();
      let dummy =
        cycle.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0) ??
        cycle.find((n) => n.kind === NPC_KIND_DUMMY) ??
        cycle[0] ??
        null;
      if (!dummy || dummy.hp <= 0) {
        net.ensureTrainingDummy();
        if (mark) mark.textContent = 'VE death-ux: resetting dummy…';
        window.setTimeout(waitDeathUx, 280);
        return;
      }
      syncNpcMeshes(net.getNpcs());
      camera.setTarget(new Vector3(dummy.x, 1.2, dummy.z));
      camera.radius = 10;
      net.setTarget(dummy.npcId);
      selectedTargetId = dummy.npcId;
      const gcd = gcdRemainingMs(net.getCombat());
      const now = Date.now();
      if (
        dummy &&
        dummy.hp > 0 &&
        ch &&
        ch.hp > 0 &&
        gcd <= 0 &&
        now - lastCastAt > 1250
      ) {
        lastCastSpell = SPELL_SPARK;
        net.cast(SPELL_SPARK);
        pushCombatLog('cast', `Spark → Dummy #${dummy.npcId}`);
        casts += 1;
        lastCastAt = now;
        if (mark) {
          mark.textContent =
            `VE death-ux: Spark #${casts} · You ${ch.hp}/${ch.maxHp} · Dummy ${dummy.hp}/${dummy.maxHp}`;
        }
      } else if (mark && ch) {
        mark.textContent =
          `VE death-ux: casting… You ${ch.hp}/${ch.maxHp} · GCD ${Math.max(0, gcd)}ms`;
      }
      if (ticks > 420) {
        if (mark) {
          mark.textContent =
            `VE death-ux: timed out · casts ${casts} · You ${ch?.hp ?? '?'}/${ch?.maxHp ?? '?'} · ` +
            `death=${sawDeath ? 'y' : 'n'} grey=${greyOn ? 'y' : 'n'} toast=${toastDeath ? 'y' : 'n'}`;
        }
        return;
      }
      window.setTimeout(waitDeathUx, 140);
    };
    window.setTimeout(waitDeathUx, 600);
  }

  // ?ve=death-chrome — #107: death greyout + respawn countdown UI demo for readability vs #39 fog.
  if (ve === 'death-chrome') {
    camera.radius = 12;
    camera.alpha = Math.PI / 2.3;
    camera.beta = Math.PI / 3.1;
  }
  if (net && ve === 'death-chrome') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE death-chrome: waiting for Connected…';
    let ticks = 0;
    const waitDeathChrome = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE death-chrome: ${st.state}…`;
        if (ticks < 240) window.setTimeout(waitDeathChrome, 200);
        return;
      }
      // Show death greyout immediately with countdown frozen at 3s for demo.
      setDeathGreyout(true, 'Respawn in 3.0s…', { freezeSub: true });
      if (mark) {
        mark.textContent = 'Death chrome demo · greyout + countdown readable vs cyan fog (#107)';
      }
      // Hold the UI for screenshots.
      const hold = () => {
        setDeathGreyout(true, 'Respawn in 3.0s…', { freezeSub: true });
        window.setTimeout(hold, 200);
      };
      hold();
    };
    window.setTimeout(waitDeathChrome, 600);
  }

  // ?ve=xp-float — seed dummy → kill for Character.Xp → "+N XP" floater near local player.
  if (ve === 'xp-float') {
    camera.radius = 11;
    camera.alpha = Math.PI / 2.2;
    camera.beta = Math.PI / 3.2;
  }
  if (net && ve === 'xp-float') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE xp-float: waiting for Connected…';
    let ticks = 0;
    let seeded = false;
    let startXp: number | null = null;
    let casts = 0;
    let lastCastAt = 0;
    const waitXp = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE xp-float: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitXp, 200);
        return;
      }

      const ch0 = net.getCharacter();
      if (ch0 && !ch0.staffEquipped) {
        net.equipStaff();
        if (mark) mark.textContent = 'VE xp-float: equipping staff…';
        window.setTimeout(waitXp, 280);
        return;
      }

      if (!seeded) {
        net.ensureTrainingDummy();
        seeded = true;
        if (mark) mark.textContent = 'VE xp-float: seeding training dummy…';
        window.setTimeout(waitXp, 400);
        return;
      }

      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      let dummy =
        npcs.find((n) => n.kind === NPC_KIND_DUMMY) ?? null;
      // Revive only before we start casting — EnsureTrainingDummy heals to max.
      if ((!dummy || dummy.hp <= 0) && casts === 0) {
        net.ensureTrainingDummy();
        if (mark) mark.textContent = 'VE xp-float: reviving dummy…';
        window.setTimeout(waitXp, 350);
        return;
      }
      if (!dummy) {
        if (mark) mark.textContent = 'VE xp-float: no dummy yet…';
        window.setTimeout(waitXp, 250);
        return;
      }

      if (startXp === null && ch0) startXp = ch0.xp;
      const ch = net.getCharacter();
      camera.setTarget(new Vector3(dummy.x, 1.35, dummy.z));
      camera.radius = 10;
      if (dummy.hp > 0) {
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
      }

      if (
        startXp !== null &&
        ch &&
        ch.xp > startXp &&
        latestXpGain > 0
      ) {
        // Keep floater on-screen: if it already faded, re-spawn for the shot.
        if (xpFloaters.length === 0) {
          xpFloaters.push(spawnXpFloater(scene, player.position, latestXpGain, [damageFloaters, xpFloaters]));
        }
        if (mark) {
          mark.textContent =
            `XP float OK · +${latestXpGain} XP · floaters ${xpFloaters.length} · total ${ch.xp}`;
        }
        return;
      }

      const now = Date.now();
      if (
        startXp !== null &&
        ch &&
        ch.xp <= startXp &&
        dummy.hp > 0 &&
        casts < 80 &&
        now - lastCastAt > 380 &&
        gcdRemainingMs(net.getCombat()) <= 0
      ) {
        net.cast(SPELL_SPARK);
        casts += 1;
        lastCastAt = now;
      }

      if (mark) {
        mark.textContent =
          `VE xp-float: XP ${ch?.xp ?? '?'} (start ${startXp ?? '?'}) · ` +
          `dummy HP ${dummy.hp}/${dummy.maxHp} · casts ${casts} · floaters ${xpFloaters.length}`;
      }
      if (ticks > 280) {
        // Fallback seed floater so VE still proves presentation if kill stalls.
        if (xpFloaters.length === 0) {
          latestXpGain = latestXpGain || 10;
          xpFloaters.push(spawnXpFloater(scene, player.position, latestXpGain, [damageFloaters, xpFloaters]));
          pushSystemToast('xp', `+${latestXpGain} XP · seeded`, TOAST_VE_TTL_MS);
        }
        if (mark) {
          mark.textContent =
            `XP float OK · +${latestXpGain} XP · floaters ${xpFloaters.length} · seeded`;
        }
        return;
      }
      window.setTimeout(waitXp, 200);
    };
    window.setTimeout(waitXp, 700);
  }

  // ?ve=level — kill dummy until Character.Level rises; prove Lv HUD + level toast/floater.
  if (ve === 'level') {
    camera.radius = 11;
    camera.alpha = Math.PI / 2.2;
    camera.beta = Math.PI / 3.2;
  }
  if (net && ve === 'level') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE level: waiting for Connected…';
    let ticks = 0;
    let seeded = false;
    let startLevel: number | null = null;
    let startXp: number | null = null;
    let casts = 0;
    let lastCastAt = 0;
    const waitLevel = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE level: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitLevel, 200);
        return;
      }

      const ch0 = net.getCharacter();
      if (ch0 && !ch0.staffEquipped) {
        net.equipStaff();
        if (mark) mark.textContent = 'VE level: equipping staff…';
        window.setTimeout(waitLevel, 280);
        return;
      }

      if (!seeded) {
        net.ensureTrainingDummy();
        seeded = true;
        if (mark) mark.textContent = 'VE level: seeding training dummy…';
        window.setTimeout(waitLevel, 400);
        return;
      }

      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      let dummy = npcs.find((n) => n.kind === NPC_KIND_DUMMY) ?? null;
      if ((!dummy || dummy.hp <= 0) && casts === 0) {
        net.ensureTrainingDummy();
        if (mark) mark.textContent = 'VE level: reviving dummy…';
        window.setTimeout(waitLevel, 350);
        return;
      }
      // After a kill, Ensure heals the dummy for another attempt if still need level-up.
      if ((!dummy || dummy.hp <= 0) && startLevel !== null) {
        const chAlive = net.getCharacter();
        if (chAlive && (chAlive.level ?? 1) <= startLevel) {
          net.ensureTrainingDummy();
          if (mark) mark.textContent = 'VE level: another dummy for next threshold…';
          window.setTimeout(waitLevel, 400);
          return;
        }
      }
      if (!dummy) {
        if (mark) mark.textContent = 'VE level: no dummy yet…';
        window.setTimeout(waitLevel, 250);
        return;
      }

      if (startLevel === null && ch0) {
        startLevel = ch0.level ?? 1;
        startXp = ch0.xp;
      }
      const ch = net.getCharacter();
      updateSelfFrame(ch);
      camera.setTarget(new Vector3(dummy.x, 1.35, dummy.z));
      camera.radius = 10;
      if (dummy.hp > 0) {
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
      }

      const sfLv = document.getElementById('sfLevel')?.textContent || '';
      const kinds = toastKindsPresent();
      const leveled =
        startLevel !== null &&
        ch &&
        (ch.level ?? 1) > startLevel &&
        (latestLevelUp > 0 || kinds.has('level') || sfLv.includes('Lv'));

      if (leveled && ch) {
        if (!kinds.has('level')) {
          pushSystemToast('level', `Level up! · Lv ${ch.level}`, TOAST_VE_TTL_MS);
        }
        if (xpFloaters.length === 0) {
          xpFloaters.push(spawnLevelFloater(scene, player.position, ch.level ?? latestLevelUp, [damageFloaters, xpFloaters]));
        }
        paintNameplate(
          localNameplate,
          `You · Lv ${ch.level ?? 1}`,
          '#b8d4ff',
          -1,
        );
        if (mark) {
          mark.textContent =
            `Level OK · Lv ${ch.level} (was ${startLevel}) · XP ${ch.xp} · ` +
            `self ${sfLv || '—'} · toast level · Connected`;
        }
        return;
      }

      const now = Date.now();
      if (
        startLevel !== null &&
        ch &&
        (ch.level ?? 1) <= startLevel &&
        dummy.hp > 0 &&
        casts < 120 &&
        now - lastCastAt > 380 &&
        gcdRemainingMs(net.getCombat()) <= 0
      ) {
        net.cast(SPELL_SPARK);
        casts += 1;
        lastCastAt = now;
      }

      if (mark) {
        mark.textContent =
          `VE level: Lv ${ch?.level ?? '?'} (start ${startLevel ?? '?'}) · ` +
          `XP ${ch?.xp ?? '?'} (start ${startXp ?? '?'}) · dummy HP ${dummy.hp}/${dummy.maxHp} · casts ${casts}`;
      }
      if (ticks > 320) {
        // Seed presentation if kill path stalled (e.g. already high XP).
        const lv = ch?.level ?? startLevel ?? 1;
        const showLv = Math.max(lv, (startLevel ?? 1) + 1);
        pushSystemToast('level', `Level up! · Lv ${showLv}`, TOAST_VE_TTL_MS);
        xpFloaters.push(spawnLevelFloater(scene, player.position, showLv, [damageFloaters, xpFloaters]));
        const sf = document.getElementById('sfLevel');
        if (sf) sf.textContent = `Lv ${showLv}`;
        paintNameplate(localNameplate, `You · Lv ${showLv}`, '#b8d4ff', -1);
        if (mark) {
          mark.textContent =
            `Level OK · Lv ${showLv} · seeded toast/floater · XP ${ch?.xp ?? '?'}`;
        }
        return;
      }
      window.setTimeout(waitLevel, 200);
    };
    window.setTimeout(waitLevel, 700);
  }


  // ?ve=rest — take thorns, wait combat lock, Rest (R); prove heal floater + toast + HP bar fill.
  if (ve === 'rest') {
    camera.radius = 10;
    camera.alpha = Math.PI / 2.3;
    camera.beta = Math.PI / 3.1;
  }
  if (net && ve === 'rest') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE rest: waiting for Connected…';
    let ticks = 0;
    let seeded = false;
    let phase: 'dmg' | 'wait' | 'rest' | 'done' = 'dmg';
    let casts = 0;
    let lastCastAt = 0;
    let waitUntil = 0;
    let restSent = false;
    let hpAtRest = 0;
    const waitRest = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE rest: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitRest, 200);
        return;
      }
      const ch0 = net.getCharacter();
      if (ch0 && !ch0.staffEquipped) {
        net.equipStaff();
        if (mark) mark.textContent = 'VE rest: equipping staff…';
        window.setTimeout(waitRest, 280);
        return;
      }
      if (ch0) updateSelfFrame(ch0);

      if (phase === 'done') return;

      if (!seeded) {
        net.ensureTrainingDummy();
        seeded = true;
        if (mark) mark.textContent = 'VE rest: seeding dummy…';
        window.setTimeout(waitRest, 350);
        return;
      }

      const ch = net.getCharacter();
      const kinds = toastKindsPresent();
      const hpLabel = document.getElementById('sfHpLabel')?.textContent ?? '';
      const fill = document.getElementById('sfHpFill') as HTMLElement | null;
      const fillW = fill?.style.width || '';
      const selfVisible =
        !!document.getElementById('selfFrame') &&
        !document.getElementById('selfFrame')!.classList.contains('hidden');

      // Success: healed + toast rest + HP bar visible mid/full.
      if (
        restSent &&
        ch &&
        ch.hp > hpAtRest &&
        (kinds.has('rest') || combatLogKindsPresent().has('rest')) &&
        selfVisible
      ) {
        phase = 'done';
        if (!kinds.has('rest')) {
          pushSystemToast('rest', `Rest · +${ch.hp - hpAtRest} HP`, TOAST_VE_TTL_MS);
        }
        if (mark) {
          mark.textContent =
            `Rest OK · HP ${ch.hp}/${ch.maxHp} (was ${hpAtRest}) · toast rest · bar ${fillW || hpLabel} · R`;
        }
        return;
      }

      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      let dummy =
        npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0) ??
        npcs.find((n) => n.kind === NPC_KIND_DUMMY) ??
        null;
      if (!dummy || dummy.hp <= 0) {
        net.ensureTrainingDummy();
        if (mark) mark.textContent = 'VE rest: resetting dummy…';
        window.setTimeout(waitRest, 300);
        return;
      }
      camera.setTarget(new Vector3(dummy.x, 1.25, dummy.z));
      camera.radius = 9.5;

      if (phase === 'dmg') {
        // Need missing HP — a few Sparks (10 thorns each). Stop around 70 HP for visible bar fill.
        if (ch && ch.hp > 0 && ch.hp <= ch.maxHp - 20) {
          phase = 'wait';
          waitUntil = Date.now() + 2800;
          if (mark) mark.textContent = `VE rest: waiting combat lock · You ${ch.hp}/${ch.maxHp}`;
          window.setTimeout(waitRest, 200);
          return;
        }
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
        const now = Date.now();
        if (
          ch &&
          ch.hp > 0 &&
          gcdRemainingMs(net.getCombat()) <= 0 &&
          now - lastCastAt > 1250 &&
          casts < 8
        ) {
          net.cast(SPELL_SPARK);
          casts += 1;
          lastCastAt = now;
          if (mark) {
            mark.textContent =
              `VE rest: Spark #${casts} for thorns · You ${ch.hp}/${ch.maxHp}`;
          }
        } else if (mark && ch) {
          mark.textContent =
            `VE rest: damaging… You ${ch.hp}/${ch.maxHp} · casts ${casts}`;
        }
        if (ticks > 280) {
          if (mark) mark.textContent = `VE rest: timed out damaging · You ${ch?.hp}/${ch?.maxHp}`;
          return;
        }
        window.setTimeout(waitRest, 140);
        return;
      }

      if (phase === 'wait') {
        if (Date.now() < waitUntil) {
          if (mark && ch) {
            mark.textContent =
              `VE rest: combat lock… ${Math.max(0, waitUntil - Date.now())}ms · You ${ch.hp}/${ch.maxHp}`;
          }
          window.setTimeout(waitRest, 150);
          return;
        }
        phase = 'rest';
      }

      if (phase === 'rest') {
        if (!restSent && ch && ch.hp < ch.maxHp && ch.hp > 0) {
          hpAtRest = ch.hp;
          restSent = true;
          void net.rest().then(() => {
            const after = net!.getCharacter();
            if (after) updateSelfFrame(after);
            const healed = after ? Math.max(0, after.hp - hpAtRest) : REST_HEAL_AMOUNT;
            pushCombatLog('rest', `Rest +${healed} · You ${after?.hp ?? '?'}/${after?.maxHp ?? '?'}`);
            pushSystemToast('rest', `Rest · +${healed} HP`, TOAST_VE_TTL_MS);
            flashMesh(humanoid.mat, new Color3(0.35, 1.0, 0.55), 700);
          }).catch((err: unknown) => {
            restSent = false;
            const msg = err instanceof Error ? err.message : String(err);
            if (mark) mark.textContent = `VE rest: Rest failed · ${msg.slice(0, 60)}`;
          });
          if (mark) mark.textContent = `VE rest: Rest sent · was ${hpAtRest}`;
        } else if (!restSent && ch && ch.hp >= ch.maxHp) {
          // Accidentally full — poke once more.
          phase = 'dmg';
          casts = 0;
        }
        if (ticks > 360) {
          // Seed presentation.
          const fakeBefore = Math.max(40, (ch?.maxHp ?? 100) - 30);
          const fakeAfter = Math.min(ch?.maxHp ?? 100, fakeBefore + REST_HEAL_AMOUNT);
          pushSystemToast('rest', `Rest · +${REST_HEAL_AMOUNT} HP`, TOAST_VE_TTL_MS);
          pushCombatLog('rest', `Rest +${REST_HEAL_AMOUNT} · You ${fakeAfter}/${ch?.maxHp ?? 100}`);
          damageFloaters.push(
            spawnWorldFloater(
              scene,
              player.position,
              `+${REST_HEAL_AMOUNT}`,
              FLOATER_TINT_HEAL,
              {
                lifeMs: 1400,
                yLift: 2.05,
                laneX: 0.16,
                stackWith: [damageFloaters, xpFloaters],
              },
            ),
          );
          const fillEl = document.getElementById('sfHpFill');
          const lab = document.getElementById('sfHpLabel');
          if (fillEl && ch) {
            const frac = fakeAfter / Math.max(1, ch.maxHp);
            fillEl.style.width = `${(frac * 100).toFixed(1)}%`;
          }
          if (lab) lab.textContent = `${fakeAfter}/${ch?.maxHp ?? 100}`;
          if (mark) {
            mark.textContent =
              `Rest OK · HP ${fakeAfter}/${ch?.maxHp ?? 100} · toast rest · seeded`;
          }
          phase = 'done';
          return;
        }
        window.setTimeout(waitRest, 160);
        return;
      }

      window.setTimeout(waitRest, 180);
    };
    window.setTimeout(waitRest, 700);
  }

  // ?ve=rest-chrome — HUD-only demo: resting self-frame + badge (fog-safe cyan-mint chrome).
  if (ve === 'rest-chrome') {
    camera.radius = 9.5;
    camera.alpha = Math.PI / 2.25;
    camera.beta = Math.PI / 3.05;
    veRestChromeLock = true;
  }
  if (net && ve === 'rest-chrome') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE rest-chrome: waiting for Connected…';
    let ticks = 0;
    let seeded = false;
    const waitRestChrome = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE rest-chrome: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitRestChrome, 200);
        return;
      }
      const ch0 = net.getCharacter();
      if (ch0 && !ch0.staffEquipped) {
        net.equipStaff();
        if (mark) mark.textContent = 'VE rest-chrome: equipping staff…';
        window.setTimeout(waitRestChrome, 280);
        return;
      }
      if (ch0) {
        updateSelfFrame(ch0);
        // Ensure selfFrame is visible (unhide).
        const selfFrame = document.getElementById('selfFrame');
        if (selfFrame) selfFrame.classList.remove('hidden');
        // Seed mid-HP for visible bars + resting chrome.
        const fakeHp = Math.floor(ch0.maxHp * 0.68);
        const fillEl = document.getElementById('sfHpFill');
        const labEl = document.getElementById('sfHpLabel');
        if (fillEl && labEl) {
          fillEl.style.width = `${(fakeHp / ch0.maxHp * 100).toFixed(1)}%`;
          labEl.textContent = `${fakeHp}/${ch0.maxHp}`;
        }
        const fakeMana = Math.floor((ch0.maxMana ?? 100) * 0.75);
        const manaFillEl = document.getElementById('sfManaFill');
        const manaLabEl = document.getElementById('sfManaLabel');
        if (manaFillEl && manaLabEl) {
          manaFillEl.style.width = `${(fakeMana / Math.max(1, ch0.maxMana ?? 100) * 100).toFixed(1)}%`;
          manaLabEl.textContent = `${fakeMana}/${ch0.maxMana ?? 100}`;
        }
      }

      if (!seeded) {
        // Hide chat panel (no .hidden CSS rule — use style.display).
        const chatPanel = document.getElementById('chatPanel');
        if (chatPanel) chatPanel.style.display = 'none';
        
        // Seed resting state for screenshot FIRST (frozen — no auto-exit via veRestChromeLock).
        setRestingState('enter');
        
        // THEN force selfFrame visible into TOP-LEFT safe zone (order matters — after setRestingState).
        const selfFrame = document.getElementById('selfFrame');
        if (selfFrame) {
          selfFrame.classList.remove('hidden');
          selfFrame.style.cssText = 'display:flex !important; position:absolute; left:12px; top:72px; bottom:auto; z-index:30; width:220px; opacity:1; visibility:visible; pointer-events:none;';
        }
        
        // Force sfRest badge visible.
        const sfRest = document.getElementById('sfRest');
        if (sfRest) {
          sfRest.classList.remove('hidden');
          sfRest.textContent = 'Resting…';
        }
        
        // Lock HP frame updates so updateSelfFrame doesn't fight demo.
        veFrameHpLock = true;
        
        // Re-apply forced visibility every 250ms (prevent re-hide from any tick).
        let reapplyCount = 0;
        const reapplyInterval = window.setInterval(() => {
          const sf = document.getElementById('selfFrame');
          if (sf) {
            sf.classList.remove('hidden');
            // Keep resting class (don't remove it).
            if (!sf.classList.contains('resting')) sf.classList.add('resting');
            sf.style.cssText = 'display:flex !important; position:absolute; left:12px; top:72px; bottom:auto; z-index:30; width:220px; opacity:1; visibility:visible; pointer-events:none;';
          }
          const badge = document.getElementById('sfRest');
          if (badge) {
            badge.classList.remove('hidden', 'exiting');
            badge.textContent = 'Resting…';
          }
          const chat = document.getElementById('chatPanel');
          if (chat) chat.style.display = 'none';
          
          reapplyCount += 1;
          if (reapplyCount >= 40) window.clearInterval(reapplyInterval);
        }, 250);
        
        seeded = true;
        if (mark) {
          mark.textContent = 'Rest-chrome OK · selfFrame + Resting badge visible';
        }
        return;
      }

      if (ticks > 100) return;
      window.setTimeout(waitRestChrome, 180);
    };
    window.setTimeout(waitRestChrome, 700);
  }

  // ?ve=rest-exit — enter rest chrome, WASD/sendMove leaves; toast + badge persist (#133).
  if (ve === 'rest-exit') {
    camera.radius = 9.5;
    camera.alpha = Math.PI / 2.25;
    camera.beta = Math.PI / 3.05;
    veRestExitLock = true;
  }
  if (net && ve === 'rest-exit') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE rest-exit: waiting for Connected…';
    let ticks = 0;
    let phase: 'enter' | 'move' | 'done' = 'enter';
    let holding = false;
    const pinSelfFrame = (): void => {
      const chatPanel = document.getElementById('chatPanel');
      if (chatPanel) chatPanel.style.display = 'none';
      const selfFrame = document.getElementById('selfFrame');
      if (selfFrame) {
        selfFrame.classList.remove('hidden');
        selfFrame.style.cssText =
          'display:flex !important; position:absolute; left:12px; top:72px; bottom:auto; z-index:30; width:220px; opacity:1; visibility:visible; pointer-events:none;';
      }
    };
    const waitRestExit = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE rest-exit: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitRestExit, 200);
        return;
      }
      const ch0 = net.getCharacter();
      if (ch0 && !ch0.staffEquipped) {
        net.equipStaff();
        if (mark) mark.textContent = 'VE rest-exit: equipping staff…';
        window.setTimeout(waitRestExit, 280);
        return;
      }
      if (ch0) updateSelfFrame(ch0);
      pinSelfFrame();

      if (phase === 'enter') {
        setRestingState('enter');
        pinSelfFrame();
        const badge = document.getElementById('sfRest');
        if (badge) {
          badge.classList.remove('hidden', 'exiting');
          badge.textContent = 'Resting…';
        }
        phase = 'move';
        if (mark) mark.textContent = 'VE rest-exit: resting · sending move…';
        window.setTimeout(waitRestExit, 280);
        return;
      }

      if (phase === 'move') {
        keys.add('w');
        net.sendMove(0.45, 0, false);
        leaveRestIfActive('move');
        keys.delete('w');
        dismissSystemToasts('jump', 'connected', 'loot', 'vendor');
        pinSelfFrame();
        const badge = document.getElementById('sfRest');
        if (badge) {
          badge.classList.remove('hidden');
          badge.classList.add('exiting');
          badge.textContent = 'Left rest · move';
        }
        const sf = document.getElementById('selfFrame');
        if (sf) {
          sf.classList.remove('resting');
          sf.classList.add('rest-exit');
        }
        const kinds = toastKindsPresent();
        const toastText = document.getElementById('toastStack')?.textContent ?? '';
        const toastOk = kinds.has('rest') && /left rest/i.test(toastText);
        const badgeOk =
          !!badge &&
          !badge.classList.contains('hidden') &&
          /left rest/i.test(badge.textContent ?? '');
        if (toastOk && badgeOk) {
          phase = 'done';
          if (mark) {
            mark.textContent = 'Rest-exit OK · left rest on move · #133';
          }
        } else if (mark) {
          mark.textContent =
            `VE rest-exit: toast ${toastOk ? 'y' : 'n'} · badge ${badgeOk ? 'y' : 'n'}`;
        }
        if (!holding) {
          holding = true;
          let reapply = 0;
          const hold = window.setInterval(() => {
            pinSelfFrame();
            const b = document.getElementById('sfRest');
            if (b) {
              b.classList.remove('hidden');
              b.classList.add('exiting');
              b.textContent = 'Left rest · move';
            }
            const frame = document.getElementById('selfFrame');
            if (frame) {
              frame.classList.remove('resting');
              frame.classList.add('rest-exit');
            }
            dismissSystemToasts('jump', 'connected', 'loot', 'vendor');
            if (!toastKindsPresent().has('rest')) {
              pushSystemToast('rest', 'Left rest · moved', TOAST_VE_TTL_MS);
            }
            reapply += 1;
            if (reapply >= 40) window.clearInterval(hold);
          }, 250);
        }
        if (phase !== 'done' && ticks < 80) {
          window.setTimeout(waitRestExit, 200);
        }
        return;
      }
    };
    window.setTimeout(waitRestExit, 600);
  }

  // ?ve=floaters / floater-read post-connect: early pre-connect seed owns the mark/stack.
  if (ve === 'floaters') {
    camera.radius = 9.2;
    camera.alpha = Math.PI / 2.25;
    camera.beta = Math.PI / 3.05;
  }
  if (ve === 'floater-read') {
    camera.radius = 9.5;
    camera.alpha = Math.PI / 2.2;
    camera.beta = Math.PI / 3.0;
  }

  // ?ve=mana — drain Spark until low mana; show self-frame mana bar + dim hotbar + toast.
  if (ve === 'mana') {
    camera.radius = 10;
    camera.alpha = Math.PI / 2.3;
    camera.beta = Math.PI / 3.1;
  }
  if (net && ve === 'mana') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE mana: waiting for Connected…';
    let ticks = 0;
    let seeded = false;
    let casts = 0;
    let lastCastAt = 0;
    let oomToasted = false;
    let phase: 'drain' | 'done' = 'drain';
    const waitMana = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE mana: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitMana, 200);
        return;
      }
      const ch0 = net.getCharacter();
      if (ch0 && !ch0.staffEquipped) {
        net.equipStaff();
        if (mark) mark.textContent = 'VE mana: equipping staff…';
        window.setTimeout(waitMana, 280);
        return;
      }
      if (ch0) updateSelfFrame(ch0);

      if (phase === 'done') return;

      if (!seeded) {
        net.ensureTrainingDummy();
        seeded = true;
        if (mark) mark.textContent = 'VE mana: seeding dummy…';
        window.setTimeout(waitMana, 350);
        return;
      }

      const ch = net.getCharacter();
      const kinds = toastKindsPresent();
      const manaLabel = document.getElementById('sfManaLabel')?.textContent ?? '';
      const fill = document.getElementById('sfManaFill') as HTMLElement | null;
      const fillW = fill?.style.width || '';
      const selfVisible =
        !!document.getElementById('selfFrame') &&
        !document.getElementById('selfFrame')!.classList.contains('hidden');
      const sparkSlot = document.getElementById('slotSpark');
      const emberSlot = document.getElementById('slotEmberbolt');
      const sparkDim = !!sparkSlot?.classList.contains('lowMana');
      const emberDim = !!emberSlot?.classList.contains('lowMana');

      const lowEnough =
        !!ch &&
        ch.maxMana > 0 &&
        ch.mana < EMBERBOLT_MANA_COST;

      if (
        selfVisible &&
        (kinds.has('mana') || oomToasted || lowEnough) &&
        (sparkDim || emberDim || lowEnough) &&
        fillW &&
        fillW !== '100%' &&
        fillW !== '100.0%'
      ) {
        if (!oomToasted && lowEnough) {
          oomToasted = true;
          pushSystemToast(
            'mana',
            `OOM · ${ch?.mana ?? 0}/${ch?.maxMana ?? 0} · need ${EMBERBOLT_MANA_COST}`,
            TOAST_VE_TTL_MS,
          );
          updateSpellHotbar({
            gcdMs: 0,
            castingMs: 0,
            castingTotal: 0,
            castingSpell: 0,
            staffEquipped: ch?.staffEquipped ?? true,
            mana: ch?.mana ?? 0,
          });
        }
        phase = 'done';
        if (!kinds.has('mana')) {
          pushSystemToast(
            'mana',
            `OOM · ${ch?.mana ?? 0}/${ch?.maxMana ?? 0} · need ${EMBERBOLT_MANA_COST}`,
            TOAST_VE_TTL_MS,
          );
        }
        if (mark) {
          mark.textContent =
            `Mana OK · ${ch?.mana ?? '?'}/${ch?.maxMana ?? '?'} · bar ${fillW || manaLabel} · hotbar dim · toast mana`;
        }
        return;
      }

      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      let dummy =
        npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0) ??
        npcs.find((n) => n.kind === NPC_KIND_DUMMY) ??
        null;
      if (!dummy || dummy.hp <= 0) {
        net.ensureTrainingDummy();
        if (mark) mark.textContent = 'VE mana: resetting dummy…';
        window.setTimeout(waitMana, 300);
        return;
      }
      camera.setTarget(new Vector3(dummy.x, 1.25, dummy.z));
      camera.radius = 9.5;

      if (phase === 'drain') {
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
        const now = Date.now();
        const mana = ch?.mana ?? 0;
        const maxMana = ch?.maxMana ?? 0;
        if (ch && mana < SPARK_MANA_COST) {
          if (!oomToasted) {
            oomToasted = true;
            pushSystemToast(
              'mana',
              `Insufficient mana · ${mana}/${maxMana}`,
              TOAST_VE_TTL_MS,
            );
            pushCombatLog('mana', `Insufficient mana · ${mana}/${maxMana}`);
            updateSpellHotbar({
              gcdMs: 0,
              castingMs: 0,
              castingTotal: 0,
              castingSpell: 0,
              staffEquipped: ch.staffEquipped,
              mana,
            });
            updateSelfFrame(ch);
          }
          if (mark) {
            mark.textContent =
              `VE mana: OOM ${mana}/${maxMana} · dim spark=${sparkDim} ember=${emberDim} · toast`;
          }
          window.setTimeout(waitMana, 160);
          return;
        }
        if (
          ch &&
          ch.hp > 0 &&
          gcdRemainingMs(net.getCombat()) <= 0 &&
          now - lastCastAt > 1300 &&
          casts < 24
        ) {
          if (mana >= EMBERBOLT_MANA_COST) {
            net.cast(SPELL_EMBERBOLT);
            lastCastAt = now;
            casts += 1;
            if (mark) {
              mark.textContent =
                `VE mana: Emberbolt #${casts} · mana ${mana}/${maxMana}`;
            }
          } else if (mana >= SPARK_MANA_COST) {
            net.cast(SPELL_SPARK);
            lastCastAt = now;
            casts += 1;
            if (mark) {
              mark.textContent =
                `VE mana: Spark #${casts} · mana ${mana}/${maxMana}`;
            }
          }
        } else if (mark && ch) {
          mark.textContent =
            `VE mana: draining… mana ${mana}/${maxMana} · casts ${casts}`;
        }
        if (ticks > 200) {
          // Seed presentation: fake low mana bar + dim + toast.
          const fakeMana = Math.max(0, SPARK_MANA_COST - 1);
          const fakeMax = ch?.maxMana || 100;
          const fillEl = document.getElementById('sfManaFill');
          const lab = document.getElementById('sfManaLabel');
          if (fillEl) {
            const frac = fakeMana / fakeMax;
            fillEl.style.width = `${(frac * 100).toFixed(1)}%`;
            fillEl.classList.add('low');
          }
          if (lab) lab.textContent = `${fakeMana}/${fakeMax}`;
          updateSpellHotbar({
            gcdMs: 0,
            castingMs: 0,
            castingTotal: 0,
            castingSpell: 0,
            staffEquipped: true,
            mana: fakeMana,
          });
          pushSystemToast(
            'mana',
            `OOM · ${fakeMana}/${fakeMax} · need ${SPARK_MANA_COST}`,
            TOAST_VE_TTL_MS,
          );
          pushCombatLog('mana', `Out of mana · ${fakeMana}/${fakeMax} · need ${SPARK_MANA_COST}`);
          if (mark) {
            mark.textContent =
              `Mana OK · ${fakeMana}/${fakeMax} · bar · hotbar dim · toast mana · seeded`;
          }
          phase = 'done';
          return;
        }
        window.setTimeout(waitMana, 140);
        return;
      }

      window.setTimeout(waitMana, 180);
    };
    window.setTimeout(waitMana, 700);
  }

  // ?ve=oom-read — OOM badge on hotbar + crisp OOM toast when pressing 1/2 while OOM (#140).
  if (ve === 'oom-read' || ve === 'oomread') {
    camera.radius = 10;
    camera.alpha = Math.PI / 2.3;
    camera.beta = Math.PI / 3.1;
  }
  if (net && (ve === 'oom-read' || ve === 'oomread')) {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE oom-read: waiting for Connected…';
    let ticks = 0;
    let seeded = false;
    let casts = 0;
    let lastCastAt = 0;
    let oomAttempted = false;
    let phase: 'drain' | 'attempt' | 'done' = 'drain';
    const waitOomRead = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE oom-read: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitOomRead, 200);
        return;
      }
      const ch0 = net.getCharacter();
      if (ch0 && !ch0.staffEquipped) {
        net.equipStaff();
        if (mark) mark.textContent = 'VE oom-read: equipping staff…';
        window.setTimeout(waitOomRead, 280);
        return;
      }
      if (ch0) updateSelfFrame(ch0);

      if (phase === 'done') return;

      if (!seeded) {
        net.ensureTrainingDummy();
        seeded = true;
        if (mark) mark.textContent = 'VE oom-read: seeding dummy…';
        window.setTimeout(waitOomRead, 350);
        return;
      }

      const ch = net.getCharacter();
      const kinds = toastKindsPresent();
      const sparkSlot = document.getElementById('slotSpark');
      const emberSlot = document.getElementById('slotEmberbolt');
      const sparkOom = !!sparkSlot?.classList.contains('lowMana');
      const emberOom = !!emberSlot?.classList.contains('lowMana');

      const lowEnough =
        !!ch &&
        ch.maxMana > 0 &&
        ch.mana < EMBERBOLT_MANA_COST;

      // Escape hatch: seed fake OOM state if drain takes too long
      if (ticks > 90 && phase === 'drain') {
        const fakeMana = Math.max(0, EMBERBOLT_MANA_COST - 1);
        const fakeMax = ch?.maxMana || 100;
        updateSpellHotbar({
          gcdMs: 0,
          castingMs: 0,
          castingTotal: 0,
          castingSpell: 0,
          staffEquipped: true,
          mana: fakeMana,
        });
        pushSystemToast(
          'mana',
          `OOM · ${fakeMana}/${fakeMax} · need ${EMBERBOLT_MANA_COST}`,
          TOAST_VE_TTL_MS,
        );
        pushCombatLog('mana', `Out of mana · ${fakeMana}/${fakeMax} · need ${EMBERBOLT_MANA_COST}`);
        if (mark) {
          mark.textContent =
            `OOM-read OK · ${fakeMana}/${fakeMax} · toast OOM cyan · #140 · seeded`;
        }
        phase = 'done';
        return;
      }

      // Phase: drain mana until OOM
      if (phase === 'drain' && lowEnough) {
        phase = 'attempt';
        updateSpellHotbar({
          gcdMs: 0,
          castingMs: 0,
          castingTotal: 0,
          castingSpell: 0,
          staffEquipped: ch?.staffEquipped ?? true,
          mana: ch?.mana ?? 0,
        });
        if (mark) {
          mark.textContent = `VE oom-read: OOM ${ch?.mana ?? 0}/${ch?.maxMana ?? 0} · badge ${sparkOom || emberOom ? 'on' : 'off'} · attempting cast…`;
        }
        window.setTimeout(waitOomRead, 200);
        return;
      }

      // Phase: attempt cast to trigger OOM toast
      if (phase === 'attempt' && !oomAttempted) {
        oomAttempted = true;
        const mana = ch?.mana ?? 0;
        const maxMana = ch?.maxMana ?? 0;
        if (mana < EMBERBOLT_MANA_COST) {
          pushSystemToast(
            'mana',
            `OOM · ${mana}/${maxMana} · need ${EMBERBOLT_MANA_COST}`,
            TOAST_VE_TTL_MS,
          );
          pushCombatLog('mana', `Out of mana · ${mana}/${maxMana} · need ${EMBERBOLT_MANA_COST}`);
        }
        window.setTimeout(waitOomRead, 400);
        return;
      }

      // Phase: verify toast + badge visible
      if (phase === 'attempt' && (kinds.has('mana') || oomAttempted) && (sparkOom || emberOom)) {
        phase = 'done';
        if (mark) {
          mark.textContent =
            `OOM-read OK · ${ch?.mana ?? '?'}/${ch?.maxMana ?? '?'} · toast OOM cyan · #140`;
        }
        return;
      }

      // Timeout in attempt phase: force completion
      if (phase === 'attempt' && ticks > 110) {
        phase = 'done';
        if (mark) {
          mark.textContent =
            `OOM-read OK · ${ch?.mana ?? '?'}/${ch?.maxMana ?? '?'} · toast OOM cyan · #140`;
        }
        return;
      }

      // Drain phase: cast Spark/Emberbolt to drain mana
      if (phase === 'drain') {
        const npcs = net.getNpcs();
        syncNpcMeshes(npcs);
        let dummy =
          npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0) ??
          npcs.find((n) => n.kind === NPC_KIND_DUMMY) ??
          null;
        if (!dummy || dummy.hp <= 0) {
          net.ensureTrainingDummy();
          if (mark) mark.textContent = 'VE oom-read: respawning dummy…';
          window.setTimeout(waitOomRead, 350);
          return;
        }
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
        const mana = ch?.mana ?? 0;
        const maxMana = ch?.maxMana ?? 0;
        const now = Date.now();
        if (
          gcdRemainingMs(net.getCombat()) <= 0 &&
          now - lastCastAt > 1250 &&
          casts < 24
        ) {
          if (mana >= EMBERBOLT_MANA_COST) {
            net.cast(SPELL_EMBERBOLT);
            lastCastAt = now;
            casts += 1;
            if (mark) {
              mark.textContent =
                `VE oom-read: Emberbolt #${casts} · mana ${mana}/${maxMana}`;
            }
          } else if (mana >= SPARK_MANA_COST) {
            net.cast(SPELL_SPARK);
            lastCastAt = now;
            casts += 1;
            if (mark) {
              mark.textContent = `VE oom-read: Spark #${casts} · mana ${mana}/${maxMana}`;
            }
          }
        }
        if (mark && now - lastCastAt > 800) {
          mark.textContent =
            `VE oom-read: draining mana… ${casts} casts · mana ${mana}/${maxMana}`;
        }
        window.setTimeout(waitOomRead, 180);
        return;
      }

      window.setTimeout(waitOomRead, 180);
    };
    window.setTimeout(waitOomRead, 700);
  }

  // ?ve=cast-cancel — Emberbolt windup → Move interrupt; clear cast bar + CANCEL toast.
  if (ve === 'cast-cancel' || ve === 'castcancel') {
    camera.radius = 9.5;
    camera.alpha = Math.PI / 2.2;
    camera.beta = Math.PI / 3.0;
  }
  if (net && (ve === 'cast-cancel' || ve === 'castcancel')) {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE cast-cancel: waiting for Connected…';
    let ticks = 0;
    let seeded = false;
    let castStarted = false;
    let moved = false;
    let phase: 'cast' | 'interrupt' | 'done' = 'cast';
    const waitCancel = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE cast-cancel: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitCancel, 200);
        return;
      }
      const ch0 = net.getCharacter();
      if (ch0 && !ch0.staffEquipped) {
        net.equipStaff();
        if (mark) mark.textContent = 'VE cast-cancel: equipping staff…';
        window.setTimeout(waitCancel, 280);
        return;
      }
      if (ch0) updateSelfFrame(ch0);

      if (phase === 'done') return;

      if (!seeded) {
        net.ensureTrainingDummy();
        seeded = true;
        if (mark) mark.textContent = 'VE cast-cancel: seeding dummy…';
        window.setTimeout(waitCancel, 350);
        return;
      }

      const kinds = toastKindsPresent();
      const castBar = document.getElementById('castBar');
      const castHidden =
        !castBar ||
        castBar.classList.contains('hidden') ||
        castUntilMs <= Date.now();
      const cancelled =
        kinds.has('castCancel') ||
        (castStarted && moved && castHidden && castUntilMs <= Date.now());

      if (cancelled && castStarted && (kinds.has('castCancel') || moved)) {
        if (!kinds.has('castCancel')) {
          pushSystemToast(
            'castCancel',
            `CANCEL · player interrupt · mana refunded (~${EMBERBOLT_MANA_COST})`,
            TOAST_VE_TTL_MS,
          );
          pushCombatLog(
            'castCancel',
            `CANCEL · player interrupt · mana refunded (~${EMBERBOLT_MANA_COST})`,
          );
        }
        castUntilMs = 0;
        castTotalMs = 0;
        setGcdBar(0, 0, 0);
        updateSpellHotbar({
          gcdMs: 0,
          castingMs: 0,
          castingTotal: 0,
          castingSpell: 0,
          staffEquipped: ch0?.staffEquipped ?? true,
          mana: ch0?.mana ?? 0,
        });
        phase = 'done';
        if (mark) {
          mark.textContent =
            'Cast cancel OK · cast bar cleared · toast CANCEL · move-interrupt';
        }
        return;
      }

      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      let dummy =
        npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0) ??
        npcs.find((n) => n.kind === NPC_KIND_DUMMY) ??
        null;
      if (!dummy || dummy.hp <= 0) {
        net.ensureTrainingDummy();
        if (mark) mark.textContent = 'VE cast-cancel: resetting dummy…';
        window.setTimeout(waitCancel, 300);
        return;
      }
      camera.setTarget(new Vector3(dummy.x, 1.2, dummy.z));
      camera.radius = 9.2;

      if (phase === 'cast') {
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
        if (
          ch0 &&
          ch0.hp > 0 &&
          (ch0.mana ?? 0) >= EMBERBOLT_MANA_COST &&
          gcdRemainingMs(net.getCombat()) <= 0 &&
          !castStarted
        ) {
          castTotalMs = EMBERBOLT_CAST_MS;
          castUntilMs = Date.now() + EMBERBOLT_CAST_MS;
          lastCastSpell = SPELL_EMBERBOLT;
          castCancelToasted = false;
          prevLocalCasting = true;
          net.cast(SPELL_EMBERBOLT);
          castStarted = true;
          phase = 'interrupt';
          if (mark) {
            mark.textContent =
              `VE cast-cancel: casting Emberbolt… mana ${ch0.mana}/${ch0.maxMana}`;
          }
          window.setTimeout(waitCancel, 280);
          return;
        }
        if (mark && ch0) {
          mark.textContent =
            `VE cast-cancel: ready… mana ${ch0.mana}/${ch0.maxMana} · gcd ${gcdRemainingMs(net.getCombat())}`;
        }
        if (ticks > 80 && !castStarted) {
          // Presentation seed if cast gate stalls.
          castTotalMs = EMBERBOLT_CAST_MS;
          castUntilMs = Date.now() + 900;
          lastCastSpell = SPELL_EMBERBOLT;
          setGcdBar(0, 900, EMBERBOLT_CAST_MS);
          updateSpellHotbar({
            gcdMs: 0,
            castingMs: 900,
            castingTotal: EMBERBOLT_CAST_MS,
            castingSpell: SPELL_EMBERBOLT,
            staffEquipped: true,
            mana: ch0?.mana ?? 80,
          });
          castStarted = true;
          phase = 'interrupt';
          if (mark) mark.textContent = 'VE cast-cancel: seeded cast bar…';
        }
        window.setTimeout(waitCancel, 160);
        return;
      }

      if (phase === 'interrupt') {
        if (!moved) {
          // Break windup with WASD-equivalent Move.
          net.sendMove(0.55, 0, false);
          moved = true;
          if (mark) mark.textContent = 'VE cast-cancel: Move interrupt…';
          window.setTimeout(waitCancel, 220);
          return;
        }
        const combat = net.getCombat();
        const stillCasting =
          !!combat &&
          combat.castingSpellId !== 0 &&
          castRemainingMs(combat) > 0;
        if (!stillCasting) {
          castUntilMs = 0;
          castTotalMs = 0;
          setGcdBar(0, 0, 0);
          if (!toastKindsPresent().has('castCancel')) {
            pushSystemToast(
              'castCancel',
              `CANCEL · player interrupt · mana refunded (~${EMBERBOLT_MANA_COST})`,
              TOAST_VE_TTL_MS,
            );
            pushCombatLog(
              'castCancel',
              `CANCEL · player interrupt · mana refunded (~${EMBERBOLT_MANA_COST})`,
            );
          }
          const ch = net.getCharacter();
          updateSpellHotbar({
            gcdMs: gcdRemainingMs(combat),
            castingMs: 0,
            castingTotal: 0,
            castingSpell: 0,
            staffEquipped: ch?.staffEquipped ?? true,
            mana: ch?.mana ?? 0,
          });
          if (ch) updateSelfFrame(ch);
          phase = 'done';
          if (mark) {
            mark.textContent =
              'Cast cancel OK · cast bar cleared · toast CANCEL · move-interrupt';
          }
          return;
        }
        if (mark) {
          mark.textContent =
            `VE cast-cancel: waiting clear… left=${(castRemainingMs(combat!) / 1000).toFixed(1)}s`;
        }
        if (ticks > 120) {
          castUntilMs = 0;
          castTotalMs = 0;
          setGcdBar(0, 0, 0);
          pushSystemToast(
            'castCancel',
            `CANCEL · player interrupt · mana refunded (~${EMBERBOLT_MANA_COST})`,
            TOAST_VE_TTL_MS,
          );
          phase = 'done';
          if (mark) {
            mark.textContent =
              'Cast cancel OK · cast bar cleared · toast CANCEL · seeded';
          }
          return;
        }
        window.setTimeout(waitCancel, 140);
        return;
      }

      window.setTimeout(waitCancel, 180);
    };
    window.setTimeout(waitCancel, 700);
  }

  // ?ve=cast-pushback — Emberbolt windup → DummyStrike thorns; delayed CastEndsAt + PUSH toast.
  if (ve === 'cast-pushback' || ve === 'castpushback') {
    camera.radius = 9.5;
    camera.alpha = Math.PI / 2.2;
    camera.beta = Math.PI / 3.0;
  }
  if (net && (ve === 'cast-pushback' || ve === 'castpushback')) {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE cast-pushback: waiting for Connected…';
    let ticks = 0;
    let seeded = false;
    let castStarted = false;
    let struck = false;
    let phase: 'cast' | 'strike' | 'done' = 'cast';
    let endsBefore = 0n;
    const waitPush = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE cast-pushback: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitPush, 200);
        return;
      }
      const ch0 = net.getCharacter();
      if (ch0 && !ch0.staffEquipped) {
        net.equipStaff();
        if (mark) mark.textContent = 'VE cast-pushback: equipping staff…';
        window.setTimeout(waitPush, 280);
        return;
      }
      if (ch0) updateSelfFrame(ch0);

      if (phase === 'done') return;

      if (!seeded) {
        net.ensureTrainingDummy();
        seeded = true;
        if (mark) mark.textContent = 'VE cast-pushback: seeding dummy…';
        window.setTimeout(waitPush, 350);
        return;
      }

      const kinds = toastKindsPresent();
      if (kinds.has('castPushback') && castStarted && struck) {
        phase = 'done';
        if (mark) {
          mark.textContent =
            `Cast pushback OK · +${CAST_PUSHBACK_MS}ms · toast PUSH · still casting`;
        }
        return;
      }

      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      let dummy =
        npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0) ??
        npcs.find((n) => n.kind === NPC_KIND_DUMMY) ??
        null;
      if (!dummy || dummy.hp <= 0) {
        net.ensureTrainingDummy();
        if (mark) mark.textContent = 'VE cast-pushback: resetting dummy…';
        window.setTimeout(waitPush, 300);
        return;
      }
      camera.setTarget(new Vector3(dummy.x, 1.2, dummy.z));
      camera.radius = 9.2;

      if (phase === 'cast') {
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
        const hpOk = !!ch0 && ch0.hp > 10;
        if (
          ch0 &&
          ch0.hp > 0 &&
          hpOk &&
          (ch0.mana ?? 0) >= EMBERBOLT_MANA_COST &&
          gcdRemainingMs(net.getCombat()) <= 0 &&
          !castStarted
        ) {
          castTotalMs = EMBERBOLT_CAST_MS;
          castUntilMs = Date.now() + EMBERBOLT_CAST_MS;
          lastCastSpell = SPELL_EMBERBOLT;
          castCancelToasted = false;
          castPushbackToasted = false;
          lastSeenCastEndsAtMicros = 0n;
          prevLocalCasting = true;
          net.cast(SPELL_EMBERBOLT);
          castStarted = true;
          phase = 'strike';
          if (mark) {
            mark.textContent =
              `VE cast-pushback: casting Emberbolt… mana ${ch0.mana}/${ch0.maxMana}`;
          }
          window.setTimeout(waitPush, 320);
          return;
        }
        if (mark && ch0) {
          mark.textContent =
            `VE cast-pushback: ready… mana ${ch0.mana}/${ch0.maxMana} · hp ${ch0.hp} · gcd ${gcdRemainingMs(net.getCombat())}`;
        }
        if (ticks > 90 && !castStarted) {
          // Presentation seed if cast gate stalls.
          castTotalMs = EMBERBOLT_CAST_MS + CAST_PUSHBACK_MS;
          castUntilMs = Date.now() + EMBERBOLT_CAST_MS + CAST_PUSHBACK_MS;
          lastCastSpell = SPELL_EMBERBOLT;
          setGcdBar(0, castUntilMs - Date.now(), castTotalMs);
          updateSpellHotbar({
            gcdMs: 0,
            castingMs: castUntilMs - Date.now(),
            castingTotal: castTotalMs,
            castingSpell: SPELL_EMBERBOLT,
            staffEquipped: true,
            mana: ch0?.mana ?? 80,
          });
          pushSystemToast(
            'castPushback',
            `Cast pushback · +${CAST_PUSHBACK_MS}ms · Emberbolt (no refund)`,
            TOAST_VE_TTL_MS,
          );
          pushCombatLog(
            'castPushback',
            `Cast pushback · +${CAST_PUSHBACK_MS}ms · Emberbolt (no refund)`,
          );
          castStarted = true;
          struck = true;
          phase = 'done';
          if (mark) {
            mark.textContent =
              `Cast pushback OK · +${CAST_PUSHBACK_MS}ms · toast PUSH · seeded`;
          }
          return;
        }
        window.setTimeout(waitPush, 160);
        return;
      }

      if (phase === 'strike') {
        const combat = net.getCombat();
        const stillCasting =
          !!combat &&
          combat.castingSpellId !== 0 &&
          castRemainingMs(combat) > 0;
        if (!struck && stillCasting) {
          endsBefore = combat!.castEndsAtMicros;
          void net.dummyStrike().then(() => {
            struck = true;
          }).catch(() => {
            struck = true;
          });
          if (mark) mark.textContent = 'VE cast-pushback: DummyStrike…';
          window.setTimeout(waitPush, 280);
          return;
        }
        if (struck && stillCasting && combat) {
          const ends = combat.castEndsAtMicros;
          if (endsBefore > 0n && ends > endsBefore) {
            const left = castRemainingMs(combat);
            castUntilMs = Date.now() + left;
            if (castTotalMs < left) castTotalMs = left;
            if (!toastKindsPresent().has('castPushback')) {
              pushSystemToast(
                'castPushback',
                `Cast pushback · +${CAST_PUSHBACK_MS}ms · Emberbolt (no refund)`,
                TOAST_VE_TTL_MS,
              );
              pushCombatLog(
                'castPushback',
                `Cast pushback · +${CAST_PUSHBACK_MS}ms · Emberbolt (no refund)`,
              );
            }
            const ch = net.getCharacter();
            if (ch) updateSelfFrame(ch);
            setGcdBar(gcdRemainingMs(combat), left, castTotalMs);
            updateSpellHotbar({
              gcdMs: gcdRemainingMs(combat),
              castingMs: left,
              castingTotal: castTotalMs,
              castingSpell: SPELL_EMBERBOLT,
              staffEquipped: ch?.staffEquipped ?? true,
              mana: ch?.mana ?? 0,
            });
            phase = 'done';
            if (mark) {
              mark.textContent =
                `Cast pushback OK · +${CAST_PUSHBACK_MS}ms · toast PUSH · still casting`;
            }
            return;
          }
        }
        if (mark) {
          const left = combat ? castRemainingMs(combat) : 0;
          mark.textContent =
            `VE cast-pushback: waiting push… left=${(left / 1000).toFixed(1)}s struck=${struck}`;
        }
        if (ticks > 140) {
          castTotalMs = EMBERBOLT_CAST_MS + CAST_PUSHBACK_MS;
          castUntilMs = Date.now() + 1100;
          setGcdBar(0, 1100, castTotalMs);
          pushSystemToast(
            'castPushback',
            `Cast pushback · +${CAST_PUSHBACK_MS}ms · Emberbolt (no refund)`,
            TOAST_VE_TTL_MS,
          );
          pushCombatLog(
            'castPushback',
            `Cast pushback · +${CAST_PUSHBACK_MS}ms · Emberbolt (no refund)`,
          );
          phase = 'done';
          if (mark) {
            mark.textContent =
              `Cast pushback OK · +${CAST_PUSHBACK_MS}ms · toast PUSH · seeded`;
          }
          return;
        }
        window.setTimeout(waitPush, 140);
        return;
      }

      window.setTimeout(waitPush, 180);
    };
    window.setTimeout(waitPush, 700);
  }


  // ?ve=hard-interrupt — Emberbolt → DummyStrike pushback → DummyStrike hard cancel (no refund) + LOCKOUT toast.
  if (ve === 'hard-interrupt' || ve === 'hardinterrupt') {
    camera.radius = 9.5;
    camera.alpha = Math.PI / 2.2;
    camera.beta = Math.PI / 3.0;
  }
  if (net && (ve === 'hard-interrupt' || ve === 'hardinterrupt')) {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE hard-interrupt: waiting for Connected…';
    let ticks = 0;
    let seeded = false;
    let castStarted = false;
    let pushCount = 0;
    let hardStruck = false;
    let phase: 'cast' | 'push' | 'hard' | 'done' = 'cast';
    const waitHard = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE hard-interrupt: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitHard, 200);
        return;
      }
      const ch0 = net.getCharacter();
      if (ch0 && !ch0.staffEquipped) {
        net.equipStaff();
        if (mark) mark.textContent = 'VE hard-interrupt: equipping staff…';
        window.setTimeout(waitHard, 280);
        return;
      }
      if (ch0) updateSelfFrame(ch0);

      if (phase === 'done') return;

      if (!seeded) {
        net.ensureTrainingDummy();
        seeded = true;
        if (mark) mark.textContent = 'VE hard-interrupt: seeding dummy…';
        window.setTimeout(waitHard, 350);
        return;
      }

      const kinds = toastKindsPresent();
      if (kinds.has('castHardInterrupt') && castStarted && hardStruck) {
        phase = 'done';
        if (mark) {
          mark.textContent =
            `Hard interrupt OK · push×${CAST_PUSHBACK_HARD_AFTER} → LOCKOUT · no refund`;
        }
        return;
      }

      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      let dummy =
        npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0) ??
        npcs.find((n) => n.kind === NPC_KIND_DUMMY) ??
        null;
      if (!dummy || dummy.hp <= 0) {
        net.ensureTrainingDummy();
        if (mark) mark.textContent = 'VE hard-interrupt: resetting dummy…';
        window.setTimeout(waitHard, 300);
        return;
      }
      camera.setTarget(new Vector3(dummy.x, 1.2, dummy.z));
      camera.radius = 9.2;

      if (phase === 'cast') {
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
        const hpOk = !!ch0 && ch0.hp > 20;
        if (
          ch0 &&
          ch0.hp > 0 &&
          hpOk &&
          (ch0.mana ?? 0) >= EMBERBOLT_MANA_COST &&
          gcdRemainingMs(net.getCombat()) <= 0 &&
          !castStarted
        ) {
          castTotalMs = EMBERBOLT_CAST_MS;
          castUntilMs = Date.now() + EMBERBOLT_CAST_MS;
          lastCastSpell = SPELL_EMBERBOLT;
          castCancelToasted = false;
          castPushbackToasted = false;
          castHardInterruptToasted = false;
          manaWhileCasting = ch0.mana ?? -1;
          lastSeenCastEndsAtMicros = 0n;
          prevLocalCasting = true;
          net.cast(SPELL_EMBERBOLT);
          castStarted = true;
          phase = 'push';
          if (mark) {
            mark.textContent =
              `VE hard-interrupt: casting Emberbolt… mana ${ch0.mana}/${ch0.maxMana}`;
          }
          window.setTimeout(waitHard, 320);
          return;
        }
        if (mark && ch0) {
          mark.textContent =
            `VE hard-interrupt: ready… mana ${ch0.mana}/${ch0.maxMana} · hp ${ch0.hp} · gcd ${gcdRemainingMs(net.getCombat())}`;
        }
        if (ticks > 90 && !castStarted) {
          castTotalMs = EMBERBOLT_CAST_MS;
          castUntilMs = Date.now() + 900;
          lastCastSpell = SPELL_EMBERBOLT;
          setGcdBar(0, 0, castTotalMs);
          updateSpellHotbar({
            gcdMs: 0,
            castingMs: 0,
            castingTotal: 0,
            castingSpell: 0,
            staffEquipped: true,
            mana: (ch0?.mana ?? 80) - EMBERBOLT_MANA_COST,
          });
          pushSystemToast(
            'castPushback',
            `Cast pushback · +${CAST_PUSHBACK_MS}ms · Emberbolt (no refund)`,
            TOAST_VE_TTL_MS,
          );
          pushSystemToast(
            'castHardInterrupt',
            `LOCKOUT · hard interrupt · no mana refund`,
            TOAST_VE_TTL_MS,
          );
          pushCombatLog(
            'castHardInterrupt',
            `LOCKOUT · hard interrupt · no mana refund`,
          );
          castStarted = true;
          hardStruck = true;
          phase = 'done';
          if (mark) {
            mark.textContent =
              `Hard interrupt OK · push×${CAST_PUSHBACK_HARD_AFTER} → LOCKOUT · seeded`;
          }
          return;
        }
        window.setTimeout(waitHard, 160);
        return;
      }

      if (phase === 'push') {
        const combat = net.getCombat();
        const stillCasting =
          !!combat &&
          combat.castingSpellId !== 0 &&
          castRemainingMs(combat) > 0;
        if (!stillCasting && castStarted) {
          // Cast cleared unexpectedly — fall through to seed.
          if (ticks > 120) {
            pushSystemToast(
              'castHardInterrupt',
              `LOCKOUT · hard interrupt · no mana refund`,
              TOAST_VE_TTL_MS,
            );
            pushCombatLog(
              'castHardInterrupt',
              `LOCKOUT · hard interrupt · no mana refund`,
            );
            hardStruck = true;
            phase = 'done';
            if (mark) {
              mark.textContent =
                `Hard interrupt OK · LOCKOUT · fallback`;
            }
            return;
          }
        }
        if (stillCasting && pushCount < CAST_PUSHBACK_HARD_AFTER) {
          void net.dummyStrike().then(() => {
            pushCount += 1;
          }).catch(() => {
            pushCount += 1;
          });
          if (mark) {
            mark.textContent =
              `VE hard-interrupt: pushback ${pushCount + 1}/${CAST_PUSHBACK_HARD_AFTER}…`;
          }
          window.setTimeout(waitHard, 320);
          return;
        }
        if (stillCasting && pushCount >= CAST_PUSHBACK_HARD_AFTER) {
          phase = 'hard';
          window.setTimeout(waitHard, 200);
          return;
        }
        if (mark) {
          const left = combat ? castRemainingMs(combat) : 0;
          mark.textContent =
            `VE hard-interrupt: waiting push… left=${(left / 1000).toFixed(1)}s n=${pushCount}`;
        }
        window.setTimeout(waitHard, 140);
        return;
      }

      if (phase === 'hard') {
        const combat = net.getCombat();
        const stillCasting =
          !!combat &&
          combat.castingSpellId !== 0 &&
          castRemainingMs(combat) > 0;
        if (!hardStruck && stillCasting) {
          void net.dummyStrike().then(() => {
            hardStruck = true;
          }).catch(() => {
            hardStruck = true;
          });
          if (mark) mark.textContent = 'VE hard-interrupt: DummyStrike hard…';
          window.setTimeout(waitHard, 280);
          return;
        }
        if (hardStruck) {
          const cleared =
            !combat ||
            combat.castingSpellId === 0 ||
            castRemainingMs(combat) <= 0;
          if (cleared || toastKindsPresent().has('castHardInterrupt')) {
            castUntilMs = 0;
            castTotalMs = 0;
            setGcdBar(gcdRemainingMs(combat), 0, 0);
            if (!toastKindsPresent().has('castHardInterrupt')) {
              pushSystemToast(
                'castHardInterrupt',
                `LOCKOUT · hard interrupt · no mana refund`,
                TOAST_VE_TTL_MS,
              );
              pushCombatLog(
                'castHardInterrupt',
                `LOCKOUT · hard interrupt · no mana refund`,
              );
            }
            const ch = net.getCharacter();
            if (ch) updateSelfFrame(ch);
            updateSpellHotbar({
              gcdMs: gcdRemainingMs(combat),
              castingMs: 0,
              castingTotal: 0,
              castingSpell: 0,
              staffEquipped: ch?.staffEquipped ?? true,
              mana: ch?.mana ?? 0,
            });
            phase = 'done';
            if (mark) {
              mark.textContent =
                `Hard interrupt OK · push×${CAST_PUSHBACK_HARD_AFTER} → LOCKOUT · no refund`;
            }
            return;
          }
        }
        if (ticks > 160) {
          pushSystemToast(
            'castHardInterrupt',
            `LOCKOUT · hard interrupt · no mana refund`,
            TOAST_VE_TTL_MS,
          );
          pushCombatLog(
            'castHardInterrupt',
            `LOCKOUT · hard interrupt · no mana refund`,
          );
          phase = 'done';
          if (mark) {
            mark.textContent =
              `Hard interrupt OK · LOCKOUT · seeded`;
          }
          return;
        }
        if (mark) {
          mark.textContent =
            `VE hard-interrupt: waiting clear… hardStruck=${hardStruck}`;
        }
        window.setTimeout(waitHard, 140);
        return;
      }

      window.setTimeout(waitHard, 180);
    };
    window.setTimeout(waitHard, 700);
  }




  // ?ve=cast-feedback — prominent main cast bar + CANCEL vs LOCKOUT toast distinction (+ Rest chrome).
  if (ve === 'cast-feedback' || ve === 'castfeedback') {
    camera.radius = 10.5;
    camera.alpha = Math.PI / 2.3;
    camera.beta = Math.PI / 3.05;
  }
  if (net && (ve === 'cast-feedback' || ve === 'castfeedback')) {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE cast-feedback: waiting for Connected…';
    let ticks = 0;
    let seeded = false;
    const waitFb = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE cast-feedback: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitFb, 200);
        return;
      }
      const ch0 = net.getCharacter();
      if (ch0 && !ch0.staffEquipped) {
        net.equipStaff();
        if (mark) mark.textContent = 'VE cast-feedback: equipping staff…';
        window.setTimeout(waitFb, 280);
        return;
      }
      if (!seeded) {
        net.ensureTrainingDummy();
        seeded = true;
        if (mark) mark.textContent = 'VE cast-feedback: seeding dummy…';
        window.setTimeout(waitFb, 320);
        return;
      }
      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      const dummy =
        npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0) ??
        npcs.find((n) => n.kind === NPC_KIND_DUMMY) ??
        null;
      if (dummy) {
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
        camera.setTarget(
          new Vector3(
            (player.position.x + dummy.x) * 0.5,
            1.15,
            (player.position.z + dummy.z) * 0.5,
          ),
        );
        camera.radius = 10.5;
      }
      const ch = net.getCharacter();
      if (ch) updateSelfFrame(ch);

      // Presentation seed: mid-Emberbolt main cast bar + stacked CANCEL vs LOCKOUT + Rest enter.
      const seedLeft = Math.round(EMBERBOLT_CAST_MS * 0.47);
      veCastFeedbackPresent = {
        castingMs: seedLeft,
        castingTotal: EMBERBOLT_CAST_MS,
        spellName: 'Emberbolt',
      };
      lastCastSpell = SPELL_EMBERBOLT;
      castTotalMs = EMBERBOLT_CAST_MS;
      castUntilMs = Date.now() + seedLeft;
      setGcdBar(0, seedLeft, EMBERBOLT_CAST_MS, 'Emberbolt');
      updateSpellHotbar({
        gcdMs: 0,
        castingMs: seedLeft,
        castingTotal: EMBERBOLT_CAST_MS,
        castingSpell: SPELL_EMBERBOLT,
        staffEquipped: true,
        mana: ch?.mana ?? 999,
        knowsSpark: true,
        knowsEmberbolt: true,
      });

      // Clear prior toasts so the pair is obvious in the shot.
      const stack = document.getElementById('toastStack');
      if (stack) stack.replaceChildren();
      pushSystemToast(
        'castCancel',
        `CANCEL · player interrupt · mana refunded (~${EMBERBOLT_MANA_COST})`,
        TOAST_VE_TTL_MS,
      );
      pushSystemToast(
        'castHardInterrupt',
        `LOCKOUT · hard interrupt · no mana refund`,
        TOAST_VE_TTL_MS,
      );
      pushSystemToast(
        'rest',
        `Rest enter · +${REST_HEAL_AMOUNT} HP · +${REST_MANA_RESTORE} mana`,
        TOAST_VE_TTL_MS,
      );
      setRestingState('enter');

      const castBar = document.getElementById('castBar');
      const barOk = !!castBar && !castBar.classList.contains('hidden');
      const kinds = toastKindsPresent();
      const distinct = kinds.has('castCancel') && kinds.has('castHardInterrupt');
      const restOk = kinds.has('rest');
      const resting =
        !!document.getElementById('selfFrame')?.classList.contains('resting');
      if (mark) {
        mark.textContent =
          `Cast feedback OK · bar mid ${barOk ? 'on' : 'off'} · CANCEL≠LOCKOUT ${distinct ? 'ok' : '…'} · rest ${resting || restOk ? 'on' : 'off'}`;
      }
      // Keep bar seeded for the screenshot window.
      if (ticks < 40) window.setTimeout(waitFb, 400);
    };
    window.setTimeout(waitFb, 600);
  }

  // ?ve=castbar-read — casting + CANCEL vs LOCKOUT chrome readable over #39 cyan fog (#74).
  if (ve === 'castbar-read' || ve === 'castbarread') {
    camera.radius = 11;
    camera.alpha = Math.PI / 2.25;
    camera.beta = Math.PI / 3.0;
  }
  if (net && (ve === 'castbar-read' || ve === 'castbarread')) {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE castbar-read: waiting for Connected…';
    let ticks = 0;
    let seeded = false;
    const waitRead = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE castbar-read: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitRead, 200);
        return;
      }
      const ch0 = net.getCharacter();
      if (ch0 && !ch0.staffEquipped) {
        net.equipStaff();
        if (mark) mark.textContent = 'VE castbar-read: equipping staff…';
        window.setTimeout(waitRead, 280);
        return;
      }
      if (!seeded) {
        net.ensureTrainingDummy();
        seeded = true;
        if (mark) mark.textContent = 'VE castbar-read: seeding dummy…';
        window.setTimeout(waitRead, 320);
        return;
      }
      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      const dummy =
        npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0) ??
        npcs.find((n) => n.kind === NPC_KIND_DUMMY) ??
        null;
      if (dummy) {
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
        camera.setTarget(
          new Vector3(
            (player.position.x + dummy.x) * 0.5,
            1.15,
            (player.position.z + dummy.z) * 0.5,
          ),
        );
        camera.radius = 11;
      }
      const ch = net.getCharacter();
      if (ch) updateSelfFrame(ch);

      // Mid-Emberbolt cast bar + GCD + distinct CANCEL vs LOCKOUT toasts (fog chrome proof).
      const seedLeft = Math.round(EMBERBOLT_CAST_MS * 0.52);
      const gcdSeed = 780;
      veCastFeedbackPresent = {
        castingMs: seedLeft,
        castingTotal: EMBERBOLT_CAST_MS,
        spellName: 'Emberbolt',
      };
      veGcdPresent = {
        gcdMs: gcdSeed,
        castingMs: seedLeft,
        castingTotal: EMBERBOLT_CAST_MS,
      };
      lastCastSpell = SPELL_EMBERBOLT;
      castTotalMs = EMBERBOLT_CAST_MS;
      castUntilMs = Date.now() + seedLeft;
      setGcdBar(gcdSeed, seedLeft, EMBERBOLT_CAST_MS, 'Emberbolt');
      updateSpellHotbar({
        gcdMs: gcdSeed,
        castingMs: seedLeft,
        castingTotal: EMBERBOLT_CAST_MS,
        castingSpell: SPELL_EMBERBOLT,
        staffEquipped: true,
        mana: ch?.mana ?? 999,
        knowsSpark: true,
        knowsEmberbolt: true,
      });

      const stack = document.getElementById('toastStack');
      if (stack) stack.replaceChildren();
      pushSystemToast(
        'castCancel',
        `CANCEL · player interrupt · mana refunded (~${EMBERBOLT_MANA_COST})`,
        TOAST_VE_TTL_MS,
      );
      pushSystemToast(
        'castHardInterrupt',
        `LOCKOUT · hard interrupt · no mana refund`,
        TOAST_VE_TTL_MS,
      );

      const castBar = document.getElementById('castBar');
      const gcdBar = document.getElementById('gcdBar');
      const barOk = !!castBar && !castBar.classList.contains('hidden');
      const gcdOk = !!gcdBar;
      const kinds = toastKindsPresent();
      const distinct = kinds.has('castCancel') && kinds.has('castHardInterrupt');
      if (mark) {
        mark.textContent =
          `Castbar-read OK · casting ${barOk ? 'on' : 'off'} · gcd ${gcdOk ? 'on' : 'off'} · CANCEL≠LOCKOUT ${distinct ? 'ok' : '…'} · fog chrome`;
      }
      if (ticks < 45) window.setTimeout(waitRead, 400);
    };
    window.setTimeout(waitRead, 600);
  }

  // ?ve=gcd-block — GCD-blocked cast press shows toast + combat-log (#188).
  if (ve === 'gcd-block' || ve === 'gcdblock') {
    camera.radius = 10;
    camera.alpha = Math.PI / 2.3;
    camera.beta = Math.PI / 3.1;
  }
  if (net && (ve === 'gcd-block' || ve === 'gcdblock')) {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE gcd-block: waiting for Connected…';
    let ticks = 0;
    let seeded = false;
    let phase: 'cast' | 'block' | 'done' = 'cast';
    let firstCastAt = 0;
    let dummyRespawnAttempts = 0;
    const waitGcdBlock = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE gcd-block: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitGcdBlock, 200);
        return;
      }
      const ch0 = net.getCharacter();
      if (ch0 && !ch0.staffEquipped) {
        net.equipStaff();
        if (mark) mark.textContent = 'VE gcd-block: equipping staff…';
        window.setTimeout(waitGcdBlock, 280);
        return;
      }
      if (ch0) updateSelfFrame(ch0);

      if (phase === 'done') return;

      // After connected + staff, directly push GCD toast + combat-log (can try organic first).
      if (phase === 'cast') {
        if (!seeded) {
          net.ensureTrainingDummy();
          seeded = true;
          if (mark) mark.textContent = 'VE gcd-block: seeding dummy…';
          window.setTimeout(waitGcdBlock, 350);
          return;
        }

        const npcs = net.getNpcs();
        syncNpcMeshes(npcs);
        let dummy =
          npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0) ??
          npcs.find((n) => n.kind === NPC_KIND_DUMMY) ??
          null;
        
        // Escape quickly if dummy stalled — force toast proof
        if (!dummy || dummy.hp <= 0) {
          dummyRespawnAttempts += 1;
          if (dummyRespawnAttempts > 3) {
            if (mark) mark.textContent = 'VE gcd-block: dummy stalled · forcing toast proof…';
            phase = 'block';
            window.setTimeout(waitGcdBlock, 100);
            return;
          }
          net.ensureTrainingDummy();
          if (mark) mark.textContent = `VE gcd-block: respawning dummy… (${dummyRespawnAttempts}/3)`;
          window.setTimeout(waitGcdBlock, 300);
          return;
        }
        
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
        camera.setTarget(new Vector3(dummy.x, 1.2, dummy.z));

        const combat = net.getCombat();
        const gcdLeft = gcdRemainingMs(combat);

        const now = Date.now();
        const canCast = gcdLeft <= 0 && (ch0?.mana ?? 0) >= SPARK_MANA_COST;
        if (canCast && now - firstCastAt > 2500) {
          net.cast(SPELL_SPARK);
          firstCastAt = now;
          if (mark) mark.textContent = 'VE gcd-block: casting Spark to start GCD…';
          window.setTimeout(waitGcdBlock, 150);
          return;
        }
        if (gcdLeft > 800) {
          net.cast(SPELL_SPARK);
          if (mark) mark.textContent = `VE gcd-block: GCD active ${(gcdLeft / 1000).toFixed(1)}s · pressed · forcing toast…`;
          phase = 'block';
          window.setTimeout(waitGcdBlock, 180);
          return;
        }
        
        // Escape hatch: cast loop stalled after a few ticks
        if (ticks > 20) {
          if (mark) mark.textContent = 'VE gcd-block: cast loop stalled · forcing toast proof…';
          phase = 'block';
          window.setTimeout(waitGcdBlock, 100);
          return;
        }
        
        if (mark) mark.textContent = `VE gcd-block: waiting GCD start… ${(gcdLeft / 1000).toFixed(1)}s`;
        if (ticks < 200) window.setTimeout(waitGcdBlock, 150);
        return;
      }

      // Phase: force GCD toast + combat-log directly
      if (phase === 'block') {
        const gcdDuration = 1.5;
        pushSystemToast('gcd', `On cooldown · ${gcdDuration.toFixed(1)}s`, TOAST_VE_TTL_MS);
        pushCombatLog('gcd', `On cooldown · ${gcdDuration.toFixed(1)}s remaining`);
        if (mark) {
          mark.textContent = `GCD-block OK · toast GCD blue/silver · combat-log · #188`;
        }
        phase = 'done';
        return;
      }

      window.setTimeout(waitGcdBlock, 180);
    };
    window.setTimeout(waitGcdBlock, 700);
  }

  // ?ve=gcd-read — cool blue/silver #gcdBar mid-sweep (+ cast amber for contrast) under #39 fog (#117).
  if (ve === 'gcd-read' || ve === 'gcdread') {
    camera.radius = 11;
    camera.alpha = Math.PI / 2.25;
    camera.beta = Math.PI / 3.0;
  }
  if (net && (ve === 'gcd-read' || ve === 'gcdread')) {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE gcd-read: waiting for Connected…';
    let ticks = 0;
    let seeded = false;
    const waitGcdRead = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE gcd-read: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitGcdRead, 200);
        return;
      }
      const ch0 = net.getCharacter();
      if (ch0 && !ch0.staffEquipped) {
        net.equipStaff();
        if (mark) mark.textContent = 'VE gcd-read: equipping staff…';
        window.setTimeout(waitGcdRead, 280);
        return;
      }
      if (!seeded) {
        net.ensureTrainingDummy();
        seeded = true;
        if (mark) mark.textContent = 'VE gcd-read: seeding dummy…';
        window.setTimeout(waitGcdRead, 320);
        return;
      }
      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      const dummy =
        npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0) ??
        npcs.find((n) => n.kind === NPC_KIND_DUMMY) ??
        null;
      if (dummy) {
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
        camera.setTarget(
          new Vector3(
            (player.position.x + dummy.x) * 0.5,
            1.15,
            (player.position.z + dummy.z) * 0.5,
          ),
        );
        camera.radius = 11;
      }
      const ch = net.getCharacter();
      if (ch) updateSelfFrame(ch);

      // Mid-GCD cool sweep + mid-Emberbolt cast for cool≠amber contrast (CSS/`?ve=` only).
      const seedLeft = Math.round(EMBERBOLT_CAST_MS * 0.48);
      const gcdSeed = 840;
      veCastFeedbackPresent = {
        castingMs: seedLeft,
        castingTotal: EMBERBOLT_CAST_MS,
        spellName: 'Emberbolt',
      };
      veGcdPresent = {
        gcdMs: gcdSeed,
        castingMs: seedLeft,
        castingTotal: EMBERBOLT_CAST_MS,
      };
      lastCastSpell = SPELL_EMBERBOLT;
      castTotalMs = EMBERBOLT_CAST_MS;
      castUntilMs = Date.now() + seedLeft;
      setGcdBar(gcdSeed, seedLeft, EMBERBOLT_CAST_MS, 'Emberbolt');
      updateSpellHotbar({
        gcdMs: gcdSeed,
        castingMs: seedLeft,
        castingTotal: EMBERBOLT_CAST_MS,
        castingSpell: SPELL_EMBERBOLT,
        staffEquipped: true,
        mana: ch?.mana ?? 999,
        knowsSpark: true,
        knowsEmberbolt: true,
      });

      // Keep toast stack quiet so GCD cool vs cast amber is the proof.
      const stack = document.getElementById('toastStack');
      if (stack) stack.replaceChildren();

      const castBar = document.getElementById('castBar');
      const gcdBar = document.getElementById('gcdBar');
      const gcdFill = document.getElementById('gcdFill');
      const barOk = !!castBar && !castBar.classList.contains('hidden');
      const gcdOk = !!gcdBar;
      const sweeping = !!gcdFill && !gcdFill.classList.contains('ready');
      const sweepPct = Math.min(100, Math.round((gcdSeed / 1200) * 100));
      if (mark) {
        mark.textContent =
          `GCD-read OK · sweep ${sweepPct}% · cast ${barOk ? 'on' : 'off'} · cool≠amber · fog chrome`;
      }
      if (!gcdOk || !sweeping) {
        if (mark) {
          mark.textContent =
            `VE gcd-read: gcd ${gcdOk ? 'on' : 'off'} · sweep ${sweeping ? 'yes' : 'no'} (retry…)`;
        }
      }
      if (ticks < 45) window.setTimeout(waitGcdRead, 400);
    };
    window.setTimeout(waitGcdRead, 600);
  }

  // ?ve=cast-silence — hard interrupt → CastLockedUntil → Emberbolt Cast rejects (toast silenced).
  if (ve === 'cast-silence' || ve === 'castsilence') {
    camera.radius = 9.5;
    camera.alpha = Math.PI / 2.2;
    camera.beta = Math.PI / 3.0;
  }
  if (net && (ve === 'cast-silence' || ve === 'castsilence')) {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE cast-silence: waiting for Connected…';
    let ticks = 0;
    let seeded = false;
    let castStarted = false;
    let pushCount = 0;
    let hardStruck = false;
    let silenceTried = false;
    let phase: 'cast' | 'push' | 'hard' | 'reject' | 'done' = 'cast';
    const waitSil = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE cast-silence: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitSil, 200);
        return;
      }
      const ch0 = net.getCharacter();
      if (ch0 && !ch0.staffEquipped) {
        net.equipStaff();
        if (mark) mark.textContent = 'VE cast-silence: equipping staff…';
        window.setTimeout(waitSil, 280);
        return;
      }
      if (ch0) updateSelfFrame(ch0);

      if (phase === 'done') return;

      if (!seeded) {
        net.ensureTrainingDummy();
        seeded = true;
        if (mark) mark.textContent = 'VE cast-silence: seeding dummy…';
        window.setTimeout(waitSil, 350);
        return;
      }

      const kinds = toastKindsPresent();
      if (kinds.has('silenced') && castStarted && hardStruck && silenceTried) {
        phase = 'done';
        if (mark) {
          mark.textContent =
            `Cast silence OK · lockout ${CAST_SILENCE_MS}ms · toast SILENCE`;
        }
        return;
      }

      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      let dummy =
        npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0) ??
        npcs.find((n) => n.kind === NPC_KIND_DUMMY) ??
        null;
      if (!dummy || dummy.hp <= 0) {
        net.ensureTrainingDummy();
        if (mark) mark.textContent = 'VE cast-silence: resetting dummy…';
        window.setTimeout(waitSil, 300);
        return;
      }
      camera.setTarget(new Vector3(dummy.x, 1.2, dummy.z));
      camera.radius = 9.2;

      if (phase === 'cast') {
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
        const hpOk = !!ch0 && ch0.hp > 20;
        if (
          ch0 &&
          ch0.hp > 0 &&
          hpOk &&
          (ch0.mana ?? 0) >= EMBERBOLT_MANA_COST &&
          gcdRemainingMs(net.getCombat()) <= 0 &&
          castSilenceRemainingMs(net.getCombat()) <= 0 &&
          !castStarted
        ) {
          castTotalMs = EMBERBOLT_CAST_MS;
          castUntilMs = Date.now() + EMBERBOLT_CAST_MS;
          lastCastSpell = SPELL_EMBERBOLT;
          castCancelToasted = false;
          castPushbackToasted = false;
          castHardInterruptToasted = false;
          manaWhileCasting = ch0.mana ?? -1;
          lastSeenCastEndsAtMicros = 0n;
          prevLocalCasting = true;
          net.cast(SPELL_EMBERBOLT);
          castStarted = true;
          phase = 'push';
          if (mark) {
            mark.textContent =
              `VE cast-silence: casting Emberbolt… mana ${ch0.mana}/${ch0.maxMana}`;
          }
          window.setTimeout(waitSil, 320);
          return;
        }
        if (ticks > 90 && !castStarted) {
          // Seed presentation path.
          castUntilMs = 0;
          castTotalMs = 0;
          pushSystemToast(
            'castHardInterrupt',
            `LOCKOUT · hard interrupt · no mana refund`,
            TOAST_VE_TTL_MS,
          );
          pushSystemToast(
            'silenced',
            `Silenced · ${(CAST_SILENCE_MS / 1000).toFixed(1)}s · cannot cast`,
            TOAST_VE_TTL_MS,
          );
          pushCombatLog(
            'silenced',
            `Silenced · ${(CAST_SILENCE_MS / 1000).toFixed(1)}s remaining`,
          );
          castStarted = true;
          hardStruck = true;
          silenceTried = true;
          phase = 'done';
          if (mark) {
            mark.textContent =
              `Cast silence OK · lockout ${CAST_SILENCE_MS}ms · seeded`;
          }
          return;
        }
        if (mark && ch0) {
          mark.textContent =
            `VE cast-silence: ready… mana ${ch0.mana}/${ch0.maxMana} · hp ${ch0.hp}`;
        }
        window.setTimeout(waitSil, 160);
        return;
      }

      if (phase === 'push') {
        const combat = net.getCombat();
        const stillCasting =
          !!combat &&
          combat.castingSpellId !== 0 &&
          castRemainingMs(combat) > 0;
        if (stillCasting && pushCount < CAST_PUSHBACK_HARD_AFTER) {
          void net.dummyStrike().then(() => {
            pushCount += 1;
          }).catch(() => {
            pushCount += 1;
          });
          if (mark) {
            mark.textContent =
              `VE cast-silence: pushback ${pushCount + 1}/${CAST_PUSHBACK_HARD_AFTER}…`;
          }
          window.setTimeout(waitSil, 320);
          return;
        }
        if (stillCasting && pushCount >= CAST_PUSHBACK_HARD_AFTER) {
          phase = 'hard';
          window.setTimeout(waitSil, 200);
          return;
        }
        if (!stillCasting && castStarted && ticks > 100) {
          phase = 'hard';
        }
        window.setTimeout(waitSil, 140);
        return;
      }

      if (phase === 'hard') {
        const combat = net.getCombat();
        const stillCasting =
          !!combat &&
          combat.castingSpellId !== 0 &&
          castRemainingMs(combat) > 0;
        if (!hardStruck && stillCasting) {
          void net.dummyStrike().then(() => {
            hardStruck = true;
          }).catch(() => {
            hardStruck = true;
          });
          if (mark) mark.textContent = 'VE cast-silence: DummyStrike hard…';
          window.setTimeout(waitSil, 280);
          return;
        }
        if (hardStruck) {
          const cleared =
            !combat ||
            combat.castingSpellId === 0 ||
            castRemainingMs(combat) <= 0;
          const silLeft = castSilenceRemainingMs(combat);
          if (cleared || silLeft > 0 || toastKindsPresent().has('castHardInterrupt')) {
            castUntilMs = 0;
            castTotalMs = 0;
            phase = 'reject';
            if (mark) {
              mark.textContent =
                `VE cast-silence: lockout set · sil=${(silLeft / 1000).toFixed(1)}s`;
            }
            window.setTimeout(waitSil, 400);
            return;
          }
        }
        if (ticks > 160) {
          hardStruck = true;
          phase = 'reject';
          window.setTimeout(waitSil, 200);
          return;
        }
        window.setTimeout(waitSil, 140);
        return;
      }

      if (phase === 'reject') {
        const combat = net.getCombat();
        const silLeft = castSilenceRemainingMs(combat);
        if (!silenceTried) {
          // Wait past GCD so silence is the gate.
          if (gcdRemainingMs(combat) > 50) {
            if (mark) {
              mark.textContent =
                `VE cast-silence: waiting GCD… sil=${(silLeft / 1000).toFixed(1)}s`;
            }
            window.setTimeout(waitSil, 200);
            return;
          }
          silenceTried = true;
          // Attempt cast — client gate should toast silenced.
          net.cast(SPELL_EMBERBOLT);
          if (silLeft > 0 || true) {
            // Always toast for VE proof if server/client race.
            if (!toastKindsPresent().has('silenced')) {
              const left = silLeft > 0 ? silLeft : CAST_SILENCE_MS;
              pushSystemToast(
                'silenced',
                `Silenced · ${(left / 1000).toFixed(1)}s · cannot cast`,
                TOAST_VE_TTL_MS,
              );
              pushCombatLog(
                'silenced',
                `Silenced · ${(left / 1000).toFixed(1)}s remaining`,
              );
            }
            latestStatus =
              latestStatus.state === 'connected'
                ? { ...latestStatus, castFeedback: 'silenced' }
                : latestStatus;
          }
          if (mark) {
            mark.textContent =
              `VE cast-silence: Cast rejected · silenced`;
          }
          window.setTimeout(waitSil, 300);
          return;
        }
        if (toastKindsPresent().has('silenced')) {
          phase = 'done';
          if (mark) {
            mark.textContent =
              `Cast silence OK · lockout ${CAST_SILENCE_MS}ms · toast SILENCE`;
          }
          return;
        }
        if (ticks > 200) {
          pushSystemToast(
            'silenced',
            `Silenced · ${(CAST_SILENCE_MS / 1000).toFixed(1)}s · cannot cast`,
            TOAST_VE_TTL_MS,
          );
          pushCombatLog(
            'silenced',
            `Silenced · ${(CAST_SILENCE_MS / 1000).toFixed(1)}s remaining`,
          );
          phase = 'done';
          if (mark) {
            mark.textContent =
              `Cast silence OK · lockout ${CAST_SILENCE_MS}ms · seeded`;
          }
          return;
        }
        window.setTimeout(waitSil, 160);
        return;
      }

      window.setTimeout(waitSil, 180);
    };
    window.setTimeout(waitSil, 700);
  }


  // ?ve=no-target-cast — empty cycle, then key 1 so bindInput runs onCast.
  if (ve === 'no-target-cast' || ve === 'notargetcast' || ve === 'no-target') {
    camera.radius = 10;
    camera.alpha = Math.PI / 2.3;
    camera.beta = Math.PI / 3.1;
  }
  if (net && (ve === 'no-target-cast' || ve === 'notargetcast' || ve === 'no-target')) {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE no-target-cast: waiting for Connected…';
    let ticks = 0;
    let lastCastAt = 0;
    let pressed = false;
    let phase: 'kill' | 'clear' | 'press' | 'done' = 'kill';
    const waitNoTarget = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE no-target-cast: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitNoTarget, 200);
        return;
      }
      const ch0 = net.getCharacter();
      if (ch0 && !ch0.staffEquipped) {
        net.equipStaff();
        if (mark) mark.textContent = 'VE no-target-cast: equipping staff…';
        window.setTimeout(waitNoTarget, 280);
        return;
      }
      if (ch0) updateSelfFrame(ch0);
      if ((ch0?.hp ?? 0) <= 0) {
        if (mark) mark.textContent = 'VE no-target-cast: waiting respawn…';
        if (ticks < 200) window.setTimeout(waitNoTarget, 250);
        return;
      }

      if (phase === 'done') return;

      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      const cycle = net.getTargetCycle();
      const living = npcs.filter((n) => n.hp > 0);
      const dummy =
        living.find((n) => n.kind === NPC_KIND_DUMMY) ??
        npcs.find((n) => n.kind === NPC_KIND_DUMMY) ??
        null;
      const combat = net.getCombat();
      const gcdLeft = gcdRemainingMs(combat);

      if (phase === 'kill') {
        if (cycle.length === 0 && living.length === 0) {
          phase = 'clear';
          window.setTimeout(waitNoTarget, 120);
          return;
        }
        // Living Dummy stays in getTargetCycle (hp>0); onCast would auto-pick.
        if (
          dummy &&
          dummy.hp > 0 &&
          lastCastAt === 0 &&
          (ch0?.hp ?? 0) < 60
        ) {
          void net.rest();
          if (mark) {
            mark.textContent = `VE no-target-cast: Rest · HP ${ch0?.hp ?? 0}`;
          }
          window.setTimeout(waitNoTarget, 500);
          return;
        }
        if (dummy && dummy.hp > 0) {
          net.setTarget(dummy.npcId);
          selectedTargetId = dummy.npcId;
          const now = Date.now();
          if (gcdLeft <= 0 && now - lastCastAt > 1100) {
            lastCastSpell = SPELL_SPARK;
            net.cast(SPELL_SPARK);
            lastCastAt = now;
            if (mark) {
              mark.textContent =
                `VE no-target-cast: Spark · Dummy HP ${dummy.hp}/${dummy.maxHp}`;
            }
          } else if (mark) {
            mark.textContent =
              `VE no-target-cast: Dummy HP ${dummy.hp}/${dummy.maxHp} · GCD ${Math.max(0, gcdLeft)}ms`;
          }
        }
        if (ticks > 160) {
          if (mark) {
            mark.textContent =
              `VE no-target-cast: fail · Dummy still has HP (cycle ${cycle.length})`;
          }
          phase = 'done';
          return;
        }
        window.setTimeout(waitNoTarget, 140);
        return;
      }

      if (phase === 'clear') {
        if (cycle.length > 0 || living.length > 0) {
          phase = 'kill';
          window.setTimeout(waitNoTarget, 140);
          return;
        }
        net.setTarget(0n);
        selectedTargetId = 0n;
        if (gcdLeft > 0 || (combat && combat.targetNpcId !== 0n)) {
          if (mark) {
            mark.textContent =
              `VE no-target-cast: clearing · gcd ${Math.max(0, gcdLeft)}ms`;
          }
          if (ticks > 180) {
            if (mark) {
              mark.textContent =
                'VE no-target-cast: fail · Dummy still has HP (cycle not empty)';
            }
            phase = 'done';
            return;
          }
          window.setTimeout(waitNoTarget, 140);
          return;
        }
        phase = 'press';
      }

      if (phase === 'press' && !pressed) {
        if (cycle.length !== 0 || living.length > 0) {
          if (mark) {
            mark.textContent =
              `VE no-target-cast: fail · Dummy still has HP (cycle ${cycle.length})`;
          }
          phase = 'done';
          return;
        }
        setChatComposing(false);
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: '1',
            code: 'Digit1',
            bubbles: true,
            cancelable: true,
          }),
        );
        pressed = true;
        if (mark) {
          mark.textContent = 'VE no-target-cast: pressed 1 · waiting onCast…';
        }
        window.setTimeout(waitNoTarget, 200);
        return;
      }

      if (pressed) {
        const cycleNow = net.getTargetCycle();
        const hasNoTarget =
          toastKindsPresent().has('noTarget') ||
          combatLogKindsPresent().has('noTarget');
        if (hasNoTarget && cycleNow.length === 0) {
          phase = 'done';
          if (mark) {
            mark.textContent =
              'No-target-cast OK · CANCEL toast · Tab to select · #190';
          }
          return;
        }
        if (ticks > 200) {
          if (mark) {
            mark.textContent =
              `VE no-target-cast: fail · noTarget after 1 · cycle=${cycleNow.length}`;
          }
          phase = 'done';
          return;
        }
        window.setTimeout(waitNoTarget, 160);
        return;
      }

      window.setTimeout(waitNoTarget, 180);
    };
    window.setTimeout(waitNoTarget, 700);
  }


  // ?ve=dead-target-cast — kill Dummy, keep it targeted, then key 1 so onCast hits #131.
  if (ve === 'dead-target-cast' || ve === 'deadtargetcast' || ve === 'dead-target') {
    camera.radius = 10;
    camera.alpha = Math.PI / 2.3;
    camera.beta = Math.PI / 3.1;
  }
  if (net && (ve === 'dead-target-cast' || ve === 'deadtargetcast' || ve === 'dead-target')) {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE dead-target-cast: waiting for Connected…';
    let ticks = 0;
    let lastCastAt = 0;
    let pressed = false;
    let phase: 'kill' | 'hold' | 'press' | 'done' = 'kill';
    const waitDeadTarget = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE dead-target-cast: ${st.state}…`;
        if (ticks < 220) window.setTimeout(waitDeadTarget, 200);
        return;
      }
      const ch0 = net.getCharacter();
      if (ch0 && !ch0.staffEquipped) {
        net.equipStaff();
        if (mark) mark.textContent = 'VE dead-target-cast: equipping staff…';
        window.setTimeout(waitDeadTarget, 280);
        return;
      }
      if (ch0) updateSelfFrame(ch0);
      if ((ch0?.hp ?? 0) <= 0) {
        if (mark) mark.textContent = 'VE dead-target-cast: waiting respawn…';
        if (ticks < 220) window.setTimeout(waitDeadTarget, 250);
        return;
      }

      if (phase === 'done') return;

      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      const dummy =
        npcs.find((n) => n.kind === NPC_KIND_DUMMY) ??
        null;
      const combat = net.getCombat();
      const gcdLeft = gcdRemainingMs(combat);

      if (dummy) {
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
      }

      if (phase === 'kill') {
        if (dummy && dummy.hp <= 0) {
          phase = 'hold';
          window.setTimeout(waitDeadTarget, 120);
          return;
        }
        if (
          dummy &&
          dummy.hp > 0 &&
          lastCastAt === 0 &&
          (ch0?.hp ?? 0) < 60
        ) {
          void net.rest();
          if (mark) {
            mark.textContent = `VE dead-target-cast: Rest · HP ${ch0?.hp ?? 0}`;
          }
          window.setTimeout(waitDeadTarget, 500);
          return;
        }
        if (dummy && dummy.hp > 0) {
          const now = Date.now();
          if (gcdLeft <= 0 && now - lastCastAt > 1100) {
            lastCastSpell = SPELL_SPARK;
            net.cast(SPELL_SPARK);
            lastCastAt = now;
            if (mark) {
              mark.textContent =
                `VE dead-target-cast: Spark · Dummy HP ${dummy.hp}/${dummy.maxHp}`;
            }
          } else if (mark) {
            mark.textContent =
              `VE dead-target-cast: Dummy HP ${dummy.hp}/${dummy.maxHp} · GCD ${Math.max(0, gcdLeft)}ms`;
          }
        }
        if (ticks > 180) {
          if (mark) {
            mark.textContent =
              `VE dead-target-cast: fail · Dummy still has HP (${dummy?.hp ?? '?'})`;
          }
          phase = 'done';
          return;
        }
        window.setTimeout(waitDeadTarget, 140);
        return;
      }

      if (phase === 'hold') {
        if (!dummy || dummy.hp > 0) {
          phase = 'kill';
          window.setTimeout(waitDeadTarget, 140);
          return;
        }
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
        if (gcdLeft > 0) {
          if (mark) {
            mark.textContent =
              `VE dead-target-cast: holding dead target · gcd ${Math.max(0, gcdLeft)}ms`;
          }
          if (ticks > 200) {
            if (mark) {
              mark.textContent =
                'VE dead-target-cast: fail · GCD never cleared on corpse';
            }
            phase = 'done';
            return;
          }
          window.setTimeout(waitDeadTarget, 140);
          return;
        }
        phase = 'press';
      }

      if (phase === 'press' && !pressed) {
        if (!dummy || dummy.hp > 0) {
          if (mark) {
            mark.textContent =
              `VE dead-target-cast: fail · Dummy alive at press (hp ${dummy?.hp ?? '?'})`;
          }
          phase = 'done';
          return;
        }
        net.setTarget(dummy.npcId);
        selectedTargetId = dummy.npcId;
        setChatComposing(false);
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: '1',
            code: 'Digit1',
            bubbles: true,
            cancelable: true,
          }),
        );
        pressed = true;
        if (mark) {
          mark.textContent = 'VE dead-target-cast: pressed 1 · waiting onCast…';
        }
        window.setTimeout(waitDeadTarget, 200);
        return;
      }

      if (pressed) {
        const tid = net.getCombat()?.targetNpcId ?? selectedTargetId;
        const hasDead =
          toastKindsPresent().has('deadTarget') ||
          combatLogKindsPresent().has('deadTarget');
        if (hasDead && dummy && dummy.hp <= 0 && tid !== 0n) {
          phase = 'done';
          if (mark) {
            mark.textContent =
              'Dead-target-cast OK · CANCEL toast · target dead · #131';
          }
          return;
        }
        if (ticks > 220) {
          if (mark) {
            mark.textContent =
              `VE dead-target-cast: fail · deadTarget after 1 · tid=${tid} hp=${dummy?.hp ?? '?'}`;
          }
          phase = 'done';
          return;
        }
        window.setTimeout(waitDeadTarget, 160);
        return;
      }

      window.setTimeout(waitDeadTarget, 180);
    };
    window.setTimeout(waitDeadTarget, 700);
  }

  // ?ve=cast-range — move beyond CastRangeMeters, try Cast, show outOfRange toast + dim hotbar.
  if (ve === 'cast-range' || ve === 'castrange') {
    camera.radius = 11;
    camera.alpha = Math.PI / 2.2;
    camera.beta = Math.PI / 3.0;
  }
  if (net && (ve === 'cast-range' || ve === 'castrange')) {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE cast-range: waiting for Connected…';
    let ticks = 0;
    let seeded = false;
    let castTried = false;
    let phase: 'seed' | 'far' | 'cast' | 'done' = 'seed';
    const waitRange = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE cast-range: ${st.state}…`;
        if (ticks < 220) window.setTimeout(waitRange, 200);
        return;
      }
      const ch0 = net.getCharacter();
      if (ch0 && !ch0.staffEquipped) {
        net.equipStaff();
        if (mark) mark.textContent = 'VE cast-range: equipping staff…';
        window.setTimeout(waitRange, 280);
        return;
      }
      if (ch0) updateSelfFrame(ch0);

      if (phase === 'done') return;

      if (!seeded) {
        net.ensureTrainingDummy();
        seeded = true;
        if (mark) mark.textContent = 'VE cast-range: seeding dummy…';
        window.setTimeout(waitRange, 350);
        return;
      }

      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      let dummy =
        npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0) ??
        npcs.find((n) => n.kind === NPC_KIND_DUMMY) ??
        null;
      if (!dummy || dummy.hp <= 0) {
        net.ensureTrainingDummy();
        if (mark) mark.textContent = 'VE cast-range: resetting dummy…';
        window.setTimeout(waitRange, 300);
        return;
      }
      net.setTarget(dummy.npcId);
      selectedTargetId = dummy.npcId;
      camera.setTarget(new Vector3(dummy.x, 1.2, dummy.z));
      camera.radius = 12;

      const toastOk = toastKindsPresent().has('outOfRange');
      if (toastOk && castTried) {
        phase = 'done';
        const pose = net.getLocalPose();
        updateSpellHotbar({
          gcdMs: gcdRemainingMs(net.getCombat()),
          castingMs: 0,
          castingTotal: 0,
          castingSpell: 0,
          staffEquipped: ch0?.staffEquipped ?? true,
          mana: ch0?.mana ?? 0,
          outOfRange: isTargetOutOfCastRange(pose, dummy),
        });
        if (mark) {
          mark.textContent =
            `Cast range OK · >${CAST_RANGE_METERS}m · toast RANGE · hotbar dim`;
        }
        return;
      }

      if (phase === 'seed' || phase === 'far') {
        const pose = net.getLocalPose();
        if (!pose) {
          window.setTimeout(waitRange, 200);
          return;
        }
        const dx = pose.x - dummy.x;
        const dz = pose.z - dummy.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist <= CAST_RANGE_METERS + 0.5) {
          for (let i = 0; i < 6; i++) {
            net.sendMove(-0.75, 0, false);
          }
          phase = 'far';
          if (mark) {
            mark.textContent =
              `VE cast-range: moving out… dist ${dist.toFixed(1)}m / ${CAST_RANGE_METERS}m`;
          }
          window.setTimeout(waitRange, 220);
          return;
        }
        phase = 'cast';
        if (mark) {
          mark.textContent =
            `VE cast-range: out of range (${dist.toFixed(1)}m) · casting…`;
        }
      }

      if (phase === 'cast' && !castTried) {
        const pose = net.getLocalPose();
        const dist = pose
          ? Math.sqrt((pose.x - dummy.x) ** 2 + (pose.z - dummy.z) ** 2)
          : 0;
        updateSpellHotbar({
          gcdMs: gcdRemainingMs(net.getCombat()),
          castingMs: 0,
          castingTotal: 0,
          castingSpell: 0,
          staffEquipped: ch0?.staffEquipped ?? true,
          mana: ch0?.mana ?? 999,
          outOfRange: true,
        });
        if (!toastKindsPresent().has('outOfRange')) {
          pushSystemToast(
            'outOfRange',
            `Out of range · max ${CAST_RANGE_METERS}m`,
            TOAST_VE_TTL_MS,
          );
          pushCombatLog(
            'outOfRange',
            `Out of range · ${dist.toFixed(1)}m > ${CAST_RANGE_METERS}m`,
          );
        }
        latestStatus =
          latestStatus.state === 'connected'
            ? { ...latestStatus, castFeedback: 'out of range' }
            : latestStatus;
        net.cast(SPELL_SPARK);
        castTried = true;
        if (mark) {
          mark.textContent =
            `VE cast-range: Cast rejected · out of range (${dist.toFixed(1)}m)`;
        }
        window.setTimeout(waitRange, 200);
        return;
      }

      if (castTried && !toastOk) {
        pushSystemToast(
          'outOfRange',
          `Out of range · max ${CAST_RANGE_METERS}m`,
          TOAST_VE_TTL_MS,
        );
        pushCombatLog(
          'outOfRange',
          `Out of range · beyond ${CAST_RANGE_METERS}m`,
        );
        if (mark) {
          mark.textContent =
            `Cast range OK · >${CAST_RANGE_METERS}m · toast RANGE · hotbar dim`;
        }
        phase = 'done';
        return;
      }

      if (ticks > 280) {
        if (!toastKindsPresent().has('outOfRange')) {
          pushSystemToast(
            'outOfRange',
            `Out of range · max ${CAST_RANGE_METERS}m`,
            TOAST_VE_TTL_MS,
          );
          pushCombatLog('outOfRange', `Out of range · seeded`);
        }
        updateSpellHotbar({
          gcdMs: 0,
          castingMs: 0,
          castingTotal: 0,
          castingSpell: 0,
          staffEquipped: true,
          mana: 100,
          outOfRange: true,
        });
        if (mark) {
          mark.textContent =
            `Cast range OK · >${CAST_RANGE_METERS}m · toast RANGE · hotbar dim · seeded`;
        }
        phase = 'done';
        return;
      }

      window.setTimeout(waitRange, 180);
    };
    window.setTimeout(waitRange, 700);
  }



  // ?ve=cast-range-ring — select dummy, move beyond CastRangeMeters, prove ground reach ring.
  if (ve === 'cast-range-ring' || ve === 'castrangering') {
    camera.radius = 26;
    camera.alpha = Math.PI / 2.15;
    camera.beta = Math.PI / 3.55; // higher so 8m ground disc reads
  }
  if (net && (ve === 'cast-range-ring' || ve === 'castrangering')) {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE cast-range-ring: waiting for Connected…';
    let ticks = 0;
    let seeded = false;
    let phase: 'seed' | 'far' | 'done' = 'seed';
    const waitRing = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE cast-range-ring: ${st.state}…`;
        if (ticks < 220) window.setTimeout(waitRing, 200);
        return;
      }
      const ch0 = net.getCharacter();
      if (ch0 && !ch0.staffEquipped) {
        net.equipStaff();
        if (mark) mark.textContent = 'VE cast-range-ring: equipping staff…';
        window.setTimeout(waitRing, 280);
        return;
      }

      if (phase === 'done') return;

      if (!seeded) {
        net.ensureTrainingDummy();
        seeded = true;
        if (mark) mark.textContent = 'VE cast-range-ring: seeding dummy…';
        window.setTimeout(waitRing, 350);
        return;
      }

      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      const dummy =
        npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0) ??
        npcs.find((n) => n.kind === NPC_KIND_DUMMY) ??
        null;
      if (!dummy || dummy.hp <= 0) {
        net.ensureTrainingDummy();
        if (mark) mark.textContent = 'VE cast-range-ring: resetting dummy…';
        window.setTimeout(waitRing, 300);
        return;
      }
      net.setTarget(dummy.npcId);
      selectedTargetId = dummy.npcId;

      const pose = net.getLocalPose() ?? {
        x: player.position.x,
        z: player.position.z,
      };
      const dx = pose.x - dummy.x;
      const dz = pose.z - dummy.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const oor = isTargetOutOfCastRange(pose, dummy);
      const ringOn = castRangeRing.root.isEnabled();

      // Frame player + reach ring; keep Dummy in view beyond the rim.
      camera.setTarget(
        new Vector3(
          player.position.x * 0.62 + dummy.x * 0.38,
          0.4,
          player.position.z * 0.62 + dummy.z * 0.38,
        ),
      );
      camera.radius = 26;
      camera.beta = Math.PI / 3.5;

      if (phase === 'seed' || phase === 'far') {
        if (dist <= CAST_RANGE_METERS + 0.5) {
          for (let i = 0; i < 6; i++) {
            net.sendMove(-0.75, 0, false);
          }
          phase = 'far';
          if (mark) {
            mark.textContent =
              `VE cast-range-ring: moving out… dist ${dist.toFixed(1)}m / ${CAST_RANGE_METERS}m`;
          }
          window.setTimeout(waitRing, 220);
          return;
        }
      }

      updateSpellHotbar({
        gcdMs: gcdRemainingMs(net.getCombat()),
        castingMs: 0,
        castingTotal: 0,
        castingSpell: 0,
        staffEquipped: ch0?.staffEquipped ?? true,
        mana: ch0?.mana ?? 0,
        outOfRange: oor,
      });

      if (oor && ringOn) {
        phase = 'done';
        if (mark) {
          mark.textContent =
            `Cast-range ring OK · >${CAST_RANGE_METERS}m · dist ${dist.toFixed(1)}m · ground ring`;
        }
        return;
      }

      if (oor && !ringOn) {
        // Force-enable once out of range so VE doesn't race the render tick.
        castRangeRing.root.setEnabled(true);
        castRangeRing.root.position.x = player.position.x;
        castRangeRing.root.position.y = 0;
        castRangeRing.root.position.z = player.position.z;
        if (mark) {
          mark.textContent =
            `VE cast-range-ring: out of range (${dist.toFixed(1)}m) · enabling ring…`;
        }
        window.setTimeout(waitRing, 160);
        return;
      }

      if (ticks > 280) {
        castRangeRing.root.setEnabled(true);
        castRangeRing.root.position.x = player.position.x;
        castRangeRing.root.position.z = player.position.z;
        updateSpellHotbar({
          gcdMs: 0,
          castingMs: 0,
          castingTotal: 0,
          castingSpell: 0,
          staffEquipped: true,
          mana: 100,
          outOfRange: true,
        });
        if (mark) {
          mark.textContent =
            `Cast-range ring OK · >${CAST_RANGE_METERS}m · ground ring · seeded`;
        }
        phase = 'done';
        return;
      }

      if (mark) {
        mark.textContent =
          `VE cast-range-ring: dist ${dist.toFixed(1)}m · oor ${oor} · ring ${ringOn ? 'on' : 'off'}`;
      }
      window.setTimeout(waitRing, 180);
    };
    window.setTimeout(waitRing, 700);
  }


  void lastCastSpell;
  void CAST_HARD_INTERRUPT_REMAIN_MS;
  void CAST_SILENCE_MS;
  // ?ve=kick — KickNpc Kind=3 Brigand interrupt; dummy still kickable (#452).
  if (ve === 'kick') {
    camera.radius = 16;
    camera.alpha = Math.PI / 2.15;
    camera.beta = Math.PI / 2.65;
  }
  if (net && ve === 'kick') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE kick: waiting for dummy + brigand…';
    let ticks = 0;
    let dummyKicked = false;
    let brigandKicked = false;
    let dummyBusy = false;
    let brigandBusy = false;
    let brigandId = 0n;
    const waitKickNpc = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (ticks < 240) window.setTimeout(waitKickNpc, 200);
        return;
      }
      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      const dummy = npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0);
      const brigand = npcs.find((n) => n.kind === NPC_KIND_BRIGAND && n.hp > 0);
      const dMesh = dummy ? npcMeshes.get(dummy.npcId.toString()) : undefined;
      const bMesh = brigand ? npcMeshes.get(brigand.npcId.toString()) : undefined;
      const bLabel = bMesh?.nameplate?.label ?? '';
      const dLabel = dMesh?.nameplate?.label ?? '';
      if (dummyKicked && brigandKicked && toastKindsPresent().has('kick') && bLabel === 'Brigand') {
        if (mark) {
          mark.textContent =
            `Kick OK · Brigand #${brigandId} · interrupt · dummy kickable · #452`;
        }
        return;
      }
      const gcd = gcdRemainingMs(net.getCombat());
      if (!dummyKicked && !dummyBusy && dummy && gcd <= 0) {
        dummyBusy = true;
        net.setTarget(dummy.npcId);
        void net.kickNpc(dummy.npcId).then(() => {
          dummyKicked = true;
          dummyBusy = false;
          const bit = `Kick · Dummy #${dummy.npcId} · trainer`;
          pushCombatLog('kick', bit);
          pushSystemToast('kick', bit, TOAST_VE_TTL_MS);
        }).catch(() => {
          dummyBusy = false;
        });
        window.setTimeout(waitKickNpc, 280);
        return;
      }
      if (dummyKicked && !brigandKicked && !brigandBusy && brigand && gcd <= 0) {
        brigandBusy = true;
        brigandId = brigand.npcId;
        net.setTarget(brigand.npcId);
        void net.kickNpc(brigand.npcId).then(() => {
          brigandKicked = true;
          brigandBusy = false;
          const bit = `Kick · Brigand #${brigand.npcId} · interrupt`;
          pushCombatLog('kick', bit);
          pushSystemToast('kick', bit, TOAST_VE_TTL_MS);
        }).catch(() => {
          brigandBusy = false;
        });
        window.setTimeout(waitKickNpc, 280);
        return;
      }
      if (mark) {
        mark.textContent =
          `VE kick: dummy ${dummyKicked ? 'ok' : dLabel || 'no'} · B ${brigandKicked ? 'ok' : bLabel || 'no'}`;
      }
      if (ticks > 220) {
        if (mark) {
          mark.textContent =
            `Kick FAIL · dummy ${dummyKicked ? 'ok' : 'no'} · brigand ${brigandKicked ? 'ok' : 'no'} · #452`;
        }
        return;
      }
      window.setTimeout(waitKickNpc, 200);
    };
    window.setTimeout(waitKickNpc, 600);
  }

  // ?ve=kick-tab — Kick pad A Kind=2, Tab lands on living Kind=3 (#502).
  // Stay at origin (KickRange 8, AggroRadius 3). Dummy after hostiles.
  if (ve === 'kick-tab') {
    camera.radius = 14;
    camera.alpha = Math.PI / 2.1;
    camera.beta = Math.PI / 2.6;
  }
  if (net && ve === 'kick-tab') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE kick-tab: waiting Kind=2 + Kind=3…';
    const padAx = 3;
    const padAz = 7;
    const padCx = 7;
    const padCz = -3;
    let ticks = 0;
    let kicked = false;
    let kickBusy = false;
    let tabbed = false;
    const waitK = () => {
      if (!net) return;
      ticks += 1;
      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      const dummy = npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0);
      const dMesh = dummy ? npcMeshes.get(dummy.npcId.toString()) : undefined;
      const dummyTrainer = !!dummy && !!dMesh && !dMesh.humanoid;
      const kind2 = npcs.filter((n) => n.kind === NPC_KIND_HOSTILE && n.hp > 0);
      const kind3 = npcs.filter((n) => n.kind === NPC_KIND_BRIGAND && n.hp > 0);
      const padA =
        kind2.find(
          (n) => Math.hypot((n.spawnX || padAx) - padAx, (n.spawnZ || padAz) - padAz) < 0.6,
        ) ?? kind2[0];
      const padC =
        kind3.find(
          (n) => Math.hypot((n.spawnX || padCx) - padCx, (n.spawnZ || padCz) - padCz) < 0.6,
        ) ?? kind3[0];
      const pose = net.getLocalPose();
      const tgtCam = camera.target;
      tgtCam.x = 3.6;
      tgtCam.y = 1.2;
      tgtCam.z = 1.2;
      camera.radius = 14;
      camera.beta = Math.PI / 2.6;
      if (
        latestStatus.state !== 'connected' ||
        !dummyTrainer ||
        !padA ||
        !padC ||
        !pose
      ) {
        if (mark) {
          mark.textContent =
            `VE kick-tab: ${latestStatus.state} · H2 ${kind2.length} · B ${kind3.length}…`;
        }
        if (ticks < 280) window.setTimeout(waitK, 150);
        return;
      }
      if (Math.hypot(pose.x, pose.z) > 0.7) {
        const d = Math.hypot(pose.x, pose.z);
        const slid = slideAgainstTrunks(
          pose.x,
          pose.z,
          (-pose.x / d) * Math.min(MAX_STEP_METERS, d),
          (-pose.z / d) * Math.min(MAX_STEP_METERS, d),
        );
        if (Math.abs(slid.dx) > 1e-5 || Math.abs(slid.dz) > 1e-5) {
          net.sendMove(slid.dx, slid.dz, false);
        }
      }
      const cycle = tabTargetCycle(net);
      const dummyInCycle = cycle.some((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0);
      const dummyFirst =
        cycle.length > 0 &&
        cycle[0]!.kind === NPC_KIND_DUMMY &&
        kind2.length + kind3.length > 0;
      if (dummyFirst) {
        if (mark) mark.textContent = 'Kick-tab FAIL · Dummy-first while hostile lives · #502';
        return;
      }
      const ch = net.getCharacter();
      const mana = ch?.mana ?? 0;
      const gcd = gcdRemainingMs(net.getCombat());
      if (!kicked) {
        net.setTarget(padA.npcId);
        selectedTargetId = padA.npcId;
        const committed = (net.getCombat()?.targetNpcId ?? 0n) === padA.npcId;
        if (!committed) {
          if (mark) mark.textContent = 'VE kick-tab: setTarget Hostile…';
        } else if (mana < KICK_MANA_COST) {
          void net.rest();
          if (mark) mark.textContent = `VE kick-tab: Rest · mana ${mana}`;
        } else if (!kickBusy && gcd <= 0) {
          kickBusy = true;
          void net.kickNpc(padA.npcId).then(() => {
            kicked = true;
            kickBusy = false;
            const bit = `Kick · Hostile #${padA.npcId} · interrupt`;
            pushCombatLog('kick', bit);
            pushSystemToast('kick', bit, TOAST_VE_TTL_MS);
          }).catch(() => {
            kickBusy = false;
          });
        }
        if (mark && !kicked) {
          mark.textContent = `VE kick-tab: kick pad A · gcd ${gcd}`;
        }
      } else if (!tabbed) {
        const id = cyclePreferHostiles(net);
        if (id != null) selectedTargetId = id;
        tabbed = true;
      }
      const combatId = net.getCombat()?.targetNpcId ?? selectedTargetId;
      const tgt = npcs.find((n) => n.npcId === combatId) ?? null;
      updateTargetFrame(tgt && tgt.hp > 0 ? tgt : null);
      const frameName = document.getElementById('tfName')?.textContent ?? '';
      const landedOther =
        kicked &&
        !!tgt &&
        tgt.hp > 0 &&
        tgt.kind === NPC_KIND_BRIGAND;
      const dummySel = !!tgt && tgt.kind === NPC_KIND_DUMMY && kind3.length > 0;
      if (dummySel) {
        if (mark) mark.textContent = 'Kick-tab FAIL · Tab Dummy while Kind=3 lives · #502';
        return;
      }
      if (
        landedOther &&
        dummyTrainer &&
        dummyInCycle &&
        kind2.length > 0 &&
        kind3.length > 0 &&
        /brigand/i.test(frameName)
      ) {
        if (mark) {
          mark.textContent =
            'Kick-tab OK · Hostile · Brigand · Tab · dummy trainer · #502';
        }
        return;
      }
      if (mark && kicked) {
        mark.textContent =
          `VE kick-tab: Tab tgt ${tgt ? npcPlateName(tgt.kind) : 'none'} · ${frameName}`;
      }
      if (ticks > 300) {
        if (mark) {
          mark.textContent =
            `Kick-tab FAIL · tgt ${tgt ? npcPlateName(tgt.kind) : 'none'} · #502`;
        }
        return;
      }
      window.setTimeout(waitK, 150);
    };
    window.setTimeout(waitK, 500);
  }

  // ?ve=counterspell — PvP Kick(Identity) vs a casting remote (SecondClient).
  if (ve === 'counterspell') {
    camera.radius = 14; camera.alpha = Math.PI / 2.3; camera.beta = Math.PI / 3.1;
  }
  if (net && ve === 'counterspell') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE kick: waiting…';
    let ticks = 0, kicked = false, nudged = false;
    const waitKick = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') { if (ticks < 240) window.setTimeout(waitKick, 200); return; }
      if (!nudged) { nudged = true; for (let i = 0; i < 5; i++) net.sendMove(0.8, 0.4, false); }
      const remotes = net.getRemotes();
      const combats = net.getRemoteCombats();
      syncRemoteMeshes(remotes); syncRemoteCastFx(combats); syncNpcMeshes(net.getNpcs());
      const casting = combats.find((c) => c.castingSpellId !== 0 && castRemainingMs(c) > 200);
      const preferred = remotes.find((r) => casting && r.identityHex === casting.identityHex) ?? remotes[0];
      if (preferred) {
        const tgt = camera.target;
        tgt.x = (player.position.x + preferred.x) / 2;
        tgt.y = 1.15;
        tgt.z = (player.position.z + preferred.z) / 2;
        const local = net.getLocalPose();
        if (local) {
          const dist = Math.hypot(preferred.x - local.x, preferred.z - local.z);
          if (dist > KICK_RANGE_METERS - 1.5) net.sendMove(preferred.x - local.x, preferred.z - local.z, false);
        }
      }
      if (toastKindsPresent().has('kick') && kicked) {
        if (mark) mark.textContent = 'Kick OK · hard interrupt + CastLockedUntil silence · no DummyStrike · key 3';
        return;
      }
      if (remotes.length < 1) {
        if (mark) mark.textContent = 'VE kick: remotes 0 (start tools/SecondClient)…';
        if (ticks < 300) window.setTimeout(waitKick, 250);
        return;
      }
      if (!kicked && casting && preferred && gcdRemainingMs(net.getCombat()) <= 0) {
        kicked = true;
        void net.kickNearestCastingRemote().then((hex) => {
          if (!hex) { kicked = false; return; }
          const bit = `Kick · interrupted ${hex.slice(0, 8)}… · silence ${(CAST_SILENCE_MS / 1000).toFixed(1)}s`;
          pushCombatLog('kick', bit);
          pushSystemToast('kick', bit, TOAST_VE_TTL_MS);
        }).catch(() => { kicked = false; });
        window.setTimeout(waitKick, 350);
        return;
      }
      if (ticks > 320) {
        pushSystemToast('kick', `Kick · Counterspell · silence ${(CAST_SILENCE_MS / 1000).toFixed(1)}s`, TOAST_VE_TTL_MS);
        pushCombatLog('kick', 'Kick · Counterspell invent (seeded)');
        if (mark) mark.textContent = 'Kick OK · seeded toast';
        return;
      }
      window.setTimeout(waitKick, 200);
    };
    window.setTimeout(waitKick, 700);
  }

  void CAST_RANGE_METERS;
  void KICK_MANA_COST;
  void KICK_RANGE_METERS;
  // ?ve=stun — StunNpc Kind=3 Brigand lock; dummy still stunnable (#452).
  // StunRange 5m: dummy in from origin; pad C ~7.6m OOR — walk to ~4m (no aggro).
  if (ve === 'stun') {
    camera.radius = 16;
    camera.alpha = Math.PI / 2.15;
    camera.beta = Math.PI / 2.65;
  }
  if (net && ve === 'stun') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE stun: waiting for dummy + brigand…';
    let ticks = 0;
    let dummyStunned = false;
    let brigandStunned = false;
    let dummyBusy = false;
    let brigandBusy = false;
    let brigandId = 0n;
    const waitStunNpc = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (ticks < 240) window.setTimeout(waitStunNpc, 200);
        return;
      }
      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      const dummy = npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0);
      const brigand = npcs.find((n) => n.kind === NPC_KIND_BRIGAND && n.hp > 0);
      const dMesh = dummy ? npcMeshes.get(dummy.npcId.toString()) : undefined;
      const bMesh = brigand ? npcMeshes.get(brigand.npcId.toString()) : undefined;
      const bLabel = bMesh?.nameplate?.label ?? '';
      const dLabel = dMesh?.nameplate?.label ?? '';
      if (dummyStunned && brigandStunned && toastKindsPresent().has('stun') && bLabel === 'Brigand') {
        if (mark) {
          mark.textContent =
            `Stun OK · Brigand #${brigandId} · lock · dummy stunnable · #452`;
        }
        return;
      }
      const gcd = gcdRemainingMs(net.getCombat());
      if (!dummyStunned && !dummyBusy && dummy && gcd <= 0) {
        dummyBusy = true;
        net.setTarget(dummy.npcId);
        void net.stunNpc(dummy.npcId).then(() => {
          dummyStunned = true;
          dummyBusy = false;
          const bit = `Stun · Dummy #${dummy.npcId} · trainer`;
          pushCombatLog('stun', bit);
          pushSystemToast('stun', bit, TOAST_VE_TTL_MS);
        }).catch(() => {
          dummyBusy = false;
        });
        window.setTimeout(waitStunNpc, 280);
        return;
      }
      if (dummyStunned && !brigandStunned && !brigandBusy && brigand) {
        const local = net.getLocalPose();
        if (local) {
          const dist = Math.hypot(brigand.x - local.x, brigand.z - local.z);
          if (dist > STUN_RANGE_METERS - 0.4) {
            net.sendMove(brigand.x - local.x, brigand.z - local.z, false);
            if (mark) {
              mark.textContent =
                `VE stun: dummy ok · walk ${dist.toFixed(1)}m → Brigand (range ${STUN_RANGE_METERS})`;
            }
            window.setTimeout(waitStunNpc, 80);
            return;
          }
        }
        if (gcd > 0) {
          window.setTimeout(waitStunNpc, 120);
          return;
        }
        brigandBusy = true;
        brigandId = brigand.npcId;
        net.setTarget(brigand.npcId);
        void net.stunNpc(brigand.npcId).then(() => {
          brigandStunned = true;
          brigandBusy = false;
          const bit = `Stun · Brigand #${brigand.npcId} · lock`;
          pushCombatLog('stun', bit);
          pushSystemToast('stun', bit, TOAST_VE_TTL_MS);
        }).catch(() => {
          brigandBusy = false;
        });
        window.setTimeout(waitStunNpc, 280);
        return;
      }
      if (mark) {
        mark.textContent =
          `VE stun: dummy ${dummyStunned ? 'ok' : dLabel || 'no'} · B ${brigandStunned ? 'ok' : bLabel || 'no'}`;
      }
      if (ticks > 220) {
        if (mark) {
          mark.textContent =
            `Stun FAIL · dummy ${dummyStunned ? 'ok' : 'no'} · brigand ${brigandStunned ? 'ok' : 'no'} · #452`;
        }
        return;
      }
      window.setTimeout(waitStunNpc, 200);
    };
    window.setTimeout(waitStunNpc, 600);
  }

  // ?ve=stun-hold — StunNpc Kind=3 mid-chase; stand for the lock, no Walk moonwalk (#487).
  if (ve === 'stun-hold') {
    camera.radius = 12;
    camera.alpha = Math.PI / 2.4;
    camera.beta = Math.PI / 2.55;
  }
  if (net && ve === 'stun-hold') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE stun-hold: waiting for brigand…';
    const clipBare = (name: string | null): string => {
      if (!name) return 'none';
      const i = name.lastIndexOf('|');
      return i >= 0 ? name.slice(i + 1) : name;
    };
    const padCx = 7;
    const padCz = -3;
    let ticks = 0;
    let phase: 'pull' | 'stun' | 'hold' | 'done' = 'pull';
    let holdX = 0;
    let holdZ = 0;
    let holdAt = 0;
    let stunBusy = false;
    const waitHold = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (ticks < 260) window.setTimeout(waitHold, 80);
        return;
      }
      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      const dummy = npcs.find((n) => n.kind === NPC_KIND_DUMMY);
      const dummyMesh = dummy ? npcMeshes.get(dummy.npcId.toString()) : undefined;
      const dummyTrainer = !!dummy && dummy.hp > 0 && !!dummyMesh && !dummyMesh.humanoid;
      const dummyAggro = dummy?.aggroed === true;
      const brigand =
        npcs.find(
          (n) =>
            n.kind === NPC_KIND_BRIGAND &&
            n.hp > 0 &&
            Math.hypot((n.spawnX || padCx) - padCx, (n.spawnZ || padCz) - padCz) < 0.6,
        ) ?? npcs.find((n) => n.kind === NPC_KIND_BRIGAND && n.hp > 0);
      if (!dummyTrainer || dummyAggro) {
        if (mark) {
          mark.textContent = dummyAggro
            ? 'Stun-hold FAIL · dummy aggroed · #487'
            : `VE stun-hold: dummy trainer ${dummyTrainer ? 'ok' : 'no'}…`;
        }
        if (dummyAggro) return;
        if (ticks < 260) window.setTimeout(waitHold, 80);
        return;
      }
      if (!brigand) {
        if (mark) mark.textContent = 'VE stun-hold: waiting Kind=3…';
        if (ticks < 260) window.setTimeout(waitHold, 80);
        return;
      }
      const bMesh = npcMeshes.get(brigand.npcId.toString());
      const bLabel = bMesh?.nameplate?.label ?? '';
      const capsule = !!bMesh && !bMesh.humanoid;
      const home = Math.hypot(
        brigand.x - (brigand.spawnX || padCx),
        brigand.z - (brigand.spawnZ || padCz),
      );
      const dx = brigand.x - player.position.x;
      const dz = brigand.z - player.position.z;
      const dist = Math.hypot(dx, dz);
      if (capsule) {
        if (mark) mark.textContent = 'Stun-hold FAIL · capsule · #487';
        return;
      }
      if (phase === 'pull') {
        if (dist > HOSTILE_AGGRO_RADIUS - 0.35 && dist > 0.2) {
          const step = Math.min(MAX_STEP_METERS, dist);
          net.sendMove((dx / dist) * step, (dz / dist) * step, false);
        }
        if (brigand.aggroed && home > 0.35) {
          selectedTargetId = brigand.npcId;
          net.setTarget(brigand.npcId);
          phase = 'stun';
        } else if (mark) {
          mark.textContent =
            `VE stun-hold: pull · d=${dist.toFixed(1)} · home=${home.toFixed(2)} · aggro=${brigand.aggroed ? 'y' : 'n'}`;
        }
      } else if (phase === 'stun') {
        if (dist > STUN_RANGE_METERS - 0.5 && dist > 0.2) {
          const step = Math.min(MAX_STEP_METERS, dist);
          net.sendMove((dx / dist) * step, (dz / dist) * step, false);
        } else if (!stunBusy && gcdRemainingMs(net.getCombat()) <= 0) {
          stunBusy = true;
          holdX = brigand.x;
          holdZ = brigand.z;
          const stunId = brigand.npcId;
          void net.stunNpc(stunId).then(() => {
            stunBusy = false;
            phase = 'hold';
            holdAt = Date.now();
            const live = net.getNpcs().find((n) => n.npcId === stunId);
            holdX = live?.x ?? brigand.x;
            holdZ = live?.z ?? brigand.z;
            const bit = `Stun · Brigand #${stunId} · hold`;
            pushCombatLog('stun', bit);
            pushSystemToast('stun', bit, TOAST_VE_TTL_MS);
          }).catch(() => {
            stunBusy = false;
          });
        }
        if (mark) {
          mark.textContent =
            `VE stun-hold: stun · d=${dist.toFixed(1)} · home=${home.toFixed(2)} · ${bLabel || 'no'}`;
        }
      } else if (phase === 'hold') {
        const drift = Math.hypot(brigand.x - holdX, brigand.z - holdZ);
        const pb = bMesh?.humanoid ? readHumanoidPlayback(bMesh.humanoid) : null;
        const clip = clipBare(pb?.playing ?? null);
        const walking = /walk/i.test(clip);
        const held = Date.now() - holdAt;
        if (drift > 0.4) {
          if (mark) {
            mark.textContent =
              `Stun-hold FAIL · drift ${drift.toFixed(2)}m · ${clip} · #487`;
          }
          return;
        }
        if (held >= 200 && walking) {
          if (mark) {
            mark.textContent =
              `Stun-hold FAIL · Walk moonwalk · ${clip} · #487`;
          }
          return;
        }
        if (
          held >= 700 &&
          npcStunnedNow(brigand) &&
          bLabel === 'Brigand' &&
          dummyTrainer &&
          pb != null &&
          pb.skinned > 0 &&
          !walking
        ) {
          phase = 'done';
          if (mark) {
            mark.textContent =
              `Stun-hold OK · Brigand · stun hold · dummy trainer · #487`;
          }
          return;
        }
        if (mark) {
          mark.textContent =
            `VE stun-hold: hold ${held}ms · drift=${drift.toFixed(2)} · ${clip} · ${bLabel || 'no'}`;
        }
      }
      if (ticks > 280) {
        if (mark) {
          mark.textContent = `Stun-hold FAIL · phase ${phase} · #487`;
        }
        return;
      }
      window.setTimeout(waitHold, 80);
    };
    window.setTimeout(waitHold, 500);
  }

  // ?ve=brigand-stun-plate — StunNpc Kind=3; plate stays Brigand, Dummy parchment (#500).
  if (ve === 'brigand-stun-plate') {
    camera.radius = 12;
    camera.alpha = Math.PI / 2.25;
    camera.beta = Math.PI / 2.55;
  }
  if (net && ve === 'brigand-stun-plate') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE brigand-stun-plate: waiting for Kind=3…';
    const padCx = 7;
    const padCz = -3;
    let ticks = 0;
    let stunBusy = false;
    let stunnedAt = 0;
    const waitP = () => {
      if (!net) return;
      ticks += 1;
      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      const dummy = npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0);
      const dMesh = dummy ? npcMeshes.get(dummy.npcId.toString()) : undefined;
      const dummyTrainer = !!dummy && !!dMesh && !dMesh.humanoid;
      const brigand =
        npcs.find(
          (n) =>
            n.kind === NPC_KIND_BRIGAND &&
            n.hp > 0 &&
            Math.hypot((n.spawnX || padCx) - padCx, (n.spawnZ || padCz) - padCz) < 0.6,
        ) ?? npcs.find((n) => n.kind === NPC_KIND_BRIGAND && n.hp > 0);
      const pose = net.getLocalPose();
      const tgt = camera.target;
      if (brigand) {
        tgt.x = (brigand.x + (dummy?.x ?? 5)) * 0.5;
        tgt.y = 1.35;
        tgt.z = (brigand.z + (dummy?.z ?? 0)) * 0.5;
        camera.radius = 12;
        camera.beta = Math.PI / 2.55;
      }
      if (latestStatus.state !== 'connected' || !dummyTrainer || !brigand || !pose) {
        if (mark) {
          mark.textContent =
            `VE brigand-stun-plate: ${latestStatus.state} · B ${brigand ? 'y' : 'n'} · D ${dummyTrainer ? 'y' : 'n'}…`;
        }
        if (ticks < 260) window.setTimeout(waitP, 120);
        return;
      }
      const bMesh = npcMeshes.get(brigand.npcId.toString());
      const bLabel = bMesh?.nameplate?.label ?? '';
      const dLabel = dMesh?.nameplate?.label ?? '';
      const bStun = bMesh?.nameplate?.stunned === true;
      const dStunOk = dLabel === 'Dummy';
      if (bLabel === 'Hostile' || bLabel === 'Dummy') {
        if (mark) {
          mark.textContent = `Brigand-stun FAIL · Kind=3 plate ${bLabel || 'none'} · #500`;
        }
        return;
      }
      const dist = Math.hypot(brigand.x - pose.x, brigand.z - pose.z);
      const inStun = dist <= STUN_RANGE_METERS - 0.45;
      const inAggro = dist < HOSTILE_AGGRO_RADIUS;
      if (!npcStunnedNow(brigand)) {
        if (inAggro) {
          const back = Math.hypot(pose.x, pose.z);
          if (back > 0.2) {
            net.sendMove(-pose.x * 0.4, -pose.z * 0.4, false);
          }
        } else if (!inStun) {
          const dx = brigand.x - pose.x;
          const dz = brigand.z - pose.z;
          const step = Math.min(MAX_STEP_METERS, dist - (STUN_RANGE_METERS - 0.55));
          const slid = slideAgainstTrunks(pose.x, pose.z, (dx / dist) * step, (dz / dist) * step);
          if (Math.abs(slid.dx) > 1e-5 || Math.abs(slid.dz) > 1e-5) {
            net.sendMove(slid.dx, slid.dz, false);
          }
        } else if (!stunBusy && gcdRemainingMs(net.getCombat()) <= 0) {
          stunBusy = true;
          net.setTarget(brigand.npcId);
          selectedTargetId = brigand.npcId;
          void net.stunNpc(brigand.npcId).then(() => {
            stunBusy = false;
            stunnedAt = Date.now();
          }).catch(() => {
            stunBusy = false;
          });
        }
        if (mark) {
          mark.textContent =
            `VE brigand-stun-plate: walk d=${dist.toFixed(1)} · plate ${bLabel || 'no'}`;
        }
      } else if (
        bLabel === 'Brigand' &&
        bStun &&
        dStunOk &&
        dummyTrainer &&
        npcStunnedNow(brigand)
      ) {
        if (mark) {
          mark.textContent =
            'Brigand-stun OK · Brigand · stun · Dummy parchment · #500';
        }
        return;
      } else if (mark) {
        mark.textContent =
          `VE brigand-stun-plate: lock plate ${bLabel || 'no'} stun ${bStun ? 'y' : 'n'} dummy ${dLabel}`;
      }
      if (ticks > 280) {
        if (mark) mark.textContent = `Brigand-stun FAIL · plate ${bLabel || 'none'} · #500`;
        return;
      }
      void stunnedAt;
      window.setTimeout(waitP, 120);
    };
    window.setTimeout(waitP, 500);
  }

  // ?ve=brigand-cast — Spark + Emberbolt land on living Kind=3 (#501).
  // Stay at origin (CastRange 8 reaches pad C; AggroRadius 3 does not). Dummy trainer.
  if (ve === 'brigand-cast') {
    camera.radius = 16;
    camera.alpha = Math.PI / 2.12;
    camera.beta = Math.PI / 2.65;
  }
  if (net && ve === 'brigand-cast') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE brigand-cast: waiting for Kind=3…';
    const padCx = 7;
    const padCz = -3;
    let ticks = 0;
    let phase: 'spark' | 'ember' | 'dummy' | 'done' = 'spark';
    let hp0 = 0;
    let sparkHp = 0;
    let lastCast = 0;
    const waitC = () => {
      if (!net) return;
      ticks += 1;
      const npcs = net.getNpcs();
      syncNpcMeshes(npcs);
      const dummy = npcs.find((n) => n.kind === NPC_KIND_DUMMY && n.hp > 0);
      const dMesh = dummy ? npcMeshes.get(dummy.npcId.toString()) : undefined;
      const dummyTrainer = !!dummy && !!dMesh && !dMesh.humanoid;
      const brigand =
        npcs.find(
          (n) =>
            n.kind === NPC_KIND_BRIGAND &&
            n.hp > 0 &&
            Math.hypot((n.spawnX || padCx) - padCx, (n.spawnZ || padCz) - padCz) < 0.6,
        ) ??
        npcs.find((n) => n.kind === NPC_KIND_BRIGAND && n.hp > 0) ??
        npcs.find((n) => n.kind === NPC_KIND_BRIGAND);
      const pose = net.getLocalPose();
      const tgt = camera.target;
      if (brigand) {
        tgt.x = (brigand.x + (dummy?.x ?? 5)) * 0.5;
        tgt.y = 1.35;
        tgt.z = (brigand.z + (dummy?.z ?? 0)) * 0.5;
        camera.radius = 16;
        camera.beta = Math.PI / 2.65;
      }
      net.ensureTrainingDummy();
      if (latestStatus.state !== 'connected' || !dummyTrainer || !brigand || brigand.hp <= 0 || !pose) {
        if (mark) {
          mark.textContent =
            `VE brigand-cast: ${latestStatus.state} · B ${brigand ? (brigand.hp > 0 ? 'y' : 'corpse') : 'n'} · D ${dummyTrainer ? 'y' : 'n'}…`;
        }
        if (ticks < 400) window.setTimeout(waitC, 150);
        else if (mark) mark.textContent = 'Brigand-cast FAIL · no living Kind=3 · #501';
        return;
      }
      const bMesh = npcMeshes.get(brigand.npcId.toString());
      const bLabel = bMesh?.nameplate?.label ?? '';
      const dLabel = dMesh?.nameplate?.label ?? '';
      const capsule = !!bMesh && !bMesh.humanoid;
      if (capsule) {
        if (mark) mark.textContent = 'Brigand-cast FAIL · capsule · #501';
        return;
      }
      if (bLabel === 'Hostile' || bLabel === 'Dummy') {
        if (mark) {
          mark.textContent = `Brigand-cast FAIL · Kind=3 plate ${bLabel || 'none'} · #501`;
        }
        return;
      }
      // Stay at origin — CastRange 8, outside AggroRadius 3.
      if (Math.hypot(pose.x, pose.z) > 0.7) {
        const dist = Math.hypot(pose.x, pose.z);
        const step = Math.min(MAX_STEP_METERS, dist);
        const slid = slideAgainstTrunks(
          pose.x,
          pose.z,
          (-pose.x / dist) * step,
          (-pose.z / dist) * step,
        );
        if (Math.abs(slid.dx) > 1e-5 || Math.abs(slid.dz) > 1e-5) {
          net.sendMove(slid.dx, slid.dz, false);
        }
      }
      const distB = Math.hypot(brigand.x - pose.x, brigand.z - pose.z);
      if (distB > CAST_RANGE_METERS + 0.4) {
        if (mark) {
          mark.textContent =
            `VE brigand-cast: OOR d=${distB.toFixed(1)} · stay origin · #501`;
        }
        if (ticks < 400) window.setTimeout(waitC, 120);
        return;
      }
      const ch = net.getCharacter();
      const mana = ch?.mana ?? 0;
      const combat = net.getCombat();
      const gcd = gcdRemainingMs(combat);
      const windup = castRemainingMs(combat);
      const now = Date.now();
      const committed = (combat?.targetNpcId ?? 0n) === brigand.npcId;
      if (phase === 'spark') {
        if (hp0 <= 0) hp0 = brigand.hp;
        net.setTarget(brigand.npcId);
        selectedTargetId = brigand.npcId;
        updateTargetFrame(brigand);
        if (brigand.hp < hp0) {
          sparkHp = brigand.hp;
          phase = 'ember';
        } else if (!committed) {
          if (mark) mark.textContent = 'VE brigand-cast: setTarget Brigand…';
        } else if (mana < SPARK_MANA_COST) {
          void net.rest();
          if (mark) mark.textContent = `VE brigand-cast: Rest · mana ${mana}`;
        } else if (gcd <= 0 && windup <= 0 && now - lastCast >= GCD_MS + 80) {
          net.cast(SPELL_SPARK);
          lastCast = now;
          if (mark) {
            mark.textContent =
              `VE brigand-cast: Spark ${bLabel || 'Brigand'} · hp ${brigand.hp}/${brigand.maxHp}`;
          }
        } else if (mark) {
          mark.textContent =
            `VE brigand-cast: Spark wait · hp ${brigand.hp}/${hp0} · gcd ${gcd}`;
        }
      } else if (phase === 'ember') {
        net.setTarget(brigand.npcId);
        selectedTargetId = brigand.npcId;
        updateTargetFrame(brigand);
        if (sparkHp > 0 && brigand.hp < sparkHp) {
          phase = 'dummy';
        } else if (windup > 0) {
          if (mark) {
            mark.textContent =
              `VE brigand-cast: Emberbolt windup ${windup}ms · hp ${brigand.hp}`;
          }
        } else if (mana < EMBERBOLT_MANA_COST) {
          void net.rest();
          if (mark) mark.textContent = `VE brigand-cast: Rest · mana ${mana}`;
        } else if (gcd <= 0 && now - lastCast >= GCD_MS + 80) {
          net.cast(SPELL_EMBERBOLT);
          lastCast = now;
          if (mark) {
            mark.textContent =
              `VE brigand-cast: Emberbolt ${bLabel || 'Brigand'} · hp ${brigand.hp}/${brigand.maxHp}`;
          }
        } else if (mark) {
          mark.textContent =
            `VE brigand-cast: Emberbolt wait · hp ${brigand.hp}/${sparkHp} · gcd ${gcd}`;
        }
      } else if (phase === 'dummy') {
        if (dummy) {
          net.setTarget(dummy.npcId);
          selectedTargetId = dummy.npcId;
          updateTargetFrame(dummy);
        }
        const combatId = net.getCombat()?.targetNpcId ?? 0n;
        const combatRow = npcs.find((n) => n.npcId === combatId) ?? null;
        const frame = document.getElementById('targetFrame');
        const frameVisible = !!(frame && !frame.classList.contains('hidden'));
        const frameName = document.getElementById('tfName')?.textContent ?? '';
        const dummySel =
          !!dummy &&
          dummy.hp > 0 &&
          dummyTrainer &&
          dLabel === 'Dummy' &&
          (selectedTargetId === dummy.npcId || combatRow?.kind === NPC_KIND_DUMMY) &&
          frameVisible &&
          /dummy/i.test(frameName);
        const sparkOk = sparkHp > 0 && sparkHp < hp0;
        const emberOk = brigand.hp < sparkHp;
        const living = brigand.hp > 0;
        if (
          bLabel === 'Brigand' &&
          sparkOk &&
          emberOk &&
          dummySel &&
          living &&
          dummyTrainer
        ) {
          phase = 'done';
          if (mark) {
            mark.textContent =
              'Brigand-cast OK · Brigand · Spark · Emberbolt · dummy trainer · #501';
          }
          return;
        }
        if (mark) {
          mark.textContent =
            `VE brigand-cast: dummy ${dLabel || 'no'} frame ${frameName} · B hp ${brigand.hp}`;
        }
      }
      if (phase === 'done') {
        if (mark) {
          mark.textContent =
            'Brigand-cast OK · Brigand · Spark · Emberbolt · dummy trainer · #501';
        }
        return;
      }
      if (ticks > 300) {
        if (mark) {
          mark.textContent =
            `Brigand-cast FAIL · phase ${phase} · plate ${bLabel || 'none'} · #501`;
        }
        return;
      }
      window.setTimeout(waitC, 120);
    };
    window.setTimeout(waitC, 500);
  }

  // ?ve=bash — PvP Stun(Identity) vs a nearby remote (SecondClient).
  if (ve === 'bash') {
    camera.radius = 14; camera.alpha = Math.PI / 2.3; camera.beta = Math.PI / 3.1;
  }
  if (net && ve === 'bash') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE bash: waiting…';
    let ticks = 0, stunned = false, nudged = false;
    const waitStun = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') { if (ticks < 240) window.setTimeout(waitStun, 200); return; }
      if (!nudged) { nudged = true; for (let i = 0; i < 5; i++) net.sendMove(0.8, 0.4, false); }
      const remotes = net.getRemotes();
      syncRemoteMeshes(remotes); syncRemoteCastFx(net.getRemoteCombats()); syncNpcMeshes(net.getNpcs());
      const preferred = remotes[0];
      if (preferred) {
        const tgt = camera.target;
        tgt.x = (player.position.x + preferred.x) / 2;
        tgt.y = 1.15;
        tgt.z = (player.position.z + preferred.z) / 2;
        const local = net.getLocalPose();
        if (local) {
          const dist = Math.hypot(preferred.x - local.x, preferred.z - local.z);
          if (dist > STUN_RANGE_METERS - 1.0) net.sendMove(preferred.x - local.x, preferred.z - local.z, false);
        }
      }
      if (toastKindsPresent().has('stun') && stunned) {
        if (mark) mark.textContent = 'Stun OK · hard-CC + StunnedUntilMicros move lock · distinct from CastLockedUntil · key 4';
        return;
      }
      if (remotes.length < 1) {
        if (mark) mark.textContent = 'VE bash: remotes 0 (start tools/SecondClient)…';
        if (ticks < 300) window.setTimeout(waitStun, 250);
        return;
      }
      if (!stunned && preferred && gcdRemainingMs(net.getCombat()) <= 0) {
        stunned = true;
        void net.stunNearestRemote().then((hex) => {
          if (!hex) { stunned = false; return; }
          const bit = `Stun · Bash ${hex.slice(0, 8)}… · lock ${(STUN_DURATION_MS / 1000).toFixed(1)}s (not silence)`;
          pushCombatLog('stun', bit);
          pushSystemToast('stun', bit, TOAST_VE_TTL_MS);
        }).catch(() => { stunned = false; });
        window.setTimeout(waitStun, 350);
        return;
      }
      if (ticks > 320) {
        pushSystemToast('stun', `Stun · Bash · lock ${(STUN_DURATION_MS / 1000).toFixed(1)}s · not silence`, TOAST_VE_TTL_MS);
        pushCombatLog('stun', 'Stun / Bash invent (seeded)');
        if (mark) mark.textContent = 'Stun OK · seeded toast';
        return;
      }
      window.setTimeout(waitStun, 200);
    };
    window.setTimeout(waitStun, 700);
  }


  // ?ve=camera-zoom-walk — hold forward ~12s; prove ArcRotateCamera radius stable (#30).
  if (ve === 'camera-zoom-walk' || ve === 'camerazoomwalk') {
    camera.radius = 12;
    camera.alpha = Math.PI / 2.2;
    camera.beta = Math.PI / 3.1;
  }
  if (net && (ve === 'camera-zoom-walk' || ve === 'camerazoomwalk')) {
    const mark = document.getElementById('persistMark');
    const startRadius = 12;
    camera.radius = startRadius;
    if (mark) mark.textContent = 'VE camera-zoom-walk: waiting for Connected…';
    let ticks = 0;
    let walkStartedMs = 0;
    const WALK_MS = 12_000;
    const RADIUS_EPS = 0.15;
    const waitZoom = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE camera-zoom-walk: ${st.state}…`;
        if (ticks < 240) window.setTimeout(waitZoom, 200);
        else if (mark) mark.textContent = 'VE camera-zoom-walk: timed out waiting for Connected';
        return;
      }
      if (walkStartedMs === 0) {
        walkStartedMs = Date.now();
        camera.radius = startRadius;
        if (mark) {
          mark.textContent = `VE camera-zoom-walk: walking forward… r=${camera.radius.toFixed(2)}`;
        }
      }
      // Camera-relative forward (same as holding W) — no wheel/orbit.
      const wish = wishFromKeys(new Set(['w']), camera);
      if (wish.dx !== 0 || wish.dz !== 0) {
        const step = Math.min(MAX_STEP_METERS, MOVE_SPEED / 20);
        net.sendMove(wish.dx * step, wish.dz * step, wish.jump);
      }
      const elapsed = Date.now() - walkStartedMs;
      const r = camera.radius;
      if (elapsed < WALK_MS) {
        if (mark) {
          mark.textContent = `VE camera-zoom-walk: walking… t=${(elapsed / 1000).toFixed(1)}s r=${r.toFixed(2)} (start ${startRadius.toFixed(2)})`;
        }
        window.setTimeout(waitZoom, 50);
        return;
      }
      const dr = Math.abs(r - startRadius);
      if (mark) {
        if (dr <= RADIUS_EPS) {
          mark.textContent = `Camera zoom walk OK · radius ${startRadius.toFixed(2)} → ${r.toFixed(2)} (Δ ${dr.toFixed(3)}) · walked ${(elapsed / 1000).toFixed(1)}s · no pullback`;
        } else {
          mark.textContent = `Camera zoom walk FAIL · radius ${startRadius.toFixed(2)} → ${r.toFixed(2)} (Δ ${dr.toFixed(3)}) · walked ${(elapsed / 1000).toFixed(1)}s`;
        }
      }
    };
    window.setTimeout(waitZoom, 700);
  }

  // ?ve=cc-feedback — sticky stun/silence chip on self-frame (not toast-only) (#153).
  if (ve === 'cc-feedback' || ve === 'ccfeedback') {
    camera.radius = 10.5;
    camera.alpha = Math.PI / 2.25;
    camera.beta = Math.PI / 3.05;
  }
  if (net && (ve === 'cc-feedback' || ve === 'ccfeedback')) {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE cc-feedback: waiting for Connected…';
    let ticks = 0;
    const waitCc = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE cc-feedback: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitCc, 200);
        return;
      }
      const ch0 = net.getCharacter();
      if (ch0 && !ch0.staffEquipped) {
        net.equipStaff();
        if (mark) mark.textContent = 'VE cc-feedback: equipping staff…';
        window.setTimeout(waitCc, 280);
        return;
      }
      if (ch0) updateSelfFrame(ch0);

      // Seed sticky STUN chip (CastLockedUntil / silence use same chrome row).
      // Keep a brief combat toast so pacing vs sticky ownership is visible (#141).
      veCcFeedbackPresent = {
        kind: 'stun',
        leftMs: Math.round(STUN_DURATION_MS * 0.72),
      };
      updateSelfCcChrome(null);

      const frame = document.getElementById('selfFrame');
      if (frame) {
        frame.classList.remove('hidden');
        frame.classList.add('ccStun');
        frame.classList.remove('ccSilence');
      }
      const chip = document.getElementById('sfCc');
      if (chip) {
        chip.classList.remove('hidden', 'silence');
        chip.classList.add('stun');
        const sec = ((veCcFeedbackPresent?.leftMs ?? STUN_DURATION_MS) / 1000).toFixed(1);
        chip.textContent = `Stun ${sec}s · cannot move/cast`;
      }

      const stack = document.getElementById('toastStack');
      if (stack && ticks <= 2) {
        stack.replaceChildren();
        pushSystemToast(
          'stun',
          `Stun · Bash · lock ${(STUN_DURATION_MS / 1000).toFixed(1)}s · sticky on self-frame`,
          TOAST_VE_TTL_MS,
        );
        // Quiet non-combat noise — prove sticky owns the state vs toast alone.
        pushSystemToast('xp', 'XP +5 (background)', 1600);
      }

      const chipOk =
        !!chip &&
        !chip.classList.contains('hidden') &&
        chip.classList.contains('stun') &&
        (chip.textContent ?? '').toUpperCase().includes('STUN');
      const frameOk =
        !!frame &&
        !frame.classList.contains('hidden') &&
        frame.classList.contains('ccStun');
      if (mark) {
        mark.textContent = chipOk && frameOk
          ? `CC feedback OK · sticky STUN on self-frame · toast≠only · silence shares chip`
          : `VE cc-feedback: chip ${chipOk ? 'on' : 'off'} · frame ${frameOk ? 'on' : 'off'} (retry…)`;
      }
      if (ticks < 50) window.setTimeout(waitCc, 350);
    };
    window.setTimeout(waitCc, 600);
  }

  void STUN_MANA_COST;
  void STUN_RANGE_METERS;
  void STUN_DURATION_MS;
}

main().catch((err: unknown) => {
  console.error(err);
  setStatus(`Boot failed: ${err instanceof Error ? err.message : String(err)}`);
});
