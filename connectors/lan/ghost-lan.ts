#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { LanGateway } from "./gateway";
import { scan } from "../../src/lib/ghost/server/adapters/lan/scan";

async function main() {
  const { values: v } = parseArgs({ options: {
    discover: { type: "boolean" }, coordinator: { type: "string" }, pair: { type: "string" },
    allow: { type: "string", multiple: true }, "allow-all": { type: "boolean" },
    "state-dir": { type: "string", default: ".ghost/lan-gateway" }, "no-discovery": { type: "boolean" },
    "extra-hosts": { type: "string" }, label: { type: "string" }, help: { type: "boolean" },
  }});
  if (v.help) {
    console.log("Discover: pnpm hardware:gateway --discover\nConnect: pnpm hardware:gateway --coordinator https://ghost.example --pair CODE --allow LOCAL_KEY\nHA_URL and HA_TOKEN configure Home Assistant locally. --no-discovery uses only configured hosts/HA.\nThe owner must confirm pairing in GHOST. Credentials stay in --state-dir (default .ghost/lan-gateway).");
    return;
  }
  process.env.GHOST_LAN_NO_PUBLISH = "1";
  process.env.GHOST_LAN_STORE ??= path.resolve(v["state-dir"], "lan.json");
  const scanOptions = { discovery: !v["no-discovery"], extraHosts: v["extra-hosts"] };
  if (v.discover) {
    const result = await scan(scanOptions);
    console.log(JSON.stringify({ devices: result.discoveries.map(d => ({ local_key: d.manifest.local_key, name: d.manifest.name, support: d.manifest.meta?.support, online: d.online, capabilities: d.manifest.capabilities.map(c => c.capability_id) })), errors: result.errors }, null, 2));
    return;
  }
  if (!v.coordinator) throw new Error("--coordinator is required (or use --discover)");
  const gateway = new LanGateway({ coordinator: v.coordinator, pairingCode: v.pair, ownerToken: process.env.GHOST_OWNER_TOKEN, allow: v.allow ?? [], allowAll: v["allow-all"], stateDir: path.resolve(v["state-dir"]), label: v.label, scanOptions });
  console.log(await gateway.refresh());
  let previous = "";
  gateway.connector.subscribe(() => {
    const s = gateway.connector.getSnapshot();
    if (s.status !== previous) { previous = s.status; console.log(`GHOST: ${s.status}${s.status === "pending_confirmation" ? " — confirm this connector in the owner's GHOST app" : ""}`); }
  });
  gateway.start();
  const timer = setInterval(() => void gateway.refresh().catch(e => console.error("Refresh failed:", e.message)), 30_000);
  const stop = () => { clearInterval(timer); gateway.stop(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
