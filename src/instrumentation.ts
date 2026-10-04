/**
 * Next.js server instrumentation. Interfere (optional partner integration) is loaded only when
 * INTERFERE_PUBLIC_KEY is set; otherwise both hooks are no-ops and nothing is imported.
 * See src/lib/observability/report.ts and docs/partners-infra.md.
 */
import type { Instrumentation } from "next";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.INTERFERE_PUBLIC_KEY) return;
  const { ensureInterfereServer } = await import("./lib/observability/report");
  await ensureInterfereServer("ghost");
}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.INTERFERE_PUBLIC_KEY) return;
  const { onRequestError } = await import("@interfere/next/server");
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(request.headers)) if (typeof v === "string") headers[k] = v;
  await onRequestError(err as Error & { digest?: string }, { path: request.path, method: request.method, headers }, context);
};
