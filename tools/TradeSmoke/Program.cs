using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

// TradeOffer Offer/Accept/Cancel + range + HasEmberShard / XP transfer.
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
        connA.Db.PlayerPose.Identity.Find(idA) is not null
        && connB.Db.PlayerPose.Identity.Find(idB) is not null
        && connA.Db.Character.Identity.Find(idA) is not null
        && connB.Db.Character.Identity.Find(idB) is not null,
        timeoutMs, connA, connB, "poses+chars");

    // Park both near spawn so range checks are meaningful.
    await MoveTo(connA, idA, 0f, 0f, connB);
    await MoveTo(connB, idB, 1.5f, 0f, connA);

    // Grant A an ember shard via SeedLoot + Pickup.
    connA.Reducers.SeedLoot();
    await PumpUntilBoth(() => CountLoot(connA) >= 1, timeoutMs, connA, connB, "seed loot");
    connA.Reducers.Pickup();
    await PumpUntilBoth(() =>
        connA.Db.Character.Identity.Find(idA) is { HasEmberShard: true },
        timeoutMs, connA, connB, "A has shard");
    Console.WriteLine("A has ember shard");

    // Move B far — OfferTrade must fail range.
    await MoveTo(connB, idB, Trade.RangeMeters * 4f, 0f, connA);
    string? rangeFail = null;
    var rangeFailed = new TaskCompletionSource();
    void OnOfferFar(ReducerEventContext ctx, Identity _to, bool _shard, int _xp)
    {
        switch (ctx.Event.Status)
        {
            case Status.Failed(var reason):
                rangeFail = reason;
                rangeFailed.TrySetResult();
                break;
            case Status.Committed:
                rangeFailed.TrySetException(new Exception("OfferTrade committed while out of range"));
                break;
            case Status.OutOfEnergy(_):
                rangeFailed.TrySetException(new Exception("OfferTrade out of energy"));
                break;
        }
    }
    connA.Reducers.OnOfferTrade += OnOfferFar;
    try
    {
        connA.Reducers.OfferTrade(idB, true, 0);
        await Pump(rangeFailed.Task, timeoutMs, connA, "offer out of range");
    }
    finally
    {
        connA.Reducers.OnOfferTrade -= OnOfferFar;
    }
    if (string.IsNullOrEmpty(rangeFail) ||
        rangeFail.IndexOf("Out of range", StringComparison.OrdinalIgnoreCase) < 0)
    {
        Fail($"expected Out of range on OfferTrade, got: {rangeFail ?? "(null)"}");
        return;
    }
    Console.WriteLine("out-of-range OfferTrade reject OK");

    await MoveTo(connB, idB, 1.5f, 0f, connA);

    // Cancel: offer then cancel from A.
    connA.Reducers.OfferTrade(idB, true, 0);
    await PumpUntilBoth(() => connB.Db.TradeOffer.To.Find(idB) is not null,
        timeoutMs, connA, connB, "offer pending");
    connA.Reducers.CancelTrade();
    await PumpUntilBoth(() => connB.Db.TradeOffer.To.Find(idB) is null,
        timeoutMs, connA, connB, "cancel cleared");
    Console.WriteLine("CancelTrade OK");

    // Shard transfer: Offer + Accept.
    connA.Reducers.OfferTrade(idB, true, 0);
    await PumpUntilBoth(() => connB.Db.TradeOffer.To.Find(idB) is { OfferedHasEmberShard: true },
        timeoutMs, connA, connB, "shard offer");
    connB.Reducers.AcceptTrade();
    await PumpUntilBoth(() =>
    {
        var ca = connA.Db.Character.Identity.Find(idA);
        var cb = connB.Db.Character.Identity.Find(idB);
        return ca is { HasEmberShard: false }
            && cb is { HasEmberShard: true }
            && connA.Db.TradeOffer.To.Find(idB) is null;
    }, timeoutMs, connA, connB, "shard transfer");
    Console.WriteLine("AcceptTrade shard OK");

    // XP transfer: B → A small XP (B gained XP from A's prior loot path may vary; seed B XP via kill or use B's current).
    var xpB = connB.Db.Character.Identity.Find(idB)!.Xp;
    var xpA = connA.Db.Character.Identity.Find(idA)!.Xp;
    if (xpB < Trade.DefaultOfferXp)
    {
        // B may only have shard flag — give B XP by having A seed nothing; use dummy kill on B.
        connB.Reducers.EnsureTrainingDummy();
        await PumpUntilBoth(() => FindDummy(connB) is { Hp: var h } && h == Combat.DummyMaxHp,
            timeoutMs, connA, connB, "dummy");
        if (connB.Db.Character.Identity.Find(idB) is { StaffEquipped: false })
        {
            connB.Reducers.EquipStaff();
            await PumpUntilBoth(() => connB.Db.Character.Identity.Find(idB) is { StaffEquipped: true },
                timeoutMs, connA, connB, "B staff");
        }
        var dummy = FindDummy(connB)!;
        connB.Reducers.SetTarget(dummy.NpcId);
        while (FindDummy(connB) is { Hp: > 0 } d)
        {
            var before = d.Hp;
            connB.Reducers.Cast(Combat.SpellSpark);
            await PumpUntilBoth(() =>
            {
                var n = FindDummy(connB);
                return n is null || n.Hp < before || n.Hp == 0;
            }, timeoutMs, connA, connB, "spark");
            await DelayPumpBoth(connA, connB, Combat.GcdMs + 40);
        }
        await PumpUntilBoth(() => connB.Db.Character.Identity.Find(idB)!.Xp >= xpB + Combat.XpPerKill,
            timeoutMs, connA, connB, "B xp kill");
        xpB = connB.Db.Character.Identity.Find(idB)!.Xp;
        xpA = connA.Db.Character.Identity.Find(idA)!.Xp;
    }

    // Clear B's leftover ground loot so it doesn't confuse later.
    await MoveTo(connA, idA, 0f, 0f, connB);
    await MoveTo(connB, idB, 1.2f, 0f, connA);

    var offerXp = Trade.DefaultOfferXp;
    connB.Reducers.OfferTrade(idA, false, offerXp);
    await PumpUntilBoth(() =>
        connA.Db.TradeOffer.To.Find(idA) is { OfferedXp: var ox } && ox == offerXp,
        timeoutMs, connA, connB, "xp offer");
    connA.Reducers.AcceptTrade();
    await PumpUntilBoth(() =>
    {
        var ca = connA.Db.Character.Identity.Find(idA);
        var cb = connB.Db.Character.Identity.Find(idB);
        return ca is not null && cb is not null
            && ca.Xp >= xpA + offerXp
            && cb.Xp <= xpB - offerXp
            && connA.Db.TradeOffer.To.Find(idA) is null;
    }, timeoutMs, connA, connB, "xp transfer");
    Console.WriteLine($"AcceptTrade XP OK ({offerXp})");

    Console.WriteLine("OK: TradeSmoke passed");
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

static int CountLoot(DbConnection c)
{
    var n = 0;
    foreach (var _ in c.Db.WorldLoot.Iter()) n++;
    return n;
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

async Task<(DbConnection conn, Identity id)> ConnectAsync(string label)
{
    var connected = new TaskCompletionSource<Identity>();
    var conn = DbConnection.Builder()
        .WithUri(uri)
        .WithDatabaseName(db)
        .OnConnect((_, identity, _) => connected.TrySetResult(identity))
        .OnConnectError(e => connected.TrySetException(e))
        .Build();
    await Pump(connected.Task, timeoutMs, conn, label + "-connect");
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

static async Task MoveTo(DbConnection mover, Identity id, float x, float z, DbConnection other)
{
    for (var i = 0; i < 80; i++)
    {
        var p = mover.Db.PlayerPose.Identity.Find(id);
        if (p is null) break;
        var dx = x - p.X;
        var dz = z - p.Z;
        if (dx * dx + dz * dz < 0.05f) break;
        mover.Reducers.Move(dx, dz, false);
        await DelayPumpBoth(mover, other, 40);
    }
    await PumpUntilBoth(() =>
    {
        var p = mover.Db.PlayerPose.Identity.Find(id);
        if (p is null) return false;
        var dx = x - p.X;
        var dz = z - p.Z;
        return dx * dx + dz * dz < 0.25f;
    }, timeoutMs, mover, other, $"move-to ({x},{z})");
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

static async Task PumpUntilBoth(Func<bool> pred, int timeoutMs, DbConnection a, DbConnection b, string label)
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
    using var cts = new CancellationTokenSource(ms + 2000);
    var end = DateTime.UtcNow.AddMilliseconds(ms);
    while (DateTime.UtcNow < end && !cts.IsCancellationRequested)
    {
        a.FrameTick();
        b.FrameTick();
        try { await Task.Delay(16, cts.Token); } catch (OperationCanceledException) { break; }
    }
}
