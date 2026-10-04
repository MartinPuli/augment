/**
 * Virtual follow-cam: a smoothly moving crop window over the source frame that keeps a tracked
 * target framed. Critically-damped springs drive centre and zoom; a dead zone stops micro-jitter;
 * the crop is clamped inside the frame. Lock is kept until the target has been missing for
 * `lostMs`, then a new target is acquired (class filter + largest / most-moving heuristic).
 */
import { netSpeed, type Box, type Track } from "./tracker";

export type FollowStatus = "off" | "searching" | "locked" | "holding";

export interface FollowOptions {
  /** Follow automatically (true), a specific track id (number), or not at all (false). */
  follow: boolean | number;
  classes: string[] | null;
  maxZoom: number;
  /** Fraction of the crop size the target may drift before the camera moves. */
  deadZone: number;
  /** Spring angular frequencies (rad/s). */
  omegaPos: number;
  omegaZoom: number;
  /** How long a locked target may be missing before re-acquiring. */
  lostMs: number;
  /** Fraction of the crop the target should fill (by its larger relative side). */
  fill: number;
}

export interface FollowFrame {
  crop: Box;
  zoom: number;
  status: FollowStatus;
  targetId: number | null;
  /** True exactly on the frame a (new) target was acquired. */
  acquired: boolean;
}

const DEFAULTS: FollowOptions = {
  follow: true,
  classes: null,
  maxZoom: 3,
  deadZone: 0.06,
  omegaPos: 3.2,
  omegaZoom: 2.2,
  lostMs: 1500,
  fill: 0.32,
};

interface Spring {
  x: number;
  v: number;
}

function stepSpring(s: Spring, target: number, omega: number, dt: number) {
  // critically damped: x'' = w^2 (target - x) - 2 w x'
  const a = omega * omega * (target - s.x) - 2 * omega * s.v;
  s.v += a * dt;
  s.x += s.v * dt;
}

export class FollowCam {
  o: FollowOptions;
  private cx: Spring = { x: 0, v: 0 };
  private cy: Spring = { x: 0, v: 0 };
  private z: Spring = { x: 1, v: 0 };
  private frameW = 0;
  private frameH = 0;
  private targetId: number | null = null;
  private missingSince: number | null = null;
  private explicitId: number | null = null;

  constructor(opts: Partial<FollowOptions> = {}) {
    this.o = { ...DEFAULTS, ...opts };
    if (typeof this.o.follow === "number") this.explicitId = this.o.follow;
  }

  configure(opts: Partial<FollowOptions>) {
    const prevFollow = this.o.follow;
    this.o = { ...this.o, ...opts };
    if (opts.follow !== undefined && opts.follow !== prevFollow) {
      this.explicitId = typeof opts.follow === "number" ? opts.follow : null;
      if (typeof opts.follow === "number") this.targetId = null; // re-lock on the explicit id
      if (opts.follow === false) this.targetId = null;
    }
  }

  /** User/agent picked a specific track. */
  lock(id: number | null) {
    this.explicitId = id;
    this.targetId = null;
    this.missingSince = null;
    this.o.follow = id ?? true;
  }

  get currentTarget(): number | null {
    return this.targetId;
  }

  private choose(tracks: Track[]): Track | null {
    const area = this.frameW * this.frameH || 1;
    const diag = Math.hypot(this.frameW, this.frameH) || 1;
    const inClass = tracks.filter((t) => !this.o.classes || this.o.classes.includes(t.label));
    // prefer established, confident, plausibly-sized tracks; fall back to anything in-class
    const solid = inClass.filter((t) => t.hits >= 4 && t.score >= 0.22 && (t.box.w * t.box.h) / area < 0.2);
    // genuinely moving (net displacement, not jitter) beats static look-alikes such as camera OSD text
    const moving = solid.filter((t) => netSpeed(t) > Math.max(4, Math.hypot(t.box.w, t.box.h) * 0.35));
    const pool = moving.length ? moving : solid.length ? solid : inClass.filter((t) => (t.box.w * t.box.h) / area < 0.35);
    if (!pool.length) return null;
    let best: Track | null = null;
    let bestS = -Infinity;
    for (const t of pool) {
      const size = Math.min(1, Math.sqrt((t.box.w * t.box.h) / area) / 0.25); // relative size, saturating
      const motion = Math.min(1, netSpeed(t) / (diag * 0.02)); // "most-moving"
      const conf = Math.min(1, t.score / 0.5);
      const age = Math.min(1, t.hits / 15);
      const centre = 1 - Math.hypot(t.box.x + t.box.w / 2 - this.frameW / 2, t.box.y + t.box.h / 2 - this.frameH / 2) / diag;
      const s = conf * 1.2 + size * 0.8 + motion * 0.6 + age * 0.4 + centre * 0.2;
      if (s > bestS) {
        bestS = s;
        best = t;
      }
    }
    return best;
  }

  /**
   * Advance the camera. `tracks` are confirmed tracks; `predict` returns the box to frame
   * (e.g. tracker.predict for latency-compensated motion).
   */
  update(tracks: Track[], predict: (t: Track) => Box, frameW: number, frameH: number, now: number, dtMs: number): FollowFrame {
    const dt = Math.min(1 / 20, Math.max(0, dtMs / 1000));
    if (frameW !== this.frameW || frameH !== this.frameH) {
      const first = this.frameW === 0;
      this.frameW = frameW;
      this.frameH = frameH;
      if (first) {
        this.cx = { x: frameW / 2, v: 0 };
        this.cy = { x: frameH / 2, v: 0 };
        this.z = { x: 1, v: 0 };
      }
    }
    let acquired = false;
    let status: FollowStatus = "off";
    let target: Track | undefined;

    if (this.o.follow !== false && frameW > 0) {
      const wanted = this.explicitId ?? this.targetId;
      target = wanted !== null ? tracks.find((t) => t.id === wanted) : undefined;
      if (target) {
        this.missingSince = null;
        if (this.targetId !== target.id) acquired = true;
        this.targetId = target.id;
        status = "locked";
      } else if (this.targetId !== null || this.explicitId !== null) {
        this.missingSince ??= now;
        if (now - this.missingSince > this.o.lostMs) {
          // lost for too long: drop explicit lock and re-acquire
          this.explicitId = null;
          this.targetId = null;
          this.missingSince = null;
          if (typeof this.o.follow === "number") this.o.follow = true;
          status = "searching";
        } else {
          status = "holding";
        }
      }
      if (!target && this.targetId === null && this.explicitId === null) {
        const pick = this.choose(tracks);
        if (pick) {
          target = pick;
          this.targetId = pick.id;
          acquired = true;
          status = "locked";
        } else status = "searching";
      }
    }

    // desired camera state
    let wantCx = frameW / 2;
    let wantCy = frameH / 2;
    let wantZ = 1;
    if (target) {
      const b = predict(target);
      // lead slightly in the direction of motion
      wantCx = b.x + b.w / 2 + target.vx * 0.25;
      wantCy = b.y + b.h / 2 + target.vy * 0.25;
      const rel = Math.max(b.w / frameW, b.h / frameH, 1e-3);
      wantZ = Math.max(1, Math.min(this.o.maxZoom, this.o.fill / rel));
    } else if (status === "holding") {
      wantCx = this.cx.x;
      wantCy = this.cy.x;
      wantZ = this.z.x;
    }

    // dead zone (relative to the current crop)
    const cropW = frameW / this.z.x;
    const cropH = frameH / this.z.x;
    const dz = (e: number, size: number) => {
      const lim = this.o.deadZone * size;
      return Math.abs(e) <= lim ? 0 : e - Math.sign(e) * lim;
    };
    const tx = this.cx.x + (target ? dz(wantCx - this.cx.x, cropW) : wantCx - this.cx.x);
    const ty = this.cy.x + (target ? dz(wantCy - this.cy.x, cropH) : wantCy - this.cy.x);
    const tz = Math.abs(wantZ - this.z.x) < 0.04 ? this.z.x : wantZ;

    stepSpring(this.cx, tx, this.o.omegaPos, dt);
    stepSpring(this.cy, ty, this.o.omegaPos, dt);
    stepSpring(this.z, tz, this.o.omegaZoom, dt);
    this.z.x = Math.max(1, Math.min(this.o.maxZoom, this.z.x));

    // clamp crop inside the frame
    const w = frameW / this.z.x;
    const h = frameH / this.z.x;
    const clampC = (c: Spring, half: number, max: number) => {
      const lo = half;
      const hi = max - half;
      if (c.x < lo) {
        c.x = lo;
        c.v = Math.max(0, c.v);
      } else if (c.x > hi) {
        c.x = hi;
        c.v = Math.min(0, c.v);
      }
    };
    clampC(this.cx, w / 2, frameW);
    clampC(this.cy, h / 2, frameH);

    return {
      crop: { x: this.cx.x - w / 2, y: this.cy.x - h / 2, w, h },
      zoom: this.z.x,
      status,
      targetId: this.targetId,
      acquired,
    };
  }
}
