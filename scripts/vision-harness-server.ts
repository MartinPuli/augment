/**
 * Dev-only harness server for the live-view widget: serves a prebuilt bundle directory and mounts the
 * real proxy routes at /api/v1. Usage: tsx scripts/vision-harness-server.ts <dir> [port]
 */
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { mountProxyRoutes } from "../src/lib/ghost/server/routes/proxy";

const dir = process.argv[2];
const port = Number(process.argv[3] ?? 4799);
const app = new Hono();
const v1 = new Hono();
mountProxyRoutes(v1);
app.route("/api/v1", v1);
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".ts": "text/javascript", ".css": "text/css" };
app.get("*", (c) => {
  let p = new URL(c.req.url).pathname;
  if (p === "/") p = "/index.html";
  let f = path.join(dir, p);
  if (!fs.existsSync(f) && fs.existsSync(`${f}.js`)) f = `${f}.js`;
  if (!f.startsWith(dir) || !fs.existsSync(f)) return c.text("not found", 404);
  return new Response(fs.readFileSync(f), { headers: { "content-type": types[path.extname(p)] ?? "application/octet-stream", "cache-control": "no-store" } });
});
serve({ fetch: app.fetch, port });
console.log(`harness on http://localhost:${port}`);
