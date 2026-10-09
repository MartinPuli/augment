import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { AccessType, DeviceClass, InvokeRequest, QuoteRequest, SearchQuery } from "../contracts";
import type { RecordExperienceRequest, TermsPatch } from "../client/api-types";
import { getPrincipal, getPrincipalOptional, me } from "./auth";
import { listHardwareGuides, readHardwareGuide } from "./hardware-guides";
import { dbReady } from "./db";
import { recallDeviceConnections } from "./device-connections";
import { subscribe } from "./events";
import { recallExperience, recordExperience } from "./experiences";
import {
  getInvocation,
  getObservation,
  getObservationMedia,
  invoke,
  MAX_UPLOAD_BYTES,
  uploadObservation,
} from "./invocations";
import { getLedger } from "./ledger";
import { acceptQuote, approveLease, getLease, getOffer, listLeases, quote, releaseLease, revokeLease } from "./leases";
import { handleMcp } from "./mcp";
import { createPoppyApp, poppyOptionsFromEnv } from "./poppy/routes";
import type { PoppyOptions } from "./poppy/auth";
import { confirmPairing, createPairing, listConnectors, listPairings, rejectPairing } from "./pairings";
import { listDevices, requireDevice, searchCapabilities, updateTerms } from "./registry";
import { mountExtraRoutes } from "./routes/extra";
import { bad, GhostError, notFound } from "./util";

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw bad("request body must be valid JSON");
  }
}

function originOf(c: Context): string {
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host") || c.req.header("host") || url.host;
  return `${proto}://${host}`;
}

/** Parse GET /capabilities query params into a SearchQuery. */
export function parseSearchQuery(p: Record<string, string | undefined>): SearchQuery {
  const sq: SearchQuery = {};
  if (p.q) sq.q = p.q;
  if (p.semantic_type) sq.semantic_type = p.semantic_type;
  if (p.device_class) sq.device_class = p.device_class as DeviceClass;
  if (p.access_type) sq.access_type = p.access_type as AccessType;
  if (p.zone_id) sq.zone_id = p.zone_id;
  if (p.near) {
    const [lat, lon] = p.near.split(",").map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw bad("near must be 'lat,lon'");
    sq.near = { lat, lon };
    if (p.radius_km) sq.near.radius_km = Number(p.radius_km);
  }
  if (p.only_online === "1" || p.only_online === "true") sq.only_online = true;
  if (p.limit) sq.limit = Number(p.limit);
  return sq;
}

function v1Routes(): Hono {
  const v1 = new Hono();

  v1.get("/health", (c) => c.json({ ok: true, protocol: "ghost/0.1", at: new Date().toISOString() }));
  v1.get("/me", async (c) => c.json(await me(c)));

  v1.get("/hardware-guides", c => c.json(listHardwareGuides(c.req.query("q"))));
  v1.get("/hardware-guides/:id", async c => c.json(await readHardwareGuide(c.req.param("id"), c.req.query("file"), Number(c.req.query("offset") ?? 0))));

  /* catalog */
  v1.get("/device-connections", async (c) => c.json(await recallDeviceConnections(await getPrincipal(c), {
    query: c.req.query("q"), device_id: c.req.query("device_id"), limit: Number(c.req.query("limit")) || undefined,
  })));
  v1.get("/capabilities", async (c) => {
    const viewer = await getPrincipalOptional(c);
    return c.json(await searchCapabilities(parseSearchQuery(c.req.query()), viewer?.principal_id ?? null));
  });
  v1.get("/devices", async (c) => {
    const mine = c.req.query("mine");
    if (mine === "1" || mine === "true") return c.json(await listDevices({ owner_id: await getPrincipal(c) }));
    return c.json(await listDevices());
  });
  v1.get("/devices/:id", async (c) => c.json(await requireDevice(c.req.param("id"))));
  v1.patch("/devices/:id/terms", async (c) => {
    const pid = await getPrincipal(c);
    return c.json(await updateTerms(pid, c.req.param("id"), await body<TermsPatch>(c)));
  });

  /* leases */
  v1.post("/quotes", async (c) => c.json(await quote(await getPrincipal(c), await body<QuoteRequest>(c))));
  v1.get("/quotes/:id", async (c) => c.json(await getOffer(await getPrincipal(c), c.req.param("id"))));
  v1.post("/quotes/:id/accept", async (c) => {
    const pid = await getPrincipal(c);
    const b = await body<{ offer_id?: string; max_spend_cents: number }>(c);
    if (b.offer_id && b.offer_id !== c.req.param("id")) throw bad("offer_id in body does not match the URL");
    return c.json(await acceptQuote(pid, c.req.param("id"), b.max_spend_cents));
  });
  v1.get("/leases", async (c) => {
    const pid = await getPrincipal(c);
    const role = c.req.query("role");
    const active = c.req.query("active");
    return c.json(
      await listLeases(pid, {
        role: role === "visitor" || role === "owner" ? role : undefined,
        active: active === "1" || active === "true",
      }),
    );
  });
  v1.get("/leases/:id", async (c) => c.json(await getLease(await getPrincipal(c), c.req.param("id"))));
  v1.post("/leases/:id/release", async (c) => c.json({ lease: await releaseLease(await getPrincipal(c), c.req.param("id")) }));
  v1.post("/leases/:id/revoke", async (c) => c.json({ lease: await revokeLease(await getPrincipal(c), c.req.param("id")) }));
  v1.post("/leases/:id/approve", async (c) => c.json({ lease: await approveLease(await getPrincipal(c), c.req.param("id")) }));

  /* invocations + observations */
  v1.post("/invoke", async (c) => {
    const pid = await getPrincipal(c);
    return c.json(await invoke(pid, await body<InvokeRequest>(c), { origin: originOf(c) }));
  });
  v1.get("/invocations/:id", async (c) => c.json(await getInvocation(await getPrincipal(c), c.req.param("id"))));
  v1.post("/invocations/:id/observation", async (c) => {
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > MAX_UPLOAD_BYTES) throw new GhostError(413, "observation media too large (max 8MB)", "too_large");
    const auth = c.req.header("authorization") ?? "";
    const token = /^Bearer\s+(.+)$/i.exec(auth.trim())?.[1] ?? null;
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const r = await uploadObservation({
      invocation_id: c.req.param("id"),
      token,
      content_type: c.req.header("content-type") ?? null,
      bytes,
      captured_at: c.req.header("x-captured-at") ?? null,
      note: c.req.header("x-observation-note") ?? null,
    });
    return c.json(r, 201);
  });
  // Observation ids are unguessable; holding the id is the capability to read it (so <img src> works).
  v1.get("/observations/:id", async (c) => {
    const o = await getObservation(c.req.param("id"));
    if (!o) throw notFound("observation not found");
    return c.json(o);
  });
  v1.get("/observations/:id/media", async (c) => {
    const m = await getObservationMedia(c.req.param("id"));
    if (!m) throw notFound("no media for this observation");
    return c.body(m.bytes as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": m.media_type,
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Length": String(m.bytes.byteLength),
      "X-Content-Type-Options": "nosniff",
    });
  });

  /* pairing + connectors */
  v1.post("/pairings", async (c) => c.json(await createPairing(await getPrincipal(c)), 201));
  v1.get("/pairings", async (c) => {
    const pending = c.req.query("pending");
    return c.json(await listPairings(await getPrincipal(c), { pending: pending === "1" || pending === "true" }));
  });
  v1.post("/pairings/:id/confirm", async (c) => c.json(await confirmPairing(await getPrincipal(c), c.req.param("id"))));
  v1.post("/pairings/:id/reject", async (c) => c.json(await rejectPairing(await getPrincipal(c), c.req.param("id"))));
  v1.get("/connectors", async (c) => c.json(await listConnectors(await getPrincipal(c))));

  /* memory + ledger */
  v1.post("/experiences", async (c) => c.json(await recordExperience(await getPrincipal(c), await body<RecordExperienceRequest>(c)), 201));
  v1.get("/experiences", async (c) => {
    const mine = c.req.query("mine");
    const visitor_id = mine === "1" || mine === "true" ? await getPrincipal(c) : undefined;
    const limit = c.req.query("limit");
    return c.json(await recallExperience(c.req.query("q") ?? undefined, { limit: limit ? Number(limit) : undefined, visitor_id }));
  });
  v1.get("/ledger", async (c) => c.json(await getLedger(await getPrincipal(c))));

  /* live events */
  v1.get("/events", (c) => {
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      let closed = false;
      const unsub = subscribe((e) => {
        if (!closed) void stream.writeSSE({ data: JSON.stringify(e) }).catch(() => {});
      });
      const ka = setInterval(() => {
        if (!closed) void stream.write(": keep-alive\n\n").catch(() => {});
      }, 15_000);
      await stream.write(": connected\n\n");
      await new Promise<void>((resolve) => stream.onAbort(() => resolve()));
      closed = true;
      clearInterval(ka);
      unsub();
    });
  });

  mountExtraRoutes(v1);
  return v1;
}

/** The coordinator HTTP app: /api/v1/* and /mcp. */
export function createApiApp(options: { poppy?: PoppyOptions } = {}): Hono {
  const app = new Hono();
  app.use("*", async (_c, next) => {
    await dbReady();
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof GhostError) return c.json({ error: err.message, code: err.code }, err.status as 400);
    const status = (err as { status?: number }).status;
    if (typeof status === "number" && status >= 400 && status < 600) return c.json({ error: err.message }, status as 400);
    console.error("[ghost] unhandled API error", err);
    return c.json({ error: "internal error", detail: (err as Error).message }, 500);
  });
  app.notFound((c) => c.json({ error: `no route for ${c.req.method} ${new URL(c.req.url).pathname}` }, 404));
  const poppy = options.poppy ?? poppyOptionsFromEnv();
  if (poppy) app.route("/", createPoppyApp(poppy));
  app.route("/api/v1", v1Routes());
  app.all("/mcp", handleMcp);
  app.all("/mcp/*", handleMcp);
  return app;
}
