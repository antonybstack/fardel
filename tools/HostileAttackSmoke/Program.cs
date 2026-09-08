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

    var hp0 = conn.Db.Character.Identity.Find(identity)!.Hp;
    if (hp0 <= Combat.HostileAttackDamage)
    {
        Fail($"hp {hp0} too low to prove a swing");
        return;
    }
    Console.WriteLine($"pad A id={padA.NpcId} hp0={hp0}");

    await MoveToward(conn, identity, Combat.HostileSpawnAx, Combat.HostileSpawnAz);
    await PumpUntil(() =>
    {
        var a = FindNpc(conn, padA.NpcId);
        return a is { Aggroed: true };
    }, timeoutMs, conn, "hostile A aggroed");

    await PumpUntil(() =>
    {
        var ch = conn.Db.Character.Identity.Find(identity);
        return ch is { Hp: var hp } && hp < hp0 && hp > 0;
    }, timeoutMs, conn, "hp dropped in melee");

    var hpHit = conn.Db.Character.Identity.Find(identity)!.Hp;
    if (hp0 - hpHit < Combat.HostileAttackDamage)
    {
        Fail($"hp drop {hp0}->{hpHit} smaller than HostileAttackDamage {Combat.HostileAttackDamage}");
        return;
    }
    var stillB = FindNpc(conn, padB.NpcId)!;
    if (stillB.Aggroed)
    {
        Fail("hostile B aggroed while pulling A");
        return;
    }
    if (FindDummy(conn) is not { Hp: > 0 } dummyMid || dummyMid.NpcId != dummy.NpcId)
    {
        Fail("dummy trainer gone after swing");
        return;
    }
    Console.WriteLine($"hit hp {hp0}->{hpHit}");

    await MoveToward(conn, identity, -20f, -20f);
    var a0x = Combat.HostileSpawnAx;
    var a0z = Combat.HostileSpawnAz;
    await PumpUntil(() =>
    {
        var a = FindNpc(conn, padA.NpcId);
        return a is not null && !a.Aggroed && Dist(a.X, a.Z, a0x, a0z) < 0.45f;
    }, timeoutMs, conn, "hostile A leashed");

    var hpStop = conn.Db.Character.Identity.Find(identity)!.Hp;
    if (hpStop <= 0)
    {
        Fail("player died before leash stop");
        return;
    }
    await DelayPump(conn, Combat.HostileAttackMs * 2 + 400);
    var hpAfter = conn.Db.Character.Identity.Find(identity)!.Hp;
    if (hpAfter != hpStop)
    {
        Fail($"hp still dropping after leash {hpStop}->{hpAfter}");
        return;
    }
    if (FindDummy(conn) is not { Hp: > 0 } dummyEnd || dummyEnd.NpcId != dummy.NpcId)
    {
        Fail("dummy trainer gone after leash");
        return;
    }

    Console.WriteLine($"OK: HostileAttackSmoke passed hp {hp0}->{hpHit} stopped {hpStop}");
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
