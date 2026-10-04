/**
 * GHOST lifecycle operations used by mission steps (search, quote/accept, invoke, release,
 * record experience). Thin wrappers over the coordinator HTTP API that normalise responses
 * and never throw; every failure comes back as data so missions can record it honestly.
 */
import type {
  CapabilityHit,
  Experience,
  Invocation,
  InvokeResponse,
  Lease,
  Observation,
  QuoteResponse,
} from "../lib/ghost/contracts";
import type { AcceptResponse, RecordExperienceRequest } from "../lib/ghost/client/api-types";
import { coordinator, listFrom, sleep, type CallResult } from "./coordinator";

/** API paths in one place so they are easy to align with the coordinator router. */
export const API = {
  capabilities: "/capabilities",
  quotes: "/quotes",
  accept: (offerId: string) => `/quotes/${encodeURIComponent(offerId)}/accept`,
  invoke: "/invoke",
  lease: (leaseId: string) => `/leases/${encodeURIComponent(leaseId)}`,
  release: (leaseId: string) => `/leases/${encodeURIComponent(leaseId)}/release`,
  experiences: "/experiences",
};

export async function searchCapabilities(
  runId: string,
  params: Record<string, string | number | boolean | undefined>,
): Promise<{ hits: CapabilityHit[]; error?: string }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
  const r = await coordinator<unknown>(runId, "GET", `${API.capabilities}?${qs.toString()}`);
  if (!r.ok) return { hits: [], error: `capability search failed (${r.status}): ${r.error}` };
  return { hits: listFrom<CapabilityHit>(r.data, ["results", "hits", "capabilities", "items"]) };
}

export interface InvokeOutcome {
  ref: string;
  invocation_id: string | null;
  state: Invocation["state"] | "transport_error";
  observation_id: string | null;
  media_url: string | null;
  captured_at: string | null;
  value: Observation["value"] | null;
  note: string | null;
  error: string | null;
  http_status: number;
}

export async function invokeCapability(
  runId: string,
  args: {
    device_id: string;
    capability_id: string;
    arguments?: Record<string, unknown>;
    lease_id?: string | null;
    idempotency_key: string;
    timeout_ms?: number;
  },
): Promise<InvokeOutcome> {
  const ref = `${args.device_id}/${args.capability_id}`;
  const timeout = Math.min(Math.max(args.timeout_ms ?? 20_000, 1_000), 60_000);
  const r = await coordinator<InvokeResponse>(
    runId,
    "POST",
    API.invoke,
    {
      device_id: args.device_id,
      capability_id: args.capability_id,
      arguments: args.arguments ?? {},
      ...(args.lease_id ? { lease_id: args.lease_id } : {}),
      idempotency_key: args.idempotency_key,
      timeout_ms: timeout,
    },
    timeout + 10_000,
  );
  if (!r.ok) {
    return {
      ref,
      invocation_id: null,
      // A transport timeout means we do not know whether the device acted.
      state: r.code === "timeout" ? "unknown" : "transport_error",
      observation_id: null,
      media_url: null,
      captured_at: null,
      value: null,
      note: null,
      error: `invoke ${ref} failed (${r.status}${r.code ? ` ${r.code}` : ""}): ${r.error}`,
      http_status: r.status,
    };
  }
  const inv = r.data?.invocation;
  const obs = r.data?.observation ?? null;
  return {
    ref,
    invocation_id: inv?.invocation_id ?? null,
    state: inv?.state ?? "unknown",
    observation_id: obs?.observation_id ?? inv?.observation_id ?? null,
    media_url: obs?.media_url ?? null,
    captured_at: obs?.captured_at ?? null,
    value: obs?.value ?? null,
    note: obs?.note ?? null,
    error: inv?.error ?? null,
    http_status: r.status,
  };
}

export interface LeaseOutcome {
  ok: boolean;
  lease_id: string | null;
  offer_id: string | null;
  owner_id: string | null;
  refs: string[];
  price_cents: number;
  state: string;
  host_message: string | null;
  error: string | null;
  rounds: number;
}

/**
 * Quote, negotiate (at most 2 counteroffers, as the protocol allows) and accept a lease for
 * `refs` without exceeding `budgetCents`. Waits up to `approvalWaitMs` for owner approval.
 */
export async function acquireLease(
  runId: string,
  args: {
    refs: { device_id: string; capability_id: string }[];
    owner_id: string | null;
    duration_s: number;
    budgetCents: number;
    approvalWaitMs: number;
  },
): Promise<LeaseOutcome> {
  const refKeys = args.refs.map((r) => `${r.device_id}/${r.capability_id}`);
  const base: LeaseOutcome = {
    ok: false,
    lease_id: null,
    offer_id: null,
    owner_id: args.owner_id,
    refs: refKeys,
    price_cents: 0,
    state: "none",
    host_message: null,
    error: null,
    rounds: 0,
  };
  let q = await coordinator<QuoteResponse>(runId, "POST", API.quotes, { refs: args.refs, duration_s: args.duration_s });
  if (!q.ok) return { ...base, error: `quote failed (${q.status}): ${q.error}` };
  let offer = q.data.offer;
  let hostMessage = q.data.host_message ?? offer?.host_message ?? null;
  let rounds = 0;
  // "countered" is a live offer at the host's new price (protocol: max 2 counteroffer rounds).
  const live = (o: { status: string } | undefined) => !!o && (o.status === "open" || o.status === "countered");
  while (offer && live(offer) && offer.price_cents > args.budgetCents && rounds < 2) {
    rounds++;
    q = await coordinator<QuoteResponse>(runId, "POST", API.quotes, {
      refs: args.refs,
      duration_s: args.duration_s,
      offer_id: offer.offer_id,
      offer_price_cents: Math.max(0, args.budgetCents),
    });
    if (!q.ok) return { ...base, offer_id: offer.offer_id, rounds, error: `counteroffer failed (${q.status}): ${q.error}` };
    offer = q.data.offer;
    hostMessage = q.data.host_message ?? offer?.host_message ?? hostMessage;
  }
  if (!offer) return { ...base, error: "coordinator returned no offer" };
  const withOffer = { ...base, offer_id: offer.offer_id, owner_id: offer.owner_id ?? args.owner_id, host_message: hostMessage, rounds };
  if (!live(offer)) return { ...withOffer, state: offer.status, error: `offer ${offer.status}: ${hostMessage ?? "no message"}` };
  if (offer.price_cents > args.budgetCents) {
    return {
      ...withOffer,
      price_cents: offer.price_cents,
      state: "over_budget",
      error: `host asks ${offer.price_cents}¢, remaining budget is ${args.budgetCents}¢ (after ${rounds} counteroffer(s))`,
    };
  }
  const a = await coordinator<AcceptResponse>(runId, "POST", API.accept(offer.offer_id), {
    offer_id: offer.offer_id,
    max_spend_cents: args.budgetCents,
  });
  if (!a.ok) return { ...withOffer, price_cents: offer.price_cents, error: `accept failed (${a.status}): ${a.error}` };
  const accepted: Lease | undefined = a.data?.lease ?? (a.data as unknown as Lease | undefined);
  if (!accepted?.lease_id) return { ...withOffer, price_cents: offer.price_cents, error: "accept returned no lease" };
  let lease: Lease = accepted;

  // Owner approval (requires_approval terms) or payment may still be pending.
  const deadline = Date.now() + args.approvalWaitMs;
  while ((lease.state === "reserved" || lease.state === "payment_pending") && Date.now() < deadline) {
    await sleep(1_000);
    const polled: CallResult<{ lease?: Lease } & Partial<Lease>> = await coordinator(runId, "GET", API.lease(lease.lease_id));
    if (!polled.ok) break;
    const fresh = polled.data?.lease ?? (polled.data as Lease | null);
    if (fresh?.lease_id) lease = fresh;
  }
  const out = {
    ...withOffer,
    lease_id: lease.lease_id,
    price_cents: lease.price_cents ?? offer.price_cents,
    state: lease.state,
  };
  if (lease.state !== "active") return { ...out, error: `lease ${lease.lease_id} is ${lease.state}, not active${lease.reason ? `: ${lease.reason}` : ""}` };
  return { ...out, ok: true };
}

export async function releaseLease(runId: string, leaseId: string): Promise<{ ok: boolean; state: string | null; error: string | null }> {
  const r = await coordinator<{ lease?: Lease } & Partial<Lease>>(runId, "POST", API.release(leaseId), {});
  if (!r.ok) return { ok: false, state: null, error: `release ${leaseId} failed (${r.status}): ${r.error}` };
  const lease = r.data?.lease ?? (r.data as Lease | null);
  return { ok: true, state: lease?.state ?? "released", error: null };
}

export async function recordExperience(
  runId: string,
  body: RecordExperienceRequest,
): Promise<{ experience_id: string | null; error: string | null }> {
  const r = await coordinator<{ experience?: Experience } & Partial<Experience>>(runId, "POST", API.experiences, body);
  if (!r.ok) return { experience_id: null, error: `record experience failed (${r.status}): ${r.error}` };
  const exp = r.data?.experience ?? (r.data as Experience | null);
  return { experience_id: exp?.experience_id ?? null, error: null };
}
