using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

var uri = GameConstants.ResolveLocalUri();
var db = GameConstants.ResolveDatabaseName();
const int timeoutMs = 50000;

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
    Console.WriteLine($"pad A id={padA.NpcId} hp={padA.Hp} B id={padB.NpcId}");

    // Stay outside AggroRadius so auto-attack does not chew HP; origin is ~7.6m (in CastRange).
    var pose0 = conn.Db.PlayerPose.Identity.Find(identity)!;
    var dA = Dist(pose0.X, pose0.Z, padA.X, padA.Z);
    if (dA <= Combat.HostileAggroRadius + 0.4f || dA > Combat.CastRangeMeters - 0.2f)
    {
        Fail($"spawn dist to A {dA:0.##} not in (aggro, cast]");
        return;
    }

    conn.Reducers.SetTarget(padA.NpcId);
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(identity) is { } cc && cc.TargetNpcId == padA.NpcId,
        timeoutMs, conn, "target A");

    while (FindNpc(conn, padA.NpcId) is { Hp: > 0 })
    {
        var before = FindNpc(conn, padA.NpcId)!.Hp;
        conn.Reducers.Cast(Combat.SpellSpark);
        await PumpUntil(() =>
        {
            var n = FindNpc(conn, padA.NpcId);
            return n is null || n.Hp < before || n.Hp == 0;
        }, timeoutMs, conn, "spark tick");
        await DelayPump(conn, Combat.GcdMs + 50);
    }

    await PumpUntil(() => FindLootNear(conn, Combat.HostileSpawnAx, Combat.HostileSpawnAz) is not null,
        timeoutMs, conn, "corpse WorldLoot");
    var shard = FindLootNear(conn, Combat.HostileSpawnAx, Combat.HostileSpawnAz)!;
    Console.WriteLine($"corpse loot id={shard.LootId} xz=({shard.X:0.##},{shard.Z:0.##})");

    if (FindDummy(conn) is not { Hp: > 0 } dummyMid || dummyMid.NpcId != dummy.NpcId)
    {
        Fail("dummy trainer gone after hostile kill");
        return;
    }
    if (FindNpc(conn, padB.NpcId) is not { Hp: > 0 })
    {
        Fail("hostile B died while killing A");
        return;
    }

    var xpBefore = conn.Db.Character.Identity.Find(identity)!.Xp;
    await MoveToward(conn, identity, shard.X, shard.Z);
    await PumpUntil(() =>
    {
        var p = conn.Db.PlayerPose.Identity.Find(identity);
        if (p is null) return false;
        return Dist(p.X, p.Z, shard.X, shard.Z) <= Loot.PickupRangeMeters;
    }, timeoutMs, conn, "in pickup range");

    conn.Reducers.Pickup();
    await PumpUntil(() => FindLoot(conn, shard.LootId) is null, timeoutMs, conn, "loot despawned");
    var ch = conn.Db.Character.Identity.Find(identity)!;
    if (!ch.HasEmberShard)
    {
        Fail("HasEmberShard not set after corpse pickup");
        return;
    }
    if (ch.Xp < xpBefore + Loot.XpPerEmberShard)
    {
        Fail($"xp {xpBefore}->{ch.Xp} missing ember_shard grant");
        return;
    }

    Console.WriteLine("OK: HostileLootSmoke passed");
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

static WorldLoot? FindLootNear(DbConnection conn, float x, float z)
{
    foreach (var row in conn.Db.WorldLoot.Iter())
    {
        if (row.ItemId != Loot.EmberShardItemId) continue;
        if (Dist(row.X, row.Z, x, z) < 2.5f) return row;
    }
    return null;
}

static WorldLoot? FindLoot(DbConnection conn, ulong id)
{
    foreach (var row in conn.Db.WorldLoot.Iter())
    {
        if (row.LootId == id) return row;
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
