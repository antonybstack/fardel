/**
 * SpacetimeDB connection for the Babylon client (Connect + Move).
 */

import { DbConnection, type EventContext } from '../module_bindings';
import type { Identity } from 'spacetimedb';

export type ConnectionStatus =
  | { state: 'connecting'; uri: string; database: string }
  | {
      state: 'connected';
      uri: string;
      database: string;
      identityHex: string;
      pose?: { x: number; y: number; z: number; yaw: number };
    }
  | { state: 'disconnected'; uri: string; database: string }
  | { state: 'error'; uri: string; database: string; message: string };

export type StatusListener = (status: ConnectionStatus) => void;

export type PoseListener = (pose: {
  x: number;
  y: number;
  z: number;
  yaw: number;
}) => void;

export type GameNet = {
  identityHex: string;
  identity: Identity;
  /** Send a wish-step Move reducer call (server clamps to MaxStepMeters). */
  sendMove: (dx: number, dz: number) => void;
  getLocalPose: () => { x: number; y: number; z: number; yaw: number } | null;
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

type PoseRow = {
  identity: Identity;
  x: number;
  y: number;
  z: number;
  yaw: number;
};

function poseView(row: PoseRow): { x: number; y: number; z: number; yaw: number } {
  return { x: row.x, y: row.y, z: row.z, yaw: row.yaw };
}

/**
 * Connect, subscribe to PlayerPose (all tables for slice 1), and return a net handle.
 */
export async function connectToSpacetime(
  onStatus: StatusListener,
  onLocalPose?: PoseListener,
): Promise<GameNet | null> {
  const uri = resolveUri();
  const database = resolveDatabaseName();
  onStatus({ state: 'connecting', uri, database });

  const wsUri = uri.replace(/^http/, 'ws');

  return new Promise((resolve) => {
    let settled = false;
    let localIdentity: Identity | null = null;
    let latestPose: { x: number; y: number; z: number; yaw: number } | null =
      null;

    const finishError = (message: string) => {
      if (settled) return;
      settled = true;
      onStatus({ state: 'error', uri, database, message });
      resolve(null);
    };

    try {
      const builder = DbConnection.builder()
        .withUri(wsUri)
        .withDatabaseName(database)
        .onConnect((conn, identity) => {
          localIdentity = identity;
          const identityHex = identity.toHexString();

          const emitPose = (row: PoseRow) => {
            if (!localIdentity || !row.identity.isEqual(localIdentity)) return;
            latestPose = poseView(row);
            onLocalPose?.(latestPose);
            onStatus({
              state: 'connected',
              uri,
              database,
              identityHex,
              pose: latestPose,
            });
          };

          conn.db.playerPose.onInsert((_ctx: EventContext, row) => {
            emitPose(row as PoseRow);
          });
          conn.db.playerPose.onUpdate((_ctx: EventContext, _old, row) => {
            emitPose(row as PoseRow);
          });

          conn
            .subscriptionBuilder()
            .onApplied(() => {
              // Seed HUD from cache after subscribe (ClientConnected inserts pose).
              for (const row of conn.db.playerPose.iter()) {
                emitPose(row as PoseRow);
              }
              if (!latestPose) {
                onStatus({
                  state: 'connected',
                  uri,
                  database,
                  identityHex,
                });
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
            onStatus({
              state: 'connected',
              uri,
              database,
              identityHex,
            });
            resolve({
              identityHex,
              identity,
              sendMove: (dx: number, dz: number) => {
                void conn.reducers.move({ dx, dz });
              },
              getLocalPose: () => latestPose,
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
          finishError(err instanceof Error ? err.message : String(err));
        })
        .onDisconnect(() => {
          onStatus({ state: 'disconnected', uri, database });
        });

      builder.build();
    } catch (err) {
      finishError(err instanceof Error ? err.message : String(err));
    }
  });
}
