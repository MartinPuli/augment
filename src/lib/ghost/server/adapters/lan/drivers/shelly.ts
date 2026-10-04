import type { AdapterDiscovery } from "../../types";
import { candidate, capPowerRead, capSwitchRead, capSwitchSet, fail, lanManifest, ok, parseOn, reject, stateObs, verified } from "../caps";
import { errMsg, hostUrl, httpJson, normMac, tryJson } from "../net";
import type { HostHint, LanDriver, LanMeta } from "../types";

/**
 * Shelly — documented local HTTP API.
 * Gen1: https://shelly-api-docs.shelly.cloud/gen1/  (/shelly, /status, /relay/<n>?turn=on|off)
 * Gen2+: https://shelly-api-docs.shelly.cloud/gen2/ (/rpc/Shelly.GetDeviceInfo, /rpc/Switch.Set, /rpc/Switch.GetStatus)
 */

type ShellyIdent = {
  // gen1
  type?: string;
  auth?: boolean;
  fw?: string;
  // gen2+
  gen?: number;
  id?: string;
  name?: string | null;
  model?: string;
  app?: string;
  auth_en?: boolean;
  ver?: string;
  mac?: string;
};

export async function fingerprintShelly(host: HostHint): Promise<AdapterDiscovery[] | null> {
  const base = (p: string) => hostUrl(host.ip, host.port, p);
  const ident = await tryJson<ShellyIdent>(base("/shelly"));
  if (!ident || typeof ident !== "object" || (!ident.type && !ident.gen && !ident.model)) return null;
  const gen = ident.gen && ident.gen >= 2 ? ident.gen : 1;
  const mac = normMac(ident.mac);
  const keyBase = `shelly:${(mac ?? host.key).replace(/[^0-9a-z.:]/gi, "")}`;
  const model = ident.model ?? ident.type ?? "Shelly";
  const vendor = "Shelly (Allterco)";
  const via = [...host.via];
  const authOn = gen === 1 ? !!ident.auth : !!ident.auth_en;
  const baseName = (ident.name && String(ident.name)) || (ident.app ? `Shelly ${ident.app}` : `Shelly ${model}`);

  if (authOn) {
    return [
      candidate({
        local_key: keyBase,
        name: baseName,
        device_class: "plug",
        vendor,
        model,
        icon: "power",
        meta: {
          driver: "shelly",
          support: "needs_pairing",
          ip: host.ip,
          port: host.port,
          mac,
          gen,
          discovered_via: via,
          reason: "This Shelly has password protection enabled; GHOST v0.1 does not store Shelly credentials.",
          instructions: "Disable 'restrict login' in the Shelly web UI/app (only on a trusted network), then scan again.",
        },
      }),
    ];
  }

  // Count switch channels and detect metering.
  let channels: { ch: number; metering: boolean }[] = [];
  let displayName = baseName;
  try {
    if (gen >= 2) {
      const st = await httpJson<Record<string, { output?: boolean; apower?: number } | undefined>>(base("/rpc/Shelly.GetStatus"));
      for (const [k, v] of Object.entries(st)) {
        const m = k.match(/^switch:(\d+)$/);
        if (m && v) channels.push({ ch: Number(m[1]), metering: typeof v.apower === "number" });
      }
      const cfg = await tryJson<{ sys?: { device?: { name?: string | null } } }>(base("/rpc/Sys.GetConfig"));
      if (cfg?.sys?.device?.name) displayName = cfg.sys.device.name;
    } else {
      const st = await httpJson<{ relays?: { ison?: boolean }[]; meters?: { power?: number }[] }>(base("/status"));
      channels = (st.relays ?? []).map((_, i) => ({ ch: i, metering: typeof st.meters?.[i]?.power === "number" }));
      const settings = await tryJson<{ name?: string | null }>(base("/settings"));
      if (settings?.name) displayName = settings.name;
    }
  } catch (e) {
    return [
      candidate({
        local_key: keyBase,
        name: displayName,
        device_class: "plug",
        vendor,
        model,
        icon: "power",
        meta: { driver: "shelly", support: "unsupported", ip: host.ip, port: host.port, mac, gen, discovered_via: via, reason: `Shelly answered /shelly but its status failed: ${errMsg(e)}` },
      }),
    ];
  }
  channels.sort((a, b) => a.ch - b.ch);
  if (!channels.length) {
    return [
      candidate({
        local_key: keyBase,
        name: displayName,
        device_class: "sensor",
        vendor,
        model,
        icon: "cpu",
        meta: {
          driver: "shelly",
          support: "unsupported",
          ip: host.ip,
          port: host.port,
          mac,
          gen,
          discovered_via: via,
          reason: "This Shelly model has no relay channel; the v0.1 Shelly driver only controls switch outputs.",
        },
      }),
    ];
  }
  return channels.map(({ ch, metering }) => {
    const multi = channels.length > 1;
    const meta: LanMeta = {
      driver: "shelly",
      support: "supported",
      ip: host.ip,
      port: host.port,
      mac,
      gen,
      channel: ch,
      power_metering: metering,
      discovered_via: via,
      firmware: ident.ver ?? ident.fw,
    };
    const caps = [capSwitchSet(multi ? `relay channel ${ch}` : "the relay"), capSwitchRead()];
    if (metering) caps.push(capPowerRead());
    return verified(
      lanManifest({
        local_key: multi ? `${keyBase}:${ch}` : keyBase,
        name: multi ? `${displayName} · ch ${ch + 1}` : displayName,
        device_class: "plug",
        vendor,
        model,
        icon: "power",
        capabilities: caps,
        meta,
      }),
    );
  });
}

type SwitchState = { on: boolean; power_w?: number };

async function readSwitch(meta: LanMeta, signal?: AbortSignal): Promise<SwitchState> {
  const ch = Number(meta.channel ?? 0);
  const ip = String(meta.ip);
  const port = meta.port as number | undefined;
  if (Number(meta.gen ?? 1) >= 2) {
    const s = await httpJson<{ output?: boolean; apower?: number }>(hostUrl(ip, port, `/rpc/Switch.GetStatus?id=${ch}`), { signal });
    if (typeof s.output !== "boolean") throw new Error("Switch.GetStatus returned no output field");
    return { on: s.output, power_w: typeof s.apower === "number" ? s.apower : undefined };
  }
  const r = await httpJson<{ ison?: boolean }>(hostUrl(ip, port, `/relay/${ch}`), { signal });
  if (typeof r.ison !== "boolean") throw new Error("relay status returned no ison field");
  let power_w: number | undefined;
  if (meta.power_metering) {
    const st = await httpJson<{ meters?: { power?: number }[] }>(hostUrl(ip, port, "/status"), { signal }).catch(() => null);
    const p = st?.meters?.[ch]?.power;
    if (typeof p === "number") power_w = p;
  }
  return { on: r.ison, power_w };
}

export const shellyDriver: LanDriver = {
  id: "shelly",
  async invoke(device, meta, capability_id, args, ctx) {
    if (meta.support !== "supported") return reject(String(meta.reason ?? "device not controllable"));
    const ch = Number(meta.channel ?? 0);
    const ip = String(meta.ip);
    const port = meta.port as number | undefined;
    try {
      switch (capability_id) {
        case "switch.set": {
          const p = parseOn(args);
          if (!p.ok) return reject(p.error);
          if (Number(meta.gen ?? 1) >= 2) {
            await httpJson(hostUrl(ip, port, `/rpc/Switch.Set?id=${ch}&on=${p.value}`), { signal: ctx.signal, timeoutMs: 2500 });
          } else {
            await httpJson(hostUrl(ip, port, `/relay/${ch}?turn=${p.value ? "on" : "off"}`), { signal: ctx.signal, timeoutMs: 2500 });
          }
          const s = await readSwitch(meta, ctx.signal);
          const obs = stateObs({ ...s }, { value: s.on, name: device.name, note: "Relay state read back from the Shelly after the command." });
          if (s.on !== p.value) return { state: "failed", error: `Shelly reports the relay is ${s.on ? "on" : "off"} after asking for ${p.value ? "on" : "off"}`, observation: obs };
          return ok(obs);
        }
        case "switch.read": {
          const s = await readSwitch(meta, ctx.signal);
          return ok(stateObs({ ...s }, { value: s.on, name: device.name }));
        }
        case "power.read": {
          if (!meta.power_metering) return reject("this Shelly has no power meter");
          const s = await readSwitch(meta, ctx.signal);
          if (typeof s.power_w !== "number") return fail("the Shelly did not report power");
          return ok({ kind: "value", value: s.power_w, unit: "W", data: { ...s }, captured_at: new Date().toISOString(), source: { name: device.name } });
        }
        default:
          return reject(`unknown capability ${capability_id}`);
      }
    } catch (e) {
      return fail(`Shelly at ${ip} did not respond: ${errMsg(e)}`);
    }
  },
  async probe(meta) {
    const r = await tryJson(hostUrl(String(meta.ip), meta.port as number | undefined, "/shelly"));
    return r ? { online: true } : { online: false, detail: "no answer on /shelly" };
  },
};
