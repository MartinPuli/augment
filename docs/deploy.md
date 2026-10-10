# Deploying GHOST to Fly.io

GHOST runs as a single Node process (`server.ts`). It serves the Next.js app, the coordinator API
(`/api/v1`, `/mcp`) and the device channel WebSocket (`/v1/device-channel`).

Phones need a trusted HTTPS origin before the browser will grant camera, microphone or motion
access. A Fly app gives you one at `https://<app>.fly.dev`.

Nothing here is required for local development: `pnpm dev` runs everything on your laptop with
embedded Postgres (PGlite).

## What the repo contains

| File | Purpose |
| --- | --- |
| `Dockerfile` | Uses Node 22 (bookworm-slim) and pnpm 10. Runs `pnpm install --frozen-lockfile` and `next build`, then starts with `node --import tsx server.ts` and `NODE_ENV=production`. |
| `.dockerignore` | Keeps `.env*`, `.ghost/`, `.mastra/`, `node_modules/`, `.next/` and `.git/` out of the build context. |
| `fly.toml` | Runs one always-on machine (`auto_stop_machines = "off"`, `min_machines_running = 1`). Forces HTTPS, counts concurrency by connections (WebSockets), health-checks `/api/v1/health`, and mounts the `ghost_data` volume at `/app/.ghost`. |

How this was verified locally (Docker Desktop was not running, so the image itself was not built):

- `pnpm build` succeeds.
- `NODE_ENV=production node --import tsx server.ts` (the image's `CMD`) boots.
- `/api/v1/health` and `/` both return 200 under that command.
- SIGTERM shuts the server down cleanly.

## 1. One-time setup

```bash
brew install flyctl            # or: curl -L https://fly.io/install.sh | sh
fly auth login

# Pick a unique app name and put it in fly.toml (`app = ...`) and in both NEXT_PUBLIC_PUBLIC_ORIGIN lines.
fly launch --no-deploy --copy-config --name ghost-<you> --region sjc

# Volume for embedded Postgres + mission storage (only needed when DATABASE_URL is unset,
# but harmless otherwise). Size in GB.
fly volumes create ghost_data --size 1 --region sjc
```

## 2. Secrets (runtime only, never baked into the image)

```bash
# Claude: either a direct Anthropic key ...
fly secrets set ANTHROPIC_API_KEY=sk-ant-...
# ... or the Neon AI Gateway (see docs/partners-infra.md)
fly secrets set NEON_AI_GATEWAY_BASE_URL=https://br-xxx-api.ai.c-7.us-east-2.aws.neon.tech \
                NEON_AI_GATEWAY_TOKEN=nt_live_...

# Neon Postgres (recommended in production; pooled string, host ends in -pooler)
fly secrets set DATABASE_URL='postgresql://user:pass@ep-xxx-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require'

# Optional partners: EXA_API_KEY, KERNEL_API_KEY, AGENTMAIL_API_KEY, ELEVENLABS_API_KEY,
# MASTRA_PLATFORM_ACCESS_TOKEN + MASTRA_PROJECT_ID, INTERFERE_PUBLIC_KEY, ...
```

When `DATABASE_URL` is set, both the coordinator tables and the Mastra mission snapshots
(schema `mastra`) live in Neon. Data then survives redeploys, and you can inspect it from the
Neon console.

Without `DATABASE_URL`, both live on the `ghost_data` volume.

## 3. Deploy

```bash
fly deploy --ha=false
# Optional Interfere build integration (needs both keys; the secret one is a BuildKit secret):
fly deploy --ha=false --build-arg INTERFERE_PUBLIC_KEY=interfere_public_us_... \
           --build-secret INTERFERE_API_KEY=interfere_secret_us_...

fly status          # machine started, health check passing
fly logs            # "> GHOST ready on http://localhost:3000 (production)"
curl https://ghost-<you>.fly.dev/api/v1/health
```

Use `--ha=false` on the first deployment so Fly does not create a spare coordinator. Keep exactly one machine:

```bash
fly scale count 1
```

The coordinator keeps live state in memory, so a second machine would split devices between two
coordinators. That state includes connector sockets, invocation waiters, rate limits, and the
credentials of running missions.

## 4. Pair phones and devices

1. Open `https://ghost-<you>.fly.dev` on your laptop. It creates your principal and sets a cookie.
2. Click "Pair phone" and scan the QR code with the phone.
   - The QR code uses `NEXT_PUBLIC_PUBLIC_ORIGIN`, so it points at the Fly URL rather than at localhost.
   - The phone opens `/join#code=...` over HTTPS and can then grant camera and motion access.
3. Confirm the pairing in the owner console. The phone's sensors then show up as devices.
4. Other connectors use the same origin:
   - Raspberry Pi: `connectors/raspberry`.
   - Desktop browser holding BLE or serial devices.
   - Both connect **outbound** to `wss://ghost-<you>.fly.dev/v1/device-channel`, so no inbound ports are needed at home.

`NEXT_PUBLIC_PUBLIC_ORIGIN` is read in two places:

- **The browser bundle (build time).** This is why it is a build arg in `fly.toml`.
- **The server (runtime).** It is used for upload URLs sent to connectors.

If you rename the app, update both and redeploy.

### Limits of a cloud deployment

The built-in LAN adapters cannot see your home network from Fly. These include Shelly, WLED,
Hue and Home Assistant on a private IP.

To use them with a cloud coordinator, run a connector on the LAN (a `lan-gateway` connector or
the Pi connector), or run GHOST locally and expose it with a tunnel.

## Troubleshooting

- **Health check fails right after deploy.**
  - The first boot runs database migrations and prepares Next.js.
  - The check allows a 30 s grace period. Look at `fly logs`.
- **Phones cannot open the camera.** Make sure you opened the `https://` URL. `force_https` redirects plain HTTP.
- **Mission runs are lost after deploy.** Set `DATABASE_URL` (Neon), or check that the `ghost_data` volume is attached (`fly volumes list`).
- **`pnpm install --frozen-lockfile` fails in the build.** Commit an up-to-date `pnpm-lock.yaml`.
