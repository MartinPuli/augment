/** SIMULATED hardware; real coordinator, MCP, HTTP, WebSocket and on-disk connector state. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LanGateway, ActionJournal } from "../connectors/lan/gateway";
import { scan } from "../src/lib/ghost/server/adapters/lan/scan";
import { startCoordinator } from "../src/lib/ghost/server";
import type { Device, InvokeResponse, MeResponse, QuoteResponse, Lease } from "../src/lib/ghost/contracts";

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, label: string) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await pause(100); }
  throw new Error(`Timed out: ${label}`);
}
let checks = 0;
function check(value: unknown, label: string) { assert(value, label); checks++; console.log(`✓ ${label}`); }
async function main() {
  const stateDir = await mkdtemp(path.join(tmpdir(), "ghost-gateway-test-"));
  const port = Number(process.env.HARDWARE_TEST_PORT ?? 4381);
  const base = `http://127.0.0.1:${port}`;
  const simPorts = { SIM_SHELLY_PORT: "4382", SIM_WLED_PORT: "4383", SIM_HUE_PORT: "4384", SIM_ROKU_PORT: "4385", SIM_KASA_PORT: "4386", SIM_HA_PORT: "4387" };
  delete process.env.GHOST_PRINTERS_CONFIG; // Never discover an operator's real printers in this simulator test.
  process.env.HA_URL = "http://127.0.0.1:4387"; process.env.HA_TOKEN = "sim-token";
  process.env.GHOST_LAN_STORE = path.join(stateDir, "lan.json"); process.env.GHOST_LAN_NO_PUBLISH = "1";
  process.env.GHOST_DB = "pglite"; delete process.env.DATABASE_URL;
  const sim = spawn(process.execPath, ["--import", "tsx", "scripts/lan-fake-devices.ts", "--quiet"], { env: { ...process.env, ...simPorts }, stdio: ["ignore", "ignore", "pipe"] });
  let errors = ""; sim.stderr.on("data", d => errors += d);
  let coordinator: Awaited<ReturnType<typeof startCoordinator>> | undefined;
  let gateway: LanGateway | undefined;
  let mcp: Client | undefined;
  try {
    await until(async () => { if (sim.exitCode !== null) throw new Error(errors); return fetch(`${process.env.HA_URL}/api/states`, { headers: { authorization: "Bearer sim-token" } }).then(r => r.ok).catch(() => false); }, "simulator");
    coordinator = await startCoordinator({ dataDir: "memory", skipAdapters: true, hostname: "127.0.0.1", listenPort: port });
    const api = async <T>(token: string | null, route: string, body?: unknown): Promise<T> => {
      const response = await fetch(`${base}/api/v1${route}`, { method: body ? "POST" : "GET", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
      return await response.json() as T;
    };
    const owner = await api<MeResponse>(null, "/me");
    const stranger = await api<MeResponse>(null, "/me");
    const scanOptions = { discovery: false, extraHosts: "wled@127.0.0.1:4383,shelly@127.0.0.1:4382" };
    const discoveries = (await scan(scanOptions)).discoveries;
    check(discoveries.length >= 10, "read-only discovery finds simulated LAN and Home Assistant devices");
    const allow = ["ha:light.sim_kitchen", "ha:sensor.sim_temperature", "ha:camera.sim_porch"];
    const pairing = await api<{ code: string; pairing_id: string }>(owner.owner_token, "/pairings", {});
    const options = { coordinator: base, pairingCode: pairing.code, allow, stateDir, scanOptions };
    gateway = new LanGateway(options);
    await gateway.refresh(discoveries); gateway.start();
    await until(() => gateway!.connector.getSnapshot().status === "pending_confirmation", "owner pairing confirmation");
    check((await api<Device[]>(owner.owner_token, "/devices?mine=1")).length === 0, "gateway publishes nothing until the owner confirms pairing");
    await api(owner.owner_token, `/pairings/${pairing.pairing_id}/confirm`, {});
    await until(() => gateway!.connector.getSnapshot().devices.length === 3 && gateway!.connector.getSnapshot().devices.every(d => d.device_id), "gateway publication");
    let devices = await api<Device[]>(owner.owner_token, "/devices?mine=1");
    check(devices.length === 3 && devices.every(d => allow.includes(d.local_key)), "only the owner's three allowlisted devices are published");
    check(!JSON.stringify(devices).includes("sim-token") && !JSON.stringify(devices).includes("127.0.0.1"), "device catalog contains neither hardware credentials nor LAN addresses");
    const camera = devices.find(d => d.device_class === "camera")!;
    const denied = await fetch(`${base}/api/v1/invoke`, { method: "POST", headers: { authorization: `Bearer ${stranger.owner_token}`, "content-type": "application/json" }, body: JSON.stringify({ device_id: camera.device_id, capability_id: "camera.snapshot", arguments: {}, idempotency_key: "stranger" }) });
    check(!denied.ok, "another principal cannot invoke the owner's camera without access");
    const light = devices.find(d => d.device_class === "light")!;
    const request = { device_id: light.device_id, capability_id: "light.set", arguments: { on: true, brightness: 40 }, idempotency_key: "one-light-change", timeout_ms: 10000 };
    const first = await api<InvokeResponse>(owner.owner_token, "/invoke", request);
    check(first.invocation.state === "succeeded" && first.observation?.value === true, "light action traverses WebSocket and is read back through Home Assistant");
    const again = await api<InvokeResponse>(owner.owner_token, "/invoke", request);
    check(again.invocation.invocation_id === first.invocation.invocation_id, "retry reuses the original invocation");
    const sensor = devices.find(d => d.local_key === "ha:sensor.sim_temperature")!;
    const measured = await api<InvokeResponse>(owner.owner_token, "/invoke", { device_id: sensor.device_id, capability_id: "sensor.read", arguments: {}, idempotency_key: "temperature" });
    check(measured.observation?.value === 22.4 && !!measured.observation.captured_at, "temperature returns the simulated device's value and capture timestamp");
    const image = await api<InvokeResponse>(owner.owner_token, "/invoke", { device_id: camera.device_id, capability_id: "camera.snapshot", arguments: {}, idempotency_key: "camera" });
    check(image.invocation.state === "succeeded" && image.observation?.kind === "image", "camera bytes upload through the invocation-scoped observation endpoint");
    const media = await fetch(new URL(image.observation!.media_url!, base));
    const bytes = new Uint8Array(await media.arrayBuffer());
    check(bytes[0] === 255 && bytes[1] === 216, "stored camera observation contains actual JPEG bytes (SIMULATED frame)");
    mcp = new Client({ name: "hardware-test", version: "1" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${owner.owner_token}` } } }));
    const tools = (await mcp.listTools()).tools.map(t => t.name);
    check(tools.includes("list_hardware_guides") && tools.includes("read_hardware_guide"), "hardware skills are discoverable through the real MCP endpoint");
    const guide = await mcp.callTool({ name: "read_hardware_guide", arguments: { id: "home-assistant-best-practices", file: "references/device-control.md" } });
    check(!guide.isError && JSON.stringify(guide).includes("revision"), "an agent can read a pinned upstream hardware skill reference");
    const traversal = await mcp.callTool({ name: "read_hardware_guide", arguments: { id: "ghost-hardware", file: "../../.env" } });
    check(traversal.isError, "guide reader rejects files outside the catalog");
    const quoted = await api<QuoteResponse>(stranger.owner_token, "/quotes", { refs: [{ device_id: camera.device_id, capability_id: "camera.snapshot" }], duration_s: 30 });
    const accepted = await api<{ lease: Lease }>(stranger.owner_token, `/quotes/${quoted.offer.offer_id}/accept`, { max_spend_cents: 0 });
    check(accepted.lease.state === "reserved", "free access from another agent still requires the device owner's approval");
    await api(owner.owner_token, `/leases/${accepted.lease.lease_id}/approve`, {});
    const borrowed = await api<InvokeResponse>(stranger.owner_token, "/invoke", { device_id: camera.device_id, capability_id: "camera.snapshot", arguments: {}, lease_id: accepted.lease.lease_id, idempotency_key: "borrowed-eyes" });
    check(borrowed.invocation.state === "succeeded" && borrowed.observation?.kind === "image", "approved visitor can borrow the camera and receive its image");
    await api(owner.owner_token, `/leases/${accepted.lease.lease_id}/revoke`, {});
    const revoked = await fetch(`${base}/api/v1/invoke`, { method: "POST", headers: { authorization: `Bearer ${stranger.owner_token}`, "content-type": "application/json" }, body: JSON.stringify({ device_id: camera.device_id, capability_id: "camera.snapshot", arguments: {}, lease_id: accepted.lease.lease_id, idempotency_key: "after-revoke" }) });
    check(!revoked.ok, "revoked access cannot take another camera snapshot");
    const originalMode = process.env.NODE_ENV;
    Object.assign(process.env, { NODE_ENV: "production" });
    const blockedScan = await fetch(`${base}/api/v1/lan/scan`, { method: "POST", headers: { authorization: `Bearer ${stranger.owner_token}`, "content-type": "application/json" }, body: "{}" });
    if (originalMode === undefined) Reflect.deleteProperty(process.env, "NODE_ENV"); else Object.assign(process.env, { NODE_ENV: originalMode });
    check(blockedScan.status === 403, "hosted coordinator rejects scanning its network on behalf of a visitor");
    const before = new Map(devices.map(d => [d.local_key, d.device_id]));
    gateway.stop(); await pause(200);
    gateway = new LanGateway({ ...options, pairingCode: undefined });
    await gateway.refresh(discoveries); gateway.start();
    await until(() => gateway!.connector.getSnapshot().devices.every(d => !!d.device_id), "credential reconnect");
    devices = await api<Device[]>(owner.owner_token, "/devices?mine=1");
    check(devices.length === 3 && devices.every(d => before.get(d.local_key) === d.device_id), "gateway restarts with its stored credential and preserves device identities");
    await gateway.refresh([]);
    await until(async () => (await api<Device[]>(owner.owner_token, "/devices?mine=1")).every(d => !d.online), "offline propagation");
    check(true, "missing hardware is unpublished instead of remaining available");
    const journalDir = path.join(stateDir, "receipt-test");
    const journal = new ActionJournal(journalDir); let physicalCalls = 0;
    await journal.run("stable-action", async () => { physicalCalls++; return { value: true }; });
    const restart = new ActionJournal(journalDir);
    await restart.run("stable-action", async () => { physicalCalls++; return { value: false }; });
    check(physicalCalls === 1, "on-disk action receipts prevent repeat after process restart");
    const receiptFile = path.join(journalDir, (await readdir(journalDir))[0]);
    check(((await stat(receiptFile)).mode & 0o777) === 0o600, "hardware action receipts are owner-readable only");
    await writeFile(receiptFile, JSON.stringify({ state: "started" }));
    await assert.rejects(restart.run("stable-action", async () => { physicalCalls++; return {}; }), /result is unknown/);
    check(physicalCalls === 1, "incomplete action receipt yields unknown without re-executing hardware");
    check(!!await readFile(receiptFile), "crash marker remains available for diagnosis");
    console.log(`\n${checks} checks passed. Hardware was SIMULATED; network/permissions/persistence/MCP were real.`);
  } finally {
    await mcp?.close(); gateway?.stop(); await pause(100); await coordinator?.stop();
    const exited = once(sim, "exit"); sim.kill("SIGTERM"); if (sim.exitCode === null) await exited;
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
