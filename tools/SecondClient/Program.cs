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

    var sheath = string.Equals(
        Environment.GetEnvironmentVariable("FARDEL_SECOND_SHEATH"),
        "1",
        StringComparison.OrdinalIgnoreCase);
    var hop = string.Equals(
        Environment.GetEnvironmentVariable("FARDEL_SECOND_HOP"),
        "1",
        StringComparison.OrdinalIgnoreCase);
    var suicide = string.Equals(
        Environment.GetEnvironmentVariable("FARDEL_SECOND_DIE"),
        "1",
        StringComparison.OrdinalIgnoreCase);
    var walkStop = string.Equals(
        Environment.GetEnvironmentVariable("FARDEL_SECOND_WALK_STOP"),
        "1",
        StringComparison.OrdinalIgnoreCase);

    if (!sheath && conn.Db.Character.Identity.Find(identity) is { StaffEquipped: false })
    {
        conn.Reducers.EquipStaff();
        await Frame(conn, 200);
    }

    conn.Reducers.EnsureTrainingDummy();
    await Frame(conn, 200);

    if (sheath)
    {
        // ?ve=remote-sheathed: stand west of origin (outside HostileAggroRadius 3;
        // pads A/B/C are ~7.6m). Do not walk to (4, 2.5) — leftover DIE
        // identity / pad-C path reads as a Death pose. Wait for respawn.
        var aliveGuard = DateTime.UtcNow.AddSeconds(20);
        while (DateTime.UtcNow < aliveGuard)
        {
            var ch = conn.Db.Character.Identity.Find(identity);
            if (ch is { Hp: > 0 }) break;
            Console.WriteLine("sheath: waiting respawn");
            await Frame(conn, Combat.RespawnDelayMs + 250);
        }
        if (conn.Db.Character.Identity.Find(identity) is { StaffEquipped: true })
        {
            conn.Reducers.UnequipStaff();
            await Frame(conn, 200);
        }
        // West of origin: outside AggroRadius 3 vs A/B/C, not stacked on
        // yard-origin corpses from other VE identities.
        const float sheathX = -2.5f;
        const float sheathZ = 0f;
        var walkGuard = DateTime.UtcNow.AddSeconds(8);
        while (DateTime.UtcNow < walkGuard)
        {
            if (conn.Db.Character.Identity.Find(identity) is { Hp: <= 0 })
            {
                await Frame(conn, 200);
                continue;
            }
            if (conn.Db.PlayerPose.Identity.Find(identity) is not { } cur)
            {
                await Frame(conn, 50);
                continue;
            }
            var dx = sheathX - cur.X;
            var dz = sheathZ - cur.Z;
            var dist = MathF.Sqrt(dx * dx + dz * dz);
            if (dist < 0.4f)
            {
                Console.WriteLine($"sheath-pad ({cur.X:F1}, {cur.Z:F1})");
                break;
            }
            var scale = MathF.Min(Movement.MaxStepMeters, dist) / dist;
            conn.Reducers.Move(dx * scale, dz * scale, false);
            await Frame(conn, 50);
        }
        if (conn.Db.PlayerPose.Identity.Find(identity) is { } sheathPose)
        {
            Console.WriteLine($"READY sheath-pad ({sheathPose.X:F2}, {sheathPose.Z:F2}) identity={identity}");
        }
        while (true)
        {
            var ch = conn.Db.Character.Identity.Find(identity);
            if (ch is { Hp: <= 0 })
            {
                await Frame(conn, Combat.RespawnDelayMs + 250);
                continue;
            }
            if (ch is { StaffEquipped: true })
            {
                conn.Reducers.UnequipStaff();
            }
            await Frame(conn, 400);
        }
    }
    if (walkStop)
    {
        // ?ve=remote-walk-stop: walk then stand so the browser sees Walk then
        // Idle_Weapon (no leftover stride). South-west of origin — outside
        // AggroRadius 3 vs A/B/C + dummy, not stacked on hop (0, −6) or
        // sheath (−2.5, 0). Keep staff on.
        var aliveGuard = DateTime.UtcNow.AddSeconds(20);
        while (DateTime.UtcNow < aliveGuard)
        {
            var ch = conn.Db.Character.Identity.Find(identity);
            if (ch is { Hp: > 0 }) break;
            Console.WriteLine("walk-stop: waiting respawn");
            await Frame(conn, Combat.RespawnDelayMs + 250);
        }
        if (conn.Db.Character.Identity.Find(identity) is { StaffEquipped: false })
        {
            conn.Reducers.EquipStaff();
            await Frame(conn, 200);
        }
        var walkStopPlus = true;
        while (true)
        {
            var ch0 = conn.Db.Character.Identity.Find(identity);
            if (ch0 is { Hp: <= 0 })
            {
                await Frame(conn, Combat.RespawnDelayMs + 250);
                continue;
            }
            if (ch0 is { StaffEquipped: false })
            {
                conn.Reducers.EquipStaff();
                await Frame(conn, 150);
            }
            var destX = walkStopPlus ? -1.5f : -6.5f;
            var destZ = -5f;
            var walkGuard = DateTime.UtcNow.AddSeconds(8);
            while (DateTime.UtcNow < walkGuard)
            {
                if (conn.Db.Character.Identity.Find(identity) is { Hp: <= 0 })
                {
                    await Frame(conn, 200);
                    continue;
                }
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
                    Console.WriteLine($"walk-stop pad ({cur.X:F1}, {cur.Z:F1})");
                    break;
                }
                var scale = MathF.Min(Movement.MaxStepMeters, dist) / dist;
                conn.Reducers.Move(dx * scale, dz * scale, false);
                await Frame(conn, 50);
            }
            if (conn.Db.PlayerPose.Identity.Find(identity) is { } stopPose)
            {
                Console.WriteLine($"READY walk-stop ({stopPose.X:F2}, {stopPose.Z:F2}) identity={identity}");
            }
            var standUntil = DateTime.UtcNow.AddSeconds(3.2);
            while (DateTime.UtcNow < standUntil)
            {
                conn.Reducers.Move(0f, 0f, jump: false);
                await Frame(conn, 80);
            }
            walkStopPlus = !walkStopPlus;
        }
    }
    if (hop)
    {
        // ?ve=remote-hop: stand west of origin (outside AggroRadius 3) and
        // pump jump. Do not walk to (4, 2.5) — leftover DIE identities / pad
        // corpses made the VE a graveyard. Wait for respawn. Keep staff on.
        var aliveGuard = DateTime.UtcNow.AddSeconds(20);
        while (DateTime.UtcNow < aliveGuard)
        {
            var ch = conn.Db.Character.Identity.Find(identity);
            if (ch is { Hp: > 0 }) break;
            Console.WriteLine("hop: waiting respawn");
            await Frame(conn, Combat.RespawnDelayMs + 250);
        }
        if (conn.Db.Character.Identity.Find(identity) is { StaffEquipped: false })
        {
            conn.Reducers.EquipStaff();
            await Frame(conn, 200);
        }
        // South of origin: pads A(3,7) B(-7,3) C(7,-3) dummy(5,0) are all
        // >7 m away. (-2.5, 0) sat next to the vendor stall and pad-B path.
        const float hopX = 0f;
        const float hopZ = -6f;
        var walkGuard = DateTime.UtcNow.AddSeconds(8);
        while (DateTime.UtcNow < walkGuard)
        {
            if (conn.Db.Character.Identity.Find(identity) is { Hp: <= 0 })
            {
                await Frame(conn, 200);
                continue;
            }
            if (conn.Db.PlayerPose.Identity.Find(identity) is not { } cur)
            {
                await Frame(conn, 50);
                continue;
            }
            var dx = hopX - cur.X;
            var dz = hopZ - cur.Z;
            var dist = MathF.Sqrt(dx * dx + dz * dz);
            if (dist < 0.4f)
            {
                Console.WriteLine($"hop-pad ({cur.X:F1}, {cur.Z:F1})");
                break;
            }
            var scale = MathF.Min(Movement.MaxStepMeters, dist) / dist;
            conn.Reducers.Move(dx * scale, dz * scale, false);
            await Frame(conn, 50);
        }
        if (conn.Db.PlayerPose.Identity.Find(identity) is { } hopPose)
        {
            Console.WriteLine($"READY hop-pad ({hopPose.X:F2}, {hopPose.Z:F2}) identity={identity}");
        }
        while (true)
        {
            var ch = conn.Db.Character.Identity.Find(identity);
            if (ch is { Hp: <= 0 })
            {
                await Frame(conn, Combat.RespawnDelayMs + 250);
                continue;
            }
            if (ch is { StaffEquipped: false })
            {
                conn.Reducers.EquipStaff();
            }
            var hopCur = conn.Db.PlayerPose.Identity.Find(identity);
            if (hopCur is null)
            {
                await Frame(conn, 50);
                continue;
            }
            var air = hopCur.Y > 0.08f;
            conn.Reducers.Move(0f, 0f, jump: !air);
            await Frame(conn, 50);
        }
    }
    if (suicide)
    {
        // ?ve=remote-death: stand in-yard and DummyStrike until Hp=0 so the
        // browser sees RecieveHit then Death. Move is rejected while dead.
        var walkGuard = DateTime.UtcNow.AddSeconds(8);
        while (DateTime.UtcNow < walkGuard)
        {
            if (conn.Db.PlayerPose.Identity.Find(identity) is not { } cur)
            {
                await Frame(conn, 50);
                continue;
            }
            var dx = targetX - cur.X;
            var dz = targetZ - cur.Z;
            var dist = MathF.Sqrt(dx * dx + dz * dz);
            if (dist < 0.4f)
            {
                Console.WriteLine($"die-pad ({cur.X:F1}, {cur.Z:F1})");
                break;
            }
            var scale = MathF.Min(Movement.MaxStepMeters, dist) / dist;
            conn.Reducers.Move(dx * scale, dz * scale, false);
            await Frame(conn, 50);
        }
        if (conn.Db.PlayerPose.Identity.Find(identity) is { } diePose)
        {
            Console.WriteLine($"READY die-pad ({diePose.X:F2}, {diePose.Z:F2}) identity={identity}");
        }
        while (true)
        {
            if (conn.Db.Character.Identity.Find(identity) is { Hp: <= 0 })
            {
                Console.WriteLine("dead — waiting respawn");
                await Frame(conn, Combat.RespawnDelayMs + 250);
                continue;
            }
            try { conn.Reducers.EnsureTrainingDummy(); } catch { /* ignore */ }
            await Frame(conn, 80);
            var dummy = FindDummy(conn);
            if (dummy is null || dummy.Hp <= 0)
            {
                await Frame(conn, 200);
                continue;
            }
            var hp = conn.Db.Character.Identity.Find(identity)?.Hp ?? 0;
            Console.WriteLine($"DummyStrike hp={hp}");
            try
            {
                conn.Reducers.DummyStrike();
            }
            catch (Exception e)
            {
                Console.Error.WriteLine("DummyStrike: " + e.Message);
            }
            await Frame(conn, 220);
        }
    }

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
