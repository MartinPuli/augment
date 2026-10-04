/**
 * Web Bluetooth driver: cheap BLE LED strips/bulbs, heart-rate straps, battery service, and a
 * read-only GATT description for anything else. requestBluetoothDevice() must run inside a user
 * gesture: navigator.bluetooth.requestDevice() is called before any await.
 *
 * LED byte protocols (no state readback on any of them → verification "acknowledgment"):
 * - ELK-BLEDOM family (svc 0xFFF0 / char 0xFFF3). Frames from the open-source elkbledom Home
 *   Assistant integration (dave-code-ruiz/elkbledom models.json) and FergusInLondon/ELK-BLEDOM:
 *     on   7e 00 04 f0 00 01 ff 00 ef   (+ variant 7e 04 04 f0 00 01 ff 00 ef, also sent)
 *     off  7e 00 04 00 00 00 ff 00 ef   (+ variant 7e 04 04 00 00 00 ff 00 ef, also sent)
 *     rgb  7e 00 05 03 RR GG BB 00 ef
 *     bri  7e 00 01 PP 00 00 00 00 ef   (PP = 0..100)
 * - MELK (same service/char): login 7e 07 83 then 7e 04 04 right after connecting, then
 *   on 7e 00 04 01 00 00 00 00 ef (+ 7e 04 04 f0 00 01 ff 00 ef), off as ELK, rgb as ELK,
 *   bri 7e 04 01 PP ff 00 ff 00 ef.
 * - LEDBLE (svc 0xFFE0 / char 0xFFE1, name prefix "LEDBLE" only): on 7e 00 04 01 00 00 00 00 ef,
 *   off/rgb as ELK, bri 7e 04 01 PP ff 00 ff 00 ef.
 * - Triones / Happy Lighting / QHM (svc 0xFFD5 / char 0xFFD9) and Magic Blue / LEDBlue
 *   (svc 0xFFE5 / char 0xFFE9): on cc 23 33, off cc 24 33, rgb 56 RR GG BB 00 f0 aa;
 *   brightness by scaling RGB.
 */
import type { CapabilitySpec } from "@/lib/ghost/contracts";
import { InvokeError, type CapabilityHandler, type DriverDevice, type InvokeContext, type ResultOutput } from "../types";
import { boolArg, errorMessage, makeManifest, nowIso, numArg, parseColor, sleep, slug, toHex, withAbort, withTimeout } from "../util";

export type BleProfile = "light" | "heart_rate" | "battery" | "any";

type Hooks = { onAvailability?: (online: boolean, detail?: string) => void };
type Char = BluetoothRemoteGATTCharacteristic;
type RGB = [number, number, number];
type Frame = Uint8Array<ArrayBuffer>;

/* ------------------------------------------------------------------ */
/* Request options                                                     */
/* ------------------------------------------------------------------ */

const LIGHT_NAME_PREFIXES = [
  "ELK",
  "MELK",
  "BLEDOM",
  "Triones",
  "LEDBlue",
  "LEDBLE",
  "QHM",
  "Dream",
  "duoCo",
  "Happy",
  "LED-",
  "Magic",
] as const;
const LIGHT_NAME_RE = /^(ELK|MELK|BLEDOM|Triones|LEDBlue|LEDBLE|QHM|Dream|duoCo|Happy|LED-|Magic)/i;

/**
 * Every service we can drive or describe. Blocklisted UUIDs in optionalServices are dropped by
 * the browser rather than rejected, so listing generic_access is harmless.
 */
const OPTIONAL_SERVICES: BluetoothServiceUUID[] = [
  0xfff0,
  0xffd5,
  0xffe0,
  0xffe5,
  "heart_rate",
  "battery_service",
  "device_information",
  "generic_access",
];

function requestOptions(profile: BleProfile | undefined): RequestDeviceOptions {
  const optionalServices = OPTIONAL_SERVICES;
  switch (profile) {
    case "light":
      return {
        filters: [
          ...LIGHT_NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
          { services: [0xfff0] },
          { services: [0xffd5] },
          { services: [0xffe5] },
        ],
        optionalServices,
      };
    case "heart_rate":
      return { filters: [{ services: ["heart_rate"] }], optionalServices };
    case "battery":
      return { filters: [{ services: ["battery_service"] }], optionalServices };
    default:
      return { acceptAllDevices: true, optionalServices };
  }
}

export function bluetoothSupport(): { supported: boolean; reason?: string } {
  if (typeof navigator === "undefined") return { supported: false, reason: "not running in a browser" };
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return { supported: false, reason: "Web Bluetooth needs HTTPS (secure context) or localhost" };
  }
  if (!("bluetooth" in navigator) || !navigator.bluetooth) {
    const ua = navigator.userAgent || "";
    const iOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && typeof document !== "undefined" && "ontouchend" in document);
    return {
      supported: false,
      reason: iOS
        ? "iOS Safari does not support Web Bluetooth; use Chrome or Edge on desktop/Android (or the Bluefy browser on iOS)"
        : "Web Bluetooth needs Chrome or Edge on desktop/Android; this browser does not support it (Firefox and Safari do not)",
    };
  }
  return { supported: true };
}

/* ------------------------------------------------------------------ */
/* LED protocols                                                       */
/* ------------------------------------------------------------------ */

type LightProtocolId = "elk-bledom" | "melk" | "ledble" | "triones" | "magic-blue";

interface LightProtocol {
  id: LightProtocolId;
  label: string;
  service: number;
  char: number;
  init?: () => Frame[];
  on: () => Frame[];
  off: () => Frame[];
  color: (r: number, g: number, b: number) => Frame[];
  /** Native brightness 0..100. Absent → brightness is applied by scaling RGB. */
  brightness?: (pct: number) => Frame[];
  confidence: string;
}

const f = (...xs: number[]): Frame => Uint8Array.from(xs.map((x) => Math.round(x) & 0xff));
const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

const ELK_OFF = () => [f(0x7e, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0x00, 0xef), f(0x7e, 0x04, 0x04, 0x00, 0x00, 0x00, 0xff, 0x00, 0xef)];
const ELK_COLOR = (r: number, g: number, b: number) => [f(0x7e, 0x00, 0x05, 0x03, r, g, b, 0x00, 0xef)];
const TRIONES = {
  on: () => [f(0xcc, 0x23, 0x33)],
  off: () => [f(0xcc, 0x24, 0x33)],
  color: (r: number, g: number, b: number) => [f(0x56, r, g, b, 0x00, 0xf0, 0xaa)],
};

const PROTOCOLS: Record<LightProtocolId, LightProtocol> = {
  "elk-bledom": {
    id: "elk-bledom",
    label: "ELK-BLEDOM",
    service: 0xfff0,
    char: 0xfff3,
    on: () => [f(0x7e, 0x00, 0x04, 0xf0, 0x00, 0x01, 0xff, 0x00, 0xef), f(0x7e, 0x04, 0x04, 0xf0, 0x00, 0x01, 0xff, 0x00, 0xef)],
    off: ELK_OFF,
    color: ELK_COLOR,
    brightness: (p) => [f(0x7e, 0x00, 0x01, clampPct(p), 0x00, 0x00, 0x00, 0x00, 0xef)],
    confidence: "widely documented open-source protocol; untested on this exact unit",
  },
  melk: {
    id: "melk",
    label: "MELK",
    service: 0xfff0,
    char: 0xfff3,
    init: () => [f(0x7e, 0x07, 0x83), f(0x7e, 0x04, 0x04)],
    on: () => [f(0x7e, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0xef), f(0x7e, 0x04, 0x04, 0xf0, 0x00, 0x01, 0xff, 0x00, 0xef)],
    off: ELK_OFF,
    color: ELK_COLOR,
    brightness: (p) => [f(0x7e, 0x04, 0x01, clampPct(p), 0xff, 0x00, 0xff, 0x00, 0xef)],
    confidence: "from the elkbledom integration's MELK entry; untested",
  },
  ledble: {
    id: "ledble",
    label: "LEDBLE",
    service: 0xffe0,
    char: 0xffe1,
    on: () => [f(0x7e, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0xef)],
    off: () => [f(0x7e, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0x00, 0xef)],
    color: ELK_COLOR,
    brightness: (p) => [f(0x7e, 0x04, 0x01, clampPct(p), 0xff, 0x00, 0xff, 0x00, 0xef)],
    confidence: "from the elkbledom integration's LEDBLE entry; untested",
  },
  triones: {
    id: "triones",
    label: "Triones / Happy Lighting",
    service: 0xffd5,
    char: 0xffd9,
    ...TRIONES,
    confidence: "widely documented open-source protocol; untested on this exact unit",
  },
  "magic-blue": {
    id: "magic-blue",
    label: "Magic Blue / LEDBlue",
    service: 0xffe5,
    char: 0xffe9,
    ...TRIONES,
    confidence: "Triones frames on the Magic Blue service; untested",
  },
};

/* ------------------------------------------------------------------ */
/* GATT probing                                                        */
/* ------------------------------------------------------------------ */

interface GattHandles {
  light?: { proto: LightProtocol; char: Char };
  hr?: Char;
  battery?: Char;
}

async function tryService(server: BluetoothRemoteGATTServer, uuid: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService | null> {
  try {
    return await withTimeout(server.getPrimaryService(uuid), 4000, "getPrimaryService timed out");
  } catch {
    return null;
  }
}

async function tryChar(svc: BluetoothRemoteGATTService | null, uuid: BluetoothCharacteristicUUID): Promise<Char | null> {
  if (!svc) return null;
  try {
    return await withTimeout(svc.getCharacteristic(uuid), 4000, "getCharacteristic timed out");
  } catch {
    return null;
  }
}

function canWrite(c: Char): boolean {
  return c.properties.write || c.properties.writeWithoutResponse;
}

async function findLight(server: BluetoothRemoteGATTServer, name: string, profile: BleProfile | undefined): Promise<GattHandles["light"]> {
  const nameLooksLikeLight = LIGHT_NAME_RE.test(name);
  // 0xFFF0 and 0xFFE0 are generic vendor services on many non-light gadgets: only treat them as
  // a light when the user asked for a light or the advertised name matches a known LED family.
  const order: LightProtocolId[] = [];
  if (profile === "light" || nameLooksLikeLight) order.push(/^MELK/i.test(name) ? "melk" : "elk-bledom");
  order.push("triones", "magic-blue");
  if (/^LEDBLE/i.test(name)) order.push("ledble");
  for (const id of order) {
    const proto = PROTOCOLS[id];
    const ch = await tryChar(await tryService(server, proto.service), proto.char);
    if (ch && canWrite(ch)) return { proto, char: ch };
  }
  return undefined;
}

async function probeGatt(server: BluetoothRemoteGATTServer, name: string, profile: BleProfile | undefined): Promise<GattHandles> {
  const h: GattHandles = {};
  h.light = await findLight(server, name, profile);
  const hr = await tryChar(await tryService(server, "heart_rate"), "heart_rate_measurement");
  if (hr && hr.properties.notify) h.hr = hr;
  const bat = await tryChar(await tryService(server, "battery_service"), "battery_level");
  if (bat && bat.properties.read) h.battery = bat;
  return h;
}

async function readDeviceInfo(server: BluetoothRemoteGATTServer): Promise<{ vendor?: string; model?: string }> {
  const svc = await tryService(server, "device_information");
  if (!svc) return {};
  const dec = new TextDecoder();
  const read = async (uuid: BluetoothCharacteristicUUID) => {
    const c = await tryChar(svc, uuid);
    if (!c || !c.properties.read) return undefined;
    try {
      const v = await withTimeout(c.readValue(), 3000, "read timed out");
      const s = dec.decode(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)).replace(/\0+$/, "").trim();
      return s ? s.slice(0, 64) : undefined;
    } catch {
      return undefined;
    }
  };
  return { vendor: await read("manufacturer_name_string"), model: await read("model_number_string") };
}

const PROP_NAMES = [
  "broadcast",
  "read",
  "writeWithoutResponse",
  "write",
  "notify",
  "indicate",
  "authenticatedSignedWrites",
  "reliableWrite",
  "writableAuxiliaries",
] as const;

async function describeGatt(server: BluetoothRemoteGATTServer): Promise<{ uuid: string; characteristics: { uuid: string; properties: string[] }[] }[]> {
  let services: BluetoothRemoteGATTService[] = [];
  try {
    services = await withTimeout(server.getPrimaryServices(), 5000, "getPrimaryServices timed out");
  } catch {
    // Some stacks throw when a service is outside optionalServices: fall back to one-by-one.
    for (const uuid of OPTIONAL_SERVICES) {
      const s = await tryService(server, uuid);
      if (s) services.push(s);
    }
  }
  const out: { uuid: string; characteristics: { uuid: string; properties: string[] }[] }[] = [];
  for (const s of services.slice(0, 16)) {
    let chars: Char[] = [];
    try {
      chars = await withTimeout(s.getCharacteristics(), 4000, "getCharacteristics timed out");
    } catch {
      /* blocklisted or not permitted */
    }
    out.push({
      uuid: s.uuid,
      characteristics: chars.slice(0, 32).map((c) => ({
        uuid: c.uuid,
        properties: PROP_NAMES.filter((p) => c.properties[p]),
      })),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Capability specs                                                    */
/* ------------------------------------------------------------------ */

const LIGHT_SET: CapabilitySpec = {
  capability_id: "light.set",
  kind: "act",
  semantic_type: "light.set",
  title: "Set light",
  description:
    'Turn the Bluetooth LED light on/off, set its color ("#rrggbb") and brightness (0-100). The light has no state readback: success only means the command was sent.',
  input_schema: {
    type: "object",
    properties: {
      on: { type: "boolean", description: "true = on, false = off" },
      color: { type: "string", description: 'Color as "#rrggbb" (a few names like "red", "warm" also work)' },
      brightness: { type: "number", minimum: 0, maximum: 100, description: "Brightness percent (0 turns it off)" },
    },
    additionalProperties: false,
  },
  verification: "acknowledgment",
  limits: { rate_per_min: 60 },
  estimated_ms: 400,
};

const HR_READ: CapabilitySpec = {
  capability_id: "heart_rate.read",
  kind: "measure",
  semantic_type: "heart_rate.read",
  title: "Read heart rate",
  description: "Collect heart-rate notifications from the strap for a few seconds and return the median bpm.",
  input_schema: {
    type: "object",
    properties: { seconds: { type: "number", minimum: 1, maximum: 10, default: 5, description: "Sampling window in seconds" } },
    additionalProperties: false,
  },
  output: { unit: "bpm" },
  verification: "observation",
  estimated_ms: 5500,
};

const BATTERY_READ: CapabilitySpec = {
  capability_id: "battery.read",
  kind: "measure",
  semantic_type: "battery.read",
  title: "Read battery level",
  description: "Read the device's battery level (Bluetooth Battery Service).",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
  output: { unit: "%" },
  verification: "observation",
  exclusive: false,
  estimated_ms: 500,
};

const GATT_DESCRIBE: CapabilitySpec = {
  capability_id: "gatt.describe",
  kind: "observe",
  semantic_type: "gatt.describe",
  title: "Describe GATT services",
  description: "Read-only list of the reachable GATT services and characteristics (uuid + properties). No writes.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
  verification: "observation",
  exclusive: false,
  estimated_ms: 1500,
};

function rejectUnknown(args: Record<string, unknown>, allowed: string[]) {
  for (const k of Object.keys(args ?? {})) {
    if (!allowed.includes(k)) {
      throw new InvokeError(
        `unknown argument "${k}"` + (allowed.length ? ` (allowed: ${allowed.join(", ")})` : " (takes no arguments)"),
        "rejected",
      );
    }
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** Parse a Heart Rate Measurement (0x2A37) value. */
function parseHr(v: DataView): { bpm: number; contact: boolean | null; rr: number[] } | null {
  if (v.byteLength < 2) return null;
  const flags = v.getUint8(0);
  const u16 = (flags & 0x01) !== 0;
  let off = 1;
  if (u16 && v.byteLength < 3) return null;
  const bpm = u16 ? v.getUint16(off, true) : v.getUint8(off);
  off += u16 ? 2 : 1;
  const contactSupported = (flags & 0x04) !== 0;
  const contact = contactSupported ? (flags & 0x02) !== 0 : null;
  if (flags & 0x08) off += 2; // energy expended
  const rr: number[] = [];
  if (flags & 0x10) {
    while (off + 1 < v.byteLength) {
      rr.push(Math.round((v.getUint16(off, true) / 1024) * 1000)); // 1/1024 s → ms
      off += 2;
    }
  }
  return { bpm, contact, rr };
}

/* ------------------------------------------------------------------ */
/* Request + device                                                    */
/* ------------------------------------------------------------------ */

export async function requestBluetoothDevice(profile?: BleProfile, hooks?: Hooks): Promise<DriverDevice> {
  const sup = bluetoothSupport();
  if (!sup.supported) throw new Error(sup.reason ?? "Web Bluetooth is not supported");
  // Called synchronously, before any await, so it stays inside the user gesture.
  const devicePromise = navigator.bluetooth.requestDevice(requestOptions(profile));
  const device = await devicePromise;
  if (!device.gatt) throw new Error("This Bluetooth device has no GATT server");
  const name = (device.name || "").trim() || "Bluetooth device";

  let server: BluetoothRemoteGATTServer;
  try {
    server = await withTimeout(device.gatt.connect(), 15000, "Bluetooth connect timed out");
  } catch (e) {
    throw new Error(`Could not connect to ${name}: ${errorMessage(e)}`);
  }

  let gatt: GattHandles;
  let info: { vendor?: string; model?: string } = {};
  try {
    gatt = await probeGatt(server, name, profile);
    info = await readDeviceInfo(server);
  } catch (e) {
    device.gatt.disconnect();
    throw new Error(`Could not read services from ${name}: ${errorMessage(e)}`);
  }

  /* ---------------- connection state ---------------- */
  let disposed = false;
  let online = true;
  const onDisconnected = () => {
    if (disposed || !online) return;
    online = false;
    hooks?.onAvailability?.(false, "Bluetooth disconnected");
  };
  device.addEventListener("gattserverdisconnected", onDisconnected);

  // One GATT operation sequence at a time (writes, notification sessions, reconnects).
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  const initFrames = async (h: GattHandles) => {
    const init = h.light?.proto.init;
    if (!init || !h.light) return;
    for (const fr of init()) {
      await writeFrame(h.light.char, fr);
      await sleep(40);
    }
  };
  await initFrames(gatt).catch(() => {});

  /** Ensure a live GATT connection; one reconnect attempt per invoke. */
  const ensure = async (ctx: InvokeContext): Promise<GattHandles> => {
    if (disposed) throw new InvokeError("Bluetooth device was released", "failed");
    if (device.gatt?.connected) return gatt;
    const budget = Math.max(500, Math.min(8000, ctx.remainingMs() - 200));
    try {
      const s = await withAbort(withTimeout(device.gatt!.connect(), budget, "reconnect timed out"), ctx.signal);
      gatt = await probeGatt(s, name, profile);
      await initFrames(gatt).catch(() => {});
    } catch (e) {
      throw new InvokeError(`Bluetooth device is disconnected (out of range or off?); reconnect failed: ${errorMessage(e)}`, "failed");
    }
    if (!online) {
      online = true;
      hooks?.onAvailability?.(true, "Bluetooth reconnected");
    }
    return gatt;
  };

  /* ---------------- light ---------------- */
  let lastColor: RGB = [255, 255, 255];
  let lastBrightness = 100;
  let lastOn: boolean | null = null;

  const lightSet = async (args: Record<string, unknown>, ctx: InvokeContext): Promise<ResultOutput> => {
    rejectUnknown(args, ["on", "color", "brightness"]);
    const on = boolArg(args, "on");
    const color = args.color === undefined || args.color === null ? undefined : parseColor(args.color);
    const hasB = args.brightness !== undefined && args.brightness !== null;
    if (hasB && (typeof args.brightness === "number" || typeof args.brightness === "string")) {
      const n = Number(args.brightness);
      if (Number.isFinite(n) && (n < 0 || n > 100)) throw new InvokeError(`argument "brightness" must be 0-100 (got ${n})`, "rejected");
    }
    const brightness = hasB ? numArg(args, "brightness", { min: 0, max: 100, def: 100 }) : undefined;
    if (on === undefined && !color && brightness === undefined) {
      throw new InvokeError('give at least one of "on", "color", "brightness"', "rejected");
    }
    if (on === false && (color || (brightness !== undefined && brightness > 0))) {
      throw new InvokeError('"on": false cannot be combined with a color or brightness', "rejected");
    }

    return exclusive(async () => {
      const h = await ensure(ctx);
      if (!h.light) throw new InvokeError("light characteristic not available after reconnect", "failed");
      const { proto, char } = h.light;

      const turnOff = on === false || brightness === 0;
      const nextColor = color ?? lastColor;
      const nextB = brightness ?? lastBrightness;
      const frames: Frame[] = [];
      if (turnOff) {
        frames.push(...proto.off());
      } else {
        frames.push(...proto.on());
        if (proto.brightness) {
          if (color) frames.push(...proto.color(...nextColor));
          if (brightness !== undefined) frames.push(...proto.brightness(nextB));
        } else if (color || brightness !== undefined) {
          const k = nextB / 100;
          frames.push(...proto.color(nextColor[0] * k, nextColor[1] * k, nextColor[2] * k));
        }
      }

      let sent = 0;
      try {
        for (const fr of frames) {
          if (ctx.signal.aborted) throw new InvokeError("cancelled", "failed");
          const budget = Math.max(200, Math.min(3000, ctx.remainingMs()));
          await withAbort(withTimeout(writeFrame(char, fr), budget, "BLE write timed out"), ctx.signal);
          sent++;
          await sleep(40);
        }
      } catch (e) {
        if (sent === 0) throw e instanceof InvokeError ? e : new InvokeError(`BLE write failed: ${errorMessage(e)}`, "failed");
        throw new InvokeError(`BLE write interrupted after ${sent}/${frames.length} frames: ${errorMessage(e)}`, "unknown");
      }

      if (turnOff) lastOn = false;
      else {
        lastOn = true;
        lastColor = nextColor;
        lastBrightness = nextB;
      }
      return {
        value: lastOn ? "on" : "off",
        data: {
          on: lastOn,
          color: lastOn ? toHex(lastColor) : null,
          brightness: lastOn ? lastBrightness : 0,
          protocol: proto.id,
          frames_sent: sent,
          brightness_method: proto.brightness ? "native" : "rgb_scaling",
        },
        captured_at: nowIso(),
        note: `Command written over BLE (${proto.label} protocol, ${proto.confidence}). The light has no state readback, so the result is acknowledged, not verified.`,
      };
    });
  };

  /* ---------------- heart rate ---------------- */
  const hrRead = async (args: Record<string, unknown>, ctx: InvokeContext): Promise<ResultOutput> => {
    rejectUnknown(args, ["seconds"]);
    const seconds = numArg(args, "seconds", { min: 1, max: 10, def: 5 });
    const windowMs = Math.min(seconds * 1000, ctx.remainingMs() - 1500);
    if (windowMs < 800) throw new InvokeError("not enough time left before the deadline to sample heart rate", "failed");

    return exclusive(async () => {
      const h = await ensure(ctx);
      if (!h.hr) throw new InvokeError("heart-rate characteristic not available", "failed");
      const ch = h.hr;
      const samples: number[] = [];
      const rr: number[] = [];
      let contact: boolean | null = null;
      const onValue = (ev: Event) => {
        const v = (ev.target as Char).value;
        if (!v) return;
        const p = parseHr(v);
        if (!p) return;
        if (p.contact !== null) contact = p.contact;
        if (p.bpm > 0 && p.bpm < 255) samples.push(p.bpm);
        rr.push(...p.rr);
      };
      ch.addEventListener("characteristicvaluechanged", onValue);
      const started = nowIso();
      try {
        await withAbort(withTimeout(ch.startNotifications(), 4000, "startNotifications timed out"), ctx.signal);
        await sleep(windowMs, ctx.signal);
      } finally {
        ch.removeEventListener("characteristicvaluechanged", onValue);
        try {
          await withTimeout(ch.stopNotifications(), 2000, "stopNotifications timed out");
        } catch {
          /* already disconnected */
        }
      }
      if (!samples.length) {
        throw new InvokeError(
          `no heart-rate samples arrived in ${(windowMs / 1000).toFixed(1)} s` + (contact === false ? " (strap reports no skin contact)" : " (is the strap worn?)"),
          "failed",
        );
      }
      return {
        value: median(samples),
        unit: "bpm",
        data: {
          samples,
          min: Math.min(...samples),
          max: Math.max(...samples),
          count: samples.length,
          last: samples[samples.length - 1],
          window_s: Math.round(windowMs / 100) / 10,
          sampling_started_at: started,
          ...(rr.length ? { rr_ms: rr.slice(-30) } : {}),
          sensor_contact: contact,
        },
        captured_at: nowIso(),
        note: "Median of heart-rate notifications received from the strap during the sampling window.",
      };
    });
  };

  /* ---------------- battery ---------------- */
  const batteryRead = async (args: Record<string, unknown>, ctx: InvokeContext): Promise<ResultOutput> => {
    rejectUnknown(args, []);
    return exclusive(async () => {
      const h = await ensure(ctx);
      if (!h.battery) throw new InvokeError("battery characteristic not available", "failed");
      const budget = Math.max(500, Math.min(4000, ctx.remainingMs()));
      const v = await withAbort(withTimeout(h.battery.readValue(), budget, "battery read timed out"), ctx.signal);
      if (v.byteLength < 1) throw new InvokeError("empty battery reading", "failed");
      const pct = v.getUint8(0);
      if (pct > 100) throw new InvokeError(`device reported an invalid battery level (${pct})`, "failed");
      return { value: pct, unit: "%", captured_at: nowIso(), note: "Battery level as reported by the device's Battery Service." };
    });
  };

  /* ---------------- describe ---------------- */
  const gattDescribe = async (args: Record<string, unknown>, ctx: InvokeContext): Promise<ResultOutput> => {
    rejectUnknown(args, []);
    return exclusive(async () => {
      await ensure(ctx);
      const services = await withAbort(describeGatt(device.gatt!), ctx.signal);
      return {
        value: services.length,
        data: { services, name, ble_id: device.id },
        captured_at: nowIso(),
        note: "Only services this page was allowed to access are listed (browser blocklist and optionalServices apply). Read-only; no writes performed.",
      };
    });
  };

  /* ---------------- manifest ---------------- */
  const caps: CapabilitySpec[] = [];
  const handlers: Record<string, (a: Record<string, unknown>, c: InvokeContext) => Promise<ResultOutput>> = {};
  let detected: string;
  let device_class: "light" | "wearable" | "sensor" | "other";
  let icon: string;
  if (gatt.light) {
    detected = "light";
    device_class = "light";
    icon = "lightbulb";
    caps.push(LIGHT_SET);
    handlers["light.set"] = lightSet;
  } else if (gatt.hr) {
    detected = "heart_rate";
    device_class = "wearable";
    icon = "heart-pulse";
    caps.push(HR_READ);
    handlers["heart_rate.read"] = hrRead;
  } else if (gatt.battery) {
    detected = "battery";
    device_class = "sensor";
    icon = "battery";
  } else {
    detected = "unknown";
    device_class = "other";
    icon = "bluetooth";
  }
  if (gatt.battery) {
    caps.push(BATTERY_READ);
    handlers["battery.read"] = batteryRead;
  }
  const candidate = detected === "unknown";
  if (candidate) {
    caps.push(GATT_DESCRIBE);
    handlers["gatt.describe"] = gattDescribe;
  }

  const handler: CapabilityHandler = async (capability_id, args, ctx) => {
    const fn = handlers[capability_id];
    if (!fn) throw new InvokeError(`unknown capability "${capability_id}"`, "rejected");
    if (args !== undefined && args !== null && (typeof args !== "object" || Array.isArray(args))) {
      throw new InvokeError("arguments must be an object", "rejected");
    }
    return fn(args ?? {}, ctx);
  };

  return {
    manifest: makeManifest({
      local_key: `ble-${slug(device.id)}`,
      name,
      device_class,
      transport: "bluetooth",
      vendor: info.vendor,
      model: info.model,
      icon,
      capabilities: caps,
      meta: {
        profile: detected,
        protocol: gatt.light ? gatt.light.proto.id : detected === "heart_rate" ? "ble-hrs" : detected === "battery" ? "ble-bas" : "unknown",
        ble_id: device.id,
        tested: false,
        ...(candidate ? { candidate: true } : {}),
        ...(gatt.light ? { protocol_confidence: gatt.light.proto.confidence } : {}),
      },
    }),
    handler,
    dispose: () => {
      disposed = true;
      device.removeEventListener("gattserverdisconnected", onDisconnected);
      try {
        if (device.gatt?.connected) device.gatt.disconnect();
      } catch {
        /* ignore */
      }
    },
  };
}

async function writeFrame(c: Char, frame: Frame): Promise<void> {
  if (c.properties.writeWithoutResponse && typeof c.writeValueWithoutResponse === "function") {
    await c.writeValueWithoutResponse(frame);
  } else if (typeof c.writeValueWithResponse === "function") {
    await c.writeValueWithResponse(frame);
  } else {
    await c.writeValue(frame);
  }
}
