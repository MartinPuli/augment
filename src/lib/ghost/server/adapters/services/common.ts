import type { CapabilitySpec, CatalogStatus, Device, JSONSchema } from "../../../contracts";
import { PROTOCOL_VERSION } from "../../../contracts";
import type { AdapterResult, InternalAdapter, InvokeContext, ObservationInput } from "../types";

/**
 * Shared plumbing for digital-service adapters (weather, news, wikipedia...).
 * Each service is one in-process adapter publishing ONE device (public_observation, price 0).
 * Results carry `data.ui = {type, props}` so the canvas knows which widget to render.
 */

export const TIMEOUT_MS = 8000;
export const CACHE_TTL_MS = 60_000;
export const UA = "GHOST/1.0 (open-source hackathon project; https://github.com/)";

const cache = new Map<string, { at: number; body: unknown }>();

/** Fetch with 8 s timeout + 60 s cache keyed by URL (+ optional key). */
export async function fetchCached<T = unknown>(
  url: string,
  opts: { signal?: AbortSignal; as?: "json" | "text"; headers?: Record<string, string>; ttl?: number; key?: string } = {},
): Promise<{ body: T; cached: boolean }> {
  const key = opts.key ?? url;
  const ttl = opts.ttl ?? CACHE_TTL_MS;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return { body: hit.body as T, cached: true };
  const signals = [AbortSignal.timeout(TIMEOUT_MS)];
  if (opts.signal) signals.push(opts.signal);
  const res = await fetch(url, { signal: AbortSignal.any(signals), headers: { "User-Agent": UA, ...(opts.headers ?? {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
  const body = (opts.as === "text" ? await res.text() : await res.json()) as T;
  cache.set(key, { at: Date.now(), body });
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  return { body, cached: false };
}

export function ui(type: string, props: Record<string, unknown>, title?: string): { type: string; props: Record<string, unknown>; title?: string } {
  return title ? { type, props, title } : { type, props };
}

export function ok(observation: ObservationInput): AdapterResult {
  return { state: "succeeded", observation };
}

export function reject(error: string): AdapterResult {
  return { state: "rejected", error };
}

export function str(v: unknown, max = 200): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

/** Integer arg in [min,max] with default; returns null when invalid. */
export function intArg(v: unknown, min: number, max: number, dflt: number): number | null {
  if (v === undefined || v === null || v === "") return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

export function numArg(v: unknown, min: number, max: number, dflt: number | null): number | null {
  if (v === undefined || v === null || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");
}

export interface ServiceCap {
  capability_id: string;
  semantic_type?: string;
  title: string;
  description: string;
  input_schema: JSONSchema;
  estimated_ms?: number;
  run(args: Record<string, unknown>, ctx: InvokeContext, device: Device): Promise<AdapterResult>;
}

export interface ServiceDef {
  id: string;
  name: string;
  vendor: string;
  icon: string;
  source: { operator: string; url: string; attribution?: string; conditions_url?: string };
  note?: string;
  caps: ServiceCap[];
  /** Return a reason string when the service cannot run (e.g. missing env). Device is then "unavailable". */
  unavailable?(): string | null;
}

/** Build an InternalAdapter publishing exactly one device for this service. */
export function defineService(def: ServiceDef): InternalAdapter {
  const capSpecs: CapabilitySpec[] = def.caps.map((c) => ({
    capability_id: c.capability_id,
    kind: "observe",
    semantic_type: c.semantic_type ?? c.capability_id,
    title: c.title,
    description: c.description,
    input_schema: c.input_schema,
    verification: "observation",
    exclusive: false,
    estimated_ms: c.estimated_ms ?? 1000,
    limits: { rate_per_min: 30 },
  }));
  return {
    id: `svc-${def.id}`,
    owner_id: `provider:${def.id}`,
    async discover(ctx) {
      const why = def.unavailable?.() ?? null;
      const status: CatalogStatus = why ? "unavailable" : "verified";
      if (why) ctx.log(`svc-${def.id}: unavailable (${why})`);
      return [
        {
          status,
          online: !why,
          manifest: {
            protocol_version: PROTOCOL_VERSION,
            local_key: `service-${def.id}`,
            name: def.name,
            device_class: "other",
            transport: "http-public",
            vendor: def.vendor,
            model: "Digital service",
            zone_id: "internet",
            access_type: "public_observation",
            terms: { price_cents: 0, currency: "USD", max_duration_s: 3600, note: def.note ?? `Public ${def.vendor} data.` },
            capabilities: capSpecs,
            source: def.source,
            icon: def.icon,
            meta: { service: def.id, digital_service: true, ...(why ? { unavailable_reason: why } : {}) },
          },
        },
      ];
    },
    async invoke(device, capability_id, args, ctx) {
      const cap = def.caps.find((c) => c.capability_id === capability_id);
      if (!cap) return reject(`unknown capability ${capability_id}`);
      const why = def.unavailable?.() ?? null;
      if (why) return { state: "failed", error: `${def.name} is not available: ${why}` };
      try {
        return await cap.run(args ?? {}, ctx, device);
      } catch (e) {
        const err = e as Error;
        if (err.name === "TimeoutError") return { state: "failed", error: `${def.vendor} did not respond in time` };
        if (err.name === "AbortError") return { state: "unknown", error: `cancelled before ${def.vendor} responded` };
        return { state: "failed", error: `${def.vendor} request failed: ${err.message}` };
      }
    },
    async cancel() {
      return "unsupported";
    },
  };
}
