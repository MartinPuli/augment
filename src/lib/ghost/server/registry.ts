import type {
  AccessType,
  CapabilityHit,
  CapabilitySpec,
  CatalogStatus,
  Device,
  DeviceClass,
  DeviceManifest,
  SearchQuery,
  Terms,
} from "../contracts";
import { PROTOCOL_VERSION } from "../contracts";
import type { DevicesResponseItem, TermsPatch } from "../client/api-types";
import type { AdapterDiscovery } from "./adapters/types";
import { ensureProviderPrincipal } from "./auth";
import { db, type Queryable } from "./db";
import { emit as emitRaw } from "./events";
import { S } from "./state";
import { bad, forbidden, id, iso, isoOrNull, json, notFound, tokenize } from "./util";

type DeviceRow = {
  device_id: string;
  owner_id: string;
  connector_id: string;
  local_key: string;
  manifest: unknown;
  terms_override: unknown;
  status: CatalogStatus;
  online: boolean;
  last_heartbeat: unknown;
  created_at: unknown;
  updated_at: unknown;
};

const ACCESS_TYPES: AccessType[] = ["public_observation", "own_device", "owner_shared", "provider_booked"];
const STATUSES: CatalogStatus[] = ["candidate", "configured", "verified", "unavailable"];

export function rowToDevice(r: DeviceRow): Device {
  const m = json<DeviceManifest>(r.manifest);
  const override = json<Partial<Terms> | null>(r.terms_override);
  const terms: Terms = { ...m.terms, ...(override ?? {}) };
  // quota: null in the override means "unlimited" (owner cleared it)
  for (const k of ["quota", "floor_cents", "note"] as const) {
    if ((terms as unknown as Record<string, unknown>)[k] === null) delete terms[k];
  }
  return {
    ...m,
    terms,
    device_id: r.device_id,
    owner_id: r.owner_id,
    connector_id: r.connector_id,
    status: r.status,
    online: !!r.online,
    last_heartbeat: isoOrNull(r.last_heartbeat),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

/** Validate + normalize a manifest from an untrusted connector/adapter. Throws GhostError 400. */
export function normalizeManifest(raw: unknown): DeviceManifest {
  const m = raw as Partial<DeviceManifest> | null;
  if (!m || typeof m !== "object") throw bad("manifest must be an object");
  if (typeof m.local_key !== "string" || !m.local_key.trim() || m.local_key.length > 200)
    throw bad("manifest.local_key must be a non-empty string");
  if (typeof m.name !== "string" || !m.name.trim()) throw bad(`manifest ${m.local_key}: name required`);
  if (!m.access_type || !ACCESS_TYPES.includes(m.access_type)) throw bad(`manifest ${m.local_key}: invalid access_type`);
  const t = m.terms as Partial<Terms> | undefined;
  if (!t || typeof t !== "object") throw bad(`manifest ${m.local_key}: terms required`);
  const price = Number(t.price_cents ?? 0);
  if (!Number.isInteger(price) || price < 0) throw bad(`manifest ${m.local_key}: terms.price_cents must be an integer >= 0`);
  const maxDur = Number(t.max_duration_s ?? 300);
  if (!Number.isFinite(maxDur) || maxDur <= 0) throw bad(`manifest ${m.local_key}: terms.max_duration_s must be > 0`);
  if (!Array.isArray(m.capabilities) || m.capabilities.length === 0)
    throw bad(`manifest ${m.local_key}: at least one capability required`);
  const seen = new Set<string>();
  const caps: CapabilitySpec[] = m.capabilities.map((c) => {
    if (!c || typeof c.capability_id !== "string" || !c.capability_id) throw bad(`manifest ${m.local_key}: capability_id required`);
    if (seen.has(c.capability_id)) throw bad(`manifest ${m.local_key}: duplicate capability ${c.capability_id}`);
    seen.add(c.capability_id);
    return {
      ...c,
      kind: c.kind ?? "observe",
      semantic_type: c.semantic_type ?? c.capability_id,
      title: c.title ?? c.capability_id,
      description: String(c.description ?? "").slice(0, 2000),
      input_schema: c.input_schema && typeof c.input_schema === "object" ? c.input_schema : { type: "object", properties: {} },
      verification: c.verification ?? "acknowledgment",
    };
  });
  const terms: Terms = {
    ...t,
    price_cents: price,
    currency: "USD",
    max_duration_s: Math.round(maxDur),
  };
  if (t.quota !== undefined && t.quota !== null) {
    const qn = Number(t.quota);
    if (!Number.isInteger(qn) || qn <= 0) throw bad(`manifest ${m.local_key}: terms.quota must be a positive integer`);
    terms.quota = qn;
  }
  if (t.floor_cents !== undefined && t.floor_cents !== null) {
    const f = Number(t.floor_cents);
    if (!Number.isInteger(f) || f < 0) throw bad(`manifest ${m.local_key}: terms.floor_cents must be an integer >= 0`);
    terms.floor_cents = Math.min(f, price);
  }
  return {
    ...m,
    protocol_version: PROTOCOL_VERSION,
    local_key: m.local_key.trim(),
    name: m.name.trim().slice(0, 120),
    device_class: (m.device_class ?? "other") as DeviceClass,
    transport: m.transport ?? "other",
    access_type: m.access_type,
    terms,
    capabilities: caps,
  } as DeviceManifest;
}

export async function getDevice(device_id: string, q: Queryable = db()): Promise<Device | null> {
  const r = await q.query<DeviceRow>(`select * from devices where device_id = $1`, [device_id]);
  return r.rows[0] ? rowToDevice(r.rows[0]) : null;
}

export async function requireDevice(device_id: string, q: Queryable = db()): Promise<Device> {
  const d = await getDevice(device_id, q);
  if (!d) throw notFound(`device ${device_id} not found`);
  return d;
}

export async function listDevices(opts: { owner_id?: string; connector_id?: string } = {}): Promise<DevicesResponseItem[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.owner_id) {
    params.push(opts.owner_id);
    where.push(`owner_id = $${params.length}`);
  }
  if (opts.connector_id) {
    params.push(opts.connector_id);
    where.push(`connector_id = $${params.length}`);
  }
  const r = await db().query<DeviceRow>(
    `select * from devices ${where.length ? "where " + where.join(" and ") : ""} order by created_at desc`,
    params,
  );
  const devices = r.rows.map(rowToDevice);
  if (!devices.length) return devices;
  const locks = await db().query<{ device_id: string; lease_id: string }>(
    `select distinct device_id, lease_id from lease_locks where held and device_id = any($1::text[])`,
    [devices.map((d) => d.device_id)],
  );
  const byDev = new Map<string, string[]>();
  for (const l of locks.rows) byDev.set(l.device_id, [...(byDev.get(l.device_id) ?? []), l.lease_id]);
  return devices.map((d) => ({ ...d, active_lease_ids: byDev.get(d.device_id) ?? [] }));
}

/** Upsert one device by (connector_id, local_key). Returns the device and whether it is new. */
export async function upsertDevice(
  q: Queryable,
  args: { connector_id: string; owner_id: string; manifest: DeviceManifest; status?: CatalogStatus; online?: boolean },
): Promise<{ device: Device; created: boolean }> {
  const existing = await q.query<DeviceRow>(`select * from devices where connector_id = $1 and local_key = $2`, [
    args.connector_id,
    args.manifest.local_key,
  ]);
  const online = args.online ?? true;
  if (existing.rows[0]) {
    const prev = existing.rows[0];
    // A re-publish never downgrades a device that already proved itself with a successful invocation.
    let status: CatalogStatus = args.status ?? prev.status;
    if (prev.status === "verified" && status === "configured") status = "verified";
    const r = await q.query<DeviceRow>(
      `update devices set manifest = $2::jsonb, owner_id = $3, status = $4, online = $5, last_heartbeat = now(), updated_at = now()
       where device_id = $1 returning *`,
      [prev.device_id, JSON.stringify(args.manifest), args.owner_id, status, online],
    );
    return { device: rowToDevice(r.rows[0]), created: false };
  }
  const device_id = id("dev");
  const r = await q.query<DeviceRow>(
    `insert into devices (device_id, owner_id, connector_id, local_key, manifest, status, online, last_heartbeat)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7, now()) returning *`,
    [device_id, args.owner_id, args.connector_id, args.manifest.local_key, JSON.stringify(args.manifest), args.status ?? "configured", online],
  );
  return { device: rowToDevice(r.rows[0]), created: true };
}

/**
 * Publish devices discovered by an in-process adapter (Caltrans, NOAA, LAN scan...).
 * Upserts by connector_id "internal:<adapterId>" + local_key and emits device.published / device.updated.
 */
export async function publishFromAdapter(
  adapterId: string,
  discoveries: AdapterDiscovery[],
  opts: { owner_id?: string } = {},
): Promise<Device[]> {
  const connector_id = `internal:${adapterId}`;
  const out: Device[] = [];
  for (const d of discoveries) {
    let manifest: DeviceManifest;
    try {
      manifest = normalizeManifest(d.manifest);
    } catch (e) {
      console.warn(`[ghost] adapter ${adapterId}: skipped invalid manifest: ${(e as Error).message}`);
      continue;
    }
    const owner_id = d.owner_id ?? opts.owner_id ?? `provider:${adapterId}`;
    if (owner_id.startsWith("provider:") && !S().cache.has(`prov:${owner_id}`)) {
      await ensureProviderPrincipal(owner_id);
      S().cache.set(`prov:${owner_id}`, { at: Date.now(), value: true });
    }
    const status: CatalogStatus = d.status && STATUSES.includes(d.status) ? d.status : "verified";
    const { device, created } = await upsertDevice(db(), {
      connector_id,
      owner_id,
      manifest,
      status,
      online: d.online ?? true,
    });
    emit(created ? { type: "device.published", device } : { type: "device.updated", device });
    out.push(device);
  }
  return out;
}

/** Devices published over the device channel by a confirmed connector. */
export async function publishFromConnector(
  connector_id: string,
  owner_id: string,
  manifests: unknown[],
): Promise<{ local_key: string; device_id: string; status: CatalogStatus }[]> {
  const out: { local_key: string; device_id: string; status: CatalogStatus }[] = [];
  for (const raw of manifests.slice(0, 50)) {
    const manifest = normalizeManifest(raw);
    const { device, created } = await upsertDevice(db(), { connector_id, owner_id, manifest, status: "configured", online: true });
    emit(created ? { type: "device.published", device } : { type: "device.updated", device });
    out.push({ local_key: manifest.local_key, device_id: device.device_id, status: device.status });
  }
  return out;
}

export async function unpublishFromConnector(connector_id: string, local_keys: string[]): Promise<void> {
  for (const k of local_keys) {
    const r = await db().query<DeviceRow>(
      `update devices set status = 'unavailable', online = false, updated_at = now() where connector_id = $1 and local_key = $2 returning *`,
      [connector_id, k],
    );
    for (const row of r.rows) emit({ type: "device.removed", device_id: row.device_id });
  }
}

/** Set online flag for devices of a connector (all, or one local_key). Emits device.updated on change. */
export async function setConnectorDevicesOnline(connector_id: string, online: boolean, local_key?: string): Promise<void> {
  const params: unknown[] = [connector_id, online];
  let extra = "";
  if (local_key) {
    params.push(local_key);
    extra = ` and local_key = $3`;
  }
  const r = await db().query<DeviceRow>(
    `update devices set online = $2, updated_at = now() ${online ? ", last_heartbeat = now()" : ""}
     where connector_id = $1 and online <> $2 and status <> 'unavailable'${extra} returning *`,
    params,
  );
  for (const row of r.rows) emit({ type: "device.updated", device: rowToDevice(row) });
}

export async function touchHeartbeat(connector_id: string): Promise<void> {
  await db().query(`update devices set last_heartbeat = now() where connector_id = $1`, [connector_id]);
  await db().query(`update connectors set last_seen = now() where connector_id = $1`, [connector_id]);
}

export async function setDeviceStatus(device_id: string, status: CatalogStatus): Promise<void> {
  const r = await db().query<DeviceRow>(
    `update devices set status = $2, updated_at = now() where device_id = $1 and status <> $2 returning *`,
    [device_id, status],
  );
  if (r.rows[0]) emit({ type: "device.updated", device: rowToDevice(r.rows[0]) });
}

/** Owner edits the terms of their device (PATCH /devices/:id/terms, MCP update_offer). */
export async function updateTerms(principal_id: string, device_id: string, patch: TermsPatch): Promise<Device> {
  const d = await requireDevice(device_id);
  if (d.owner_id !== principal_id) throw forbidden("only the device owner can change its terms");
  const r0 = await db().query<{ terms_override: unknown }>(`select terms_override from devices where device_id = $1`, [device_id]);
  const override: Partial<Terms> = { ...(json<Partial<Terms> | null>(r0.rows[0]?.terms_override) ?? {}) };
  const intField = (k: "price_cents" | "max_duration_s" | "floor_cents", min: number) => {
    if (patch[k] === undefined) return;
    const v = Number(patch[k]);
    if (!Number.isInteger(v) || v < min) throw bad(`${k} must be an integer >= ${min}`);
    override[k] = v;
  };
  intField("price_cents", 0);
  intField("max_duration_s", 1);
  if ((patch as { floor_cents?: number | null }).floor_cents === null) {
    // null clears the floor (the host then never goes below the list price)
    (override as Record<string, unknown>).floor_cents = null;
  } else intField("floor_cents", 0);
  if (patch.quota !== undefined) {
    if (patch.quota === null || (patch.quota as unknown) === "") {
      (override as Record<string, unknown>).quota = null;
    } else {
      const v = Number(patch.quota);
      if (!Number.isInteger(v) || v < 1) throw bad("quota must be a positive integer (or null for unlimited)");
      override.quota = v;
    }
  }
  if (patch.requires_approval !== undefined) override.requires_approval = !!patch.requires_approval;
  if (patch.note !== undefined) {
    if (patch.note === null) (override as Record<string, unknown>).note = null;
    else override.note = String(patch.note).slice(0, 1000);
  }
  const merged = { ...d.terms, ...override };
  if (merged.floor_cents !== undefined && merged.floor_cents !== null && merged.floor_cents > merged.price_cents) {
    override.floor_cents = merged.price_cents;
  }
  const r = await db().query<DeviceRow>(
    `update devices set terms_override = $2::jsonb, updated_at = now() where device_id = $1 returning *`,
    [device_id, JSON.stringify(override)],
  );
  const dev = rowToDevice(r.rows[0]);
  emit({ type: "device.updated", device: dev });
  return dev;
}

/** Every device event passes here: keeps the search snapshot fresh. */
function emit(e: Parameters<typeof emitRaw>[0]): void {
  invalidateCatalog();
  emitRaw(e);
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export async function experienceCounts(): Promise<Map<string, { successes: number; attempts: number }>> {
  const r = await db().query<{ d: string; c: string; attempts: number; successes: number }>(
    `select e->>'device_id' as d, e->>'capability_id' as c, count(*)::int as attempts,
            sum(case when outcome = 'verified' then 1 else 0 end)::int as successes
     from experiences, jsonb_array_elements(refs) as e group by 1, 2`,
  );
  const m = new Map<string, { successes: number; attempts: number }>();
  for (const row of r.rows) m.set(`${row.d}/${row.c}`, { successes: Number(row.successes), attempts: Number(row.attempts) });
  return m;
}

/** Present a device from the viewer's perspective: their own devices are zero-price own_device access. */
export function viewTerms(d: Device, viewer_id?: string | null): { access_type: AccessType; terms: Terms } {
  if (viewer_id && d.owner_id === viewer_id) {
    return { access_type: "own_device", terms: { ...d.terms, price_cents: 0, floor_cents: 0, requires_approval: false } };
  }
  return { access_type: d.access_type, terms: d.terms };
}

/** Catalog snapshot for search, cached briefly (invalidated on every device write in this process). */
async function catalogSnapshot(): Promise<Device[]> {
  const hit = S().cache.get("catalog");
  if (hit && Date.now() - hit.at < 5000) return hit.value as Device[];
  const r = await db().query<DeviceRow>(`select * from devices where status <> 'unavailable'`);
  const devices = r.rows.map(rowToDevice);
  S().cache.set("catalog", { at: Date.now(), value: devices });
  return devices;
}

export function invalidateCatalog(): void {
  S().cache.delete("catalog");
}

export async function searchCapabilities(sq: SearchQuery, viewer_id?: string | null): Promise<CapabilityHit[]> {
  const [devices, exp] = await Promise.all([catalogSnapshot(), experienceCounts()]);
  const qTokens = sq.q ? [...new Set(tokenize(sq.q))] : [];
  const limit = Math.max(1, Math.min(200, sq.limit ?? 25));
  const scored: { hit: CapabilityHit; score: number }[] = [];
  for (const d of devices) {
    if (sq.device_class && d.device_class !== sq.device_class) continue;
    if (sq.zone_id && d.zone_id !== sq.zone_id) continue;
    if (sq.only_online && !d.online) continue;
    const view = viewTerms(d, viewer_id);
    if (sq.access_type && view.access_type !== sq.access_type) continue;
    let distance_km: number | undefined;
    if (sq.near) {
      if (!d.location) continue;
      distance_km = haversineKm(sq.near, d.location);
      if (sq.near.radius_km !== undefined && distance_km > sq.near.radius_km) continue;
    }
    const devText = [d.name, d.vendor, d.model, d.zone_id, d.device_class, d.transport, d.source?.operator, d.location?.label]
      .filter(Boolean)
      .join(" ");
    const devTokens = tokenize(devText);
    for (const c of d.capabilities) {
      if (sq.semantic_type && !(c.semantic_type === sq.semantic_type || c.semantic_type.startsWith(sq.semantic_type + ".")))
        continue;
      let relevance = 0;
      if (qTokens.length) {
        const capTokens = tokenize([c.capability_id, c.title, c.description, c.semantic_type].join(" "));
        const all = new Set([...devTokens, ...capTokens]);
        let matched = 0;
        for (const t of qTokens) {
          if (all.has(t)) matched += 1;
          else if ([...all].some((x) => (t.length >= 3 && x.startsWith(t)) || (x.length >= 4 && t.startsWith(x)))) matched += 0.6;
        }
        relevance = matched / qTokens.length;
        if (relevance === 0) continue;
      }
      const ref = `${d.device_id}/${c.capability_id}`;
      const e = exp.get(ref);
      const hit: CapabilityHit = {
        device: {
          device_id: d.device_id,
          name: d.name,
          device_class: d.device_class,
          transport: d.transport,
          zone_id: d.zone_id,
          location: d.location,
          access_type: view.access_type,
          status: d.status,
          online: d.online,
          owner_id: d.owner_id,
          source: d.source,
          icon: d.icon,
          vendor: d.vendor,
          model: d.model,
        },
        capability: c,
        terms: view.terms,
        ref,
        ...(distance_km !== undefined ? { distance_km: Math.round(distance_km * 100) / 100 } : {}),
        experience: e ?? { successes: 0, attempts: 0 },
      };
      const score =
        relevance * 4 +
        (d.online ? 2 : 0) +
        (d.status === "verified" ? 1 : d.status === "configured" ? 0.5 : 0) +
        (e && e.attempts ? (e.successes / e.attempts) * 0.5 : 0) -
        (distance_km !== undefined ? Math.min(1, distance_km / Math.max(1, sq.near?.radius_km ?? 50)) * 0.5 : 0);
      scored.push({ hit, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.hit);
}

export function findCapability(d: Device, capability_id: string): CapabilitySpec | null {
  return d.capabilities.find((c) => c.capability_id === capability_id) ?? null;
}
