/**
 * End-to-end test of the browser connector SDK (GhostConnector) against the mock coordinator.
 *
 *   pnpm exec tsx scripts/conn-ws-mock.ts            # terminal 1 (port 3200)
 *   pnpm exec tsx scripts/conn-client-test.ts        # terminal 2
 *
 * Runs in Node (global WebSocket/fetch/Blob), with fake devices standing in for hardware.
 */
import { GhostConnector } from "../src/lib/connector/client";
import { InvokeError, type DriverDevice, type KV } from "../src/lib/connector/types";
import { makeManifest, sleep } from "../src/lib/connector/util";

const PORT = Number(process.env.MOCK_PORT || 3200);
const HTTP = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}/v1/device-channel`;

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
}

function memKV(): KV {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

async function post(path: string, body: unknown) {
  const r = await fetch(HTTP + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return (await r.json()) as { result?: { state: string; output?: Record<string, unknown>; error?: string; timeout?: boolean } };
}

function waitFor(c: GhostConnector, pred: () => boolean, ms = 5000): Promise<void> {
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

async function main() {
  let echoCalls = 0;
  let slowAborted = "";
  const revoked: string[] = [];
  const device: DriverDevice = {
    manifest: makeManifest({
      local_key: "test-rig",
      name: "Test rig",
      device_class: "other",
      transport: "browser",
      capabilities: [
        { capability_id: "test.echo", kind: "measure", semantic_type: "test.echo", title: "Echo", description: "", input_schema: { type: "object" }, verification: "observation" },
        { capability_id: "test.photo", kind: "observe", semantic_type: "image.observe", title: "Photo", description: "", input_schema: { type: "object" }, output: { media: "image/jpeg" }, verification: "observation" },
        { capability_id: "test.slow", kind: "act", semantic_type: "test.slow", title: "Slow", description: "", input_schema: { type: "object" }, verification: "acknowledgment" },
        { capability_id: "test.bad", kind: "act", semantic_type: "test.bad", title: "Bad", description: "", input_schema: { type: "object" }, verification: "acknowledgment" },
      ],
    }),
    async handler(cap, args, ctx) {
      if (cap === "test.echo") {
        echoCalls++;
        return { value: Number(args.x ?? 42), unit: "u", captured_at: new Date().toISOString() };
      }
      if (cap === "test.photo") {
        const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
        const id = await ctx.upload(new Blob([bytes], { type: "image/jpeg" }), { capturedAt: new Date() });
        return { observation_id: id, captured_at: new Date().toISOString() };
      }
      if (cap === "test.slow") {
        try {
          await sleep(4000, ctx.signal);
        } catch (e) {
          slowAborted = e instanceof Error ? e.message : String(e);
          throw e;
        }
        return { value: "done" };
      }
      if (cap === "test.bad") throw new InvokeError("bad args", "rejected");
      throw new Error("unreachable");
    },
    onSignal(session_id, data, reply) {
      reply({ kind: "answer", sdp: "fake-sdp-for-" + session_id, echo: data });
    },
    onRevoke(lease) {
      revoked.push(lease);
    },
  };

  const kv = memKV();
  const c = new GhostConnector({ url: WS, connectorKind: "desktop-browser", label: "node test", ownerToken: "owner_tok_test", storage: kv });
  c.registerDevice(device);
  c.start();
  await waitFor(c, () => c.getSnapshot().status === "online");
  check("welcome with owner_token → online", c.getSnapshot().status === "online");
  check("credential persisted", !!kv.getItem("ghost.connector.desktop-browser.credential"));
  await waitFor(c, () => !!c.getSnapshot().devices[0]?.device_id);
  const device_id = c.getSnapshot().devices[0].device_id!;
  check("published → device_id assigned", device_id === "dev_test-rig", device_id);

  let r = await post("/invoke", { device_id, capability_id: "test.echo", arguments: { x: 7 }, invocation_id: "inv_echo_1" });
  check("invoke echo succeeded", r.result?.state === "succeeded" && r.result.output?.value === 7, r.result);
  r = await post("/invoke", { device_id, capability_id: "test.echo", arguments: { x: 9 }, invocation_id: "inv_echo_1" });
  check("retry same invocation_id → cached result, handler not re-run", r.result?.output?.value === 7 && echoCalls === 1, { r: r.result, echoCalls });

  r = await post("/invoke", { device_id, capability_id: "test.photo" });
  const obs = r.result?.output?.observation_id as string | undefined;
  check("photo uploaded → observation_id", r.result?.state === "succeeded" && !!obs, r.result);
  if (obs) {
    const up = await fetch(`${HTTP}/uploads/${obs}`);
    const buf = new Uint8Array(await up.arrayBuffer());
    check("upload bytes + content-type stored", up.headers.get("content-type")?.startsWith("image/jpeg") === true && buf[0] === 0xff && buf.length === 9);
  }

  r = await post("/invoke", { device_id, capability_id: "test.echo", deadline_ms: -1000 });
  check("past deadline → rejected", r.result?.state === "rejected", r.result);
  r = await post("/invoke", { device_id, capability_id: "nope.cap" });
  check("unpublished capability → rejected", r.result?.state === "rejected", r.result);
  r = await post("/invoke", { device_id, capability_id: "test.bad" });
  check("handler InvokeError(rejected) → rejected", r.result?.state === "rejected" && r.result.error === "bad args", r.result);

  r = await post("/invoke", { device_id, capability_id: "test.slow", deadline_ms: 800 });
  check("act past deadline → unknown (never claim success)", r.result?.state === "unknown" && slowAborted === "deadline exceeded", { r: r.result, slowAborted });

  // revoke while running + later invokes on that lease
  const slow = post("/invoke", { device_id, capability_id: "test.slow", lease_id: "lease_A", deadline_ms: 8000 });
  await sleep(300);
  await post("/revoke", { lease_id: "lease_A", device_ids: [device_id] });
  r = await slow;
  check("revoke aborts running invocation", r.result?.state === "failed" && r.result.error === "lease revoked", r.result);
  check("revoke → device onRevoke called", revoked.includes("lease_A"), revoked);
  r = await post("/invoke", { device_id, capability_id: "test.echo", lease_id: "lease_A" });
  check("invoke on revoked lease → rejected", r.result?.state === "rejected", r.result);
  r = await post("/invoke", { device_id, capability_id: "test.echo", lease_id: "lease_B" });
  check("other lease still works", r.result?.state === "succeeded", r.result);

  // cancel
  const slow2 = post("/invoke", { device_id, capability_id: "test.slow", invocation_id: "inv_cancel_me", deadline_ms: 8000 });
  await sleep(300);
  check("active invocation visible in snapshot", c.getSnapshot().active.some((a) => a.invocation_id === "inv_cancel_me"));
  await post("/cancel", { invocation_id: "inv_cancel_me" });
  r = await slow2;
  check("cancel → failed/cancelled", r.result?.state === "failed" && r.result.error === "cancelled", r.result);

  // viewer signal relay (second connector acts as the viewer)
  const viewer = new GhostConnector({ url: WS, connectorKind: "desktop-browser", label: "viewer", ownerToken: "owner_tok_viewer", storage: memKV() });
  viewer.start();
  await waitFor(viewer, () => viewer.getSnapshot().status === "online");
  const got = new Promise<unknown>((resolve) => viewer.onViewerSignal("sess_1", (d) => resolve(d)));
  viewer.sendSignal("sess_1", "device", { device_id, kind: "offer", sdp: "x" });
  const answer = (await Promise.race([got, sleep(3000).then(() => null)])) as { kind?: string; sdp?: string } | null;
  check("signal relay viewer → device → viewer", answer?.kind === "answer" && answer.sdp === "fake-sdp-for-sess_1", answer);
  viewer.stop();

  // reconnect with credential: force-close the socket
  const before = c.getSnapshot().connector_id;
  (c as unknown as { ws: WebSocket }).ws.close();
  await waitFor(c, () => c.getSnapshot().status !== "online", 3000);
  await waitFor(c, () => c.getSnapshot().status === "online", 8000);
  check("reconnected with persisted credential (same connector_id)", c.getSnapshot().connector_id === before, { before, after: c.getSnapshot().connector_id });
  await waitFor(c, () => c.getSnapshot().devices[0]?.status === "configured", 3000);
  r = await post("/invoke", { device_id, capability_id: "test.echo", arguments: { x: 3 } });
  check("invoke after reconnect", r.result?.state === "succeeded" && r.result.output?.value === 3, r.result);

  // unpublish → rejects
  c.unpublish(["test-rig"]);
  await sleep(200);
  r = await post("/invoke", { device_id, capability_id: "test.echo" });
  check("after unpublish → not invokable", r.result?.state !== "succeeded", r);

  c.stop();
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
