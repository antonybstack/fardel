using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

// Killer gets Combat.XpPerKill; each other PartyMember mate gets PartyXpSharePerMate
// (always-relevant — no distance gate). Solo kill must not invent phantom share.
var uri = GameConstants.ResolveLocalUri();
var db = GameConstants.ResolveDatabaseName();
const int timeoutMs = 45000;

DbConnection? connA = null;
DbConnection? connB = null;

try
{
    var (a, idA) = await ConnectAsync("A");
    connA = a;
    Console.WriteLine("A connected " + idA);

    var (b, idB) = await ConnectAsync("B");
    connB = b;
    Console.WriteLine("B connected " + idB);

    _ = await SubscribeAll(connA, "A-all");
    _ = await SubscribeAll(connB, "B-all");

    await PumpUntilBoth(() =>
        connA.Db.Character.Identity.Find(idA) is not null
        && connB.Db.Character.Identity.Find(idB) is not null
        && connA.Db.PlayerPose.Identity.Find(idA) is not null
        && connB.Db.PlayerPose.Identity.Find(idB) is not null,
        timeoutMs, connA, connB, "chars+poses");

    // Party up A→B.
    connA.Reducers.InviteToParty(idB);
    await PumpUntilBoth(() => connB.Db.PartyInvite.Invitee.Find(idB) is not null,
        timeoutMs, connA, connB, "invite");
    connB.Reducers.AcceptPartyInvite();
    await PumpUntilBoth(() =>
    {
        var ma = connA.Db.PartyMember.Identity.Find(idA);
        var mb = connA.Db.PartyMember.Identity.Find(idB);
        return ma is not null && mb is not null && ma.PartyId == mb.PartyId;
    }, timeoutMs, connA, connB, "party-2");
    Console.WriteLine("partied");

    EnsureStaff(connA, idA);
    EnsureStaff(connB, idB);
    await DelayPumpBoth(connA, connB, 200);

    var xpA0 = connA.Db.Character.Identity.Find(idA)!.Xp;
    var xpB0 = connB.Db.Character.Identity.Find(idB)!.Xp;

    await KillDummy(connA, idA, connB);
    await PumpUntilBoth(() =>
        connA.Db.Character.Identity.Find(idA) is { } ca
        && ca.Xp >= xpA0 + Combat.XpPerKill
        && connB.Db.Character.Identity.Find(idB) is { } cb
        && cb.Xp >= xpB0 + Combat.PartyXpSharePerMate,
        timeoutMs, connA, connB, "party share after A kill");

    var xpA1 = connA.Db.Character.Identity.Find(idA)!.Xp;
    var xpB1 = connB.Db.Character.Identity.Find(idB)!.Xp;
    if (xpA1 - xpA0 < Combat.XpPerKill)
    {
        Fail($"killer XP delta {xpA1 - xpA0} < {Combat.XpPerKill}");
        return;
    }
    if (xpB1 - xpB0 < Combat.PartyXpSharePerMate)
    {
        Fail($"mate XP delta {xpB1 - xpB0} < {Combat.PartyXpSharePerMate}");
        return;
    }
    Console.WriteLine($"party share OK A +{xpA1 - xpA0} B +{xpB1 - xpB0}");

    // Leave party; B solo-kill must not grant A share.
    connA.Reducers.LeaveParty();
    connB.Reducers.LeaveParty();
    await PumpUntilBoth(() =>
        connA.Db.PartyMember.Identity.Find(idA) is null
        && connB.Db.PartyMember.Identity.Find(idB) is null,
        timeoutMs, connA, connB, "left party");

    var xpA2 = connA.Db.Character.Identity.Find(idA)!.Xp;
    var xpB2 = connB.Db.Character.Identity.Find(idB)!.Xp;
    await KillDummy(connB, idB, connA);
    await PumpUntilBoth(() =>
        connB.Db.Character.Identity.Find(idB) is { } cb && cb.Xp >= xpB2 + Combat.XpPerKill,
        timeoutMs, connA, connB, "solo B kill XP");

    await DelayPumpBoth(connA, connB, 300);
    var xpA3 = connA.Db.Character.Identity.Find(idA)!.Xp;
    if (xpA3 != xpA2)
    {
        Fail($"solo kill leaked share to A: {xpA2} -> {xpA3}");
        return;
    }
    Console.WriteLine("solo kill no-share OK");

    Console.WriteLine("OK: PartyXpSmoke passed");
    Environment.ExitCode = 0;
}
catch (Exception e)
{
    Fail(e.ToString());
}
finally
{
    try { connA?.Disconnect(); } catch { /* ignore */ }
    try { connB?.Disconnect(); } catch { /* ignore */ }
}

static void EnsureStaff(DbConnection conn, Identity id)
{
    if (conn.Db.Character.Identity.Find(id) is { StaffEquipped: false })
    {
        conn.Reducers.EquipStaff();
    }
}

static async Task KillDummy(DbConnection killer, Identity killerId, DbConnection other)
{
    killer.Reducers.EnsureTrainingDummy();
    await PumpUntilBoth(() => FindDummy(killer) is { Hp: var h } && h == Combat.DummyMaxHp,
        timeoutMs, killer, other, "dummy ready");
    var dummy = FindDummy(killer) ?? throw new Exception("no dummy");
    killer.Reducers.SetTarget(dummy.NpcId);
    await PumpUntilBoth(() =>
        killer.Db.PlayerCombat.Identity.Find(killerId) is { } cc && cc.TargetNpcId == dummy.NpcId,
        timeoutMs, killer, other, "target");

    while (FindDummy(killer) is { Hp: > 0 })
    {
        var before = FindDummy(killer)!.Hp;
        killer.Reducers.Cast(Combat.SpellSpark);
        await PumpUntilBoth(() =>
        {
            var n = FindDummy(killer);
            return n is null || n.Hp < before || n.Hp == 0;
        }, timeoutMs, killer, other, "spark tick");
        await DelayPumpBoth(killer, other, Combat.GcdMs + 50);
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

async Task<(DbConnection conn, Identity id)> ConnectAsync(string label)
{
    var tcs = new TaskCompletionSource<Identity>();
    var conn = DbConnection.Builder()
        .WithUri(uri)
        .WithDatabaseName(db)
        .OnConnect((_, identity, _) => tcs.TrySetResult(identity))
        .OnConnectError(e => tcs.TrySetException(e))
        .Build();
    await Pump(tcs.Task, timeoutMs, conn, label + "-connect");
    var id = await tcs.Task;
    return (conn, id);
}

static async Task<SubscriptionHandle> SubscribeAll(DbConnection conn, string label)
{
    var tcs = new TaskCompletionSource();
    var handle = conn.SubscriptionBuilder()
        .OnApplied(_ => tcs.TrySetResult())
        .OnError((_, e) => tcs.TrySetException(e))
        .SubscribeToAllTables();
    await Pump(tcs.Task, timeoutMs, conn, label);
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

static async Task PumpUntilBoth(
    Func<bool> pred,
    int timeoutMs,
    DbConnection a,
    DbConnection b,
    string label)
{
    using var cts = new CancellationTokenSource(timeoutMs);
    while (!pred() && !cts.IsCancellationRequested)
    {
        a.FrameTick();
        b.FrameTick();
        try { await Task.Delay(16, cts.Token); } catch (OperationCanceledException) { break; }
    }
    if (!pred()) throw new TimeoutException(label);
}

static async Task DelayPumpBoth(DbConnection a, DbConnection b, int ms)
{
    var until = Environment.TickCount64 + ms;
    while (Environment.TickCount64 < until)
    {
        a.FrameTick();
        b.FrameTick();
        await Task.Delay(16);
    }
}
