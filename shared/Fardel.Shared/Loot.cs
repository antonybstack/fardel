namespace Fardel.Shared;

/// <summary>Minimal world loot / ground-item tunables (pickup invent).</summary>
public static class Loot
{
    public const string EmberShardItemId = "ember_shard";

    /// <summary>XZ pickup radius (meters) from player pose to WorldLoot.</summary>
    public const float PickupRangeMeters = 3f;

    /// <summary>XP granted when picking up an ember_shard (bag flag also set).</summary>
    public const int XpPerEmberShard = 5;

    /// <summary>SeedLoot spawn near yard origin (within PickupRange of Movement.Spawn).</summary>
    public const float SeedX = 1.5f;
    public const float SeedY = 0.4f;
    public const float SeedZ = 1.2f;

    /// <summary>Offset from dead dummy when auto-dropping ember_shard.</summary>
    public const float DeathDropOffsetX = 0.6f;
    public const float DeathDropOffsetZ = 0.4f;
}
