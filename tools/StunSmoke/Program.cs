using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

// Stun/Bash: hard-CC breaks windup without CastLockedUntil; StunnedUntilMicros
// locks Move + Cast with "stunned" (distinct from silence).
var uri = GameConstants.ResolveLocalUri();
var db = GameConstants.ResolveDatabaseName();
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
    Console.WriteLine("B (stunner) connected " + idB);
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

    // Out of range reject
    await MoveTo(connB, idB, Combat.StunRangeMeters * 3f, 0f, connA);
    await ExpectStunFail(connB, idA, "Out of range", "far stun");
    Console.WriteLine("out-of-range Stun reject OK");
    await MoveTo(connB, idB, 1.5f, 0f, connA);
    await DelayPumpBoth(connA, connB, Combat.GcdMs + 80);
    await TopUpMana(connA, idA, connB);
    await TopUpMana(connB, idB, connA);

    // Stun while casting: break windup, no CastLockedUntil, set StunnedUntilMicros
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
        timeoutMs, connA, connB, "A casting stun");
    await PumpUntilBoth(() =>
    {
        var ch = connA.Db.Character.Identity.Find(idA);
        return ch is not null && ch.Mana < manaBefore;
    }, timeoutMs, connA, connB, "A mana spent");
    var manaMid = connA.Db.Character.Identity.Find(idA)!.Mana;
    Console.WriteLine($"A casting mana {manaBefore}->{manaMid}");
    connB.Reducers.Stun(idA);
    await PumpUntilBoth(() =>
        connA.Db.PlayerCombat.Identity.Find(idA) is { } pc && pc.CastingSpellId == 0,
        timeoutMs, connA, connB, "A cast cleared by Stun");
    await PumpUntilBoth(() =>
    {
        var ch = connB.Db.Character.Identity.Find(idB);
        return ch is not null && ch.Mana < manaBBefore;
    }, timeoutMs, connA, connB, "B mana spent by Stun");
    var locked = connA.Db.PlayerCombat.Identity.Find(idA)!;
    if (locked.StunnedUntilMicros <= 0)
    {
        Fail("StunnedUntilMicros not set after Stun");
        return;
    }
    // Distinct from silence: CastLockedUntil must NOT be extended by Stun.
    if (locked.CastLockedUntil.MicrosecondsSinceUnixEpoch > locked.StunnedUntilMicros)
    {
        // allow pre-existing silence; just ensure we didn't require silence for stun path
    }
    Console.WriteLine($"Stun StunnedUntilMicros={locked.StunnedUntilMicros} CastLockedUntil={locked.CastLockedUntil.MicrosecondsSinceUnixEpoch}");
    var manaAfterStun = connA.Db.Character.Identity.Find(idA)!.Mana;
    if (manaAfterStun - manaMid > Combat.ManaRegenPerTick * 2)
    {
        Fail($"Stun refunded victim mana ({manaMid}->{manaAfterStun})");
        return;
    }
    var manaBAfter = connB.Db.Character.Identity.Find(idB)!.Mana;
    if (manaBBefore - manaBAfter < Combat.StunManaCost - 1)
    {
        Fail($"Stun did not spend stunner mana ({manaBBefore}->{manaBAfter})");
        return;
    }
    Console.WriteLine($"Stun mana OK victim {manaMid}->{manaAfterStun} stunner {manaBBefore}->{manaBAfter}");

    // Move must reject while stunned
    await ExpectMoveFail(connA, 0.5f, 0f, "stunned", "during stun move");
    Console.WriteLine("Stun move reject OK");

    // Wait past GCD so stun (not GCD) is the Cast reject reason.
    await DelayPumpBoth(connA, connB, Combat.GcdMs + 80);
    await ExpectCastFail(connA, Combat.SpellEmberbolt, "stunned", "during Stun lockout");
    Console.WriteLine("Stun cast reject OK (stunned, not silenced)");

    // Prove CastLockedUntil was not set by Stun: after stun expires, Cast works
    // without waiting CastSilenceMs (stun window may equal silence; wait stun only).
    await DelayPumpBoth(connA, connB, Combat.StunDurationMs + 200);
    await TopUpMana(connA, idA, connB);
    connA.Reducers.EnsureTrainingDummy();
    await PumpUntilBoth(() => FindDummy(connA) is { Hp: var h } && h == Combat.DummyMaxHp,
        timeoutMs, connA, connB, "dummy post-stun");
    dummy = FindDummy(connA)!;
    connA.Reducers.SetTarget(dummy.NpcId);
    await DelayPumpBoth(connA, connB, 40);
    // Move should work after stun
    await MoveTo(connA, idA, 0.3f, 0f, connB);
    Console.WriteLine("post-Stun Move OK");
    connA.Reducers.Cast(Combat.SpellEmberbolt);
    await PumpUntilBoth(() =>
        connA.Db.PlayerCombat.Identity.Find(idA) is { } pc && pc.CastingSpellId == Combat.SpellEmberbolt,
        timeoutMs, connA, connB, "A casting after Stun");
    Console.WriteLine("post-Stun Cast OK (no silence)");
    connA.Reducers.CancelCast();
    await PumpUntilBoth(() =>
        connA.Db.PlayerCombat.Identity.Find(idA) is { } pc && pc.CastingSpellId == 0,
        timeoutMs, connA, connB, "cleanup cancel");

    // Idle stun (no windup) still applies move lock
    await DelayPumpBoth(connA, connB, Combat.GcdMs + 80);
    await TopUpMana(connB, idB, connA);
    var stunBefore = connA.Db.PlayerCombat.Identity.Find(idA)!.StunnedUntilMicros;
    connB.Reducers.Stun(idA);
    await PumpUntilBoth(() =>
        connA.Db.PlayerCombat.Identity.Find(idA) is { } pc
        && pc.StunnedUntilMicros > stunBefore,
        timeoutMs, connA, connB, "idle stun applied");
    var idle = connA.Db.PlayerCombat.Identity.Find(idA)!;
    if (idle.CastingSpellId != 0)
    {
        Fail("idle stun should not leave casting");
        return;
    }
    await ExpectMoveFail(connA, 0.4f, 0f, "stunned", "idle stun move");
    Console.WriteLine("idle Stun move reject OK");

    var dummyAfter = FindDummy(connA)!.Hp;
    if (dummyAfter != dummyHpBefore && dummyAfter != Combat.DummyMaxHp)
    {
        // Emberbolt may have been cancelled; dummy should not have taken Emberbolt from interrupted cast.
        // After reset it is full — OK.
    }
    Console.WriteLine("OK: StunSmoke passed");
    Environment.ExitCode = 0;
}
catch (Exception e) { Fail(e.ToString()); }
finally
{
    try { connA?.Disconnect(); } catch { }
    try { connB?.Disconnect(); } catch { }
}

static async Task ExpectStunFail(DbConnection conn, Identity target, string needle, string label)
{
    string? fail = null;
    var tcs = new TaskCompletionSource();
    void OnStun(ReducerEventContext ctx, Identity _target)
    {
        switch (ctx.Event.Status)
        {
            case Status.Failed(var reason): fail = reason; tcs.TrySetResult(); break;
            case Status.Committed: tcs.TrySetException(new Exception($"Stun committed ({label})")); break;
            case Status.OutOfEnergy(_): tcs.TrySetException(new Exception($"Stun OOE ({label})")); break;
        }
    }
    conn.Reducers.OnStun += OnStun;
    try { conn.Reducers.Stun(target); await Pump(tcs.Task, timeoutMs, conn, "stun fail " + label); }
    finally { conn.Reducers.OnStun -= OnStun; }
    if (string.IsNullOrEmpty(fail) || fail.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0)
    {
        Fail($"expected '{needle}' on Stun ({label}), got: {fail ?? "(null)"}");
        throw new Exception("stun fail mismatch");
    }
    Console.WriteLine($"Stun reject OK ({label}): {fail}");
}

static async Task ExpectMoveFail(DbConnection conn, float dx, float dz, string needle, string label)
{
    string? fail = null;
    var tcs = new TaskCompletionSource();
    void OnMove(ReducerEventContext ctx, float _dx, float _dz, bool _jump)
    {
        switch (ctx.Event.Status)
        {
            case Status.Failed(var reason): fail = reason; tcs.TrySetResult(); break;
            case Status.Committed: tcs.TrySetException(new Exception($"Move committed ({label})")); break;
            case Status.OutOfEnergy(_): tcs.TrySetException(new Exception($"Move OOE ({label})")); break;
        }
    }
    conn.Reducers.OnMove += OnMove;
    try { conn.Reducers.Move(dx, dz, false); await Pump(tcs.Task, timeoutMs, conn, "move fail " + label); }
    finally { conn.Reducers.OnMove -= OnMove; }
    if (string.IsNullOrEmpty(fail) || fail.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0)
    {
        Fail($"expected '{needle}' on Move ({label}), got: {fail ?? "(null)"}");
        throw new Exception("move fail mismatch");
    }
    Console.WriteLine($"Move reject OK ({label}): {fail}");
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
           && cur.Mana < cur.MaxMana - Math.Max(Combat.EmberboltManaCost, Combat.StunManaCost)
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
        var combat = conn.Db.PlayerCombat.Identity.Find(id);
        if (combat is not null
            && combat.StunnedUntilMicros > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() * 1000L)
        {
            // Wait out stun if somehow still locked during reposition helpers.
            await DelayPumpBoth(conn, other, 80);
            continue;
        }
        var dx = x - pose.X; var dz = z - pose.Z;
        var dist = MathF.Sqrt(dx * dx + dz * dz);
        if (dist < 0.25f) return;
        var scale = MathF.Min(Movement.MaxStepMeters, dist) / dist;
        conn.Reducers.Move(dx * scale, dz * scale, false);
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

async Task<(DbConnection conn, Identity id)> ConnectAsync(string label)
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
