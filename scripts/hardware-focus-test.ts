/** Regression: retired software must remain inaccessible even with persisted device IDs. */
import assert from "node:assert/strict";
import { startCoordinator } from "../src/lib/ghost/server";
import { internalAdapters } from "../src/lib/ghost/server/adapters";
import { publishFromAdapter, listDevices, searchCapabilities, getDevice } from "../src/lib/ghost/server/registry";
import { PROTOCOL_VERSION, type DeviceManifest } from "../src/lib/ghost/contracts";

async function main() {
  delete process.env.DATABASE_URL;
  process.env.GHOST_QUIET = "1";
  const coordinator = await startCoordinator({ dataDir: "memory", skipAdapters: true });
  let checks = 0;
  const pass = (name: string) => { checks++; console.log(`PASS ${name}`); };
  try {
    assert.deepEqual(internalAdapters.map(a => a.id).sort(), ["caltrans", "lan", "noaa"]); pass("only physical-source adapters registered");
    const manifest: DeviceManifest = { protocol_version: PROTOCOL_VERSION, local_key: "focus-test", name: "SIMULATED focus-test camera", device_class: "camera", transport: "http-public", access_type: "public_observation", terms: { price_cents: 0, currency: "USD", max_duration_s: 60 }, capabilities: [{ capability_id: "image.observe", kind: "observe", semantic_type: "image.observe", title: "SIMULATED image", description: "Fixture, not real hardware", input_schema: { type: "object" }, verification: "observation" }] };
    const [hardware] = await publishFromAdapter("caltrans", [{ manifest }]);
    const retired = [];
    for (const id of ["svc-google", "svc-news", "kernel"]) {
      retired.push(...await publishFromAdapter(id, [{ manifest: { ...manifest, name: `Retired ${id}` } }]));
    }
    assert.deepEqual((await listDevices()).map(d => d.device_id), [hardware.device_id]);
    assert.deepEqual((await searchCapabilities({})).map(d => d.device.device_id), [hardware.device_id]);
    for (const d of retired) assert.equal(await getDevice(d.device_id), null);
    pass("old software rows excluded from discovery, listing and direct lookup");
    const meResponse = await coordinator.app.request("/api/v1/me");
    assert.match(meResponse.headers.get("cache-control") || "", /no-store/);
    const me = await meResponse.json();
    const headers = { authorization: `Bearer ${me.owner_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
    for (const d of retired) {
      const r = await coordinator.app.request("/api/v1/invoke", { method: "POST", headers, body: JSON.stringify({ device_id: d.device_id, capability_id: "image.observe", idempotency_key: `retired-${d.device_id}` }) });
      assert.equal(r.status, 404);
    }
    pass("saved software device IDs cannot be invoked");
    for (const path of ["/api/v1/partners/status", "/api/v1/partners/mail/inbox", "/api/v1/google/status", "/api/v1/missions"]) {
      assert.equal((await coordinator.app.request(path, { headers })).status, 404);
    }
    pass("general software and agent workflow routes removed");
    async function rpc(method: string, params = {}) {
      const r = await coordinator.app.request("/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.error, undefined);
      return body.result;
    }
    const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "hardware-focus-test", version: "1" } });
    assert.match(init.instructions, /physical hardware/); pass("MCP initialization explains the hardware workflow");
    const tools = await rpc("tools/list");
    assert(tools.tools.some((t: { name: string }) => t.name === "invoke_capability"));
    assert(tools.tools.some((t: { name: string }) => t.name === "release_lease"));
    pass("hardware invocation and release tools remain available");
    const resources = await rpc("resources/list");
    assert(resources.resources.some((r: { uri: string }) => r.uri === "ghost://hardware/workflow"));
    const guide = await rpc("resources/read", { uri: "ghost://hardware/workflow" });
    assert.match(guide.contents[0].text, /test funds/); pass("MCP resource exposes access, evidence and test-payment limits");
    const search = await rpc("tools/call", { name: "search_capabilities", arguments: {} });
    assert(!search.isError); assert(!search.content[0].text.includes("Retired")); assert(search.content[0].text.includes(hardware.device_id)); pass("MCP catalog includes hardware only");
    console.log(`${checks} hardware-focus checks passed`);
  } finally { await coordinator.stop(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
