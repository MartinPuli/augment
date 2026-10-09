/** Signed test agent -> draft Poppy session -> actual MCP -> simulated public observation. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { startCoordinator, ownsPath } from "../src/lib/ghost/server";
import { createApiApp } from "../src/lib/ghost/server/http";
import { PoppyAuth, PoppyError, JWT_CLIENT, JWT_GRANT, type PoppyOptions } from "../src/lib/ghost/server/poppy/auth";
import { createPoppyApp } from "../src/lib/ghost/server/poppy/routes";
import { publicJson } from "../src/lib/ghost/server/poppy/public-json";
import { internalAdapters } from "../src/lib/ghost/server/adapters";
import { publishFromAdapter } from "../src/lib/ghost/server/registry";
import { db } from "../src/lib/ghost/server/db";
import { PROTOCOL_VERSION, type DeviceManifest } from "../src/lib/ghost/contracts";

let checks = 0;
function check(value: unknown, label: string) { assert(value, label); checks++; console.log(`✓ ${label}`); }
async function main() {
  process.env.GHOST_DB = "pglite"; delete process.env.DATABASE_URL; delete process.env.GHOST_POPPY_ENABLED;
  const coordinator = await startCoordinator({ dataDir: "memory", skipAdapters: true });
  const origin = "https://ghost.example";
  const agent = "https://agent.example/client.json";
  const keys = await generateKeyPair("ES256");
  const publicKey = await exportJWK(keys.publicKey);
  const proofKeys = await generateKeyPair("ES256");
  const proofKey = await exportJWK(proofKeys.publicKey);
  let now = Math.floor(Date.now() / 1000);
  const options: PoppyOptions = {
    origin, allowedClients: new Set([agent]), now: () => now,
    fetchJson: async url => {
      if (url === agent) return { client_id: agent, client_name: "Test agent", jwks_uri: "https://agent.example/jwks", token_endpoint_auth_method: "private_key_jwt", redirect_uris: [] };
      assert.equal(url, "https://agent.example/jwks");
      return { keys: [publicKey] };
    },
  };
  async function signed(sub: string, patch: JWTPayload = {}) {
    return new SignJWT({ iss: agent, sub, aud: `${origin}/poppy/oauth/token`, iat: now, exp: now + 60, jti: randomUUID(), ...patch }).setProtectedHeader({ alg: "ES256" }).sign(keys.privateKey);
  }
  async function form(user = "opaque-user-1", extras: Record<string, string> = {}) {
    return new URLSearchParams({ grant_type: JWT_GRANT, client_id: agent, client_assertion_type: JWT_CLIENT, client_assertion: await signed(agent), assertion: await signed(user), resource: `${origin}/poppy/mcp`, ...extras });
  }
  async function proof(method: string, path: string, accessToken?: string, patch: JWTPayload = {}) {
    return new SignJWT({ jti: randomUUID(), iat: now, htm: method, htu: `${origin}${path}`, ...(accessToken ? { ath: createHash("sha256").update(accessToken).digest("base64url") } : {}), ...patch }).setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: proofKey }).sign(proofKeys.privateKey);
  }
  async function rejects(fn: () => Promise<unknown>, code: string, label: string) {
    await assert.rejects(fn, e => e instanceof PoppyError && e.code === code); check(true, label);
  }
  const client = new Client({ name: "poppy-test-agent", version: "1" });
  try {
    check((await coordinator.app.request("/.well-known/poppy.json")).status === 404, "Poppy stays disabled by default");
    check(ownsPath("/.well-known/poppy.json") && ownsPath("/poppy/oauth/token") && ownsPath("/.well-known/oauth-protected-resource/poppy/mcp"), "custom server routes discovery, auth and MCP to the coordinator");
    const app = createApiApp({ poppy: options });
    const discovery = await (await app.request(`${origin}/.well-known/poppy.json`, { headers: { "x-forwarded-host": "evil.example" } })).json();
    check(discovery.organization.domain === "ghost.example" && discovery.apis[0].url === `${origin}/poppy/mcp`, "discovery uses configured canonical origin, never proxy headers");
    check(!discovery.auth.direct && !discovery.auth.device && !discovery.extensions, "discovery does not promise unimplemented sign-in or operations");
    const metadata = await (await app.request(`${origin}/.well-known/oauth-authorization-server`)).json();
    const resource = await (await app.request(`${origin}/.well-known/oauth-protected-resource/poppy/mcp`)).json();
    check(metadata.issuer === discovery.auth.issuer && metadata.poppy_domains.includes(discovery.organization.domain) && resource.authorization_servers.includes(metadata.issuer), "OAuth issuer/domain binding and MCP resource metadata agree");
    const issued = await app.request(`${origin}/poppy/oauth/token`, { method: "POST", body: await form() });
    const token = await issued.json();
    check(issued.status === 200 && token.token_type === "Bearer" && token.signed_in === false && token.scope === "" && issued.headers.get("cache-control") === "no-store", "signed registered agent obtains a short-lived guest MCP token");
    const denied = await app.request(`${origin}/poppy/mcp?access_token=${token.access_token}`);
    check(denied.status === 401 && denied.headers.get("www-authenticate")?.includes("resource_metadata"), "URL tokens are refused and MCP advertises its authorization server");
    check((await app.request(`${origin}/poppy/mcp`, { headers: { cookie: `ghost_pid=${token.access_token}` } })).status === 401, "Poppy cannot authenticate via owner cookies");
    check((await app.request(`${origin}/api/v1/ledger`, { headers: { authorization: `Bearer ${token.access_token}` } })).status === 401, "guest token cannot access the owner API");
    check((await app.request(`${origin}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token.access_token}` } })).status === 401, "guest token cannot authenticate to the owner MCP endpoint");
    check((await app.request(`${origin}/poppy/session`, { headers: { authorization: `Bearer ${token.access_token}` } })).status === 401, "MCP Bearer tokens cannot be used at non-MCP APIs");
    const duplicate = await form(); duplicate.append("client_id", agent);
    check((await app.request(`${origin}/poppy/oauth/token`, { method: "POST", body: duplicate })).status === 400, "duplicate OAuth form fields are refused");
    check((await app.request(`${origin}/poppy/oauth/token`, { method: "POST", body: "x".repeat(65537) })).status === 413, "oversized token requests are rejected");
    check((await app.request(`${origin}/api/v1/invoke`, { method: "POST", body: "x".repeat(65537) })).status === 401, "Poppy body limits do not intercept the existing hardware API");

    let calls = 0;
    internalAdapters.push({ id: "poppy-test", owner_id: "provider:poppy-test", async invoke() { calls++; return { state: "succeeded", observation: { kind: "value", value: 21.5, unit: "C", captured_at: null, source: { name: "SIMULATED public sensor" }, note: "SIMULATED, not a physical reading" } }; } });
    const manifest: DeviceManifest = { protocol_version: PROTOCOL_VERSION, local_key: "public", name: "SIM public sensor", device_class: "sensor", transport: "http-public", access_type: "public_observation", terms: { price_cents: 0, currency: "USD", max_duration_s: 60 }, capabilities: [{ capability_id: "temperature.read", semantic_type: "temperature.read", kind: "measure", title: "Read temperature", description: "SIMULATED", input_schema: { type: "object", properties: {}, additionalProperties: false }, verification: "observation" }] };
    const [device, privateDevice, actuator] = await publishFromAdapter("poppy-test", [{ manifest }, { manifest: { ...manifest, local_key: "private", access_type: "owner_shared" } }, { manifest: { ...manifest, local_key: "actuator", capabilities: [{ ...manifest.capabilities[0], kind: "act" }] } }]);
    await client.connect(new StreamableHTTPClientTransport(new URL(resource.resource), { requestInit: { headers: { authorization: `Bearer ${token.access_token}` } }, fetch: async (input, init) => app.fetch(new Request(input, init)) }));
    const names = (await client.listTools()).tools.map(t => t.name);
    check(names.includes("search_capabilities") && names.includes("invoke_capability") && !names.includes("accept_quote") && !names.includes("update_offer") && !names.includes("record_experience"), "real MCP discovery exposes only the guest tool surface");
    const call = async (name: string, args: Record<string, unknown>) => await client.callTool({ name, arguments: args }) as CallToolResult;
    const data = (r: CallToolResult) => { const t = r.content.find(c => c.type === "text"); assert(t?.type === "text"); return JSON.parse(t.text); };
    const hits = data(await call("search_capabilities", { q: "SIM" }));
    check(hits.some((h: { device: { device_id: string } }) => h.device.device_id === device.device_id) && !hits.some((h: { device: { device_id: string } }) => h.device.device_id === privateDevice.device_id), "guest search hides private devices");
    check(!((await call("read_hardware_guide", { id: "ghost-hardware", file: "printers.md" })).isError), "hardware skills remain available through Poppy MCP");
    const invocation = { ref: `${device.device_id}/temperature.read`, idempotency_key: "poppy-public-1" };
    const observed = data(await call("invoke_capability", invocation));
    check(observed.state === "succeeded" && observed.observation.value === 21.5 && observed.observation.captured_at === null && observed.observation.note.includes("SIMULATED"), "Poppy MCP reaches the real GHOST invocation engine and preserves provenance");
    const repeated = data(await call("invoke_capability", invocation));
    check(repeated.invocation_id === observed.invocation_id && calls === 1, "repeated public read keeps its invocation and does not run the adapter again");
    check((await call("invoke_capability", { ...invocation, ref: `${privateDevice.device_id}/temperature.read`, idempotency_key: "private" })).isError && calls === 1, "guest invocation cannot use private hardware");
    check((await call("invoke_capability", { ...invocation, ref: `${actuator.device_id}/temperature.read`, idempotency_key: "act" })).isError && calls === 1, "even public device metadata cannot authorize guest actuation");
    const principals = await db().query("select principal_id from principals where kind = 'agent'");
    check(principals.rows.length === 1 && (await db().query("select * from ledger_entries where principal_id = $1", [principals.rows[0].principal_id])).rows.length === 0, "guest observations create no spending balance");

    const auth = new PoppyAuth(options);
    const firstForm = await form();
    const first = await auth.issue(firstForm);
    await rejects(() => auth.issue(firstForm), "invalid_grant", "replayed signed assertions are rejected");
    const renewed = await auth.issue(await form("opaque-user-1", { session_id: first.session_id }));
    check(renewed.session_id === first.session_id, "same agent and pseudonymous user can renew their session");
    await rejects(async () => auth.issue(await form("opaque-user-2", { session_id: first.session_id })), "invalid_session", "another user cannot take over an existing session");
    await rejects(async () => auth.issue(await form("u", { client_id: "https://unknown.example/client.json" })), "invalid_client", "unregistered client is rejected before metadata fetching");
    await rejects(async () => auth.issue(await form("u", { scope: "poppy:write" })), "invalid_scope", "guest grant cannot escalate to account write access");
    await rejects(async () => auth.issue(await form("u", { resource: "https://evil.example/mcp" })), "invalid_target", "Bearer token cannot target another MCP server");
    await rejects(async () => auth.issue(await form("u", { resource: "" })), "invalid_target", "Bearer grant must name its MCP resource");
    await rejects(async () => auth.issue(await form("u", { assertion: await signed("u", { aud: "https://evil.example/token" }) })), "invalid_grant", "session assertion for another audience is rejected");
    await rejects(async () => auth.issue(await form("u", { assertion: await signed("u", { exp: now - 1, iat: now - 60 }) })), "invalid_grant", "expired agent assertions are rejected");
    await rejects(async () => auth.issue(await form("u", { client_assertion: await signed("another-client") })), "invalid_client", "client assertion must identify the authenticated client in sub");
    const dpopForm = await form(); dpopForm.delete("resource");
    const dpopToken = await auth.issue(dpopForm, await proof("POST", "/poppy/oauth/token"));
    check(dpopToken.token_type === "DPoP", "guest token can be bound to an agent proof key");
    const getProof = await proof("GET", "/poppy/session", dpopToken.access_token);
    const identity = await auth.authenticate(`DPoP ${dpopToken.access_token}`, getProof, "GET", "/poppy/session");
    check(identity.session_id === dpopToken.session_id, "matching DPoP key, method, target and token hash authenticate");
    await rejects(() => auth.authenticate(`DPoP ${dpopToken.access_token}`, getProof, "GET", "/poppy/session"), "invalid_dpop_proof", "DPoP proof replay is rejected");
    await rejects(async () => auth.authenticate(`DPoP ${dpopToken.access_token}`, await proof("POST", "/poppy/session", dpopToken.access_token), "GET", "/poppy/session"), "invalid_dpop_proof", "DPoP proof is bound to the request method");
    await rejects(async () => auth.authenticate(`DPoP ${dpopToken.access_token}`, await proof("GET", "/poppy/session", "wrong-token"), "GET", "/poppy/session"), "invalid_dpop_proof", "DPoP proof is bound to the access token");
    const otherKeyForm = await form(); otherKeyForm.delete("resource");
    const differentKeys = await generateKeyPair("ES256");
    const otherProof = await new SignJWT({ jti: randomUUID(), iat: now, htm: "POST", htu: `${origin}/poppy/oauth/token` }).setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: await exportJWK(differentKeys.publicKey) }).sign(differentKeys.privateKey);
    const bound = await auth.issue(otherKeyForm, otherProof);
    await rejects(async () => auth.authenticate(`DPoP ${bound.access_token}`, await proof("GET", "/poppy/session", bound.access_token), "GET", "/poppy/session"), "invalid_dpop_proof", "copied access token cannot be used with another proof key");
    await rejects(() => auth.authenticate(`Bearer ${dpopToken.access_token}`, undefined, "POST", "/poppy/mcp"), "invalid_token", "DPoP token cannot be downgraded to Bearer");
    options.allowedClients.delete(agent);
    await rejects(() => auth.authenticate(`Bearer ${first.access_token}`, undefined, "POST", "/poppy/mcp"), "invalid_token", "removing a registered agent invalidates its sessions immediately");
    options.allowedClients.add(agent);
    now += 3601;
    await rejects(() => auth.authenticate(`Bearer ${first.access_token}`, undefined, "POST", "/poppy/mcp"), "invalid_token", "guest access token expires after one hour");
    now += 86400;
    await rejects(async () => auth.issue(await form("opaque-user-1", { session_id: first.session_id })), "invalid_session", "expired session cannot be renewed");
    const foreign = new PoppyAuth({ ...options, origin: "https://other.example" });
    await rejects(() => foreign.authenticate(`Bearer ${renewed.access_token}`, undefined, "POST", "/poppy/mcp"), "invalid_token", "another coordinator never accepts the session token");
    const malformed = new PoppyAuth({ ...options, fetchJson: async () => ({ client_id: agent, client_name: "Bad", jwks_uri: "https://private.example/keys", token_endpoint_auth_method: "private_key_jwt" }) });
    await rejects(async () => malformed.issue(await form()), "invalid_client", "metadata cannot redirect key fetching to another origin");
    await assert.rejects(publicJson("https://127.0.0.1/keys")); check(true, "production metadata fetch rejects loopback addresses");
    await assert.rejects(publicJson("http://agent.example/keys")); check(true, "production metadata fetch requires HTTPS");
    const limited = new PoppyAuth(options);
    for (let i = 0; i < 30; i++) await limited.issue(await form());
    await rejects(async () => limited.issue(await form()), "rate_limited", "token issuance is bounded per registered agent");
    const revoke = await form(); revoke.set("token", "unknown-account-token");
    const revokeResponse = await createPoppyApp(options).request(`${origin}/poppy/oauth/revoke`, { method: "POST", body: revoke });
    check(revokeResponse.status === 200, "authenticated revocation is non-disclosing when no account token exists");
    console.log(`\n${checks} Poppy checks passed. Test agent and sensor are simulated; signatures, MCP, authorization and GHOST observations are real.`);
  } finally { await client.close(); await coordinator.stop(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
