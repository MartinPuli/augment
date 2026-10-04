/// <reference lib="webworker" />
/**
 * Object-detection worker. onnxruntime-web is loaded at runtime from the jsDelivr CDN (pinned to the
 * installed version) instead of being bundled: this sidesteps bundler handling of ORT's wasm/glue
 * files and keeps the app bundle small. WebGPU when available, else WASM (SIMD; threads only when
 * the page is cross-origin isolated). Weights are fetched from Hugging Face and kept in Cache Storage.
 */
import type * as OrtNS from "onnxruntime-web";
import { getModel, type VisionModelSpec } from "./models";
import { computeLayout, decodeDfine, decodeYolov10, resampleToTensor } from "./postprocess";
import type { Detection, DetectorBackend } from "./types";

export const ORT_VERSION = "1.30.0";
const ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const MODEL_CACHE = "ghost-vision-models-v1";

export type WorkerIn =
  | { type: "init"; modelId?: string; backend?: "auto" | "webgpu" | "wasm"; minScore?: number }
  | { type: "detect"; id: number; bitmap: ImageBitmap }
  | { type: "dispose" };

export type WorkerOut =
  | { type: "progress"; loaded: number; total: number }
  | { type: "ready"; backend: DetectorBackend; model: string; input: number }
  | { type: "result"; id: number; detections: Detection[]; ms: number; backend: DetectorBackend }
  | { type: "error"; id?: number; message: string; fatal?: boolean };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: WorkerOut) => ctx.postMessage(m);

let ort: typeof OrtNS | null = null;
let session: OrtNS.InferenceSession | null = null;
let model: VisionModelSpec = getModel();
let backend: DetectorBackend = "none";
let input = 640;
let minScore = 0.15;
let modelBytes: Uint8Array | null = null;
let canvas: OffscreenCanvas | null = null;
let g: OffscreenCanvasRenderingContext2D | null = null;
let tensorBuf: Float32Array | undefined;

async function loadOrt(): Promise<typeof OrtNS> {
  if (ort) return ort;
  const mod = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ `${ORT_CDN}ort.webgpu.min.mjs`)) as typeof OrtNS & {
    default?: typeof OrtNS;
  };
  const o = (mod.InferenceSession ? mod : mod.default) as typeof OrtNS;
  o.env.wasm.wasmPaths = ORT_CDN;
  o.env.wasm.numThreads = (ctx as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated
    ? Math.min(4, navigator.hardwareConcurrency || 2)
    : 1;
  o.env.logLevel = "error";
  ort = o;
  return o;
}

async function fetchModel(spec: VisionModelSpec): Promise<Uint8Array> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(MODEL_CACHE);
    const hit = await cache.match(spec.url);
    if (hit) {
      const buf = new Uint8Array(await hit.arrayBuffer());
      post({ type: "progress", loaded: buf.byteLength, total: buf.byteLength });
      return buf;
    }
  } catch {
    cache = null; // Cache Storage unavailable (insecure context / private mode)
  }
  const res = await fetch(spec.url, { mode: "cors" });
  if (!res.ok || !res.body) throw new Error(`model download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length")) || spec.bytes;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let lastPost = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    if (performance.now() - lastPost > 100) {
      post({ type: "progress", loaded, total });
      lastPost = performance.now();
    }
  }
  const buf = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  post({ type: "progress", loaded, total: loaded });
  if (cache) {
    cache.put(spec.url, new Response(buf.slice().buffer, { headers: { "content-type": "application/octet-stream" } })).catch(() => {});
  }
  return buf;
}

async function hasWebGPU(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return Boolean(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function createSession(which: "webgpu" | "wasm"): Promise<void> {
  const o = await loadOrt();
  if (!modelBytes) throw new Error("model not loaded");
  session?.release().catch(() => {});
  session = null;
  session = await o.InferenceSession.create(modelBytes, {
    executionProviders: [which],
    graphOptimizationLevel: "all",
  });
  backend = which;
  // Keep the native 640 input on every backend: a smaller input (tried 512 on WASM) loses most small
  // objects such as distant cars (24 -> 1 detections >= 0.3 on a Caltrans frame).
  input = model.input;
  tensorBuf = undefined;
}

async function init(msg: Extract<WorkerIn, { type: "init" }>) {
  model = getModel(msg.modelId);
  minScore = msg.minScore ?? Math.min(0.15, model.threshold);
  await loadOrt();
  modelBytes = await fetchModel(model);
  const want = msg.backend ?? "auto";
  let lastErr: unknown = null;
  if (want !== "wasm" && (await hasWebGPU())) {
    try {
      await createSession("webgpu");
    } catch (e) {
      lastErr = e;
      session = null;
    }
  }
  if (!session) {
    try {
      await createSession("wasm");
    } catch (e) {
      throw new Error(`could not start detector (${(e as Error).message}${lastErr ? `; webgpu: ${(lastErr as Error).message}` : ""})`);
    }
  }
  post({ type: "ready", backend, model: model.id, input });
}

async function runOnce(bitmap: ImageBitmap): Promise<Detection[]> {
  if (!session || !ort) throw new Error("detector not ready");
  // Bring the frame to at most ~2x the model input with the canvas (cheap), then resample into the
  // tensor with Lanczos-3 (sharp kernels keep small objects detectable).
  const cap = input * 2;
  const k = Math.min(1, cap / Math.max(bitmap.width, bitmap.height));
  const sw = Math.max(1, Math.round(bitmap.width * k));
  const sh = Math.max(1, Math.round(bitmap.height * k));
  if (!canvas || canvas.width !== sw || canvas.height !== sh) {
    canvas = new OffscreenCanvas(sw, sh);
    g = canvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  }
  const c = g!;
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = "high";
  c.drawImage(bitmap, 0, 0, sw, sh);
  const rgba = c.getImageData(0, 0, sw, sh).data;
  const inner = computeLayout(sw, sh, { input, resize: model.resize });
  tensorBuf = resampleToTensor(rgba, sw, sh, inner, tensorBuf);
  // boxes are decoded back to the ORIGINAL bitmap coordinates
  const layout = { ...inner, sx: inner.sx * k, sy: inner.sy * k, srcW: bitmap.width, srcH: bitmap.height };
  const feeds = { [session.inputNames[0]]: new ort.Tensor("float32", tensorBuf, [1, 3, input, input]) };
  const out = await session.run(feeds);
  try {
    if (model.family === "dfine") {
      const logits = out[session.outputNames[0]];
      const boxes = out[session.outputNames[1]];
      return decodeDfine(
        (await logits.getData()) as Float32Array,
        (await boxes.getData()) as Float32Array,
        logits.dims[1],
        logits.dims[2],
        layout,
        minScore,
      );
    }
    const o = out[session.outputNames[0]];
    return decodeYolov10((await o.getData()) as Float32Array, o.dims[1], layout, minScore);
  } finally {
    for (const k of Object.keys(out)) out[k].dispose?.();
  }
}

let webgpuFailures = 0;

async function detect(msg: Extract<WorkerIn, { type: "detect" }>) {
  const t0 = performance.now();
  try {
    let dets: Detection[];
    try {
      dets = await runOnce(msg.bitmap);
    } catch (e) {
      if (backend !== "webgpu") throw e;
      // WebGPU hiccup (device lost / unsupported kernel at runtime): fall back to WASM once.
      webgpuFailures++;
      await createSession("wasm");
      dets = await runOnce(msg.bitmap);
      post({ type: "ready", backend, model: model.id, input });
    }
    post({ type: "result", id: msg.id, detections: dets, ms: performance.now() - t0, backend });
  } catch (e) {
    post({ type: "error", id: msg.id, message: (e as Error).message ?? String(e) });
  } finally {
    msg.bitmap.close();
  }
}

ctx.onmessage = (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  if (msg.type === "init") {
    init(msg).catch((e) => post({ type: "error", message: (e as Error).message ?? String(e), fatal: true }));
  } else if (msg.type === "detect") {
    void detect(msg);
  } else if (msg.type === "dispose") {
    session?.release().catch(() => {});
    session = null;
    modelBytes = null;
    void webgpuFailures;
    ctx.close();
  }
};
