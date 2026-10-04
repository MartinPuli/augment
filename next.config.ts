import type { NextConfig } from "next";
import { withInterfere } from "@interfere/next/config";

// Interfere (optional partner integration): enabled only when both keys are set at build time
// (production builds publish release metadata/source maps with the secret key). See docs/partners-infra.md.
const interfere = !!process.env.INTERFERE_PUBLIC_KEY && !!process.env.INTERFERE_API_KEY;
if (process.env.INTERFERE_PUBLIC_KEY && !interfere) console.warn("[interfere] INTERFERE_API_KEY is not set: Interfere build integration disabled");

const nextConfig: NextConfig = {
  /* config options here */
  ...(interfere ? { env: { NEXT_PUBLIC_GHOST_INTERFERE: "1" } } : {}),
};

export default interfere ? withInterfere(nextConfig) : nextConfig;
