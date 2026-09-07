namespace Fardel.Shared;

/// <summary>Public Say / ChatMessage tunables shared by module and smoke tools.</summary>
public static class Chat
{
    /// <summary>Minimum interval between Say from the same identity.</summary>
    public const int SayMinIntervalMs = 1000;

    /// <summary>Max stored characters after trim (server truncates).</summary>
    public const int SayMaxLen = 120;

    /// <summary>Rolling wholesale window size (oldest pruned).</summary>
    public const int ChatWindowMax = 50;
}
