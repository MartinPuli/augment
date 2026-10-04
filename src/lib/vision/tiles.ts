/**
 * SAHI-style tiled inference helpers. Small objects (cars on a high highway camera) are only a few
 * pixels wide at the model's 640 input; running extra passes on sub-regions upsamples them.
 * Results are mapped back to full-frame coordinates and merged with NMS. Detections touching an
 * inner tile cut are dropped (they are usually truncated halves of a larger object).
 */
import { nms } from "./postprocess";
import type { Box } from "./tracker";
import type { Detection } from "./types";

/** Integer pixel region in the source frame. */
export type Tile = Box;

function clampTile(b: Box, fw: number, fh: number): Tile {
  const w = Math.max(32, Math.min(fw, Math.round(b.w)));
  const h = Math.max(32, Math.min(fh, Math.round(b.h)));
  const x = Math.max(0, Math.min(fw - w, Math.round(b.x)));
  const y = Math.max(0, Math.min(fh - h, Math.round(b.y)));
  return { x, y, w, h };
}

/**
 * Extra regions to run besides the full frame (only for large sources, never upsampling):
 * - zoomed follow-cam: one tile around the visible crop (+25 % margin, at least ~model-input size)
 * - otherwise: two overlapping halves along the long side (only if the budget allows)
 */
export function planTiles(
  fw: number,
  fh: number,
  crop: Box | null,
  opts: { perPassMs: number; budgetMs: number; allow: boolean; modelInput?: number },
): Tile[] {
  if (!opts.allow) return [];
  const per = Math.max(1, opts.perPassMs || 60);
  // Never upsample: DETR/YOLO detectors do worse on blurry upscaled crops than on the native frame
  // (measured on Caltrans TVD32: 41 cars at full frame vs 0 on a 2.3x-upscaled crop). Tiles only pay
  // off when the source is much larger than the model input (e.g. a 1280-1920 px webcam / phone).
  const minSide = (opts.modelInput ?? 640) * 0.85;
  if (Math.max(fw, fh) < (opts.modelInput ?? 640) * 1.5) return [];
  if (crop && crop.w < fw / 1.35) {
    if (per * 2 > opts.budgetMs) return [];
    const m = 0.25;
    const w = Math.max(minSide, crop.w * (1 + m));
    const h = Math.max(minSide * (fh / fw), crop.h * (1 + m));
    return [clampTile({ x: crop.x + crop.w / 2 - w / 2, y: crop.y + crop.h / 2 - h / 2, w, h }, fw, fh)];
  }
  if (per * 3 > opts.budgetMs) return [];
  if (fw >= fh) {
    const w = fw * 0.56;
    return [clampTile({ x: 0, y: 0, w, h: fh }, fw, fh), clampTile({ x: fw - w, y: 0, w, h: fh }, fw, fh)];
  }
  const h = fh * 0.56;
  return [clampTile({ x: 0, y: 0, w: fw, h }, fw, fh), clampTile({ x: 0, y: fh - h, w: fw, h }, fw, fh)];
}

/** Map tile-local detections to frame coordinates, dropping boxes cut by an inner tile edge. */
export function fromTile(dets: Detection[], tile: Tile, fw: number, fh: number): Detection[] {
  const edge = 3;
  const out: Detection[] = [];
  for (const d of dets) {
    if (tile.x > 0 && d.x <= edge) continue;
    if (tile.y > 0 && d.y <= edge) continue;
    if (tile.x + tile.w < fw && d.x + d.w >= tile.w - edge) continue;
    if (tile.y + tile.h < fh && d.y + d.h >= tile.h - edge) continue;
    out.push({ ...d, x: d.x + tile.x, y: d.y + tile.y });
  }
  return out;
}

export function mergeDetections(lists: Detection[][]): Detection[] {
  const all = lists.flat();
  return lists.length > 1 ? nms(all, 0.5) : all;
}
