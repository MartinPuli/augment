# GHOST and Personal Agent Protocol

Experimental guest implementation against the [Poppy draft 0.1 specification](https://personalagentprotocol.org/docs/spec), read on 2026-10-09. This is a tested subset, not a claim of complete protocol conformance or interoperability with Dot, Muse or another external agent. The draft can change incompatibly.

## Working flow

An operator registers an agent's exact HTTPS client metadata URL. The agent discovers GHOST at `/.well-known/poppy.json`, reads its OAuth metadata, signs fresh client and pseudonymous-user assertions, and requests a session. For MCP, it omits DPoP and requests the exact advertised MCP resource. The resulting Bearer token works only at `/poppy/mcp`.

That separate guest MCP interface exposes hardware guides, public capability search/details, and public observations through the existing GHOST invocation engine. It cannot access private devices, move hardware, accept rental quotes, spend funds, change offers, or retrieve an owner's history. Observations retain their original source, timestamps and uncertainty. Guest principals receive no development ledger grant.

DPoP session issuance and a diagnostic `/poppy/session` endpoint also work. Proofs are checked for signature, key binding, request method/URL, issuance time, replay and access-token hash. DPoP tokens never work as MCP Bearer tokens. Session assertions and client assertions are separately verified and single-use. Client metadata and public keys are fetched over HTTPS with a pinned public IPv4 address, no redirects, an eight-second timeout and a 64 KiB response limit. Metadata keys are cached for one minute.

## Configuration

```dotenv
GHOST_POPPY_ENABLED=1
GHOST_POPPY_ORIGIN=https://your-ghost-domain.example
GHOST_POPPY_CLIENTS=https://your-agent.example/client.json
```

The feature is disabled by default. The HTTPS origin must belong to the deployed coordinator, with no path, query or credentials. The existing custom Node server routes the well-known documents and `/poppy/*` to the coordinator. Do not enable this on a web-only Vercel deployment without routing these paths to that same server.

Only registered clients are accepted; the allowlist is loaded at startup. Removing an entry and restarting invalidates its access. Signing keys, replay records and sessions are process-local: every restart invalidates all guest tokens. This implementation requires one coordinator process, not multiple replicas. Tokens last up to one hour and sessions up to 24 hours. Session creation is limited to 30 token requests per minute per registered agent; authenticated requests to 120 per minute, with existing GHOST observation limits applied as well. There are at most 100 registered clients and 1,000 active guest sessions.

No account sign-in methods, account scopes, conversation service or operations extension are advertised. The required revocation endpoint authenticates the client and returns RFC 7009's non-disclosing success for unknown Account Tokens; none are issued in this guest implementation. Ordinary MCP clients that only understand authorization-code login cannot sign in here yet. Existing GHOST owner-token clients continue using `/mcp`.

## Validation

`pnpm poppy:test` passed **48 checks** on 2026-10-09. It exercises a signed test agent through the actual Streamable HTTP MCP transport, an in-process HTTP app, the coordinator and a labeled simulated public sensor. Metadata transport is injected in this local test; the production network fetcher is tested for HTTPS and loopback rejection. This is not a Dot test, a deployed interoperability test, or a physical-device test.

The suite covers discovery/issuer/resource agreement, host-header isolation, token expiry, audience and scope rejection, session ownership, assertion and DPoP replay, proof-key binding, agent revocation, rate limits, private-device and actuator rejection, idempotent observations, provenance and absence of spending funds.

The existing coordinator suite passed **75 checks**; TypeScript, targeted ESLint and the production build passed. A separate local production Node/Next server served all three discovery documents, the health endpoint and the homepage with HTTP 200, and rejected unauthenticated Poppy MCP with HTTP 401 and the resource metadata challenge. The production HTTPS metadata reader also fetched Google's public OpenID configuration successfully without credentials. These checks do not establish compatibility with a real Poppy agent.

## Next integration boundary

Account sign-in and durable delegation must be implemented before advertising account access. The [operations extension](https://personalagentprotocol.org/docs/extensions/operations) can then wrap rental proposals with fixed revisions of the device, capabilities, duration, price and cancellation terms. Confirming rental terms must still preserve the hardware owner's separate approval and GHOST's execution checks. Existing GHOST lease IDs and invocation idempotency do not by themselves establish compliance with Poppy operations.

Real payments, push notifications and attachments remain [open topics in the protocol](https://personalagentprotocol.org/docs/open-topics). GHOST's current rental ledger is also development-only. A real third-party device rental, deployment, and testing with an independently implemented personal agent remain unverified.
