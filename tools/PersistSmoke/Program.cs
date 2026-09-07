using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

const string uri = GameConstants.DefaultLocalUri;
const string db = GameConstants.DefaultDatabaseName;
const int timeoutMs = 30000;

var tokenDir = Path.Combine(Path.GetTempPath(), "fardel-persist-smoke-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(tokenDir);
AuthToken.Init("fardel-persist-smoke", "settings.ini", tokenDir);

Identity identity1 = default;
int xpAfterKill = 0;
string? savedToken = null;

try
{
    // --- pass 1: connect, earn XP, save token ---
    {
        var connected = new TaskCompletionSource<(Identity id, string token)>();
        var subscribed = new TaskCompletionSource();
        DbConnection? conn = null;
        try
        {
            conn = DbConnection.Builder()
                .WithUri(uri)
                .WithDatabaseName(db)
                .OnConnect((_, identity, token) =>
                {
                    AuthToken.SaveToken(token);
                    connected.TrySetResult((identity, token));
                })
                .OnConnectError(e => connected.TrySetException(e))
                .Build();

            await Pump(connected.Task, timeoutMs, conn, "connect1");
            (identity1, savedToken) = await connected.Task;
            Console.WriteLine("pass1 connected " + identity1);

            conn.SubscriptionBuilder()
                .OnApplied(_ => subscribed.TrySetResult())
                .OnError((_, e) => subscribed.TrySetException(e))
                .SubscribeToAllTables();
            await Pump(subscribed.Task, timeoutMs, conn, "subscribe1");
            await PumpUntil(() => conn.Db.Character.Identity.Find(identity1) is not null, timeoutMs, conn, "character1");

            var startXp = conn.Db.Character.Identity.Find(identity1)!.Xp;
            Console.WriteLine($"pass1 startXp={startXp}");

            conn.Reducers.EnsureTrainingDummy();
            await PumpUntil(() => FindDummy(conn) is { Hp: > 0 }, timeoutMs, conn, "dummy ready");
            var dummy = FindDummy(conn)!;
            conn.Reducers.SetTarget(dummy.NpcId);
            await PumpUntil(() =>
                conn.Db.PlayerCombat.Identity.Find(identity1) is { } cc && cc.TargetNpcId == dummy.NpcId,
                timeoutMs, conn, "target set");

            while (FindDummy(conn) is { Hp: > 0 })
            {
                var before = FindDummy(conn)!.Hp;
                conn.Reducers.Cast(Combat.SpellSpark);
                await PumpUntil(() =>
                {
                    var n = FindDummy(conn);
                    return n is null || n.Hp < before || n.Hp == 0;
                }, timeoutMs, conn, "spark tick");
                await DelayPump(conn, Combat.GcdMs + 50);
            }

            await PumpUntil(() =>
                conn.Db.Character.Identity.Find(identity1) is { } ch && ch.Xp >= startXp + Combat.XpPerKill,
                timeoutMs, conn, "xp after kill");
            xpAfterKill = conn.Db.Character.Identity.Find(identity1)!.Xp;
            Console.WriteLine($"pass1 xpAfterKill={xpAfterKill}");
        }
        finally
        {
            try { conn?.Disconnect(); } catch { /* ignore */ }
        }
    }

    await Task.Delay(200);

    if (string.IsNullOrEmpty(savedToken) && string.IsNullOrEmpty(AuthToken.Token))
    {
        Fail("no token saved after pass1");
        return;
    }
    var token = !string.IsNullOrEmpty(AuthToken.Token) ? AuthToken.Token : savedToken!;

    // --- pass 2: reconnect with same token; Character.Xp must persist ---
    {
        var connected = new TaskCompletionSource<Identity>();
        var subscribed = new TaskCompletionSource();
        DbConnection? conn = null;
        try
        {
            conn = DbConnection.Builder()
                .WithUri(uri)
                .WithDatabaseName(db)
                .WithToken(token)
                .OnConnect((_, identity, _) => connected.TrySetResult(identity))
                .OnConnectError(e => connected.TrySetException(e))
                .Build();

            await Pump(connected.Task, timeoutMs, conn, "connect2");
            var identity2 = await connected.Task;
            Console.WriteLine("pass2 connected " + identity2);

            if (identity2 != identity1)
            {
                Fail($"identity changed on reconnect: {identity1} -> {identity2}");
                return;
            }

            conn.SubscriptionBuilder()
                .OnApplied(_ => subscribed.TrySetResult())
                .OnError((_, e) => subscribed.TrySetException(e))
                .SubscribeToAllTables();
            await Pump(subscribed.Task, timeoutMs, conn, "subscribe2");

            await PumpUntil(() => conn.Db.Character.Identity.Find(identity2) is not null, timeoutMs, conn, "character2");
            var ch = conn.Db.Character.Identity.Find(identity2)!;
            if (ch.Xp != xpAfterKill)
            {
                Fail($"XP not persisted: expected {xpAfterKill}, got {ch.Xp}");
                return;
            }
            Console.WriteLine($"pass2 Character.Xp={ch.Xp} (persisted OK)");

            // Session rows should be recreated on connect
            await PumpUntil(() => conn.Db.PlayerPose.Identity.Find(identity2) is not null, timeoutMs, conn, "pose session");
            await PumpUntil(() => conn.Db.PlayerCombat.Identity.Find(identity2) is not null, timeoutMs, conn, "combat session");
            Console.WriteLine("pass2 session rows OK");
        }
        finally
        {
            try { conn?.Disconnect(); } catch { /* ignore */ }
        }
    }

    Console.WriteLine("OK: PersistSmoke passed");
    Environment.ExitCode = 0;
}
catch (Exception e)
{
    Fail(e.ToString());
}
finally
{
    try { Directory.Delete(tokenDir, recursive: true); } catch { /* ignore */ }
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
