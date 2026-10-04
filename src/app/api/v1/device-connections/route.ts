import { Hono } from "hono";
import { getPrincipal } from "@/lib/ghost/server/auth";
import { openDb } from "@/lib/ghost/server/db";
import { recallDeviceConnections } from "@/lib/ghost/server/device-connections";
import { GhostError } from "@/lib/ghost/server/util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read the same durable catalog as the socket coordinator without booting a second
// coordinator (which would incorrectly mark its connected devices offline).
const app = new Hono();
app.get("*", async (c) => {
  if (!process.env.DATABASE_URL) return c.json({ error: "Connection memory needs DATABASE_URL on this deployment." }, 503);
  await openDb();
  return c.json(await recallDeviceConnections(await getPrincipal(c), {
    query: c.req.query("q"),
    device_id: c.req.query("device_id"),
    limit: Number(c.req.query("limit")) || 10,
  }));
});
app.onError((error, c) => {
  if (error instanceof GhostError) return c.json({ error: error.message, code: error.code }, error.status as 400);
  console.error("[ghost] connection memory unavailable", error.message);
  return c.json({ error: "Connection memory is temporarily unavailable." }, 503);
});

export const GET = (request: Request) => app.fetch(request);
