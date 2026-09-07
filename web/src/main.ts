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
  CROWD_NEAR_COUNT,
  type ConnectionStatus,
  type CrowdProxyView,
  type GameNet,
  type NpcView,
  type RemoteCombat,
  type RemotePose,
  type GroundItemView,
  type VendorView,
} from './net/connection';
import { buildForestClearing } from './world/forest';
import {
  createPlayerHumanoid,
  partyRobeColor,
  remoteRobeColor,
  ROBE_EMISSIVE_SCALE,
  type HumanoidParts,
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
};

function setStatus(text: string): void {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}

function setGcdBar(
  remainingMs: number,
  castingMs: number,
  castingTotal: number,
  spellName?: string,
): void {
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
    const ve = veCastFeedbackPresent;
    const cMs = ve?.castingMs ?? castingMs;
    const cTotal = ve?.castingTotal ?? castingTotal;
    const name = ve?.spellName ?? spellName ?? 'Casting';
    if (cTotal > 0 && cMs > 0) {
      const pct = Math.min(100, ((cTotal - cMs) / cTotal) * 100);
      castFill.style.width = `${pct}%`;
      castLabel.textContent = `${name}  ${(cMs / 1000).toFixed(1)}s`;
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

/** VE presentation override: force Spark STAFF + Emberbolt OOM + empty slots (?ve=hotbar / hotbar-afford). */
let veHotbarPresent: null | { sparkDisabled: boolean; emberLowMana: boolean } = null;

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

/** Client-only Rest enter/exit chrome on #selfFrame (not a server channel). */
let restExitTimer: number | null = null;

function setRestingState(mode: 'off' | 'enter' | 'exit'): void {
  const frame = document.getElementById('selfFrame');
  const badge = document.getElementById('sfRest');
  if (!frame || !badge) return;
  if (restExitTimer != null) {
    window.clearTimeout(restExitTimer);
    restExitTimer = null;
  }
  if (mode === 'off') {
    frame.classList.remove('resting');
    badge.classList.add('hidden');
    badge.classList.remove('exiting');
    badge.textContent = 'Resting…';
    return;
  }
  if (mode === 'enter') {
    frame.classList.add('resting');
    badge.classList.remove('hidden', 'exiting');
    badge.textContent = 'Resting…';
    // Auto-exit chrome after a short settle so enter vs exit is readable.
    restExitTimer = window.setTimeout(() => setRestingState('exit'), 2200);
    return;
  }
  // exit
  frame.classList.remove('resting');
  badge.classList.remove('hidden');
  badge.classList.add('exiting');
  badge.textContent = 'Rest complete';
  restExitTimer = window.setTimeout(() => setRestingState('off'), 1600);
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
  const frame = document.getElementById('selfFrame');
  if (!frame) return;
  if (!character) {
    frame.classList.add('hidden');
    return;
  }
  frame.classList.remove('hidden');
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
}

function setKeysLegendOpen(open: boolean): void {
  const panel = document.getElementById('keysLegend');
  if (!panel) return;
  panel.classList.toggle('hidden', !open);
}

/** Identity/AOI/keys #status wall + #fpsHud — hidden by default; F3 / ?debug=1. */
function setDebugHudVisible(open: boolean): void {
  const status = document.getElementById('status');
  const fps = document.getElementById('fpsHud');
  if (status) status.classList.toggle('hidden', !open);
  if (fps) fps.classList.toggle('hidden', !open);
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
  | 'outOfRange';

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
                                        : 'RESPAWN';
  const time = new Date();
  const hh = String(time.getHours()).padStart(2, '0');
  const mm = String(time.getMinutes()).padStart(2, '0');
  const ss = String(time.getSeconds()).padStart(2, '0');
  line.innerHTML =
    `<span class="clTag">[${hh}:${mm}:${ss}] ${tag}</span>` +
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
  | 'trade'
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
  | 'outOfRange';

/** Client-only transient top-center system toasts. */
function pushSystemToast(
  kind: SystemToastKind,
  text: string,
  ttlMs: number = TOAST_TTL_MS,
): void {
  const root = document.getElementById('toastStack');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `sysToast ${kind}`;
  el.setAttribute('data-kind', kind);
  el.style.setProperty('--toast-ttl', `${Math.max(400, ttlMs)}ms`);
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
  }, ttlMs + 400);
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
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const scale = (Math.min(w, h) * 0.42) / MINIMAP_RANGE_M;
  const maxR = Math.min(w, h) * 0.44;

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

  // Compass N with shadow for readability
  ctx.font = 'bold 11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Dark outline
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.lineWidth = 3.0;
  ctx.strokeText('N', cx, 12);
  // Bright fill
  ctx.fillStyle = '#f0f4fc';
  ctx.fillText('N', cx, 12);

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
    plot(n.x, n.z, dummy ? '#c4a06a' : '#c45a5a', dummy ? 3.4 : 3.0);
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
  // Local on top
  plot(originX, originZ, '#6aa2ff', 4.2);
  // Dark outline ring for contrast
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.arc(cx, cy, 4.2, 0, Math.PI * 2);
  ctx.stroke();
  // Bright white ring
  ctx.strokeStyle = 'rgba(232,238,252,0.85)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(cx, cy, 4.2, 0, Math.PI * 2);
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
      'keys: H legend · WASD · RMB · Tab · 1/2 · Esc · B bag · U/I · J/K · P/O party · T/Y trade · E vendor · F pickup · V tonic · R rest · Enter say',
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

async function createScene(engine: Engine): Promise<{
  scene: Scene;
  camera: ArcRotateCamera;
  player: Mesh;
  humanoid: HumanoidParts;
  proxySource: Mesh;
  setLocalGhost: (on: boolean) => void;
}> {
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

  // North-star yard: Quaternius Standard forest + procedural mountains (#41).
  await buildForestClearing(scene);

  // Local player: procedural humanoid + staff (crowd proxies stay capsules).
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

  return { scene, camera, player, humanoid, proxySource, setLocalGhost };
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
  if (isDummy) {
    // Scarecrow / practice dummy — wood post + crossbeam + canvas (not a cylinder).
    const dummy = createTrainingDummy(scene, `npc_${npc.npcId}`);
    body = dummy.body;
    body.parent = root;
    body.position.y = 0;
    mat = dummy.mat;
    extraMats = dummy.extraMats;
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
  if (isDummy) {
    nameplate = createNameplate(scene, `npc_${npc.npcId}`);
    nameplate.mesh.parent = root;
    nameplate.mesh.position.set(0, 2.15, 0);
    paintNameplate(nameplate, 'Dummy', '#e8c89a', npc.maxHp > 0 ? npc.hp / npc.maxHp : 1);
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
  };
}


function makeVendorMesh(scene: Scene, vendor: VendorView): { root: Mesh; mat: StandardMaterial; nameplate: Nameplate | null } {
  const root = new Mesh(`vendor_${vendor.vendorId}`, scene);
  root.position = new Vector3(vendor.x, 0, vendor.z);

  // Procedural shop stall — posts + counter + cloth awning (#58). Warm wood /
  // desaturated canvas under locked #39 fog/sun; readable at 8–20m play cam.
  const stall = createVendorStall(scene, `vendorStall_${vendor.vendorId}`);
  stall.body.parent = root;
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
    if (chatComposing) return;
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

async function main(): Promise<void> {
  const canvas = document.getElementById('renderCanvas');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('Missing #renderCanvas');
  }

  const engine = new Engine(canvas, true, {
    preserveDrawingBuffer: true,
    stencil: true,
  });
  const { scene, camera, player, humanoid, proxySource, setLocalGhost } = await createScene(engine);
  const castRangeRing = createCastRangeRing(scene);

  let net: GameNet | null = null;
  let bagOpen = false;
  let keysLegendOpen = false;
  const bootParams = new URLSearchParams(window.location.search);
  const debugParam = (bootParams.get('debug') || '').toLowerCase();
  let debugHudVisible = debugParam === '1' || debugParam === 'true';
  setDebugHudVisible(debugHudVisible);
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
  const npcMeshes = new Map<string, NpcMesh>();
  const vendorMeshes = new Map<string, { root: Mesh; mat: StandardMaterial; nameplate: Nameplate | null }>();
  let vendorOpen = false; void vendorOpen;
  const groundSparkles = new Map<string, GroundSparkle>();
  let latestGround: GroundItemView[] = [];
  const groundSeenIds = new Set<string>();
  let groundBootstrapped = false;
  let toastedPartyLootKey = '';
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
  let toastedTradeKey = '';
  let lastTradePendingFrom: string | null = null;
  const proxyInstances = new Map<string, InstancedMesh>();
  let fpsHudAccum = 0;

  const remoteMeshes = new Map<string, HumanoidParts>();
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
        pushSystemToast('mana', `Insufficient mana · need ${manaCost}`, TOAST_VE_TTL_MS);
        pushCombatLog('mana', `Insufficient mana · ${ch.mana ?? 0}/${ch.maxMana ?? 0}`);
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
        castCancelToasted = false;
        castPushbackToasted = false;
        lastSeenCastEndsAtMicros = 0n;
        prevLocalCasting = true;
      } else {
        castTotalMs = 0;
        castUntilMs = 0;
      }
      lastCastSpell = spellId;
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
      const playerMat = player.material as StandardMaterial;
      flashMesh(
        playerMat,
        spellId === SPELL_SPARK ? SPARK_COLOR : EMBER_COLOR,
        spellId === SPELL_SPARK ? 160 : 400,
      );
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
      net.leaveParty();
    },
    onTradeOfferOrAccept: () => {
      const g = net;
      if (!g) return;
      const trade = g.getTrade();
      if (trade.pendingFrom) {
        void g.acceptTrade().then(() => {
          const bits: string[] = [];
          if (trade.offeredHasEmberShard) bits.push('ember_shard');
          if (trade.offeredXp > 0) bits.push(`+${trade.offeredXp} XP`);
          pushCombatLog('trade', `Accepted trade (${bits.join(' · ') || 'ok'})`);
          pushSystemToast('trade', `Trade accepted · ${bits.join(' · ') || 'done'}`, TOAST_VE_TTL_MS);
          bagOpen = true;
          setBagPanelOpen(true);
          const ch = g.getCharacter();
          if (ch) updateBagPanel(ch);
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          pushSystemToast('rate', msg.slice(0, 96) || 'Accept trade failed');
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
        pushSystemToast('trade', `Trade offered · ${what} · T waits accept`, TOAST_VE_TTL_MS);
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
      void net.cancelTrade().then(() => {
        pushCombatLog('trade', 'Trade cancelled');
        pushSystemToast('trade', 'Trade cancelled');
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        pushSystemToast('rate', msg.slice(0, 96) || 'Cancel trade failed');
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
        pushSystemToast('rate', 'No yard tonic in bag');
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
        // Brief green flash VFX on local player
        flashMesh(humanoid.mat, new Color3(0.35, 1.0, 0.55), 700);
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (/no yard tonic/i.test(msg)) {
          pushSystemToast('rate', 'No yard tonic in bag');
        } else {
          pushSystemToast('rate', msg.slice(0, 96) || 'Use tonic failed');
        }
      });
    },
    onUseBandage: () => {
      if (!net) return;
      const g = net;
      const ch0 = g.getCharacter();
      if (!ch0?.hasYardBandage) {
        pushSystemToast('rate', 'No yard bandage in bag');
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
          pushSystemToast('rate', 'No yard bandage in bag');
        } else if (/recently damaged/i.test(msg)) {
          pushSystemToast('rate', 'Too soon after damage');
        } else if (/bandage on cooldown/i.test(msg)) {
          pushSystemToast('rate', 'Bandage on cooldown');
        } else if (/already full/i.test(msg)) {
          pushSystemToast('rate', 'Already full HP');
        } else {
          pushSystemToast('rate', msg.slice(0, 96) || 'Use bandage failed');
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
        pushSystemToast('mana', `Insufficient mana · need ${KICK_MANA_COST}`, TOAST_VE_TTL_MS);
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
        pushSystemToast('mana', `Insufficient mana · need ${STUN_MANA_COST}`, TOAST_VE_TTL_MS);
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
            const label =
              npc.kind === NPC_KIND_DUMMY ? 'Dummy' : 'NPC';
            pushCombatLog(
              'damage',
              `${label} #${npc.npcId}  −${delta} HP (${npc.hp}/${npc.maxHp})`,
            );
          }
        }
        npcLastHp.set(key, npc.hp);
      }

      const wasAlive = (prevHp ?? npc.hp) > 0;
      const isAlive = npc.hp > 0;
      let fx = npcLifeFx.get(key);

      if (wasAlive && !isAlive && (!fx || fx.phase !== 'dying')) {
        if (fx) {
          disposeLifeBurst(fx);
          npcLifeFx.delete(key);
        }
        fx = beginNpcDeathFx(scene, mesh);
        npcLifeFx.set(key, fx);
        latestDeathAtMs = Date.now();
        const label = npc.kind === NPC_KIND_DUMMY ? 'Dummy' : 'NPC';
        const defeated =
          npc.kind === NPC_KIND_DUMMY ? 'Dummy defeated' : `${label} defeated`;
        pushCombatLog('death', `${defeated} (#${npc.npcId})`);
        pushSystemToast('death', defeated, TOAST_VE_TTL_MS);
      } else if (!wasAlive && isAlive && (!fx || fx.phase !== 'spawning')) {
        if (fx) {
          disposeLifeBurst(fx);
          npcLifeFx.delete(key);
        }
        fx = beginNpcRespawnFx(mesh);
        npcLifeFx.set(key, fx);
        latestRespawnAtMs = Date.now();
        const label = npc.kind === NPC_KIND_DUMMY ? 'Dummy' : 'NPC';
        const line =
          npc.kind === NPC_KIND_DUMMY
            ? 'Dummy respawned'
            : `${label} respawned`;
        pushCombatLog('respawn', `${line} (#${npc.npcId})`);
        pushSystemToast('respawn', line, TOAST_VE_TTL_MS);
      }

      mesh.root.position.x = npc.x;
      mesh.root.position.z = npc.z;

      const animating = !!fx && (fx.phase === 'dying' || fx.phase === 'spawning');
      if (!animating) {
        mesh.root.setEnabled(isAlive);
        if (mesh.nameplate && npc.kind === NPC_KIND_DUMMY) {
          mesh.nameplate.mesh.setEnabled(isAlive);
        }
      }

      if (mesh.nameplate && npc.kind === NPC_KIND_DUMMY) {
        paintNameplate(
          mesh.nameplate,
          'Dummy',
          '#e8c89a',
          npc.maxHp > 0 ? Math.max(0, npc.hp / npc.maxHp) : 0,
        );
      }

      const selected = selectedTargetId === npc.npcId && isAlive;
      const remoteSelected =
        isAlive &&
        latestRemoteCombats.some((rc) => rc.targetNpcId === npc.npcId);
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
        } else {
          mesh.ringMat.emissiveColor = new Color3(1.28, 0.95, 0.2);
          mesh.ringMat.diffuseColor = new Color3(1.0, 0.86, 0.24);
          mesh.markerMat.emissiveColor = new Color3(1.18, 0.88, 0.16);
          mesh.markerMat.diffuseColor = new Color3(1.0, 0.84, 0.22);
          // Stronger body tint so tab-target reads even at glancing angles.
          mesh.mat.emissiveColor = new Color3(0.28, 0.18, 0.04);
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
      } else if (fx?.phase !== 'dying') {
        mesh.ringMat.emissiveColor = new Color3(0, 0, 0);
        mesh.mat.emissiveColor = new Color3(0, 0, 0);
        mesh.marker.setEnabled(false);
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
      }
    }
  };

  engine.runRenderLoop(() => {
    const dt = engine.getDeltaTime() / 1000;
    const now = Date.now();

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

    if (net && keys.size > 0) {
      const wish = wishFromKeys(keys, camera);
      if (wish.dx !== 0 || wish.dz !== 0) {
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

    // Refresh tonic buff timer on self-frame each frame.
    if (net) {
      const chTick = net.getCharacter();
      if (chTick) updateSelfFrame(chTick);
    }

    // Keep highlight in sync with server combat target.
    if (net) {
      const c = net.getCombat();
      if (c) selectedTargetId = c.targetNpcId;
      syncNpcMeshes(net.getNpcs());
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
    }
    const castLeft = Math.max(0, castUntilMs - now);
    setGcdBar(gcdLeft, castLeft, castTotalMs, castSpellDisplayName(lastCastSpell));
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
        } else if (ch.staffEquipped !== prevStaffEquipped) {
          const staffMsg = ch.staffEquipped ? 'Staff equipped' : 'Staff unequipped';
          pushCombatLog('equip', staffMsg);
          pushSystemToast('equip', staffMsg);
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
            }
          } else if (ch.hp <= 0 && prevPlayerHp > 0) {
            setDeathGreyout(true);
            setLocalGhost(true);
            pushCombatLog('death', 'You died · respawning at yard');
            pushSystemToast('death', 'You died · respawning at yard', TOAST_VE_TTL_MS);
            selectedTargetId = 0n;
            latestPlayerDeathAtMs = Date.now();
            prevPlayerHp = ch.hp;
          } else if (ch.hp > 0 && prevPlayerHp <= 0) {
            setDeathGreyout(false);
            setLocalGhost(false);
            pushCombatLog('respawn', 'You respawned at yard · full HP');
            pushSystemToast('respawn', 'Respawned at yard · full HP', TOAST_VE_TTL_MS);
            flashMesh(humanoid.mat, new Color3(0.55, 0.85, 1.0), 900);
            latestPlayerRespawnAtMs = Date.now();
            prevPlayerHp = ch.hp;
          } else if (ch.hp !== prevPlayerHp) {
            if (ch.hp < prevPlayerHp) {
              const dmg = prevPlayerHp - ch.hp;
              pushCombatLog('damage', `Thorns −${dmg} · You ${ch.hp}/${ch.maxHp}`);
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
            `Invite from ${pending.slice(0, 8)}…`,
          );
        }
        if (!pending && prevPendingInvite && size > prevPartySize) {
          const acceptKey = `${prevPendingInvite}:${size}:${memberKey}`;
          if (acceptKey !== toastedInviteAcceptKey) {
            pushSystemToast(
              'party',
              `Invite accepted · party ${size}`,
            );
            toastedInviteAcceptKey = acceptKey;
          }
        }
        prevPendingInvite = pending;
        // Inbound trade offer toast + bag refresh when transfer lands.
        const tr = net?.getTrade();
        const tradePending = tr?.pendingFrom ?? null;
        if (tradePending && tradePending !== lastTradePendingFrom) {
          const bits: string[] = [];
          if (tr?.offeredHasEmberShard) bits.push('ember_shard');
          if ((tr?.offeredXp ?? 0) > 0) bits.push(`+${tr!.offeredXp} XP`);
          pushSystemToast(
            'trade',
            `Trade from ${tradePending.slice(0, 8)}… · ${bits.join(' · ') || 'offer'} · T accept`,
            TOAST_VE_TTL_MS,
          );
          pushCombatLog(
            'trade',
            `Offer from ${tradePending.slice(0, 8)}… (${bits.join(' · ') || 'offer'})`,
          );
        }
        if (
          !tradePending &&
          lastTradePendingFrom &&
          tr?.pendingTo == null
        ) {
          const doneKey = `done:${lastTradePendingFrom}`;
          if (doneKey !== toastedTradeKey) {
            toastedTradeKey = doneKey;
            bagOpen = true;
            setBagPanelOpen(true);
            const chNow = net?.getCharacter();
            if (chNow) updateBagPanel(chNow);
            pushSystemToast('trade', 'Trade complete · bag updated', TOAST_VE_TTL_MS);
          }
        }
        lastTradePendingFrom = tradePending;
        if (size > prevPartySize && size >= 1) {
          if (prevPartySize === 0) {
            pushCombatLog(
              'party',
              size === 1
                ? 'Party formed (you)'
                : `Joined party · size ${size}`,
            );
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
            pushCombatLog(
              'party',
              `Party join · ${label} · size ${size}`,
            );
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
            pushCombatLog(
              'party',
              `Party join · ${joined
                .map((h) => `${h.slice(0, 8)}…`)
                .join(', ')} · size ${size}`,
            );
          }
        }
        prevPartySize = size;
        prevPartyMemberKey = memberKey;
      }
    }
    if (latestStatus.state === 'connected') {
      setStatus(formatStatus(latestStatus, now));
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
      proxies: net?.getProxies() ?? [],
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
    }

    {
      const nearV = net?.nearestVendor(4.5) ?? null;
      if (nearV) {
        updateVendorPanel(nearV);
        // transient nearby chip via vendor panel peek without forcing open
        const foot = document.querySelector('#vendorPanel .bagFoot');
        if (foot) {
          const ch = net?.getCharacter();
          foot.textContent = ch?.hasEmberShard
            ? 'Vendor nearby · E sell ember_shard (+5 XP)'
            : 'Vendor nearby · E buy ember_shard (−5 XP)';
        }
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
    // Skip follow for ?ve=vendor-stall so the shop silhouette stays framed.
    {
      const veFollow = new URLSearchParams(window.location.search).get('ve');
      if (veFollow !== 'vendor-stall') {
        const follow = player.position.add(new Vector3(0, 1.35, 0));
        const radius = camera.radius;
        camera.setTarget(follow);
        camera.radius = radius;
      }
    }
    scene.render();
  });
  window.addEventListener('resize', () => engine.resize());

  setStatus('Connecting to SpacetimeDB…');
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
    }
    setStatus(formatStatus(s, Date.now()));
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
        net.seedCrowdProxies();
        syncProxyMeshes(net.getProxies());
        if (mark) {
          const aoi = net.getAoi();
          const ok =
            ve === 'quaternius-env'
              ? 'Quaternius env OK · Standard CC0 heroes+mid+understory · mountains procedural'
              : 'Forest OK · density+LOD · Connected';
          mark.textContent = aoi ? `${ok} · AOI near ${aoi.nearCount}` : ok;
        }
        return;
      }
      window.setTimeout(waitForest, 300);
    };
    window.setTimeout(waitForest, 600);
  }

  // ?ve=atmosphere — yard mood shot: fog depth, warm sun, lush ground clearing.
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
        net.seedCrowdProxies();
        syncProxyMeshes(net.getProxies());
        if (mark) {
          mark.textContent =
            'Atmosphere OK · fog+warm sun+ground · Connected · yard mood';
        }
        return;
      }
      window.setTimeout(waitAtmosphere, 300);
    };
    window.setTimeout(waitAtmosphere, 600);
  }

  // ?ve=path-ground — play-cam frame of polished dirt/stone trail vs lush grass (#44).
  if (ve === 'path-ground') {
    camera.radius = 15;
    camera.alpha = Math.PI / 3.1;
    camera.beta = Math.PI / 2.75;
  }

  if (net && ve === 'path-ground') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE path-ground: waiting for Connected…';
    const waitPathGround = () => {
      if (!net) return;
      const st = latestStatus;
      if (st.state === 'connected') {
        // Bias toward SE trail strip + soft path/grass edge under cyan fog.
        camera.setTarget(player.position.add(new Vector3(4.2, 0.15, 5.2)));
        camera.radius = 15;
        camera.alpha = Math.PI / 3.1;
        camera.beta = Math.PI / 2.75;
        if (mark) {
          mark.textContent =
            'Path-ground OK · dirt/stone trail vs lush grass · Connected';
        }
        return;
      }
      window.setTimeout(waitPathGround, 300);
    };
    window.setTimeout(waitPathGround, 600);
  }

  // ?ve=sky-horizon — play-cam frame of layered mountain silhouette + sky gradient (#55).
  if (ve === 'sky-horizon') {
    camera.radius = 18;
    camera.alpha = Math.PI / 2.05;
    camera.beta = Math.PI / 2.55;
  }

  if (net && ve === 'sky-horizon') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE sky-horizon: waiting for Connected…';
    const waitSkyHorizon = () => {
      if (!net) return;
      const st = latestStatus;
      if (st.state === 'connected') {
        // Face distant N mountains; mid play-cam so ridges read through cyan fog.
        camera.setTarget(player.position.add(new Vector3(0, 2.5, -12)));
        camera.radius = 18;
        camera.alpha = Math.PI / 2.05;
        camera.beta = Math.PI / 2.55;
        if (mark) {
          mark.textContent =
            'Sky-horizon OK · layered ridges + fog-matched sky · Connected';
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
            'Humanoid OK · body+head+limbs+staff · Connected · crowd capsules OK';
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
      camera.setTarget(player.position.add(new Vector3(0, 1.05, 0)));
      camera.radius = 11;
      camera.alpha = Math.PI / 2.55;
      camera.beta = Math.PI / 2.65;
      const staffOn = humanoid.staff.isEnabled();
      const robesOn = humanoid.robes.isEnabled();
      if (staffOn && robesOn) {
        if (mark) {
          mark.textContent =
            'Humanoid polish OK · silhouette · robes/staff · canonical forest lights';
        }
        return;
      }
      if (ticks > 120) {
        if (mark) mark.textContent = 'VE humanoid-polish: timed out';
        return;
      }
      window.setTimeout(waitPolish, 200);
    };
    window.setTimeout(waitPolish, 600);
  }

  // ?ve=dummy — frame scarecrow/practice dummy at play-cam under canonical #39 lights.
  if (ve === 'dummy') {
    camera.radius = 9.5;
    camera.alpha = Math.PI / 2.15;
    camera.beta = Math.PI / 2.75;
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
          net.sendMove((dx / dist) * step, (dz / dist) * step);
        } else if (dist < 4.8) {
          const step = Math.min(MAX_STEP_METERS, 5.8 - dist);
          net.sendMove((-dx / dist) * step, (-dz / dist) * step);
        }
        // Bias toward dummy so wood post + X-pad + sack head dominate the shot.
        camera.setTarget(
          new Vector3(
            player.position.x * 0.15 + dummy.x * 0.85,
            1.2,
            player.position.z * 0.15 + dummy.z * 0.85,
          ),
        );
        camera.radius = 9.5;
        camera.alpha = Math.PI / 2.15;
        camera.beta = Math.PI / 2.75;
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
            `Dummy OK · scarecrow silhouette · wood+canvas · canonical forest lights · #${dummy.npcId}`;
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

  // ?ve=minimap-read — Readability test: party + self blips + compass vs grass/fog (cyan #39 palette).
  if (ve === 'minimap-read') {
    camera.radius = 28;
    camera.alpha = Math.PI / 2.4;
    camera.beta = Math.PI / 3.2;
  }
  if (net && ve === 'minimap-read') {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE minimap-read: waiting for party + blips vs grass/fog…';
    let ticks = 0;
    let invited = false;
    const waitMinimapRead = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') {
        if (mark) mark.textContent = `VE minimap-read: ${st.state}…`;
        if (ticks < 200) window.setTimeout(waitMinimapRead, 200);
        return;
      }
      const party = net.getPartyState();
      const local = net.getLocalPose();
      const remotes = net.getRemotes();
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
      drawMinimap({
        local: { x: local.x, z: local.z },
        remotes,
        npcs: net.getNpcs(),
        proxies: net.getProxies(),
      });
      const partyMate = remotes.find((r) => r.party);
      if ((party?.size ?? 0) >= 2 && partyMate && document.getElementById('minimap')) {
        camera.setTarget(new Vector3(local.x, 1.1, local.z));
        if (mark) {
          mark.textContent =
            `Minimap read OK · blips + compass vs grass/cyan fog · party ${party?.size} · ` +
            `remotes ${remotes.length} · contrast readable`;
        }
        return;
      }
      if (mark) {
        mark.textContent =
          `VE minimap-read: Connected · party ${party?.size ?? 0} · remotes ${remotes.length} · ` +
          `invited=${invited} · pending=${party?.pendingInviteFrom?.slice(0, 8) ?? '—'} (waiting party…)`;
      }
      if (ticks > 220) {
        if (mark) mark.textContent = 'VE minimap-read: timed out waiting for party mate';
        return;
      }
      window.setTimeout(waitMinimapRead, 200);
    };
    window.setTimeout(waitMinimapRead, 800);
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
        const ch = net.getCharacter();
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
          net.sendMove((dx / dist) * step, (dz / dist) * step);
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
          net.sendMove((dx / dist) * step, (dz / dist) * step);
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
        `Keys legend OK · H toggles · ${chips} binds · WASD/RMB/Tab/1-2/Esc · B/U/I/J/K · P/O/T/Y · E/F/V/R · Enter`;
    }
  }

  // ?ve=bag — prove self-frame + loadout strip + bag panel (B).
  if (ve === 'bag') {
    camera.radius = 11;
    camera.alpha = Math.PI / 2.45;
    camera.beta = Math.PI / 3.15;
  }
  if (net && ve === 'bag') {
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
          mark.textContent = `Bag OK · You XP ${ch.xp} · staff ${ch.staffEquipped ? 'on' : 'off'} · Spark+Emberbolt known · B toggles bag`;
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



  // ?ve=fps — seed crowd proxies; prove FPS HUD visible + near proxies > 0.
  if (ve === 'fps') {
    camera.radius = 22;
    camera.alpha = Math.PI / 2.5;
    camera.beta = Math.PI / 3.55;
    debugHudVisible = true;
    setDebugHudVisible(true);
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
      net.seedCrowdProxies();
      syncProxyMeshes(net.getProxies());
      const proxies = net.getProxies();
      const near = proxies.filter((p) => !p.far);
      const far = proxies.filter((p) => p.far);
      const hud = document.getElementById('fpsHud');
      const fpsVal = document.getElementById('fpsValue')?.textContent ?? '—';
      const hudVisible = !!hud && hud.offsetWidth > 0;
      const fpsNum = Number.parseInt(fpsVal, 10);
      const fpsOk = Number.isFinite(fpsNum) && fpsNum > 0;
      if (hudVisible && near.length > 0 && fpsOk) {
        if (mark) {
          mark.textContent =
            `FPS OK · ${fpsNum} fps (floor ${FPS_FLOOR} / target ${FPS_TARGET}) · near ${near.length} · far ${far.length} · remotes ${(net.getRemotes() ?? []).length} · box ref`;
        }
        return;
      }
      if (mark) {
        mark.textContent =
          `VE fps: Connected · HUD ${hudVisible ? 'on' : 'off'} · fps ${fpsVal} · near ${near.length} (waiting…)`;
      }
      if (ticks > 220) {
        if (mark) {
          mark.textContent =
            `VE fps: timed out · HUD ${hudVisible ? 'on' : 'off'} · fps ${fpsVal} · near ${near.length}`;
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
        for (let i = 0; i < 4; i++) net.sendMove(-0.75, 0);
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
        pushSystemToast('loot', 'Ember shard nearby · F to pick', TOAST_VE_TTL_MS);
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
      const toastOk = toastKindsPresent().has('trade');
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
          net.sendMove(target.x - (net.getLocalPose()?.x ?? 0), target.z - (net.getLocalPose()?.z ?? 0));
        }
        void net
          .offerTrade(partner, true, 0)
          .then(() => {
            pushCombatLog('trade', `Offered ember_shard → ${target.identityHex.slice(0, 8)}…`);
            pushSystemToast(
              'trade',
              `Trade offered · ember_shard · waiting accept`,
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




  // ?ve=vendor-stall — play-cam frame of shop silhouette (posts+counter+awning) under #39 fog (#58).
  if (ve === 'vendor-stall') {
    // Face stall front (counter/-Z); play-cam height so awning+counter read.
    camera.radius = 11;
    camera.alpha = -Math.PI / 2.15;
    camera.beta = Math.PI / 2.35;
    // Presentation preview at known YardVendor spawn — independent of syncVendorMeshes
    // so empty yard_vendor sub cannot dispose it mid-shot.
    const STALL_X = -2.5;
    const STALL_Z = 2.0;
    const preview = createVendorStall(scene, 'veVendorStall');
    preview.body.position.set(STALL_X, 0, STALL_Z);
    const plate = createNameplate(scene, 'veVendorStall');
    plate.mesh.parent = preview.body;
    plate.mesh.position.set(0, 2.45, 0);
    paintNameplate(plate, 'Vendor', '#7dffb5', 1);
    camera.setTarget(new Vector3(STALL_X, 1.1, STALL_Z));
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
      camera.setTarget(new Vector3(x, 1.1, z));
      camera.radius = 11;
      camera.alpha = -Math.PI / 2.15;
      camera.beta = Math.PI / 2.35;
      if (mark) {
        mark.textContent =
          'Vendor-stall OK · shop silhouette · Connected';
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
            net.sendMove(v0.x + 0.9 - p.x, v0.z + 0.4 - p.z);
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
        if (pose) net.sendMove(v0.x - pose.x, v0.z - pose.z);
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
            net.sendMove(dx, dz);
            window.setTimeout(waitVendor, 280);
            return;
          }
        }
        net.seedLoot();
        void net
          .pickup()
          .then(() => {
            const p2 = net.getLocalPose();
            if (p2) net.sendMove(v0.x - p2.x, v0.z - p2.z);
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
            net.sendMove(v0.x + 0.9 - p.x, v0.z + 0.4 - p.z);
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
        if (pose) net.sendMove(v0.x - pose.x, v0.z - pose.z);
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
          net.sendMove(lootX - pose.x, lootZ - pose.z);
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
          flashMesh(humanoid.mat, new Color3(0.35, 1.0, 0.55), 900);
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
        net.sendMove(MAX_STEP_METERS * TONIC_MOVE_MULT * 0.6, 0);
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
            net.sendMove(v0.x + 0.9 - p.x, v0.z + 0.4 - p.z);
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
        if (pose) net.sendMove(v0.x - pose.x, v0.z - pose.z);
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
          net.sendMove(lootX - pose.x, lootZ - pose.z);
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
        if (mark) {
          mark.textContent =
            `Death UX OK · greyout · countdown · toast` +
            (digText || subText ? ` · ${digText || subText}` : '') +
            ` · casts ${casts}`;
        }
        const hold = () => {
          setDeathGreyout(true, 'Respawn in 2s…', { freezeSub: true });
          setLocalGhost(true);
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
            `Insufficient mana · ${ch?.mana ?? 0}/${ch?.maxMana ?? 0}`,
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
            `Insufficient mana · ${ch?.mana ?? 0}/${ch?.maxMana ?? 0}`,
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
            `Insufficient mana · ${fakeMana}/${fakeMax}`,
            TOAST_VE_TTL_MS,
          );
          pushCombatLog('mana', `Insufficient mana · ${fakeMana}/${fakeMax}`);
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
          net.sendMove(0.55, 0);
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
            net.sendMove(-0.75, 0);
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
            net.sendMove(-0.75, 0);
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
  // ?ve=kick / ?ve=counterspell
  if (ve === 'kick' || ve === 'counterspell') {
    camera.radius = 14; camera.alpha = Math.PI / 2.3; camera.beta = Math.PI / 3.1;
  }
  if (net && (ve === 'kick' || ve === 'counterspell')) {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE kick: waiting…';
    let ticks = 0, kicked = false, nudged = false;
    const waitKick = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') { if (ticks < 240) window.setTimeout(waitKick, 200); return; }
      if (!nudged) { nudged = true; for (let i = 0; i < 5; i++) net.sendMove(0.8, 0.4); }
      const remotes = net.getRemotes();
      const combats = net.getRemoteCombats();
      syncRemoteMeshes(remotes); syncRemoteCastFx(combats); syncNpcMeshes(net.getNpcs());
      const casting = combats.find((c) => c.castingSpellId !== 0 && castRemainingMs(c) > 200);
      const preferred = remotes.find((r) => casting && r.identityHex === casting.identityHex) ?? remotes[0];
      if (preferred) {
        camera.setTarget(new Vector3((player.position.x + preferred.x) / 2, 1.15, (player.position.z + preferred.z) / 2));
        const local = net.getLocalPose();
        if (local) {
          const dist = Math.hypot(preferred.x - local.x, preferred.z - local.z);
          if (dist > KICK_RANGE_METERS - 1.5) net.sendMove(preferred.x - local.x, preferred.z - local.z);
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
  // ?ve=stun / ?ve=bash
  if (ve === 'stun' || ve === 'bash') {
    camera.radius = 14; camera.alpha = Math.PI / 2.3; camera.beta = Math.PI / 3.1;
  }
  if (net && (ve === 'stun' || ve === 'bash')) {
    const mark = document.getElementById('persistMark');
    if (mark) mark.textContent = 'VE stun: waiting…';
    let ticks = 0, stunned = false, nudged = false;
    const waitStun = () => {
      if (!net) return;
      ticks += 1;
      const st = latestStatus;
      if (st.state !== 'connected') { if (ticks < 240) window.setTimeout(waitStun, 200); return; }
      if (!nudged) { nudged = true; for (let i = 0; i < 5; i++) net.sendMove(0.8, 0.4); }
      const remotes = net.getRemotes();
      syncRemoteMeshes(remotes); syncRemoteCastFx(net.getRemoteCombats()); syncNpcMeshes(net.getNpcs());
      const preferred = remotes[0];
      if (preferred) {
        camera.setTarget(new Vector3((player.position.x + preferred.x) / 2, 1.15, (player.position.z + preferred.z) / 2));
        const local = net.getLocalPose();
        if (local) {
          const dist = Math.hypot(preferred.x - local.x, preferred.z - local.z);
          if (dist > STUN_RANGE_METERS - 1.0) net.sendMove(preferred.x - local.x, preferred.z - local.z);
        }
      }
      if (toastKindsPresent().has('stun') && stunned) {
        if (mark) mark.textContent = 'Stun OK · hard-CC + StunnedUntilMicros move lock · distinct from CastLockedUntil · key 4';
        return;
      }
      if (remotes.length < 1) {
        if (mark) mark.textContent = 'VE stun: remotes 0 (start tools/SecondClient)…';
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
        net.sendMove(wish.dx * step, wish.dz * step);
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

  void STUN_MANA_COST;
  void STUN_RANGE_METERS;
  void STUN_DURATION_MS;
  void stunRemainingMs;
}

main().catch((err: unknown) => {
  console.error(err);
  setStatus(`Boot failed: ${err instanceof Error ? err.message : String(err)}`);
});
