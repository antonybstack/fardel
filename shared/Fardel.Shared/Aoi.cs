namespace Fardel.Shared;

/// <summary>
/// Chunk AOI helpers (ADR 0001): Moore neighborhood + border hysteresis.
/// Pure — shared by module and headless smokes.
/// </summary>
public static class Aoi
{
    /// <summary>Meters past a new chunk edge before InterestChunk updates.</summary>
    public const float HysteresisMarginMeters = 2f;

    public const int CrowdNearCount = 8;
    public const int CrowdFarCount = 32;
    /// <summary>Far proxies sit this many chunks away from spawn interest.</summary>
    public const int FarChunkOffset = 5;

    /// <summary>
    /// True when pose has crossed deeper than <see cref="HysteresisMarginMeters"/>
    /// past the shared boundary into (poseCx, poseCz), measured only on axes that changed.
    /// </summary>
    public static bool DeepEnoughForInterest(
        float x,
        float z,
        int interestCx,
        int interestCz,
        int poseCx,
        int poseCz)
    {
        if (poseCx == interestCx && poseCz == interestCz)
        {
            return false;
        }

        if (poseCx != interestCx)
        {
            if (poseCx > interestCx)
            {
                // Entered from the left: need x past left edge + margin
                var edge = poseCx * Movement.ChunkSizeMeters;
                if (x < edge + HysteresisMarginMeters)
                {
                    return false;
                }
            }
            else
            {
                // Entered from the right: need x before right edge - margin
                var edge = (poseCx + 1) * Movement.ChunkSizeMeters;
                if (x > edge - HysteresisMarginMeters)
                {
                    return false;
                }
            }
        }

        if (poseCz != interestCz)
        {
            if (poseCz > interestCz)
            {
                var edge = poseCz * Movement.ChunkSizeMeters;
                if (z < edge + HysteresisMarginMeters)
                {
                    return false;
                }
            }
            else
            {
                var edge = (poseCz + 1) * Movement.ChunkSizeMeters;
                if (z > edge - HysteresisMarginMeters)
                {
                    return false;
                }
            }
        }

        return true;
    }

    /// <summary>
    /// Update interest center: keep previous until pose chunk differs AND deep enough in the new chunk.
    /// </summary>
    public static void UpdateInterest(
        float x,
        float z,
        int poseChunkX,
        int poseChunkZ,
        ref int interestChunkX,
        ref int interestChunkZ)
    {
        if (poseChunkX == interestChunkX && poseChunkZ == interestChunkZ)
        {
            return;
        }

        if (DeepEnoughForInterest(x, z, interestChunkX, interestChunkZ, poseChunkX, poseChunkZ))
        {
            interestChunkX = poseChunkX;
            interestChunkZ = poseChunkZ;
        }
    }

    /// <summary>Fill up to 9 Moore neighborhood chunk coords (center + 8). Returns count.</summary>
    public static int FillMooreNeighborhood(int cx, int cz, Span<(int x, int z)> dest)
    {
        var n = 0;
        for (var dz = -1; dz <= 1; dz++)
        {
            for (var dx = -1; dx <= 1; dx++)
            {
                if (n >= dest.Length)
                {
                    return n;
                }

                dest[n++] = (cx + dx, cz + dz);
            }
        }

        return n;
    }

    public static bool InMooreNeighborhood(int interestCx, int interestCz, int chunkX, int chunkZ)
    {
        var dx = chunkX - interestCx;
        var dz = chunkZ - interestCz;
        return dx >= -1 && dx <= 1 && dz >= -1 && dz <= 1;
    }
}
