/**
 * WebRTC live-stream end-to-end: phone (/join, fake camera) → coordinator signaling → viewer.
 *
 *   GHOST_ORIGIN=http://localhost:3000 pnpm exec tsx scripts/conn-webrtc-e2e.ts
 *
 * Tab 1 is the real /join page (paired + camera published). Tab 2 is a bare viewer bundle
 * (scripts/conn-webrtc-viewer.entry.ts) that calls openDeviceStreamVia() with the owner's token and
 * waits for decoded video frames.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const ORIGIN = (process.env.GHOST_ORIGIN || "http://localhost:3000").replace(/\/$/, "");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9334;
const ROOT = process.cwd();
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
    signal: AbortSignal.timeout(30_000),
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

class Page {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, (m: { result?: unknown; error?: unknown }) => void>();
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      const fn = m.id && this.pending.get(m.id);
      if (fn) {
        this.pending.delete(m.id);
        fn(m);
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
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }
  text() {
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
  async tap(selector: string, label: string) {
    const rect = await this.eval<{ x: number; y: number } | null>(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.innerText.includes(${JSON.stringify(label)}));
      if (!el) return null; el.scrollIntoView({block:"center"}); const r = el.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2 };
    })()`);
    if (!rect) throw new Error(`no ${selector} "${label}"`);
    for (const type of ["mousePressed", "mouseReleased"]) await this.send("Input.dispatchMouseEvent", { type, x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  }
}

async function bundleViewer(): Promise<string> {
  const pnpmDir = path.join(ROOT, "node_modules/.pnpm");
  const dir = fs.readdirSync(pnpmDir).find((d) => d.startsWith("esbuild@"));
  if (!dir) throw new Error("esbuild not found under node_modules/.pnpm");
  const req = createRequire(path.join(ROOT, "package.json"));
  type EsbuildLike = { build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }> };
  const esbuild = req(path.join(pnpmDir, dir, "node_modules/esbuild")) as EsbuildLike;
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, "scripts/conn-webrtc-viewer.entry.ts")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    tsconfig: path.join(ROOT, "tsconfig.json"),
    logLevel: "silent",
  });
  return out.outputFiles[0].text;
}

async function main() {
  const bundle = await bundleViewer();
  check("viewer bundle built", bundle.length > 1000);
  const me = await api<{ owner_token: string }>("/me");
  const pr = await api<{ pairing_id: string; join_path: string }>("/pairings", {});
  check("owner session + pairing", !!me.json.owner_token && !!pr.json.join_path, { me, pr });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ghost-rtc-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--no-first-run",
    "about:blank",
  ]);
  const watchdog = setTimeout(() => {
    console.log("FAIL  watchdog (150 s)");
    chrome.kill("SIGKILL");
    process.exit(1);
  }, 150_000);
  try {
    let pageWs = "";
    for (let i = 0; i < 40 && !pageWs; i++) {
      await sleep(250);
      try {
        const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
        pageWs = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? "";
      } catch {}
    }
    const phone = new Page(pageWs);
    await phone.open();
    await phone.send("Page.enable");
    await phone.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await phone.send("Page.navigate", { url: ORIGIN + pr.json.join_path });
    check("phone waiting for confirmation", await phone.waitText("Waiting for the owner", 60000));
    await api(`/pairings/${pr.json.pairing_id}/confirm`, {});
    check("phone confirmed", await phone.waitText("What can Polty borrow?"));
    await phone.tap("li button", "Camera");
    await sleep(1500);
    await phone.tap("button", "Publish device");
    check("phone live", await phone.waitText("Polty can borrow this phone"));
    let deviceId = "";
    for (let i = 0; i < 20 && !deviceId; i++) {
      deviceId = /device (\S+) ·/.exec(await phone.text())?.[1] ?? "";
      if (!deviceId) await sleep(250);
    }
    check("phone device id", !!deviceId);

    const newTab = (await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(ORIGIN + "/api/v1/health")}`, { method: "PUT" })).json()) as { webSocketDebuggerUrl: string };
    const viewer = new Page(newTab.webSocketDebuggerUrl);
    await viewer.open();
    await sleep(800);
    await viewer.eval(bundle + ";true");
    const res = await viewer.eval<Record<string, unknown>>(`window.__ghostView(${JSON.stringify(me.json.owner_token)}, ${JSON.stringify(deviceId)})`);
    check("viewer receives decoded live video from the phone camera", res.ok === true, res);
    console.log("      viewer result:", JSON.stringify(res));
    await phone.send("Page.bringToFront"); // headless: the phone tab went to the background when the viewer opened
    check("phone says it is being watched live", await phone.waitText("Polty is watching live", 6000), await phone.text());

    await phone.tap("button", "Stop access");
    check("phone Stop access", await phone.waitText("Access stopped"));
    const ended = await viewer.eval<boolean>(`(async () => { const v = document.querySelector("video"); const t = v && v.srcObject && v.srcObject.getVideoTracks()[0]; for (let i = 0; i < 40; i++) { if (!t || t.readyState === "ended" || t.muted) return true; await new Promise(r => setTimeout(r, 200)); } return false; })()`);
    check("Stop access ends the viewer's track", ended);
  } finally {
    clearTimeout(watchdog);
    chrome.kill("SIGTERM");
  }
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("crashed:", e);
  process.exit(1);
});
