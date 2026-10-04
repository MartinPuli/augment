/**
 * Pure pre/post-processing for the detector (no DOM, no ORT) so it runs in the worker and in Node tests.
 */
import { COCO_LABELS } from "./labels";
import type { Detection } from "./types";
import type { VisionModelSpec } from "./models";

/** Where the source frame lands inside the square model input. src = (in - p) / s */
export interface Layout {
  size: number;
  sx: number;
  sy: number;
  px: number;
  py: number;
  /** Drawn size of the source inside the input. */
  dw: number;
  dh: number;
  srcW: number;
  srcH: number;
}

export function computeLayout(srcW: number, srcH: number, model: Pick<VisionModelSpec, "input" | "resize">): Layout {
  const size = model.input;
  if (model.resize === "stretch") {
    return { size, sx: size / srcW, sy: size / srcH, px: 0, py: 0, dw: size, dh: size, srcW, srcH };
  }
  const s = Math.min(size / srcW, size / srcH);
  const dw = Math.round(srcW * s);
  const dh = Math.round(srcH * s);
  const px = Math.floor((size - dw) / 2);
  const py = Math.floor((size - dh) / 2);
  return { size, sx: s, sy: s, px, py, dw, dh, srcW, srcH };
}

/** RGBA (size x size) -> NCHW float32 RGB in [0,1]. Reuses `out` when given. */
export function rgbaToTensor(rgba: Uint8ClampedArray | Uint8Array, size: number, out?: Float32Array): Float32Array {
  const plane = size * size;
  const t = out && out.length === plane * 3 ? out : new Float32Array(plane * 3);
  const inv = 1 / 255;
  for (let i = 0, p = 0; p < plane; p++, i += 4) {
    t[p] = rgba[i] * inv;
    t[p + plane] = rgba[i + 1] * inv;
    t[p + 2 * plane] = rgba[i + 2] * inv;
  }
  return t;
}

/* ---------------- Lanczos-3 resampling straight into the NCHW tensor ---------------- */
// Sharper kernels matter a lot for small objects on soft CCTV video: on a Caltrans frame D-FINE-N
// found 13 cars (>=0.3) with bilinear, 41 with bicubic and 61 with Lanczos-3 resizing.

interface Taps {
  n: number;
  idx: Int32Array;
  w: Float32Array;
}

function lanczos(x: number, a: number): number {
  if (x === 0) return 1;
  if (x <= -a || x >= a) return 0;
  const px = Math.PI * x;
  return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
}

function buildTaps(srcLen: number, dstLen: number, a = 3): Taps {
  const scale = srcLen / dstLen;
  const filterScale = Math.max(1, scale);
  const support = a * filterScale;
  const n = Math.ceil(support) * 2 + 1;
  const idx = new Int32Array(dstLen * n);
  const w = new Float32Array(dstLen * n);
  for (let o = 0; o < dstLen; o++) {
    const center = (o + 0.5) * scale - 0.5;
    const start = Math.floor(center - support) + 1;
    let sum = 0;
    for (let j = 0; j < n; j++) {
      const sx = start + j;
      const wt = lanczos((sx - center) / filterScale, a);
      idx[o * n + j] = Math.min(srcLen - 1, Math.max(0, sx));
      w[o * n + j] = wt;
      sum += wt;
    }
    if (sum !== 0) for (let j = 0; j < n; j++) w[o * n + j] /= sum;
  }
  return { n, idx, w };
}

const tapCache = new Map<string, { h: Taps; v: Taps }>();
let tmpBuf: Float32Array | null = null;

/**
 * Resize an RGBA source (sw x sh) into the model tensor according to `layout` (stretch or letterbox),
 * NCHW float32 RGB in [0,1]; letterbox padding is filled with 114/255.
 */
export function resampleToTensor(
  rgba: Uint8ClampedArray | Uint8Array,
  sw: number,
  sh: number,
  layout: Layout,
  out?: Float32Array,
): Float32Array {
  const size = layout.size;
  const plane = size * size;
  const t = out && out.length === plane * 3 ? out : new Float32Array(plane * 3);
  const dw = layout.dw;
  const dh = layout.dh;
  const key = `${sw}x${sh}>${dw}x${dh}`;
  let taps = tapCache.get(key);
  if (!taps) {
    taps = { h: buildTaps(sw, dw), v: buildTaps(sh, dh) };
    if (tapCache.size > 16) tapCache.clear();
    tapCache.set(key, taps);
  }
  if (layout.px > 0 || layout.py > 0 || dw < size || dh < size) t.fill(114 / 255);
  // horizontal pass: tmp[c][y][x] (sh x dw)
  const need = 3 * sh * dw;
  if (!tmpBuf || tmpBuf.length < need) tmpBuf = new Float32Array(need);
  const tmp = tmpBuf;
  const { n: hn, idx: hi, w: hw } = taps.h;
  const pl = sh * dw;
  for (let y = 0; y < sh; y++) {
    const row = y * sw * 4;
    const trow = y * dw;
    for (let x = 0; x < dw; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      const base = x * hn;
      for (let j = 0; j < hn; j++) {
        const wt = hw[base + j];
        const si = row + hi[base + j] * 4;
        r += rgba[si] * wt;
        g += rgba[si + 1] * wt;
        b += rgba[si + 2] * wt;
      }
      tmp[trow + x] = r;
      tmp[pl + trow + x] = g;
      tmp[2 * pl + trow + x] = b;
    }
  }
  // vertical pass into the tensor
  const { n: vn, idx: vi, w: vw } = taps.v;
  const inv = 1 / 255;
  for (let oy = 0; oy < dh; oy++) {
    const base = oy * vn;
    const orow = (layout.py + oy) * size + layout.px;
    for (let c = 0; c < 3; c++) {
      const src = c * pl;
      const dst = c * plane + orow;
      for (let x = 0; x < dw; x++) {
        let v = 0;
        for (let j = 0; j < vn; j++) v += tmp[src + vi[base + j] * dw + x] * vw[base + j];
        v *= inv;
        t[dst + x] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
    }
  }
  return t;
}

function clampBox(x1: number, y1: number, x2: number, y2: number, W: number, H: number) {
  const ax = Math.max(0, Math.min(W, x1));
  const ay = Math.max(0, Math.min(H, y1));
  const bx = Math.max(0, Math.min(W, x2));
  const by = Math.max(0, Math.min(H, y2));
  return { x: ax, y: ay, w: Math.max(0, bx - ax), h: Math.max(0, by - ay) };
}

const sigmoid = (v: number) => 1 / (1 + Math.exp(-v));

/**
 * D-FINE / RT-DETR head: logits [1,Q,C] (focal, sigmoid), pred_boxes [1,Q,4] normalized cxcywh
 * relative to the model input.
 */
export function decodeDfine(
  logits: Float32Array,
  boxes: Float32Array,
  numQueries: number,
  numClasses: number,
  layout: Layout,
  threshold: number,
): Detection[] {
  const out: Detection[] = [];
  // threshold in logit space to skip sigmoid for most entries
  const logitThr = Math.log(threshold / (1 - threshold));
  for (let q = 0; q < numQueries; q++) {
    let best = -Infinity;
    let bestC = -1;
    const base = q * numClasses;
    for (let c = 0; c < numClasses; c++) {
      const v = logits[base + c];
      if (v > best) {
        best = v;
        bestC = c;
      }
    }
    if (best < logitThr) continue;
    const b = q * 4;
    const cx = boxes[b] * layout.size;
    const cy = boxes[b + 1] * layout.size;
    const w = boxes[b + 2] * layout.size;
    const h = boxes[b + 3] * layout.size;
    const x1 = (cx - w / 2 - layout.px) / layout.sx;
    const y1 = (cy - h / 2 - layout.py) / layout.sy;
    const x2 = (cx + w / 2 - layout.px) / layout.sx;
    const y2 = (cy + h / 2 - layout.py) / layout.sy;
    const r = clampBox(x1, y1, x2, y2, layout.srcW, layout.srcH);
    if (r.w < 2 || r.h < 2) continue;
    out.push({ ...r, score: sigmoid(best), classId: bestC, label: COCO_LABELS[bestC] ?? `class ${bestC}` });
  }
  return nms(out, 0.7);
}

/** YOLOv10 (NMS-free): output [1,N,6] = x1,y1,x2,y2,score,class in model-input pixels. */
export function decodeYolov10(output: Float32Array, n: number, layout: Layout, threshold: number): Detection[] {
  const out: Detection[] = [];
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    const score = output[o + 4];
    if (score < threshold) continue;
    const cls = Math.round(output[o + 5]);
    const x1 = (output[o] - layout.px) / layout.sx;
    const y1 = (output[o + 1] - layout.py) / layout.sy;
    const x2 = (output[o + 2] - layout.px) / layout.sx;
    const y2 = (output[o + 3] - layout.py) / layout.sy;
    const r = clampBox(x1, y1, x2, y2, layout.srcW, layout.srcH);
    if (r.w < 2 || r.h < 2) continue;
    out.push({ ...r, score, classId: cls, label: COCO_LABELS[cls] ?? `class ${cls}` });
  }
  return out;
}

export function iou(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

/** Class-wise greedy NMS. */
export function nms(dets: Detection[], thr: number): Detection[] {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const keep: Detection[] = [];
  for (const d of sorted) {
    if (keep.some((k) => k.classId === d.classId && iou(k, d) > thr)) continue;
    keep.push(d);
  }
  return keep;
}
