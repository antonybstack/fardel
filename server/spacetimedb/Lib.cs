using Fardel.Shared;
using SpacetimeDB;

public static partial class Module
{
    [SpacetimeDB.Table(Accessor = "PlayerPose", Public = true)]
    public partial struct PlayerPose
    {
        [SpacetimeDB.PrimaryKey]
        public Identity Identity;
        public float X;
        public float Y;
        public float Z;
        public float Yaw;
        public int ChunkX;
        public int ChunkZ;
    }

    [SpacetimeDB.Reducer(ReducerKind.ClientConnected)]
    public static void ClientConnected(ReducerContext ctx)
    {
        Log.Info($"Client connected: {ctx.Sender}");
        if (ctx.Db.PlayerPose.Identity.Find(ctx.Sender) is not null)
        {
            return;
        }

        Movement.ChunkCoords(Movement.SpawnX, Movement.SpawnZ, out var cx, out var cz);
        ctx.Db.PlayerPose.Insert(new PlayerPose
        {
            Identity = ctx.Sender,
            X = Movement.SpawnX,
            Y = Movement.SpawnY,
            Z = Movement.SpawnZ,
            Yaw = 0f,
            ChunkX = cx,
            ChunkZ = cz,
        });
    }

    [SpacetimeDB.Reducer(ReducerKind.ClientDisconnected)]
    public static void ClientDisconnected(ReducerContext ctx)
    {
        Log.Info($"Client disconnected: {ctx.Sender}");
        if (ctx.Db.PlayerPose.Identity.Find(ctx.Sender) is { } pose)
        {
            ctx.Db.PlayerPose.Identity.Delete(pose.Identity);
        }
    }

    /// <summary>
    /// Slice 1 intent: client sends a wish displacement; server clamps and writes pose.
    /// </summary>
    [SpacetimeDB.Reducer]
    public static void Move(ReducerContext ctx, float dx, float dz)
    {
        var pose = ctx.Db.PlayerPose.Identity.Find(ctx.Sender)
            ?? throw new Exception("PlayerPose missing; connect should have spawned one");

        Movement.ClampWishStep(ref dx, ref dz);
        var x = pose.X + dx;
        var z = pose.Z + dz;
        Movement.ChunkCoords(x, z, out var cx, out var cz);

        pose.X = x;
        pose.Z = z;
        pose.ChunkX = cx;
        pose.ChunkZ = cz;
        ctx.Db.PlayerPose.Identity.Update(pose);
    }
}
