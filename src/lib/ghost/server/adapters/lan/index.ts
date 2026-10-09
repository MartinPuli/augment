import type { Device } from "../../../contracts";
import type { AdapterContext, AdapterDiscovery, InternalAdapter } from "../types";
import { elgatoDriver } from "./drivers/elgato";
import { discoverHomeAssistant, homeAssistantDriver } from "./drivers/homeassistant";
import { hueBridgeDriver, hueLightDriver } from "./drivers/hue";
import { kasaDriver } from "./drivers/kasa";
import { rokuDriver } from "./drivers/roku";
import { shellyDriver } from "./drivers/shelly";
import { tasmotaDriver } from "./drivers/tasmota";
import { wledDriver } from "./drivers/wled";
import { errMsg, limiter, withTimeout } from "./net";
import { scan } from "./scan";
import { loadStore, updateStore } from "./store";
import type { DriverId, LanDriver, LanMeta, ScanResult } from "./types";

export { scan } from "./scan";
export type { ScanResult, ScanSummary, LanMeta, LanSupport } from "./types";

/**
 * LAN / smart-home adapter. Devices live on the user's own network and are controlled through
 * their documented local APIs (Shelly, WLED, Tasmota, Elgato, Hue, Kasa, Roku) or through Home
 * Assistant's REST API. Publishing happens via POST /api/v1/lan/scan (owner = the scanning
 * principal) and at boot via discover() (previously found devices + Home Assistant entities).
 */

const DRIVERS: Partial<Record<DriverId, LanDriver>> = {
  shelly: shellyDriver,
  wled: wledDriver,
  tasmota: tasmotaDriver,
  elgato: elgatoDriver,
  "hue-bridge": hueBridgeDriver,
  "hue-light": hueLightDriver,
  kasa: kasaDriver,
  roku: rokuDriver,
  homeassistant: homeAssistantDriver,
};

export const LAN_PROVIDER = "provider:lan";

/** Remember what a scan found so it is re-published at the next boot. */
export async function rememberScan(result: ScanResult, owner_id: string): Promise<void> {
  await updateStore((s) => {
    s.owner_id = owner_id;
    const now = new Date().toISOString();
    for (const d of result.discoveries) {
      const meta = d.manifest.meta as LanMeta | undefined;
      // HA entities come back from HA itself at boot; persist only direct LAN devices.
      if (meta?.driver === "homeassistant") continue;
      s.devices[d.manifest.local_key] = { manifest: d.manifest, status: d.status ?? "verified", owner_id, last_seen: now };
    }
    const { discoveries: _d, ...summary } = result;
    void _d;
    s.last_scan = summary;
  });
}

function lanInfo(device: Device, meta: LanMeta) {
  return {
    state: "succeeded" as const,
    observation: {
      kind: "state" as const,
      data: {
        name: device.name,
        vendor: device.vendor ?? null,
        model: device.model ?? null,
        ip: meta.ip ?? null,
        support: meta.support,
        reason: meta.reason ?? null,
        instructions: meta.instructions ?? null,
        protocols: meta.protocols ?? null,
        services: meta.services ?? null,
        discovered_via: meta.discovered_via ?? [],
      },
      captured_at: null,
      note: "What the network scan learned; not a live reading.",
    },
  };
}

async function discover(ctx: AdapterContext): Promise<AdapterDiscovery[]> {
  const store = await loadStore();
  if (process.env.NODE_ENV === "production" && !process.env.GHOST_LOCAL_LAN_OWNER_ID) return [];
  const out: AdapterDiscovery[] = [];
  // 1) Devices found by earlier scans, re-checked quickly so `online` is honest.
  const probeLimit = limiter(8);
  const persisted = Object.values(store.devices);
  await Promise.all(
    persisted.map((p) =>
      probeLimit(async () => {
        const meta = p.manifest.meta as LanMeta;
        const driver = DRIVERS[meta?.driver];
        let online = false;
        if (driver?.probe) online = (await withTimeout(driver.probe(meta).catch(() => ({ online: false })), 2500, { online: false })).online;
        else online = false;
        out.push({ manifest: p.manifest, status: p.status, online, owner_id: p.owner_id });
      }),
    ),
  );
  // Never expose unclaimed HA devices. Cloud deployments use outbound owner gateways.
  const owner = process.env.GHOST_LOCAL_LAN_OWNER_ID || store.owner_id;
  const ha = owner ? await discoverHomeAssistant(ctx.log) : { discoveries: [] };
  for (const d of ha.discoveries) out.push({ ...d, owner_id: owner! });
  if (persisted.length || ha.discoveries.length) ctx.log(`lan: re-published ${persisted.length} remembered device(s) and ${ha.discoveries.length} Home Assistant entit(ies)`);
  return out;
}

export const lanAdapter: InternalAdapter = {
  id: "lan",
  owner_id: LAN_PROVIDER,
  discover,
  async invoke(device, capability_id, args, ctx) {
    const meta = (device.meta ?? {}) as LanMeta;
    if (capability_id === "lan.info") return lanInfo(device, meta);
    const driver = DRIVERS[meta.driver];
    if (!driver) return { state: "rejected", error: String(meta.reason ?? `${device.name} has no LAN driver in GHOST v0.1`) };
    try {
      return await driver.invoke(device, meta, capability_id, args ?? {}, ctx);
    } catch (e) {
      return { state: "failed", error: `${device.name}: ${errMsg(e)}` };
    }
  },
  async probe(device) {
    const meta = (device.meta ?? {}) as LanMeta;
    const driver = DRIVERS[meta.driver];
    if (!driver?.probe) return { online: false, detail: "no probe for this device" };
    return withTimeout(
      driver.probe(meta).catch((e) => ({ online: false, detail: errMsg(e) })),
      3000,
      { online: false, detail: "timed out" },
    );
  },
};

/** Convenience for scripts: run a scan without publishing. */
export async function scanOnly(timeoutMs = 4000) {
  return scan({ timeoutMs });
}
