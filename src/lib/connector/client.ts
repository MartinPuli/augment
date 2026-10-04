/**
 * GhostConnector — browser (and Node-testable) side of the GHOST device channel.
 *
 *   connector ──hello──▶ coordinator          (credential | owner_token | pairing_code)
 *             ◀─welcome / pending_confirmation
 *             ──publish──▶  ◀─published
 *             ──heartbeat (5 s)──▶
 *             ◀─invoke── handler(ctx) ── POST upload.url ──▶ ──result──▶
 *             ◀─revoke / cancel / signal / ping
 *
 * Guarantees:
 * - Only registered devices/capabilities are invokable; unknown ones are rejected.
 * - Invokes for revoked leases or past deadlines are rejected; the handler's AbortSignal fires on
 *   cancel, revoke, deadline and stop.
 * - Results are cached by invocation_id: a retried invoke gets the same result without re-running
 *   the hardware action. Results produced while offline are flushed after reconnect.
 * - Reconnects with exponential backoff and the persisted credential.
 */
import {
  PROTOCOL_VERSION,
  type ConnectorKind,
  type ConnectorMessage,
  type CoordinatorMessage,
  type DeviceManifest,
  type InvocationState,
} from "@/lib/ghost/contracts";
import {
  InvokeError,
  type ActiveInvocation,
  type ConnectorSnapshot,
  type ConnectorStatus,
  type DriverDevice,
  type FinishedInvocation,
  type KV,
  type PublishedDeviceInfo,
  type ResultMessage,
  type ResultOutput,
} from "./types";
import { errorMessage, isRecord, safeStorage, withAbort } from "./util";

export interface GhostConnectorOptions {
  /** ws(s)://host/v1/device-channel */
  url: string;
  connectorKind: ConnectorKind;
  label: string;
  ownerToken?: string | null;
  pairingCode?: string | null;
  /** If the coordinator welcomes us as a different owner, drop the stored credential and use ownerToken. */
  expectedOwnerId?: string | null;
  /** Credential persistence. Defaults to localStorage (when available). Pass null to disable. */
  storage?: KV | null;
  /** Defaults to `ghost.connector.<connectorKind>.credential`. */
  storageKey?: string;
  heartbeatMs?: number;
  WebSocketImpl?: typeof WebSocket;
  fetchImpl?: typeof fetch;
  /** Report devices offline while the tab is hidden (phones). */
  trackVisibility?: boolean;
  /** Publish devices as soon as they are registered (default true). */
  autoPublish?: boolean;
  log?: (...args: unknown[]) => void;
}

interface Registered {
  device: DriverDevice;
  device_id: string | null;
  status: PublishedDeviceInfo["status"];
  wantPublished: boolean;
  online: boolean;
}

interface Running {
  inv: ActiveInvocation;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

type InvocationEvent =
  | { phase: "start"; invocation: ActiveInvocation }
  | { phase: "end"; invocation: FinishedInvocation };

type EventMap = {
  invocation: InvocationEvent;
  revoke: { lease_id: string; device_ids: string[] };
  message: CoordinatorMessage;
  welcome: { connector_id: string; owner_id: string };
};

const MAX_CACHED_RESULTS = 200;
const DEADLINE_MARGIN_MS = 300;
const MAX_RECENT = 20;

export class GhostConnector {
  readonly kind: ConnectorKind;
  private opts: GhostConnectorOptions;
  private storage: KV | null;
  private storageKey: string;
  private ws: WebSocket | null = null;
  private stopped = true;
  private welcomed = false;
  private helloAuth: "credential" | "owner_token" | "pairing_code" | null = null;
  private errorBeforeWelcome: string | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private devices = new Map<string, Registered>();
  private running = new Map<string, Running>();
  private results = new Map<string, ResultMessage>();
  private pendingResults: ResultMessage[] = [];
  private revokedLeases = new Set<string>();
  private viewerSignals = new Map<string, (data: unknown, device_id: string) => void>();
  private liveSessions = new Map<string, string>();
  private listeners = new Set<() => void>();
  private eventListeners = new Map<keyof EventMap, Set<(e: never) => void>>();
  private snap: ConnectorSnapshot;
  private hidden = false;
  private cleanupGlobal: (() => void) | null = null;

  constructor(opts: GhostConnectorOptions) {
    this.opts = { heartbeatMs: 5000, autoPublish: true, ...opts };
    this.kind = opts.connectorKind;
    this.storage = opts.storage === undefined ? safeStorage() : opts.storage;
    this.storageKey = opts.storageKey ?? `ghost.connector.${opts.connectorKind}.credential`;
    this.snap = {
      status: "idle",
      detail: null,
      connector_kind: opts.connectorKind,
      connector_id: null,
      owner_id: null,
      pairing_id: null,
      devices: [],
      active: [],
      recent: [],
      live_sessions: [],
    };
  }

  /* ---------------------------------------------------------------- */
  /* Store API (useSyncExternalStore-compatible)                       */
  /* ---------------------------------------------------------------- */

  getSnapshot = (): ConnectorSnapshot => this.snap;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  on<K extends keyof EventMap>(event: K, fn: (e: EventMap[K]) => void): () => void {
    let set = this.eventListeners.get(event) as Set<(e: EventMap[K]) => void> | undefined;
    if (!set) {
      set = new Set();
      this.eventListeners.set(event, set as Set<(e: never) => void>);
    }
    const s = set;
    s.add(fn);
    return () => s.delete(fn);
  }

  private emit<K extends keyof EventMap>(event: K, payload: EventMap[K]) {
    const set = this.eventListeners.get(event) as Set<(e: EventMap[K]) => void> | undefined;
    set?.forEach((fn) => {
      try {
        fn(payload);
      } catch (e) {
        this.log("listener error", e);
      }
    });
  }

  private update(patch: Partial<ConnectorSnapshot> = {}) {
    const devices: PublishedDeviceInfo[] = [...this.devices.values()].map((r) => ({
      local_key: r.device.manifest.local_key,
      name: r.device.manifest.name,
      device_class: r.device.manifest.device_class,
      transport: r.device.manifest.transport,
      icon: r.device.manifest.icon,
      capabilities: r.device.manifest.capabilities.map((c) => ({
        capability_id: c.capability_id,
        kind: c.kind,
        title: c.title,
      })),
      device_id: r.device_id,
      status: r.status,
    }));
    this.snap = {
      ...this.snap,
      ...patch,
      devices,
      active: [...this.running.values()].map((r) => r.inv),
      live_sessions: [...this.liveSessions.entries()].map(([session_id, device_id]) => ({ session_id, device_id })),
    };
    this.listeners.forEach((fn) => {
      try {
        fn();
      } catch (e) {
        this.log("subscriber error", e);
      }
    });
  }

  private setStatus(status: ConnectorStatus, detail: string | null = null, extra: Partial<ConnectorSnapshot> = {}) {
    this.update({ status, detail, ...extra });
  }

  private log(...args: unknown[]) {
    (this.opts.log ?? (() => {}))("[ghost-connector]", ...args);
  }

  /* ---------------------------------------------------------------- */
  /* Credentials / auth                                                */
  /* ---------------------------------------------------------------- */

  get credential(): string | null {
    try {
      return this.storage?.getItem(this.storageKey) ?? null;
    } catch {
      return null;
    }
  }

  private saveCredential(c: string) {
    try {
      this.storage?.setItem(this.storageKey, c);
    } catch {
      /* storage unavailable: credential only lives for this session */
    }
    this.memCredential = c;
  }
  private memCredential: string | null = null;

  forgetCredential() {
    try {
      this.storage?.removeItem(this.storageKey);
    } catch {}
    this.memCredential = null;
  }

  hasCredential(): boolean {
    return !!(this.credential ?? this.memCredential);
  }

  setOwnerToken(token: string | null, expectedOwnerId?: string | null) {
    this.opts.ownerToken = token;
    if (expectedOwnerId !== undefined) this.opts.expectedOwnerId = expectedOwnerId;
  }

  setPairingCode(code: string | null) {
    this.opts.pairingCode = code;
  }

  /* ---------------------------------------------------------------- */
  /* Connection lifecycle                                              */
  /* ---------------------------------------------------------------- */

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.installGlobalListeners();
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    for (const r of this.running.values()) r.controller.abort(new InvokeError("connector stopped", "failed"));
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, "stopped");
    } catch {}
    this.welcomed = false;
    this.cleanupGlobal?.();
    this.cleanupGlobal = null;
    this.setStatus("closed", null);
  }

  /** Reconnect now (e.g. after the tab became visible again). */
  reconnectNow() {
    if (this.stopped) return;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connect();
  }

  get isOnline(): boolean {
    return this.welcomed && this.ws?.readyState === 1;
  }

  private connect() {
    if (this.stopped) return;
    const WS = this.opts.WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WS) {
      this.setStatus("error", "WebSocket is not available in this environment");
      return;
    }
    this.welcomed = false;
    this.errorBeforeWelcome = null;
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting", this.attempt ? `attempt ${this.attempt + 1}` : null);
    let ws: WebSocket;
    try {
      ws = new WS(this.opts.url);
    } catch (e) {
      this.setStatus("error", `Cannot open ${this.opts.url}: ${errorMessage(e)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.sendHello();
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      let msg: CoordinatorMessage;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        this.log("bad message", ev.data);
        return;
      }
      this.onMessage(msg);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopHeartbeat();
      const wasWelcomed = this.welcomed;
      this.welcomed = false;
      for (const r of this.devices.values()) if (r.status !== "unpublished") r.status = "publishing";
      if (this.stopped) return;
      if (ev.code === 4000 || /superseded/i.test(ev.reason || "")) {
        // Another tab/window connected with the same credential. Don't fight over the socket.
        this.stopped = true;
        this.cleanupGlobal?.();
        this.cleanupGlobal = null;
        this.setStatus("error", "This connector is now active in another tab or window. Reload here to take it back.");
        return;
      }
      const err0 = this.errorBeforeWelcome;
      const definitive =
        !!err0 &&
        ([4001, 4003, 4004].includes(ev.code) ||
          /credential|pair again|invalid|expired|rejected|already used|unsupported protocol/i.test(err0));
      if (!wasWelcomed && err0 && definitive) {
        // The coordinator explicitly refused our hello (transient server errors just retry below).
        const err = err0;
        if (this.helloAuth === "credential") {
          this.forgetCredential();
          if (this.opts.ownerToken || this.opts.pairingCode) {
            this.attempt = 0;
            this.connect();
            return;
          }
          this.setStatus("error", `Stored credential was rejected (${err}). Pair this device again.`);
          this.stopped = true;
          return;
        }
        if (this.helloAuth === "pairing_code") {
          this.opts.pairingCode = null;
          this.setStatus("error", `Pairing failed: ${err}`);
          this.stopped = true;
          return;
        }
        if (!this.helloAuth) {
          this.setStatus("error", err);
          this.stopped = true;
          return;
        }
      }
      this.setStatus("reconnecting", ev.reason || (wasWelcomed ? "connection lost" : "coordinator unreachable"));
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const base = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt, 5));
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private sendHello() {
    const credential = this.credential ?? this.memCredential;
    const hello: Extract<ConnectorMessage, { type: "hello" }> = {
      type: "hello",
      protocol_version: PROTOCOL_VERSION,
      connector_kind: this.kind,
      label: this.opts.label,
      nonce: Math.random().toString(36).slice(2) + Date.now().toString(36),
    };
    if (credential) {
      hello.credential = credential;
      this.helloAuth = "credential";
    } else if (this.opts.ownerToken) {
      hello.owner_token = this.opts.ownerToken;
      this.helloAuth = "owner_token";
    } else if (this.opts.pairingCode) {
      hello.pairing_code = this.opts.pairingCode;
      this.helloAuth = "pairing_code";
    } else {
      this.helloAuth = null;
      this.errorBeforeWelcome = "No credential, owner token or pairing code";
      this.setStatus("error", "Not paired: open the pairing link from GHOST again.");
      this.stopped = true;
      try {
        this.ws?.close(1000, "no auth");
      } catch {}
      return;
    }
    this.sendRaw(hello);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    const beat = () => this.sendRaw({ type: "heartbeat", at: new Date().toISOString() });
    beat();
    this.heartbeatTimer = setInterval(beat, this.opts.heartbeatMs ?? 5000);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private sendRaw(msg: ConnectorMessage): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      this.log("send failed", e);
      return false;
    }
  }

  private installGlobalListeners() {
    if (typeof window === "undefined" || this.cleanupGlobal) return;
    const onOnline = () => this.reconnectNow();
    window.addEventListener("online", onOnline);
    let onVis: (() => void) | null = null;
    if (this.opts.trackVisibility && typeof document !== "undefined") {
      onVis = () => {
        const hidden = document.visibilityState === "hidden";
        if (hidden === this.hidden) return;
        this.hidden = hidden;
        for (const r of this.devices.values()) {
          if (r.status === "unpublished") continue;
          this.setDeviceStatus(
            r.device.manifest.local_key,
            !hidden && r.online,
            hidden ? "Browser tab hidden or screen off — sensors paused by the OS" : undefined,
            true,
          );
        }
        if (!hidden) {
          this.reconnectNow();
          if (this.isOnline) this.sendRaw({ type: "heartbeat", at: new Date().toISOString() });
        }
      };
      document.addEventListener("visibilitychange", onVis);
    }
    this.cleanupGlobal = () => {
      window.removeEventListener("online", onOnline);
      if (onVis) document.removeEventListener("visibilitychange", onVis);
    };
  }

  /* ---------------------------------------------------------------- */
  /* Incoming messages                                                 */
  /* ---------------------------------------------------------------- */

  private onMessage(msg: CoordinatorMessage) {
    this.emit("message", msg);
    switch (msg.type) {
      case "welcome": {
        const expected = this.opts.expectedOwnerId;
        if (expected && msg.owner_id && msg.owner_id !== expected && this.helloAuth === "credential" && this.opts.ownerToken) {
          // Stored credential belongs to another principal (e.g. a different login): re-auth as the current owner.
          this.log("credential belongs to", msg.owner_id, "expected", expected, "— re-authenticating");
          this.forgetCredential();
          try {
            this.ws?.close(4900, "owner changed");
          } catch {}
          return;
        }
        if (msg.credential) this.saveCredential(msg.credential);
        this.welcomed = true;
        this.attempt = 0;
        if (this.helloAuth === "pairing_code") this.opts.pairingCode = null;
        this.setStatus("online", null, { connector_id: msg.connector_id, owner_id: msg.owner_id, pairing_id: null });
        this.emit("welcome", { connector_id: msg.connector_id, owner_id: msg.owner_id });
        this.startHeartbeat();
        this.publishWanted();
        this.flushPendingResults();
        if (this.hidden) {
          for (const r of this.devices.values()) this.setDeviceStatus(r.device.manifest.local_key, false, "Browser tab hidden", true);
        }
        return;
      }
      case "pending_confirmation":
        this.setStatus("pending_confirmation", msg.message || "Waiting for the owner to confirm", { pairing_id: msg.pairing_id });
        return;
      case "published": {
        for (const d of msg.devices ?? []) {
          const r = this.devices.get(d.local_key);
          if (!r) continue;
          r.device_id = d.device_id;
          r.status = d.status;
        }
        this.update();
        return;
      }
      case "invoke":
        void this.handleInvoke(msg);
        return;
      case "cancel": {
        const r = this.running.get(msg.invocation_id);
        r?.controller.abort(new InvokeError("cancelled", "failed"));
        return;
      }
      case "revoke":
        this.handleRevoke(msg.lease_id, msg.device_ids ?? []);
        return;
      case "signal":
        this.handleSignal(msg);
        return;
      case "ping":
        this.sendRaw({ type: "heartbeat", at: new Date().toISOString() });
        return;
      case "error":
        this.log("coordinator error:", msg.message);
        if (!this.welcomed) this.errorBeforeWelcome = msg.message || "coordinator error";
        if (!this.welcomed && this.snap.status !== "pending_confirmation") {
          // If the server neither closes nor welcomes us shortly, retry with a fresh socket.
          const ws = this.ws;
          setTimeout(() => {
            if (this.ws === ws && !this.welcomed && this.snap.status !== "pending_confirmation") {
              try {
                ws?.close(4901, "no welcome after error");
              } catch {}
            }
          }, 4000);
        }
        this.update({ detail: msg.message || null });
        return;
    }
  }

  private handleRevoke(lease_id: string, device_ids: string[]) {
    this.revokedLeases.add(lease_id);
    if (this.revokedLeases.size > 500) {
      const first = this.revokedLeases.values().next().value;
      if (first) this.revokedLeases.delete(first);
    }
    for (const r of this.running.values()) {
      if (r.inv.lease_id === lease_id) r.controller.abort(new InvokeError("lease revoked", "failed"));
    }
    for (const reg of this.devices.values()) {
      if (device_ids.length && (!reg.device_id || !device_ids.includes(reg.device_id))) continue;
      try {
        reg.device.onRevoke?.(lease_id);
      } catch (e) {
        this.log("onRevoke failed", e);
      }
    }
    this.emit("revoke", { lease_id, device_ids });
  }

  private handleSignal(msg: Extract<CoordinatorMessage, { type: "signal" }>) {
    if (msg.from === "device") {
      const fn = this.viewerSignals.get(msg.session_id);
      if (fn) fn(msg.data, msg.device_id);
      else this.log("signal for unknown viewer session", msg.session_id);
      return;
    }
    const reg = this.findByDeviceId(msg.device_id);
    const reply = (data: unknown) => this.sendRaw({ type: "signal", session_id: msg.session_id, to: "viewer", data });
    if (!reg || !reg.device.onSignal) {
      reply({ kind: "error", message: "This device does not offer a live stream" });
      return;
    }
    try {
      reg.device.onSignal(msg.session_id, msg.data, reply, { device_id: msg.device_id });
    } catch (e) {
      reply({ kind: "error", message: errorMessage(e) });
    }
  }

  private findByDeviceId(device_id: string | undefined | null): Registered | undefined {
    if (!device_id) return undefined;
    for (const r of this.devices.values()) if (r.device_id === device_id) return r;
    return undefined;
  }

  /* ---------------------------------------------------------------- */
  /* Invocations                                                       */
  /* ---------------------------------------------------------------- */

  private async handleInvoke(msg: Extract<CoordinatorMessage, { type: "invoke" }>) {
    const id = msg.invocation_id;
    if (typeof id !== "string" || !id) return;
    const cached = this.results.get(id);
    if (cached) {
      this.sendRaw(cached);
      return;
    }
    if (this.running.has(id)) return; // still working on it; the result will follow

    const reject = (error: string) =>
      this.finishResult(null, { type: "result", invocation_id: id, state: "rejected", error });

    const reg = this.devices.get(msg.local_key) ?? this.findByDeviceId(msg.device_id);
    if (!reg || reg.status === "unpublished") return reject("unknown or unpublished device");
    if (reg.device_id && msg.device_id && reg.device_id !== msg.device_id) return reject("device_id does not match local_key");
    if (msg.lease_id && this.revokedLeases.has(msg.lease_id)) return reject("lease revoked");
    const cap = reg.device.manifest.capabilities.find((c) => c.capability_id === msg.capability_id);
    if (!cap) return reject(`capability "${msg.capability_id}" is not published by this device`);
    if (this.hidden && this.kind === "phone-browser") return reject("phone tab is in the background; sensors are paused");
    const parsed = Date.parse(msg.deadline);
    const deadline = Number.isFinite(parsed) ? parsed : Date.now() + 30_000;
    if (deadline <= Date.now()) return reject("deadline already passed");
    const args = isRecord(msg.arguments) ? msg.arguments : {};

    const controller = new AbortController();
    const inv: ActiveInvocation = {
      invocation_id: id,
      device_id: msg.device_id,
      local_key: reg.device.manifest.local_key,
      capability_id: msg.capability_id,
      lease_id: msg.lease_id ?? null,
      started_at: Date.now(),
      deadline,
    };
    const run: Running = { inv, controller, timer: null, settled: false };
    // Abort slightly before the coordinator's deadline so the (honest) result still arrives in time.
    run.timer = setTimeout(
      () => controller.abort(new InvokeError("deadline exceeded", cap.kind === "act" ? "unknown" : "failed")),
      Math.max(0, deadline - Date.now() - DEADLINE_MARGIN_MS),
    );
    this.running.set(id, run);
    this.update();
    this.emit("invocation", { phase: "start", invocation: inv });

    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const uploadUrl = this.resolveHttpUrl(msg.upload?.url);
    const uploadToken = msg.upload?.token;
    const ctx = {
      invocation_id: id,
      device_id: msg.device_id,
      local_key: inv.local_key,
      capability_id: msg.capability_id,
      lease_id: inv.lease_id,
      lease_revision: msg.lease_revision,
      deadline,
      remainingMs: () => Math.max(0, deadline - Date.now() - DEADLINE_MARGIN_MS),
      signal: controller.signal,
      upload: async (blob: Blob, o?: { capturedAt?: string | Date | null; contentType?: string }) => {
        if (!uploadUrl || !uploadToken) throw new InvokeError("coordinator gave no upload URL", "failed");
        const headers: Record<string, string> = {
          "Content-Type": o?.contentType || blob.type || "application/octet-stream",
          Authorization: `Bearer ${uploadToken}`,
        };
        if (o?.capturedAt) headers["X-Captured-At"] = o.capturedAt instanceof Date ? o.capturedAt.toISOString() : o.capturedAt;
        const res = await fetchImpl(uploadUrl, { method: "POST", headers, body: blob, signal: controller.signal });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new InvokeError(`upload failed (${res.status}) ${text.slice(0, 160)}`, "failed");
        }
        const json = (await res.json().catch(() => null)) as { observation_id?: string } | null;
        if (!json?.observation_id) throw new InvokeError("upload response had no observation_id", "failed");
        return json.observation_id;
      },
    };

    let state: InvocationState = "succeeded";
    let output: ResultOutput | undefined;
    let error: string | undefined;
    try {
      output = await withAbort(reg.device.handler(msg.capability_id, args, ctx), controller.signal);
    } catch (e) {
      state = e instanceof InvokeError ? e.state : "failed";
      error = errorMessage(e);
    }
    if (run.timer) clearTimeout(run.timer);
    run.settled = true;
    this.running.delete(id);
    const result: ResultMessage = { type: "result", invocation_id: id, state };
    if (output) result.output = sanitizeOutput(output);
    if (error) result.error = error;
    this.finishResult(inv, result);
  }

  private finishResult(inv: ActiveInvocation | null, result: ResultMessage) {
    this.results.set(result.invocation_id, result);
    if (this.results.size > MAX_CACHED_RESULTS) {
      const first = this.results.keys().next().value;
      if (first) this.results.delete(first);
    }
    if (!this.welcomed || !this.sendRaw(result)) this.pendingResults.push(result);
    if (inv) {
      const fin: FinishedInvocation = { ...inv, state: result.state, error: result.error, finished_at: Date.now() };
      this.update({ recent: [fin, ...this.snap.recent].slice(0, MAX_RECENT) });
      this.emit("invocation", { phase: "end", invocation: fin });
    } else {
      this.log("rejected invoke", result.invocation_id, result.error);
    }
  }

  private flushPendingResults() {
    const pending = this.pendingResults;
    this.pendingResults = [];
    for (const r of pending) if (!this.sendRaw(r)) this.pendingResults.push(r);
  }

  private resolveHttpUrl(u: string | undefined): string | null {
    if (!u) return null;
    try {
      // The Vercel UI proxies uploads to its coordinator; keep browser uploads same-origin.
      if (process.env.NEXT_PUBLIC_GHOST_PROXY_UPLOADS === "1" && typeof location !== "undefined") {
        const upload = new URL(u, location.origin);
        if (/^\/api\/v1\/invocations\/[^/]+\/observation$/.test(upload.pathname)) {
          return new URL(upload.pathname + upload.search, location.origin).toString();
        }
      }
      const wsUrl = new URL(this.opts.url);
      const base = `${wsUrl.protocol === "wss:" ? "https:" : "http:"}//${wsUrl.host}`;
      return new URL(u, base).toString();
    } catch {
      return u;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Devices                                                           */
  /* ---------------------------------------------------------------- */

  /** Register (or replace) a device. Published immediately when online unless publish:false. */
  registerDevice(device: DriverDevice, opts: { publish?: boolean } = {}) {
    const key = device.manifest.local_key;
    const prev = this.devices.get(key);
    const publish = opts.publish ?? this.opts.autoPublish ?? true;
    const reg: Registered = {
      device,
      device_id: prev?.device_id ?? null,
      status: publish ? "publishing" : "unpublished",
      wantPublished: publish,
      online: true,
    };
    this.devices.set(key, reg);
    if (publish && this.welcomed) this.sendRaw({ type: "publish", devices: [device.manifest] });
    this.update();
  }

  /** Replace a device's manifest/handler (e.g. a capability was added) and republish it. */
  updateDevice(device: DriverDevice) {
    const prev = this.devices.get(device.manifest.local_key);
    this.registerDevice(device, { publish: prev ? prev.wantPublished : undefined });
  }

  /** Publish registered devices (all, or the given local_keys). */
  publish(local_keys?: string[]) {
    const manifests: DeviceManifest[] = [];
    for (const [key, r] of this.devices) {
      if (local_keys && !local_keys.includes(key)) continue;
      r.wantPublished = true;
      if (r.status === "unpublished") r.status = "publishing";
      manifests.push(r.device.manifest);
    }
    if (manifests.length && this.welcomed) this.sendRaw({ type: "publish", devices: manifests });
    this.update();
  }

  private publishWanted() {
    const manifests = [...this.devices.values()].filter((r) => r.wantPublished).map((r) => r.device.manifest);
    if (manifests.length) this.sendRaw({ type: "publish", devices: manifests });
  }

  /** Stop advertising devices (they stay registered locally). Running invocations are aborted. */
  unpublish(local_keys: string[]) {
    if (!local_keys.length) return;
    for (const key of local_keys) {
      const r = this.devices.get(key);
      if (!r) continue;
      r.wantPublished = false;
      r.status = "unpublished";
      for (const run of this.running.values()) {
        if (run.inv.local_key === key) run.controller.abort(new InvokeError("owner stopped access", "failed"));
      }
    }
    this.sendRaw({ type: "unpublish", local_keys });
    this.update();
  }

  /** Unpublish, forget and dispose a device (closes tracks / disconnects hardware). */
  async removeDevice(local_key: string, opts: { dispose?: boolean } = {}) {
    const r = this.devices.get(local_key);
    if (!r) return;
    this.unpublish([local_key]);
    this.devices.delete(local_key);
    for (const [sid, dev] of this.liveSessions) if (dev === r.device_id) this.liveSessions.delete(sid);
    this.update();
    if (opts.dispose !== false) {
      try {
        await r.device.dispose?.();
      } catch (e) {
        this.log("dispose failed", e);
      }
    }
  }

  getDevice(local_key: string): DriverDevice | undefined {
    return this.devices.get(local_key)?.device;
  }

  deviceIdFor(local_key: string): string | null {
    return this.devices.get(local_key)?.device_id ?? null;
  }

  /** Report availability changes (BLE disconnect, tab hidden...). */
  setDeviceStatus(local_key: string, online: boolean, detail?: string, transient = false) {
    const r = this.devices.get(local_key);
    if (!r) return;
    if (!transient) r.online = online;
    this.sendRaw({ type: "device_status", local_key, online, ...(detail ? { detail } : {}) });
  }

  sendEvent(local_key: string, name: string, data?: Record<string, unknown>) {
    this.sendRaw({ type: "event", local_key, name, ...(data ? { data } : {}) });
  }

  /* ---------------------------------------------------------------- */
  /* WebRTC signaling relay                                            */
  /* ---------------------------------------------------------------- */

  sendSignal(session_id: string, to: "viewer" | "device", data: unknown): boolean {
    return this.sendRaw({ type: "signal", session_id, to, data });
  }

  /** Viewer side: receive device → viewer signals for one session. */
  onViewerSignal(session_id: string, fn: (data: unknown, device_id: string) => void): () => void {
    this.viewerSignals.set(session_id, fn);
    return () => {
      if (this.viewerSignals.get(session_id) === fn) this.viewerSignals.delete(session_id);
    };
  }

  /** Device side: mark a live session as streaming (drives the "Polty is watching" UI). */
  setLiveSession(session_id: string, device_id: string, live: boolean) {
    if (live) this.liveSessions.set(session_id, device_id);
    else this.liveSessions.delete(session_id);
    this.update();
  }
}

function sanitizeOutput(o: ResultOutput): ResultOutput {
  const out: ResultOutput = {};
  if (o.observation_id !== undefined) out.observation_id = o.observation_id;
  if (o.value !== undefined) out.value = o.value;
  if (o.unit !== undefined) out.unit = o.unit;
  if (o.data !== undefined) out.data = o.data;
  if (o.captured_at !== undefined) out.captured_at = o.captured_at;
  if (o.note !== undefined) out.note = o.note;
  return out;
}
