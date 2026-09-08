using Fardel.Shared;
using SpacetimeDB;

#pragma warning disable STDB_UNSTABLE

public static partial class Module
{
    public const int NpcKindDummy = Combat.NpcKindDummy;
    public const int NpcKindHostile = Combat.NpcKindHostile;

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
        /// <summary>Vertical velocity (meters/second upward). Gravity applied each Move.</summary>
        [SpacetimeDB.Default(0f)]
        public float VelY;
        /// <summary>Server Timestamp when player was last grounded (for coyote time).</summary>
        [SpacetimeDB.Default(0)]
        public long LastGroundedMicros;
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

    /// <summary>
    /// Session-scoped party roster (ADR 0001 always-relevant hook).
    /// Removed on ClientDisconnected — parties are not durable across disconnect.
    /// </summary>
    [SpacetimeDB.Table(Accessor = "PartyMember", Public = true)]
    public partial struct PartyMember
    {
        [SpacetimeDB.PrimaryKey]
        public Identity Identity;
        [SpacetimeDB.Index.BTree]
        public ulong PartyId;
        public bool IsLeader;
    }

    /// <summary>Pending invite keyed by invitee (one outstanding invite at a time).</summary>
    [SpacetimeDB.Table(Accessor = "PartyInvite", Public = true)]
    public partial struct PartyInvite
    {
        [SpacetimeDB.PrimaryKey]
        public Identity Invitee;
        public ulong PartyId;
        public Identity Inviter;
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
        /// <summary>Bag flag — set when picking up ember_shard WorldLoot.</summary>
        public bool HasEmberShard;
        /// <summary>Bag flag — yard_tonic bought via BuyYardTonic; consumed by UseYardTonic.</summary>
        [SpacetimeDB.Default(false)]
        public bool HasYardTonic;
        /// <summary>Move-speed buff expiry (UseYardTonic). Inactive when &lt;= now.</summary>
        public Timestamp TonicExpiresAt;
        /// <summary>Bag flag — yard_bandage bought via BuyYardBandage; consumed by UseBandage.</summary>
        [SpacetimeDB.Default(false)]
        public bool HasYardBandage;
        /// <summary>Earliest time UseBandage may succeed again (own CD, distinct from RestReadyAt).</summary>
        public Timestamp BandageReadyAt;
        /// <summary>Player hit points (dummy thorns / future PvE). Hp≤0 = dead until respawn.</summary>
        [SpacetimeDB.Default(100)]
        public int Hp;
        [SpacetimeDB.Default(100)]
        public int MaxHp;
        /// <summary>Persisted level (high-water from cumulative XP). Party/self share the same number.</summary>
        [SpacetimeDB.Default(1)]
        public int Level;
        /// <summary>Last time ApplyPlayerDamage hit this character (0 = never). Gates Rest.</summary>
        public Timestamp LastDamagedAt;
        /// <summary>Earliest time Rest may succeed again (cooldown after heal).</summary>
        public Timestamp RestReadyAt;
        /// <summary>Spell resource pool (Spark/Emberbolt spend; Rest + lazy regen refill).</summary>
        [SpacetimeDB.Default(100)]
        public int Mana;
        [SpacetimeDB.Default(100)]
        public int MaxMana;
        /// <summary>Last lazy mana-regen tick (Cast/Rest). 0 = never.</summary>
        public Timestamp LastManaTickAt;
    }

    [SpacetimeDB.Table(Accessor = "PlayerCombat", Public = true)]
    public partial struct PlayerCombat
    {
        [SpacetimeDB.PrimaryKey]
        public Identity Identity;
        public ulong TargetNpcId;
        public Timestamp GcdReadyAt;
        /// <summary>Non-zero while a windup cast (e.g. Emberbolt) is pending — remotes read this.</summary>
        public int CastingSpellId;
        public Timestamp CastEndsAt;
        /// <summary>Last spell that actually fired (instant Cast or ResolveCast) for remote flash.</summary>
        public int LastSpellId;
        public Timestamp LastCastAt;
        /// <summary>Pushbacks applied to the current windup; resets on cast start / clear.</summary>
        [SpacetimeDB.Default(0)]
        public int CastPushbackCount;
        /// <summary>Cast rejects with "silenced" while Timestamp &lt; this (hard-interrupt lockout).</summary>
        public Timestamp CastLockedUntil;
        /// <summary>Move/Cast reject with "stunned" while now &lt; this micros (Stun/Bash hard-CC). Distinct from CastLockedUntil.</summary>
        [SpacetimeDB.Default(0)]
        public long StunnedUntilMicros;
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
        /// <summary>Home pad. Hostiles leash back here (#355). Dummy unused.</summary>
        [SpacetimeDB.Default(0f)]
        public float SpawnX;
        [SpacetimeDB.Default(0f)]
        public float SpawnY;
        [SpacetimeDB.Default(0f)]
        public float SpawnZ;
        /// <summary>True while chasing a living player. Cleared on leash / no prey.</summary>
        [SpacetimeDB.Default(false)]
        public bool Aggroed;
        /// <summary>Next auto-attack eligible at this unix micros. 0 = swing on first melee (#356).</summary>
        [SpacetimeDB.Default(0)]
        public long NextSwingAtMicros;
    }

    /// <summary>Ground loot in the yard — SeedLoot / dummy death inserts; Pickup despawns.</summary>
    [SpacetimeDB.Table(Accessor = "WorldLoot", Public = true)]
    public partial struct WorldLoot
    {
        [SpacetimeDB.PrimaryKey, SpacetimeDB.AutoInc]
        public ulong LootId;
        public float X;
        public float Y;
        public float Z;
        /// <summary>Item id string, e.g. ember_shard (Fardel.Shared.Loot).</summary>
        public string ItemId;
    }


    /// <summary>Pending player trade — one outstanding offer per recipient (To).</summary>
    [SpacetimeDB.Table(Accessor = "TradeOffer", Public = true)]
    public partial struct TradeOffer
    {
        [SpacetimeDB.PrimaryKey]
        public Identity To;
        public Identity From;
        /// <summary>When true, Accept transfers Character.HasEmberShard From→To.</summary>
        public bool OfferedHasEmberShard;
        /// <summary>When > 0, Accept transfers this much Character.Xp From→To.</summary>
        public int OfferedXp;
    }


    /// <summary>Stationary yard vendor — seeded on connect; Buy/Sell ember shard for XP.</summary>
    [SpacetimeDB.Table(Accessor = "YardVendor", Public = true)]
    public partial struct YardVendor
    {
        [SpacetimeDB.PrimaryKey, SpacetimeDB.AutoInc]
        public ulong VendorId;
        public float X;
        public float Y;
        public float Z;
        public string Label;
    }

    /// <summary>Public yard chat — Say reducer inserts; clients wholesale-subscribe.</summary>
    [SpacetimeDB.Table(Accessor = "ChatMessage", Public = true)]
    public partial struct ChatMessage
    {
        [SpacetimeDB.PrimaryKey, SpacetimeDB.AutoInc]
        public ulong MessageId;
        public Identity Sender;
        public string Text;
        public Timestamp SentAt;
    }

    /// <summary>
    /// Party channel — PartySay inserts; RLS ClientVisibilityFilter keeps
    /// rows visible only to current PartyMember mates (ADR invent).
    /// </summary>
    [SpacetimeDB.Table(Accessor = "PartyChatMessage", Public = true)]
    public partial struct PartyChatMessage
    {
        [SpacetimeDB.PrimaryKey, SpacetimeDB.AutoInc]
        public ulong MessageId;
        [SpacetimeDB.Index.BTree]
        public ulong PartyId;
        public Identity Sender;
        public string Text;
        public Timestamp SentAt;
    }

    /// <summary>Only party mates see PartyChatMessage rows (join on party_id).</summary>
    [SpacetimeDB.ClientVisibilityFilter]
    public static readonly Filter PartyChatVisibleToMates = new Filter.Sql(
        "SELECT pcm.* FROM party_chat_message pcm " +
        "JOIN party_member pm ON pm.party_id = pcm.party_id " +
        "WHERE pm.identity = :sender"
    );

    /// <summary>
    /// Private whisper — Whisper reducer inserts; RLS keeps rows visible only to
    /// sender and recipient identities.
    /// </summary>
    [SpacetimeDB.Table(Accessor = "WhisperMessage", Public = true)]
    public partial struct WhisperMessage
    {
        [SpacetimeDB.PrimaryKey, SpacetimeDB.AutoInc]
        public ulong MessageId;
        [SpacetimeDB.Index.BTree]
        public Identity Sender;
        [SpacetimeDB.Index.BTree]
        public Identity Recipient;
        public string Text;
        public Timestamp SentAt;
    }

    /// <summary>Only sender and recipient see WhisperMessage rows.</summary>
    [SpacetimeDB.ClientVisibilityFilter]
    public static readonly Filter WhisperVisibleToParticipants = new Filter.Sql(
        "SELECT * FROM whisper_message WHERE sender = :sender OR recipient = :sender"
    );

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

    /// <summary>Player death → short delay → yard-origin respawn with full HP.</summary>
    [SpacetimeDB.Table(Accessor = "PendingPlayerRespawn", Scheduled = nameof(ResolvePlayerRespawn), ScheduledAt = nameof(ScheduledAt))]
    public partial struct PendingPlayerRespawn
    {
        [SpacetimeDB.PrimaryKey, SpacetimeDB.AutoInc]
        public ulong ScheduleId;
        public ScheduleAt ScheduledAt;
        public Identity Player;
    }

    /// <summary>#355 — repeating proximity aggro / leash tick. Not public (clients watch Npc XZ).</summary>
    [SpacetimeDB.Table(Accessor = "PendingHostileTick", Scheduled = nameof(TickHostiles), ScheduledAt = nameof(ScheduledAt))]
    public partial struct PendingHostileTick
    {
        [SpacetimeDB.PrimaryKey, SpacetimeDB.AutoInc]
        public ulong ScheduleId;
        public ScheduleAt ScheduledAt;
    }

    [SpacetimeDB.Reducer(ReducerKind.ClientConnected)]
    public static void ClientConnected(ReducerContext ctx)
    {
        Log.Info($"Client connected: {ctx.Sender}");
        EnsureDummy(ctx);
        EnsureHostiles(ctx);
        EnsureHostileTicker(ctx);
        EnsureVendor(ctx);
        EnsureCharacter(ctx, ctx.Sender);
        EnsureSession(ctx, ctx.Sender);
        // Sync Level for pre-schema rows (Default 1) that already hold XP.
        if (ctx.Db.Character.Identity.Find(ctx.Sender) is { } connectedChar)
        {
            var before = connectedChar.Level;
            SyncLevelFromXp(ref connectedChar);
            if (connectedChar.Level != before)
            {
                ctx.Db.Character.Identity.Update(connectedChar);
            }
        }
    }

    [SpacetimeDB.Reducer(ReducerKind.ClientDisconnected)]
    public static void ClientDisconnected(ReducerContext ctx)
    {
        Log.Info($"Client disconnected: {ctx.Sender}");
        // Character row is durable — do not delete.
        // PartyMember / PartyInvite are session-scoped — clear on disconnect (ADR 0001 invent).
        if (ctx.Db.PlayerPose.Identity.Find(ctx.Sender) is { } pose)
        {
            ctx.Db.PlayerPose.Identity.Delete(pose.Identity);
        }

        if (ctx.Db.PlayerCombat.Identity.Find(ctx.Sender) is { } combat)
        {
            ctx.Db.PlayerCombat.Identity.Delete(combat.Identity);
        }

        ClearPartyStateFor(ctx, ctx.Sender);
        ClearTradeStateFor(ctx, ctx.Sender);
    }

    [SpacetimeDB.Reducer]
    public static void Move(ReducerContext ctx, float dx, float dz, bool jump = false)
    {
        var pose = ctx.Db.PlayerPose.Identity.Find(ctx.Sender)
            ?? throw new Exception("PlayerPose missing");
        var mover = ctx.Db.Character.Identity.Find(ctx.Sender)
            ?? throw new Exception("Character missing");
        if (mover.Hp <= 0)
        {
            throw new Exception("Dead");
        }
        if (ctx.Db.PlayerCombat.Identity.Find(ctx.Sender) is { } moveCombat
            && ctx.Timestamp.MicrosecondsSinceUnixEpoch < moveCombat.StunnedUntilMicros)
        {
            throw new Exception("stunned");
        }
        var maxStep = Movement.MaxStepMeters;
        if (ctx.Timestamp < mover.TonicExpiresAt)
        {
            maxStep *= Tonic.MoveSpeedMult;
        }
        Movement.ClampWishStep(ref dx, ref dz, maxStep);
        Movement.ApplyAirControl(ref dx, ref dz, pose.Y);
        var x = pose.X + dx;
        var z = pose.Z + dz;

        // Vertical physics: gravity + jump intent
        var nowMicros = ctx.Timestamp.MicrosecondsSinceUnixEpoch;
        var dtSeconds = 0.05f; // Approximate time step between Move calls (~20Hz client sends)
        var velY = pose.VelY;
        var y = pose.Y;
        var lastGroundedMicros = pose.LastGroundedMicros;

        // Apply gravity
        velY += Movement.Gravity * dtSeconds;

        // Jump intent: grounded or coyote. No pre-land buffer (#259): coyote covers
        // the next grounded Move (~20Hz ≤ 50ms). A stored intent would bunny-hop
        // hold-Space land (JumpSmoke #157). velY<=0.01 blocks mid-air / same-tick re-boost.
        var grounded = y <= Movement.GroundY + 0.01f;
        var coyoteAllowed = (nowMicros - lastGroundedMicros) <= Movement.CoyoteTimeMicros;
        if (jump && (grounded || coyoteAllowed) && velY <= 0.01f)
        {
            velY = Movement.JumpVelocity;
        }

        // Update Y position
        y += velY * dtSeconds;

        // Ground clamp
        if (y <= Movement.GroundY)
        {
            y = Movement.GroundY;
            velY = 0f;
            lastGroundedMicros = nowMicros;
        }

        Movement.ChunkCoords(x, z, out var cx, out var cz);
        pose.X = x;
        pose.Y = y;
        pose.Z = z;
        pose.VelY = velY;
        pose.LastGroundedMicros = lastGroundedMicros;
        pose.ChunkX = cx;
        pose.ChunkZ = cz;
        var ix = pose.InterestChunkX;
        var iz = pose.InterestChunkZ;
        Aoi.UpdateInterest(x, z, cx, cz, ref ix, ref iz);
        pose.InterestChunkX = ix;
        pose.InterestChunkZ = iz;
        ctx.Db.PlayerPose.Identity.Update(pose);

        // Move interrupts windup casts (Emberbolt): cancel schedule + refund mana.
        if (System.Math.Abs(dx) > 1e-6f || System.Math.Abs(dz) > 1e-6f)
        {
            InterruptWindupCast(ctx, ctx.Sender, refundMana: true);
        }
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
        if (character.Hp <= 0)
        {
            throw new Exception("Dead");
        }
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

        var combatGate = ctx.Db.PlayerCombat.Identity.Find(ctx.Sender)
            ?? throw new Exception("PlayerCombat missing");
        if (ctx.Timestamp.MicrosecondsSinceUnixEpoch < combatGate.StunnedUntilMicros)
        {
            throw new Exception("stunned");
        }
        if (ctx.Timestamp < combatGate.CastLockedUntil)
        {
            throw new Exception("silenced");
        }

        var combat = ctx.Db.PlayerCombat.Identity.Find(ctx.Sender)
            ?? throw new Exception("PlayerCombat missing");

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

        // Horizontal (XZ) cast range — same pattern as Trade/Loot/Vendor.
        var pose = ctx.Db.PlayerPose.Identity.Find(ctx.Sender)
            ?? throw new Exception("PlayerPose missing");
        {
            var dx = pose.X - npc.X;
            var dz = pose.Z - npc.Z;
            var range = Combat.CastRangeMeters;
            if (dx * dx + dz * dz > range * range)
            {
                throw new Exception("out of range");
            }
        }

        TickManaRegen(ctx, ref character);
        var manaCost = Combat.ManaCost(spellId);
        if (manaCost > 0 && character.Mana < manaCost)
        {
            ctx.Db.Character.Identity.Update(character);
            throw new Exception("Insufficient mana");
        }
        if (manaCost > 0)
        {
            character.Mana -= manaCost;
        }
        ctx.Db.Character.Identity.Update(character);

        if (ctx.Timestamp < combat.GcdReadyAt)
        {
            throw new Exception("GCD");
        }

        combat.GcdReadyAt = ctx.Timestamp + Ms(Combat.GcdMs);

        if (castMs <= 0)
        {
            combat.CastingSpellId = 0;
            combat.LastSpellId = spellId;
            combat.LastCastAt = ctx.Timestamp;
            ctx.Db.PlayerCombat.Identity.Update(combat);
            ApplyDamage(ctx, ctx.Sender, npc.NpcId, damage);
            return;
        }

        combat.CastingSpellId = spellId;
        combat.CastEndsAt = ctx.Timestamp + Ms(castMs);
        combat.CastPushbackCount = 0;
        ctx.Db.PlayerCombat.Identity.Update(combat);

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

        // Interrupted / CancelCast / death cleared CastingSpellId — skip damage.
        if (ctx.Db.PlayerCombat.Identity.Find(cast.Caster) is not { } combat
            || combat.CastingSpellId != cast.SpellId)
        {
            return;
        }

        combat.CastingSpellId = 0;
        combat.CastPushbackCount = 0;
        combat.LastSpellId = cast.SpellId;
        combat.LastCastAt = ctx.Timestamp;
        ctx.Db.PlayerCombat.Identity.Update(combat);

        ApplyDamage(ctx, cast.Caster, cast.TargetNpcId, damage);
    }

    /// <summary>
    /// Explicit cast cancel (Escape). Deletes PendingCast schedule, clears windup,
    /// refunds mana spent at Cast start. No-op if not casting.
    /// </summary>
    [SpacetimeDB.Reducer]
    public static void CancelCast(ReducerContext ctx)
    {
        InterruptWindupCast(ctx, ctx.Sender, refundMana: true);
    }

    /// <summary>
    /// Training-dummy thorns poke (opt-in). Applies DummyThornsDamage to the
    /// caller. Mid-windup: pushback CastEndsAt, or hard-interrupt (no refund +
    /// CastLockedUntil silence for CastSilenceMs) after CastPushbackHardAfter /
    /// when remaining &lt; CastHardInterruptRemainMs.
    /// CombatSmoke / ManaSmoke do not call this.
    /// </summary>
    [SpacetimeDB.Reducer]
    public static void DummyStrike(ReducerContext ctx)
    {
        Npc? dummy = null;
        foreach (var n in ctx.Db.Npc.Iter())
        {
            if (n.Kind == NpcKindDummy)
            {
                dummy = n;
                break;
            }
        }
        if (dummy is null)
        {
            throw new Exception("No dummy");
        }
        if (dummy.Value.Hp <= 0)
        {
            throw new Exception("Dummy dead");
        }

        ApplyPlayerDamage(ctx, ctx.Sender, Combat.DummyThornsDamage);
    }

    /// <summary>
    /// Kick / Counterspell — hard-interrupt a nearby caster's windup and apply
    /// CastLockedUntil silence (same path as DummyStrike hard interrupt, without
    /// the pushback chain). Instant; spends KickManaCost + shared GCD.
    /// </summary>
    [SpacetimeDB.Reducer]
    public static void Kick(ReducerContext ctx, Identity target)
    {
        if (target.Equals(ctx.Sender))
        {
            throw new Exception("Cannot kick self");
        }

        var selfChar = ctx.Db.Character.Identity.Find(ctx.Sender)
            ?? throw new Exception("Character missing");
        if (selfChar.Hp <= 0)
        {
            throw new Exception("Dead");
        }

        if (ctx.Db.Character.Identity.Find(target) is null)
        {
            throw new Exception("Target missing");
        }
        if (ctx.Db.PlayerPose.Identity.Find(target) is null)
        {
            throw new Exception("Target not online");
        }

        var selfPose = ctx.Db.PlayerPose.Identity.Find(ctx.Sender)
            ?? throw new Exception("PlayerPose missing");
        var targetPose = ctx.Db.PlayerPose.Identity.Find(target)
            ?? throw new Exception("Target not online");
        {
            var dx = selfPose.X - targetPose.X;
            var dz = selfPose.Z - targetPose.Z;
            var range = Combat.KickRangeMeters;
            if (dx * dx + dz * dz > range * range)
            {
                throw new Exception("Out of range");
            }
        }

        var selfCombat = ctx.Db.PlayerCombat.Identity.Find(ctx.Sender)
            ?? throw new Exception("PlayerCombat missing");
        if (ctx.Timestamp < selfCombat.GcdReadyAt)
        {
            throw new Exception("GCD");
        }
        if (ctx.Timestamp.MicrosecondsSinceUnixEpoch < selfCombat.StunnedUntilMicros)
        {
            throw new Exception("stunned");
        }
        if (ctx.Timestamp < selfCombat.CastLockedUntil)
        {
            throw new Exception("silenced");
        }
        if (selfCombat.CastingSpellId != 0)
        {
            throw new Exception("Busy casting");
        }

        var targetCombat = ctx.Db.PlayerCombat.Identity.Find(target)
            ?? throw new Exception("Target combat missing");
        if (targetCombat.CastingSpellId == 0)
        {
            throw new Exception("Target not casting");
        }

        TickManaRegen(ctx, ref selfChar);
        if (Combat.KickManaCost > 0 && selfChar.Mana < Combat.KickManaCost)
        {
            ctx.Db.Character.Identity.Update(selfChar);
            throw new Exception("Insufficient mana");
        }
        if (Combat.KickManaCost > 0)
        {
            selfChar.Mana -= Combat.KickManaCost;
        }
        ctx.Db.Character.Identity.Update(selfChar);

        selfCombat.GcdReadyAt = ctx.Timestamp + Ms(Combat.GcdMs);
        selfCombat.LastSpellId = 0;
        selfCombat.LastCastAt = ctx.Timestamp;
        ctx.Db.PlayerCombat.Identity.Update(selfCombat);

        Log.Info(
            $"Kick {ctx.Sender} → {target} spell={targetCombat.CastingSpellId} " +
            $"(hard interrupt + silence {Combat.CastSilenceMs}ms)");
        InterruptWindupCast(ctx, target, refundMana: false);
    }

    /// <summary>
    /// Stun / Bash — short hard-CC on a nearby player. Breaks windup without
    /// CastLockedUntil silence; sets StunnedUntil so Move/Cast reject with
    /// "stunned" for StunDurationMs. Instant; spends StunManaCost + shared GCD.
    /// </summary>
    [SpacetimeDB.Reducer]
    public static void Stun(ReducerContext ctx, Identity target)
    {
        if (target.Equals(ctx.Sender))
        {
            throw new Exception("Cannot stun self");
        }

        var selfChar = ctx.Db.Character.Identity.Find(ctx.Sender)
            ?? throw new Exception("Character missing");
        if (selfChar.Hp <= 0)
        {
            throw new Exception("Dead");
        }

        if (ctx.Db.Character.Identity.Find(target) is null)
        {
            throw new Exception("Target missing");
        }
        if (ctx.Db.PlayerPose.Identity.Find(target) is null)
        {
            throw new Exception("Target not online");
        }

        var selfPose = ctx.Db.PlayerPose.Identity.Find(ctx.Sender)
            ?? throw new Exception("PlayerPose missing");
        var targetPose = ctx.Db.PlayerPose.Identity.Find(target)
            ?? throw new Exception("Target not online");
        {
            var dx = selfPose.X - targetPose.X;
            var dz = selfPose.Z - targetPose.Z;
            var range = Combat.StunRangeMeters;
            if (dx * dx + dz * dz > range * range)
            {
                throw new Exception("Out of range");
            }
        }

        var selfCombat = ctx.Db.PlayerCombat.Identity.Find(ctx.Sender)
            ?? throw new Exception("PlayerCombat missing");
        if (ctx.Timestamp < selfCombat.GcdReadyAt)
        {
            throw new Exception("GCD");
        }
        if (ctx.Timestamp.MicrosecondsSinceUnixEpoch < selfCombat.StunnedUntilMicros)
        {
            throw new Exception("stunned");
        }
        if (ctx.Timestamp < selfCombat.CastLockedUntil)
        {
            throw new Exception("silenced");
        }
        if (selfCombat.CastingSpellId != 0)
        {
            throw new Exception("Busy casting");
        }

        var targetCombat = ctx.Db.PlayerCombat.Identity.Find(target)
            ?? throw new Exception("Target combat missing");

        TickManaRegen(ctx, ref selfChar);
        if (Combat.StunManaCost > 0 && selfChar.Mana < Combat.StunManaCost)
        {
            ctx.Db.Character.Identity.Update(selfChar);
            throw new Exception("Insufficient mana");
        }
        if (Combat.StunManaCost > 0)
        {
            selfChar.Mana -= Combat.StunManaCost;
        }
        ctx.Db.Character.Identity.Update(selfChar);

        selfCombat.GcdReadyAt = ctx.Timestamp + Ms(Combat.GcdMs);
        selfCombat.LastSpellId = 0;
        selfCombat.LastCastAt = ctx.Timestamp;
        ctx.Db.PlayerCombat.Identity.Update(selfCombat);

        // Break windup if any — no CastLockedUntil silence (distinct lockout).
        if (targetCombat.CastingSpellId != 0)
        {
            Log.Info(
                $"Stun {ctx.Sender} → {target} spell={targetCombat.CastingSpellId} " +
                $"(hard-CC windup break, no silence; stun {Combat.StunDurationMs}ms)");
            InterruptWindupCast(ctx, target, refundMana: false, applySilence: false);
        }
        else
        {
            Log.Info(
                $"Stun {ctx.Sender} → {target} (hard-CC; stun {Combat.StunDurationMs}ms)");
        }

        // Re-fetch after possible interrupt update.
        targetCombat = ctx.Db.PlayerCombat.Identity.Find(target)
            ?? throw new Exception("Target combat missing");
        targetCombat.StunnedUntilMicros = ctx.Timestamp.MicrosecondsSinceUnixEpoch
            + (long)Combat.StunDurationMs * 1000L;
        ctx.Db.PlayerCombat.Identity.Update(targetCombat);
    }

    /// <summary>Unequip staff — Cast already gates on StaffEquipped (slice 3 nice-to-have).</summary>
    [SpacetimeDB.Reducer]
    public static void UnequipStaff(ReducerContext ctx)
    {
        var character = ctx.Db.Character.Identity.Find(ctx.Sender)
            ?? throw new Exception("Character missing");
        if (!character.StaffEquipped)
        {
            return;
        }

        character.StaffEquipped = false;
        ctx.Db.Character.Identity.Update(character);
    }

    /// <summary>Equip staff — restores Cast permission when known spells are present.</summary>
    [SpacetimeDB.Reducer]
    public static void EquipStaff(ReducerContext ctx)
    {
        var character = ctx.Db.Character.Identity.Find(ctx.Sender)
            ?? throw new Exception("Character missing");
        if (character.StaffEquipped)
        {
            return;
        }

        character.StaffEquipped = true;
        ctx.Db.Character.Identity.Update(character);
    }

    /// <summary>Unequip robes — presentation + Character.RobesEquipped (cosmetic; casts still staff-gated).</summary>
    [SpacetimeDB.Reducer]
    public static void UnequipRobes(ReducerContext ctx)
    {
        var character = ctx.Db.Character.Identity.Find(ctx.Sender)
            ?? throw new Exception("Character missing");
        if (!character.RobesEquipped)
        {
            return;
        }

        character.RobesEquipped = false;
        ctx.Db.Character.Identity.Update(character);
    }

    /// <summary>Equip robes — restores wizard-robe silhouette on the client.</summary>
    [SpacetimeDB.Reducer]
    public static void EquipRobes(ReducerContext ctx)
    {
        var character = ctx.Db.Character.Identity.Find(ctx.Sender)
            ?? throw new Exception("Character missing");
        if (character.RobesEquipped)
        {
            return;
        }

        character.RobesEquipped = true;
        ctx.Db.Character.Identity.Update(character);
    }

    /// <summary>Create a party with sender as sole leader. No-op if already in a party.</summary>
    [SpacetimeDB.Reducer]
    public static void CreateParty(ReducerContext ctx)
    {
        if (ctx.Db.PartyMember.Identity.Find(ctx.Sender) is not null)
        {
            throw new Exception("Already in a party");
        }

        // PartyId = leader identity hash mixed with timestamp micros (stable unique-ish without AutoInc table).
        var partyId = PartyIdFrom(ctx.Sender, ctx.Timestamp);
        ctx.Db.PartyMember.Insert(new PartyMember
        {
            Identity = ctx.Sender,
            PartyId = partyId,
            IsLeader = true,
        });
        Log.Info($"Party {partyId} created by {ctx.Sender}");
    }

    /// <summary>Invite another online identity into the sender's party (creates party if needed).</summary>
    [SpacetimeDB.Reducer]
    public static void InviteToParty(ReducerContext ctx, Identity invitee)
    {
        if (invitee == ctx.Sender)
        {
            throw new Exception("Cannot invite self");
        }

        if (ctx.Db.PlayerPose.Identity.Find(invitee) is null)
        {
            throw new Exception("Invitee not online");
        }

        if (ctx.Db.PartyMember.Identity.Find(invitee) is not null)
        {
            throw new Exception("Invitee already in a party");
        }

        ulong partyId;
        if (ctx.Db.PartyMember.Identity.Find(ctx.Sender) is { } self)
        {
            if (!self.IsLeader)
            {
                throw new Exception("Only leader can invite");
            }
            partyId = self.PartyId;
        }
        else
        {
            partyId = PartyIdFrom(ctx.Sender, ctx.Timestamp);
            ctx.Db.PartyMember.Insert(new PartyMember
            {
                Identity = ctx.Sender,
                PartyId = partyId,
                IsLeader = true,
            });
        }

        if (ctx.Db.PartyInvite.Invitee.Find(invitee) is { } existing)
        {
            ctx.Db.PartyInvite.Invitee.Delete(existing.Invitee);
        }

        ctx.Db.PartyInvite.Insert(new PartyInvite
        {
            Invitee = invitee,
            PartyId = partyId,
            Inviter = ctx.Sender,
        });
        Log.Info($"Party {partyId}: {ctx.Sender} invited {invitee}");
    }

    /// <summary>Accept the outstanding invite for sender.</summary>
    [SpacetimeDB.Reducer]
    public static void AcceptPartyInvite(ReducerContext ctx)
    {
        if (ctx.Db.PartyMember.Identity.Find(ctx.Sender) is not null)
        {
            throw new Exception("Already in a party");
        }

        var invite = ctx.Db.PartyInvite.Invitee.Find(ctx.Sender)
            ?? throw new Exception("No pending invite");

        // Ensure party still exists (leader still online / in party).
        var leaderAlive = false;
        foreach (var m in ctx.Db.PartyMember.Iter())
        {
            if (m.PartyId == invite.PartyId)
            {
                leaderAlive = true;
                break;
            }
        }
        if (!leaderAlive)
        {
            ctx.Db.PartyInvite.Invitee.Delete(invite.Invitee);
            throw new Exception("Party no longer exists");
        }

        ctx.Db.PartyInvite.Invitee.Delete(invite.Invitee);
        ctx.Db.PartyMember.Insert(new PartyMember
        {
            Identity = ctx.Sender,
            PartyId = invite.PartyId,
            IsLeader = false,
        });
        Log.Info($"Party {invite.PartyId}: {ctx.Sender} joined");
    }

    /// <summary>Leave current party. If leader leaves, promote another member or dissolve.</summary>
    [SpacetimeDB.Reducer]
    public static void LeaveParty(ReducerContext ctx)
    {
        var self = ctx.Db.PartyMember.Identity.Find(ctx.Sender)
            ?? throw new Exception("Not in a party");

        var partyId = self.PartyId;
        var wasLeader = self.IsLeader;
        ctx.Db.PartyMember.Identity.Delete(self.Identity);

        // Drop invites targeting sender.
        if (ctx.Db.PartyInvite.Invitee.Find(ctx.Sender) is { } inv)
        {
            ctx.Db.PartyInvite.Invitee.Delete(inv.Invitee);
        }

        // Collect remaining members without mutating while iterating.
        var remaining = new System.Collections.Generic.List<PartyMember>();
        foreach (var m in ctx.Db.PartyMember.Iter())
        {
            if (m.PartyId == partyId)
            {
                remaining.Add(m);
            }
        }

        if (remaining.Count == 0)
        {
            // Dissolve: clear invites for this party.
            var invites = new System.Collections.Generic.List<Identity>();
            foreach (var i in ctx.Db.PartyInvite.Iter())
            {
                if (i.PartyId == partyId)
                {
                    invites.Add(i.Invitee);
                }
            }
            foreach (var id in invites)
            {
                ctx.Db.PartyInvite.Invitee.Delete(id);
            }
            Log.Info($"Party {partyId} dissolved");
            return;
        }

        if (wasLeader)
        {
            var next = remaining[0];
            next.IsLeader = true;
            ctx.Db.PartyMember.Identity.Update(next);
            Log.Info($"Party {partyId}: promoted {next.Identity}");
        }
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


    /// <summary>
    /// Grant XP and raise persisted Level when cumulative thresholds are crossed.
    /// Level is high-water (XP spent as currency does not de-level).
    /// </summary>
    static void AddCharacterXp(ref Character ch, int amount)
    {
        if (amount == 0)
        {
            return;
        }

        ch.Xp += amount;
        if (ch.Xp < 0)
        {
            ch.Xp = 0;
        }

        SyncLevelFromXp(ref ch);
    }

    static void SyncLevelFromXp(ref Character ch)
    {
        var computed = Progression.LevelFromXp(ch.Xp);
        if (computed > ch.Level)
        {
            ch.Level = computed;
        }

        if (ch.Level < 1)
        {
            ch.Level = 1;
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
            Level = 1,
            KnowsSpark = true,
            KnowsEmberbolt = true,
            StaffEquipped = true,
            RobesEquipped = true,
            HasEmberShard = false,
            HasYardTonic = false,
            TonicExpiresAt = ctx.Timestamp,
            HasYardBandage = false,
            BandageReadyAt = ctx.Timestamp,
            Hp = Combat.PlayerMaxHp,
            MaxHp = Combat.PlayerMaxHp,
            LastDamagedAt = default,
            RestReadyAt = ctx.Timestamp,
            Mana = Combat.PlayerMaxMana,
            MaxMana = Combat.PlayerMaxMana,
            LastManaTickAt = ctx.Timestamp,
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
                VelY = 0f,
                LastGroundedMicros = ctx.Timestamp.MicrosecondsSinceUnixEpoch,
            });
        }

        if (ctx.Db.PlayerCombat.Identity.Find(id) is null)
        {
            ctx.Db.PlayerCombat.Insert(new PlayerCombat
            {
                Identity = id,
                TargetNpcId = 0,
                GcdReadyAt = ctx.Timestamp,
                CastingSpellId = 0,
                CastEndsAt = ctx.Timestamp,
                LastSpellId = 0,
                LastCastAt = ctx.Timestamp,
                CastPushbackCount = 0,
                CastLockedUntil = ctx.Timestamp,
                StunnedUntilMicros = 0,
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

    static bool HasHostileForPad(ReducerContext ctx, float x, float z)
    {
        foreach (var n in ctx.Db.Npc.Iter())
        {
            if (n.Kind != NpcKindHostile)
            {
                continue;
            }
            var hx = MathF.Abs(n.SpawnX) > 0.01f || MathF.Abs(n.SpawnZ) > 0.01f ? n.SpawnX : n.X;
            var hz = MathF.Abs(n.SpawnX) > 0.01f || MathF.Abs(n.SpawnZ) > 0.01f ? n.SpawnZ : n.Z;
            var dx = hx - x;
            var dz = hz - z;
            if (dx * dx + dz * dz < 0.25f)
            {
                return true;
            }
        }
        return false;
    }

    static void InsertHostile(ReducerContext ctx, float x, float y, float z)
    {
        ctx.Db.Npc.Insert(new Npc
        {
            Kind = NpcKindHostile,
            X = x,
            Y = y,
            Z = z,
            Hp = Combat.HostileMaxHp,
            MaxHp = Combat.HostileMaxHp,
            SpawnX = x,
            SpawnY = y,
            SpawnZ = z,
            Aggroed = false,
        });
    }

    /// <summary>#354 — two yard hostiles (not origin, dummy stays trainer).</summary>
    static void EnsureHostiles(ReducerContext ctx)
    {
        if (!HasHostileForPad(ctx, Combat.HostileSpawnAx, Combat.HostileSpawnAz))
        {
            InsertHostile(ctx, Combat.HostileSpawnAx, Combat.HostileSpawnAy, Combat.HostileSpawnAz);
        }
        if (!HasHostileForPad(ctx, Combat.HostileSpawnBx, Combat.HostileSpawnBz))
        {
            InsertHostile(ctx, Combat.HostileSpawnBx, Combat.HostileSpawnBy, Combat.HostileSpawnBz);
        }

        var backfill = new System.Collections.Generic.List<Npc>();
        foreach (var n in ctx.Db.Npc.Iter())
        {
            if (n.Kind != NpcKindHostile)
            {
                continue;
            }
            if (MathF.Abs(n.SpawnX) > 0.01f || MathF.Abs(n.SpawnZ) > 0.01f)
            {
                continue;
            }
            var row = n;
            row.SpawnX = n.X;
            row.SpawnY = n.Y;
            row.SpawnZ = n.Z;
            backfill.Add(row);
        }
        foreach (var row in backfill)
        {
            ctx.Db.Npc.NpcId.Update(row);
        }
    }

    static void EnsureHostileTicker(ReducerContext ctx)
    {
        foreach (var _ in ctx.Db.PendingHostileTick.Iter())
        {
            return;
        }

        ctx.Db.PendingHostileTick.Insert(new PendingHostileTick
        {
            ScheduledAt = new ScheduleAt.Time(ctx.Timestamp + Ms(Combat.HostileTickMs)),
        });
    }

    /// <summary>#355 proximity aggro/leash + #356 melee auto-attack cadence.</summary>
    [SpacetimeDB.Reducer]
    public static void TickHostiles(ReducerContext ctx, PendingHostileTick job)
    {
        _ = job;
        StepHostiles(ctx);
        ctx.Db.PendingHostileTick.Insert(new PendingHostileTick
        {
            ScheduledAt = new ScheduleAt.Time(ctx.Timestamp + Ms(Combat.HostileTickMs)),
        });
    }

    static void StepHostiles(ReducerContext ctx)
    {
        var snapshot = new System.Collections.Generic.List<Npc>();
        foreach (var n in ctx.Db.Npc.Iter())
        {
            snapshot.Add(n);
        }

        foreach (var n in snapshot)
        {
            if (n.Kind != NpcKindHostile || n.Hp <= 0)
            {
                continue;
            }

            var row = n;
            if (MathF.Abs(row.SpawnX) < 0.01f && MathF.Abs(row.SpawnZ) < 0.01f)
            {
                row.SpawnX = row.X;
                row.SpawnY = row.Y;
                row.SpawnZ = row.Z;
            }

            var homeDx = row.X - row.SpawnX;
            var homeDz = row.Z - row.SpawnZ;
            var homeDist = MathF.Sqrt(homeDx * homeDx + homeDz * homeDz);
            var hasPrey = TryNearestLivingPlayer(ctx, row.X, row.Z, out var preyId, out var px, out var pz, out var preyDist);
            var overLeash = homeDist > Combat.HostileLeashRadius;

            if (row.Aggroed)
            {
                if (overLeash || !hasPrey)
                {
                    row.Aggroed = false;
                    row.NextSwingAtMicros = 0;
                    StepToward(ref row, row.SpawnX, row.SpawnZ, Combat.HostileStepMeters);
                }
                else
                {
                    StepToward(ref row, px, pz, Combat.HostileStepMeters);
                    MaybeHostileSwing(ctx, ref row, preyId, px, pz);
                }
            }
            else if (homeDist > 0.2f)
            {
                StepToward(ref row, row.SpawnX, row.SpawnZ, Combat.HostileStepMeters);
            }
            else if (hasPrey && preyDist <= Combat.HostileAggroRadius)
            {
                row.Aggroed = true;
                StepToward(ref row, px, pz, Combat.HostileStepMeters);
                MaybeHostileSwing(ctx, ref row, preyId, px, pz);
            }

            ctx.Db.Npc.NpcId.Update(row);
        }
    }

    static void MaybeHostileSwing(ReducerContext ctx, ref Npc row, Identity preyId, float px, float pz)
    {
        var dx = px - row.X;
        var dz = pz - row.Z;
        var d = MathF.Sqrt(dx * dx + dz * dz);
        if (d > Combat.HostileMeleeRange)
        {
            return;
        }

        var now = ctx.Timestamp.MicrosecondsSinceUnixEpoch;
        if (row.NextSwingAtMicros > 0 && now < row.NextSwingAtMicros)
        {
            return;
        }

        ApplyPlayerDamage(ctx, preyId, Combat.HostileAttackDamage);
        row.NextSwingAtMicros = now + (long)Combat.HostileAttackMs * 1000L;
    }

    static bool TryNearestLivingPlayer(
        ReducerContext ctx,
        float x,
        float z,
        out Identity id,
        out float px,
        out float pz,
        out float dist)
    {
        id = default;
        px = 0f;
        pz = 0f;
        dist = float.MaxValue;
        var found = false;
        foreach (var pose in ctx.Db.PlayerPose.Iter())
        {
            if (ctx.Db.Character.Identity.Find(pose.Identity) is not { Hp: > 0 })
            {
                continue;
            }

            var dx = pose.X - x;
            var dz = pose.Z - z;
            var d = MathF.Sqrt(dx * dx + dz * dz);
            if (d >= dist)
            {
                continue;
            }

            dist = d;
            id = pose.Identity;
            px = pose.X;
            pz = pose.Z;
            found = true;
        }

        return found;
    }

    static void StepToward(ref Npc n, float tx, float tz, float step)
    {
        var dx = tx - n.X;
        var dz = tz - n.Z;
        var len = MathF.Sqrt(dx * dx + dz * dz);
        if (len <= step || len <= 1e-4f)
        {
            n.X = tx;
            n.Z = tz;
            return;
        }

        n.X += dx / len * step;
        n.Z += dz / len * step;
    }

    static void ApplyDamage(ReducerContext ctx, Identity caster, ulong npcId, int damage)
    {
        if (ctx.Db.Npc.NpcId.Find(npcId) is not { } row || row.Hp <= 0)
        {
            return;
        }

        row.Hp = Math.Max(0, row.Hp - damage);
        if (row.Hp == 0)
        {
            row.Aggroed = false;
        }
        ctx.Db.Npc.NpcId.Update(row);

        if (row.Hp == 0 && ctx.Db.Character.Identity.Find(caster) is { } character)
        {
            AddCharacterXp(ref character, Combat.XpPerKill);
            ctx.Db.Character.Identity.Update(character);
            Log.Info($"Npc {row.NpcId} kind={row.Kind} killed by {caster}, xp={character.Xp} level={character.Level}");
            SharePartyKillXp(ctx, caster);
            // Dummy + hostiles both drop ember_shard WorldLoot. Pickup is F. (#357)
            SpawnEmberShardAt(ctx, row.X + Loot.DeathDropOffsetX, row.Y + Loot.SeedY, row.Z + Loot.DeathDropOffsetZ);
            SharePartyLootDrop(ctx, caster, row.X, row.Y, row.Z);
        }

        // Dummy thorns only — hostiles hit back in #356, not here.
        if (row.Kind == NpcKindDummy)
        {
            ApplyPlayerDamage(ctx, caster, Combat.DummyThornsDamage);
        }
    }

    /// <summary>Subtract player HP; on Hp≤0 clear target and schedule yard respawn.</summary>
    static void ApplyPlayerDamage(ReducerContext ctx, Identity target, int damage)
    {
        if (damage <= 0)
        {
            return;
        }

        if (ctx.Db.Character.Identity.Find(target) is not { } ch || ch.Hp <= 0)
        {
            return;
        }

        ch.Hp = Math.Max(0, ch.Hp - damage);
        ch.LastDamagedAt = ctx.Timestamp;
        ctx.Db.Character.Identity.Update(ch);
        if (ch.Hp > 0)
        {
            // Partial interrupt → hard interrupt once threshold crossed.
            MaybePushbackOrHardInterrupt(ctx, target);
            return;
        }

        if (ctx.Db.PlayerCombat.Identity.Find(target) is { } combat)
        {
            combat.TargetNpcId = 0;
            combat.CastingSpellId = 0;
            combat.CastPushbackCount = 0;
            ctx.Db.PlayerCombat.Identity.Update(combat);
        }
        ClearPendingCastsFor(ctx, target);

        ctx.Db.PendingPlayerRespawn.Insert(new PendingPlayerRespawn
        {
            ScheduledAt = new ScheduleAt.Time(ctx.Timestamp + Ms(Combat.RespawnDelayMs)),
            Player = target,
        });
        Log.Info($"Player {target} died; respawn in {Combat.RespawnDelayMs}ms");
    }

    /// <summary>Full HP + teleport to yard origin after death delay.</summary>
    [SpacetimeDB.Reducer]
    public static void ResolvePlayerRespawn(ReducerContext ctx, PendingPlayerRespawn pending)
    {
        if (ctx.Db.Character.Identity.Find(pending.Player) is { } ch)
        {
            // Only revive if still dead (ignore stale schedules).
            if (ch.Hp <= 0)
            {
                ch.Hp = ch.MaxHp > 0 ? ch.MaxHp : Combat.PlayerMaxHp;
                if (ch.MaxHp <= 0)
                {
                    ch.MaxHp = Combat.PlayerMaxHp;
                }
                if (ch.MaxMana <= 0)
                {
                    ch.MaxMana = Combat.PlayerMaxMana;
                }
                ch.Mana = ch.MaxMana;
                ch.LastManaTickAt = ctx.Timestamp;
                ctx.Db.Character.Identity.Update(ch);
            }
        }

        if (ctx.Db.PlayerPose.Identity.Find(pending.Player) is { } pose)
        {
            Movement.ChunkCoords(Movement.SpawnX, Movement.SpawnZ, out var cx, out var cz);
            pose.X = Movement.SpawnX;
            pose.Y = Movement.SpawnY;
            pose.Z = Movement.SpawnZ;
            pose.VelY = 0f;
            pose.LastGroundedMicros = ctx.Timestamp.MicrosecondsSinceUnixEpoch;
            pose.ChunkX = cx;
            pose.ChunkZ = cz;
            var ix = pose.InterestChunkX;
            var iz = pose.InterestChunkZ;
            Aoi.UpdateInterest(pose.X, pose.Z, cx, cz, ref ix, ref iz);
            pose.InterestChunkX = ix;
            pose.InterestChunkZ = iz;
            ctx.Db.PlayerPose.Identity.Update(pose);
        }

        if (ctx.Db.PlayerCombat.Identity.Find(pending.Player) is { } combat)
        {
            combat.TargetNpcId = 0;
            combat.CastingSpellId = 0;
            combat.CastPushbackCount = 0;
            ctx.Db.PlayerCombat.Identity.Update(combat);
        }

        Log.Info($"Player {pending.Player} respawned at yard origin");
    }



    /// <summary>
    /// Spawn an extra ember_shard near each other PartyMember mate within
    /// <see cref="Loot.PartyShareRangeMeters"/> of the death position.
    /// Killer still gets the primary death drop; solo kills invent nothing.
    /// </summary>
    static void SharePartyLootDrop(ReducerContext ctx, Identity killer, float deathX, float deathY, float deathZ)
    {
        if (ctx.Db.PartyMember.Identity.Find(killer) is not { } self)
        {
            return;
        }

        var range = Loot.PartyShareRangeMeters;
        var rangeSq = range * range;

        foreach (var m in ctx.Db.PartyMember.Iter())
        {
            if (m.PartyId != self.PartyId || m.Identity.Equals(killer))
            {
                continue;
            }

            if (ctx.Db.PlayerPose.Identity.Find(m.Identity) is not { } pose)
            {
                continue;
            }

            var dx = pose.X - deathX;
            var dz = pose.Z - deathZ;
            if (dx * dx + dz * dz > rangeSq)
            {
                continue;
            }

            SpawnEmberShardAt(
                ctx,
                pose.X + Loot.PartyShareOffsetX,
                deathY + Loot.SeedY,
                pose.Z + Loot.PartyShareOffsetZ);
            Log.Info($"Party loot share ember_shard near {m.Identity} (killer {killer})");
        }
    }

    /// <summary>
    /// Grant <see cref="Combat.PartyXpSharePerMate"/> to each other PartyMember
    /// mate of the killer (always-relevant party — no distance gate).
    /// </summary>
    static void SharePartyKillXp(ReducerContext ctx, Identity killer)
    {
        if (ctx.Db.PartyMember.Identity.Find(killer) is not { } self)
        {
            return;
        }

        foreach (var m in ctx.Db.PartyMember.Iter())
        {
            if (m.PartyId != self.PartyId || m.Identity.Equals(killer))
            {
                continue;
            }

            if (ctx.Db.Character.Identity.Find(m.Identity) is not { } mate)
            {
                continue;
            }

            AddCharacterXp(ref mate, Combat.PartyXpSharePerMate);
            ctx.Db.Character.Identity.Update(mate);
            Log.Info($"Party XP share +{Combat.PartyXpSharePerMate} to {m.Identity} (killer {killer}, total={mate.Xp} level={mate.Level})");
        }
    }

    static void ClearPartyStateFor(ReducerContext ctx, Identity id)
    {
        if (ctx.Db.PartyInvite.Invitee.Find(id) is { } invite)
        {
            ctx.Db.PartyInvite.Invitee.Delete(invite.Invitee);
        }

        if (ctx.Db.PartyMember.Identity.Find(id) is not { } self)
        {
            return;
        }

        var partyId = self.PartyId;
        var wasLeader = self.IsLeader;
        ctx.Db.PartyMember.Identity.Delete(self.Identity);

        var remaining = new System.Collections.Generic.List<PartyMember>();
        foreach (var m in ctx.Db.PartyMember.Iter())
        {
            if (m.PartyId == partyId)
            {
                remaining.Add(m);
            }
        }

        if (remaining.Count == 0)
        {
            var invites = new System.Collections.Generic.List<Identity>();
            foreach (var i in ctx.Db.PartyInvite.Iter())
            {
                if (i.PartyId == partyId)
                {
                    invites.Add(i.Invitee);
                }
            }
            foreach (var invId in invites)
            {
                ctx.Db.PartyInvite.Invitee.Delete(invId);
            }
            return;
        }

        if (wasLeader)
        {
            var next = remaining[0];
            next.IsLeader = true;
            ctx.Db.PartyMember.Identity.Update(next);
        }
    }


    /// <summary>Public say — trim, truncate, rate-limit per identity, insert ChatMessage; prune oldest beyond window.</summary>
    [SpacetimeDB.Reducer]
    public static void Say(ReducerContext ctx, string text)
    {
        var trimmed = (text ?? string.Empty).Trim();
        if (trimmed.Length == 0)
        {
            throw new Exception("Empty say");
        }

        if (trimmed.Length > Chat.SayMaxLen)
        {
            trimmed = trimmed.Substring(0, Chat.SayMaxLen);
        }

        // Per-identity rate limit: reject if last ChatMessage from sender is too recent.
        Timestamp? lastSent = null;
        foreach (var m in ctx.Db.ChatMessage.Iter())
        {
            if (m.Sender != ctx.Sender)
            {
                continue;
            }
            if (lastSent is null || m.SentAt > lastSent.Value)
            {
                lastSent = m.SentAt;
            }
        }
        if (lastSent is { } last && ctx.Timestamp < last + Ms(Chat.SayMinIntervalMs))
        {
            throw new Exception("Say rate-limited");
        }

        ctx.Db.ChatMessage.Insert(new ChatMessage
        {
            Sender = ctx.Sender,
            Text = trimmed,
            SentAt = ctx.Timestamp,
        });

        // Nice-to-have: keep a short rolling window so wholesale sub stays small.
        var count = 0;
        foreach (var _ in ctx.Db.ChatMessage.Iter())
        {
            count++;
        }
        while (count > Chat.ChatWindowMax)
        {
            ulong oldestId = 0;
            var found = false;
            foreach (var m in ctx.Db.ChatMessage.Iter())
            {
                if (!found || m.MessageId < oldestId)
                {
                    oldestId = m.MessageId;
                    found = true;
                }
            }
            if (!found)
            {
                break;
            }
            ctx.Db.ChatMessage.MessageId.Delete(oldestId);
            count--;
        }

        Log.Info($"Say {ctx.Sender}: {trimmed}");
    }

    /// <summary>Party channel say — sender must be PartyMember; RLS hides from outsiders.</summary>
    [SpacetimeDB.Reducer]
    public static void PartySay(ReducerContext ctx, string text)
    {
        var self = ctx.Db.PartyMember.Identity.Find(ctx.Sender)
            ?? throw new Exception("Not in a party");

        var trimmed = (text ?? string.Empty).Trim();
        if (trimmed.Length == 0)
        {
            throw new Exception("Empty party say");
        }

        if (trimmed.Length > Chat.SayMaxLen)
        {
            trimmed = trimmed.Substring(0, Chat.SayMaxLen);
        }

        Timestamp? lastSent = null;
        foreach (var m in ctx.Db.PartyChatMessage.Iter())
        {
            if (m.Sender != ctx.Sender)
            {
                continue;
            }
            if (lastSent is null || m.SentAt > lastSent.Value)
            {
                lastSent = m.SentAt;
            }
        }
        if (lastSent is { } last && ctx.Timestamp < last + Ms(Chat.SayMinIntervalMs))
        {
            throw new Exception("PartySay rate-limited");
        }

        ctx.Db.PartyChatMessage.Insert(new PartyChatMessage
        {
            PartyId = self.PartyId,
            Sender = ctx.Sender,
            Text = trimmed,
            SentAt = ctx.Timestamp,
        });

        var count = 0;
        foreach (var _ in ctx.Db.PartyChatMessage.Iter())
        {
            count++;
        }
        while (count > Chat.ChatWindowMax)
        {
            ulong oldestId = 0;
            var found = false;
            foreach (var m in ctx.Db.PartyChatMessage.Iter())
            {
                if (!found || m.MessageId < oldestId)
                {
                    oldestId = m.MessageId;
                    found = true;
                }
            }
            if (!found)
            {
                break;
            }
            ctx.Db.PartyChatMessage.MessageId.Delete(oldestId);
            count--;
        }

        Log.Info($"PartySay party={self.PartyId} {ctx.Sender}: {trimmed}");
    }


    /// <summary>Private whisper — recipient must exist (pose/character); RLS hides from others.</summary>
    [SpacetimeDB.Reducer]
    public static void Whisper(ReducerContext ctx, Identity recipient, string text)
    {
        if (recipient == ctx.Sender)
        {
            throw new Exception("Cannot whisper self");
        }

        if (ctx.Db.PlayerPose.Identity.Find(recipient) is null &&
            ctx.Db.Character.Identity.Find(recipient) is null)
        {
            throw new Exception("Whisper target offline");
        }

        var trimmed = (text ?? string.Empty).Trim();
        if (trimmed.Length == 0)
        {
            throw new Exception("Empty whisper");
        }

        if (trimmed.Length > Chat.SayMaxLen)
        {
            trimmed = trimmed.Substring(0, Chat.SayMaxLen);
        }

        Timestamp? lastSent = null;
        foreach (var m in ctx.Db.WhisperMessage.Iter())
        {
            if (m.Sender != ctx.Sender)
            {
                continue;
            }
            if (lastSent is null || m.SentAt > lastSent.Value)
            {
                lastSent = m.SentAt;
            }
        }
        if (lastSent is { } last && ctx.Timestamp < last + Ms(Chat.SayMinIntervalMs))
        {
            throw new Exception("Whisper rate-limited");
        }

        ctx.Db.WhisperMessage.Insert(new WhisperMessage
        {
            Sender = ctx.Sender,
            Recipient = recipient,
            Text = trimmed,
            SentAt = ctx.Timestamp,
        });

        var count = 0;
        foreach (var _ in ctx.Db.WhisperMessage.Iter())
        {
            count++;
        }
        while (count > Chat.ChatWindowMax)
        {
            ulong oldestId = 0;
            var found = false;
            foreach (var m in ctx.Db.WhisperMessage.Iter())
            {
                if (!found || m.MessageId < oldestId)
                {
                    oldestId = m.MessageId;
                    found = true;
                }
            }
            if (!found)
            {
                break;
            }
            ctx.Db.WhisperMessage.MessageId.Delete(oldestId);
            count--;
        }

        Log.Info($"Whisper {ctx.Sender} -> {recipient}: {trimmed}");
    }


    /// <summary>Offer a pending trade to another online identity (shard and/or small XP).</summary>
    [SpacetimeDB.Reducer]
    public static void OfferTrade(ReducerContext ctx, Identity to, bool offeredHasEmberShard, int offeredXp)
    {
        if (to == ctx.Sender)
        {
            throw new Exception("Cannot trade with self");
        }

        if (ctx.Db.PlayerPose.Identity.Find(to) is null)
        {
            throw new Exception("Trade partner not online");
        }

        if (!offeredHasEmberShard && offeredXp <= 0)
        {
            throw new Exception("Offer empty");
        }

        if (offeredXp < 0 || offeredXp > Trade.MaxOfferXp)
        {
            throw new Exception("Invalid XP offer");
        }

        var fromPose = ctx.Db.PlayerPose.Identity.Find(ctx.Sender)
            ?? throw new Exception("PlayerPose missing");
        var toPose = ctx.Db.PlayerPose.Identity.Find(to)
            ?? throw new Exception("Trade partner not online");
        EnsureInTradeRange(fromPose, toPose);

        var fromChar = ctx.Db.Character.Identity.Find(ctx.Sender)
            ?? throw new Exception("Character missing");

        if (offeredHasEmberShard && !fromChar.HasEmberShard)
        {
            throw new Exception("No ember shard");
        }

        if (offeredXp > 0 && fromChar.Xp < offeredXp)
        {
            throw new Exception("Not enough XP");
        }

        // One outstanding offer per recipient; also replace any prior offer from sender.
        if (ctx.Db.TradeOffer.To.Find(to) is { } existing)
        {
            ctx.Db.TradeOffer.To.Delete(existing.To);
        }
        var stale = new System.Collections.Generic.List<Identity>();
        foreach (var row in ctx.Db.TradeOffer.Iter())
        {
            if (row.From == ctx.Sender)
            {
                stale.Add(row.To);
            }
        }
        foreach (var id in stale)
        {
            ctx.Db.TradeOffer.To.Delete(id);
        }

        ctx.Db.TradeOffer.Insert(new TradeOffer
        {
            To = to,
            From = ctx.Sender,
            OfferedHasEmberShard = offeredHasEmberShard,
            OfferedXp = offeredXp,
        });
        Log.Info($"TradeOffer {ctx.Sender} -> {to} shard={offeredHasEmberShard} xp={offeredXp}");
    }

    /// <summary>Accept the outstanding TradeOffer targeting sender — range + transfer.</summary>
    [SpacetimeDB.Reducer]
    public static void AcceptTrade(ReducerContext ctx)
    {
        var offer = ctx.Db.TradeOffer.To.Find(ctx.Sender)
            ?? throw new Exception("No pending trade");

        var fromPose = ctx.Db.PlayerPose.Identity.Find(offer.From)
            ?? throw new Exception("Trade partner not online");
        var toPose = ctx.Db.PlayerPose.Identity.Find(ctx.Sender)
            ?? throw new Exception("PlayerPose missing");
        EnsureInTradeRange(fromPose, toPose);

        var fromChar = ctx.Db.Character.Identity.Find(offer.From)
            ?? throw new Exception("Offer character missing");
        var toChar = ctx.Db.Character.Identity.Find(ctx.Sender)
            ?? throw new Exception("Character missing");

        if (offer.OfferedHasEmberShard)
        {
            if (!fromChar.HasEmberShard)
            {
                ctx.Db.TradeOffer.To.Delete(offer.To);
                throw new Exception("No ember shard");
            }
            fromChar.HasEmberShard = false;
            toChar.HasEmberShard = true;
        }

        if (offer.OfferedXp > 0)
        {
            if (fromChar.Xp < offer.OfferedXp)
            {
                ctx.Db.TradeOffer.To.Delete(offer.To);
                throw new Exception("Not enough XP");
            }
            fromChar.Xp -= offer.OfferedXp;
            if (fromChar.Xp < 0)
            {
                fromChar.Xp = 0;
            }
            // Spend keeps high-water Level; recipient may level up.
            SyncLevelFromXp(ref fromChar);
            AddCharacterXp(ref toChar, offer.OfferedXp);
        }

        ctx.Db.Character.Identity.Update(fromChar);
        ctx.Db.Character.Identity.Update(toChar);
        ctx.Db.TradeOffer.To.Delete(offer.To);
        Log.Info($"AcceptTrade {ctx.Sender} from {offer.From} shard={offer.OfferedHasEmberShard} xp={offer.OfferedXp}");
    }

    /// <summary>Cancel outgoing or decline inbound TradeOffer involving sender.</summary>
    [SpacetimeDB.Reducer]
    public static void CancelTrade(ReducerContext ctx)
    {
        var removed = false;
        if (ctx.Db.TradeOffer.To.Find(ctx.Sender) is { } inbound)
        {
            ctx.Db.TradeOffer.To.Delete(inbound.To);
            removed = true;
        }

        var outs = new System.Collections.Generic.List<Identity>();
        foreach (var row in ctx.Db.TradeOffer.Iter())
        {
            if (row.From == ctx.Sender)
            {
                outs.Add(row.To);
            }
        }
        foreach (var id in outs)
        {
            ctx.Db.TradeOffer.To.Delete(id);
            removed = true;
        }

        if (!removed)
        {
            throw new Exception("No trade to cancel");
        }
        Log.Info($"CancelTrade by {ctx.Sender}");
    }

    static void EnsureInTradeRange(PlayerPose a, PlayerPose b)
    {
        var dx = a.X - b.X;
        var dz = a.Z - b.Z;
        var range = Trade.RangeMeters;
        if (dx * dx + dz * dz > range * range)
        {
            throw new Exception("Out of range");
        }
    }

    static void ClearTradeStateFor(ReducerContext ctx, Identity id)
    {
        if (ctx.Db.TradeOffer.To.Find(id) is { } inbound)
        {
            ctx.Db.TradeOffer.To.Delete(inbound.To);
        }
        var outs = new System.Collections.Generic.List<Identity>();
        foreach (var row in ctx.Db.TradeOffer.Iter())
        {
            if (row.From == id)
            {
                outs.Add(row.To);
            }
        }
        foreach (var to in outs)
        {
            ctx.Db.TradeOffer.To.Delete(to);
        }
    }

    /// <summary>Clear + seed one ember_shard near yard spawn (idempotent smoke helper).</summary>
    [SpacetimeDB.Reducer]
    public static void SeedLoot(ReducerContext ctx)
    {
        ClearWorldLoot(ctx);
        SpawnEmberShardAt(ctx, Loot.SeedX, Loot.SeedY, Loot.SeedZ);
        Log.Info($"SeedLoot by {ctx.Sender}");
    }

    /// <summary>Take nearest WorldLoot in range — grant XP + bag flag for ember_shard, despawn.</summary>
    [SpacetimeDB.Reducer]
    public static void Pickup(ReducerContext ctx)
    {
        var pose = ctx.Db.PlayerPose.Identity.Find(ctx.Sender)
            ?? throw new Exception("PlayerPose missing");

        WorldLoot? best = null;
        var bestDistSq = float.MaxValue;
        foreach (var row in ctx.Db.WorldLoot.Iter())
        {
            var dx = row.X - pose.X;
            var dz = row.Z - pose.Z;
            var distSq = dx * dx + dz * dz;
            if (distSq < bestDistSq)
            {
                bestDistSq = distSq;
                best = row;
            }
        }

        if (best is null)
        {
            throw new Exception("No loot");
        }

        var range = Loot.PickupRangeMeters;
        if (bestDistSq > range * range)
        {
            throw new Exception("Out of range");
        }

        var item = best.Value;
        var character = ctx.Db.Character.Identity.Find(ctx.Sender)
            ?? throw new Exception("Character missing");

        if (item.ItemId == Loot.EmberShardItemId)
        {
            AddCharacterXp(ref character, Loot.XpPerEmberShard);
            character.HasEmberShard = true;
            ctx.Db.Character.Identity.Update(character);
        }

        ctx.Db.WorldLoot.LootId.Delete(item.LootId);
        Log.Info($"Pickup {item.ItemId} id={item.LootId} by {ctx.Sender} xp={character.Xp}");
    }

    static void ClearWorldLoot(ReducerContext ctx)
    {
        var toDelete = new System.Collections.Generic.List<ulong>();
        foreach (var row in ctx.Db.WorldLoot.Iter())
        {
            toDelete.Add(row.LootId);
        }
        foreach (var id in toDelete)
        {
            ctx.Db.WorldLoot.LootId.Delete(id);
        }
    }

    static void SpawnEmberShardAt(ReducerContext ctx, float x, float y, float z)
    {
        ctx.Db.WorldLoot.Insert(new WorldLoot
        {
            X = x,
            Y = y,
            Z = z,
            ItemId = Loot.EmberShardItemId,
        });
    }


    /// <summary>Spend XP at a nearby YardVendor to gain HasEmberShard.</summary>
    [SpacetimeDB.Reducer]
    public static void BuyFromVendor(ReducerContext ctx)
    {
        var pose = ctx.Db.PlayerPose.Identity.Find(ctx.Sender)
            ?? throw new Exception("PlayerPose missing");
        var character = ctx.Db.Character.Identity.Find(ctx.Sender)
            ?? throw new Exception("Character missing");

        var vendor = FindVendorInRange(ctx, pose)
            ?? throw new Exception("Out of range");

        if (character.HasEmberShard)
        {
            throw new Exception("Already have ember shard");
        }

        if (character.Xp < Fardel.Shared.Vendor.BuyPriceXp)
        {
            throw new Exception("Not enough XP");
        }

        character.Xp -= Fardel.Shared.Vendor.BuyPriceXp;
        if (character.Xp < 0)
        {
            character.Xp = 0;
        }
        SyncLevelFromXp(ref character);
        character.HasEmberShard = true;
        ctx.Db.Character.Identity.Update(character);
        Log.Info($"BuyFromVendor {ctx.Sender} vendor={vendor.VendorId} xp={character.Xp}");
    }

    /// <summary>Sell HasEmberShard to a nearby YardVendor for XP.</summary>
    [SpacetimeDB.Reducer]
    public static void SellToVendor(ReducerContext ctx)
    {
        var pose = ctx.Db.PlayerPose.Identity.Find(ctx.Sender)
            ?? throw new Exception("PlayerPose missing");
        var character = ctx.Db.Character.Identity.Find(ctx.Sender)
            ?? throw new Exception("Character missing");

        var vendor = FindVendorInRange(ctx, pose)
            ?? throw new Exception("Out of range");

        if (!character.HasEmberShard)
        {
            throw new Exception("No ember shard");
        }

        character.HasEmberShard = false;
        AddCharacterXp(ref character, Fardel.Shared.Vendor.SellPriceXp);
        ctx.Db.Character.Identity.Update(character);
        Log.Info($"SellToVendor {ctx.Sender} vendor={vendor.VendorId} xp={character.Xp}");
    }


    /// <summary>
    /// Out-of-combat Rest: restore HealAmount HP and ManaRestore mana (free; distinct from UseBandage).
    /// Rejects while dead, casting, recently damaged, on cooldown, or already full HP+mana.
    /// </summary>
    [SpacetimeDB.Reducer]
    public static void Rest(ReducerContext ctx)
    {
        var character = ctx.Db.Character.Identity.Find(ctx.Sender)
            ?? throw new Exception("Character missing");
        if (character.Hp <= 0)
        {
            throw new Exception("Dead");
        }
        if (character.MaxHp <= 0)
        {
            character.MaxHp = Combat.PlayerMaxHp;
        }
        if (character.MaxMana <= 0)
        {
            character.MaxMana = Combat.PlayerMaxMana;
        }

        TickManaRegen(ctx, ref character);

        var hpFull = character.Hp >= character.MaxHp;
        var manaFull = character.Mana >= character.MaxMana;
        if (hpFull && manaFull)
        {
            ctx.Db.Character.Identity.Update(character);
            throw new Exception("Already full");
        }

        if (ctx.Db.PlayerCombat.Identity.Find(ctx.Sender) is { } combat
            && combat.CastingSpellId != 0)
        {
            ctx.Db.Character.Identity.Update(character);
            throw new Exception("Casting");
        }

        if (character.LastDamagedAt.MicrosecondsSinceUnixEpoch > 0
            && ctx.Timestamp < character.LastDamagedAt + Ms(Fardel.Shared.Rest.CombatLockMs))
        {
            ctx.Db.Character.Identity.Update(character);
            throw new Exception("Recently damaged");
        }

        if (ctx.Timestamp < character.RestReadyAt)
        {
            ctx.Db.Character.Identity.Update(character);
            throw new Exception("Rest on cooldown");
        }

        var beforeHp = character.Hp;
        var beforeMana = character.Mana;
        if (!hpFull)
        {
            character.Hp = Math.Min(character.MaxHp, character.Hp + Fardel.Shared.Rest.HealAmount);
        }
        if (!manaFull)
        {
            character.Mana = Math.Min(character.MaxMana, character.Mana + Fardel.Shared.Rest.ManaRestore);
        }
        character.RestReadyAt = ctx.Timestamp + Ms(Fardel.Shared.Rest.CooldownMs);
        character.LastManaTickAt = ctx.Timestamp;
        ctx.Db.Character.Identity.Update(character);
        Log.Info(
            $"Rest {ctx.Sender} hp {beforeHp}->{character.Hp}/{character.MaxHp} " +
            $"mana {beforeMana}->{character.Mana}/{character.MaxMana}");
    }

    /// <summary>Delete scheduled PendingCast rows for caster (cancels ResolveCast).</summary>
    static void ClearPendingCastsFor(ReducerContext ctx, Identity caster)
    {
        var toDelete = new System.Collections.Generic.List<ulong>();
        foreach (var row in ctx.Db.PendingCast.Iter())
        {
            if (row.Caster.Equals(caster))
            {
                toDelete.Add(row.ScheduleId);
            }
        }
        foreach (var id in toDelete)
        {
            ctx.Db.PendingCast.ScheduleId.Delete(id);
        }
    }

    /// <summary>
    /// Break an in-flight windup cast: delete PendingCast, clear CastingSpellId,
    /// optionally refund mana spent at Cast start. GCD stays (already started).
    /// </summary>
    static void InterruptWindupCast(ReducerContext ctx, Identity caster, bool refundMana, bool applySilence = true)
    {
        if (ctx.Db.PlayerCombat.Identity.Find(caster) is not { } combat
            || combat.CastingSpellId == 0)
        {
            return;
        }

        var spellId = combat.CastingSpellId;
        ClearPendingCastsFor(ctx, caster);
        combat.CastingSpellId = 0;
        combat.CastPushbackCount = 0;
        if (!refundMana && applySilence)
        {
            combat.CastLockedUntil = ctx.Timestamp + Ms(Combat.CastSilenceMs);
        }
        ctx.Db.PlayerCombat.Identity.Update(combat);

        if (!refundMana)
        {
            Log.Info(
                $"InterruptWindupCast {caster} spell={spellId} (no refund / hard) " +
                $"silence={(applySilence ? Combat.CastSilenceMs : 0)}ms");
            return;
        }

        var cost = Combat.ManaCost(spellId);
        if (cost > 0 && ctx.Db.Character.Identity.Find(caster) is { } ch)
        {
            TickManaRegen(ctx, ref ch);
            if (ch.MaxMana <= 0)
            {
                ch.MaxMana = Combat.PlayerMaxMana;
            }
            ch.Mana = System.Math.Min(ch.MaxMana, ch.Mana + cost);
            ctx.Db.Character.Identity.Update(ch);
            Log.Info($"InterruptWindupCast {caster} spell={spellId} refunded {cost} mana->{ch.Mana}");
        }
        else
        {
            Log.Info($"InterruptWindupCast {caster} spell={spellId}");
        }
    }

    /// <summary>
    /// Non-lethal hit during windup: pushback, or hard-interrupt (no refund)
    /// when CastPushbackCount &gt;= CastPushbackHardAfter or remaining &lt; threshold.
    /// </summary>
    static void MaybePushbackOrHardInterrupt(ReducerContext ctx, Identity caster)
    {
        if (ctx.Db.PlayerCombat.Identity.Find(caster) is not { } combat
            || combat.CastingSpellId == 0)
        {
            return;
        }

        var remainUs = combat.CastEndsAt.MicrosecondsSinceUnixEpoch
            - ctx.Timestamp.MicrosecondsSinceUnixEpoch;
        var remainMs = remainUs / 1000L;
        if (remainMs < 0)
        {
            remainMs = 0;
        }

        if (combat.CastPushbackCount >= Combat.CastPushbackHardAfter
            || remainMs < Combat.CastHardInterruptRemainMs)
        {
            Log.Info(
                $"HardInterruptWindup {caster} spell={combat.CastingSpellId} " +
                $"pushbacks={combat.CastPushbackCount} remainMs={remainMs} (no refund)");
            InterruptWindupCast(ctx, caster, refundMana: false);
            return;
        }

        PushbackWindupCast(ctx, caster);
    }

    /// <summary>
    /// Delay an in-flight windup: bump CastEndsAt, reschedule PendingCast.
    /// CastingSpellId stays; mana is not refunded. No-op if not casting.
    /// </summary>
    static void PushbackWindupCast(ReducerContext ctx, Identity caster)
    {
        if (ctx.Db.PlayerCombat.Identity.Find(caster) is not { } combat
            || combat.CastingSpellId == 0)
        {
            return;
        }

        var spellId = combat.CastingSpellId;
        var targetNpcId = combat.TargetNpcId;
        foreach (var row in ctx.Db.PendingCast.Iter())
        {
            if (row.Caster.Equals(caster) && row.SpellId == spellId)
            {
                targetNpcId = row.TargetNpcId;
                break;
            }
        }

        var baseEnd = combat.CastEndsAt.MicrosecondsSinceUnixEpoch > ctx.Timestamp.MicrosecondsSinceUnixEpoch
            ? combat.CastEndsAt
            : ctx.Timestamp;
        combat.CastEndsAt = baseEnd + Ms(Combat.CastPushbackMs);
        combat.CastPushbackCount = combat.CastPushbackCount + 1;
        ctx.Db.PlayerCombat.Identity.Update(combat);

        ClearPendingCastsFor(ctx, caster);
        ctx.Db.PendingCast.Insert(new PendingCast
        {
            ScheduledAt = new ScheduleAt.Time(combat.CastEndsAt),
            Caster = caster,
            SpellId = spellId,
            TargetNpcId = targetNpcId,
        });
        Log.Info(
            $"PushbackWindupCast {caster} spell={spellId} +{Combat.CastPushbackMs}ms " +
            $"count={combat.CastPushbackCount}");
    }

    /// <summary>Lazy mana regen between Cast/Rest using LastManaTickAt wall time.</summary>
    static void TickManaRegen(ReducerContext ctx, ref Character ch)
    {
        if (ch.MaxMana <= 0)
        {
            ch.MaxMana = Combat.PlayerMaxMana;
        }
        if (ch.Mana < 0)
        {
            ch.Mana = 0;
        }
        if (ch.Mana > ch.MaxMana)
        {
            ch.Mana = ch.MaxMana;
        }

        var last = ch.LastManaTickAt.MicrosecondsSinceUnixEpoch;
        var now = ctx.Timestamp.MicrosecondsSinceUnixEpoch;
        if (last <= 0)
        {
            ch.LastManaTickAt = ctx.Timestamp;
            return;
        }
        if (ch.Mana >= ch.MaxMana)
        {
            ch.LastManaTickAt = ctx.Timestamp;
            return;
        }

        var elapsedMs = (now - last) / 1000L;
        if (elapsedMs < Combat.ManaRegenIntervalMs)
        {
            return;
        }

        var ticks = (int)(elapsedMs / Combat.ManaRegenIntervalMs);
        if (ticks <= 0)
        {
            return;
        }

        ch.Mana = Math.Min(ch.MaxMana, ch.Mana + ticks * Combat.ManaRegenPerTick);
        // Advance by whole ticks so partial intervals accumulate.
        ch.LastManaTickAt = new Timestamp(last + ticks * (long)Combat.ManaRegenIntervalMs * 1000L);
    }


    /// <summary>Spend XP at a nearby YardVendor to gain HasYardBandage.</summary>
    [SpacetimeDB.Reducer]
    public static void BuyYardBandage(ReducerContext ctx)
    {
        var pose = ctx.Db.PlayerPose.Identity.Find(ctx.Sender)
            ?? throw new Exception("PlayerPose missing");
        var character = ctx.Db.Character.Identity.Find(ctx.Sender)
            ?? throw new Exception("Character missing");

        var vendor = FindVendorInRange(ctx, pose)
            ?? throw new Exception("Out of range");

        if (character.HasYardBandage)
        {
            throw new Exception("Already have yard bandage");
        }

        if (character.Xp < Bandage.BuyXpCost)
        {
            throw new Exception("Not enough XP");
        }

        character.Xp -= Bandage.BuyXpCost;
        character.HasYardBandage = true;
        ctx.Db.Character.Identity.Update(character);
        Log.Info($"BuyYardBandage {ctx.Sender} vendor={vendor.VendorId} xp={character.Xp}");
    }

    /// <summary>
    /// Consume HasYardBandage for an HP-only heal (no mana). Own CD/combat-lock vs Rest.
    /// Rejects while dead, casting, recently damaged, on cooldown, full HP, or no bandage.
    /// </summary>
    [SpacetimeDB.Reducer]
    public static void UseBandage(ReducerContext ctx)
    {
        var character = ctx.Db.Character.Identity.Find(ctx.Sender)
            ?? throw new Exception("Character missing");
        if (character.Hp <= 0)
        {
            throw new Exception("Dead");
        }
        if (character.MaxHp <= 0)
        {
            character.MaxHp = Combat.PlayerMaxHp;
        }

        if (!character.HasYardBandage)
        {
            throw new Exception("No yard bandage");
        }

        if (character.Hp >= character.MaxHp)
        {
            throw new Exception("Already full");
        }

        if (ctx.Db.PlayerCombat.Identity.Find(ctx.Sender) is { } combat
            && combat.CastingSpellId != 0)
        {
            throw new Exception("Casting");
        }

        if (character.LastDamagedAt.MicrosecondsSinceUnixEpoch > 0
            && ctx.Timestamp < character.LastDamagedAt + Ms(Bandage.CombatLockMs))
        {
            throw new Exception("Recently damaged");
        }

        if (ctx.Timestamp < character.BandageReadyAt)
        {
            throw new Exception("Bandage on cooldown");
        }

        var beforeHp = character.Hp;
        character.HasYardBandage = false;
        character.Hp = Math.Min(character.MaxHp, character.Hp + Bandage.HealAmount);
        character.BandageReadyAt = ctx.Timestamp + Ms(Bandage.CooldownMs);
        ctx.Db.Character.Identity.Update(character);
        Log.Info(
            $"UseBandage {ctx.Sender} hp {beforeHp}->{character.Hp}/{character.MaxHp}");
    }

    /// <summary>Spend XP at a nearby YardVendor to gain HasYardTonic.</summary>
    [SpacetimeDB.Reducer]
    public static void BuyYardTonic(ReducerContext ctx)
    {
        var pose = ctx.Db.PlayerPose.Identity.Find(ctx.Sender)
            ?? throw new Exception("PlayerPose missing");
        var character = ctx.Db.Character.Identity.Find(ctx.Sender)
            ?? throw new Exception("Character missing");

        var vendor = FindVendorInRange(ctx, pose)
            ?? throw new Exception("Out of range");

        if (character.HasYardTonic)
        {
            throw new Exception("Already have yard tonic");
        }

        if (character.Xp < Tonic.BuyXpCost)
        {
            throw new Exception("Not enough XP");
        }

        character.Xp -= Tonic.BuyXpCost;
        character.HasYardTonic = true;
        ctx.Db.Character.Identity.Update(character);
        Log.Info($"BuyYardTonic {ctx.Sender} vendor={vendor.VendorId} xp={character.Xp}");
    }

    /// <summary>
    /// Consume HasYardTonic for a short move-speed buff (TonicExpiresAt).
    /// Rejects while dead (align UseBandage/Rest).
    /// </summary>
    [SpacetimeDB.Reducer]
    public static void UseYardTonic(ReducerContext ctx)
    {
        var character = ctx.Db.Character.Identity.Find(ctx.Sender)
            ?? throw new Exception("Character missing");
        if (character.Hp <= 0)
        {
            throw new Exception("Dead");
        }

        if (!character.HasYardTonic)
        {
            throw new Exception("No yard tonic");
        }

        character.HasYardTonic = false;
        character.TonicExpiresAt = ctx.Timestamp + Ms(Tonic.DurationMs);
        ctx.Db.Character.Identity.Update(character);
        Log.Info($"UseYardTonic {ctx.Sender} expires={character.TonicExpiresAt}");
    }

    static YardVendor? FindVendorInRange(ReducerContext ctx, PlayerPose pose)
    {
        YardVendor? best = null;
        var bestDist = float.MaxValue;
        var range = Fardel.Shared.Vendor.RangeMeters;
        var rangeSq = range * range;
        foreach (var v in ctx.Db.YardVendor.Iter())
        {
            var dx = v.X - pose.X;
            var dz = v.Z - pose.Z;
            var d = dx * dx + dz * dz;
            if (d <= rangeSq && d < bestDist)
            {
                bestDist = d;
                best = v;
            }
        }
        return best;
    }

    /// <summary>Idempotent YardVendor seed (also called on ClientConnected).</summary>
    static void EnsureVendor(ReducerContext ctx)
    {
        foreach (var _ in ctx.Db.YardVendor.Iter())
        {
            return;
        }

        ctx.Db.YardVendor.Insert(new YardVendor
        {
            X = Fardel.Shared.Vendor.SpawnX,
            Y = Fardel.Shared.Vendor.SpawnY,
            Z = Fardel.Shared.Vendor.SpawnZ,
            Label = Fardel.Shared.Vendor.DefaultLabel,
        });
        Log.Info($"Seeded YardVendor at ({Fardel.Shared.Vendor.SpawnX},{Fardel.Shared.Vendor.SpawnZ})");
    }

    static ulong PartyIdFrom(Identity leader, Timestamp ts)
    {
        // Mix identity hash with timestamp micros (no durable party table / AutoInc needed).
        unchecked
        {
            ulong h = (ulong)(uint)leader.GetHashCode();
            h ^= (ulong)ts.MicrosecondsSinceUnixEpoch;
            h *= 1099511628211UL;
            return h == 0 ? 1UL : h;
        }
    }

    static TimeDuration Ms(int ms) => new() { Microseconds = ms * 1000L };
}
