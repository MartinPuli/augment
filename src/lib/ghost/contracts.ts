/**
 * GHOST protocol v0.1 — shared contracts.
 *
 * This file is imported by the browser, the coordinator (server) and connectors.
 * It must stay free of Node-only or browser-only imports.
 *
 * Vocabulary
 * - Device: something physical (or a public source) reachable through a connector or adapter.
 * - Capability: one bounded thing a device can do (observe, measure, act, stream).
 * - Connector: a process that talks to the real interface (phone browser, Pi service,
 *   desktop browser holding a BLE/serial device, LAN gateway) and connects OUTBOUND to the
 *   coordinator over the device channel (WebSocket).
 * - Internal adapter: a server-side connector that runs inside the coordinator
 *   (public HTTP sources like Caltrans/NOAA, LAN devices like Shelly/WLED/Hue).
 * - Offer -> Lease -> Invocation -> Observation -> Experience: the access lifecycle.
 */

export const PROTOCOL_VERSION = "ghost/0.1" as const;

/* ------------------------------------------------------------------ */
/* Primitive enums                                                     */
/* ------------------------------------------------------------------ */

export type AccessType =
  | "public_observation" // read operator-published data; no lease, zero price
  | "own_device" // the visitor's own principal owns it; zero price, lease still used for exclusivity
  | "owner_shared" // another owner grants temporary use within terms
  | "provider_booked"; // an external provider schedules time on hardware

export type CatalogStatus = "candidate" | "configured" | "verified" | "unavailable";

export type Transport =
  | "browser" // getUserMedia, speech, vibration, screen... in a web page
  | "bluetooth" // Web Bluetooth (BLE GATT)
  | "serial" // Web Serial (USB-serial: Arduino, ESP32, micro:bit)
  | "usb" // WebUSB / WebHID
  | "wifi-lan" // devices on the local network (HTTP/UDP/TCP/mDNS/SSDP)
  | "http-public" // documented public operator APIs
  | "gpio" // Raspberry Pi GPIO via a local service
  | "mqtt"
  | "webrtc"
  | "other";

export type DeviceClass =
  | "phone"
  | "computer"
  | "camera"
  | "microphone"
  | "light"
  | "plug"
  | "switch"
  | "sensor"
  | "actuator"
  | "speaker"
  | "display"
  | "robot"
  | "printer"
  | "instrument"
  | "wearable"
  | "media"
  | "hub"
  | "other";

/** observe = read state/image, measure = numeric reading, act = change the world, stream = live media */
export type InteractionKind = "observe" | "measure" | "act" | "stream";

export type VerificationMethod =
  | "observation" // a fresh observation is the evidence (photo, reading)
  | "reported_state" // device reports resulting state (e.g. relay is on)
  | "acknowledgment" // device only acknowledges the command; outcome not verified
  | "none";

export type InvocationState =
  | "accepted"
  | "running"
  | "succeeded"
  | "failed"
  | "rejected"
  | "unknown";

export type LeaseState =
  | "offer"
  | "reserved"
  | "payment_pending"
  | "active"
  | "released"
  | "expired"
  | "revoked"
  | "failed";

/** Minimal JSON-schema type (enough for tool input schemas). */
export type JSONSchema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
  additionalProperties?: boolean | JSONSchema;
  [k: string]: unknown;
};

/* ------------------------------------------------------------------ */
/* Manifests (what connectors publish)                                 */
/* ------------------------------------------------------------------ */

export interface CapabilitySpec {
  /** Unique within the device, dotted. e.g. "camera.snapshot", "light.set", "cover.open" */
  capability_id: string;
  kind: InteractionKind;
  /** Semantic type used for search and comparison, e.g. "image.observe", "light.set", "water_level.read" */
  semantic_type: string;
  title: string;
  description: string;
  input_schema: JSONSchema;
  output?: {
    media?: string; // MIME of produced media, e.g. "image/jpeg"
    unit?: string; // e.g. "m", "°C", "dB"
    datum?: string; // reference datum, e.g. "MLLW"
    schema?: JSONSchema;
  };
  limits?: {
    max_operations_per_lease?: number;
    rate_per_min?: number;
    max_payload_bytes?: number;
  };
  /** Free-form prerequisites, e.g. ["fixture_clear"] */
  requires?: string[];
  /** Verified configuration: this action changes what another device can observe. */
  affects_view_of?: string;
  verification: VerificationMethod;
  /** Capabilities in the same group are mutually exclusive across leases. Default: device-wide. */
  concurrency_group?: string;
  /** If false, multiple visitors may use it concurrently (e.g. public reads). Default true for act/stream. */
  exclusive?: boolean;
  /** Typical duration in ms (for UI progress). */
  estimated_ms?: number;
}

export interface Terms {
  /** Integer minor units (cents). 0 = free. */
  price_cents: number;
  currency: "USD";
  /** Maximum lease duration in seconds. */
  max_duration_s: number;
  /** Max invocations per lease (all capabilities). Undefined = unlimited. */
  quota?: number;
  /** Lowest price the host agent will accept in negotiation. Defaults to price_cents. */
  floor_cents?: number;
  /** If true, the owner must approve each lease (owner console prompt). */
  requires_approval?: boolean;
  /** Human-readable terms text (versioned with the offer). */
  note?: string;
}

export interface GeoPoint {
  lat: number;
  lon: number;
  label?: string;
}

export interface DeviceManifest {
  protocol_version: typeof PROTOCOL_VERSION;
  /** Stable key chosen by the connector, unique per connector. Server maps it to a device_id. */
  local_key: string;
  name: string;
  device_class: DeviceClass;
  transport: Transport;
  vendor?: string;
  model?: string;
  /** Physical zone identifier, e.g. "workshop-demo-table", "living-room". */
  zone_id?: string;
  location?: GeoPoint;
  access_type: AccessType;
  terms: Terms;
  capabilities: CapabilitySpec[];
  /** Provenance for public sources: operator, URL, attribution, usage conditions. */
  source?: { operator: string; url?: string; attribution?: string; conditions_url?: string };
  /** Icon hint for the UI (lucide icon name or emoji). */
  icon?: string;
  meta?: Record<string, unknown>;
}

/** A device as stored in the coordinator catalog. */
export interface Device extends DeviceManifest {
  device_id: string;
  owner_id: string;
  /** Connector id, or "internal:<adapter_id>" for in-process adapters. */
  connector_id: string;
  status: CatalogStatus;
  online: boolean;
  last_heartbeat: string | null;
  created_at: string;
  updated_at: string;
}

/** Search result row. */
export interface CapabilityHit {
  device: Pick<
    Device,
    | "device_id"
    | "name"
    | "device_class"
    | "transport"
    | "zone_id"
    | "location"
    | "access_type"
    | "status"
    | "online"
    | "owner_id"
    | "source"
    | "icon"
    | "vendor"
    | "model"
  >;
  capability: CapabilitySpec;
  terms: Terms;
  /** Combined ref used by tools: "<device_id>/<capability_id>" */
  ref: string;
  /** Distance in km when searched with `near`. */
  distance_km?: number;
  /** Relevant remembered experiences (count of successes / attempts). */
  experience?: { successes: number; attempts: number };
}

/* ------------------------------------------------------------------ */
/* Access lifecycle                                                    */
/* ------------------------------------------------------------------ */

export interface CapabilityRef {
  device_id: string;
  capability_id: string;
}

export interface Offer {
  offer_id: string;
  visitor_id: string;
  owner_id: string;
  refs: CapabilityRef[];
  price_cents: number;
  currency: "USD";
  duration_s: number;
  quota?: number;
  terms_version: string;
  expires_at: string; // offer expiry
  /** Negotiation trail. */
  round: number; // 0 = initial quote, max 2 counteroffers
  status: "open" | "accepted" | "rejected" | "expired" | "countered";
  host_message?: string; // what the host agent said
  created_at: string;
}

export interface PaymentReceipt {
  receipt_id: string;
  provider: "dev-ledger" | "stripe-test" | "none";
  /** Explicit label shown in the UI. Never present the dev ledger as a real transaction. */
  label: string;
  amount_cents: number;
  currency: "USD";
  status: "succeeded" | "failed" | "refund_pending" | "refunded" | "compensation_recorded";
  external_ref?: string;
  created_at: string;
}

export interface Lease {
  lease_id: string;
  offer_id: string | null;
  visitor_id: string;
  owner_id: string;
  refs: CapabilityRef[];
  state: LeaseState;
  revision: number;
  starts_at: string | null;
  ends_at: string | null;
  quota: number | null;
  used: number;
  price_cents: number;
  payment?: PaymentReceipt | null;
  reason?: string; // why it ended / failed
  created_at: string;
  updated_at: string;
}

export interface Invocation {
  invocation_id: string;
  lease_id: string | null;
  visitor_id: string;
  device_id: string;
  capability_id: string;
  arguments: Record<string, unknown>;
  state: InvocationState;
  error?: string;
  observation_id?: string | null;
  created_at: string;
  updated_at: string;
  deadline: string;
}

export type ObservationKind = "image" | "value" | "state" | "audio" | "text" | "ack" | "stream";

export interface Observation {
  observation_id: string;
  invocation_id: string | null;
  device_id: string;
  capability_id: string;
  kind: ObservationKind;
  /** When the physical world was captured. null if unknown (never substitute retrieval time). */
  captured_at: string | null;
  retrieved_at: string;
  /** For media: a coordinator URL, e.g. /api/v1/observations/<id>/media */
  media_url?: string;
  media_type?: string;
  /** For live streams: a URL the browser can play (HLS proxied through the coordinator, etc.). */
  stream?: LiveSource;
  value?: number | string | boolean | null;
  unit?: string;
  data?: Record<string, unknown>;
  zone_id?: string;
  source?: { name: string; url?: string; attribution?: string };
  /** Freshness / honesty notes, e.g. "operator's latest published image; not triggered by us". */
  note?: string;
  cached?: boolean;
}

export interface Experience {
  experience_id: string;
  visitor_id: string;
  goal: string;
  refs: CapabilityRef[];
  zone_id?: string;
  outcome: "verified" | "unverified" | "failed";
  cost_cents: number;
  latency_ms?: number;
  failures?: string[];
  evidence: string[]; // observation ids
  summary: string;
  created_at: string;
}

/* ------------------------------------------------------------------ */
/* Live media sources (rendered by the canvas / vision tracker)        */
/* ------------------------------------------------------------------ */

export type LiveSource =
  | { kind: "hls"; url: string; title?: string } // already proxied if needed (CORS-safe)
  | { kind: "mjpeg"; url: string; title?: string }
  | { kind: "image_poll"; url: string; interval_ms: number; title?: string }
  | { kind: "webrtc"; device_id: string; title?: string } // phone camera live via coordinator signaling
  | { kind: "local_camera"; title?: string; facing?: "user" | "environment" }; // this browser's webcam

/* ------------------------------------------------------------------ */
/* Device channel (WebSocket at /v1/device-channel)                    */
/* ------------------------------------------------------------------ */

export type ConnectorKind =
  | "desktop-browser"
  | "phone-browser"
  | "raspberry-pi"
  | "lan-gateway"
  | "serial-bridge"
  | "other";

/** connector -> coordinator */
export type ConnectorMessage =
  | {
      type: "hello";
      protocol_version: typeof PROTOCOL_VERSION;
      connector_kind: ConnectorKind;
      label: string;
      /** Reconnect credential issued earlier by the coordinator. */
      credential?: string;
      /** One-use pairing code from a QR/join link (requires owner confirmation). */
      pairing_code?: string;
      /** Owner session token: the owner's own browser connecting its own hardware (auto-confirmed). */
      owner_token?: string;
      /** Connector-generated nonce for pairing. */
      nonce?: string;
    }
  | { type: "publish"; devices: DeviceManifest[] }
  | { type: "unpublish"; local_keys: string[] }
  | { type: "device_status"; local_key: string; online: boolean; detail?: string }
  | { type: "heartbeat"; at: string }
  | {
      type: "result";
      invocation_id: string;
      state: InvocationState;
      /** Small structured output. Media goes through the HTTP upload endpoint first. */
      output?: {
        observation_id?: string; // returned by the upload endpoint
        value?: number | string | boolean | null;
        unit?: string;
        data?: Record<string, unknown>;
        captured_at?: string | null;
        note?: string;
      };
      error?: string;
    }
  | { type: "event"; local_key: string; name: string; data?: Record<string, unknown> }
  /** WebRTC signaling relay (phone camera live stream). */
  | { type: "signal"; session_id: string; to: "viewer" | "device"; data: unknown };

/** coordinator -> connector */
export type CoordinatorMessage =
  | {
      type: "welcome";
      connector_id: string;
      owner_id: string;
      /** Persist this and send it in future hellos. */
      credential: string;
    }
  | { type: "pending_confirmation"; pairing_id: string; message: string }
  | { type: "published"; devices: { local_key: string; device_id: string; status: CatalogStatus }[] }
  | {
      type: "invoke";
      invocation_id: string;
      device_id: string;
      local_key: string;
      capability_id: string;
      arguments: Record<string, unknown>;
      lease_id: string | null;
      lease_revision: number;
      deadline: string;
      /** Where to POST media for this invocation, with a one-use token. */
      upload: { url: string; token: string };
    }
  | { type: "cancel"; invocation_id: string }
  | { type: "revoke"; lease_id: string; device_ids: string[] }
  | { type: "signal"; session_id: string; from: "viewer" | "device"; device_id: string; data: unknown }
  | { type: "error"; message: string }
  | { type: "ping"; at: string };

/* ------------------------------------------------------------------ */
/* Coordinator event stream (SSE at GET /api/v1/events) for UIs        */
/* ------------------------------------------------------------------ */

export type GhostEvent =
  | { type: "device.published"; device: Device }
  | { type: "device.updated"; device: Device }
  | { type: "device.removed"; device_id: string }
  | { type: "pairing.pending"; pairing_id: string; label: string; connector_kind: ConnectorKind; owner_id: string }
  | { type: "pairing.confirmed"; pairing_id: string; connector_id: string }
  | { type: "lease.updated"; lease: Lease }
  | { type: "offer.updated"; offer: Offer }
  | { type: "invocation.updated"; invocation: Invocation }
  | { type: "observation.created"; observation: Observation }
  | { type: "ledger.updated"; principal_id: string; balance_cents: number }
  | { type: "log"; level: "info" | "warn" | "error"; message: string; at: string };

/* ------------------------------------------------------------------ */
/* HTTP API shapes (/api/v1/*)                                         */
/* ------------------------------------------------------------------ */

export interface MeResponse {
  principal_id: string;
  /** Token the owner's browser uses to connect its own hardware over the device channel. */
  owner_token: string;
  balance_cents: number;
  display_name: string;
}

export interface SearchQuery {
  q?: string;
  semantic_type?: string;
  device_class?: DeviceClass;
  access_type?: AccessType;
  zone_id?: string;
  near?: { lat: number; lon: number; radius_km?: number };
  only_online?: boolean;
  limit?: number;
}

export interface QuoteRequest {
  refs: CapabilityRef[];
  duration_s: number;
  /** Counteroffer from the visitor (cents). Host may accept, counter, or reject. Max 2 rounds. */
  offer_price_cents?: number;
  /** Continue negotiating on an existing offer. */
  offer_id?: string;
}

export interface QuoteResponse {
  offer: Offer;
  /** Plain-language explanation from the host agent. */
  host_message: string;
}

export interface AcceptRequest {
  offer_id: string;
  /** The visitor's remaining task budget; the coordinator refuses to exceed it. */
  max_spend_cents: number;
}

export interface InvokeRequest {
  device_id: string;
  capability_id: string;
  arguments?: Record<string, unknown>;
  lease_id?: string;
  /** Client-generated idempotency key. Same key returns the same invocation. */
  idempotency_key?: string;
  timeout_ms?: number;
}

export interface InvokeResponse {
  invocation: Invocation;
  observation?: Observation | null;
}

export interface PairingResponse {
  pairing_id: string;
  code: string;
  /** Relative path; the UI turns it into an absolute URL with the public origin. */
  join_path: string;
  expires_at: string;
}

export function refKey(r: CapabilityRef): string {
  return `${r.device_id}/${r.capability_id}`;
}

export function parseRef(ref: string): CapabilityRef | null {
  const i = ref.indexOf("/");
  if (i <= 0) return null;
  return { device_id: ref.slice(0, i), capability_id: ref.slice(i + 1) };
}
