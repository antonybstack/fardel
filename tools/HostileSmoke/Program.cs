using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

var uri = GameConstants.ResolveLocalUri();
var db = GameConstants.ResolveDatabaseName();
const int timeoutMs = 90000;

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

    await MoveToward(conn, identity, 0f, 0f);
    await DelayPump(conn, Combat.GcdMs + 80);
    await ProveKickNpc(conn, padA.NpcId, Combat.NpcKindHostile, dummyId, "Kind=2");
    await DelayPump(conn, Combat.GcdMs + 80);
    await ProveKickNpc(conn, padC.NpcId, Combat.NpcKindBrigand, dummyId, "Kind=3");
    await DelayPump(conn, Combat.GcdMs + 80);
    await ProveStunNpc(conn, identity, padA.NpcId, Combat.NpcKindHostile, dummyId, "Kind=2");
    await MoveToward(conn, identity, 0f, 0f);
    await DelayPump(conn, Combat.GcdMs + 80);
    await ProveStunNpc(conn, identity, padC.NpcId, Combat.NpcKindBrigand, dummyId, "Kind=3");
    await MoveToward(conn, identity, 0f, 0f);
    await DelayPump(conn, Combat.StunNpcLockMs + 200);
    await PumpUntil(() =>
    {
        var a = FindNpc(conn, padA.NpcId);
        var c = FindNpc(conn, padC.NpcId);
        return a is { Hp: > 0, Aggroed: false, Kind: Combat.NpcKindHostile }
            && Dist(a.X, a.Z, Combat.HostileSpawnAx, Combat.HostileSpawnAz) < 0.8f
            && c is { Hp: > 0, Aggroed: false, Kind: Combat.NpcKindBrigand }
            && Dist(c.X, c.Z, Combat.HostileSpawnCx, Combat.HostileSpawnCz) < 0.8f;
    }, timeoutMs, conn, "A+C home after kick/stun");
    AssertDummyTrainer(conn, dummyId, "after kick/stun");

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
    await ExpectPickupOk(conn, "corpse shard");
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

    Console.WriteLine($"OK: HostileSmoke passed kick stun types loot respawn dummy {hp0}->{hpHit}");
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

static async Task ProveKickNpc(DbConnection conn, ulong npcId, int wantKind, ulong dummyId, string label)
{
    var n0 = FindNpc(conn, npcId) ?? throw new Exception($"KickNpc {label} missing");
    if (n0.Kind != wantKind || n0.Hp <= 0)
    {
        Fail($"KickNpc {label} kind={n0.Kind} hp={n0.Hp}");
        throw new Exception("kick pre");
    }
    var dummyHp = FindDummy(conn)!.Hp;
    var x0 = n0.X;
    var z0 = n0.Z;
    await ExpectKickNpcOk(conn, npcId, label);
    await PumpUntil(() =>
    {
        var n = FindNpc(conn, npcId);
        return n is { Hp: > 0, NextSwingAtMicros: > 0 };
    }, timeoutMs, conn, $"KickNpc {label} interrupt");
    var kicked = FindNpc(conn, npcId)!;
    if (kicked.Kind != wantKind)
    {
        Fail($"KickNpc changed {label} kind={kicked.Kind}");
        throw new Exception("kick kind");
    }
    var shoved = Dist(kicked.X, kicked.Z, x0, z0);
    if (shoved < Combat.KickNpcShoveMeters * 0.5f)
    {
        Fail($"KickNpc did not shove {label} ({shoved:0.##}m)");
        throw new Exception("kick shove");
    }
    if (FindDummy(conn) is not { Hp: var dHp } || dHp != dummyHp)
    {
        Fail($"dummy trainer HP changed during KickNpc {label}");
        throw new Exception("kick dummy");
    }
    AssertDummyTrainer(conn, dummyId, $"KickNpc {label}");
    Console.WriteLine($"KickNpc {label} OK id={kicked.NpcId} shove={shoved:0.##} swingAt={kicked.NextSwingAtMicros}");
}

static async Task ProveStunNpc(
    DbConnection conn,
    Identity id,
    ulong npcId,
    int wantKind,
    ulong dummyId,
    string label)
{
    var n0 = FindNpc(conn, npcId) ?? throw new Exception($"StunNpc {label} missing");
    if (n0.Kind != wantKind || n0.Hp <= 0)
    {
        Fail($"StunNpc {label} kind={n0.Kind} hp={n0.Hp}");
        throw new Exception("stun pre");
    }
    await WalkStunRange(conn, id, n0);
    await DelayPump(conn, Combat.GcdMs + 80);
    n0 = FindNpc(conn, npcId)!;
    var dummyHp = FindDummy(conn)!.Hp;
    var x0 = n0.X;
    var z0 = n0.Z;
    await ExpectStunNpcOk(conn, npcId, label);
    await PumpUntil(() =>
    {
        var n = FindNpc(conn, npcId);
        return n is { Hp: > 0, StunnedUntilMicros: > 0 };
    }, timeoutMs, conn, $"StunNpc {label} lock");
    var stunned = FindNpc(conn, npcId)!;
    if (stunned.Kind != wantKind)
    {
        Fail($"StunNpc changed {label} kind={stunned.Kind}");
        throw new Exception("stun kind");
    }
    var lockLeft = stunned.StunnedUntilMicros - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() * 1000L;
    if (lockLeft < (long)Combat.StunNpcLockMs * 1000L / 2)
    {
        Fail($"{label} lock too short leftover={lockLeft}us");
        throw new Exception("stun lock");
    }
    var drifted = Dist(stunned.X, stunned.Z, x0, z0);
    if (drifted > Combat.HostileStepMeters * 2f)
    {
        Fail($"StunNpc {label} drifted {drifted:0.##}m during lock");
        throw new Exception("stun drift");
    }
    if (FindDummy(conn) is not { Hp: var dHp } || dHp != dummyHp)
    {
        Fail($"dummy trainer HP changed during StunNpc {label}");
        throw new Exception("stun dummy");
    }
    AssertDummyTrainer(conn, dummyId, $"StunNpc {label}");
    Console.WriteLine($"StunNpc {label} OK id={stunned.NpcId} lockLeft={lockLeft}us swingAt={stunned.NextSwingAtMicros}");
}

static async Task WalkStunRange(DbConnection conn, Identity id, Npc npc)
{
    var p = conn.Db.PlayerPose.Identity.Find(id)
        ?? throw new Exception("pose missing for stun walk");
    var toPad = Dist(p.X, p.Z, npc.X, npc.Z);
    var standOff = MathF.Min(Combat.StunRangeMeters - 0.8f, toPad - Combat.HostileAggroRadius - 0.4f);
    if (standOff < 0.5f)
    {
        Fail($"cannot stand off stun {toPad:0.##}m (stun={Combat.StunRangeMeters} aggro={Combat.HostileAggroRadius})");
        throw new Exception("stun range");
    }
    var ux = (npc.X - p.X) / toPad;
    var uz = (npc.Z - p.Z) / toPad;
    await MoveToward(conn, id, p.X + ux * (toPad - standOff), p.Z + uz * (toPad - standOff));
}

static async Task ExpectKickNpcOk(DbConnection conn, ulong npcId, string label)
{
    var tcs = new TaskCompletionSource();
    void OnKickNpc(ReducerEventContext ctx, ulong _npcId)
    {
        switch (ctx.Event.Status)
        {
            case Status.Committed: tcs.TrySetResult(); break;
            case Status.Failed(var reason): tcs.TrySetException(new Exception($"KickNpc failed ({label}): {reason}")); break;
            case Status.OutOfEnergy(_): tcs.TrySetException(new Exception($"KickNpc OOE ({label})")); break;
        }
    }
    conn.Reducers.OnKickNpc += OnKickNpc;
    try { conn.Reducers.KickNpc(npcId); await Pump(tcs.Task, timeoutMs, conn, "kick npc ok " + label); }
    finally { conn.Reducers.OnKickNpc -= OnKickNpc; }
}

static async Task ExpectStunNpcOk(DbConnection conn, ulong npcId, string label)
{
    var tcs = new TaskCompletionSource();
    void OnStunNpc(ReducerEventContext ctx, ulong _npcId)
    {
        switch (ctx.Event.Status)
        {
            case Status.Committed: tcs.TrySetResult(); break;
            case Status.Failed(var reason): tcs.TrySetException(new Exception($"StunNpc failed ({label}): {reason}")); break;
            case Status.OutOfEnergy(_): tcs.TrySetException(new Exception($"StunNpc OOE ({label})")); break;
        }
    }
    conn.Reducers.OnStunNpc += OnStunNpc;
    try { conn.Reducers.StunNpc(npcId); await Pump(tcs.Task, timeoutMs, conn, "stun npc ok " + label); }
    finally { conn.Reducers.OnStunNpc -= OnStunNpc; }
}

static async Task ExpectPickupOk(DbConnection conn, string label)
{
    var tcs = new TaskCompletionSource();
    void OnPickup(ReducerEventContext ctx)
    {
        switch (ctx.Event.Status)
        {
            case Status.Committed: tcs.TrySetResult(); break;
            case Status.Failed(var reason): tcs.TrySetException(new Exception($"Pickup failed ({label}): {reason}")); break;
            case Status.OutOfEnergy(_): tcs.TrySetException(new Exception($"Pickup OOE ({label})")); break;
        }
    }
    conn.Reducers.OnPickup += OnPickup;
    try { conn.Reducers.Pickup(); await Pump(tcs.Task, timeoutMs, conn, "pickup ok " + label); }
    finally { conn.Reducers.OnPickup -= OnPickup; }
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
