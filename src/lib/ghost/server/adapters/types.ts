import type {
  CatalogStatus,
  Device,
  DeviceManifest,
  InvocationState,
  LiveSource,
  ObservationKind,
} from "../../contracts";

/**
 * In-process adapter (a connector that runs inside the coordinator).
 * Used for documented public sources (Caltrans, NOAA) and LAN devices (Shelly, WLED, Hue...).
 * Mirrors the DeviceAdapter shape from the spec: describe/probe/read/invoke/status/cancel/release.
 */
export interface InternalAdapter {
  /** Stable id, e.g. "caltrans", "noaa", "lan". Devices get connector_id "internal:<id>". */
  id: string;
  /** Owner principal for the devices this adapter publishes, e.g. "provider:caltrans". */
  owner_id: string;
  /** Called once at boot (and on refresh). Return manifests to upsert into the catalog. */
  discover?(ctx: AdapterContext): Promise<AdapterDiscovery[]>;
  /** Execute a capability. Must enforce its own input validation and physical bounds. */
  invoke(device: Device, capability_id: string, args: Record<string, unknown>, ctx: InvokeContext): Promise<AdapterResult>;
  /** Optional availability check. */
  probe?(device: Device): Promise<{ online: boolean; detail?: string }>;
  /** Optional cancellation. Return "unsupported" or "too_late" honestly. */
  cancel?(invocation_id: string): Promise<"cancelled" | "unsupported" | "too_late">;
}

export interface AdapterDiscovery {
  manifest: DeviceManifest;
  status?: CatalogStatus; // default "verified" for documented public sources that responded
  online?: boolean; // default true
  /** Optional owner override (e.g. LAN devices adopted by the principal who scanned). */
  owner_id?: string;
}

export interface AdapterContext {
  log(message: string): void;
}

export interface InvokeContext {
  invocation_id: string;
  visitor_id: string;
  lease_id: string | null;
  deadline: Date;
  signal: AbortSignal;
}

export interface AdapterResult {
  state: Extract<InvocationState, "succeeded" | "failed" | "rejected" | "unknown">;
  error?: string;
  observation?: ObservationInput;
}

export interface ObservationInput {
  kind: ObservationKind;
  /** Raw media bytes (stored by the coordinator and served at /api/v1/observations/:id/media). */
  media?: { bytes: Uint8Array; content_type: string };
  stream?: LiveSource;
  value?: number | string | boolean | null;
  unit?: string;
  data?: Record<string, unknown>;
  /** When the world was captured; null if unknown. Never fake this with retrieval time. */
  captured_at?: string | null;
  source?: { name: string; url?: string; attribution?: string };
  note?: string;
}
