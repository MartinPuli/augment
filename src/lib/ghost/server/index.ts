import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { getRequestListener } from "@hono/node-server";
import type { Hono } from "hono";
import { internalAdapters } from "./adapters";
import { createDeviceChannel, DEVICE_CHANNEL_PATH, heartbeatSweep, pingConnectors } from "./channel";
import { db, openDb, type DbOptions } from "./db";
import { log } from "./events";
import { createApiApp } from "./http";
import { sweep } from "./leases";
import { publishFromAdapter } from "./registry";
import { S } from "./state";
import { isPoppyPath } from "./poppy/routes";

export interface Coordinator {
  app: Hono;
  /** Node request listener for /api/v1/* and /mcp. */
  requestListener: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  /** Handles WebSocket upgrades for /v1/device-channel. Returns false for other paths. */
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  /** True if the coordinator should serve this request path (vs Next.js). */
  ownsPath: (pathname: string) => boolean;
  stop: () => Promise<void>;
}

export interface StartOptions extends DbOptions {
  /** Skip internal adapter discovery (tests). */
  skipAdapters?: boolean;
  /** Also listen on this port with a standalone http server (no Next.js). */
  listenPort?: number;
  hostname?: string;
}

export function ownsPath(pathname: string): boolean {
  return isPoppyPath(pathname) || pathname.startsWith("/api/v1/") || pathname === "/api/v1" || pathname === "/mcp" || pathname.startsWith("/mcp/") || pathname.startsWith("/mcp?");
}

async function discoverAdapters() {
  for (const adapter of internalAdapters) {
    if (!adapter.discover) continue;
    void (async () => {
      try {
        const found = await adapter.discover!({ log: (m) => log("info", `[${adapter.id}] ${m}`) });
        if (found?.length) {
          const devs = await publishFromAdapter(adapter.id, found, { owner_id: adapter.owner_id });
          log("info", `adapter ${adapter.id}: published ${devs.length} devices`);
        }
      } catch (e) {
        log("warn", `adapter ${adapter.id} discovery failed: ${(e as Error).message}`);
      }
    })();
  }
}

/**
 * Boot the GHOST coordinator once per process (singleton on globalThis.__ghost).
 * Opens Postgres (DATABASE_URL) or embedded PGlite (.ghost/pgdata), runs migrations,
 * starts the lease sweeper + heartbeat watchdog and adapter discovery (in the background).
 */
export function startCoordinator(opts: StartOptions = {}): Promise<Coordinator> {
  const st = S();
  if (st.started) return st.started as Promise<Coordinator>;
  st.started = (async () => {
    const database = await openDb(opts);
    log("info", `database ready (${database.kind === "postgres" ? "Postgres via DATABASE_URL" : "embedded PGlite"})`);
    // After a restart no connector is connected: their devices are offline until they reconnect.
    await db().query(`update devices set online = false, updated_at = now() where connector_id not like 'internal:%' and online`);

    let sweeping = false;
    let lastSweepError = 0;
    st.timers.push(
      setInterval(() => {
        if (sweeping) return;
        sweeping = true;
        sweep()
          .catch((e) => {
            // Throttle: a database outage would otherwise log every second.
            if (Date.now() - lastSweepError > 30_000) {
              lastSweepError = Date.now();
              console.error(`[ghost] lease sweep failed (will retry every 1s): ${(e as Error).message || e}`);
            }
          })
          .finally(() => (sweeping = false));
      }, 1000),
    );
    st.timers.push(setInterval(() => void heartbeatSweep().catch(() => {}), 2500));
    st.timers.push(setInterval(() => pingConnectors(), 10_000));
    for (const t of st.timers) t.unref?.();

    if (!opts.skipAdapters && process.env.GHOST_SKIP_ADAPTERS !== "1") void discoverAdapters();

    const app = createApiApp();
    const requestListener = getRequestListener(app.fetch) as Coordinator["requestListener"];
    const channel = createDeviceChannel();
    const coordinator: Coordinator = {
      app,
      requestListener,
      ownsPath,
      handleUpgrade(req, socket, head) {
        const pathname = new URL(req.url ?? "/", "http://x").pathname;
        if (pathname !== DEVICE_CHANNEL_PATH) return false;
        channel.handleUpgrade(req, socket, head);
        return true;
      },
      async stop() {
        for (const t of st.timers) clearInterval(t);
        st.timers = [];
        for (const s of st.connectors.values()) {
          try {
            s.socket.close(1001, "coordinator stopping");
          } catch {
            /* ignore */
          }
        }
        st.connectors.clear();
        channel.wss.close();
        await db().close().catch(() => {});
        st.db = null;
        st.dbPromise = null;
        st.started = null;
      },
    };

    if (opts.listenPort) {
      const server = http.createServer((req, res) => {
        void requestListener(req, res);
      });
      server.on("upgrade", (req, socket, head) => {
        if (!coordinator.handleUpgrade(req, socket, head)) socket.destroy();
      });
      await new Promise<void>((resolve) => server.listen(opts.listenPort, opts.hostname ?? "0.0.0.0", resolve));
      const stop = coordinator.stop;
      coordinator.stop = async () => {
        server.closeAllConnections?.();
        await new Promise<void>((r) => server.close(() => r()));
        await stop();
      };
      log("info", `coordinator listening on http://${opts.hostname ?? "0.0.0.0"}:${opts.listenPort} (standalone, no Next.js)`);
    }
    return coordinator;
  })();
  st.started.catch(() => {
    st.started = null;
  });
  return st.started as Promise<Coordinator>;
}

export { emit, subscribe } from "./events";
export { getPrincipal } from "./auth";
export { publishFromAdapter } from "./registry";
