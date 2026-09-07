using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

// BuyYardTonic + UseYardTonic — range, consume, move-speed buff.
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
    Console.WriteLine($"vendor id={vendor.VendorId} at ({vendor.X},{vendor.Z})");

    // Reject UseYardTonic when bag empty.
    string? emptyFail = null;
    var emptyFailed = new TaskCompletionSource();
    void OnUseEmpty(ReducerEventContext ctx)
    {
        switch (ctx.Event.Status)
        {
            case Status.Failed(var reason):
                emptyFail = reason;
                emptyFailed.TrySetResult();
                break;
            case Status.Committed:
                emptyFailed.TrySetException(new Exception("UseYardTonic committed with no tonic"));
                break;
            case Status.OutOfEnergy(_):
                emptyFailed.TrySetException(new Exception("UseYardTonic out of energy"));
                break;
        }
    }
    // Clear any leftover tonic from prior runs.
    var chPrep = conn.Db.Character.Identity.Find(id)!;
    if (chPrep.HasYardTonic)
    {
        conn.Reducers.UseYardTonic();
        await PumpUntil(() => conn.Db.Character.Identity.Find(id) is { HasYardTonic: false },
            timeoutMs, conn, "clear leftover tonic");
        await DelayPump(conn, 50);
    }

    conn.Reducers.OnUseYardTonic += OnUseEmpty;
    try
    {
        conn.Reducers.UseYardTonic();
        await Pump(emptyFailed.Task, timeoutMs, conn, "use empty");
    }
    finally
    {
        conn.Reducers.OnUseYardTonic -= OnUseEmpty;
    }
    if (string.IsNullOrEmpty(emptyFail) ||
        emptyFail.IndexOf("No yard tonic", StringComparison.OrdinalIgnoreCase) < 0)
    {
        Fail($"expected No yard tonic, got: {emptyFail ?? "(null)"}");
        return;
    }
    Console.WriteLine("empty UseYardTonic reject OK");

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
                rangeFailed.TrySetException(new Exception("BuyYardTonic committed while out of range"));
                break;
            case Status.OutOfEnergy(_):
                rangeFailed.TrySetException(new Exception("BuyYardTonic out of energy"));
                break;
        }
    }
    conn.Reducers.OnBuyYardTonic += OnBuyFar;
    try
    {
        conn.Reducers.BuyYardTonic();
        await Pump(rangeFailed.Task, timeoutMs, conn, "buy tonic out of range");
    }
    finally
    {
        conn.Reducers.OnBuyYardTonic -= OnBuyFar;
    }
    if (string.IsNullOrEmpty(rangeFail) ||
        rangeFail.IndexOf("Out of range", StringComparison.OrdinalIgnoreCase) < 0)
    {
        Fail($"expected Out of range on BuyYardTonic, got: {rangeFail ?? "(null)"}");
        return;
    }
    Console.WriteLine("out-of-range BuyYardTonic reject OK");

    await MoveTo(conn, id, vendor.X + 0.8f, vendor.Z + 0.4f);

    var ch0 = conn.Db.Character.Identity.Find(id)!;
    if (ch0.Xp < Tonic.BuyXpCost)
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
        await PumpUntil(() => conn.Db.Character.Identity.Find(id)!.Xp >= Tonic.BuyXpCost,
            timeoutMs, conn, "xp from kill");
        await MoveTo(conn, id, vendor.X + 0.8f, vendor.Z + 0.4f);
    }

    var xpBefore = conn.Db.Character.Identity.Find(id)!.Xp;
    conn.Reducers.BuyYardTonic();
    await PumpUntil(() =>
    {
        var ch = conn.Db.Character.Identity.Find(id);
        return ch is { HasYardTonic: true } && ch.Xp == xpBefore - Tonic.BuyXpCost;
    }, timeoutMs, conn, "buy tonic");
    Console.WriteLine($"BuyYardTonic OK XP {xpBefore}→{conn.Db.Character.Identity.Find(id)!.Xp}");

    var poseA = conn.Db.PlayerPose.Identity.Find(id)!;
    var wish = Movement.MaxStepMeters * 1.5f;
    conn.Reducers.Move(wish, 0f);
    await DelayPump(conn, 80);
    var poseB = conn.Db.PlayerPose.Identity.Find(id)!;
    var baseDelta = poseB.X - poseA.X;
    Console.WriteLine($"baseline move deltaX={baseDelta:F3} (expect ~{Movement.MaxStepMeters})");
    if (baseDelta > Movement.MaxStepMeters + 0.05f)
    {
        // Buff still active from a prior use in this session — clear by waiting isn't possible
        // without clock; re-baseline after we measure boosted instead.
        Console.WriteLine("note: baseline already boosted (prior buff); will compare after Use");
    }

    conn.Reducers.UseYardTonic();
    await PumpUntil(() =>
    {
        var ch = conn.Db.Character.Identity.Find(id);
        return ch is { HasYardTonic: false };
    }, timeoutMs, conn, "use tonic consume");
    var afterUse = conn.Db.Character.Identity.Find(id)!;
    if (afterUse.HasYardTonic)
    {
        Fail("HasYardTonic still true after UseYardTonic");
        return;
    }
    Console.WriteLine($"UseYardTonic OK expires micros={afterUse.TonicExpiresAt.MicrosecondsSinceUnixEpoch}");

    var poseC = conn.Db.PlayerPose.Identity.Find(id)!;
    conn.Reducers.Move(wish, 0f);
    await DelayPump(conn, 80);
    var poseD = conn.Db.PlayerPose.Identity.Find(id)!;
    var buffDelta = poseD.X - poseC.X;
    Console.WriteLine($"buffed move deltaX={buffDelta:F3} (expect ~{wish})");
    if (buffDelta < wish - 0.05f)
    {
        Fail($"expected buffed step ~{wish}, got {buffDelta}");
        return;
    }
    if (baseDelta <= Movement.MaxStepMeters + 0.05f && buffDelta <= baseDelta + 0.05f)
    {
        Fail($"buffed delta {buffDelta} not greater than baseline {baseDelta}");
        return;
    }

    Console.WriteLine("OK: TonicSmoke passed");
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
