using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

const string uri = GameConstants.DefaultLocalUri;
const string db = GameConstants.DefaultDatabaseName;
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

    if (conn.Db.Character.Identity.Find(identity) is { RobesEquipped: false })
    {
        conn.Reducers.EquipRobes();
        await PumpUntil(() =>
            conn.Db.Character.Identity.Find(identity) is { RobesEquipped: true },
            timeoutMs, conn, "equip robes baseline");
    }
    Console.WriteLine("robes equipped baseline OK");

    conn.Reducers.UnequipRobes();
    await PumpUntil(() =>
        conn.Db.Character.Identity.Find(identity) is { RobesEquipped: false },
        timeoutMs, conn, "robes unequipped");
    Console.WriteLine("unequip OK");

    conn.Reducers.EquipRobes();
    await PumpUntil(() =>
        conn.Db.Character.Identity.Find(identity) is { RobesEquipped: true },
        timeoutMs, conn, "robes re-equipped");
    Console.WriteLine("re-equip OK");

    Console.WriteLine("OK: RobesEquipSmoke passed");
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
