import type { Device } from "../../../contracts";
import type { AdapterDiscovery, AdapterResult, InvokeContext } from "../types";

export type DriverId =
  | "octoprint"
  | "moonraker"
  | "shelly"
  | "wled"
  | "tasmota"
  | "elgato"
  | "hue-bridge"
  | "hue-light"
  | "kasa"
  | "roku"
  | "homeassistant"
  | "candidate";

/** How far GHOST can go with a device. Drives UI color (mint / amber / mute). */
export type LanSupport = "supported" | "needs_pairing" | "unsupported";

/**
 * Connection info stored in manifest.meta. Never put secrets here (Hue usernames and HA tokens
 * live in .ghost/lan.json / env only); meta is visible to the owner in device listings.
 */
export interface LanMeta {
  driver: DriverId;
  support: LanSupport;
  ip?: string;
  port?: number;
  mac?: string;
  serial?: string;
  /** Why the device is a candidate, in plain language. */
  reason?: string;
  /** What the user can do to make it work. */
  instructions?: string;
  discovered_via?: string[];
  /** Driver-specific fields. */
  [k: string]: unknown;
}

/** Everything the discovery layer learned about one host before fingerprinting. */
export interface HostHint {
  /** ip, or ip:port for explicit extra hosts (several simulators can share 127.0.0.1). */
  key: string;
  ip: string;
  /** Preferred HTTP port (default 80). */
  port?: number;
  via: Set<string>;
  mdns: { type: string; name: string; port: number; host?: string; txt?: Record<string, unknown> }[];
  ssdp: SsdpHit[];
  kasa?: Record<string, unknown>; // raw get_sysinfo reply (legacy Kasa protocol)
  tdp?: Record<string, unknown>; // TP-Link discovery reply (KLAP/AES firmware)
  /** Explicit driver hint (GHOST_LAN_EXTRA_HOSTS "driver@host:port"). */
  forced?: string;
  extra?: boolean;
}

export interface SsdpHit {
  location?: string;
  server?: string;
  st?: string;
  usn?: string;
  hueBridgeId?: string;
  friendlyName?: string;
  manufacturer?: string;
  modelName?: string;
  modelNumber?: string;
  serialNumber?: string;
  udn?: string;
  deviceType?: string;
}

export interface LanDriver {
  id: DriverId;
  invoke(device: Device, meta: LanMeta, capability_id: string, args: Record<string, unknown>, ctx: InvokeContext): Promise<AdapterResult>;
  probe?(meta: LanMeta): Promise<{ online: boolean; detail?: string }>;
}

export type Fingerprinter = (host: HostHint) => Promise<AdapterDiscovery[] | null>;

export interface LanInterface {
  name: string;
  address: string;
  netmask: string;
  cidr: string | null;
  family: "IPv4" | "IPv6";
  mac?: string;
}

export interface ScanSummary {
  started_at: string;
  duration_ms: number;
  found: number;
  verified: number;
  candidates: number;
  /** Computers / phones seen (e.g. Macs announcing AirPlay) and deliberately not published. */
  skipped_personal: number;
  interfaces: LanInterface[];
  sources: Record<string, number>;
  errors: string[];
  note?: string;
}

export interface ScanResult extends ScanSummary {
  discoveries: AdapterDiscovery[];
}
