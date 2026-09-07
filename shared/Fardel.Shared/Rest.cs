namespace Fardel.Shared;

/// <summary>Out-of-combat Rest (bandage-style) — instant heal + cooldown.</summary>
public static class Rest
{
    /// <summary>HP restored per Rest reducer call (clamped to MaxHp).</summary>
    public const int HealAmount = 25;

    /// <summary>Minimum interval between successful Rest calls (ms).</summary>
    public const int CooldownMs = 5000;

    /// <summary>Cannot Rest within this many ms of taking player damage.</summary>
    public const int CombatLockMs = 2500;
}
