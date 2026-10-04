/**
 * SAHI-style tiled inference helpers. Small objects (cars on a high highway camera) are only a few
 * pixels wide at the model's 640 input; running extra passes on sub-regions upsamples them.
 * Results are mapped back to full-frame coordinates and merged with NMS. Detections touching an
 * inner tile cut are dropped (they are usually truncated halves of a larger object).
 */
import { nms } from "./postprocess";
import type { Box } from "./tracker";
import type { Detection } from "./types";

export interface Tile extends Box {
  /** Integer pixel region in the source frame. */
}

function clampTile(b: Box, fw: number, fh: number): Tile {
  const w = Math.max(32, Math.min(fw, Math.round(b.w)));
  const h = Math.max(32, Math.min(fh, Math.round(b.h)));
  const x = Math.max(0, Math.min(fw - w, Math.round(b.x)));
  const y = Math.max(0, Math.min(fh - h, Math.round(b.y)));
  return { x, y, w, h };
}

/**
 * Extra regions to run besides the full frame.
 * - zoomed follow-cam: one tile = the visible crop (+25 % margin)
 * - otherwise: two overlapping halves along the long side (only if the budget allows)
 */
export function planTiles(
  fw: number,
  fh: number,
  crop: Box | null,
  opts: { perPassMs: number; budgetMs: number; allow: boolean },
): Tile[] {
  if (!opts.allow) return [];
  const per = Math.max(1, opts.perPassMs || 60);
  if (crop && crop.w < fw / 1.35) {
    if (per * 2 > opts.budgetMs) return [];
    const m = 0.25;
    return [clampTile({ x: crop.x - (crop.w * m) / 2, y: crop.y - (crop.h * m) / 2, w: crop.w * (1 + m), h: crop.h * (1 + m) }, fw, fh)];
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
