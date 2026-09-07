using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

// Mana pool: Spark/Emberbolt spend; Insufficient mana reject; Rest restores; lazy regen.
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
    // Normalize legacy rows / prior smoke drain.
    if (ch0.MaxMana <= 0 || ch0.Mana < 0)
    {
        Console.WriteLine($"note: mana seed odd {ch0.Mana}/{ch0.MaxMana}");
    }
    Console.WriteLine($"mana seed {ch0.Mana}/{ch0.MaxMana} hp {ch0.Hp}/{ch0.MaxHp}");

    if (conn.Db.Character.Identity.Find(id) is { StaffEquipped: false })
    {
        conn.Reducers.EquipStaff();
        await PumpUntil(() => conn.Db.Character.Identity.Find(id) is { StaffEquipped: true },
            timeoutMs, conn, "staff");
    }

    // Wait for lazy regen / Rest until near-full mana so spend math is deterministic.
    await EnsureNearFullMana(conn, id);
    var full = conn.Db.Character.Identity.Find(id)!;
    if (full.Mana < Combat.SparkManaCost * 3)
    {
        Fail($"expected usable mana after top-up, got {full.Mana}/{full.MaxMana}");
        return;
    }
    Console.WriteLine($"topped mana {full.Mana}/{full.MaxMana}");

    conn.Reducers.EnsureTrainingDummy();
    await PumpUntil(() => FindDummy(conn) is { Hp: > 0 }, timeoutMs, conn, "dummy");
    var dummy = FindDummy(conn)!;
    conn.Reducers.SetTarget(dummy.NpcId);
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(id) is { } cc && cc.TargetNpcId == dummy.NpcId,
        timeoutMs, conn, "target");

    // --- Spark spends SparkManaCost ---
    await DelayPump(conn, Combat.GcdMs + 40);
    var beforeSpark = conn.Db.Character.Identity.Find(id)!.Mana;
    conn.Reducers.Cast(Combat.SpellSpark);
    await PumpUntil(() =>
    {
        var ch = conn.Db.Character.Identity.Find(id);
        return ch is not null && ch.Mana < beforeSpark;
    }, timeoutMs, conn, "spark mana spend");
    var afterSpark = conn.Db.Character.Identity.Find(id)!;
    var sparkDrop = beforeSpark - afterSpark.Mana;
    // Allow 0..ManaRegenPerTick of regen race between spend and observe.
    // TickManaRegen may add up to a tick before spend, so observed drop can be cost-regen.
    if (sparkDrop < Combat.SparkManaCost - Combat.ManaRegenPerTick * 2
        || sparkDrop > Combat.SparkManaCost)
    {
        Fail($"Spark mana drop expected ~{Combat.SparkManaCost}, got {sparkDrop} ({beforeSpark}->{afterSpark.Mana})");
        return;
    }
    Console.WriteLine($"Spark spend OK {beforeSpark}->{afterSpark.Mana} (drop {sparkDrop})");

    // --- Emberbolt spends EmberboltManaCost ---
    await DelayPump(conn, Combat.GcdMs + 40);
    conn.Reducers.EnsureTrainingDummy();
    await PumpUntil(() => FindDummy(conn) is { Hp: > 0 }, timeoutMs, conn, "dummy ember");
    dummy = FindDummy(conn)!;
    conn.Reducers.SetTarget(dummy.NpcId);
    await DelayPump(conn, 40);
    var beforeEmber = conn.Db.Character.Identity.Find(id)!.Mana;
    if (beforeEmber < Combat.EmberboltManaCost)
    {
        await EnsureNearFullMana(conn, id);
        beforeEmber = conn.Db.Character.Identity.Find(id)!.Mana;
    }
    conn.Reducers.Cast(Combat.SpellEmberbolt);
    await PumpUntil(() =>
    {
        var ch = conn.Db.Character.Identity.Find(id);
        return ch is not null && ch.Mana < beforeEmber;
    }, timeoutMs, conn, "ember mana spend");
    var afterEmber = conn.Db.Character.Identity.Find(id)!;
    var emberDrop = beforeEmber - afterEmber.Mana;
    if (emberDrop < Combat.EmberboltManaCost - Combat.ManaRegenPerTick * 2
        || emberDrop > Combat.EmberboltManaCost)
    {
        Fail($"Emberbolt mana drop expected ~{Combat.EmberboltManaCost}, got {emberDrop} ({beforeEmber}->{afterEmber.Mana})");
        return;
    }
    Console.WriteLine($"Emberbolt spend OK {beforeEmber}->{afterEmber.Mana} (drop {emberDrop})");
    // Let windup finish so casting gate is clean.
    await DelayPump(conn, Combat.EmberboltCastMs + Combat.GcdMs + 80);

    // --- Drain with Emberbolt until mana < cost, then OOM reject (check OOM before Rest). ---
    // Sparks alone hit respawn (full mana) before OOM because thorns outpace Spark cost.
    var rejectSeen = false;
    var drainCasts = 0;
    while (!rejectSeen && drainCasts < 20)
    {
        var chNow = conn.Db.Character.Identity.Find(id)!;
        if (chNow.Hp <= 0)
        {
            Fail("unexpected death during mana drain");
            return;
        }

        conn.Reducers.EnsureTrainingDummy();
        await PumpUntil(() => FindDummy(conn) is { Hp: > 0 }, timeoutMs, conn, "dummy drain");
        dummy = FindDummy(conn)!;
        conn.Reducers.SetTarget(dummy.NpcId);
        await DelayPump(conn, Combat.GcdMs + 40);
        chNow = conn.Db.Character.Identity.Find(id)!;
        var manaNow = chNow.Mana;
        Console.WriteLine($"drain loop mana={manaNow} hp={chNow.Hp} casts={drainCasts}");

        // Prefer OOM proof over Rest top-up (Rest restores ManaRestore).
        if (manaNow < Combat.EmberboltManaCost)
        {
            await ExpectCastFail(conn, Combat.SpellEmberbolt, "Insufficient mana", "oom ember");
            rejectSeen = true;
            break;
        }

        // Soft HP floor so the next Emberbolt thorns won't kill before OOM.
        if (chNow.Hp <= Combat.DummyThornsDamage)
        {
            await DelayPump(conn, Rest.CombatLockMs + Rest.CooldownMs + 200);
            conn.Reducers.Rest();
            await DelayPump(conn, 200);
            Console.WriteLine($"rest for HP; mana now {conn.Db.Character.Identity.Find(id)!.Mana}");
            continue;
        }

        conn.Reducers.Cast(Combat.SpellEmberbolt);
        drainCasts++;
        await DelayPump(conn, Combat.EmberboltCastMs + 80);
    }
    if (!rejectSeen)
    {
        Fail("expected Insufficient mana reject after drain");
        return;
    }
    Console.WriteLine($"Insufficient mana reject OK after {drainCasts} drain casts");

    // --- Rest restores mana (and HP if missing) ---
    var low = conn.Db.Character.Identity.Find(id)!;
    var manaBeforeRest = low.Mana;
    // Clear combat lock from thorns if any.
    await DelayPump(conn, Rest.CombatLockMs + 200);
    // RestReadyAt may still be fresh from a prior Rest in EnsureNearFullMana — wait cooldown.
    await DelayPump(conn, Rest.CooldownMs + 200);
    conn.Reducers.Rest();
    await PumpUntil(() =>
    {
        var ch = conn.Db.Character.Identity.Find(id);
        return ch is not null && ch.Mana > manaBeforeRest;
    }, timeoutMs, conn, "rest mana restore");
    var afterRest = conn.Db.Character.Identity.Find(id)!;
    var gained = afterRest.Mana - manaBeforeRest;
    if (gained < 1)
    {
        Fail($"expected Rest mana gain, got {manaBeforeRest}->{afterRest.Mana}");
        return;
    }
    Console.WriteLine($"Rest mana OK {manaBeforeRest}->{afterRest.Mana}/{afterRest.MaxMana} (+{gained})");

    Console.WriteLine("OK: ManaSmoke passed");
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

static async Task EnsureNearFullMana(DbConnection conn, Identity id)
{
    // Prefer Rest top-ups; fall back to waiting lazy regen.
    var guard = 0;
    while (conn.Db.Character.Identity.Find(id) is { } cur
           && cur.MaxMana > 0
           && cur.Mana < cur.MaxMana - Combat.SparkManaCost
           && guard++ < 12)
    {
        await DelayPump(conn, Rest.CombatLockMs + Rest.CooldownMs + 150);
        var before = cur.Mana;
        // Rest may fail if already full HP+mana mid-loop — ignore.
        string? fail = null;
        var tcs = new TaskCompletionSource();
        void OnRest(ReducerEventContext ctx)
        {
            switch (ctx.Event.Status)
            {
                case Status.Failed(var reason):
                    fail = reason;
                    tcs.TrySetResult();
                    break;
                case Status.Committed:
                    tcs.TrySetResult();
                    break;
                case Status.OutOfEnergy(_):
                    tcs.TrySetException(new Exception("Rest out of energy"));
                    break;
            }
        }
        conn.Reducers.OnRest += OnRest;
        try
        {
            conn.Reducers.Rest();
            await Pump(tcs.Task, timeoutMs, conn, "rest top-up");
        }
        finally
        {
            conn.Reducers.OnRest -= OnRest;
        }
        await PumpUntil(() =>
        {
            var n = conn.Db.Character.Identity.Find(id);
            return n is not null && (n.Mana > before || n.Mana >= n.MaxMana - Combat.SparkManaCost || fail != null);
        }, timeoutMs, conn, "mana rose");
        if (fail != null && fail.IndexOf("full", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            break;
        }
        // Also wait a bit of lazy regen between Rest cooldowns.
        await DelayPump(conn, Combat.ManaRegenIntervalMs * 3);
    }
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
