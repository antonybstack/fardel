using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

const string uri = GameConstants.DefaultLocalUri;
const string db = GameConstants.DefaultDatabaseName;
const int timeoutMs = 60000;

DbConnection? connA = null;
DbConnection? connB = null;

try
{
    var (a, idA) = await ConnectAsync("A");
    connA = a;
    Console.WriteLine("A (victim) connected " + idA);
    var (b, idB) = await ConnectAsync("B");
    connB = b;
    Console.WriteLine("B (kicker) connected " + idB);
    _ = await SubscribeAll(connA, "A-all");
    _ = await SubscribeAll(connB, "B-all");
    await PumpUntilBoth(() =>
        connA.Db.PlayerPose.Identity.Find(idA) is not null
        && connB.Db.PlayerPose.Identity.Find(idB) is not null
        && connA.Db.Character.Identity.Find(idA) is not null
        && connB.Db.Character.Identity.Find(idB) is not null
        && connA.Db.PlayerCombat.Identity.Find(idA) is not null
        && connB.Db.PlayerCombat.Identity.Find(idB) is not null,
        timeoutMs, connA, connB, "poses+chars+combat");
    await MoveTo(connA, idA, 0f, 0f, connB);
    await MoveTo(connB, idB, 1.5f, 0f, connA);
    if (connA.Db.Character.Identity.Find(idA) is { StaffEquipped: false })
    {
        connA.Reducers.EquipStaff();
        await PumpUntilBoth(() => connA.Db.Character.Identity.Find(idA) is { StaffEquipped: true },
            timeoutMs, connA, connB, "A staff");
    }
    await TopUpMana(connA, idA, connB);
    await TopUpMana(connB, idB, connA);
    Console.WriteLine($"seed A mana={connA.Db.Character.Identity.Find(idA)!.Mana} B mana={connB.Db.Character.Identity.Find(idB)!.Mana}");
    connA.Reducers.EnsureTrainingDummy();
    await PumpUntilBoth(() => FindDummy(connA) is { Hp: var h } && h == Combat.DummyMaxHp,
        timeoutMs, connA, connB, "dummy full");
    var dummy = FindDummy(connA)!;
    connA.Reducers.SetTarget(dummy.NpcId);
    await PumpUntilBoth(() =>
        connA.Db.PlayerCombat.Identity.Find(idA) is { } cc && cc.TargetNpcId == dummy.NpcId,
        timeoutMs, connA, connB, "A target");
    await DelayPumpBoth(connA, connB, Combat.GcdMs + 80);

    await MoveTo(connB, idB, Combat.KickRangeMeters * 3f, 0f, connA);
    if (connA.Db.Character.Identity.Find(idA)!.Mana < Combat.EmberboltManaCost)
        await TopUpMana(connA, idA, connB);
    connA.Reducers.Cast(Combat.SpellEmberbolt);
    await PumpUntilBoth(() =>
        connA.Db.PlayerCombat.Identity.Find(idA) is { } pc && pc.CastingSpellId == Combat.SpellEmberbolt,
        timeoutMs, connA, connB, "A casting far");
    await ExpectKickFail(connB, idA, "Out of range", "far kick");
    Console.WriteLine("out-of-range Kick reject OK");
    connA.Reducers.CancelCast();
    await PumpUntilBoth(() =>
        connA.Db.PlayerCombat.Identity.Find(idA) is { } pc && pc.CastingSpellId == 0,
        timeoutMs, connA, connB, "A cancel after far");
    await MoveTo(connB, idB, 1.5f, 0f, connA);
    await DelayPumpBoth(connA, connB, Combat.GcdMs + 80);
    await TopUpMana(connA, idA, connB);
    await TopUpMana(connB, idB, connA);
    await ExpectKickFail(connB, idA, "not casting", "idle kick");
    Console.WriteLine("not-casting Kick reject OK");

    connA.Reducers.EnsureTrainingDummy();
    await PumpUntilBoth(() => FindDummy(connA) is { Hp: var h } && h == Combat.DummyMaxHp,
        timeoutMs, connA, connB, "dummy full 2");
    dummy = FindDummy(connA)!;
    connA.Reducers.SetTarget(dummy.NpcId);
    await DelayPumpBoth(connA, connB, 40);
    var manaBefore = connA.Db.Character.Identity.Find(idA)!.Mana;
    var manaBBefore = connB.Db.Character.Identity.Find(idB)!.Mana;
    var dummyHpBefore = FindDummy(connA)!.Hp;
    connA.Reducers.Cast(Combat.SpellEmberbolt);
    await PumpUntilBoth(() =>
        connA.Db.PlayerCombat.Identity.Find(idA) is { } pc && pc.CastingSpellId == Combat.SpellEmberbolt,
        timeoutMs, connA, connB, "A casting kick");
    await PumpUntilBoth(() =>
    {
        var ch = connA.Db.Character.Identity.Find(idA);
        return ch is not null && ch.Mana < manaBefore;
    }, timeoutMs, connA, connB, "A mana spent");
    var manaMid = connA.Db.Character.Identity.Find(idA)!.Mana;
    Console.WriteLine($"A casting mana {manaBefore}->{manaMid}");
    connB.Reducers.Kick(idA);
    await PumpUntilBoth(() =>
        connA.Db.PlayerCombat.Identity.Find(idA) is { } pc && pc.CastingSpellId == 0,
        timeoutMs, connA, connB, "A cast cleared by Kick");
    await PumpUntilBoth(() =>
    {
        var ch = connB.Db.Character.Identity.Find(idB);
        return ch is not null && ch.Mana < manaBBefore;
    }, timeoutMs, connA, connB, "B mana spent by Kick");
    var locked = connA.Db.PlayerCombat.Identity.Find(idA)!;
    if (locked.CastLockedUntil.MicrosecondsSinceUnixEpoch <= 0)
    {
        Fail("CastLockedUntil not set after Kick");
        return;
    }
    Console.WriteLine($"Kick CastLockedUntil micros={locked.CastLockedUntil.MicrosecondsSinceUnixEpoch}");
    var manaAfterKick = connA.Db.Character.Identity.Find(idA)!.Mana;
    if (manaAfterKick - manaMid > Combat.ManaRegenPerTick * 2)
    {
        Fail($"Kick refunded victim mana ({manaMid}->{manaAfterKick})");
        return;
    }
    var manaBAfter = connB.Db.Character.Identity.Find(idB)!.Mana;
    if (manaBBefore - manaBAfter < Combat.KickManaCost - 1)
    {
        Fail($"Kick did not spend kicker mana ({manaBBefore}->{manaBAfter})");
        return;
    }
    Console.WriteLine($"Kick mana OK victim {manaMid}->{manaAfterKick} kicker {manaBBefore}->{manaBAfter}");
    await DelayPumpBoth(connA, connB, Combat.GcdMs + 80);
    await ExpectCastFail(connA, Combat.SpellEmberbolt, "silenced", "during Kick silence");
    Console.WriteLine("Kick silence reject OK");
    await DelayPumpBoth(connA, connB, Combat.EmberboltCastMs + 400);
    var dummyAfter = FindDummy(connA)!.Hp;
    if (dummyAfter != dummyHpBefore)
    {
        Fail($"Kick still damaged dummy ({dummyHpBefore}->{dummyAfter})");
        return;
    }
    Console.WriteLine("Kick no-damage OK");
    await DelayPumpBoth(connA, connB, Combat.CastSilenceMs + 200);
    await TopUpMana(connA, idA, connB);
    connA.Reducers.EnsureTrainingDummy();
    await PumpUntilBoth(() => FindDummy(connA) is { Hp: var h } && h == Combat.DummyMaxHp,
        timeoutMs, connA, connB, "dummy post-silence");
    dummy = FindDummy(connA)!;
    connA.Reducers.SetTarget(dummy.NpcId);
    await DelayPumpBoth(connA, connB, 40);
    connA.Reducers.Cast(Combat.SpellEmberbolt);
    await PumpUntilBoth(() =>
        connA.Db.PlayerCombat.Identity.Find(idA) is { } pc && pc.CastingSpellId == Combat.SpellEmberbolt,
        timeoutMs, connA, connB, "A casting after Kick silence");
    Console.WriteLine("post-Kick-silence Cast OK");
    connA.Reducers.CancelCast();
    await PumpUntilBoth(() =>
        connA.Db.PlayerCombat.Identity.Find(idA) is { } pc && pc.CastingSpellId == 0,
        timeoutMs, connA, connB, "cleanup cancel");
    Console.WriteLine("OK: KickSmoke passed");
    Environment.ExitCode = 0;
}
catch (Exception e) { Fail(e.ToString()); }
finally
{
    try { connA?.Disconnect(); } catch { }
    try { connB?.Disconnect(); } catch { }
}

static async Task ExpectKickFail(DbConnection conn, Identity target, string needle, string label)
{
    string? fail = null;
    var tcs = new TaskCompletionSource();
    void OnKick(ReducerEventContext ctx, Identity _target)
    {
        switch (ctx.Event.Status)
        {
            case Status.Failed(var reason): fail = reason; tcs.TrySetResult(); break;
            case Status.Committed: tcs.TrySetException(new Exception($"Kick committed ({label})")); break;
            case Status.OutOfEnergy(_): tcs.TrySetException(new Exception($"Kick OOE ({label})")); break;
        }
    }
    conn.Reducers.OnKick += OnKick;
    try { conn.Reducers.Kick(target); await Pump(tcs.Task, timeoutMs, conn, "kick fail " + label); }
    finally { conn.Reducers.OnKick -= OnKick; }
    if (string.IsNullOrEmpty(fail) || fail.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0)
    {
        Fail($"expected '{needle}' on Kick ({label}), got: {fail ?? "(null)"}");
        throw new Exception("kick fail mismatch");
    }
    Console.WriteLine($"Kick reject OK ({label}): {fail}");
}

static async Task ExpectCastFail(DbConnection conn, int spellId, string needle, string label)
{
    string? fail = null;
    var tcs = new TaskCompletionSource();
    void OnCast(ReducerEventContext ctx, int _spellId)
    {
        switch (ctx.Event.Status)
        {
            case Status.Failed(var reason): fail = reason; tcs.TrySetResult(); break;
            case Status.Committed: tcs.TrySetException(new Exception($"Cast committed ({label})")); break;
            case Status.OutOfEnergy(_): tcs.TrySetException(new Exception($"Cast OOE ({label})")); break;
        }
    }
    conn.Reducers.OnCast += OnCast;
    try { conn.Reducers.Cast(spellId); await Pump(tcs.Task, timeoutMs, conn, "cast fail " + label); }
    finally { conn.Reducers.OnCast -= OnCast; }
    if (string.IsNullOrEmpty(fail) || fail.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0)
    {
        Fail($"expected '{needle}' on Cast ({label}), got: {fail ?? "(null)"}");
        throw new Exception("cast fail mismatch");
    }
    Console.WriteLine($"Cast reject OK ({label}): {fail}");
}

static async Task TopUpMana(DbConnection conn, Identity id, DbConnection other)
{
    var guard = 0;
    while (conn.Db.Character.Identity.Find(id) is { } cur
           && cur.MaxMana > 0
           && cur.Mana < cur.MaxMana - Math.Max(Combat.EmberboltManaCost, Combat.KickManaCost)
           && guard++ < 10)
    {
        await DelayPumpBoth(conn, other, Rest.CombatLockMs + Rest.CooldownMs + 150);
        var before = cur.Mana;
        try { conn.Reducers.Rest(); } catch { }
        await DelayPumpBoth(conn, other, 200);
        await DelayPumpBoth(conn, other, Combat.ManaRegenIntervalMs * 2);
        var after = conn.Db.Character.Identity.Find(id);
        if (after is null || after.Mana <= before) break;
    }
}

static async Task MoveTo(DbConnection conn, Identity id, float x, float z, DbConnection other)
{
    for (var i = 0; i < 120; i++)
    {
        var pose = conn.Db.PlayerPose.Identity.Find(id);
        if (pose is null) { await DelayPumpBoth(conn, other, 40); continue; }
        var dx = x - pose.X; var dz = z - pose.Z;
        var dist = MathF.Sqrt(dx * dx + dz * dz);
        if (dist < 0.25f) return;
        var scale = MathF.Min(Movement.MaxStepMeters, dist) / dist;
        conn.Reducers.Move(dx * scale, dz * scale);
        await DelayPumpBoth(conn, other, 50);
    }
    Fail($"MoveTo timeout ({x},{z})");
    throw new Exception("move timeout");
}

static Npc? FindDummy(DbConnection conn)
{
    foreach (var n in conn.Db.Npc.Iter()) if (n.Kind == 1) return n;
    return null;
}

static void Fail(string msg) { Console.Error.WriteLine("FAIL: " + msg); Environment.ExitCode = 1; }

static async Task<(DbConnection conn, Identity id)> ConnectAsync(string label)
{
    var connected = new TaskCompletionSource<Identity>();
    var c = DbConnection.Builder().WithUri(uri).WithDatabaseName(db)
        .OnConnect((_, identity, _) => connected.TrySetResult(identity))
        .OnConnectError(e => connected.TrySetException(e)).Build();
    await Pump(connected.Task, timeoutMs, c, "connect " + label);
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

static async Task PumpUntilBoth(Func<bool> pred, int timeoutMs, DbConnection a, DbConnection b, string label)
{
    using var cts = new CancellationTokenSource(timeoutMs);
    while (!pred() && !cts.IsCancellationRequested)
    {
        a.FrameTick(); b.FrameTick();
        try { await Task.Delay(16, cts.Token); } catch (OperationCanceledException) { break; }
    }
    if (!pred()) throw new TimeoutException(label);
}

static async Task DelayPumpBoth(DbConnection a, DbConnection b, int ms)
{
    var until = Environment.TickCount64 + ms;
    while (Environment.TickCount64 < until) { a.FrameTick(); b.FrameTick(); await Task.Delay(16); }
}
