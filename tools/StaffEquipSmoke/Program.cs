using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

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

    // Ensure staff starts equipped (seed default; re-equip if a prior smoke left it off).
    if (conn.Db.Character.Identity.Find(identity) is { StaffEquipped: false })
    {
        conn.Reducers.EquipStaff();
        await PumpUntil(() =>
            conn.Db.Character.Identity.Find(identity) is { StaffEquipped: true },
            timeoutMs, conn, "equip staff baseline");
    }
    Console.WriteLine("staff equipped baseline OK");

    conn.Reducers.EnsureTrainingDummy();
    await PumpUntil(() => FindDummy(conn) is { Hp: > 0 }, timeoutMs, conn, "dummy ready");
    var dummy = FindDummy(conn)!;
    conn.Reducers.SetTarget(dummy.NpcId);
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(identity) is { } cc && cc.TargetNpcId == dummy.NpcId,
        timeoutMs, conn, "target set");

    // --- unequip → Cast Spark must fail (HP unchanged) ---
    conn.Reducers.UnequipStaff();
    await PumpUntil(() =>
        conn.Db.Character.Identity.Find(identity) is { StaffEquipped: false },
        timeoutMs, conn, "staff unequipped");
    Console.WriteLine("unequip OK");

    var hpBefore = FindDummy(conn)!.Hp;
    string? castFailReason = null;
    var castFailed = new TaskCompletionSource();
    void OnCast(ReducerEventContext ctx, int spellId)
    {
        switch (ctx.Event.Status)
        {
            case Status.Failed(var reason):
                castFailReason = reason;
                castFailed.TrySetResult();
                break;
            case Status.Committed:
                castFailed.TrySetException(new Exception("Cast committed while staff unequipped"));
                break;
            case Status.OutOfEnergy(_):
                castFailed.TrySetException(new Exception("Cast out of energy"));
                break;
        }
    }
    conn.Reducers.OnCast += OnCast;
    try
    {
        conn.Reducers.Cast(Combat.SpellSpark);
        await Pump(castFailed.Task, timeoutMs, conn, "cast fail while unequipped");
    }
    finally
    {
        conn.Reducers.OnCast -= OnCast;
    }

    await DelayPump(conn, 250);
    var hpMid = FindDummy(conn)!.Hp;
    if (hpMid != hpBefore)
    {
        Fail($"Cast damaged dummy while unequipped ({hpBefore} -> {hpMid})");
        return;
    }
    if (string.IsNullOrEmpty(castFailReason) ||
        castFailReason.IndexOf("Staff", StringComparison.OrdinalIgnoreCase) < 0)
    {
        Fail($"expected Staff required failure, got: {castFailReason ?? "(null)"}");
        return;
    }
    Console.WriteLine($"unequip blocks cast OK ({castFailReason})");

    // --- equip → Cast Spark succeeds ---
    conn.Reducers.EquipStaff();
    await PumpUntil(() =>
        conn.Db.Character.Identity.Find(identity) is { StaffEquipped: true },
        timeoutMs, conn, "staff re-equipped");
    Console.WriteLine("re-equip OK");

    // Wait out any GCD from a prior attempt (failed cast should not set GCD, but be safe).
    await DelayPump(conn, Combat.GcdMs + 50);
    conn.Reducers.EnsureTrainingDummy();
    await PumpUntil(() => FindDummy(conn) is { Hp: var h } && h == Combat.DummyMaxHp, timeoutMs, conn, "dummy reset");
    dummy = FindDummy(conn)!;
    conn.Reducers.SetTarget(dummy.NpcId);
    await DelayPump(conn, 50);

    var hp0 = FindDummy(conn)!.Hp;
    conn.Reducers.Cast(Combat.SpellSpark);
    await PumpUntil(() => FindDummy(conn)!.Hp < hp0, timeoutMs, conn, "spark after re-equip");
    Console.WriteLine($"spark after re-equip OK ({hp0} -> {FindDummy(conn)!.Hp})");

    Console.WriteLine("OK: StaffEquipSmoke passed");
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

static Npc? FindDummy(DbConnection conn)
{
    foreach (var n in conn.Db.Npc.Iter())
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
    var until = Environment.TickCount64 + ms;
    while (Environment.TickCount64 < until)
    {
        conn.FrameTick();
        await Task.Delay(16);
    }
}
