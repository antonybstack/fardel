using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

const string uri = GameConstants.DefaultLocalUri;
const string db = GameConstants.DefaultDatabaseName;
const int timeoutMs = 45000;
DbConnection? conn = null;

try
{
    var (c, id) = await ConnectAsync();
    conn = c;
    Console.WriteLine("connected " + id);
    _ = await SubscribeAll(conn, "all");
    await PumpUntil(() => conn.Db.PlayerPose.Identity.Find(id) is not null && conn.Db.Character.Identity.Find(id) is not null, timeoutMs, conn, "pose+char");

    conn.Reducers.EnsureVendor();
    await PumpUntil(() => FindVendor(conn) is not null, timeoutMs, conn, "yard vendor");
    await PumpUntil(() => conn.Db.VendorStock.ItemId.Find(Vendor.TonicItemId) is { Qty: > 0 }, timeoutMs, conn, "vendor stock");
    Console.WriteLine("vendor + stock ready");

    await MoveTo(conn, id, Vendor.RangeMeters * 4f, 0f);
    string? rangeFail = null;
    var rangeFailed = new TaskCompletionSource();
    void OnBuyFar(ReducerEventContext ctx, bool _pay)
    {
        switch (ctx.Event.Status)
        {
            case Status.Failed(var reason): rangeFail = reason; rangeFailed.TrySetResult(); break;
            case Status.Committed: rangeFailed.TrySetException(new Exception("BuyFromVendor committed while out of range")); break;
            case Status.OutOfEnergy(_): rangeFailed.TrySetException(new Exception("BuyFromVendor out of energy")); break;
        }
    }
    conn.Reducers.OnBuyFromVendor += OnBuyFar;
    try { conn.Reducers.BuyFromVendor(false); await Pump(rangeFailed.Task, timeoutMs, conn, "buy out of range"); }
    finally { conn.Reducers.OnBuyFromVendor -= OnBuyFar; }
    if (string.IsNullOrEmpty(rangeFail) || rangeFail.IndexOf("Out of range", StringComparison.OrdinalIgnoreCase) < 0)
    { Fail($"expected Out of range on BuyFromVendor, got: {rangeFail ?? "(null)"}"); return; }
    Console.WriteLine("out-of-range BuyFromVendor reject OK");

    var vendor = FindVendor(conn)!;
    await MoveTo(conn, id, vendor.X + 0.8f, vendor.Z + 0.4f);

    if (conn.Db.Character.Identity.Find(id)!.Xp < Vendor.BuyXpCost)
    {
        conn.Reducers.EnsureTrainingDummy();
        await PumpUntil(() => FindDummy(conn) is { Hp: var h } && h == Combat.DummyMaxHp, timeoutMs, conn, "dummy");
        if (conn.Db.Character.Identity.Find(id) is { StaffEquipped: false })
        {
            conn.Reducers.EquipStaff();
            await PumpUntil(() => conn.Db.Character.Identity.Find(id) is { StaffEquipped: true }, timeoutMs, conn, "staff");
        }
        while (FindDummy(conn) is { Hp: > 0 } d)
        {
            var before = d.Hp;
            conn.Reducers.SetTarget(d.NpcId);
            conn.Reducers.Cast(Combat.SpellSpark);
            await PumpUntil(() => { var n = FindDummy(conn); return n is null || n.Hp < before || n.Hp == 0; }, timeoutMs, conn, "spark");
            await DelayPump(conn, Combat.GcdMs + 40);
        }
        await PumpUntil(() => conn.Db.Character.Identity.Find(id)!.Xp >= Vendor.BuyXpCost, timeoutMs, conn, "xp for buy");
        vendor = FindVendor(conn)!;
        await MoveTo(conn, id, vendor.X + 0.8f, vendor.Z + 0.4f);
    }

    var xpBefore = conn.Db.Character.Identity.Find(id)!.Xp;
    var qtyBefore = conn.Db.VendorStock.ItemId.Find(Vendor.TonicItemId)!.Qty;
    conn.Reducers.BuyFromVendor(false);
    await PumpUntil(() => {
        var ch = conn.Db.Character.Identity.Find(id);
        var st = conn.Db.VendorStock.ItemId.Find(Vendor.TonicItemId);
        return ch is { HasYardTonic: true } && ch.Xp == xpBefore - Vendor.BuyXpCost && st is not null && st.Qty == qtyBefore - 1;
    }, timeoutMs, conn, "buy with XP");
    Console.WriteLine("BuyFromVendor XP OK");

    string? dupFail = null;
    var dupFailed = new TaskCompletionSource();
    void OnBuyDup(ReducerEventContext ctx, bool _pay)
    {
        switch (ctx.Event.Status)
        {
            case Status.Failed(var reason): dupFail = reason; dupFailed.TrySetResult(); break;
            case Status.Committed: dupFailed.TrySetException(new Exception("duplicate BuyFromVendor committed")); break;
            case Status.OutOfEnergy(_): dupFailed.TrySetException(new Exception("BuyFromVendor out of energy")); break;
        }
    }
    conn.Reducers.OnBuyFromVendor += OnBuyDup;
    try { conn.Reducers.BuyFromVendor(false); await Pump(dupFailed.Task, timeoutMs, conn, "dup buy"); }
    finally { conn.Reducers.OnBuyFromVendor -= OnBuyDup; }
    if (string.IsNullOrEmpty(dupFail) || dupFail.IndexOf("Already have tonic", StringComparison.OrdinalIgnoreCase) < 0)
    { Fail($"expected Already have tonic, got: {dupFail ?? "(null)"}"); return; }
    Console.WriteLine("duplicate BuyFromVendor reject OK");

    conn.Reducers.SeedLoot();
    await PumpUntil(() => CountLoot(conn) >= 1, timeoutMs, conn, "seed loot");
    await MoveTo(conn, id, Loot.SeedX, Loot.SeedZ);
    conn.Reducers.Pickup();
    await PumpUntil(() => conn.Db.Character.Identity.Find(id) is { HasEmberShard: true }, timeoutMs, conn, "has shard");
    vendor = FindVendor(conn)!;
    await MoveTo(conn, id, vendor.X + 0.8f, vendor.Z + 0.4f);
    var xpSellBefore = conn.Db.Character.Identity.Find(id)!.Xp;
    conn.Reducers.SellToVendor();
    await PumpUntil(() => {
        var ch = conn.Db.Character.Identity.Find(id);
        return ch is { HasEmberShard: false } && ch.Xp >= xpSellBefore + Vendor.SellShardXp;
    }, timeoutMs, conn, "sell shard");
    Console.WriteLine($"SellToVendor OK (+{Vendor.SellShardXp} XP)");

    var (connB, idB) = await ConnectAsync();
    try
    {
        _ = await SubscribeAll(connB, "B-all");
        await PumpUntilBoth(() => connB.Db.PlayerPose.Identity.Find(idB) is not null && connB.Db.Character.Identity.Find(idB) is not null, timeoutMs, conn, connB, "B pose+char");
        connB.Reducers.EnsureVendor();
        vendor = FindVendor(connB)!;
        await MoveToBoth(connB, idB, vendor.X + 1.0f, vendor.Z, conn);
        connB.Reducers.SeedLoot();
        await PumpUntilBoth(() => CountLoot(connB) >= 1, timeoutMs, conn, connB, "B seed");
        await MoveToBoth(connB, idB, Loot.SeedX, Loot.SeedZ, conn);
        connB.Reducers.Pickup();
        await PumpUntilBoth(() => connB.Db.Character.Identity.Find(idB) is { HasEmberShard: true }, timeoutMs, conn, connB, "B shard");
        vendor = FindVendor(connB)!;
        await MoveToBoth(connB, idB, vendor.X + 0.8f, vendor.Z + 0.4f, conn);
        var qtyB = connB.Db.VendorStock.ItemId.Find(Vendor.TonicItemId)!.Qty;
        connB.Reducers.BuyFromVendor(true);
        await PumpUntilBoth(() => {
            var ch = connB.Db.Character.Identity.Find(idB);
            var st = connB.Db.VendorStock.ItemId.Find(Vendor.TonicItemId);
            return ch is { HasYardTonic: true, HasEmberShard: false } && st is not null && st.Qty == qtyB - 1;
        }, timeoutMs, conn, connB, "B buy shard");
        Console.WriteLine("BuyFromVendor(shard) OK");
    }
    finally { try { connB.Disconnect(); } catch { } }

    Console.WriteLine("OK: VendorSmoke passed");
    Environment.ExitCode = 0;
}
catch (Exception e) { Fail(e.ToString()); }
finally { try { conn?.Disconnect(); } catch { } }

static int CountLoot(DbConnection c) { var n = 0; foreach (var _ in c.Db.WorldLoot.Iter()) n++; return n; }
static YardVendor? FindVendor(DbConnection c) { foreach (var v in c.Db.YardVendor.Iter()) return v; return null; }
static Npc? FindDummy(DbConnection c) { foreach (var n in c.Db.Npc.Iter()) if (n.Kind == 1) return n; return null; }
static void Fail(string msg) { Console.Error.WriteLine("FAIL: " + msg); Environment.ExitCode = 1; }

static async Task<(DbConnection conn, Identity id)> ConnectAsync()
{
    var connected = new TaskCompletionSource<Identity>();
    var conn = DbConnection.Builder().WithUri(uri).WithDatabaseName(db)
        .OnConnect((_, identity, _) => connected.TrySetResult(identity))
        .OnConnectError(e => connected.TrySetException(e)).Build();
    await Pump(connected.Task, timeoutMs, conn, "connect");
    return (conn, await connected.Task);
}
static async Task<SubscriptionHandle> SubscribeAll(DbConnection conn, string label)
{
    var subscribed = new TaskCompletionSource();
    var handle = conn.SubscriptionBuilder().OnApplied(_ => subscribed.TrySetResult()).OnError((_, e) => subscribed.TrySetException(e)).SubscribeToAllTables();
    await Pump(subscribed.Task, timeoutMs, conn, label);
    return handle;
}
static async Task MoveTo(DbConnection mover, Identity id, float x, float z)
{
    for (var i = 0; i < 100; i++)
    {
        var p = mover.Db.PlayerPose.Identity.Find(id); if (p is null) break;
        var dx = x - p.X; var dz = z - p.Z; if (dx * dx + dz * dz < 0.05f) break;
        mover.Reducers.Move(dx, dz); await DelayPump(mover, 40);
    }
    await PumpUntil(() => { var p = mover.Db.PlayerPose.Identity.Find(id); if (p is null) return false; var dx = x - p.X; var dz = z - p.Z; return dx * dx + dz * dz < 0.35f; }, timeoutMs, mover, $"move-to ({x},{z})");
}
static async Task MoveToBoth(DbConnection mover, Identity id, float x, float z, DbConnection other)
{
    for (var i = 0; i < 100; i++)
    {
        var p = mover.Db.PlayerPose.Identity.Find(id); if (p is null) break;
        var dx = x - p.X; var dz = z - p.Z; if (dx * dx + dz * dz < 0.05f) break;
        mover.Reducers.Move(dx, dz); await DelayPumpBoth(mover, other, 40);
    }
    await PumpUntilBoth(() => { var p = mover.Db.PlayerPose.Identity.Find(id); if (p is null) return false; var dx = x - p.X; var dz = z - p.Z; return dx * dx + dz * dz < 0.35f; }, timeoutMs, mover, other, $"move-to ({x},{z})");
}
static async Task Pump(Task task, int timeoutMs, DbConnection conn, string label)
{
    using var cts = new CancellationTokenSource(timeoutMs);
    while (!task.IsCompleted && !cts.IsCancellationRequested) { conn.FrameTick(); try { await Task.Delay(16, cts.Token); } catch (OperationCanceledException) { break; } }
    if (!task.IsCompleted) throw new TimeoutException(label); await task;
}
static async Task PumpUntil(Func<bool> pred, int timeoutMs, DbConnection conn, string label)
{
    using var cts = new CancellationTokenSource(timeoutMs);
    while (!pred() && !cts.IsCancellationRequested) { conn.FrameTick(); try { await Task.Delay(16, cts.Token); } catch (OperationCanceledException) { break; } }
    if (!pred()) throw new TimeoutException(label);
}
static async Task PumpUntilBoth(Func<bool> pred, int timeoutMs, DbConnection a, DbConnection b, string label)
{
    using var cts = new CancellationTokenSource(timeoutMs);
    while (!pred() && !cts.IsCancellationRequested) { a.FrameTick(); b.FrameTick(); try { await Task.Delay(16, cts.Token); } catch (OperationCanceledException) { break; } }
    if (!pred()) throw new TimeoutException(label);
}
static async Task DelayPump(DbConnection conn, int ms)
{
    using var cts = new CancellationTokenSource(ms + 2000);
    var end = DateTime.UtcNow.AddMilliseconds(ms);
    while (DateTime.UtcNow < end && !cts.IsCancellationRequested) { conn.FrameTick(); try { await Task.Delay(16, cts.Token); } catch (OperationCanceledException) { break; } }
}
static async Task DelayPumpBoth(DbConnection a, DbConnection b, int ms)
{
    using var cts = new CancellationTokenSource(ms + 2000);
    var end = DateTime.UtcNow.AddMilliseconds(ms);
    while (DateTime.UtcNow < end && !cts.IsCancellationRequested) { a.FrameTick(); b.FrameTick(); try { await Task.Delay(16, cts.Token); } catch (OperationCanceledException) { break; } }
}
