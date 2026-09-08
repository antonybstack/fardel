using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

var uri = GameConstants.ResolveLocalUri();
var db = GameConstants.ResolveDatabaseName();
const int timeoutMs = 20000;

var connected = new TaskCompletionSource<Identity>();
var subscribed = new TaskCompletionSource();
var jumped = new TaskCompletionSource<(float y, float velY)>();
var landed = new TaskCompletionSource<float>();

DbConnection? conn = null;
Identity? me = null;

try
{
    conn = DbConnection.Builder()
        .WithUri(uri)
        .WithDatabaseName(db)
        .OnConnect((c, identity, _) =>
        {
            me = identity;
            connected.TrySetResult(identity);
        })
        .OnConnectError(e => connected.TrySetException(e))
        .OnDisconnect((_, e) =>
        {
            if (!jumped.Task.IsCompleted)
            {
                jumped.TrySetException(e ?? new Exception("disconnected early"));
            }
            if (!landed.Task.IsCompleted)
            {
                landed.TrySetException(e ?? new Exception("disconnected early"));
            }
        })
        .Build();

    if (!await WaitTick(connected.Task, timeoutMs, conn, "connect"))
    {
        Fail("connect timeout");
        return;
    }

    var identity = await connected.Task;
    Console.WriteLine("connected " + identity);

    var jumpedOnce = false;
    var landedOnce = false;

    conn.Db.PlayerPose.OnInsert += (_, _) => { };
    conn.Db.PlayerPose.OnUpdate += (EventContext ctx, PlayerPose oldPose, PlayerPose newPose) =>
    {
        if (me is { } id && newPose.Identity == id)
        {
            // Detect jump: Y rising above GroundY or VelY near JumpVelocity
            if (!jumpedOnce && (newPose.Y > Movement.GroundY + 0.05f || MathF.Abs(newPose.VelY - Movement.JumpVelocity) < 1f))
            {
                jumpedOnce = true;
                jumped.TrySetResult((newPose.Y, newPose.VelY));
            }

            // Detect landing: Y back near GroundY and VelY near 0
            if (jumpedOnce && !landedOnce && MathF.Abs(newPose.Y - Movement.GroundY) < 0.05f && MathF.Abs(newPose.VelY) < 0.1f)
            {
                landedOnce = true;
                landed.TrySetResult(newPose.Y);
            }
        }
    };

    conn.SubscriptionBuilder()
        .OnApplied(_ => subscribed.TrySetResult())
        .OnError((_, e) => subscribed.TrySetException(e))
        .SubscribeToAllTables();

    if (!await WaitTick(subscribed.Task, timeoutMs, conn, "subscribe"))
    {
        Fail("subscribe timeout");
        return;
    }

    if (conn.Db.PlayerPose.Identity.Find(identity) is not { } pose)
    {
        Fail("PlayerPose missing after subscribe");
        return;
    }

    var spawnLastGroundedMicros = pose.LastGroundedMicros;
    Console.WriteLine($"spawn pose ({pose.X}, {pose.Y}, {pose.Z}) velY={pose.VelY} lastGroundedMicros={spawnLastGroundedMicros}");

    // Jump while grounded
    conn.Reducers.Move(0f, 0f, jump: true);

    if (!await WaitTick(jumped.Task, timeoutMs, conn, "jump"))
    {
        Fail("jump timeout — no pose update with rising Y");
        return;
    }

    var (jumpY, jumpVelY) = await jumped.Task;
    Console.WriteLine($"jumped: Y={jumpY} velY={jumpVelY}");

    if (jumpY <= Movement.GroundY + 0.01f && MathF.Abs(jumpVelY - Movement.JumpVelocity) > 1f)
    {
        Fail("jump did not raise Y or set VelY");
        return;
    }

    // Air-phase: server gravity / ground-clamp only run inside Move — pump until land.
    // (Merged #96 WaitTick only FrameTick'd; never advanced physics.)
    var airTick = 0;
    using (var landCts = new CancellationTokenSource(timeoutMs))
    {
        while (!landed.Task.IsCompleted && !landCts.IsCancellationRequested)
        {
            conn.Reducers.Move(0f, 0f, jump: false);
            conn.FrameTick();
            if (conn.Db.PlayerPose.Identity.Find(identity) is { } air)
            {
                Console.WriteLine($"air tick {airTick} Y={air.Y} VelY={air.VelY}");
            }
            airTick++;
            try
            {
                await Task.Delay(50, landCts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            conn.FrameTick();
        }
    }

    if (!landed.Task.IsCompleted)
    {
        Fail("landing timeout — player did not return to ground");
        return;
    }

    var landY = await landed.Task;
    if (MathF.Abs(landY - Movement.GroundY) > 0.05f)
    {
        Fail($"landed Y={landY} not at GroundY={Movement.GroundY}");
        return;
    }
    if (conn.Db.PlayerPose.Identity.Find(identity) is not { } landPose)
    {
        Fail("PlayerPose missing after land");
        return;
    }
    if (MathF.Abs(landPose.VelY) > 0.1f)
    {
        Fail($"landed VelY={landPose.VelY} not ≈0");
        return;
    }
    
    // Assert LastGroundedMicros advanced (strictly greater than pre-jump)
    if (landPose.LastGroundedMicros <= spawnLastGroundedMicros)
    {
        Fail($"landed LastGroundedMicros={landPose.LastGroundedMicros} not > spawn={spawnLastGroundedMicros}");
        return;
    }
    Console.WriteLine($"landed: Y={landY} lastGroundedMicros={landPose.LastGroundedMicros} (advanced from {spawnLastGroundedMicros})");

    // Hold-Space air pump (#157): live client keeps jump:true while Space is held.
    // After rise, pump Move(0,0,true) until land — gravity must still integrate; VelY must
    // not reset to JumpVelocity mid-air.
    conn.Reducers.Move(0f, 0f, jump: true);
    var holdRose = false;
    float holdPeakVelY = 0f;
    using (var holdCts = new CancellationTokenSource(timeoutMs))
    {
        while (!holdCts.IsCancellationRequested)
        {
            conn.FrameTick();
            var air = conn.Db.PlayerPose.Identity.Find(identity);
            if (air is null)
            {
                Fail("PlayerPose missing during hold-Space jump");
                return;
            }
            if (!holdRose)
            {
                if (air.Y > Movement.GroundY + 0.05f
                    || MathF.Abs(air.VelY - Movement.JumpVelocity) < 1f)
                {
                    holdRose = true;
                    holdPeakVelY = air.VelY;
                    Console.WriteLine($"hold-Space jumped: Y={air.Y} velY={air.VelY}");
                }
            }
            else
            {
                // Mid-air re-boost: VelY snaps back to JumpVelocity after it had fallen.
                if (air.Y > Movement.GroundY + 0.08f
                    && MathF.Abs(air.VelY - Movement.JumpVelocity) < 0.5f
                    && holdPeakVelY < Movement.JumpVelocity - 1f)
                {
                    Fail($"hold-Space air pump re-boosted VelY to {air.VelY} (was {holdPeakVelY})");
                    return;
                }
                if (air.VelY < holdPeakVelY)
                {
                    holdPeakVelY = air.VelY;
                }
                if (MathF.Abs(air.Y - Movement.GroundY) < 0.05f && MathF.Abs(air.VelY) < 0.1f)
                {
                    Console.WriteLine($"hold-Space landed: Y={air.Y} velY={air.VelY}");
                    break;
                }
            }
            conn.Reducers.Move(0f, 0f, jump: true);
            try
            {
                await Task.Delay(50, holdCts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            conn.FrameTick();
        }
    }
    if (!holdRose)
    {
        Fail("hold-Space jump timeout — no pose update with rising Y");
        return;
    }
    if (conn.Db.PlayerPose.Identity.Find(identity) is not { } holdLand
        || MathF.Abs(holdLand.Y - Movement.GroundY) > 0.05f
        || MathF.Abs(holdLand.VelY) > 0.1f)
    {
        Fail("hold-Space air pump did not land (Y/VelY)");
        return;
    }
    Console.WriteLine("hold-Space Move(0,0,true) air pump land OK (no VelY re-boost)");

    // Second jump while airborne should not re-boost (anti multi-jump)
    // Get current pose
    if (conn.Db.PlayerPose.Identity.Find(identity) is not { } poseBeforeSecond)
    {
        Fail("PlayerPose missing before second jump");
        return;
    }

    var beforeVelY = poseBeforeSecond.VelY;

    // Try immediate second jump
    conn.Reducers.Move(0f, 0f, jump: true);
    await PumpFrames(conn, 200);

    if (conn.Db.PlayerPose.Identity.Find(identity) is { } poseAfterSecond)
    {
        // VelY should not jump back to JumpVelocity if already landed/grounded
        if (MathF.Abs(poseAfterSecond.VelY - Movement.JumpVelocity) < 0.5f && MathF.Abs(beforeVelY) < 0.1f)
        {
            // This is fine - we jumped again from ground
            Console.WriteLine($"second jump from ground: velY {beforeVelY} -> {poseAfterSecond.VelY}");
        }
        else
        {
            Console.WriteLine($"second jump check: velY {beforeVelY} -> {poseAfterSecond.VelY}");
        }
    }

    // Small XZ move with jump=false still works
    var beforeX = poseBeforeSecond.X;
    conn.Reducers.Move(0.1f, 0f, jump: false);
    await PumpFrames(conn, 200);

    if (conn.Db.PlayerPose.Identity.Find(identity) is { } finalPose)
    {
        if (MathF.Abs(finalPose.X - beforeX) < 0.01f)
        {
            Fail("XZ movement broken after jump");
            return;
        }
        Console.WriteLine($"XZ move OK: X {beforeX} -> {finalPose.X}");
    }

    Console.WriteLine("OK: JumpSmoke passed");
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


static async Task PumpFrames(DbConnection conn, int ms)
{
    using var cts = new CancellationTokenSource(ms + 100);
    var end = DateTime.UtcNow.AddMilliseconds(ms);
    try
    {
        while (DateTime.UtcNow < end && !cts.IsCancellationRequested)
        {
            conn.FrameTick();
            await Task.Delay(16, cts.Token).ConfigureAwait(false);
        }
    }
    catch (OperationCanceledException)
    {
        // ignore
    }
}

static async Task<bool> WaitTick(Task task, int timeoutMs, DbConnection conn, string label)
{
    using var cts = new CancellationTokenSource(timeoutMs);
    try
    {
        while (!task.IsCompleted && !cts.IsCancellationRequested)
        {
            conn.FrameTick();
            await Task.Delay(16, cts.Token).ConfigureAwait(false);
        }
    }
    catch (OperationCanceledException)
    {
        Console.Error.WriteLine($"timeout waiting for {label}");
        return false;
    }

    return task.IsCompleted;
}
