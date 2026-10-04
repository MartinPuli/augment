/** Real coordinator + disk-backed PGlite, SIMULATED hardware. No LAN scan or microphone capture. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startCoordinator } from "../src/lib/ghost/server";
import { internalAdapters } from "../src/lib/ghost/server/adapters";
import type { InternalAdapter } from "../src/lib/ghost/server/adapters/types";
import type { DeviceManifest, MeResponse, InvokeResponse } from "../src/lib/ghost/contracts";
import type { DeviceConnectionMemory } from "../src/lib/ghost/client/api-types";
import { publishFromAdapter } from "../src/lib/ghost/server/registry";
import { db } from "../src/lib/ghost/server/db";
import { PROTOCOL_VERSION } from "../src/lib/ghost/contracts";

delete process.env.DATABASE_URL;
process.env.GHOST_QUIET = "1";
async function main() {
const dir = await mkdtemp(path.join(os.tmpdir(), "ghost-memory-"));
const adapter: InternalAdapter = {
  id: "memory-test", owner_id: "provider:memory-test",
  async invoke(_d, _c, args) {
    if (args.fail) return { state: "failed", error: "SIMULATED unplugged input" };
    return { state: "succeeded", observation: { kind: "value", value: -35, unit: "dBFS", captured_at: new Date().toISOString(), note: "SIMULATED hardware" } };
  },
};
internalAdapters.push(adapter);
let coord = await startCoordinator({ dataDir: dir, skipAdapters: true });
let checks = 0;
function check(name: string, fn: () => void) { fn(); checks++; console.log(`PASS ${name}`); }
async function request<T>(token: string | null, route: string, body?: unknown): Promise<T> {
  const r = await coord.app.request(`/api/v1${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(r.status < 400, true, `${route}: ${r.status}`);
  return r.json() as Promise<T>;
}
try {
  const owner = await request<MeResponse>(null, "/me");
  const outsider = await request<MeResponse>(null, "/me");
  const manifest: DeviceManifest = {
    protocol_version: PROTOCOL_VERSION, local_key: "remembered-input", name: "SIMULATED paired microphone",
    device_class: "computer", transport: "browser", access_type: "own_device",
    terms: { price_cents: 0, currency: "USD", max_duration_s: 60 },
    capabilities: [{ capability_id: "audio.level", kind: "measure", semantic_type: "sound_level.read", title: "Sound level", description: "SIMULATED input", input_schema: { type: "object", properties: { seconds: { type: "number" }, fail: { type: "boolean" } } }, verification: "observation" }],
    meta: { module_connections: { microphone: { method: "browser-audio-input", input_label: "SIMULATED Bluetooth mic" } } },
  };
  const [device] = await publishFromAdapter(adapter.id, [{ manifest, owner_id: owner.principal_id, status: "configured" }]);
  const recall = () => request<DeviceConnectionMemory[]>(owner.owner_token, `/device-connections?device_id=${device.device_id}`);
  let memory = (await recall())[0];
  check("an enabled device is remembered before its first use, without fabricated success", () => assert.equal(memory.history.succeeded, 0));
  check("microphone recipe preserves its selected input label and explains OS Bluetooth pairing", () => {
    assert.equal(memory.guide.input_label, "SIMULATED Bluetooth mic");
    assert(memory.guide.steps.some((s) => s.includes("operating system")));
  });
  const out = await request<InvokeResponse>(owner.owner_token, "/invoke", { device_id: device.device_id, capability_id: "audio.level", arguments: { seconds: 2 }, idempotency_key: "remember-once" });
  await request(owner.owner_token, "/invoke", { device_id: device.device_id, capability_id: "audio.level", arguments: { seconds: 2 }, idempotency_key: "remember-once" });
  for (let i = 0; i < 9; i++) await request(owner.owner_token, "/invoke", { device_id: device.device_id, capability_id: "audio.level", arguments: { fail: true } });
  memory = (await recall())[0];
  check("idempotent retries do not inflate success counts", () => assert.equal(memory.history.succeeded, 1));
  check("failed attempts remain failed", () => assert.equal(memory.history.failed, 9));
  check("older successful arguments survive newer failures", () => {
    assert.deepEqual(memory.history.last_successful[0].arguments, { seconds: 2 });
    assert.equal(memory.history.last_successful[0].observation_id, out.observation?.observation_id);
  });
  check("current schema and verification accompany the remembered call", () => assert.equal(memory.capabilities[0].verification, "observation"));
  const outsideMemory = await request(outsider.owner_token, "/device-connections");
  check("another principal cannot recall this owner's private device calls", () => assert.deepEqual(outsideMemory, []));
  const unauth = await coord.app.request("/api/v1/device-connections");
  check("memory endpoint requires an authenticated identity", () => assert.equal(unauth.status, 401));
  const mcp = await coord.app.request("/mcp", {
    method: "POST", headers: { authorization: `Bearer ${owner.owner_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recall_device_connections", arguments: { device_id: device.device_id } } }),
  });
  const result = await mcp.json() as { result?: { content: { text?: string }[]; isError?: boolean } };
  check("external agents can retrieve connection memory through MCP", () => {
    assert.equal(result.result?.isError, undefined);
    assert(result.result?.content[0].text?.includes(out.invocation.invocation_id));
  });
  await db().query("update devices set online = false where device_id = $1", [device.device_id]);
  await coord.stop();
  coord = await startCoordinator({ dataDir: dir, skipAdapters: true });
  memory = (await recall())[0];
  check("device identity and invocation evidence survive a coordinator restart", () => {
    assert.equal(memory.device_id, device.device_id);
    assert.equal(memory.history.succeeded, 1);
    assert.equal(memory.history.last_successful[0].invocation_id, out.invocation.invocation_id);
  });
  check("offline devices remain remembered without being reported as available", () => {
    assert.equal(memory.online, false);
    assert.equal(memory.history.last_successful[0].available_now, false);
  });
  const [again] = await publishFromAdapter(adapter.id, [{ manifest, owner_id: owner.principal_id }]);
  check("republishing retains the remembered device identity", () => assert.equal(again.device_id, device.device_id));
  const changed = { ...manifest, capabilities: [{ ...manifest.capabilities[0], capability_id: "audio.record" }] };
  await publishFromAdapter(adapter.id, [{ manifest: changed, owner_id: owner.principal_id }]);
  memory = (await recall())[0];
  check("removed capabilities stay in history but cannot be suggested as available", () => assert.equal(memory.history.last_successful[0].available_now, false));
  console.log(`${checks} checks passed. Hardware was SIMULATED.`);
} finally {
  await coord.stop();
  internalAdapters.splice(internalAdapters.indexOf(adapter), 1);
  await rm(dir, { recursive: true, force: true });
}
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
