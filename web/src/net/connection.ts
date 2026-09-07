/**
 * SpacetimeDB connection for the Babylon client.
 *
 * Prefers generated bindings at `../module_bindings` when present.
 * Until `spacetime generate --lang typescript` succeeds, this module uses a
 * stub that reports status and documents the wiring TODO.
 */

export type ConnectionStatus =
  | { state: 'connecting'; uri: string; database: string }
  | { state: 'connected'; uri: string; database: string; identityHex: string }
  | { state: 'disconnected'; uri: string; database: string }
  | { state: 'error'; uri: string; database: string; message: string };

export type StatusListener = (status: ConnectionStatus) => void;

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

/**
 * Attempt a real DbConnection via generated bindings.
 * Falls back to a clear stub if bindings are missing.
 */
export async function connectToSpacetime(onStatus: StatusListener): Promise<void> {
  const uri = resolveUri();
  const database = resolveDatabaseName();
  onStatus({ state: 'connecting', uri, database });

  try {
    const bindings = await import('../module_bindings');
    const DbConnection = (bindings as { DbConnection?: unknown }).DbConnection as
      | {
          builder: () => {
            withUri: (u: string) => unknown;
          };
        }
      | undefined;

    if (!DbConnection || typeof DbConnection.builder !== 'function') {
      onStatus({
        state: 'error',
        uri,
        database,
        message:
          'TODO: run spacetime generate --lang typescript --out-dir web/src/module_bindings --project-path server (stub active; Babylon scene is up)',
      });
      return;
    }

    const builder = DbConnection.builder() as {
      withUri: (u: string) => {
        withModuleName?: (n: string) => unknown;
        withDatabaseName?: (n: string) => unknown;
        onConnect: (cb: (conn: unknown, identity: { toHexString: () => string }, token: string) => void) => {
          onConnectError: (cb: (err: unknown) => void) => {
            onDisconnect: (cb: () => void) => { build: () => unknown };
          };
        };
      };
    };

    const wsUri = uri.replace(/^http/, 'ws');
    let named = builder.withUri(wsUri);
    const asAny = named as {
      withDatabaseName?: (n: string) => typeof named;
      withModuleName?: (n: string) => typeof named;
      onConnect: typeof named.onConnect;
    };
    if (typeof asAny.withDatabaseName === 'function') {
      named = asAny.withDatabaseName(database) as typeof named;
    } else if (typeof asAny.withModuleName === 'function') {
      named = asAny.withModuleName(database) as typeof named;
    }

    named
      .onConnect((_conn, identity) => {
        onStatus({
          state: 'connected',
          uri,
          database,
          identityHex: identity.toHexString(),
        });
      })
      .onConnectError((err) => {
        onStatus({
          state: 'error',
          uri,
          database,
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .onDisconnect(() => {
        onStatus({ state: 'disconnected', uri, database });
      })
      .build();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onStatus({
      state: 'error',
      uri,
      database,
      message: `Connection stub error: ${msg}`,
    });
  }
}
