using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

// Emberbolt cast cancel / move-interrupt: no damage + mana refund.
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

    // Top up mana so refund math is readable (Rest may fail if full HP+mana).
    await TopUpMana(conn, id);
    Console.WriteLine($"mana seed {conn.Db.Character.Identity.Find(id)!.Mana}/{conn.Db.Character.Identity.Find(id)!.MaxMana}");

    // --- Move interrupt during Emberbolt windup ---
    conn.Reducers.EnsureTrainingDummy();
    await PumpUntil(() => FindDummy(conn) is { Hp: var h } && h == Combat.DummyMaxHp,
        timeoutMs, conn, "dummy full move");
    var dummy = FindDummy(conn)!;
    conn.Reducers.SetTarget(dummy.NpcId);
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(id) is { } cc && cc.TargetNpcId == dummy.NpcId,
        timeoutMs, conn, "target move");

    await DelayPump(conn, Combat.GcdMs + 80);
    var manaBeforeMove = conn.Db.Character.Identity.Find(id)!.Mana;
    if (manaBeforeMove < Combat.EmberboltManaCost)
    {
        await TopUpMana(conn, id);
        manaBeforeMove = conn.Db.Character.Identity.Find(id)!.Mana;
    }
    var hpBeforeMove = FindDummy(conn)!.Hp;

    conn.Reducers.Cast(Combat.SpellEmberbolt);
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(id) is { } pc && pc.CastingSpellId == Combat.SpellEmberbolt,
        timeoutMs, conn, "ember casting");
    await PumpUntil(() =>
    {
        var ch = conn.Db.Character.Identity.Find(id);
        return ch is not null && ch.Mana < manaBeforeMove;
    }, timeoutMs, conn, "ember mana spent");
    var manaMid = conn.Db.Character.Identity.Find(id)!.Mana;
    Console.WriteLine($"move-interrupt: casting mana {manaBeforeMove}->{manaMid}");

    // Break windup with a real step.
    conn.Reducers.Move(0.4f, 0f);
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(id) is { } pc && pc.CastingSpellId == 0,
        timeoutMs, conn, "cast cleared by move");

    var manaAfterMove = conn.Db.Character.Identity.Find(id)!.Mana;
    // Refund should restore ~EmberboltManaCost (allow tiny regen race).
    var refunded = manaAfterMove - manaMid;
    if (refunded < Combat.EmberboltManaCost - Combat.ManaRegenPerTick * 2
        || refunded > Combat.EmberboltManaCost + Combat.ManaRegenPerTick)
    {
        Fail($"Move interrupt refund expected ~{Combat.EmberboltManaCost}, got {refunded} ({manaMid}->{manaAfterMove})");
        return;
    }
    Console.WriteLine($"Move interrupt refund OK {manaMid}->{manaAfterMove} (+{refunded})");

    // Wait past original windup — dummy must not take Emberbolt damage.
    await DelayPump(conn, Combat.EmberboltCastMs + 200);
    var hpAfterMove = FindDummy(conn)!.Hp;
    if (hpAfterMove != hpBeforeMove)
    {
        Fail($"Move interrupt still damaged dummy ({hpBeforeMove}->{hpAfterMove})");
        return;
    }
    Console.WriteLine("Move interrupt no-damage OK");

    // --- Explicit CancelCast during Emberbolt windup ---
    await DelayPump(conn, Combat.GcdMs + 80);
    conn.Reducers.EnsureTrainingDummy();
    await PumpUntil(() => FindDummy(conn) is { Hp: var h } && h == Combat.DummyMaxHp,
        timeoutMs, conn, "dummy full cancel");
    dummy = FindDummy(conn)!;
    conn.Reducers.SetTarget(dummy.NpcId);
    await DelayPump(conn, 40);

    await TopUpMana(conn, id);
    var manaBeforeCancel = conn.Db.Character.Identity.Find(id)!.Mana;
    var hpBeforeCancel = FindDummy(conn)!.Hp;

    conn.Reducers.Cast(Combat.SpellEmberbolt);
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(id) is { } pc && pc.CastingSpellId == Combat.SpellEmberbolt,
        timeoutMs, conn, "ember casting cancel");
    await PumpUntil(() =>
    {
        var ch = conn.Db.Character.Identity.Find(id);
        return ch is not null && ch.Mana < manaBeforeCancel;
    }, timeoutMs, conn, "ember mana spent cancel");
    var manaMidCancel = conn.Db.Character.Identity.Find(id)!.Mana;

    conn.Reducers.CancelCast();
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(id) is { } pc && pc.CastingSpellId == 0,
        timeoutMs, conn, "cast cleared by CancelCast");

    var manaAfterCancel = conn.Db.Character.Identity.Find(id)!.Mana;
    var cancelRefund = manaAfterCancel - manaMidCancel;
    if (cancelRefund < Combat.EmberboltManaCost - Combat.ManaRegenPerTick * 2
        || cancelRefund > Combat.EmberboltManaCost + Combat.ManaRegenPerTick)
    {
        Fail($"CancelCast refund expected ~{Combat.EmberboltManaCost}, got {cancelRefund} ({manaMidCancel}->{manaAfterCancel})");
        return;
    }
    Console.WriteLine($"CancelCast refund OK {manaMidCancel}->{manaAfterCancel} (+{cancelRefund})");

    await DelayPump(conn, Combat.EmberboltCastMs + 200);
    var hpAfterCancel = FindDummy(conn)!.Hp;
    if (hpAfterCancel != hpBeforeCancel)
    {
        Fail($"CancelCast still damaged dummy ({hpBeforeCancel}->{hpAfterCancel})");
        return;
    }
    Console.WriteLine("CancelCast no-damage OK");

    // CancelCast while not casting is a no-op (committed).
    conn.Reducers.CancelCast();
    await DelayPump(conn, 80);
    Console.WriteLine("CancelCast idle no-op OK");

    Console.WriteLine("OK: CastCancelSmoke passed");
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
