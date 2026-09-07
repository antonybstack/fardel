using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

// Cast rejects "out of range" when PlayerPose is farther than Combat.CastRangeMeters
// from the targeted NPC. Spawn↔dummy (~5m) is IN range; Move far then Cast fails;
// Move back then Cast succeeds.
const string uri = GameConstants.DefaultLocalUri;
const string db = GameConstants.DefaultDatabaseName;
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

    if (conn.Db.Character.Identity.Find(id) is { StaffEquipped: false })
    {
        conn.Reducers.EquipStaff();
        await PumpUntil(() => conn.Db.Character.Identity.Find(id) is { StaffEquipped: true },
            timeoutMs, conn, "staff");
    }

    await TopUpMana(conn, id);
    Console.WriteLine($"seed hp={conn.Db.Character.Identity.Find(id)!.Hp} mana={conn.Db.Character.Identity.Find(id)!.Mana}");

    conn.Reducers.EnsureTrainingDummy();
    await PumpUntil(() => FindDummy(conn) is { Hp: var h } && h == Combat.DummyMaxHp,
        timeoutMs, conn, "dummy full");
    var dummy = FindDummy(conn)!;
    conn.Reducers.SetTarget(dummy.NpcId);
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(id) is { } cc && cc.TargetNpcId == dummy.NpcId,
        timeoutMs, conn, "target");

    var pose0 = conn.Db.PlayerPose.Identity.Find(id)!;
    var dist0 = DistXZ(pose0.X, pose0.Z, dummy.X, dummy.Z);
    Console.WriteLine($"spawn dist to dummy={dist0:F2}m (range={Combat.CastRangeMeters})");
    if (dist0 > Combat.CastRangeMeters)
    {
        Fail($"spawn should be IN range; dist={dist0} > {Combat.CastRangeMeters}");
        return;
    }

    var outTargetX = Combat.DummySpawnX - (Combat.CastRangeMeters + 2f);
    Console.WriteLine($"moving to x~={outTargetX} (out of range)…");
    await MoveToward(conn, id, outTargetX, 0f);

    var poseFar = conn.Db.PlayerPose.Identity.Find(id)!;
    dummy = FindDummy(conn)!;
    var distFar = DistXZ(poseFar.X, poseFar.Z, dummy.X, dummy.Z);
    Console.WriteLine($"far pose ({poseFar.X:F2},{poseFar.Z:F2}) dist={distFar:F2}m");
    if (distFar <= Combat.CastRangeMeters)
    {
        Fail($"expected OUT of range; dist={distFar} <= {Combat.CastRangeMeters}");
        return;
    }

    conn.Reducers.SetTarget(dummy.NpcId);
    await DelayPump(conn, Combat.GcdMs + 80);
    await TopUpMana(conn, id);

    var manaBefore = conn.Db.Character.Identity.Find(id)!.Mana;
    await ExpectCastFail(conn, Combat.SpellSpark, "out of range", "far from dummy");
    var manaAfter = conn.Db.Character.Identity.Find(id)!.Mana;
    if (manaAfter != manaBefore)
    {
        Fail($"mana should be unchanged on out-of-range reject; before={manaBefore} after={manaAfter}");
        return;
    }
    Console.WriteLine("out-of-range reject OK (mana unchanged)");

    Console.WriteLine("moving back IN range…");
    await MoveToward(conn, id, Movement.SpawnX, Movement.SpawnZ);

    var poseNear = conn.Db.PlayerPose.Identity.Find(id)!;
    dummy = FindDummy(conn)!;
    var distNear = DistXZ(poseNear.X, poseNear.Z, dummy.X, dummy.Z);
    Console.WriteLine($"near pose ({poseNear.X:F2},{poseNear.Z:F2}) dist={distNear:F2}m");
    if (distNear > Combat.CastRangeMeters)
    {
        Fail($"expected IN range; dist={distNear} > {Combat.CastRangeMeters}");
        return;
    }

    conn.Reducers.EnsureTrainingDummy();
    await PumpUntil(() => FindDummy(conn) is { Hp: var h } && h > 0,
        timeoutMs, conn, "dummy alive");
    dummy = FindDummy(conn)!;
    conn.Reducers.SetTarget(dummy.NpcId);
    await DelayPump(conn, Combat.GcdMs + 80);
    await TopUpMana(conn, id);

    var manaReady = conn.Db.Character.Identity.Find(id)!.Mana;
    var hpBefore = dummy.Hp;
    conn.Reducers.Cast(Combat.SpellSpark);
    await PumpUntil(() =>
    {
        var n = FindDummy(conn);
        return n is not null && n.Hp < hpBefore;
    }, timeoutMs, conn, "spark damage in range");
    var manaSpent = conn.Db.Character.Identity.Find(id)!.Mana;
    Console.WriteLine($"in-range Spark OK hp {hpBefore}->{FindDummy(conn)!.Hp} mana {manaReady}->{manaSpent}");

    Console.WriteLine("OK: CastRangeSmoke passed");
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

static float DistXZ(float ax, float az, float bx, float bz)
{
    var dx = ax - bx;
    var dz = az - bz;
    return MathF.Sqrt(dx * dx + dz * dz);
}

static async Task MoveToward(DbConnection conn, Identity id, float tx, float tz)
{
    var guard = 0;
    while (guard++ < 80)
    {
        var p = conn.Db.PlayerPose.Identity.Find(id)!;
        var dx = tx - p.X;
        var dz = tz - p.Z;
        var dist = MathF.Sqrt(dx * dx + dz * dz);
        if (dist <= 0.35f) break;
        var scale = MathF.Min(Movement.MaxStepMeters, dist) / dist;
        conn.Reducers.Move(dx * scale, dz * scale);
        await DelayPump(conn, 25);
    }
    await DelayPump(conn, 80);
}

static async Task ExpectCastFail(DbConnection conn, int spellId, string needle, string label)
{
    string? fail = null;
    var tcs = new TaskCompletionSource();
    void OnCast(ReducerEventContext ctx, int _spellId)
    {
        switch (ctx.Event.Status)
        {
            case Status.Failed(var reason):
                fail = reason;
                tcs.TrySetResult();
                break;
            case Status.Committed:
                tcs.TrySetException(new Exception($"Cast committed when expecting fail ({label})"));
                break;
            case Status.OutOfEnergy(_):
                tcs.TrySetException(new Exception($"Cast out of energy ({label})"));
                break;
        }
    }
    conn.Reducers.OnCast += OnCast;
    try
    {
        conn.Reducers.Cast(spellId);
        await Pump(tcs.Task, timeoutMs, conn, "cast fail " + label);
    }
    finally
    {
        conn.Reducers.OnCast -= OnCast;
    }
    if (string.IsNullOrEmpty(fail) ||
        fail.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0)
    {
        Fail($"expected '{needle}' on Cast ({label}), got: {fail ?? "(null)"}");
        throw new Exception("cast fail mismatch");
    }
    Console.WriteLine($"Cast reject OK ({label}): {fail}");
}

static async Task TopUpMana(DbConnection conn, Identity id)
{
    var guard = 0;
    while (conn.Db.Character.Identity.Find(id) is { } cur
           && cur.MaxMana > 0
           && cur.Mana < cur.MaxMana - Combat.EmberboltManaCost
           && guard++ < 10)
    {
        await DelayPump(conn, Rest.CombatLockMs + Rest.CooldownMs + 150);
        var before = cur.Mana;
        try { conn.Reducers.Rest(); } catch { /* ignore */ }
        await DelayPump(conn, 200);
        await DelayPump(conn, Combat.ManaRegenIntervalMs * 2);
        var after = conn.Db.Character.Identity.Find(id);
        if (after is null || after.Mana <= before) break;
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

static void Fail(string msg)
{
    Console.Error.WriteLine("FAIL: " + msg);
    Environment.ExitCode = 1;
}

static async Task<(DbConnection conn, Identity id)> ConnectAsync()
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
