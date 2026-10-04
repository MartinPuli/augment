import { z } from "zod";
import type { CapabilitySpec, Device, DeviceManifest } from "../../contracts";
import { PROTOCOL_VERSION } from "../../contracts";
import { checkProxyUrl, proxiedHlsUrl } from "../routes/proxy";
import type { AdapterDiscovery, AdapterResult, InternalAdapter } from "./types";

/**
 * Caltrans CCTV (public road cameras). Documented operator data:
 *   https://cwwp2.dot.ca.gov/data/d<N>/cctv/cctvStatusD0<N>.json
 * Conditions of use: https://dot.ca.gov/conditions-of-use — retain Caltrans attribution.
 *
 * Read-only road views. GHOST never steers these cameras and never triggers a capture: the still is
 * the operator's latest published image, and the stream is the operator's own live HLS feed.
 */

const CONDITIONS_URL = "https://dot.ca.gov/conditions-of-use";
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const CATALOG_TIMEOUT_MS = 20_000;
const MEDIA_TIMEOUT_MS = 10_000;
const STILL_NOTE = "Operator's latest published still; GHOST did not trigger the camera.";
const STREAM_NOTE =
  "Operator's live HLS stream, proxied through GHOST for CORS. Video typically runs ~10–30 s behind real time (segmented HLS). Road view only; GHOST cannot steer this camera.";

const catalogUrl = (d: number) => `https://cwwp2.dot.ca.gov/data/d${d}/cctv/cctvStatusD${String(d).padStart(2, "0")}.json`;

/* ---------- catalog validation (lenient: unknown fields are ignored, bad rows skipped) ---------- */

const Cctv = z.object({
  index: z.union([z.string(), z.number()]).transform(String),
  recordTimestamp: z
    .object({ recordDate: z.string().optional(), recordTime: z.string().optional(), recordEpoch: z.union([z.string(), z.number()]).optional() })
    .partial()
    .optional(),
  location: z.object({
    district: z.union([z.string(), z.number()]).transform(String).optional(),
    locationName: z.string(),
    nearbyPlace: z.string().optional().default(""),
    longitude: z.union([z.string(), z.number()]).transform(Number),
    latitude: z.union([z.string(), z.number()]).transform(Number),
    direction: z.string().optional().default(""),
    county: z.string().optional().default(""),
    route: z.string().optional().default(""),
    postmile: z.union([z.string(), z.number()]).optional(),
  }),
  inService: z.union([z.string(), z.boolean()]).transform((v) => v === true || String(v).toLowerCase() === "true"),
  imageData: z.object({
    streamingVideoURL: z.string().optional().default(""),
    static: z.object({
      currentImageUpdateFrequency: z.union([z.string(), z.number()]).optional(),
      currentImageURL: z.string().optional().default(""),
    }),
  }),
});
type CctvRecord = z.infer<typeof Cctv>;

const Catalog = z.object({ data: z.array(z.object({ cctv: z.unknown() })) });

interface CameraMeta {
  caltrans_index: string;
  code: string;
  district: number;
  image_url: string;
  stream_url: string | null;
  route: string;
  direction: string;
  county: string;
  nearby_place: string;
  postmile?: string;
  image_update_frequency_min: number | null;
  catalog_record_time: string | null;
}

function districts(): number[] {
  const raw = process.env.GHOST_CALTRANS_DISTRICTS ?? "4";
  const out = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 12);
  return out.length ? [...new Set(out)] : [4];
}

function validUrl(raw: string | undefined | null): string | null {
  if (!raw || /not reported/i.test(raw)) return null;
  return checkProxyUrl(raw.trim()) ? raw.trim() : null;
}

/** "TV327 -- I-280 : At John Daly Blvd" -> { code: "TV327", label: "I-280 at John Daly Blvd" } */
function parseName(locationName: string, route: string): { code: string; label: string } {
  const [codePart, rest = ""] = locationName.split(/\s+--\s+/, 2);
  const code = (rest ? codePart : "").trim().toUpperCase();
  const body = rest || locationName;
  const [r, where = ""] = body.split(/\s*:\s*/, 2);
  let place = where.trim().replace(/\s+/g, " ");
  place = place.replace(/^(At|Before|After|Near|On|In)\b/, (w) => w.toLowerCase());
  const label = [r.trim() || route, place].filter(Boolean).join(" ");
  return { code, label };
}

function epochIso(rt: CctvRecord["recordTimestamp"]): string | null {
  const e = Number(rt?.recordEpoch);
  return Number.isFinite(e) && e > 0 ? new Date(e * 1000).toISOString() : null;
}

function capabilities(meta: CameraMeta, title: string): CapabilitySpec[] {
  const caps: CapabilitySpec[] = [
    {
      capability_id: "image.observe",
      kind: "observe",
      semantic_type: "image.observe",
      title: "Latest camera still",
      description: `Fetch the operator's most recently published still from Caltrans camera ${title}. Caltrans refreshes stills roughly every ${meta.image_update_frequency_min ?? 5} min; GHOST does not trigger captures. Road view only.`,
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      output: { media: "image/jpeg" },
      limits: { rate_per_min: 12, max_payload_bytes: MAX_IMAGE_BYTES },
      verification: "observation",
      exclusive: false,
      estimated_ms: 1500,
    },
  ];
  if (meta.stream_url) {
    caps.push({
      capability_id: "video.stream",
      kind: "stream",
      semantic_type: "video.live",
      title: "Live video stream",
      description: `Open the operator's live HLS video from Caltrans camera ${title} (proxied for the canvas, can be tracked with in-browser object detection). Road view only; cannot be steered.`,
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      output: { media: "application/vnd.apple.mpegurl" },
      limits: { rate_per_min: 30 },
      verification: "observation",
      exclusive: false,
      estimated_ms: 1200,
    });
  }
  return caps;
}

function toDiscovery(rec: CctvRecord, district: number, seen: Set<string>): AdapterDiscovery | null {
  const image_url = validUrl(rec.imageData.static.currentImageURL);
  if (!image_url) return null;
  const lat = rec.location.latitude;
  const lon = rec.location.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const { code, label } = parseName(rec.location.locationName, rec.location.route);
  let local_key = `d${district}-${(code || `idx${rec.index}`).toLowerCase()}`;
  if (seen.has(local_key)) local_key = `${local_key}-${rec.index}`;
  seen.add(local_key);
  const freq = Number(rec.imageData.static.currentImageUpdateFrequency);
  const meta: CameraMeta = {
    caltrans_index: rec.index,
    code,
    district,
    image_url,
    stream_url: validUrl(rec.imageData.streamingVideoURL),
    route: rec.location.route,
    direction: rec.location.direction,
    county: rec.location.county,
    nearby_place: rec.location.nearbyPlace,
    postmile: rec.location.postmile !== undefined ? String(rec.location.postmile) : undefined,
    image_update_frequency_min: Number.isFinite(freq) && freq > 0 ? freq : null,
    catalog_record_time: epochIso(rec.recordTimestamp),
  };
  const name = code ? `${code} · ${label}` : label;
  const placeLabel = [label, rec.location.nearbyPlace, rec.location.county && `${rec.location.county} County`].filter(Boolean).join(", ");
  const manifest: DeviceManifest = {
    protocol_version: PROTOCOL_VERSION,
    local_key,
    name,
    device_class: "camera",
    transport: "http-public",
    vendor: "Caltrans",
    model: "CCTV",
    zone_id: `caltrans-d${district}`,
    location: { lat, lon, label: placeLabel },
    access_type: "public_observation",
    terms: {
      price_cents: 0,
      currency: "USD",
      max_duration_s: 3600,
      note: "Public Caltrans data. Retain attribution: \"Caltrans CCTV\". See https://dot.ca.gov/conditions-of-use",
    },
    capabilities: capabilities(meta, name),
    source: {
      operator: "Caltrans",
      url: catalogUrl(district),
      attribution: `Caltrans CCTV, District ${district}`,
      conditions_url: CONDITIONS_URL,
    },
    icon: "cctv",
    meta: { ...meta, direction_of_view: rec.location.direction || null, has_stream: Boolean(meta.stream_url) },
  };
  return rec.inService ? { manifest, status: "verified", online: true } : { manifest, status: "unavailable", online: false };
}

async function fetchDistrict(district: number, log: (m: string) => void): Promise<AdapterDiscovery[]> {
  const url = catalogUrl(district);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS), headers: { "user-agent": "GHOST/0.1" } });
    if (!res.ok) {
      log(`caltrans d${district}: catalog HTTP ${res.status}`);
      return [];
    }
    const parsed = Catalog.safeParse(await res.json());
    if (!parsed.success) {
      log(`caltrans d${district}: unexpected catalog structure`);
      return [];
    }
    const seen = new Set<string>();
    const out: AdapterDiscovery[] = [];
    let skipped = 0;
    for (const row of parsed.data.data) {
      const rec = Cctv.safeParse(row.cctv);
      const d = rec.success ? toDiscovery(rec.data, district, seen) : null;
      if (d) out.push(d);
      else skipped++;
    }
    const streams = out.filter((d) => d.manifest.capabilities.some((c) => c.capability_id === "video.stream")).length;
    log(`caltrans d${district}: ${out.length} cameras (${streams} with live stream, ${skipped} skipped)`);
    return out;
  } catch (e) {
    log(`caltrans d${district}: catalog fetch failed: ${(e as Error).message}`);
    return [];
  }
}

function readMeta(device: Device): CameraMeta | null {
  const m = device.meta as Partial<CameraMeta> | undefined;
  if (!m || typeof m.image_url !== "string") return null;
  return m as CameraMeta;
}

function withDeadline(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

function httpDateIso(v: string | null): string | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

async function observeStill(device: Device, meta: CameraMeta, signal: AbortSignal): Promise<AdapterResult> {
  const u = checkProxyUrl(meta.image_url);
  if (!u) return { state: "rejected", error: "camera image URL is not on the allowlist" };
  const res = await fetch(u, { signal: withDeadline(signal, MEDIA_TIMEOUT_MS), headers: { "user-agent": "GHOST/0.1" } });
  if (!res.ok) return { state: "failed", error: `Caltrans still unavailable (HTTP ${res.status})` };
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!type.startsWith("image/")) return { state: "failed", error: `Caltrans returned ${type || "unknown content"} instead of an image` };
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_IMAGE_BYTES) return { state: "failed", error: `still too large (${declared} bytes)` };
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) return { state: "failed", error: "Caltrans returned an empty image" };
  if (bytes.byteLength > MAX_IMAGE_BYTES) return { state: "failed", error: `still too large (${bytes.byteLength} bytes)` };
  const operator_updated_at = httpDateIso(res.headers.get("last-modified"));
  return {
    state: "succeeded",
    observation: {
      kind: "image",
      media: { bytes, content_type: type },
      captured_at: null,
      data: {
        camera: meta.code || device.name,
        operator_updated_at,
        operator_updated_at_meaning: "HTTP Last-Modified of the operator's file (when Caltrans published it), not a verified capture time",
        image_url: meta.image_url,
        image_update_frequency_min: meta.image_update_frequency_min,
        bytes: bytes.byteLength,
        route: meta.route,
        direction: meta.direction,
      },
      source: { name: "Caltrans", url: meta.image_url, attribution: `Caltrans CCTV, District ${meta.district}` },
      note: STILL_NOTE,
    },
  };
}

async function openStream(device: Device, meta: CameraMeta, signal: AbortSignal): Promise<AdapterResult> {
  if (!meta.stream_url) return { state: "rejected", error: "this camera has no published live stream" };
  const u = checkProxyUrl(meta.stream_url);
  if (!u) return { state: "rejected", error: "stream URL is not on the proxy allowlist" };
  const res = await fetch(u, { signal: withDeadline(signal, MEDIA_TIMEOUT_MS), headers: { "user-agent": "GHOST/0.1" } });
  if (!res.ok) return { state: "failed", error: `Stream unavailable (operator playlist HTTP ${res.status})` };
  const text = await res.text();
  if (!text.trimStart().startsWith("#EXTM3U")) return { state: "failed", error: "Stream unavailable (operator did not return an HLS playlist)" };
  const variants = (text.match(/#EXT-X-STREAM-INF:[^\n]*/g) ?? []).map((l) => {
    const res = /RESOLUTION=(\d+x\d+)/.exec(l)?.[1];
    const bw = /BANDWIDTH=(\d+)/.exec(l)?.[1];
    return { resolution: res ?? null, bandwidth: bw ? Number(bw) : null };
  });
  const title = `${device.name} · Caltrans live`;
  return {
    state: "succeeded",
    observation: {
      kind: "stream",
      stream: { kind: "hls", url: proxiedHlsUrl(meta.stream_url), title },
      captured_at: null,
      data: {
        camera: meta.code || device.name,
        upstream_url: meta.stream_url,
        playlist_ok: true,
        playlist_checked_at: new Date().toISOString(),
        variants,
        route: meta.route,
        direction: meta.direction,
      },
      source: { name: "Caltrans", url: meta.stream_url, attribution: `Caltrans CCTV, District ${meta.district}` },
      note: STREAM_NOTE,
    },
  };
}

export const caltransAdapter: InternalAdapter = {
  id: "caltrans",
  owner_id: "provider:caltrans",

  async discover(ctx) {
    try {
      const all = await Promise.all(districts().map((d) => fetchDistrict(d, ctx.log)));
      return all.flat();
    } catch (e) {
      ctx.log(`caltrans: discovery failed: ${(e as Error).message}`);
      return [];
    }
  },

  async invoke(device, capability_id, _args, ctx) {
    const meta = readMeta(device);
    if (!meta) return { state: "failed", error: "device is missing Caltrans camera metadata" };
    try {
      if (capability_id === "image.observe") return await observeStill(device, meta, ctx.signal);
      if (capability_id === "video.stream") return await openStream(device, meta, ctx.signal);
      return { state: "rejected", error: `unknown capability ${capability_id} (Caltrans cameras are read-only road views)` };
    } catch (e) {
      const err = e as Error;
      if (err.name === "TimeoutError") return { state: "failed", error: "Caltrans did not respond in time" };
      if (err.name === "AbortError") return { state: "unknown", error: "cancelled before Caltrans responded" };
      return { state: "failed", error: `Caltrans request failed: ${err.message}` };
    }
  },

  async probe(device) {
    const meta = readMeta(device);
    if (!meta) return { online: false, detail: "missing metadata" };
    try {
      const res = await fetch(meta.image_url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
      return { online: res.ok, detail: res.ok ? `still last modified ${res.headers.get("last-modified") ?? "unknown"}` : `HTTP ${res.status}` };
    } catch (e) {
      return { online: false, detail: (e as Error).message };
    }
  },

  async cancel() {
    return "unsupported";
  },
};
