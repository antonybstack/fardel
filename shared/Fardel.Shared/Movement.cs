namespace Fardel.Shared;

/// <summary>Pure movement helpers for module + clients. No UnityEngine.</summary>
public static class Movement
{
    public const float MaxStepMeters = 0.75f;
    public const float ChunkSizeMeters = 32f;
    public const float SpawnX = 0f;
    public const float SpawnY = 0f;
    public const float SpawnZ = 0f;

    /// <summary>Clamp a wish displacement to MaxStepMeters (XZ). Y ignored for slice 1.</summary>
    public static void ClampWishStep(ref float dx, ref float dz)
    {
        var lenSq = dx * dx + dz * dz;
        var maxSq = MaxStepMeters * MaxStepMeters;
        if (lenSq <= maxSq || lenSq <= 1e-12f)
        {
            return;
        }

        var inv = MaxStepMeters / MathF.Sqrt(lenSq);
        dx *= inv;
        dz *= inv;
    }

    public static void ChunkCoords(float x, float z, out int chunkX, out int chunkZ)
    {
        chunkX = (int)MathF.Floor(x / ChunkSizeMeters);
        chunkZ = (int)MathF.Floor(z / ChunkSizeMeters);
    }
}
