import type { NextConfig } from "next";
import { withInterfere } from "@interfere/next/config";

// Interfere (optional partner integration): enabled only when both keys are set at build time
// (production builds publish release metadata/source maps with the secret key). See docs/partners-infra.md.
const interfere = !!process.env.INTERFERE_PUBLIC_KEY && !!process.env.INTERFERE_API_KEY;
if (process.env.INTERFERE_PUBLIC_KEY && !interfere) console.warn("[interfere] INTERFERE_API_KEY is not set: Interfere build integration disabled");

// Phones reach the dev server through a tunnel or the LAN; let them load dev assets/HMR.
const publicHost = (() => {
  try {
    return process.env.NEXT_PUBLIC_PUBLIC_ORIGIN ? new URL(process.env.NEXT_PUBLIC_PUBLIC_ORIGIN).hostname : null;
  } catch {
    return null;
  }
})();

const nextConfig: NextConfig = {
  devIndicators: false,
  serverExternalPackages: ["@electric-sql/pglite", "agentmail", "@mastra/core", "@mastra/libsql", "@mastra/pg", "@mastra/observability", "libsql", "@libsql/client"],
  outputFileTracingIncludes: { "/*": ["./resources/hardware-skills/**/*"] },
  // Deploy the UI independently while the live device coordinator owns its sockets.
  async rewrites() {
    const coordinator = process.env.VERCEL === "1" ? undefined : process.env.GHOST_COORDINATOR_ORIGIN?.replace(/\/+$/, "");
    return coordinator ? [
      { source: "/api/v1/:path*", destination: `${coordinator}/api/v1/:path*` },
      { source: "/mcp", destination: `${coordinator}/mcp` },
      { source: "/mcp/:path*", destination: `${coordinator}/mcp/:path*` },
    ] : [];
  },
  allowedDevOrigins: [
    ...(publicHost ? [publicHost] : []),
    "*.trycloudflare.com",
    "*.ngrok-free.app",
    "*.ngrok.app",
    "*.fly.dev",
    "*.local",
    "192.168.*.*",
    "10.*.*.*",
    "172.*.*.*",
  ],
  ...(interfere ? { env: { NEXT_PUBLIC_GHOST_INTERFERE: "1" } } : {}),
};

export default interfere ? withInterfere(nextConfig) : nextConfig;
