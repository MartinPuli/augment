/**
 * Connector SDK against the REAL coordinator (not the mock).
 *
 *   GHOST_ORIGIN=http://localhost:3000 pnpm exec tsx scripts/conn-real-test.ts
 *
 * Covers: owner_token hello, publish, invoke round trip (value + media upload), phone pairing
 * (pairing_code → pending_confirmation → owner confirm → welcome → publish), and WebRTC signal
 * relay viewer → phone → viewer.
 */
import { GhostConnector } from "../src/lib/connector/client";
import type { DriverDevice, KV } from "../src/lib/connector/types";
import { makeManifest, sleep } from "../src/lib/connector/util";

const ORIGIN = (process.env.GHOST_ORIGIN || "http://localhost:3000").replace(/\/$/, "");
const WS = ORIGIN.replace(/^http/, "ws") + "/v1/device-channel";
let cookie = "";
let failures = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
}

const memKV = (): KV => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};

async function api<T = Record<string, unknown>>(path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const r = await fetch(ORIGIN + "/api/v1" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = r.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(";")[0]).join("; ");
  const text = await r.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json: json as T };
}

function waitFor(c: GhostConnector, pred: () => boolean, ms = 6000): Promise<void> {
  if (pred()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      unsub();
      reject(new Error(`timeout; status=${c.getSnapshot().status} detail=${c.getSnapshot().detail}`));
    }, ms);
    const unsub = c.subscribe(() => {
      if (pred()) {
        clearTimeout(t);
        unsub();
        resolve();
      }
    });
  });
}

async function invoke(device_id: string, capability_id: string, args: Record<string, unknown> = {}) {
  let r = await api<Record<string, unknown>>("/invoke", { device_id, capability_id, arguments: args });
  if (r.status >= 400 && /lease/i.test(JSON.stringify(r.json))) {
    const q = await api<{ offer: { offer_id: string } }>("/quotes", { refs: [{ device_id, capability_id }], duration_s: 120 });
    const a = await api<{ lease: { lease_id: string } }>(`/quotes/${q.json.offer?.offer_id}/accept`, { offer_id: q.json.offer?.offer_id, max_spend_cents: 0 });
    r = await api("/invoke", { device_id, capability_id, arguments: args, lease_id: a.json.lease?.lease_id });
  }
  return r as { status: number; json: { invocation?: { state: string; error?: string; observation_id?: string | null }; observation?: { value?: unknown; media_url?: string; observation_id?: string } | null } };
}

async function main() {
  const me = await api<{ principal_id: string; owner_token: string }>("/me");
  check("GET /me → owner_token", me.status === 200 && !!me.json.owner_token, me);

  let echoArgs: unknown = null;
  const rig: DriverDevice = {
    manifest: makeManifest({
      local_key: "sdk-test-rig",
      name: "SDK test rig",
      device_class: "other",
      transport: "browser",
      capabilities: [
        { capability_id: "test.echo", kind: "measure", semantic_type: "test.echo", title: "Echo", description: "echo x", input_schema: { type: "object" }, output: { unit: "u" }, verification: "observation" },
        { capability_id: "test.photo", kind: "observe", semantic_type: "image.observe", title: "Photo", description: "tiny jpeg", input_schema: { type: "object" }, output: { media: "image/jpeg" }, verification: "observation" },
      ],
    }),
    async handler(cap, args, ctx) {
      if (cap === "test.echo") {
        echoArgs = args;
        return { value: Number(args.x ?? 1), unit: "u", captured_at: new Date().toISOString() };
      }
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);
      const id = await ctx.upload(new Blob([jpeg], { type: "image/jpeg" }), { capturedAt: new Date() });
      return { observation_id: id, captured_at: new Date().toISOString() };
    },
  };

  const desk = new GhostConnector({ url: WS, connectorKind: "desktop-browser", label: "sdk test desktop", ownerToken: me.json.owner_token, expectedOwnerId: me.json.principal_id, storage: memKV() });
  desk.registerDevice(rig);
  desk.start();
  await waitFor(desk, () => desk.getSnapshot().status === "online");
  check("desktop hello(owner_token) → welcome", desk.getSnapshot().owner_id === me.json.principal_id, desk.getSnapshot());
  await waitFor(desk, () => !!desk.getSnapshot().devices[0]?.device_id);
  const rigId = desk.getSnapshot().devices[0].device_id!;
  check("publish → published with device_id", !!rigId, desk.getSnapshot().devices);

  const r1 = await invoke(rigId, "test.echo", { x: 5 });
  check("invoke test.echo via coordinator → succeeded", r1.json.invocation?.state === "succeeded" && (echoArgs as { x?: number })?.x === 5, r1);
  const r2 = await invoke(rigId, "test.photo");
  check("invoke test.photo → media uploaded", r2.json.invocation?.state === "succeeded" && !!r2.json.invocation?.observation_id, r2);

  // Phone pairing
  const pr = await api<{ pairing_id: string; code: string; join_path: string }>("/pairings", {});
  check("POST /pairings → code + join_path", !!pr.json.code && /code=/.test(pr.json.join_path), pr);
  const phoneKV = memKV();
  const phone = new GhostConnector({ url: WS, connectorKind: "phone-browser", label: "SDK test phone", pairingCode: pr.json.code, storage: phoneKV });
  let answered = "";
  phone.registerDevice({
    manifest: makeManifest({
      local_key: "phone",
      name: "SDK test phone",
      device_class: "phone",
      transport: "browser",
      capabilities: [
        { capability_id: "camera.stream", kind: "stream", semantic_type: "video.stream", title: "Live", description: "", input_schema: { type: "object" }, verification: "observation" },
      ],
    }),
    handler: async () => ({ value: "live" }),
    onSignal: (sid, data, reply) => {
      answered = sid;
      reply({ kind: "answer", sdp: "fake", echo: data });
    },
  });
  phone.start();
  await waitFor(phone, () => phone.getSnapshot().status === "pending_confirmation");
  check("phone hello(pairing_code) → pending_confirmation", phone.getSnapshot().pairing_id === pr.json.pairing_id, phone.getSnapshot());
  const conf = await api(`/pairings/${pr.json.pairing_id}/confirm`, {});
  check("owner confirm → 200", conf.status < 300, conf);
  await waitFor(phone, () => phone.getSnapshot().status === "online");
  check("phone welcomed after confirm + credential stored", !!phoneKV.getItem("ghost.connector.phone-browser.credential"));
  await waitFor(phone, () => !!phone.getSnapshot().devices[0]?.device_id);
  const phoneId = phone.getSnapshot().devices[0].device_id!;
  check("phone published", !!phoneId, phone.getSnapshot().devices);

  // Signal relay: the desktop socket is the viewer
  const got = new Promise<unknown>((resolve) => desk.onViewerSignal("sess_sdk", (d) => resolve(d)));
  const errs: string[] = [];
  desk.on("message", (m) => m.type === "error" && errs.push(m.message));
  desk.sendSignal("sess_sdk", "device", { device_id: phoneId, kind: "offer", sdp: "x" });
  const ans = (await Promise.race([got, sleep(4000).then(() => null)])) as { kind?: string } | null;
  check("signal relay desktop(viewer) → phone → desktop", ans?.kind === "answer" && answered === "sess_sdk", { ans, errs });

  // Reconnect phone with its credential
  phone.stop();
  const phone2 = new GhostConnector({ url: WS, connectorKind: "phone-browser", label: "SDK test phone", storage: phoneKV });
  phone2.start();
  await waitFor(phone2, () => phone2.getSnapshot().status === "online");
  check("phone reconnects with stored credential", phone2.getSnapshot().owner_id === me.json.principal_id, phone2.getSnapshot());
  phone2.stop();

  desk.unpublish(["sdk-test-rig"]);
  await sleep(300);
  desk.stop();
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("crashed:", e);
  process.exit(1);
});
