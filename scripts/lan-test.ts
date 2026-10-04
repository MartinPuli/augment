/**
 * Exercise the GHOST LAN adapter end-to-end WITHOUT the coordinator database.
 *
 *   Simulators (default):  pnpm exec tsx scripts/lan-fake-devices.ts   (in another terminal)
 *                          pnpm exec tsx scripts/lan-test.ts
 *   Real network, discovery only:      pnpm exec tsx scripts/lan-test.ts --real
 *   ... plus read capabilities (only on YOUR network, nothing is switched):
 *                          pnpm exec tsx scripts/lan-test.ts --real --read
 *
 * Writes its Hue pairing store to a temp file (never .ghost/lan.json) and never publishes.
 */
import os from "node:os";
import path from "node:path";

const REAL = process.argv.includes("--real");
process.env.GHOST_LAN_NO_PUBLISH = "1";
process.env.GHOST_LAN_STORE = path.join(os.tmpdir(), `ghost-lan-test-${process.pid}.json`);
if (!REAL) {
  process.env.GHOST_LAN_EXTRA_HOSTS ??= "127.0.0.1:8081,127.0.0.1:8082,127.0.0.1:8083,roku@127.0.0.1:8084,kasa@127.0.0.1:9999";
  process.env.HA_URL ??= "http://127.0.0.1:8124";
  process.env.HA_TOKEN ??= "sim-token";
} else {
  delete process.env.GHOST_LAN_EXTRA_HOSTS;
}

type Dev = import("../src/lib/ghost/contracts").Device;
type Disc = import("../src/lib/ghost/server/adapters/types").AdapterDiscovery;

const C = { dim: "\x1b[2m", g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", b: "\x1b[1m", x: "\x1b[0m" };

function asDevice(d: Disc): Dev {
  const now = new Date().toISOString();
  return {
    ...d.manifest,
    device_id: `test_${d.manifest.local_key}`,
    owner_id: "principal:test",
    connector_id: "internal:lan",
    status: d.status ?? "verified",
    online: d.online ?? true,
    last_heartbeat: now,
    created_at: now,
    updated_at: now,
  };
}

/** Sample calls per capability (simulator mode). Each entry: args, expected state. */
const PLAN: Record<string, { args: Record<string, unknown>; expect?: string }[]> = {
  "switch.set": [{ args: { on: true } }, { args: { on: false } }],
  "switch.read": [{ args: {} }],
  "power.read": [{ args: {} }],
  "light.set": [{ args: { color: "#8a2be2", brightness: 60 } }, { args: { color: "purple" }, expect: "rejected" }, { args: { brightness: 35 } }],
  "light.effect": [{ args: { effect: "rainbow" } }, { args: { effect: "definitely-not-an-effect" }, expect: "rejected" }],
  "light.read": [{ args: {} }],
  "media.keypress": [{ args: { key: "Home" } }],
  "media.launch": [{ args: { app_id: "12" } }],
  "media.read": [{ args: {} }],
  "fan.set": [{ args: { on: true, percentage: 50 } }],
  "fan.read": [{ args: {} }],
  "cover.set": [{ args: { action: "open" } }],
  "cover.read": [{ args: {} }],
  "media.control": [{ args: { action: "volume_set", volume: 40 } }, { args: { action: "play_pause" } }],
  "climate.set_temperature": [{ args: { temperature: 22 } }, { args: { temperature: 99 }, expect: "rejected" }],
  "climate.read": [{ args: {} }],
  "sensor.read": [{ args: {} }],
  "lock.read": [{ args: {} }],
  "camera.snapshot": [{ args: {} }],
  "lan.info": [{ args: {} }],
};

function short(o: unknown): string {
  const s = JSON.stringify(o, (k, v) => (v instanceof Uint8Array ? `<${v.length} bytes>` : v));
  return s && s.length > 220 ? s.slice(0, 217) + "..." : s;
}

async function main() {
  const { scan, lanAdapter } = await import("../src/lib/ghost/server/adapters/lan");
  console.log(`${C.b}GHOST LAN test — ${REAL ? "REAL network (read-only)" : "SIMULATORS on localhost (not real hardware)"}${C.x}`);
  console.log(`${C.dim}extra hosts: ${process.env.GHOST_LAN_EXTRA_HOSTS ?? "(none)"}  HA: ${process.env.HA_URL ?? "(not configured)"}${C.x}\n`);

  const runScan = async () => {
    const r = await scan({ timeoutMs: Number(process.env.SCAN_MS ?? 4000), log: (m) => console.log(`${C.dim}${m}${C.x}`) });
    console.log(`${C.b}scan${C.x}: ${r.found} found, ${r.verified} controllable, ${r.candidates} candidates in ${r.duration_ms} ms  sources=${short(r.sources)}`);
    console.log(`interfaces: ${r.interfaces.map((i) => `${i.name} ${i.cidr ?? i.address}`).join(", ") || "(none)"}`);
    if (r.note) console.log(`${C.y}note: ${r.note}${C.x}`);
    if (r.errors.length) console.log(`${C.dim}errors: ${r.errors.join(" | ")}${C.x}`);
    for (const d of r.discoveries) {
      const m = d.manifest.meta as Record<string, unknown>;
      const color = d.status === "candidate" ? C.y : C.g;
      console.log(
        `  ${color}${(d.status ?? "verified").padEnd(9)}${C.x} ${String(m.driver).padEnd(13)} ${d.manifest.name.padEnd(32)} ${String(m.ip ?? m.entity_id ?? "").padEnd(22)} ${d.manifest.capabilities.map((c) => c.capability_id).join(", ")}${m.reason ? `  ${C.dim}(${m.reason})${C.x}` : ""}`,
      );
    }
    return r;
  };

  let result = await runScan();
  const ctx = () => ({ invocation_id: `inv_test_${Date.now()}`, visitor_id: "principal:test", lease_id: null, deadline: new Date(Date.now() + 15000), signal: AbortSignal.timeout(15000) });
  let pass = 0,
    failN = 0;
  const call = async (dev: Dev, cap: string, args: Record<string, unknown>, expect?: string) => {
    const t = Date.now();
    const res = await lanAdapter.invoke(dev, cap, args, ctx());
    const good = expect ? res.state === expect : res.state === "succeeded";
    if (good) pass++;
    else failN++;
    const col = good ? C.g : C.r;
    console.log(
      `  ${col}${good ? "PASS" : "FAIL"}${C.x} ${dev.name.slice(0, 28).padEnd(28)} ${cap.padEnd(24)} ${short(args).padEnd(38)} -> ${res.state}${res.error ? ` (${res.error})` : ""} ${C.dim}${Date.now() - t}ms ${short(res.observation?.data ?? res.observation?.value ?? null)}${res.observation?.note ? ` — ${res.observation.note}` : ""}${C.x}`,
    );
    return res;
  };

  if (REAL) {
    // Reads only with --read, and only on your own network: never poke devices on a shared/venue network.
    if (!process.argv.includes("--read")) return;
    console.log(`\n${C.b}read-only checks on real devices${C.x}`);
    for (const d of result.discoveries.map(asDevice)) {
      for (const c of d.capabilities.filter((c) => c.kind !== "act" && c.capability_id !== "camera.snapshot")) await call(d, c.capability_id, {});
    }
    console.log(`\n${pass} ok, ${failN} failed`);
    return;
  }

  await fetch("http://127.0.0.1:8083/sim/reset").catch(() => {});
  // Hue pairing flow (simulated link button).
  const bridge = result.discoveries.map(asDevice).find((d) => d.meta?.driver === "hue-bridge");
  if (bridge) {
    console.log(`\n${C.b}Hue pairing${C.x}`);
    await call(bridge, "hue.pair", {}, "failed"); // link button not pressed yet
    await fetch("http://127.0.0.1:8083/sim/linkbutton");
    console.log(`  ${C.dim}(pressed the SIMULATED link button)${C.x}`);
    await call(bridge, "hue.pair", {}); // succeeds; publishing is disabled in this script
    console.log("");
    result = await runScan(); // lights now appear
  }

  console.log(`\n${C.b}invoking every capability${C.x}`);
  for (const d of result.discoveries.map(asDevice)) {
    for (const c of d.capabilities) {
      if (c.capability_id === "hue.pair") continue;
      const plans = PLAN[c.capability_id] ?? [{ args: {} }];
      for (const p of plans) {
        // Lights without color support must reject color.
        let expect = p.expect;
        if (c.capability_id === "light.set" && p.args.color === "#8a2be2" && !c.input_schema.properties?.color) expect = "rejected";
        await call(d, c.capability_id, p.args, expect);
      }
    }
  }
  // An unknown capability must be rejected, not crash.
  const any = result.discoveries.map(asDevice).find((d) => d.meta?.driver === "shelly");
  if (any) await call(any, "teleport.now", {}, "rejected");
  console.log(`\n${failN ? C.r : C.g}${pass} passed, ${failN} failed${C.x}`);
  process.exitCode = failN ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
