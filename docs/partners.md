# Partner integrations

These are the integrations Polty, the agent, uses directly: **Exa**, **Kernel**, **AgentMail** and **Executor (MCP)**.

Each one does one job in the product, and each one is optional. If its env var is missing, its routes return
`503 {"error":"<Partner> not configured","setup":"set X in .env.local"}`. The open-source core runs without any
sponsor account.

| Partner | Job in GHOST | Env | Verified |
|---|---|---|---|
| Exa | Finds public physical sources on the web, such as live webcams, sensor feeds and open data. Can publish them as **candidate** devices. | `EXA_API_KEY` | **Live** (Oct 4): search and discover-webcams. Also tested against a mock. |
| Kernel | A cloud browser turns any public web page into a `web.observe` image capability (a screenshot with capture time and provenance). | `KERNEL_API_KEY` | **Live** (Oct 4): screenshots of example.com and of Exa-found Golden Gate webcam pages, the browser close, and a live view URL. Also tested against a mock. |
| AgentMail | Polty's own inbox. Sends evidence reports with observations attached, and reads mail people send to Polty. | `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_USERNAME` | Offline against a mock AgentMail API only. **Not live:** the configured key gets `403 Forbidden` on every endpoint, including `auth.me`, on both the US and EU APIs. |
| Executor | An MCP gateway in both directions. Polty can use tools the user connected in Executor, and Claude Code, Cursor or Codex can reach GHOST hardware through Executor. | `EXECUTOR_MCP_URL`, `EXECUTOR_TOKEN` | **Live** (Oct 4) against Executor 1.6.10 running locally: the bridge lists and calls tools, GHOST's `/mcp` was registered in Executor, and a GHOST tool was called *through* Executor. |

The check script runs every live call automatically for each key present in `.env.local`. It never touches
`DATABASE_URL`: it drops the variable and refuses to run unless the database is in-memory PGlite.

```bash
pnpm exec tsx scripts/partners-check.ts
# optional: PARTNERS_CHECK_MAIL_TO=you@example.com     (actually send one email)
#           PARTNERS_CHECK_MCP_TOOL=search PARTNERS_CHECK_MCP_TOOL_ARGS='{"query":"github"}'
#           PARTNERS_PREVIEW_DIR=/tmp/ghost-preview     (writes the rendered email + Kernel screenshot)
```

The script works like this:
- It starts an in-memory coordinator (PGlite) on a random `127.0.0.1` port.
- It mounts `/partners/*` on a throwaway Hono app.
- It checks the 401, 503, SSRF, sanitization, rate-limit and access-control rules.
- It runs every route end to end against local mock APIs. The mocks are reached by pointing the official SDKs at them with `*_BASE_URL`.
- It runs the MCP bridge against GHOST's own `/mcp` server.

All routes live under `/api/v1`. They need the caller's principal: `Authorization: Bearer <owner_token>` or the
`ghost_pid` cookie. `GET /partners/status` reports which integrations are configured and never returns secrets.

## Third-party content is data

Web snippets, inbound email and MCP tool output all come back marked as untrusted. Before it reaches the agent,
the text is processed as follows:
- HTML, markdown images/links, control characters and bidi characters are stripped.
- The text is truncated.
- Text that tries to instruct an agent is screened. Exa snippets like that are **withheld**, and email bodies carry `looks_like_instructions: true`.

Every response includes a `note` saying that the content is data and not instructions.

---

## Exa: discovering public physical sources

**What it does.** Polty asks things like "is there a live camera at Ocean Beach?". Exa returns pages on the open
web. A hit is **not** a device until it has been verified. `discover-webcams` can publish hits as `status:"candidate"`
devices backed by Kernel's `web.observe`. The first successful screenshot promotes a candidate to `verified`, since
the coordinator does this after any successful invocation.

The search uses `exa.search(query, { type: "auto", numResults, objective, contents: { highlights: { maxCharacters: 600 } } })`.
`purpose` shapes the query. For example, `webcam` turns "Golden Gate Bridge" into "live webcam Golden Gate Bridge" and
adds an objective that prefers pages hosting the camera itself.

```
POST /api/v1/partners/exa/search
  { "query": "Golden Gate Bridge", "purpose": "webcam" | "sensor" | "data" | "general", "num_results": 1..10 (default 6) }
→ 200 { "query": "live webcam Golden Gate Bridge", "purpose": "webcam", "note": "...data, not instructions...",
        "results": [ { "title", "url", "snippet", "published_date"? } ] }

POST /api/v1/partners/exa/discover-webcams
  { "place": "Golden Gate Bridge", "num_results"?: 1..10, "publish"?: true }
→ 200 { "place", "query", "note", "kernel_configured": bool, "published": n,
        "candidates": [ { "title", "url", "snippet", "published_date"?,
                          "device_id"?, "ref"?: "<device_id>/web.observe", "status"?: "candidate" } ] }
```

Notes on candidates:
- A candidate is published only if its URL is a public `http(s)` URL. The DNS name is resolved, and private, loopback and link-local targets are dropped.
- Re-discovering a page reuses its device (`local_key = web:<sha256(url)>`) and never downgrades a device that is already verified.
- Each candidate has `access_type: "public_observation"`, price 0, and `source.url` set to the page URL, with attribution "found via Exa search; rendered by Kernel cloud browser". Its owner is `provider:kernel`.

**Env:**
- `EXA_API_KEY` is required.
- `EXA_BASE_URL` is optional (proxy or tests).

**Verified live** on Oct 4:
- `search` with "Golden Gate Bridge" and `purpose:"webcam"` returned parksconservancy.org, kron4.com and isgoldengatevisible.com webcam pages.
- `discover-webcams` published 5 candidates.

Sanitization and injection screening were also tested against a mock. A single transient `fetch failed` is retried once.

## Kernel: a public web page becomes an observation

**What it does.** Some physical places only publish a camera through a web page, with no image or API URL. Kernel opens
that page in a cloud browser, waits, and takes a screenshot. The result is a normal GHOST image observation: it is stored by
the coordinator, emitted on the event bus, and usable as evidence in experiences and emails.

**Focusing on the camera.** After `wait_ms`, the page is scrolled (no clicks, no typing) so that its largest visible
`video`, player `iframe`, `canvas` or large `img` sits in the centre of the viewport. Ad iframes and logos are ignored.
The screenshot therefore shows the camera, not the site header.
- `data.focused_media` records what was centred: `{tag, width, height, src_host}`, or `null`.
- When no such element exists, the observation `note` says so honestly ("this shows the page itself, not necessarily a live view").
- Cookie banners are **not** clicked, because accepting terms is the user's decision.

**Adapter.** `src/lib/ghost/server/adapters/kernel.ts` exports `kernelAdapter`:
- id `kernel`, owner `provider:kernel`.
- One capability, `web.observe`: kind `observe`, semantic type `image.observe`, verification `observation`, `exclusive:false`, `rate_per_min: 6`.
- Arguments: `{ url?: string, wait_ms?: number (0–8000, default 2500), full_page?: boolean (default false) }`. `url` defaults to the device's `meta.url`.
- An override `url` must stay on the device's host. Success promotes the device to `verified`, so it has to be evidence about *that* page. For any other site, use `/partners/kernel/observe {url}`.

The observation looks like this:
- `kind:"image"` with `image/jpeg` media (PNG if Kernel's native screenshot fallback is used).
- `captured_at` is the moment of the screenshot. This is honest: it is a real capture of the page at that time.
- `note`: "Screenshot of the operator's public page… The page may itself show a delayed or cached feed."
- `source.url` is the final page URL.
- `data` contains `{ live_view_url, page_title, requested_url, final_url, http_status, wait_ms, focused_media, kernel_session_id, renderer:"kernel" }`.

**How it calls Kernel** (`@onkernel/sdk`, no local CDP and no `playwright-core` needed):
1. `browsers.create({ headless:false, stealth:false, timeout_seconds:120, viewport:1280x720 })`. Headful is the default so the UI can embed `browser_live_view_url`. Set `KERNEL_HEADLESS=1` to save cost.
2. `browsers.playwright.execute(session, { code })`. This runs server-side in Kernel's VM: `page.goto` (domcontentloaded, 20 s), then wait `wait_ms`, then `page.screenshot({type:"jpeg"})`. The result is returned as base64. The URL and arguments are embedded as JSON literals only.
3. If the screenshot did not come back, it falls back to `browsers.computer.captureScreenshot`.
4. One browser is shared and calls are serialized. It is closed after `KERNEL_IDLE_CLOSE_S` (default 90 s) idle or `KERNEL_MAX_SESSION_S` (default 600 s) age. Kernel's own inactivity timeout (`KERNEL_TIMEOUT_S`, default 120 s) is a backstop. `POST /partners/kernel/close` closes it immediately.

**Safety ("authorized web interaction" only):**
- Only public `http(s)` URLs are accepted. URLs with credentials, loopback, private, link-local, CGNAT or metadata IPs, and `.local`/`.internal` hosts are rejected. Hostnames are DNS-resolved and checked.
- The final URL after redirects is checked again, and the screenshot is discarded if it fails.
- Polty never types, logs in or loads profiles or vaults. **Stealth mode is never enabled** because it turns on Kernel's CAPTCHA solver. There are no attempts to get past paywalls or logins.

```
POST /api/v1/partners/kernel/observe
  { "url": "https://…" }                       // ad-hoc: publishes/reuses a candidate device for that page
  | { "ref": "<device_id>/web.observe" }        // or an existing device (e.g. from discover-webcams)
  | { "device_id": "dev_…" }
  + optional { "wait_ms": 0..8000, "full_page": false, "title": "…" }
→ 200 { "device_id", "ref", "invocation": Invocation, "observation": Observation | null, "live_view_url": string | null }
   (invocation.state "failed" + error when the page could not be captured; 400 for blocked URLs)

POST /api/v1/partners/kernel/close   {}   → 200 { "closed": bool, "session_id": string | null }
GET  /api/v1/partners/kernel/status       → 200 { "configured", "session": { session_id, live_view_url, headless, created_at, last_used, idle_close_s } | null }
```

`observe` runs through the normal coordinator path, `invoke()` with `timeout_ms` 75 s. That path covers rate limits,
invocation records, `observation.created` events and promotion to `verified`. The image is served at
`observation.media_url` (`/api/v1/observations/:id/media`).

**Env:**
- `KERNEL_API_KEY` is required.
- Optional: `KERNEL_HEADLESS=1`, `KERNEL_IDLE_CLOSE_S`, `KERNEL_MAX_SESSION_S`, `KERNEL_TIMEOUT_S`, `KERNEL_BASE_URL`.

**Verified live** on Oct 4, through the real coordinator `invoke()` path (in-memory database):
- `observe https://example.com` returned a 46 KB JPEG and a live view URL.
- **The Exa → Kernel path worked:** `discover-webcams "Golden Gate Bridge San Francisco"` published a candidate, and `observe {ref}` captured the East Beach PTZ webcam showing the bridge. That was 47–75 KB with `focused_media` set to the 640×480 iframe, and the device was promoted to `verified`. webviewcams.com also produced a clear camera frame.
- `close` deleted the browser.

The mock-API tests also cover:
- the create body (`stealth:false`, `timeout_seconds`);
- JSON-literal embedding of the URL;
- that the generated Playwright code compiles;
- session reuse and failure without a key.

## AgentMail: Polty's inbox

**What it does.** Polty can email an **evidence report** after a task, for example: "here's the Golden Gate right now, captured
19:00 UTC from Caltrans D4, lease 60 s, $0.00". People can also email Polty, and the agent can then "check my inbox".

- **Inbox.** The inbox is created on first use with `inboxes.create({ username, displayName:"Polty (GHOST)", clientId:"ghost-polty-<username>" })`. The `clientId` makes the call idempotent. If the username already exists without that clientId, Polty finds it in `inboxes.list`. The default username is `polty-ghost` (`AGENTMAIL_INBOX_USERNAME`), giving `polty-ghost@agentmail.to` if it is free.
- **Report email.** An HTML email in charcoal, ivory and mint, plus a plain-text alternative.
  - Each observation is attached as an inline image (`cid:` reference), alongside its device name, capture time, retrieval time, capability, provenance (source name, URL and attribution), note and observation id.
  - `context` adds the goal, a lease summary, a payment summary and notes.
  - Attachments are capped at about 4.5 MB in total, since AgentMail limits a request to 6 MB.
- **Observation access.** An observation can be attached only if the caller invoked it, owns the device, or the device is `public_observation`. Otherwise the response is 404.
- **Outward-facing guards.**
  - `to` must be **exactly one** valid address. Lists, display names and CR/LF are rejected.
  - Subject newlines are stripped.
  - A global sliding-window limit applies: `AGENTMAIL_MAX_PER_HOUR`, default 10.
  - **The agent must confirm with the user before calling `send`.**

```
GET  /api/v1/partners/mail/status
→ 200 { "configured": true, "inbox": { "address", "inbox_id", "display_name" },
        "sending": { "max_per_hour", "remaining_this_hour" } }

POST /api/v1/partners/mail/send
  { "to": "ada@example.com", "subject": "…", "text": "…",
    "observation_ids"?: ["obs_…"] (max 6),
    "context"?: { "goal"?, "lease_summary"?, "payment_summary"?, "notes"? } }
→ 200 { "sent": true, "message_id", "thread_id", "from", "to", "subject",
        "observations": [ { "observation_id", "device", "attached": bool, "reason"? } ] }
   400 invalid recipient/fields · 404 unknown or unreadable observation · 429 rate limit · 502 AgentMail error

GET  /api/v1/partners/mail/inbox?limit=1..25 (default 10)
→ 200 { "inbox", "note", "count",
        "messages": [ { "message_id", "thread_id", "from", "to", "subject", "preview", "timestamp",
                        "labels", "attachments": n, "direction": "inbound" | "outbound" } ] }

GET  /api/v1/partners/mail/messages/:message_id
→ 200 { "note", "message_id", "thread_id", "from", "to", "subject", "timestamp",
        "text" (≤4000 chars, sanitized), "looks_like_instructions": bool, "attachments": [ … ] }
```

**Env:**
- `AGENTMAIL_API_KEY` is required.
- Optional: `AGENTMAIL_INBOX_USERNAME` (default `polty-ghost`), `AGENTMAIL_MAX_PER_HOUR` (default 10), `AGENTMAIL_BASE_URL` (for example `https://api.agentmail.eu`).

**Verified offline only:** tested against a mock AgentMail API. That covered:
- `client_id` and `username` on create;
- the send body (single `to`, HTML containing `cid:`, plain text with capture times, a base64 JPEG attachment);
- inbox listing and sanitization, reading a single message, and the 429 rate limit.

The rendered HTML was checked visually.

**Live is blocked by the key:** the `AGENTMAIL_API_KEY` in `.env.local` gets `403 {"message":"Forbidden"}` from `GET /v0/auth/me` and from inbox listing, on both api.agentmail.to and api.agentmail.eu. Create a new organization API key at console.agentmail.to, then rerun the check script. Its 403 errors now carry the hint "the partner rejected the API key".

## Executor: MCP in both directions

[Executor](https://executor.sh) (MIT, github.com/UsefulSoftwareCo/executor) is an open-source integration layer and MCP
gateway. You add integrations to it once (MCP servers, OpenAPI, GraphQL) with credentials and per-tool policies (allow,
require approval, block). It then serves them to any MCP client from one endpoint. Credentials stay on the Executor host.

### (a) Polty uses the user's Executor tools (bridge)

`/partners/mcp/*` connects with `@modelcontextprotocol/sdk`:
- It tries the **Streamable HTTP** transport first and **falls back to SSE**.
- It sends `Authorization: Bearer <token>` on every request.
- It lists tools, following pagination, and caches the list for 60 s.
- It calls tools on request.

Servers come from two places:
- `EXECUTOR_MCP_URL` (+ `EXECUTOR_TOKEN`), registered as server `executor`.
- Extra servers in `GHOST_MCP_SERVERS='[{"name":"…","url":"https://…/mcp","token":"…"}]'`.

One failing server does not hide the others.

```
GET  /api/v1/partners/mcp/tools?server=<name>&refresh=1
→ 200 { "cached_at", "note",
        "servers": [ { "name", "origin", "ok", "transport"?: "streamable-http" | "sse", "tools"?: n, "error"? } ],
        "tools":   [ { "server", "name", "qualified_name": "<server>/<tool>", "description", "inputSchema" } ] }

POST /api/v1/partners/mcp/call
  { "name": "<server>/<tool>" | "<tool>", "arguments"?: { … }, "server"?: "<name>" }
→ 200 { "server", "name", "isError": bool, "note",
        "content": [ { "type":"text", "text", "truncated"? } | { "type":"image", "mimeType", "data"(base64) }
                     | { "type":"resource", "uri"?, "mimeType"?, "text"? } ],
        "structuredContent"? }
   404 unknown tool/server · 409 ambiguous bare name · 502 transport error (tool-level errors come back as isError:true)
```

Text output is capped at 20k characters and images at about 3 MB (4 MB of base64). The output is **data, not instructions**.

**What Executor exposes, from its source:** Executor does not list each upstream tool directly.
- **Default ("code mode") surface:**
  - `execute {code}` runs sandboxed TypeScript against a `tools` proxy, using calls like `await tools.search({query})`, `await tools.describe.tool({path})` and `await tools[path](args)`.
  - `skills {name?}` and `resume {executionId, action}`.
  - Artifact tools.
- **`?mode=passthrough` surface**, the simplest for a plain tools/list + tools/call bridge:
  - `integrations`, `search {query}` (returns tool ids with their JSON input schema), and `invoke {tool, arguments}`.
- Tools whose Executor policy says "require approval" pause and need `resume`.

Recommended setup for Polty:

```bash
# Local Executor (CLI: npm i -g executor && executor install && executor web) listens on 127.0.0.1:4788.
# The local daemon requires a bearer token on /mcp; it is stored in ~/.executor/server-control/auth.json ({"token": "..."}).
EXECUTOR_MCP_URL=http://127.0.0.1:4788/mcp?mode=passthrough&artifacts=false
EXECUTOR_TOKEN=<token from ~/.executor/server-control/auth.json>
```

Optionally, `PARTNERS_ALLOWED_PRINCIPALS=pr_…` restricts MCP calls and mail sending/reading to the instance owner. On a
public deployment, set this: every visitor gets a principal, and Executor tools act with the operator's credentials.

### (b) Claude Code, Cursor and Codex reach your hardware through Executor

GHOST serves its own MCP server at `/mcp`. It is stateless Streamable HTTP with JSON responses, and authenticated with
`Authorization: Bearer <owner_token>`. Get the token from `GET /api/v1/me` (`owner_token`). Its tools are:

`search_capabilities`, `get_capability`, `quote_lease`, `accept_quote`, `invoke_capability`, `release_lease`,
`list_leases`, `get_balance`, `recall_experience`, `record_experience`, `update_offer` and `revoke_lease`.

All of them act as that principal.

To register GHOST in Executor (**steps 2, 3 and the API variant below were verified live**):

1. Run Executor: `npm i -g executor && executor install && executor web`, or Docker:
   `docker run -d -p 4788:4788 -v executor-data:/data ghcr.io/rhyssullivan/executor-selfhost:latest`.
2. In the Executor web UI, click **Add Source** (also called "Add Integration") and paste your GHOST MCP URL, for example
   `https://<your-ghost-host>/mcp`, or `http://127.0.0.1:3000/mcp` when both run locally.
3. Authentication: under **Request headers**, add `Authorization: Bearer <owner_token>`.
   - These headers are stored as static config, not in the secret store.
   - The cleaner option is to declare a header auth method (`Authorization`, prefix `Bearer `) and add a connection holding the token as its secret.
   - Executor probes the URL and shows "Ready to add" when it can list GHOST's tools.
4. Optionally, set per-tool policies in Executor. For example, require approval for `accept_quote` (spends test funds) and
   `invoke_capability` (acts on hardware), and allow `search_capabilities` and `recall_experience`.
   The same thing can be done through Executor's HTTP API, which is the exact sequence we ran:
   ```bash
   EXEC=http://127.0.0.1:4788; T=<token from ~/.executor/server-control/auth.json>
   curl -s -X POST $EXEC/api/mcp/probe   -H "Authorization: Bearer $T" -H 'content-type: application/json' \
     -d '{"endpoint":"https://<ghost-host>/mcp","headers":{"Authorization":"Bearer <owner_token>"}}'
     # -> {"connected":true,"toolCount":12,"serverName":"ghost-coordinator",...}
   curl -s -X POST $EXEC/api/mcp/servers -H "Authorization: Bearer $T" -H 'content-type: application/json' \
     -d '{"transport":"remote","name":"GHOST","slug":"ghost","endpoint":"https://<ghost-host>/mcp","remoteTransport":"streamable-http","headers":{"Authorization":"Bearer <owner_token>"},"authenticationTemplate":[{"kind":"none"}]}'
     # -> {"slug":"ghost"}
   curl -s -X POST $EXEC/api/connections -H "Authorization: Bearer $T" -H 'content-type: application/json' \
     -d '{"owner":"org","name":"default","integration":"ghost","template":"none","value":""}'
     # -> {"address":"tools.ghost.org.default", ...}
   ```
   After this, GHOST's tools appear in Executor as `tools.ghost.org.default.<tool>`. An example is `tools.ghost.org.default.search_capabilities`.
5. Point your coding agent at Executor. This is the documented command; the header is needed by the local daemon:
   ```bash
   npx add-mcp http://127.0.0.1:4788/mcp --transport http --name executor \
     --header 'Authorization: Bearer <token from ~/.executor/server-control/auth.json>'
   ```
   The **Connect** card in Executor's UI generates this command with the token filled in.
6. In Claude Code, Cursor or Codex, ask for something like "find a camera near the Golden Gate and show me the view". The agent
   searches Executor's tools, finds GHOST's `search_capabilities` / `invoke_capability`, and Executor forwards the call
   to GHOST with your owner token.

You can also skip Executor and connect directly: `npx add-mcp https://<ghost-host>/mcp --transport http --name ghost --header 'Authorization: Bearer <owner_token>'`.

**Env (bridge):**
- `EXECUTOR_MCP_URL` is required for (a).
- Optional: `EXECUTOR_TOKEN`, `GHOST_MCP_SERVERS`, `PARTNERS_ALLOWED_PRINCIPALS`.

**What was verified (Oct 4), against Executor 1.6.10 (`executor web --foreground`, local, bearer token):**
- (a) The bridge connected over Streamable HTTP.
  - Default mode listed 7 tools: `execute, skills, resume, create-artifact, edit-artifact, list-artifacts, show-artifact`.
  - `?mode=passthrough&artifacts=false` listed 4 tools: `integrations, search, invoke, skills`.
  - `integrations` and `search` calls returned results (`structuredContent` is passed through).
- (b) GHOST's `/mcp` (in-memory coordinator) was registered in Executor with the API sequence above. Then, through the bridge:
  1. `search {query:"search capabilities camera"}` returned `tools.ghost.org.default.search_capabilities` with GHOST's input schema.
  2. `invoke {tool, arguments:{q:"golden gate"}}` returned GHOST's catalog hit (the Exa/Kernel webcam candidate).

  This is the full path a coding agent takes: MCP client → Executor → GHOST.
- The bridge was also tested in the check script against GHOST's own `/mcp` through `GHOST_MCP_SERVERS`:
  - qualified and bare names;
  - an unknown tool returning 404;
  - an unreachable server and a wrong token being reported per server.
- **Not exercised:**
  - the SSE fallback;
  - the `add-mcp` command for Claude Code, Cursor or Codex (step 5, taken from Executor's docs);
  - Executor's approval flow (`resume`);
  - the Executor web UI. Steps 2–3 there follow the UI source, but we used the API.
