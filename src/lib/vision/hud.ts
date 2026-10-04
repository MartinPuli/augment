/**
 * Canvas HUD for the live view. All drawing is in CSS pixels (caller sets the DPR transform).
 */
import type { FollowStatus } from "./follow";
import type { Box, Track } from "./tracker";

export const HUD = {
  mint: "#5df2b5",
  amber: "#ffb547",
  coral: "#ff6b5e",
  violet: "#a99bff",
  ivory: "#f4efe4",
  ivoryDim: "#c9c4b8",
  mute: "#8a877f",
  ink: "#0a0b0e",
};

let monoFamily: string | null = null;
export function mono(px: number, weight = 500): string {
  if (monoFamily === null) {
    try {
      monoFamily = getComputedStyle(document.body).getPropertyValue("--font-mono").trim() || "";
    } catch {
      monoFamily = "";
    }
    if (!monoFamily || monoFamily.includes("var(")) monoFamily = "ui-monospace, SFMono-Regular, Menlo, monospace";
  }
  return `${weight} ${px}px ${monoFamily}`;
}

export interface ViewXf {
  crop: Box;
  /** view size in CSS px */
  w: number;
  h: number;
}

export function toView(v: ViewXf, x: number, y: number): [number, number] {
  return [((x - v.crop.x) * v.w) / v.crop.w, ((y - v.crop.y) * v.h) / v.crop.h];
}

export function boxToView(v: ViewXf, b: Box): Box {
  const [x, y] = toView(v, b.x, b.y);
  return { x, y, w: (b.w * v.w) / v.crop.w, h: (b.h * v.h) / v.crop.h };
}

export function classColor(label: string): string {
  if (label === "person") return HUD.violet;
  if (label === "car" || label === "truck" || label === "bus" || label === "motorcycle" || label === "bicycle" || label === "train") return HUD.ivory;
  return HUD.ivoryDim;
}

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function brackets(ctx: CanvasRenderingContext2D, b: Box, len: number) {
  const { x, y, w, h } = b;
  const l = Math.min(len, w / 2, h / 2);
  ctx.moveTo(x, y + l);
  ctx.lineTo(x, y);
  ctx.lineTo(x + l, y);
  ctx.moveTo(x + w - l, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + l);
  ctx.moveTo(x + w, y + h - l);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + w - l, y + h);
  ctx.moveTo(x + l, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + h - l);
}

function chip(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string, strong: boolean) {
  ctx.font = mono(10, strong ? 600 : 500);
  const tw = ctx.measureText(text).width;
  const pad = 4;
  const h = 15;
  const cx = Math.max(2, Math.min(x, ctx.canvas.width / (ctx.getTransform().a || 1) - tw - pad * 2 - 2));
  const cy = Math.max(30, y - h - 3); // stay below the HTML top strip
  ctx.fillStyle = strong ? rgba(HUD.ink, 0.86) : rgba(HUD.ink, 0.62);
  ctx.fillRect(cx, cy, tw + pad * 2, h);
  ctx.fillStyle = color;
  ctx.fillRect(cx, cy, 2, h);
  ctx.fillStyle = strong ? color : rgba(HUD.ivory, 0.92);
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx + pad + 1, cy + h / 2 + 0.5);
}

export interface DrawTracksArgs {
  view: ViewXf;
  tracks: Track[];
  boxes: Map<number, Box>;
  targetId: number | null;
  now: number;
  hoverId: number | null;
  classes: string[] | null;
}

export function drawTracks(ctx: CanvasRenderingContext2D, a: DrawTracksArgs) {
  const { view, tracks, boxes, targetId, now } = a;
  // trails
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const t of tracks) {
    if (t.trail.length < 2) continue;
    const isT = t.id === targetId;
    const col = isT ? HUD.mint : classColor(t.label);
    const jump = Math.max(t.box.w, t.box.h) * 2.5 + 4;
    for (let i = 1; i < t.trail.length; i++) {
      const p0 = t.trail[i - 1];
      const p1 = t.trail[i];
      if (Math.abs(p1.x - p0.x) + Math.abs(p1.y - p0.y) > jump) continue; // skip ID-switch jumps
      const age = (now - p1.t) / 2500;
      const alpha = Math.max(0, 1 - age) * (i / t.trail.length) * (isT ? 0.9 : 0.45);
      if (alpha <= 0.02) continue;
      const [x0, y0] = toView(view, p0.x, p0.y);
      const [x1, y1] = toView(view, p1.x, p1.y);
      ctx.strokeStyle = rgba(col, alpha);
      ctx.lineWidth = isT ? 2 : 1.25;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  }

  // boxes
  const chips: { t: Track; b: Box; strong: boolean }[] = [];
  for (const t of tracks) {
    const src = boxes.get(t.id) ?? t.box;
    const b = boxToView(view, src);
    if (b.x + b.w < 0 || b.y + b.h < 0 || b.x > view.w || b.y > view.h) continue;
    const isT = t.id === targetId;
    const dim = a.classes && !a.classes.includes(t.label) && !isT;
    const col = isT ? HUD.mint : classColor(t.label);
    const fresh = now - t.lastSeen < 400;
    ctx.strokeStyle = rgba(col, dim ? 0.28 : fresh ? 0.95 : 0.5);
    ctx.lineWidth = isT ? 2 : a.hoverId === t.id ? 1.75 : 1.25;
    ctx.beginPath();
    brackets(ctx, b, Math.max(4, Math.min(14, Math.min(b.w, b.h) * 0.28)));
    ctx.stroke();
    if (isT || a.hoverId === t.id) {
      ctx.fillStyle = rgba(col, isT ? 0.08 : 0.05);
      ctx.fillRect(b.x, b.y, b.w, b.h);
    }
    if (!dim && (isT || a.hoverId === t.id || b.w >= 26)) chips.push({ t, b, strong: isT });
  }
  chips.sort((p, q) => Number(q.strong) - Number(p.strong) || q.b.w * q.b.h - p.b.w * p.b.h);
  for (const c of chips.slice(0, 14)) {
    const col = c.strong ? HUD.mint : classColor(c.t.label);
    chip(ctx, c.b.x, c.b.y, `#${c.t.id} ${c.t.label} ${Math.round(c.t.score * 100)}%`, col, c.strong);
  }
}

/** Lock-on reticle around the target. `lockT` = seconds since acquisition (for the snap-in animation). */
export function drawReticle(ctx: CanvasRenderingContext2D, b: Box, status: FollowStatus, now: number, lockT: number) {
  const col = status === "locked" ? HUD.mint : status === "holding" ? HUD.coral : HUD.amber;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const base = Math.max(b.w, b.h) / 2 + 10;
  const snap = Math.min(1, lockT / 0.45);
  const ease = 1 - Math.pow(1 - snap, 3);
  const r = base + (1 - ease) * 60;
  const rot = (now / 1000) * (status === "locked" ? 0.6 : 1.6);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = rgba(col, 0.25 + 0.65 * ease);
  ctx.lineWidth = 1.5;
  // four rotating arcs
  for (let i = 0; i < 4; i++) {
    const a0 = rot + (i * Math.PI) / 2 + 0.2;
    ctx.beginPath();
    ctx.arc(0, 0, r, a0, a0 + Math.PI / 2 - 0.4);
    ctx.stroke();
  }
  // cardinal ticks
  ctx.lineWidth = 2;
  for (let i = 0; i < 4; i++) {
    const a0 = (i * Math.PI) / 2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a0) * (r + 3), Math.sin(a0) * (r + 3));
    ctx.lineTo(Math.cos(a0) * (r + 10), Math.sin(a0) * (r + 10));
    ctx.stroke();
  }
  // centre pip
  ctx.fillStyle = rgba(col, 0.9);
  ctx.beginPath();
  ctx.arc(0, 0, 1.75, 0, Math.PI * 2);
  ctx.fill();
  // pulse ring on acquisition
  if (lockT < 0.9 && status === "locked") {
    const p = lockT / 0.9;
    ctx.strokeStyle = rgba(col, 0.6 * (1 - p));
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, base + p * 46, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** Amber search sweep when nothing is locked yet. */
export function drawSearching(ctx: CanvasRenderingContext2D, w: number, h: number, now: number) {
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * 0.16;
  const t = now / 1000;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = rgba(HUD.amber, 0.55);
  ctx.lineWidth = 1.25;
  ctx.setLineDash([3, 6]);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = rgba(HUD.amber, 0.85);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, r, t * 2.2, t * 2.2 + 0.9);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = rgba(HUD.amber, 0.5);
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    ctx.beginPath();
    ctx.moveTo(dx * (r - 6), dy * (r - 6));
    ctx.lineTo(dx * (r + 6), dy * (r + 6));
    ctx.stroke();
  }
  ctx.restore();
}

/** "LOCKED · #12 car" banner that types in, holds, and fades. */
export function drawLockBanner(ctx: CanvasRenderingContext2D, w: number, text: string, t: number, color = HUD.mint) {
  if (t > 2.2) return;
  const typed = text.slice(0, Math.ceil(Math.min(1, t / 0.35) * text.length));
  const alpha = t < 1.6 ? 1 : Math.max(0, 1 - (t - 1.6) / 0.6);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = mono(12, 600);
  const tw = ctx.measureText(text).width;
  const bw = tw + 28;
  const x = (w - bw) / 2;
  const y = 44;
  ctx.fillStyle = rgba(HUD.ink, 0.78);
  ctx.fillRect(x, y, bw, 24);
  ctx.strokeStyle = rgba(color, 0.9);
  ctx.lineWidth = 1;
  ctx.beginPath();
  brackets(ctx, { x: x - 0.5, y: y - 0.5, w: bw + 1, h: 25 }, 6);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(typed, x + 14, y + 12.5);
  ctx.restore();
}

/** Minimap of the full frame with the follow-cam crop rectangle. */
export function drawMinimap(
  ctx: CanvasRenderingContext2D,
  el: CanvasImageSource,
  frameW: number,
  frameH: number,
  crop: Box,
  tracks: Track[],
  boxes: Map<number, Box>,
  targetId: number | null,
  rect: Box,
) {
  ctx.save();
  ctx.fillStyle = rgba(HUD.ink, 0.7);
  ctx.fillRect(rect.x - 3, rect.y - 3, rect.w + 6, rect.h + 6);
  ctx.globalAlpha = 0.85;
  try {
    ctx.drawImage(el, 0, 0, frameW, frameH, rect.x, rect.y, rect.w, rect.h);
  } catch {}
  ctx.globalAlpha = 1;
  ctx.fillStyle = rgba(HUD.ink, 0.25);
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  const sx = rect.w / frameW;
  const sy = rect.h / frameH;
  for (const t of tracks) {
    const b = boxes.get(t.id) ?? t.box;
    const isT = t.id === targetId;
    ctx.fillStyle = isT ? HUD.mint : rgba(classColor(t.label), 0.8);
    const px = rect.x + (b.x + b.w / 2) * sx;
    const py = rect.y + (b.y + b.h / 2) * sy;
    ctx.fillRect(px - (isT ? 2 : 1), py - (isT ? 2 : 1), isT ? 4 : 2, isT ? 4 : 2);
  }
  // dim outside the crop
  const cx = rect.x + crop.x * sx;
  const cy = rect.y + crop.y * sy;
  const cw = crop.w * sx;
  const ch = crop.h * sy;
  ctx.strokeStyle = rgba(HUD.mint, 0.95);
  ctx.lineWidth = 1.25;
  ctx.strokeRect(cx, cy, cw, ch);
  ctx.strokeStyle = rgba(HUD.ivory, 0.18);
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x - 0.5, rect.y - 0.5, rect.w + 1, rect.h + 1);
  ctx.restore();
}

/** Subtle scanlines + vignette for the "optical" feel. */
export function drawOptics(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.38)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

/** Frame corner marks of the whole viewport. */
export function drawViewportCorners(ctx: CanvasRenderingContext2D, w: number, h: number, color: string) {
  ctx.strokeStyle = rgba(color, 0.55);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  brackets(ctx, { x: 10, y: 10, w: w - 20, h: h - 20 }, 16);
  ctx.stroke();
}
