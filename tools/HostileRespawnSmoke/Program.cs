using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

var uri = GameConstants.ResolveLocalUri();
var db = GameConstants.ResolveDatabaseName();
const int timeoutMs = 70000;

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

    await PumpUntil(() => CountKind(conn, Combat.NpcKindHostile) >= 2, timeoutMs, conn, "two Kind=2");
    var dummy = FindDummy(conn) ?? throw new Exception("dummy trainer missing");
    if (dummy.Kind != Combat.NpcKindDummy || dummy.Hp <= 0)
    {
        Fail($"dummy kind={dummy.Kind} hp={dummy.Hp}");
        return;
    }
    var dummyId = dummy.NpcId;

    var padA = FindKindNear(conn, Combat.NpcKindHostile, Combat.HostileSpawnAx, Combat.HostileSpawnAz)
        ?? throw new Exception("hostile pad A missing");
    var padB = FindKindNear(conn, Combat.NpcKindHostile, Combat.HostileSpawnBx, Combat.HostileSpawnBz)
        ?? throw new Exception("hostile pad B missing");
    var padC = FindKindNear(conn, Combat.NpcKindBrigand, Combat.HostileSpawnCx, Combat.HostileSpawnCz)
        ?? throw new Exception("brigand pad C missing");
    Console.WriteLine($"pad A id={padA.NpcId} B id={padB.NpcId} C id={padC.NpcId} dummy={dummyId}");

    var pose0 = conn.Db.PlayerPose.Identity.Find(identity)!;
    var dA = Dist(pose0.X, pose0.Z, padA.X, padA.Z);
    if (dA <= Combat.HostileAggroRadius + 0.4f || dA > Combat.CastRangeMeters - 0.2f)
    {
        Fail($"spawn dist to A {dA:0.##} not in (aggro, cast]");
        return;
    }

    await KillNpc(conn, identity, padA.NpcId, timeoutMs, "kill A linger");
    AssertDummyTrainer(conn, dummyId, "after A death");
    if (FindNpc(conn, padB.NpcId) is not { Hp: > 0 })
    {
        Fail("hostile B died while killing A");
        return;
    }

    await PumpUntil(() =>
    {
        var n = FindNpc(conn, padA.NpcId);
        return n is { Hp: > 0, Kind: Combat.NpcKindHostile }
            && Dist(n.X, n.Z, Combat.HostileSpawnAx, Combat.HostileSpawnAz) < 0.6f;
    }, timeoutMs, conn, "A linger respawn");
    var aLive = FindNpc(conn, padA.NpcId)!;
    if (aLive.Hp != Combat.HostileMaxHp)
    {
        Fail($"A linger hp={aLive.Hp} want {Combat.HostileMaxHp}");
        return;
    }
    Console.WriteLine($"linger A id={aLive.NpcId} hp={aLive.Hp} xz=({aLive.X:0.##},{aLive.Z:0.##})");
    AssertDummyTrainer(conn, dummyId, "after A linger");

    await DelayPump(conn, Combat.GcdMs + 80);

    await KillNpc(conn, identity, padA.NpcId, timeoutMs, "kill A loot");
    AssertDummyTrainer(conn, dummyId, "after A second death");
    await PumpUntil(() => FindLootNear(conn, Combat.HostileSpawnAx, Combat.HostileSpawnAz) is not null,
        timeoutMs, conn, "corpse WorldLoot");
    var shard = FindLootNear(conn, Combat.HostileSpawnAx, Combat.HostileSpawnAz)!;
    await MoveToward(conn, identity, shard.X, shard.Z);
    await PumpUntil(() =>
    {
        var p = conn.Db.PlayerPose.Identity.Find(identity);
        return p is not null && Dist(p.X, p.Z, shard.X, shard.Z) <= Loot.PickupRangeMeters;
    }, timeoutMs, conn, "in corpse pickup");
    conn.Reducers.Pickup();
    await PumpUntil(() => FindLoot(conn, shard.LootId) is null, timeoutMs, conn, "corpse loot despawned");
    await PumpUntil(() =>
    {
        var n = FindNpc(conn, padA.NpcId);
        return n is { Hp: > 0, Kind: Combat.NpcKindHostile }
            && Dist(n.X, n.Z, Combat.HostileSpawnAx, Combat.HostileSpawnAz) < 0.6f;
    }, timeoutMs, conn, "A loot respawn");
    Console.WriteLine($"loot A id={padA.NpcId} hp={FindNpc(conn, padA.NpcId)!.Hp}");
    AssertDummyTrainer(conn, dummyId, "after A loot respawn");

    // Pickup is next to the pad — break leash so A does not escort the C kill.
    await MoveToward(conn, identity, -8f, -8f);
    await PumpUntil(() =>
    {
        var n = FindNpc(conn, padA.NpcId);
        return n is { Hp: > 0, Aggroed: false }
            && Dist(n.X, n.Z, Combat.HostileSpawnAx, Combat.HostileSpawnAz) < 0.8f;
    }, timeoutMs, conn, "A leashed home");
    await MoveToward(conn, identity, 0f, 0f);
    await DelayPump(conn, Combat.GcdMs + 80);
    await KillNpc(conn, identity, padC.NpcId, timeoutMs, "kill C linger");
    if (FindNpc(conn, padC.NpcId) is { Kind: var deadKind } && deadKind != Combat.NpcKindBrigand)
    {
        Fail($"pad C kind={deadKind} after death");
        return;
    }
    await PumpUntil(() =>
    {
        var n = FindNpc(conn, padC.NpcId);
        return n is { Hp: > 0, Kind: Combat.NpcKindBrigand }
            && Dist(n.X, n.Z, Combat.HostileSpawnCx, Combat.HostileSpawnCz) < 0.6f;
    }, timeoutMs, conn, "C linger respawn");
    AssertDummyTrainer(conn, dummyId, "after C linger");
    if (FindNpc(conn, padA.NpcId) is not { Hp: > 0, Kind: Combat.NpcKindHostile })
    {
        Fail("pad A not living Kind=2 after C cycle");
        return;
    }
    if (FindNpc(conn, padB.NpcId) is not { Hp: > 0, Kind: Combat.NpcKindHostile })
    {
        Fail("pad B not living Kind=2 after C cycle");
        return;
    }

    Console.WriteLine("OK: HostileRespawnSmoke passed");
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

static void AssertDummyTrainer(DbConnection conn, ulong dummyId, string when)
{
    var dummy = FindDummy(conn);
    if (dummy is null || dummy.NpcId != dummyId)
    {
        Fail($"dummy trainer gone {when}");
        Environment.Exit(1);
    }
    if (dummy.Kind != Combat.NpcKindDummy)
    {
        Fail($"dummy kind={dummy.Kind} {when}");
        Environment.Exit(1);
    }
    if (Combat.IsHostileKind(dummy.Kind))
    {
        Fail($"dummy became hostile {when}");
        Environment.Exit(1);
    }
}

static async Task KillNpc(DbConnection conn, Identity identity, ulong npcId, int timeoutMs, string label)
{
    conn.Reducers.SetTarget(npcId);
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(identity) is { } cc && cc.TargetNpcId == npcId,
        timeoutMs, conn, "target " + label);

    while (FindNpc(conn, npcId) is { Hp: > 0 })
    {
        var before = FindNpc(conn, npcId)!.Hp;
        conn.Reducers.Cast(Combat.SpellSpark);
        await PumpUntil(() =>
        {
            var n = FindNpc(conn, npcId);
            return n is null || n.Hp < before || n.Hp == 0;
        }, timeoutMs, conn, "spark " + label);
        await DelayPump(conn, Combat.GcdMs + 50);
    }

    if (FindNpc(conn, npcId) is not { Hp: 0 })
    {
        throw new Exception(label + " did not die");
    }
}

static int CountKind(DbConnection conn, int kind)
{
    var n = 0;
    foreach (var row in conn.Db.Npc.Iter())
    {
        if (row.Kind == kind) n++;
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

static Npc? FindKindNear(DbConnection conn, int kind, float x, float z)
{
    foreach (var n in conn.Db.Npc.Iter())
    {
        if (n.Kind != kind) continue;
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
    while (guard++ < 160)
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
