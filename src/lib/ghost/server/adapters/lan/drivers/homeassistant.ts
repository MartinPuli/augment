import type { CapabilitySpec, DeviceClass, JSONSchema } from "../../../../contracts";
import type { AdapterDiscovery, AdapterResult, ObservationInput } from "../../types";
import { capLightRead, capLightSet, capSwitchRead, capSwitchSet, colorClose, fail, lanManifest, LAN_ZONE, ok, parseLightArgs, parseOn, reject, toHex } from "../caps";
import { errMsg, httpJson, httpRaw, slug, sleep } from "../net";
import type { LanDriver, LanMeta } from "../types";

/**
 * Home Assistant — documented REST API (https://developers.home-assistant.io/docs/api/rest/).
 * Configure with HA_URL (e.g. http://homeassistant.local:8123) and HA_TOKEN (a long-lived access
 * token from your HA profile). The token stays in the environment; it is never copied into manifests.
 */

export function haConfig(): { url: string; token: string } | null {
  const url = process.env.HA_URL?.trim().replace(/\/+$/, "");
  const token = process.env.HA_TOKEN?.trim();
  if (!url || !token) return null;
  return { url, token };
}

type HaState = {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
  last_reported?: string;
};

const MAX_ENTITIES = Number(process.env.HA_MAX_ENTITIES ?? 250);
const DOMAINS = ["light", "switch", "input_boolean", "fan", "cover", "media_player", "climate", "camera", "sensor", "binary_sensor", "lock"] as const;

async function ha<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  const cfg = haConfig();
  if (!cfg) throw new Error("Home Assistant is not configured (HA_URL / HA_TOKEN)");
  return httpJson<T>(`${cfg.url}${path}`, { ...init, headers: { authorization: `Bearer ${cfg.token}` }, timeoutMs: init.timeoutMs ?? 5000 });
}

/* ------------------------------------------------------------------ */
/* Capabilities per domain                                             */
/* ------------------------------------------------------------------ */

const OBJ = (properties: Record<string, JSONSchema> = {}, required: string[] = []): JSONSchema => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

function readCap(id: string, semantic: string, title: string, description: string, kind: "observe" | "measure" = "observe", unit?: string): CapabilitySpec {
  return {
    capability_id: id,
    kind,
    semantic_type: semantic,
    title,
    description,
    input_schema: OBJ(),
    ...(unit ? { output: { unit } } : {}),
    verification: "observation",
    exclusive: false,
    estimated_ms: 400,
  };
}

function actCap(id: string, semantic: string, title: string, description: string, schema: JSONSchema, verification: "reported_state" | "acknowledgment" = "reported_state"): CapabilitySpec {
  return { capability_id: id, kind: "act", semantic_type: semantic, title, description, input_schema: schema, verification, limits: { rate_per_min: 30 }, estimated_ms: 1200 };
}

function lightModes(a: Record<string, unknown>) {
  const modes = (Array.isArray(a.supported_color_modes) ? a.supported_color_modes : []) as string[];
  const color = modes.some((m) => ["hs", "xy", "rgb", "rgbw", "rgbww"].includes(m));
  const ct = modes.includes("color_temp");
  const brightness = color || ct || modes.some((m) => ["brightness", "white"].includes(m));
  const lo = Number(a.min_color_temp_kelvin ?? 2000);
  const hi = Number(a.max_color_temp_kelvin ?? 6500);
  return { color, ct, brightness, range: [Math.round(lo), Math.round(hi)] as [number, number] };
}

function climateBounds(a: Record<string, unknown>): [number, number] {
  const unit = String(a.temperature_unit ?? "°C");
  const fallback: [number, number] = unit.includes("F") ? [50, 86] : [10, 30];
  const lo = Number(a.min_temp);
  const hi = Number(a.max_temp);
  // Never trust a device range wider than sane household bounds.
  return [Number.isFinite(lo) ? Math.max(lo, fallback[0]) : fallback[0], Number.isFinite(hi) ? Math.min(hi, fallback[1]) : fallback[1]];
}

const SENSOR_ICON: Record<string, string> = {
  temperature: "thermometer",
  humidity: "droplets",
  power: "zap",
  energy: "zap",
  illuminance: "sun",
  battery: "battery",
  motion: "activity",
  occupancy: "activity",
  door: "door-open",
  window: "app-window",
  carbon_dioxide: "wind",
  pm25: "wind",
};

function entityManifest(s: HaState, area: string | null): AdapterDiscovery | null {
  const [domain, object_id] = s.entity_id.split(".");
  const a = s.attributes ?? {};
  const name = String(a.friendly_name ?? object_id.replace(/_/g, " "));
  const meta: LanMeta = { driver: "homeassistant", support: "supported", entity_id: s.entity_id, domain, discovered_via: ["home-assistant"], ha_area: area ?? undefined };
  let device_class: DeviceClass = "other";
  let icon = "house";
  let capabilities: CapabilitySpec[] = [];
  const dc = typeof a.device_class === "string" ? a.device_class : null;
  switch (domain) {
    case "light": {
      const m = lightModes(a);
      meta.color = m.color;
      meta.ct = m.ct;
      meta.ct_range = m.range;
      device_class = "light";
      icon = "lightbulb";
      capabilities = [capLightSet({ color: m.color, brightness: m.brightness, temperature: m.ct ? m.range : undefined }), capLightRead()];
      break;
    }
    case "switch":
    case "input_boolean":
      device_class = dc === "outlet" ? "plug" : "switch";
      icon = dc === "outlet" ? "plug" : "toggle-right";
      capabilities = [capSwitchSet(), capSwitchRead()];
      break;
    case "fan":
      device_class = "actuator";
      icon = "fan";
      capabilities = [
        actCap(
          "fan.set",
          "fan.set",
          "Set fan",
          "Turn the fan on/off, optionally at a speed percentage.",
          OBJ({ on: { type: "boolean" }, percentage: { type: "number", minimum: 0, maximum: 100, description: "Speed in percent" } }, ["on"]),
        ),
        readCap("fan.read", "fan.read", "Read fan state", "Whether the fan is on and its speed."),
      ];
      break;
    case "cover":
      device_class = "actuator";
      icon = "blinds";
      capabilities = [
        actCap(
          "cover.set",
          "cover.set",
          "Move cover",
          `Open, close or stop the ${dc ?? "cover"}, or move it to a position (0 = closed, 100 = open). The reported state may be "opening"/"closing" while it moves.`,
          OBJ({ action: { type: "string", enum: ["open", "close", "stop"] }, position: { type: "number", minimum: 0, maximum: 100 } }),
        ),
        readCap("cover.read", "cover.read", "Read cover state", "open / closed / opening / closing and position."),
      ];
      break;
    case "lock":
      // Locks are security-sensitive: read-only in v0.1.
      device_class = "actuator";
      icon = "lock";
      capabilities = [readCap("lock.read", "lock.read", "Read lock state", "locked / unlocked. GHOST v0.1 never operates locks.")];
      break;
    case "media_player":
      device_class = dc === "tv" ? "display" : dc === "speaker" ? "speaker" : "media";
      icon = dc === "tv" ? "tv" : "speaker";
      capabilities = [
        actCap(
          "media.control",
          "media.control",
          "Control playback",
          "Play/pause, skip, set volume (0-100), mute, or turn on/off.",
          OBJ(
            {
              action: { type: "string", enum: ["play", "pause", "play_pause", "next", "previous", "volume_set", "mute", "unmute", "turn_on", "turn_off"] },
              volume: { type: "number", minimum: 0, maximum: 100, description: "Required for volume_set" },
            },
            ["action"],
          ),
        ),
        readCap("media.read", "media.read", "What's playing", "Player state, title, artist, source and volume."),
      ];
      break;
    case "climate": {
      const [lo, hi] = climateBounds(a);
      const unit = String(a.temperature_unit ?? "°C");
      meta.temp_bounds = [lo, hi];
      device_class = "actuator";
      icon = "thermometer";
      capabilities = [
        actCap(
          "climate.set_temperature",
          "climate.set_temperature",
          "Set target temperature",
          `Set the thermostat target (${lo}-${hi} ${unit}).`,
          OBJ({ temperature: { type: "number", minimum: lo, maximum: hi } }, ["temperature"]),
        ),
        readCap("climate.read", "climate.read", "Read thermostat", "Current and target temperature, HVAC mode.", "measure", unit),
      ];
      break;
    }
    case "camera":
      device_class = "camera";
      icon = "camera";
      capabilities = [
        {
          capability_id: "camera.snapshot",
          kind: "observe",
          semantic_type: "image.observe",
          title: "Snapshot",
          description: "Fetch the camera's current still image through Home Assistant.",
          input_schema: OBJ(),
          output: { media: "image/jpeg" },
          verification: "observation",
          exclusive: false,
          limits: { rate_per_min: 20 },
          estimated_ms: 2000,
        },
      ];
      break;
    case "sensor": {
      const unit = typeof a.unit_of_measurement === "string" ? a.unit_of_measurement : undefined;
      const numeric = s.state !== "" && Number.isFinite(Number(s.state));
      if (!numeric && !dc) return null; // skip text sensors without semantics (there are many)
      device_class = "sensor";
      icon = SENSOR_ICON[dc ?? ""] ?? "gauge";
      const sem = `${dc ?? slug(object_id).replace(/-/g, "_")}.read`;
      capabilities = [readCap("sensor.read", sem, `Read ${dc ?? "sensor"}`, `Latest ${dc ?? "sensor"} reading from Home Assistant${unit ? ` in ${unit}` : ""}.`, numeric ? "measure" : "observe", unit)];
      break;
    }
    case "binary_sensor":
      device_class = "sensor";
      icon = SENSOR_ICON[dc ?? ""] ?? "radar";
      capabilities = [readCap("sensor.read", `${dc ?? "binary_sensor"}.read`, `Read ${dc ?? "binary sensor"}`, `Whether the ${dc ?? "sensor"} is on (detected/open) or off.`)];
      break;
    default:
      return null;
  }
  const manifest = lanManifest({
    local_key: `ha:${s.entity_id}`,
    name,
    device_class,
    vendor: "Home Assistant",
    model: [domain, dc].filter(Boolean).join(" · "),
    icon,
    zone_id: area ? slug(area) : LAN_ZONE,
    capabilities,
    meta,
  });
  return { manifest, status: "verified", online: s.state !== "unavailable" };
}

const PRIORITY: Record<string, number> = { light: 0, switch: 1, fan: 1, cover: 1, media_player: 2, climate: 2, camera: 2, input_boolean: 3, lock: 3, binary_sensor: 4, sensor: 5 };

/** Import Home Assistant entities as GHOST devices. Returns [] if HA is not configured. */
export async function discoverHomeAssistant(log?: (m: string) => void): Promise<{ discoveries: AdapterDiscovery[]; error?: string }> {
  if (!haConfig()) return { discoveries: [] };
  let states: HaState[];
  try {
    states = await ha<HaState[]>("/api/states", { timeoutMs: 6000 });
  } catch (e) {
    const msg = `Home Assistant unreachable: ${errMsg(e)}`;
    log?.(msg);
    return { discoveries: [], error: msg };
  }
  const wanted = states
    .filter((s) => (DOMAINS as readonly string[]).includes(s.entity_id.split(".")[0]))
    .filter((s) => !s.attributes?.hidden)
    .sort((x, y) => (PRIORITY[x.entity_id.split(".")[0]] ?? 9) - (PRIORITY[y.entity_id.split(".")[0]] ?? 9));
  // Areas via the template endpoint (best-effort, one request).
  const areas = new Map<string, string>();
  try {
    const tpl = "{% for s in states %}{{ s.entity_id }}\t{{ area_name(s.entity_id) or '' }}\n{% endfor %}";
    const cfg = haConfig()!;
    const r = await httpRaw(`${cfg.url}/api/template`, { method: "POST", body: { template: tpl }, headers: { authorization: `Bearer ${cfg.token}` }, timeoutMs: 5000 });
    if (r.ok)
      for (const line of (await r.text()).split("\n")) {
        const [eid, area] = line.split("\t");
        if (eid && area?.trim()) areas.set(eid.trim(), area.trim());
      }
  } catch {
    /* areas are optional */
  }
  const out: AdapterDiscovery[] = [];
  for (const s of wanted) {
    if (out.length >= MAX_ENTITIES) break;
    const d = entityManifest(s, areas.get(s.entity_id) ?? null);
    if (d) out.push(d);
  }
  log?.(`Home Assistant: imported ${out.length} of ${states.length} entities`);
  return { discoveries: out };
}

/* ------------------------------------------------------------------ */
/* Invoke                                                              */
/* ------------------------------------------------------------------ */

async function getState(entity_id: string, signal?: AbortSignal): Promise<HaState> {
  return ha<HaState>(`/api/states/${encodeURIComponent(entity_id)}`, { signal });
}

async function callService(domain: string, service: string, data: Record<string, unknown>, signal?: AbortSignal) {
  return ha<unknown>(`/api/services/${domain}/${service}`, { method: "POST", body: data, signal, timeoutMs: 8000 });
}

/** Poll the entity until `done` holds (HA applies service calls asynchronously). */
async function readBack(entity_id: string, done: (s: HaState) => boolean, signal?: AbortSignal): Promise<{ state: HaState; matched: boolean }> {
  let st = await getState(entity_id, signal);
  for (let i = 0; i < 5 && !done(st); i++) {
    await sleep(350);
    st = await getState(entity_id, signal);
  }
  return { state: st, matched: done(st) };
}

function capturedAt(s: HaState): string | null {
  return s.last_reported ?? s.last_updated ?? null;
}

function stateData(s: HaState): Record<string, unknown> {
  const a = s.attributes ?? {};
  const pick = (keys: string[]) => Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
  const base: Record<string, unknown> = { entity_id: s.entity_id, state: s.state };
  const domain = s.entity_id.split(".")[0];
  if (domain === "light") {
    if (typeof a.brightness === "number") base.brightness = Math.round((a.brightness / 255) * 100);
    if (Array.isArray(a.rgb_color)) base.color = toHex(a.rgb_color as number[]);
    if (a.color_temp_kelvin) base.color_temp_k = a.color_temp_kelvin;
    base.on = ["unknown", "unavailable"].includes(s.state) ? null : s.state === "on";
  } else if (domain === "media_player") {
    Object.assign(base, pick(["media_title", "media_artist", "source", "app_name", "is_volume_muted"]));
    if (typeof a.volume_level === "number") base.volume = Math.round(a.volume_level * 100);
  } else if (domain === "climate") {
    Object.assign(base, pick(["current_temperature", "temperature", "hvac_action", "temperature_unit"]));
  } else if (domain === "cover") {
    Object.assign(base, pick(["current_position"]));
  } else if (domain === "fan") {
    Object.assign(base, pick(["percentage", "preset_mode"]));
    base.on = ["unknown", "unavailable"].includes(s.state) ? null : s.state === "on";
  } else {
    if (a.unit_of_measurement) base.unit = a.unit_of_measurement;
    if (a.device_class) base.device_class = a.device_class;
    if (["switch", "input_boolean"].includes(domain)) base.on = ["unknown", "unavailable"].includes(s.state) ? null : s.state === "on";
  }
  return base;
}

function stateObservation(s: HaState, name: string, note?: string): ObservationInput {
  const domain = s.entity_id.split(".")[0];
  const a = s.attributes ?? {};
  let value: number | string | boolean | null = s.state;
  let unit: string | undefined;
  if (["light", "switch", "input_boolean", "fan", "binary_sensor"].includes(domain)) value = s.state === "on";
  else if (domain === "sensor" && Number.isFinite(Number(s.state)) && s.state !== "") {
    value = Number(s.state);
    unit = typeof a.unit_of_measurement === "string" ? a.unit_of_measurement : undefined;
  } else if (domain === "climate" && typeof a.current_temperature === "number") {
    value = a.current_temperature;
    unit = String(a.temperature_unit ?? "°C");
  }
  if (s.state === "unavailable" || s.state === "unknown") value = null;
  return {
    kind: domain === "sensor" && typeof value === "number" ? "value" : "state",
    value,
    unit,
    data: stateData(s),
    captured_at: capturedAt(s),
    source: { name: `${name} via Home Assistant` },
    note: note ?? (["unavailable", "unknown"].includes(s.state) ? `Home Assistant reports this entity as ${s.state}.` : undefined),
  };
}

function verifiedResult(r: { state: HaState; matched: boolean }, name: string, what: string): AdapterResult {
  const obs = stateObservation(r.state, name, r.matched ? `State read back from Home Assistant after ${what}.` : undefined);
  if (!r.matched) return { state: "failed", error: `Home Assistant still reports "${r.state.state}" after ${what}`, observation: obs };
  return ok(obs);
}

export const homeAssistantDriver: LanDriver = {
  id: "homeassistant",
  async invoke(device, meta, capability_id, args, ctx) {
    if (!haConfig()) return fail("Home Assistant is no longer configured on this coordinator (HA_URL / HA_TOKEN missing).");
    const entity_id = String(meta.entity_id);
    const domain = entity_id.split(".")[0];
    const sig = ctx.signal;
    try {
      switch (capability_id) {
        case "light.set": {
          const range = (meta.ct_range as [number, number] | undefined) ?? [2000, 6500];
          const p = parseLightArgs(args, { color: !!meta.color, temperature: meta.ct ? range : undefined });
          if (!p.ok) return reject(p.error);
          const a = p.value;
          const turnOff = a.on === false || a.brightness === 0;
          if (turnOff) {
            await callService("light", "turn_off", { entity_id }, sig);
            return verifiedResult(await readBack(entity_id, (s) => s.state === "off", sig), device.name, "turning it off");
          }
          const data: Record<string, unknown> = { entity_id };
          if (a.color) data.rgb_color = a.color;
          if (a.brightness !== undefined) data.brightness_pct = Math.round(a.brightness);
          if (a.temperature_k !== undefined) data.color_temp_kelvin = Math.round(a.temperature_k);
          await callService("light", "turn_on", data, sig);
          const applied = (s: HaState) => {
            if (s.state !== "on") return false;
            const rgb = s.attributes?.rgb_color as number[] | undefined;
            if (a.color && Array.isArray(rgb) && !colorClose(a.color, [rgb[0], rgb[1], rgb[2]], 60)) return false;
            const bri = s.attributes?.brightness;
            if (a.brightness !== undefined && typeof bri === "number" && Math.abs((bri / 255) * 100 - a.brightness) > 4) return false;
            return true;
          };
          const rb = await readBack(entity_id, applied, sig);
          if (!rb.matched && rb.state.state === "on")
            return ok(stateObservation(rb.state, device.name, "The light is on; its reported color/brightness differs slightly from the request (device gamut or rounding)."));
          return verifiedResult(rb, device.name, "turning it on");
        }
        case "switch.set": {
          const p = parseOn(args);
          if (!p.ok) return reject(p.error);
          await callService(domain === "input_boolean" ? "input_boolean" : "switch", p.value ? "turn_on" : "turn_off", { entity_id }, sig);
          const want = p.value ? "on" : "off";
          return verifiedResult(await readBack(entity_id, (s) => s.state === want, sig), device.name, `switching ${want}`);
        }
        case "fan.set": {
          if (typeof args.on !== "boolean") return reject("on (boolean) is required");
          const pct = args.percentage;
          if (pct !== undefined && (typeof pct !== "number" || pct < 0 || pct > 100)) return reject("percentage must be 0-100");
          if (!args.on) await callService("fan", "turn_off", { entity_id }, sig);
          else await callService("fan", "turn_on", { entity_id, ...(typeof pct === "number" ? { percentage: Math.round(pct) } : {}) }, sig);
          const want = args.on ? "on" : "off";
          return verifiedResult(await readBack(entity_id, (s) => s.state === want, sig), device.name, `turning the fan ${want}`);
        }
        case "cover.set": {
          const action = args.action;
          const pos = args.position;
          if (pos !== undefined) {
            if (typeof pos !== "number" || pos < 0 || pos > 100) return reject("position must be 0-100");
            await callService("cover", "set_cover_position", { entity_id, position: Math.round(pos) }, sig);
          } else if (action === "open" || action === "close" || action === "stop") {
            await callService("cover", `${action}_cover`, { entity_id }, sig);
          } else return reject('pass action ("open" | "close" | "stop") or position (0-100)');
          await sleep(500);
          const st = await getState(entity_id, sig);
          return ok(stateObservation(st, device.name, "Cover state right after the command (it may still be moving)."));
        }
        case "media.control": {
          const action = String(args.action ?? "");
          const map: Record<string, [string, Record<string, unknown>]> = {
            play: ["media_play", {}],
            pause: ["media_pause", {}],
            play_pause: ["media_play_pause", {}],
            next: ["media_next_track", {}],
            previous: ["media_previous_track", {}],
            mute: ["volume_mute", { is_volume_muted: true }],
            unmute: ["volume_mute", { is_volume_muted: false }],
            turn_on: ["turn_on", {}],
            turn_off: ["turn_off", {}],
          };
          let svc: [string, Record<string, unknown>] | undefined = map[action];
          if (action === "volume_set") {
            const v = args.volume;
            if (typeof v !== "number" || v < 0 || v > 100) return reject("volume (0-100) is required for volume_set");
            svc = ["volume_set", { volume_level: Math.round(v) / 100 }];
          }
          if (!svc) return reject(`unknown action "${action}"`);
          await callService("media_player", svc[0], { entity_id, ...svc[1] }, sig);
          await sleep(600);
          const st = await getState(entity_id, sig);
          return ok(stateObservation(st, device.name, "Player state read back from Home Assistant shortly after the command."));
        }
        case "climate.set_temperature": {
          const [lo, hi] = (meta.temp_bounds as [number, number] | undefined) ?? [10, 30];
          const t = args.temperature;
          if (typeof t !== "number" || !Number.isFinite(t) || t < lo || t > hi) return reject(`temperature must be between ${lo} and ${hi}`);
          await callService("climate", "set_temperature", { entity_id, temperature: t }, sig);
          return verifiedResult(await readBack(entity_id, (s) => Number(s.attributes?.temperature) === t, sig), device.name, `setting ${t}°`);
        }
        case "camera.snapshot": {
          const cfg = haConfig()!;
          const r = await httpRaw(`${cfg.url}/api/camera_proxy/${encodeURIComponent(entity_id)}`, { headers: { authorization: `Bearer ${cfg.token}` }, signal: sig, timeoutMs: 8000 });
          if (!r.ok) return fail(`Home Assistant camera proxy returned HTTP ${r.status}`);
          const bytes = new Uint8Array(await r.arrayBuffer());
          if (bytes.length > 8_000_000) return fail("snapshot too large");
          return ok({
            kind: "image",
            media: { bytes, content_type: r.headers.get("content-type") ?? "image/jpeg" },
            captured_at: null,
            source: { name: `${device.name} via Home Assistant` },
            note: "Still image from Home Assistant's camera proxy; HA does not report when the frame was captured.",
          });
        }
        case "light.read":
        case "switch.read":
        case "fan.read":
        case "cover.read":
        case "media.read":
        case "climate.read":
        case "lock.read":
        case "sensor.read": {
          const st = await getState(entity_id, sig);
          return ok(stateObservation(st, device.name));
        }
        default:
          return reject(`unknown capability ${capability_id}`);
      }
    } catch (e) {
      return fail(`Home Assistant call failed: ${errMsg(e)}`);
    }
  },
  async probe(meta) {
    try {
      const s = await getState(String(meta.entity_id));
      return { online: s.state !== "unavailable", detail: s.state };
    } catch (e) {
      return { online: false, detail: errMsg(e) };
    }
  },
};
