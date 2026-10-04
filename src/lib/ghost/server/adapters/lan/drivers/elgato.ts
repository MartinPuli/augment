import type { AdapterDiscovery } from "../../types";
import { capLightRead, capLightSet, fail, hsvToRgb, lanManifest, ok, parseLightArgs, reject, rgbToHsv, stateObs, toHex, verified } from "../caps";
import { errMsg, hostUrl, httpJson, normMac, tryJson } from "../net";
import type { HostHint, LanDriver } from "../types";

/**
 * Elgato Key Light / Key Light Air / Ring Light / Light Strip — local REST API on port 9123
 * (/elgato/accessory-info, /elgato/lights), advertised over mDNS as _elg._tcp.
 */

export const ELGATO_PORT = 9123;
const TEMP_RANGE: [number, number] = [2900, 7000];

type ElgatoInfo = { productName?: string; serialNumber?: string; displayName?: string; firmwareVersion?: string; macAddress?: string; features?: string[] };
type ElgatoLight = { on?: number; brightness?: number; temperature?: number; hue?: number; saturation?: number };
type ElgatoLights = { numberOfLights?: number; lights?: ElgatoLight[] };

const kToElgato = (k: number) => Math.max(143, Math.min(344, Math.round(1_000_000 / k)));
const elgatoToK = (v: number) => Math.round(1_000_000 / v / 50) * 50;

export async function fingerprintElgato(host: HostHint): Promise<AdapterDiscovery[] | null> {
  const port = host.port && host.port !== 80 ? host.port : ELGATO_PORT;
  const info = await tryJson<ElgatoInfo>(hostUrl(host.ip, port, "/elgato/accessory-info"));
  if (!info || typeof info !== "object" || !(info.productName || info.serialNumber)) return null;
  const lights = await tryJson<ElgatoLights>(hostUrl(host.ip, port, "/elgato/lights"));
  const first = lights?.lights?.[0];
  const color = typeof first?.hue === "number";
  return [
    verified(
      lanManifest({
        local_key: `elgato:${info.serialNumber ?? host.key}`,
        name: info.displayName || info.productName || "Elgato light",
        device_class: "light",
        vendor: "Elgato",
        model: info.productName,
        icon: "lamp-desk",
        capabilities: [color ? capLightSet({ color: true }) : capLightSet({ temperature: TEMP_RANGE }), capLightRead()],
        meta: {
          driver: "elgato",
          support: "supported",
          ip: host.ip,
          port,
          mac: normMac(info.macAddress),
          serial: info.serialNumber,
          color,
          firmware: info.firmwareVersion,
          discovered_via: [...host.via],
        },
      }),
    ),
  ];
}

function describe(l: ElgatoLight | undefined) {
  if (!l) return { on: false };
  return {
    on: !!l.on,
    brightness: l.brightness,
    temperature_k: typeof l.temperature === "number" ? elgatoToK(l.temperature) : undefined,
    color: typeof l.hue === "number" ? toHex(hsvToRgb(l.hue, l.saturation ?? 0, 100)) : undefined,
  };
}

export const elgatoDriver: LanDriver = {
  id: "elgato",
  async invoke(device, meta, capability_id, args, ctx) {
    const ip = String(meta.ip);
    const url = hostUrl(ip, Number(meta.port ?? ELGATO_PORT), "/elgato/lights");
    try {
      switch (capability_id) {
        case "light.set": {
          const p = parseLightArgs(args, meta.color ? { color: true } : { temperature: TEMP_RANGE });
          if (!p.ok) return reject(p.error);
          const a = p.value;
          const light: ElgatoLight = {};
          if (a.on !== undefined) light.on = a.on ? 1 : 0;
          if (a.brightness !== undefined) {
            if (a.brightness === 0) light.on = 0;
            else {
              light.brightness = Math.max(3, Math.round(a.brightness));
              if (a.on === undefined) light.on = 1;
            }
          }
          if (a.temperature_k !== undefined) {
            light.temperature = kToElgato(a.temperature_k);
            if (light.on === undefined) light.on = 1;
          }
          if (a.color) {
            const hsv = rgbToHsv(a.color);
            light.hue = hsv.h;
            light.saturation = hsv.s;
            if (light.on === undefined) light.on = 1;
          }
          await httpJson(url, { method: "PUT", body: { numberOfLights: 1, lights: [light] }, signal: ctx.signal, timeoutMs: 2500 });
          const after = await httpJson<ElgatoLights>(url, { signal: ctx.signal });
          const d = describe(after.lights?.[0]);
          const obs = stateObs(d, { value: d.on, name: device.name, note: "State read back from the Elgato light." });
          if (light.on !== undefined && d.on !== !!light.on) return { state: "failed", error: `light reports on=${d.on}`, observation: obs };
          return ok(obs);
        }
        case "light.read": {
          const st = await httpJson<ElgatoLights>(url, { signal: ctx.signal });
          const d = describe(st.lights?.[0]);
          return ok(stateObs(d, { value: d.on, name: device.name }));
        }
        default:
          return reject(`unknown capability ${capability_id}`);
      }
    } catch (e) {
      return fail(`Elgato light at ${ip} did not respond: ${errMsg(e)}`);
    }
  },
  async probe(meta) {
    const r = await tryJson(hostUrl(String(meta.ip), Number(meta.port ?? ELGATO_PORT), "/elgato/accessory-info"));
    return r ? { online: true } : { online: false, detail: "no answer on :9123/elgato/accessory-info" };
  },
};
