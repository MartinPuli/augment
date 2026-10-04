/**
 * End-to-end test of GHOST missions (Mastra workflows), including suspend -> resume.
 *
 *   pnpm exec tsx scripts/infra-mission-test.ts           # real coordinator, in-process (default)
 *   pnpm exec tsx scripts/infra-mission-test.ts --mock    # tiny mocked /api/v1 instead
 *
 * Real mode boots the actual coordinator standalone (no Next.js) on 127.0.0.1:3197 with an
 * in-memory PGlite database, connects a fake WebSocket connector that publishes a camera
 * (camera.snapshot) and a cover actuator (cover.open / cover.close) plus a public camera,
 * mounts the mission HTTP routes on :3198, and drives the missions over HTTP.
 * Fake devices are labelled as fake; no real hardware is touched.
 */
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { rmSync } from "node:fs";

const MOCK = process.argv.includes("--mock");
// --neon-storage: keep Mastra mission snapshots/traces in Neon Postgres (DATABASE_URL from .env.local).
const NEON_STORAGE = process.argv.includes("--neon-storage");
const COORD_PORT = Number(process.env.INFRA_TEST_PORT || 3197);
const ROUTES_PORT = COORD_PORT + 1;
const COORD = `http://127.0.0.1:${COORD_PORT}`;
const ZONE = "infra-test-table";

// Configure before Mastra / coordinator modules load.
const dbFile = path.join(os.tmpdir(), `ghost-mission-test-${process.pid}.db`);
process.env.GHOST_COORDINATOR_URL = COORD;
process.env.GHOST_SKIP_ADAPTERS = "1";
if (NEON_STORAGE) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("dotenv").config({ path: ".env.local", quiet: true });
  if (!process.env.DATABASE_URL) throw new Error("--neon-storage needs DATABASE_URL");
  delete process.env.MASTRA_STORAGE_URL;
} else {
  process.env.MASTRA_STORAGE_URL = `file:${dbFile}`;
  delete process.env.DATABASE_URL;
}
delete process.env.GHOST_MISSION_OWNER_TOKEN;

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `\n      -> ${JSON.stringify(detail).slice(0, 600)}` : ""}`);
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function api(base: string, method: string, p: string, token?: string, body?: unknown): Promise<{ status: number; data: Json }> {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data: Json = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { status: r.status, data };
}

/* ------------------------------------------------------------------ */
/* Fake connector (real device channel protocol over WebSocket)        */
/* ------------------------------------------------------------------ */

async function startFakeConnector(ownerToken: string): Promise<{ close: () => void; coverOpen: () => boolean }> {
  let coverOpen = false;
  const ws = new WebSocket(`ws://127.0.0.1:${COORD_PORT}/v1/device-channel`);
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  const cap = (id: string, kind: string, semantic: string, extra: Json = {}) => ({
    capability_id: id,
    kind,
    semantic_type: semantic,
    title: id,
    description: `FAKE ${id} (test double)`,
    input_schema: { type: "object", properties: {} },
    verification: kind === "observe" ? "observation" : "reported_state",
    ...extra,
  });
  const terms = (price: number) => ({ price_cents: price, currency: "USD", max_duration_s: 900 });
  const manifests = [
    {
      protocol_version: "ghost/0.1",
      local_key: "cam1",
      name: "Fake bench camera",
      device_class: "camera",
      transport: "other",
      zone_id: ZONE,
      access_type: "owner_shared",
      terms: terms(20),
      capabilities: [cap("camera.snapshot", "observe", "image.observe", { output: { media: "image/jpeg" } })],
    },
    {
      protocol_version: "ghost/0.1",
      local_key: "cover1",
      name: "Fake cover servo",
      device_class: "actuator",
      transport: "other",
      zone_id: ZONE,
      access_type: "owner_shared",
      terms: terms(10),
      capabilities: [
        cap("cover.open", "act", "cover.open", { affects_view_of: "Fake bench camera" }),
        cap("cover.close", "act", "cover.close"),
      ],
    },
    {
      protocol_version: "ghost/0.1",
      local_key: "pubcam",
      name: "Fake public still camera",
      device_class: "camera",
      transport: "other",
      zone_id: "infra-test-street",
      access_type: "public_observation",
      terms: terms(0),
      capabilities: [cap("camera.snapshot", "observe", "image.observe", { output: { media: "image/jpeg" } })],
    },
  ];
  const ready = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("fake connector: no 'published' within 8s")), 8_000);
    ws.addEventListener("open", () => send({ type: "hello", protocol_version: "ghost/0.1", connector_kind: "other", label: "infra-mission-test (FAKE devices)", owner_token: ownerToken }));
    ws.addEventListener("message", async (ev) => {
      const msg = JSON.parse(String(ev.data)) as Json;
      if (msg.type === "welcome") send({ type: "publish", devices: manifests });
      else if (msg.type === "published") {
        clearTimeout(t);
        resolve();
      } else if (msg.type === "ping") send({ type: "heartbeat", at: new Date().toISOString() });
      else if (msg.type === "error") console.log("  [fake connector] error:", msg.message);
      else if (msg.type === "invoke") {
        try {
          if (msg.capability_id === "camera.snapshot") {
            const bytes = Buffer.from(`FAKE-JPEG ${msg.local_key} cover=${coverOpen ? "open" : "closed"} ${Date.now()}`);
            const up = await fetch(msg.upload.url, {
              method: "POST",
              headers: { authorization: `Bearer ${msg.upload.token}`, "content-type": "image/jpeg", "x-captured-at": new Date().toISOString() },
              body: bytes,
            });
            const j = (await up.json()) as Json;
            if (!up.ok) throw new Error(`upload ${up.status}: ${JSON.stringify(j)}`);
            send({ type: "result", invocation_id: msg.invocation_id, state: "succeeded", output: { observation_id: j.observation_id, captured_at: new Date().toISOString() } });
          } else if (msg.capability_id === "cover.open" || msg.capability_id === "cover.close") {
            coverOpen = msg.capability_id === "cover.open";
            send({ type: "result", invocation_id: msg.invocation_id, state: "succeeded", output: { value: coverOpen ? "open" : "closed", data: { cover: coverOpen ? "open" : "closed" } } });
          } else {
            send({ type: "result", invocation_id: msg.invocation_id, state: "rejected", error: "unsupported" });
          }
        } catch (e) {
          send({ type: "result", invocation_id: msg.invocation_id, state: "failed", error: (e as Error).message });
        }
      }
    });
    ws.addEventListener("error", () => reject(new Error("fake connector websocket error")));
  });
  await ready;
  return { close: () => ws.close(), coverOpen: () => coverOpen };
}

/* ------------------------------------------------------------------ */
/* Mock /api/v1 (fallback when the coordinator cannot boot)            */
/* ------------------------------------------------------------------ */

function startMockCoordinator(): Promise<http.Server> {
  let n = 0;
  const nid = (p: string) => `${p}_mock${++n}`;
  const leases = new Map<string, Json>();
  const hits = [
    { ref: "cam1/camera.snapshot", device: { device_id: "cam1", name: "Mock camera", device_class: "camera", zone_id: ZONE, owner_id: "pr_owner", access_type: "owner_shared", online: true, status: "verified" }, capability: { capability_id: "camera.snapshot", kind: "observe", semantic_type: "image.observe" }, terms: { price_cents: 20 } },
    { ref: "cover1/cover.open", device: { device_id: "cover1", name: "Mock cover", device_class: "actuator", zone_id: ZONE, owner_id: "pr_owner", access_type: "owner_shared", online: true, status: "verified" }, capability: { capability_id: "cover.open", kind: "act", semantic_type: "cover.open", affects_view_of: "cam1" }, terms: { price_cents: 10 } },
    { ref: "pubcam/camera.snapshot", device: { device_id: "pubcam", name: "Mock public cam", device_class: "camera", zone_id: "street", owner_id: "provider:x", access_type: "public_observation", online: true, status: "verified" }, capability: { capability_id: "camera.snapshot", kind: "observe", semantic_type: "image.observe" }, terms: { price_cents: 0 } },
  ];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname.replace(/^\/api\/v1/, "");
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.headers.authorization !== "Bearer mock-token") return send(401, { error: "unauthorized", code: "unauthorized" });
    if (req.method === "GET" && p === "/capabilities") return send(200, hits.filter((h) => !url.searchParams.get("zone_id") || h.device.zone_id === url.searchParams.get("zone_id")));
    if (req.method === "POST" && p === "/quotes") {
      const price = (body.refs as Json[]).reduce((s, r) => s + (hits.find((h) => h.device.device_id === r.device_id)?.terms.price_cents ?? 0), 0);
      return send(200, { offer: { offer_id: nid("off"), owner_id: "pr_owner", price_cents: price, status: "open", refs: body.refs }, host_message: "Mock host: list price." });
    }
    let m = /^\/quotes\/([^/]+)\/accept$/.exec(p);
    if (req.method === "POST" && m) {
      const lease = { lease_id: nid("lse"), state: "active", price_cents: 30, refs: [] };
      leases.set(lease.lease_id, lease);
      return send(200, { lease, payment: null, balance_cents: 970 });
    }
    m = /^\/leases\/([^/]+)\/release$/.exec(p);
    if (req.method === "POST" && m) {
      const l = leases.get(m[1]);
      if (!l) return send(404, { error: "lease not found" });
      l.state = "released";
      return send(200, { lease: l });
    }
    if (req.method === "POST" && p === "/invoke") {
      const inv = { invocation_id: nid("inv"), state: "succeeded", device_id: body.device_id, capability_id: body.capability_id };
      if (body.device_id === "missing") return send(404, { error: "device not found", code: "not_found" });
      const obs = body.capability_id === "camera.snapshot" ? { observation_id: nid("obs"), media_url: `/api/v1/observations/x/media`, captured_at: new Date().toISOString() } : null;
      return send(200, { invocation: { ...inv, observation_id: obs?.observation_id ?? null }, observation: obs });
    }
    if (req.method === "POST" && p === "/experiences") return send(201, { experience_id: nid("exp"), ...body });
    return send(404, { error: `no mock route ${req.method} ${p}` });
  });
  return new Promise((r) => server.listen(COORD_PORT, "127.0.0.1", () => r(server)));
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  console.log(`GHOST mission test (${MOCK ? "mocked /api/v1" : "real coordinator, in-process"}); Mastra storage: ${NEON_STORAGE ? "Neon Postgres (schema mastra)" : process.env.MASTRA_STORAGE_URL}`);
  const missions = await import("../src/lib/ghost/server/missions");
  const cleanups: (() => Promise<void> | void)[] = [];

  let visitor = { principal_id: "pr_mock_visitor", owner_token: "mock-token" };
  let routesBase: string | null = null;
  let pubRef = "pubcam/camera.snapshot";

  if (MOCK) {
    const srv = await startMockCoordinator();
    cleanups.push(() => void srv.close());
  } else {
    const { startCoordinator } = await import("../src/lib/ghost/server");
    const coord = await startCoordinator({ databaseUrl: "", dataDir: "memory", skipAdapters: true, listenPort: COORD_PORT, hostname: "127.0.0.1" });
    cleanups.push(() => coord.stop());
    const owner = (await api(COORD, "GET", "/api/v1/me")).data;
    const v = (await api(COORD, "GET", "/api/v1/me")).data;
    check("coordinator issued two principals", !!owner.owner_token && !!v.owner_token && owner.principal_id !== v.principal_id, { owner, v });
    visitor = { principal_id: v.principal_id, owner_token: v.owner_token };
    const fake = await startFakeConnector(owner.owner_token);
    cleanups.push(() => fake.close());
    const caps = (await api(COORD, "GET", `/api/v1/capabilities?zone_id=${ZONE}&limit=50`, visitor.owner_token)).data as unknown as Json[];
    const pub = (await api(COORD, "GET", `/api/v1/capabilities?zone_id=infra-test-street`, visitor.owner_token)).data as unknown as Json[];
    pubRef = pub[0]?.ref ?? pubRef;
    check("fake devices visible in catalog", Array.isArray(caps) && caps.length >= 3 && pub.length >= 1, caps);

    // Mission HTTP routes on their own Hono app (the coordinator router wires them under /api/v1).
    const { Hono } = await import("hono");
    const { getRequestListener } = await import("@hono/node-server");
    const { mountMissionRoutes } = await import("../src/lib/ghost/server/missions/routes");
    const v1 = new Hono();
    mountMissionRoutes(v1);
    const app = new Hono().route("/api/v1", v1);
    const listener = getRequestListener(app.fetch);
    const rs = http.createServer((req, res) => void listener(req, res));
    await new Promise<void>((r) => rs.listen(ROUTES_PORT, "127.0.0.1", r));
    cleanups.push(() => void rs.close());
    routesBase = `http://127.0.0.1:${ROUTES_PORT}`;
  }

  /* 1. inspect-with-actuator -> suspended at verify */
  const t0 = Date.now();
  let run: Json;
  if (routesBase) {
    const r = await api(routesBase, "POST", "/api/v1/missions/inspect-with-actuator/run", visitor.owner_token, {
      zone_id: ZONE,
      goal: "See what is under the cover on the test table",
      max_spend_cents: 100,
      settle_ms: 200,
      restore_capability: "cover.close",
    });
    check("POST /missions/inspect-with-actuator/run -> 200", r.status === 200, r);
    run = r.data;
  } else {
    run = (await missions.runMission(
      "inspect-with-actuator",
      { zone_id: ZONE, goal: "See what is under the cover", max_spend_cents: 100, settle_ms: 200, restore_capability: "cover.close" },
      visitor,
    )) as unknown as Json;
  }
  console.log(`  run ${run.run_id} -> ${run.status} in ${Date.now() - t0} ms; steps: ${(run.steps as Json[]).map((s) => `${s.id}:${s.status}`).join(" ")}`);
  check("mission suspends at verify", run.status === "suspended" && run.suspended?.step === "verify", run);
  const payload = run.suspended?.payload ?? {};
  check("suspend payload carries baseline + after observation ids", !!payload.baseline?.observation_id && !!payload.after?.observation_id && payload.baseline.observation_id !== payload.after.observation_id, payload);
  const ev = run.evidence as string[];
  check("evidence trail includes both photos", ev.includes(payload.baseline?.observation_id) && ev.includes(payload.after?.observation_id), ev);
  const leaseStep = (run.steps as Json[]).find((s) => s.id === "lease");
  check("lease step succeeded", leaseStep?.status === "success", leaseStep);

  /* 2. GET run; another principal cannot see it */
  const got = routesBase
    ? (await api(routesBase, "GET", `/api/v1/missions/runs/${run.run_id}`, visitor.owner_token)).data
    : ((await missions.getMission(run.run_id, visitor)) as unknown as Json);
  check("GET run reports suspended (from Mastra storage)", got.status === "suspended" && got.suspended?.step === "verify", got);
  if (routesBase) {
    const stranger = (await api(COORD, "GET", "/api/v1/me")).data;
    const r = await api(routesBase, "GET", `/api/v1/missions/runs/${run.run_id}`, stranger.owner_token);
    check("other principal gets 404 for the run", r.status === 404, r);
    const anon = await api(routesBase, "POST", "/api/v1/missions/patrol-cameras/run", undefined, { refs: [pubRef] });
    check("anonymous run -> 401", anon.status === 401, anon);
    const badIn = await api(routesBase, "POST", "/api/v1/missions/patrol-cameras/run", visitor.owner_token, { refs: [] });
    check("invalid input -> 400", badIn.status === 400, badIn);
  }

  /* 3. resume with a verdict -> release + experience */
  // Simulate a coordinator restart for credentials: the resuming caller must supply them again.
  (await import("../src/mastra/coordinator")).clearRunCredential(run.run_id);
  const resumeBody = { verdict: "verified", summary: "Cover is open in the after photo; the part is visible.", verifier: "vision_model" };
  const done = routesBase
    ? (await api(routesBase, "POST", `/api/v1/missions/runs/${run.run_id}/resume`, visitor.owner_token, resumeBody)).data
    : ((await missions.resumeMission(run.run_id, resumeBody, visitor)) as unknown as Json);
  console.log(`  resumed -> ${done.status}; steps: ${(done.steps as Json[]).map((s) => `${s.id}:${s.status}`).join(" ")}`);
  const result = done.result ?? {};
  check("resume completes the mission", done.status === "success", done);
  check("outcome verified + experience recorded", result.outcome === "verified" && !!result.experience_id, result);
  check("restore (cover.close) ran", (result.invocations as Json[] | undefined)?.some((i) => i.step === "restore" && i.state === "succeeded") === true, result.invocations);
  check("cost within budget", typeof result.cost_cents === "number" && result.cost_cents <= 100, result.cost_cents);
  if (!MOCK) {
    for (const id of (result.lease_ids as string[]) ?? []) {
      const l = await api(COORD, "GET", `/api/v1/leases/${id}`, visitor.owner_token);
      check(`lease ${id} released`, l.data.state === "released", l.data);
    }
    const ex = await api(COORD, "GET", `/api/v1/experiences?mine=1`, visitor.owner_token);
    check("experience is recallable", JSON.stringify(ex.data).includes(String(result.experience_id)), ex.data);
  }
  const again = routesBase
    ? await api(routesBase, "POST", `/api/v1/missions/runs/${run.run_id}/resume`, visitor.owner_token, resumeBody)
    : { status: await missions.resumeMission(run.run_id, resumeBody, visitor).then(() => 200, (e) => e.status) };
  check("second resume -> 409 (not suspended)", again.status === 409, again);

  /* 4. Over budget -> honest failure, nothing actuated */
  const poor = (await missions.runMission("inspect-with-actuator", { zone_id: ZONE, max_spend_cents: 1, approval_wait_s: 0 }, visitor)) as unknown as Json;
  const pr = poor.result ?? {};
  check("over-budget mission records outcome=failed", poor.status === "success" && pr.outcome === "failed", poor);
  check("over-budget mission never actuated", !(pr.invocations as Json[] | undefined)?.some((i) => i.step === "actuate"), pr.invocations);
  check("failure explains the budget", JSON.stringify(pr.failures ?? []).includes("budget"), pr.failures);

  /* 5. patrol-cameras: one observable, one missing */
  const patrol = (await missions.runMission("patrol-cameras", { refs: [pubRef, "missing/camera.snapshot"], record_experience: true }, visitor)) as unknown as Json;
  const pres = patrol.result ?? {};
  console.log(`  patrol -> ${patrol.status}: observed=${pres.observed} failed=${pres.failed} ids=${JSON.stringify(pres.observation_ids)}`);
  check("patrol returns an observation id for the reachable camera", patrol.status === "success" && pres.observed === 1 && pres.observation_ids?.length === 1, patrol);
  check("patrol reports the missing camera as failed", pres.failed === 1, pres.observations);

  for (const c of cleanups.reverse()) await c();
  rmSync(dbFile, { force: true });
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  rmSync(dbFile, { force: true });
  process.exit(1);
});
