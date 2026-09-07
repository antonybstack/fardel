using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

// ADR 0001 always-relevant: after party-up, B moves outside A's Moore
// neighborhood; A rebuilds to neighborhood SQL + party identity pose filters
// and still sees B's PlayerPose.
var uri = GameConstants.ResolveLocalUri();
var db = GameConstants.ResolveDatabaseName();
const int timeoutMs = 45000;
// Chunk = 32m; Moore = ±1 → need ≥ ~96m from spawn interest (0,0).
const float farTargetX = 120f;
const float farTargetZ = 0f;

DbConnection? connA = null;
DbConnection? connB = null;

try
{
    var (a, idA) = await ConnectAsync("A");
    connA = a;
    Console.WriteLine("A connected " + idA);

    var (b, idB) = await ConnectAsync("B");
    connB = b;
    Console.WriteLine("B connected " + idB);

    var subA = await SubscribeAll(connA, "A-all");
    _ = await SubscribeAll(connB, "B-all");

    await PumpUntilBoth(() =>
        connA.Db.PlayerPose.Identity.Find(idA) is not null
        && connB.Db.PlayerPose.Identity.Find(idB) is not null,
        timeoutMs, connA, connB, "poses");

    // Party up: InviteToParty creates party if needed.
    connA.Reducers.InviteToParty(idB);
    await PumpUntilBoth(() => connB.Db.PartyInvite.Invitee.Find(idB) is not null,
        timeoutMs, connA, connB, "invite");

    connB.Reducers.AcceptPartyInvite();
    await PumpUntilBoth(() =>
    {
        var ma = connA.Db.PartyMember.Identity.Find(idA);
        var mb = connA.Db.PartyMember.Identity.Find(idB);
        return ma is not null && mb is not null && ma.PartyId == mb.PartyId;
    }, timeoutMs, connA, connB, "party-2");

    var partyId = connA.Db.PartyMember.Identity.Find(idA)!.PartyId;
    Console.WriteLine($"partied partyId={partyId}");

    await MoveTo(connB, idB, farTargetX, farTargetZ, connA);
    var poseB = connB.Db.PlayerPose.Identity.Find(idB)!;
    Console.WriteLine($"B far at ({poseB.X:F1},{poseB.Z:F1}) chunk=({poseB.ChunkX},{poseB.ChunkZ})");

    if (Aoi.InMooreNeighborhood(0, 0, poseB.ChunkX, poseB.ChunkZ))
    {
        Fail($"B still inside Moore of spawn: chunk ({poseB.ChunkX},{poseB.ChunkZ})");
        return;
    }

    // Collect always-relevant identities from A's party roster.
    var partyIds = new List<Identity>();
    foreach (var m in connA.Db.PartyMember.Iter())
    {
        if (m.PartyId == partyId)
        {
            partyIds.Add(m.Identity);
        }
    }
    if (partyIds.Count < 2)
    {
        Fail($"expected >=2 party members, got {partyIds.Count}");
        return;
    }

    // Rebuild A's subscription: neighborhood around spawn interest + always-relevant.
    var unsubDone = new TaskCompletionSource();
    subA.UnsubscribeThen(_ => unsubDone.TrySetResult());
    await Pump(unsubDone.Task, timeoutMs, connA, "A-unsub");

    var sqls = BuildAlwaysRelevantNeighborhoodSqls(0, 0, partyIds, idA);
    Console.WriteLine($"A resubscribe sqls={sqls.Count}");
    foreach (var s in sqls)
    {
        Console.WriteLine("  SQL: " + s);
    }

    var subApplied = new TaskCompletionSource();
    connA.SubscriptionBuilder()
        .OnApplied(_ => subApplied.TrySetResult())
        .OnError((_, e) => subApplied.TrySetException(e))
        .Subscribe(sqls.ToArray());
    await Pump(subApplied.Task, timeoutMs, connA, "A-neigh+party");

    // Keep B alive so pose stays published.
    await DelayPumpBoth(connA, connB, 200);

    await PumpUntilBoth(() => connA.Db.PlayerPose.Identity.Find(idB) is not null,
        timeoutMs, connA, connB, "A sees far party pose");

    var seen = connA.Db.PlayerPose.Identity.Find(idB)!;
    if (MathF.Abs(seen.X - poseB.X) > 2f)
    {
        Fail($"A sees B but X mismatch: {seen.X} vs {poseB.X}");
        return;
    }

    // Sanity: far crowd proxies must NOT leak (neighborhood filter still works).
    connA.Reducers.SeedCrowdProxies();
    await DelayPumpBoth(connA, connB, 300);
    var farLeak = 0;
    foreach (var p in connA.Db.CrowdProxy.Iter())
    {
        if (p.Far) farLeak++;
    }
    if (farLeak != 0)
    {
        Fail($"far crowd proxies leaked into neighborhood+party sub: {farLeak}");
        return;
    }

    Console.WriteLine($"OK: party always-relevant — A sees B pose at ({seen.X:F1},{seen.Z:F1}) outside Moore");
    Environment.ExitCode = 0;
}
catch (Exception e)
{
    Fail(e.ToString());
}
finally
{
    try { connA?.Disconnect(); } catch { /* ignore */ }
    try { connB?.Disconnect(); } catch { /* ignore */ }
}

static List<string> BuildAlwaysRelevantNeighborhoodSqls(
    int interestCx,
    int interestCz,
    List<Identity> partyMembers,
    Identity self)
{
    var sqls = new List<string>
    {
        "SELECT * FROM character",
        "SELECT * FROM player_combat",
        "SELECT * FROM npc",
        "SELECT * FROM party_member",
        "SELECT * FROM party_invite",
    };

    var neigh = new (int x, int z)[9];
    var n = Aoi.FillMooreNeighborhood(interestCx, interestCz, neigh);
    for (var i = 0; i < n; i++)
    {
        var (cx, cz) = neigh[i];
        sqls.Add($"SELECT * FROM crowd_proxy WHERE chunk_x = {cx} AND chunk_z = {cz}");
        sqls.Add($"SELECT * FROM player_pose WHERE chunk_x = {cx} AND chunk_z = {cz}");
    }

    // Always-relevant identity poses (self + party), even outside Moore.
    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    void AddIdentityPose(Identity id)
    {
        var hex = id.ToString();
        if (!seen.Add(hex)) return;
        sqls.Add($"SELECT * FROM player_pose WHERE identity = 0x{hex}");
    }

    AddIdentityPose(self);
    foreach (var id in partyMembers)
    {
        AddIdentityPose(id);
    }

    return sqls;
}

async Task<(DbConnection conn, Identity id)> ConnectAsync(string label)
{
    var tcs = new TaskCompletionSource<Identity>();
    var conn = DbConnection.Builder()
        .WithUri(uri)
        .WithDatabaseName(db)
        .OnConnect((_, identity, _) => tcs.TrySetResult(identity))
        .OnConnectError(e => tcs.TrySetException(e))
        .Build();
    await Pump(tcs.Task, timeoutMs, conn, label + "-connect");
    var id = await tcs.Task;
    return (conn, id);
}

static async Task<SubscriptionHandle> SubscribeAll(DbConnection conn, string label)
{
    var tcs = new TaskCompletionSource();
    var handle = conn.SubscriptionBuilder()
        .OnApplied(_ => tcs.TrySetResult())
        .OnError((_, e) => tcs.TrySetException(e))
        .SubscribeToAllTables();
    await Pump(tcs.Task, timeoutMs, conn, label);
    return handle;
}

static async Task MoveTo(DbConnection mover, Identity id, float tx, float tz, DbConnection other)
{
    for (var i = 0; i < 500; i++)
    {
        if (mover.Db.PlayerPose.Identity.Find(id) is not { } cur)
        {
            await DelayPumpBoth(mover, other, 30);
            continue;
        }

        var dx = tx - cur.X;
        var dz = tz - cur.Z;
        var dist = MathF.Sqrt(dx * dx + dz * dz);
        if (dist < 0.5f) return;

        var scale = MathF.Min(Movement.MaxStepMeters, dist) / dist;
        mover.Reducers.Move(dx * scale, dz * scale);
        await DelayPumpBoth(mover, other, 16);
    }

    throw new TimeoutException("move to far");
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

static async Task PumpUntilBoth(
    Func<bool> pred,
    int timeoutMs,
    DbConnection a,
    DbConnection b,
    string label)
{
    using var cts = new CancellationTokenSource(timeoutMs);
    while (!pred() && !cts.IsCancellationRequested)
    {
        a.FrameTick();
        b.FrameTick();
        try { await Task.Delay(16, cts.Token); } catch (OperationCanceledException) { break; }
    }
    if (!pred()) throw new TimeoutException(label);
}

static async Task DelayPumpBoth(DbConnection a, DbConnection b, int ms)
{
    var until = Environment.TickCount64 + ms;
    while (Environment.TickCount64 < until)
    {
        a.FrameTick();
        b.FrameTick();
        await Task.Delay(16);
    }
}
