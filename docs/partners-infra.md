# Infrastructure partner integrations

GHOST has five infrastructure partners: **Mastra**, **Neon**, **Fly.io**, **Interfere** and **CodeRabbit**. For the
agent-facing partners (Exa, Kernel, AgentMail, Executor), see [partners.md](partners.md).

Each integration does one real job, and all of them are optional. The open-source core runs locally
(`pnpm dev`) with embedded Postgres and no sponsor account.

| Partner | Job in GHOST | Env | Verified |
|---|---|---|---|
| Mastra | **Missions**: deterministic, observable multi-step physical procedures, built as Mastra Workflows with suspend/resume for verification. The voice agent launches one as a single tool. Traces and run state go to Mastra storage and show in Studio. | none required. Optional: `MASTRA_STORAGE_URL`, `MASTRA_PLATFORM_ACCESS_TOKEN` + `MASTRA_PROJECT_ID` | **Yes, live.** `scripts/infra-mission-test.ts` ran against the real coordinator and a fake WebSocket connector: all checks pass with LibSQL storage and with Neon Postgres storage. Studio (`pnpm mastra:dev`) lists the runs and their traces from that storage. Mastra Platform export was not tested (no token). |
| Neon Postgres | Production database for the coordinator, and durable storage for mission snapshots and traces (schema `mastra`), so a suspended mission survives a redeploy. | `DATABASE_URL` (pooled) | **Yes, live.** `pnpm infra:neon-check` connects to Postgres 18.6 over the `-pooler` host. The mission test with `--neon-storage` suspends and resumes through Neon. |
| Neon AI Gateway | Routes every Claude call through the Neon branch's Anthropic Messages endpoint, with the same official SDK. | `NEON_AI_GATEWAY_BASE_URL`, `NEON_AI_GATEWAY_TOKEN` | **Yes, live.** The gateway lists 13 Claude models, and a `claude-haiku-4-5` message returned through `createAnthropicClient()`. |
| Fly.io | Public HTTPS origin, so phones can use their camera and sensors. Hosts the long-lived device-channel WebSockets. | runtime secrets only, see [deploy.md](deploy.md) | **Partly.** `pnpm build` passes, and the image `CMD` (`NODE_ENV=production node --import tsx server.ts`) boots and serves `/api/v1/health` and `/`. Docker Desktop was not running, so `docker build` was not run. Nothing was deployed. |
| Interfere | Production visibility: client errors, Next.js server errors, and coordinator errors (failed missions, API 5xx) that happen outside Next's pipeline. | `INTERFERE_PUBLIC_KEY`, `INTERFERE_API_KEY` (build), `INTERFERE_ENVIRONMENT` | **Wired, not live.** The SDK is installed and the build integration was exercised. With a placeholder key the build reached Interfere's API and was rejected (`Secret key rejected by server`), which shows a real key is all that is missing. No events have been seen in Interfere. |
| CodeRabbit | AI review tuned for this repo: hardware honesty rules, security review of the device channel, SSRF, credentials and leases, and English-only copy. | none; it is a GitHub App | `.coderabbit.yaml` validates against `schema.v2.json`. The GitHub App is not installed, because the repo has not been pushed. |

---

## Mastra: missions

**Why Mastra.** Some procedures must be the same every time, auditable, and able to pause for a human
or a vision model. "Photograph, open the cover, photograph again, check, release, remember" is one of
them. A free-form LLM loop is the wrong tool for that.

Mastra Workflows give GHOST:
- typed steps (zod)
- a step graph
- `suspend()` and `resume()` with persisted snapshots
- `foreach` with concurrency
- per-step traces
- Studio, for inspecting runs

There are **no LLM steps**. Claude still runs on the official Anthropic SDK in the agent route.

### Files

| File | Contents |
|---|---|
| `src/mastra/index.ts` | The Mastra instance, with workflows, storage selection and observability. |
| `src/mastra/workflows/inspect-with-actuator.ts` | Eight steps: `discover` → `lease` → `baseline-snapshot` → `actuate` → `after-snapshot` → `verify` (suspend) → `release` → `record-experience`. |
| `src/mastra/workflows/patrol-cameras.ts` | `plan` → `foreach(observe, concurrency 4)` → `summarize`. |
| `src/mastra/coordinator.ts`, `src/mastra/ghost-ops.ts` | The loopback HTTP client for `/api/v1` (search, quote/negotiate/accept, invoke, release, experiences). Calls never throw; every failure comes back as data. |
| `src/lib/ghost/server/missions/index.ts` | `runMission(name, input, principal, {wait})`, `resumeMission(runId, data, principal?)`, `getMission(runId, principal?)`, `listMissions()` |
| `src/lib/ghost/server/missions/routes.ts` | `mountMissionRoutes(app)`. The core router mounts it under `/api/v1`. |

### HTTP

```
GET  /api/v1/missions                   # names, descriptions, input/resume/output JSON Schemas
POST /api/v1/missions/:name/run         # body = input; ?wait=false returns {run_id, status:"running"} at once
POST /api/v1/missions/runs/:id/resume   # body = {verdict:"verified"|"unverified", summary, verifier?, evidence?}
GET  /api/v1/missions/runs/:id          # status, steps[], suspended{step,payload}, evidence[], result
```

Auth works the same as the rest of `/api/v1`: `Authorization: Bearer <owner_token>` or the `ghost_pid` cookie.

### Example

```bash
curl -s -X POST localhost:3000/api/v1/missions/inspect-with-actuator/run \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"zone_id":"workshop-demo-table","max_spend_cents":100,"restore_capability":"cover.close"}'
# -> {"status":"suspended","suspended":{"step":"verify","payload":{"baseline":{"observation_id":...,"media_url":...},
#      "after":{...},"question":"Compare the two photos ..."}}, "evidence":[...], "steps":[...]}

curl -s -X POST localhost:3000/api/v1/missions/runs/$RUN/resume -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"verdict":"verified","summary":"Cover open; part visible."}'
# -> {"status":"success","result":{"outcome":"verified","experience_id":"exp_...","lease_ids":[...],"cost_cents":30,...}}
```

### Design rules (and how they are enforced)

**Evidence ids for every step.**
- Every invocation is recorded with its `invocation_id`, `state` and `observation_id`.
- `evidence[]` collects the observation ids in order.
- The verifier gets the `media_url` of both photos in the suspend payload.

**Unknown is not success.**
- A transport timeout on `invoke` is recorded as `unknown`.
- An `unknown` actuation is noted, and the photo comparison decides.
- If the baseline photo fails, the mission aborts **before** actuating, because without a baseline nothing could be verified.
- If the after-photo is missing, the outcome is `unverified`, not `verified`.

**Honest failures.**
- Aborted missions still release their leases and record an experience with `outcome:"failed"` and the reasons. The over-budget case is tested.
- Mission crashes, and outcomes with failures, are also reported to Interfere.

**Budget.**
- Leases are quoted per owner. Public sources are skipped, because they need no lease.
- If the price is over budget, the mission makes up to 2 counteroffers at the remaining budget (the protocol limit), then accepts only if the price is at or under budget. The coordinator enforces `max_spend_cents` again on accept.

**No double actuation.**
- Every invoke carries the idempotency key `<runId>:<step>`.

**Credentials never persisted.**
- The caller's owner token is held in an in-memory vault keyed by run id. It is never put in workflow input, state, the suspend payload or the request context, because Mastra persists all of those.
- Resuming re-supplies the resuming caller's token, so it works after a coordinator restart. The test clears the vault before resuming to check this.
- `SensitiveDataFilter` redacts token-like fields from traces as a second layer.

**No SSRF through missions.**
- The loopback base URL comes from the operator (`GHOST_COORDINATOR_URL`, or `http://127.0.0.1:$PORT`), never from mission input.

**Scoped runs.**
- `resourceId` is the principal id. Other principals get a 404 for both `GET` and resume.

### Storage

The first match wins:

1. `MASTRA_STORAGE_URL`: LibSQL at that URL (`file:/abs/path.db` or `libsql://…`).
2. `DATABASE_URL`: `PostgresStore`, schema `mastra` (Neon). Mastra creates its tables on first use.
3. Otherwise: LibSQL at `.ghost/mastra.db`, or `$GHOST_DATA_DIR/mastra.db`.

`GHOST_MISSIONS_STORAGE=memory` keeps everything in memory (tests). `GHOST_MISSIONS_TRACING=0` turns tracing off.

### Studio

```bash
pnpm mastra:dev      # http://localhost:4111 → Workflows / Observability
```

The script sets `GHOST_DATA_DIR=$PWD/.ghost`, so Studio and the app share the same LibSQL file. With
`DATABASE_URL` set, both use Neon. Studio then shows:
- the runs the app started, including their step graph, inputs and outputs
- the suspend payload
- per-step traces

To **start** a mission from Studio, the coordinator must be running (`pnpm dev`). Set
`GHOST_MISSION_OWNER_TOKEN=<owner_token from GET /api/v1/me>` too, because Studio runs have no
caller credentials. This variable is for development only.

### Mastra Platform (optional)

Set `MASTRA_PLATFORM_ACCESS_TOKEN` and `MASTRA_PROJECT_ID`, both from projects.mastra.ai. Traces are
then also exported with `MastraPlatformExporter`.

The `MASTRA_API_KEY` in our `.env.local` template is **not** a variable Mastra reads.

### Tests

```bash
pnpm infra:mission-test                  # real coordinator (in-process, PGlite in memory) + fake WS connector, LibSQL temp file
pnpm infra:mission-test --neon-storage   # same, Mastra storage in Neon Postgres (DATABASE_URL from .env.local)
pnpm infra:mission-test --mock           # mocked /api/v1 (no coordinator code)
```

The mission test checks:
- suspend at `verify`, with both photo ids
- `GET` reads the run from storage
- a stranger gets 404, an anonymous caller gets 401, bad input gets 400
- resume after the credential vault is cleared
- `verified` outcome with an experience recorded
- `cover.close` restore ran
- the lease was actually released (read back with `GET /leases/:id`)
- a second resume gets 409
- an over-budget mission returns `failed` and never actuates
- patrol: one observation, one honest failure

---

## Neon

### Postgres

1. In the Neon console, create a project in the region closest to your Fly app (for example `aws-us-west-2` or `us-east-2`).
2. Open **Connect**, select **Pooled connection**, and copy the string. The host ends in `-pooler`.
3. Set it as `DATABASE_URL`:
   ```
   DATABASE_URL=postgresql://user:pass@ep-xxx-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
   - `sslmode=require` makes `pg` 8.x print a security warning and treat it as `verify-full`. Use `sslmode=verify-full` to silence the warning.
   - `channel_binding=require` is ignored by `pg`.
4. Run `pnpm infra:neon-check`. It prints:
   - the server version
   - whether the host is pooled
   - whether the coordinator tables and the `mastra` schema exist

The coordinator creates its tables on first boot. Mastra creates its own tables in schema `mastra` on the first mission.

### AI Gateway (Anthropic Messages)

Source: https://neon.com/docs/ai-gateway/anthropic-messages

**Base URL.**
- Use the branch's gateway host, which is different from the database host: `https://br-<name>-api.ai.<cell>.<region>.aws.neon.tech`.
- The SDK base is that host plus `/anthropic`. The SDK appends `/v1/messages` itself.

**Auth.**
- Use a Neon credential `nt_live_…` with scope `ai_gateway:invoke`, sent as `Authorization: Bearer`. This is the SDK's `authToken` option, not `apiKey`.
- To create one, use `neon credentials create --scope ai_gateway:invoke`, or in the Console go to **Connect → AI Gateway**.

**Env.**
- Set `NEON_AI_GATEWAY_BASE_URL` (the bare host) and `NEON_AI_GATEWAY_TOKEN`.
- `NEON_AI_GATEWAY_URL` and `NEON_AI_GATEWAY_KEY` are accepted as aliases.
- `GHOST_LLM_PROVIDER=anthropic` forces the direct API.

**Code.**
```ts
import { createAnthropicClient, gatewayInfo } from "@/lib/llm/anthropic-client";
const client = createAnthropicClient();   // Neon gateway if configured, else new Anthropic()
gatewayInfo.provider;                      // "neon-ai-gateway" | "anthropic"
```
- With the gateway, the client sets `apiKey: null`, so `ANTHROPIC_API_KEY` is never sent to Neon.

**Models.** These Claude ids are listed by the gateway (checked live on Oct 4 2026):
- `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`, `claude-fable-5-1`
- `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5`, `claude-opus-4-1`
- `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5`

**Thinking.** Opus 5.x, Sonnet 5, Fable 5.x and Opus 4.7/4.8 need `thinking: {type: "adaptive"}`, as on the direct API.

**Supported.** Streaming and prompt caching are documented as supported. Tool use is not mentioned explicitly in Neon's docs.

**Limits.**
- 200k tokens per minute.
- A daily spend cap ("$20/day, may vary").
- A paid Neon plan with prepaid AI Gateway credits.

**Check.** `pnpm infra:neon-check` lists the gateway's models and sends one 16-token message. Use `--no-llm` to skip the billed call.

---

## Fly.io

See [deploy.md](deploy.md) for:
- `fly launch --no-deploy`, then volume, secrets and `fly deploy`
- why there is exactly one always-on machine
- how phones pair through `https://<app>.fly.dev` (`NEXT_PUBLIC_PUBLIC_ORIGIN`)

---

## Interfere

Package: `@interfere/next` 11.x. Docs: https://interfere.com/docs/sdk/next-js

| Where | What is captured | File |
|---|---|---|
| Browser | Uncaught errors, console logs, page and session context (SDK defaults). Initialised only when the build is configured (`NEXT_PUBLIC_GHOST_INTERFERE=1`). | `src/instrumentation-client.ts` |
| Next.js server | Errors in Server Components and route handlers (`/api/agent`, `/api/tts`) through `onRequestError`. `register()` starts Interfere's OpenTelemetry pipeline. | `src/instrumentation.ts` |
| Coordinator (custom server, outside Next) | `reportError(err, where, attrs)` and `reportEvent(name, attrs, {failed})` use Interfere's `captureError` plus standard OTel spans. Already used for mission crashes, failed mission outcomes and mission-route 5xx. | `src/lib/observability/report.ts` |
| Build | `withInterfere()` uploads source maps and release metadata. It is applied only when `INTERFERE_PUBLIC_KEY` **and** `INTERFERE_API_KEY` are both set. | `next.config.ts` |

**Env.**
- `INTERFERE_PUBLIC_KEY` (`interfere_public_us_…`): runtime and build.
- `INTERFERE_API_KEY` (`interfere_secret_…`): build only. On Fly, pass it with `--build-secret`.
- `INTERFERE_ENVIRONMENT=production`: required at build. Interfere also drops `development`, `local` and `test` events.
- The SDK is active only when `NODE_ENV=production`, or when `NEXT_PUBLIC_INTERFERE_FORCE_ENABLE=1`.
- Get the keys by creating a "surface" at interfere.com.

**Suggested wiring for the coordinator core.** This is not done yet; the files belong to the core workstream.
- Call `reportError(err, "api", {path})` in the Hono `onError` for 5xx.
- Call `reportEvent("invocation.timeout", {device_id, capability_id, invocation_id}, {failed: true})` when an invocation finishes as `unknown` or `failed`.
- Call `reportEvent("connector.dropped", {connector_id})` on heartbeat loss.

**Not verified.** No Interfere account was available. Nothing has been seen arriving in Interfere's UI.

What was checked:
- The integration compiles and builds with keys unset (it is a no-op then).
- With placeholder keys, the build ran the Interfere pipeline up to the key check.
- Interfere offers no `track(event)` API. Custom coordinator events are therefore OTel spans. Whether Interfere's UI surfaces them as more than trace spans is unknown.

---

## CodeRabbit

`.coderabbit.yaml` sets:
- the `assertive` profile, with English output
- path filters that skip the lockfile, models and build output
- **path instructions**:
  - global hardware-honesty rules: `unknown` is not success, `captured_at` is never the retrieval time, fake devices are labelled, the dev ledger is not money, copy is English only
  - device-channel authentication and message-trust review
  - SSRF review for proxies and adapters
  - authorization and integer-cents money review for leases
  - mission rules: no secrets in persisted workflow state, idempotency, release on every path
  - LLM key hygiene, including no `ANTHROPIC_API_KEY` to the gateway
  - UI honesty and accessibility
  - fail-safe rules for connector code running on real hardware
  - deployment hygiene
- **tools**: eslint, gitleaks, trufflehog, osvScanner, hadolint (Dockerfile), shellcheck, yamllint, markdownlint, ruff (Pi connector), actionlint, ast-grep essential rules
- **knowledge base**: `AGENTS.md`, `CLAUDE.md` and `docs/**/*.md` as code guidelines

To enable it after the repo is public on GitHub:
1. Sign in at https://app.coderabbit.ai with GitHub.
2. Install the CodeRabbit GitHub App (https://github.com/apps/coderabbitai) on the repo.

Notes:
- The Open Source plan is free for public repositories.
- Reviews start automatically on PRs to `main`.
- On repos with fewer than 10 stars, comment `@coderabbitai review` to trigger one.
- `@coderabbitai configuration` prints the resolved config.

The config was validated against `https://coderabbit.ai/integrations/schema.v2.json` (0 errors). It has
not run on a real PR yet.
