/**
 * Tiny coordinator HTTP helpers used by the connector UI (pairing, /me, SSE events).
 * Kept local to the connector package so it does not depend on the in-progress typed client.
 */
import type { GhostEvent, MeResponse, PairingResponse } from "@/lib/ghost/contracts";

/** Origin of the coordinator HTTP API. Same origin unless NEXT_PUBLIC_GHOST_API_ORIGIN is set. */
export function apiOrigin(): string {
  const env = process.env.NEXT_PUBLIC_GHOST_API_ORIGIN;
  if (env) return env.replace(/\/+$/, "");
  if (typeof location !== "undefined") return location.origin;
  return "http://localhost:3000";
}

/** ws(s)://<host>/v1/device-channel (override with NEXT_PUBLIC_GHOST_WS_URL). */
export function deviceChannelUrl(): string {
  const env = process.env.NEXT_PUBLIC_GHOST_WS_URL;
  if (env) return env;
  const origin = apiOrigin();
  return origin.replace(/^http/, "ws") + "/v1/device-channel";
}

/** Origin a phone can reach (Fly.io / tunnel URL), used for QR codes. */
export function publicOrigin(): string {
  const env = process.env.NEXT_PUBLIC_PUBLIC_ORIGIN;
  if (env) return env.replace(/\/+$/, "");
  if (typeof location !== "undefined") return location.origin;
  return "";
}

export function absoluteJoinUrl(join_path: string): string {
  if (/^https?:\/\//.test(join_path)) return join_path;
  return publicOrigin() + (join_path.startsWith("/") ? join_path : `/${join_path}`);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiOrigin() + path, {
    credentials: "include",
    ...init,
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = (await res.json()) as { error?: string; message?: string };
      msg = j.error || j.message || msg;
    } catch {}
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const getMe = () => api<MeResponse>("/api/v1/me");
export const createPairing = () => api<PairingResponse>("/api/v1/pairings", { method: "POST", body: "{}" });
export const confirmPairing = (id: string) =>
  api<unknown>(`/api/v1/pairings/${encodeURIComponent(id)}/confirm`, { method: "POST", body: "{}" });
export const rejectPairing = (id: string) =>
  api<unknown>(`/api/v1/pairings/${encodeURIComponent(id)}/reject`, { method: "POST", body: "{}" });

const EVENT_NAMES: GhostEvent["type"][] = [
  "device.published",
  "device.updated",
  "device.removed",
  "pairing.pending",
  "pairing.confirmed",
  "lease.updated",
  "offer.updated",
  "invocation.updated",
  "observation.created",
  "ledger.updated",
  "log",
];

/**
 * Subscribe to the coordinator SSE stream. Accepts both unnamed `data: {"type":...}` events and
 * named events (`event: pairing.pending`). EventSource reconnects by itself.
 */
export function subscribeEvents(fn: (e: GhostEvent) => void): () => void {
  if (typeof EventSource === "undefined") return () => {};
  const es = new EventSource(apiOrigin() + "/api/v1/events", { withCredentials: true });
  const seen = new WeakSet<MessageEvent>();
  const handle = (name: string | null) => (ev: MessageEvent) => {
    if (seen.has(ev)) return;
    seen.add(ev);
    try {
      const parsed = JSON.parse(ev.data) as Record<string, unknown>;
      const evt = (typeof parsed.type === "string" ? parsed : { type: name ?? "log", ...parsed }) as GhostEvent;
      fn(evt);
    } catch {
      /* heartbeat comments / non-JSON */
    }
  };
  es.onmessage = handle(null);
  const named = EVENT_NAMES.map((n) => [n, handle(n)] as const);
  for (const [n, h] of named) es.addEventListener(n, h as EventListener);
  return () => {
    for (const [n, h] of named) es.removeEventListener(n, h as EventListener);
    es.close();
  };
}

export function isSecureContextOk(): boolean {
  if (typeof window === "undefined") return true;
  return window.isSecureContext;
}
