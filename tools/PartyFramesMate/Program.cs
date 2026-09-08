using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

// One-shot mate for ?ve=party-frames: invite first non-self pose that looks
// like a browser (or any), wait for party size>=2 with long patience, move far, hold.
var uri = GameConstants.ResolveLocalUri();
var db = GameConstants.ResolveDatabaseName();
const float farX = 80f;
const float farZ = 0f;
const int timeoutMs = 60000;

var connected = new TaskCompletionSource<Identity>();
var subscribed = new TaskCompletionSource();
DbConnection? conn = null;

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
    Console.WriteLine("party-frames-mate connected " + identity);

    conn.SubscriptionBuilder()
        .OnApplied(_ => subscribed.TrySetResult())
        .OnError((_, e) => subscribed.TrySetException(e))
        .SubscribeToAllTables();
    await Pump(subscribed.Task, timeoutMs, conn, "subscribe");

    // Prefer invitee matching known browser token prefix from prior VE logs if present.
    const string preferPrefix = "C20094CD"; // browser restored token from robes VE
    Identity? target = null;
    for (var attempt = 0; attempt < 200 && target is null; attempt++)
    {
        foreach (var pose in conn.Db.PlayerPose.Iter())
        {
            if (pose.Identity.Equals(identity)) continue;
            var hex = pose.Identity.ToString();
            if (hex.StartsWith(preferPrefix, StringComparison.OrdinalIgnoreCase))
            {
                target = pose.Identity;
                break;
            }
        }
        if (target is null)
        {
            foreach (var pose in conn.Db.PlayerPose.Iter())
            {
                if (pose.Identity.Equals(identity)) continue;
                // Skip far-looking zombies at origin that never accept: still try prefer first.
                target = pose.Identity;
                break;
            }
        }
        if (target is null) await DelayPump(conn, 200);
    }
    if (target is null) { Fail("no invitee pose"); return; }
    Console.WriteLine("inviting " + target);

    // Leave any stale solo party.
    if (conn.Db.PartyMember.Identity.Find(identity) is not null)
    {
        try { conn.Reducers.LeaveParty(); } catch { /* ignore */ }
        await DelayPump(conn, 200);
    }

    for (var i = 0; i < 40; i++)
    {
        // Accept inbound if browser invited us first.
        if (conn.Db.PartyInvite.Invitee.Find(identity) is not null
            && conn.Db.PartyMember.Identity.Find(identity) is null)
        {
            Console.WriteLine("AcceptPartyInvite");
            conn.Reducers.AcceptPartyInvite();
            await DelayPump(conn, 300);
        }

        var self = conn.Db.PartyMember.Identity.Find(identity);
        var count = 0;
        if (self is not null)
        {
            foreach (var m in conn.Db.PartyMember.Iter())
                if (m.PartyId == self.PartyId) count++;
        }
        if (count >= 2) break;

        if (self is null || count < 2)
        {
            if (self is not null && count < 2)
            {
                // Stay patient — do not leave; browser may still accept.
            }
            else
            {
                try { conn.Reducers.InviteToParty(target.Value); }
                catch (Exception e) { Console.Error.WriteLine("invite: " + e.Message); }
            }
        }
        await DelayPump(conn, 500);
    }

    {
        var self = conn.Db.PartyMember.Identity.Find(identity)
            ?? throw new Exception("not in party");
        var count = 0;
        foreach (var m in conn.Db.PartyMember.Iter())
            if (m.PartyId == self.PartyId) count++;
        if (count < 2) { Fail("party size still < 2"); return; }
        Console.WriteLine($"party size {count} — moving far");
    }

    await MoveTo(conn, identity, farX, farZ);
    if (conn.Db.PlayerPose.Identity.Find(identity) is { } p)
        Console.WriteLine($"READY far @({p.X:F1},{p.Z:F1}) chunk=({p.ChunkX},{p.ChunkZ})");

    // Hold so browser can screenshot.
    for (var i = 0; i < 120; i++) await DelayPump(conn, 250);
    Console.WriteLine("done holding");
}
catch (Exception e)
{
    Fail(e.ToString());
}
finally
{
    try { conn?.Disconnect(); } catch { /* ignore */ }
}

static async Task MoveTo(DbConnection conn, Identity id, float tx, float tz)
{
    for (var i = 0; i < 400; i++)
    {
        if (conn.Db.PlayerPose.Identity.Find(id) is not { } cur)
        {
            await DelayPump(conn, 30);
            continue;
        }
        var dx = tx - cur.X;
        var dz = tz - cur.Z;
        var dist = MathF.Sqrt(dx * dx + dz * dz);
        if (dist < 0.5f) return;
        var scale = MathF.Min(Movement.MaxStepMeters, dist) / dist;
        conn.Reducers.Move(dx * scale, dz * scale, false);
        await DelayPump(conn, 16);
    }
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

static async Task DelayPump(DbConnection conn, int ms)
{
    var until = Environment.TickCount64 + ms;
    while (Environment.TickCount64 < until)
    {
        conn.FrameTick();
        await Task.Delay(16);
    }
}
