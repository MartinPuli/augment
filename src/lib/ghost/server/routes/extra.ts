import type { Hono } from "hono";
import { mountProxyRoutes } from "./proxy";
import { mountLanRoutes } from "./lan";

/**
 * Extra coordinator routes contributed by workstreams. Mounted under /api/v1 by the core HTTP app.
 * Each mount function receives the /api/v1 sub-app.
 */
export function mountExtraRoutes(app: Hono) {
  mountProxyRoutes(app);
  mountLanRoutes(app);
}
