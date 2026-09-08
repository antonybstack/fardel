using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

var uri = GameConstants.ResolveLocalUri();
var db = GameConstants.ResolveDatabaseName();
const int timeoutMs = 50000;

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

    await PumpUntil(() => conn.Db.Character.Identity.Find(identity) is not null
        && conn.Db.PlayerPose.Identity.Find(identity) is not null, timeoutMs, conn, "character+pose");

    if (conn.Db.Character.Identity.Find(identity) is { StaffEquipped: false })
    {
        conn.Reducers.EquipStaff();
        await PumpUntil(() => conn.Db.Character.Identity.Find(identity) is { StaffEquipped: true },
            timeoutMs, conn, "staff equipped");
    }

    await PumpUntil(() => CountHostiles(conn) >= 2, timeoutMs, conn, "two hostiles");
    var dummy = FindDummy(conn) ?? throw new Exception("dummy trainer missing");
    if (dummy.Kind != Combat.NpcKindDummy || dummy.Hp <= 0)
    {
        Fail($"dummy kind={dummy.Kind} hp={dummy.Hp}");
        return;
    }

    var padA = FindHostileNear(conn, Combat.HostileSpawnAx, Combat.HostileSpawnAz)
        ?? throw new Exception("hostile pad A missing");
    var padB = FindHostileNear(conn, Combat.HostileSpawnBx, Combat.HostileSpawnBz)
        ?? throw new Exception("hostile pad B missing");
    if (padA.Kind != Combat.NpcKindHostile || padB.Kind != Combat.NpcKindHostile)
    {
        Fail($"kinds A={padA.Kind} B={padB.Kind}");
        return;
    }
    if (padA.Hp <= 0 || padA.MaxHp != Combat.HostileMaxHp || padB.Hp <= 0)
    {
        Fail($"hp A={padA.Hp}/{padA.MaxHp} B={padB.Hp}/{padB.MaxHp}");
        return;
    }
    if (padA.Aggroed || padB.Aggroed)
    {
        Fail("hostiles aggroed at spawn (origin should be outside AggroRadius)");
        return;
    }
    Console.WriteLine($"spawn A id={padA.NpcId} B id={padB.NpcId} dummy id={dummy.NpcId}");

    var hp0 = conn.Db.Character.Identity.Find(identity)!.Hp;
    if (hp0 <= Combat.HostileAttackDamage)
    {
        Fail($"hp {hp0} too low to prove a swing");
        return;
    }

    var a0x = padA.X;
    var a0z = padA.Z;
    await MoveToward(conn, identity, Combat.HostileSpawnAx, Combat.HostileSpawnAz);
    await PumpUntil(() =>
    {
        var a = FindNpc(conn, padA.NpcId);
        return a is { Aggroed: true } || (a is not null && Dist(a.X, a.Z, a0x, a0z) > 0.6f);
    }, timeoutMs, conn, "hostile A pulled");

    var pulled = FindNpc(conn, padA.NpcId)!;
    if (Dist(pulled.X, pulled.Z, a0x, a0z) <= 0.35f && !pulled.Aggroed)
    {
        Fail("hostile A did not leave pad");
        return;
    }
    var stillB = FindNpc(conn, padB.NpcId)!;
    if (stillB.Aggroed)
    {
        Fail("hostile B aggroed while pulling A");
        return;
    }
    Console.WriteLine($"aggro A xz=({pulled.X:0.##},{pulled.Z:0.##}) aggro={pulled.Aggroed}");

    await PumpUntil(() =>
    {
        var ch = conn.Db.Character.Identity.Find(identity);
        return ch is { Hp: var hp } && hp < hp0 && hp > 0;
    }, timeoutMs, conn, "hp dropped in melee");

    var hpHit = conn.Db.Character.Identity.Find(identity)!.Hp;
    if (hp0 - hpHit < Combat.HostileAttackDamage)
    {
        Fail($"hp drop {hp0}->{hpHit} smaller than HostileAttackDamage {Combat.HostileAttackDamage}");
        return;
    }
    Console.WriteLine($"damage hp {hp0}->{hpHit}");

    conn.Reducers.SetTarget(padA.NpcId);
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(identity) is { } cc && cc.TargetNpcId == padA.NpcId,
        timeoutMs, conn, "target A");

    while (FindNpc(conn, padA.NpcId) is { Hp: > 0 })
    {
        var ch = conn.Db.Character.Identity.Find(identity);
        if (ch is null || ch.Hp <= 0)
        {
            Fail("player died before hostile death");
            return;
        }
        var before = FindNpc(conn, padA.NpcId)!.Hp;
        conn.Reducers.Cast(Combat.SpellSpark);
        await PumpUntil(() =>
        {
            var n = FindNpc(conn, padA.NpcId);
            return n is null || n.Hp < before || n.Hp == 0;
        }, timeoutMs, conn, "spark tick");
        await DelayPump(conn, Combat.GcdMs + 50);
    }

    var dead = FindNpc(conn, padA.NpcId);
    if (dead is null || dead.Hp != 0)
    {
        Fail($"hostile A did not die (hp={dead?.Hp})");
        return;
    }
    if (FindNpc(conn, padB.NpcId) is not { Hp: > 0 })
    {
        Fail("hostile B died with A");
        return;
    }
    if (FindDummy(conn) is not { Hp: > 0 } dummyEnd || dummyEnd.NpcId != dummy.NpcId)
    {
        Fail("dummy trainer gone after hostile death");
        return;
    }

    Console.WriteLine($"OK: HostileSmoke passed spawn aggro damage {hp0}->{hpHit} death");
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

static Npc? FindDummy(DbConnection conn)
{
    foreach (var n in conn.Db.Npc.Iter())
    {
        if (n.Kind == Combat.NpcKindDummy) return n;
    }
    return null;
}

static Npc? FindHostileNear(DbConnection conn, float x, float z)
{
    foreach (var n in conn.Db.Npc.Iter())
    {
        if (n.Kind != Combat.NpcKindHostile) continue;
        var hx = MathF.Abs(n.SpawnX) > 0.01f || MathF.Abs(n.SpawnZ) > 0.01f ? n.SpawnX : n.X;
        var hz = MathF.Abs(n.SpawnX) > 0.01f || MathF.Abs(n.SpawnZ) > 0.01f ? n.SpawnZ : n.Z;
        if (Dist(hx, hz, x, z) < 0.5f) return n;
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

static float Dist(float x, float z, float ox, float oz)
{
    var dx = x - ox;
    var dz = z - oz;
    return MathF.Sqrt(dx * dx + dz * dz);
}

static async Task MoveToward(DbConnection conn, Identity id, float tx, float tz)
{
    var guard = 0;
    while (guard++ < 120)
    {
        var p = conn.Db.PlayerPose.Identity.Find(id)!;
        var dx = tx - p.X;
        var dz = tz - p.Z;
        var dist = MathF.Sqrt(dx * dx + dz * dz);
        if (dist <= 0.4f) break;
        var scale = MathF.Min(Movement.MaxStepMeters, dist) / dist;
        conn.Reducers.Move(dx * scale, dz * scale, false);
        await DelayPump(conn, 25);
    }
    await DelayPump(conn, 80);
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
