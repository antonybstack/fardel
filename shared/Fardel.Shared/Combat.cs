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
