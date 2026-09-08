using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

// Rest reducer: out-of-combat HP heal + ManaRestore; reject casting / recently damaged / full / dead.
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
    if (ch0.MaxHp <= 0 || ch0.Hp != ch0.MaxHp)
    {
        // Prior runs may leave mid HP — Rest until full or respawn path.
        Console.WriteLine($"note: start hp {ch0.Hp}/{ch0.MaxHp}");
    }

    if (conn.Db.Character.Identity.Find(id) is { StaffEquipped: false })
    {
        conn.Reducers.EquipStaff();
        await PumpUntil(() => conn.Db.Character.Identity.Find(id) is { StaffEquipped: true },
            timeoutMs, conn, "staff");
    }

    // --- Full HP Rest rejects ---
    await EnsureFullHp(conn, id);
    await ExpectRestFail(conn, "Already full", "full");

    // --- Take enough thorns that one Rest does not fill MaxHp (cooldown can fire) ---
    // Need Hp <= MaxHp - HealAmount - 1 after damage so Rest leaves room for a second attempt.
    var needMissing = Rest.HealAmount + Combat.DummyThornsDamage; // at least two thorns worth
    await TakeThorns(conn, id, 1);
    var mid = conn.Db.Character.Identity.Find(id)!;
    Console.WriteLine($"after first thorns hp={mid.Hp}/{mid.MaxHp}");
    if (mid.Hp >= mid.MaxHp)
    {
        Fail("expected missing HP after thorns");
        return;
    }

    // --- Immediate Rest: Recently damaged ---
    await ExpectRestFail(conn, "Recently damaged", "recent dmg");

    // More thorns while still in combat-lock window (damage refreshes LastDamagedAt).
    while (conn.Db.Character.Identity.Find(id) is { } cur
           && cur.Hp > cur.MaxHp - needMissing
           && cur.Hp > 0)
    {
        await TakeThorns(conn, id, 1);
    }
    mid = conn.Db.Character.Identity.Find(id)!;
    Console.WriteLine($"after more thorns hp={mid.Hp}/{mid.MaxHp} (need missing>={needMissing}) mana={mid.Mana}/{mid.MaxMana}");

    // Emberbolt (cost 20) sinks mana below MaxMana-ManaRestore before the
    // DummyThornsDamage HP floor; Spark (cost 5) cannot.
    var manaSlack = Combat.ManaRegenPerTick * 4;
    while (conn.Db.Character.Identity.Find(id) is { } drain
           && drain.Hp > Combat.DummyThornsDamage
           && drain.Hp < drain.MaxHp
           && drain.Mana > drain.MaxMana - Rest.ManaRestore - manaSlack)
    {
        await TakeEmberThorns(conn, id);
    }
    var drained = conn.Db.Character.Identity.Find(id)!;
    var manaCap = drained.MaxMana - Rest.ManaRestore - manaSlack;
    if (drained.Mana > manaCap)
    {
        Fail($"expected mana <= {manaCap} after ember drain, got {drained.Mana}/{drained.MaxMana} (hp {drained.Hp}/{drained.MaxHp})");
        return;
    }
    Console.WriteLine($"ember drain mana={drained.Mana}/{drained.MaxMana} hp={drained.Hp}/{drained.MaxHp}");

    // --- Wait combat lock, Rest heals HP and restores mana (not to full HP) ---
    await DelayPump(conn, Rest.CombatLockMs + 200);
    var before = conn.Db.Character.Identity.Find(id)!;
    var beforeHeal = before.Hp;
    var beforeMana = before.Mana;
    if (beforeMana >= before.MaxMana)
    {
        Fail($"expected missing mana before Rest, got {beforeMana}/{before.MaxMana}");
        return;
    }
    conn.Reducers.Rest();
    await PumpUntil(() =>
    {
        var ch = conn.Db.Character.Identity.Find(id);
        return ch is not null && ch.Hp > beforeHeal;
    }, timeoutMs, conn, "rest heal");
    var afterHeal = conn.Db.Character.Identity.Find(id)!;
    var expected = Math.Min(afterHeal.MaxHp, beforeHeal + Rest.HealAmount);
    if (afterHeal.Hp != expected)
    {
        Fail($"expected hp {expected}, got {afterHeal.Hp} (before {beforeHeal})");
        return;
    }
    Console.WriteLine($"Rest heal OK {beforeHeal}->{afterHeal.Hp}/{afterHeal.MaxHp}");
    if (afterHeal.Hp >= afterHeal.MaxHp)
    {
        Fail("expected Rest to leave missing HP so cooldown reject can run");
        return;
    }

    var expectedMana = Math.Min(afterHeal.MaxMana, beforeMana + Rest.ManaRestore);
    // Rest TickManaRegen covers last Emberbolt windup + trailing GCD + combat-lock wait.
    var regenWaitMs = Combat.EmberboltCastMs + Rest.CombatLockMs + Combat.GcdMs + 400;
    var regenTicks = regenWaitMs / Combat.ManaRegenIntervalMs + 1;
    var manaHi = Math.Min(afterHeal.MaxMana, beforeMana + Rest.ManaRestore + regenTicks * Combat.ManaRegenPerTick);
    if (afterHeal.Mana < expectedMana || afterHeal.Mana > manaHi)
    {
        Fail($"expected mana {expectedMana}..{manaHi} after Rest.ManaRestore={Rest.ManaRestore}, got {afterHeal.Mana} (before {beforeMana})");
        return;
    }
    Console.WriteLine($"Rest mana OK {beforeMana}->{afterHeal.Mana}/{afterHeal.MaxMana} (want {expectedMana}..{manaHi})");

    // --- Cooldown reject (immediate; still missing HP, no new damage) ---
    await ExpectRestFail(conn, "Rest on cooldown", "cooldown");
    // Wait out cooldown so casting / later Rest gates are clean.
    await DelayPump(conn, Rest.CooldownMs + 200);

    // --- Casting reject (Emberbolt windup) ---
    await EnsureMissingHp(conn, id);
    await DelayPump(conn, Math.Max(Rest.CombatLockMs, Rest.CooldownMs) + 300);
    conn.Reducers.EnsureTrainingDummy();
    await PumpUntil(() => FindDummy(conn) is { Hp: > 0 }, timeoutMs, conn, "dummy cast");
    var d2 = FindDummy(conn)!;
    conn.Reducers.SetTarget(d2.NpcId);
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(id) is { } cc && cc.TargetNpcId == d2.NpcId,
        timeoutMs, conn, "retarget ember");
    // Clear GCD from prior spark.
    await DelayPump(conn, Combat.GcdMs + 50);
    conn.Reducers.Cast(Combat.SpellEmberbolt);
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(id) is { CastingSpellId: var s } && s == Combat.SpellEmberbolt,
        timeoutMs, conn, "ember casting");
    await ExpectRestFail(conn, "Casting", "casting");
    // Wait cast to finish so we don't leave pending state messy.
    await DelayPump(conn, Combat.EmberboltCastMs + Combat.GcdMs + 80);

    // --- Dead reject ---
    // Kill self via thorns without waiting full PlayerHpSmoke path if already low.
    var casts = 0;
    while (conn.Db.Character.Identity.Find(id) is { Hp: > 0 } && casts < 40)
    {
        conn.Reducers.EnsureTrainingDummy();
        await PumpUntil(() => FindDummy(conn) is { Hp: > 0 }, timeoutMs, conn, "dummy die");
        var d = FindDummy(conn)!;
        conn.Reducers.SetTarget(d.NpcId);
        await DelayPump(conn, Combat.GcdMs + 30);
        var beforeSpark = conn.Db.Character.Identity.Find(id)!.Hp;
        conn.Reducers.Cast(Combat.SpellSpark);
        casts++;
        await PumpUntil(() =>
        {
            var ch = conn.Db.Character.Identity.Find(id);
            return ch is null || ch.Hp < beforeSpark || ch.Hp == 0;
        }, timeoutMs, conn, "thorn toward death");
        await DelayPump(conn, Combat.GcdMs + 40);
        if (conn.Db.Character.Identity.Find(id) is { Hp: <= 0 }) break;
    }
    if (conn.Db.Character.Identity.Find(id) is not { Hp: <= 0 })
    {
        Fail("expected death for Dead Rest reject");
        return;
    }
    await ExpectRestFail(conn, "Dead", "dead");
    Console.WriteLine("dead Rest reject OK");

    // Wait respawn so we don't leave identity dead for other smokes sharing DB... 
    // Other smokes use fresh identities usually; still wait briefly.
    await PumpUntil(() =>
        conn.Db.Character.Identity.Find(id) is { Hp: var h, MaxHp: var m } && m > 0 && h == m,
        timeoutMs, conn, "respawn after rest smoke");

    Console.WriteLine("OK: RestSmoke passed");
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

static async Task EnsureFullHp(DbConnection conn, Identity id)
{
    var ch = conn.Db.Character.Identity.Find(id)!;
    bool Full(Character c) =>
        c.Hp > 0 && c.Hp == c.MaxHp
        && c.MaxMana > 0 && c.Mana >= c.MaxMana;
    if (Full(ch)) return;
    if (ch.Hp <= 0)
    {
        await PumpUntil(() =>
            conn.Db.Character.Identity.Find(id) is { } n && Full(n),
            timeoutMs, conn, "wait respawn full");
        return;
    }
    // Wait out combat lock + cooldown and Rest up (HP and/or mana).
    await DelayPump(conn, Rest.CombatLockMs + Rest.CooldownMs + 200);
    var guard = 0;
    while (conn.Db.Character.Identity.Find(id) is { } cur && !Full(cur) && guard++ < 10)
    {
        conn.Reducers.Rest();
        var beforeHp = cur.Hp;
        var beforeMana = cur.Mana;
        await PumpUntil(() =>
        {
            var n = conn.Db.Character.Identity.Find(id);
            return n is not null && (n.Hp > beforeHp || n.Mana > beforeMana || Full(n));
        }, timeoutMs, conn, "rest to full");
        await DelayPump(conn, Rest.CooldownMs + 100);
    }
}

static async Task EnsureMissingHp(DbConnection conn, Identity id)
{
    var ch = conn.Db.Character.Identity.Find(id)!;
    if (ch.Hp < ch.MaxHp && ch.Hp > 0) return;
    await TakeThorns(conn, id, 1);
}

static async Task TakeThorns(DbConnection conn, Identity id, int sparks)
{
    if (conn.Db.Character.Identity.Find(id) is { StaffEquipped: false })
    {
        conn.Reducers.EquipStaff();
        await DelayPump(conn, 80);
    }
    for (var i = 0; i < sparks; i++)
    {
        conn.Reducers.EnsureTrainingDummy();
        await PumpUntil(() => FindDummy(conn) is { Hp: > 0 }, timeoutMs, conn, "dummy thorns");
        var d = FindDummy(conn)!;
        conn.Reducers.SetTarget(d.NpcId);
        await DelayPump(conn, Combat.GcdMs + 40);
        var before = conn.Db.Character.Identity.Find(id)!.Hp;
        conn.Reducers.Cast(Combat.SpellSpark);
        await PumpUntil(() => conn.Db.Character.Identity.Find(id)!.Hp < before,
            timeoutMs, conn, $"thorns #{i}");
        await DelayPump(conn, Combat.GcdMs + 40);
    }
}

static async Task TakeEmberThorns(DbConnection conn, Identity id)
{
    if (conn.Db.Character.Identity.Find(id) is { StaffEquipped: false })
    {
        conn.Reducers.EquipStaff();
        await DelayPump(conn, 80);
    }
    conn.Reducers.EnsureTrainingDummy();
    await PumpUntil(() => FindDummy(conn) is { Hp: > 0 }, timeoutMs, conn, "dummy ember drain");
    var d = FindDummy(conn)!;
    conn.Reducers.SetTarget(d.NpcId);
    await DelayPump(conn, Combat.GcdMs + 40);
    var ch = conn.Db.Character.Identity.Find(id)!;
    if (ch.Mana < Combat.EmberboltManaCost)
    {
        Fail($"ember drain needs {Combat.EmberboltManaCost} mana, got {ch.Mana}");
        throw new Exception("ember drain oom");
    }
    var beforeHp = ch.Hp;
    conn.Reducers.Cast(Combat.SpellEmberbolt);
    await PumpUntil(() =>
    {
        var n = conn.Db.Character.Identity.Find(id);
        return n is not null && (n.Hp < beforeHp || n.Hp == 0);
    }, timeoutMs, conn, "ember thorns");
    await DelayPump(conn, Combat.GcdMs + 40);
}

static async Task ExpectRestFail(DbConnection conn, string needle, string label)
{
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
                tcs.TrySetException(new Exception($"Rest committed when expecting fail ({label})"));
                break;
            case Status.OutOfEnergy(_):
                tcs.TrySetException(new Exception($"Rest out of energy ({label})"));
                break;
        }
    }
    conn.Reducers.OnRest += OnRest;
    try
    {
        conn.Reducers.Rest();
        await Pump(tcs.Task, timeoutMs, conn, "rest fail " + label);
    }
    finally
    {
        conn.Reducers.OnRest -= OnRest;
    }
    if (string.IsNullOrEmpty(fail) ||
        fail.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0)
    {
        Fail($"expected '{needle}' on Rest ({label}), got: {fail ?? "(null)"}");
        throw new Exception("rest fail mismatch");
    }
    Console.WriteLine($"Rest reject OK ({label}): {fail}");
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
    var localUri = GameConstants.ResolveLocalUri();
    var localDb = GameConstants.ResolveDatabaseName();
    var connected = new TaskCompletionSource<Identity>();
    var c = DbConnection.Builder()
        .WithUri(localUri)
        .WithDatabaseName(localDb)
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
