namespace Fardel.Shared;

/// <summary>Tunables and constants shared by module and client. Keep this assembly free of Unity/SpacetimeDB.</summary>
public static class GameConstants
{
    /// <summary>Default HTTP/WS base for local SpacetimeDB (slice 0).</summary>
    public const string DefaultLocalUri = "http://127.0.0.1:3000";

    /// <summary>Database name used with local publish (see server/spacetime.local.json).</summary>
    public const string DefaultDatabaseName = "fardel";
}
