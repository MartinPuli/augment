/**
 * Verifies the detector models from Node: downloads the ONNX weights from Hugging Face (runtime only,
 * nothing is committed), prints input/output names + shapes, grabs a real frame from a Caltrans HLS
 * stream with ffmpeg, and runs the same pre/post-processing code the browser worker uses.
 *
 *   pnpm exec tsx scripts/vision-model-check.ts [hls-or-image-url]
 *
 * Requires ffmpeg on PATH for the frame grab. Uses onnxruntime-web's WASM backend (single thread).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ort from "onnxruntime-web/wasm";
import { VISION_MODELS, type VisionModelSpec } from "../src/lib/vision/models";
import { computeLayout, decodeDfine, decodeYolov10, rgbaToTensor } from "../src/lib/vision/postprocess";

const SRC = process.argv[2] ?? "https://wzmedia.dot.ca.gov/D4/W80_at_SAS_Tower.stream/playlist.m3u8";
const THR = (m: VisionModelSpec) => (process.env.THR ? Number(process.env.THR) : m.threshold);
const CACHE = path.join(os.tmpdir(), "ghost-vision-models");
fs.mkdirSync(CACHE, { recursive: true });

async function fetchModel(m: VisionModelSpec): Promise<Uint8Array> {
  const file = path.join(CACHE, `${m.id}.onnx`);
  if (fs.existsSync(file) && fs.statSync(file).size === m.bytes) return fs.readFileSync(file);
  const t0 = Date.now();
  const res = await fetch(m.url, { headers: { Origin: "http://localhost:3000" } });
  if (!res.ok) throw new Error(`${m.id}: HTTP ${res.status}`);
  console.log(`  ${m.id}: final URL host ${new URL(res.url).host}, ACAO=${res.headers.get("access-control-allow-origin")}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  console.log(`  ${m.id}: downloaded ${(buf.length / 1e6).toFixed(1)} MB in ${Date.now() - t0} ms`);
  fs.writeFileSync(file, buf);
  return buf;
}

function grabFrame(src: string): { w: number; h: number } {
  const out = path.join(CACHE, "frame.png");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-frames:v", "1", out], { timeout: 30000 });
  const png = fs.readFileSync(out); // IHDR: width/height are big-endian u32 at offsets 16/20
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

function rgbaFor(m: VisionModelSpec, w: number, h: number): Uint8Array {
  const L = computeLayout(w, h, m);
  const vf =
    m.resize === "stretch"
      ? `scale=${L.size}:${L.size}:flags=bilinear`
      : `scale=${L.dw}:${L.dh}:flags=bilinear,pad=${L.size}:${L.size}:${L.px}:${L.py}:color=0x727272`;
  const buf = execFileSync("ffmpeg", ["-loglevel", "error", "-i", path.join(CACHE, "frame.png"), "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return new Uint8Array(buf);
}

async function main() {
  ort.env.wasm.numThreads = 1;
  console.log(`Frame source: ${SRC}`);
  const { w, h } = grabFrame(SRC);
  console.log(`Frame: ${w}x${h}`);
  for (const m of Object.values(VISION_MODELS)) {
    console.log(`\n== ${m.name} (${m.id}) license=${m.license}`);
    const bytes = await fetchModel(m);
    const session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
    console.log("  inputs ", JSON.stringify(session.inputMetadata));
    console.log("  outputs", JSON.stringify(session.outputMetadata));
    const L = computeLayout(w, h, m);
    const tensor = rgbaToTensor(rgbaFor(m, w, h), m.input);
    const feeds = { [session.inputNames[0]]: new ort.Tensor("float32", tensor, [1, 3, m.input, m.input]) };
    let dets: ReturnType<typeof decodeDfine> = [];
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const r = await session.run(feeds);
      times.push(performance.now() - t0);
      if (m.family === "dfine") {
        const logits = r[session.outputNames[0]];
        const boxes = r[session.outputNames[1]];
        dets = decodeDfine(logits.data as Float32Array, boxes.data as Float32Array, logits.dims[1], logits.dims[2], L, THR(m));
      } else {
        const o = r[session.outputNames[0]];
        dets = decodeYolov10(o.data as Float32Array, o.dims[1], L, THR(m));
      }
    }
    console.log(`  wasm 1-thread inference ms: ${times.map((t) => t.toFixed(0)).join(", ")}`);
    const counts: Record<string, number> = {};
    for (const d of dets) counts[d.label] = (counts[d.label] ?? 0) + 1;
    console.log(`  detections @${THR(m)}: ${dets.length}`, counts);
    for (const d of dets.slice(0, 6))
      console.log(`    ${d.label.padEnd(8)} ${d.score.toFixed(2)}  x=${d.x.toFixed(0)} y=${d.y.toFixed(0)} w=${d.w.toFixed(0)} h=${d.h.toFixed(0)}`);
    await session.release();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
