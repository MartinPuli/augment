/**
 * Coordinator smoke test: boots the coordinator API standalone (no Next.js) on port 3100 with an
 * in-memory PGlite database, connects the SIMULATED connector, and exercises the core flows.
 *
 *   pnpm tsx scripts/coord-smoke.ts
 */
process.env.GHOST_QUIET = "1";
import { config as loadEnv } from "dotenv";
import WebSocket from "ws";
import type { CapabilityHit, InvokeResponse, Lease, MeResponse, Observation, QuoteResponse } from "../src/lib/ghost/contracts";
import type { AcceptResponse, ExperienceSearchResponse, LedgerResponse, PairingInfo } from "../src/lib/ghost/client/api-types";
import { startCoordinator } from "../src/lib/ghost/server";
import { internalAdapters } from "../src/lib/ghost/server/adapters";
import type { InternalAdapter } from "../src/lib/ghost/server/adapters/types";
import { emit, subscribe } from "../src/lib/ghost/server/events";
import { db } from "../src/lib/ghost/server/db";
import { acceptQuote } from "../src/lib/ghost/server/leases";
import { publishFromAdapter } from "../src/lib/ghost/server/registry";
import { makePng, simulatedManifests, startFakeConnector } from "./coord-fake-connector";
import { PROTOCOL_VERSION } from "../src/lib/ghost/contracts";

const PORT = Number(process.env.SMOKE_PORT || 3100);
const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0;
let failed = 0;

function ok(cond: unknown, name: string, extra?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${extra !== undefined ? ` — ${typeof extra === "string" ? extra : JSON.stringify(extra).slice(0, 400)}` : ""}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T = unknown>(token: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: r.status, json: json as T };
}

async function newPrincipal(): Promise<MeResponse & { cookie: string }> {
  const r = await fetch(`${BASE}/api/v1/me`);
  const me = (await r.json()) as MeResponse;
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  return { ...me, cookie };
}

/** Test-only internal adapter: a labeled simulated public camera (public_observation). */
const smokeAdapter: InternalAdapter = {
  id: "smoke",
  owner_id: "provider:smoke",
  async invoke(_device, capability_id) {
    if (capability_id !== "image.observe") return { state: "rejected", error: "unknown capability" };
    return {
      state: "succeeded",
      observation: {
        kind: "image",
        media: { bytes: new Uint8Array(makePng(32, 24)), content_type: "image/png" },
        captured_at: null,
        source: { name: "Smoke-test simulator", attribution: "SIMULATED" },
        note: "SIMULATED public camera (smoke test); capture time unknown",
      },
    };
  },
};

async function main() {
  loadEnv({ path: ".env.local", quiet: true });
  loadEnv({ path: ".env", quiet: true });
  const t0 = Date.now();
  internalAdapters.push(smokeAdapter);
  // Default: in-memory PGlite. SMOKE_DB=postgres runs against DATABASE_URL in a throwaway schema (dropped after).
  const usePg = process.env.SMOKE_DB === "postgres" && !!process.env.DATABASE_URL;
  const schema = `ghost_smoke_${Date.now().toString(36)}`;
  if (!usePg) delete process.env.DATABASE_URL;
  console.log(usePg ? `database: Postgres (DATABASE_URL), schema ${schema}` : "database: in-memory PGlite");
  const coord = await startCoordinator({
    dataDir: "memory",
    ...(usePg ? { schema } : {}),
    skipAdapters: true,
    listenPort: PORT,
    hostname: "127.0.0.1",
  });
  const events: string[] = [];
  subscribe((e) => events.push(e.type));

  console.log("\n# principals + ledger");
  const owner = await newPrincipal();
  const bob = await newPrincipal();
  const carol = await newPrincipal();
  ok(owner.balance_cents === 500 && bob.balance_cents === 500, "new principals start with 500 test cents");
  ok(/^Visitor [0-9A-Z]{4}$/.test(owner.display_name), "display name like 'Visitor 4F2A'", owner.display_name);
  ok(owner.cookie.startsWith("ghost_pid="), "GET /me sets ghost_pid cookie");
  const meAgain = await fetch(`${BASE}/api/v1/me`, { headers: { cookie: owner.cookie } }).then((r) => r.json() as Promise<MeResponse>);
  ok(meAgain.principal_id === owner.principal_id, "cookie identifies the same principal");
  ok((await api(null, "GET", "/api/v1/ledger")).status === 401, "ledger without auth -> 401");

  console.log("\n# device channel: owner_token hello + publish");
  const conn = startFakeConnector({ url: BASE, owner_token: owner.owner_token, log: () => {}, hang: ["relay.set"], manifests: [
    ...simulatedManifests({ lampPrice: 50, lampFloor: 20, cameraPrice: 25, quota: 6 }),
    {
      protocol_version: PROTOCOL_VERSION,
      local_key: "sim-relay",
      name: "Simulated unresponsive relay",
      device_class: "switch",
      transport: "other",
      access_type: "owner_shared",
      terms: { price_cents: 10, currency: "USD", max_duration_s: 60 },
      capabilities: [
        {
          capability_id: "relay.set",
          kind: "act",
          semantic_type: "switch.set",
          title: "Set relay (SIMULATED: never answers)",
          description: "Simulator that never replies, to exercise the timeout path.",
          input_schema: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"], additionalProperties: false },
          verification: "reported_state",
        },
      ],
    },
  ] });
  const welcome = await conn.welcome;
  ok(welcome.owner_id === owner.principal_id && welcome.credential.length > 10, "welcome with connector_id + credential");
  const pub = await conn.published;
  const lampId = pub.devices.find((d) => d.local_key === "sim-lamp")!.device_id;
  const camId = pub.devices.find((d) => d.local_key === "sim-camera")!.device_id;
  const relayId = pub.devices.find((d) => d.local_key === "sim-relay")!.device_id;
  ok(pub.devices.length === 3 && pub.devices.every((d) => d.status === "configured"), "published 3 devices as configured");

  console.log("\n# search");
  const s1 = await api<CapabilityHit[]>(bob.owner_token, "GET", "/api/v1/capabilities?q=simulated%20lamp");
  ok(s1.status === 200 && s1.json[0]?.ref === `${lampId}/light.set`, "search 'simulated lamp' finds the lamp first", s1.json);
  const s2 = await api<CapabilityHit[]>(bob.owner_token, "GET", "/api/v1/capabilities?semantic_type=image.observe&near=37.77,-122.42&radius_km=5");
  ok(s2.json.some((h) => h.ref === `${camId}/camera.snapshot` && typeof h.distance_km === "number"), "semantic_type + near filter with distance");
  const s3 = await api<CapabilityHit[]>(owner.owner_token, "GET", `/api/v1/capabilities?q=lamp`);
  ok(s3.json[0]?.device.access_type === "own_device" && s3.json[0]?.terms.price_cents === 0, "owner sees own device as own_device, zero price");
  const devs = await api<{ device_id: string }[]>(owner.owner_token, "GET", "/api/v1/devices?mine=1");
  ok(devs.json.length === 3, "GET /devices?mine=1 lists owner's devices");

  console.log("\n# invoke without lease on paid device");
  const noLease = await api<{ error: string; code: string }>(bob.owner_token, "POST", "/api/v1/invoke", { device_id: lampId, capability_id: "light.set", arguments: { on: true } });
  ok(noLease.status === 402 && noLease.json.code === "lease_required", "rejected with 402 lease_required", noLease);

  console.log("\n# quote -> counteroffer -> accept");
  const refs = [
    { device_id: lampId, capability_id: "light.set" },
    { device_id: camId, capability_id: "camera.snapshot" },
  ];
  const q0 = await api<QuoteResponse>(bob.owner_token, "POST", "/api/v1/quotes", { refs, duration_s: 9999 });
  ok(q0.status === 200 && q0.json.offer.price_cents === 75 && q0.json.offer.duration_s === 300, "initial quote = 75c, duration clamped to 300s", q0.json);
  ok(/clamped/.test(q0.json.host_message), "host explains the clamp");
  const q1 = await api<QuoteResponse>(bob.owner_token, "POST", "/api/v1/quotes", { refs, duration_s: 60, offer_id: q0.json.offer.offer_id, offer_price_cents: 10 });
  ok(q1.json.offer.status === "countered" && q1.json.offer.price_cents === 43 && q1.json.offer.round === 1, "round 1 counter at midpoint 43c", q1.json.offer);
  const q2 = await api<QuoteResponse>(bob.owner_token, "POST", "/api/v1/quotes", { refs, duration_s: 60, offer_id: q0.json.offer.offer_id, offer_price_cents: 20 });
  ok(q2.json.offer.price_cents === 30 && /Final/.test(q2.json.host_message), "round 2 final offer at floor 30c", q2.json);
  const tooCheap = await api<{ code: string }>(bob.owner_token, "POST", `/api/v1/quotes/${q0.json.offer.offer_id}/accept`, { offer_id: q0.json.offer.offer_id, max_spend_cents: 29 });
  ok(tooCheap.status === 402, "accept refuses to exceed max_spend_cents", tooCheap);
  const acc = await api<AcceptResponse>(bob.owner_token, "POST", `/api/v1/quotes/${q0.json.offer.offer_id}/accept`, { offer_id: q0.json.offer.offer_id, max_spend_cents: 30 });
  ok(acc.status === 200 && acc.json.lease.state === "active" && acc.json.balance_cents === 470, "lease active, visitor debited 30c", acc.json);
  ok(acc.json.payment?.provider === "dev-ledger" && /test funds/.test(acc.json.payment?.label ?? ""), "payment receipt labeled as dev-ledger test funds");
  const lease = acc.json.lease;
  const ownerLedger = await api<LedgerResponse>(owner.owner_token, "GET", "/api/v1/ledger");
  ok(ownerLedger.json.balance_cents === 530, "owner credited 30 test cents", ownerLedger.json.balance_cents);
  const q3 = await api<QuoteResponse>(bob.owner_token, "POST", "/api/v1/quotes", { refs, duration_s: 60, offer_price_cents: 1 });
  const q4 = await api<QuoteResponse>(bob.owner_token, "POST", "/api/v1/quotes", { refs, duration_s: 60, offer_id: q3.json.offer.offer_id, offer_price_cents: 1 });
  const q5 = await api<QuoteResponse>(bob.owner_token, "POST", "/api/v1/quotes", { refs, duration_s: 60, offer_id: q3.json.offer.offer_id, offer_price_cents: 1 });
  ok(q3.json.offer.round === 1 && q4.json.offer.round === 2 && q5.json.offer.status === "rejected", "third lowball counteroffer is rejected", [q3.json.offer, q4.json.offer, q5.json.offer]);

  console.log("\n# invoke with lease");
  const inv1 = await api<InvokeResponse>(bob.owner_token, "POST", "/api/v1/invoke", { device_id: lampId, capability_id: "light.set", arguments: { on: true, brightness: 80 }, lease_id: lease.lease_id });
  ok(inv1.status === 200 && inv1.json.invocation.state === "succeeded" && inv1.json.observation?.data?.on === true, "light.set succeeded with reported state", inv1.json);
  ok(conn.lamp.on && conn.lamp.brightness === 80, "simulated lamp state changed");
  const inv2 = await api<InvokeResponse>(bob.owner_token, "POST", "/api/v1/invoke", { device_id: camId, capability_id: "camera.snapshot", lease_id: lease.lease_id });
  const obs = inv2.json.observation as Observation;
  ok(inv2.json.invocation.state === "succeeded" && obs?.kind === "image" && obs.media_type === "image/png" && !!obs.captured_at, "camera.snapshot returns an image observation", inv2.json);
  const media = await fetch(`${BASE}${obs.media_url}`);
  const bytes = new Uint8Array(await media.arrayBuffer());
  ok(media.status === 200 && media.headers.get("content-type") === "image/png" && bytes[0] === 0x89 && bytes[1] === 0x50, "observation media served as PNG bytes");
  const badArgs = await api<{ code: string }>(bob.owner_token, "POST", "/api/v1/invoke", { device_id: lampId, capability_id: "light.set", arguments: { on: "yes", extra: 1 }, lease_id: lease.lease_id });
  ok(badArgs.status === 400 && badArgs.json.code === "invalid_arguments", "invalid arguments rejected by input_schema", badArgs.json);
  const camDev = await api<{ status: string }>(bob.owner_token, "GET", `/api/v1/devices/${camId}`);
  ok(camDev.json.status === "verified", "device becomes verified after a successful invocation");

  console.log("\n# exclusivity");
  const cq = await api<QuoteResponse>(carol.owner_token, "POST", "/api/v1/quotes", { refs: [refs[0]], duration_s: 30 });
  const cacc = await api<{ code: string; error: string }>(carol.owner_token, "POST", `/api/v1/quotes/${cq.json.offer.offer_id}/accept`, { offer_id: cq.json.offer.offer_id, max_spend_cents: 100 });
  ok(cacc.status === 409 && cacc.json.code === "busy", "second visitor cannot hold the same exclusive lamp", cacc.json);
  const carolLedger = await api<LedgerResponse>(carol.owner_token, "GET", "/api/v1/ledger");
  ok(carolLedger.json.balance_cents === 500, "refused visitor was not charged");

  console.log("\n# idempotency");
  const k = `idem-${Date.now()}`;
  const i1 = await api<InvokeResponse>(bob.owner_token, "POST", "/api/v1/invoke", { device_id: lampId, capability_id: "light.set", arguments: { on: false }, lease_id: lease.lease_id, idempotency_key: k });
  const i2 = await api<InvokeResponse>(bob.owner_token, "POST", "/api/v1/invoke", { device_id: lampId, capability_id: "light.set", arguments: { on: false }, lease_id: lease.lease_id, idempotency_key: k });
  ok(i1.json.invocation.invocation_id === i2.json.invocation.invocation_id, "same idempotency_key returns the same invocation");
  const afterIdem = await api<Lease>(bob.owner_token, "GET", `/api/v1/leases/${lease.lease_id}`);
  ok(afterIdem.json.used === 3, "idempotent replay did not consume quota (used=3)", afterIdem.json.used);

  console.log("\n# quota exhaustion");
  let lastStatus = 0;
  let lastCode = "";
  for (let n = 0; n < 5; n++) {
    const r = await api<{ code?: string }>(bob.owner_token, "POST", "/api/v1/invoke", { device_id: lampId, capability_id: "light.set", arguments: { on: n % 2 === 0 }, lease_id: lease.lease_id });
    lastStatus = r.status;
    lastCode = (r.json as { code?: string }).code ?? "";
    if (r.status !== 200) break;
  }
  ok(lastStatus === 429 && lastCode === "quota_exhausted", "invocations stop at quota 6", { lastStatus, lastCode });

  console.log("\n# release -> other visitor leases -> owner revoke");
  const rel = await api<{ lease: Lease }>(bob.owner_token, "POST", `/api/v1/leases/${lease.lease_id}/release`);
  ok(rel.json.lease.state === "released", "visitor released lease");
  const cq2 = await api<QuoteResponse>(carol.owner_token, "POST", "/api/v1/quotes", { refs: [refs[0]], duration_s: 60 });
  const cacc2 = await api<AcceptResponse>(carol.owner_token, "POST", `/api/v1/quotes/${cq2.json.offer.offer_id}/accept`, { offer_id: cq2.json.offer.offer_id, max_spend_cents: 100 });
  ok(cacc2.status === 200 && cacc2.json.lease.state === "active", "after release, carol can lease the lamp", cacc2.json);
  const cinv = await api<InvokeResponse>(carol.owner_token, "POST", "/api/v1/invoke", { device_id: lampId, capability_id: "light.set", arguments: { on: true } });
  ok(cinv.json.invocation?.state === "succeeded" && cinv.json.invocation.lease_id === cacc2.json.lease.lease_id, "invoke without lease_id picks carol's active lease");
  const ownerLeases = await api<Lease[]>(owner.owner_token, "GET", "/api/v1/leases?role=owner&active=1");
  ok(ownerLeases.json.length === 1 && ownerLeases.json[0].lease_id === cacc2.json.lease.lease_id, "owner sees carol's active lease");
  const notOwner = await api(bob.owner_token, "POST", `/api/v1/leases/${cacc2.json.lease.lease_id}/revoke`);
  ok(notOwner.status === 403 || notOwner.status === 404, "non-owner cannot revoke");
  const revokeMsg = conn.waitFor("revoke", 3000);
  const rev = await api<{ lease: Lease }>(owner.owner_token, "POST", `/api/v1/leases/${cacc2.json.lease.lease_id}/revoke`);
  ok(rev.json.lease.state === "revoked", "owner revoked (Stop access)");
  ok((await revokeMsg.catch(() => null))?.lease_id === cacc2.json.lease.lease_id, "connector received {type:'revoke'}");
  const afterRevoke = await api<{ code: string }>(carol.owner_token, "POST", "/api/v1/invoke", { device_id: lampId, capability_id: "light.set", arguments: { on: true }, lease_id: cacc2.json.lease.lease_id });
  ok(afterRevoke.status === 403 && afterRevoke.json.code === "lease_inactive", "next invoke after revoke is refused", afterRevoke.json);

  console.log("\n# expiry");
  const eq = await api<QuoteResponse>(carol.owner_token, "POST", "/api/v1/quotes", { refs: [refs[0]], duration_s: 2 });
  const eacc = await api<AcceptResponse>(carol.owner_token, "POST", `/api/v1/quotes/${eq.json.offer.offer_id}/accept`, { offer_id: eq.json.offer.offer_id, max_spend_cents: 100 });
  ok(eacc.json.lease?.state === "active", "short 2s lease active");
  await sleep(3500);
  const eget = await api<Lease>(carol.owner_token, "GET", `/api/v1/leases/${eacc.json.lease.lease_id}`);
  ok(eget.json.state === "expired", "sweeper expired the lease", eget.json.state);
  const einv = await api<{ code: string }>(carol.owner_token, "POST", "/api/v1/invoke", { device_id: lampId, capability_id: "light.set", arguments: { on: true }, lease_id: eacc.json.lease.lease_id });
  ok(einv.status === 403, "invoke on expired lease refused", einv.json);

  console.log("\n# own device (implicit lease) + timeout -> unknown");
  const own = await api<InvokeResponse>(owner.owner_token, "POST", "/api/v1/invoke", { device_id: lampId, capability_id: "light.set", arguments: { on: true } });
  ok(own.json.invocation?.state === "succeeded" && !!own.json.invocation.lease_id, "owner invokes own device via implicit zero-price lease", own.json);
  const yq = await api<QuoteResponse>(carol.owner_token, "POST", "/api/v1/quotes", { refs: [refs[0]], duration_s: 30 });
  const yacc = await api<AcceptResponse>(carol.owner_token, "POST", `/api/v1/quotes/${yq.json.offer.offer_id}/accept`, { offer_id: yq.json.offer.offer_id, max_spend_cents: 100 });
  const ownLease = await api<Lease>(owner.owner_token, "GET", `/api/v1/leases/${own.json.invocation.lease_id}`);
  ok(yacc.json.lease?.state === "active" && ownLease.json.state === "released", "owner's implicit test lease yields to a visitor's paid lease", { v: yacc.json, o: ownLease.json.state });
  await api(carol.owner_token, "POST", `/api/v1/leases/${yacc.json.lease?.lease_id}/release`);
  const tStart = Date.now();
  const hang = await api<InvokeResponse>(owner.owner_token, "POST", "/api/v1/invoke", { device_id: relayId, capability_id: "relay.set", arguments: { on: true }, timeout_ms: 1500 });
  ok(hang.json.invocation?.state === "unknown" && Date.now() - tStart < 1500 + 8000, "no result before deadline -> state unknown (never success)", hang.json);

  console.log("\n# public observation via internal adapter (no lease) + rate limit");
  const [pubCam] = await publishFromAdapter("smoke", [
    {
      manifest: {
        protocol_version: PROTOCOL_VERSION,
        local_key: "smoke-cam-1",
        name: "Smoke simulated public camera",
        device_class: "camera",
        transport: "http-public",
        access_type: "public_observation",
        terms: { price_cents: 0, currency: "USD", max_duration_s: 3600 },
        source: { operator: "Smoke simulator", attribution: "SIMULATED" },
        capabilities: [
          {
            capability_id: "image.observe",
            kind: "observe",
            semantic_type: "image.observe",
            title: "Latest still",
            description: "simulated",
            input_schema: { type: "object", properties: {}, additionalProperties: false },
            output: { media: "image/png" },
            verification: "observation",
            exclusive: false,
          },
        ],
      },
    },
  ]);
  ok(pubCam.owner_id === "provider:smoke" && pubCam.connector_id === "internal:smoke" && pubCam.status === "verified", "publishFromAdapter upserts internal device");
  const again = await publishFromAdapter("smoke", [{ manifest: { ...(pubCam as unknown as import("../src/lib/ghost/contracts").DeviceManifest) } }]);
  ok(again[0].device_id === pubCam.device_id, "publishFromAdapter is idempotent by local_key");
  const p1 = await api<InvokeResponse>(bob.owner_token, "POST", "/api/v1/invoke", { device_id: pubCam.device_id, capability_id: "image.observe" });
  ok(p1.json.invocation?.state === "succeeded" && p1.json.invocation.lease_id === null && p1.json.observation?.captured_at === null, "public observation without lease; captured_at null when unknown", p1.json);
  let limited = false;
  for (let n = 0; n < 21; n++) {
    const r = await api(bob.owner_token, "POST", "/api/v1/invoke", { device_id: pubCam.device_id, capability_id: "image.observe" });
    if (r.status === 429) {
      limited = true;
      break;
    }
  }
  ok(limited, "public observations are rate-limited (20/min per principal per device)");

  console.log("\n# late payment -> compensation_recorded");
  const lq = await api<QuoteResponse>(carol.owner_token, "POST", "/api/v1/quotes", { refs: [{ device_id: camId, capability_id: "camera.snapshot" }], duration_s: 30 });
  const before = (await api<LedgerResponse>(carol.owner_token, "GET", "/api/v1/ledger")).json.balance_cents;
  const late = await acceptQuote(carol.principal_id, lq.json.offer.offer_id, 100, { paymentDelayMs: 1500, reserveTtlS: 1 });
  const after = (await api<LedgerResponse>(carol.owner_token, "GET", "/api/v1/ledger")).json.balance_cents;
  ok(late.lease.state === "expired" && late.payment?.status === "compensation_recorded" && before === after, "late payment never activates; compensation recorded, net zero", { state: late.lease.state, payment: late.payment, before, after });

  console.log("\n# requires_approval");
  const patch = await api<{ terms: { requires_approval?: boolean; price_cents: number } }>(owner.owner_token, "PATCH", `/api/v1/devices/${camId}/terms`, { requires_approval: true, price_cents: 40, quota: null });
  ok(patch.status === 200 && patch.json.terms.requires_approval === true && patch.json.terms.price_cents === 40, "owner PATCH terms", patch.json);
  const badPatch = await api(bob.owner_token, "PATCH", `/api/v1/devices/${camId}/terms`, { price_cents: 1 });
  ok(badPatch.status === 403, "non-owner cannot change terms");
  const aq = await api<QuoteResponse>(bob.owner_token, "POST", "/api/v1/quotes", { refs: [{ device_id: camId, capability_id: "camera.snapshot" }], duration_s: 30 });
  const aacc = await api<AcceptResponse>(bob.owner_token, "POST", `/api/v1/quotes/${aq.json.offer.offer_id}/accept`, { offer_id: aq.json.offer.offer_id, max_spend_cents: 100 });
  ok(aacc.json.lease?.state === "reserved", "lease waits for owner approval (reserved, not charged)", aacc.json);
  const preApprove = await api<{ code: string }>(bob.owner_token, "POST", "/api/v1/invoke", { device_id: camId, capability_id: "camera.snapshot", lease_id: aacc.json.lease.lease_id });
  ok(preApprove.status === 403, "cannot invoke before approval");
  const appr = await api<{ lease: Lease }>(owner.owner_token, "POST", `/api/v1/leases/${aacc.json.lease.lease_id}/approve`);
  ok(appr.json.lease?.state === "active" && appr.json.lease.payment?.amount_cents === 40, "owner approval pays + activates", appr.json);
  await api(owner.owner_token, "PATCH", `/api/v1/devices/${camId}/terms`, { requires_approval: false });

  console.log("\n# experiences");
  const e1 = await api(bob.owner_token, "POST", "/api/v1/experiences", { goal: "turn on the simulated lamp and verify with camera", refs, outcome: "verified", summary: "lamp on, camera saw glow", evidence: [obs.observation_id], cost_cents: 30 });
  const e2 = await api(bob.owner_token, "POST", "/api/v1/experiences", { goal: "turn on lamp", refs: [refs[0]], outcome: "failed", summary: "quota exhausted", failures: ["quota_exhausted"] });
  const e3 = await api(bob.owner_token, "POST", "/api/v1/experiences", { goal: "x", refs: [], outcome: "great", summary: "y" });
  ok(e1.status === 201 && e2.status === 201 && e3.status === 400, "record experiences; invalid outcome rejected");
  const rec = await api<ExperienceSearchResponse>(bob.owner_token, "GET", "/api/v1/experiences?q=lamp%20camera");
  ok(rec.json.counts.total === 2 && rec.json.counts.verified === 1 && rec.json.counts.failed === 1, "recall returns matches with counts (sample size)", rec.json.counts);
  const s4 = await api<CapabilityHit[]>(bob.owner_token, "GET", "/api/v1/capabilities?q=simulated%20lamp");
  ok(s4.json.find((h) => h.ref === `${lampId}/light.set`)?.experience?.attempts === 2, "search attaches experience counts");

  console.log("\n# pairing flow");
  const pr = await api<{ pairing_id: string; code: string; join_path: string }>(owner.owner_token, "POST", "/api/v1/pairings");
  ok(pr.status === 201 && /^[A-Z0-9]{6}$/.test(pr.json.code) && pr.json.join_path === `/join#code=${pr.json.code}`, "pairing invitation with 6-char code", pr.json);
  const phone = startFakeConnector({ url: BASE, pairing_code: pr.json.code, label: "Simulated phone", log: () => {}, manifests: [simulatedManifests()[1]].map((m) => ({ ...m, local_key: "phone-cam", name: "Simulated phone camera" })) });
  await phone.waitFor("pending_confirmation", 3000);
  const pend = await api<PairingInfo[]>(owner.owner_token, "GET", "/api/v1/pairings?pending=1");
  ok(pend.json.some((p) => p.pairing_id === pr.json.pairing_id && p.status === "pending" && p.label === "Simulated phone"), "pending pairing listed for owner");
  const dup = startFakeConnector({ url: BASE, pairing_code: pr.json.code, label: "Intruder", log: () => {} });
  const dupErr = await dup.waitFor("error", 3000).catch(() => null);
  ok(!!dupErr, "pairing code is one-use");
  dup.close();
  const conf = await api(owner.owner_token, "POST", `/api/v1/pairings/${pr.json.pairing_id}/confirm`);
  const pw = await phone.welcome.catch(() => null);
  ok(conf.status === 200 && !!pw?.credential, "owner confirm -> connector gets welcome with new credential");
  const phonePub = await phone.published.catch(() => null);
  ok(phonePub?.devices[0]?.status === "configured", "confirmed connector publishes");
  phone.close();
  await sleep(300);
  const phoneDev = await api<{ online: boolean }>(owner.owner_token, "GET", `/api/v1/devices/${phonePub?.devices[0]?.device_id}`);
  ok(phoneDev.json.online === false, "socket close marks devices offline");
  const phone2 = startFakeConnector({ url: BASE, credential: pw!.credential, log: () => {}, manifests: [simulatedManifests()[1]].map((m) => ({ ...m, local_key: "phone-cam", name: "Simulated phone camera" })) });
  const pw2 = await phone2.welcome.catch(() => null);
  const pp2 = await phone2.published.catch(() => null);
  ok(pw2?.connector_id === pw?.connector_id && pp2?.devices[0]?.device_id === phonePub?.devices[0]?.device_id, "reconnect with credential keeps connector + device ids");
  phone2.close();

  console.log("\n# WebRTC signaling relay");
  const viewerOk = new WebSocket(`${BASE.replace("http", "ws")}/v1/device-channel`, { headers: { cookie: owner.cookie } });
  await new Promise((r) => viewerOk.on("open", r));
  const sigReply = new Promise<{ type: string; from?: string; data?: { sdp?: string } }>((resolve) =>
    viewerOk.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "signal") resolve(m);
    }),
  );
  viewerOk.send(JSON.stringify({ type: "signal", session_id: "sess-1", to: "device", data: { device_id: camId, type: "offer", sdp: "x" } }));
  const reply = await Promise.race([sigReply, sleep(3000).then(() => null)]);
  ok(reply?.from === "device" && reply?.data?.sdp === "SIMULATED-SDP-ANSWER", "viewer offer relayed to device and answer relayed back", reply);
  viewerOk.close();
  const viewerNo = new WebSocket(`${BASE.replace("http", "ws")}/v1/device-channel`, { headers: { cookie: carol.cookie } });
  await new Promise((r) => viewerNo.on("open", r));
  const denied = new Promise<{ type: string; message?: string }>((resolve) => viewerNo.on("message", (raw) => resolve(JSON.parse(raw.toString()))));
  viewerNo.send(JSON.stringify({ type: "signal", session_id: "sess-2", to: "device", data: { device_id: camId } }));
  const d = await Promise.race([denied, sleep(3000).then(() => null)]);
  ok(d?.type === "error" && /lease/.test(d.message ?? ""), "viewer without lease is refused", d);
  viewerNo.close();

  console.log("\n# SSE + MCP");
  const ac = new AbortController();
  ok((await fetch(`${BASE}/api/v1/events`)).status === 401, "anonymous event stream refused");
  const sse = await fetch(`${BASE}/api/v1/events`, { signal: ac.signal, headers: { authorization: `Bearer ${bob.owner_token}` } });
  ok(sse.headers.get("content-type")?.includes("text/event-stream"), "GET /events is an SSE stream");
  const reader = sse.body!.getReader();
  emit({ type: "ledger.updated", principal_id: owner.principal_id, balance_cents: 987654321 });
  void api(owner.owner_token, "PATCH", `/api/v1/devices/${lampId}/terms`, { note: "sse test" });
  let sseText = "";
  const until = Date.now() + 3000;
  while (Date.now() < until && !sseText.includes("device.updated")) {
    const { value, done } = await Promise.race([reader.read(), sleep(3000).then(() => ({ value: undefined, done: true }))]);
    if (done) break;
    sseText += new TextDecoder().decode(value);
  }
  ok(sseText.includes('"type":"device.updated"'), "SSE delivered device.updated");
  ok(!sseText.includes("987654321"), "event stream excludes another account’s private activity");
  ac.abort();

  const mcpHeaders = { authorization: `Bearer ${bob.owner_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
  const init = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: mcpHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } }),
  });
  ok(init.status === 200, "MCP initialize", await init.text().catch(() => ""));
  const tl = await fetch(`${BASE}/mcp`, { method: "POST", headers: mcpHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) });
  const tlj = (await tl.json()) as { result?: { tools: { name: string }[] } };
  const names = tlj.result?.tools.map((t) => t.name) ?? [];
  ok(["search_capabilities", "get_capability", "quote_lease", "accept_quote", "invoke_capability", "release_lease", "recall_experience", "record_experience", "update_offer", "revoke_lease"].every((n) => names.includes(n)), "MCP tools/list has all tools", names);
  const call = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: mcpHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "invoke_capability", arguments: { ref: `${pubCam.device_id}/image.observe` } } }),
  });
  const cj = (await call.json()) as { result?: { content: { type: string; mimeType?: string }[]; isError?: boolean } };
  // bob may be rate-limited on this public camera from the loop above; use carol instead if so
  let content = cj.result?.content ?? [];
  if (!content.some((c) => c.type === "image")) {
    const call2 = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders, authorization: `Bearer ${carol.owner_token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "invoke_capability", arguments: { ref: `${pubCam.device_id}/image.observe` } } }),
    });
    content = ((await call2.json()) as typeof cj).result?.content ?? [];
  }
  ok(content.some((c) => c.type === "image" && c.mimeType === "image/png") && content.some((c) => c.type === "text"), "MCP invoke_capability returns image + provenance text", content.map((c) => c.type));
  const noAuth = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  ok(noAuth.status === 401, "MCP without bearer -> 401");

  ok(events.includes("lease.updated") && events.includes("invocation.updated") && events.includes("ledger.updated"), "event bus emitted lease/invocation/ledger events");

  conn.close();
  if (usePg) await db().query(`drop schema if exists ${schema} cascade`).catch((e) => console.log("drop schema failed", e.message));
  await coord.stop();
  console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${passed} passed, ${failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke test crashed:", e);
  process.exit(1);
});
