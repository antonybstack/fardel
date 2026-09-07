# Slice 0 — local connect

## Prereqs

1. Unity **6000.6+** (installed)
2. SpacetimeDB CLI 2.10+
3. .NET 8 + WASI workload (macOS module publish):

```bash
sudo dotnet workload install wasi-experimental
```

## Run

```bash
# Terminal A
spacetime start

# Terminal B
cd server
spacetime publish
spacetime generate --lang csharp --out-dir ../client/Assets/Scripts/Spacetime/Generated
```

Open `client/` in Unity 6000.6, menu **Fardel → Setup Connect Scene** (or open `Assets/Scenes/Connect.unity`), Play.

**Done when:** Play Mode HUD shows **Connected** and an identity.
