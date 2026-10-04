/**
 * GHOST browser connector SDK — shared types.
 *
 * A connector registers devices (manifest + handler). The handler is called for every `invoke`
 * routed to that device and must resolve to a small structured output (media is uploaded first
 * with ctx.upload and referenced by observation_id).
 */
import type {
  CapabilitySpec,
  CatalogStatus,
  ConnectorKind,
  ConnectorMessage,
  DeviceManifest,
  InvocationState,
} from "@/lib/ghost/contracts";

export type ResultMessage = Extract<ConnectorMessage, { type: "result" }>;
export type ResultOutput = NonNullable<ResultMessage["output"]>;

export interface InvokeContext {
  invocation_id: string;
  device_id: string;
  local_key: string;
  capability_id: string;
  lease_id: string | null;
  lease_revision: number;
  /** Absolute deadline (epoch ms). */
  deadline: number;
  /** Milliseconds left before the deadline (never negative). */
  remainingMs(): number;
  /** Aborted on cancel, revoke of this lease, deadline, or connector stop. */
  signal: AbortSignal;
  /** POST media to this invocation's one-use upload URL. Resolves to the observation_id. */
  upload(blob: Blob, opts?: { capturedAt?: string | Date | null; contentType?: string }): Promise<string>;
}

export type CapabilityHandler = (
  capability_id: string,
  args: Record<string, unknown>,
  ctx: InvokeContext,
) => Promise<ResultOutput>;

/** Throw from a handler to choose the result state explicitly. */
export class InvokeError extends Error {
  readonly state: Extract<InvocationState, "failed" | "rejected" | "unknown">;
  constructor(message: string, state: Extract<InvocationState, "failed" | "rejected" | "unknown"> = "failed") {
    super(message);
    this.name = "InvokeError";
    this.state = state;
  }
}

/** Device-side WebRTC signaling hook (phone camera live stream). */
export type SignalHandler = (
  session_id: string,
  data: unknown,
  reply: (data: unknown) => void,
  meta: { device_id: string },
) => void;

export interface DeviceExtras {
  /** Called when the coordinator relays a viewer's signaling message for this device. */
  onSignal?: SignalHandler;
  /** Called when a lease touching this device is revoked: stop any media running for it. */
  onRevoke?: (lease_id: string) => void;
  /** Release hardware (close tracks, GATT disconnect, close serial port). */
  dispose?: () => void | Promise<void>;
}

/** A complete device a driver can hand to GhostConnector.registerDevice. */
export interface DriverDevice extends DeviceExtras {
  manifest: DeviceManifest;
  handler: CapabilityHandler;
}

/**
 * A capability module contributes capabilities to a composite device (the phone / "This laptop").
 * The module only exists after the browser API is available AND permission was granted.
 */
export interface CapabilityModule extends DeviceExtras {
  /** Non-secret connection hints that can be remembered alongside the device manifest. */
  connection?: { method: string; input_label?: string };
  /** "camera" | "microphone" | "speaker" | "display" | "haptics" | "motion" | "location" | "battery" | "torch" */
  id: string;
  label: string;
  capabilities: CapabilitySpec[];
  handle: CapabilityHandler;
}

export type ConnectorStatus =
  | "idle"
  | "connecting"
  | "pending_confirmation"
  | "online"
  | "reconnecting"
  | "error"
  | "closed";

export interface PublishedDeviceInfo {
  local_key: string;
  name: string;
  device_class: DeviceManifest["device_class"];
  transport: DeviceManifest["transport"];
  icon?: string;
  capabilities: { capability_id: string; kind: CapabilitySpec["kind"]; title: string }[];
  /** Assigned by the coordinator once `published` arrives. */
  device_id: string | null;
  status: CatalogStatus | "unpublished" | "publishing";
}

export interface ActiveInvocation {
  invocation_id: string;
  device_id: string;
  local_key: string;
  capability_id: string;
  lease_id: string | null;
  started_at: number;
  deadline: number;
}

export interface FinishedInvocation extends ActiveInvocation {
  state: InvocationState;
  error?: string;
  finished_at: number;
}

export interface ConnectorSnapshot {
  status: ConnectorStatus;
  /** Human-readable detail for the status (error text, pending message...). */
  detail: string | null;
  connector_kind: ConnectorKind;
  connector_id: string | null;
  owner_id: string | null;
  pairing_id: string | null;
  devices: PublishedDeviceInfo[];
  active: ActiveInvocation[];
  recent: FinishedInvocation[];
  /** Live WebRTC sessions this connector serves (device side). */
  live_sessions: { session_id: string; device_id: string }[];
}

/** Minimal key-value persistence (localStorage-compatible). */
export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
