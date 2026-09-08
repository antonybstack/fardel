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

    if (conn.Db.Character.Identity.Find(identity) is { StaffEquipped: false })
    {
        conn.Reducers.EquipStaff();
        await PumpUntil(() => conn.Db.Character.Identity.Find(identity) is { StaffEquipped: true },
            timeoutMs, conn, "staff equipped");
    }

    await PumpUntil(() => CountHostiles(conn) >= 2, timeoutMs, conn, "two hostiles");
    var dummy = FindDummy(conn) ?? throw new Exception("dummy trainer missing");
    if (dummy.Kind != Combat.NpcKindDummy || dummy.Hp <= 0)
    {
        Fail($"dummy kind={dummy.Kind} hp={dummy.Hp}");
        return;
    }
    var dummyId = dummy.NpcId;

    var padA = FindHostileNear(conn, Combat.HostileSpawnAx, Combat.HostileSpawnAz)
        ?? throw new Exception("hostile pad A missing");
    var padB = FindHostileNear(conn, Combat.HostileSpawnBx, Combat.HostileSpawnBz)
        ?? throw new Exception("hostile pad B missing");
    var padC = FindKindNear(conn, Combat.NpcKindBrigand, Combat.HostileSpawnCx, Combat.HostileSpawnCz)
        ?? throw new Exception("brigand pad C missing");
    if (padA.Kind != Combat.NpcKindHostile || padB.Kind != Combat.NpcKindHostile)
    {
        Fail($"kinds A={padA.Kind} B={padB.Kind}");
        return;
    }
    if (padC.Kind != Combat.NpcKindBrigand || padC.Hp <= 0)
    {
        Fail($"pad C kind={padC.Kind} hp={padC.Hp} want Kind=3 living");
        return;
    }
    if (padA.Hp <= 0 || padA.MaxHp != Combat.HostileMaxHp || padB.Hp <= 0)
    {
        Fail($"hp A={padA.Hp}/{padA.MaxHp} B={padB.Hp}/{padB.MaxHp}");
        return;
    }
    if (padA.Aggroed || padB.Aggroed)
    {
        Fail("hostiles aggroed at spawn (origin should be outside AggroRadius)");
        return;
    }
    Console.WriteLine($"spawn A id={padA.NpcId} B id={padB.NpcId} C id={padC.NpcId} dummy id={dummyId}");

    var hp0 = conn.Db.Character.Identity.Find(identity)!.Hp;
    if (hp0 <= Combat.HostileAttackDamage)
    {
        Fail($"hp {hp0} too low to prove a swing");
        return;
    }

    var a0x = padA.X;
    var a0z = padA.Z;
    await MoveToward(conn, identity, Combat.HostileSpawnAx, Combat.HostileSpawnAz);
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
    if (stillB.Aggroed)
    {
        Fail("hostile B aggroed while pulling A");
        return;
    }
    Console.WriteLine($"aggro A xz=({pulled.X:0.##},{pulled.Z:0.##}) aggro={pulled.Aggroed}");

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
    Console.WriteLine($"damage hp {hp0}->{hpHit}");

    conn.Reducers.SetTarget(padA.NpcId);
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(identity) is { } cc && cc.TargetNpcId == padA.NpcId,
        timeoutMs, conn, "target A");

    while (FindNpc(conn, padA.NpcId) is { Hp: > 0 })
    {
        var ch = conn.Db.Character.Identity.Find(identity);
        if (ch is null || ch.Hp <= 0)
        {
            Fail("player died before hostile death");
            return;
        }
        var before = FindNpc(conn, padA.NpcId)!.Hp;
        conn.Reducers.Cast(Combat.SpellSpark);
        await PumpUntil(() =>
        {
            var n = FindNpc(conn, padA.NpcId);
            return n is null || n.Hp < before || n.Hp == 0;
        }, timeoutMs, conn, "spark tick");
        await DelayPump(conn, Combat.GcdMs + 50);
    }

    var dead = FindNpc(conn, padA.NpcId);
    if (dead is null || dead.Hp != 0)
    {
        Fail($"hostile A did not die (hp={dead?.Hp})");
        return;
    }
    if (FindNpc(conn, padB.NpcId) is not { Hp: > 0 })
    {
        Fail("hostile B died with A");
        return;
    }
    AssertDummyTrainer(conn, dummyId, "after A death");
    if (FindNpc(conn, padC.NpcId) is not { Hp: > 0, Kind: Combat.NpcKindBrigand })
    {
        Fail("brigand C gone after killing A");
        return;
    }

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
    AssertDummyTrainer(conn, dummyId, "after A loot respawn");
    Console.WriteLine($"loot-respawn A id={padA.NpcId} hp={FindNpc(conn, padA.NpcId)!.Hp}");

    // Pickup is on the pad — break leash before the Kind=3 cycle.
    await MoveToward(conn, identity, -8f, -8f);
    await PumpUntil(() =>
    {
        var n = FindNpc(conn, padA.NpcId);
        return n is { Hp: > 0, Aggroed: false }
            && Dist(n.X, n.Z, Combat.HostileSpawnAx, Combat.HostileSpawnAz) < 0.8f;
    }, timeoutMs, conn, "A leashed home");
    await MoveToward(conn, identity, 0f, 0f);
    await DelayPump(conn, Combat.GcdMs + 80);

    conn.Reducers.SetTarget(padC.NpcId);
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(identity) is { } cc && cc.TargetNpcId == padC.NpcId,
        timeoutMs, conn, "target C");
    while (FindNpc(conn, padC.NpcId) is { Hp: > 0 })
    {
        var ch = conn.Db.Character.Identity.Find(identity);
        if (ch is null || ch.Hp <= 0)
        {
            Fail("player died before brigand death");
            return;
        }
        var before = FindNpc(conn, padC.NpcId)!.Hp;
        conn.Reducers.Cast(Combat.SpellSpark);
        await PumpUntil(() =>
        {
            var n = FindNpc(conn, padC.NpcId);
            return n is null || n.Hp < before || n.Hp == 0;
        }, timeoutMs, conn, "spark C");
        await DelayPump(conn, Combat.GcdMs + 50);
    }
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

    Console.WriteLine($"OK: HostileSmoke passed types loot respawn dummy {hp0}->{hpHit}");
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

static void AssertDummyTrainer(DbConnection conn, ulong dummyId, string when)
{
    var dummy = FindDummy(conn);
    if (dummy is null || dummy.NpcId != dummyId || dummy.Kind != Combat.NpcKindDummy)
    {
        Fail($"dummy trainer gone {when} kind={dummy?.Kind}");
        Environment.Exit(1);
    }
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
