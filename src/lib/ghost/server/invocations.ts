import { distributed } from "./cluster";
import type {
  CapabilitySpec,
  Device,
  Invocation,
  InvocationState,
  InvokeRequest,
  InvokeResponse,
  Observation,
  ObservationKind,
} from "../contracts";
import { internalAdapters } from "./adapters";
import type { ObservationInput } from "./adapters/types";
import { db, type Queryable } from "./db";
import { emit, log } from "./events";
import { authorizeAndConsume } from "./leases";
import { findCapability, requireDevice, setDeviceStatus } from "./registry";
import { validateSchema } from "./schema";
import { connectorOnline, rateLimit, S, sendToConnector } from "./state";
import {
  bad,
  conflict,
  GhostError,
  id,
  iso,
  isoOrNull,
  isUniqueViolation,
  json,
  notFound,
  secretToken,
  sha256,
  tooMany,
  unauthorized,
} from "./util";

export const DEFAULT_TIMEOUT_MS = 20_000;
export const MAX_TIMEOUT_MS = 120_000;
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const PUBLIC_RATE_PER_MIN = 20;

const TERMINAL: InvocationState[] = ["succeeded", "failed", "rejected", "unknown"];

type InvocationRow = {
  invocation_id: string;
  lease_id: string | null;
  visitor_id: string;
  device_id: string;
  capability_id: string;
  arguments: unknown;
  state: InvocationState;
  error: string | null;
  observation_id: string | null;
  output: unknown;
  idempotency_key: string | null;
  lease_revision: number | null;
  upload_token_hash: string | null;
  upload_expires_at: unknown;
  upload_used: boolean;
  deadline: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type ObservationRow = {
  observation_id: string;
  invocation_id: string | null;
  device_id: string;
  capability_id: string;
  kind: ObservationKind;
  captured_at: unknown;
  retrieved_at: unknown;
  media_type: string | null;
  has_media: boolean;
  body: unknown;
};

export function rowToInvocation(r: InvocationRow): Invocation {
  return {
    invocation_id: r.invocation_id,
    lease_id: r.lease_id,
    visitor_id: r.visitor_id,
    device_id: r.device_id,
    capability_id: r.capability_id,
    arguments: json<Record<string, unknown>>(r.arguments) ?? {},
    state: r.state,
    ...(r.error ? { error: r.error } : {}),
    observation_id: r.observation_id,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    deadline: iso(r.deadline),
  };
}

const OBS_COLS = `observation_id, invocation_id, device_id, capability_id, kind, captured_at, retrieved_at, media_type,
  (media is not null) as has_media, body`;

export function rowToObservation(r: ObservationRow): Observation {
  const body = json<Partial<Observation>>(r.body) ?? {};
  return {
    ...body,
    observation_id: r.observation_id,
    invocation_id: r.invocation_id,
    device_id: r.device_id,
    capability_id: r.capability_id,
    kind: r.kind,
    captured_at: isoOrNull(r.captured_at),
    retrieved_at: iso(r.retrieved_at),
    ...(r.has_media ? { media_url: `/api/v1/observations/${r.observation_id}/media`, media_type: r.media_type ?? undefined } : {}),
  };
}

export async function getInvocationRaw(invocation_id: string, q: Queryable = db()): Promise<Invocation | null> {
  const r = await q.query<InvocationRow>(`select * from invocations where invocation_id = $1`, [invocation_id]);
  return r.rows[0] ? rowToInvocation(r.rows[0]) : null;
}

export async function getObservation(observation_id: string): Promise<Observation | null> {
  const r = await db().query<ObservationRow>(`select ${OBS_COLS} from observations where observation_id = $1`, [observation_id]);
  return r.rows[0] ? rowToObservation(r.rows[0]) : null;
}

export async function getObservationMedia(observation_id: string): Promise<{ bytes: Uint8Array; media_type: string } | null> {
  const r = await db().query<{ media: Uint8Array | null; media_type: string | null }>(
    `select media, media_type from observations where observation_id = $1`,
    [observation_id],
  );
  const row = r.rows[0];
  if (!row || !row.media) return null;
  return { bytes: new Uint8Array(row.media), media_type: row.media_type ?? "application/octet-stream" };
}

/** Invocation visible to its visitor and to the device owner. */
export async function getInvocation(principal_id: string, invocation_id: string): Promise<InvokeResponse> {
  const inv = await getInvocationRaw(invocation_id);
  if (!inv) throw notFound("invocation not found");
  if (inv.visitor_id !== principal_id) {
    const d = await requireDevice(inv.device_id).catch(() => null);
    if (!d || d.owner_id !== principal_id) throw notFound("invocation not found");
  }
  return { invocation: inv, observation: inv.observation_id ? await getObservation(inv.observation_id) : null };
}

/* ------------------------------------------------------------------ */
/* Observations                                                        */
/* ------------------------------------------------------------------ */

function kindForMedia(mt: string): ObservationKind {
  if (mt.startsWith("image/")) return "image";
  if (mt.startsWith("audio/")) return "audio";
  if (mt.startsWith("text/")) return "text";
  return "value";
}

export async function storeObservation(
  args: {
    invocation_id: string | null;
    device: Device;
    capability_id: string;
    input: ObservationInput;
  },
  q: Queryable = db(),
): Promise<Observation> {
  const observation_id = id("obs");
  const { input, device } = args;
  const body: Partial<Observation> = {};
  if (input.stream) body.stream = input.stream;
  if (input.value !== undefined) body.value = input.value;
  if (input.unit !== undefined) body.unit = input.unit;
  if (input.data !== undefined) body.data = input.data;
  if (device.zone_id) body.zone_id = device.zone_id;
  const source = input.source ?? (device.source ? { name: device.source.operator, url: device.source.url, attribution: device.source.attribution } : undefined);
  if (source) body.source = source;
  if (input.note) body.note = input.note;
  let captured: string | null = null;
  if (input.captured_at) {
    const t = Date.parse(input.captured_at);
    captured = Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const media = input.media ? Buffer.from(input.media.bytes) : null;
  if (media && media.byteLength > MAX_UPLOAD_BYTES) throw new GhostError(413, "observation media too large (max 8MB)", "too_large");
  const r = await q.query<ObservationRow>(
    `insert into observations (observation_id, invocation_id, device_id, capability_id, kind, captured_at, media, media_type, body)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) returning ${OBS_COLS}`,
    [
      observation_id,
      args.invocation_id,
      device.device_id,
      args.capability_id,
      input.kind,
      captured,
      media,
      input.media?.content_type ?? null,
      JSON.stringify(body),
    ],
  );
  const obs = rowToObservation(r.rows[0]);
  emit({ type: "observation.created", observation: obs });
  return obs;
}

/** POST /api/v1/invocations/:id/observation — connector uploads media with its one-use token. */
export async function uploadObservation(args: {
  invocation_id: string;
  token: string | null;
  content_type: string | null;
  bytes: Uint8Array;
  captured_at?: string | null;
  note?: string | null;
}): Promise<{ observation_id: string }> {
  if (!args.token) throw unauthorized("upload token required (Authorization: Bearer <token>)");
  const r = await db().query<InvocationRow>(`select * from invocations where invocation_id = $1`, [args.invocation_id]);
  const inv = r.rows[0];
  if (!inv || !inv.upload_token_hash || inv.upload_token_hash !== sha256(args.token)) throw unauthorized("invalid upload token");
  if (inv.upload_used) throw conflict("upload token already used");
  if (inv.upload_expires_at && new Date(iso(inv.upload_expires_at)).getTime() < Date.now()) throw new GhostError(410, "upload token expired", "expired");
  if (args.bytes.byteLength === 0) throw bad("empty body");
  if (args.bytes.byteLength > MAX_UPLOAD_BYTES) throw new GhostError(413, "observation media too large (max 8MB)", "too_large");
  const ct = (args.content_type ?? "").split(";")[0].trim().toLowerCase();
  if (!ct) throw bad("Content-Type required");
  const device = await requireDevice(inv.device_id);
  const cap = findCapability(device, inv.capability_id);
  const expected = cap?.output?.media?.toLowerCase();
  if (expected) {
    const ok = expected.endsWith("/*") ? ct.startsWith(expected.slice(0, -1)) : ct === expected || (expected.startsWith("image/") && ct.startsWith("image/"));
    if (!ok) throw new GhostError(415, `media type ${ct} does not match capability output ${expected}`, "unsupported_media");
  }
  // Claim the token atomically (one use).
  const claim = await db().query(`update invocations set upload_used = true where invocation_id = $1 and upload_used = false`, [inv.invocation_id]);
  if (claim.rowCount === 0) throw conflict("upload token already used");
  let captured: string | null = null;
  if (args.captured_at) {
    const t = Date.parse(args.captured_at);
    if (Number.isFinite(t)) captured = new Date(t).toISOString();
  }
  const obs = await storeObservation({
    invocation_id: inv.invocation_id,
    device,
    capability_id: inv.capability_id,
    input: {
      kind: kindForMedia(ct),
      media: { bytes: args.bytes, content_type: ct },
      captured_at: captured,
      note: args.note ?? undefined,
    },
  });
  return { observation_id: obs.observation_id };
}

/* ------------------------------------------------------------------ */
/* Finalization + waiting                                              */
/* ------------------------------------------------------------------ */

async function finalize(
  invocation_id: string,
  patch: { state: InvocationState; error?: string | null; observation_id?: string | null; output?: unknown },
  opts: { allowFromUnknown?: boolean } = {},
): Promise<Invocation | null> {
  const from = opts.allowFromUnknown ? `('accepted','running','unknown')` : `('accepted','running')`;
  const r = await db().query<InvocationRow>(
    `update invocations set state = $2, error = $3, observation_id = coalesce($4, observation_id),
            output = coalesce($5::jsonb, output), updated_at = now()
     where invocation_id = $1 and state in ${from} returning *`,
    [invocation_id, patch.state, patch.error ?? null, patch.observation_id ?? null, patch.output === undefined ? null : JSON.stringify(patch.output)],
  );
  if (!r.rows[0]) return null;
  const inv = rowToInvocation(r.rows[0]);
  emit({ type: "invocation.updated", invocation: inv });
  if (TERMINAL.includes(inv.state)) {
    const ws = S().waiters.get(invocation_id) ?? [];
    S().waiters.delete(invocation_id);
    for (const w of ws) w.resolve(inv);
    if (inv.state === "succeeded") await setDeviceStatus(inv.device_id, "verified").catch(() => {});
  }
  return inv;
}

function waitFor(invocation_id: string, ms: number): Promise<Invocation | null> {
  return new Promise((resolve) => {
    const st = S();
    const timer = setTimeout(() => {
      const list = st.waiters.get(invocation_id) ?? [];
      st.waiters.set(
        invocation_id,
        list.filter((w) => w !== waiter),
      );
      resolve(null);
    }, ms);
    const waiter = {
      resolve: (inv: Invocation) => {
        clearTimeout(timer);
        resolve(inv);
      },
    };
    st.waiters.set(invocation_id, [...(st.waiters.get(invocation_id) ?? []), waiter]);
  });
}

async function waitTerminal(invocation_id: string, deadlineMs: number): Promise<Invocation> {
  const cur = await getInvocationRaw(invocation_id);
  if (cur && TERMINAL.includes(cur.state)) return cur;
  const remaining = Math.max(0, deadlineMs - Date.now());
  let done: Invocation | null = null;
  if (distributed()) {
    while (Date.now() < deadlineMs) {
      const current = await getInvocationRaw(invocation_id);
      if (current && TERMINAL.includes(current.state)) { done = current; break; }
      await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(0, deadlineMs-Date.now()))));
    }
  } else { done = await waitFor(invocation_id, remaining); }
  if (done) return done;
  // Never claim success: no result before the deadline means we don't know what happened.
  const timedOut = await finalize(invocation_id, { state: "unknown", error: "no result before the deadline; the outcome is unknown" });
  return timedOut ?? (await getInvocationRaw(invocation_id))!;
}

/* ------------------------------------------------------------------ */
/* Invoke                                                              */
/* ------------------------------------------------------------------ */

export interface InvokeOptions {
  /** Public origin used to build absolute upload URLs for connectors. */
  origin?: string;
}

function connectorOrigin(connector_id: string, fallback?: string): string {
  return (
    S().connectors.get(connector_id)?.origin ||
    fallback ||
    process.env.GHOST_PUBLIC_ORIGIN ||
    process.env.NEXT_PUBLIC_PUBLIC_ORIGIN ||
    `http://localhost:${process.env.PORT || 3000}`
  ).replace(/\/$/, "");
}

export async function invoke(visitor_id: string, req: InvokeRequest, opts: InvokeOptions = {}): Promise<InvokeResponse> {
  if (!req || typeof req.device_id !== "string" || typeof req.capability_id !== "string")
    throw bad("device_id and capability_id are required");
  const timeoutMs = Math.max(500, Math.min(MAX_TIMEOUT_MS, Number(req.timeout_ms ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS));
  const idem = typeof req.idempotency_key === "string" && req.idempotency_key ? req.idempotency_key.slice(0, 200) : null;

  if (idem) {
    const ex = await db().query<InvocationRow>(`select * from invocations where visitor_id = $1 and idempotency_key = $2`, [visitor_id, idem]);
    if (ex.rows[0]) return replay(rowToInvocation(ex.rows[0]), timeoutMs);
  }

  const device = await requireDevice(req.device_id);
  const cap = findCapability(device, req.capability_id);
  if (!cap) throw notFound(`capability ${req.capability_id} not found on ${device.name}`);
  if (device.status === "unavailable") throw conflict(`${device.name} is unavailable`);
  const args = req.arguments ?? {};
  const errs = validateSchema(cap.input_schema ?? { type: "object" }, args);
  if (errs.length) throw new GhostError(400, `invalid arguments: ${errs.join("; ")}`, "invalid_arguments");

  const internalId = device.connector_id.startsWith("internal:") ? device.connector_id.slice("internal:".length) : null;
  const adapter = internalId ? internalAdapters.find((a) => a.id === internalId) : null;
  if (internalId && !adapter) throw conflict(`adapter ${internalId} is not loaded`);
  if (!internalId && !(await connectorOnline(device.connector_id)))
    throw new GhostError(503, `${device.name} is offline (its connector is not connected)`, "offline");

  if (device.access_type === "public_observation" && device.owner_id !== visitor_id) {
    if (!await rateLimit(`pub:${visitor_id}:${device.device_id}`, PUBLIC_RATE_PER_MIN, 60_000))
      throw tooMany(`rate limit: at most ${PUBLIC_RATE_PER_MIN} public observations per minute per device`);
  }
  if (cap.limits?.rate_per_min && !await rateLimit(`cap:${visitor_id}:${device.device_id}:${cap.capability_id}`, cap.limits.rate_per_min, 60_000))
    throw tooMany(`rate limit: ${cap.capability_id} allows ${cap.limits.rate_per_min} calls per minute`);

  const invocation_id = id("inv");
  const uploadToken = internalId ? null : secretToken("upl");
  const deadline = new Date(Date.now() + timeoutMs);
  let authorized: Awaited<ReturnType<typeof authorizeAndConsume>> & { inv: Invocation };
  try {
    authorized = await db().tx(async (q) => {
      const a = await authorizeAndConsume(q, visitor_id, device, cap.capability_id, req.lease_id);
      const ins = await q.query<InvocationRow>(
        `insert into invocations (invocation_id, lease_id, visitor_id, device_id, capability_id, arguments, state, idempotency_key,
                                  lease_revision, upload_token_hash, upload_expires_at, deadline)
         values ($1,$2,$3,$4,$5,$6::jsonb,'accepted',$7,$8,$9,$10,$11) returning *`,
        [
          invocation_id,
          a.lease?.lease_id ?? null,
          visitor_id,
          device.device_id,
          cap.capability_id,
          JSON.stringify(args),
          idem,
          a.lease?.revision ?? null,
          uploadToken ? sha256(uploadToken) : null,
          uploadToken ? new Date(deadline.getTime() + 30_000).toISOString() : null,
          deadline.toISOString(),
        ],
      );
      return { ...a, inv: rowToInvocation(ins.rows[0]) };
    });
  } catch (e) {
    if (idem && isUniqueViolation(e)) {
      const ex = await db().query<InvocationRow>(`select * from invocations where visitor_id = $1 and idempotency_key = $2`, [visitor_id, idem]);
      if (ex.rows[0]) return replay(rowToInvocation(ex.rows[0]), timeoutMs);
    }
    throw e;
  }
  // Lease use count changed (or an implicit lease was created): tell consoles.
  if (authorized.lease) emit({ type: "lease.updated", lease: authorized.lease });
  const inv0 = authorized.inv;
  emit({ type: "invocation.updated", invocation: inv0 });

  if (adapter) {
    void runAdapter(adapter, device, cap, args, inv0, visitor_id, deadline);
  } else {
    const origin = connectorOrigin(device.connector_id, opts.origin);
    const sent = await sendToConnector(device.connector_id, {
      type: "invoke",
      invocation_id,
      device_id: device.device_id,
      local_key: device.local_key,
      capability_id: cap.capability_id,
      arguments: args,
      lease_id: authorized.lease?.lease_id ?? null,
      lease_revision: authorized.lease?.revision ?? 0,
      deadline: deadline.toISOString(),
      upload: { url: `${origin}/api/v1/invocations/${invocation_id}/observation`, token: uploadToken! },
    });
    if (!sent) {
      await finalize(invocation_id, { state: "failed", error: "could not deliver to the device connector (disconnected)" });
    } else {
      const r = await db().query<InvocationRow>(
        `update invocations set state = 'running', updated_at = now() where invocation_id = $1 and state = 'accepted' returning *`,
        [invocation_id],
      );
      if (r.rows[0]) emit({ type: "invocation.updated", invocation: rowToInvocation(r.rows[0]) });
    }
  }

  const inv = await waitTerminal(invocation_id, deadline.getTime());
  return { invocation: inv, observation: inv.observation_id ? await getObservation(inv.observation_id) : null };
}

async function replay(inv: Invocation, timeoutMs: number): Promise<InvokeResponse> {
  let cur = inv;
  if (!TERMINAL.includes(cur.state)) {
    const deadline = Math.min(new Date(cur.deadline).getTime(), Date.now() + timeoutMs);
    cur = await waitTerminal(cur.invocation_id, deadline);
  }
  return { invocation: cur, observation: cur.observation_id ? await getObservation(cur.observation_id) : null };
}

async function runAdapter(
  adapter: (typeof internalAdapters)[number],
  device: Device,
  cap: CapabilitySpec,
  args: Record<string, unknown>,
  inv: Invocation,
  visitor_id: string,
  deadline: Date,
): Promise<void> {
  const ac = new AbortController();
  S().aborts.set(inv.invocation_id, ac);
  const timer = setTimeout(() => ac.abort(), Math.max(0, deadline.getTime() - Date.now()));
  try {
    await db().query(`update invocations set state = 'running', updated_at = now() where invocation_id = $1 and state = 'accepted'`, [inv.invocation_id]);
    const res = await adapter.invoke(device, cap.capability_id, args, {
      invocation_id: inv.invocation_id,
      visitor_id,
      lease_id: inv.lease_id,
      deadline,
      signal: ac.signal,
    });
    let observation_id: string | null = null;
    if (res.observation) {
      const obs = await storeObservation({ invocation_id: inv.invocation_id, device, capability_id: cap.capability_id, input: res.observation });
      observation_id = obs.observation_id;
    }
    const state: InvocationState = ["succeeded", "failed", "rejected", "unknown"].includes(res.state) ? res.state : "unknown";
    await finalize(inv.invocation_id, { state, error: res.error ?? null, observation_id }, { allowFromUnknown: true });
  } catch (e) {
    const aborted = ac.signal.aborted;
    await finalize(
      inv.invocation_id,
      { state: aborted ? "unknown" : "failed", error: aborted ? "adapter did not finish before the deadline" : `adapter error: ${(e as Error).message}` },
      { allowFromUnknown: false },
    );
    if (!aborted) log("warn", `adapter ${adapter.id} failed on ${device.name}: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
    S().aborts.delete(inv.invocation_id);
  }
}

/** A connector reported a result over the device channel. */
export async function handleConnectorResult(
  connector_id: string,
  msg: {
    invocation_id: string;
    state: InvocationState;
    output?: {
      observation_id?: string;
      value?: number | string | boolean | null;
      unit?: string;
      data?: Record<string, unknown>;
      captured_at?: string | null;
      note?: string;
    };
    error?: string;
  },
): Promise<void> {
  const inv = await getInvocationRaw(msg.invocation_id);
  if (!inv) return;
  const device = await requireDevice(inv.device_id).catch(() => null);
  if (!device || device.connector_id !== connector_id) {
    log("warn", `connector ${connector_id} sent a result for an invocation it does not serve`);
    return;
  }
  const allowed: InvocationState[] = ["running", "succeeded", "failed", "rejected", "unknown"];
  if (!allowed.includes(msg.state)) return;
  if (msg.state === "running") {
    await db().query(`update invocations set state = 'running', updated_at = now() where invocation_id = $1 and state = 'accepted'`, [inv.invocation_id]);
    return;
  }
  let observation_id: string | null = null;
  const out = msg.output ?? {};
  if (out.observation_id) {
    const obs = await getObservation(out.observation_id);
    if (obs && obs.invocation_id === inv.invocation_id) observation_id = obs.observation_id;
  }
  if (!observation_id && (out.value !== undefined || out.data !== undefined || out.note)) {
    const cap = findCapability(device, inv.capability_id);
    const kind: ObservationKind =
      cap?.verification === "acknowledgment" ? "ack" : cap?.verification === "reported_state" ? "state" : "value";
    const obs = await storeObservation({
      invocation_id: inv.invocation_id,
      device,
      capability_id: inv.capability_id,
      input: { kind, value: out.value ?? null, unit: out.unit, data: out.data, captured_at: out.captured_at ?? null, note: out.note },
    });
    observation_id = obs.observation_id;
  } else if (observation_id && (out.value !== undefined || out.data !== undefined)) {
    // merge structured output into the uploaded observation
    await db().query(`update observations set body = body || $2::jsonb where observation_id = $1`, [
      observation_id,
      JSON.stringify({ ...(out.value !== undefined ? { value: out.value } : {}), ...(out.data ? { data: out.data } : {}), ...(out.unit ? { unit: out.unit } : {}) }),
    ]);
  }
  const state = msg.state;
  // A claimed success without any evidence for an observation-verified capability is downgraded to unknown.
  const cap = findCapability(device, inv.capability_id);
  let error = msg.error ?? null;
  let finalState = state;
  if (state === "succeeded" && cap?.verification === "observation" && !observation_id) {
    finalState = "unknown";
    error = "connector reported success but provided no observation";
  }
  const done = await finalize(inv.invocation_id, { state: finalState, error, observation_id, output: msg.output ?? null }, { allowFromUnknown: true });
  if (!done) log("info", `late/duplicate result for ${inv.invocation_id} ignored (already ${inv.state})`);
}

/** Connector disconnected: in-flight invocations can no longer report; mark unknown at their deadline (handled by waiters). */
export async function cancelInvocation(invocation_id: string): Promise<"cancelled" | "unsupported" | "too_late"> {
  const inv = await getInvocationRaw(invocation_id);
  if (!inv || TERMINAL.includes(inv.state)) return "too_late";
  const ac = S().aborts.get(invocation_id);
  if (ac) ac.abort();
  const device = await requireDevice(inv.device_id).catch(() => null);
  if (device && !device.connector_id.startsWith("internal:")) await sendToConnector(device.connector_id, { type: "cancel", invocation_id });
  return "unsupported";
}
