using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

// WorldLoot seed + Pickup range/grant/despawn + dummy-death drop.
var uri = GameConstants.ResolveLocalUri();
var db = GameConstants.ResolveDatabaseName();
const int timeoutMs = 30000;

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

    await PumpUntil(() => conn.Db.Character.Identity.Find(identity) is not null, timeoutMs, conn, "character ready");
    await PumpUntil(() => conn.Db.PlayerPose.Identity.Find(identity) is not null, timeoutMs, conn, "pose ready");

    // Walk far first, then seed loot at origin so Pickup must fail range.
    for (var i = 0; i < 24; i++)
    {
        conn.Reducers.Move(Loot.PickupRangeMeters, 0f, false);
        await DelayPump(conn, 40);
    }
    await PumpUntil(() =>
    {
        var p = conn.Db.PlayerPose.Identity.Find(identity);
        return p is { } pose && pose.X >= Loot.PickupRangeMeters * 4 ;
    }, timeoutMs, conn, "moved far");

    conn.Reducers.SeedLoot();
    // Wait for SeedLoot commit (exact seed pose) — leftover death drops must not win the race.
    await PumpUntil(() =>
    {
        foreach (var row in conn.Db.WorldLoot.Iter())
        {
            if (row.ItemId != Loot.EmberShardItemId) continue;
            if (MathF.Abs(row.X - Loot.SeedX) < 0.05f && MathF.Abs(row.Z - Loot.SeedZ) < 0.05f)
                return CountLoot(conn, Loot.EmberShardItemId) == 1;
        }
        return false;
    }, timeoutMs, conn, "seed loot");
    var seed = FindLoot(conn, Loot.EmberShardItemId) ?? throw new Exception("no seed loot");
    Console.WriteLine($"seed loot id={seed.LootId} at ({seed.X},{seed.Z}) item={seed.ItemId}");

    string? rangeFail = null;
    var rangeFailed = new TaskCompletionSource();
    void OnPickupFar(ReducerEventContext ctx)
    {
        switch (ctx.Event.Status)
        {
            case Status.Failed(var reason):
                rangeFail = reason;
                rangeFailed.TrySetResult();
                break;
            case Status.Committed:
                rangeFailed.TrySetException(new Exception("Pickup committed while out of range"));
                break;
            case Status.OutOfEnergy(_):
                rangeFailed.TrySetException(new Exception("Pickup out of energy"));
                break;
        }
    }
    conn.Reducers.OnPickup += OnPickupFar;
    try
    {
        conn.Reducers.Pickup();
        await Pump(rangeFailed.Task, timeoutMs, conn, "pickup out of range");
    }
    finally
    {
        conn.Reducers.OnPickup -= OnPickupFar;
    }
    if (string.IsNullOrEmpty(rangeFail) ||
        rangeFail.IndexOf("Out of range", StringComparison.OrdinalIgnoreCase) < 0)
    {
        Fail($"expected Out of range, got: {rangeFail ?? "(null)"}");
        return;
    }
    Console.WriteLine("out-of-range reject OK");

    for (var i = 0; i < 40; i++)
    {
        var p = conn.Db.PlayerPose.Identity.Find(identity);
        if (p is null) break;
        var dx = seed.X - p.X;
        var dz = seed.Z - p.Z;
        if (dx * dx + dz * dz <= Loot.PickupRangeMeters * Loot.PickupRangeMeters)
        {
            break;
        }
        conn.Reducers.Move(dx, dz, false);
        await DelayPump(conn, 40);
    }
    await PumpUntil(() =>
    {
        var p = conn.Db.PlayerPose.Identity.Find(identity);
       if (p is null) return false;
        var dx = seed.X - p.X;
        var dz = seed.Z - p.Z;
        return dx * dx + dz * dz <= Loot.PickupRangeMeters * Loot.PickupRangeMeters;
    }, timeoutMs, conn, "back in range");

    var xpBefore = conn.Db.Character.Identity.Find(identity)!.Xp;
    var lootId = seed.LootId;

    conn.Reducers.Pickup();
    await PumpUntil(() =>
    {
        var ch = conn.Db.Character.Identity.Find(identity);
        if (ch is null) return false;
        if (ch.Xp < xpBefore + Loot.XpPerEmberShard) return false;
        if (!ch.HasEmberShard) return false;
        return FindLootById(conn, lootId) is null;
    }, timeoutMs, conn, "pickup grant+despawn");

    var xpAfter = conn.Db.Character.Identity.Find(identity)!.Xp;
    Console.WriteLine($"pickup OK xp {xpBefore}->{xpAfter} despawned");

    conn.Reducers.EnsureTrainingDummy();
    await PumpUntil(() => FindDummy(conn) is { Hp: var h } && h == Combat.DummyMaxHp, timeoutMs, conn, "dummy ready");

    conn.Reducers.SeedLoot();
    await PumpUntil(() =>
    {
        foreach (var row in conn.Db.WorldLoot.Iter())
        {
            if (row.ItemId != Loot.EmberShardItemId) continue;
            if (MathF.Abs(row.X - Loot.SeedX) < 0.05f && MathF.Abs(row.Z - Loot.SeedZ) < 0.05f)
                return true;
        }
        return false;
    }, timeoutMs, conn, "seed before clear");
    var leftover = FindLoot(conn, Loot.EmberShardItemId)!;
    conn.Reducers.Pickup();
    await PumpUntil(() => FindLootById(conn, leftover.LootId) is null, timeoutMs, conn, "clear leftover");

    var lootCountBeforeKill = CountLoot(conn, Loot.EmberShardItemId);
    var dummy = FindDummy(conn)!;
    conn.Reducers.SetTarget(dummy.NpcId);
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(identity) is { } cc && cc.TargetNpcId == dummy.NpcId,
        timeoutMs, conn, "target set");

    var ch0 = conn.Db.Character.Identity.Find(identity)!;
    if (!ch0.StaffEquipped)
    {
        conn.Reducers.EquipStaff();
        await PumpUntil(() => conn.Db.Character.Identity.Find(identity) is { StaffEquipped: true }, timeoutMs, conn, "equip staff");
    }

    while (FindDummy(conn) is { Hp: > 0 })
    {
        var before = FindDummy(conn)!.Hp;
        conn.Reducers.Cast(Combat.SpellSpark);
        await PumpUntil(() =>
        {
            var n = FindDummy(conn);
            return n is null || n.Hp < before || n.Hp == 0;
        }, timeoutMs, conn, "spark tick");
        await DelayPump(conn, Combat.GcdMs + 50);
    }

    await PumpUntil(() => CountLoot(conn, Loot.EmberShardItemId) > lootCountBeforeKill, timeoutMs, conn, "death drop");
    var drop = FindLoot(conn, Loot.EmberShardItemId)!;
    Console.WriteLine($"death drop OK id={drop.LootId} at ({drop.X:F1},{drop.Z:F1})");

    Console.WriteLine("OK: LootSmoke passed");
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

static int CountLoot(DbConnection c, string itemId)
{
    var n = 0;
    foreach (var row in c.Db.WorldLoot.Iter())
    {
        if (row.ItemId == itemId) n++;
    }
    return n;
}

static WorldLoot? FindLoot(DbConnection c, string itemId)
{
    foreach (var row in c.Db.WorldLoot.Iter())
    {
        if (row.ItemId == itemId) return row;
    }
    return null;
}

static WorldLoot? FindLootById(DbConnection c, ulong lootId) => c.Db.WorldLoot.LootId.Find(lootId);

static Npc? FindDummy(DbConnection c)
{
    foreach (var n in c.Db.Npc.Iter())
    {
        if (n.Kind == 1) return n;
    }
    return null;
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
    using var cts = new CancellationTokenSource(ms + 2000);
    var end = DateTime.UtcNow.AddMilliseconds(ms);
    while (DateTime.UtcNow < end && !cts.IsCancellationRequested)
    {
        conn.FrameTick();
        try { await Task.Delay(16, cts.Token); } catch (OperationCanceledException) { break; }
    }
}
