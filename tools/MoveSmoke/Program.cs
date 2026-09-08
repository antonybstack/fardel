using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

var uri = GameConstants.ResolveLocalUri();
var db = GameConstants.ResolveDatabaseName();
const int timeoutMs = 20000;

var connected = new TaskCompletionSource<Identity>();
var subscribed = new TaskCompletionSource();
var moved = new TaskCompletionSource<(float x, float z)>();

DbConnection? conn = null;
Identity? me = null;

try
{
    conn = DbConnection.Builder()
        .WithUri(uri)
        .WithDatabaseName(db)
        .OnConnect((c, identity, _) =>
        {
            me = identity;
            connected.TrySetResult(identity);
        })
        .OnConnectError(e => connected.TrySetException(e))
        .OnDisconnect((_, e) =>
        {
            if (!moved.Task.IsCompleted)
            {
                moved.TrySetException(e ?? new Exception("disconnected early"));
            }
        })
        .Build();

    if (!await WaitTick(connected.Task, timeoutMs, conn, "connect"))
    {
        Fail("connect timeout");
        return;
    }

    var identity = await connected.Task;
    Console.WriteLine("connected " + identity);

    conn.Db.PlayerPose.OnInsert += (_, _) => { };
    conn.Db.PlayerPose.OnUpdate += (EventContext ctx, PlayerPose oldPose, PlayerPose newPose) =>
    {
        if (me is { } id && newPose.Identity == id &&
            (MathF.Abs(newPose.X - oldPose.X) > 1e-4f || MathF.Abs(newPose.Z - oldPose.Z) > 1e-4f))
        {
            moved.TrySetResult((newPose.X, newPose.Z));
        }
    };

    conn.SubscriptionBuilder()
        .OnApplied(_ => subscribed.TrySetResult())
        .OnError((_, e) => subscribed.TrySetException(e))
        .SubscribeToAllTables();

    if (!await WaitTick(subscribed.Task, timeoutMs, conn, "subscribe"))
    {
        Fail("subscribe timeout");
        return;
    }

    // Pose should exist from ClientConnected
    if (conn.Db.PlayerPose.Identity.Find(identity) is not {} pose)
    {
        Fail("PlayerPose missing after subscribe");
        return;
    }

    var startX = pose.X;
    var startZ = pose.Z;
    Console.WriteLine($"spawn pose ({startX}, {startZ}) chunk=({pose.ChunkX},{pose.ChunkZ})");

    // Oversized wish step — server must clamp
    conn.Reducers.Move(10f, 0f, false);

    if (!await WaitTick(moved.Task, timeoutMs, conn, "move"))
    {
        Fail("move timeout — no pose update");
        return;
    }

    var (x, z) = await moved.Task;
    var dx = x - startX;
    var dz = z - startZ;
    var step = MathF.Sqrt(dx * dx + dz * dz);
    Console.WriteLine($"after move ({x}, {z}) step={step}");

    if (step <= 0.01f)
    {
        Fail("pose did not move");
        return;
    }

    if (step > Movement.MaxStepMeters + 0.05f)
    {
        Fail($"step {step} exceeded MaxStepMeters {Movement.MaxStepMeters}");
        return;
    }

    // After #83: grounded Move also writes Y / VelY / LastGroundedMicros
    if (conn.Db.PlayerPose.Identity.Find(identity) is not { } finalPose)
    {
        Fail("PlayerPose missing after move");
        return;
    }

    if (MathF.Abs(finalPose.Y - Movement.GroundY) > 0.05f)
    {
        Fail($"grounded move Y={finalPose.Y} not ≈ GroundY={Movement.GroundY}");
        return;
    }

    if (MathF.Abs(finalPose.VelY) > 0.1f)
    {
        Fail($"grounded move VelY={finalPose.VelY} not ≈ 0");
        return;
    }

    if (finalPose.LastGroundedMicros == 0)
    {
        Fail("grounded move LastGroundedMicros not updated (still zero)");
        return;
    }

    Console.WriteLine($"grounded move contract OK: Y={finalPose.Y} VelY={finalPose.VelY} LastGroundedMicros={finalPose.LastGroundedMicros}");
    Console.WriteLine("OK: MoveSmoke passed");
    Environment.ExitCode = 0;
}
catch (Exception e)
{
    Fail(e.ToString());
}
finally
{
    try { conn?.Disconnect(); } catch { /* ignore */ }
}

static void Fail(string msg)
{
    Console.Error.WriteLine("FAIL: " + msg);
    Environment.ExitCode = 1;
}

static async Task<bool> WaitTick(Task task, int timeoutMs, DbConnection conn, string label)
{
    using var cts = new CancellationTokenSource(timeoutMs);
    try
    {
        while (!task.IsCompleted && !cts.IsCancellationRequested)
        {
            conn.FrameTick();
            await Task.Delay(16, cts.Token).ConfigureAwait(false);
        }
    }
    catch (OperationCanceledException)
    {
        Console.Error.WriteLine($"timeout waiting for {label}");
        return false;
    }

    return task.IsCompleted;
}
