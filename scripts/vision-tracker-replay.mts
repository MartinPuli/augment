/**
 * Replays consecutive frames (PNG sequence at a known fps) through the detector pre/post-processing
 * and the tracker, printing per-frame detection and confirmed-track counts.
 *   ffmpeg -i <hls-url> -t 3 -vf fps=8 /tmp/seq/f%03d.png
 *   pnpm exec tsx scripts/vision-tracker-replay.mts /tmp/seq 8
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ort from "onnxruntime-web/wasm";
import { getModel } from "../src/lib/vision/models";
import { computeLayout, decodeDfine, rgbaToTensor } from "../src/lib/vision/postprocess";
import { Tracker } from "../src/lib/vision/tracker";

const dir = process.argv[2];
const fps = Number(process.argv[3] ?? 8);
const m = getModel("dfine-n");
ort.env.wasm.numThreads = 1;
const s = await ort.InferenceSession.create(fs.readFileSync(path.join(os.tmpdir(), "ghost-vision-models", "dfine-n.onnx")));
const tr = new Tracker();
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
for (const [i, f] of files.entries()) {
  const png = fs.readFileSync(path.join(dir, f));
  const W = png.readUInt32BE(16);
  const H = png.readUInt32BE(20);
  const L = computeLayout(W, H, m);
  const data = new Uint8Array(
    execFileSync("ffmpeg", ["-loglevel", "error", "-i", path.join(dir, f), "-vf", `scale=${m.input}:${m.input}`, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 1 << 28 }),
  );
  const r = await s.run({ pixel_values: new ort.Tensor("float32", rgbaToTensor(data, m.input), [1, 3, m.input, m.input]) });
  const d = decodeDfine(r.logits.data as Float32Array, r.pred_boxes.data as Float32Array, 300, 80, L, 0.12);
  const conf = tr.update(d, (i * 1000) / fps);
  const ids = conf.map((x) => x.id);
  console.log(
    `${f} dets>=0.3:${d.filter((x) => x.score >= 0.3).length} dets>=0.12:${d.length} live:${tr.all().length} confirmed:${conf.length} maxId:${Math.max(0, ...tr.all().map((x) => x.id))} oldestId:${ids.length ? Math.min(...ids) : "-"}`,
  );
}
