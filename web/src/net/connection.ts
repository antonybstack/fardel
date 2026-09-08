/**
 * SpacetimeDB connection for the Babylon client
 * (Connect + Move + Combat + Persist + AOI).
 *
 * Subscriptions follow ADR 0001: Moore neighborhood filters on hot tables
 * (player_pose, crowd_proxy); cold/small tables (character, combat, npc,
 * party_member, party_invite, chat_message, party_chat_message, whisper_message, trade_offer, yard_vendor) wholesale; always-relevant party identity poses.
 * Character is Public + wholesale — party frames read mate Hp/MaxHp from the cache (no extra always-relevant Character SQL needed).
 */

import { DbConnection, type EventContext, type SubscriptionHandle } from '../module_bindings';
import type { Identity, Timestamp } from 'spacetimedb';

export const SPELL_SPARK = 1;
export const SPELL_EMBERBOLT = 2;
export const GCD_MS = 1200;
export const EMBERBOLT_CAST_MS = 1500;
/** Match shared Combat.CastPushbackMs — windup delay on hit. */
export const CAST_PUSHBACK_MS = 500;
/** Match Combat.CastPushbackHardAfter — pushbacks before hard interrupt. */
export const CAST_PUSHBACK_HARD_AFTER = 1;
/** Match Combat.CastHardInterruptRemainMs. */
export const CAST_HARD_INTERRUPT_REMAIN_MS = 400;
/** Match Combat.CastSilenceMs — post hard-interrupt Cast lockout. */
export const CAST_SILENCE_MS = 1500;
/** Match Combat.CastRangeMeters — max XZ distance to target for Cast. */
export const CAST_RANGE_METERS = 8;
/** Match Combat.KickManaCost / KickRangeMeters. */
export const KICK_MANA_COST = 10;
export const KICK_RANGE_METERS = 8;
/** Match Combat.StunManaCost / StunRangeMeters / StunDurationMs. */
export const STUN_MANA_COST = 15;
export const STUN_RANGE_METERS = 5;
export const STUN_DURATION_MS = 1500;
export const NPC_KIND_DUMMY = 1;
/** Match shared Combat mana costs / pool. */
export const SPARK_MANA_COST = 5;
export const EMBERBOLT_MANA_COST = 20;
export const PLAYER_MAX_MANA = 100;
export const REST_MANA_RESTORE = 40;

/** Match shared/Fardel.Shared Movement.ChunkSizeMeters / Aoi constants. */
export const CHUNK_SIZE_METERS = 32;
export const CROWD_NEAR_COUNT = 8;
export const CROWD_FAR_COUNT = 32;

/** localStorage key for SpacetimeDB auth token (Persist slice). */
export const AUTH_TOKEN_KEY = 'fardel.spacetime.token';

export type Pose = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  chunkX: number;
  chunkZ: number;
  interestChunkX: number;
  interestChunkZ: number;
};

/** Other identity's pose in the subscribed neighborhood (shared-yard). */
export type RemotePose = Pose & {
  identityHex: string;
  /** True when this remote shares the local player's party (always-relevant). */
  party?: boolean;
};

export type NpcView = {
  npcId: bigint;
  kind: number;
  x: number;
  y: number;
  z: number;
  hp: number;
  maxHp: number;
};

export type CrowdProxyView = {
  proxyId: bigint;
  x: number;
  y: number;
  z: number;
  chunkX: number;
  chunkZ: number;
  far: boolean;
};

export type AoiView = {
  interestChunkX: number;
  interestChunkZ: number;
  poseChunkX: number;
  poseChunkZ: number;
  proxyCount: number;
  nearCount: number;
  farCount: number;
  neighborhoodSql: boolean;
};

export type CombatView = {
  targetNpcId: bigint;
  /** Micros since Unix epoch when GCD is ready (server Timestamp). */
  gcdReadyAtMicros: bigint;
  /** Non-zero while a windup cast is in progress (e.g. Emberbolt). */
  castingSpellId: number;
  castEndsAtMicros: bigint;
  /** Pushbacks on current windup (server CastPushbackCount). */
  castPushbackCount: number;
  /** Micros since Unix epoch — Cast rejects while now < this (hard-interrupt silence). */
  castLockedUntilMicros: bigint;
  /** Micros since Unix epoch — Move/Cast reject while now < this (Stun/Bash; distinct from silence). */
  stunnedUntilMicros: bigint;
  /** Last spell that actually fired (instant or resolve) — remotes flash on change. */
  lastSpellId: number;
  lastCastAtMicros: bigint;
};

/** Other identity's combat row (shared-yard target rings + cast telegraphs). */
export type RemoteCombat = CombatView & {
  identityHex: string;
};

export type CharacterView = {
  xp: number;
  level: number;
  knowsSpark: boolean;
  knowsEmberbolt: boolean;
  staffEquipped: boolean;
  robesEquipped: boolean;
  hasEmberShard: boolean;
  hasYardTonic: boolean;
  tonicExpiresAtMicros: bigint;
  hasYardBandage: boolean;
  bandageReadyAtMicros: bigint;
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  lastDamagedAtMicros: bigint;
  restReadyAtMicros: bigint;
  lastManaTickAtMicros: bigint;
};

export type PartyMemberView = {
  identityHex: string;
  partyId: string;
  isLeader: boolean;
};

export type PartyView = {
  partyId: string | null;
  size: number;
  isLeader: boolean;
  members: PartyMemberView[];
  pendingInviteFrom: string | null;
};

export type TradeView = {
  /** Hex of who offered a pending trade to local player (inbound). */
  pendingFrom: string | null;
  offeredHasEmberShard: boolean;
  offeredXp: number;
  /** Hex of outbound offer recipient, if any. */
  pendingTo: string | null;
};

export type VendorView = {
  vendorId: bigint;
  x: number;
  y: number;
  z: number;
  label: string;
};


export type GroundItemView = {
  lootId: bigint;
  x: number;
  y: number;
  z: number;
  itemId: string;
};

export type ChatMessageView = {
  messageId: string;
  senderHex: string;
  text: string;
  sentAtMicros: bigint;
  /** Public say / party channel / private whisper. */
  channel: 'say' | 'party' | 'whisper';
  /** Whisper recipient hex (whisper channel only). */
  recipientHex?: string;
};

export type ConnectionStatus =
  | { state: 'connecting'; uri: string; database: string; restoredToken: boolean }
  | {
      state: 'connected';
      uri: string;
      database: string;
      identityHex: string;
      pose?: Pose;
      combat?: CombatView;
      targetNpc?: NpcView | null;
      character?: CharacterView;
      aoi?: AoiView;
      remotes?: RemotePose[];
      remoteCombats?: RemoteCombat[];
      party?: PartyView;
      castFeedback?: string;
      restoredToken: boolean;
    }
  | { state: 'disconnected'; uri: string; database: string }
  | { state: 'error'; uri: string; database: string; message: string };

export type StatusListener = (status: ConnectionStatus) => void;
export type PoseListener = (pose: Pose) => void;
export type RemotesListener = (remotes: RemotePose[]) => void;
export type RemoteCombatsListener = (combats: RemoteCombat[]) => void;
export type NpcsListener = (npcs: NpcView[]) => void;
export type ProxiesListener = (proxies: CrowdProxyView[]) => void;
export type CombatListener = (combat: CombatView | null) => void;
export type CharacterListener = (character: CharacterView | null) => void;
export type ChatListener = (messages: ChatMessageView[]) => void;
export type GroundListener = (items: GroundItemView[]) => void;

export type GameNet = {
  identityHex: string;
  identity: Identity;
  sendMove: (dx: number, dz: number, jump?: boolean) => void;
  ensureTrainingDummy: () => void;
  seedCrowdProxies: () => void;
  setTarget: (npcId: bigint) => void;
  cast: (spellId: number) => void;
  /** Cancel in-flight windup cast (refunds mana spent at Cast start). */
  cancelCast: () => Promise<void>;
  /** Opt-in dummy thorns poke — delays windup CastEndsAt if casting. */
  dummyStrike: () => Promise<void>;
  kick: (target: Identity) => Promise<void>;
  kickNearestCastingRemote: () => Promise<string | null>;
  stun: (target: Identity) => Promise<void>;
  stunNearestRemote: () => Promise<string | null>;
  unequipStaff: () => void;
  equipStaff: () => void;
  unequipRobes: () => void;
  equipRobes: () => void;
  createParty: () => void;
  inviteToParty: (invitee: Identity) => void;
  acceptPartyInvite: () => void;
  leaveParty: () => void;
  /** Public Say reducer — server-authoritative ChatMessage row; rejects on rate-limit. */
  say: (text: string) => Promise<void>;
  /** Party channel — PartyChatMessage (RLS mates only); rejects if not in party / rate-limit. */
  partySay: (text: string) => Promise<void>;
  /** Private whisper — WhisperMessage (RLS sender+recipient); rejects if target offline / rate-limit. */
  whisper: (recipient: Identity, text: string) => Promise<void>;
  seedLoot: () => void;
  pickup: () => Promise<void>;
  getGroundItems: () => GroundItemView[];
  offerTrade: (to: Identity, offeredHasEmberShard: boolean, offeredXp: number) => Promise<void>;
  acceptTrade: () => Promise<void>;
  cancelTrade: () => Promise<void>;
  /** Offer shard (if held) or small XP to nearest remote in range; returns partner hex or null. */
  offerTradeNearestRemote: () => Promise<string | null>;
  getTrade: () => TradeView;
  buyFromVendor: () => Promise<void>;
  sellToVendor: () => Promise<void>;
  buyYardTonic: () => Promise<void>;
  useYardTonic: () => Promise<void>;
  buyYardBandage: () => Promise<void>;
  useBandage: () => Promise<void>;
  rest: () => Promise<void>;
  getVendors: () => VendorView[];
  /** Nearest YardVendor within interact range, or null. */
  nearestVendor: (rangeMeters?: number) => VendorView | null;
  /** Resolve live PlayerPose identity by hex prefix (case-insensitive); null if ambiguous/missing. */
  findIdentityByHexPrefix: (prefix: string) => Identity | null;
  getRecentChat: () => ChatMessageView[];
  /** Invite nearest remote (create party if needed); auto-accept path is invitee-side. */
  inviteNearestRemote: () => string | null;
  getLocalPose: () => Pose | null;
  getRemotes: () => RemotePose[];
  getRemoteCombats: () => RemoteCombat[];
  getCombat: () => CombatView | null;
  getCharacter: () => CharacterView | null;
  /** Character row for any subscribed identity (wholesale Character; party mates included). */
  getCharacterFor: (identityHex: string) => CharacterView | null;
  getParty: () => PartyView | null;
  getNpcs: () => NpcView[];
  getProxies: () => CrowdProxyView[];
  getAoi: () => AoiView | null;
  /** Sorted target cycle list (alive NPCs, dummy first). */
  getTargetCycle: () => NpcView[];
  cycleTarget: () => bigint | null;
  disconnect: () => void;
};

const DEFAULT_URI_LOCAL = 'http://127.0.0.1:3000';
/** Pages / non-localhost default — Mac cloudflared → local SpacetimeDB. */
const DEFAULT_URI_REMOTE = 'https://dev-db.sparkify.dev';
const DEFAULT_DATABASE = 'fardel';
const LEAD_VITE_PORT = '5173';

function isLocalHost(): boolean {
  const h = window.location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
}

function isLeadVite(): boolean {
  return isLocalHost() && window.location.port === LEAD_VITE_PORT;
}

/**
 * URI resolution (first match wins):
 * 1. ?db= / ?database= — always, including agent seats
 * 2. VITE_FARDEL_URI — seat Vite (.env.local / process env); never used on Pages
 * 3. lead Vite :5173 on localhost → 127.0.0.1:3000
 * 4. production Pages host → https://dev-db.sparkify.dev
 *
 * Other localhost ports (agent 52xx) must use (1) or (2) — never default to prod.
 */
function resolveUri(): string {
  const params = new URLSearchParams(window.location.search);
  const override = params.get('db') ?? params.get('database');
  if (override) return override;
  const fromEnv = import.meta.env.VITE_FARDEL_URI;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (isLocalHost() && !isLeadVite()) {
    throw new Error(
      'Seat client requires ?db= or VITE_FARDEL_URI (refusing default :3000 / db fardel)',
    );
  }
  return isLocalHost() ? DEFAULT_URI_LOCAL : DEFAULT_URI_REMOTE;
}

function resolveDatabaseName(): string {
  const params = new URLSearchParams(window.location.search);
  const override = params.get('module') ?? params.get('name');
  if (override) return override;
  const fromEnv = import.meta.env.VITE_FARDEL_DB;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (isLocalHost() && !isLeadVite()) {
    throw new Error(
      'Seat client requires ?module= or VITE_FARDEL_DB (refusing default db fardel)',
    );
  }
  return DEFAULT_DATABASE;
}

export function loadAuthToken(): string | null {
  try {
    const t = localStorage.getItem(AUTH_TOKEN_KEY);
    return t && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

export function saveAuthToken(token: string): void {
  try {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
  } catch {
    /* private mode / quota — ignore */
  }
}

export function clearAuthToken(): void {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** Fill Moore neighborhood (center + 8) — matches Fardel.Shared.Aoi.FillMooreNeighborhood. */
export function fillMooreNeighborhood(
  cx: number,
  cz: number,
): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      out.push({ x: cx + dx, z: cz + dz });
    }
  }
  return out;
}

/**
 * Build ADR 0001 neighborhood SQL set (hot tables filtered by chunk) plus
 * always-relevant party wholesale + per-identity player_pose filters.
 */
export function buildNeighborhoodSqls(
  interestCx: number,
  interestCz: number,
  alwaysRelevantIdentityHexes: string[] = [],
  _localIdentityHex?: string | null,
): string[] {
  const sqls: string[] = [
    // Cold / small — never on AOI hot path for inventory, but OK wholesale for yard MVP
    'SELECT * FROM character',
    'SELECT * FROM player_combat',
    'SELECT * FROM npc',
    'SELECT * FROM party_member',
    'SELECT * FROM party_invite',
    'SELECT * FROM chat_message',
    'SELECT * FROM world_loot',
    'SELECT * FROM trade_offer',
    'SELECT * FROM yard_vendor',
  ];
  for (const { x: cx, z: cz } of fillMooreNeighborhood(interestCx, interestCz)) {
    sqls.push(`SELECT * FROM crowd_proxy WHERE chunk_x = ${cx} AND chunk_z = ${cz}`);
    sqls.push(`SELECT * FROM player_pose WHERE chunk_x = ${cx} AND chunk_z = ${cz}`);
  }
  const seen = new Set<string>();
  for (const hex of alwaysRelevantIdentityHexes) {
    const h = hex.toLowerCase();
    if (!h || seen.has(h)) continue;
    seen.add(h);
    sqls.push(`SELECT * FROM player_pose WHERE identity = 0x${hex}`);
  }
  return sqls;
}

type PoseRow = {
  identity: Identity;
  x: number;
  y: number;
  z: number;
  yaw: number;
  chunkX: number;
  chunkZ: number;
  interestChunkX: number;
  interestChunkZ: number;
};

type CombatRow = {
  identity: Identity;
  targetNpcId: bigint;
  gcdReadyAt: Timestamp;
  castingSpellId: number;
  castEndsAt: Timestamp;
  lastSpellId: number;
  lastCastAt: Timestamp;
  castPushbackCount?: number;
  castLockedUntil: Timestamp;
  stunnedUntilMicros?: bigint | number;
};

type NpcRow = {
  npcId: bigint;
  kind: number;
  x: number;
  y: number;
  z: number;
  hp: number;
  maxHp: number;
};

type CharacterRow = {
  identity: Identity;
  xp: number;
  knowsSpark: boolean;
  knowsEmberbolt: boolean;
  staffEquipped: boolean;
  robesEquipped: boolean;
  hasEmberShard: boolean;
  hasYardTonic: boolean;
  tonicExpiresAt: Timestamp;
  hasYardBandage: boolean;
  bandageReadyAt: Timestamp;
  hp: number;
  maxHp: number;
  level: number;
  lastDamagedAt: Timestamp;
  restReadyAt: Timestamp;
  mana: number;
  maxMana: number;
  lastManaTickAt: Timestamp;
};

type CrowdProxyRow = {
  proxyId: bigint;
  x: number;
  y: number;
  z: number;
  chunkX: number;
  chunkZ: number;
  far: boolean;
};

type PartyMemberRow = {
  identity: Identity;
  partyId: bigint;
  isLeader: boolean;
};

type PartyInviteRow = {
  invitee: Identity;
  partyId: bigint;
  inviter: Identity;
};

type ChatMessageRow = {
  messageId: bigint;
  sender: Identity;
  text: string;
  sentAt: Timestamp;
};

type PartyChatMessageRow = {
  messageId: bigint;
  partyId: bigint;
  sender: Identity;
  text: string;
  sentAt: Timestamp;
};

type WhisperMessageRow = {
  messageId: bigint;
  sender: Identity;
  recipient: Identity;
  text: string;
  sentAt: Timestamp;
};

type GroundItemRow = {
  lootId: bigint;
  x: number;
  y: number;
  z: number;
  itemId: string;
};

function poseView(row: PoseRow): Pose {
  return {
    x: row.x,
    y: row.y,
    z: row.z,
    yaw: row.yaw,
    chunkX: row.chunkX,
    chunkZ: row.chunkZ,
    interestChunkX: row.interestChunkX,
    interestChunkZ: row.interestChunkZ,
  };
}

function npcView(row: NpcRow): NpcView {
  return {
    npcId: row.npcId,
    kind: row.kind,
    x: row.x,
    y: row.y,
    z: row.z,
    hp: row.hp,
    maxHp: row.maxHp,
  };
}

function proxyView(row: CrowdProxyRow): CrowdProxyView {
  return {
    proxyId: asBigInt(row.proxyId),
    x: row.x,
    y: row.y,
    z: row.z,
    chunkX: row.chunkX,
    chunkZ: row.chunkZ,
    far: row.far,
  };
}

function combatView(row: CombatRow): CombatView {
  return {
    targetNpcId: row.targetNpcId,
    gcdReadyAtMicros: row.gcdReadyAt.microsSinceUnixEpoch,
    castingSpellId: row.castingSpellId,
    castEndsAtMicros: row.castEndsAt.microsSinceUnixEpoch,
    castPushbackCount: row.castPushbackCount ?? 0,
    castLockedUntilMicros: row.castLockedUntil?.microsSinceUnixEpoch ?? 0n,
    stunnedUntilMicros: BigInt(row.stunnedUntilMicros ?? 0),
    lastSpellId: row.lastSpellId,
    lastCastAtMicros: row.lastCastAt.microsSinceUnixEpoch,
  };
}

function characterView(row: CharacterRow): CharacterView {
  return {
    xp: row.xp,
    level: row.level ?? 1,
    knowsSpark: row.knowsSpark,
    knowsEmberbolt: row.knowsEmberbolt,
    staffEquipped: row.staffEquipped,
    robesEquipped: row.robesEquipped,
    hasEmberShard: !!row.hasEmberShard,
    hasYardTonic: !!row.hasYardTonic,
    tonicExpiresAtMicros: row.tonicExpiresAt.microsSinceUnixEpoch,
    hasYardBandage: !!row.hasYardBandage,
    bandageReadyAtMicros: row.bandageReadyAt?.microsSinceUnixEpoch ?? 0n,
    hp: row.hp ?? 0,
    maxHp: row.maxHp ?? 0,
    mana: row.mana ?? 0,
    maxMana: row.maxMana ?? 0,
    lastDamagedAtMicros: row.lastDamagedAt?.microsSinceUnixEpoch ?? 0n,
    restReadyAtMicros: row.restReadyAt?.microsSinceUnixEpoch ?? 0n,
    lastManaTickAtMicros: row.lastManaTickAt?.microsSinceUnixEpoch ?? 0n,
  };
}

function asBigInt(v: bigint | number | string): bigint {
  if (typeof v === 'bigint') return v;
  return BigInt(v);
}

/**
 * Connect, subscribe to Moore neighborhood (ADR 0001), seed crowd proxies,
 * ensure training dummy, return net handle.
 * Reuses localStorage auth token when present so refresh restores identity + Character.
 */

function chatView(row: ChatMessageRow): ChatMessageView {
  return {
    messageId: `s:${row.messageId.toString()}`,
    senderHex: row.sender.toHexString(),
    text: row.text,
    sentAtMicros: row.sentAt.microsSinceUnixEpoch,
    channel: 'say',
  };
}

function partyChatView(row: PartyChatMessageRow): ChatMessageView {
  return {
    messageId: `p:${row.messageId.toString()}`,
    senderHex: row.sender.toHexString(),
    text: row.text,
    sentAtMicros: row.sentAt.microsSinceUnixEpoch,
    channel: 'party',
  };
}

function whisperChatView(row: WhisperMessageRow): ChatMessageView {
  return {
    messageId: `w:${row.messageId.toString()}`,
    senderHex: row.sender.toHexString(),
    text: row.text,
    sentAtMicros: row.sentAt.microsSinceUnixEpoch,
    channel: 'whisper',
    recipientHex: row.recipient.toHexString(),
  };
}

export async function connectToSpacetime(
  onStatus: StatusListener,
  onLocalPose?: PoseListener,
  onNpcs?: NpcsListener,
  onCombat?: CombatListener,
  onCharacter?: CharacterListener,
  onProxies?: ProxiesListener,
  onRemotes?: RemotesListener,
  onRemoteCombats?: RemoteCombatsListener,
  onChat?: ChatListener,
  onGround?: GroundListener,
): Promise<GameNet | null> {
  const uri = resolveUri();
  const database = resolveDatabaseName();
  const savedToken = loadAuthToken();
  const restoredToken = savedToken != null;
  onStatus({ state: 'connecting', uri, database, restoredToken });

  const wsUri = uri.replace(/^http/, 'ws');

  return new Promise((resolve) => {
    let settled = false;
    let localIdentity: Identity | null = null;
    let latestPose: Pose | null = null;
    let latestCombat: CombatView | null = null;
        let latestCharacter: CharacterView | null = null;
    /** identityHex → CharacterView (wholesale Character; party frames read mates here). */
    const characterMap = new Map<string, CharacterView>();
    let castFeedback = '';
    const npcMap = new Map<string, NpcView>();
    const proxyMap = new Map<string, CrowdProxyView>();
    const remotePoseMap = new Map<string, RemotePose>();
    const remoteCombatMap = new Map<string, RemoteCombat>();
    /** identityHex → PartyMemberView for wholesale party_member rows. */
    const partyMemberMap = new Map<string, PartyMemberView>();
    /** messageId → ChatMessageView (wholesale chat_message). */
    const chatMessageMap = new Map<string, ChatMessageView>();
    const groundMap = new Map<string, GroundItemView>();
    let pendingInviteFrom: string | null = null;
    let pendingTradeFrom: string | null = null;
    let pendingTradeShard = false;
    let pendingTradeXp = 0;
    let pendingTradeTo: string | null = null;
    /** Hex set currently included as always-relevant pose filters in the active sub. */
    let subscribedAlwaysHexes = new Set<string>();
    let subHandle: SubscriptionHandle | null = null;
    let subscribedInterestX = 0;
    let subscribedInterestZ = 0;
    let resubInFlight = false;
    let syncingCaches = false;
    let neighborhoodSql = true;

    const finishError = (message: string) => {
      if (settled) return;
      settled = true;
      onStatus({ state: 'error', uri, database, message });
      resolve(null);
    };

    const listNpcs = (): NpcView[] => Array.from(npcMap.values());
    const listProxies = (): CrowdProxyView[] => Array.from(proxyMap.values());
    const listRemotes = (): RemotePose[] => Array.from(remotePoseMap.values());
    const listRemoteCombats = (): RemoteCombat[] => Array.from(remoteCombatMap.values());
    const listChat = (): ChatMessageView[] => {
      const rows = Array.from(chatMessageMap.values());
      // Prefixed ids (s:/p:/w:) are not raw BigInts — sort by server SentAt.
      rows.sort((a, b) => {
        const am = a.sentAtMicros;
        const bm = b.sentAtMicros;
        return am < bm ? -1 : am > bm ? 1 : 0;
      });
      return rows;
    };
    const emitChat = () => {
      onChat?.(listChat());
    };
    const listGround = (): GroundItemView[] => Array.from(groundMap.values());
    const emitGround = () => {
      onGround?.(listGround());
    };
    const upsertGround = (row: GroundItemRow) => {
      const id = asBigInt(row.lootId).toString();
      groundMap.set(id, {
        lootId: asBigInt(row.lootId),
        x: row.x,
        y: row.y,
        z: row.z,
        itemId: row.itemId,
      });
      if (!syncingCaches) emitGround();
    };
    const removeGround = (row: GroundItemRow) => {
      groundMap.delete(asBigInt(row.lootId).toString());
      if (!syncingCaches) emitGround();
    };

    const localPartyId = (): string | null => {
      if (!localIdentity) return null;
      const self = partyMemberMap.get(localIdentity.toHexString());
      return self?.partyId ?? null;
    };

    const buildPartyView = (): PartyView | null => {
      if (!localIdentity) return null;
      const selfHex = localIdentity.toHexString();
      const self = partyMemberMap.get(selfHex);
      const pid = self?.partyId ?? null;
      const members =
        pid == null
          ? []
          : Array.from(partyMemberMap.values()).filter((m) => m.partyId === pid);
      return {
        partyId: pid,
        size: members.length,
        isLeader: self?.isLeader ?? false,
        members,
        pendingInviteFrom,
      };
    };

    const partyAlwaysRelevantHexes = (): string[] => {
      if (!localIdentity) return [];
      const selfHex = localIdentity.toHexString();
      const out = new Set<string>([selfHex]);
      const pid = localPartyId();
      if (pid != null) {
        for (const m of partyMemberMap.values()) {
          if (m.partyId === pid) out.add(m.identityHex);
        }
      }
      return Array.from(out);
    };

    const markRemotePartyFlags = () => {
      const pid = localPartyId();
      for (const [hex, remote] of remotePoseMap) {
        const inParty =
          pid != null && partyMemberMap.get(hex)?.partyId === pid;
        if (!!remote.party !== inParty) {
          remotePoseMap.set(hex, { ...remote, party: inParty });
        } else if (remote.party !== inParty) {
          remote.party = inParty;
        }
      }
    };

    const findNpc = (id: bigint): NpcView | null => {
      if (id === 0n) return null;
      return npcMap.get(id.toString()) ?? null;
    };

    const buildAoi = (): AoiView | null => {
      if (!latestPose) return null;
      let near = 0;
      let far = 0;
      for (const p of proxyMap.values()) {
        if (p.far) far += 1;
        else near += 1;
      }
      return {
        interestChunkX: latestPose.interestChunkX,
        interestChunkZ: latestPose.interestChunkZ,
        poseChunkX: latestPose.chunkX,
        poseChunkZ: latestPose.chunkZ,
        proxyCount: proxyMap.size,
        nearCount: near,
        farCount: far,
        neighborhoodSql,
      };
    };

    const targetCycle = (): NpcView[] => {
      const alive = listNpcs().filter((n) => n.hp > 0);
      alive.sort((a, b) => {
        if (a.kind === NPC_KIND_DUMMY && b.kind !== NPC_KIND_DUMMY) return -1;
        if (b.kind === NPC_KIND_DUMMY && a.kind !== NPC_KIND_DUMMY) return 1;
        return a.npcId < b.npcId ? -1 : a.npcId > b.npcId ? 1 : 0;
      });
      return alive;
    };

    const emitStatus = (identityHex: string) => {
      markRemotePartyFlags();
      onStatus({
        state: 'connected',
        uri,
        database,
        identityHex,
        pose: latestPose ?? undefined,
        combat: latestCombat ?? undefined,
        targetNpc: latestCombat
          ? findNpc(latestCombat.targetNpcId)
          : null,
        character: latestCharacter ?? undefined,
        aoi: buildAoi() ?? undefined,
        remotes: listRemotes(),
        remoteCombats: listRemoteCombats(),
        party: buildPartyView() ?? undefined,
        castFeedback: castFeedback || undefined,
        restoredToken,
      });
    };

    const emitNpcs = () => {
      onNpcs?.(listNpcs());
    };

    const emitProxies = () => {
      onProxies?.(listProxies());
    };

    try {
      let builder = DbConnection.builder()
        .withUri(wsUri)
        .withDatabaseName(database);

      if (savedToken) {
        builder = builder.withToken(savedToken);
      }

      builder
        .onConnect((conn, identity, token) => {
          localIdentity = identity;
          const identityHex = identity.toHexString();
          if (token) {
            saveAuthToken(token);
          }

          const emitPose = (row: PoseRow) => {
            if (!localIdentity) return;
            if (!row.identity.isEqual(localIdentity)) {
              const hex = row.identity.toHexString();
              const pid = localPartyId();
              const inParty =
                pid != null && partyMemberMap.get(hex)?.partyId === pid;
              remotePoseMap.set(hex, {
                ...poseView(row),
                identityHex: hex,
                party: inParty,
              });
              onRemotes?.(listRemotes());
              emitStatus(identityHex);
              return;
            }
            latestPose = poseView(row);
            onLocalPose?.(latestPose);
            // Resubscribe when hysteresis-stable interest center moves.
            if (
              latestPose.interestChunkX !== subscribedInterestX ||
              latestPose.interestChunkZ !== subscribedInterestZ
            ) {
              scheduleResubscribe(
                identityHex,
                latestPose.interestChunkX,
                latestPose.interestChunkZ,
              );
            }
            emitStatus(identityHex);
          };

          const removePose = (row: PoseRow) => {
            if (!localIdentity) return;
            if (row.identity.isEqual(localIdentity)) return;
            const hex = row.identity.toHexString();
            if (remotePoseMap.delete(hex)) {
              onRemotes?.(listRemotes());
              emitStatus(identityHex);
            }
          };

          const emitCombatRow = (row: CombatRow) => {
            if (!localIdentity) return;
            const view = combatView(row);
            if (row.identity.isEqual(localIdentity)) {
              latestCombat = view;
              onCombat?.(latestCombat);
            } else {
              const hex = row.identity.toHexString();
              remoteCombatMap.set(hex, { ...view, identityHex: hex });
              onRemoteCombats?.(listRemoteCombats());
            }
            emitStatus(identityHex);
          };

          const removeCombatRow = (row: CombatRow) => {
            if (!localIdentity) return;
            if (row.identity.isEqual(localIdentity)) {
              latestCombat = null;
              onCombat?.(null);
            } else {
              const hex = row.identity.toHexString();
              if (remoteCombatMap.delete(hex)) {
                onRemoteCombats?.(listRemoteCombats());
              }
            }
            emitStatus(identityHex);
          };

          const emitCharacterRow = (row: CharacterRow) => {
            const hex = row.identity.toHexString();
            const view = characterView(row);
            characterMap.set(hex, view);
            if (localIdentity && row.identity.isEqual(localIdentity)) {
              latestCharacter = view;
              onCharacter?.(latestCharacter);
            }
            emitStatus(identityHex);
          };

          const upsertNpc = (row: NpcRow) => {
            const view = npcView(row);
            npcMap.set(view.npcId.toString(), view);
            emitNpcs();
            emitStatus(identityHex);
          };

          const removeNpc = (row: NpcRow) => {
            npcMap.delete(asBigInt(row.npcId).toString());
            emitNpcs();
            emitStatus(identityHex);
          };

          const upsertProxy = (row: CrowdProxyRow) => {
            const view = proxyView(row);
            proxyMap.set(view.proxyId.toString(), view);
            emitProxies();
            emitStatus(identityHex);
          };

          const removeProxy = (row: CrowdProxyRow) => {
            proxyMap.delete(asBigInt(row.proxyId).toString());
            emitProxies();
            emitStatus(identityHex);
          };

          const syncCachesFromDb = () => {
            syncingCaches = true;
            try {
            partyMemberMap.clear();
            for (const row of conn.db.partyMember.iter()) {
              upsertPartyMember(row as PartyMemberRow);
            }
            pendingInviteFrom = null;
            pendingTradeFrom = null;
            pendingTradeShard = false;
            pendingTradeXp = 0;
            pendingTradeTo = null;
            for (const row of conn.db.partyInvite.iter()) {
              upsertPartyInvite(row as PartyInviteRow);
            }
            if ((conn.db as any).tradeOffer) {
              for (const row of (conn.db as any).tradeOffer.iter()) {
                const r = row as {
                  to: Identity;
                  from: Identity;
                  offeredHasEmberShard: boolean;
                  offeredXp: number;
                };
                if (localIdentity && r.to.isEqual(localIdentity)) {
                  pendingTradeFrom = r.from.toHexString();
                  pendingTradeShard = r.offeredHasEmberShard;
                  pendingTradeXp = r.offeredXp;
                }
                if (localIdentity && r.from.isEqual(localIdentity)) {
                  pendingTradeTo = r.to.toHexString();
                }
              }
            }
            remotePoseMap.clear();
            for (const row of conn.db.playerPose.iter()) {
              emitPose(row as PoseRow);
            }
            onRemotes?.(listRemotes());
            remoteCombatMap.clear();
            for (const row of conn.db.playerCombat.iter()) {
              emitCombatRow(row as CombatRow);
            }
            onRemoteCombats?.(listRemoteCombats());
            characterMap.clear();
            latestCharacter = null;
            for (const row of conn.db.character.iter()) {
              emitCharacterRow(row as CharacterRow);
            }
            npcMap.clear();
            for (const row of conn.db.npc.iter()) {
              upsertNpc(row as NpcRow);
            }
            proxyMap.clear();
            for (const row of conn.db.crowdProxy.iter()) {
              upsertProxy(row as CrowdProxyRow);
            }
            chatMessageMap.clear();
            for (const row of conn.db.chatMessage.iter()) {
              const view = chatView(row as ChatMessageRow);
              chatMessageMap.set(view.messageId, view);
            }
            if (conn.db.partyChatMessage) {
              for (const row of conn.db.partyChatMessage.iter()) {
                const view = partyChatView(row as PartyChatMessageRow);
                chatMessageMap.set(view.messageId, view);
              }
            }
            if (conn.db.whisperMessage) {
              for (const row of conn.db.whisperMessage.iter()) {
                const view = whisperChatView(row as WhisperMessageRow);
                chatMessageMap.set(view.messageId, view);
              }
            }
            emitChat();
            groundMap.clear();
            const wl = (conn.db as any).worldLoot;
            if (wl) {
              for (const row of wl.iter()) {
                upsertGround(row as GroundItemRow);
              }
            }
            emitGround();
            } finally {
              syncingCaches = false;
            }
          };

          // EnsureTrainingDummy resets HP to max — call once on first subscribe so
          // AOI / party resubscribes do not revive a mid-fight or dead dummy.
          let ensuredTrainingDummyOnce = false;

          const applySubscription = (
            ix: number,
            iz: number,
            afterApplied?: () => void,
          ) => {
            subscribedInterestX = ix;
            subscribedInterestZ = iz;
            const always = partyAlwaysRelevantHexes();
            subscribedAlwaysHexes = new Set(always.map((h) => h.toLowerCase()));
            const sqls = buildNeighborhoodSqls(
              ix,
              iz,
              always,
              localIdentity?.toHexString() ?? identityHex,
            );
            neighborhoodSql = true;
            subHandle = conn
              .subscriptionBuilder()
              .onApplied(() => {
                syncCachesFromDb();
                if (!ensuredTrainingDummyOnce) {
                  ensuredTrainingDummyOnce = true;
                  try {
                    void conn.reducers.ensureTrainingDummy({});
                  } catch {
                    /* ignore */
                  }
                }
                try {
                  void conn.reducers.seedCrowdProxies({});
                } catch {
                  /* ignore */
                }
                if (!latestPose) {
                  emitStatus(identityHex);
                }
                afterApplied?.();
              })
              .onError((ctx) => {
                const err = (ctx as { event?: unknown }).event;
                finishError(
                  err instanceof Error
                    ? err.message
                    : String(err ?? 'subscribe error'),
                );
              })
              .subscribe(sqls);
          };

          const alwaysRelevantChanged = (): boolean => {
            const next = partyAlwaysRelevantHexes().map((h) => h.toLowerCase());
            if (next.length !== subscribedAlwaysHexes.size) return true;
            for (const h of next) {
              if (!subscribedAlwaysHexes.has(h)) return true;
            }
            return false;
          };

          const scheduleResubscribe = (
            hex: string,
            ix: number,
            iz: number,
            force = false,
          ) => {
            if (resubInFlight) return;
            const interestMoved =
              ix !== subscribedInterestX || iz !== subscribedInterestZ;
            if (!force && !interestMoved && !alwaysRelevantChanged()) return;
            resubInFlight = true;
            const prev = subHandle;
            subHandle = null;
            try {
              prev?.unsubscribe();
            } catch {
              /* ignore */
            }
            // Clear hot caches that leave the set; cold tables stay.
            proxyMap.clear();
            emitProxies();
            remotePoseMap.clear();
            onRemotes?.(listRemotes());
            applySubscription(ix, iz, () => {
              resubInFlight = false;
              emitStatus(hex);
            });
          };

          const maybeResubForParty = () => {
            if (syncingCaches || resubInFlight || !localIdentity) return;
            const ix = latestPose?.interestChunkX ?? subscribedInterestX;
            const iz = latestPose?.interestChunkZ ?? subscribedInterestZ;
            scheduleResubscribe(localIdentity.toHexString(), ix, iz, false);
          };

          const upsertPartyMember = (row: PartyMemberRow) => {
            const hex = row.identity.toHexString();
            const wasSelfInParty =
              !!localIdentity &&
              partyMemberMap.has(localIdentity.toHexString());
            partyMemberMap.set(hex, {
              identityHex: hex,
              partyId: row.partyId.toString(),
              isLeader: row.isLeader,
            });
            markRemotePartyFlags();
            onRemotes?.(listRemotes());
            emitStatus(identityHex);
            const selfJoined =
              !!localIdentity &&
              hex === localIdentity.toHexString() &&
              !wasSelfInParty;
            if (selfJoined && !syncingCaches && localIdentity) {
              // Force AOI rebuild so party_chat_message join sub is live after CreateParty.
              const ix = latestPose?.interestChunkX ?? subscribedInterestX;
              const iz = latestPose?.interestChunkZ ?? subscribedInterestZ;
              scheduleResubscribe(localIdentity.toHexString(), ix, iz, true);
            } else {
              maybeResubForParty();
            }
          };

          const removePartyMember = (row: PartyMemberRow) => {
            const hex = row.identity.toHexString();
            if (partyMemberMap.delete(hex)) {
              markRemotePartyFlags();
              onRemotes?.(listRemotes());
              emitStatus(identityHex);
              maybeResubForParty();
            }
          };

          const upsertPartyInvite = (row: PartyInviteRow) => {
            if (!localIdentity) return;
            if (row.invitee.isEqual(localIdentity)) {
              pendingInviteFrom = row.inviter.toHexString();
              emitStatus(identityHex);
            }
          };

          const removePartyInvite = (row: PartyInviteRow) => {
            if (!localIdentity) return;
            if (row.invitee.isEqual(localIdentity)) {
              pendingInviteFrom = null;
              emitStatus(identityHex);
            }
          };

          type TradeOfferRow = {
            to: Identity;
            from: Identity;
            offeredHasEmberShard: boolean;
            offeredXp: number;
          };

          const refreshTradeView = () => {
            pendingTradeFrom = null;
            pendingTradeShard = false;
            pendingTradeXp = 0;
            pendingTradeTo = null;
            if (!localIdentity) return;
            for (const row of conn.db.tradeOffer.iter()) {
              const r = row as TradeOfferRow;
              if (r.to.isEqual(localIdentity)) {
                pendingTradeFrom = r.from.toHexString();
                pendingTradeShard = r.offeredHasEmberShard;
                pendingTradeXp = r.offeredXp;
              }
              if (r.from.isEqual(localIdentity)) {
                pendingTradeTo = r.to.toHexString();
              }
            }
          };

          const upsertTradeOffer = (_row: TradeOfferRow) => {
            refreshTradeView();
            emitStatus(identityHex);
          };

          const removeTradeOffer = (_row: TradeOfferRow) => {
            refreshTradeView();
            emitStatus(identityHex);
          };

          conn.db.playerPose.onInsert((_ctx: EventContext, row) => {
            emitPose(row as PoseRow);
          });
          conn.db.playerPose.onUpdate((_ctx: EventContext, _old, row) => {
            emitPose(row as PoseRow);
          });
          conn.db.playerPose.onDelete((_ctx: EventContext, row) => {
            removePose(row as PoseRow);
          });

          conn.db.playerCombat.onInsert((_ctx: EventContext, row) => {
            emitCombatRow(row as CombatRow);
          });
          conn.db.playerCombat.onUpdate((_ctx: EventContext, _old, row) => {
            emitCombatRow(row as CombatRow);
          });
          conn.db.playerCombat.onDelete((_ctx: EventContext, row) => {
            removeCombatRow(row as CombatRow);
          });

          conn.db.character.onInsert((_ctx: EventContext, row) => {
            emitCharacterRow(row as CharacterRow);
          });
          conn.db.character.onUpdate((_ctx: EventContext, _old, row) => {
            emitCharacterRow(row as CharacterRow);
          });

          conn.db.npc.onInsert((_ctx: EventContext, row) => {
            upsertNpc(row as NpcRow);
          });
          conn.db.npc.onUpdate((_ctx: EventContext, _old, row) => {
            upsertNpc(row as NpcRow);
          });
          conn.db.npc.onDelete((_ctx: EventContext, row) => {
            removeNpc(row as NpcRow);
          });

          if ((conn.db as any).worldLoot) {
            const table = (conn.db as any).worldLoot;
            table.onInsert((_ctx: EventContext, row: unknown) => {
              upsertGround(row as GroundItemRow);
            });
            table.onUpdate((_ctx: EventContext, _old: unknown, row: unknown) => {
              upsertGround(row as GroundItemRow);
            });
            table.onDelete((_ctx: EventContext, row: unknown) => {
              removeGround(row as GroundItemRow);
            });
          }

          conn.db.crowdProxy.onInsert((_ctx: EventContext, row) => {
            upsertProxy(row as CrowdProxyRow);
          });
          conn.db.crowdProxy.onUpdate((_ctx: EventContext, _old, row) => {
            upsertProxy(row as CrowdProxyRow);
          });
          conn.db.crowdProxy.onDelete((_ctx: EventContext, row) => {
            removeProxy(row as CrowdProxyRow);
          });

          conn.db.partyMember.onInsert((_ctx: EventContext, row) => {
            upsertPartyMember(row as PartyMemberRow);
          });
          conn.db.partyMember.onUpdate((_ctx: EventContext, _old, row) => {
            upsertPartyMember(row as PartyMemberRow);
          });
          conn.db.partyMember.onDelete((_ctx: EventContext, row) => {
            removePartyMember(row as PartyMemberRow);
          });

          conn.db.partyInvite.onInsert((_ctx: EventContext, row) => {
            upsertPartyInvite(row as PartyInviteRow);
          });
          conn.db.partyInvite.onUpdate((_ctx: EventContext, _old, row) => {
            upsertPartyInvite(row as PartyInviteRow);
          });
          conn.db.partyInvite.onDelete((_ctx: EventContext, row) => {
            removePartyInvite(row as PartyInviteRow);
          });

          conn.db.tradeOffer.onInsert((_ctx: EventContext, row) => {
            upsertTradeOffer(row as TradeOfferRow);
          });
          conn.db.tradeOffer.onUpdate((_ctx: EventContext, _old, row) => {
            upsertTradeOffer(row as TradeOfferRow);
          });
          conn.db.tradeOffer.onDelete((_ctx: EventContext, row) => {
            removeTradeOffer(row as TradeOfferRow);
          });

          const upsertChat = (row: ChatMessageRow) => {
            const view = chatView(row);
            chatMessageMap.set(view.messageId, view);
            emitChat();
          };
          const removeChat = (row: ChatMessageRow) => {
            const id = chatView(row).messageId;
            if (chatMessageMap.delete(id)) {
              emitChat();
            }
          };

          conn.db.chatMessage.onInsert((_ctx: EventContext, row) => {
            upsertChat(row as ChatMessageRow);
          });
          conn.db.chatMessage.onUpdate((_ctx: EventContext, _old, row) => {
            upsertChat(row as ChatMessageRow);
          });
          conn.db.chatMessage.onDelete((_ctx: EventContext, row) => {
            removeChat(row as ChatMessageRow);
          });

          const upsertPartyChat = (row: PartyChatMessageRow) => {
            const view = partyChatView(row);
            chatMessageMap.set(view.messageId, view);
            emitChat();
          };
          const removePartyChat = (row: PartyChatMessageRow) => {
            const id = partyChatView(row).messageId;
            if (chatMessageMap.delete(id)) {
              emitChat();
            }
          };
          if (conn.db.partyChatMessage) {
            conn.db.partyChatMessage.onInsert((_ctx: EventContext, row) => {
              upsertPartyChat(row as PartyChatMessageRow);
            });
            conn.db.partyChatMessage.onUpdate((_ctx: EventContext, _old, row) => {
              upsertPartyChat(row as PartyChatMessageRow);
            });
            conn.db.partyChatMessage.onDelete((_ctx: EventContext, row) => {
              removePartyChat(row as PartyChatMessageRow);
            });
          }

          const upsertWhisperChat = (row: WhisperMessageRow) => {
            const view = whisperChatView(row);
            chatMessageMap.set(view.messageId, view);
            emitChat();
          };
          const removeWhisperChat = (row: WhisperMessageRow) => {
            const id = whisperChatView(row).messageId;
            if (chatMessageMap.delete(id)) {
              emitChat();
            }
          };
          if (conn.db.whisperMessage) {
            conn.db.whisperMessage.onInsert((_ctx: EventContext, row) => {
              upsertWhisperChat(row as WhisperMessageRow);
            });
            conn.db.whisperMessage.onUpdate((_ctx: EventContext, _old, row) => {
              upsertWhisperChat(row as WhisperMessageRow);
            });
            conn.db.whisperMessage.onDelete((_ctx: EventContext, row) => {
              removeWhisperChat(row as WhisperMessageRow);
            });
          }

          // Persistent chat subscriptions — not torn down on AOI/party resubscribe,
          // so PartySay / Whisper inserts are not lost in the unsub gap. RLS still applies.
          let chatSubStarted = false;
          const startPersistentChatSubs = () => {
            if (chatSubStarted) return;
            chatSubStarted = true;
            conn
              .subscriptionBuilder()
              .onApplied(() => {
                // Merge any RLS-visible chat rows into the strip cache.
                for (const row of conn.db.chatMessage.iter()) {
                  const view = chatView(row as ChatMessageRow);
                  chatMessageMap.set(view.messageId, view);
                }
                if (conn.db.partyChatMessage) {
                  for (const row of conn.db.partyChatMessage.iter()) {
                    const view = partyChatView(row as PartyChatMessageRow);
                    chatMessageMap.set(view.messageId, view);
                  }
                }
                if (conn.db.whisperMessage) {
                  for (const row of conn.db.whisperMessage.iter()) {
                    const view = whisperChatView(row as WhisperMessageRow);
                    chatMessageMap.set(view.messageId, view);
                  }
                }
                emitChat();
              })
              .onError(() => {
                /* neighborhood sub remains authoritative for gameplay */
              })
              .subscribe([
                'SELECT * FROM chat_message',
                'SELECT * FROM party_chat_message',
                'SELECT * FROM whisper_message',
              ]);
          };
          startPersistentChatSubs();

          // Spawn interest is (0,0) until pose arrives / hysteresis adopts.
          applySubscription(0, 0);

          if (!settled) {
            settled = true;
            emitStatus(identityHex);
            resolve({
              identityHex,
              identity,
              sendMove: (dx: number, dz: number, jump = false) => {
                if (
                  latestCombat &&
                  Number(latestCombat.stunnedUntilMicros / 1000n) > Date.now()
                ) {
                  castFeedback = 'stunned';
                  emitStatus(identityHex);
                  return;
                }
                void conn.reducers.move({ dx, dz, jump });
              },
              ensureTrainingDummy: () => {
                void conn.reducers.ensureTrainingDummy({});
              },
              seedCrowdProxies: () => {
                void conn.reducers.seedCrowdProxies({});
              },
              seedLoot: () => {
                try { void conn.reducers.seedLoot({}); } catch { /* ignore */ }
              },
              pickup: () => conn.reducers.pickup({}),
              getGroundItems: () => listGround(),
              offerTrade: (to, offeredHasEmberShard, offeredXp) =>
                conn.reducers.offerTrade({ to, offeredHasEmberShard, offeredXp }),
              acceptTrade: () => conn.reducers.acceptTrade({}),
              cancelTrade: () => conn.reducers.cancelTrade({}),
              offerTradeNearestRemote: async () => {
                const remotes = listRemotes();
                const local = latestPose;
                if (!local || remotes.length === 0) {
                  castFeedback = 'No remote to trade';
                  emitStatus(identityHex);
                  return null;
                }
                let best = remotes[0]!;
                let bestD = Number.POSITIVE_INFINITY;
                for (const r of remotes) {
                  const dx = r.x - local.x;
                  const dz = r.z - local.z;
                  const d = dx * dx + dz * dz;
                  if (d < bestD) {
                    bestD = d;
                    best = r;
                  }
                }
                let partner: Identity | null = null;
                for (const row of conn.db.playerPose.iter()) {
                  const hex = (row as PoseRow).identity.toHexString();
                  if (hex === best.identityHex) {
                    partner = (row as PoseRow).identity;
                    break;
                  }
                }
                if (!partner) {
                  castFeedback = 'Trade partner pose missing';
                  emitStatus(identityHex);
                  return null;
                }
                const ch = latestCharacter;
                const offerShard = !!ch?.hasEmberShard;
                const offerXp = offerShard ? 0 : 5;
                if (!offerShard && (ch?.xp ?? 0) < offerXp) {
                  castFeedback = 'Nothing to offer (need shard or XP)';
                  emitStatus(identityHex);
                  return null;
                }
                castFeedback = `Offering trade to ${best.identityHex.slice(0, 8)}…`;
                emitStatus(identityHex);
                await conn.reducers.offerTrade({
                  to: partner,
                  offeredHasEmberShard: offerShard,
                  offeredXp: offerXp,
                });
                return best.identityHex;
              },
              buyFromVendor: () => conn.reducers.buyFromVendor({}),
              sellToVendor: () => conn.reducers.sellToVendor({}),
              buyYardTonic: () => conn.reducers.buyYardTonic({}),
              useYardTonic: () => conn.reducers.useYardTonic({}),
              buyYardBandage: () => conn.reducers.buyYardBandage({}),
              useBandage: () => conn.reducers.useBandage({}),
              rest: () => conn.reducers.rest({}),
              getVendors: () => {
                const out: VendorView[] = [];
                const table = (conn.db as any).yardVendor;
                if (!table) return out;
                for (const row of table.iter()) {
                  out.push({
                    vendorId: BigInt(row.vendorId),
                    x: row.x,
                    y: row.y,
                    z: row.z,
                    label: String(row.label ?? 'Vendor'),
                  });
                }
                return out;
              },
              nearestVendor: (rangeMeters = 4.5) => {
                const pose = latestPose;
                if (!pose) return null;
                const r2 = rangeMeters * rangeMeters;
                let best: VendorView | null = null;
                let bestD = Number.POSITIVE_INFINITY;
                const vtable = (conn.db as any).yardVendor;
                if (!vtable) return null;
                for (const row of vtable.iter()) {
                  const dx = row.x - pose.x;
                  const dz = row.z - pose.z;
                  const d = dx * dx + dz * dz;
                  if (d <= r2 && d < bestD) {
                    bestD = d;
                    best = {
                      vendorId: BigInt(row.vendorId),
                      x: row.x,
                      y: row.y,
                      z: row.z,
                      label: String(row.label ?? 'Vendor'),
                    };
                  }
                }
                return best;
              },
              getTrade: () => ({
                pendingFrom: pendingTradeFrom,
                offeredHasEmberShard: pendingTradeShard,
                offeredXp: pendingTradeXp,
                pendingTo: pendingTradeTo,
              }),
              setTarget: (npcId: bigint) => {
                castFeedback = npcId === 0n ? 'Cleared target' : `Target ${npcId}`;
                void conn.reducers.setTarget({ npcId });
                emitStatus(identityHex);
              },
              cancelCast: () => conn.reducers.cancelCast({}),
              dummyStrike: () => conn.reducers.dummyStrike({}),
              kick: (target: Identity) => conn.reducers.kick({ target }),
              kickNearestCastingRemote: async () => {
                const local = latestPose;
                if (!local) return null;
                let bestHex: string | null = null;
                let bestDist = Number.POSITIVE_INFINITY;
                for (const rc of listRemoteCombats()) {
                  if (rc.castingSpellId === 0 || castRemainingMs(rc) <= 0) continue;
                  const remote = remotePoseMap.get(rc.identityHex);
                  if (!remote) continue;
                  const dist = Math.hypot(remote.x - local.x, remote.z - local.z);
                  if (dist > KICK_RANGE_METERS) continue;
                  if (dist < bestDist) { bestDist = dist; bestHex = rc.identityHex; }
                }
                if (!bestHex) { castFeedback = 'No casting remote in Kick range'; emitStatus(identityHex); return null; }
                let target: Identity | null = null;
                for (const row of conn.db.playerPose.iter()) {
                  const hex = (row as PoseRow).identity.toHexString();
                  if (hex === bestHex) { target = (row as PoseRow).identity; break; }
                }
                if (!target) { castFeedback = 'Kick target pose missing'; emitStatus(identityHex); return null; }
                castFeedback = `Kick → ${bestHex.slice(0, 8)}…`;
                emitStatus(identityHex);
                await conn.reducers.kick({ target });
                return bestHex;
              },
              stun: (target: Identity) => conn.reducers.stun({ target }),
              stunNearestRemote: async () => {
                const local = latestPose;
                if (!local) return null;
                let bestHex: string | null = null;
                let bestDist = Number.POSITIVE_INFINITY;
                for (const [hex, remote] of remotePoseMap) {
                  if (hex === identityHex) continue;
                  const dist = Math.hypot(remote.x - local.x, remote.z - local.z);
                  if (dist > STUN_RANGE_METERS) continue;
                  if (dist < bestDist) { bestDist = dist; bestHex = hex; }
                }
                if (!bestHex) { castFeedback = 'No remote in Stun range'; emitStatus(identityHex); return null; }
                let target: Identity | null = null;
                for (const row of conn.db.playerPose.iter()) {
                  const hex = (row as PoseRow).identity.toHexString();
                  if (hex === bestHex) { target = (row as PoseRow).identity; break; }
                }
                if (!target) { castFeedback = 'Stun target pose missing'; emitStatus(identityHex); return null; }
                castFeedback = `Stun → ${bestHex.slice(0, 8)}…`;
                emitStatus(identityHex);
                await conn.reducers.stun({ target });
                return bestHex;
              },
              cast: (spellId: number) => {
                const name =
                  spellId === SPELL_SPARK
                    ? 'Spark'
                    : spellId === SPELL_EMBERBOLT
                      ? 'Emberbolt'
                      : `Spell ${spellId}`;
                if (latestCharacter && !latestCharacter.staffEquipped) {
                  castFeedback = 'Staff required';
                  emitStatus(identityHex);
                  return;
                }
                const cost =
                  spellId === SPELL_SPARK
                    ? SPARK_MANA_COST
                    : spellId === SPELL_EMBERBOLT
                      ? EMBERBOLT_MANA_COST
                      : 0;
                if (latestCharacter && cost > 0 && latestCharacter.mana < cost) {
                  castFeedback = 'Insufficient mana';
                  emitStatus(identityHex);
                  return;
                }
                if (
                  latestCombat &&
                  Number(latestCombat.stunnedUntilMicros / 1000n) > Date.now()
                ) {
                  castFeedback = 'stunned';
                  emitStatus(identityHex);
                  return;
                }
                if (
                  latestCombat &&
                  Number(latestCombat.castLockedUntilMicros / 1000n) > Date.now()
                ) {
                  castFeedback = 'silenced';
                  emitStatus(identityHex);
                  return;
                }
                if (latestCombat && latestCombat.targetNpcId !== 0n && latestPose) {
                  const tgt = findNpc(latestCombat.targetNpcId);
                  if (tgt) {
                    const dx = latestPose.x - tgt.x;
                    const dz = latestPose.z - tgt.z;
                    if (dx * dx + dz * dz > CAST_RANGE_METERS * CAST_RANGE_METERS) {
                      castFeedback = 'out of range';
                      emitStatus(identityHex);
                      return;
                    }
                  }
                }
                castFeedback = `Casting ${name}…`;
                emitStatus(identityHex);
                void conn.reducers
                  .cast({ spellId })
                  .catch((err: unknown) => {
                    const msg = err instanceof Error ? err.message : String(err);
                    if (/out of range/i.test(msg)) {
                      castFeedback = 'out of range';
                      emitStatus(identityHex);
                    } else if (msg) {
                      castFeedback = msg.slice(0, 96);
                      emitStatus(identityHex);
                    }
                  });
              },
              unequipStaff: () => {
                castFeedback = 'Unequipping staff…';
                emitStatus(identityHex);
                void conn.reducers.unequipStaff({});
              },
              equipStaff: () => {
                castFeedback = 'Equipping staff…';
                emitStatus(identityHex);
                void conn.reducers.equipStaff({});
              },
              unequipRobes: () => {
                castFeedback = 'Unequipping robes…';
                emitStatus(identityHex);
                void conn.reducers.unequipRobes({});
              },
              equipRobes: () => {
                castFeedback = 'Equipping robes…';
                emitStatus(identityHex);
                void conn.reducers.equipRobes({});
              },
              createParty: () => {
                castFeedback = 'Creating party…';
                emitStatus(identityHex);
                void conn.reducers.createParty({});
              },
              inviteToParty: (invitee: Identity) => {
                castFeedback = `Inviting ${invitee.toHexString().slice(0, 8)}…`;
                emitStatus(identityHex);
                void conn.reducers.inviteToParty({ invitee });
              },
              acceptPartyInvite: () => {
                castFeedback = 'Accepting party invite…';
                emitStatus(identityHex);
                void conn.reducers.acceptPartyInvite({});
              },
              leaveParty: () => {
                castFeedback = 'Leaving party…';
                emitStatus(identityHex);
                void conn.reducers.leaveParty({});
              },
              say: (text: string) => {
                return conn.reducers.say({ text });
              },
              partySay: async (text: string) => {
                await conn.reducers.partySay({ text });
                // Self-echo: SpacetimeDB JS + AOI resubscribe can miss RLS
                // party_chat_message inserts for the sender; mates still get onInsert.
                // Dedupe if the row already arrived via subscription.
                const trimmed = text.trim();
                const already = Array.from(chatMessageMap.values()).some(
                  (m) =>
                    m.channel === 'party' &&
                    m.senderHex === identityHex &&
                    m.text === trimmed,
                );
                if (!already && localIdentity) {
                  const view: ChatMessageView = {
                    messageId: `p:local:${Date.now()}`,
                    senderHex: identityHex,
                    text: trimmed.slice(0, 120),
                    sentAtMicros: BigInt(Date.now()) * 1000n,
                    channel: 'party',
                  };
                  chatMessageMap.set(view.messageId, view);
                  emitChat();
                }
              },
              whisper: (recipient: Identity, text: string) => {
                return conn.reducers.whisper({ recipient, text });
              },
              findIdentityByHexPrefix: (prefix: string) => {
                const needle = prefix.trim().toLowerCase();
                if (!needle) return null;
                const hits: Identity[] = [];
                for (const row of conn.db.playerPose.iter()) {
                  const hex = (row as PoseRow).identity.toHexString().toLowerCase();
                  if (hex.startsWith(needle) || hex === needle) {
                    hits.push((row as PoseRow).identity);
                  }
                }
                if (hits.length === 1) return hits[0]!;
                return null;
              },
              getRecentChat: () => listChat(),
              inviteNearestRemote: () => {
                const remotes = listRemotes();
                const local = latestPose;
                if (!local || remotes.length === 0) {
                  castFeedback = 'No remote to invite';
                  emitStatus(identityHex);
                  return null;
                }
                let best = remotes[0]!;
                let bestD = Number.POSITIVE_INFINITY;
                for (const r of remotes) {
                  const dx = r.x - local.x;
                  const dz = r.z - local.z;
                  const d = dx * dx + dz * dz;
                  if (d < bestD) {
                    bestD = d;
                    best = r;
                  }
                }
                // Prefer Identity from live table row when available.
                let invitee: Identity | null = null;
                for (const row of conn.db.playerPose.iter()) {
                  const hex = (row as PoseRow).identity.toHexString();
                  if (hex === best.identityHex) {
                    invitee = (row as PoseRow).identity;
                    break;
                  }
                }
                if (!invitee) {
                  castFeedback = 'Invitee pose missing';
                  emitStatus(identityHex);
                  return null;
                }
                castFeedback = `Inviting nearest ${best.identityHex.slice(0, 8)}…`;
                emitStatus(identityHex);
                void conn.reducers.inviteToParty({ invitee });
                return best.identityHex;
              },
              getLocalPose: () => latestPose,
              getRemotes: () => listRemotes(),
              getRemoteCombats: () => listRemoteCombats(),
              getCombat: () => latestCombat,
              getCharacter: () => latestCharacter,
              getCharacterFor: (hex: string) => {
                const key = hex.toLowerCase();
                for (const [h, v] of characterMap) {
                  if (h.toLowerCase() === key) return v;
                }
                return null;
              },
              getParty: () => buildPartyView(),
              getNpcs: () => listNpcs(),
              getProxies: () => listProxies(),
              getAoi: () => buildAoi(),
              getTargetCycle: () => targetCycle(),
              cycleTarget: () => {
                const cycle = targetCycle();
                if (cycle.length === 0) return null;
                const cur = latestCombat?.targetNpcId ?? 0n;
                let idx = cycle.findIndex((n) => n.npcId === cur);
                idx = (idx + 1) % cycle.length;
                const next = cycle[idx]!.npcId;
                castFeedback = `Target ${next}`;
                void conn.reducers.setTarget({ npcId: next });
                emitStatus(identityHex);
                return next;
              },
              disconnect: () => {
                try {
                  subHandle?.unsubscribe();
                } catch {
                  /* ignore */
                }
                try {
                  conn.disconnect();
                } catch {
                  /* ignore */
                }
              },
            });
          }
        })
        .onConnectError((_ctx, err) => {
          // Bad/expired token: clear and let caller/user refresh for a new identity.
          if (savedToken) {
            clearAuthToken();
          }
          finishError(err instanceof Error ? err.message : String(err));
        })
        .onDisconnect(() => {
          onStatus({ state: 'disconnected', uri, database });
        })
        .build();
    } catch (err) {
      finishError(err instanceof Error ? err.message : String(err));
    }
  });
}

/** Remaining GCD ms from a combat view (client clock). */
export function gcdRemainingMs(combat: CombatView | null | undefined, nowMs = Date.now()): number {
  if (!combat) return 0;
  const readyMs = Number(combat.gcdReadyAtMicros / 1000n);
  return Math.max(0, readyMs - nowMs);
}

/** Remaining windup ms from combat view (client clock). */
export function castRemainingMs(combat: CombatView | null | undefined, nowMs = Date.now()): number {
  if (!combat || combat.castingSpellId === 0) return 0;
  const endsMs = Number(combat.castEndsAtMicros / 1000n);
  return Math.max(0, endsMs - nowMs);
}


/** True when local pose is farther than CAST_RANGE_METERS from target (XZ). */
export function isTargetOutOfCastRange(
  pose: { x: number; z: number } | null | undefined,
  target: { x: number; z: number } | null | undefined,
): boolean {
  if (!pose || !target) return false;
  const dx = pose.x - target.x;
  const dz = pose.z - target.z;
  return dx * dx + dz * dz > CAST_RANGE_METERS * CAST_RANGE_METERS;
}

/** Ms remaining on hard-interrupt Cast silence (0 if unlocked). */
export function castSilenceRemainingMs(
  combat: CombatView | null | undefined,
  nowMs = Date.now(),
): number {
  if (!combat) return 0;
  const untilMs = Number(combat.castLockedUntilMicros / 1000n);
  return Math.max(0, untilMs - nowMs);
}

/** Ms remaining on Stun/Bash hard-CC (0 if unlocked). Distinct from silence. */
export function stunRemainingMs(
  combat: CombatView | null | undefined,
  nowMs = Date.now(),
): number {
  if (!combat) return 0;
  const untilMs = Number(combat.stunnedUntilMicros / 1000n);
  return Math.max(0, untilMs - nowMs);
}
