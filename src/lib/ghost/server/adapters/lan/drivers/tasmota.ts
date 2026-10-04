import type { AdapterDiscovery } from "../../types";
import { candidate, capPowerRead, capSwitchRead, capSwitchSet, fail, lanManifest, ok, parseOn, reject, stateObs, verified } from "../caps";
import { errMsg, hostUrl, httpJson, httpRaw, normMac } from "../net";
import type { HostHint, LanDriver, LanMeta } from "../types";

/** Tasmota — documented HTTP command API: https://tasmota.github.io/docs/Commands/#with-web-requests */

type TasmotaStatus0 = {
  Status?: { DeviceName?: string; FriendlyName?: string[]; Module?: number; Topic?: string; Power?: number };
  StatusNET?: { Hostname?: string; Mac?: string };
  StatusFWR?: { Version?: string; Hardware?: string };
  StatusSTS?: Record<string, unknown>;
  StatusSNS?: { ENERGY?: { Power?: number | number[] } };
};

export async function fingerprintTasmota(host: HostHint): Promise<AdapterDiscovery[] | null> {
  let res: Response;
  try {
    res = await httpRaw(hostUrl(host.ip, host.port, "/cm?cmnd=Status%200"));
  } catch {
    return null;
  }
  const text = await res.text().catch(() => "");
  if (res.status === 401 || /Need user=/i.test(text)) {
    return [
      candidate({
        local_key: `tasmota:${host.key}`,
        name: "Tasmota device",
        device_class: "plug",
        vendor: "Tasmota",
        icon: "power",
        meta: {
          driver: "tasmota",
          support: "needs_pairing",
          ip: host.ip,
          port: host.port,
          discovered_via: [...host.via],
          reason: "This Tasmota device has a web password set; GHOST v0.1 does not store Tasmota credentials.",
          instructions: "Clear the web admin password (WebPassword) on a trusted network, then scan again.",
        },
      }),
    ];
  }
  if (!res.ok) return null;
  let st: TasmotaStatus0;
  try {
    st = JSON.parse(text) as TasmotaStatus0;
  } catch {
    return null;
  }
  if (!st?.Status || !st.StatusFWR) return null;
  const mac = normMac(st.StatusNET?.Mac);
  const relays = Object.keys(st.StatusSTS ?? {})
    .filter((k) => /^POWER\d*$/.test(k))
    .sort();
  const metering = st.StatusSNS?.ENERGY?.Power !== undefined;
  const names = st.Status.FriendlyName ?? [];
  const baseName = st.Status.DeviceName || names[0] || st.StatusNET?.Hostname || "Tasmota device";
  const keyBase = `tasmota:${mac ?? host.key}`;
  if (!relays.length) {
    return [
      candidate({
        local_key: keyBase,
        name: baseName,
        device_class: "sensor",
        vendor: "Tasmota",
        model: st.StatusFWR.Hardware,
        icon: "cpu",
        meta: { driver: "tasmota", support: "unsupported", ip: host.ip, port: host.port, mac, discovered_via: [...host.via], reason: "No relay outputs reported; the v0.1 Tasmota driver only controls relays." },
      }),
    ];
  }
  return relays.map((key, i) => {
    const multi = relays.length > 1;
    const idx = key === "POWER" ? 0 : Number(key.slice(5));
    const meta: LanMeta = {
      driver: "tasmota",
      support: "supported",
      ip: host.ip,
      port: host.port,
      mac,
      relay: idx, // 0 = single "POWER"
      power_metering: metering && !multi,
      firmware: st.StatusFWR?.Version,
      discovered_via: [...host.via],
    };
    const caps = [capSwitchSet(multi ? `relay ${idx}` : "the relay"), capSwitchRead()];
    if (meta.power_metering) caps.push(capPowerRead());
    return verified(
      lanManifest({
        local_key: multi ? `${keyBase}:${idx}` : keyBase,
        name: multi ? names[i] || `${baseName} · relay ${idx}` : baseName,
        device_class: "plug",
        vendor: "Tasmota",
        model: st.StatusFWR?.Hardware,
        icon: "power",
        capabilities: caps,
        meta,
      }),
    );
  });
}

function powerKey(meta: LanMeta): string {
  const r = Number(meta.relay ?? 0);
  return r > 0 ? `Power${r}` : "Power";
}

async function readPower(meta: LanMeta, signal?: AbortSignal): Promise<boolean> {
  const r = await httpJson<Record<string, string>>(hostUrl(String(meta.ip), meta.port as number | undefined, `/cm?cmnd=${powerKey(meta)}`), { signal });
  const v = Object.entries(r).find(([k]) => /^POWER\d*$/i.test(k))?.[1];
  if (v !== "ON" && v !== "OFF") throw new Error("Tasmota returned no POWER state");
  return v === "ON";
}

export const tasmotaDriver: LanDriver = {
  id: "tasmota",
  async invoke(device, meta, capability_id, args, ctx) {
    if (meta.support !== "supported") return reject(String(meta.reason ?? "device not controllable"));
    const ip = String(meta.ip);
    const port = meta.port as number | undefined;
    try {
      switch (capability_id) {
        case "switch.set": {
          const p = parseOn(args);
          if (!p.ok) return reject(p.error);
          await httpJson(hostUrl(ip, port, `/cm?cmnd=${powerKey(meta)}%20${p.value ? "On" : "Off"}`), { signal: ctx.signal, timeoutMs: 2500 });
          const on = await readPower(meta, ctx.signal);
          const obs = stateObs({ on }, { value: on, name: device.name, note: "Relay state read back from Tasmota." });
          if (on !== p.value) return { state: "failed", error: `Tasmota reports ${on ? "ON" : "OFF"} after the command`, observation: obs };
          return ok(obs);
        }
        case "switch.read": {
          const on = await readPower(meta, ctx.signal);
          return ok(stateObs({ on }, { value: on, name: device.name }));
        }
        case "power.read": {
          if (!meta.power_metering) return reject("this Tasmota device has no energy meter");
          const r = await httpJson<TasmotaStatus0>(hostUrl(ip, port, "/cm?cmnd=Status%208"), { signal: ctx.signal });
          const p = r.StatusSNS?.ENERGY?.Power;
          const w = Array.isArray(p) ? p[0] : p;
          if (typeof w !== "number") return fail("Tasmota did not report power");
          return ok({ kind: "value", value: w, unit: "W", data: { power_w: w }, captured_at: new Date().toISOString(), source: { name: device.name } });
        }
        default:
          return reject(`unknown capability ${capability_id}`);
      }
    } catch (e) {
      return fail(`Tasmota at ${ip} did not respond: ${errMsg(e)}`);
    }
  },
  async probe(meta) {
    try {
      await readPower(meta);
      return { online: true };
    } catch (e) {
      return { online: false, detail: errMsg(e) };
    }
  },
};
