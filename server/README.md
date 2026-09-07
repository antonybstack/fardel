# Fardel SpacetimeDB module

C# WASI module for local/dev authority.

## Mac note

On macOS, publish with **.NET 8** (`wasi-experimental` workload). `.NET 10` NativeAOT-LLVM is Windows/Linux for now.

```bash
sudo dotnet workload install wasi-experimental
spacetime start   # separate terminal
cd server
spacetime publish
```

Generate Unity bindings (after publish):

```bash
spacetime generate --lang csharp --out-dir ../client/Assets/Scripts/Spacetime/Generated
```
