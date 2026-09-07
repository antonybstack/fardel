namespace Fardel.Shared;

/// <summary>Yard tonic consumable — short move-speed buff (use invent).</summary>
public static class Tonic
{
    public const string ItemId = "yard_tonic";

    /// <summary>Buff duration after UseYardTonic (ms).</summary>
    public const int DurationMs = 15000;

    /// <summary>Move max-step / wish multiplier while TonicExpiresAt is in the future.</summary>
    public const float MoveSpeedMult = 1.75f;

    /// <summary>XP spent at YardVendor via BuyYardTonic.</summary>
    public const int BuyXpCost = 5;
}
