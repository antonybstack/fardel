using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

const string uri = GameConstants.DefaultLocalUri;
const string db = GameConstants.DefaultDatabaseName;
const int timeoutMs = 30000;

// --- Pure Shared hysteresis unit checks (no server) ---
{
    var moore = new (int x, int z)[9];
    var n = Aoi.FillMooreNeighborhood(0, 0, moore);
    if (n != 9) Fail($"Moore count {n}");
    if (!Aoi.InMooreNeighborhood(0, 0, 1, 1) || Aoi.InMooreNeighborhood(0, 0, 2, 0))
    {
        Fail("Moore membership");
        return;
    }

    // Just across +X boundary into chunk (1,0) at x=32.1 — not deep enough (margin 2)
    var ix = 0;
    var iz = 0;
    Aoi.UpdateInterest(32.1f, 0f, 1, 0, ref ix, ref iz);
    if (ix != 0 || iz != 0)
    {
        Fail($"hysteresis early flip: interest=({ix},{iz})");
        return;
    }

    // Deep into chunk 1: x >= 34
    Aoi.UpdateInterest(34.5f, 0f, 1, 0, ref ix, ref iz);
    if (ix != 1 || iz != 0)
    {
        Fail($"hysteresis should adopt: interest=({ix},{iz})");
        return;
    }
    Console.WriteLine("Shared Aoi hysteresis OK");
}

DbConnection? conn = null;
var connected = new TaskCompletionSource<Identity>();
var subscribedAll = new TaskCompletionSource();

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

    // Full subscribe for seeding + interest observation
    conn.SubscriptionBuilder()
        .OnApplied(_ => subscribedAll.TrySetResult())
        .OnError((_, e) => subscribedAll.TrySetException(e))
        .SubscribeToAllTables();
    await Pump(subscribedAll.Task, timeoutMs, conn, "subscribe-all");

    await PumpUntil(() => conn.Db.PlayerPose.Identity.Find(identity) is not null, timeoutMs, conn, "pose");

    var pose0 = conn.Db.PlayerPose.Identity.Find(identity)!;
    if (pose0.InterestChunkX != pose0.ChunkX || pose0.InterestChunkZ != pose0.ChunkZ)
    {
        Fail("spawn interest should match pose chunk");
        return;
    }

    // Walk just across +X chunk boundary (32m) with 0.75 steps — interest should lag
    // From 0 → need ~43 steps to reach 32, then a few more to 32.1
    while (true)
    {
        var p = conn.Db.PlayerPose.Identity.Find(identity)!;
        if (p.X >= 32.1f) break;
        conn.Reducers.Move(Movement.MaxStepMeters, 0f);
        await DelayPump(conn, 20);
    }

    await PumpUntil(() =>
    {
        var p = conn.Db.PlayerPose.Identity.Find(identity)!;
        return p.ChunkX == 1 && p.InterestChunkX == 0;
    }, timeoutMs, conn, "interest lags at border");
    Console.WriteLine("server hysteresis at border OK");

    // Push deep enough for interest adopt (x >= 34)
    while (true)
    {
        var p = conn.Db.PlayerPose.Identity.Find(identity)!;
        if (p.X >= 34.5f) break;
        conn.Reducers.Move(Movement.MaxStepMeters, 0f);
        await DelayPump(conn, 20);
    }

    await PumpUntil(() =>
    {
        var p = conn.Db.PlayerPose.Identity.Find(identity)!;
        return p.InterestChunkX == 1 && p.InterestChunkZ == 0;
    }, timeoutMs, conn, "interest adopts deep");
    Console.WriteLine("server interest adopt OK");

    // Seed crowd; verify counts under full subscribe
    conn.Reducers.SeedCrowdProxies();
    await PumpUntil(() => CountProxies(conn) >= Aoi.CrowdNearCount + Aoi.CrowdFarCount, timeoutMs, conn, "crowd seeded");
    var allCount = CountProxies(conn);
    Console.WriteLine($"full-sub crowd count={allCount}");

    // Tear down and reconnect with neighborhood-only SQL subscribe
    try { conn.Disconnect(); } catch { /* ignore */ }
    conn = null;

    var connected2 = new TaskCompletionSource<Identity>();
    var subscribedN = new TaskCompletionSource();
    // Fresh identity is fine — we only care about CrowdProxy chunk filters
    conn = DbConnection.Builder()
        .WithUri(uri)
        .WithDatabaseName(db)
        .OnConnect((_, id, _) => connected2.TrySetResult(id))
        .OnConnectError(e => connected2.TrySetException(e))
        .Build();
    await Pump(connected2.Task, timeoutMs, conn, "connect2");
    var id2 = await connected2.Task;

    // Neighborhood around spawn interest (0,0) — player2 spawns at 0,0
    var neigh = new (int x, int z)[9];
    var nn = Aoi.FillMooreNeighborhood(0, 0, neigh);
    var sqls = new List<string>
    {
        // Always-relevant: self pose + character + combat
        "SELECT * FROM player_pose WHERE identity = 0x" + id2.ToString(),
        "SELECT * FROM character WHERE identity = 0x" + id2.ToString(),
        "SELECT * FROM player_combat WHERE identity = 0x" + id2.ToString(),
    };
    // Identity hex format for SQL may differ — use broader self via all player_pose for self only is hard.
    // Safer: subscribe character/combat wholesale (cold/small) + crowd by chunk + all poses in neighborhood.
    sqls.Clear();
    sqls.Add("SELECT * FROM character");
    sqls.Add("SELECT * FROM player_combat");
    sqls.Add("SELECT * FROM npc");
    for (var i = 0; i < nn; i++)
    {
        var (cx, cz) = neigh[i];
        sqls.Add($"SELECT * FROM crowd_proxy WHERE chunk_x = {cx} AND chunk_z = {cz}");
        sqls.Add($"SELECT * FROM player_pose WHERE chunk_x = {cx} AND chunk_z = {cz}");
    }

    conn.SubscriptionBuilder()
        .OnApplied(_ => subscribedN.TrySetResult())
        .OnError((_, e) => subscribedN.TrySetException(e))
        .Subscribe(sqls.ToArray());
    await Pump(subscribedN.Task, timeoutMs, conn, "subscribe-neighborhood");

    // Ensure seed still present (re-seed in case delete-data)
    conn.Reducers.SeedCrowdProxies();
    await PumpUntil(() => CountNear(conn) >= Aoi.CrowdNearCount, timeoutMs, conn, "near proxies visible");

    var near = CountNear(conn);
    var far = CountFar(conn);
    Console.WriteLine($"neighborhood-sub near={near} far={far}");

    if (near < Aoi.CrowdNearCount)
    {
        Fail($"expected >= {Aoi.CrowdNearCount} near proxies, got {near}");
        return;
    }

    if (far != 0)
    {
        Fail($"far proxies leaked into neighborhood subscribe: {far}");
        return;
    }

    // Alloc scaffold: iterate neighborhood proxies without LINQ / heap-heavy paths
    var scratch = 0;
    foreach (var p in conn.Db.CrowdProxy.Iter())
    {
        scratch ^= p.ProxyId.GetHashCode();
        scratch += (int)(p.X * 1000);
    }
    Console.WriteLine($"alloc-scaffold iter checksum={scratch}");

    Console.WriteLine("OK: AoiSmoke passed");
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

static int CountProxies(DbConnection conn)
{
    var n = 0;
    foreach (var _ in conn.Db.CrowdProxy.Iter()) n++;
    return n;
}

static int CountNear(DbConnection conn)
{
    var n = 0;
    foreach (var p in conn.Db.CrowdProxy.Iter())
    {
        if (!p.Far) n++;
    }
    return n;
}

static int CountFar(DbConnection conn)
{
    var n = 0;
    foreach (var p in conn.Db.CrowdProxy.Iter())
    {
        if (p.Far) n++;
    }
    return n;
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
