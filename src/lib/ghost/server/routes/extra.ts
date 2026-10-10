import { mountAccountRoutes } from "../accounts";
import type { Hono } from "hono";
import { mountProxyRoutes } from "./proxy";
import { mountLanRoutes } from "./lan";

/** Physical device discovery and operator media. General software services are retired. */
export function mountExtraRoutes(app: Hono) {
  mountAccountRoutes(app);
  mountProxyRoutes(app);
  mountLanRoutes(app);
}
