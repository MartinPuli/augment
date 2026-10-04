import type { Hono } from "hono";
import { z } from "zod";
import type { Device } from "../../contracts";
import { rememberScan, scan } from "../adapters/lan";
import { haConfig } from "../adapters/lan/drivers/homeassistant";
import { parseExtraHosts } from "../adapters/lan/scan";
import { loadStore } from "../adapters/lan/store";
import type { LanMeta, ScanSummary } from "../adapters/lan/types";
import type { AdapterDiscovery } from "../adapters/types";
import { getPrincipal } from "../auth";
import { publishFromAdapter } from "../registry";
import { GhostError } from "../util";

/**
 * LAN routes (mounted under /api/v1):
 *   POST /lan/scan   — scan the coordinator's local network, publish what answered under the caller
 *   GET  /lan/status — last scan summary
 */

export interface LanScanResponse {
  devices: Device[];
  found: number;
  verified: number;
  candidates: number;
  /** Computers/phones seen but deliberately not published (people's personal devices). */
  skipped_personal: number;
  duration_ms: number;
  interfaces: ScanSummary["interfaces"];
  sources: Record<string, number>;
  errors: string[];
  note?: string;
  scanned_at: string;
  /** True when this is the previous result (scans are limited to one per 5 s). */
  cached?: boolean;
}

const MIN_INTERVAL_MS = 5000;

type LanRouteState = {
  inflight: Promise<LanScanResponse> | null;
  inflightOwner: string | null;
  lastAt: number;
  lastOwner: string | null;
  last: LanScanResponse | null;
};

// Survive Next dev hot reloads.
const G = globalThis as unknown as { __ghostLanRoutes?: LanRouteState };
const st: LanRouteState = (G.__ghostLanRoutes ??= { inflight: null, inflightOwner: null, lastAt: 0, lastOwner: null, last: null });

const ScanBody = z
  .object({
    timeout_ms: z.number().int().min(1000).max(10000).optional(),
  })
  .strict();

async function runScan(owner_id: string, timeoutMs: number): Promise<LanScanResponse> {
  const result = await scan({ timeoutMs, log: (m) => console.log(`[ghost/lan] ${m}`) });
  const devices = await publishFromAdapter("lan", result.discoveries, { owner_id });

  // Devices remembered from earlier scans that did not answer now: keep them, but mark offline.
  const store = await loadStore();
  const foundKeys = new Set(result.discoveries.map((d) => d.manifest.local_key));
  const missing: AdapterDiscovery[] = Object.entries(store.devices)
    .filter(([k, v]) => !foundKeys.has(k) && v.owner_id === owner_id && (v.manifest.meta as LanMeta | undefined)?.driver !== "candidate")
    .map(([, v]) => ({ manifest: v.manifest, status: v.status, online: false, owner_id }));
  if (missing.length) await publishFromAdapter("lan", missing, { owner_id }).catch(() => []);

  await rememberScan(result, owner_id);
  return {
    devices,
    found: result.found,
    verified: result.verified,
    candidates: result.candidates,
    skipped_personal: result.skipped_personal,
    duration_ms: result.duration_ms,
    interfaces: result.interfaces,
    sources: result.sources,
    errors: result.errors,
    note: result.note,
    scanned_at: result.started_at,
  };
}

export function mountLanRoutes(app: Hono) {
  app.post("/lan/scan", async (c) => {
    const principal = await getPrincipal(c);
    let raw: unknown = {};
    const text = await c.req.text();
    if (text.trim()) {
      try {
        raw = JSON.parse(text);
      } catch {
        throw new GhostError(400, "body must be JSON", "bad_request");
      }
    }
    const parsed = ScanBody.safeParse(raw ?? {});
    if (!parsed.success) throw new GhostError(400, `invalid body: ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`, "bad_request");

    if (st.inflight) {
      if (st.inflightOwner === principal) return c.json({ ...(await st.inflight), cached: true });
      throw new GhostError(429, "a network scan is already running; try again in a few seconds", "rate_limited");
    }
    const since = Date.now() - st.lastAt;
    if (since < MIN_INTERVAL_MS) {
      if (st.last && st.lastOwner === principal) return c.json({ ...st.last, cached: true });
      c.header("Retry-After", String(Math.ceil((MIN_INTERVAL_MS - since) / 1000)));
      throw new GhostError(429, `scans are limited to one every ${MIN_INTERVAL_MS / 1000} s`, "rate_limited");
    }
    st.lastAt = Date.now();
    st.inflightOwner = principal;
    st.inflight = runScan(principal, parsed.data.timeout_ms ?? 4000);
    try {
      const res = await st.inflight;
      st.last = res;
      st.lastOwner = principal;
      st.lastAt = Date.now();
      return c.json(res);
    } finally {
      st.inflight = null;
      st.inflightOwner = null;
    }
  });

  app.get("/lan/status", async (c) => {
    const principal = await getPrincipal(c);
    const store = await loadStore();
    const last = st.last && st.lastOwner === principal ? st.last : null;
    const { devices: _devices, ...lastSummary } = last ?? ({} as Partial<LanScanResponse>);
    void _devices;
    return c.json({
      scanning: !!st.inflight,
      last_scan: last ? lastSummary : store.last_scan && store.owner_id === principal ? store.last_scan : null,
      home_assistant: { configured: !!haConfig() },
      extra_hosts: parseExtraHosts(process.env.GHOST_LAN_EXTRA_HOSTS).length,
      paired_hue_bridges: Object.keys(store.hue).length,
      min_interval_ms: MIN_INTERVAL_MS,
    });
  });
}
