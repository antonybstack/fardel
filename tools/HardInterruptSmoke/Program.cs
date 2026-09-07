using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

// After CastPushbackHardAfter pushbacks (or remain < CastHardInterruptRemainMs),
// next DummyStrike hard-cancels windup with no mana refund.
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

    // Room for multiple DummyStrike thorns (do not die).
    var hpNow = conn.Db.Character.Identity.Find(id)!.Hp;
    var needHp = Combat.DummyThornsDamage * (Combat.CastPushbackHardAfter + 2) + 5;
    if (hpNow <= needHp)
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

    conn.Reducers.Cast(Combat.SpellEmberbolt);
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(id) is { } pc && pc.CastingSpellId == Combat.SpellEmberbolt,
        timeoutMs, conn, "ember casting");
    await PumpUntil(() =>
    {
        var ch = conn.Db.Character.Identity.Find(id);
        return ch is not null && ch.Mana < manaBefore;
    }, timeoutMs, conn, "ember mana spent");

    var manaMid = conn.Db.Character.Identity.Find(id)!.Mana;
    Console.WriteLine($"casting mana {manaBefore}->{manaMid}");

    // --- Soft pushbacks (CastPushbackHardAfter times) ---
    for (var i = 0; i < Combat.CastPushbackHardAfter; i++)
    {
        var ends0 = conn.Db.PlayerCombat.Identity.Find(id)!.CastEndsAt.MicrosecondsSinceUnixEpoch;
        var hp0 = conn.Db.Character.Identity.Find(id)!.Hp;
        conn.Reducers.DummyStrike();
        await PumpUntil(() =>
        {
            var ch = conn.Db.Character.Identity.Find(id);
            return ch is not null && ch.Hp < hp0;
        }, timeoutMs, conn, $"pushback strike {i + 1} thorns");

        var combat = conn.Db.PlayerCombat.Identity.Find(id)!;
        if (combat.CastingSpellId != Combat.SpellEmberbolt)
        {
            Fail($"expected still casting after pushback #{i + 1}, got {combat.CastingSpellId}");
            return;
        }
        var ends1 = combat.CastEndsAt.MicrosecondsSinceUnixEpoch;
        var delayMs = (ends1 - ends0) / 1000L;
        if (delayMs < Combat.CastPushbackMs - 50 || delayMs > Combat.CastPushbackMs + 80)
        {
            Fail($"pushback #{i + 1} delay expected ~{Combat.CastPushbackMs}ms, got {delayMs}");
            return;
        }
        if (combat.CastPushbackCount != i + 1)
        {
            Fail($"CastPushbackCount expected {i + 1}, got {combat.CastPushbackCount}");
            return;
        }
        Console.WriteLine($"pushback #{i + 1} OK +{delayMs}ms count={combat.CastPushbackCount}");
        await DelayPump(conn, 40);
    }

    var manaAfterPush = conn.Db.Character.Identity.Find(id)!.Mana;
    if (manaAfterPush - manaMid > Combat.ManaRegenPerTick * 3)
    {
        Fail($"pushbacks refunded mana ({manaMid}->{manaAfterPush})");
        return;
    }

    // --- Hard interrupt strike ---
    var hpHard = conn.Db.Character.Identity.Find(id)!.Hp;
    var manaHardBefore = conn.Db.Character.Identity.Find(id)!.Mana;
    conn.Reducers.DummyStrike();
    await PumpUntil(() =>
    {
        var ch = conn.Db.Character.Identity.Find(id);
        return ch is not null && ch.Hp < hpHard;
    }, timeoutMs, conn, "hard interrupt thorns");
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(id) is { } pc && pc.CastingSpellId == 0,
        timeoutMs, conn, "cast cleared by hard interrupt");

    var manaHardAfter = conn.Db.Character.Identity.Find(id)!.Mana;
    var manaDelta = manaHardAfter - manaHardBefore;
    if (manaDelta > Combat.ManaRegenPerTick * 2)
    {
        Fail($"hard interrupt refunded mana ({manaHardBefore}->{manaHardAfter})");
        return;
    }
    Console.WriteLine($"hard interrupt no-refund OK mana {manaHardBefore}->{manaHardAfter}");

    var combatCleared = conn.Db.PlayerCombat.Identity.Find(id)!;
    if (combatCleared.CastPushbackCount != 0)
    {
        Fail($"CastPushbackCount expected 0 after hard interrupt, got {combatCleared.CastPushbackCount}");
        return;
    }

    // Wait past any prior CastEndsAt — dummy must not take Emberbolt damage.
    await DelayPump(conn, Combat.EmberboltCastMs + Combat.CastPushbackMs * (Combat.CastPushbackHardAfter + 1) + 300);
    var dummyAfter = FindDummy(conn)!.Hp;
    if (dummyAfter != dummyHpBefore)
    {
        Fail($"hard interrupt still damaged dummy ({dummyHpBefore}->{dummyAfter})");
        return;
    }
    Console.WriteLine("hard interrupt no-damage OK");

    // --- Remain-threshold path: wait until remain < CastHardInterruptRemainMs, then strike ---
    await DelayPump(conn, Combat.GcdMs + 80);
    await TopUpMana(conn, id);
    // Heal enough HP for another strike.
    if (conn.Db.Character.Identity.Find(id)!.Hp <= Combat.DummyThornsDamage)
    {
        await DelayPump(conn, Rest.CombatLockMs + Rest.CooldownMs + 150);
        try { conn.Reducers.Rest(); } catch { /* ignore */ }
        await DelayPump(conn, 200);
    }

    conn.Reducers.EnsureTrainingDummy();
    await PumpUntil(() => FindDummy(conn) is { Hp: var h } && h == Combat.DummyMaxHp,
        timeoutMs, conn, "dummy full remain");
    dummy = FindDummy(conn)!;
    conn.Reducers.SetTarget(dummy.NpcId);
    await DelayPump(conn, 40);

    var manaRemainBefore = conn.Db.Character.Identity.Find(id)!.Mana;
    var dummyRemainBefore = FindDummy(conn)!.Hp;
    conn.Reducers.Cast(Combat.SpellEmberbolt);
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(id) is { } pc && pc.CastingSpellId == Combat.SpellEmberbolt,
        timeoutMs, conn, "ember casting remain");
    await PumpUntil(() =>
    {
        var ch = conn.Db.Character.Identity.Find(id);
        return ch is not null && ch.Mana < manaRemainBefore;
    }, timeoutMs, conn, "ember mana spent remain");
    var manaRemainMid = conn.Db.Character.Identity.Find(id)!.Mana;

    // Wait until remaining windup is below hard-interrupt threshold (no prior pushback).
    var waitMs = Combat.EmberboltCastMs - Combat.CastHardInterruptRemainMs + 80;
    if (waitMs > 0) await DelayPump(conn, waitMs);

    var still = conn.Db.PlayerCombat.Identity.Find(id)!;
    if (still.CastingSpellId != Combat.SpellEmberbolt)
    {
        Fail($"expected still casting before remain-threshold strike, got {still.CastingSpellId}");
        return;
    }

    var hpRemain = conn.Db.Character.Identity.Find(id)!.Hp;
    conn.Reducers.DummyStrike();
    await PumpUntil(() =>
    {
        var ch = conn.Db.Character.Identity.Find(id);
        return ch is not null && ch.Hp < hpRemain;
    }, timeoutMs, conn, "remain hard interrupt thorns");
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(id) is { } pc && pc.CastingSpellId == 0,
        timeoutMs, conn, "cast cleared by remain hard interrupt");

    var manaRemainAfter = conn.Db.Character.Identity.Find(id)!.Mana;
    if (manaRemainAfter - manaRemainMid > Combat.ManaRegenPerTick * 2)
    {
        Fail($"remain hard interrupt refunded mana ({manaRemainMid}->{manaRemainAfter})");
        return;
    }
    Console.WriteLine($"remain-threshold hard interrupt no-refund OK mana {manaRemainMid}->{manaRemainAfter}");

    await DelayPump(conn, Combat.CastHardInterruptRemainMs + 400);
    var dummyRemainAfter = FindDummy(conn)!.Hp;
    if (dummyRemainAfter != dummyRemainBefore)
    {
        Fail($"remain hard interrupt still damaged dummy ({dummyRemainBefore}->{dummyRemainAfter})");
        return;
    }
    Console.WriteLine("remain-threshold no-damage OK");

    Console.WriteLine("OK: HardInterruptSmoke passed");
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
