/** Simulated printer APIs; real GHOST gateway, coordinator and MCP. Never contacts real printers. */
import assert from "node:assert/strict";
import { printerSimulator as fixture } from "./fixtures/printer-simulator";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { startCoordinator } from "../src/lib/ghost/server";
import { LanGateway } from "../connectors/lan/gateway";
import { discoverPrinters, printerConfigs } from "../src/lib/ghost/server/adapters/lan/drivers/printers";

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
let checks = 0;
function check(ok: unknown, label: string) { assert(ok, label); checks++; console.log(`✓ ${label}`); }
async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), "ghost-printers-"));
  process.env.GHOST_PRINTERS_CONFIG = path.join(directory, "printers.json");
  process.env.GHOST_LAN_STORE = path.join(directory, "lan.json");
  process.env.SIM_PRINTER_KEY = "SIM-printer-key";
  process.env.GHOST_DB = "pglite"; delete process.env.DATABASE_URL;
  const octo = await fixture("octoprint"); const moon = await fixture("moonraker");
  const configs = [
    { id: "octo", name: "SIM OctoPrint", type: "octoprint", url: octo.url, api_key_env: "SIM_PRINTER_KEY", allow_job_control: true },
    { id: "moon", name: "SIM Moonraker", type: "moonraker", url: moon.url, api_key_env: "SIM_PRINTER_KEY", allow_job_control: true },
  ];
  const save = (value: unknown) => writeFile(process.env.GHOST_PRINTERS_CONFIG!, JSON.stringify(value), { mode: 0o600 });
  const base = "http://127.0.0.1:4401";
  let coordinator: Awaited<ReturnType<typeof startCoordinator>> | undefined;
  let gateway: LanGateway | undefined;
  const client = new Client({ name: "printer-integration-test", version: "1" });
  try {
    await save(configs.map(c => ({ ...c, allow_job_control: undefined })));
    const readonly = await discoverPrinters();
    check(readonly.discoveries.length === 2 && readonly.discoveries.every(d => d.manifest.capabilities.length === 1), "owner config defaults can publish monitoring without printer controls");
    await save([...configs, configs[0]]);
    await assert.rejects(printerConfigs(), /Duplicate/); check(true, "duplicate printer IDs are rejected");
    await save([{ ...configs[0], url: "http://user:secret@localhost" }]);
    await assert.rejects(printerConfigs(), /without credentials/); check(true, "credentials embedded in printer URLs are rejected");
    await save(configs);
    coordinator = await startCoordinator({ dataDir: "memory", skipAdapters: true, hostname: "127.0.0.1", listenPort: 4401 });
    const me = await (await fetch(`${base}/api/v1/me`)).json();
    gateway = new LanGateway({ coordinator: base, ownerToken: me.owner_token, allow: ["printer:octo", "printer:moon"], stateDir: directory, scanOptions: { discovery: false, includeHomeAssistant: false, extraHosts: "" } });
    await gateway.refresh(); gateway.start();
    for (let n = 0; n < 100 && !gateway.connector.getSnapshot().devices.every(d => d.device_id); n++) await pause(100);
    check(gateway.connector.getSnapshot().devices.length === 2 && gateway.connector.getSnapshot().devices.every(d => d.device_id), "configured printers travel through discovery and the outbound gateway");
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${me.owner_token}` } } }));
    function text(r: CallToolResult) { const t = r.content.find(c => c.type === "text"); assert(t?.type === "text"); return JSON.parse(t.text.slice(t.text.search(/[\[{]/))); }
    let seq = 0;
    const invoke = async (id: string, cap: string, args: Record<string, unknown> = {}, key = `printer-test-${++seq}`) => text(await client.callTool({ name: "invoke_capability", arguments: { ref: `${id}/${cap}`, arguments: args, idempotency_key: key, timeout_ms: 12000 } }) as CallToolResult);
    for (const [local, sim] of [["octo", octo], ["moon", moon]] as const) {
      const id = gateway.connector.deviceIdFor(`printer:${local}`)!;
      const read = await invoke(id, "printer.status");
      check(read.state === "succeeded" && read.observation.data.progress_percent === 42, `${local}: real MCP invocation returns normalized print progress`);
      check(Object.values(read.observation.data.temperatures_c as Record<string, { actual: number }>).some(t => t.actual === 201.5), `${local}: measured nozzle temperature survives normalization`);
      check(read.observation.captured_at === null, `${local}: provider clock is never invented as a UTC capture timestamp`);
      check(!JSON.stringify(read).includes("SIM-printer-key"), `${local}: API key is absent from agent observations`);
      const wrong = await invoke(id, "printer.job.control", { action: "cancel", expected_file: "wrong.gcode" });
      check(wrong.state === "rejected" && sim.state.commands.length === 0, `${local}: changed-file precondition prevents acting on another job`);
      const paused = await invoke(id, "printer.job.control", { action: "pause", expected_file: "SIM-cube.gcode" }, `${local}-pause`);
      check(paused.state === "succeeded" && sim.state.phase === "paused", `${local}: pause uses the documented command and checks resulting state`);
      await invoke(id, "printer.job.control", { action: "pause", expected_file: "SIM-cube.gcode" }, `${local}-pause`);
      check(sim.state.commands.length === 1, `${local}: repeated MCP request does not send another printer command`);
      if (local === "octo") check(JSON.stringify(sim.state.commands[0].body) === '{"command":"pause","action":"pause"}', "OctoPrint uses explicit pause rather than unsafe toggle semantics");
      const resumed = await invoke(id, "printer.job.control", { action: "resume", expected_file: "SIM-cube.gcode" });
      check(resumed.state === "succeeded" && sim.state.phase === "printing", `${local}: resume confirms controller state`);
      const cancelled = await invoke(id, "printer.job.control", { action: "cancel", expected_file: "SIM-cube.gcode" });
      check(cancelled.state === "succeeded" && sim.state.phase === "cancelled", `${local}: cancel confirms terminal controller state`);
      sim.state.phase = "printing"; sim.state.stalled = true;
      const stalled = await invoke(id, "printer.job.control", { action: "pause", expected_file: "SIM-cube.gcode" });
      check(stalled.state === "unknown", `${local}: accepted command without readback is unknown, never success`);
      sim.state.stalled = false; sim.state.malformed = true;
      const malformed = await invoke(id, "printer.status");
      check(malformed.state === "failed" && !JSON.stringify(malformed).includes("SIM-printer-key"), `${local}: provider failures expose neither fabricated readings nor error-body credentials`);
      sim.state.malformed = false; sim.state.redirect = true;
      check((await invoke(id, "printer.status")).state === "failed", `${local}: redirects cannot forward the local API key elsewhere`);
      sim.state.redirect = false;
    }
    await save(configs.map(c => ({ ...c, allow_job_control: false })));
    const before = octo.state.commands.length;
    const revoked = await invoke(gateway.connector.deviceIdFor("printer:octo")!, "printer.job.control", { action: "pause", expected_file: "SIM-cube.gcode" });
    check(revoked.state === "rejected" && octo.state.commands.length === before, "removing owner control permission takes effect before the next discovery refresh");
    check(octo.state.authenticated && moon.state.authenticated, "both providers received API keys only in the authentication header");
    console.log(`\n${checks} checks passed with SIMULATED printers through real MCP and WebSocket. No physical printing occurred.`);
  } finally { await client.close(); gateway?.stop(); await pause(100); await coordinator?.stop(); await octo.stop(); await moon.stop(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
