// Minimal CDP driver: launches headless Chrome (WebGPU enabled, fake camera) on port 9444, opens a URL,
// prints console output + widget reports, takes screenshots. Usage: node cdp.mjs <url> <secs> "<s1,s2>" <prefix>
// Optional CLICK_AT=sec,x,y env to dispatch a click.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
const WebSocket = createRequire(`${process.cwd()}/package.json`)("ws");
const url = process.argv[2];
const secs = Number(process.argv[3] ?? 40);
const shots = (process.argv[4] ?? "15,30,40").split(",").map(Number);
const prefix = process.argv[5] ?? "shot";
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--remote-debugging-port=9444", `--user-data-dir=/tmp/ghost-harness-chrome`,
  "--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required",
  "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--window-size=960,800", "about:blank",
], { stdio: ["ignore", "ignore", "ignore"], detached: true });
let ws, id = 0; const waits = new Map();
const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; waits.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
await new Promise((r) => setTimeout(r, 1500));
let ver;
for (let i = 0; i < 20; i++) { try { ver = await (await fetch("http://127.0.0.1:9444/json/version")).json(); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => ws.on("open", r));
let sessionId;
ws.on("message", (m) => {
  const msg = JSON.parse(m.toString());
  if (msg.id && waits.has(msg.id)) { waits.get(msg.id)(msg.result ?? msg); waits.delete(msg.id); return; }
  if (msg.method === "Runtime.consoleAPICalled") {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (text.startsWith("REPORT ")) { const r = JSON.parse(text.slice(7)); console.log(`[report] status=${r.status} backend=${r.backend} fps=${r.fps} det=${r.detect_fps} infer=${r.inference_ms}ms total=${r.total} counts=${JSON.stringify(r.counts)} follow=${r.follow_status} target=${JSON.stringify(r.target)} zoom=${r.zoom} err=${r.error}`); }
    else console.log(`[console.${msg.params.type}] ${text.slice(0, 400)}`);
  }
  if (msg.method === "Runtime.exceptionThrown") console.log("[exception]", JSON.stringify(msg.params.exceptionDetails).slice(0, 600));
  if (msg.method === "Log.entryAdded") console.log(`[log.${msg.params.entry.level}] ${msg.params.entry.text.slice(0, 300)} ${msg.params.entry.url ?? ""}`);
  if (msg.method === "Target.attachedToTarget" && msg.params.targetInfo.type === "worker") console.log("[worker attached]", msg.params.targetInfo.url);
});
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
({ sessionId } = await send("Target.attachToTarget", { targetId, flatten: true }));
await send("Runtime.enable", {}, sessionId);
await send("Log.enable", {}, sessionId);
await send("Emulation.setDeviceMetricsOverride", { width: 940, height: 760, deviceScaleFactor: 1, mobile: false }, sessionId);
await send("Page.enable", {}, sessionId);
await send("Page.navigate", { url }, sessionId);
const t0 = Date.now();
if (process.env.CLICK_AT) {
  const [sec, x, y] = process.env.CLICK_AT.split(",").map(Number);
  setTimeout(async () => {
    console.log("[click-start]"); for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) console.log("[click-res]", JSON.stringify(await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, sessionId)));
    console.log(`[click] ${x},${y}`);
  }, sec * 1000);
}
for (const s of shots) {
  await new Promise((r) => setTimeout(r, Math.max(0, s * 1000 - (Date.now() - t0))));
  const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  fs.writeFileSync(`${prefix}-${s}s.png`, Buffer.from(data, "base64"));
  console.log(`[shot] ${prefix}-${s}s.png`);
}
await new Promise((r) => setTimeout(r, Math.max(0, secs * 1000 - (Date.now() - t0))));
const gpu = await send("Runtime.evaluate", { expression: "(async()=>{const a=await navigator.gpu?.requestAdapter(); return JSON.stringify({gpu: !!navigator.gpu, adapter: !!a, coi: crossOriginIsolated})})()", awaitPromise: true }, sessionId);
console.log("[gpu]", gpu.result?.value);
try { await Promise.race([send("Browser.close"), new Promise((r) => setTimeout(r, 3000))]); } catch {}
try { process.kill(-chrome.pid, "SIGKILL"); } catch {}
process.exit(0);
