import type { AdapterDiscovery } from "../types";
import { mdnsBrowse } from "./discovery/mdns";
import { ssdpSearch } from "./discovery/ssdp";
import { classifyCandidate } from "./drivers/candidates";
import { fingerprintElgato } from "./drivers/elgato";
import { discoverHomeAssistant, haConfig } from "./drivers/homeassistant";
import { fingerprintHue } from "./drivers/hue";
import { fingerprintKasa, kasaTdpCandidate, kasaUdpDiscover } from "./drivers/kasa";
import { discoverPrinters } from "./drivers/printers";
import { fingerprintRoku, ROKU_PORT } from "./drivers/roku";
import { fingerprintShelly } from "./drivers/shelly";
import { fingerprintTasmota } from "./drivers/tasmota";
import { fingerprintWled } from "./drivers/wled";
import { broadcastAddr, errMsg, isPrivateLanV4, lanInterfaces, limiter, selfAddresses, sleep } from "./net";
import type { Fingerprinter, HostHint, LanMeta, ScanResult } from "./types";

/**
 * LAN discovery: mDNS + SSDP + Kasa UDP broadcast (+ TP-Link TDP) + explicit extra hosts, then
 * HTTP fingerprinting of every host that answered. Read-only, documented endpoints only: no port
 * scanning of address ranges, no credential guessing.
 */

export interface ScanOptions {
  timeoutMs?: number;
  /** Disable LAN broadcasts; only configured extra hosts and Home Assistant are queried. */
  discovery?: boolean;
  /** Include Home Assistant entities (if HA_URL/HA_TOKEN are set). Default true. */
  includeHomeAssistant?: boolean;
  /** Override GHOST_LAN_EXTRA_HOSTS (testing). */
  extraHosts?: string;
  log?: (m: string) => void;
}

const MAX_UNSUPPORTED = 40;

const FINGERPRINTERS: Record<string, Fingerprinter> = {
  shelly: fingerprintShelly,
  wled: fingerprintWled,
  tasmota: fingerprintTasmota,
  hue: fingerprintHue,
  elgato: fingerprintElgato,
  roku: fingerprintRoku,
  kasa: fingerprintKasa,
};

/**
 * GHOST_LAN_EXTRA_HOSTS="127.0.0.1:8081,wled@127.0.0.1:8082,kasa@127.0.0.1:9999"
 * Probes these hosts directly (simulators / devices mDNS can't see). For testing.
 */
export function parseExtraHosts(raw: string | undefined): { ip: string; port?: number; forced?: string }[] {
  if (!raw) return [];
  const out: { ip: string; port?: number; forced?: string }[] = [];
  for (const part of raw.split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(?:([a-z]+)@)?(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/i);
    if (!m) continue;
    const forced = m[1]?.toLowerCase();
    if (forced && !FINGERPRINTERS[forced]) continue;
    const port = m[3] ? Number(m[3]) : undefined;
    out.push({ ip: m[2].replace(/^\[|\]$/g, ""), port: port && port > 0 && port < 65536 ? port : undefined, forced });
  }
  return out.slice(0, 32);
}

function svcPort(h: HostHint, type: string): number | undefined {
  return h.mdns.find((m) => m.type === type)?.port;
}

/** Which fingerprinters to run for a host, most specific first. */
function plan(h: HostHint): { fp: Fingerprinter; host: HostHint }[] {
  const steps: { fp: Fingerprinter; host: HostHint }[] = [];
  const add = (name: string, port?: number) => steps.push({ fp: FINGERPRINTERS[name], host: port !== undefined ? { ...h, port } : h });
  if (h.forced) {
    add(h.forced);
    return steps;
  }
  if (h.kasa) add("kasa");
  const types = new Set(h.mdns.map((m) => m.type));
  const names = h.mdns.map((m) => m.name).join(" ");
  const ssdpText = h.ssdp.map((s) => `${s.st ?? ""} ${s.server ?? ""} ${s.manufacturer ?? ""} ${s.location ?? ""}`).join(" ");
  if (types.has("shelly") || /shelly/i.test(names)) add("shelly", h.extra ? h.port : svcPort(h, "http"));
  if (types.has("wled")) add("wled", h.extra ? h.port : svcPort(h, "wled"));
  if (types.has("hue") || h.ssdp.some((s) => s.hueBridgeId) || /IpBridge|hue/i.test(ssdpText)) add("hue", h.extra ? h.port : undefined);
  if (types.has("elg")) add("elgato", svcPort(h, "elg"));
  if (/roku/i.test(ssdpText)) {
    const loc = h.ssdp.find((s) => s.location?.includes(`:${ROKU_PORT}`))?.location;
    add("roku", loc ? Number(new URL(loc).port) : ROKU_PORT);
  }
  if (steps.length) return steps;
  // Hosts only seen through "foreign" services (AirPlay, Cast, HomeKit, printers, ...) are
  // classified from their announcements and never probed.
  const probeable = h.extra || types.has("http") || h.ssdp.some((s) => s.location || s.friendlyName);
  if (!probeable) return [];
  // Unknown host: try each documented identification endpoint once.
  const httpPort = h.extra ? h.port : svcPort(h, "http");
  if (h.extra && h.port === 9999) return [{ fp: fingerprintKasa, host: h }];
  if (h.extra && h.port === 9123) return [{ fp: fingerprintElgato, host: h }];
  if (h.extra && h.port === ROKU_PORT) return [{ fp: fingerprintRoku, host: h }];
  for (const n of ["shelly", "wled", "tasmota", "hue"]) add(n, httpPort);
  return steps;
}

async function fingerprintHost(h: HostHint): Promise<AdapterDiscovery[] | null> {
  const steps = plan(h);
  if (!steps.length) return null;
  if (h.forced || h.kasa) {
    for (const s of steps) {
      const r = await s.fp(s.host).catch(() => null);
      if (r?.length) return r;
    }
    return null;
  }
  // Specific hints are sequential (cheap); generic probes run in parallel, first match by order wins.
  const results = await Promise.all(steps.map((s) => s.fp(s.host).catch(() => null)));
  return results.find((r) => r && r.length) ?? null;
}

export async function scan(opts: ScanOptions = {}): Promise<ScanResult> {
  const t0 = Date.now();
  const timeoutMs = Math.max(1000, Math.min(15000, opts.timeoutMs ?? 4000));
  const log = opts.log ?? (() => {});
  const interfaces = lanInterfaces();
  const self = selfAddresses();
  const v4 = interfaces.filter((i) => i.family === "IPv4");
  const errors: string[] = [];
  const sources: Record<string, number> = { mdns: 0, ssdp: 0, kasa: 0, extra: 0, home_assistant: 0 };

  const hosts = new Map<string, HostHint>();
  const jobs = new Map<string, Promise<void>>();
  /** Completed fingerprints (a host missing here at the deadline is classified from its hints). */
  const done = new Map<string, AdapterDiscovery[] | null>();
  const run = limiter(12);

  const schedule = (key: string) => {
    if (jobs.has(key)) return;
    jobs.set(
      key,
      sleep(hosts.get(key)?.extra ? 0 : 500)
        .then(() => run(() => fingerprintHost(hosts.get(key)!)))
        .then(
          (r) => void done.set(key, r),
          (e) => {
            errors.push(`fingerprint ${key}: ${errMsg(e)}`);
            done.set(key, null);
          },
        ),
    );
  };

  const touch = (ip: string, via: string, opts2: { key?: string; port?: number; forced?: string; extra?: boolean } = {}): HostHint | null => {
    if (!opts2.extra && self.has(ip)) return null; // skip this computer
    const key = opts2.key ?? ip;
    let h = hosts.get(key);
    if (!h) {
      h = { key, ip, port: opts2.port, via: new Set(), mdns: [], ssdp: [], forced: opts2.forced, extra: opts2.extra };
      hosts.set(key, h);
    }
    h.via.add(via);
    return h;
  };

  // Explicit extra hosts (simulators / devices on other subnets). Testing aid.
  const extras = parseExtraHosts(opts.extraHosts ?? process.env.GHOST_LAN_EXTRA_HOSTS);
  for (const e of extras) {
    const key = e.port ? `${e.ip}:${e.port}` : e.ip;
    touch(e.ip, "extra-hosts", { key, port: e.port, forced: e.forced, extra: true });
    sources.extra++;
    schedule(key);
  }

  const targets = new Set<string>(["255.255.255.255"]);
  for (const i of v4) {
    const b = broadcastAddr(i.address, i.netmask);
    if (b) targets.add(b);
  }

  const printerJob = discoverPrinters().catch(() => ({ discoveries: [] as AdapterDiscovery[], errors: ["Printer configuration could not be loaded; check GHOST_PRINTERS_CONFIG"] }));

  const haJob =
    opts.includeHomeAssistant !== false && haConfig()
      ? discoverHomeAssistant(log).then((r) => {
          if (r.error) errors.push(r.error);
          sources.home_assistant = r.discoveries.length;
          return r.discoveries;
        })
      : Promise.resolve([] as AdapterDiscovery[]);

  const discovery = opts.discovery === false ? [] : await Promise.all([
    mdnsBrowse(timeoutMs, (hit) => {
      const h = touch(hit.ip, "mdns");
      if (!h) return;
      sources.mdns++;
      if (!h.mdns.some((m) => m.type === hit.type && m.name === hit.name)) h.mdns.push({ type: hit.type, name: hit.name, port: hit.port, host: hit.host, txt: hit.txt });
      schedule(h.key);
    }),
    ssdpSearch(
      v4.filter((i) => i.netmask !== "255.255.255.255"),
      Math.min(timeoutMs, 3000),
      (ip, hit) => {
        const h = touch(ip, "ssdp");
        if (!h) return;
        sources.ssdp++;
        h.ssdp.push(hit);
        schedule(h.key);
      },
    ),
    kasaUdpDiscover([...targets], Math.min(timeoutMs, 2500), (hit) => {
      const h = touch(hit.ip, "kasa-udp");
      if (!h) return;
      sources.kasa++;
      if (hit.sysinfo) h.kasa = hit.sysinfo;
      if (hit.tdp) h.tdp = hit.tdp;
      schedule(h.key);
    }),
  ]);
  for (const errs of discovery) errors.push(...errs);

  // Wait for fingerprints (bounded); late hosts fall back to hint-based classification.
  const keys = [...jobs.keys()];
  const all = await Promise.race([Promise.all(keys.map((k) => jobs.get(k)!)).then(() => true), sleep(3500).then(() => false)]);
  if (!all) errors.push(`${keys.filter((k) => !done.has(k)).length} host(s) did not finish fingerprinting in time`);

  let skippedPersonal = 0;
  const byKey = new Map<string, AdapterDiscovery>();
  const add = (d: AdapterDiscovery) => {
    const prev = byKey.get(d.manifest.local_key);
    if (!prev || (prev.status === "candidate" && d.status !== "candidate")) byKey.set(d.manifest.local_key, d);
  };
  for (const k of keys) {
    const host = hosts.get(k)!;
    const found = done.get(k) ?? null;
    if (found?.length) {
      found.forEach(add);
      continue;
    }
    if (host.tdp && !host.kasa) {
      add(kasaTdpCandidate(host.ip, host.tdp, [...host.via]));
      continue;
    }
    const c = classifyCandidate(host);
    if (c === "personal") skippedPersonal++;
    else if (c) add(c);
  }

  // Dedupe the same physical device seen on two addresses (MAC / serial).
  const seenHw = new Set<string>();
  const lan: AdapterDiscovery[] = [];
  let unsupportedKept = 0;
  for (const d of byKey.values()) {
    // Keep the catalog useful on big networks: at most MAX_UNSUPPORTED "seen but unsupported" entries.
    if ((d.manifest.meta as LanMeta).support === "unsupported" && ++unsupportedKept > MAX_UNSUPPORTED) continue;
    const m = d.manifest.meta as LanMeta;
    const hw = m.mac || m.serial ? `${m.driver}:${m.mac ?? m.serial}:${m.channel ?? m.child_id ?? m.relay ?? m.light_id ?? ""}` : null;
    if (hw && seenHw.has(hw)) continue;
    if (hw) seenHw.add(hw);
    lan.push(d);
  }

  const ha = await Promise.race([haJob, sleep(8000).then(() => [] as AdapterDiscovery[])]);
  const printers = await printerJob;
  errors.push(...printers.errors);
  sources.printers = printers.discoveries.length;
  const discoveries = [...lan, ...ha, ...printers.discoveries];
  const verified = discoveries.filter((d) => d.status !== "candidate").length;
  let note: string | undefined;
  if (!v4.some((i) => isPrivateLanV4(i.address))) {
    note =
      "This computer has no private IPv4 LAN address (e.g. an IPv6-only phone hotspot or a VPN-only link), so most local devices can't be reached.";
  } else if (!lan.length) {
    note = skippedPersonal
      ? `Only computers/phones answered (${skippedPersonal}, not published — personal devices are never listed). No smart-home devices here; venue Wi-Fi often isolates clients — try a phone hotspot or your home network.`
      : "No devices answered on this network. Venue Wi-Fi often isolates clients — try a phone hotspot or your home network.";
  } else if (skippedPersonal) {
    note = `Ignored ${skippedPersonal} computer(s)/phone(s) — personal devices are never published.`;
  }
  log(`lan scan: ${discoveries.length} devices (${verified} controllable) in ${Date.now() - t0} ms`);
  return {
    started_at: new Date(t0).toISOString(),
    duration_ms: Date.now() - t0,
    found: discoveries.length,
    verified,
    candidates: discoveries.length - verified,
    skipped_personal: skippedPersonal,
    interfaces,
    sources,
    errors: [...new Set(errors)].slice(0, 10),
    note,
    discoveries,
  };
}
