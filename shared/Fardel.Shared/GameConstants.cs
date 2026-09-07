namespace Fardel.Shared;

/// <summary>Tunables and constants shared by module and client. Keep this assembly free of Unity/SpacetimeDB.</summary>
public static class GameConstants
{
    /// <summary>Default HTTP/WS base for local SpacetimeDB (slice 0).</summary>
    public const string DefaultLocalUri = "http://127.0.0.1:3000";

    /// <summary>Database name used with local publish (see server/spacetime.local.json).</summary>
    public const string DefaultDatabaseName = "fardel";

    /// <summary>
    /// Seat-aware Spacetime URI: <c>FARDEL_SPACETIME_URI</c> when set (e.g. after
    /// <c>source tools/scripts/wt-env.sh &lt;slug&gt;</c>), else <see cref="DefaultLocalUri"/>.
    /// </summary>
    public static string ResolveLocalUri()
    {
        var env = Environment.GetEnvironmentVariable("FARDEL_SPACETIME_URI");
        return string.IsNullOrWhiteSpace(env) ? DefaultLocalUri : env.Trim();
    }

    /// <summary>
    /// Seat-aware database name: <c>FARDEL_DB</c> when set, else <see cref="DefaultDatabaseName"/>.
    /// </summary>
    public static string ResolveDatabaseName()
    {
        var env = Environment.GetEnvironmentVariable("FARDEL_DB");
        return string.IsNullOrWhiteSpace(env) ? DefaultDatabaseName : env.Trim();
    }
}
