using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

// YardVendor BuyFromVendor / SellToVendor — range, XP↔ember_shard.
var uri = GameConstants.ResolveLocalUri();
var db = GameConstants.ResolveDatabaseName();
const int timeoutMs = 45000;

DbConnection? conn = null;

try
{
    var (c, id) = await ConnectAsync();
    conn = c;
    Console.WriteLine("connected " + id);

    _ = await SubscribeAll(conn, "all");

    await PumpUntil(() =>
        conn.Db.PlayerPose.Identity.Find(id) is not null
        && conn.Db.Character.Identity.Find(id) is not null,
        timeoutMs, conn, "pose+char");

    await PumpUntil(() => FindVendor(conn) is not null, timeoutMs, conn, "yard vendor");
    var vendor = FindVendor(conn)!;
    Console.WriteLine($"vendor id={vendor.VendorId} at ({vendor.X},{vendor.Z}) label={vendor.Label}");

    await MoveTo(conn, id, Vendor.RangeMeters * 4f, 0f);
    string? rangeFail = null;
    var rangeFailed = new TaskCompletionSource();
    void OnBuyFar(ReducerEventContext ctx)
    {
        switch (ctx.Event.Status)
        {
            case Status.Failed(var reason):
                rangeFail = reason;
                rangeFailed.TrySetResult();
                break;
            case Status.Committed:
                rangeFailed.TrySetException(new Exception("BuyFromVendor committed while out of range"));
                break;
            case Status.OutOfEnergy(_):
                rangeFailed.TrySetException(new Exception("BuyFromVendor out of energy"));
                break;
        }
    }
    conn.Reducers.OnBuyFromVendor += OnBuyFar;
    try
    {
        conn.Reducers.BuyFromVendor();
        await Pump(rangeFailed.Task, timeoutMs, conn, "buy out of range");
    }
    finally
    {
        conn.Reducers.OnBuyFromVendor -= OnBuyFar;
    }
    if (string.IsNullOrEmpty(rangeFail) ||
        rangeFail.IndexOf("Out of range", StringComparison.OrdinalIgnoreCase) < 0)
    {
        Fail($"expected Out of range on BuyFromVendor, got: {rangeFail ?? "(null)"}");
        return;
    }
    Console.WriteLine("out-of-range BuyFromVendor reject OK");

    await MoveTo(conn, id, vendor.X + 0.8f, vendor.Z + 0.4f);

    var chPrep = conn.Db.Character.Identity.Find(id)!;
    if (chPrep.HasEmberShard)
    {
        conn.Reducers.SellToVendor();
        await PumpUntil(() => conn.Db.Character.Identity.Find(id) is { HasEmberShard: false },
            timeoutMs, conn, "clear shard");
    }

    var ch0 = conn.Db.Character.Identity.Find(id)!;
    if (ch0.Xp < Vendor.BuyPriceXp)
    {
        conn.Reducers.EnsureTrainingDummy();
        await PumpUntil(() => FindDummy(conn) is { Hp: var h } && h == Combat.DummyMaxHp,
            timeoutMs, conn, "dummy");
        if (conn.Db.Character.Identity.Find(id) is { StaffEquipped: false })
        {
            conn.Reducers.EquipStaff();
            await PumpUntil(() => conn.Db.Character.Identity.Find(id) is { StaffEquipped: true },
                timeoutMs, conn, "staff");
        }
        var dummy = FindDummy(conn)!;
        conn.Reducers.SetTarget(dummy.NpcId);
        while (FindDummy(conn) is { Hp: > 0 } d)
        {
            var before = d.Hp;
            conn.Reducers.Cast(Combat.SpellSpark);
            await PumpUntil(() =>
            {
                var n = FindDummy(conn);
                return n is null || n.Hp < before || n.Hp == 0;
            }, timeoutMs, conn, "spark");
            await DelayPump(conn, Combat.GcdMs + 40);
        }
        await PumpUntil(() => conn.Db.Character.Identity.Find(id)!.Xp >= Vendor.BuyPriceXp,
            timeoutMs, conn, "xp from kill");
        await MoveTo(conn, id, vendor.X + 0.8f, vendor.Z + 0.4f);
    }

    var xpBeforeBuy = conn.Db.Character.Identity.Find(id)!.Xp;
    Console.WriteLine($"XP before buy={xpBeforeBuy}");

    conn.Reducers.BuyFromVendor();
    await PumpUntil(() =>
    {
        var ch = conn.Db.Character.Identity.Find(id);
        return ch is { HasEmberShard: true } && ch.Xp == xpBeforeBuy - Vendor.BuyPriceXp;
    }, timeoutMs, conn, "buy shard");
    Console.WriteLine($"BuyFromVendor OK shard + XP {xpBeforeBuy}→{conn.Db.Character.Identity.Find(id)!.Xp}");

    var xpBeforeSell = conn.Db.Character.Identity.Find(id)!.Xp;
    conn.Reducers.SellToVendor();
    await PumpUntil(() =>
    {
        var ch = conn.Db.Character.Identity.Find(id);
        return ch is { HasEmberShard: false } && ch.Xp == xpBeforeSell + Vendor.SellPriceXp;
    }, timeoutMs, conn, "sell shard");
    Console.WriteLine($"SellToVendor OK XP {xpBeforeSell}→{conn.Db.Character.Identity.Find(id)!.Xp}");

    var xpFinal = conn.Db.Character.Identity.Find(id)!.Xp;
    if (Vendor.BuyPriceXp == Vendor.SellPriceXp && xpFinal != xpBeforeBuy)
    {
        Fail($"expected XP restored to {xpBeforeBuy}, got {xpFinal}");
        return;
    }

    Console.WriteLine("OK: VendorSmoke passed");
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

static YardVendor? FindVendor(DbConnection c)
{
    foreach (var v in c.Db.YardVendor.Iter()) return v;
    return null;
}

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

static async Task<(DbConnection conn, Identity id)> ConnectAsync()
{
    var connected = new TaskCompletionSource<Identity>();
    var conn = DbConnection.Builder()
        .WithUri(uri)
        .WithDatabaseName(db)
        .OnConnect((_, identity, _) => connected.TrySetResult(identity))
        .OnConnectError(e => connected.TrySetException(e))
        .Build();
    await Pump(connected.Task, timeoutMs, conn, "connect");
    return (conn, await connected.Task);
}

static async Task<SubscriptionHandle> SubscribeAll(DbConnection conn, string label)
{
    var subscribed = new TaskCompletionSource();
    var handle = conn.SubscriptionBuilder()
        .OnApplied(_ => subscribed.TrySetResult())
        .OnError((_, e) => subscribed.TrySetException(e))
        .SubscribeToAllTables();
    await Pump(subscribed.Task, timeoutMs, conn, label);
    return handle;
}

static async Task MoveTo(DbConnection conn, Identity id, float x, float z)
{
    for (var i = 0; i < 80; i++)
    {
        var p = conn.Db.PlayerPose.Identity.Find(id);
        if (p is null) break;
        var dx = x - p.X;
        var dz = z - p.Z;
        if (dx * dx + dz * dz < 0.05f) break;
        conn.Reducers.Move(dx, dz);
        await DelayPump(conn, 40);
    }
    await PumpUntil(() =>
    {
        var p = conn.Db.PlayerPose.Identity.Find(id);
        if (p is null) return false;
        var dx = x - p.X;
        var dz = z - p.Z;
        return dx * dx + dz * dz < 0.25f;
    }, timeoutMs, conn, $"move-to ({x},{z})");
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
