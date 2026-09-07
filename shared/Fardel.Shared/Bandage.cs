namespace Fardel.Shared;

/// <summary>
/// Yard bandage consumable — buy from vendor, UseBandage for HP heal.
/// Distinct from Rest: item-gated, HP-only (no mana), own CD/combat-lock tunables.
/// </summary>
public static class Bandage
{
    public const string ItemId = "yard_bandage";

    /// <summary>HP restored per UseBandage (clamped to MaxHp). Distinct from Rest.HealAmount.</summary>
    public const int HealAmount = 40;

    /// <summary>Minimum interval between successful UseBandage calls (ms). Distinct from Rest.CooldownMs.</summary>
    public const int CooldownMs = 3000;

    /// <summary>Cannot UseBandage within this many ms of taking player damage. Distinct from Rest.CombatLockMs.</summary>
    public const int CombatLockMs = 1500;

    /// <summary>XP spent at YardVendor via BuyYardBandage.</summary>
    public const int BuyXpCost = 5;
}
