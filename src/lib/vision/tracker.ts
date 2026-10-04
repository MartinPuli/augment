/**
 * Multi-object tracker: ByteTrack-lite.
 *  - constant-velocity prediction (EMA velocity on box centre + size)
 *  - stage 1: high-score detections vs all live tracks (IoU, with a centre-distance fallback so
 *    tiny fast objects — e.g. cars on a highway cam at a few FPS — still associate)
 *  - stage 2: low-score detections vs remaining confirmed tracks (recovers occluded / blurred objects)
 *  - tentative -> confirmed after `minHits`; confirmed tracks survive `maxAgeMs` without a match
 *  - stable integer ids, trail history, speed estimate (source px/s)
 * Time is passed in explicitly (ms), so it is deterministic and testable.
 */
import { iou } from "./postprocess";
import type { Detection } from "./types";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TrailPoint {
  x: number;
  y: number;
  t: number;
}

export interface Track {
  id: number;
  classId: number;
  label: string;
  /** Last corrected box (source px). */
  box: Box;
  /** Velocity of centre (px/s) and size (px/s). */
  vx: number;
  vy: number;
  vw: number;
  vh: number;
  score: number;
  hits: number;
  state: "tentative" | "confirmed";
  firstSeen: number;
  lastSeen: number;
  /** Time of the last update() that touched this track. */
  lastUpdate: number;
  trail: TrailPoint[];
  /** Smoothed speed of centre in source px/s. */
  speed: number;
}

/** Net displacement speed over the trail window (px/s) — robust to box jitter, unlike `speed`. */
export function netSpeed(t: Track): number {
  const a = t.trail[0];
  const b = t.trail[t.trail.length - 1];
  if (!a || !b || b.t - a.t < 400) return 0;
  return Math.hypot(b.x - a.x, b.y - a.y) / ((b.t - a.t) / 1000);
}

export interface TrackerOptions {
  highThresh?: number;
  lowThresh?: number;
  newTrackThresh?: number;
  /** Min similarity for stage-1 / stage-2 matches. */
  matchSim?: number;
  lowMatchSim?: number;
  maxAgeMs?: number;
  minHits?: number;
  trailMs?: number;
  maxTrail?: number;
  /** Let vehicles (car/truck/bus) and similar classes keep identity when the label flickers. */
  classGroups?: string[][];
}

const DEFAULT_GROUPS = [["car", "truck", "bus", "train"], ["motorcycle", "bicycle"], ["person"]];

export class Tracker {
  private tracks: Track[] = [];
  private nextId = 1;
  private o: Required<TrackerOptions>;
  private groupOf = new Map<string, number>();

  constructor(opts: TrackerOptions = {}) {
    this.o = {
      highThresh: 0.25,
      lowThresh: 0.12,
      newTrackThresh: 0.3,
      matchSim: 0.15,
      lowMatchSim: 0.3,
      maxAgeMs: 1500,
      minHits: 2,
      trailMs: 2500,
      maxTrail: 48,
      classGroups: DEFAULT_GROUPS,
      ...opts,
    };
    this.o.classGroups.forEach((g, i) => g.forEach((l) => this.groupOf.set(l, i)));
  }

  reset() {
    this.tracks = [];
    this.nextId = 1;
  }

  /** All live tracks (tentative included). */
  all(): readonly Track[] {
    return this.tracks;
  }

  confirmed(): Track[] {
    return this.tracks.filter((t) => t.state === "confirmed");
  }

  get(id: number): Track | undefined {
    return this.tracks.find((t) => t.id === id);
  }

  /** Box extrapolated to time `t` (ms) with constant velocity, capped to avoid run-away boxes. */
  predict(tr: Track, t: number, maxMs = 600): Box {
    const dt = Math.max(0, Math.min(maxMs, t - tr.lastSeen)) / 1000;
    const w = Math.max(2, tr.box.w + tr.vw * dt);
    const h = Math.max(2, tr.box.h + tr.vh * dt);
    const cx = tr.box.x + tr.box.w / 2 + tr.vx * dt;
    const cy = tr.box.y + tr.box.h / 2 + tr.vy * dt;
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  }

  private compatible(a: string, b: string): boolean {
    if (a === b) return true;
    const ga = this.groupOf.get(a);
    return ga !== undefined && ga === this.groupOf.get(b);
  }

  private similarity(pred: Box, d: Detection): number {
    const i = iou(pred, d);
    if (i > 0.05) return i;
    // centre-distance fallback for small / fast objects
    const dx = pred.x + pred.w / 2 - (d.x + d.w / 2);
    const dy = pred.y + pred.h / 2 - (d.y + d.h / 2);
    const dist = Math.hypot(dx, dy);
    const gate = Math.max(pred.w, pred.h, d.w, d.h) * 1.1;
    if (dist >= gate) return i;
    const sizeRatio = Math.min(pred.w * pred.h, d.w * d.h) / Math.max(pred.w * pred.h, d.w * d.h);
    if (sizeRatio < 0.25) return i;
    return Math.max(i, 0.5 * (1 - dist / gate) * sizeRatio);
  }

  private associate(tracks: Track[], dets: Detection[], t: number, minSim: number) {
    const pairs: { ti: number; di: number; s: number }[] = [];
    const preds = tracks.map((tr) => this.predict(tr, t));
    for (let ti = 0; ti < tracks.length; ti++) {
      for (let di = 0; di < dets.length; di++) {
        if (!this.compatible(tracks[ti].label, dets[di].label)) continue;
        const s = this.similarity(preds[ti], dets[di]) - (tracks[ti].label === dets[di].label ? 0 : 0.05);
        if (s >= minSim) pairs.push({ ti, di, s });
      }
    }
    pairs.sort((a, b) => b.s - a.s);
    const usedT = new Set<number>();
    const usedD = new Set<number>();
    const matches: [Track, Detection][] = [];
    for (const p of pairs) {
      if (usedT.has(p.ti) || usedD.has(p.di)) continue;
      usedT.add(p.ti);
      usedD.add(p.di);
      matches.push([tracks[p.ti], dets[p.di]]);
    }
    return {
      matches,
      unmatchedTracks: tracks.filter((_, i) => !usedT.has(i)),
      unmatchedDets: dets.filter((_, i) => !usedD.has(i)),
    };
  }

  private apply(tr: Track, d: Detection, t: number) {
    const dt = Math.max(1e-3, (t - tr.lastSeen) / 1000);
    const pcx = tr.box.x + tr.box.w / 2;
    const pcy = tr.box.y + tr.box.h / 2;
    const cx = d.x + d.w / 2;
    const cy = d.y + d.h / 2;
    // light smoothing of the measurement towards the prediction (reduces jitter on tiny boxes)
    const pred = this.predict(tr, t);
    const a = tr.hits < 3 ? 1 : 0.75;
    const sw = a * d.w + (1 - a) * pred.w;
    const sh = a * d.h + (1 - a) * pred.h;
    const scx = a * cx + (1 - a) * (pred.x + pred.w / 2);
    const scy = a * cy + (1 - a) * (pred.y + pred.h / 2);
    if (dt < 2) {
      const k = tr.hits < 2 ? 1 : 0.35;
      tr.vx = (1 - k) * tr.vx + k * ((scx - pcx) / dt);
      tr.vy = (1 - k) * tr.vy + k * ((scy - pcy) / dt);
      tr.vw = (1 - k) * tr.vw * 0.5 + k * ((sw - tr.box.w) / dt) * 0.5;
      tr.vh = (1 - k) * tr.vh * 0.5 + k * ((sh - tr.box.h) / dt) * 0.5;
    }
    // cap velocity to a plausible number of box-lengths per second (stops run-away predictions after
    // an occasional wrong association)
    const vmax = Math.max(sw, sh) * 6 + 20;
    const vmag = Math.hypot(tr.vx, tr.vy);
    if (vmag > vmax) {
      tr.vx *= vmax / vmag;
      tr.vy *= vmax / vmag;
    }
    tr.box = { x: scx - sw / 2, y: scy - sh / 2, w: sw, h: sh };
    tr.score = 0.7 * tr.score + 0.3 * d.score;
    if (d.label !== tr.label && d.score > tr.score + 0.1) {
      tr.label = d.label;
      tr.classId = d.classId;
    }
    tr.hits++;
    tr.lastSeen = t;
    tr.speed = 0.8 * tr.speed + 0.2 * Math.hypot(tr.vx, tr.vy);
    if (tr.state === "tentative" && tr.hits >= this.o.minHits) tr.state = "confirmed";
    tr.trail.push({ x: scx, y: scy, t });
  }

  /** Feed detections captured at time `t` (ms). Returns confirmed tracks. */
  update(dets: Detection[], t: number): Track[] {
    const high = dets.filter((d) => d.score >= this.o.highThresh);
    const low = dets.filter((d) => d.score >= this.o.lowThresh && d.score < this.o.highThresh);

    const s1 = this.associate(this.tracks, high, t, this.o.matchSim);
    for (const [tr, d] of s1.matches) this.apply(tr, d, t);

    const s2 = this.associate(
      s1.unmatchedTracks.filter((tr) => tr.state === "confirmed"),
      low,
      t,
      this.o.lowMatchSim,
    );
    for (const [tr, d] of s2.matches) this.apply(tr, d, t);
    const matchedIds = new Set([...s1.matches, ...s2.matches].map(([tr]) => tr.id));

    // prune: unmatched tentative tracks die immediately; confirmed ones after maxAge
    this.tracks = this.tracks.filter((tr) => {
      if (matchedIds.has(tr.id)) return true;
      if (tr.state === "tentative") return false;
      return t - tr.lastSeen <= this.o.maxAgeMs;
    });

    for (const d of s1.unmatchedDets) {
      if (d.score < this.o.newTrackThresh) continue;
      // don't spawn duplicates on top of an existing track
      if (this.tracks.some((tr) => iou(this.predict(tr, t), d) > 0.6)) continue;
      this.tracks.push({
        id: this.nextId++,
        classId: d.classId,
        label: d.label,
        box: { x: d.x, y: d.y, w: d.w, h: d.h },
        vx: 0,
        vy: 0,
        vw: 0,
        vh: 0,
        score: d.score,
        hits: 1,
        state: this.o.minHits <= 1 ? "confirmed" : "tentative",
        firstSeen: t,
        lastSeen: t,
        lastUpdate: t,
        trail: [{ x: d.x + d.w / 2, y: d.y + d.h / 2, t }],
        speed: 0,
      });
    }

    for (const tr of this.tracks) {
      tr.lastUpdate = t;
      const cutoff = t - this.o.trailMs;
      while (tr.trail.length && (tr.trail[0].t < cutoff || tr.trail.length > this.o.maxTrail)) tr.trail.shift();
    }
    return this.confirmed();
  }
}
