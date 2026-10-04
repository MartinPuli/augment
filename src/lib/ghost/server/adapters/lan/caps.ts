import type { CapabilitySpec, DeviceClass, DeviceManifest, JSONSchema } from "../../../contracts";
import { PROTOCOL_VERSION } from "../../../contracts";
import type { AdapterDiscovery, AdapterResult, ObservationInput } from "../types";
import type { LanMeta } from "./types";

export const LAN_ZONE = "home-lan";

const OBJ = (properties: Record<string, JSONSchema> = {}, required: string[] = []): JSONSchema => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

/* ------------------------------------------------------------------ */
/* Capability builders                                                 */
/* ------------------------------------------------------------------ */

export function capSwitchSet(what = "the relay"): CapabilitySpec {
  return {
    capability_id: "switch.set",
    kind: "act",
    semantic_type: "switch.set",
    title: "Turn on / off",
    description: `Switch ${what} on or off. The new state is read back from the device.`,
    input_schema: OBJ({ on: { type: "boolean", description: "true = on, false = off" } }, ["on"]),
    output: { schema: OBJ({ on: { type: "boolean" } }) },
    verification: "reported_state",
    limits: { rate_per_min: 30 },
    estimated_ms: 800,
  };
}

export function capSwitchRead(): CapabilitySpec {
  return {
    capability_id: "switch.read",
    kind: "observe",
    semantic_type: "switch.read",
    title: "Read on/off state",
    description: "Read whether the switch is currently on.",
    input_schema: OBJ(),
    verification: "observation",
    exclusive: false,
    estimated_ms: 500,
  };
}

export function capPowerRead(): CapabilitySpec {
  return {
    capability_id: "power.read",
    kind: "measure",
    semantic_type: "power.read",
    title: "Read power draw",
    description: "Instantaneous active power measured by the device's meter.",
    input_schema: OBJ(),
    output: { unit: "W" },
    verification: "observation",
    exclusive: false,
    estimated_ms: 500,
  };
}

export function capLightSet(opts: { color?: boolean; brightness?: boolean; temperature?: [number, number] } = {}): CapabilitySpec {
  const props: Record<string, JSONSchema> = { on: { type: "boolean", description: "Turn the light on or off" } };
  if (opts.color) props.color = { type: "string", pattern: "^#[0-9a-fA-F]{6}$", description: 'Color as hex "#rrggbb", e.g. "#8a2be2" for purple' };
  if (opts.brightness !== false) props.brightness = { type: "number", minimum: 0, maximum: 100, description: "Brightness in percent (0-100)" };
  if (opts.temperature)
    props.temperature_k = {
      type: "number",
      minimum: opts.temperature[0],
      maximum: opts.temperature[1],
      description: `White color temperature in kelvin (${opts.temperature[0]}-${opts.temperature[1]})`,
    };
  const parts = ["on/off"];
  if (opts.color) parts.push("color");
  if (opts.brightness !== false) parts.push("brightness");
  if (opts.temperature) parts.push("color temperature");
  return {
    capability_id: "light.set",
    kind: "act",
    semantic_type: "light.set",
    title: "Set light",
    description: `Change the light's ${parts.join(", ")}. Omitted fields are left unchanged. Setting a color or brightness also turns the light on.`,
    input_schema: OBJ(props),
    verification: "reported_state",
    limits: { rate_per_min: 60 },
    estimated_ms: 800,
  };
}

export function capLightRead(): CapabilitySpec {
  return {
    capability_id: "light.read",
    kind: "observe",
    semantic_type: "light.read",
    title: "Read light state",
    description: "Read on/off, brightness and color as reported by the light.",
    input_schema: OBJ(),
    verification: "observation",
    exclusive: false,
    estimated_ms: 500,
  };
}

export function capInfo(reason: string): CapabilitySpec {
  return {
    capability_id: "lan.info",
    kind: "observe",
    semantic_type: "device.info",
    title: "What GHOST knows",
    description: `Return what the network scan learned about this device. Not controllable yet: ${reason}`.slice(0, 600),
    input_schema: OBJ(),
    verification: "none",
    exclusive: false,
    estimated_ms: 50,
  };
}

/* ------------------------------------------------------------------ */
/* Manifests                                                           */
/* ------------------------------------------------------------------ */

export function lanManifest(m: {
  local_key: string;
  name: string;
  device_class: DeviceClass;
  vendor?: string;
  model?: string;
  icon?: string;
  zone_id?: string;
  capabilities: CapabilitySpec[];
  meta: LanMeta;
}): DeviceManifest {
  return {
    protocol_version: PROTOCOL_VERSION,
    local_key: m.local_key,
    name: m.name.slice(0, 120),
    device_class: m.device_class,
    transport: "wifi-lan",
    vendor: m.vendor,
    model: m.model,
    zone_id: m.zone_id ?? LAN_ZONE,
    access_type: "own_device",
    terms: {
      price_cents: 0,
      currency: "USD",
      max_duration_s: 3600,
      note: "Your own device on your own network. Free; the lease only provides exclusivity.",
    },
    capabilities: m.capabilities,
    icon: m.icon,
    meta: m.meta as Record<string, unknown>,
  };
}

export function verified(manifest: DeviceManifest): AdapterDiscovery {
  return { manifest, status: "verified", online: true };
}

/** A device we saw but cannot control (yet). Always carries lan.info so the manifest is valid. */
export function candidate(m: {
  local_key: string;
  name: string;
  device_class: DeviceClass;
  vendor?: string;
  model?: string;
  icon?: string;
  meta: LanMeta;
  capabilities?: CapabilitySpec[];
}): AdapterDiscovery {
  const reason = m.meta.reason ?? "no supported local API";
  return {
    manifest: lanManifest({ ...m, capabilities: [...(m.capabilities ?? []), capInfo(reason)] }),
    status: "candidate",
    online: true,
  };
}

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

export function ok(observation: ObservationInput): AdapterResult {
  return { state: "succeeded", observation };
}

export function fail(error: string): AdapterResult {
  return { state: "failed", error };
}

export function reject(error: string): AdapterResult {
  return { state: "rejected", error };
}

/** State read straight from the device right now: captured_at is the read time. */
export function stateObs(data: Record<string, unknown>, opts: { value?: number | string | boolean | null; unit?: string; note?: string; name?: string } = {}): ObservationInput {
  return {
    kind: "state",
    value: opts.value,
    unit: opts.unit,
    data,
    captured_at: new Date().toISOString(),
    note: opts.note,
    source: opts.name ? { name: opts.name } : undefined,
  };
}

export function ackObs(data: Record<string, unknown>, note: string): ObservationInput {
  return { kind: "ack", data, captured_at: null, note };
}

/* ------------------------------------------------------------------ */
/* Argument parsing (light-weight, no throw)                           */
/* ------------------------------------------------------------------ */

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseLightArgs(
  args: Record<string, unknown>,
  allow: { color?: boolean; temperature?: [number, number] } = {},
): Parsed<{ on?: boolean; color?: [number, number, number]; brightness?: number; temperature_k?: number }> {
  const out: { on?: boolean; color?: [number, number, number]; brightness?: number; temperature_k?: number } = {};
  const known = new Set(["on", "color", "brightness", "temperature_k"]);
  for (const k of Object.keys(args)) if (!known.has(k)) return { ok: false, error: `unknown argument "${k}"` };
  if (args.on !== undefined) {
    if (typeof args.on !== "boolean") return { ok: false, error: "on must be a boolean" };
    out.on = args.on;
  }
  if (args.color !== undefined) {
    if (!allow.color) return { ok: false, error: "this light does not support color" };
    const rgb = parseHex(args.color);
    if (!rgb) return { ok: false, error: 'color must be a hex string like "#8a2be2"' };
    out.color = rgb;
  }
  if (args.brightness !== undefined) {
    const b = Number(args.brightness);
    if (typeof args.brightness !== "number" || !Number.isFinite(b) || b < 0 || b > 100) return { ok: false, error: "brightness must be a number 0-100" };
    out.brightness = b;
  }
  if (args.temperature_k !== undefined) {
    if (!allow.temperature) return { ok: false, error: "this light does not support color temperature" };
    const t = Number(args.temperature_k);
    const [lo, hi] = allow.temperature;
    if (typeof args.temperature_k !== "number" || !Number.isFinite(t) || t < lo || t > hi)
      return { ok: false, error: `temperature_k must be between ${lo} and ${hi}` };
    out.temperature_k = t;
  }
  if (out.on === undefined && !out.color && out.brightness === undefined && out.temperature_k === undefined)
    return { ok: false, error: "nothing to change: pass on, color, brightness or temperature_k" };
  return { ok: true, value: out };
}

export function parseOn(args: Record<string, unknown>): Parsed<boolean> {
  if (typeof args.on !== "boolean") return { ok: false, error: "on (boolean) is required" };
  return { ok: true, value: args.on };
}

/* ------------------------------------------------------------------ */
/* Color                                                               */
/* ------------------------------------------------------------------ */

export function parseHex(v: unknown): [number, number, number] | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex(rgb: [number, number, number] | number[]): string {
  return "#" + rgb.slice(0, 3).map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("");
}

/** sRGB -> CIE xy (Philips Hue wide-gamut conversion, D65). */
export function rgbToXy([r, g, b]: [number, number, number]): [number, number] {
  const lin = (c: number) => {
    const v = c / 255;
    return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
  };
  const R = lin(r),
    G = lin(g),
    B = lin(b);
  const X = R * 0.664511 + G * 0.154324 + B * 0.162028;
  const Y = R * 0.283881 + G * 0.668433 + B * 0.047685;
  const Z = R * 0.000088 + G * 0.07231 + B * 0.986039;
  const sum = X + Y + Z;
  if (sum === 0) return [0.3227, 0.329];
  return [Number((X / sum).toFixed(4)), Number((Y / sum).toFixed(4))];
}

/** CIE xy (+ brightness 0..1) -> approximate sRGB, for read-back display only. */
export function xyToRgb(x: number, y: number, bri = 1): [number, number, number] {
  if (y === 0) return [255, 255, 255];
  const Y = bri;
  const X = (Y / y) * x;
  const Z = (Y / y) * (1 - x - y);
  let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
  let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
  let b = X * 0.051713 - Y * 0.121364 + Z * 1.01153;
  const gamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  r = gamma(Math.max(0, r));
  g = gamma(Math.max(0, g));
  b = gamma(Math.max(0, b));
  const max = Math.max(r, g, b, 1e-9);
  return [Math.round((r / max) * 255), Math.round((g / max) * 255), Math.round((b / max) * 255)];
}

/** RGB -> HSV with h in degrees [0,360), s and v in [0,100]. */
export function rgbToHsv([r, g, b]: [number, number, number]): { h: number; s: number; v: number } {
  const R = r / 255,
    G = g / 255,
    B = b / 255;
  const max = Math.max(R, G, B),
    min = Math.min(R, G, B);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h: Math.round(h) % 360, s: Math.round(max === 0 ? 0 : (d / max) * 100), v: Math.round(max * 100) };
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const S = s / 100,
    V = v / 100;
  const c = V * S;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = V - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** Two colors are "close enough" after a device round-trip (quantization, gamut). */
export function colorClose(a: [number, number, number], b: [number, number, number], tol = 40): boolean {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) <= tol * 3;
}
