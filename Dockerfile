# syntax=docker/dockerfile:1
# GHOST: Next.js 16 app + coordinator (Hono /api/v1, /mcp, WebSocket /v1/device-channel)
# served by one custom Node server (server.ts, run with tsx).
#
#   docker build -t ghost --build-arg NEXT_PUBLIC_PUBLIC_ORIGIN=https://<app>.fly.dev .
#   docker run -p 3000:3000 -v ghost-data:/app/.ghost -e ANTHROPIC_API_KEY=... ghost
#
# Node >= 22.13 is required by Mastra (missions). Secrets are runtime env only; never baked in.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    MASTRA_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.7.1 --activate
WORKDIR /app

# ---- build: install all deps (tsx is needed at runtime) and build Next.js ----
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# NEXT_PUBLIC_* values are inlined into the browser bundle at build time.
ARG NEXT_PUBLIC_PUBLIC_ORIGIN=""
# Optional Interfere: the public key is safe to expose; the secret key (needed by production
# builds to publish release metadata/source maps) is a BuildKit secret, never a layer:
#   fly deploy --build-arg INTERFERE_PUBLIC_KEY=... --build-secret INTERFERE_API_KEY=...
ARG INTERFERE_PUBLIC_KEY=""
ARG INTERFERE_ENVIRONMENT="production"
ENV NEXT_PUBLIC_PUBLIC_ORIGIN=$NEXT_PUBLIC_PUBLIC_ORIGIN \
    INTERFERE_PUBLIC_KEY=$INTERFERE_PUBLIC_KEY \
    INTERFERE_ENVIRONMENT=$INTERFERE_ENVIRONMENT
RUN --mount=type=secret,id=INTERFERE_API_KEY \
    INTERFERE_API_KEY="$(cat /run/secrets/INTERFERE_API_KEY 2>/dev/null || true)" pnpm build \
    && rm -rf .next/cache

# ---- runtime ----
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0
COPY --from=build /app /app
# PGlite data (.ghost/pgdata) and Mastra mission storage (.ghost/mastra.db) when DATABASE_URL is
# unset. Mount a volume here (fly.toml does) or the data is lost on every deploy.
# Runs as root on purpose: Fly volumes mount root-owned, and PGlite must write to them.
RUN mkdir -p /app/.ghost
EXPOSE 3000
CMD ["node", "--import", "tsx", "server.ts"]
