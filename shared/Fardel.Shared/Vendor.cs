namespace Fardel.Shared;

/// <summary>Minimal yard vendor buy/sell tunables (vendor invent).</summary>
public static class Vendor
{
    /// <summary>XZ interact radius (meters) for BuyFromVendor / SellToVendor.</summary>
    public const float RangeMeters = 4f;

    /// <summary>Consumable flag item sold from VendorStock.</summary>
    public const string TonicItemId = "yard_tonic";

    /// <summary>XP spent when buying tonic without an ember shard.</summary>
    public const int BuyXpCost = 10;

    /// <summary>XP granted when selling an ember_shard to the vendor.</summary>
    public const int SellShardXp = 8;

    /// <summary>Initial VendorStock.Qty for yard_tonic.</summary>
    public const int InitialStock = 20;

    /// <summary>Seed position near yard origin — offset from dummy at (5,0,0).</summary>
    public const float SpawnX = -2.5f;
    public const float SpawnY = 0f;
    public const float SpawnZ = 2.0f;

    public const string DefaultLabel = "Vendor";
}
