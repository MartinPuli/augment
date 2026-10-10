# Vercel deployment

GHOST can run entirely on Vercel with an existing Postgres database. WebSockets use Vercel's beta `experimental_upgradeWebSocket` API and require Fluid compute. The local `server.ts` remains available for standalone development.

## Configuration

- `DATABASE_URL`: persistent Postgres; required on Vercel. Embedded PGlite fallback is deliberately disabled there.
- `GHOST_DB_SCHEMA`: use a dedicated production schema, separate from local demos and tests.
- Remove `GHOST_COORDINATOR_ORIGIN` and `NEXT_PUBLIC_GHOST_WS_URL` from previous tunnel deployments. The UI, HTTP API, MCP endpoint, and device channel now use the same origin.
- `NEXT_PUBLIC_PUBLIC_ORIGIN`: the production HTTPS URL used in invitation links.
- Vercel automatically enables distributed routing through `VERCEL=1`. Set `GHOST_DISTRIBUTED=1` to test that behavior outside Vercel.
- Keep the experimental Poppy interface disabled on Vercel: its draft authentication implementation still stores sessions, replay protection, and keys in one process. MCP works at `/mcp` with a GHOST owner token.

The Next routes `/api/v1/*`, `/mcp/*`, and `/v1/device-channel` boot the coordinator inside Functions. Device connections close cleanly after 270 seconds, before the 300-second Function deadline; existing connectors reconnect using their saved credential.

Postgres stores connector presence, short-lived routed messages, and shared rate limits. An invocation may arrive at a different Function than the device connection. It is routed to the current connector session; its caller reads the durable result. Routed commands are claimed once and never automatically replayed after an uncertain delivery. Connector journals and invocation idempotency keys remain necessary for physical actions.

Pairing confirmation and viewer/device signaling also cross instance boundaries. A newer connector connection supersedes the old session. A killed instance's presence expires, and its device becomes offline rather than remaining falsely available. Cold starts never mark other instances' devices offline.

This is a modest-traffic implementation: active instances poll Postgres for delivery. It has not been load tested for a large device fleet. Uploads are subject to Vercel Function payload limits; use external object storage for large media. Agent model usage and hosting/database resources are metered separately.

## Verification

`pnpm exec tsx scripts/distributed-test.ts` starts two independent processes in a unique `ghost_cluster_test_*` Postgres schema. It exercises identity, pairing authorization, cross-instance invocation/results, idempotency, signaling authorization, reconnection, supersession, and offline detection after a process dies. It drops only that generated test schema afterward. Provide `DATABASE_URL` in the environment, or set `GHOST_TEST_ENV` to a private dotenv file.

Also run `pnpm coord:smoke`, TypeScript, ESLint for changed files, and the Next production build. Test a production deployment created with `vercel deploy --prod --skip-domain` before promoting its URL. Verify a real WebSocket handshake and a simulated invocation over the deployed connection, not only the home page.

`.vercelignore` excludes environment files, local database/runtime directories, application notes, and licensed font sources. Never upload `.ghost` or copy local owner credentials into deployment configuration.
