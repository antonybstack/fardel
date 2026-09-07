using Fardel.Shared;
using SpacetimeDB;

#pragma warning disable STDB_UNSTABLE

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

        if (ctx.Db.PlayerCombat.Identity.Find(cast.Caster) is { } combat)
        {
            combat.CastingSpellId = 0;
            combat.LastSpellId = cast.SpellId;
            combat.LastCastAt = ctx.Timestamp;
            ctx.Db.PlayerCombat.Identity.Update(combat);
        }

        ApplyDamage(ctx, cast.Caster, cast.TargetNpcId, damage);
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
            HasEmberShard = false,
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
                CastingSpellId = 0,
                CastEndsAt = ctx.Timestamp,
                LastSpellId = 0,
                LastCastAt = ctx.Timestamp,
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
            SpawnEmberShardAt(ctx, row.X + Loot.DeathDropOffsetX, row.Y + Loot.SeedY, row.Z + Loot.DeathDropOffsetZ);
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
            character.Xp += Loot.XpPerEmberShard;
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
