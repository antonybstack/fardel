namespace Fardel.Shared;

/// <summary>Public Say / PartySay / Whisper / ChatMessage tunables shared by module and smoke tools.</summary>
public static class Chat
{
    /// <summary>Minimum interval between Say / PartySay / Whisper from the same identity (per channel table).</summary>
    public const int SayMinIntervalMs = 1000;

    /// <summary>Max stored characters after trim (server truncates).</summary>
    public const int SayMaxLen = 120;

    /// <summary>Rolling wholesale window size (oldest pruned) for public, party, and whisper chat.</summary>
    public const int ChatWindowMax = 50;
}
