namespace Fardel.Shared;

/// <summary>Minimal player↔player trade tunables (trade invent).</summary>
public static class Trade
{
    /// <summary>XZ range (meters) between From and To poses for OfferTrade / AcceptTrade.</summary>
    public const float RangeMeters = 5f;

    /// <summary>Max XP that can be offered in one TradeOffer.</summary>
    public const int MaxOfferXp = 25;

    /// <summary>Default small XP offer when sender has no ember shard.</summary>
    public const int DefaultOfferXp = 5;
}
