using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

// Long-lived second identity for shared-yard VE proof.
const string uri = "http://127.0.0.1:3000";
const string db = "fardel";
const float targetX = 4.0f;
const float targetZ = 2.5f;
const int timeoutMs = 30000;

var connected = new TaskCompletionSource<Identity>();
var subscribed = new TaskCompletionSource();

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
            Console.Error.WriteLine("disconnected: " + (e?.Message ?? "ok"));
        })
        .Build();

    if (!await WaitTick(connected.Task, timeoutMs, conn, "connect"))
    {
        Fail("connect timeout");
        return;
    }

    var identity = await connected.Task;
    Console.WriteLine("second-client connected " + identity);

    conn.SubscriptionBuilder()
        .OnApplied(_ => subscribed.TrySetResult())
        .OnError((_, e) => subscribed.TrySetException(e))
        .SubscribeToAllTables();

    if (!await WaitTick(subscribed.Task, timeoutMs, conn, "subscribe"))
    {
        Fail("subscribe timeout");
        return;
    }

    if (conn.Db.PlayerPose.Identity.Find(identity) is not { } pose)
    {
        Fail("PlayerPose missing after subscribe");
        return;
    }

    Console.WriteLine($"spawn ({pose.X}, {pose.Z})");

    // Walk toward offset in clamped steps.
    for (var i = 0; i < 80; i++)
    {
        if (conn.Db.PlayerPose.Identity.Find(identity) is not { } cur)
        {
            await Frame(conn, 50);
            continue;
        }

        var dx = targetX - cur.X;
        var dz = targetZ - cur.Z;
        var dist = MathF.Sqrt(dx * dx + dz * dz);
        if (dist < 0.2f)
        {
            Console.WriteLine($"arrived ({cur.X}, {cur.Z}) — holding for VE");
            break;
        }

        var scale = MathF.Min(Movement.MaxStepMeters, dist) / dist;
        conn.Reducers.Move(dx * scale, dz * scale);
        await Frame(conn, 60);
    }

    if (conn.Db.PlayerPose.Identity.Find(identity) is { } finalPose)
    {
        Console.WriteLine($"READY remotes-visible-at ({finalPose.X:F2}, {finalPose.Z:F2}) identity={identity}");
    }

    // Hold connection indefinitely (VE screenshot script kills us).
    while (true)
    {
        await Frame(conn, 200);
    }
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

static async Task Frame(DbConnection conn, int ms)
{
    var until = DateTime.UtcNow.AddMilliseconds(ms);
    while (DateTime.UtcNow < until)
    {
        conn.FrameTick();
        await Task.Delay(16);
    }
}

static async Task<bool> WaitTick(Task task, int timeoutMs, DbConnection conn, string label)
{
    var until = DateTime.UtcNow.AddMilliseconds(timeoutMs);
    while (!task.IsCompleted && DateTime.UtcNow < until)
    {
        conn.FrameTick();
        await Task.Delay(16);
    }
    if (!task.IsCompleted)
    {
        Console.Error.WriteLine($"timeout waiting for {label}");
        return false;
    }
    await task;
    return true;
}
