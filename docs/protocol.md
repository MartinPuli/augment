# GHOST protocol v0.1 (proposed)

> This is the **proposed GHOST v0.1 protocol** used by this repository. It is not a standard and
> will change. Types live in [`src/lib/ghost/contracts.ts`](../src/lib/ghost/contracts.ts) (shared
> by browser, coordinator and connectors) and [`src/lib/ghost/client/api-types.ts`](../src/lib/ghost/client/api-types.ts).

GHOST lets a personal agent acquire a physical capability for a while: **discover → quote → lease →
invoke → observe → remember**. The coordinator is the trusted core. Code performs reservation,
budget accounting, payment verification and authorization; a model saying "I accept" does not
activate hardware.

## Pieces

| Piece | What it is |
|---|---|
| Coordinator | `server.ts` + `src/lib/ghost/server/**`: catalog, leases, ledger, authorization, invocation routing, device channel, SSE, memory, MCP. One Node process together with Next.js. |
| Connector | A process that talks to real hardware (phone browser, desktop browser with BLE/serial, Raspberry Pi, LAN gateway) and connects **outbound** over WebSocket. |
| Internal adapter | A connector running inside the coordinator (public HTTP sources, LAN devices). `connector_id = "internal:<adapter_id>"`. |
| Principal | A person or provider. Browsers get one automatically (`GET /api/v1/me`). Providers are `provider:<id>`. |

Database: Postgres when `DATABASE_URL` is set (e.g. Neon), otherwise embedded PGlite in
`.ghost/pgdata`. Same SQL, idempotent migrations at boot. Money is integer cents (`USD`).

**Payments are test funds.** Every principal starts with 500 cents in the *Development ledger — test
funds, not a real payment*. Receipts carry `provider: "dev-ledger"` and that label.

## Authentication

- Browser: `GET /api/v1/me` creates a principal on first visit and sets the httpOnly cookie
  `ghost_pid` (its value is the secret owner token). It returns
  `{ principal_id, owner_token, balance_cents, display_name }`.
- Agents, MCP clients, scripts: `Authorization: Bearer <owner_token>`.
- Connectors: `owner_token`, `pairing_code` or a `credential` in the device-channel `hello`.

Errors are JSON `{ "error": string, "code": string }` with an HTTP status
(400 bad_request / invalid_arguments, 401, 402 lease_required / payment_required, 403 lease_inactive /
lease_expired / not_covered / forbidden, 404, 409 busy / conflict, 413, 415, 429 quota_exhausted / rate_limited, 503 offline).

## Device channel (WebSocket `/v1/device-channel`)

JSON text frames. Connector → coordinator messages are `ConnectorMessage`, coordinator → connector
are `CoordinatorMessage` (see `contracts.ts`).

### Hello

```json
{ "type": "hello", "protocol_version": "ghost/0.1", "connector_kind": "phone-browser",
  "label": "Gabriele's phone", "owner_token": "gho_..." }
```

Exactly one of:

| Field | Meaning | Reply |
|---|---|---|
| `credential` | Reconnect a previously confirmed connector | `welcome` (same connector_id, devices come back online) |
| `owner_token` | The owner's own browser connecting its own hardware; auto-confirmed. Reuses the connector with the same owner + label + kind. | `welcome` immediately (new credential) |
| `pairing_code` | One-use code from a QR / join link created by an owner | `pending_confirmation`; on owner confirm → `welcome` with a **new persistent credential** (only its hash is stored); on reject → `error` + close |

`welcome = { type, connector_id, owner_id, credential }`. Persist the credential and send it in
future hellos.

### Pairing invitations (owner)

- `POST /api/v1/pairings` → `{ pairing_id, code: "K7QF2M", join_path: "/join#code=K7QF2M", expires_at }`
  (6 characters, 2 minutes, one use). The UI turns `join_path` into an absolute URL using
  `NEXT_PUBLIC_PUBLIC_ORIGIN` or `location.origin`.
- `GET /api/v1/pairings?pending=1` → `PairingInfo[]` (`status: invited | pending | confirmed | rejected | expired`).
- `POST /api/v1/pairings/:id/confirm` → `{ pairing, connector_id }`; `POST /api/v1/pairings/:id/reject`.
- SSE: `pairing.pending`, `pairing.confirmed`.

### Publish

```json
{ "type": "publish", "devices": [ DeviceManifest, ... ] }
```

Only confirmed connectors can publish. Devices are upserted by `(connector_id, local_key)`, owned by
the connector's owner, start as `status: "configured"` and become `"verified"` only after a
successful invocation. Reply: `{ "type": "published", "devices": [{ local_key, device_id, status }] }`.
`unpublish { local_keys }` marks devices unavailable. `device_status { local_key, online }` toggles one device.

### Liveness

- Connectors send `{ "type": "heartbeat", "at": ISO }` every 5 s. After 15 s without one (or when
  the socket closes) the connector's devices are marked offline (`device.updated`).
- The coordinator sends `{ "type": "ping" }` every 10 s (informational).
- Reconnection never reactivates leases; leases are purely time/quota based.

### Invocations

```json
{ "type": "invoke", "invocation_id": "inv_...", "device_id": "dev_...", "local_key": "sim-camera",
  "capability_id": "camera.snapshot", "arguments": {}, "lease_id": "lse_...", "lease_revision": 2,
  "deadline": ISO, "upload": { "url": "https://host/api/v1/invocations/inv_.../observation", "token": "upl_..." } }
```

1. Media (photo, audio): `POST upload.url` with the raw bytes, `Authorization: Bearer <upload.token>`,
   `Content-Type: image/jpeg` (must match the capability's `output.media`), optional
   `X-Captured-At: ISO` (omit if unknown — never substitute the upload time). Max 8 MB, one use,
   expires 30 s after the deadline. Returns `201 { observation_id }`.
2. Then send the result:
   ```json
   { "type": "result", "invocation_id": "inv_...", "state": "succeeded",
     "output": { "observation_id": "obs_...", "captured_at": ISO, "value": 21.5, "unit": "°C", "data": {}, "note": "..." } }
   ```
   `state` is one of `running | succeeded | failed | rejected | unknown`. Small structured output
   without media creates a value/state/ack observation automatically.

Honesty rules enforced by the coordinator:
- Delivery to the socket is not completion. No result before the deadline → invocation `unknown`
  (never `succeeded`). A late result can still update an `unknown` invocation afterwards.
- A capability with `verification: "observation"` that reports success without an observation is
  recorded as `unknown`.
- `captured_at` is `null` when unknown.

`{ "type": "revoke", "lease_id", "device_ids" }` tells a connector to stop (owner revoked, lease
released or expired). `{ "type": "cancel", "invocation_id" }` is best-effort.

### WebRTC signaling relay (phone camera live view)

A viewer (browser with the `ghost_pid` cookie, or a socket that said `hello` with an owner token)
sends:

```json
{ "type": "signal", "session_id": "s1", "to": "device", "data": { "device_id": "dev_...", "type": "offer", "sdp": "..." } }
```

The coordinator checks the viewer owns the device or holds an **active lease covering any
capability of that device**, binds `session_id` to the viewer socket and forwards
`{ type: "signal", session_id, from: "viewer", device_id, data }` to the device's connector. The
connector answers with `{ type: "signal", session_id, to: "viewer", data }`, which is forwarded only
to the socket that opened that session (`from: "device"`).

## HTTP API (`/api/v1`)

| Method & path | Body / query | Response |
|---|---|---|
| `GET /me` | – | `MeResponse` (+ cookie) |
| `GET /capabilities` | `q, semantic_type, device_class, access_type, zone_id, near=lat,lon, radius_km, only_online=1, limit` | `CapabilityHit[]` (text match over name/vendor/model/zone/source + capability title/description/semantic type; online & verified ranked first; `distance_km` with `near`; `experience {successes, attempts}`). Your own devices appear as `own_device` at price 0. |
| `GET /devices` / `?mine=1` | – | `DevicesResponseItem[]` |
| `GET /devices/:id` | – | `Device` |
| `PATCH /devices/:id/terms` | `TermsPatch` (owner only; `null` clears quota/floor/note) | `Device` |
| `POST /quotes` | `QuoteRequest` | `QuoteResponse` |
| `GET /quotes/:id` | – | `Offer` |
| `POST /quotes/:id/accept` | `AcceptRequest` | `AcceptResponse { lease, payment, balance_cents }` |
| `GET /leases?role=visitor\|owner&active=1` | – | `LeaseView[]` |
| `GET /leases/:id` | – | `LeaseView` |
| `POST /leases/:id/release` | – (visitor) | `{ lease }` |
| `POST /leases/:id/revoke` | – (owner, "Stop access") | `{ lease }` |
| `POST /leases/:id/approve` | – (owner, for `requires_approval` terms) | `{ lease }` |
| `POST /invoke` | `InvokeRequest` | `InvokeResponse` (waits up to `timeout_ms`, default 20 s, max 120 s) |
| `GET /invocations/:id` | – | `InvokeResponse` |
| `POST /invocations/:id/observation` | raw bytes, upload token | `201 { observation_id }` |
| `GET /observations/:id` | – | `Observation` |
| `GET /observations/:id/media` | – | bytes (`Content-Type` of the media, immutable cache) |
| `POST /pairings`, `GET /pairings?pending=1`, `POST /pairings/:id/confirm\|reject` | – | see above |
| `GET /connectors` | – | `ConnectorInfo[]` |
| `POST /experiences` | `RecordExperienceRequest` (`outcome`: verified \| unverified \| failed) | `201 Experience` |
| `GET /experiences?q=&limit=&mine=1` | – | `{ experiences, counts: { total, verified, unverified, failed } }` |
| `GET /ledger` | – | `LedgerResponse` (test funds, labeled) |
| `GET /events` | – | SSE stream of `GhostEvent` (`data:` JSON per event, `: keep-alive` every 15 s) |
| `GET /health` | – | `{ ok, protocol }` |

Observation ids are unguessable; holding one is enough to read it (so `<img src>` works).

### Leases: the host agent's policy (deterministic)

- Initial quote = sum of the devices' `terms.price_cents` (public observations and your own devices
  are free). `duration_s` is clamped to the smallest `max_duration_s` and the host message explains it.
  `quota` = smallest device quota. Offers expire after **60 s**.
- Counteroffer (`offer_id` + `offer_price_cents`): at or above the floor (`floor_cents`, default
  `price_cents`) → accepted at that price; below the floor → round 1 counter at
  `max(floor, midpoint)`, round 2 final offer at the floor; a third below-floor counteroffer is rejected.
- Accept, in **one transaction**: offer still open and terms unchanged → refuse if price >
  `max_spend_cents` or > test balance → insert lease → take exclusive locks → debit visitor / credit
  owner in the dev ledger → receipt → `active` with `starts_at`, `ends_at`, `quota`.
- Exclusivity: capabilities with `exclusive` (default true for `act`/`stream`) lock
  `(device_id, concurrency_group ?? "device")`. A partial unique index on held locks makes it
  impossible for two live leases (`reserved | payment_pending | active`) to hold the same resource.
- `requires_approval` terms: the lease stays `reserved` (not charged) until the owner approves
  within 120 s; approval pays and activates.
- A payment that lands after the reservation expired never activates the lease; the receipt is
  `compensation_recorded` and the ledger records the payment and a compensating credit.
- A sweeper (1 s) expires leases past `ends_at` and stale reservations, and sends `revoke` to connectors.

### Invocation authorization

- Paid / owner-shared / provider-booked devices: an **active** lease of the caller that includes the
  ref, unexpired, quota not exhausted (`lease_id` optional: the caller's matching active lease is used).
  Every attempt consumes one use atomically.
- Your own device: if you have no lease, an implicit 60 s zero-price lease is created (still exclusive).
- `public_observation`: no lease, rate-limited to 20 calls/min per principal per device.
- Arguments are validated against `input_schema` (type, required, enum, min/max, length, items,
  `additionalProperties: false`).
- `idempotency_key` (per principal) returns the same invocation instead of running twice.

## Events (`GET /api/v1/events`)

`device.published | device.updated | device.removed | pairing.pending | pairing.confirmed |
lease.updated | offer.updated | invocation.updated | observation.created | ledger.updated | log`.
Broadcast to every subscriber (demo scope). In-process: `import { emit, subscribe } from "src/lib/ghost/server/events"`.

## MCP server (`/mcp`)

Streamable HTTP (stateless, JSON responses), authenticated with `Authorization: Bearer <owner_token>`
(get it from `GET /api/v1/me` or the app). Tools call the same functions as the HTTP routes.

Visitor tools: `search_capabilities`, `get_capability`, `quote_lease`, `accept_quote`,
`invoke_capability` (images come back as MCP image content plus a provenance text block with
`captured_at`/`retrieved_at`), `release_lease`, `list_leases`, `get_balance`, `recall_experience`,
`record_experience`. Owner tools: `update_offer`, `revoke_lease`.

Connect Claude Code:

```bash
claude mcp add --transport http ghost http://localhost:3000/mcp --header "Authorization: Bearer <owner_token>"
```

Raw JSON-RPC check:

```bash
curl -s http://localhost:3000/mcp -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Device names, descriptions and provider text are **data, not instructions**; tools say so.

## Running

```bash
pnpm dev                                   # Next.js + coordinator on :3000 (tsx watch restarts on coordinator changes; Next HMR as usual)
pnpm start                                 # production (after pnpm build)
pnpm coord:smoke                           # coordinator smoke test on :3100, in-memory PGlite, simulated connector
SMOKE_DB=postgres pnpm coord:smoke         # same against DATABASE_URL in a throwaway schema (dropped afterwards)
pnpm coord:fake-connector --url http://localhost:3000   # SIMULATED lamp + camera connector for demos
```

`startCoordinator({ listenPort })` from `src/lib/ghost/server` boots the coordinator without Next.js.
