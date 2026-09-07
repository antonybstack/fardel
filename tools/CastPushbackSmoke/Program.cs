using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

// Dummy thorns during Emberbolt windup delay CastEndsAt (no cancel/refund).
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

    if (conn.Db.Character.Identity.Find(id) is { StaffEquipped: false })
    {
        conn.Reducers.EquipStaff();
        await PumpUntil(() => conn.Db.Character.Identity.Find(id) is { StaffEquipped: true },
            timeoutMs, conn, "staff");
    }

    // Need HP room for DummyStrike thorns (do not die — death would full-interrupt).
    var hpNow = conn.Db.Character.Identity.Find(id)!.Hp;
    if (hpNow <= Combat.DummyThornsDamage)
    {
        await DelayPump(conn, Rest.CombatLockMs + Rest.CooldownMs + 150);
        try { conn.Reducers.Rest(); } catch { /* ignore */ }
        await DelayPump(conn, 200);
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

    await DelayPump(conn, Combat.GcdMs + 80);

    var manaBefore = conn.Db.Character.Identity.Find(id)!.Mana;
    if (manaBefore < Combat.EmberboltManaCost)
    {
        await TopUpMana(conn, id);
        manaBefore = conn.Db.Character.Identity.Find(id)!.Mana;
    }
    var hpBefore = conn.Db.Character.Identity.Find(id)!.Hp;
    var dummyHpBefore = FindDummy(conn)!.Hp;

    var t0 = Environment.TickCount64;
    conn.Reducers.Cast(Combat.SpellEmberbolt);
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(id) is { } pc && pc.CastingSpellId == Combat.SpellEmberbolt,
        timeoutMs, conn, "ember casting");
    await PumpUntil(() =>
    {
        var ch = conn.Db.Character.Identity.Find(id);
        return ch is not null && ch.Mana < manaBefore;
    }, timeoutMs, conn, "ember mana spent");

    var combat0 = conn.Db.PlayerCombat.Identity.Find(id)!;
    var ends0 = combat0.CastEndsAt.MicrosecondsSinceUnixEpoch;
    var manaMid = conn.Db.Character.Identity.Find(id)!.Mana;
    Console.WriteLine($"casting ends0={ends0} mana {manaBefore}->{manaMid} hp {hpBefore}");

    conn.Reducers.DummyStrike();
    await PumpUntil(() =>
    {
        var ch = conn.Db.Character.Identity.Find(id);
        return ch is not null && ch.Hp < hpBefore;
    }, timeoutMs, conn, "dummy strike thorns");

    var combat1 = conn.Db.PlayerCombat.Identity.Find(id)!;
    if (combat1.CastingSpellId != Combat.SpellEmberbolt)
    {
        Fail($"expected still casting Emberbolt after DummyStrike, got {combat1.CastingSpellId}");
        return;
    }

    var ends1 = combat1.CastEndsAt.MicrosecondsSinceUnixEpoch;
    var delayMs = (ends1 - ends0) / 1000L;
    if (delayMs < Combat.CastPushbackMs - 50 || delayMs > Combat.CastPushbackMs + 80)
    {
        Fail($"CastEndsAt delay expected ~{Combat.CastPushbackMs}ms, got {delayMs} ({ends0}->{ends1})");
        return;
    }
    Console.WriteLine($"CastEndsAt pushback OK +{delayMs}ms");

    var manaAfterStrike = conn.Db.Character.Identity.Find(id)!.Mana;
    var manaDelta = manaAfterStrike - manaMid;
    // No refund. Allow tiny regen.
    if (manaDelta > Combat.ManaRegenPerTick * 2)
    {
        Fail($"DummyStrike refunded mana ({manaMid}->{manaAfterStrike})");
        return;
    }
    Console.WriteLine($"no-refund OK mana {manaMid}->{manaAfterStrike}");

    var dummyMid = FindDummy(conn)!.Hp;
    if (dummyMid != dummyHpBefore)
    {
        Fail($"DummyStrike damaged dummy ({dummyHpBefore}->{dummyMid})");
        return;
    }

    var hpAfter = conn.Db.Character.Identity.Find(id)!.Hp;
    if (hpAfter != hpBefore - Combat.DummyThornsDamage)
    {
        Fail($"DummyStrike thorns expected {Combat.DummyThornsDamage}, hp {hpBefore}->{hpAfter}");
        return;
    }
    Console.WriteLine($"thorns OK hp {hpBefore}->{hpAfter}");

    // Original windup should no longer land on time — wait past original 1500ms from t0.
    var elapsed = (int)(Environment.TickCount64 - t0);
    var waitPastOriginal = Combat.EmberboltCastMs + 150 - elapsed;
    if (waitPastOriginal > 0)
    {
        await DelayPump(conn, waitPastOriginal);
    }
    var dummyAtOriginal = FindDummy(conn)!.Hp;
    if (dummyAtOriginal != dummyHpBefore)
    {
        Fail($"Emberbolt landed at original time despite pushback ({dummyHpBefore}->{dummyAtOriginal})");
        return;
    }
    Console.WriteLine("no-land at original CastEndsAt OK");

    await PumpUntil(() => FindDummy(conn)!.Hp <= dummyHpBefore - Combat.EmberboltDamage + 1,
        timeoutMs, conn, "emberbolt land after pushback");
    var dummyAfter = FindDummy(conn)!.Hp;
    if (dummyAfter != dummyHpBefore - Combat.EmberboltDamage)
    {
        Fail($"Emberbolt damage mismatch after pushback: {dummyHpBefore}->{dummyAfter}");
        return;
    }

    var stillCasting = conn.Db.PlayerCombat.Identity.Find(id)!.CastingSpellId;
    if (stillCasting != 0)
    {
        Fail($"expected cast cleared after land, CastingSpellId={stillCasting}");
        return;
    }
    Console.WriteLine("emberbolt landed after pushback OK");

    Console.WriteLine("OK: CastPushbackSmoke passed");
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
