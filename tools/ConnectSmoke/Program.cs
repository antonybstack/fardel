using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

var uri = GameConstants.ResolveLocalUri();
var db = GameConstants.ResolveDatabaseName();
const int timeoutMs = 15000;
var startedMicros = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() * 1000L;

var tcs = new TaskCompletionSource<(bool ok, Identity identity, string detail)>();

DbConnection? conn = null;
try
{
    conn = DbConnection.Builder()
        .WithUri(uri)
        .WithDatabaseName(db)
        .OnConnect((_, identity, _) =>
        {
            tcs.TrySetResult((true, identity, identity.ToString()));
        })
        .OnConnectError(e =>
        {
            tcs.TrySetResult((false, default, e.ToString()));
        })
        .OnDisconnect((_, e) =>
        {
            if (!tcs.Task.IsCompleted)
            {
                tcs.TrySetResult((false, default, e?.ToString() ?? "disconnected before connect"));
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

    var (ok, identity, detail) = await tcs.Task.ConfigureAwait(false);
    if (!ok)
    {
        Console.Error.WriteLine("FAIL: " + detail);
        Environment.ExitCode = 1;
        return;
    }

    Console.WriteLine("OK: connected identity " + detail);

    // Wait for subscription / pose to appear (#168)
    var subscribed = new TaskCompletionSource();
    conn.SubscriptionBuilder()
        .OnApplied(_ => subscribed.TrySetResult())
        .OnError((_, e) => subscribed.TrySetException(e))
        .SubscribeToAllTables();

    using (var cts2 = new CancellationTokenSource(timeoutMs))
    {
        while (!subscribed.Task.IsCompleted && !cts2.IsCancellationRequested)
        {
            conn.FrameTick();
            await Task.Delay(16, cts2.Token).ConfigureAwait(false);
        }
        if (!subscribed.Task.IsCompleted)
        {
            Console.Error.WriteLine("FAIL: timed out waiting for subscription");
            Environment.ExitCode = 2;
            return;
        }
        await subscribed.Task.ConfigureAwait(false);
    }

    PlayerPose? pose = null;
    using (var cts3 = new CancellationTokenSource(timeoutMs))
    {
        while (pose is null && !cts3.IsCancellationRequested)
        {
            pose = conn.Db.PlayerPose.Identity.Find(identity);
            if (pose is null)
            {
                conn.FrameTick();
                await Task.Delay(16, cts3.Token).ConfigureAwait(false);
            }
        }
    }

    if (pose is null)
    {
        Console.Error.WriteLine("FAIL: PlayerPose not found after subscription");
        Environment.ExitCode = 1;
        return;
    }

    // Assert EnsureSession spawn verticals (#168): Y≈SpawnY, VelY≈0, LastGroundedMicros set/recent.
    if (MathF.Abs(pose.Y - Movement.SpawnY) > 0.05f)
    {
        Console.Error.WriteLine($"FAIL: Y={pose.Y} not ≈ SpawnY={Movement.SpawnY}");
        Environment.ExitCode = 1;
        return;
    }
    if (MathF.Abs(pose.VelY) > 0.05f)
    {
        Console.Error.WriteLine($"FAIL: VelY={pose.VelY} not ≈ 0");
        Environment.ExitCode = 1;
        return;
    }
    var nowMicros = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() * 1000L;
    var ageMicros = nowMicros - pose.LastGroundedMicros;
    // Nonzero and within the connect window (5s clock skew). Stale coyote fuel still PASSed #183.
    if (pose.LastGroundedMicros == 0
        || pose.LastGroundedMicros < startedMicros - 5_000_000
        || ageMicros > timeoutMs * 1000L)
    {
        Console.Error.WriteLine(
            $"FAIL: LastGroundedMicros={pose.LastGroundedMicros} not set/recent (start={startedMicros} now={nowMicros})");
        Environment.ExitCode = 1;
        return;
    }

    Console.WriteLine($"OK: pose Y={pose.Y} VelY={pose.VelY} LastGroundedMicros={pose.LastGroundedMicros}");
    Environment.ExitCode = 0;
}
finally
{
    try { conn?.Disconnect(); } catch { /* ignore */ }
}
