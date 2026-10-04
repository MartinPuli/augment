/**
 * Small helpers shared by connector drivers: manifests, argument validation, abortable waits.
 * Browser-safe and Node-safe (no DOM access at import time).
 */
import { PROTOCOL_VERSION, type DeviceManifest, type Terms } from "@/lib/ghost/contracts";
import { InvokeError } from "./types";

export const DEFAULT_TERMS: Terms = {
  price_cents: 0,
  currency: "USD",
  max_duration_s: 900,
};

export function makeManifest(
  m: Omit<DeviceManifest, "protocol_version" | "access_type" | "terms"> &
    Partial<Pick<DeviceManifest, "access_type" | "terms">>,
): DeviceManifest {
  return {
    protocol_version: PROTOCOL_VERSION,
    access_type: "own_device",
    terms: { ...DEFAULT_TERMS },
    ...m,
  };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Read a bounded number argument. Missing → default. Wrong type → rejected. Out of range → clamped. */
export function numArg(
  args: Record<string, unknown>,
  key: string,
  opts: { min: number; max: number; def: number },
): number {
  const v = args[key];
  if (v === undefined || v === null) return opts.def;
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new InvokeError(`argument "${key}" must be a number`, "rejected");
  }
  return Math.min(opts.max, Math.max(opts.min, n));
}

export function strArg(
  args: Record<string, unknown>,
  key: string,
  opts: { maxLen: number; def?: string; required?: boolean },
): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    if (opts.required) throw new InvokeError(`argument "${key}" is required`, "rejected");
    return opts.def;
  }
  if (typeof v !== "string") throw new InvokeError(`argument "${key}" must be a string`, "rejected");
  if (v.length > opts.maxLen) throw new InvokeError(`argument "${key}" is longer than ${opts.maxLen} characters`, "rejected");
  return v;
}

export function boolArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  if (v === "true" || v === 1 || v === "on") return true;
  if (v === "false" || v === 0 || v === "off") return false;
  throw new InvokeError(`argument "${key}" must be a boolean`, "rejected");
}

export function enumArg<T extends string>(args: Record<string, unknown>, key: string, values: readonly T[]): T | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !values.includes(v as T)) {
    throw new InvokeError(`argument "${key}" must be one of ${values.join(", ")}`, "rejected");
  }
  return v as T;
}

/** "#rrggbb" | "rrggbb" | "#rgb" | css-ish names (a few) → [r,g,b] */
export function parseColor(input: unknown): [number, number, number] {
  if (typeof input !== "string") throw new InvokeError(`color must be a "#rrggbb" string`, "rejected");
  const named: Record<string, string> = {
    red: "#ff0000",
    green: "#00ff00",
    blue: "#0000ff",
    white: "#ffffff",
    warm: "#ffb36b",
    warmwhite: "#ffb36b",
    yellow: "#ffd400",
    orange: "#ff7a00",
    purple: "#8a2be2",
    violet: "#a99bff",
    pink: "#ff4fa3",
    cyan: "#00e5ff",
    mint: "#5df2b5",
    off: "#000000",
    black: "#000000",
  };
  let s = input.trim().toLowerCase().replace(/\s+/g, "");
  if (named[s]) s = named[s];
  if (s.startsWith("#")) s = s.slice(1);
  if (/^[0-9a-f]{3}$/.test(s)) s = s.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/.test(s)) throw new InvokeError(`color must be "#rrggbb" (got ${JSON.stringify(input)})`, "rejected");
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

export function toHex(rgb: [number, number, number]): string {
  return "#" + rgb.map((n) => Math.round(n).toString(16).padStart(2, "0")).join("");
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortReason(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function abortReason(signal: AbortSignal): Error {
  const r = signal.reason;
  if (r instanceof Error) return r;
  return new InvokeError(typeof r === "string" ? r : "aborted", "failed");
}

/** Race a promise against an abort signal. */
export function withAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new InvokeError(message, "failed")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "device"
  );
}

export function hasWindow(): boolean {
  return typeof window !== "undefined";
}

export function safeStorage(): import("./types").KV | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const k = "__ghost_probe";
    localStorage.setItem(k, "1");
    localStorage.removeItem(k);
    return localStorage;
  } catch {
    return null;
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
