using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

// Long-lived second identity for shared-yard VE proof (pose + remote cast telegraphs).
var uri = GameConstants.ResolveLocalUri();
var db = GameConstants.ResolveDatabaseName();
const float targetX = 4.0f;
const float targetZ = 2.5f;
const int timeoutMs = 30000;

var connected = new TaskCompletionSource<Identity>();
var subscribed = new TaskCompletionSource();

DbConnection? conn = null;

try
{
    conn = DbConnection.Builder()
        .WithUri(uri)
        .WithDatabaseName(db)
        .OnConnect((c, identity, _) =>
        {
            connected.TrySetResult(identity);
        })
        .OnConnectError(e => connected.TrySetException(e))
        .OnDisconnect((_, e) =>
        {
            Console.Error.WriteLine("disconnected: " + (e?.Message ?? "ok"));
        })
        .Build();

    if (!await WaitTick(connected.Task, timeoutMs, conn, "connect"))
    {
        Fail("connect timeout");
        return;
    }

    var identity = await connected.Task;
    Console.WriteLine("second-client connected " + identity);

    conn.SubscriptionBuilder()
        .OnApplied(_ => subscribed.TrySetResult())
        .OnError((_, e) => subscribed.TrySetException(e))
        .SubscribeToAllTables();

    if (!await WaitTick(subscribed.Task, timeoutMs, conn, "subscribe"))
    {
        Fail("subscribe timeout");
        return;
    }

    if (conn.Db.PlayerPose.Identity.Find(identity) is not { } pose)
    {
        Fail("PlayerPose missing after subscribe");
        return;
    }

    Console.WriteLine($"spawn ({pose.X}, {pose.Z})");

    if (conn.Db.Character.Identity.Find(identity) is { StaffEquipped: false })
    {
        conn.Reducers.EquipStaff();
        await Frame(conn, 200);
    }

    conn.Reducers.EnsureTrainingDummy();
    await Frame(conn, 200);

    // In-range pads vs dummy (5,0). CastRange=8; (-3,3) was OOR so Emberbolt never
    // stuck CastingSpellId. Walk between pads for ?ve=remote-walk, then stand-cast
    // for ?ve=remote-cast (Move during windup cancels).
    var goPlus = true;
    var castRound = 0;
    while (true)
    {
        var destX = goPlus ? targetX : 2.0f;
        var destZ = goPlus ? targetZ : -2.0f;
        var walkGuard = DateTime.UtcNow.AddSeconds(8);
        while (DateTime.UtcNow < walkGuard)
        {
            if (conn.Db.PlayerPose.Identity.Find(identity) is not { } cur)
            {
                await Frame(conn, 50);
                continue;
            }

            var dx = destX - cur.X;
            var dz = destZ - cur.Z;
            var dist = MathF.Sqrt(dx * dx + dz * dz);
            if (dist < 0.4f)
            {
                Console.WriteLine($"pad ({cur.X:F1}, {cur.Z:F1})");
                break;
            }

            var scale = MathF.Min(Movement.MaxStepMeters, dist) / dist;
            conn.Reducers.Move(dx * scale, dz * scale, false);
            await Frame(conn, 50);
        }
        goPlus = !goPlus;

        if (conn.Db.PlayerPose.Identity.Find(identity) is { } readyPose)
        {
            Console.WriteLine($"READY remotes-visible-at ({readyPose.X:F2}, {readyPose.Z:F2}) identity={identity}");
        }

        conn.Reducers.EnsureTrainingDummy();
        await Frame(conn, 100);

        var dummy = FindDummy(conn);
        if (dummy is null || dummy.Hp <= 0)
        {
            await Frame(conn, 200);
            continue;
        }

        if (conn.Db.Character.Identity.Find(identity) is { Hp: <= 0 })
        {
            await Frame(conn, 400);
            continue;
        }

        if (conn.Db.Character.Identity.Find(identity) is { StaffEquipped: false })
        {
            conn.Reducers.EquipStaff();
            await Frame(conn, 150);
        }

        var combat = conn.Db.PlayerCombat.Identity.Find(identity);
        if (combat is null)
        {
            await Frame(conn, 100);
            continue;
        }

        if (combat.TargetNpcId != dummy.NpcId)
        {
            conn.Reducers.SetTarget(dummy.NpcId);
            Console.WriteLine($"SetTarget dummy #{dummy.NpcId}");
            await Frame(conn, 150);
            combat = conn.Db.PlayerCombat.Identity.Find(identity);
        }

        if (combat is { CastingSpellId: not 0 })
        {
            await Frame(conn, Combat.EmberboltCastMs);
            continue;
        }

        var nowMicros = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() * 1000L;
        if (combat is { } c2 && c2.GcdReadyAt.MicrosecondsSinceUnixEpoch > nowMicros)
        {
            await Frame(conn, 80);
            continue;
        }

        castRound++;
        Console.WriteLine($"Cast Emberbolt #{castRound} → dummy hp={dummy.Hp}");
        try
        {
            conn.Reducers.Cast(Combat.SpellEmberbolt);
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("cast error: " + e.Message);
        }

        // Hold still through windup so the browser sees CastingSpellId + Spell1.
        await Frame(conn, Combat.EmberboltCastMs + Combat.GcdMs + 200);
    }
}
catch (Exception e)
{
    Fail(e.ToString());
}
finally
{
    try { conn?.Disconnect(); } catch { /* ignore */ }
}

static Npc? FindDummy(DbConnection conn)
{
    foreach (var n in conn.Db.Npc.Iter())
    {
        if (n.Kind == 1)
        {
            return n;
        }
    }
    return null;
}

static void Fail(string msg)
{
    Console.Error.WriteLine("FAIL: " + msg);
    Environment.ExitCode = 1;
}

static async Task Frame(DbConnection conn, int ms)
{
    var until = DateTime.UtcNow.AddMilliseconds(ms);
    while (DateTime.UtcNow < until)
    {
        conn.FrameTick();
        await Task.Delay(16);
    }
}

static async Task<bool> WaitTick(Task task, int timeoutMs, DbConnection conn, string label)
{
    var until = DateTime.UtcNow.AddMilliseconds(timeoutMs);
    while (!task.IsCompleted && DateTime.UtcNow < until)
    {
        conn.FrameTick();
        await Task.Delay(16);
    }
    if (!task.IsCompleted)
    {
        Console.Error.WriteLine($"timeout waiting for {label}");
        return false;
    }
    await task;
    return true;
}
