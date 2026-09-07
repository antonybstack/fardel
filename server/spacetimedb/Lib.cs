using Fardel.Shared;
using SpacetimeDB;

public static partial class Module
{
    public const int NpcKindDummy = 1;

    [SpacetimeDB.Table(Accessor = "PlayerPose", Public = true)]
    public partial struct PlayerPose
    {
        [SpacetimeDB.PrimaryKey]
        public Identity Identity;
        public float X;
        public float Y;
        public float Z;
        public float Yaw;
        public int ChunkX;
        public int ChunkZ;
    }

    [SpacetimeDB.Table(Accessor = "PlayerCombat", Public = true)]
    public partial struct PlayerCombat
    {
        [SpacetimeDB.PrimaryKey]
        public Identity Identity;
        public ulong TargetNpcId;
        public Timestamp GcdReadyAt;
        public int Xp;
    }

    [SpacetimeDB.Table(Accessor = "Npc", Public = true)]
    public partial struct Npc
    {
        [SpacetimeDB.PrimaryKey, SpacetimeDB.AutoInc]
        public ulong NpcId;
        public int Kind;
        public float X;
        public float Y;
        public float Z;
        public int Hp;
        public int MaxHp;
    }

    [SpacetimeDB.Table(Accessor = "PendingCast", Scheduled = nameof(ResolveCast), ScheduledAt = nameof(ScheduledAt))]
    public partial struct PendingCast
    {
        [SpacetimeDB.PrimaryKey, SpacetimeDB.AutoInc]
        public ulong ScheduleId;
        public ScheduleAt ScheduledAt;
        public Identity Caster;
        public int SpellId;
        public ulong TargetNpcId;
    }

    [SpacetimeDB.Reducer(ReducerKind.ClientConnected)]
    public static void ClientConnected(ReducerContext ctx)
    {
        Log.Info($"Client connected: {ctx.Sender}");
        EnsureDummy(ctx);
        EnsurePlayer(ctx, ctx.Sender);
    }

    [SpacetimeDB.Reducer(ReducerKind.ClientDisconnected)]
    public static void ClientDisconnected(ReducerContext ctx)
    {
        Log.Info($"Client disconnected: {ctx.Sender}");
        if (ctx.Db.PlayerPose.Identity.Find(ctx.Sender) is { } pose)
        {
            ctx.Db.PlayerPose.Identity.Delete(pose.Identity);
        }

        if (ctx.Db.PlayerCombat.Identity.Find(ctx.Sender) is { } combat)
        {
            ctx.Db.PlayerCombat.Identity.Delete(combat.Identity);
        }
    }

    [SpacetimeDB.Reducer]
    public static void Move(ReducerContext ctx, float dx, float dz)
    {
        var pose = ctx.Db.PlayerPose.Identity.Find(ctx.Sender)
            ?? throw new Exception("PlayerPose missing");

        Movement.ClampWishStep(ref dx, ref dz);
        var x = pose.X + dx;
        var z = pose.Z + dz;
        Movement.ChunkCoords(x, z, out var cx, out var cz);
        pose.X = x;
        pose.Z = z;
        pose.ChunkX = cx;
        pose.ChunkZ = cz;
        ctx.Db.PlayerPose.Identity.Update(pose);
    }

    [SpacetimeDB.Reducer]
    public static void SetTarget(ReducerContext ctx, ulong npcId)
    {
        var combat = ctx.Db.PlayerCombat.Identity.Find(ctx.Sender)
            ?? throw new Exception("PlayerCombat missing");
        if (npcId != 0 && ctx.Db.Npc.NpcId.Find(npcId) is null)
        {
            throw new Exception("Target npc not found");
        }

        combat.TargetNpcId = npcId;
        ctx.Db.PlayerCombat.Identity.Update(combat);
    }

    /// <summary>Cast Spark (1) or Emberbolt (2) at current target. Shared GCD.</summary>
    [SpacetimeDB.Reducer]
    public static void Cast(ReducerContext ctx, int spellId)
    {
        if (!Combat.TryGetSpell(spellId, out var castMs, out var damage))
        {
            throw new Exception("Unknown spell");
        }

        var combat = ctx.Db.PlayerCombat.Identity.Find(ctx.Sender)
            ?? throw new Exception("PlayerCombat missing");

        if (ctx.Timestamp < combat.GcdReadyAt)
        {
            throw new Exception("GCD");
        }

        if (combat.TargetNpcId == 0)
        {
            throw new Exception("No target");
        }

        var npc = ctx.Db.Npc.NpcId.Find(combat.TargetNpcId)
            ?? throw new Exception("Target npc not found");
        if (npc.Hp <= 0)
        {
            throw new Exception("Target dead");
        }

        combat.GcdReadyAt = ctx.Timestamp + Ms(Combat.GcdMs);
        ctx.Db.PlayerCombat.Identity.Update(combat);

        if (castMs <= 0)
        {
            ApplyDamage(ctx, ctx.Sender, npc.NpcId, damage);
            return;
        }

        ctx.Db.PendingCast.Insert(new PendingCast
        {
            ScheduledAt = new ScheduleAt.Time(ctx.Timestamp + Ms(castMs)),
            Caster = ctx.Sender,
            SpellId = spellId,
            TargetNpcId = npc.NpcId,
        });
    }

    [SpacetimeDB.Reducer]
    public static void ResolveCast(ReducerContext ctx, PendingCast cast)
    {
        if (!Combat.TryGetSpell(cast.SpellId, out _, out var damage))
        {
            return;
        }

        ApplyDamage(ctx, cast.Caster, cast.TargetNpcId, damage);
    }

    /// <summary>Test helper: reset/ensure a living dummy for smokes.</summary>
    [SpacetimeDB.Reducer]
    public static void EnsureTrainingDummy(ReducerContext ctx)
    {
        EnsureDummy(ctx);
        foreach (var npc in ctx.Db.Npc.Iter())
        {
            if (npc.Kind != NpcKindDummy)
            {
                continue;
            }

            var refreshed = npc;
            refreshed.Hp = refreshed.MaxHp;
            ctx.Db.Npc.NpcId.Update(refreshed);
            return;
        }
    }

    static void EnsurePlayer(ReducerContext ctx, Identity id)
    {
        if (ctx.Db.PlayerPose.Identity.Find(id) is null)
        {
            Movement.ChunkCoords(Movement.SpawnX, Movement.SpawnZ, out var cx, out var cz);
            ctx.Db.PlayerPose.Insert(new PlayerPose
            {
                Identity = id,
                X = Movement.SpawnX,
                Y = Movement.SpawnY,
                Z = Movement.SpawnZ,
                Yaw = 0f,
                ChunkX = cx,
                ChunkZ = cz,
            });
        }

        if (ctx.Db.PlayerCombat.Identity.Find(id) is null)
        {
            ctx.Db.PlayerCombat.Insert(new PlayerCombat
            {
                Identity = id,
                TargetNpcId = 0,
                GcdReadyAt = ctx.Timestamp,
                Xp = 0,
            });
        }
    }

    static void EnsureDummy(ReducerContext ctx)
    {
        foreach (var npc in ctx.Db.Npc.Iter())
        {
            if (npc.Kind == NpcKindDummy)
            {
                return;
            }
        }

        ctx.Db.Npc.Insert(new Npc
        {
            Kind = NpcKindDummy,
            X = Combat.DummySpawnX,
            Y = Combat.DummySpawnY,
            Z = Combat.DummySpawnZ,
            Hp = Combat.DummyMaxHp,
            MaxHp = Combat.DummyMaxHp,
        });
    }

    static void ApplyDamage(ReducerContext ctx, Identity caster, ulong npcId, int damage)
    {
        if (ctx.Db.Npc.NpcId.Find(npcId) is not { } row || row.Hp <= 0)
        {
            return;
        }

        row.Hp = Math.Max(0, row.Hp - damage);
        ctx.Db.Npc.NpcId.Update(row);

        if (row.Hp == 0)
        {
            if (ctx.Db.PlayerCombat.Identity.Find(caster) is { } combat)
            {
                combat.Xp += Combat.XpPerKill;
                ctx.Db.PlayerCombat.Identity.Update(combat);
                Log.Info($"Dummy killed by {caster}, xp={combat.Xp}");
            }
        }
    }

    static TimeDuration Ms(int ms) => new() { Microseconds = ms * 1000L };
}
