/**
 * Production visibility for the GHOST coordinator via Interfere (optional, server-only).
 *
 * Next.js errors (Server Components, route handlers) are captured by `src/instrumentation.ts`
 * and browser errors by `src/instrumentation-client.ts`. The coordinator (Hono + device
 * channel) runs in the custom server *outside* Next's request pipeline, so its failures are
 * reported here: unhandled API errors, failed / timed-out invocations, device-channel drops,
 * mission failures.
 *
 * Everything is a no-op unless INTERFERE_PUBLIC_KEY is set (and, as in Interfere's SDK,
 * NODE_ENV=production or NEXT_PUBLIC_INTERFERE_FORCE_ENABLE=1). Uses only Interfere's
 * documented server API (`register`, `captureError` from @interfere/next) plus standard
 * OpenTelemetry spans, which Interfere's tracer provider exports.
 *
 * Never put secrets (tokens, pairing codes, upload tokens) in `attrs`.
 */
import { context as otelContext, SpanStatusCode, trace, type Attributes } from "@opentelemetry/api";

export function interfereConfigured(): boolean {
  return !!process.env.INTERFERE_PUBLIC_KEY?.trim();
}

function active(): boolean {
  return interfereConfigured() && (process.env.NODE_ENV === "production" || !!process.env.NEXT_PUBLIC_INTERFERE_FORCE_ENABLE);
}

/**
 * Register Interfere's OpenTelemetry pipeline once per process. Shared guard on globalThis so
 * Next's instrumentation hook and the coordinator (different module instances, same process)
 * never register twice.
 */
export function ensureInterfereServer(serviceName = "ghost"): Promise<boolean> {
  if (!interfereConfigured()) return Promise.resolve(false);
  const g = globalThis as unknown as { __ghostInterfere?: Promise<boolean> };
  if (!g.__ghostInterfere) {
    g.__ghostInterfere = (async () => {
      try {
        const m = await import("@interfere/next/instrumentation");
        await m.register({ serviceName });
        return true;
      } catch (e) {
        console.warn("[interfere] server registration failed:", (e as Error).message);
        return false;
      }
    })();
  }
  return g.__ghostInterfere;
}

/** Attributes allowed in reports: primitives only, ids not secrets. */
export type ReportAttrs = Record<string, string | number | boolean | null | undefined>;

function clean(attrs: ReportAttrs | undefined): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== undefined && v !== null) out[`ghost.${k}`] = v;
  return out;
}

/**
 * Report a coordinator error with context (e.g. { where: "invoke", device_id, invocation_id }).
 * Fire-and-forget; never throws.
 */
export function reportError(err: unknown, where: string, attrs?: ReportAttrs): void {
  if (!active()) return;
  void (async () => {
    try {
      if (!(await ensureInterfereServer())) return;
      const { captureError } = await import("@interfere/next/server");
      const tracer = trace.getTracer("ghost-coordinator");
      const span = tracer.startSpan(`ghost.${where}`, { attributes: clean(attrs) });
      otelContext.with(trace.setSpan(otelContext.active(), span), () => captureError(err));
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      span.end();
    } catch {
      /* reporting must never break the coordinator */
    }
  })();
}

/**
 * Record a notable coordinator event as an OpenTelemetry span (e.g. "invocation.timeout",
 * "device.offline", "mission.failed"). `failed: true` marks the span as an error.
 */
export function reportEvent(name: string, attrs?: ReportAttrs, opts: { failed?: boolean } = {}): void {
  if (!active()) return;
  void (async () => {
    try {
      if (!(await ensureInterfereServer())) return;
      const span = trace.getTracer("ghost-coordinator").startSpan(`ghost.${name}`, { attributes: clean(attrs) });
      if (opts.failed) span.setStatus({ code: SpanStatusCode.ERROR, message: name });
      span.end();
    } catch {
      /* ignore */
    }
  })();
}
