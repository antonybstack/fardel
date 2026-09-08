using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

// BuyYardBandage + UseBandage — vendor buy, HP-only heal, own CD/gates (≠ Rest).
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

    await PumpUntil(() => FindVendor(conn) is not null, timeoutMs, conn, "yard vendor");
    var vendor = FindVendor(conn)!;
    Console.WriteLine($"vendor id={vendor.VendorId} at ({vendor.X},{vendor.Z})");

    int bHeal = Bandage.HealAmount, bCd = Bandage.CooldownMs, bLock = Bandage.CombatLockMs;
    int rHeal = Rest.HealAmount, rCd = Rest.CooldownMs, rLock = Rest.CombatLockMs;
    if (bHeal == rHeal && bCd == rCd && bLock == rLock)
    {
        Fail("Bandage tunables must differ from Rest (distinct CD/gates)");
        return;
    }
    Console.WriteLine(
        $"tunables OK Bandage heal={Bandage.HealAmount} cd={Bandage.CooldownMs} lock={Bandage.CombatLockMs} " +
        $"vs Rest heal={Rest.HealAmount} cd={Rest.CooldownMs} lock={Rest.CombatLockMs}");

    // Clear leftover bandage from prior runs.
    var chPrep = conn.Db.Character.Identity.Find(id)!;
    if (chPrep.HasYardBandage)
    {
        // May fail gates; force-consume only when HP missing and locks clear.
        await DelayPump(conn, Math.Max(Bandage.CombatLockMs, Bandage.CooldownMs) + 200);
        if (conn.Db.Character.Identity.Find(id) is { Hp: var h, MaxHp: var m } && h >= m)
        {
            await TakeThorns(conn, id, 1);
            await DelayPump(conn, Bandage.CombatLockMs + 200);
        }
        try
        {
            conn.Reducers.UseBandage();
            await PumpUntil(() => conn.Db.Character.Identity.Find(id) is { HasYardBandage: false },
                8000, conn, "clear leftover bandage");
        }
        catch
        {
            // ignore — empty reject path below covers bag-empty
        }
        await DelayPump(conn, 50);
    }

    // Reject UseBandage when bag empty.
    await ExpectUseFail(conn, "No yard bandage", "empty");

    await MoveTo(conn, id, Vendor.RangeMeters * 4f, 0f);
    await ExpectBuyFail(conn, "Out of range", "buy far");

    await MoveTo(conn, id, vendor.X + 0.8f, vendor.Z + 0.4f);

    if (conn.Db.Character.Identity.Find(id) is { StaffEquipped: false })
    {
        conn.Reducers.EquipStaff();
        await PumpUntil(() => conn.Db.Character.Identity.Find(id) is { StaffEquipped: true },
            timeoutMs, conn, "staff");
    }

    await EnsureXp(conn, id, vendor, Bandage.BuyXpCost);

    var xpBefore = conn.Db.Character.Identity.Find(id)!.Xp;
    conn.Reducers.BuyYardBandage();
    await PumpUntil(() =>
    {
        var ch = conn.Db.Character.Identity.Find(id);
        return ch is { HasYardBandage: true } && ch.Xp == xpBefore - Bandage.BuyXpCost;
    }, timeoutMs, conn, "buy bandage");
    Console.WriteLine($"BuyYardBandage OK XP {xpBefore}→{conn.Db.Character.Identity.Find(id)!.Xp}");

    // Need missing HP > HealAmount so cooldown reject can fire after one use.
    var needMissing = Bandage.HealAmount + Combat.DummyThornsDamage;
    await TakeThorns(conn, id, 1);
    while (conn.Db.Character.Identity.Find(id) is { } cur
           && cur.Hp > cur.MaxHp - needMissing
           && cur.Hp > 0)
    {
        await TakeThorns(conn, id, 1);
    }
    var mid = conn.Db.Character.Identity.Find(id)!;
    Console.WriteLine($"after thorns hp={mid.Hp}/{mid.MaxHp} (need missing>={needMissing})");
    if (mid.Hp >= mid.MaxHp)
    {
        Fail("expected missing HP after thorns");
        return;
    }

    // Refresh LastDamagedAt then immediately gate-check (no GCD wait — CombatLockMs is short).
    {
        conn.Reducers.EnsureTrainingDummy();
        await PumpUntil(() => FindDummy(conn) is { Hp: > 0 }, timeoutMs, conn, "dummy recent");
        var dRecent = FindDummy(conn)!;
        conn.Reducers.SetTarget(dRecent.NpcId);
        var beforeRecent = conn.Db.Character.Identity.Find(id)!.Hp;
        conn.Reducers.Cast(Combat.SpellSpark);
        await PumpUntil(() => conn.Db.Character.Identity.Find(id)!.Hp < beforeRecent,
            timeoutMs, conn, "thorn recent");
    }
    await ExpectUseFail(conn, "Recently damaged", "recent dmg");

    await DelayPump(conn, Bandage.CombatLockMs + 200);
    var beforeHeal = conn.Db.Character.Identity.Find(id)!.Hp;
    conn.Reducers.UseBandage();
    await PumpUntil(() =>
    {
        var ch = conn.Db.Character.Identity.Find(id);
        return ch is { HasYardBandage: false } && ch.Hp > beforeHeal;
    }, timeoutMs, conn, "use bandage heal");
    var afterHeal = conn.Db.Character.Identity.Find(id)!;
    var expected = Math.Min(afterHeal.MaxHp, beforeHeal + Bandage.HealAmount);
    if (afterHeal.Hp != expected)
    {
        Fail($"expected hp {expected}, got {afterHeal.Hp} (before {beforeHeal})");
        return;
    }
    if (afterHeal.HasYardBandage)
    {
        Fail("HasYardBandage still true after UseBandage");
        return;
    }
    Console.WriteLine($"UseBandage heal OK {beforeHeal}->{afterHeal.Hp}/{afterHeal.MaxHp} (consumed)");

    // Cooldown reject — buy another bandage first, still missing HP.
    if (afterHeal.Hp >= afterHeal.MaxHp)
    {
        Fail("expected UseBandage to leave missing HP so cooldown reject can run");
        return;
    }
    await MoveTo(conn, id, vendor.X + 0.8f, vendor.Z + 0.4f);
    await EnsureXp(conn, id, vendor, Bandage.BuyXpCost);
    var xp2 = conn.Db.Character.Identity.Find(id)!.Xp;
    conn.Reducers.BuyYardBandage();
    await PumpUntil(() => conn.Db.Character.Identity.Find(id) is { HasYardBandage: true },
        timeoutMs, conn, "buy bandage #2");
    Console.WriteLine($"BuyYardBandage #2 OK XP {xp2}→{conn.Db.Character.Identity.Find(id)!.Xp}");

    await ExpectUseFail(conn, "Bandage on cooldown", "cooldown");
    await DelayPump(conn, Bandage.CooldownMs + 200);

    // Casting reject
    await EnsureMissingHp(conn, id);
    await DelayPump(conn, Math.Max(Bandage.CombatLockMs, Bandage.CooldownMs) + 300);
    // Ensure we still hold the bandage from #2
    if (conn.Db.Character.Identity.Find(id) is not { HasYardBandage: true })
    {
        await MoveTo(conn, id, vendor.X + 0.8f, vendor.Z + 0.4f);
        await EnsureXp(conn, id, vendor, Bandage.BuyXpCost);
        conn.Reducers.BuyYardBandage();
        await PumpUntil(() => conn.Db.Character.Identity.Find(id) is { HasYardBandage: true },
            timeoutMs, conn, "buy bandage for cast gate");
        await DelayPump(conn, Bandage.CooldownMs + 200);
    }
    conn.Reducers.EnsureTrainingDummy();
    await PumpUntil(() => FindDummy(conn) is { Hp: > 0 }, timeoutMs, conn, "dummy cast");
    var d2 = FindDummy(conn)!;
    conn.Reducers.SetTarget(d2.NpcId);
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(id) is { } cc && cc.TargetNpcId == d2.NpcId,
        timeoutMs, conn, "retarget ember");
    await DelayPump(conn, Combat.GcdMs + 50);
    conn.Reducers.Cast(Combat.SpellEmberbolt);
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(id) is { CastingSpellId: var s } && s == Combat.SpellEmberbolt,
        timeoutMs, conn, "ember casting");
    await ExpectUseFail(conn, "Casting", "casting");
    await DelayPump(conn, Combat.EmberboltCastMs + Combat.GcdMs + 80);

    // Full HP reject (and keep bandage) — Rest or wait; then buy if consumed somehow.
    await EnsureFullHpViaRest(conn, id);
    if (conn.Db.Character.Identity.Find(id) is not { HasYardBandage: true })
    {
        await MoveTo(conn, id, vendor.X + 0.8f, vendor.Z + 0.4f);
        await EnsureXp(conn, id, vendor, Bandage.BuyXpCost);
        conn.Reducers.BuyYardBandage();
        await PumpUntil(() => conn.Db.Character.Identity.Find(id) is { HasYardBandage: true },
            timeoutMs, conn, "buy bandage for full gate");
        await DelayPump(conn, Bandage.CooldownMs + 100);
    }
    await ExpectUseFail(conn, "Already full", "full");

    // Dead reject — hold bandage while alive (buy if empty), then die. Dead cannot buy.
    if (conn.Db.Character.Identity.Find(id) is not { HasYardBandage: true })
    {
        if (conn.Db.Character.Identity.Find(id) is not { Hp: > 0 })
        {
            Fail("cannot buy bandage while dead; expected bandage held before death");
            return;
        }
        await MoveTo(conn, id, vendor.X + 0.8f, vendor.Z + 0.4f);
        await EnsureXp(conn, id, vendor, Bandage.BuyXpCost);
        if (conn.Db.Character.Identity.Find(id) is not { Hp: > 0 })
        {
            Fail("died farming XP for Dead-gate bandage; cannot buy while dead");
            return;
        }
        conn.Reducers.BuyYardBandage();
        await PumpUntil(() => conn.Db.Character.Identity.Find(id) is { HasYardBandage: true },
            timeoutMs, conn, "buy bandage for Dead gate");
    }
    if (conn.Db.Character.Identity.Find(id) is not { HasYardBandage: true, Hp: > 0 })
    {
        Fail("expected to hold a bandage while alive before Dead UseBandage reject");
        return;
    }

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
        Fail("expected death for Dead UseBandage reject");
        return;
    }
    if (conn.Db.Character.Identity.Find(id) is not { HasYardBandage: true })
    {
        Fail("expected HasYardBandage held at death for Dead UseBandage reject");
        return;
    }
    await ExpectUseFail(conn, "Dead", "dead");
    Console.WriteLine("dead UseBandage reject OK");

    await PumpUntil(() =>
        conn.Db.Character.Identity.Find(id) is { Hp: var h, MaxHp: var m } && m > 0 && h == m,
        timeoutMs, conn, "respawn after bandage smoke");

    Console.WriteLine("OK: BandageSmoke passed");
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

static async Task EnsureXp(DbConnection conn, Identity id, YardVendor vendor, int need)
{
    if (conn.Db.Character.Identity.Find(id)!.Xp >= need) return;
    conn.Reducers.EnsureTrainingDummy();
    await PumpUntil(() => FindDummy(conn) is { Hp: var h } && h == Combat.DummyMaxHp,
        timeoutMs, conn, "dummy xp");
    if (conn.Db.Character.Identity.Find(id) is { StaffEquipped: false })
    {
        conn.Reducers.EquipStaff();
        await PumpUntil(() => conn.Db.Character.Identity.Find(id) is { StaffEquipped: true },
            timeoutMs, conn, "staff xp");
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
        }, timeoutMs, conn, "spark xp");
        await DelayPump(conn, Combat.GcdMs + 40);
    }
    await PumpUntil(() => conn.Db.Character.Identity.Find(id)!.Xp >= need,
        timeoutMs, conn, "xp from kill");
    await MoveTo(conn, id, vendor.X + 0.8f, vendor.Z + 0.4f);
}

static async Task EnsureFullHpViaRest(DbConnection conn, Identity id)
{
    var ch = conn.Db.Character.Identity.Find(id)!;
    if (ch.Hp > 0 && ch.Hp == ch.MaxHp) return;
    if (ch.Hp <= 0)
    {
        await PumpUntil(() =>
            conn.Db.Character.Identity.Find(id) is { Hp: var h, MaxHp: var m } && m > 0 && h == m,
            timeoutMs, conn, "wait respawn full");
        return;
    }
    await DelayPump(conn, Rest.CombatLockMs + Rest.CooldownMs + 200);
    var guard = 0;
    while (conn.Db.Character.Identity.Find(id) is { } cur && cur.Hp < cur.MaxHp && guard++ < 12)
    {
        var before = cur.Hp;
        conn.Reducers.Rest();
        await PumpUntil(() =>
        {
            var n = conn.Db.Character.Identity.Find(id);
            return n is not null && (n.Hp > before || n.Hp >= n.MaxHp);
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

static async Task ExpectUseFail(DbConnection conn, string needle, string label)
{
    string? fail = null;
    var tcs = new TaskCompletionSource();
    void OnUse(ReducerEventContext ctx)
    {
        switch (ctx.Event.Status)
        {
            case Status.Failed(var reason):
                fail = reason;
                tcs.TrySetResult();
                break;
            case Status.Committed:
                tcs.TrySetException(new Exception($"UseBandage committed when expecting fail ({label})"));
                break;
            case Status.OutOfEnergy(_):
                tcs.TrySetException(new Exception($"UseBandage out of energy ({label})"));
                break;
        }
    }
    conn.Reducers.OnUseBandage += OnUse;
    try
    {
        conn.Reducers.UseBandage();
        await Pump(tcs.Task, timeoutMs, conn, "use fail " + label);
    }
    finally
    {
        conn.Reducers.OnUseBandage -= OnUse;
    }
    if (string.IsNullOrEmpty(fail) ||
        fail.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0)
    {
        Fail($"expected '{needle}' on UseBandage ({label}), got: {fail ?? "(null)"}");
        throw new Exception("use fail mismatch");
    }
    Console.WriteLine($"UseBandage reject OK ({label}): {fail}");
}

static async Task ExpectBuyFail(DbConnection conn, string needle, string label)
{
    string? fail = null;
    var tcs = new TaskCompletionSource();
    void OnBuy(ReducerEventContext ctx)
    {
        switch (ctx.Event.Status)
        {
            case Status.Failed(var reason):
                fail = reason;
                tcs.TrySetResult();
                break;
            case Status.Committed:
                tcs.TrySetException(new Exception($"BuyYardBandage committed when expecting fail ({label})"));
                break;
            case Status.OutOfEnergy(_):
                tcs.TrySetException(new Exception($"BuyYardBandage out of energy ({label})"));
                break;
        }
    }
    conn.Reducers.OnBuyYardBandage += OnBuy;
    try
    {
        conn.Reducers.BuyYardBandage();
        await Pump(tcs.Task, timeoutMs, conn, "buy fail " + label);
    }
    finally
    {
        conn.Reducers.OnBuyYardBandage -= OnBuy;
    }
    if (string.IsNullOrEmpty(fail) ||
        fail.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0)
    {
        Fail($"expected '{needle}' on BuyYardBandage ({label}), got: {fail ?? "(null)"}");
        throw new Exception("buy fail mismatch");
    }
    Console.WriteLine($"BuyYardBandage reject OK ({label}): {fail}");
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

static async Task MoveTo(DbConnection conn, Identity id, float x, float z)
{
    for (var i = 0; i < 80; i++)
    {
        var p = conn.Db.PlayerPose.Identity.Find(id);
        if (p is null) break;
        var dx = x - p.X;
        var dz = z - p.Z;
        if (dx * dx + dz * dz < 0.05f) break;
        conn.Reducers.Move(dx, dz, false);
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
    var until = Environment.TickCount64 + ms;
    while (Environment.TickCount64 < until)
    {
        conn.FrameTick();
        await Task.Delay(16);
    }
}
