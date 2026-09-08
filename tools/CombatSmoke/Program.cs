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

    conn.Reducers.EnsureTrainingDummy();
    await PumpUntil(() => FindDummy(conn) is { Hp: var h } && h == Combat.DummyMaxHp, timeoutMs, conn, "dummy ready full");

    var dummy = FindDummy(conn) ?? throw new Exception("no dummy");
    var chReady = conn.Db.Character.Identity.Find(identity)!;
    Console.WriteLine($"dummy id={dummy.NpcId} hp={dummy.Hp}/{dummy.MaxHp} caster={chReady.Hp}/{chReady.MaxHp} mana={chReady.Mana}/{chReady.MaxMana} staff={chReady.StaffEquipped}");

    // Prefer HP > DummyThornsDamage so the caster drop is exact, not clamped to 0.
    if (chReady.Hp <= 0)
    {
        await PumpUntil(() => conn.Db.Character.Identity.Find(identity) is { Hp: > 0 },
            timeoutMs, conn, "caster alive");
    }
    if (conn.Db.Character.Identity.Find(identity) is { Hp: var seedHp } && seedHp <= Combat.DummyThornsDamage)
    {
        await DelayPump(conn, Rest.CombatLockMs + Rest.CooldownMs + 150);
        try { conn.Reducers.Rest(); } catch { /* ignore */ }
        await DelayPump(conn, 200);
    }

    conn.Reducers.SetTarget(dummy.NpcId);
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(identity) is { } cc && cc.TargetNpcId == dummy.NpcId,
        timeoutMs, conn, "target set");

    var startXp = conn.Db.Character.Identity.Find(identity) is { } c0 ? c0.Xp : 0;

    var thornsChecked = false;
    while (FindDummy(conn) is { Hp: > 0 })
    {
        var before = FindDummy(conn)!.Hp;
        var casterHpBefore = conn.Db.Character.Identity.Find(identity)!.Hp;
        conn.Reducers.Cast(Combat.SpellSpark);
        await PumpUntil(() =>
        {
            var n = FindDummy(conn);
            return n is null || n.Hp < before || n.Hp == 0;
        }, timeoutMs, conn, "spark tick");
        if (!thornsChecked)
        {
            var expectedCasterHp = Math.Max(0, casterHpBefore - Combat.DummyThornsDamage);
            await PumpUntil(() =>
            {
                var ch = conn.Db.Character.Identity.Find(identity);
                return ch is not null && ch.Hp != casterHpBefore;
            }, timeoutMs, conn, "caster thorns");
            var casterHpAfter = conn.Db.Character.Identity.Find(identity)!.Hp;
            if (casterHpAfter != expectedCasterHp)
            {
                Fail($"DummyThornsDamage expected {Combat.DummyThornsDamage}, caster hp {casterHpBefore}->{casterHpAfter}");
                return;
            }
            Console.WriteLine($"thorns OK caster hp {casterHpBefore}->{casterHpAfter}");
            thornsChecked = true;
        }
        await DelayPump(conn, Combat.GcdMs + 50);
    }

    await PumpUntil(() =>
        conn.Db.Character.Identity.Find(identity) is { } cc && cc.Xp >= startXp + Combat.XpPerKill,
        timeoutMs, conn, "xp after spark kill");
    Console.WriteLine("spark-kill xp OK");

    conn.Reducers.EnsureTrainingDummy();
    await PumpUntil(() => FindDummy(conn) is { Hp: var h } && h == Combat.DummyMaxHp, timeoutMs, conn, "dummy reset");
    dummy = FindDummy(conn)!;
    conn.Reducers.SetTarget(dummy.NpcId);
    await DelayPump(conn, 50);

    var hp0 = FindDummy(conn)!.Hp;
    conn.Reducers.Cast(Combat.SpellSpark);
    await PumpUntil(() => FindDummy(conn)!.Hp < hp0, timeoutMs, conn, "first spark");
    var hp1 = FindDummy(conn)!.Hp;
    conn.Reducers.Cast(Combat.SpellSpark);
    await DelayPump(conn, 200);
    var hp2 = FindDummy(conn)!.Hp;
    if (hp2 != hp1)
    {
        Fail($"GCD did not block second spark ({hp1} -> {hp2})");
        return;
    }
    Console.WriteLine("GCD block OK");

    await DelayPump(conn, Combat.GcdMs + 50);
    conn.Reducers.EnsureTrainingDummy();
    await PumpUntil(() => FindDummy(conn) is { Hp: var h } && h == Combat.DummyMaxHp, timeoutMs, conn, "dummy reset 2");
    dummy = FindDummy(conn)!;
    conn.Reducers.SetTarget(dummy.NpcId);
    await DelayPump(conn, 50);
    var hpBefore = FindDummy(conn)!.Hp;
    conn.Reducers.Cast(Combat.SpellEmberbolt);
    await DelayPump(conn, 200);
    var hpMid = FindDummy(conn)!.Hp;
    if (hpMid != hpBefore)
    {
        Fail($"Emberbolt applied too early ({hpBefore} -> {hpMid})");
        return;
    }
    await PumpUntil(() => FindDummy(conn)!.Hp <= hpBefore - Combat.EmberboltDamage + 1, timeoutMs, conn, "emberbolt land");
    var hpAfter = FindDummy(conn)!.Hp;
    if (hpAfter != hpBefore - Combat.EmberboltDamage)
    {
        Fail($"Emberbolt damage mismatch: {hpBefore} -> {hpAfter}");
        return;
    }
    Console.WriteLine("emberbolt OK");

    Console.WriteLine("OK: CombatSmoke passed");
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
