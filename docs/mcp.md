# GHOST hardware MCP

GHOST provides physical capabilities to an existing agent. It does not run a general-purpose chat agent or expose email, calendars, search engines, cloud browsers or crypto feeds.

## Connect

Create an account at `/dashboard`, name your agent, choose its access level and per-lease test budget. The dashboard issues an agent token once. Add this deployment's `/mcp` endpoint to a client supporting **Streamable HTTP** and set:

```
Authorization: Bearer <AGENT_TOKEN>
```

Each agent has a separate principal and a hashed, revocable credential. It cannot administer the account or change device owners' terms. Scopes are public observations, hardware reads, or hardware reads and actions. Shared devices still require the existing lease/owner approval flow, including hardware owned by the agent's account holder. The per-lease budget is enforced server-side; it is not a daily or cumulative limit.

`/dashboard` shows the latest 50 MCP requests and physical invocations, refreshing every three seconds. All recorded calls remain in Postgres. Interrupted calls may have unknown outcomes; completed MCP calls are distinct from successful physical invocations. Revocation blocks the next request and attempts to release all active agent leases. Already-dispatched actions may finish.

Accounts use a username and password (12–256 characters), salted scrypt hashes, an HTTP-only same-site cookie and login rate limits. Password recovery and email verification are not implemented. Existing browser identities can be registered without losing their devices. Legacy owner-token MCP clients still work for compatibility; the UI never asks users to give agents an owner token.

The server uses stateless Streamable HTTP. Clients must accept `application/json, text/event-stream`. It does not currently provide OAuth discovery for clients that only support OAuth and cannot supply a bearer header.

## Workflow

1. `search_capabilities`: find actual registered hardware, optionally by device class, location, access type or semantic capability.
2. `get_capability`: inspect the input schema, access terms, online status and verification method.
3. For shared hardware, `quote_lease` and `accept_quote` within the user's budget. Wait for approval when required. Public observations need no lease.
4. `invoke_capability`: use the documented arguments and an idempotency key. Reuse that key if the outcome is uncertain.
5. Inspect the observation. An acknowledgment is not proof of a physical outcome. Capture time and retrieval time are different.
6. `release_lease` when finished. Owners can revoke access in `/owner`.

`recall_device_connections` and the experience tools preserve actual history. `list_hardware_guides` and `read_hardware_guide` explain supported setups; guides never confer access. The MCP resource `ghost://hardware/workflow` and initialization instructions describe these rules to clients.

## Hardware access

A listing requires a supported connector and owner authorization or an operator-published observation source. GHOST does not provide universal access to arbitrary hardware. Robot fleets such as FrodoBots are not integrated. Payment accounting currently uses **test funds**, not actual rentals or payouts.

## Headless deployment

```sh
pnpm install
pnpm coordinator
```

Defaults to `127.0.0.1:3000`. Set `HOST` and `PORT` explicitly for your host. The coordinator exposes `/mcp`, `/api/v1/*` and `/v1/device-channel` without Next.js or model credentials. It uses embedded PGlite unless `DATABASE_URL` is configured. Use trusted HTTPS for remote clients and phone cameras; see [Vercel deployment](vercel.md).

The optional web interface only supports accounts, agent permissions and activity (`/dashboard`), MCP guidance (`/connect`), hardware discovery (`/`), device pairing (`/devices`, `/join`) and owner permissions (`/owner`). `/connectors` redirects to physical device setup. The former chat/voice APIs and software integration routes are removed from the active product. Historical software-device records remain in the database but cannot be discovered or invoked.
