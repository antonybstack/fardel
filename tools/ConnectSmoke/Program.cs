using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

var uri = GameConstants.ResolveLocalUri();
var db = GameConstants.ResolveDatabaseName();
const int timeoutMs = 15000;

var tcs = new TaskCompletionSource<(bool ok, string detail)>();

DbConnection? conn = null;
try
{
    conn = DbConnection.Builder()
        .WithUri(uri)
        .WithDatabaseName(db)
        .OnConnect((_, identity, _) =>
        {
            tcs.TrySetResult((true, identity.ToString()));
        })
        .OnConnectError(e =>
        {
            tcs.TrySetResult((false, e.ToString()));
        })
        .OnDisconnect((_, e) =>
        {
            if (!tcs.Task.IsCompleted)
            {
                tcs.TrySetResult((false, e?.ToString() ?? "disconnected before connect"));
            }
        })
        .Build();

    using var cts = new CancellationTokenSource(timeoutMs);
    while (!tcs.Task.IsCompleted && !cts.IsCancellationRequested)
    {
        conn.FrameTick();
        await Task.Delay(16, cts.Token).ConfigureAwait(false);
    }

    if (!tcs.Task.IsCompleted)
    {
        Console.Error.WriteLine("FAIL: timed out waiting for SpacetimeDB connect");
        Environment.ExitCode = 2;
        return;
    }

    var (ok, detail) = await tcs.Task.ConfigureAwait(false);
    if (!ok)
    {
        Console.Error.WriteLine("FAIL: " + detail);
        Environment.ExitCode = 1;
        return;
    }

    Console.WriteLine("OK: connected identity " + detail);
    Environment.ExitCode = 0;
}
finally
{
    try { conn?.Disconnect(); } catch { /* ignore */ }
}
