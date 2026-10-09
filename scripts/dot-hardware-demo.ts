/** Keep an isolated simulated hardware network alive for a real agent to test. */
import { mkdir, mkdtemp, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { startCoordinator } from "../src/lib/ghost/server";
import { subscribe } from "../src/lib/ghost/server/events";
import { LanGateway } from "../connectors/lan/gateway";
import { printerSimulator } from "./fixtures/printer-simulator";

async function main() {
  const root = path.resolve(".ghost/dot-hardware-demo");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const run = await mkdtemp(path.join(root, "run-"));
  process.env.GHOST_DB = "pglite";
  delete process.env.DATABASE_URL;
  process.env.GHOST_LAN_STORE = path.join(run, "lan.json");
  process.env.GHOST_PRINTERS_CONFIG = path.join(run, "printers.json");
  process.env.SIM_PRINTER_KEY = "SIM-printer-key";
  const octo = await printerSimulator("octoprint");
  const moon = await printerSimulator("moonraker");
  await writeFile(process.env.GHOST_PRINTERS_CONFIG, JSON.stringify([
    { id: "dot-octo", name: "SIM Dot OctoPrint", type: "octoprint", url: octo.url, api_key_env: "SIM_PRINTER_KEY", allow_job_control: true },
    { id: "dot-moon", name: "SIM Dot Moonraker", type: "moonraker", url: moon.url, api_key_env: "SIM_PRINTER_KEY", allow_job_control: true },
  ]), { mode: 0o600 });
  const base = "http://127.0.0.1:4411";
  const coordinator = await startCoordinator({ dataDir: "memory", skipAdapters: true, hostname: "127.0.0.1", listenPort: 4411 });
  const me = await (await fetch(`${base}/api/v1/me`)).json();
  await writeFile(path.join(root, "connection.private.json"), JSON.stringify({ endpoint: `${base}/mcp`, token: me.owner_token }), { mode: 0o600 });
  let writes = Promise.resolve();
  const unsubscribe = subscribe(event => {
    if (event.type !== "invocation.updated") return;
    const evidence = { at: new Date().toISOString(), invocation: event.invocation, simulators: { octoprint: octo.state, moonraker: moon.state } };
    const line = JSON.stringify(evidence) + "\n";
    writes = writes.then(() => appendFile(path.join(run, "evidence.jsonl"), line, { mode: 0o600 })).catch(error => console.error("Evidence write failed", error));
  });
  const gateway = new LanGateway({ coordinator: base, ownerToken: me.owner_token, allow: ["printer:dot-octo", "printer:dot-moon"], stateDir: run, scanOptions: { discovery: false, includeHomeAssistant: false, extraHosts: "" } });
  await gateway.refresh(); gateway.start();
  for (let n = 0; n < 100 && !gateway.connector.getSnapshot().devices.every(d => d.device_id); n++) await new Promise(r => setTimeout(r, 100));
  if (gateway.connector.getSnapshot().devices.length !== 2 || !gateway.connector.getSnapshot().devices.every(d => d.device_id)) throw new Error("Demo printers did not connect");
  console.log(`READY: two SIMULATED printers, MCP ${base}/mcp, evidence ${path.join(run, "evidence.jsonl")}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    unsubscribe(); gateway.stop(); await writes;
    await coordinator.stop(); await octo.stop(); await moon.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}
main().catch(error => { console.error(error); process.exit(1); });
