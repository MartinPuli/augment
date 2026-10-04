import type {
  CapabilityRef,
  CapabilitySpec,
  Device,
  Lease,
  LeaseState,
  Offer,
  PaymentReceipt,
  QuoteRequest,
  QuoteResponse,
} from "../contracts";
import type { AcceptResponse, LeaseView } from "../client/api-types";
import { displayNames } from "./auth";
import { db, type Queryable } from "./db";
import { emit, log } from "./events";
import { addEntry, balanceOf, DEV_LEDGER_LABEL, emitLedger } from "./ledger";
import { findCapability, getDevice, requireDevice, rowToDevice } from "./registry";
import { sendToConnector } from "./state";
import {
  bad,
  conflict,
  forbidden,
  GhostError,
  id,
  iso,
  isoOrNull,
  isUniqueViolation,
  json,
  notFound,
  paymentRequired,
  sha256,
  sleep,
} from "./util";

export const OFFER_TTL_S = 60;
export const MAX_COUNTEROFFERS = 2;
/** How long a reservation waits for payment before it expires. */
export const PAYMENT_RESERVE_TTL_S = 30;
/** How long a reservation waits for owner approval (requires_approval terms). */
export const APPROVAL_RESERVE_TTL_S = 120;
export const IMPLICIT_LEASE_S = 60;

export const LIVE_STATES: LeaseState[] = ["reserved", "payment_pending", "active"];

/* ------------------------------------------------------------------ */
/* Row mapping                                                         */
/* ------------------------------------------------------------------ */

type OfferRow = {
  offer_id: string;
  visitor_id: string;
  owner_id: string;
  refs: unknown;
  price_cents: number;
  currency: string;
  duration_s: number;
  quota: number | null;
  terms_version: string;
  expires_at: unknown;
  round: number;
  status: Offer["status"];
  host_message: string | null;
  list_price_cents: number;
  floor_cents: number;
  requires_approval: boolean;
  lease_id: string | null;
  created_at: unknown;
};

type LeaseRow = {
  lease_id: string;
  offer_id: string | null;
  visitor_id: string;
  owner_id: string;
  refs: unknown;
  state: LeaseState;
  revision: number;
  starts_at: unknown;
  ends_at: unknown;
  duration_s: number;
  quota: number | null;
  used: number;
  price_cents: number;
  payment: unknown;
  reason: string | null;
  requires_approval: boolean;
  implicit: boolean;
  reserve_expires_at: unknown;
  created_at: unknown;
  updated_at: unknown;
};

export function rowToOffer(r: OfferRow): Offer {
  return {
    offer_id: r.offer_id,
    visitor_id: r.visitor_id,
    owner_id: r.owner_id,
    refs: json<CapabilityRef[]>(r.refs),
    price_cents: Number(r.price_cents),
    currency: "USD",
    duration_s: Number(r.duration_s),
    ...(r.quota !== null && r.quota !== undefined ? { quota: Number(r.quota) } : {}),
    terms_version: r.terms_version,
    expires_at: iso(r.expires_at),
    round: Number(r.round),
    status: r.status,
    host_message: r.host_message ?? undefined,
    created_at: iso(r.created_at),
  };
}

export function rowToLease(r: LeaseRow): Lease {
  return {
    lease_id: r.lease_id,
    offer_id: r.offer_id,
    visitor_id: r.visitor_id,
    owner_id: r.owner_id,
    refs: json<CapabilityRef[]>(r.refs),
    state: r.state,
    revision: Number(r.revision),
    starts_at: isoOrNull(r.starts_at),
    ends_at: isoOrNull(r.ends_at),
    quota: r.quota === null || r.quota === undefined ? null : Number(r.quota),
    used: Number(r.used),
    price_cents: Number(r.price_cents),
    payment: (json<PaymentReceipt | null>(r.payment) ?? null) as PaymentReceipt | null,
    reason: r.reason ?? undefined,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

function isExclusive(cap: CapabilitySpec): boolean {
  if (cap.exclusive !== undefined) return cap.exclusive;
  return cap.kind === "act" || cap.kind === "stream";
}

/** Locks a lease must hold: one per (device, concurrency_group) of its exclusive capabilities. */
function locksFor(devices: Map<string, Device>, refs: CapabilityRef[]): { device_id: string; group: string }[] {
  const out = new Map<string, { device_id: string; group: string }>();
  for (const r of refs) {
    const d = devices.get(r.device_id);
    const cap = d && findCapability(d, r.capability_id);
    if (!d || !cap || !isExclusive(cap)) continue;
    const group = cap.concurrency_group ?? "device";
    out.set(`${r.device_id}|${group}`, { device_id: r.device_id, group });
  }
  return [...out.values()];
}

function termsVersion(devices: Device[]): string {
  return sha256(JSON.stringify(devices.map((d) => [d.device_id, d.terms]))).slice(0, 12);
}

async function loadRefs(refs: CapabilityRef[], q: Queryable = db()) {
  if (!Array.isArray(refs) || refs.length === 0) throw bad("refs must be a non-empty array of {device_id, capability_id}");
  if (refs.length > 20) throw bad("too many refs (max 20)");
  const devices = new Map<string, Device>();
  for (const r of refs) {
    if (!r || typeof r.device_id !== "string" || typeof r.capability_id !== "string") throw bad("invalid ref");
    if (!devices.has(r.device_id)) {
      const d = await getDevice(r.device_id, q);
      if (!d) throw notFound(`device ${r.device_id} not found`);
      devices.set(r.device_id, d);
    }
    const d = devices.get(r.device_id)!;
    if (!findCapability(d, r.capability_id)) throw notFound(`capability ${r.capability_id} not found on ${d.name}`);
  }
  const owners = new Set([...devices.values()].map((d) => d.owner_id));
  if (owners.size > 1) throw bad("one offer can only cover devices of a single owner; request separate quotes");
  return { devices, owner_id: [...owners][0] };
}

function dedupeRefs(refs: CapabilityRef[]): CapabilityRef[] {
  const m = new Map<string, CapabilityRef>();
  for (const r of refs) m.set(`${r.device_id}/${r.capability_id}`, { device_id: r.device_id, capability_id: r.capability_id });
  return [...m.values()];
}

async function emitLease(lease_id: string) {
  const l = await getLeaseRaw(lease_id);
  if (l) emit({ type: "lease.updated", lease: l });
  return l;
}

export async function getLeaseRaw(lease_id: string, q: Queryable = db()): Promise<Lease | null> {
  const r = await q.query<LeaseRow>(`select * from leases where lease_id = $1`, [lease_id]);
  return r.rows[0] ? rowToLease(r.rows[0]) : null;
}

/* ------------------------------------------------------------------ */
/* Quotes / negotiation (deterministic owner policy = the host agent)  */
/* ------------------------------------------------------------------ */

export async function getOffer(visitor_id: string, offer_id: string): Promise<Offer> {
  const r = await db().query<OfferRow>(`select * from offers where offer_id = $1`, [offer_id]);
  const o = r.rows[0];
  if (!o || (o.visitor_id !== visitor_id && o.owner_id !== visitor_id)) throw notFound(`offer ${offer_id} not found`);
  return rowToOffer(o);
}

export async function quote(visitor_id: string, req: QuoteRequest): Promise<QuoteResponse> {
  if (req.offer_id) return negotiate(visitor_id, req);
  const refs = dedupeRefs(req.refs ?? []);
  const { devices, owner_id } = await loadRefs(refs);
  const devs = [...devices.values()];
  for (const d of devs) if (d.status === "unavailable") throw conflict(`${d.name} is unavailable`);
  const own = owner_id === visitor_id;
  const notes: string[] = [];

  let duration = Math.round(Number(req.duration_s ?? 60));
  if (!Number.isFinite(duration) || duration <= 0) throw bad("duration_s must be a positive number of seconds");
  const maxDur = Math.min(...devs.map((d) => d.terms.max_duration_s));
  if (duration > maxDur) {
    notes.push(`Requested ${duration}s exceeds the owner's maximum of ${maxDur}s, so the lease is clamped to ${maxDur}s.`);
    duration = maxDur;
  }
  const quotas = devs.map((d) => d.terms.quota).filter((x): x is number => typeof x === "number");
  const quota = quotas.length ? Math.min(...quotas) : null;
  const list = own ? 0 : devs.reduce((s, d) => s + (d.access_type === "public_observation" ? 0 : d.terms.price_cents), 0);
  const floor = own
    ? 0
    : devs.reduce(
        (s, d) => s + (d.access_type === "public_observation" ? 0 : Math.min(d.terms.floor_cents ?? d.terms.price_cents, d.terms.price_cents)),
        0,
      );
  const requires_approval = !own && devs.some((d) => d.terms.requires_approval);
  const names = devs.map((d) => d.name).join(", ");
  let host = own
    ? `You own ${names}: zero-price lease (still exclusive while active).`
    : `Quote for ${names}: ${usd(list)} test payment for ${duration}s${quota ? `, up to ${quota} uses` : ""}.`;
  if (devs.some((d) => !d.online)) notes.push(`Warning: ${devs.filter((d) => !d.online).map((d) => d.name).join(", ")} is offline right now.`);
  if (requires_approval) notes.push("The owner must approve this lease before it activates.");
  if (notes.length) host += " " + notes.join(" ");

  const offer_id = id("off");
  const r = await db().query<OfferRow>(
    `insert into offers (offer_id, visitor_id, owner_id, refs, price_cents, duration_s, quota, terms_version, expires_at,
                         round, status, host_message, list_price_cents, floor_cents, requires_approval)
     values ($1,$2,$3,$4::jsonb,$5,$6,$7,$8, now() + make_interval(secs => $9), 0, 'open', $10, $11, $12, $13) returning *`,
    [offer_id, visitor_id, owner_id, JSON.stringify(refs), list, duration, quota, termsVersion(devs), OFFER_TTL_S, host, list, floor, requires_approval],
  );
  let offer = rowToOffer(r.rows[0]);
  emit({ type: "offer.updated", offer });
  if (req.offer_price_cents !== undefined && req.offer_price_cents !== null) {
    return negotiate(visitor_id, { ...req, offer_id: offer.offer_id });
  }
  offer = rowToOffer(r.rows[0]);
  return { offer, host_message: host };
}

async function negotiate(visitor_id: string, req: QuoteRequest): Promise<QuoteResponse> {
  const r0 = await db().query<OfferRow>(`select * from offers where offer_id = $1`, [req.offer_id]);
  const o = r0.rows[0];
  if (!o || o.visitor_id !== visitor_id) throw notFound(`offer ${req.offer_id} not found`);
  if (!["open", "countered"].includes(o.status)) throw conflict(`offer is ${o.status}; request a new quote`);
  if (new Date(iso(o.expires_at)).getTime() < Date.now()) {
    await db().query(`update offers set status = 'expired' where offer_id = $1`, [o.offer_id]);
    throw conflict("offer expired (offers are valid for 60s); request a new quote");
  }
  if (req.offer_price_cents === undefined || req.offer_price_cents === null) {
    const offer = rowToOffer(o);
    return { offer, host_message: o.host_message ?? "" };
  }
  const bid = Math.round(Number(req.offer_price_cents));
  if (!Number.isFinite(bid) || bid < 0) throw bad("offer_price_cents must be a non-negative integer");
  const current = Number(o.price_cents);
  const floor = Number(o.floor_cents);
  const round = Number(o.round) + 1;
  let price = current;
  let status: Offer["status"];
  let host: string;
  if (bid >= floor) {
    price = Math.min(bid, current);
    status = "open";
    host =
      bid >= current
        ? `The asking price is ${usd(current)}; no need to offer more. Accept when ready.`
        : `Accepted: ${usd(price)} (within the owner's terms). Accept the offer to reserve and pay.`;
  } else if (round > MAX_COUNTEROFFERS) {
    status = "rejected";
    host = `Rejected: ${usd(bid)} is below what the owner accepts and the ${MAX_COUNTEROFFERS} counteroffer rounds are used up. Request a new quote.`;
  } else if (round === 1) {
    price = Math.max(floor, Math.round((bid + current) / 2));
    status = "countered";
    host = `Counteroffer: ${usd(price)}. ${usd(bid)} is too low for this owner.`;
  } else {
    price = floor;
    status = "countered";
    host = `Final offer: ${usd(price)}. This is the lowest price the owner accepts.`;
  }
  const r = await db().query<OfferRow>(
    `update offers set price_cents = $2, round = $3, status = $4, host_message = $5,
            expires_at = now() + make_interval(secs => $6) where offer_id = $1 returning *`,
    [o.offer_id, price, round, status, host, OFFER_TTL_S],
  );
  const offer = rowToOffer(r.rows[0]);
  emit({ type: "offer.updated", offer });
  return { offer, host_message: host };
}

/* ------------------------------------------------------------------ */
/* Accept: reserve + pay + activate                                    */
/* ------------------------------------------------------------------ */

export interface AcceptTestHooks {
  /** Simulate a slow payment provider: reserve, wait, then settle (used by the smoke test). */
  paymentDelayMs?: number;
  /** Override the reservation TTL in seconds. */
  reserveTtlS?: number;
}

/**
 * An owner's implicit zero-price lease (created when they test their own device) yields to a
 * visitor's negotiated lease instead of blocking it. Runs inside the accept transaction.
 */
async function yieldImplicitOwnerLeases(q: Queryable, locks: { device_id: string; group: string }[]): Promise<string[]> {
  if (!locks.length) return [];
  const r = await q.query<{ lease_id: string }>(
    `select distinct l.lease_id from lease_locks k join leases l on l.lease_id = k.lease_id
     where k.held and l.implicit and l.state = 'active'
       and (k.device_id || '|' || k.concurrency_group) = any($1::text[])`,
    [locks.map((l) => `${l.device_id}|${l.group}`)],
  );
  const ids = r.rows.map((x) => x.lease_id);
  if (!ids.length) return [];
  await q.query(
    `update leases set state = 'released', reason = 'owner test lease yielded to a visitor lease', revision = revision + 1,
            ends_at = now(), updated_at = now() where lease_id = any($1::text[])`,
    [ids],
  );
  await q.query(`update lease_locks set held = false where lease_id = any($1::text[])`, [ids]);
  return ids;
}

async function insertLocks(q: Queryable, lease_id: string, locks: { device_id: string; group: string }[], devices: Map<string, Device>) {
  for (const l of locks) {
    try {
      await q.query(`insert into lease_locks (lease_id, device_id, concurrency_group, held) values ($1, $2, $3, true)`, [
        lease_id,
        l.device_id,
        l.group,
      ]);
    } catch (e) {
      if (isUniqueViolation(e)) {
        const name = devices.get(l.device_id)?.name ?? l.device_id;
        throw new GhostError(409, `${name} is already leased exclusively by someone else; try again after that lease ends`, "busy");
      }
      throw e;
    }
  }
}

async function insertLease(
  q: Queryable,
  v: {
    lease_id: string;
    offer_id: string | null;
    visitor_id: string;
    owner_id: string;
    refs: CapabilityRef[];
    state: LeaseState;
    duration_s: number;
    quota: number | null;
    price_cents: number;
    requires_approval?: boolean;
    implicit?: boolean;
    reserve_ttl_s?: number;
    reason?: string;
  },
) {
  await q.query(
    `insert into leases (lease_id, offer_id, visitor_id, owner_id, refs, state, duration_s, quota, price_cents,
                         requires_approval, implicit, reserve_expires_at, reason)
     values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11, case when $12::int is null then null else now() + make_interval(secs => $12::int) end, $13)`,
    [
      v.lease_id,
      v.offer_id,
      v.visitor_id,
      v.owner_id,
      JSON.stringify(v.refs),
      v.state,
      v.duration_s,
      v.quota,
      v.price_cents,
      !!v.requires_approval,
      !!v.implicit,
      v.reserve_ttl_s ?? null,
      v.reason ?? null,
    ],
  );
}

function receipt(amount: number, status: PaymentReceipt["status"], provider: PaymentReceipt["provider"] = "dev-ledger"): PaymentReceipt {
  return {
    receipt_id: id("rcpt"),
    provider,
    label: provider === "none" ? "No payment (zero price)" : DEV_LEDGER_LABEL,
    amount_cents: amount,
    currency: "USD",
    status,
    created_at: new Date().toISOString(),
  };
}

/** Debit visitor, credit owner, activate. Runs inside a transaction holding the lease row. */
async function payAndActivate(q: Queryable, lease: LeaseRow): Promise<PaymentReceipt> {
  const price = Number(lease.price_cents);
  let pay: PaymentReceipt;
  if (price > 0) {
    await q.query(`select principal_id from principals where principal_id = $1 for update`, [lease.visitor_id]);
    const bal = await balanceOf(q, lease.visitor_id);
    if (bal < price) throw paymentRequired(`insufficient test funds: balance ${usd(bal)}, price ${usd(price)}`);
    await addEntry(q, {
      principal_id: lease.visitor_id,
      amount_cents: -price,
      kind: "lease_payment",
      lease_id: lease.lease_id,
      label: `Test payment for lease ${lease.lease_id} — ${DEV_LEDGER_LABEL}`,
    });
    if (!lease.owner_id.startsWith("provider:")) {
      await addEntry(q, {
        principal_id: lease.owner_id,
        amount_cents: price,
        kind: "lease_income",
        lease_id: lease.lease_id,
        label: `Test income from lease ${lease.lease_id} — ${DEV_LEDGER_LABEL}`,
      });
    }
    pay = receipt(price, "succeeded");
  } else {
    pay = receipt(0, "succeeded", "none");
  }
  await q.query(
    `update leases set state = 'active', starts_at = now(), ends_at = now() + make_interval(secs => duration_s),
            payment = $2::jsonb, revision = revision + 1, updated_at = now(), reason = null where lease_id = $1`,
    [lease.lease_id, JSON.stringify(pay)],
  );
  return pay;
}

/**
 * Settle a reserved lease whose payment arrives separately (approval flow / slow provider).
 * A payment that lands after the reservation expired never activates: it records compensation.
 */
async function settleReserved(lease_id: string): Promise<{ lease: Lease; payment: PaymentReceipt | null }> {
  let compensated = false;
  let failure: GhostError | null = null;
  const payment = await db().tx(async (q) => {
    const r = await q.query<LeaseRow>(`select * from leases where lease_id = $1 for update`, [lease_id]);
    const l = r.rows[0];
    if (!l) throw notFound("lease not found");
    const expiredReservation =
      !LIVE_STATES.includes(l.state) ||
      (l.reserve_expires_at !== null && new Date(iso(l.reserve_expires_at)).getTime() < Date.now());
    if (expiredReservation) {
      // Payment landed too late: never activate. Record the payment + compensating credit.
      const price = Number(l.price_cents);
      const pay = receipt(price, "compensation_recorded", price > 0 ? "dev-ledger" : "none");
      if (price > 0) {
        await addEntry(q, { principal_id: l.visitor_id, amount_cents: -price, kind: "lease_payment", lease_id, label: `Late test payment for ${lease_id} — ${DEV_LEDGER_LABEL}` });
        await addEntry(q, { principal_id: l.visitor_id, amount_cents: price, kind: "compensation", lease_id, label: `Compensation: payment arrived after reservation expired — ${DEV_LEDGER_LABEL}` });
      }
      await q.query(
        `update leases set state = case when state in ('reserved','payment_pending') then 'expired' else state end,
                payment = $2::jsonb, reason = coalesce(reason, 'reservation expired before payment settled'), updated_at = now()
         where lease_id = $1`,
        [lease_id, JSON.stringify(pay)],
      );
      await q.query(`update lease_locks set held = false where lease_id = $1`, [lease_id]);
      compensated = true;
      return pay;
    }
    try {
      return await payAndActivate(q, l);
    } catch (e) {
      if (e instanceof GhostError) {
        failure = e;
        return null;
      }
      throw e;
    }
  });
  if (failure) {
    await endLease(lease_id, "failed", (failure as GhostError).message);
    throw failure;
  }
  const lease = (await emitLease(lease_id))!;
  await emitLedger(lease.visitor_id, lease.owner_id);
  if (compensated) log("warn", `lease ${lease_id}: payment arrived after reservation expired; compensation recorded, not activated`);
  return { lease, payment };
}

export async function acceptQuote(
  visitor_id: string,
  offer_id: string,
  max_spend_cents: number,
  hooks: AcceptTestHooks = {},
): Promise<AcceptResponse> {
  const maxSpend = Number(max_spend_cents);
  if (!Number.isFinite(maxSpend) || maxSpend < 0) throw bad("max_spend_cents must be a non-negative integer");
  const lease_id = id("lse");
  const twoPhase = hooks.paymentDelayMs !== undefined;
  let requiresApproval = false;
  let payment: PaymentReceipt | null = null;
  let failure: GhostError | null = null;
  let offerRow: OfferRow | null = null;
  let yielded: string[] = [];

  await db().tx(async (q) => {
    const r = await q.query<OfferRow>(`select * from offers where offer_id = $1 for update`, [offer_id]);
    const o = r.rows[0];
    if (!o || o.visitor_id !== visitor_id) throw notFound(`offer ${offer_id} not found`);
    offerRow = o;
    if (o.status === "accepted") throw conflict(`offer already accepted (lease ${o.lease_id})`);
    if (!["open", "countered"].includes(o.status)) throw conflict(`offer is ${o.status}; request a new quote`);
    if (new Date(iso(o.expires_at)).getTime() < Date.now()) {
      await q.query(`update offers set status = 'expired' where offer_id = $1`, [offer_id]);
      throw conflict("offer expired (offers are valid for 60s); request a new quote");
    }
    const price = Number(o.price_cents);
    if (price > maxSpend) throw paymentRequired(`price ${usd(price)} exceeds your max_spend_cents ${usd(maxSpend)}`);
    const refs = json<CapabilityRef[]>(o.refs);
    const { devices } = await loadRefs(refs, q);
    if (termsVersion([...devices.values()]) !== o.terms_version)
      throw conflict("the owner changed the terms since this quote; request a new quote");
    if (price > 0) {
      await q.query(`select principal_id from principals where principal_id = $1 for update`, [visitor_id]);
      const bal = await balanceOf(q, visitor_id);
      if (bal < price) throw paymentRequired(`insufficient test funds: balance ${usd(bal)}, price ${usd(price)}`);
    }
    requiresApproval = !!o.requires_approval;
    await insertLease(q, {
      lease_id,
      offer_id,
      visitor_id,
      owner_id: o.owner_id,
      refs,
      state: requiresApproval ? "reserved" : twoPhase ? "payment_pending" : "reserved",
      duration_s: Number(o.duration_s),
      quota: o.quota === null ? null : Number(o.quota),
      price_cents: price,
      requires_approval: requiresApproval,
      reserve_ttl_s: requiresApproval ? APPROVAL_RESERVE_TTL_S : (hooks.reserveTtlS ?? PAYMENT_RESERVE_TTL_S),
      reason: requiresApproval ? "waiting for owner approval" : undefined,
    });
    const wanted = locksFor(devices, refs);
    yielded = await yieldImplicitOwnerLeases(q, wanted);
    await insertLocks(q, lease_id, wanted, devices);
    await q.query(`update offers set status = 'accepted', lease_id = $2 where offer_id = $1`, [offer_id, lease_id]);
    if (!requiresApproval && !twoPhase) {
      const lr = await q.query<LeaseRow>(`select * from leases where lease_id = $1`, [lease_id]);
      try {
        payment = await payAndActivate(q, lr.rows[0]);
      } catch (e) {
        if (e instanceof GhostError) failure = e;
        throw e;
      }
    }
  }).catch(async (e) => {
    // Payment failure inside the single transaction: record a failed lease (no locks held).
    if (failure && offerRow) {
      const o = offerRow as OfferRow;
      await insertLease(db(), {
        lease_id,
        offer_id,
        visitor_id,
        owner_id: o.owner_id,
        refs: json<CapabilityRef[]>(o.refs),
        state: "failed",
        duration_s: Number(o.duration_s),
        quota: o.quota,
        price_cents: Number(o.price_cents),
        reason: `payment failed: ${(failure as GhostError).message}`,
      }).catch(() => {});
      await emitLease(lease_id);
    }
    throw e;
  });

  for (const lid of yielded) await emitLease(lid);
  if (offerRow) emit({ type: "offer.updated", offer: await getOffer(visitor_id, offer_id) });

  if (requiresApproval) {
    const lease = (await emitLease(lease_id))!;
    log("info", `lease ${lease_id} reserved; waiting for owner approval`);
    return { lease, payment: null, balance_cents: await balanceOf(db(), visitor_id) };
  }
  if (twoPhase) {
    await emitLease(lease_id);
    await sleep(hooks.paymentDelayMs ?? 0);
    const settled = await settleReserved(lease_id);
    return { ...settled, balance_cents: await balanceOf(db(), visitor_id) };
  }
  const lease = (await emitLease(lease_id))!;
  await emitLedger(visitor_id, lease.owner_id);
  log("info", `lease ${lease_id} active until ${lease.ends_at}`);
  return { lease, payment, balance_cents: await balanceOf(db(), visitor_id) };
}

/** Owner approves a lease that is waiting for approval (requires_approval terms). */
export async function approveLease(owner_id: string, lease_id: string): Promise<Lease> {
  const l = await getLeaseRaw(lease_id);
  if (!l) throw notFound("lease not found");
  if (l.owner_id !== owner_id) throw forbidden("only the device owner can approve this lease");
  if (l.state !== "reserved") throw conflict(`lease is ${l.state}, not waiting for approval`);
  const { lease } = await settleReserved(lease_id);
  return lease;
}

/* ------------------------------------------------------------------ */
/* Ending leases                                                       */
/* ------------------------------------------------------------------ */

/** Move a live lease to a terminal state, free its locks, tell connectors, emit. */
export async function endLease(lease_id: string, state: Extract<LeaseState, "released" | "expired" | "revoked" | "failed">, reason: string): Promise<Lease | null> {
  const ended = await db().tx(async (q) => {
    const r = await q.query<LeaseRow>(
      `update leases set state = $2, reason = $3, revision = revision + 1, updated_at = now(),
              ends_at = case when ends_at is null or ends_at > now() then now() else ends_at end
       where lease_id = $1 and state in ('reserved','payment_pending','active') returning *`,
      [lease_id, state, reason],
    );
    await q.query(`update lease_locks set held = false where lease_id = $1`, [lease_id]);
    return r.rows[0] ? rowToLease(r.rows[0]) : null;
  });
  if (!ended) return null;
  // Tell every connector serving these devices to stop (delivery is best effort; authorization is server-side).
  const deviceIds = [...new Set(ended.refs.map((r) => r.device_id))];
  const byConnector = new Map<string, string[]>();
  for (const did of deviceIds) {
    const d = await getDevice(did);
    if (d && !d.connector_id.startsWith("internal:")) byConnector.set(d.connector_id, [...(byConnector.get(d.connector_id) ?? []), did]);
  }
  for (const [cid, dids] of byConnector) sendToConnector(cid, { type: "revoke", lease_id, device_ids: dids });
  emit({ type: "lease.updated", lease: ended });
  log("info", `lease ${lease_id} ${state}: ${reason}`);
  return ended;
}

export async function releaseLease(visitor_id: string, lease_id: string): Promise<Lease> {
  const l = await getLeaseRaw(lease_id);
  if (!l || l.visitor_id !== visitor_id) throw notFound("lease not found");
  if (!LIVE_STATES.includes(l.state)) return l;
  return (await endLease(lease_id, "released", "released by visitor")) ?? (await getLeaseRaw(lease_id))!;
}

export async function revokeLease(owner_id: string, lease_id: string): Promise<Lease> {
  const l = await getLeaseRaw(lease_id);
  if (!l) throw notFound("lease not found");
  if (l.owner_id !== owner_id) throw forbidden("only the device owner can stop this lease");
  if (!LIVE_STATES.includes(l.state)) return l;
  return (await endLease(lease_id, "revoked", "owner stopped access")) ?? (await getLeaseRaw(lease_id))!;
}

/** Sweeper: expire leases past ends_at, stale reservations and offers. Runs every second. */
export async function sweep(): Promise<void> {
  const r = await db().query<{ lease_id: string; state: LeaseState }>(
    `select lease_id, state from leases
     where (state = 'active' and ends_at <= now())
        or (state in ('reserved','payment_pending') and reserve_expires_at is not null and reserve_expires_at <= now())`,
  );
  for (const row of r.rows) {
    await endLease(
      row.lease_id,
      "expired",
      row.state === "active" ? "lease time ended" : row.state === "reserved" ? "reservation expired (owner did not approve in time)" : "reservation expired before payment",
    );
  }
  await db().query(`update offers set status = 'expired' where status in ('open','countered') and expires_at <= now()`);
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

export async function decorateLeases(leases: Lease[]): Promise<LeaseView[]> {
  const names = await displayNames(leases.flatMap((l) => [l.visitor_id, l.owner_id]));
  const devIds = [...new Set(leases.flatMap((l) => l.refs.map((r) => r.device_id)))];
  const devNames = new Map<string, string>();
  if (devIds.length) {
    const r = await db().query<{ device_id: string; manifest: unknown }>(`select device_id, manifest from devices where device_id = any($1::text[])`, [devIds]);
    for (const row of r.rows) devNames.set(row.device_id, json<{ name: string }>(row.manifest).name);
  }
  return leases.map((l) => ({
    ...l,
    visitor_display_name: names.get(l.visitor_id),
    owner_display_name: names.get(l.owner_id),
    devices: [...new Set(l.refs.map((r) => r.device_id))].map((d) => ({ device_id: d, name: devNames.get(d) ?? d })),
  }));
}

export async function listLeases(principal_id: string, opts: { role?: "visitor" | "owner"; active?: boolean } = {}): Promise<LeaseView[]> {
  const params: unknown[] = [principal_id];
  let who = `(visitor_id = $1 or owner_id = $1)`;
  if (opts.role === "visitor") who = `visitor_id = $1`;
  // Owner view: leases others hold on my devices (my own implicit test leases are not "visitors").
  if (opts.role === "owner") who = `owner_id = $1 and visitor_id <> $1`;
  const live = opts.active ? ` and state in ('reserved','payment_pending','active')` : "";
  const r = await db().query<LeaseRow>(`select * from leases where ${who}${live} order by created_at desc limit 200`, params);
  return decorateLeases(r.rows.map(rowToLease));
}

export async function getLease(principal_id: string, lease_id: string): Promise<LeaseView> {
  const l = await getLeaseRaw(lease_id);
  if (!l || (l.visitor_id !== principal_id && l.owner_id !== principal_id)) throw notFound("lease not found");
  return (await decorateLeases([l]))[0];
}

/* ------------------------------------------------------------------ */
/* Authorization for invocations                                       */
/* ------------------------------------------------------------------ */

/** Find (or for own devices create) the lease that authorizes this invocation, and consume one use. */
export async function authorizeAndConsume(
  q: Queryable,
  visitor_id: string,
  device: Device,
  capability_id: string,
  lease_id: string | undefined,
): Promise<{ lease: Lease | null; mode: "lease" | "implicit" | "public" }> {
  const covers = `refs @> $2::jsonb`;
  const refJson = JSON.stringify([{ device_id: device.device_id, capability_id }]);
  const consume = async (lid: string) => {
    const r = await q.query<LeaseRow>(
      `update leases set used = used + 1, updated_at = now()
       where lease_id = $1 and visitor_id = $3 and state = 'active' and ends_at > now() and ${covers}
         and (quota is null or used < quota) returning *`,
      [lid, refJson, visitor_id],
    );
    return r.rows[0] ? rowToLease(r.rows[0]) : null;
  };
  const explain = async (lid: string): Promise<never> => {
    const r = await q.query<LeaseRow>(`select * from leases where lease_id = $1`, [lid]);
    const l = r.rows[0];
    if (!l || l.visitor_id !== visitor_id) throw notFound(`lease ${lid} not found`);
    if (l.state !== "active") throw new GhostError(403, `lease is ${l.state}${l.reason ? ` (${l.reason})` : ""}; no access`, "lease_inactive");
    if (new Date(iso(l.ends_at)).getTime() <= Date.now()) throw new GhostError(403, "lease expired; no access", "lease_expired");
    if (!json<CapabilityRef[]>(l.refs).some((r) => r.device_id === device.device_id && r.capability_id === capability_id))
      throw new GhostError(403, `lease does not include ${device.device_id}/${capability_id}`, "not_covered");
    throw new GhostError(429, `lease quota exhausted (${l.used}/${l.quota} uses)`, "quota_exhausted");
  };

  if (lease_id) {
    const l = await consume(lease_id);
    if (!l) return explain(lease_id);
    return { lease: l, mode: "lease" };
  }
  // No lease id: pick the caller's own active lease covering this capability, if any.
  const found = await q.query<{ lease_id: string }>(
    `select lease_id from leases where visitor_id = $1 and state = 'active' and ends_at > now() and ${covers}
     order by ends_at desc`,
    [visitor_id, refJson],
  );
  for (const row of found.rows) {
    const l = await consume(row.lease_id);
    if (l) return { lease: l, mode: l.price_cents === 0 && device.owner_id === visitor_id ? "implicit" : "lease" };
  }
  if (device.owner_id === visitor_id) {
    // Own device: implicit zero-price lease (still exclusive while it lasts).
    const lid = id("lse");
    const refs = [{ device_id: device.device_id, capability_id }];
    const devices = new Map([[device.device_id, device]]);
    // Cover every capability of the device so follow-up calls reuse this implicit lease.
    const allRefs = device.capabilities.map((c) => ({ device_id: device.device_id, capability_id: c.capability_id }));
    await insertLease(q, {
      lease_id: lid,
      offer_id: null,
      visitor_id,
      owner_id: visitor_id,
      refs: allRefs,
      state: "active",
      duration_s: IMPLICIT_LEASE_S,
      quota: null,
      price_cents: 0,
      implicit: true,
    });
    await insertLocks(q, lid, locksFor(devices, allRefs.length ? allRefs : refs), devices);
    const pay = receipt(0, "succeeded", "none");
    await q.query(
      `update leases set starts_at = now(), ends_at = now() + make_interval(secs => duration_s), payment = $2::jsonb, used = 1 where lease_id = $1`,
      [lid, JSON.stringify(pay)],
    );
    const r = await q.query<LeaseRow>(`select * from leases where lease_id = $1`, [lid]);
    return { lease: rowToLease(r.rows[0]), mode: "implicit" };
  }
  if (device.access_type === "public_observation") return { lease: null, mode: "public" };
  throw new GhostError(
    402,
    `${device.name} requires an active lease (${device.access_type}, ${usd(device.terms.price_cents)}). Request a quote first.`,
    "lease_required",
  );
}

export async function emitLeaseById(lease_id: string) {
  return emitLease(lease_id);
}

export { requireDevice, rowToDevice };
