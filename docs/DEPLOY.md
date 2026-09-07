# Deploy

How Fardel reaches the internet on **sparkify.dev** (Cloudflare).

## Split surfaces

| Surface | Prod | Dev / preview |
|---|---|---|
| Unity web client | **Cloudflare Pages** → `play.sparkify.dev` (or apex when ready) | Local Unity / Pages preview deploy |
| SpacetimeDB (WS + module) | **MainCloud** or always-on host → `db.sparkify.dev` | **Mac Studio + cloudflared** → `dev-db.sparkify.dev` |

Do **not** make the Mac Studio the permanent shard. Sleep, OS updates, and workstation load will drop players. The tunnel is for friends-and-family playtests and slice demos.

Do **not** open router port 22 (or SpacetimeDB ports) to the world. Prefer cloudflared (or Tailscale for admin SSH only).

## Hostnames (planned)

| Host | Points at |
|---|---|
| `play.sparkify.dev` | Cloudflare Pages (Unity WebGPU/WebGL build) |
| `db.sparkify.dev` | Prod SpacetimeDB (MainCloud custom domain or always-on) |
| `dev-db.sparkify.dev` | cloudflared → `http://127.0.0.1:3000` on the Mac Studio |

Exact hostnames can shift; keep **play** vs **db** vs **dev-db** as separate concerns.

## Dev tunnel (Mac Studio)

### Prerequisites

- Cloudflare account owning `sparkify.dev`
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/) on the Mac
- Local SpacetimeDB: `spacetime start --non-interactive` listening on `127.0.0.1:3000`

### One-time setup

```bash
brew install cloudflared   # or Cloudflare's pkg
cloudflared tunnel login   # browser OAuth → select sparkify.dev zone
cloudflared tunnel create fardel-dev
cloudflared tunnel route dns fardel-dev dev-db.sparkify.dev
```

Config (`~/.cloudflared/config.yml` — tunnel UUID from `tunnel create`):

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: /Users/antbly/.cloudflared/<TUNNEL_UUID>.json

ingress:
  - hostname: dev-db.sparkify.dev
    service: http://127.0.0.1:3000
  - service: http_status:404
```

### Run

```bash
# terminal 1
spacetime start --non-interactive

# terminal 2
cloudflared tunnel run fardel-dev
```

Clients connect with the SpacetimeDB URI for `https://dev-db.sparkify.dev` (WebSocket upgrade via the tunnel). Publish the module to that local host as usual (`spacetime publish … -s local` while developing against the Mac process; remote clients still hit the tunnel hostname).

### Ops notes

- Keep the Mac awake during playtests (or use `caffeinate`).
- Tunnel is outbound-only — no inbound router holes.
- Rotate / revoke via Cloudflare Zero Trust → Networks → Tunnels if the machine is lost.
- When MainCloud (or a VPS) is ready, point `db.sparkify.dev` there and leave `dev-db` as the Mac preview.

## Prod client (Pages)

1. CI (or local) produces the Unity web build.
2. Deploy the build folder to Cloudflare Pages project `fardel` (or similar).
3. Attach custom domain `play.sparkify.dev`.
4. Configure the client’s SpacetimeDB URI to `db.sparkify.dev` (prod) or `dev-db.sparkify.dev` (preview builds).

Cache HTML/JS carefully: the `.data` / wasm payloads are large; prefer hashed asset names and short cache on `index.html`.

## Prod SpacetimeDB

**Preferred v1:** SpacetimeDB MainCloud + custom domain / documented connection URI.  
**Alternative:** always-on Linux VPS (or Cloudflare-adjacent compute) running `spacetimedb-standalone`, still fronted by Cloudflare DNS + optional tunnel or orange-cloud proxy for WS.

Validate early:

- WebSocket connect + `FrameTick` from a Pages origin
- CORS / origin allow behavior for the chosen SpacetimeDB host
- Reconnect after laptop sleep (dev) and after deploy (prod)

## Security baseline

- No SSH on the public internet; admin via Tailscale or physical access
- Tunnel credentials stay on the Mac (`~/.cloudflared/`); never commit them
- Economy / inventory only in reducers (see [ARCHITECTURE.md](ARCHITECTURE.md))
- Preview tunnel is still public DNS — treat `dev-db` as a shared playtest, not a secret

## Status

- [x] Deploy policy documented
- [x] `dev-db.sparkify.dev` on existing Mac `sparkify` tunnel → `127.0.0.1:3000` (HTTP 404 from SpacetimeDB root is healthy)
- [x] **Cloudflare Pages project `fardel` live** — production deployment of `web-placeholder/`; custom domain `play.sparkify.dev` attached (CNAME → `fardel.pages.dev`, proxied)
- [ ] Prod SpacetimeDB (`db.sparkify.dev` or MainCloud URI)

### Tunnel ops note (this machine)

Reuses the existing **`sparkify`** cloudflared LaunchDaemon (`com.cloudflare.sparkify`), config in `/etc/cloudflared/config.yml` (mirror: `~/.cloudflared/config.fardel.yml`). Apex `sparkify.dev` / `sparkify.com` still → `:80`. SpacetimeDB must be **2.10+** if the local data dir was created by 2.10.

### Play on Pages

`play.sparkify.dev` is served by Cloudflare Pages project `fardel` (also https://fardel.pages.dev). The Mac tunnel no longer routes `play`.

`play.sparkify.dev` no longer needs tunnel ingress (DNS points at Pages). **Follow-up:** remove the `play.sparkify.dev` → `:8787` ingress block from the Mac cloudflared configs / LaunchDaemon when convenient (needs sudo on the Studio); interim Mac tunnel can drop play ingress without affecting Pages.

### Play placeholder (Pages)

Production client placeholder is on **Cloudflare Pages**:

- Project: `fardel` → https://fardel.pages.dev
- Source: repo `web-placeholder/` (`index.html` + `_headers`)
- Custom domain: `play.sparkify.dev`
- Deploy: `npx wrangler@4 pages deploy web-placeholder --project-name=fardel --branch main`

Former Mac interim (`python3 -m http.server 8787` + tunnel) is obsolete for play once ingress is cleaned up.
