/** Digital-service adapters check: pnpm exec tsx scripts/services-check.ts (real network calls). */
import path from "node:path";
import { config as loadEnv } from "dotenv";
loadEnv({ path: path.join(process.cwd(), ".env.local"), quiet: true } as never);
import type { Device } from "../src/lib/ghost/contracts";
import { serviceAdapters } from "../src/lib/ghost/server/adapters/services";

const CASES: Record<string, [string, Record<string, unknown>][]> = {
  "svc-weather": [["weather.forecast", { location: "San Francisco", days: 3 }], ["air_quality.read", { location: "Paris, France" }]],
  "svc-news": [["news.headlines", {}], ["news.headlines", { query: "NASA" }]],
  "svc-wikipedia": [["wikipedia.summary", { topic: "golden gate bridge" }]],
  "svc-youtube": [["video.search", { query: "lofi hip hop" }]],
  "svc-calendar": [["calendar.agenda", { days: 7 }]],
  "svc-transit": [["transit.departures", { station: "Embarcadero" }], ["transit.departures", { station: "MONT" }]],
  "svc-aircraft": [["aircraft.nearby", { lat: 37.62, lon: -122.38, radius_km: 30 }]],
  "svc-earthquakes": [["earthquakes.recent", { min_magnitude: 4 }]],
  "svc-crypto": [["crypto.price", { coin: "BTC" }], ["crypto.price", { coin: "pepe" }]],
  "svc-geocode": [["place.geocode", { query: "Rome, Italy" }]],
};

async function main() {
let fail = 0;
for (const a of serviceAdapters) {
  const [disc] = (await a.discover!({ log: (m) => console.log("  log:", m) })) ?? [];
  const device = { ...disc.manifest, device_id: a.id, owner_id: a.owner_id, connector_id: `internal:${a.id}`, status: disc.status ?? "verified", online: true, last_heartbeat: null, created_at: "", updated_at: "" } as Device;
  for (const [cap, args] of CASES[a.id] ?? []) {
    const t = Date.now();
    const ac = new AbortController();
    const r = await a.invoke(device, cap, args, { invocation_id: "t", visitor_id: "t", lease_id: null, deadline: new Date(Date.now() + 10000), signal: ac.signal });
    const o = r.observation;
    const uiType = (o?.data?.ui as { type?: string } | undefined)?.type;
    const skip = disc.status === "unavailable";
    const pass = r.state === "succeeded" && !!uiType;
    if (!pass && !skip) fail++;
    console.log(`${pass ? "PASS" : skip ? "SKIP" : "FAIL"} ${a.id} ${cap} ${JSON.stringify(args)} ${Date.now() - t}ms ui=${uiType ?? "-"} captured_at=${o?.captured_at ?? null}`);
    console.log("     ", r.error ?? String(o?.note ?? o?.value ?? "").slice(0, 160).replace(/\n/g, " | "));
  }
}
// rejection paths
const w = serviceAdapters.find((a) => a.id === "svc-weather")!;
const r = await w.invoke({ capabilities: [] } as unknown as Device, "weather.forecast", { location: "x", days: 99 }, { invocation_id: "t", visitor_id: "t", lease_id: null, deadline: new Date(), signal: new AbortController().signal });
console.log(r.state === "rejected" ? "PASS" : "FAIL", "bad args rejected:", r.error);
if (r.state !== "rejected") fail++;
console.log(fail ? `${fail} FAILED` : "ALL PASSED");
process.exit(fail ? 1 : 0);
}
void main();
