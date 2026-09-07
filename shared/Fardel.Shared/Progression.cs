namespace Fardel.Shared;

/// <summary>
/// Character level from cumulative XP thresholds.
/// Span-first / zero-alloc lookups for module + headless smokes.
/// </summary>
public static class Progression
{
    /// <summary>Highest level on the baked curve (inclusive).</summary>
    public const int MaxLevel = 10;

    /// <summary>
    /// Cumulative XP required to *be* level L (index L).
    /// Level 1 is always 0. One <see cref="Combat.XpPerKill"/> (10) reaches level 2.
    /// </summary>
    // Index:           0  1   2   3   4   5    6    7    8    9   10
    static readonly int[] CumulativeXpForLevel =
        [0, 0, 10, 25, 45, 70, 100, 140, 190, 250, 320];

    /// <summary>Highest level whose cumulative XP threshold is &lt;= <paramref name="xp"/>.</summary>
    public static int LevelFromXp(int xp)
    {
        if (xp < 0)
        {
            xp = 0;
        }

        var level = 1;
        var curve = CumulativeXpForLevel.AsSpan();
        for (var L = 2; L <= MaxLevel && L < curve.Length; L++)
        {
            if (xp < curve[L])
            {
                return level;
            }

            level = L;
        }

        return level;
    }

    /// <summary>XP still needed to reach the next level, or 0 at max.</summary>
    public static int XpToNextLevel(int xp)
    {
        var level = LevelFromXp(xp);
        if (level >= MaxLevel)
        {
            return 0;
        }

        var need = CumulativeXpForLevel[level + 1];
        var rem = need - xp;
        return rem > 0 ? rem : 0;
    }
}
