namespace Fardel.Shared;

/// <summary>POC combat tunables — Spark / Emberbolt / shared GCD / mana.</summary>
public static class Combat
{
    public const int SpellSpark = 1;
    public const int SpellEmberbolt = 2;

    public const int GcdMs = 1200;
    public const int SparkCastMs = 0;
    public const int EmberboltCastMs = 1500;

    public const int SparkDamage = 10;
    public const int EmberboltDamage = 25;

    /// <summary>Mana spent when Cast starts (instant or windup). Windup cancel/move-interrupt refunds.</summary>
    public const int SparkManaCost = 5;
    public const int EmberboltManaCost = 20;

    public const int DummyMaxHp = 50;
    public const int XpPerKill = 10;

    /// <summary>
    /// Always-relevant party share: each other PartyMember mate gets this much
    /// Character.Xp when the killer earns <see cref="XpPerKill"/> (50% of kill XP).
    /// Killer still receives full XpPerKill so CombatSmoke stays green.
    /// </summary>
    public const int PartyXpSharePerMate = XpPerKill / 2;

    public const float DummySpawnX = 5f;
    public const float DummySpawnY = 0f;
    public const float DummySpawnZ = 0f;

    /// <summary>Training dummy (Kind=1). Hostiles are a separate type.</summary>
    public const int NpcKindDummy = 1;
    /// <summary>Hostile NPC kind. Two yard spawns, not origin. Dummy stays trainer.</summary>
    public const int NpcKindHostile = 2;
    public const int HostileMaxHp = 40;
    public const float HostileSpawnAx = 3f;
    public const float HostileSpawnAy = 0f;
    public const float HostileSpawnAz = 7f;
    public const float HostileSpawnBx = -7f;
    public const float HostileSpawnBy = 0f;
    public const float HostileSpawnBz = 3f;

    /// <summary>
    /// Proximity pull (#355). Must stay under CastRangeSmoke far-pose vs pad B
    /// (~3.6m at x=-5,z=0). Origin is ~7.6m from both pads — no pull on connect.
    /// </summary>
    public const float HostileAggroRadius = 3.0f;
    /// <summary>Drop chase and walk home when the hostile is this far from spawn.</summary>
    public const float HostileLeashRadius = 12f;
    public const int HostileTickMs = 100;
    /// <summary>~4 m/s. Players outrun this (MaxStep 0.75 at ~20Hz).</summary>
    public const float HostileStepMeters = 0.4f;

    /// <summary>Player Character.MaxHp seed (durable).</summary>
    public const int PlayerMaxHp = 100;

    /// <summary>Player Character.MaxMana seed (durable).</summary>
    public const int PlayerMaxMana = 100;

    /// <summary>
    /// Lazy mana regen: every ManaRegenIntervalMs of wall time between Cast/Rest
    /// ticks restores ManaRegenPerTick (clamped to MaxMana). Sized so CombatSmoke
    /// (~7 Sparks + Emberbolt) still fits from a full pool without relying on regen.
    /// </summary>
    public const int ManaRegenIntervalMs = 1000;
    public const int ManaRegenPerTick = 2;

    /// <summary>
    /// Light thorns when a spell lands on the training dummy — single-client
    /// player-HP proof without changing Cast targeting. Sized so CombatSmoke
    /// (~7 ApplyDamage hits) stays under PlayerMaxHp.
    /// </summary>
    public const int DummyThornsDamage = 10;

    /// <summary>
    /// Non-lethal damage during a windup delays CastEndsAt by this much and
    /// reschedules PendingCast. No cancel, no mana refund (partial interrupt).
    /// DummyStrike is opt-in so CombatSmoke / ManaSmoke Emberbolt timing stays
    /// the unpushed 1500ms land.
    /// </summary>
    public const int CastPushbackMs = 500;

    /// <summary>
    /// After this many successful pushbacks on the same windup, the next
    /// non-lethal hit hard-interrupts (full cancel, no mana refund).
    /// CastPushbackSmoke only strikes once — stays green.
    /// </summary>
    public const int CastPushbackHardAfter = 1;

    /// <summary>
    /// If remaining windup is below this when hit, hard-interrupt instead of
    /// pushback (lockout / no refund). Sized under EmberboltCastMs so an early
    /// DummyStrike still pushbacks.
    /// </summary>
    public const int CastHardInterruptRemainMs = 400;

    /// <summary>
    /// After a hard interrupt, Cast rejects with "silenced" until this many ms
    /// after the interrupt (CastLockedUntil). Soft cancel/move-interrupt does
    /// not apply silence.
    /// </summary>
    public const int CastSilenceMs = 1500;

    /// <summary>
    /// Max horizontal (XZ) distance from caster <c>PlayerPose</c> to targeted
    /// NPC for Cast. Spawn (0,0,0) ↔ dummy (~5,0,0) is IN range so CombatSmoke /
    /// ManaSmoke / CastSilenceSmoke keep working; Move far (&gt; this) gets OUT.
    /// </summary>
    public const float CastRangeMeters = 8f;

    /// <summary>
    /// Kick / Counterspell — first-class PvP interrupt. Hard-cancels target
    /// windup (no mana refund) and applies the same CastLockedUntil silence
    /// without DummyStrike pushback chain.
    /// </summary>
    public const float KickRangeMeters = 8f;
    /// <summary>Mana spent by the kicker (instant; not refunded).</summary>
    public const int KickManaCost = 10;

    /// <summary>
    /// Stun / Bash — short hard-CC. Breaks target windup (no mana refund) and
    /// applies StunnedUntil move/cast lockout. Distinct from CastLockedUntil
    /// silence (Stun does not set CastLockedUntil).
    /// </summary>
    public const float StunRangeMeters = 5f;
    /// <summary>Mana spent by the stunner (instant; not refunded).</summary>
    public const int StunManaCost = 15;
    /// <summary>Move + Cast reject with "stunned" while Timestamp &lt; StunnedUntil.</summary>
    public const int StunDurationMs = 1500;

    /// <summary>Delay before ResolvePlayerRespawn after Hp hits 0.</summary>
    public const int RespawnDelayMs = 2500;

    public static bool TryGetSpell(int spellId, out int castMs, out int damage)
    {
        switch (spellId)
        {
            case SpellSpark:
                castMs = SparkCastMs;
                damage = SparkDamage;
                return true;
            case SpellEmberbolt:
                castMs = EmberboltCastMs;
                damage = EmberboltDamage;
                return true;
            default:
                castMs = 0;
                damage = 0;
                return false;
        }
    }

    public static int ManaCost(int spellId) =>
        spellId switch
        {
            SpellSpark => SparkManaCost,
            SpellEmberbolt => EmberboltManaCost,
            _ => 0,
        };
}
