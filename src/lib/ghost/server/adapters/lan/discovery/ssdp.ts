import dgram from "node:dgram";
import { limiter, tryText, xmlTag } from "../net";
import type { LanInterface, SsdpHit } from "../types";

const SSDP_ADDR = "239.255.255.250";
const SSDP_PORT = 1900;
const SEARCH_TARGETS = [
  "ssdp:all",
  "upnp:rootdevice",
  "roku:ecp",
  "urn:schemas-upnp-org:device:basic:1", // Hue bridges
  "urn:schemas-upnp-org:device:MediaRenderer:1",
  "urn:schemas-upnp-org:device:ZonePlayer:1", // Sonos
];

function mSearch(st: string, mx: number): Buffer {
  return Buffer.from(
    [`M-SEARCH * HTTP/1.1`, `HOST: ${SSDP_ADDR}:${SSDP_PORT}`, `MAN: "ssdp:discover"`, `MX: ${mx}`, `ST: ${st}`, `USER-AGENT: GHOST/0.1 UPnP/1.1 polty`, ``, ``].join("\r\n"),
  );
}

function parseHeaders(text: string): Record<string, string> {
  const h: Record<string, string> = {};
  for (const line of text.split(/\r?\n/).slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return h;
}

/**
 * SSDP M-SEARCH on every IPv4 interface. Calls onHit for each response; description XML
 * (friendlyName/manufacturer/model) is fetched only from the IP that answered.
 */
export async function ssdpSearch(ifaces: LanInterface[], timeoutMs: number, onHit: (ip: string, hit: SsdpHit) => void): Promise<string[]> {
  const errors: string[] = [];
  const mx = Math.max(1, Math.min(3, Math.floor(timeoutMs / 1500)));
  const seenLoc = new Set<string>();
  const fetchDesc = limiter(6);
  const descJobs: Promise<void>[] = [];
  const bindAddrs = ifaces.filter((i) => i.family === "IPv4").map((i) => i.address);
  if (!bindAddrs.length) bindAddrs.push("0.0.0.0");

  const handle = (msg: Buffer, ip: string) => {
    const text = msg.toString("utf8");
    if (!/^HTTP\/1\.1 200/i.test(text) && !/^NOTIFY/i.test(text)) return;
    const h = parseHeaders(text);
    const hit: SsdpHit = { location: h.location, server: h.server, st: h.st ?? h.nt, usn: h.usn, hueBridgeId: h["hue-bridgeid"] };
    onHit(ip, hit);
    const loc = h.location;
    if (!loc || seenLoc.has(loc) || seenLoc.size >= 40) return;
    let u: URL;
    try {
      u = new URL(loc);
    } catch {
      return;
    }
    // Only fetch descriptions from the host that answered (no redirects to third parties).
    if (u.hostname !== ip || u.protocol !== "http:") return;
    seenLoc.add(loc);
    descJobs.push(
      fetchDesc(async () => {
        const xml = await tryText(loc, { timeoutMs: 1500 });
        if (!xml) return;
        onHit(ip, {
          ...hit,
          friendlyName: xmlTag(xml, "friendlyName"),
          manufacturer: xmlTag(xml, "manufacturer"),
          modelName: xmlTag(xml, "modelName"),
          modelNumber: xmlTag(xml, "modelNumber"),
          serialNumber: xmlTag(xml, "serialNumber"),
          udn: xmlTag(xml, "UDN"),
          deviceType: xmlTag(xml, "deviceType"),
        });
      }),
    );
  };

  const sockets = await Promise.all(
    bindAddrs.map(
      (addr) =>
        new Promise<dgram.Socket | null>((resolve) => {
          const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
          s.on("error", (e) => {
            errors.push(`ssdp ${addr}: ${e.message}`);
            try {
              s.close();
            } catch {}
            resolve(null);
          });
          s.on("message", (msg, rinfo) => handle(msg, rinfo.address));
          s.bind(0, addr === "0.0.0.0" ? undefined : addr, () => {
            try {
              if (addr !== "0.0.0.0") s.setMulticastInterface(addr);
              s.setMulticastTTL(2);
            } catch {}
            resolve(s);
          });
        }),
    ),
  );
  const live = sockets.filter((s): s is dgram.Socket => !!s);
  const sendAll = () => {
    for (const s of live) for (const st of SEARCH_TARGETS) s.send(mSearch(st, mx), SSDP_PORT, SSDP_ADDR, (e) => e && errors.push(`ssdp send: ${e.message}`));
  };
  sendAll();
  setTimeout(sendAll, Math.min(800, timeoutMs / 3));
  await new Promise((r) => setTimeout(r, timeoutMs));
  for (const s of live) {
    try {
      s.close();
    } catch {}
  }
  await Promise.race([Promise.all(descJobs), new Promise((r) => setTimeout(r, 1800))]);
  return [...new Set(errors)].slice(0, 5);
}
