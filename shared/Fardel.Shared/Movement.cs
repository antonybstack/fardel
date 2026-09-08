namespace Fardel.Shared;

/// <summary>Pure movement helpers for module + clients. No UnityEngine.</summary>
public static class Movement
{
    public const float MaxStepMeters = 0.75f;
    public const float ChunkSizeMeters = 32f;
    public const float SpawnX = 0f;
    public const float SpawnY = 0f;
    public const float SpawnZ = 0f;

    /// <summary>Gravity acceleration (meters per second squared, downward).</summary>
    public const float Gravity = -20f;
    /// <summary>Initial upward velocity when jump intent is true (meters per second).</summary>
    public const float JumpVelocity = 6f;
    /// <summary>Ground Y level (clamped when grounded).</summary>
    public const float GroundY = 0f;
    /// <summary>Coyote time: grace period for jump after leaving ground (microseconds).</summary>
    public const long CoyoteTimeMicros = 50_000L;
    /// <summary>
    /// Scale applied to XZ wish while <c>Y &gt; GroundY</c> (WoW-like air control).
    /// Grounded WASD is unchanged. No schema.
    /// </summary>
    public const float AirControlScale = 0.25f;

    /// <summary>Damp XZ wish while airborne. Call after <see cref="ClampWishStep"/>.</summary>
    public static void ApplyAirControl(ref float dx, ref float dz, float y)
    {
        if (y <= GroundY)
        {
            return;
        }

        dx *= AirControlScale;
        dz *= AirControlScale;
    }

    /// <summary>Clamp a wish displacement to MaxStepMeters (XZ). Y ignored for slice 1.</summary>
    public static void ClampWishStep(ref float dx, ref float dz)
    {
        ClampWishStep(ref dx, ref dz, MaxStepMeters);
    }

    /// <summary>Clamp a wish displacement to an explicit max step (XZ).</summary>
    public static void ClampWishStep(ref float dx, ref float dz, float maxStepMeters)
    {
        var max = maxStepMeters > 0f ? maxStepMeters : MaxStepMeters;
        var lenSq = dx * dx + dz * dz;
        var maxSq = max * max;
        if (lenSq <= maxSq || lenSq <= 1e-12f)
        {
            return;
        }

        var inv = max / MathF.Sqrt(lenSq);
        dx *= inv;
        dz *= inv;
    }

    public static void ChunkCoords(float x, float z, out int chunkX, out int chunkZ)
    {
        chunkX = (int)MathF.Floor(x / ChunkSizeMeters);
        chunkZ = (int)MathF.Floor(z / ChunkSizeMeters);
    }
}
