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
        /// <summary>Hysteresis-stable AOI center (ADR 0001).</summary>
        public int InterestChunkX;
        public int InterestChunkZ;
    }

    /// <summary>Slice-4 crowd proxies for AOI / alloc scaffold (not real players).</summary>
    [SpacetimeDB.Table(Accessor = "CrowdProxy", Public = true)]
    public partial struct CrowdProxy
    {
        [SpacetimeDB.PrimaryKey, SpacetimeDB.AutoInc]
        public ulong ProxyId;
        public float X;
        public float Y;
        public float Z;
        public int ChunkX;
        public int ChunkZ;
        public bool Far;
    }

    /// <summary>Durable traveler row — survives disconnect (slice 3).</summary>
    [SpacetimeDB.Table(Accessor = "Character", Public = true)]
    public partial struct Character
    {
        [SpacetimeDB.PrimaryKey]
        public Identity Identity;
        public int Xp;
        public bool KnowsSpark;
        public bool KnowsEmberbolt;
        public bool StaffEquipped;
        public bool RobesEquipped;
    }

    [SpacetimeDB.Table(Accessor = "PlayerCombat", Public = true)]
    public partial struct PlayerCombat
    {
        [SpacetimeDB.PrimaryKey]
        public Identity Identity;
        public ulong TargetNpcId;
        public Timestamp GcdReadyAt;
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
        EnsureCharacter(ctx, ctx.Sender);
        EnsureSession(ctx, ctx.Sender);
    }

    [SpacetimeDB.Reducer(ReducerKind.ClientDisconnected)]
    public static void ClientDisconnected(ReducerContext ctx)
    {
        Log.Info($"Client disconnected: {ctx.Sender}");
        // Character row is durable — do not delete.
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
        var ix = pose.InterestChunkX;
        var iz = pose.InterestChunkZ;
        Aoi.UpdateInterest(x, z, cx, cz, ref ix, ref iz);
        pose.InterestChunkX = ix;
        pose.InterestChunkZ = iz;
        ctx.Db.PlayerPose.Identity.Update(pose);
    }

    /// <summary>Clear + seed near/far crowd proxies for AOI smokes (idempotent).</summary>
    [SpacetimeDB.Reducer]
    public static void SeedCrowdProxies(ReducerContext ctx)
    {
        // Collect ids first — do not mutate while iterating.
        var toDelete = new System.Collections.Generic.List<ulong>();
        foreach (var row in ctx.Db.CrowdProxy.Iter())
        {
            toDelete.Add(row.ProxyId);
        }

        foreach (var id in toDelete)
        {
            ctx.Db.CrowdProxy.ProxyId.Delete(id);
        }

        // Near: around spawn chunk (0,0) neighborhood
        for (var i = 0; i < Aoi.CrowdNearCount; i++)
        {
            var x = (i % 3) * 4f;
            var z = (i / 3) * 4f;
            Movement.ChunkCoords(x, z, out var cx, out var cz);
            ctx.Db.CrowdProxy.Insert(new CrowdProxy
            {
                X = x,
                Y = 0f,
                Z = z,
                ChunkX = cx,
                ChunkZ = cz,
                Far = false,
            });
        }

        // Far: offset chunks outside Moore of spawn interest
        var farBase = Aoi.FarChunkOffset * Movement.ChunkSizeMeters;
        for (var i = 0; i < Aoi.CrowdFarCount; i++)
        {
            var x = farBase + (i % 4) * 2f;
            var z = farBase + (i / 4) * 2f;
            Movement.ChunkCoords(x, z, out var cx, out var cz);
            ctx.Db.CrowdProxy.Insert(new CrowdProxy
            {
                X = x,
                Y = 0f,
                Z = z,
                ChunkX = cx,
                ChunkZ = cz,
                Far = true,
            });
        }
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

    [SpacetimeDB.Reducer]
    public static void Cast(ReducerContext ctx, int spellId)
    {
        if (!Combat.TryGetSpell(spellId, out var castMs, out var damage))
        {
            throw new Exception("Unknown spell");
        }

        var character = ctx.Db.Character.Identity.Find(ctx.Sender)
            ?? throw new Exception("Character missing");
        if (spellId == Combat.SpellSpark && !character.KnowsSpark)
        {
            throw new Exception("Spark unknown");
        }

        if (spellId == Combat.SpellEmberbolt && !character.KnowsEmberbolt)
        {
            throw new Exception("Emberbolt unknown");
        }

        if (!character.StaffEquipped)
        {
            throw new Exception("Staff required");
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

    static void EnsureCharacter(ReducerContext ctx, Identity id)
    {
        if (ctx.Db.Character.Identity.Find(id) is not null)
        {
            return;
        }

        ctx.Db.Character.Insert(new Character
        {
            Identity = id,
            Xp = 0,
            KnowsSpark = true,
            KnowsEmberbolt = true,
            StaffEquipped = true,
            RobesEquipped = true,
        });
    }

    static void EnsureSession(ReducerContext ctx, Identity id)
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
                InterestChunkX = cx,
                InterestChunkZ = cz,
            });
        }

        if (ctx.Db.PlayerCombat.Identity.Find(id) is null)
        {
            ctx.Db.PlayerCombat.Insert(new PlayerCombat
            {
                Identity = id,
                TargetNpcId = 0,
                GcdReadyAt = ctx.Timestamp,
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

        if (row.Hp == 0 && ctx.Db.Character.Identity.Find(caster) is { } character)
        {
            character.Xp += Combat.XpPerKill;
            ctx.Db.Character.Identity.Update(character);
            Log.Info($"Dummy killed by {caster}, xp={character.Xp}");
        }
    }

    static TimeDuration Ms(int ms) => new() { Microseconds = ms * 1000L };
}
