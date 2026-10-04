import crypto from "node:crypto";
import dgram from "node:dgram";
import net from "node:net";
import type { AdapterDiscovery } from "../../types";
import {
  candidate,
  capLightRead,
  capLightSet,
  capPowerRead,
  capSwitchRead,
  capSwitchSet,
  fail,
  hsvToRgb,
  lanManifest,
  ok,
  parseLightArgs,
  parseOn,
  reject,
  rgbToHsv,
  stateObs,
  toHex,
  verified,
} from "../caps";
import { errMsg, normMac } from "../net";
import type { HostHint, LanDriver, LanMeta } from "../types";

/**
 * TP-Link Kasa (legacy local protocol): JSON "encrypted" with an XOR autokey (initial key 171),
 * UDP broadcast discovery on port 9999, TCP commands on port 9999 with a 4-byte big-endian length prefix.
 * Newer Kasa/Tapo firmware uses KLAP/AES and ignores this protocol; those devices answer the
 * TDP discovery on UDP 20002 and are published as candidates.
 */

export const KASA_PORT = 9999;

export function kasaEncrypt(json: string, lengthPrefix: boolean): Buffer {
  const src = Buffer.from(json, "utf8");
  const out = Buffer.alloc(src.length + (lengthPrefix ? 4 : 0));
  if (lengthPrefix) out.writeUInt32BE(src.length, 0);
  let key = 171;
  for (let i = 0; i < src.length; i++) {
    const c = key ^ src[i];
    key = c;
    out[i + (lengthPrefix ? 4 : 0)] = c;
  }
  return out;
}

export function kasaDecrypt(buf: Buffer): string {
  const out = Buffer.alloc(buf.length);
  let key = 171;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    out[i] = key ^ c;
    key = c;
  }
  return out.toString("utf8");
}

const GET_SYSINFO = JSON.stringify({ system: { get_sysinfo: {} } });

/** One request/response over TCP 9999. */
export function kasaTcp<T = Record<string, unknown>>(ip: string, port: number, payload: unknown, timeoutMs = 2500, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: ip, port });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (err: Error | null, val?: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      sock.destroy();
      if (err) reject(err);
      else resolve(val as T);
    };
    const onAbort = () => finish(new Error("aborted"));
    signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => finish(new Error("timed out")), timeoutMs);
    sock.on("connect", () => sock.write(kasaEncrypt(typeof payload === "string" ? payload : JSON.stringify(payload), true)));
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len > 1_000_000) return finish(new Error("reply too large"));
        if (buf.length >= 4 + len) {
          try {
            finish(null, JSON.parse(kasaDecrypt(buf.subarray(4, 4 + len))) as T);
          } catch {
            finish(new Error("could not decode Kasa reply"));
          }
        }
      }
    });
    sock.on("error", (e) => finish(e));
    sock.on("close", () => finish(new Error("connection closed before a full reply")));
  });
}

/* ------------------------------------------------------------------ */
/* UDP discovery (legacy 9999 + TDP 20002 for KLAP/AES firmware)       */
/* ------------------------------------------------------------------ */

export interface KasaUdpHit {
  ip: string;
  sysinfo?: Record<string, unknown>; // legacy protocol
  tdp?: Record<string, unknown>; // new-firmware discovery result
}

let tdpQuery: Buffer | null = null;

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

/** TP-Link Discovery Protocol probe (same packet python-kasa sends; carries a throwaway RSA public key). */
function buildTdpQuery(): Buffer {
  if (tdpQuery) return tdpQuery;
  const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const payload = Buffer.from(JSON.stringify({ params: { rsa_key: publicKey } }), "utf8");
  const header = Buffer.alloc(16);
  header.writeUInt8(2, 0); // version
  header.writeUInt8(0, 1); // msg type
  header.writeUInt16BE(1, 2); // op code: probe
  header.writeUInt16BE(payload.length, 4);
  header.writeUInt8(17, 6); // flags
  header.writeUInt8(0, 7);
  header.writeUInt32BE(crypto.randomBytes(4).readUInt32BE(0), 8);
  header.writeUInt32BE(0x5a6b7c8d, 12);
  const q = Buffer.concat([header, payload]);
  q.writeUInt32BE(crc32(q), 12);
  tdpQuery = q;
  return q;
}

export function kasaUdpDiscover(targets: string[], timeoutMs: number, onHit: (h: KasaUdpHit) => void, unicast: { ip: string; port: number }[] = []): Promise<string[]> {
  return new Promise((resolve) => {
    const errors: string[] = [];
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      try {
        sock.close();
      } catch {}
      resolve(errors);
    };
    sock.on("error", (e) => {
      errors.push(`kasa udp: ${e.message}`);
      close();
    });
    sock.on("message", (msg, rinfo) => {
      try {
        if (rinfo.port === 20002) {
          const json = JSON.parse(msg.subarray(16).toString("utf8")) as { result?: Record<string, unknown> };
          if (json.result) onHit({ ip: rinfo.address, tdp: json.result });
          return;
        }
        const json = JSON.parse(kasaDecrypt(msg)) as { system?: { get_sysinfo?: Record<string, unknown> } };
        const si = json.system?.get_sysinfo;
        if (si && typeof si === "object") onHit({ ip: rinfo.address, sysinfo: si });
      } catch {
        /* not a Kasa reply */
      }
    });
    sock.bind(0, () => {
      try {
        sock.setBroadcast(true);
      } catch {}
      const legacy = kasaEncrypt(GET_SYSINFO, false);
      let tdp: Buffer | null = null;
      try {
        tdp = buildTdpQuery();
      } catch (e) {
        errors.push(`tdp query: ${errMsg(e)}`);
      }
      const send = () => {
        for (const t of targets) {
          sock.send(legacy, KASA_PORT, t, () => {});
          if (tdp) sock.send(tdp, 20002, t, () => {});
        }
        for (const u of unicast) sock.send(legacy, u.port, u.ip, () => {});
      };
      send();
      setTimeout(() => !closed && send(), Math.min(600, timeoutMs / 3));
      setTimeout(close, timeoutMs);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Fingerprint                                                         */
/* ------------------------------------------------------------------ */

type Sysinfo = {
  alias?: string;
  model?: string;
  deviceId?: string;
  mac?: string;
  mic_mac?: string;
  type?: string;
  mic_type?: string;
  relay_state?: number;
  feature?: string;
  sw_ver?: string;
  is_color?: number;
  is_dimmable?: number;
  children?: { id: string; alias?: string; state?: number }[];
};

export async function fingerprintKasa(host: HostHint): Promise<AdapterDiscovery[] | null> {
  let si = host.kasa as Sysinfo | undefined;
  const port = host.port && host.port !== 80 ? host.port : KASA_PORT;
  if (!si) {
    try {
      const r = await kasaTcp<{ system?: { get_sysinfo?: Sysinfo } }>(host.ip, port, GET_SYSINFO, 1500);
      si = r.system?.get_sysinfo;
    } catch {
      return null;
    }
  }
  if (!si || typeof si !== "object") return null;
  const kind = String(si.mic_type ?? si.type ?? "");
  const isBulb = /SMARTBULB/i.test(kind);
  const mac = normMac(si.mac ?? si.mic_mac);
  const id = si.deviceId ?? mac ?? host.key;
  const base: LanMeta = { driver: "kasa", support: "supported", ip: host.ip, port, mac, kasa_device_id: si.deviceId, firmware: si.sw_ver, discovered_via: [...host.via] };
  const vendor = "TP-Link Kasa";
  if (isBulb) {
    const color = !!si.is_color;
    return [
      verified(
        lanManifest({
          local_key: `kasa:${id}`,
          name: si.alias || `Kasa ${si.model ?? "bulb"}`,
          device_class: "light",
          vendor,
          model: si.model,
          icon: "lightbulb",
          capabilities: [capLightSet({ color, brightness: !!si.is_dimmable || color }), capLightRead()],
          meta: { ...base, kasa_kind: "bulb", color },
        }),
      ),
    ];
  }
  if (!/SMARTPLUGSWITCH/i.test(kind) && si.relay_state === undefined && !si.children) {
    return [
      candidate({
        local_key: `kasa:${id}`,
        name: si.alias || `Kasa ${si.model ?? "device"}`,
        device_class: "other",
        vendor,
        model: si.model,
        icon: "cpu",
        meta: { ...base, support: "unsupported", reason: `Kasa device type "${kind || "unknown"}" is not supported by the v0.1 driver.` },
      }),
    ];
  }
  const metering = /ENE/.test(String(si.feature ?? ""));
  const makeCaps = (what: string) => [capSwitchSet(what), capSwitchRead(), ...(metering ? [capPowerRead()] : [])];
  if (si.children?.length) {
    return si.children.map((ch, i) => {
      const childId = ch.id.length <= 2 && si!.deviceId ? `${si!.deviceId}${ch.id}` : ch.id;
      return verified(
        lanManifest({
          local_key: `kasa:${id}:${ch.id}`,
          name: ch.alias || `${si!.alias ?? "Kasa strip"} · outlet ${i + 1}`,
          device_class: "plug",
          vendor,
          model: si!.model,
          icon: "plug",
          capabilities: makeCaps(`outlet ${i + 1}`),
          meta: { ...base, kasa_kind: "plug", child_id: childId, power_metering: metering },
        }),
      );
    });
  }
  return [
    verified(
      lanManifest({
        local_key: `kasa:${id}`,
        name: si.alias || `Kasa ${si.model ?? "plug"}`,
        device_class: "plug",
        vendor,
        model: si.model,
        icon: "plug",
        capabilities: makeCaps("the plug"),
        meta: { ...base, kasa_kind: "plug", power_metering: metering },
      }),
    ),
  ];
}

/** A device that answered the new-firmware TDP discovery but not the legacy protocol. */
export function kasaTdpCandidate(ip: string, r: Record<string, unknown>, via: string[]): AdapterDiscovery {
  const model = String(r.device_model ?? r.device_type ?? "TP-Link device");
  const enc = (r.mgt_encrypt_schm as { encrypt_type?: string } | undefined)?.encrypt_type ?? "KLAP/AES";
  const isTapo = /TAPO/i.test(String(r.device_type ?? ""));
  const isBulb = /BULB/i.test(String(r.device_type ?? ""));
  const mac = normMac(r.mac);
  return candidate({
    local_key: `kasa:${String(r.device_id ?? mac ?? ip)}`,
    name: `${isTapo ? "Tapo" : "Kasa"} ${model}`,
    device_class: isBulb ? "light" : "plug",
    vendor: isTapo ? "TP-Link Tapo" : "TP-Link Kasa",
    model,
    icon: isBulb ? "lightbulb" : "plug",
    meta: {
      driver: "candidate",
      support: "unsupported",
      ip,
      mac,
      discovered_via: via,
      reason: `This TP-Link device uses the newer ${enc}-encrypted local protocol, which needs the owner's TP-Link cloud credentials. GHOST v0.1 only speaks the legacy Kasa protocol (port 9999).`,
      instructions: "Add it to Home Assistant (TP-Link integration) and set HA_URL/HA_TOKEN; GHOST will import it from there.",
    },
  });
}

/* ------------------------------------------------------------------ */
/* Driver                                                              */
/* ------------------------------------------------------------------ */

type LightState = { on_off?: number; hue?: number; saturation?: number; brightness?: number; color_temp?: number; mode?: string; dft_on_state?: LightState; err_code?: number };

function describeBulb(ls: LightState | undefined) {
  const s = ls?.on_off ? ls : (ls?.dft_on_state ?? ls);
  return {
    on: !!ls?.on_off,
    brightness: s?.brightness,
    color: typeof s?.hue === "number" && (s?.saturation ?? 0) > 0 && !s?.color_temp ? toHex(hsvToRgb(s.hue, s.saturation ?? 0, 100)) : undefined,
    color_temp_k: s?.color_temp || undefined,
  };
}

const LS = "smartlife.iot.smartbulb.lightingservice";

export const kasaDriver: LanDriver = {
  id: "kasa",
  async invoke(device, meta, capability_id, args, ctx) {
    const ip = String(meta.ip);
    const port = Number(meta.port ?? KASA_PORT);
    const call = <T = Record<string, unknown>>(payload: unknown) => kasaTcp<T>(ip, port, payload, 3000, ctx.signal);
    const ctxWrap = (p: Record<string, unknown>) => (meta.child_id ? { context: { child_ids: [meta.child_id] }, ...p } : p);
    const readRelay = async (): Promise<boolean> => {
      const r = await call<{ system?: { get_sysinfo?: Sysinfo } }>(GET_SYSINFO);
      const si = r.system?.get_sysinfo;
      if (meta.child_id) {
        const ch = si?.children?.find((c) => meta.child_id === c.id || String(meta.child_id).endsWith(c.id));
        if (!ch) throw new Error("outlet not found in sysinfo");
        return !!ch.state;
      }
      if (typeof si?.relay_state !== "number") throw new Error("no relay_state in sysinfo");
      return si.relay_state === 1;
    };
    try {
      if (meta.kasa_kind === "bulb") {
        switch (capability_id) {
          case "light.set": {
            const p = parseLightArgs(args, { color: !!meta.color });
            if (!p.ok) return reject(p.error);
            const a = p.value;
            const req: Record<string, unknown> = { ignore_default: 1, transition_period: 300 };
            if (a.on !== undefined) req.on_off = a.on ? 1 : 0;
            if (a.brightness !== undefined) {
              if (a.brightness === 0) req.on_off = 0;
              else {
                req.brightness = Math.max(1, Math.round(a.brightness));
                if (a.on === undefined) req.on_off = 1;
              }
            }
            if (a.color) {
              const hsv = rgbToHsv(a.color);
              Object.assign(req, { hue: hsv.h, saturation: hsv.s, color_temp: 0 });
              if (req.on_off === undefined) req.on_off = 1;
            }
            const r = await call<Record<string, { transition_light_state?: LightState }>>({ [LS]: { transition_light_state: req } });
            const st = r[LS]?.transition_light_state;
            if (!st || (st.err_code && st.err_code !== 0)) return fail(`bulb returned error ${st?.err_code ?? "(no reply)"}`);
            const d = describeBulb(st);
            const obs = stateObs(d, { value: d.on, name: device.name, note: "Light state reported by the bulb in its reply." });
            if (req.on_off !== undefined && d.on !== !!req.on_off) return { state: "failed", error: `bulb reports on=${d.on}`, observation: obs };
            return ok(obs);
          }
          case "light.read": {
            const r = await call<Record<string, { get_light_state?: LightState }>>({ [LS]: { get_light_state: {} } });
            const d = describeBulb(r[LS]?.get_light_state);
            return ok(stateObs(d, { value: d.on, name: device.name }));
          }
          default:
            return reject(`unknown capability ${capability_id}`);
        }
      }
      switch (capability_id) {
        case "switch.set": {
          const p = parseOn(args);
          if (!p.ok) return reject(p.error);
          const r = await call<{ system?: { set_relay_state?: { err_code?: number } } }>(ctxWrap({ system: { set_relay_state: { state: p.value ? 1 : 0 } } }));
          const code = r.system?.set_relay_state?.err_code;
          if (code !== 0) return fail(`plug returned err_code ${code ?? "(none)"}`);
          const on = await readRelay();
          const obs = stateObs({ on }, { value: on, name: device.name, note: "Relay state read back from the plug (get_sysinfo)." });
          if (on !== p.value) return { state: "failed", error: `plug reports ${on ? "on" : "off"} after the command`, observation: obs };
          return ok(obs);
        }
        case "switch.read": {
          const on = await readRelay();
          return ok(stateObs({ on }, { value: on, name: device.name }));
        }
        case "power.read": {
          if (!meta.power_metering) return reject("this plug has no energy meter");
          const r = await call<{ emeter?: { get_realtime?: { power_mw?: number; power?: number; err_code?: number } } }>(ctxWrap({ emeter: { get_realtime: {} } }));
          const rt = r.emeter?.get_realtime;
          const w = typeof rt?.power_mw === "number" ? rt.power_mw / 1000 : rt?.power;
          if (typeof w !== "number") return fail("plug did not report power");
          return ok({ kind: "value", value: Math.round(w * 10) / 10, unit: "W", data: { ...rt }, captured_at: new Date().toISOString(), source: { name: device.name } });
        }
        default:
          return reject(`unknown capability ${capability_id}`);
      }
    } catch (e) {
      return fail(`Kasa device at ${ip}:${port} did not respond: ${errMsg(e)}`);
    }
  },
  async probe(meta) {
    try {
      await kasaTcp(String(meta.ip), Number(meta.port ?? KASA_PORT), GET_SYSINFO, 1500);
      return { online: true };
    } catch (e) {
      return { online: false, detail: errMsg(e) };
    }
  },
};
