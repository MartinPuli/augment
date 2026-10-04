import { promises as fs } from "node:fs";
import path from "node:path";
import type { DeviceManifest, CatalogStatus } from "../../../contracts";
import type { ScanSummary } from "./types";

/**
 * Small JSON store at .ghost/lan.json (gitignored).
 * Holds Hue bridge usernames (secrets: never copied into manifests), the principal that last
 * scanned (so devices re-published at boot keep their owner), and previously found devices.
 */
export interface LanStore {
  version: 1;
  /** Principal that ran the most recent scan; owns LAN + Home Assistant devices. */
  owner_id?: string;
  hue: Record<string, { username: string; ip: string; paired_at: string }>;
  devices: Record<string, { manifest: DeviceManifest; status: CatalogStatus; owner_id: string; last_seen: string }>;
  last_scan?: ScanSummary;
}

/** GHOST_LAN_STORE overrides the file path (scripts/tests use a scratch file). */
const FILE = () => process.env.GHOST_LAN_STORE ?? path.join(process.cwd(), ".ghost", "lan.json");

let cache: LanStore | null = null;
let writing: Promise<void> = Promise.resolve();

export async function loadStore(): Promise<LanStore> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await fs.readFile(FILE(), "utf8")) as Partial<LanStore>;
    cache = { version: 1, hue: raw.hue ?? {}, devices: raw.devices ?? {}, owner_id: raw.owner_id, last_scan: raw.last_scan };
  } catch {
    cache = { version: 1, hue: {}, devices: {} };
  }
  return cache;
}

/** Mutate and persist (serialized writes, atomic rename). */
export async function updateStore(fn: (s: LanStore) => void): Promise<LanStore> {
  const s = await loadStore();
  fn(s);
  const file = FILE();
  writing = writing
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
      await fs.rename(tmp, file);
    });
  await writing.catch((e) => console.warn(`[ghost/lan] could not persist ${file}: ${(e as Error).message}`));
  return s;
}
