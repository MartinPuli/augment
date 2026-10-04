/**
 * GHOST v0.1 browser-side API client.
 *
 * Typed fetch wrappers for the coordinator's HTTP API (/api/v1/*), the SSE event stream and a few
 * URL / formatting helpers. Browser-only at call time (uses fetch, EventSource, location), but safe
 * to import from client components: nothing here touches the DOM at module load.
 */
import type {
  AcceptRequest,
  CapabilityHit,
  Device,
  Experience,
  GhostEvent,
  InvokeRequest,
  InvokeResponse,
  Lease,
  MeResponse,
  Observation,
  PairingResponse,
  QuoteRequest,
  QuoteResponse,
  SearchQuery,
} from "../contracts";
import type {
  AcceptResponse,
  ConnectorInfo,
  DevicesResponseItem,
  ExperienceSearchResponse,
  LedgerResponse,
  LeaseView,
  PairingInfo,
  RecordExperienceRequest,
  TermsPatch,
} from "./api-types";

export const API_BASE = "/api/v1";

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class GhostApiError extends Error {
  /** HTTP status. 0 = the request never reached the coordinator (network error / server down). */
  readonly status: number;
  /** Parsed response body (or the underlying network error), when available. */
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "GhostApiError";
    this.status = status;
    this.body = body;
  }

  /** True when the coordinator could not be reached at all. */
  get unreachable(): boolean {
    return this.status === 0;
  }
}

export function isGhostApiError(e: unknown): e is GhostApiError {
  return e instanceof GhostApiError;
}

/* ------------------------------------------------------------------ */
/* Core fetch                                                          */
/* ------------------------------------------------------------------ */

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue>;

/** Serialize query params: skips undefined/null/""/false, encodes `true` as "1". */
export function toQueryString(params: QueryParams | undefined): string {
  if (!params) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    sp.set(k, v === true ? "1" : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export interface GhostFetchInit extends Omit<RequestInit, "body"> {
  /** JSON-serialized when present. */
  body?: unknown;
  query?: QueryParams;
}

function resolveUrl(path: string): string {
  if (/^https?:\/\//i.test(path) || path.startsWith(`${API_BASE}/`) || path === API_BASE) return path;
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Same-origin JSON fetch against the coordinator.
 * `path` is relative to /api/v1 (e.g. "/me"); absolute /api/v1/... paths are used as-is.
 * Throws GhostApiError on non-2xx (message from `{ error }` or statusText) and on network failure (status 0).
 */
export async function ghostFetch<T>(path: string, init: GhostFetchInit = {}): Promise<T> {
  const { body, query, headers, ...rest } = init;
  const url = `${resolveUrl(path)}${toQueryString(query)}`;
  const h = new Headers(headers);
  if (!h.has("accept")) h.set("accept", "application/json");
  let payload: string | undefined;
  if (body !== undefined) {
    h.set("content-type", "application/json");
    payload = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      credentials: "include",
      cache: "no-store",
      ...rest,
      headers: h,
      body: payload,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new GhostApiError(0, "Coordinator unreachable", err);
  }

  const text = res.status === 204 ? "" : await res.text().catch(() => "");
  let data: unknown = undefined;
  let parsed = false;
  if (text) {
    try {
      data = JSON.parse(text);
      parsed = true;
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const serverMsg =
      parsed && data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : "";
    throw new GhostApiError(res.status, serverMsg || res.statusText || `HTTP ${res.status}`, data);
  }
  if (text && !parsed) {
    throw new GhostApiError(res.status, "Coordinator returned a non-JSON response", data);
  }
  return data as T;
}

const enc = encodeURIComponent;

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

/** Current principal. Also sets the principal cookie on first call. */
export function getMe(): Promise<MeResponse> {
  return ghostFetch<MeResponse>("/me");
}

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

export function searchCapabilities(q: SearchQuery = {}): Promise<CapabilityHit[]> {
  return ghostFetch<CapabilityHit[]>("/capabilities", {
    query: {
      q: q.q,
      semantic_type: q.semantic_type,
      device_class: q.device_class,
      access_type: q.access_type,
      zone_id: q.zone_id,
      near: q.near ? `${q.near.lat},${q.near.lon}` : undefined,
      radius_km: q.near?.radius_km,
      only_online: q.only_online ? "1" : undefined,
      limit: q.limit,
    },
  });
}

export function listDevices(opts: { mine?: boolean } = {}): Promise<DevicesResponseItem[]> {
  return ghostFetch<DevicesResponseItem[]>("/devices", { query: { mine: opts.mine ? "1" : undefined } });
}

export function getDevice(id: string): Promise<Device> {
  return ghostFetch<Device>(`/devices/${enc(id)}`);
}

/**
 * Terms patch. `null` for `quota` / `floor_cents` / `note` means "clear it"
 * (quota → unlimited, floor → defaults to price).
 */
export type TermsPatchInput = { [K in keyof TermsPatch]?: TermsPatch[K] | null };

export function updateTerms(id: string, patch: TermsPatch | TermsPatchInput): Promise<Device> {
  return ghostFetch<Device>(`/devices/${enc(id)}/terms`, { method: "PATCH", body: patch });
}

/* ------------------------------------------------------------------ */
/* Offers and leases                                                   */
/* ------------------------------------------------------------------ */

export function requestQuote(req: QuoteRequest): Promise<QuoteResponse> {
  return ghostFetch<QuoteResponse>("/quotes", { method: "POST", body: req });
}

export function acceptQuote(offer_id: string, max_spend_cents: number): Promise<AcceptResponse> {
  const body: AcceptRequest = { offer_id, max_spend_cents };
  return ghostFetch<AcceptResponse>(`/quotes/${enc(offer_id)}/accept`, { method: "POST", body });
}

export function listLeases(opts: { role?: "visitor" | "owner"; active?: boolean } = {}): Promise<LeaseView[]> {
  return ghostFetch<LeaseView[]>("/leases", {
    query: { role: opts.role, active: opts.active ? "1" : undefined },
  });
}

export function getLease(id: string): Promise<LeaseView> {
  return ghostFetch<LeaseView>(`/leases/${enc(id)}`);
}

/** Visitor ends their own lease early. */
export function releaseLease(id: string): Promise<{ lease: Lease }> {
  return ghostFetch<{ lease: Lease }>(`/leases/${enc(id)}/release`, { method: "POST" });
}

/** Owner "Stop access". */
export function revokeLease(id: string): Promise<{ lease: Lease }> {
  return ghostFetch<{ lease: Lease }>(`/leases/${enc(id)}/revoke`, { method: "POST" });
}

/** Owner approves a lease on a device with `requires_approval`. */
export function approveLease(id: string): Promise<{ lease: Lease }> {
  return ghostFetch<{ lease: Lease }>(`/leases/${enc(id)}/approve`, { method: "POST" });
}

/* ------------------------------------------------------------------ */
/* Invocations and observations                                        */
/* ------------------------------------------------------------------ */

export function invoke(req: InvokeRequest): Promise<InvokeResponse> {
  return ghostFetch<InvokeResponse>("/invoke", { method: "POST", body: req });
}

export function getInvocation(id: string): Promise<InvokeResponse> {
  return ghostFetch<InvokeResponse>(`/invocations/${enc(id)}`);
}

export function getObservation(id: string): Promise<Observation> {
  return ghostFetch<Observation>(`/observations/${enc(id)}`);
}

/** Same-origin URL of an observation's media (usable directly in <img src>). */
export function observationMediaUrl(id: string): string {
  return `${API_BASE}/observations/${enc(id)}/media`;
}

/* ------------------------------------------------------------------ */
/* Pairing and connectors                                              */
/* ------------------------------------------------------------------ */

export function createPairing(): Promise<PairingResponse> {
  return ghostFetch<PairingResponse>("/pairings", { method: "POST" });
}

export function listPairings(opts: { pending?: boolean } = {}): Promise<PairingInfo[]> {
  return ghostFetch<PairingInfo[]>("/pairings", { query: { pending: opts.pending ? "1" : undefined } });
}

export function confirmPairing(id: string): Promise<{ pairing: PairingInfo }> {
  return ghostFetch<{ pairing: PairingInfo }>(`/pairings/${enc(id)}/confirm`, { method: "POST" });
}

export function rejectPairing(id: string): Promise<{ pairing: PairingInfo }> {
  return ghostFetch<{ pairing: PairingInfo }>(`/pairings/${enc(id)}/reject`, { method: "POST" });
}

export function listConnectors(): Promise<ConnectorInfo[]> {
  return ghostFetch<ConnectorInfo[]>("/connectors");
}

/* ------------------------------------------------------------------ */
/* Experience memory                                                   */
/* ------------------------------------------------------------------ */

export function recordExperience(req: RecordExperienceRequest): Promise<Experience> {
  return ghostFetch<Experience>("/experiences", { method: "POST", body: req });
}

export function recallExperience(q?: string, limit?: number): Promise<ExperienceSearchResponse> {
  return ghostFetch<ExperienceSearchResponse>("/experiences", { query: { q, limit } });
}

/* ------------------------------------------------------------------ */
/* Ledger                                                              */
/* ------------------------------------------------------------------ */

export function getLedger(): Promise<LedgerResponse> {
  return ghostFetch<LedgerResponse>("/ledger");
}

/* ------------------------------------------------------------------ */
/* Event stream (SSE)                                                  */
/* ------------------------------------------------------------------ */

export type EventStreamStatus = "open" | "reconnecting";

/**
 * Subscribe to the coordinator event stream (GET /api/v1/events).
 * Reconnects with exponential backoff (1s → 10s) by closing and recreating the EventSource.
 * Returns an unsubscribe function. No-op outside the browser.
 */
export function subscribeEvents(
  onEvent: (e: GhostEvent) => void,
  opts: { onStatus?: (s: EventStreamStatus) => void } = {},
): () => void {
  if (typeof window === "undefined" || typeof EventSource === "undefined") return () => {};

  const MIN_DELAY = 1000;
  const MAX_DELAY = 10_000;
  let es: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = MIN_DELAY;
  let closed = false;

  const connect = () => {
    timer = null;
    if (closed) return;
    const source = new EventSource(`${API_BASE}/events`, { withCredentials: true });
    es = source;

    source.onopen = () => {
      delay = MIN_DELAY;
      opts.onStatus?.("open");
    };

    source.onmessage = (m: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(m.data);
      } catch {
        return; // keep-alives / malformed frames
      }
      if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") return;
      try {
        onEvent(parsed as GhostEvent);
      } catch (err) {
        console.error("[ghost] event handler failed", err);
      }
    };

    source.onerror = () => {
      if (closed || es !== source) return;
      source.close();
      es = null;
      opts.onStatus?.("reconnecting");
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, MAX_DELAY);
    };
  };

  connect();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    es?.close();
    es = null;
  };
}

/* ------------------------------------------------------------------ */
/* URL and formatting helpers                                          */
/* ------------------------------------------------------------------ */

/** WebSocket URL of the device channel on this origin. */
export function deviceChannelUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/v1/device-channel`;
}

/** Turn a relative join path into an absolute URL using the public origin (for QR codes / sharing). */
export function absoluteJoinUrl(join_path: string): string {
  if (/^https?:\/\//i.test(join_path)) return join_path;
  const origin = (process.env.NEXT_PUBLIC_PUBLIC_ORIGIN || location.origin).replace(/\/+$/, "");
  return `${origin}${join_path.startsWith("/") ? join_path : `/${join_path}`}`;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** 125 → "$1.25", -50 → "-$0.50". */
export function formatCents(cents: number): string {
  if (!Number.isFinite(cents)) return "$—";
  return usd.format(Math.round(cents) / 100);
}

/* ------------------------------------------------------------------ */
/* Grouped export                                                      */
/* ------------------------------------------------------------------ */

export const api = {
  fetch: ghostFetch,
  getMe,
  searchCapabilities,
  listDevices,
  getDevice,
  updateTerms,
  requestQuote,
  acceptQuote,
  listLeases,
  getLease,
  releaseLease,
  revokeLease,
  approveLease,
  invoke,
  getInvocation,
  getObservation,
  observationMediaUrl,
  createPairing,
  listPairings,
  confirmPairing,
  rejectPairing,
  listConnectors,
  recordExperience,
  recallExperience,
  getLedger,
  subscribeEvents,
  deviceChannelUrl,
  absoluteJoinUrl,
  formatCents,
} as const;

export type GhostApi = typeof api;
