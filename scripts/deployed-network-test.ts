/**
 * End-to-end check of a hosted coordinator, using SIMULATED hardware only.
 *
 * GHOST_ORIGIN=https://your-site.example \
 * GHOST_WS_URL=wss://your-coordinator.example/v1/device-channel \
 * pnpm tsx scripts/deployed-network-test.ts
 *
 * Creates one fresh test principal and one clearly labeled simulated device.
 * Does not load local secrets, contact physical devices, or invoke partner tools.
 * Leaves its isolated test history in the coordinator; disconnects its device.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Device, InvokeResponse, MeResponse, PairingResponse } from "../src/lib/ghost/contracts";
import type { DeviceConnectionMemory, PairingInfo } from "../src/lib/ghost/client/api-types";
import { simulatedManifests, startFakeConnector, type FakeConnector } from "./coord-fake-connector";

const secrets = new Set<string>();
let checks = 0;
function check(name: string, condition: unknown): asserts condition {
  assert(condition, name);
  checks++;
  console.log(`PASS ${name}`);
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function safeError(error: unknown): string {
  let message = error instanceof Error ? error.message : "Unknown test failure";
  for (const secret of secrets) message = message.replaceAll(secret, "[redacted]");
  return message.replace(/\b(?:gho|cred|prov)_[\w-]+/g, "[redacted]").slice(0, 700);
}

async function main() {
  if (!process.env.GHOST_ORIGIN) throw new Error("Set GHOST_ORIGIN to the deployed site's HTTPS origin.");
  const origin = new URL(process.env.GHOST_ORIGIN);
  assert(["https:", "http:"].includes(origin.protocol), "GHOST_ORIGIN must use HTTP or HTTPS");
  assert(!origin.username && !origin.password, "Do not put credentials in GHOST_ORIGIN");
  const ws = new URL(process.env.GHOST_WS_URL ?? `${origin.origin.replace(/^http/, "ws")}/v1/device-channel`);
  assert(["wss:", "ws:"].includes(ws.protocol), "GHOST_WS_URL must use WS or WSS");
  assert(!ws.username && !ws.password, "Do not put credentials in GHOST_WS_URL");
  assert(ws.pathname === "/v1/device-channel" && !ws.search && !ws.hash, "GHOST_WS_URL must end in /v1/device-channel");

  let ownerToken: string | undefined;
  let connector: FakeConnector | undefined;
  async function request<T>(route: string, options: { method?: string; body?: unknown; token?: string; cookie?: string; expected?: number } = {}): Promise<{ json: T; response: Response }> {
    const response = await fetch(`${origin.origin}${route}`, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(route === "/mcp" ? { accept: "application/json, text/event-stream" } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(45_000),
    });
    assert.equal(response.status, options.expected ?? 200, `${route.split("?")[0]} returned HTTP ${response.status}`);
    return { json: await response.json() as T, response };
  }
  const api = async <T>(route: string, body?: unknown) =>
    (await request<T>(`/api/v1${route}`, { token: ownerToken, body })).json;
  const mcp = async <T>(id: number, method: string, params: unknown) =>
    (await request<T>("/mcp", { token: ownerToken, body: { jsonrpc: "2.0", id, method, params } })).json;

  try {
    const health = await api<{ ok: boolean }>("/health");
    check("deployed site reaches a healthy coordinator", health.ok === true);

    const { json: owner, response } = await request<MeResponse>("/api/v1/me");
    ownerToken = owner.owner_token;
    secrets.add(ownerToken);
    const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
    check("a fresh test identity receives an owner token and session cookie", !!ownerToken && cookie.startsWith("ghost_pid="));
    const cookieMe = (await request<MeResponse>("/api/v1/me", { cookie })).json;
    check("the session cookie restores the same identity", cookieMe.principal_id === owner.principal_id);
    check("bearer authentication restores the same identity", (await api<MeResponse>("/me")).principal_id === owner.principal_id);

    const invitation = (await request<PairingResponse>("/api/v1/pairings", { method: "POST", token: ownerToken, expected: 201 })).json;
    check("pairing creates a one-use invitation", /^[A-Z0-9]{6}$/.test(invitation.code));
    const manifest = simulatedManifests({ lampPrice: 0, lampFloor: 0, quota: 20 })[0];
    manifest.local_key = `deployed-test-${randomUUID()}`;
    manifest.name = "SIMULATED deployment test lamp (no physical hardware)";
    manifest.access_type = "own_device";
    connector = startFakeConnector({
      url: ws.origin,
      pairing_code: invitation.code,
      label: "SIMULATED deployment test connector",
      manifests: [manifest],
      log: () => {},
    });
    const pending = await connector.waitFor("pending_confirmation", 15_000);
    check("the hosted WebSocket receives the pairing request", pending.pairing_id === invitation.pairing_id);
    const pairings = await api<PairingInfo[]>("/pairings?pending=1");
    check("the HTTP API sees the pending WebSocket pairing", pairings.some((p) => p.pairing_id === invitation.pairing_id && p.status === "pending"));
    await request(`/api/v1/pairings/${invitation.pairing_id}/confirm`, { method: "POST", token: ownerToken });
    const welcome = await connector.welcome;
    secrets.add(welcome.credential);
    check("owner confirmation authorizes the waiting connector", welcome.owner_id === owner.principal_id && !!welcome.credential);
    const publication = await connector.published;
    const deviceId = publication.devices[0]?.device_id;
    check("the confirmed connector publishes its simulated device", !!deviceId && publication.devices[0].status === "configured");
    const device = await api<Device>(`/devices/${deviceId}`);
    check("the HTTP catalog sees the owned device online", device.online && device.owner_id === owner.principal_id);

    const invocation = await api<InvokeResponse>("/invoke", {
      device_id: deviceId, capability_id: "light.set", arguments: { on: true, brightness: 37 },
      idempotency_key: `deployed-test-${randomUUID()}`,
    });
    check("an HTTP invocation travels through the hosted WebSocket and returns its result", invocation.invocation.state === "succeeded" && invocation.observation?.data?.on === true && invocation.observation.data.brightness === 37);
    check("the simulator actually received the invocation", connector.received.some((m) => m.type === "invoke" && m.invocation_id === invocation.invocation.invocation_id) && connector.lamp.on && connector.lamp.brightness === 37);
    const memory = (await api<DeviceConnectionMemory[]>(`/device-connections?device_id=${encodeURIComponent(deviceId)}`))[0];
    check("successful device use is retained in connection memory", memory?.history.succeeded === 1 && memory.history.last_successful[0]?.invocation_id === invocation.invocation.invocation_id);
    check("remembered arguments contain the actual successful request", memory.history.last_successful[0].arguments.brightness === 37);

    const initialization = await mcp<{ result?: { protocolVersion?: string }; error?: unknown }>(1, "initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ghost-deployed-network-test", version: "1" },
    });
    check("external-agent MCP initialization succeeds", !!initialization.result?.protocolVersion && !initialization.error);
    const tools = await mcp<{ result?: { tools: { name: string }[] } }>(2, "tools/list", {});
    const toolNames = tools.result?.tools.map((tool) => tool.name) ?? [];
    check("MCP exposes device discovery, actions, and memory", ["search_capabilities", "invoke_capability", "recall_device_connections"].every((name) => toolNames.includes(name)));
    const recall = await mcp<{ result?: { content: { text?: string }[]; isError?: boolean } }>(3, "tools/call", {
      name: "recall_device_connections", arguments: { device_id: deviceId },
    });
    check("an external agent can recall the actual device invocation", recall.result?.isError !== true && !!recall.result?.content.some((item) => item.text?.includes(invocation.invocation.invocation_id)));

    connector.close();
    let offline = false;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !offline) {
      offline = (await api<Device>(`/devices/${deviceId}`)).online === false;
      if (!offline) await pause(300);
    }
    check("disconnecting the connector marks the device offline", offline);
    const offlineMemory = (await api<DeviceConnectionMemory[]>(`/device-connections?device_id=${encodeURIComponent(deviceId)}`))[0];
    check("offline devices retain history without being reported as available", offlineMemory?.online === false && offlineMemory.history.succeeded === 1 && offlineMemory.history.last_successful[0]?.available_now === false);
    console.log(`${checks} checks passed against the deployed HTTP and WebSocket endpoints. Hardware was SIMULATED.`);
  } finally {
    if (connector) {
      connector.close();
      if (connector.ws.readyState !== 3) {
        const closed = new Promise<void>((resolve) => connector!.ws.once("close", () => resolve()));
        await Promise.race([closed, pause(1000)]);
        if (Number(connector.ws.readyState) !== 3) connector.ws.terminate();
      }
    }
  }
}

main().catch((error) => {
  console.error(`FAIL ${safeError(error)}`);
  process.exitCode = 1;
});
