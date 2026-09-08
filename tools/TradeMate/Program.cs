using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

// Long-lived trade partner for browser ?ve=trade:
// sit near yard, auto-accept inbound TradeOffers, hold.
var uri = GameConstants.ResolveLocalUri();
var db = GameConstants.ResolveDatabaseName();
const float holdX = 2.0f;
const float holdZ = 0.5f;
const int timeoutMs = 30000;

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
        .OnDisconnect((_, e) => Console.Error.WriteLine("disconnected: " + (e?.Message ?? "ok")))
        .Build();

    if (!await WaitTick(connected.Task, timeoutMs, conn, "connect"))
    {
        Fail("connect timeout");
        return;
    }

    var identity = await connected.Task;
    Console.WriteLine("trade-mate connected " + identity);

    conn.SubscriptionBuilder()
        .OnApplied(_ => subscribed.TrySetResult())
        .OnError((_, e) => subscribed.TrySetException(e))
        .SubscribeToAllTables();

    if (!await WaitTick(subscribed.Task, timeoutMs, conn, "subscribe"))
    {
        Fail("subscribe timeout");
        return;
    }

    await Frame(conn, 300);
    Console.WriteLine("READY holding near spawn for TradeOffers…");

    var arrived = false;
    while (true)
    {
        if (!arrived)
        {
            if (conn.Db.PlayerPose.Identity.Find(identity) is { } cur)
            {
                var dx = holdX - cur.X;
                var dz = holdZ - cur.Z;
                var dist = MathF.Sqrt(dx * dx + dz * dz);
                if (dist < 0.25f)
                {
                    arrived = true;
                    Console.WriteLine($"arrived ({cur.X:F2},{cur.Z:F2})");
                }
                else
                {
                    var scale = MathF.Min(Movement.MaxStepMeters, dist) / dist;
                    conn.Reducers.Move(dx * scale, dz * scale, false);
                }
            }
        }

        if (conn.Db.TradeOffer.To.Find(identity) is { } offer)
        {
            Console.WriteLine(
                $"AcceptTrade from {offer.From} shard={offer.OfferedHasEmberShard} xp={offer.OfferedXp}");
            try
            {
                conn.Reducers.AcceptTrade();
            }
            catch (Exception e)
            {
                Console.Error.WriteLine("AcceptTrade error: " + e.Message);
            }
            await Frame(conn, 250);
            continue;
        }

        await Frame(conn, 120);
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
