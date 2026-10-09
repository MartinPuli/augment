/** Outbound gateway: hardware credentials and network addresses stay on the owner's host. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GhostConnector, type GhostConnectorOptions } from "../../src/lib/connector/client";
import { InvokeError, type KV, type ResultOutput } from "../../src/lib/connector/types";
import type { Device } from "../../src/lib/ghost/contracts";
import { lanAdapter } from "../../src/lib/ghost/server/adapters/lan";
import { scan, type ScanOptions } from "../../src/lib/ghost/server/adapters/lan/scan";
import type { AdapterDiscovery } from "../../src/lib/ghost/server/adapters/types";

function privateWrite(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}

/** Origin-scoped credential storage, never checked into source control. */
export class FileStorage implements KV {
  constructor(private directory: string) {}
  private file(key: string) { return path.join(this.directory, `${createHash("sha256").update(key).digest("hex")}.json`); }
  getItem(key: string) { const f = this.file(key); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) as string : null; }
  setItem(key: string, value: string) { privateWrite(this.file(key), value); }
  removeItem(key: string) { const f = this.file(key); if (existsSync(f)) unlinkSync(f); }
}

type Receipt = { state: "started" } | { state: "done"; output: ResultOutput } | { state: "error"; error: string; outcome: "failed" | "rejected" | "unknown" };
/** Persistent deduplication. A crash between action and receipt leaves an unknown outcome. */
export class ActionJournal {
  constructor(private directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  async run(id: string, fn: () => Promise<ResultOutput>): Promise<ResultOutput> {
    const file = path.join(this.directory, `${createHash("sha256").update(id).digest("hex")}.json`);
    try {
      const fd = openSync(file, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify({ state: "started" })); fsyncSync(fd); } finally { closeSync(fd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const receipt = JSON.parse(readFileSync(file, "utf8")) as Receipt;
      if (receipt.state === "done") return receipt.output;
      if (receipt.state === "error") throw new InvokeError(receipt.error, receipt.outcome);
      throw new InvokeError("This action already started; its result is unknown. Read the device state before taking another action.", "unknown");
    }
    try {
      const output = await fn();
      privateWrite(file, { state: "done", output });
      return output;
    } catch (error) {
      const outcome = error instanceof InvokeError ? error.state : "unknown";
      const message = error instanceof Error ? error.message : "Hardware action failed";
      privateWrite(file, { state: "error", error: message, outcome });
      throw new InvokeError(message, outcome);
    }
  }
}

export interface LanGatewayOptions {
  coordinator: string;
  pairingCode?: string;
  ownerToken?: string;
  allow: string[];
  /** Explicit consent to publish all supported devices discovered by this gateway. */
  allowAll?: boolean;
  stateDir: string;
  label?: string;
  scanOptions?: ScanOptions;
  WebSocketImpl?: GhostConnectorOptions["WebSocketImpl"];
}

export class LanGateway {
  readonly connector: GhostConnector;
  private journal: ActionJournal;
  private keys = new Set<string>();
  private refreshing = false;
  constructor(private options: LanGatewayOptions) {
    const origin = new URL(options.coordinator);
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new Error("coordinator must be an HTTP(S) origin");
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) throw new Error("Use HTTPS for a remote coordinator (HTTP is allowed on loopback only)");
    if (!options.allowAll && !options.allow.length) throw new Error("Select devices with --allow <local_key>, or explicitly use --allow-all");
    const namespace = createHash("sha256").update(origin.origin).digest("hex");
    this.journal = new ActionJournal(path.join(options.stateDir, namespace, "actions"));
    this.connector = new GhostConnector({
      url: `${origin.protocol === "https:" ? "wss:" : "ws:"}//${origin.host}/v1/device-channel`,
      connectorKind: "lan-gateway", label: options.label ?? "GHOST LAN gateway",
      pairingCode: options.pairingCode, ownerToken: options.ownerToken,
      storage: new FileStorage(path.join(options.stateDir, namespace, "credentials")),
      storageKey: `ghost.lan.${origin.origin}`, WebSocketImpl: options.WebSocketImpl,
      trackVisibility: false,
    });
  }
  async refresh(discoveries?: AdapterDiscovery[]) {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const found = discoveries ?? (await scan(this.options.scanOptions)).discoveries;
      const selected = found.filter(d => (this.options.allowAll || this.options.allow.includes(d.manifest.local_key)) && d.status !== "candidate" && d.manifest.meta?.support === "supported" && d.online !== false);
      const nextKeys = new Set(selected.map(d => d.manifest.local_key));
      for (const key of this.keys) if (!nextKeys.has(key)) await this.connector.removeDevice(key);
      for (const d of selected) {
        // Private transport addressing is only used by the local handler, not the public catalog.
        const manifest = { ...d.manifest, access_type: "own_device" as const, terms: { ...d.manifest.terms, requires_approval: true }, meta: { driver: d.manifest.meta?.driver, connection_method: "outbound LAN gateway" } };
        this.connector.registerDevice({ manifest, handler: async (capability, args, ctx) => {
          if (ctx.signal.aborted) throw new InvokeError("Invocation cancelled", "rejected");
          const spec = d.manifest.capabilities.find(c => c.capability_id === capability);
          if (!spec) throw new InvokeError("Unknown capability", "rejected");
          const perform = async (): Promise<ResultOutput> => {
            const snapshot = this.connector.getSnapshot();
            const device: Device = { ...d.manifest, device_id: ctx.device_id, connector_id: snapshot.connector_id!, owner_id: snapshot.owner_id!, status: "verified", online: true, last_heartbeat: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
            const result = await lanAdapter.invoke(device, capability, args, { invocation_id: ctx.invocation_id, visitor_id: "gateway", lease_id: ctx.lease_id, deadline: new Date(ctx.deadline), signal: ctx.signal });
            if (result.state !== "succeeded") throw new InvokeError(result.error ?? "Device did not verify the result", spec.kind === "act" && result.state === "failed" ? "unknown" : result.state);
            const obs = result.observation;
            if (!obs) throw new InvokeError("Device returned no evidence", "unknown");
            const output: ResultOutput = { value: obs.value, unit: obs.unit, data: { ...obs.data, ...(obs.source ? { source: obs.source } : {}) }, captured_at: obs.captured_at ?? null, note: obs.note };
            if (obs.media) output.observation_id = await ctx.upload(new Blob([new Uint8Array(obs.media.bytes)], { type: obs.media.content_type }), { capturedAt: obs.captured_at ?? null, contentType: obs.media.content_type });
            return output;
          };
          return spec.kind === "act" ? this.journal.run(ctx.invocation_id, perform) : perform();
        }});
      }
      this.keys = nextKeys;
      return { discovered: found.length, published: selected.length, keys: [...nextKeys] };
    } finally { this.refreshing = false; }
  }
  start() { this.connector.start(); }
  stop() { this.connector.stop(); }
}
