using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

var uri = GameConstants.ResolveLocalUri();
var db = GameConstants.ResolveDatabaseName();
const int timeoutMs = 40000;

DbConnection? conn = null;
var connected = new TaskCompletionSource<Identity>();
var subscribed = new TaskCompletionSource();

try
{
    conn = DbConnection.Builder()
        .WithUri(uri)
        .WithDatabaseName(db)
        .OnConnect((_, identity, _) => connected.TrySetResult(identity))
        .OnConnectError(e => connected.TrySetException(e))
        .Build();

    await Pump(connected.Task, timeoutMs, conn, "connect");
    var identity = await connected.Task;
    Console.WriteLine("connected " + identity);

    conn.SubscriptionBuilder()
        .OnApplied(_ => subscribed.TrySetResult())
        .OnError((_, e) => subscribed.TrySetException(e))
        .SubscribeToAllTables();
    await Pump(subscribed.Task, timeoutMs, conn, "subscribe");

    await PumpUntil(() => conn.Db.Character.Identity.Find(identity) is not null
        && conn.Db.PlayerPose.Identity.Find(identity) is not null, timeoutMs, conn, "character+pose");

    await PumpUntil(() => CountHostiles(conn) >= 2, timeoutMs, conn, "two hostiles");
    var dummy = FindDummy(conn) ?? throw new Exception("dummy trainer missing");
    if (dummy.Kind != Combat.NpcKindDummy || dummy.Hp <= 0)
    {
        Fail($"dummy kind={dummy.Kind} hp={dummy.Hp}");
        return;
    }

    var padA = FindHostileNear(conn, Combat.HostileSpawnAx, Combat.HostileSpawnAz)
        ?? throw new Exception("hostile pad A missing");
    var padB = FindHostileNear(conn, Combat.HostileSpawnBx, Combat.HostileSpawnBz)
        ?? throw new Exception("hostile pad B missing");
    if (padA.Aggroed || padB.Aggroed)
    {
        Fail("hostiles aggroed at spawn (origin should be outside AggroRadius)");
        return;
    }

    var a0x = padA.X;
    var a0z = padA.Z;
    Console.WriteLine($"pad A id={padA.NpcId} xz=({a0x:0.##},{a0z:0.##}) B id={padB.NpcId}");

    var pullX = Combat.HostileSpawnAx;
    var pullZ = Combat.HostileSpawnAz;
    await MoveToward(conn, identity, pullX, pullZ);
    await PumpUntil(() =>
    {
        var a = FindNpc(conn, padA.NpcId);
        return a is { Aggroed: true } || (a is not null && Dist(a.X, a.Z, a0x, a0z) > 0.6f);
    }, timeoutMs, conn, "hostile A pulled");

    var pulled = FindNpc(conn, padA.NpcId)!;
    if (Dist(pulled.X, pulled.Z, a0x, a0z) <= 0.35f && !pulled.Aggroed)
    {
        Fail("hostile A did not leave pad");
        return;
    }
    var stillB = FindNpc(conn, padB.NpcId)!;
    if (Dist(stillB.X, stillB.Z, Combat.HostileSpawnBx, Combat.HostileSpawnBz) > 0.6f)
    {
        Fail("hostile B left pad while pulling A");
        return;
    }
    if (FindDummy(conn) is not { Hp: > 0 } dummyMid || dummyMid.NpcId != dummy.NpcId)
    {
        Fail("dummy trainer gone after pull");
        return;
    }
    Console.WriteLine($"pulled A xz=({pulled.X:0.##},{pulled.Z:0.##}) aggro={pulled.Aggroed}");

    await MoveToward(conn, identity, -20f, -20f);
    await PumpUntil(() =>
    {
        var a = FindNpc(conn, padA.NpcId);
        return a is not null && !a.Aggroed && Dist(a.X, a.Z, a0x, a0z) < 0.45f;
    }, timeoutMs, conn, "hostile A returned");

    var home = FindNpc(conn, padA.NpcId)!;
    if (home.Aggroed || Dist(home.X, home.Z, a0x, a0z) >= 0.45f)
    {
        Fail($"hostile A did not leash home xz=({home.X:0.##},{home.Z:0.##}) aggro={home.Aggroed}");
        return;
    }
    if (FindDummy(conn) is not { Hp: > 0 } dummyEnd || dummyEnd.NpcId != dummy.NpcId)
    {
        Fail("dummy trainer gone after leash");
        return;
    }

    Console.WriteLine("OK: HostileAggroSmoke passed");
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

static int CountHostiles(DbConnection conn)
{
    var n = 0;
    foreach (var row in conn.Db.Npc.Iter())
    {
        if (row.Kind == Combat.NpcKindHostile) n++;
    }
    return n;
}

static Npc? FindDummy(DbConnection conn)
{
    foreach (var n in conn.Db.Npc.Iter())
    {
        if (n.Kind == Combat.NpcKindDummy) return n;
    }
    return null;
}

static Npc? FindHostileNear(DbConnection conn, float x, float z)
{
    foreach (var n in conn.Db.Npc.Iter())
    {
        if (n.Kind != Combat.NpcKindHostile) continue;
        var hx = MathF.Abs(n.SpawnX) > 0.01f || MathF.Abs(n.SpawnZ) > 0.01f ? n.SpawnX : n.X;
        var hz = MathF.Abs(n.SpawnX) > 0.01f || MathF.Abs(n.SpawnZ) > 0.01f ? n.SpawnZ : n.Z;
        if (Dist(hx, hz, x, z) < 0.5f) return n;
    }
    return null;
}

static Npc? FindNpc(DbConnection conn, ulong id)
{
    foreach (var n in conn.Db.Npc.Iter())
    {
        if (n.NpcId == id) return n;
    }
    return null;
}

static float Dist(float x, float z, float ox, float oz)
{
    var dx = x - ox;
    var dz = z - oz;
    return MathF.Sqrt(dx * dx + dz * dz);
}

static async Task MoveToward(DbConnection conn, Identity id, float tx, float tz)
{
    var guard = 0;
    while (guard++ < 120)
    {
        var p = conn.Db.PlayerPose.Identity.Find(id)!;
        var dx = tx - p.X;
        var dz = tz - p.Z;
        var dist = MathF.Sqrt(dx * dx + dz * dz);
        if (dist <= 0.4f) break;
        var scale = MathF.Min(Movement.MaxStepMeters, dist) / dist;
        conn.Reducers.Move(dx * scale, dz * scale, false);
        await DelayPump(conn, 25);
    }
    await DelayPump(conn, 80);
}

static void Fail(string msg)
{
    Console.Error.WriteLine("FAIL: " + msg);
    Environment.ExitCode = 1;
}

static async Task Pump(Task task, int timeoutMs, DbConnection conn, string label)
{
    using var cts = new CancellationTokenSource(timeoutMs);
    while (!task.IsCompleted && !cts.IsCancellationRequested)
    {
        conn.FrameTick();
        try { await Task.Delay(16, cts.Token); } catch (OperationCanceledException) { break; }
    }
    if (!task.IsCompleted) throw new TimeoutException(label);
    await task;
}

static async Task PumpUntil(Func<bool> pred, int timeoutMs, DbConnection conn, string label)
{
    using var cts = new CancellationTokenSource(timeoutMs);
    while (!pred() && !cts.IsCancellationRequested)
    {
        conn.FrameTick();
        try { await Task.Delay(16, cts.Token); } catch (OperationCanceledException) { break; }
    }
    if (!pred()) throw new TimeoutException(label);
}

static async Task DelayPump(DbConnection conn, int ms)
{
    var until = Environment.TickCount64 + ms;
    while (Environment.TickCount64 < until)
    {
        conn.FrameTick();
        await Task.Delay(16);
    }
}
