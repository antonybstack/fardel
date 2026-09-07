using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

// Multi-client public Say: A inserts ChatMessage; B must observe it.
// Also proves per-identity Say rate-limit rejects a second immediate Say.
// PartySay: A+B party, C outsider — B sees PartyChatMessage; C must not.
// Whisper: A→B private; C outsider must not see WhisperMessage.
var uri = GameConstants.ResolveLocalUri();
var db = GameConstants.ResolveDatabaseName();
const int timeoutMs = 30000;
const string sayText = "hello yard";
const string sayText2 = "rate ok";

DbConnection? connA = null;
DbConnection? connB = null;
DbConnection? connC = null;

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

    Console.WriteLine($"OK: B saw messageId={seen!.MessageId} from A text=\"{seen.Text}\"");

    // Immediate second Say from A must fail rate-limit.
    string? rateFailReason = null;
    var rateFailed = new TaskCompletionSource();
    void OnSay(ReducerEventContext ctx, string text)
    {
        // Ignore late events for other Say texts (e.g. first hello yard).
        if (text != "too soon")
        {
            return;
        }
        switch (ctx.Event.Status)
        {
            case Status.Failed(var reason):
                rateFailReason = reason;
                rateFailed.TrySetResult();
                break;
            case Status.Committed:
                rateFailed.TrySetException(new Exception($"Say committed while rate-limited: {text}"));
                break;
            case Status.OutOfEnergy(_):
                rateFailed.TrySetException(new Exception("Say out of energy"));
                break;
        }
    }
    connA.Reducers.OnSay += OnSay;
    try
    {
        connA.Reducers.Say("too soon");
        await Pump(rateFailed.Task, timeoutMs, connA, "say rate-limit fail");
    }
    finally
    {
        connA.Reducers.OnSay -= OnSay;
    }

    if (string.IsNullOrEmpty(rateFailReason) ||
        rateFailReason.IndexOf("rate-limited", StringComparison.OrdinalIgnoreCase) < 0)
    {
        Fail($"expected Say rate-limited failure, got: {rateFailReason ?? "(null)"}");
        return;
    }
    Console.WriteLine($"OK: rate-limit rejected ({rateFailReason})");

    // After interval, Say succeeds again and B sees it.
    await DelayPumpBoth(connA, connB, Chat.SayMinIntervalMs + 80);
    connA.Reducers.Say(sayText2);
    await PumpUntilBoth(() =>
    {
        foreach (var m in connB.Db.ChatMessage.Iter())
        {
            if (m.Sender == idA && m.Text == sayText2)
            {
                return true;
            }
        }
        return false;
    }, timeoutMs, connA, connB, "B sees A after rate window");

    Console.WriteLine($"OK: ChatSmoke — A→B say + rate-limit {Chat.SayMinIntervalMs}ms");

    // --- Party channel: A+B party, C outsider ---
    var (c, idC) = await ConnectAsync("C");
    connC = c;
    Console.WriteLine("C connected " + idC);
    _ = await SubscribeAll(connC, "C-all");
    await PumpUntilBoth(() =>
        connC.Db.PlayerPose.Identity.Find(idC) is not null,
        timeoutMs, connA, connC, "C pose");

    connA.Reducers.InviteToParty(idB);
    await PumpUntilBoth(() => connB.Db.PartyInvite.Invitee.Find(idB) is not null,
        timeoutMs, connA, connB, "party invite");
    connB.Reducers.AcceptPartyInvite();
    await PumpUntilBoth(() =>
    {
        var ma = connA.Db.PartyMember.Identity.Find(idA);
        var mb = connA.Db.PartyMember.Identity.Find(idB);
        return ma is not null && mb is not null && ma.PartyId == mb.PartyId;
    }, timeoutMs, connA, connB, "party-2");

    // Let C catch up on party_member (public) while proving chat RLS separately.
    await PumpUntilBoth(() =>
        connC.Db.PartyMember.Identity.Find(idA) is not null
        && connC.Db.PartyMember.Identity.Find(idB) is not null,
        timeoutMs, connA, connC, "C sees party roster");

    const string partyText = "party channel only";
    await DelayPump3(connA, connB, connC, Chat.SayMinIntervalMs + 80);

    connA.Reducers.PartySay(partyText);
    Console.WriteLine($"A party-said: {partyText}");

    await PumpUntil3(() =>
    {
        foreach (var m in connB.Db.PartyChatMessage.Iter())
        {
            if (m.Sender == idA && m.Text == partyText)
            {
                return true;
            }
        }
        return false;
    }, timeoutMs, connA, connB, connC, "B sees A party chat");

    // Give C a moment to receive anything (should stay empty for this text).
    await DelayPump3(connA, connB, connC, 900);

    foreach (var m in connC.Db.PartyChatMessage.Iter())
    {
        if (m.Sender == idA && m.Text == partyText)
        {
            Fail($"outsider C saw party messageId={m.MessageId} text=\"{m.Text}\"");
            return;
        }
    }

    int cPartyCount = 0;
    foreach (var _ in connC.Db.PartyChatMessage.Iter()) cPartyCount++;
    int bPartyCount = 0;
    foreach (var _ in connB.Db.PartyChatMessage.Iter()) bPartyCount++;
    Console.WriteLine($"OK: PartySay RLS — B has {bPartyCount} party msg(s), C has {cPartyCount} (outsider hidden)");

    // --- Whisper: A → B private; C must not see ---
    const string whisperText = "whisper only for B";
    await DelayPump3(connA, connB, connC, Chat.SayMinIntervalMs + 80);

    connA.Reducers.Whisper(idB, whisperText);
    Console.WriteLine($"A whispered to B: {whisperText}");

    await PumpUntil3(() =>
    {
        foreach (var m in connB.Db.WhisperMessage.Iter())
        {
            if (m.Sender == idA && m.Recipient == idB && m.Text == whisperText)
            {
                return true;
            }
        }
        return false;
    }, timeoutMs, connA, connB, connC, "B sees A whisper");

    // Sender should also see own whisper (RLS sender OR recipient).
    await PumpUntil3(() =>
    {
        foreach (var m in connA.Db.WhisperMessage.Iter())
        {
            if (m.Sender == idA && m.Recipient == idB && m.Text == whisperText)
            {
                return true;
            }
        }
        return false;
    }, timeoutMs, connA, connB, connC, "A sees own whisper");

    await DelayPump3(connA, connB, connC, 900);

    foreach (var m in connC.Db.WhisperMessage.Iter())
    {
        if (m.Sender == idA && m.Text == whisperText)
        {
            Fail($"outsider C saw whisper messageId={m.MessageId} text=\"{m.Text}\"");
            return;
        }
    }

    int cWhisper = 0;
    foreach (var _ in connC.Db.WhisperMessage.Iter()) cWhisper++;
    int bWhisper = 0;
    foreach (var _ in connB.Db.WhisperMessage.Iter()) bWhisper++;
    Console.WriteLine($"OK: Whisper RLS — B has {bWhisper} whisper(s), C has {cWhisper} (outsider hidden)");

    Console.WriteLine("OK: ChatSmoke — A→B say + rate-limit + PartySay RLS + Whisper RLS");
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
    try { connC?.Disconnect(); } catch { /* ignore */ }
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

static async Task PumpUntil3(
    Func<bool> pred,
    int timeoutMs,
    DbConnection a,
    DbConnection b,
    DbConnection c,
    string label)
{
    using var cts = new CancellationTokenSource(timeoutMs);
    while (!pred() && !cts.IsCancellationRequested)
    {
        a.FrameTick();
        b.FrameTick();
        c.FrameTick();
        try { await Task.Delay(16, cts.Token); } catch (OperationCanceledException) { break; }
    }
    if (!pred()) throw new TimeoutException(label);
}

static async Task DelayPumpBoth(DbConnection a, DbConnection b, int ms)
{
    using var cts = new CancellationTokenSource(ms + 5000);
    var until = DateTime.UtcNow.AddMilliseconds(ms);
    while (DateTime.UtcNow < until && !cts.IsCancellationRequested)
    {
        a.FrameTick();
        b.FrameTick();
        try { await Task.Delay(16, cts.Token); } catch (OperationCanceledException) { break; }
    }
}

static async Task DelayPump3(DbConnection a, DbConnection b, DbConnection c, int ms)
{
    using var cts = new CancellationTokenSource(ms + 5000);
    var until = DateTime.UtcNow.AddMilliseconds(ms);
    while (DateTime.UtcNow < until && !cts.IsCancellationRequested)
    {
        a.FrameTick();
        b.FrameTick();
        c.FrameTick();
        try { await Task.Delay(16, cts.Token); } catch (OperationCanceledException) { break; }
    }
}
