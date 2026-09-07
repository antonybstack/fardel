using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

// Long-lived party mate for browser ?ve=party / ?ve=party-hp / ?ve=party-frames / ?ve=party-xp / ?ve=party-loot:
// invite online identities (skip stale no-accept), wait for party size>=2,
// kill dummy once (party XP share + in-range loot share to mates), take a few
// dummy-thorn Sparks (mate HP mid for party-hp frames), move far, hold.
const string uri = "http://127.0.0.1:3000";
const string db = "fardel";
const float farX = 120f;
const float farZ = 0f;
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
    Console.WriteLine("party-mate connected " + identity);

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
    Console.WriteLine("READY waiting for other PlayerPose to invite…");

    var moved = false;
    var shareKillDone = false;
    var thornsTaken = false;
    var skipped = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    var soloSince = DateTime.UtcNow;
    Identity? lastInvitee = null;

    while (true)
    {
        // Accept inbound invites first.
        if (conn.Db.PartyInvite.Invitee.Find(identity) is not null
            && conn.Db.PartyMember.Identity.Find(identity) is null)
        {
            Console.WriteLine("AcceptPartyInvite (inbound)");
            conn.Reducers.AcceptPartyInvite();
            await Frame(conn, 250);
        }

        var self = conn.Db.PartyMember.Identity.Find(identity);
        var partyCount = 0;
        if (self is not null)
        {
            foreach (var m in conn.Db.PartyMember.Iter())
            {
                if (m.PartyId == self.PartyId) partyCount++;
            }
        }

        // Stuck solo after inviting a ghost — leave and blacklist that invitee.
        if (self is not null && partyCount < 2)
        {
            if ((DateTime.UtcNow - soloSince).TotalSeconds > 4)
            {
                if (lastInvitee is { } bad)
                {
                    skipped.Add(bad.ToString());
                    Console.WriteLine("solo timeout — blacklisting " + bad);
                }
                Console.WriteLine("LeaveParty (solo timeout)");
                try { conn.Reducers.LeaveParty(); } catch (Exception e) { Console.Error.WriteLine(e.Message); }
                lastInvitee = null;
                soloSince = DateTime.UtcNow;
                await Frame(conn, 300);
                continue;
            }
        }
        else
        {
            soloSince = DateTime.UtcNow;
        }

        if (conn.Db.PartyMember.Identity.Find(identity) is null)
        {
            Identity? target = null;
            foreach (var pose in conn.Db.PlayerPose.Iter())
            {
                if (pose.Identity.Equals(identity)) continue;
                if (skipped.Contains(pose.Identity.ToString())) continue;
                if (conn.Db.PartyMember.Identity.Find(pose.Identity) is not null) continue;
                target = pose.Identity;
                break;
            }
            if (target is { } t)
            {
                Console.WriteLine("InviteToParty " + t);
                try
                {
                    conn.Reducers.InviteToParty(t);
                    lastInvitee = t;
                    soloSince = DateTime.UtcNow;
                }
                catch (Exception e)
                {
                    Console.Error.WriteLine("invite error: " + e.Message);
                    skipped.Add(t.ToString());
                }
                await Frame(conn, 400);
            }
        }

        self = conn.Db.PartyMember.Identity.Find(identity);
        partyCount = 0;
        if (self is not null)
        {
            foreach (var m in conn.Db.PartyMember.Iter())
            {
                if (m.PartyId == self.PartyId) partyCount++;
            }
        }

        if (self is not null && partyCount >= 2 && !shareKillDone)
        {
            // Kill dummy so browser mate receives Combat.PartyXpSharePerMate (+ toast/floater).
            Console.WriteLine($"Party size {partyCount} — killing dummy for party-xp share…");
            var chK = conn.Db.Character.Identity.Find(identity);
            if (chK is not null && !chK.StaffEquipped)
            {
                conn.Reducers.EquipStaff();
                await Frame(conn, 200);
            }
            try { conn.Reducers.EnsureTrainingDummy(); } catch { /* ignore */ }
            await Frame(conn, 150);
            for (var guard = 0; guard < 40; guard++)
            {
                Npc? dummyK = null;
                foreach (var n in conn.Db.Npc.Iter())
                {
                    if (n.Hp > 0) { dummyK = n; break; }
                }
                if (dummyK is null)
                {
                    try { conn.Reducers.EnsureTrainingDummy(); } catch { /* ignore */ }
                    await Frame(conn, 200);
                    continue;
                }
                if (dummyK.Hp <= 0) break;
                try
                {
                    conn.Reducers.SetTarget(dummyK.NpcId);
                    await Frame(conn, 60);
                    conn.Reducers.Cast(Combat.SpellSpark);
                }
                catch (Exception e)
                {
                    Console.Error.WriteLine("share kill cast: " + e.Message);
                }
                await Frame(conn, Combat.GcdMs + 40);
                var still = false;
                foreach (var n in conn.Db.Npc.Iter())
                {
                    if (n.NpcId == dummyK.NpcId && n.Hp > 0) { still = true; break; }
                }
                if (!still) break;
            }
            shareKillDone = true;
            Console.WriteLine("share kill done (mates should have +PartyXpSharePerMate)");
        }

        if (self is not null && partyCount >= 2 && !thornsTaken)
        {
            // Drop mate HP via dummy thorns so browser party frames show non-full mate bar.
            Console.WriteLine($"Party size {partyCount} — taking thorns for party-hp VE…");
            var ch = conn.Db.Character.Identity.Find(identity);
            if (ch is not null && !ch.StaffEquipped)
            {
                conn.Reducers.EquipStaff();
                await Frame(conn, 200);
            }
            for (var t = 0; t < 3; t++)
            {
                try { conn.Reducers.EnsureTrainingDummy(); } catch { /* ignore */ }
                await Frame(conn, 120);
                Npc? dummy = null;
                foreach (var n in conn.Db.Npc.Iter())
                {
                    if (n.Hp > 0) { dummy = n; break; }
                }
                if (dummy is null) break;
                try
                {
                    conn.Reducers.SetTarget(dummy.NpcId);
                    await Frame(conn, 80);
                    conn.Reducers.Cast(Combat.SpellSpark);
                }
                catch (Exception e)
                {
                    Console.Error.WriteLine("thorn cast: " + e.Message);
                }
                await Frame(conn, Combat.GcdMs + 40);
            }
            ch = conn.Db.Character.Identity.Find(identity);
            if (ch is not null)
                Console.WriteLine($"mate HP after thorns {ch.Hp}/{ch.MaxHp}");
            thornsTaken = true;
        }

        if (self is not null && partyCount >= 2 && !moved)
        {
            Console.WriteLine($"Party size {partyCount} — moving far…");
            await MoveTo(conn, identity, farX, farZ);
            moved = true;
            if (conn.Db.PlayerPose.Identity.Find(identity) is { } p)
            {
                Console.WriteLine($"READY far party mate @({p.X:F1},{p.Z:F1}) chunk=({p.ChunkX},{p.ChunkZ})");
            }
        }

        await Frame(conn, 250);
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

static async Task MoveTo(DbConnection conn, Identity id, float tx, float tz)
{
    for (var i = 0; i < 500; i++)
    {
        if (conn.Db.PlayerPose.Identity.Find(id) is not { } cur)
        {
            await Frame(conn, 30);
            continue;
        }
        var dx = tx - cur.X;
        var dz = tz - cur.Z;
        var dist = MathF.Sqrt(dx * dx + dz * dz);
        if (dist < 0.5f) return;
        var scale = MathF.Min(Movement.MaxStepMeters, dist) / dist;
        conn.Reducers.Move(dx * scale, dz * scale);
        await Frame(conn, 16);
    }
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
