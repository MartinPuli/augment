import assert from "node:assert/strict";
import { startCoordinator } from "../src/lib/ghost/server";
import { internalAdapters } from "../src/lib/ghost/server/adapters";
import { publishFromAdapter } from "../src/lib/ghost/server/registry";
import { agentFromToken } from "../src/lib/ghost/server/accounts";
import { db } from "../src/lib/ghost/server/db";
import { PROTOCOL_VERSION, type DeviceManifest } from "../src/lib/ghost/contracts";

async function main() {
  delete process.env.DATABASE_URL;
  process.env.GHOST_QUIET = "1";
  const coord = await startCoordinator({ dataDir: "memory", skipAdapters: true });
  let count = 0;
  const pass = (name: string) => { count++; console.log(`PASS ${name}`); };
  async function api(path: string, body?: unknown, cookie?: string, extra: Record<string,string> = {}) {
    return coord.app.request(`/api/v1${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  const password = "test-only-long-password-7942";
  try {
    assert.equal((await api("/account/agents")).status, 401);
    const reg = await api("/account/register", { username: "test_owner", password });
    assert.equal(reg.status, 201); const cookie = reg.headers.get("set-cookie")!.split(";")[0];
    const owner = (await reg.json()).account;
    assert.match(reg.headers.get("cache-control")!, /no-store/);
    assert.equal((await api("/account/login", { username: "test_owner", password: "incorrect-password" })).status, 401);
    const login = await api("/account/login", { username: "test_owner", password });
    assert.equal(login.status, 200); assert.equal((await login.json()).account.principal_id, owner.principal_id);
    pass("account creation and password sign-in recover the same identity");
    assert.equal((await api("/account/register", { username: "test_owner", password })).status, 400);
    const scopeCheck = await api("/account/agents", { name: "Bad scope", permission: "admin" }, cookie);
    assert.equal(scopeCheck.status, 400, await scopeCheck.text());
    assert.equal((await api("/account/agents", { name: "CSRF", permission: "public_read" }, cookie, { origin: "https://other.example" })).status, 403);
    pass("duplicate usernames, invalid permissions and cross-origin mutations rejected");
    const created = await api("/account/agents", { name: "Test Dot", permission: "public_read" }, cookie);
    assert.equal(created.status, 201); const agent = await created.json();
    assert(agent.token.startsWith("gha_"));
    const principal = await agentFromToken(agent.token); assert(principal); assert.notEqual(principal.principal_id, owner.principal_id);
    const row = (await db().query("select token_hash from agent_credentials where agent_id=$1", [agent.agent_id])).rows[0];
    assert.notEqual(row.token_hash, agent.token);
    assert(!(await (await api("/account/agents", undefined, cookie)).text()).includes(agent.token));
    assert.equal((await api("/account/agents", undefined, undefined, { authorization: `Bearer ${agent.token}` })).status, 401);
    pass("agent has its own principal, hashed token and no account-admin access");
    async function rpc(name: string, args = {}, token = agent.token) {
      const response = await coord.app.request("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: name === "tools/list" ? name : "tools/call", params: name === "tools/list" ? {} : { name, arguments: args } }) });
      return { status: response.status, body: await response.json() };
    }
    const listed = await rpc("tools/list");
    assert(!listed.body.result.tools.some((t: { name: string }) => ["update_offer", "revoke_lease"].includes(t.name)));
    pass("delegated MCP tools exclude owner administration");
    internalAdapters.push({ id: "account-test", owner_id: "provider:account-test", async invoke() { return { state: "succeeded", observation: { kind: "value", value: 21, unit: "C", captured_at: null, note: "SIMULATED account test" } }; } });
    const manifest: DeviceManifest = { protocol_version: PROTOCOL_VERSION, local_key: "sensor", name: "SIMULATED account test sensor", device_class: "sensor", transport: "http-public", access_type: "public_observation", terms: { price_cents: 0, currency: "USD", max_duration_s: 60 }, capabilities: [{ capability_id: "temperature.read", semantic_type: "temperature.read", kind: "measure", title: "Temperature", description: "Simulated", input_schema: { type: "object" }, verification: "observation" }, { capability_id: "light.set", semantic_type: "light.set", kind: "act", title: "Light", description: "Simulated", input_schema: { type: "object" }, verification: "reported_state" }] };
    const [sensor] = await publishFromAdapter("account-test", [{ manifest }]);
    const [shared] = await publishFromAdapter("account-test", [{ manifest: { ...manifest, local_key: "shared", access_type: "owner_shared", terms: { ...manifest.terms, price_cents: 100 } } }]);
    assert((await rpc("invoke_capability", { ref: `${sensor.device_id}/light.set` })).body.result.isError);
    assert((await rpc("quote_lease", { refs: [`${shared.device_id}/temperature.read`] })).body.result.isError);
    pass("read-only scope denies physical actions and private-device lease requests");
    const observation = await rpc("invoke_capability", { ref: `${sensor.device_id}/temperature.read`, idempotency_key: "test-account-once" });
    assert(!observation.body.result.isError);
    const replay = await rpc("invoke_capability", { ref: `${sensor.device_id}/temperature.read`, idempotency_key: "test-account-once" });
    assert(!replay.body.result.isError);
    const activity = await (await api("/account/activity", undefined, cookie)).json();
    assert.equal(activity.calls.length, 4); assert.equal(activity.invocations.length, 1); assert.equal(activity.invocations[0].agent_name, "Test Dot");
    assert.equal(activity.invocations[0].observation.value, 21); assert(activity.calls.some((c: { state: string }) => c.state === "failed"));
    pass("successful calls, denied calls and physical observations persist with agent attribution; retry is idempotent");
    const otherReg = await api("/account/register", { username: "other_owner", password });
    const otherCookie = otherReg.headers.get("set-cookie")!.split(";")[0];
    const otherActivity = await (await api("/account/activity", undefined, otherCookie)).json();
    assert.equal(otherActivity.calls.length, 0); assert.equal(otherActivity.invocations.length, 0);
    assert.equal((await api(`/account/agents/${agent.agent_id}/revoke`, {}, otherCookie)).status, 404);
    pass("accounts cannot read or revoke another account's agents");
    const controlResp = await api("/account/agents", { name: "Control Dot", permission: "hardware_control", max_spend_cents: 0 }, cookie);
    const control = await controlResp.json();
    const quote = await rpc("quote_lease", { refs: [`${shared.device_id}/temperature.read`] }, control.token);
    assert(!quote.body.result.isError);
    const quoteResult = JSON.parse(quote.body.result.content[0].text);
    const offerId = quoteResult.offer?.offer_id || quoteResult.offer_id;
    assert(offerId);
    const budgetDenied = await rpc("accept_quote", { offer_id: offerId, max_spend_cents: 1000 }, control.token);
    assert(budgetDenied.body.result.isError); assert.match(budgetDenied.body.result.content[0].text, /budget/);
    pass("agent cannot raise its per-lease budget through MCP arguments");
    assert.equal((await api(`/account/agents/${agent.agent_id}/revoke`, {}, cookie)).status, 200);
    assert.equal(await agentFromToken(agent.token), null); assert.equal((await rpc("tools/list")).status, 401);
    pass("revoked tokens are rejected on the next request");
    assert.equal((await api("/account/logout", {}, cookie)).status, 200);
    console.log(`${count} account and agent integration checks passed`);
  } finally { await coord.stop(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
