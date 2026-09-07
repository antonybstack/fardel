/**
 * SpacetimeDB connection for the Babylon client (Connect + Move + Combat + Persist).
 */

import { DbConnection, type EventContext } from '../module_bindings';
import type { Identity, Timestamp } from 'spacetimedb';

export const SPELL_SPARK = 1;
export const SPELL_EMBERBOLT = 2;
export const GCD_MS = 1200;
export const EMBERBOLT_CAST_MS = 1500;
export const NPC_KIND_DUMMY = 1;

/** localStorage key for SpacetimeDB auth token (Persist slice). */
export const AUTH_TOKEN_KEY = 'fardel.spacetime.token';

export type Pose = { x: number; y: number; z: number; yaw: number };

export type NpcView = {
  npcId: bigint;
  kind: number;
  x: number;
  y: number;
  z: number;
  hp: number;
  maxHp: number;
};

export type CombatView = {
  targetNpcId: bigint;
  /** Micros since Unix epoch when GCD is ready (server Timestamp). */
  gcdReadyAtMicros: bigint;
};

export type CharacterView = {
  xp: number;
  knowsSpark: boolean;
  knowsEmberbolt: boolean;
  staffEquipped: boolean;
  robesEquipped: boolean;
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
      castFeedback?: string;
      restoredToken: boolean;
    }
  | { state: 'disconnected'; uri: string; database: string }
  | { state: 'error'; uri: string; database: string; message: string };

export type StatusListener = (status: ConnectionStatus) => void;
export type PoseListener = (pose: Pose) => void;
export type NpcsListener = (npcs: NpcView[]) => void;
export type CombatListener = (combat: CombatView | null) => void;
export type CharacterListener = (character: CharacterView | null) => void;

export type GameNet = {
  identityHex: string;
  identity: Identity;
  sendMove: (dx: number, dz: number) => void;
  ensureTrainingDummy: () => void;
  setTarget: (npcId: bigint) => void;
  cast: (spellId: number) => void;
  getLocalPose: () => Pose | null;
  getCombat: () => CombatView | null;
  getCharacter: () => CharacterView | null;
  getNpcs: () => NpcView[];
  /** Sorted target cycle list (alive NPCs, dummy first). */
  getTargetCycle: () => NpcView[];
  cycleTarget: () => bigint | null;
  disconnect: () => void;
};

const DEFAULT_URI = 'http://127.0.0.1:3000';
const DEFAULT_DATABASE = 'fardel';

function resolveUri(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('db') ?? params.get('database') ?? DEFAULT_URI;
}

function resolveDatabaseName(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('module') ?? params.get('name') ?? DEFAULT_DATABASE;
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

type PoseRow = {
  identity: Identity;
  x: number;
  y: number;
  z: number;
  yaw: number;
};

type CombatRow = {
  identity: Identity;
  targetNpcId: bigint;
  gcdReadyAt: Timestamp;
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
};

function poseView(row: PoseRow): Pose {
  return { x: row.x, y: row.y, z: row.z, yaw: row.yaw };
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

function combatView(row: CombatRow): CombatView {
  return {
    targetNpcId: row.targetNpcId,
    gcdReadyAtMicros: row.gcdReadyAt.microsSinceUnixEpoch,
  };
}

function characterView(row: CharacterRow): CharacterView {
  return {
    xp: row.xp,
    knowsSpark: row.knowsSpark,
    knowsEmberbolt: row.knowsEmberbolt,
    staffEquipped: row.staffEquipped,
    robesEquipped: row.robesEquipped,
  };
}

function asBigInt(v: bigint | number | string): bigint {
  if (typeof v === 'bigint') return v;
  return BigInt(v);
}

/**
 * Connect, subscribe to all tables, ensure training dummy, return net handle.
 * Reuses localStorage auth token when present so refresh restores identity + Character.
 */
export async function connectToSpacetime(
  onStatus: StatusListener,
  onLocalPose?: PoseListener,
  onNpcs?: NpcsListener,
  onCombat?: CombatListener,
  onCharacter?: CharacterListener,
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
    let castFeedback = '';
    const npcMap = new Map<string, NpcView>();

    const finishError = (message: string) => {
      if (settled) return;
      settled = true;
      onStatus({ state: 'error', uri, database, message });
      resolve(null);
    };

    const listNpcs = (): NpcView[] => Array.from(npcMap.values());

    const findNpc = (id: bigint): NpcView | null => {
      if (id === 0n) return null;
      return npcMap.get(id.toString()) ?? null;
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
        castFeedback: castFeedback || undefined,
        restoredToken,
      });
    };

    const emitNpcs = () => {
      onNpcs?.(listNpcs());
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
            if (!localIdentity || !row.identity.isEqual(localIdentity)) return;
            latestPose = poseView(row);
            onLocalPose?.(latestPose);
            emitStatus(identityHex);
          };

          const emitCombatRow = (row: CombatRow) => {
            if (!localIdentity || !row.identity.isEqual(localIdentity)) return;
            latestCombat = combatView(row);
            onCombat?.(latestCombat);
            emitStatus(identityHex);
          };

          const emitCharacterRow = (row: CharacterRow) => {
            if (!localIdentity || !row.identity.isEqual(localIdentity)) return;
            latestCharacter = characterView(row);
            onCharacter?.(latestCharacter);
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

          conn.db.playerPose.onInsert((_ctx: EventContext, row) => {
            emitPose(row as PoseRow);
          });
          conn.db.playerPose.onUpdate((_ctx: EventContext, _old, row) => {
            emitPose(row as PoseRow);
          });

          conn.db.playerCombat.onInsert((_ctx: EventContext, row) => {
            emitCombatRow(row as CombatRow);
          });
          conn.db.playerCombat.onUpdate((_ctx: EventContext, _old, row) => {
            emitCombatRow(row as CombatRow);
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

          conn
            .subscriptionBuilder()
            .onApplied(() => {
              for (const row of conn.db.playerPose.iter()) {
                emitPose(row as PoseRow);
              }
              for (const row of conn.db.playerCombat.iter()) {
                emitCombatRow(row as CombatRow);
              }
              for (const row of conn.db.character.iter()) {
                emitCharacterRow(row as CharacterRow);
              }
              for (const row of conn.db.npc.iter()) {
                upsertNpc(row as NpcRow);
              }
              // Ensure dummy exists / reset HP for presentation slice.
              try {
                void conn.reducers.ensureTrainingDummy({});
              } catch {
                /* ignore */
              }
              if (!latestPose) {
                emitStatus(identityHex);
              }
            })
            .onError((ctx) => {
              const err = (ctx as { event?: unknown }).event;
              finishError(
                err instanceof Error ? err.message : String(err ?? 'subscribe error'),
              );
            })
            .subscribeToAllTables();

          if (!settled) {
            settled = true;
            emitStatus(identityHex);
            resolve({
              identityHex,
              identity,
              sendMove: (dx: number, dz: number) => {
                void conn.reducers.move({ dx, dz });
              },
              ensureTrainingDummy: () => {
                void conn.reducers.ensureTrainingDummy({});
              },
              setTarget: (npcId: bigint) => {
                castFeedback = npcId === 0n ? 'Cleared target' : `Target ${npcId}`;
                void conn.reducers.setTarget({ npcId });
                emitStatus(identityHex);
              },
              cast: (spellId: number) => {
                const name =
                  spellId === SPELL_SPARK
                    ? 'Spark'
                    : spellId === SPELL_EMBERBOLT
                      ? 'Emberbolt'
                      : `Spell ${spellId}`;
                castFeedback = `Casting ${name}…`;
                emitStatus(identityHex);
                void conn.reducers.cast({ spellId });
              },
              getLocalPose: () => latestPose,
              getCombat: () => latestCombat,
              getCharacter: () => latestCharacter,
              getNpcs: () => listNpcs(),
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
