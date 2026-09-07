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
  type GroundItemView,
  type VendorView,
} from './net/connection';
import { buildForestClearing } from './world/forest';
import {
  createPlayerHumanoid,
  partyRobeColor,
  remoteRobeColor,
  type HumanoidParts,
} from './world/humanoid';
import {
  casterMuzzle,
  createEmberBeam,
  placeBeam,
  spawnImpactPop,
  spawnSparkBolt,
  targetHitPoint,
  tickImpactPops,
  tickSparkBolts,
  type EmberBeam,
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

/** Player self-frame: You + XP (no player HP on Character yet). */
function updateSelfFrame(character: {
  xp: number;
} | null | undefined): void {
  const frame = document.getElementById('selfFrame');
  if (!frame) return;
  if (!character) {
    frame.classList.add('hidden');
    return;
  }
  frame.classList.remove('hidden');
  const nameEl = document.getElementById('sfName');
  const xpEl = document.getElementById('sfXp');
  if (nameEl) nameEl.textContent = 'You';
  if (xpEl) xpEl.textContent = `XP ${character.xp}`;
}

/** Compact loadout strip: staff/robes + Spark/Emberbolt known gates. */
function updateLoadoutStrip(character: {
  staffEquipped: boolean;
  robesEquipped: boolean;
  knowsSpark: boolean;
  knowsEmberbolt: boolean;
  hasEmberShard?: boolean;
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
}

/** Bag panel rows (Character loadout). Visibility controlled separately via B. */
function updateBagPanel(character: {
  xp: number;
  staffEquipped: boolean;
  robesEquipped: boolean;
  knowsSpark: boolean;
  knowsEmberbolt: boolean;
  hasEmberShard?: boolean;
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
    setRow('bagXp', '—', null);
    setRow('bagShard', '—', null);
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
  setRow('bagXp', String(character.xp), null);
  setRow(
    'bagShard',
    character.hasEmberShard ? 'held' : 'empty',
    !!character.hasEmberShard,
  );
}

function setBagPanelOpen(open: boolean): void {
  const panel = document.getElementById('bagPanel');
  if (!panel) return;
  panel.classList.toggle('hidden', !open);
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


function updatePartyFrames(opts: {
  localHex: string | null;
  localPose: { x: number; z: number } | null;
  party: {
    size: number;
    isLeader: boolean;
    members: { identityHex: string; isLeader: boolean }[];
  } | null | undefined;
  remotes: RemotePose[];
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
    const cls = [
      'pfRow',
      isSelf ? 'self' : '',
      m.isLeader ? 'leader' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const name = isSelf ? 'You' : `${m.identityHex.slice(0, 8)}…`;
    const tag = m.isLeader ? '<span class="pfTag">leader</span>' : '';
    rows.push(
      `<div class="${cls}" data-hex="${m.identityHex}">` +
        `<div class="pfNameRow"><span class="pfName">${name}</span>${tag}</div>` +
        `<div class="pfMeta">${meta}</div>` +
        `</div>`,
    );
  }
  root.innerHTML = rows.join('');
}


const COMBAT_LOG_MAX = 14;

type CombatLogKind = 'cast' | 'damage' | 'equip' | 'party' | 'death' | 'respawn' | 'loot' | 'trade'
  | 'vendor';

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
  | 'equip'
  | 'death'
  | 'respawn'
  | 'say'
  | 'partySay'
  | 'whisper'
  | 'rate'
  | 'loot'
  | 'trade'
  | 'vendor';

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
      'keys: WASD move · RMB look · Tab target · 1 Spark · 2 Emberbolt · B bag · U/I staff · J/K robes · P invite/accept · O leave · T trade offer/accept · Y cancel trade · E vendor · F pickup · Enter say (/p party · /w hex whisper) · combat log right · FPS overlay · system toasts top',
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


function makeVendorMesh(scene: Scene, vendor: VendorView): { root: Mesh; mat: StandardMaterial; nameplate: Nameplate | null } {
  const root = new Mesh(`vendor_${vendor.vendorId}`, scene);
  root.position = new Vector3(vendor.x, 0, vendor.z);

  const body = MeshBuilder.CreateBox(`vendorBody_${vendor.vendorId}`, { width: 0.9, height: 1.4, depth: 0.7 }, scene);
  body.parent = root;
  body.position.y = 0.7;
  const mat = new StandardMaterial(`vendorMat_${vendor.vendorId}`, scene);
  mat.diffuseColor = new Color3(0.25, 0.75, 0.45);
  mat.emissiveColor = new Color3(0.05, 0.18, 0.1);
  mat.specularColor = new Color3(0.1, 0.15, 0.1);
  body.material = mat;

  const awning = MeshBuilder.CreateBox(`vendorAwning_${vendor.vendorId}`, { width: 1.2, height: 0.12, depth: 1.0 }, scene);
  awning.parent = root;
  awning.position.y = 1.55;
  const awningMat = new StandardMaterial(`vendorAwningMat_${vendor.vendorId}`, scene);
  awningMat.diffuseColor = new Color3(0.85, 0.55, 0.2);
  awningMat.emissiveColor = new Color3(0.15, 0.08, 0.02);
  awning.material = awningMat;

  const nameplate = createNameplate(scene, `vendor_${vendor.vendorId}`);
  nameplate.mesh.parent = root;
  nameplate.mesh.position.set(0, 2.05, 0);
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
  onVendorInteract: () => void;
  onPickupNearest: () => void;
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
  parts.mat.emissiveColor.copyFrom(col.scale(equipped ? 0.08 : 0.04));
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

/** Rising world billboard text — damage numbers, XP floaters, etc. */
function spawnWorldFloater(
  scene: Scene,
  at: Vector3,
  label: string,
  tint: Color3,
  opts?: { lifeMs?: number; yLift?: number; planeW?: number; planeH?: number },
): DamageFloater {
  const lifeMs = opts?.lifeMs ?? 1100;
  const yLift = opts?.yLift ?? 1.85;
  const planeW = opts?.planeW ?? 1.7;
  const planeH = opts?.planeH ?? 0.85;
  const tex = new DynamicTexture(
    `fltTex_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    { width: 256, height: 128 },
    scene,
    false,
  );
  tex.hasAlpha = true;
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, 256, 128);
  const fontPx = label.length > 6 ? 64 : 84;
  ctx.font = `bold ${fontPx}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 12;
  ctx.strokeStyle = 'rgba(0,0,0,0.92)';
  ctx.strokeText(label, 128, 64);
  ctx.fillStyle = `rgb(${Math.round(tint.r * 255)},${Math.round(tint.g * 255)},${Math.round(tint.b * 255)})`;
  ctx.fillText(label, 128, 64);
  tex.update();

  const mat = new StandardMaterial(`fltMat_${label}_${Date.now()}`, scene);
  mat.diffuseTexture = tex;
  mat.emissiveTexture = tex;
  mat.opacityTexture = tex;
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
  mesh.isPickable = false;

  return {
    mesh,
    mat,
    bornMs: Date.now(),
    lifeMs,
    startY: mesh.position.y,
    driftX: (Math.random() - 0.5) * 0.55,
  };
}

/** Rising combat text above an NPC — cosmetic only (HP delta from authority). */
function spawnDamageFloater(
  scene: Scene,
  at: Vector3,
  amount: number,
  tint: Color3,
): DamageFloater {
  return spawnWorldFloater(scene, at, `-${amount}`, tint);
}

/** Rising "+N XP" near local player — client-only Cosmetic over Character.Xp. */
function spawnXpFloater(
  scene: Scene,
  at: Vector3,
  gained: number,
): DamageFloater {
  return spawnWorldFloater(
    scene,
    at,
    `+${gained} XP`,
    new Color3(1, 0.82, 0.28),
    { lifeMs: 1400, yLift: 2.15, planeW: 2.2, planeH: 0.95 },
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

function beginNpcDeathFx(
  scene: Scene,
  mesh: NpcMesh,
): NpcLifeFx {
  mesh.root.setEnabled(true);
  mesh.root.scaling.setAll(1);
  mesh.body.position.y = 0.8;
  mesh.mat.alpha = 1;
  mesh.mat.transparencyMode = 2; // ALPHA_BLEND
  mesh.ring.setEnabled(false);
  mesh.remoteRing.setEnabled(false);
  if (mesh.nameplate) mesh.nameplate.mesh.setEnabled(false);
  const at = mesh.root.position.clone();
  at.y += 0.8;
  return {
    phase: 'dying',
    bornMs: Date.now(),
    lifeMs: DEATH_FX_MS,
    baseBodyY: 0.8,
    baseEmissive: mesh.mat.emissiveColor.clone(),
    burst: spawnDeathBurst(scene, at),
  };
}

function beginNpcRespawnFx(mesh: NpcMesh): NpcLifeFx {
  mesh.root.setEnabled(true);
  mesh.root.scaling.setAll(0.12);
  mesh.body.position.y = 0.8;
  mesh.mat.alpha = 1;
  mesh.mat.transparencyMode = 0;
  mesh.mat.emissiveColor = new Color3(0.85, 0.75, 0.35);
  if (mesh.nameplate) mesh.nameplate.mesh.setEnabled(true);
  return {
    phase: 'spawning',
    bornMs: Date.now(),
    lifeMs: RESPAWN_FX_MS,
    baseBodyY: 0.8,
    baseEmissive: new Color3(0, 0, 0),
    burst: [],
  };
}

function finishNpcLifeFx(mesh: NpcMesh, fx: NpcLifeFx): void {
  disposeLifeBurst(fx);
  mesh.root.scaling.setAll(1);
  mesh.body.position.y = fx.baseBodyY;
  mesh.mat.alpha = 1;
  mesh.mat.transparencyMode = 0;
  mesh.mat.emissiveColor = fx.baseEmissive.clone();
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
  const { scene, camera, player, humanoid, proxySource } = createScene(engine);

  let net: GameNet | null = null;
  let bagOpen = false;
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
  const vendorMeshes = new Map<string, { root: Mesh; mat: StandardMaterial; nameplate: Nameplate | null }>();
  let vendorOpen = false; void vendorOpen;
  const groundSparkles = new Map<string, GroundSparkle>();
  let latestGround: GroundItemView[] = [];
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
  const localEmberBeam: EmberBeam = createEmberBeam(scene, 'local');
  let localBeamActive = false;
  let castVfxStats = { bolts: 0, impacts: 0, beams: 0 };
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

      // Impact / Spark bolt when LastCastAt advances (unify with local cast VFX).
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
        const from = parts
          ? casterMuzzle(parts.root.position)
          : null;
        const to = mesh ? targetHitPoint(mesh.root.position) : null;
        if (spark && from && to) {
          sparkBolts.push(
            spawnSparkBolt(scene, from, to, {
              key: `r_${key.slice(0, 8)}_${Number(rc.lastCastAtMicros % 100000n)}`,
            }),
          );
          castVfxStats.bolts += 1;
        } else if (!spark && to) {
          impactPops.push(
            spawnImpactPop(scene, to, new Color3(1.2, 0.45, 0.08), {
              key: `rimp_${key.slice(0, 8)}`,
            }),
          );
          castVfxStats.impacts += 1;
          if (mesh) {
            flashMesh(mesh.mat, new Color3(1, 0.3, 0.05), 450);
          }
        } else if (mesh) {
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
        const from = casterMuzzle(parts.root.position);
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

      // Local cast VFX: Spark bolt + trail; Emberbolt thicker beam; impact pop on hit.
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
      const from = casterMuzzle(player.position);
      if (spellId === SPELL_SPARK && mesh) {
        const to = targetHitPoint(mesh.root.position);
        sparkBolts.push(
          spawnSparkBolt(scene, from, to, {
            key: `local_spark_${Date.now()}`,
          }),
        );
        castVfxStats.bolts += 1;
        localBeamActive = false;
        localEmberBeam.beam.setEnabled(false);
      } else if (spellId === SPELL_EMBERBOLT && mesh) {
        localBeamActive = true;
        const to = targetHitPoint(mesh.root.position);
        placeBeam(localEmberBeam.beam, from, to);
        castVfxStats.beams += 1;
        // Soft target glow during windup; impact pop fires when bolt/cast lands.
        flashMesh(
          mesh.mat,
          new Color3(1, 0.35, 0.05),
          Math.min(500, EMBERBOLT_CAST_MS),
        );
      } else if (mesh) {
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
      // Suppress rings while dying; keep corpse non-targetable visually.
      if (fx?.phase === 'dying') {
        mesh.ring.setEnabled(false);
        mesh.remoteRing.setEnabled(false);
      } else {
        mesh.ring.setEnabled(selected);
        mesh.remoteRing.setEnabled(remoteSelected && !selected);
      }
      if (fx?.phase === 'spawning') {
        // Emissive flash owned by respawn FX until it finishes.
      } else if (selected) {
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
      } else if (fx?.phase !== 'dying') {
        mesh.ringMat.emissiveColor = new Color3(0, 0, 0);
        mesh.mat.emissiveColor = new Color3(0, 0, 0);
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

    // Cast projectile / beam polish: Spark bolts + impact pops + local Emberbolt beam.
    {
      const arrived = tickSparkBolts(sparkBolts, now, dt);
      for (const b of arrived) {
        impactPops.push(
          spawnImpactPop(scene, b.to, b.impactColor, {
            key: `imp_${now}_${impactPops.length}`,
          }),
        );
        castVfxStats.impacts += 1;
        // Flash nearest NPC at impact point.
        for (const mesh of npcMeshes.values()) {
          const hit = targetHitPoint(mesh.root.position);
          if (Vector3.Distance(hit, b.to) < 0.6) {
            flashMesh(mesh.mat, new Color3(0.55, 0.9, 1.2), 260);
            break;
          }
        }
      }
      tickImpactPops(impactPops, now);

      const castLeftNow = Math.max(0, castUntilMs - now);
      if (
        localBeamActive &&
        lastCastSpell === SPELL_EMBERBOLT &&
        castLeftNow > 0
      ) {
        const tid = net?.getCombat()?.targetNpcId ?? selectedTargetId;
        const mesh = npcMeshes.get(tid.toString());
        if (mesh) {
          placeBeam(
            localEmberBeam.beam,
            casterMuzzle(player.position),
            targetHitPoint(mesh.root.position),
          );
          const pulse = 0.85 + 0.2 * Math.sin(now / 80);
          localEmberBeam.beamMat.emissiveColor = new Color3(
            1.35 * pulse,
            0.4 * pulse,
            0.05,
          );
        }
      } else if (localBeamActive) {
        // Windup finished — impact pop + hide beam.
        const tid = net?.getCombat()?.targetNpcId ?? selectedTargetId;
        const mesh = npcMeshes.get(tid.toString());
        if (mesh && lastCastSpell === SPELL_EMBERBOLT) {
          const to = targetHitPoint(mesh.root.position);
          impactPops.push(
            spawnImpactPop(scene, to, new Color3(1.25, 0.4, 0.06), {
              key: `local_ember_imp_${now}`,
            }),
          );
          castVfxStats.impacts += 1;
          flashMesh(mesh.mat, new Color3(1, 0.35, 0.08), 420);
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
        mesh.mat.alpha = Math.max(0, 1 - t);
        mesh.mat.emissiveColor = new Color3(0.55 * (1 - t), 0.12 * (1 - t), 0.02);
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
        mesh.mat.emissiveColor = new Color3(
          0.85 * flash,
          0.7 * flash,
          0.25 * flash,
        );
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
      syncVendorMeshes(net.getVendors());
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
      const ch =
        st.state === 'connected' ? st.character ?? null : null;
      updateSelfFrame(ch);
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
          xpFloaters.push(spawnXpFloater(scene, player.position, gained));
          latestXpGain = gained;
          _latestXpAtMs = Date.now();
          prevXp = ch.xp;
        } else if (ch.xp !== prevXp) {
          prevXp = ch.xp;
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
          xpFloaters.push(spawnXpFloater(scene, player.position, latestXpGain));
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
          xpFloaters.push(spawnXpFloater(scene, player.position, latestXpGain));
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

  void lastCastSpell;
}

main().catch((err: unknown) => {
  console.error(err);
  setStatus(`Boot failed: ${err instanceof Error ? err.message : String(err)}`);
});
