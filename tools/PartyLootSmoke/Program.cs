using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

// On dummy death: primary WorldLoot drop + extra ember_shard near each in-range
// PartyMember mate. Far mates and solo kills invent no share loot.
var uri = GameConstants.ResolveLocalUri();
var db = GameConstants.ResolveDatabaseName();
const int timeoutMs = 45000;

DbConnection? connA = null;
DbConnection? connB = null;

try
{
    var (a, idA) = await ConnectAsync("A");
    connA = a;
    Console.WriteLine("A connected " + idA);

    var (b, idB) = await ConnectAsync("B");
    connB = b;
    Console.WriteLine("B connected " + idB);

    _ = await SubscribeAll(connA, "A-all");
    _ = await SubscribeAll(connB, "B-all");

    await PumpUntilBoth(() =>
        connA.Db.Character.Identity.Find(idA) is not null
        && connB.Db.Character.Identity.Find(idB) is not null
        && connA.Db.PlayerPose.Identity.Find(idA) is not null
        && connB.Db.PlayerPose.Identity.Find(idB) is not null,
        timeoutMs, connA, connB, "chars+poses");

    // Party up A→B (both near spawn / dummy).
    connA.Reducers.InviteToParty(idB);
    await PumpUntilBoth(() => connB.Db.PartyInvite.Invitee.Find(idB) is not null,
        timeoutMs, connA, connB, "invite");
    connB.Reducers.AcceptPartyInvite();
    await PumpUntilBoth(() =>
    {
        var ma = connA.Db.PartyMember.Identity.Find(idA);
        var mb = connA.Db.PartyMember.Identity.Find(idB);
        return ma is not null && mb is not null && ma.PartyId == mb.PartyId;
    }, timeoutMs, connA, connB, "party-2");
    Console.WriteLine("partied");

    EnsureStaff(connA, idA);
    EnsureStaff(connB, idB);
    await DelayPumpBoth(connA, connB, 200);

    // Clear ground loot so counts are crisp.
    connA.Reducers.SeedLoot();
    await PumpUntilBoth(() => CountLoot(connA, Loot.EmberShardItemId) >= 1,
        timeoutMs, connA, connB, "seed clear");
    await WalkNear(connA, idA, Loot.SeedX, Loot.SeedZ);
    connA.Reducers.Pickup();
    await PumpUntilBoth(() => CountLoot(connA, Loot.EmberShardItemId) == 0,
        timeoutMs, connA, connB, "cleared seed");

    var before = CountLoot(connA, Loot.EmberShardItemId);
    var nearB0 = CountLootNear(connB, idB, Loot.PickupRangeMeters + 1.5f);

    await KillDummy(connA, idA, connB);
    await PumpUntilBoth(() => CountLoot(connA, Loot.EmberShardItemId) >= before + 2,
        timeoutMs, connA, connB, "death+share loot");

    var after = CountLoot(connA, Loot.EmberShardItemId);
    var nearB1 = CountLootNear(connB, idB, Loot.PickupRangeMeters + 1.5f);
    if (after < before + 2)
    {
        Fail($"expected >= {before + 2} loot after party kill, got {after}");
        return;
    }
    if (nearB1 <= nearB0)
    {
        Fail($"mate B expected share loot nearby ({nearB0} -> {nearB1})");
        return;
    }
    Console.WriteLine($"in-range share OK loot {before}->{after} nearB {nearB0}->{nearB1}");

    // Move B far beyond PartyShareRange; next kill must not drop near B.
    await WalkTo(connB, idB, 120f, 0f);
    await PumpUntilBoth(() =>
    {
        var p = connB.Db.PlayerPose.Identity.Find(idB);
        return p is { } pose && pose.X >= 100f;
    }, timeoutMs, connA, connB, "B far");

    // Count on B's connection (self pose always visible; A's AOI may stale B).
    var nearBFar0 = CountLootNear(connB, idB, Loot.PickupRangeMeters + 1.5f);
    if (nearBFar0 != 0)
    {
        Fail($"expected no loot near far B before kill, got {nearBFar0}");
        return;
    }
    var beforeFar = CountLoot(connA, Loot.EmberShardItemId);
    await KillDummy(connA, idA, connB);
    await PumpUntilBoth(() => CountLoot(connA, Loot.EmberShardItemId) > beforeFar,
        timeoutMs, connA, connB, "far-party kill drop");
    await DelayPumpBoth(connA, connB, 400);
    var nearBFar1 = CountLootNear(connB, idB, Loot.PickupRangeMeters + 1.5f);
    if (nearBFar1 != 0)
    {
        Fail($"far mate got share loot near them: {nearBFar1}");
        return;
    }
    // Primary death drop still lands (killer-side count grew).
    var afterFar = CountLoot(connA, Loot.EmberShardItemId);
    if (afterFar < beforeFar + 1)
    {
        Fail($"far-party kill missing primary drop {beforeFar} -> {afterFar}");
        return;
    }
    Console.WriteLine($"far mate no-share OK (loot {beforeFar}->{afterFar})");

    // Leave party; solo kill must invent only the primary death drop (+1), not +2.
    connA.Reducers.LeaveParty();
    connB.Reducers.LeaveParty();
    await PumpUntilBoth(() =>
        connA.Db.PartyMember.Identity.Find(idA) is null
        && connB.Db.PartyMember.Identity.Find(idB) is null,
        timeoutMs, connA, connB, "left party");

    // Walk A near leftover loot and clear so solo delta is readable.
    connA.Reducers.SeedLoot();
    await PumpUntilBoth(() => CountLoot(connA, Loot.EmberShardItemId) >= 1,
        timeoutMs, connA, connB, "reseed");
    await WalkNear(connA, idA, Loot.SeedX, Loot.SeedZ);
    // Keep picking until empty (SeedLoot clears+seeds one; may leave death drops elsewhere).
    for (var i = 0; i < 8 && CountLoot(connA, Loot.EmberShardItemId) > 0; i++)
    {
        var loot = FindAnyLoot(connA, Loot.EmberShardItemId);
        if (loot is null) break;
        await WalkNear(connA, idA, loot.X, loot.Z);
        connA.Reducers.Pickup();
        await DelayPumpBoth(connA, connB, 200);
    }
    await PumpUntilBoth(() => CountLoot(connA, Loot.EmberShardItemId) == 0,
        timeoutMs, connA, connB, "solo clear");

    var beforeSolo = CountLoot(connA, Loot.EmberShardItemId);
    await KillDummy(connA, idA, connB);
    await PumpUntilBoth(() => CountLoot(connA, Loot.EmberShardItemId) > beforeSolo,
        timeoutMs, connA, connB, "solo death drop");
    await DelayPumpBoth(connA, connB, 300);
    var afterSolo = CountLoot(connA, Loot.EmberShardItemId);
    if (afterSolo != beforeSolo + 1)
    {
        Fail($"solo kill loot delta {afterSolo - beforeSolo} (expected +1 primary only)");
        return;
    }
    Console.WriteLine("solo kill no-share OK");

    Console.WriteLine("OK: PartyLootSmoke passed");
    Environment.ExitCode = 0;
}
catch (Exception e)
{
    Fail(e.ToString());
}
finally
{
    try { connA?.Disconnect(); } catch { /* ignore */ }
    try { connB?.Disconnect(); } catch { /* ignore */ }
}

static void EnsureStaff(DbConnection conn, Identity id)
{
    if (conn.Db.Character.Identity.Find(id) is { StaffEquipped: false })
    {
        conn.Reducers.EquipStaff();
    }
}

static async Task KillDummy(DbConnection killer, Identity killerId, DbConnection other)
{
    killer.Reducers.EnsureTrainingDummy();
    await PumpUntilBoth(() => FindDummy(killer) is { Hp: var h } && h == Combat.DummyMaxHp,
        timeoutMs, killer, other, "dummy ready");
    var dummy = FindDummy(killer) ?? throw new Exception("no dummy");
    killer.Reducers.SetTarget(dummy.NpcId);
    await PumpUntilBoth(() =>
        killer.Db.PlayerCombat.Identity.Find(killerId) is { } cc && cc.TargetNpcId == dummy.NpcId,
        timeoutMs, killer, other, "target");

    while (FindDummy(killer) is { Hp: > 0 })
    {
        var before = FindDummy(killer)!.Hp;
        killer.Reducers.Cast(Combat.SpellSpark);
        await PumpUntilBoth(() =>
        {
            var n = FindDummy(killer);
            return n is null || n.Hp < before || n.Hp == 0;
        }, timeoutMs, killer, other, "spark tick");
        await DelayPumpBoth(killer, other, Combat.GcdMs + 50);
    }
}

static Npc? FindDummy(DbConnection conn)
{
    foreach (var n in conn.Db.Npc.Iter())
    {
        if (n.Kind == 1) return n;
    }
    return null;
}

static int CountLoot(DbConnection c, string itemId)
{
    var n = 0;
    foreach (var row in c.Db.WorldLoot.Iter())
    {
        if (row.ItemId == itemId) n++;
    }
    return n;
}

static WorldLoot? FindAnyLoot(DbConnection c, string itemId)
{
    foreach (var row in c.Db.WorldLoot.Iter())
    {
        if (row.ItemId == itemId) return row;
    }
    return null;
}

static int CountLootNear(DbConnection c, Identity who, float radius)
{
    var pose = c.Db.PlayerPose.Identity.Find(who);
    if (pose is null) return 0;
    var r2 = radius * radius;
    var n = 0;
    foreach (var row in c.Db.WorldLoot.Iter())
    {
        if (row.ItemId != Loot.EmberShardItemId) continue;
        var dx = row.X - pose.X;
        var dz = row.Z - pose.Z;
        if (dx * dx + dz * dz <= r2) n++;
    }
    return n;
}

static async Task WalkNear(DbConnection conn, Identity id, float tx, float tz)
{
    for (var i = 0; i < 80; i++)
    {
        var p = conn.Db.PlayerPose.Identity.Find(id);
        if (p is null) break;
        var dx = tx - p.X;
        var dz = tz - p.Z;
        if (dx * dx + dz * dz <= Loot.PickupRangeMeters * Loot.PickupRangeMeters * 0.25f)
        {
            return;
        }
        conn.Reducers.Move(dx, dz);
        await DelayPumpOne(conn, 40);
    }
}

static async Task WalkTo(DbConnection conn, Identity id, float tx, float tz)
{
    for (var i = 0; i < 500; i++)
    {
        var p = conn.Db.PlayerPose.Identity.Find(id);
        if (p is null)
        {
            await DelayPumpOne(conn, 30);
            continue;
        }
        var dx = tx - p.X;
        var dz = tz - p.Z;
        var dist = MathF.Sqrt(dx * dx + dz * dz);
        if (dist < 0.5f) return;
        var scale = MathF.Min(Movement.MaxStepMeters, dist) / dist;
        conn.Reducers.Move(dx * scale, dz * scale);
        await DelayPumpOne(conn, 16);
    }
}

static void Fail(string msg)
{
    Console.Error.WriteLine("FAIL: " + msg);
    Environment.ExitCode = 1;
}

static async Task<(DbConnection conn, Identity id)> ConnectAsync(string label)
{
    var tcs = new TaskCompletionSource<Identity>();
    var conn = DbConnection.Builder()
        .WithUri(uri)
        .WithDatabaseName(db)
        .OnConnect((_, identity, _) => tcs.TrySetResult(identity))
        .OnConnectError(e => tcs.TrySetException(e))
        .Build();
    await Pump(tcs.Task, timeoutMs, conn, label + "-connect");
    var id = await tcs.Task;
    return (conn, id);
}

static async Task<SubscriptionHandle> SubscribeAll(DbConnection conn, string label)
{
    var tcs = new TaskCompletionSource();
    var handle = conn.SubscriptionBuilder()
        .OnApplied(_ => tcs.TrySetResult())
        .OnError((_, e) => tcs.TrySetException(e))
        .SubscribeToAllTables();
    await Pump(tcs.Task, timeoutMs, conn, label);
    return handle;
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

static async Task PumpUntilBoth(
    Func<bool> pred,
    int timeoutMs,
    DbConnection a,
    DbConnection b,
    string label)
{
    using var cts = new CancellationTokenSource(timeoutMs);
    while (!pred() && !cts.IsCancellationRequested)
    {
        a.FrameTick();
        b.FrameTick();
        try { await Task.Delay(16, cts.Token); } catch (OperationCanceledException) { break; }
    }
    if (!pred()) throw new TimeoutException(label);
}

static async Task DelayPumpBoth(DbConnection a, DbConnection b, int ms)
{
    var until = Environment.TickCount64 + ms;
    while (Environment.TickCount64 < until)
    {
        a.FrameTick();
        b.FrameTick();
        await Task.Delay(16);
    }
}

static async Task DelayPumpOne(DbConnection a, int ms)
{
    var until = Environment.TickCount64 + ms;
    while (Environment.TickCount64 < until)
    {
        a.FrameTick();
        await Task.Delay(16);
    }
}
