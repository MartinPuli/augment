/**
 * GHOST custom server: one HTTP server for Next.js + the coordinator.
 *
 *   /api/v1/*, /mcp          -> coordinator (Hono)
 *   WS /v1/device-channel    -> coordinator device channel (ws)
 *   every other request      -> Next.js (incl. src/app/api/* route handlers)
 *   every other WS upgrade   -> Next.js (HMR)
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

import http from "node:http";
import next from "next";
import { startCoordinator } from "./src/lib/ghost/server";

const dev = process.env.NODE_ENV !== "production";
const port = Number.parseInt(process.env.PORT || "3000", 10);
const hostname = process.env.HOST || "0.0.0.0";

async function main() {
  const coordinator = await startCoordinator();

  const server = http.createServer();
  const app = next({ dev, turbopack: true, hostname: "localhost", port, httpServer: server });
  const handle = app.getRequestHandler();
  await app.prepare();
  // Next's request handler would otherwise attach its own 'upgrade' listener to this server on the
  // first request (and see device-channel upgrades too). We route upgrades ourselves instead:
  // the device channel goes to the coordinator, everything else (HMR) to Next's router-server handler.
  type Upgrade = (req: http.IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => Promise<void>;
  const internals = app as unknown as { didWebSocketSetup?: boolean; upgradeHandler?: Upgrade };
  internals.didWebSocketSetup = true;
  const nextUpgrade: Upgrade = internals.upgradeHandler ?? (app.getUpgradeHandler() as Upgrade);

  server.on("request", (req, res) => {
    const pathname = (req.url ?? "/").split("?")[0];
    if (coordinator.ownsPath(pathname)) {
      void coordinator.requestListener(req, res);
      return;
    }
    handle(req, res).catch((e) => {
      console.error("[next] request failed", e);
      if (!res.headersSent) res.statusCode = 500;
      res.end("internal error");
    });
  });

  server.on("upgrade", (req, socket, head) => {
    if (coordinator.handleUpgrade(req, socket, head)) return;
    nextUpgrade(req, socket, head).catch(() => socket.destroy());
  });

  server.listen(port, hostname, () => {
    console.log(`> GHOST ready on http://localhost:${port} (${dev ? "development" : "production"}) — listening on ${hostname}:${port}`);
    console.log(`> device channel ws://localhost:${port}/v1/device-channel · MCP http://localhost:${port}/mcp`);
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`> ${signal}: shutting down`);
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    try {
      server.closeAllConnections?.();
      server.close();
      await coordinator.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
