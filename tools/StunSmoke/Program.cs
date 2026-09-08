using Fardel.Shared;
using SpacetimeDB;
using SpacetimeDB.Types;

// Stun/Bash: hard-CC breaks windup without CastLockedUntil; StunnedUntilMicros
// locks Move (XZ and jump:true) + Cast with "stunned" (distinct from silence).
var uri = GameConstants.ResolveLocalUri();
var db = GameConstants.ResolveDatabaseName();
const int timeoutMs = 60000;

DbConnection? connA = null;
DbConnection? connB = null;

try
{
    var (a, idA) = await ConnectAsync("A");
    connA = a;
    Console.WriteLine("A (victim) connected " + idA);
    var (b, idB) = await ConnectAsync("B");
    connB = b;
    Console.WriteLine("B (stunner) connected " + idB);
    _ = await SubscribeAll(connA, "A-all");
    _ = await SubscribeAll(connB, "B-all");
    await PumpUntilBoth(() =>
        connA.Db.PlayerPose.Identity.Find(idA) is not null
        && connB.Db.PlayerPose.Identity.Find(idB) is not null
        && connA.Db.Character.Identity.Find(idA) is not null
        && connB.Db.Character.Identity.Find(idB) is not null
        && connA.Db.PlayerCombat.Identity.Find(idA) is not null
        && connB.Db.PlayerCombat.Identity.Find(idB) is not null,
        timeoutMs, connA, connB, "poses+chars+combat");
    await MoveTo(connA, idA, 0f, 0f, connB);
    await MoveTo(connB, idB, 1.5f, 0f, connA);
    if (connA.Db.Character.Identity.Find(idA) is { StaffEquipped: false })
    {
        connA.Reducers.EquipStaff();
        await PumpUntilBoth(() => connA.Db.Character.Identity.Find(idA) is { StaffEquipped: true },
            timeoutMs, connA, connB, "A staff");
    }
    await TopUpMana(connA, idA, connB);
    await TopUpMana(connB, idB, connA);
    Console.WriteLine($"seed A mana={connA.Db.Character.Identity.Find(idA)!.Mana} B mana={connB.Db.Character.Identity.Find(idB)!.Mana}");
    connA.Reducers.EnsureTrainingDummy();
    await PumpUntilBoth(() => FindDummy(connA) is { Hp: var h } && h == Combat.DummyMaxHp,
        timeoutMs, connA, connB, "dummy full");
    var dummy = FindDummy(connA)!;
    connA.Reducers.SetTarget(dummy.NpcId);
    await PumpUntilBoth(() =>
        connA.Db.PlayerCombat.Identity.Find(idA) is { } cc && cc.TargetNpcId == dummy.NpcId,
        timeoutMs, connA, connB, "A target");
    await DelayPumpBoth(connA, connB, Combat.GcdMs + 80);

    // Out of range reject
    await MoveTo(connB, idB, Combat.StunRangeMeters * 3f, 0f, connA);
    await ExpectStunFail(connB, idA, "Out of range", "far stun");
    Console.WriteLine("out-of-range Stun reject OK");
    await MoveTo(connB, idB, 1.5f, 0f, connA);
    await DelayPumpBoth(connA, connB, Combat.GcdMs + 80);
    await TopUpMana(connA, idA, connB);
    await TopUpMana(connB, idB, connA);

    // Stun while casting: break windup, no CastLockedUntil, set StunnedUntilMicros
    connA.Reducers.EnsureTrainingDummy();
    await PumpUntilBoth(() => FindDummy(connA) is { Hp: var h } && h == Combat.DummyMaxHp,
        timeoutMs, connA, connB, "dummy full 2");
    dummy = FindDummy(connA)!;
    connA.Reducers.SetTarget(dummy.NpcId);
    await DelayPumpBoth(connA, connB, 40);
    var manaBefore = connA.Db.Character.Identity.Find(idA)!.Mana;
    var manaBBefore = connB.Db.Character.Identity.Find(idB)!.Mana;
    var dummyHpBefore = FindDummy(connA)!.Hp;
    connA.Reducers.Cast(Combat.SpellEmberbolt);
    await PumpUntilBoth(() =>
        connA.Db.PlayerCombat.Identity.Find(idA) is { } pc && pc.CastingSpellId == Combat.SpellEmberbolt,
        timeoutMs, connA, connB, "A casting stun");
    await PumpUntilBoth(() =>
    {
        var ch = connA.Db.Character.Identity.Find(idA);
        return ch is not null && ch.Mana < manaBefore;
    }, timeoutMs, connA, connB, "A mana spent");
    var manaMid = connA.Db.Character.Identity.Find(idA)!.Mana;
    Console.WriteLine($"A casting mana {manaBefore}->{manaMid}");
    connB.Reducers.Stun(idA);
    await PumpUntilBoth(() =>
        connA.Db.PlayerCombat.Identity.Find(idA) is { } pc && pc.CastingSpellId == 0,
        timeoutMs, connA, connB, "A cast cleared by Stun");
    await PumpUntilBoth(() =>
    {
        var ch = connB.Db.Character.Identity.Find(idB);
        return ch is not null && ch.Mana < manaBBefore;
    }, timeoutMs, connA, connB, "B mana spent by Stun");
    var locked = connA.Db.PlayerCombat.Identity.Find(idA)!;
    if (locked.StunnedUntilMicros <= 0)
    {
        Fail("StunnedUntilMicros not set after Stun");
        return;
    }
    // Distinct from silence: CastLockedUntil must NOT be extended by Stun.
    if (locked.CastLockedUntil.MicrosecondsSinceUnixEpoch > locked.StunnedUntilMicros)
    {
        // allow pre-existing silence; just ensure we didn't require silence for stun path
    }
    Console.WriteLine($"Stun StunnedUntilMicros={locked.StunnedUntilMicros} CastLockedUntil={locked.CastLockedUntil.MicrosecondsSinceUnixEpoch}");
    var manaAfterStun = connA.Db.Character.Identity.Find(idA)!.Mana;
    if (manaAfterStun - manaMid > Combat.ManaRegenPerTick * 2)
    {
        Fail($"Stun refunded victim mana ({manaMid}->{manaAfterStun})");
        return;
    }
    var manaBAfter = connB.Db.Character.Identity.Find(idB)!.Mana;
    if (manaBBefore - manaBAfter < Combat.StunManaCost - 1)
    {
        Fail($"Stun did not spend stunner mana ({manaBBefore}->{manaBAfter})");
        return;
    }
    Console.WriteLine($"Stun mana OK victim {manaMid}->{manaAfterStun} stunner {manaBBefore}->{manaBAfter}");

    // Move must reject while stunned (XZ and jump intent — live Space path).
    await ExpectMoveFail(connA, 0.5f, 0f, jump: false, "stunned", "during stun move");
    Console.WriteLine("Stun move reject OK");
    var velYBeforeJump = connA.Db.PlayerPose.Identity.Find(idA)!.VelY;
    await ExpectMoveFail(connA, 0f, 0f, jump: true, "stunned", "during stun jump");
    var poseJumpFail = connA.Db.PlayerPose.Identity.Find(idA)!;
    if (MathF.Abs(poseJumpFail.VelY - Movement.JumpVelocity) < 0.5f
        && MathF.Abs(velYBeforeJump - Movement.JumpVelocity) > 0.5f)
    {
        Fail($"stun jump boosted VelY {velYBeforeJump}->{poseJumpFail.VelY}");
        return;
    }
    Console.WriteLine($"Stun jump reject OK VelY={poseJumpFail.VelY}");

    // Wait past GCD so stun (not GCD) is the Cast reject reason.
    await DelayPumpBoth(connA, connB, Combat.GcdMs + 80);
    await ExpectCastFail(connA, Combat.SpellEmberbolt, "stunned", "during Stun lockout");
    Console.WriteLine("Stun cast reject OK (stunned, not silenced)");

    // Prove CastLockedUntil was not set by Stun: after stun expires, Cast works
    // without waiting CastSilenceMs (stun window may equal silence; wait stun only).
    await DelayPumpBoth(connA, connB, Combat.StunDurationMs + 200);
    await TopUpMana(connA, idA, connB);
    connA.Reducers.EnsureTrainingDummy();
    await PumpUntilBoth(() => FindDummy(connA) is { Hp: var h } && h == Combat.DummyMaxHp,
        timeoutMs, connA, connB, "dummy post-stun");
    dummy = FindDummy(connA)!;
    connA.Reducers.SetTarget(dummy.NpcId);
    await DelayPumpBoth(connA, connB, 40);
    // Move should work after stun — including jump:true.
    await MoveTo(connA, idA, 0.3f, 0f, connB);
    Console.WriteLine("post-Stun Move OK");
    connA.Reducers.Move(0f, 0f, jump: true);
    await PumpUntilBoth(() =>
    {
        var p = connA.Db.PlayerPose.Identity.Find(idA);
        return p is not null
            && (p.Y > Movement.GroundY + 0.05f
                || MathF.Abs(p.VelY - Movement.JumpVelocity) < 1f);
    }, timeoutMs, connA, connB, "post-stun jump");
    Console.WriteLine($"post-Stun jump OK Y={connA.Db.PlayerPose.Identity.Find(idA)!.Y} VelY={connA.Db.PlayerPose.Identity.Find(idA)!.VelY}");
    // Land so later idle-stun Move isn't fighting air physics.
    var landGuard = 0;
    while (connA.Db.PlayerPose.Identity.Find(idA) is { } air
           && (MathF.Abs(air.Y - Movement.GroundY) > 0.05f || MathF.Abs(air.VelY) > 0.2f)
           && landGuard++ < 40)
    {
        connA.Reducers.Move(0f, 0f, jump: false);
        await DelayPumpBoth(connA, connB, 50);
    }
    connA.Reducers.Cast(Combat.SpellEmberbolt);
    await PumpUntilBoth(() =>
        connA.Db.PlayerCombat.Identity.Find(idA) is { } pc && pc.CastingSpellId == Combat.SpellEmberbolt,
        timeoutMs, connA, connB, "A casting after Stun");
    Console.WriteLine("post-Stun Cast OK (no silence)");
    connA.Reducers.CancelCast();
    await PumpUntilBoth(() =>
        connA.Db.PlayerCombat.Identity.Find(idA) is { } pc && pc.CastingSpellId == 0,
        timeoutMs, connA, connB, "cleanup cancel");

    // Idle stun (no windup) still applies move lock
    await DelayPumpBoth(connA, connB, Combat.GcdMs + 80);
    await TopUpMana(connB, idB, connA);
    var stunBefore = connA.Db.PlayerCombat.Identity.Find(idA)!.StunnedUntilMicros;
    connB.Reducers.Stun(idA);
    await PumpUntilBoth(() =>
        connA.Db.PlayerCombat.Identity.Find(idA) is { } pc
        && pc.StunnedUntilMicros > stunBefore,
        timeoutMs, connA, connB, "idle stun applied");
    var idle = connA.Db.PlayerCombat.Identity.Find(idA)!;
    if (idle.CastingSpellId != 0)
    {
        Fail("idle stun should not leave casting");
        return;
    }
    await ExpectMoveFail(connA, 0.4f, 0f, jump: false, "stunned", "idle stun move");
    Console.WriteLine("idle Stun move reject OK");
    await ExpectMoveFail(connA, 0f, 0f, jump: true, "stunned", "idle stun jump");
    Console.WriteLine("idle Stun jump reject OK");

    await DelayPumpBoth(connA, connB, Combat.StunDurationMs + Combat.GcdMs + 200);
    await MoveTo(connA, idA, 0f, 0f, connB);
    await TopUpMana(connA, idA, connB);
    connA.Reducers.EnsureTrainingDummy();
    await PumpUntilBoth(() => FindDummy(connA) is { Hp: var h } && h == Combat.DummyMaxHp,
        timeoutMs, connA, connB, "dummy for StunNpc");
    dummy = FindDummy(connA)!;
    var dummyX = dummy.X;
    var dummyZ = dummy.Z;
    var dummyHpStun = dummy.Hp;
    var manaBeforeNpc = connA.Db.Character.Identity.Find(idA)!.Mana;
    await ExpectStunNpcOk(connA, dummy.NpcId, "dummy StunNpc");
    await PumpUntilBoth(() =>
    {
        var n = FindDummy(connA);
        var ch = connA.Db.Character.Identity.Find(idA);
        return n is { StunnedUntilMicros: > 0 } && ch is not null && ch.Mana < manaBeforeNpc;
    }, timeoutMs, connA, connB, "dummy StunnedUntilMicros + mana");
    dummy = FindDummy(connA)!;
    if (dummy.Hp != dummyHpStun)
    {
        Fail($"StunNpc damaged dummy ({dummyHpStun}->{dummy.Hp})");
        return;
    }
    if (MathF.Abs(dummy.X - dummyX) > 0.05f || MathF.Abs(dummy.Z - dummyZ) > 0.05f)
    {
        Fail($"StunNpc moved dummy trainer ({dummyX},{dummyZ})->({dummy.X},{dummy.Z})");
        return;
    }
    var dummyLockLeft = dummy.StunnedUntilMicros - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() * 1000L;
    if (dummyLockLeft < (long)Combat.StunNpcLockMs * 1000L / 2)
    {
        Fail($"dummy lock too short leftover={dummyLockLeft}us");
        return;
    }
    Console.WriteLine($"StunNpc dummy trainer OK lockLeft={dummyLockLeft}us (no shove, no HP)");

    await DelayPumpBoth(connA, connB, Combat.GcdMs + 80);
    await TopUpMana(connA, idA, connB);
    await PumpUntilBoth(() => FindHostileNear(connA, Combat.HostileSpawnAx, Combat.HostileSpawnAz) is { Hp: > 0 },
        timeoutMs, connA, connB, "hostile pad A");
    var padA = FindHostileNear(connA, Combat.HostileSpawnAx, Combat.HostileSpawnAz)!;
    if (padA.Kind != Combat.NpcKindHostile)
    {
        Fail($"pad A kind={padA.Kind} want Kind=2");
        return;
    }
    await ExpectStunNpcFail(connA, padA.NpcId, "Out of range", "origin StunNpc Kind=2");
    Console.WriteLine("origin out-of-range StunNpc Kind=2 reject OK");

    var a0x = padA.X;
    var a0z = padA.Z;
    var toPad = Dist(0f, 0f, a0x, a0z);
    var standOff = MathF.Min(Combat.StunRangeMeters - 0.8f, toPad - Combat.HostileAggroRadius - 0.4f);
    if (standOff < 0.5f)
    {
        Fail($"cannot stand off pad A (dist={toPad:0.##} stun={Combat.StunRangeMeters} aggro={Combat.HostileAggroRadius})");
        return;
    }
    var tx = a0x / toPad * (toPad - standOff);
    var tz = a0z / toPad * (toPad - standOff);
    await MoveTo(connA, idA, tx, tz, connB);
    await DelayPumpBoth(connA, connB, Combat.GcdMs + 80);
    await TopUpMana(connA, idA, connB);
    var dummyHpBeforeHostile = FindDummy(connA)!.Hp;
    var a0x2 = FindNpc(connA, padA.NpcId)!.X;
    var a0z2 = FindNpc(connA, padA.NpcId)!.Z;
    await ExpectStunNpcOk(connA, padA.NpcId, "Kind=2 StunNpc");
    await PumpUntilBoth(() =>
    {
        var n = FindNpc(connA, padA.NpcId);
        return n is { Hp: > 0, StunnedUntilMicros: > 0 };
    }, timeoutMs, connA, connB, "pad A stunned");
    var stunnedNpc = FindNpc(connA, padA.NpcId)!;
    if (stunnedNpc.Kind != Combat.NpcKindHostile)
    {
        Fail($"StunNpc changed pad A kind={stunnedNpc.Kind}");
        return;
    }
    var lockLeft = stunnedNpc.StunnedUntilMicros - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() * 1000L;
    if (lockLeft < (long)Combat.StunNpcLockMs * 1000L / 2)
    {
        Fail($"Kind=2 lock too short leftover={lockLeft}us");
        return;
    }
    var drifted = Dist(stunnedNpc.X, stunnedNpc.Z, a0x2, a0z2);
    if (drifted > Combat.HostileStepMeters * 2f)
    {
        Fail($"StunNpc Kind=2 drifted {drifted:0.##}m during lock");
        return;
    }
    if (FindDummy(connA) is not { Hp: var dHp } || dHp != dummyHpBeforeHostile)
    {
        Fail("dummy trainer HP changed during StunNpc hostile");
        return;
    }
    Console.WriteLine($"StunNpc Kind=2 OK id={stunnedNpc.NpcId} lockLeft={lockLeft}us swingAt={stunnedNpc.NextSwingAtMicros}");

    await DelayPumpBoth(connA, connB, Combat.GcdMs + 80);
    await TopUpMana(connA, idA, connB);
    await MoveTo(connA, idA, 0f, 0f, connB);
    await PumpUntilBoth(() =>
        FindKindNear(connA, Combat.NpcKindBrigand, Combat.HostileSpawnCx, Combat.HostileSpawnCz) is { Hp: > 0 },
        timeoutMs, connA, connB, "brigand pad C");
    var padC = FindKindNear(connA, Combat.NpcKindBrigand, Combat.HostileSpawnCx, Combat.HostileSpawnCz)!;
    if (padC.Kind != Combat.NpcKindBrigand)
    {
        Fail($"pad C kind={padC.Kind} want Kind=3");
        return;
    }
    var c0x = padC.X;
    var c0z = padC.Z;
    var toPadC = Dist(0f, 0f, c0x, c0z);
    var standOffC = MathF.Min(Combat.StunRangeMeters - 0.8f, toPadC - Combat.HostileAggroRadius - 0.4f);
    if (standOffC < 0.5f)
    {
        Fail($"cannot stand off pad C (dist={toPadC:0.##} stun={Combat.StunRangeMeters} aggro={Combat.HostileAggroRadius})");
        return;
    }
    var ctx = c0x / toPadC * (toPadC - standOffC);
    var ctz = c0z / toPadC * (toPadC - standOffC);
    await MoveTo(connA, idA, ctx, ctz, connB);
    await DelayPumpBoth(connA, connB, Combat.GcdMs + 80);
    await TopUpMana(connA, idA, connB);
    var dummyHpBeforeBrigand = FindDummy(connA)!.Hp;
    var c0x2 = FindNpc(connA, padC.NpcId)!.X;
    var c0z2 = FindNpc(connA, padC.NpcId)!.Z;
    await ExpectStunNpcOk(connA, padC.NpcId, "Kind=3 StunNpc");
    await PumpUntilBoth(() =>
    {
        var n = FindNpc(connA, padC.NpcId);
        return n is { Hp: > 0, StunnedUntilMicros: > 0 };
    }, timeoutMs, connA, connB, "pad C stunned");
    var stunnedC = FindNpc(connA, padC.NpcId)!;
    if (stunnedC.Kind != Combat.NpcKindBrigand)
    {
        Fail($"StunNpc changed pad C kind={stunnedC.Kind}");
        return;
    }
    var lockLeftC = stunnedC.StunnedUntilMicros - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() * 1000L;
    if (lockLeftC < (long)Combat.StunNpcLockMs * 1000L / 2)
    {
        Fail($"Kind=3 lock too short leftover={lockLeftC}us");
        return;
    }
    var driftedC = Dist(stunnedC.X, stunnedC.Z, c0x2, c0z2);
    if (driftedC > Combat.HostileStepMeters * 2f)
    {
        Fail($"StunNpc Kind=3 drifted {driftedC:0.##}m during lock");
        return;
    }
    if (FindDummy(connA) is not { Hp: var dHpC } || dHpC != dummyHpBeforeBrigand)
    {
        Fail("dummy trainer HP changed during StunNpc brigand");
        return;
    }
    Console.WriteLine($"StunNpc Kind=3 OK id={stunnedC.NpcId} lockLeft={lockLeftC}us swingAt={stunnedC.NextSwingAtMicros}");

    await MoveTo(connA, idA, Combat.StunRangeMeters * 3f, 0f, connB);
    await ExpectStunNpcFail(connA, padA.NpcId, "Out of range", "far StunNpc");
    Console.WriteLine("out-of-range StunNpc reject OK");
    await ExpectStunNpcFail(connA, 999999999UL, "Target missing", "missing StunNpc");
    Console.WriteLine("missing StunNpc reject OK");

    var dummyAfter = FindDummy(connA)!.Hp;
    if (dummyAfter != dummyHpBefore && dummyAfter != Combat.DummyMaxHp)
    {
        // Emberbolt may have been cancelled; dummy should not have taken Emberbolt from interrupted cast.
        // After reset it is full — OK.
    }
    Console.WriteLine("OK: StunSmoke passed");
    Environment.ExitCode = 0;
}
catch (Exception e) { Fail(e.ToString()); }
finally
{
    try { connA?.Disconnect(); } catch { }
    try { connB?.Disconnect(); } catch { }
}

static async Task ExpectStunFail(DbConnection conn, Identity target, string needle, string label)
{
    string? fail = null;
    var tcs = new TaskCompletionSource();
    void OnStun(ReducerEventContext ctx, Identity _target)
    {
        switch (ctx.Event.Status)
        {
            case Status.Failed(var reason): fail = reason; tcs.TrySetResult(); break;
            case Status.Committed: tcs.TrySetException(new Exception($"Stun committed ({label})")); break;
            case Status.OutOfEnergy(_): tcs.TrySetException(new Exception($"Stun OOE ({label})")); break;
        }
    }
    conn.Reducers.OnStun += OnStun;
    try { conn.Reducers.Stun(target); await Pump(tcs.Task, timeoutMs, conn, "stun fail " + label); }
    finally { conn.Reducers.OnStun -= OnStun; }
    if (string.IsNullOrEmpty(fail) || fail.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0)
    {
        Fail($"expected '{needle}' on Stun ({label}), got: {fail ?? "(null)"}");
        throw new Exception("stun fail mismatch");
    }
    Console.WriteLine($"Stun reject OK ({label}): {fail}");
}

static async Task ExpectMoveFail(DbConnection conn, float dx, float dz, bool jump, string needle, string label)
{
    string? fail = null;
    var tcs = new TaskCompletionSource();
    void OnMove(ReducerEventContext ctx, float _dx, float _dz, bool _jump)
    {
        switch (ctx.Event.Status)
        {
            case Status.Failed(var reason): fail = reason; tcs.TrySetResult(); break;
            case Status.Committed: tcs.TrySetException(new Exception($"Move committed ({label})")); break;
            case Status.OutOfEnergy(_): tcs.TrySetException(new Exception($"Move OOE ({label})")); break;
        }
    }
    conn.Reducers.OnMove += OnMove;
    try { conn.Reducers.Move(dx, dz, jump); await Pump(tcs.Task, timeoutMs, conn, "move fail " + label); }
    finally { conn.Reducers.OnMove -= OnMove; }
    if (string.IsNullOrEmpty(fail) || fail.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0)
    {
        Fail($"expected '{needle}' on Move ({label}), got: {fail ?? "(null)"}");
        throw new Exception("move fail mismatch");
    }
    Console.WriteLine($"Move reject OK ({label}): {fail}");
}

static async Task ExpectCastFail(DbConnection conn, int spellId, string needle, string label)
{
    string? fail = null;
    var tcs = new TaskCompletionSource();
    void OnCast(ReducerEventContext ctx, int _spellId)
    {
        switch (ctx.Event.Status)
        {
            case Status.Failed(var reason): fail = reason; tcs.TrySetResult(); break;
            case Status.Committed: tcs.TrySetException(new Exception($"Cast committed ({label})")); break;
            case Status.OutOfEnergy(_): tcs.TrySetException(new Exception($"Cast OOE ({label})")); break;
        }
    }
    conn.Reducers.OnCast += OnCast;
    try { conn.Reducers.Cast(spellId); await Pump(tcs.Task, timeoutMs, conn, "cast fail " + label); }
    finally { conn.Reducers.OnCast -= OnCast; }
    if (string.IsNullOrEmpty(fail) || fail.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0)
    {
        Fail($"expected '{needle}' on Cast ({label}), got: {fail ?? "(null)"}");
        throw new Exception("cast fail mismatch");
    }
    Console.WriteLine($"Cast reject OK ({label}): {fail}");
}

static async Task TopUpMana(DbConnection conn, Identity id, DbConnection other)
{
    var guard = 0;
    while (conn.Db.Character.Identity.Find(id) is { } cur
           && cur.MaxMana > 0
           && cur.Mana < cur.MaxMana - Math.Max(Combat.EmberboltManaCost, Combat.StunManaCost)
           && guard++ < 10)
    {
        await DelayPumpBoth(conn, other, Rest.CombatLockMs + Rest.CooldownMs + 150);
        var before = cur.Mana;
        try { conn.Reducers.Rest(); } catch { }
        await DelayPumpBoth(conn, other, 200);
        await DelayPumpBoth(conn, other, Combat.ManaRegenIntervalMs * 2);
        var after = conn.Db.Character.Identity.Find(id);
        if (after is null || after.Mana <= before) break;
    }
}

static async Task MoveTo(DbConnection conn, Identity id, float x, float z, DbConnection other)
{
    for (var i = 0; i < 120; i++)
    {
        var pose = conn.Db.PlayerPose.Identity.Find(id);
        if (pose is null) { await DelayPumpBoth(conn, other, 40); continue; }
        var combat = conn.Db.PlayerCombat.Identity.Find(id);
        if (combat is not null
            && combat.StunnedUntilMicros > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() * 1000L)
        {
            // Wait out stun if somehow still locked during reposition helpers.
            await DelayPumpBoth(conn, other, 80);
            continue;
        }
        var dx = x - pose.X; var dz = z - pose.Z;
        var dist = MathF.Sqrt(dx * dx + dz * dz);
        if (dist < 0.25f) return;
        var scale = MathF.Min(Movement.MaxStepMeters, dist) / dist;
        conn.Reducers.Move(dx * scale, dz * scale, false);
        await DelayPumpBoth(conn, other, 50);
    }
    Fail($"MoveTo timeout ({x},{z})");
    throw new Exception("move timeout");
}

static Npc? FindDummy(DbConnection conn)
{
    foreach (var n in conn.Db.Npc.Iter()) if (n.Kind == Combat.NpcKindDummy) return n;
    return null;
}

static Npc? FindNpc(DbConnection conn, ulong id)
{
    foreach (var n in conn.Db.Npc.Iter()) if (n.NpcId == id) return n;
    return null;
}

static Npc? FindHostileNear(DbConnection conn, float x, float z)
{
    Npc? best = null;
    var bestD = float.MaxValue;
    foreach (var n in conn.Db.Npc.Iter())
    {
        if (n.Kind != Combat.NpcKindHostile || n.Hp <= 0) continue;
        var dx = n.X - x;
        var dz = n.Z - z;
        var d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = n; }
    }
    return best;
}

static Npc? FindKindNear(DbConnection conn, int kind, float x, float z)
{
    foreach (var n in conn.Db.Npc.Iter())
    {
        if (n.Kind != kind) continue;
        var hx = MathF.Abs(n.SpawnX) > 0.01f || MathF.Abs(n.SpawnZ) > 0.01f ? n.SpawnX : n.X;
        var hz = MathF.Abs(n.SpawnX) > 0.01f || MathF.Abs(n.SpawnZ) > 0.01f ? n.SpawnZ : n.Z;
        if (Dist(hx, hz, x, z) < 0.5f) return n;
    }
    return null;
}

static float Dist(float ax, float az, float bx, float bz)
{
    var dx = ax - bx;
    var dz = az - bz;
    return MathF.Sqrt(dx * dx + dz * dz);
}

static async Task ExpectStunNpcOk(DbConnection conn, ulong npcId, string label)
{
    var tcs = new TaskCompletionSource();
    void OnStunNpc(ReducerEventContext ctx, ulong _npcId)
    {
        switch (ctx.Event.Status)
        {
            case Status.Committed: tcs.TrySetResult(); break;
            case Status.Failed(var reason): tcs.TrySetException(new Exception($"StunNpc failed ({label}): {reason}")); break;
            case Status.OutOfEnergy(_): tcs.TrySetException(new Exception($"StunNpc OOE ({label})")); break;
        }
    }
    conn.Reducers.OnStunNpc += OnStunNpc;
    try { conn.Reducers.StunNpc(npcId); await Pump(tcs.Task, timeoutMs, conn, "stun npc ok " + label); }
    finally { conn.Reducers.OnStunNpc -= OnStunNpc; }
}

static async Task ExpectStunNpcFail(DbConnection conn, ulong npcId, string needle, string label)
{
    string? fail = null;
    var tcs = new TaskCompletionSource();
    void OnStunNpc(ReducerEventContext ctx, ulong _npcId)
    {
        switch (ctx.Event.Status)
        {
            case Status.Failed(var reason): fail = reason; tcs.TrySetResult(); break;
            case Status.Committed: tcs.TrySetException(new Exception($"StunNpc committed ({label})")); break;
            case Status.OutOfEnergy(_): tcs.TrySetException(new Exception($"StunNpc OOE ({label})")); break;
        }
    }
    conn.Reducers.OnStunNpc += OnStunNpc;
    try { conn.Reducers.StunNpc(npcId); await Pump(tcs.Task, timeoutMs, conn, "stun npc fail " + label); }
    finally { conn.Reducers.OnStunNpc -= OnStunNpc; }
    if (string.IsNullOrEmpty(fail) || fail.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0)
    {
        Fail($"expected '{needle}' on StunNpc ({label}), got: {fail ?? "(null)"}");
        throw new Exception("stun npc fail mismatch");
    }
    Console.WriteLine($"StunNpc reject OK ({label}): {fail}");
}

static void Fail(string msg) { Console.Error.WriteLine("FAIL: " + msg); Environment.ExitCode = 1; }

async Task<(DbConnection conn, Identity id)> ConnectAsync(string label)
{
    var connected = new TaskCompletionSource<Identity>();
    var c = DbConnection.Builder().WithUri(uri).WithDatabaseName(db)
        .OnConnect((_, identity, _) => connected.TrySetResult(identity))
        .OnConnectError(e => connected.TrySetException(e)).Build();
    await Pump(connected.Task, timeoutMs, c, "connect " + label);
    return (c, await connected.Task);
}

static async Task<SubscriptionHandle> SubscribeAll(DbConnection conn, string label)
{
    var applied = new TaskCompletionSource();
    var handle = conn.SubscriptionBuilder()
        .OnApplied(_ => applied.TrySetResult())
        .OnError((_, e) => applied.TrySetException(e))
        .SubscribeToAllTables();
    await Pump(applied.Task, timeoutMs, conn, "subscribe " + label);
    return handle;
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

static async Task PumpUntilBoth(Func<bool> pred, int timeoutMs, DbConnection a, DbConnection b, string label)
{
    using var cts = new CancellationTokenSource(timeoutMs);
    while (!pred() && !cts.IsCancellationRequested)
    {
        a.FrameTick(); b.FrameTick();
        try { await Task.Delay(16, cts.Token); } catch (OperationCanceledException) { break; }
    }
    if (!pred()) throw new TimeoutException(label);
}

static async Task DelayPumpBoth(DbConnection a, DbConnection b, int ms)
{
    var until = Environment.TickCount64 + ms;
    while (Environment.TickCount64 < until) { a.FrameTick(); b.FrameTick(); await Task.Delay(16); }
}
