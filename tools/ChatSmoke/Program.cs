using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

// Multi-client public Say: A inserts ChatMessage; B must observe it.
const string uri = GameConstants.DefaultLocalUri;
const string db = GameConstants.DefaultDatabaseName;
const int timeoutMs = 30000;
const string sayText = "hello yard";

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

    _ = await SubscribeAll(connA, "A-all");
    _ = await SubscribeAll(connB, "B-all");

    await PumpUntilBoth(() =>
        connA.Db.PlayerPose.Identity.Find(idA) is not null
        && connB.Db.PlayerPose.Identity.Find(idB) is not null,
        timeoutMs, connA, connB, "poses");

    connA.Reducers.Say(sayText);
    Console.WriteLine($"A said: {sayText}");

    await PumpUntilBoth(() =>
    {
        foreach (var m in connB.Db.ChatMessage.Iter())
        {
            if (m.Sender == idA && m.Text == sayText)
            {
                return true;
            }
        }
        return false;
    }, timeoutMs, connA, connB, "B sees A chat");

    ChatMessage? seen = null;
    foreach (var m in connB.Db.ChatMessage.Iter())
    {
        if (m.Sender == idA && m.Text == sayText)
        {
            seen = m;
            break;
        }
    }

    Console.WriteLine($"OK: ChatSmoke — B saw messageId={seen!.MessageId} from A text=\"{seen.Text}\"");
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

static async Task<(DbConnection conn, Identity id)> ConnectAsync(string label)
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
