using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

// Character.Hp + dummy thorns → death → yard respawn.
var uri = GameConstants.ResolveLocalUri();
var db = GameConstants.ResolveDatabaseName();
const int timeoutMs = 60000;

DbConnection? conn = null;

try
{
    var (c, id) = await ConnectAsync();
    conn = c;
    Console.WriteLine("connected " + id);

    _ = await SubscribeAll(conn, "all");

    await PumpUntil(() =>
        conn.Db.PlayerPose.Identity.Find(id) is not null
        && conn.Db.Character.Identity.Find(id) is not null
        && conn.Db.PlayerCombat.Identity.Find(id) is not null,
        timeoutMs, conn, "pose+char+combat");

    var ch0 = conn.Db.Character.Identity.Find(id)!;
    if (ch0.MaxHp <= 0 || ch0.Hp <= 0)
    {
        Fail($"expected full HP seed, got {ch0.Hp}/{ch0.MaxHp}");
        return;
    }
    Console.WriteLine($"hp seed {ch0.Hp}/{ch0.MaxHp}");

    // Ensure staff for Cast.
    if (!ch0.StaffEquipped)
    {
        conn.Reducers.EquipStaff();
        await PumpUntil(() => conn.Db.Character.Identity.Find(id) is { StaffEquipped: true },
            timeoutMs, conn, "staff");
    }

    // Spark dummy until player dies (thorns). Reset dummy as needed.
    var casts = 0;
    while (conn.Db.Character.Identity.Find(id) is { Hp: > 0 } && casts < 40)
    {
        conn.Reducers.EnsureTrainingDummy();
        await PumpUntil(() => FindDummy(conn) is { Hp: > 0 }, timeoutMs, conn, "dummy alive");
        var dummy = FindDummy(conn)!;
        conn.Reducers.SetTarget(dummy.NpcId);
        await PumpUntil(() =>
            conn.Db.PlayerCombat.Identity.Find(id) is { } cc && cc.TargetNpcId == dummy.NpcId,
            timeoutMs, conn, "target");

        var before = conn.Db.Character.Identity.Find(id)!.Hp;
        conn.Reducers.Cast(Combat.SpellSpark);
        casts++;
        await PumpUntil(() =>
        {
            var ch = conn.Db.Character.Identity.Find(id);
            return ch is null || ch.Hp < before || ch.Hp == 0;
        }, timeoutMs, conn, $"thorn tick #{casts}");
        await DelayPump(conn, Combat.GcdMs + 40);
    }

    var dead = conn.Db.Character.Identity.Find(id)!;
    if (dead.Hp > 0)
    {
        Fail($"expected death after {casts} sparks, hp={dead.Hp}");
        return;
    }
    Console.WriteLine($"death OK after {casts} sparks");

    var combatDead = conn.Db.PlayerCombat.Identity.Find(id)!;
    if (combatDead.TargetNpcId != 0)
    {
        Fail($"expected target cleared on death, got {combatDead.TargetNpcId}");
        return;
    }
    Console.WriteLine("target cleared OK");

    // Dead Move rejects.
    string? moveFail = null;
    var moveFailed = new TaskCompletionSource();
    void OnMove(ReducerEventContext ctx, float dx, float dz)
    {
        _ = dx; _ = dz;
        switch (ctx.Event.Status)
        {
            case Status.Failed(var reason):
                moveFail = reason;
                moveFailed.TrySetResult();
                break;
            case Status.Committed:
                moveFailed.TrySetException(new Exception("Move committed while dead"));
                break;
            case Status.OutOfEnergy(_):
                moveFailed.TrySetException(new Exception("Move out of energy"));
                break;
        }
    }
    conn.Reducers.OnMove += OnMove;
    try
    {
        conn.Reducers.Move(0.2f, 0f);
        await Pump(moveFailed.Task, timeoutMs, conn, "move while dead");
    }
    finally
    {
        conn.Reducers.OnMove -= OnMove;
    }
    if (string.IsNullOrEmpty(moveFail) ||
        moveFail.IndexOf("Dead", StringComparison.OrdinalIgnoreCase) < 0)
    {
        Fail($"expected Dead on Move, got: {moveFail ?? "(null)"}");
        return;
    }
    Console.WriteLine("dead Move reject OK");

    // Wait for scheduled respawn: full HP + yard origin pose.
    await PumpUntil(() =>
    {
        var ch = conn.Db.Character.Identity.Find(id);
        var pose = conn.Db.PlayerPose.Identity.Find(id);
        return ch is { Hp: var h, MaxHp: var m } && m > 0 && h == m
            && pose is { } p
            && MathF.Abs(p.X - Movement.SpawnX) < 0.05f
            && MathF.Abs(p.Z - Movement.SpawnZ) < 0.05f;
    }, timeoutMs, conn, "respawn full HP at spawn");

    var alive = conn.Db.Character.Identity.Find(id)!;
    var poseAlive = conn.Db.PlayerPose.Identity.Find(id)!;
    Console.WriteLine($"respawn OK hp={alive.Hp}/{alive.MaxHp} pose=({poseAlive.X},{poseAlive.Z})");

    // Can cast again after respawn.
    conn.Reducers.EnsureTrainingDummy();
    await PumpUntil(() => FindDummy(conn) is { Hp: > 0 }, timeoutMs, conn, "dummy after respawn");
    var d2 = FindDummy(conn)!;
    conn.Reducers.SetTarget(d2.NpcId);
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(id) is { } cc && cc.TargetNpcId == d2.NpcId,
        timeoutMs, conn, "retarget");
    var hpBefore = conn.Db.Character.Identity.Find(id)!.Hp;
    var dummyBefore = FindDummy(conn)!.Hp;
    conn.Reducers.Cast(Combat.SpellSpark);
    await PumpUntil(() => FindDummy(conn)!.Hp < dummyBefore, timeoutMs, conn, "spark after respawn");
    var hpAfter = conn.Db.Character.Identity.Find(id)!.Hp;
    if (hpAfter >= hpBefore)
    {
        Fail($"expected thorns after respawn spark ({hpBefore} -> {hpAfter})");
        return;
    }
    Console.WriteLine($"post-respawn spark OK player hp {hpBefore}->{hpAfter}");

    Console.WriteLine("OK: PlayerHpSmoke passed");
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

async Task<(DbConnection conn, Identity id)> ConnectAsync()
{
    var connected = new TaskCompletionSource<Identity>();
    var c = DbConnection.Builder()
        .WithUri(uri)
        .WithDatabaseName(db)
        .OnConnect((_, identity, _) => connected.TrySetResult(identity))
        .OnConnectError(e => connected.TrySetException(e))
        .Build();
    await Pump(connected.Task, timeoutMs, c, "connect");
    return (c, await connected.Task);
}

static async Task<SubscriptionHandle> SubscribeAll(DbConnection conn, string label)
{
    var applied = new TaskCompletionSource();
    var handle = conn.SubscriptionBuilder()
        .OnApplied(_ => applied.TrySetResult())
        .OnError((_, e) => applied.TrySetException(e))
        .SubscribeToAllTables();
    await Pump(applied.Task, timeoutMs, conn, "subscribe " + label);
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
