namespace Fardel.Shared;

/// <summary>POC combat tunables — Spark / Emberbolt / shared GCD.</summary>
public static class Combat
{
    public const int SpellSpark = 1;
    public const int SpellEmberbolt = 2;

    public const int GcdMs = 1200;
    public const int SparkCastMs = 0;
    public const int EmberboltCastMs = 1500;

    public const int SparkDamage = 10;
    public const int EmberboltDamage = 25;

    public const int DummyMaxHp = 50;
    public const int XpPerKill = 10;

    public const float DummySpawnX = 5f;
    public const float DummySpawnY = 0f;
    public const float DummySpawnZ = 0f;

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
}
