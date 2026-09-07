using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

// Fresh identity at Level 1 / Xp 0; one kill (XpPerKill) crosses Progression L2;
// reconnect Persist still has Level.
const string uri = GameConstants.DefaultLocalUri;
const string db = GameConstants.DefaultDatabaseName;
const int timeoutMs = 45000;

var tokenDir = Path.Combine(Path.GetTempPath(), "fardel-level-smoke-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(tokenDir);
AuthToken.Init("fardel-level-smoke", "settings.ini", tokenDir);

Identity identity1 = default;
int xpAfterKill = 0;
int levelAfterKill = 0;
string? savedToken = null;

try
{
    // --- pass 1: connect, kill for XP → Level 2 ---
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

            var start = conn.Db.Character.Identity.Find(identity1)!;
            Console.WriteLine($"pass1 start Xp={start.Xp} Level={start.Level}");
            if (start.Level < 1)
            {
                Fail($"expected Level >= 1 at start, got {start.Level}");
                return;
            }

            // Need to be below L2 threshold so one kill levels up.
            var needForL2 = 10; // Progression: cumulative XP for level 2
            if (start.Xp >= needForL2 && start.Level >= 2)
            {
                // Already leveled (reused identity unlikely with fresh token) — still assert persist path.
                Console.WriteLine("pass1 already at/above L2; skipping kill");
                xpAfterKill = start.Xp;
                levelAfterKill = start.Level;
            }
            else
            {
                if (conn.Db.Character.Identity.Find(identity1) is { StaffEquipped: false })
                {
                    conn.Reducers.EquipStaff();
                    await DelayPump(conn, 100);
                }

                var levelBefore = start.Level;
                var xpBefore = start.Xp;
                await KillDummy(conn, identity1);

                await PumpUntil(() =>
                    conn.Db.Character.Identity.Find(identity1) is { } ch
                    && ch.Xp >= xpBefore + Combat.XpPerKill,
                    timeoutMs, conn, "xp after kill");

                var after = conn.Db.Character.Identity.Find(identity1)!;
                xpAfterKill = after.Xp;
                levelAfterKill = after.Level;
                var expectedLevel = Progression.LevelFromXp(after.Xp);
                Console.WriteLine(
                    $"pass1 after kill Xp={after.Xp} Level={after.Level} (expected from curve {expectedLevel})");

                if (after.Level < expectedLevel)
                {
                    Fail($"Level {after.Level} < curve {expectedLevel} for Xp={after.Xp}");
                    return;
                }

                if (xpBefore < needForL2 && after.Xp >= needForL2 && after.Level < 2)
                {
                    Fail($"crossed L2 XP threshold but Level stayed {after.Level}");
                    return;
                }

                if (after.Level <= levelBefore && xpBefore < needForL2 && after.Xp >= needForL2)
                {
                    Fail($"Level did not increment ({levelBefore} -> {after.Level}) after crossing threshold");
                    return;
                }

                Console.WriteLine($"pass1 level-up OK {levelBefore} -> {after.Level}");
            }
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

    // --- pass 2: reconnect; Character.Level must persist ---
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
            if (ch.Level != levelAfterKill)
            {
                Fail($"Level not persisted: expected {levelAfterKill}, got {ch.Level}");
                return;
            }
            Console.WriteLine($"pass2 Character.Xp={ch.Xp} Level={ch.Level} (persisted OK)");
        }
        finally
        {
            try { conn?.Disconnect(); } catch { /* ignore */ }
        }
    }

    Console.WriteLine("OK: LevelSmoke passed");
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

static async Task KillDummy(DbConnection conn, Identity id)
{
    conn.Reducers.EnsureTrainingDummy();
    await PumpUntil(() => FindDummy(conn) is { Hp: var h } && h == Combat.DummyMaxHp,
        timeoutMs, conn, "dummy ready");
    var dummy = FindDummy(conn) ?? throw new Exception("no dummy");
    conn.Reducers.SetTarget(dummy.NpcId);
    await PumpUntil(() =>
        conn.Db.PlayerCombat.Identity.Find(id) is { } cc && cc.TargetNpcId == dummy.NpcId,
        timeoutMs, conn, "target");

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
