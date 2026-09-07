using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

// After hard interrupt, CastLockedUntil gates Cast with "silenced" until expiry.
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

    conn.Reducers.Cast(Combat.SpellEmberbolt);
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(id) is { } pc && pc.CastingSpellId == Combat.SpellEmberbolt,
        timeoutMs, conn, "ember casting");
    await PumpUntil(() =>
    {
        var ch = conn.Db.Character.Identity.Find(id);
        return ch is not null && ch.Mana < manaBefore;
    }, timeoutMs, conn, "ember mana spent");

    // Soft pushbacks then hard interrupt
    for (var i = 0; i < Combat.CastPushbackHardAfter; i++)
    {
        var hp0 = conn.Db.Character.Identity.Find(id)!.Hp;
        conn.Reducers.DummyStrike();
        await PumpUntil(() =>
        {
            var ch = conn.Db.Character.Identity.Find(id);
            return ch is not null && ch.Hp < hp0;
        }, timeoutMs, conn, $"pushback strike {i + 1}");
        var combat = conn.Db.PlayerCombat.Identity.Find(id)!;
        if (combat.CastingSpellId != Combat.SpellEmberbolt)
        {
            Fail($"expected still casting after pushback #{i + 1}");
            return;
        }
        await DelayPump(conn, 40);
    }

    var hpHard = conn.Db.Character.Identity.Find(id)!.Hp;
    conn.Reducers.DummyStrike();
    await PumpUntil(() =>
    {
        var ch = conn.Db.Character.Identity.Find(id);
        return ch is not null && ch.Hp < hpHard;
    }, timeoutMs, conn, "hard interrupt thorns");
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(id) is { } pc && pc.CastingSpellId == 0,
        timeoutMs, conn, "cast cleared by hard interrupt");

    var locked = conn.Db.PlayerCombat.Identity.Find(id)!;
    var lockUs = locked.CastLockedUntil.MicrosecondsSinceUnixEpoch;
    if (lockUs <= 0)
    {
        Fail("CastLockedUntil not set after hard interrupt");
        return;
    }
    Console.WriteLine($"CastLockedUntil micros={lockUs}");

    // Wait past GCD so silence (not GCD) is the reject reason.
    await DelayPump(conn, Combat.GcdMs + 80);
    await TopUpMana(conn, id);

    // Ensure still locked
    locked = conn.Db.PlayerCombat.Identity.Find(id)!;
    // Client wall clock is approximate; just attempt Cast and expect silenced.
    await ExpectCastFail(conn, Combat.SpellEmberbolt, "silenced", "during silence");

    var manaDuring = conn.Db.Character.Identity.Find(id)!.Mana;
    Console.WriteLine($"silenced reject OK mana unchanged-ish={manaDuring}");

    // Wait out silence window (+ small buffer).
    await DelayPump(conn, Combat.CastSilenceMs + 200);

    // Cast must succeed after expiry.
    var manaReady = conn.Db.Character.Identity.Find(id)!.Mana;
    if (manaReady < Combat.EmberboltManaCost)
    {
        await TopUpMana(conn, id);
        manaReady = conn.Db.Character.Identity.Find(id)!.Mana;
    }
    conn.Reducers.EnsureTrainingDummy();
    await PumpUntil(() => FindDummy(conn) is { Hp: var h } && h == Combat.DummyMaxHp,
        timeoutMs, conn, "dummy full post-silence");
    dummy = FindDummy(conn)!;
    conn.Reducers.SetTarget(dummy.NpcId);
    await DelayPump(conn, 40);

    conn.Reducers.Cast(Combat.SpellEmberbolt);
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(id) is { } pc && pc.CastingSpellId == Combat.SpellEmberbolt,
        timeoutMs, conn, "ember casting after silence");
    await PumpUntil(() =>
    {
        var ch = conn.Db.Character.Identity.Find(id);
        return ch is not null && ch.Mana < manaReady;
    }, timeoutMs, conn, "ember mana spent after silence");
    Console.WriteLine("post-silence Cast OK");

    // Soft cancel should NOT re-apply silence.
    conn.Reducers.CancelCast();
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(id) is { } pc && pc.CastingSpellId == 0,
        timeoutMs, conn, "cancel cleared");
    await DelayPump(conn, Combat.GcdMs + 80);
    await TopUpMana(conn, id);

    // Soft-cancel path: Cast should work immediately (no silence).
    conn.Reducers.Cast(Combat.SpellEmberbolt);
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(id) is { } pc && pc.CastingSpellId == Combat.SpellEmberbolt,
        timeoutMs, conn, "ember after soft cancel");
    conn.Reducers.CancelCast();
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(id) is { } pc && pc.CastingSpellId == 0,
        timeoutMs, conn, "soft cancel again");
    Console.WriteLine("soft cancel does not silence OK");

    Console.WriteLine("OK: CastSilenceSmoke passed");
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
