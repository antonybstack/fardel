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

    if (conn.Db.Character.Identity.Find(identity) is { StaffEquipped: false })
    {
        conn.Reducers.EquipStaff();
        await PumpUntil(() => conn.Db.Character.Identity.Find(identity) is { StaffEquipped: true },
            timeoutMs, conn, "staff equipped");
    }

    await PumpUntil(() => CountHostiles(conn) >= 2, timeoutMs, conn, "two hostiles");
    var dummy = FindDummy(conn) ?? throw new Exception("dummy trainer missing");
    if (dummy.Hp <= 0)
    {
        Fail("dummy trainer hp <= 0");
        return;
    }
    if (dummy.Kind != Combat.NpcKindDummy)
    {
        Fail($"dummy kind={dummy.Kind} want {Combat.NpcKindDummy}");
        return;
    }

    var living = LivingHostiles(conn).ToList();
    if (living.Count < 2)
    {
        Fail($"expected 2 living hostiles, got {living.Count}");
        return;
    }
    var nearA = 0;
    var nearB = 0;
    foreach (var h in living)
    {
        if (h.Kind != Combat.NpcKindHostile)
        {
            Fail($"hostile id={h.NpcId} kind={h.Kind}");
            return;
        }
        if (h.Hp <= 0 || h.MaxHp != Combat.HostileMaxHp)
        {
            Fail($"hostile id={h.NpcId} hp={h.Hp}/{h.MaxHp} want MaxHp={Combat.HostileMaxHp}");
            return;
        }
        if (MathF.Abs(h.X) < 0.2f && MathF.Abs(h.Z) < 0.2f)
        {
            Fail($"hostile id={h.NpcId} spawned at origin");
            return;
        }
        if (Near(h.X, h.Z, Combat.HostileSpawnAx, Combat.HostileSpawnAz)) nearA++;
        if (Near(h.X, h.Z, Combat.HostileSpawnBx, Combat.HostileSpawnBz)) nearB++;
        Console.WriteLine($"hostile id={h.NpcId} hp={h.Hp}/{h.MaxHp} xz=({h.X:0.##},{h.Z:0.##})");
    }
    if (nearA < 1 || nearB < 1)
    {
        Fail($"hostiles not on yard pads A/B (nearA={nearA} nearB={nearB})");
        return;
    }

    var casterHp0 = conn.Db.Character.Identity.Find(identity)!.Hp;
    var victim = living[0];
    conn.Reducers.SetTarget(victim.NpcId);
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(identity) is { } cc && cc.TargetNpcId == victim.NpcId,
        timeoutMs, conn, "target hostile");

    while (FindNpc(conn, victim.NpcId) is { Hp: > 0 })
    {
        var before = FindNpc(conn, victim.NpcId)!.Hp;
        conn.Reducers.Cast(Combat.SpellSpark);
        await PumpUntil(() =>
        {
            var n = FindNpc(conn, victim.NpcId);
            return n is null || n.Hp < before || n.Hp == 0;
        }, timeoutMs, conn, "spark tick");
        await DelayPump(conn, Combat.GcdMs + 50);
    }

    var dead = FindNpc(conn, victim.NpcId);
    if (dead is null || dead.Hp != 0)
    {
        Fail($"hostile did not die (hp={dead?.Hp})");
        return;
    }
    if (!LivingHostiles(conn).Any())
    {
        Fail("second hostile disappeared");
        return;
    }
    if (FindDummy(conn) is not { Hp: > 0 } dummyAfter || dummyAfter.NpcId != dummy.NpcId)
    {
        Fail("dummy trainer gone after hostile kill");
        return;
    }
    var casterHp1 = conn.Db.Character.Identity.Find(identity)!.Hp;
    if (casterHp1 != casterHp0)
    {
        Fail($"hostile kill applied dummy thorns (hp {casterHp0}->{casterHp1})");
        return;
    }

    Console.WriteLine("OK: HostileSpawnSmoke passed");
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

static int CountHostiles(DbConnection conn)
{
    var n = 0;
    foreach (var row in conn.Db.Npc.Iter())
    {
        if (row.Kind == Combat.NpcKindHostile) n++;
    }
    return n;
}

static IEnumerable<Npc> LivingHostiles(DbConnection conn)
{
    foreach (var row in conn.Db.Npc.Iter())
    {
        if (row.Kind == Combat.NpcKindHostile && row.Hp > 0) yield return row;
    }
}

static bool Near(float x, float z, float ox, float oz)
{
    var dx = x - ox;
    var dz = z - oz;
    return dx * dx + dz * dz < 0.25f;
}

static Npc? FindDummy(DbConnection conn)
{
    foreach (var n in conn.Db.Npc.Iter())
    {
        if (n.Kind == Combat.NpcKindDummy) return n;
    }
    return null;
}

static Npc? FindNpc(DbConnection conn, ulong id)
{
    foreach (var n in conn.Db.Npc.Iter())
    {
        if (n.NpcId == id) return n;
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
