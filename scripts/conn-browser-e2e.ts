/**
 * Browser end-to-end test of /join with headless Chrome (fake camera + mic) via the DevTools protocol.
 *
 *   GHOST_ORIGIN=http://localhost:3300 SHOTS=/tmp/shots pnpm exec tsx scripts/conn-browser-e2e.ts
 *
 * Owner side runs in Node with its own cookie: creates a pairing, confirms it, invokes capabilities.
 * Phone side is the real /join page: toggles sensors with trusted taps, publishes, gets possessed.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ORIGIN = (process.env.GHOST_ORIGIN || "http://localhost:3000").replace(/\/$/, "");
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), "ghost-shots");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
fs.mkdirSync(SHOTS, { recursive: true });

let cookie = "";
let failures = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 500)}` : ""}`);
}

async function api<T = Record<string, unknown>>(p: string, body?: unknown): Promise<{ status: number; json: T }> {
  const r = await fetch(ORIGIN + "/api/v1" + p, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = r.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(";")[0]).join("; ");
  const t = await r.text();
  let j: unknown = t;
  try {
    j = JSON.parse(t);
  } catch {}
  return { status: r.status, json: j as T };
}

type InvokeOut = { invocation?: { state: string; error?: string; observation_id?: string | null }; observation?: Record<string, unknown> | null };
async function invoke(device_id: string, capability_id: string, args: Record<string, unknown> = {}) {
  let r = await api<InvokeOut>("/invoke", { device_id, capability_id, arguments: args, timeout_ms: 20000 });
  if (r.status >= 400 && /lease/i.test(JSON.stringify(r.json))) {
    const q = await api<{ offer: { offer_id: string } }>("/quotes", { refs: [{ device_id, capability_id }], duration_s: 120 });
    const a = await api<{ lease: { lease_id: string } }>(`/quotes/${q.json.offer?.offer_id}/accept`, { offer_id: q.json.offer?.offer_id, max_spend_cents: 0 });
    r = await api<InvokeOut>("/invoke", { device_id, capability_id, arguments: args, lease_id: a.json.lease?.lease_id, timeout_ms: 20000 });
  }
  return r;
}

class CDP {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)!(m);
        this.pending.delete(m.id);
      }
    };
  }
  open() {
    return new Promise<void>((r) => (this.ws.onopen = () => r()));
  }
  async send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id;
    const p = new Promise<{ result?: unknown; error?: unknown }>((r) => this.pending.set(id, r));
    this.ws.send(JSON.stringify({ id, method, params }));
    const m = await p;
    if (m.error) throw new Error(`${method}: ${JSON.stringify(m.error)}`);
    return m.result as T;
  }
  async eval<T = unknown>(expr: string): Promise<T> {
    const r = await this.send<{ result: { value: T } }>("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result.value;
  }
  async text() {
    return this.eval<string>("document.body.innerText");
  }
  async waitText(s: string, ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if ((await this.text()).includes(s)) return true;
      await sleep(250);
    }
    return false;
  }
  async shot(name: string) {
    const r = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOTS, name + ".png"), Buffer.from(r.data, "base64"));
  }
  /** Trusted tap on the first element whose text includes `label` (gives user activation). */
  async tap(selector: string, label: string) {
    const rect = await this.eval<{ x: number; y: number } | null>(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(e => e.innerText.includes(${JSON.stringify(label)}));
      const el = els[0]; if (!el) return null; el.scrollIntoView({block:"center"});
      const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 };
    })()`);
    if (!rect) throw new Error(`no element ${selector} with text ${label}`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    }
  }
}

async function main() {
  const me = await api<{ principal_id: string }>("/me");
  check("owner session", me.status === 200, me);
  const pr = await api<{ pairing_id: string; code: string; join_path: string }>("/pairings", {});
  check("pairing created", !!pr.json.code, pr);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ghost-chrome-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--no-first-run",
    "--window-size=390,844",
    "about:blank",
  ]);
  try {
    let wsUrl = "";
    for (let i = 0; i < 40 && !wsUrl; i++) {
      await sleep(250);
      try {
        const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
        wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? "";
      } catch {}
    }
    const cdp = new CDP(wsUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await cdp.send("Page.navigate", { url: `${ORIGIN}${pr.json.join_path}` });

    check("phone shows 'Waiting for the owner to confirm'", await cdp.waitText("Waiting for the owner to confirm", 60000), await cdp.text());
    check("pairing code removed from address bar", !(await cdp.eval<string>("location.href")).includes("code="));
    await sleep(600);
    await cdp.shot("1-pending");

    const conf = await api(`/pairings/${pr.json.pairing_id}/confirm`, {});
    check("owner confirmed", conf.status < 300, conf);
    check("phone shows sensor setup after confirm", await cdp.waitText("What can Polty borrow?"), await cdp.text());
    await sleep(500);
    await cdp.shot("2-setup");

    for (const label of ["Camera", "Microphone", "Speaker", "Screen"]) {
      await cdp.tap("li button", label);
      await sleep(1500);
    }
    const setupText = await cdp.text();
    check("sensors shared after permission (camera, mic, speaker, screen)", (setupText.match(/SHARED|shared/g) ?? []).length >= 4, setupText);
    await cdp.shot("3-sensors-on");
    await cdp.tap("button", "Publish device");
    check("live mode after publish", await cdp.waitText("Polty can borrow this phone"), await cdp.text());
    let deviceId = "";
    for (let i = 0; i < 20 && !deviceId; i++) {
      deviceId = /device (\S+) ·/.exec(await cdp.text())?.[1] ?? "";
      if (!deviceId) await sleep(250);
    }
    check("phone device published with id", !!deviceId, await cdp.text());
    await sleep(600);
    await cdp.shot("4-live");

    const snap = await invoke(deviceId, "camera.snapshot");
    check("camera.snapshot from the real page (fake camera) → observation", snap.json.invocation?.state === "succeeded" && !!snap.json.invocation?.observation_id, snap);
    if (snap.json.invocation?.observation_id) {
      const m = await fetch(`${ORIGIN}/api/v1/observations/${snap.json.invocation.observation_id}/media`, { headers: { cookie } });
      const b = new Uint8Array(await m.arrayBuffer());
      check("snapshot media is a JPEG", b[0] === 0xff && b[1] === 0xd8, { status: m.status, ct: m.headers.get("content-type"), len: b.length });
      fs.writeFileSync(path.join(SHOTS, "snapshot.jpg"), b);
    }

    const level = invoke(deviceId, "audio.level", { seconds: 4 });
    const sawPossessed = await cdp.waitText("Polty is listening", 6000);
    check("possessed UI while listening", sawPossessed, await cdp.text());
    await sleep(300);
    await cdp.shot("5-possessed");
    const lv = await level;
    check("audio.level → dBFS value", lv.json.invocation?.state === "succeeded", lv);
    console.log("      audio.level observation:", JSON.stringify(lv.json.observation ?? {}).slice(0, 200));

    const show = await invoke(deviceId, "display.show", { text: "Boo! Polty was here", emoji: "👻", color: "#a99bff", duration_s: 5 });
    check("display.show → rendered", show.json.invocation?.state === "succeeded", show);
    check("display takeover visible", await cdp.waitText("Boo! Polty was here", 3000), await cdp.text());
    await sleep(300);
    await cdp.shot("6-display-show");

    const say = await invoke(deviceId, "speaker.say", { text: "hello from the other side" });
    check("speaker.say → acknowledged (state succeeded or failed honestly)", ["succeeded", "failed"].includes(say.json.invocation?.state ?? ""), say);

    const bad = await invoke(deviceId, "display.flash", { hz: 30, seconds: 1 });
    check("display.flash hz:30 refused by the published schema (max 3 Hz)", bad.status === 400 || bad.json.invocation?.state === "rejected", bad);
    const flash = await invoke(deviceId, "display.flash", { hz: 3, seconds: 1, color: "#ff6b5e" });
    check("display.flash 3 Hz for 1 s → succeeded", flash.json.invocation?.state === "succeeded", flash);

    await sleep(5200);
    await cdp.tap("button", "Stop access");
    check("stop access → back to setup with notice", await cdp.waitText("Access stopped"), await cdp.text());
    await cdp.shot("7-stopped");
    const after = await invoke(deviceId, "camera.snapshot");
    check("after Stop access the camera is not invokable", after.json.invocation?.state !== "succeeded", after);
  } finally {
    chrome.kill("SIGTERM");
  }
  console.log(`\nscreenshots: ${SHOTS}`);
  console.log(failures ? `${failures} FAILED` : "ALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("crashed:", e);
  process.exit(1);
});
