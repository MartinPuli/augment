import type { IncomingMessage } from "node:http";
import { experimental_upgradeWebSocket } from "@vercel/functions";
import { attachSocket } from "@/lib/ghost/server/channel";
import { startCoordinator } from "@/lib/ghost/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return Response.json({error:"WebSocket upgrade required"},{status:426});
  await startCoordinator();
  return experimental_upgradeWebSocket(socket => {
    const url = new URL(request.url);
    const headers = Object.fromEntries(request.headers.entries());
    headers.host ??= url.host;
    headers["x-forwarded-proto"] ??= url.protocol.replace(":", "");
    attachSocket(socket, {headers,socket:{encrypted:url.protocol === "https:"}} as unknown as IncomingMessage);
    // Close cleanly before the Function deadline. Clients reconnect with their saved credential.
    const reconnect = setTimeout(() => socket.close(1012,"reconnect"), 270_000);
    reconnect.unref();
    socket.once("close", () => clearTimeout(reconnect));
  }, {maxPayload:1024*1024});
}
