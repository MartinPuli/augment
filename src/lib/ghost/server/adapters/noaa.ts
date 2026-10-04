import type { CapabilitySpec, Device, DeviceManifest } from "../../contracts";
import { PROTOCOL_VERSION } from "../../contracts";
import type { AdapterDiscovery, AdapterResult, InternalAdapter } from "./types";

/**
 * NOAA CO-OPS (Tides & Currents) — curated San Francisco Bay stations.
 *   Data API:     https://api.tidesandcurrents.noaa.gov/api/prod/datagetter   (docs: /api/dev)
 *   Metadata API: https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/<id>.json?expand=sensors
 *
 * Measurements (water level, temperatures, wind) are observations with the station's own timestamp.
 * Tide predictions are a separate semantic type ("water_level.predict") and are never presented as
 * measurements. Responses are cached per station+product (60 s for readings, 15 min for predictions)
 * to respect the provider.
 */

const API = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
const MDAPI = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations";
const APP = "ghost";
const CONDITIONS_URL = "https://tidesandcurrents.noaa.gov/disclaimers.html";
const READING_TTL_MS = 60_000;
const PREDICTION_TTL_MS = 15 * 60_000;
const STALE_AFTER_MIN = 60;

type Product = "water_level" | "water_temperature" | "air_temperature" | "wind" | "predictions";

interface Station {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Products verified on 2026-10-04 (fallback when the metadata API is unreachable). */
  products: Product[];
}

const STATIONS: Station[] = [
  { id: "9414290", name: "San Francisco (Golden Gate)", lat: 37.8063, lon: -122.4659, products: ["water_level", "air_temperature", "wind", "predictions"] },
  { id: "9414750", name: "Alameda", lat: 37.772, lon: -122.3003, products: ["water_level", "water_temperature", "air_temperature", "wind", "predictions"] },
  { id: "9414523", name: "Redwood City", lat: 37.5068, lon: -122.2119, products: ["water_level", "air_temperature", "wind", "predictions"] },
  { id: "9415020", name: "Point Reyes", lat: 37.9942, lon: -122.9736, products: ["water_level", "water_temperature", "predictions"] },
  { id: "9414863", name: "Richmond", lat: 37.9283, lon: -122.4, products: ["water_level", "water_temperature", "air_temperature", "wind", "predictions"] },
];

/** capability_id -> product */
const CAPS: Record<string, Product> = {
  "water_level.read": "water_level",
  "water_temperature.read": "water_temperature",
  "air_temperature.read": "air_temperature",
  "wind.read": "wind",
  "tide.predict": "predictions",
};

const emptyInput = { type: "object", properties: {}, additionalProperties: false } as const;

function capSpec(p: Product, station: Station): CapabilitySpec {
  const common = { input_schema: { ...emptyInput }, verification: "observation" as const, exclusive: false, estimated_ms: 800, limits: { rate_per_min: 30 } };
  switch (p) {
    case "water_level":
      return {
        ...common,
        capability_id: "water_level.read",
        kind: "measure",
        semantic_type: "water_level.read",
        title: "Water level (measured)",
        description: `Latest measured water level at NOAA station ${station.id} ${station.name}, meters above MLLW. 6-minute data; preliminary until NOAA verifies it.`,
        output: { unit: "m", datum: "MLLW" },
      };
    case "water_temperature":
      return {
        ...common,
        capability_id: "water_temperature.read",
        kind: "measure",
        semantic_type: "water_temperature.read",
        title: "Water temperature",
        description: `Latest measured water temperature at NOAA station ${station.id} ${station.name}.`,
        output: { unit: "°C" },
      };
    case "air_temperature":
      return {
        ...common,
        capability_id: "air_temperature.read",
        kind: "measure",
        semantic_type: "air_temperature.read",
        title: "Air temperature",
        description: `Latest measured air temperature at NOAA station ${station.id} ${station.name}.`,
        output: { unit: "°C" },
      };
    case "wind":
      return {
        ...common,
        capability_id: "wind.read",
        kind: "measure",
        semantic_type: "wind.read",
        title: "Wind speed & direction",
        description: `Latest measured wind at NOAA station ${station.id} ${station.name}: speed and gust in m/s, direction in degrees true (from).`,
        output: { unit: "m/s" },
      };
    case "predictions":
      return {
        ...common,
        capability_id: "tide.predict",
        kind: "measure",
        semantic_type: "water_level.predict",
        title: "Tide prediction (not a measurement)",
        description: `NOAA astronomical tide predictions (high/low) for station ${station.id} ${station.name}, meters above MLLW. These are model predictions, not measurements.`,
        input_schema: {
          type: "object",
          properties: { hours: { type: "integer", minimum: 1, maximum: 72, default: 24, description: "Prediction window starting now." } },
          additionalProperties: false,
        },
        output: { unit: "m", datum: "MLLW" },
      };
  }
}

/* ---------------- metadata check (which sensors are actually on) ---------------- */

async function verifiedProducts(station: Station, log: (m: string) => void): Promise<{ products: Product[]; verified: boolean }> {
  try {
    const res = await fetch(`${MDAPI}/${station.id}.json?expand=sensors`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { stations?: { tidal?: boolean; sensors?: { sensors?: { name?: string; status?: number }[] } }[] };
    const st = j.stations?.[0];
    const sensors = st?.sensors?.sensors;
    if (!st || !Array.isArray(sensors)) throw new Error("unexpected metadata structure");
    const on = sensors.filter((s) => s.status !== 0).map((s) => String(s.name ?? ""));
    const products: Product[] = [];
    if (on.some((n) => /\bWL\b/.test(n) && !/tsunami/i.test(n))) products.push("water_level");
    if (on.includes("Water Temperature")) products.push("water_temperature");
    if (on.includes("Air Temperature")) products.push("air_temperature");
    if (on.includes("Wind")) products.push("wind");
    if (st.tidal) products.push("predictions");
    return { products: products.length ? products : station.products, verified: true };
  } catch (e) {
    log(`noaa ${station.id}: metadata check failed (${(e as Error).message}); using curated products`);
    return { products: station.products, verified: false };
  }
}

function manifestFor(station: Station, products: Product[]): DeviceManifest {
  return {
    protocol_version: PROTOCOL_VERSION,
    local_key: `station-${station.id}`,
    name: `NOAA ${station.id} · ${station.name}`,
    device_class: "sensor",
    transport: "http-public",
    vendor: "NOAA CO-OPS",
    model: "Tide station",
    zone_id: "noaa-sf-bay",
    location: { lat: station.lat, lon: station.lon, label: `${station.name}, San Francisco Bay` },
    access_type: "public_observation",
    terms: { price_cents: 0, currency: "USD", max_duration_s: 3600, note: "Public NOAA CO-OPS data (US government work). Cite NOAA/NOS/CO-OPS." },
    capabilities: products.map((p) => capSpec(p, station)),
    source: {
      operator: "NOAA CO-OPS",
      url: `https://tidesandcurrents.noaa.gov/stationhome.html?id=${station.id}`,
      attribution: "NOAA/NOS Center for Operational Oceanographic Products and Services",
      conditions_url: CONDITIONS_URL,
    },
    icon: "waves",
    meta: { station_id: station.id, station_name: station.name, products },
  };
}

/* ---------------- data fetch with cache ---------------- */

interface Cached {
  at: number;
  body: Record<string, unknown>;
}
const cache = new Map<string, Cached>();

/** "2026-10-04 19:30" (GMT) -> ISO */
function gmtToIso(t: unknown): string | null {
  if (typeof t !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(t.trim());
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])).toISOString();
}

function fmtBegin(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

async function fetchProduct(
  stationId: string,
  product: Product,
  params: Record<string, string>,
  ttl: number,
  signal: AbortSignal,
): Promise<{ body: Record<string, unknown>; cached: boolean; fetched_at: string; url: string }> {
  const qs = new URLSearchParams({ station: stationId, product, time_zone: "gmt", units: "metric", format: "json", application: APP, ...params });
  const url = `${API}?${qs}`;
  const key = `${stationId}:${product}:${JSON.stringify(params)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return { body: hit.body, cached: true, fetched_at: new Date(hit.at).toISOString(), url };
  const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
  if (!res.ok) throw new Error(`NOAA HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  const now = Date.now();
  if (!body.error) cache.set(key, { at: now, body });
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return { body, cached: false, fetched_at: new Date(now).toISOString(), url };
}

type Row = Record<string, string | undefined>;

function ageNote(iso: string | null): string | null {
  if (!iso) return null;
  const min = (Date.now() - Date.parse(iso)) / 60_000;
  return min > STALE_AFTER_MIN ? `Stale: latest reading is ${Math.round(min)} min old.` : null;
}

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function readProduct(device: Device, stationId: string, product: Product, args: Record<string, unknown>, signal: AbortSignal): Promise<AdapterResult> {
  const stationName = String((device.meta as Record<string, unknown> | undefined)?.station_name ?? stationId);
  const source = { name: "NOAA CO-OPS", url: `https://tidesandcurrents.noaa.gov/stationhome.html?id=${stationId}`, attribution: "NOAA/NOS/CO-OPS" };

  if (product === "predictions") {
    const hoursRaw = args.hours === undefined ? 24 : Number(args.hours);
    if (!Number.isInteger(hoursRaw) || hoursRaw < 1 || hoursRaw > 72) return { state: "rejected", error: "hours must be an integer between 1 and 72" };
    const begin = new Date(Math.floor(Date.now() / (15 * 60_000)) * 15 * 60_000); // 15-min bucket for caching
    const { body, cached, fetched_at, url } = await fetchProduct(
      stationId,
      "predictions",
      { begin_date: fmtBegin(begin), range: String(hoursRaw), datum: "MLLW", interval: "hilo" },
      PREDICTION_TTL_MS,
      signal,
    );
    if (body.error) return { state: "failed", error: `NOAA has no tide predictions for ${stationName}: ${errMsg(body.error)}` };
    const rows = (Array.isArray(body.predictions) ? body.predictions : []) as Row[];
    const preds = rows
      .map((r) => ({ predicted_for: gmtToIso(r.t), value_m: num(r.v), type: r.type === "H" ? "high" : r.type === "L" ? "low" : r.type ?? null }))
      .filter((r) => r.predicted_for && r.value_m !== null);
    if (!preds.length) return { state: "failed", error: `NOAA returned no tide predictions for ${stationName} in the next ${hoursRaw} h` };
    const next = preds.find((p) => Date.parse(p.predicted_for!) >= Date.now()) ?? preds[0];
    return {
      state: "succeeded",
      observation: {
        kind: "value",
        value: next.value_m,
        unit: "m",
        captured_at: null,
        data: {
          station: stationId,
          station_name: stationName,
          is_prediction: true,
          datum: "MLLW",
          next: next,
          predictions: preds,
          window_hours: hoursRaw,
          cached,
          fetched_at,
          api_url: url,
        },
        source,
        note: `PREDICTION, not a measurement: NOAA astronomical tide prediction (harmonic model) for ${stationName}, meters above MLLW. Next ${next.type} tide ${next.value_m} m at ${next.predicted_for}.`,
      },
    };
  }

  const params: Record<string, string> = { date: "latest" };
  if (product === "water_level") params.datum = "MLLW";
  const { body, cached, fetched_at, url } = await fetchProduct(stationId, product, params, READING_TTL_MS, signal);
  if (body.error) return { state: "failed", error: `NOAA has no recent ${product.replace("_", " ")} reading for ${stationName}: ${errMsg(body.error)}` };
  const row = ((Array.isArray(body.data) ? body.data : []) as Row[])[0];
  if (!row) return { state: "failed", error: `NOAA returned no ${product.replace("_", " ")} data for ${stationName}` };
  const captured_at = gmtToIso(row.t);
  const stale = ageNote(captured_at);
  const base = { station: stationId, station_name: stationName, noaa_time_gmt: row.t ?? null, flags: row.f ?? null, cached, fetched_at, api_url: url };

  if (product === "wind") {
    const speed = num(row.s);
    if (speed === null) return { state: "failed", error: `NOAA's latest wind record for ${stationName} has no value (sensor gap)` };
    const dir = num(row.d);
    const gust = num(row.g);
    return {
      state: "succeeded",
      observation: {
        kind: "value",
        value: speed,
        unit: "m/s",
        captured_at,
        data: { ...base, speed_mps: speed, gust_mps: gust, direction_deg: dir, direction_cardinal: row.dr ?? null, direction_meaning: "direction the wind blows FROM, degrees true" },
        source,
        note: [`Measured wind ${speed} m/s from ${row.dr ?? dir ?? "?"}${gust !== null ? `, gusting ${gust} m/s` : ""}.`, stale].filter(Boolean).join(" "),
      },
    };
  }

  const v = num(row.v);
  if (v === null) return { state: "failed", error: `NOAA's latest ${product.replace("_", " ")} record for ${stationName} has no value (sensor gap)` };
  const unit = product === "water_level" ? "m" : "°C";
  const quality = row.q === "p" ? "preliminary" : row.q === "v" ? "verified" : row.q ?? null;
  const data: Record<string, unknown> = { ...base };
  if (product === "water_level") {
    Object.assign(data, { datum: "MLLW", quality_flag: row.q ?? null, quality, sigma_m: num(row.s), is_prediction: false });
  }
  return {
    state: "succeeded",
    observation: {
      kind: "value",
      value: v,
      unit,
      captured_at,
      data,
      source,
      note: [
        product === "water_level"
          ? `Measured water level ${v} m above MLLW${quality ? ` (${quality} data)` : ""}.`
          : `Measured ${product.replace("_", " ")} ${v} °C.`,
        stale,
      ]
        .filter(Boolean)
        .join(" "),
    },
  };
}

function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

export const noaaAdapter: InternalAdapter = {
  id: "noaa",
  owner_id: "provider:noaa",

  async discover(ctx) {
    try {
      const out: AdapterDiscovery[] = await Promise.all(
        STATIONS.map(async (s) => {
          const { products, verified } = await verifiedProducts(s, ctx.log);
          return { manifest: manifestFor(s, products), status: verified ? "verified" : "configured", online: true } satisfies AdapterDiscovery;
        }),
      );
      ctx.log(`noaa: ${out.length} stations (${out.reduce((n, d) => n + d.manifest.capabilities.length, 0)} capabilities)`);
      return out;
    } catch (e) {
      ctx.log(`noaa: discovery failed: ${(e as Error).message}`);
      return [];
    }
  },

  async invoke(device, capability_id, args, ctx) {
    const stationId = String((device.meta as Record<string, unknown> | undefined)?.station_id ?? "");
    if (!/^\d{7}$/.test(stationId)) return { state: "failed", error: "device is missing a NOAA station id" };
    const product = CAPS[capability_id];
    if (!product) return { state: "rejected", error: `unknown capability ${capability_id}` };
    if (!device.capabilities.some((c) => c.capability_id === capability_id))
      return { state: "rejected", error: `station ${stationId} does not offer ${capability_id}` };
    try {
      return await readProduct(device, stationId, product, args ?? {}, ctx.signal);
    } catch (e) {
      const err = e as Error;
      if (err.name === "TimeoutError") return { state: "failed", error: "NOAA did not respond in time" };
      if (err.name === "AbortError") return { state: "unknown", error: "cancelled before NOAA responded" };
      return { state: "failed", error: `NOAA request failed: ${err.message}` };
    }
  },

  async cancel() {
    return "unsupported";
  },
};
