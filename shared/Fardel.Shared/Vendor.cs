namespace Fardel.Shared;

/// <summary>Stationary yard vendor tunables (buy/sell ember shard for XP).</summary>
public static class Vendor
{
    /// <summary>XZ interaction range (meters) from player pose to YardVendor.</summary>
    public const float RangeMeters = 4.5f;

    /// <summary>XP spent to buy an ember shard from the vendor.</summary>
    public const int BuyPriceXp = 5;

    /// <summary>XP granted when selling an ember shard to the vendor.</summary>
    public const int SellPriceXp = 5;

    /// <summary>Seed position near yard origin — offset from dummy at (5,0,0).</summary>
    public const float SpawnX = -2.5f;
    public const float SpawnY = 0f;
    public const float SpawnZ = 2.0f;

    public const string DefaultLabel = "Vendor";
}
