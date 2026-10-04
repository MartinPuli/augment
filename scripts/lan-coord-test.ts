/**
 * LAN routes through the real coordinator HTTP API (standalone, in-memory PGlite, port 3177):
 *   GET /api/v1/me → POST /api/v1/lan/scan → GET /api/v1/lan/status → POST /api/v1/invoke
 * against the SIMULATED devices from scripts/lan-fake-devices.ts (start that first).
 *
 *   pnpm exec tsx scripts/lan-coord-test.ts
 */
import os from "node:os";
import path from "node:path";

process.env.GHOST_QUIET = "1";
process.env.GHOST_SKIP_ADAPTERS = "1"; // only the scan publishes
process.env.GHOST_LAN_STORE = path.join(os.tmpdir(), `ghost-lan-coord-test-${process.pid}.json`);
process.env.GHOST_LAN_EXTRA_HOSTS ??= "127.0.0.1:8081,127.0.0.1:8082,127.0.0.1:8083,roku@127.0.0.1:8084,kasa@127.0.0.1:9999";
process.env.HA_URL ??= "http://127.0.0.1:8124";
process.env.HA_TOKEN ??= "sim-token";

const PORT = Number(process.env.LAN_COORD_PORT ?? 3177);
const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0,
  failed = 0;
const check = (cond: unknown, name: string, extra?: unknown) => {
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && extra !== undefined ? ` — ${JSON.stringify(extra).slice(0, 400)}` : ""}`);
};

async function main() {
  const { startCoordinator } = await import("../src/lib/ghost/server");
  const coord = await startCoordinator({ dataDir: "memory", listenPort: PORT, hostname: "127.0.0.1" });
  type Dev = import("../src/lib/ghost/contracts").Device;
  try {
    const me = (await (await fetch(`${BASE}/api/v1/me`)).json()) as { principal_id: string; owner_token: string };
    const H = { authorization: `Bearer ${me.owner_token}`, "content-type": "application/json" };
    const api = async <T = Record<string, unknown>>(method: string, p: string, body?: unknown) => {
      const r = await fetch(`${BASE}${p}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: (await r.json().catch(() => ({}))) as T };
    };

    const unauth = await fetch(`${BASE}/api/v1/lan/scan`, { method: "POST" });
    check(unauth.status === 401, "scan requires a principal", unauth.status);
    const badBody = await api("POST", "/api/v1/lan/scan", { timeout_ms: 5 });
    check(badBody.status === 400, "scan validates input", badBody);

    const t0 = Date.now();
    const scan = await api<{ devices: Dev[]; found: number; verified: number; candidates: number; duration_ms: number; interfaces: unknown[]; note?: string }>("POST", "/api/v1/lan/scan", {});
    console.log(`  scan: HTTP ${scan.status}, ${scan.json.found} found / ${scan.json.verified} verified / ${scan.json.candidates} candidates in ${Date.now() - t0} ms`);
    check(scan.status === 200 && scan.json.devices.length >= 10, "scan publishes devices", scan.json);
    check(scan.json.devices.every((d) => d.owner_id === me.principal_id && d.access_type === "own_device" && d.transport === "wifi-lan"), "devices owned by the scanner, own_device, wifi-lan");
    check(scan.json.devices.every((d) => d.terms.price_cents === 0), "price 0");

    const again = await api<{ cached?: boolean }>("POST", "/api/v1/lan/scan", {});
    check(again.status === 200 && again.json.cached === true, "second scan within 5 s returns the cached result", again.json);

    const status = await api<{ last_scan: { found: number } | null; home_assistant: { configured: boolean } }>("GET", "/api/v1/lan/status");
    check(status.status === 200 && status.json.last_scan?.found === scan.json.found, "status reports the last scan", status.json);

    const find = (driver: string) => scan.json.devices.find((d) => (d.meta as { driver?: string }).driver === driver);
    const invoke = async (d: Dev | undefined, capability_id: string, args: Record<string, unknown>) => {
      if (!d) return { status: 0, json: { error: "device missing" } as Record<string, unknown> };
      return api<{ invocation: { state: string; error?: string }; observation?: { value?: unknown; data?: unknown } }>("POST", "/api/v1/invoke", {
        device_id: d.device_id,
        capability_id,
        arguments: args,
        timeout_ms: 15000,
      });
    };
    for (const [driver, cap, args] of [
      ["shelly", "switch.set", { on: true }],
      ["wled", "light.set", { color: "#8a2be2", brightness: 80 }],
      ["kasa", "switch.set", { on: false }],
      ["homeassistant", "light.read", {}],
    ] as const) {
      const r = await invoke(find(driver), cap, args);
      const inv = (r.json as { invocation?: { state: string; error?: string } }).invocation;
      check(r.status === 200 && inv?.state === "succeeded", `invoke ${driver} ${cap} via /api/v1/invoke`, r.json);
    }
    const hueBridge = find("hue-bridge");
    check(!!hueBridge && hueBridge.status === "candidate", "Hue bridge published as candidate until paired", hueBridge?.status);
    await fetch("http://127.0.0.1:8083/sim/reset").catch(() => {});
    const pair1 = await invoke(hueBridge, "hue.pair", {});
    check((pair1.json as { invocation?: { state: string } }).invocation?.state === "failed", "hue.pair before link button → failed with instructions", pair1.json);
    await fetch("http://127.0.0.1:8083/sim/linkbutton");
    const pair2 = await invoke(hueBridge, "hue.pair", {});
    check((pair2.json as { invocation?: { state: string } }).invocation?.state === "succeeded", "hue.pair after (simulated) link button → succeeded", pair2.json);
    const devs = await api<Dev[] | { devices: Dev[] }>("GET", "/api/v1/devices");
    const list = Array.isArray(devs.json) ? devs.json : devs.json.devices;
    const hueLights = list.filter((d) => (d.meta as { driver?: string }).driver === "hue-light");
    check(hueLights.length === 2, "pairing published the Hue lights into the catalog", list.map((d) => d.name));
    const purple = await invoke(hueLights.find((d) => d.capabilities.some((c) => c.input_schema.properties?.color)), "light.set", { color: "#8a2be2" });
    check((purple.json as { invocation?: { state: string } }).invocation?.state === "succeeded", "Hue light → purple", purple.json);
  } finally {
    await coord.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
