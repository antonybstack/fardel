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

    /// <summary>Offset from dead dummy/hostile corpse when auto-dropping ember_shard (#357 reuses WorldLoot).</summary>
    public const float DeathDropOffsetX = 0.6f;
    public const float DeathDropOffsetZ = 0.4f;

    /// <summary>
    /// XZ radius from death position: other PartyMember mates inside this get an
    /// extra ember_shard WorldLoot near their pose (party loot share invent).
    /// Yard-scale so spawn mates cover dummy fights; far AOI mates do not.
    /// </summary>
    public const float PartyShareRangeMeters = 25f;

    /// <summary>Offset from mate pose when spawning their share shard.</summary>
    public const float PartyShareOffsetX = 0.8f;
    public const float PartyShareOffsetZ = -0.5f;
}
