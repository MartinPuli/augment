import { Bonjour } from "bonjour-service";
import type { Service } from "bonjour-service";

/** mDNS / DNS-SD service types we browse for (type without leading underscore, protocol tcp). */
export const MDNS_TYPES = [
  "http",
  "shelly",
  "wled",
  "hue",
  "elg",
  "hap",
  "googlecast",
  "ipp",
  "printer",
  "airplay",
  "sonos",
  "home-assistant",
  "esphomelib",
] as const;

export interface MdnsHit {
  ip: string;
  type: string;
  name: string;
  port: number;
  host?: string;
  txt?: Record<string, unknown>;
}

/**
 * Browse the given service types for `timeoutMs` and report every IPv4 address seen.
 * Uses bonjour-service (multicast-dns) which shares UDP 5353 with the OS responder.
 */
export function mdnsBrowse(timeoutMs: number, onHit: (h: MdnsHit) => void, types: readonly string[] = MDNS_TYPES): Promise<string[]> {
  return new Promise((resolve) => {
    const errors: string[] = [];
    let bonjour: Bonjour;
    try {
      bonjour = new Bonjour({}, (err: Error) => errors.push(`mdns: ${err.message}`));
      // multicast-dns emits 'error' on its own emitter; without a listener Node would crash.
      const inner = (bonjour as unknown as { server?: { mdns?: NodeJS.EventEmitter } }).server?.mdns;
      inner?.on("error", (err: Error) => errors.push(`mdns: ${err.message}`));
      inner?.on("warning", () => {});
    } catch (e) {
      resolve([`mdns: ${(e as Error).message}`]);
      return;
    }
    const browsers = types.map((type) => {
      try {
        return bonjour.find({ type }, (svc: Service) => {
          const addrs = (svc.addresses ?? []).filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
          if (!addrs.length && svc.referer?.family === "IPv4") addrs.push(svc.referer.address);
          for (const ip of addrs.slice(0, 1)) {
            onHit({ ip, type, name: svc.name, port: svc.port, host: svc.host, txt: (svc.txt ?? undefined) as Record<string, unknown> | undefined });
          }
        });
      } catch (e) {
        errors.push(`mdns ${type}: ${(e as Error).message}`);
        return null;
      }
    });
    // Re-query once midway: some devices miss the first multicast burst.
    const requery = setTimeout(() => browsers.forEach((b) => b?.update()), Math.min(1500, timeoutMs / 2));
    setTimeout(() => {
      clearTimeout(requery);
      for (const b of browsers) {
        try {
          b?.stop();
        } catch {}
      }
      try {
        bonjour.destroy();
      } catch {}
      resolve(errors);
    }, timeoutMs);
  });
}
