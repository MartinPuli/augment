/**
 * Browser instrumentation (runs before the app is interactive). Interfere (optional partner
 * integration) captures uncaught client errors, console logs and session context. It is only
 * loaded when the build was configured with INTERFERE_PUBLIC_KEY (next.config.ts sets
 * NEXT_PUBLIC_GHOST_INTERFERE=1 and wraps the config with withInterfere).
 */
if (process.env.NEXT_PUBLIC_GHOST_INTERFERE === "1") {
  import("@interfere/next/instrument-client")
    .then((m) => m.init())
    .catch((e) => console.warn("[interfere] client init failed", e));
}
