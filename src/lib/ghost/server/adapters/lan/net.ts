import os from "node:os";
import type { LanInterface } from "./types";

export const DEFAULT_HTTP_TIMEOUT = 1500;

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function hostUrl(ip: string, port?: number, path = "/"): string {
  const h = ip.includes(":") && !ip.startsWith("[") ? `[${ip}]` : ip;
  const p = port && port !== 80 ? `:${port}` : "";
  return `http://${h}${p}${path.startsWith("/") ? path : "/" + path}`;
}

function combineSignals(timeoutMs: number, outer?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  return outer ? AbortSignal.any([t, outer]) : t;
}

export interface FetchOpts {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** fetch with timeout; returns the raw Response (throws on network error / timeout). */
export async function httpRaw(url: string, o: FetchOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  let body: string | undefined;
  if (o.body !== undefined) {
    body = typeof o.body === "string" ? o.body : JSON.stringify(o.body);
    if (typeof o.body !== "string" && !headers["content-type"]) headers["content-type"] = "application/json";
  }
  return fetch(url, {
    method: o.method ?? (body !== undefined ? "POST" : "GET"),
    headers,
    body,
    signal: combineSignals(o.timeoutMs ?? DEFAULT_HTTP_TIMEOUT, o.signal),
    redirect: "manual",
    cache: "no-store",
  });
}

const MAX_BODY = 2_000_000;

export async function httpText(url: string, o: FetchOpts = {}): Promise<string> {
  const r = await httpRaw(url, o);
  const text = await r.text();
  if (!r.ok) throw new HttpError(r.status, `HTTP ${r.status} from ${redactUrl(url)}${text ? `: ${text.slice(0, 160)}` : ""}`);
  return text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text;
}

export async function httpJson<T = unknown>(url: string, o: FetchOpts = {}): Promise<T> {
  const text = await httpText(url, o);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Non-JSON reply from ${redactUrl(url)}`);
  }
}

/** Hide Hue usernames / tokens embedded in URLs from error messages. */
export function redactUrl(url: string): string {
  return url.replace(/\/api\/[A-Za-z0-9_-]{16,}/, "/api/<redacted>");
}

/** Like httpJson, but returns null on any failure (fingerprinting). */
export async function tryJson<T = unknown>(url: string, o: FetchOpts = {}): Promise<T | null> {
  try {
    return await httpJson<T>(url, o);
  } catch {
    return null;
  }
}

export async function tryText(url: string, o: FetchOpts = {}): Promise<string | null> {
  try {
    return await httpText(url, o);
  } catch {
    return null;
  }
}

/** Bounded concurrency: run fn over items with at most `n` in flight. */
export function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= n) await new Promise<void>((res) => queue.push(res));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, sleep(ms).then(() => fallback)]);
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "TimeoutError" || e.name === "AbortError") return "timed out";
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code) return `${e.message} (${cause.code})`;
    return e.message;
  }
  return String(e);
}

/** Non-internal IPv4 interfaces of this machine (plus global IPv6 for the summary). */
export function lanInterfaces(): LanInterface[] {
  const out: LanInterface[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.internal) continue;
      if (a.family === "IPv6" && (a.address.startsWith("fe80") || a.scopeid)) continue;
      out.push({
        name,
        address: a.address,
        netmask: a.netmask,
        cidr: a.cidr ?? null,
        family: a.family === "IPv4" ? "IPv4" : "IPv6",
        mac: a.mac && a.mac !== "00:00:00:00:00:00" ? a.mac : undefined,
      });
    }
  }
  return out;
}

/** True for RFC1918 / link-local / CGNAT-less "private LAN" IPv4 addresses. */
export function isPrivateLanV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n))) return false;
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254);
}

/** Directed broadcast address for an IPv4 interface. */
export function broadcastAddr(address: string, netmask: string): string | null {
  const a = address.split(".").map(Number);
  const m = netmask.split(".").map(Number);
  if (a.length !== 4 || m.length !== 4) return null;
  if (m.every((x) => x === 255)) return null; // /32 point-to-point (e.g. CLAT on IPv6-only hotspots)
  return a.map((x, i) => (x & m[i]) | (~m[i] & 255)).join(".");
}

export function selfAddresses(): Set<string> {
  const s = new Set<string>();
  for (const addrs of Object.values(os.networkInterfaces())) for (const a of addrs ?? []) s.add(a.address);
  return s;
}

export function normMac(mac: unknown): string | undefined {
  if (typeof mac !== "string") return undefined;
  const hex = mac.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (hex.length !== 12) return undefined;
  return hex.match(/../g)!.join(":");
}

/** Very small XML helpers (SSDP descriptions, Roku ECP). */
export function xmlTag(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? decodeXml(m[1].trim()) : undefined;
}

export function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function nowIso(): string {
  return new Date().toISOString();
}
