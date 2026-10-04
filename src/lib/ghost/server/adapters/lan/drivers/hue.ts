import type { CapabilitySpec, Device } from "../../../../contracts";
import type { AdapterDiscovery } from "../../types";
import {
  candidate,
  capLightRead,
  capLightSet,
  capSwitchRead,
  capSwitchSet,
  fail,
  lanManifest,
  ok,
  parseLightArgs,
  parseOn,
  reject,
  rgbToXy,
  stateObs,
  toHex,
  verified,
  xyToRgb,
} from "../caps";
import { errMsg, hostUrl, httpJson, normMac, tryJson } from "../net";
import { loadStore, updateStore } from "../store";
import type { HostHint, LanDriver, LanMeta } from "../types";

/**
 * Philips Hue bridge — documented local REST API (v1, http://<bridge>/api).
 * Pairing requires a physical press of the bridge's link button; GHOST never guesses credentials.
 * The username is stored only in .ghost/lan.json (never in manifests).
 */

const DEVICETYPE = "ghost#polty";

type HueConfig = { name?: string; bridgeid?: string; modelid?: string; swversion?: string; apiversion?: string; mac?: string; factorynew?: boolean };
type HueLightState = { on?: boolean; bri?: number; hue?: number; sat?: number; xy?: [number, number]; ct?: number; reachable?: boolean; colormode?: string };
type HueLight = { state?: HueLightState; type?: string; name?: string; modelid?: string; manufacturername?: string; productname?: string; uniqueid?: string };
type HueErr = { error?: { type?: number; description?: string } };

function capPair(paired: boolean): CapabilitySpec {
  return {
    capability_id: "hue.pair",
    kind: "act",
    semantic_type: "hub.pair",
    title: paired ? "Re-sync lights" : "Pair with the bridge",
    description: paired
      ? "Re-list the lights on this paired Hue bridge and publish any new ones."
      : "Ask the Hue bridge for an API key. The user must press the round link button on the bridge first (within 30 s), then call this again. On success every Hue light is published as its own device.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    verification: "acknowledgment",
    limits: { rate_per_min: 10 },
    estimated_ms: 1500,
  };
}

function bridgeManifest(ip: string, port: number | undefined, cfg: HueConfig, paired: boolean, via: string[], lightCount?: number): AdapterDiscovery {
  const bridgeId = String(cfg.bridgeid ?? "").toLowerCase();
  const meta: LanMeta = {
    driver: "hue-bridge",
    support: paired ? "supported" : "needs_pairing",
    ip,
    port,
    mac: normMac(cfg.mac),
    bridge_id: bridgeId,
    paired,
    light_count: lightCount,
    firmware: cfg.swversion,
    discovered_via: via,
    ...(paired
      ? {}
      : {
          reason: "The Hue bridge needs a one-time pairing (physical link-button press).",
          instructions: "Press the round link button on top of the Hue bridge, then ask Polty to pair the Hue bridge (hue.pair) within 30 seconds.",
        }),
  };
  const base = {
    local_key: `hue:${bridgeId}`,
    name: cfg.name || "Hue Bridge",
    device_class: "hub" as const,
    vendor: "Signify (Philips Hue)",
    model: cfg.modelid ? `Hue Bridge ${cfg.modelid}` : "Hue Bridge",
    icon: "router",
    meta,
  };
  if (!paired) return candidate({ ...base, capabilities: [capPair(false)] });
  return verified(lanManifest({ ...base, capabilities: [capPair(true)] }));
}

function lightManifests(ip: string, port: number | undefined, bridgeId: string, lights: Record<string, HueLight>, zone?: string): AdapterDiscovery[] {
  const out: AdapterDiscovery[] = [];
  for (const [lid, l] of Object.entries(lights)) {
    const type = String(l.type ?? "");
    const color = /color light/i.test(type) && !/temperature/i.test(type);
    const ct = /temperature|extended color/i.test(type);
    const plug = /on\/off plug|plug-in unit/i.test(type);
    const dimmable = !plug;
    const meta: LanMeta = {
      driver: "hue-light",
      support: "supported",
      ip,
      port,
      bridge_id: bridgeId,
      light_id: lid,
      color,
      ct,
      dimmable,
      unique_id: l.uniqueid,
      discovered_via: ["hue-bridge"],
    };
    const caps = plug ? [capSwitchSet("the Hue smart plug"), capSwitchRead()] : [capLightSet({ color, brightness: dimmable }), capLightRead()];
    const d = verified(
      lanManifest({
        local_key: `hue:${bridgeId}:light:${l.uniqueid ?? lid}`,
        name: l.name || `Hue light ${lid}`,
        device_class: plug ? "plug" : "light",
        vendor: l.manufacturername || "Signify (Philips Hue)",
        model: l.productname || l.modelid,
        icon: plug ? "plug" : "lightbulb",
        zone_id: zone,
        capabilities: caps,
        meta,
      }),
    );
    d.online = l.state?.reachable !== false;
    out.push(d);
  }
  return out;
}

export async function fingerprintHue(host: HostHint): Promise<AdapterDiscovery[] | null> {
  const cfg = await tryJson<HueConfig>(hostUrl(host.ip, host.port, "/api/config"));
  if (!cfg || typeof cfg !== "object" || !cfg.bridgeid) return null;
  const bridgeId = cfg.bridgeid.toLowerCase();
  const store = await loadStore();
  const cred = store.hue[bridgeId];
  const via = [...host.via];
  if (cred) {
    const lights = await tryJson<Record<string, HueLight> | HueErr[]>(hostUrl(host.ip, host.port, `/api/${cred.username}/lights`));
    if (lights && !Array.isArray(lights)) {
      if (cred.ip !== host.ip) await updateStore((s) => (s.hue[bridgeId] = { ...cred, ip: host.ip }));
      return [bridgeManifest(host.ip, host.port, cfg, true, via, Object.keys(lights).length), ...lightManifests(host.ip, host.port, bridgeId, lights)];
    }
    if (Array.isArray(lights) && lights[0]?.error?.type === 1) {
      // The user removed GHOST from the bridge's app list: forget the stale key.
      await updateStore((s) => delete s.hue[bridgeId]);
    }
  }
  return [bridgeManifest(host.ip, host.port, cfg, false, via)];
}

async function usernameFor(meta: LanMeta): Promise<string | null> {
  const s = await loadStore();
  return s.hue[String(meta.bridge_id)]?.username ?? null;
}

function describe(st: HueLightState | undefined) {
  if (!st) return { on: false };
  let color: string | undefined;
  if (st.colormode === "xy" && st.xy) color = toHex(xyToRgb(st.xy[0], st.xy[1]));
  else if (st.colormode === "hs" && typeof st.hue === "number") {
    // approximate via xy of the HSV color
    const h = (st.hue / 65535) * 360;
    const s = (st.sat ?? 0) / 254;
    const c = s,
      x = c * (1 - Math.abs(((h / 60) % 2) - 1)),
      m = 1 - c;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    color = toHex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
  }
  return {
    on: !!st.on,
    brightness: typeof st.bri === "number" ? Math.round((st.bri / 254) * 100) : undefined,
    color,
    color_temp_k: st.colormode === "ct" && st.ct ? Math.round(1_000_000 / st.ct) : undefined,
    reachable: st.reachable,
  };
}

async function publishLater(discoveries: AdapterDiscovery[], owner_id: string): Promise<Device[]> {
  // Scripts (scripts/lan-test.ts) set GHOST_LAN_NO_PUBLISH so they never touch the coordinator's database.
  if (process.env.GHOST_LAN_NO_PUBLISH) throw new Error("publishing disabled (GHOST_LAN_NO_PUBLISH)");
  // Dynamic import keeps the driver usable without loading the coordinator's database.
  const { publishFromAdapter } = await import("../../../registry");
  return publishFromAdapter("lan", discoveries, { owner_id });
}

async function pair(device: Device, meta: LanMeta, signal: AbortSignal) {
  const ip = String(meta.ip);
  const port = meta.port as number | undefined;
  const cfg = await httpJson<HueConfig>(hostUrl(ip, port, "/api/config"), { signal });
  const bridgeId = String(cfg.bridgeid ?? meta.bridge_id).toLowerCase();
  let username = await usernameFor({ ...meta, bridge_id: bridgeId });
  if (!username) {
    const r = await httpJson<({ success?: { username?: string } } & HueErr)[]>(hostUrl(ip, port, "/api"), {
      method: "POST",
      body: { devicetype: DEVICETYPE },
      signal,
      timeoutMs: 3000,
    });
    const first = r[0];
    if (first?.error?.type === 101)
      return fail("Link button not pressed. Press the round link button on top of the Hue bridge, then try hue.pair again within 30 seconds.");
    if (!first?.success?.username) return fail(`Hue bridge refused pairing: ${first?.error?.description ?? "unexpected reply"}`);
    username = first.success.username;
    await updateStore((s) => (s.hue[bridgeId] = { username: username!, ip, paired_at: new Date().toISOString() }));
  }
  const lights = await httpJson<Record<string, HueLight> | HueErr[]>(hostUrl(ip, port, `/api/${username}/lights`), { signal });
  if (Array.isArray(lights)) return fail(`Hue bridge rejected the stored key: ${lights[0]?.error?.description ?? "unknown error"}`);
  const discoveries = [bridgeManifest(ip, port, cfg, true, (meta.discovered_via as string[]) ?? [], Object.keys(lights).length), ...lightManifests(ip, port, bridgeId, lights, device.zone_id)];
  let published: Device[] = [];
  let publishNote = "";
  try {
    published = await publishLater(discoveries, device.owner_id);
  } catch (e) {
    publishNote = ` (could not publish to the catalog: ${errMsg(e)})`;
  }
  const names = Object.values(lights).map((l) => l.name ?? "light");
  return ok({
    kind: "state",
    value: true,
    data: { paired: true, bridge_id: bridgeId, lights: names, published: published.map((d) => ({ device_id: d.device_id, name: d.name })) },
    captured_at: new Date().toISOString(),
    note: `Paired with the Hue bridge; ${names.length} light(s) published as devices${publishNote}.`,
  });
}

export const hueBridgeDriver: LanDriver = {
  id: "hue-bridge",
  async invoke(device, meta, capability_id, _args, ctx) {
    try {
      if (capability_id === "hue.pair") return await pair(device, meta, ctx.signal);
      if (capability_id === "lan.info") return ok({ kind: "state", data: { ...meta }, captured_at: null, note: String(meta.reason ?? "") });
      return reject(`unknown capability ${capability_id}`);
    } catch (e) {
      return fail(`Hue bridge at ${meta.ip} did not respond: ${errMsg(e)}`);
    }
  },
  async probe(meta) {
    const r = await tryJson(hostUrl(String(meta.ip), meta.port as number | undefined, "/api/config"));
    return r ? { online: true } : { online: false, detail: "no answer on /api/config" };
  },
};

export const hueLightDriver: LanDriver = {
  id: "hue-light",
  async invoke(device, meta, capability_id, args, ctx) {
    const username = await usernameFor(meta);
    if (!username) return reject("The Hue bridge is not paired with GHOST any more; run hue.pair on the bridge.");
    const ip = String(meta.ip);
    const port = meta.port as number | undefined;
    const lightUrl = hostUrl(ip, port, `/api/${username}/lights/${encodeURIComponent(String(meta.light_id))}`);
    const readState = async () => (await httpJson<HueLight>(lightUrl, { signal: ctx.signal })).state;
    try {
      switch (capability_id) {
        case "light.set":
        case "switch.set": {
          const body: Record<string, unknown> = { transitiontime: 4 };
          if (capability_id === "switch.set") {
            const p = parseOn(args);
            if (!p.ok) return reject(p.error);
            body.on = p.value;
          } else {
            const p = parseLightArgs(args, { color: !!meta.color });
            if (!p.ok) return reject(p.error);
            const a = p.value;
            if (a.on !== undefined) body.on = a.on;
            if (a.brightness !== undefined) {
              if (a.brightness === 0) body.on = false;
              else {
                body.bri = Math.max(1, Math.min(254, Math.round((a.brightness / 100) * 254)));
                if (a.on === undefined) body.on = true;
              }
            }
            if (a.color) {
              body.xy = rgbToXy(a.color);
              if (body.on === undefined) body.on = true;
            }
          }
          const r = await httpJson<({ success?: unknown } & HueErr)[]>(`${lightUrl}/state`, { method: "PUT", body, signal: ctx.signal, timeoutMs: 2500 });
          const errs = r.filter((x) => x.error).map((x) => x.error?.description);
          if (errs.length && errs.length === r.length) return fail(`Hue bridge error: ${errs.join("; ")}`);
          // Give the bridge a moment to apply the transition before reading back.
          await new Promise((res) => setTimeout(res, 450));
          const st = await readState();
          const d = describe(st);
          const obs = stateObs(d, { value: d.on, name: device.name, note: "State read back from the Hue bridge." });
          if (st?.reachable === false) return { state: "failed", error: "The bridge reports this light as unreachable (powered off at the wall?)", observation: obs };
          if (body.on !== undefined && d.on !== body.on) return { state: "failed", error: `bridge reports on=${d.on}`, observation: obs };
          return ok(obs);
        }
        case "light.read":
        case "switch.read": {
          const d = describe(await readState());
          return ok(stateObs(d, { value: d.on, name: device.name }));
        }
        default:
          return reject(`unknown capability ${capability_id}`);
      }
    } catch (e) {
      return fail(`Hue bridge at ${ip} did not respond: ${errMsg(e)}`);
    }
  },
  async probe(meta) {
    const username = await usernameFor(meta);
    if (!username) return { online: false, detail: "bridge not paired" };
    const r = await tryJson<HueLight>(hostUrl(String(meta.ip), meta.port as number | undefined, `/api/${username}/lights/${meta.light_id}`));
    return r?.state ? { online: r.state.reachable !== false } : { online: false, detail: "bridge did not answer" };
  },
};
