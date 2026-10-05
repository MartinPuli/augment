"use client";

import { motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { duration, ease, haptic, spring } from "@/components/ui/motion";
import type { Activity, Mood } from "@/lib/store";

/**
 * Polty — the GHOST poltergeist. A ghost that moves real things.
 *
 * Look: a vinyl-toy ghost lit like a 3D render, built only from SVG gradients (no blur filters, so
 * nothing expensive re-renders per frame): a warm key light top-left rolling off into periwinkle
 * shade bottom-right, a mint rim light on the shadow side, painted cloth folds in the skirt, a faint
 * grain, a glossy specular, glossy eyes with a violet iris and two glints, and a mint "signal curl"
 * antenna that glows. Behind it sits a coloured aura; below it, a two-layer contact shadow.
 *
 * Motion: one rAF loop owns everything high-frequency (skirt, bob, squash-and-stretch, hops, arms,
 * tilt, gaze, lip-sync, ground shadow, crackle, signal rings, thought orbs) and writes attributes
 * directly. React state only changes for blinks and expressions, which motion springs.
 * Personality is driven by real state: mood (anticipation then overshoot, hops, poses), activity
 * (lean and breathe with the mic, bounce on syllables, crackle while possessing), pokes (squash,
 * giggle) and idle fidgets on a random timer. prefers-reduced-motion keeps blinks and expressions
 * and drops hops, bounces and wobble (PoltyStage sets MotionConfig for the motion springs).
 */

export interface PoltyProps {
  mood: Mood;
  activity: Activity;
  /** 0..1 speech output level (lip-sync), read every frame. */
  speechLevel: () => number;
  /** 0..1 microphone level while listening. */
  micLevel: () => number;
  /** Gaze direction in [-1, 1] x [-1, 1], read every frame. */
  gaze: () => { x: number; y: number };
  size?: number;
  className?: string;
  onClick?: () => void;
  /** Horizontal velocity hint for cloth sway (-1..1). */
  sway?: () => number;
}

interface Expr {
  upper: number; // 0..1 upper lid closed
  lower: number; // 0..1 lower lid (smile squint)
  tilt: number; // deg; + = inner corners down (angry), - = inner up (sad)
  eyeScale: number;
  eyeScaleR?: number; // asymmetric (curious)
  mouth: "smile" | "big" | "flat" | "frown" | "o" | "smirk" | "wavy";
  blush: number;
  headTilt: number;
}

const EXPR: Record<Mood, Expr> = {
  neutral: { upper: 0.06, lower: 0, tilt: 0, eyeScale: 1, mouth: "smile", blush: 0.6, headTilt: 0 },
  happy: { upper: 0, lower: 0.5, tilt: 0, eyeScale: 1, mouth: "big", blush: 1, headTilt: -4 },
  curious: { upper: 0.04, lower: 0, tilt: 0, eyeScale: 1.08, eyeScaleR: 0.86, mouth: "o", blush: 0.45, headTilt: -10 },
  excited: { upper: 0, lower: 0.22, tilt: 0, eyeScale: 1.18, mouth: "big", blush: 1, headTilt: 0 },
  thinking: { upper: 0.22, lower: 0.05, tilt: 6, eyeScale: 0.96, mouth: "wavy", blush: 0.35, headTilt: 6 },
  surprised: { upper: 0, lower: 0, tilt: 0, eyeScale: 1.3, mouth: "o", blush: 0.5, headTilt: 0 },
  sad: { upper: 0.3, lower: 0, tilt: -14, eyeScale: 0.95, mouth: "frown", blush: 0.2, headTilt: 6 },
  determined: { upper: 0.34, lower: 0.08, tilt: 16, eyeScale: 1, mouth: "flat", blush: 0.3, headTilt: 0 },
  mischievous: { upper: 0.42, lower: 0.18, tilt: 4, eyeScale: 1, mouth: "smirk", blush: 0.7, headTilt: -7 },
  proud: { upper: 0.18, lower: 0.38, tilt: 0, eyeScale: 1, mouth: "big", blush: 0.8, headTilt: -5 },
  sleepy: { upper: 0.66, lower: 0.05, tilt: -4, eyeScale: 1, mouth: "o", blush: 0.35, headTilt: 8 },
};

/** Body language per mood: arm raise (deg, + = up), droop toward the floor, bob pace, little hops. */
interface Pose {
  arms: number;
  armsR?: number; // right arm, when the pose is asymmetric
  wave?: number; // arm flap amplitude, deg
  sink: number; // + = droops lower
  pace: number; // bob speed multiplier
  hop?: { h: number; every: [number, number] }; // hop height and gap range (s)
}

const POSE: Record<Mood, Pose> = {
  neutral: { arms: 0, sink: 0, pace: 1 },
  happy: { arms: 26, wave: 20, sink: -1, pace: 1.25, hop: { h: 9, every: [1, 1.9] } },
  curious: { arms: 6, armsR: 30, sink: 0, pace: 1.05 },
  excited: { arms: 52, wave: 30, sink: -2, pace: 1.5, hop: { h: 14, every: [0.42, 0.75] } },
  thinking: { arms: -4, armsR: 58, sink: 0, pace: 0.8 },
  surprised: { arms: 78, sink: -4, pace: 1.3 },
  sad: { arms: -18, sink: 8, pace: 0.6 },
  determined: { arms: 16, sink: -1, pace: 1.1 },
  mischievous: { arms: 4, armsR: 24, wave: 7, sink: 0, pace: 1.1 },
  proud: { arms: 40, sink: -3, pace: 1, hop: { h: 7, every: [2.2, 4] } },
  sleepy: { arms: -24, sink: 9, pace: 0.45 },
};

/** Mood-change kick: squash impulse (+ = pop up, - = slump), wiggle (deg/s), hop height. */
const MOOD_KICK: Partial<Record<Mood, { squash: number; wiggle?: number; hop?: number }>> = {
  neutral: { squash: 0.7 },
  happy: { squash: 2, hop: 8 },
  excited: { squash: 2.6, wiggle: 50, hop: 13 },
  surprised: { squash: 3.4, hop: 16 },
  proud: { squash: 1.8, hop: 6 },
  curious: { squash: 1, wiggle: 40 },
  mischievous: { squash: 0.7, wiggle: 55 },
  determined: { squash: 1.5 },
  thinking: { squash: 0.7 },
  sad: { squash: -1.7 },
  sleepy: { squash: -1 },
};

const MOUTHS: Record<Expr["mouth"], string> = {
  smile: "M90 127 Q100 136 110 127",
  big: "M87 124 Q100 143 113 124 Q100 131 87 124 Z",
  flat: "M91 129 L109 129",
  frown: "M90 133 Q100 124 110 133",
  o: "M100 124 m-4.5 4.5 a4.5 5.5 0 1 0 9 0 a4.5 5.5 0 1 0 -9 0",
  smirk: "M91 129 Q103 133 111 123",
  wavy: "M90 129 Q95 125 100 129 T110 129",
};

// Aura colours by activity, tuned to read over light glass and footage.
const GLOW: Record<Activity, string> = {
  idle: "#5eead4",
  listening: "#2dd4bf",
  thinking: "#a78bfa",
  speaking: "#9f8cff",
  acting: "#14e0c4",
};

// Palette: warm key light, periwinkle shade, mint accents. Never pure black or grey.
const INK = "#24123a"; // mouth line, deep plum-indigo
const MOUTH_IN = "#4a1648";
const TONGUE = "#ff6f91";
const MINT_DEEP = "#0e8f80";
const CURL = "M100 24 C98 10 104 -2 115 -3 C126 -4 131 7 126 14 C122 19 113 18 114 11";
const CURL_HI = "M99.4 18 C98.6 8 104.5 -0.4 113 -1.3";
/** Glossy specular "window" on the head, following its top-left contour. */
const GLOSS = "M36 76 C34 50 52 28 80 25.5 C85 25 86.5 29 82 30.6 C62 37 50 51 45.8 72 C44.8 78.5 36.6 80.6 36 76 Z";

const EYE_L = { cx: 76, cy: 98 };
const EYE_R = { cx: 124, cy: 98 };
const RX = 13;
const RY = 17.5;
/** Arm shoulder pivots (left, right). */
const SH_L = { x: 41, y: 122 };
const SH_R = { x: 159, y: 122 };
const GRAVITY = 1900; // units/s², for hops
const FIDGETS = ["hop", "wiggle", "glance", "glance", "wave", "boing", "blink2", "shimmy", "hop"] as const;

type SpringState = { x: number; v: number };
type Impulse = { at: number; squash: number; wiggle: number; hop: number; tilt: number; curl: number };

/** Advance a damped spring toward `target` by dt seconds (semi-implicit Euler). */
function stepTo(sp: SpringState, target: number, k: number, c: number, dt: number) {
  sp.v += (k * (target - sp.x) - c * sp.v) * dt;
  sp.x += sp.v * dt;
}

/** Queue a spring impulse, applied by the frame loop `delay` ms from now (anticipation, then pop). */
function enqueue(q: Impulse[], i: Partial<Omit<Impulse, "at">>, delay = 0) {
  q.push({ at: performance.now() + delay, squash: 0, wiggle: 0, hop: 0, tilt: 0, curl: 0, ...i });
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

interface Cloth {
  body: string;
  valley: string;
  ridge: string;
}

/**
 * The body outline (head, softly swelling flanks, five rippling tails) plus the centre-lines of the
 * skirt's painted folds: a shaded valley rising from each notch and a lit ridge down each tail.
 */
function cloth(out: Cloth, t: number, sway: number, breathe: number) {
  const w = 71 + breathe * 1.6;
  const L = 100 - w;
  const R = 100 + w;
  const top = 20 - breathe * 1.3;
  const shoulder = 94;
  const hem = 170;
  const s = sway * 8;
  const fR = R + 3 + s;
  const fL = L - 3 + s;
  let d = `M${r1(L)} ${shoulder} C${r1(L)} ${r1(top + 27)} 55 ${r1(top)} 100 ${r1(top)} C145 ${r1(top)} ${r1(R)} ${r1(top + 27)} ${r1(R)} ${shoulder}`;
  d += ` C${r1(R + 1.5)} 126 ${r1(R + 4 + s * 0.6)} 150 ${r1(fR)} ${hem}`;
  let valley = "";
  let ridge = "";
  const n = 5;
  const span = fR - fL;
  for (let i = 0; i < n; i++) {
    const x0 = fR - (span * i) / n;
    const x1 = fR - (span * (i + 1)) / n;
    const phase = t * 3.1 + i * 1.25;
    const tip = hem + 18 + Math.sin(phase) * 6 + (i % 2 === 0 ? 4 : 0);
    const notch = i === n - 1 ? hem : hem - 2 + Math.sin(phase + 1.7) * 3;
    const mid = (x0 + x1) / 2 + Math.sin(phase * 0.7) * 2.5 + sway * 4;
    d += ` C${r1(x0 - 3)} ${r1(tip - 4)} ${r1(mid + 6)} ${r1(tip + 2)} ${r1(mid)} ${r1(tip)}`;
    d += ` C${r1(mid - 6)} ${r1(tip - 2)} ${r1(x1 + 3)} ${r1(notch + 6)} ${r1(x1)} ${r1(notch)}`;
    if (i < n - 1) valley += `M${r1(x1)} ${r1(notch + 8)} Q${r1(x1 - 1.5)} ${r1(notch - 8)} ${r1(x1 + sway * 3)} ${r1(notch - 26)}`;
    ridge += `M${r1(mid)} ${r1(tip - 7)} Q${r1(mid - 1)} ${r1(hem - 6)} ${r1(mid + sway * 2)} ${r1(hem - 20)}`;
  }
  d += ` C${r1(L - 4 + s * 0.6)} 150 ${r1(L - 1.5)} 126 ${r1(L)} ${shoulder} Z`;
  out.body = d;
  out.valley = valley;
  out.ridge = ridge;
  return out;
}

const REST = cloth({ body: "", valley: "", ridge: "" }, 0.4, 0, 0.5);

/** Two little lightning forks out of the antenna tip (acting/possessing). */
function zap(cx: number, cy: number) {
  let d = "";
  for (let j = 0; j < 2; j++) {
    const ang = -Math.PI / 2 + (j ? 0.5 : -0.9) + (Math.random() - 0.5) * 1.2;
    let x = cx + Math.cos(ang) * 9;
    let y = cy + Math.sin(ang) * 9;
    d += `M${r1(x)} ${r1(y)}`;
    for (let s = 0; s < 3; s++) {
      const len = 5 + Math.random() * 4;
      const a = ang + (s % 2 ? 0.9 : -0.9) * (0.5 + Math.random() * 0.5);
      x += Math.cos(a) * len;
      y += Math.sin(a) * len;
      d += `L${r1(x)} ${r1(y)}`;
    }
  }
  return d;
}

export function Polty({ mood, activity, speechLevel, micLevel, gaze, size = 160, className, onClick, sway }: PoltyProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const id = (name: string) => `${uid}-${name}`;
  const url = (name: string) => `url(#${uid}-${name})`;

  const rigRef = useRef<SVGGElement>(null);
  const bodyRef = useRef<SVGPathElement>(null);
  const valleyRef = useRef<SVGGElement>(null);
  const ridgeRef = useRef<SVGGElement>(null);
  const armLRef = useRef<SVGGElement>(null);
  const armRRef = useRef<SVGGElement>(null);
  const eyesRef = useRef<SVGGElement>(null);
  const irisRefs = useRef<(SVGGElement | null)[]>([]);
  const glintRefs = useRef<(SVGGElement | null)[]>([]);
  const mouthOpenRef = useRef<SVGGElement>(null);
  const mouthClosedRef = useRef<SVGGElement>(null);
  const auraRef = useRef<SVGCircleElement>(null);
  const poolRef = useRef<SVGEllipseElement>(null);
  const umbraRef = useRef<SVGEllipseElement>(null);
  const penumbraRef = useRef<SVGEllipseElement>(null);
  const curlRef = useRef<SVGGElement>(null);
  const curlGlowRef = useRef<SVGCircleElement>(null);
  const ringRefs = useRef<(SVGPathElement | null)[]>([]);
  const crackleRef = useRef<SVGGElement>(null);
  const thinkRef = useRef<SVGGElement>(null);
  const dotRefs = useRef<(SVGCircleElement | null)[]>([]);

  const [blink, setBlink] = useState(false);
  const [noticed, setNoticed] = useState(false);
  const [giggle, setGiggle] = useState(false);
  const reduce = useReducedMotion() ?? false;
  /** Spring impulses waiting to be applied by the frame loop. */
  const queue = useRef<Impulse[]>([]);
  /** Timed secondary motions (ms timestamps): glance start, wave/shimmy/giggle end. */
  const fx = useRef({ glance: 0, wave: 0, shimmy: 0, giggle: 0 });
  const timers = useRef<{ notice?: ReturnType<typeof setTimeout>; giggle?: ReturnType<typeof setTimeout> }>({});
  /** Latest props for timers and the frame loop (assigned after render, never during it). */
  const stateRef = useRef({ activity, mood, reduce });
  useEffect(() => {
    stateRef.current = { activity, mood, reduce };
  });
  const e = giggle ? EXPR.happy : (EXPR[mood] ?? EXPR.neutral);

  // Blink on a natural, irregular rhythm (sometimes a double-blink).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const blinkOnce = (at: number) => {
      setTimeout(() => setBlink(true), at);
      setTimeout(() => setBlink(false), at + 110);
    };
    const loop = () => {
      timer = setTimeout(
        () => {
          blinkOnce(0);
          if (Math.random() < 0.22) blinkOnce(240);
          loop();
        },
        2000 + Math.random() * 3600,
      );
    };
    loop();
    return () => clearTimeout(timer);
  }, []);

  // Mood change: anticipation (a dip the other way), then the pop with overshoot, and a reset blink.
  const prevMood = useRef(mood);
  useEffect(() => {
    const was = prevMood.current;
    if (was === mood) return;
    prevMood.current = mood;
    const k = MOOD_KICK[mood] ?? { squash: 0.6 };
    const dTilt = (EXPR[mood]?.headTilt ?? 0) - (EXPR[was]?.headTilt ?? 0);
    enqueue(queue.current, { squash: -k.squash * 0.45, tilt: -dTilt * 6 });
    enqueue(queue.current, { squash: k.squash, wiggle: k.wiggle ?? 0, hop: k.hop ?? 0 }, 90);
    const t1 = setTimeout(() => setBlink(true), 0);
    const t2 = setTimeout(() => setBlink(false), 100);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [mood]);

  // Activity change: perk up to listen, spark into a device, settle in to think.
  const prevActivity = useRef(activity);
  useEffect(() => {
    if (prevActivity.current === activity) return;
    prevActivity.current = activity;
    const q = queue.current;
    if (activity === "listening") {
      enqueue(q, { squash: -0.6 });
      enqueue(q, { squash: 1.2, hop: 4 }, 80);
    } else if (activity === "acting") {
      enqueue(q, { squash: -0.8 });
      enqueue(q, { squash: 1.6, curl: -420 }, 90);
    } else if (activity === "thinking") enqueue(q, { squash: 0.6, tilt: -30 });
    else if (activity === "speaking") enqueue(q, { squash: 0.8, curl: -200 });
  }, [activity]);

  // Idle fidgets every few seconds, so Polty never looks frozen.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const loop = () => {
      timer = setTimeout(
        () => {
          const { activity: act, mood: m, reduce: calm } = stateRef.current;
          if (act === "idle" && m !== "sleepy" && m !== "sad" && !document.hidden) {
            const pick = FIDGETS[Math.floor(Math.random() * FIDGETS.length)];
            const now = performance.now();
            const q = queue.current;
            if (pick === "glance") fx.current.glance = now;
            else if (pick === "blink2") {
              setBlink(true);
              setTimeout(() => setBlink(false), 90);
              setTimeout(() => setBlink(true), 200);
              setTimeout(() => setBlink(false), 290);
            } else if (!calm) {
              if (pick === "hop") {
                enqueue(q, { squash: -1.1 });
                enqueue(q, { squash: 0.9, hop: 7 + Math.random() * 5 }, 90);
              } else if (pick === "wiggle") enqueue(q, { wiggle: (Math.random() < 0.5 ? -1 : 1) * 75 });
              else if (pick === "wave") fx.current.wave = now + 1500;
              else if (pick === "boing") enqueue(q, { curl: (Math.random() < 0.5 ? -1 : 1) * 560, squash: 0.6 });
              else if (pick === "shimmy") fx.current.shimmy = now + 750;
            }
          }
          loop();
        },
        2600 + Math.random() * 4400,
      );
    };
    loop();
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const t = timers.current;
    return () => {
      clearTimeout(t.notice);
      clearTimeout(t.giggle);
    };
  }, []);

  // Poke: squish, giggle-wobble with a happy squint, then bounce back up.
  const handleClick = () => {
    haptic(10);
    setGiggle(true);
    clearTimeout(timers.current.giggle);
    timers.current.giggle = setTimeout(() => setGiggle(false), 750);
    if (!reduce) {
      fx.current.giggle = performance.now() + 750;
      enqueue(queue.current, { squash: -2.8, wiggle: 40 });
      enqueue(queue.current, { squash: 1.2, hop: 9, curl: 380 }, 120);
    }
    onClick?.();
  };

  const handleEnter = () => {
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    setNoticed(true);
    if (!reduce) enqueue(queue.current, { squash: 0.9, curl: -180 });
    clearTimeout(timers.current.notice);
    timers.current.notice = setTimeout(() => setNoticed(false), 700);
  };

  // Per-frame animation.
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    let last = t0;
    const out: Cloth = { body: "", valley: "", ridge: "" };
    const look = { x: 0, y: 0 };
    const squash = { x: 0, v: 0 }; // + = stretch tall, - = squash wide
    const wiggle = { x: 0, v: 0 }; // deg
    const tilt = { x: 0, v: 0 }; // deg
    const sink = { x: 0, v: 0 };
    const armL = { x: 0, v: 0 };
    const armR = { x: 0, v: 0 };
    const curl = { x: 0, v: 0 };
    const hop = { y: 0, v: 0, air: false };
    let swayS = 0;
    let phase = 0;
    let skirtT = 0;
    let prevY = 0;
    let prevVel = 0;
    let sFast = 0;
    let sSlow = 0;
    let armed = true;
    let lastSyl = 0;
    let nextHop = 0;
    let launchAt = 0;
    let launchH = 0;
    let landPulse = 0;
    let think = 0;
    let ring = 0;
    let crackleAt = 0;
    let mouthOpen = false;

    const tick = (now: number) => {
      const dt = Math.min(1 / 30, Math.max(0.001, (now - last) / 1000));
      last = now;
      const t = (now - t0) / 1000;
      const st = stateRef.current;
      const act = st.activity;
      const calm = st.reduce;
      const pose = POSE[st.mood] ?? POSE.neutral;
      const ex = EXPR[st.mood] ?? EXPR.neutral;
      const speak = speechLevel();
      const mic = micLevel();
      const target = gaze();
      const f = fx.current;

      // 1. Scheduled impulses (mood changes, pokes, fidgets). Dropped under reduced motion.
      const q = queue.current;
      for (let i = q.length - 1; i >= 0; i--) {
        const k = q[i];
        if (k.at > now) continue;
        q.splice(i, 1);
        if (calm) continue;
        squash.v += k.squash;
        wiggle.v += k.wiggle;
        tilt.v += k.tilt;
        curl.v += k.curl;
        if (k.hop > 0) {
          hop.v = Math.max(hop.v, Math.sqrt(2 * GRAVITY * k.hop));
          hop.air = true;
        }
      }

      // 2. Gaze: the cursor (or what the stage points at), a glance fidget, up-right while thinking.
      const gp = f.glance ? (now - f.glance) / 1600 : 1;
      let gx = target.x + (gp < 1 ? Math.sin(gp * Math.PI * 2) * 0.95 : 0);
      let gy = target.y;
      if (act === "thinking") {
        gx = 0.62;
        gy = -0.85;
      }
      const follow = 1 - Math.exp(-dt * (act === "listening" ? 12 : 9));
      look.x += (gx - look.x) * follow;
      look.y += (gy - look.y) * follow;
      swayS += ((sway?.() ?? 0) - swayS) * (1 - Math.exp(-dt * 5));

      // 3. Voice envelope: a fast and a slow follower; a jump between them is a syllable.
      sFast += (speak - sFast) * (1 - Math.exp(-dt * 28));
      sSlow += (speak - sSlow) * (1 - Math.exp(-dt * 3.5));
      if (act === "speaking" && !calm) {
        const onset = sFast - sSlow;
        if (armed && onset > 0.08 && sFast > 0.18 && now - lastSyl > 110) {
          squash.v += 0.7 + sFast * 1.5;
          wiggle.v += (Math.random() - 0.5) * 40;
          curl.v -= 120 + sFast * 160;
          armed = false;
          lastSyl = now;
        } else if (onset < 0.025) armed = true;
      }

      // 4. Hops: happy/excited/proud hop on their own; crouch first (anticipation), then launch.
      if (!calm && pose.hop && act !== "listening" && !hop.air && !launchAt && now > nextHop) {
        if (nextHop) {
          squash.v -= 1.1;
          launchAt = now + 90;
          launchH = pose.hop.h * (0.8 + Math.random() * 0.4);
        }
        nextHop = now + (pose.hop.every[0] + Math.random() * (pose.hop.every[1] - pose.hop.every[0])) * 1000;
      }
      if (launchAt && now >= launchAt) {
        launchAt = 0;
        if (!calm) {
          squash.v += 0.9;
          hop.v = Math.sqrt(2 * GRAVITY * launchH);
          hop.air = true;
        }
      }
      if (hop.air) {
        hop.v -= GRAVITY * dt;
        hop.y += hop.v * dt;
        if (hop.y <= 0) {
          // Landing: squash proportional to the impact, and the shadow slaps wide.
          const impact = -hop.v;
          hop.y = 0;
          hop.v = 0;
          hop.air = false;
          squash.v -= Math.min(3.6, impact * 0.014);
          landPulse = Math.min(1, impact / 220);
        }
      }
      landPulse *= Math.exp(-dt * 8);

      // 5. Springs. Squash is jelly-bouncy, wiggle rings longer; tilt overshoots (spring.bouncy).
      if (calm) squash.x = squash.v = wiggle.x = wiggle.v = curl.x = curl.v = 0;
      stepTo(squash, 0, 300, 11, dt);
      stepTo(wiggle, 0, 150, 6.5, dt);
      stepTo(curl, 0, 180, 7, dt);
      let tiltT = ex.headTilt + look.x * 2.5;
      if (act === "thinking") tiltT = 7 + Math.sin(t * 0.9) * 4;
      else if (act === "listening") tiltT += look.x * 7; // lean toward the dock / speaker
      if (st.mood === "sleepy") tiltT += Math.sin(t * 0.55) * 3;
      const ts = calm ? spring.gentle : spring.bouncy;
      stepTo(tilt, tiltT, ts.stiffness, ts.damping, dt);
      stepTo(sink, calm ? pose.sink * 0.5 : pose.sink, spring.gentle.stiffness, spring.gentle.damping, dt);

      // 6. Bob, with squash at the bottom and stretch on the way up. Phase integrates the pace,
      //    so a mood change speeds it up without a jump.
      phase += dt * 2.1 * pose.pace * (calm ? 0.45 : 1);
      skirtT += dt * (calm ? 0.4 : 0.8 + pose.pace * 0.2 + (act === "speaking" ? sFast * 0.8 : 0));
      const amp = calm ? 1.5 : 6;
      const bobY = Math.sin(phase) * amp;
      const bobStretch = calm ? 0 : -Math.sin(phase) * 0.035 - Math.cos(phase) * 0.02;
      const airStretch = hop.air ? Math.min(0.12, Math.abs(hop.v) * 0.0005) : 0;
      const voice = act === "speaking" ? sFast : 0;
      const swell = act === "listening" ? mic * 0.05 : 0; // breathes with your voice
      const stretch = clamp(squash.x + bobStretch + airStretch + voice * 0.05, -0.2, 0.22);
      const sy = 1 + stretch + swell;
      const sx = 1 - stretch * 0.65 + swell;

      // 7. Body placement and rotation (tilt + wiggle + giggle/shimmy wobble).
      const y = bobY + sink.x - hop.y - voice * 4 - (calm ? 0 : squash.x * 14);
      const vel = (y - prevY) / dt;
      prevY = y;
      const dVel = clamp(vel - prevVel, -260, 260);
      prevVel = vel;
      const gig = f.giggle > now ? (f.giggle - now) / 750 : 0;
      const shim = f.shimmy > now ? (f.shimmy - now) / 750 : 0;
      const wob = calm ? 0 : Math.sin(t * 42) * 7 * gig + Math.sin(t * 31) * 6 * shim;
      const leanX = (act === "listening" ? look.x * 5 : 0) + (calm ? 0 : Math.sin(t * 50) * 1.6 * gig);
      const rot = tilt.x + wiggle.x * 0.14 + wob;
      rigRef.current?.setAttribute(
        "transform",
        `translate(${r2(leanX)} ${r2(y)}) rotate(${r2(rot)} 100 150) translate(100 184) scale(${r3(sx)} ${r3(sy)}) translate(-100 -184)`,
      );

      // 8. Arms: pose + flaps + voice gestures, on a spring, thrown by the body's acceleration
      //    (follow-through: they flop on landings and lag on launches).
      let aL = pose.arms;
      let aR = pose.armsR ?? pose.arms;
      if (pose.wave && !calm) {
        aL += Math.sin(t * 10) * pose.wave;
        aR += Math.sin(t * 10 + 2.4) * pose.wave;
      }
      if (hop.air) {
        aL += 40;
        aR += 40;
      }
      if (act === "speaking") {
        aL += sFast * 34 * (0.5 + 0.5 * Math.sin(t * 4.2));
        aR += sFast * 34 * (0.5 + 0.5 * Math.sin(t * 4.2 + 2.1));
      } else if (act === "listening") {
        aL += 8 + mic * 20;
        aR += 8 + mic * 20;
      } else if (act === "acting") {
        // Reaching into the device, trembling with the effort.
        aL = 80 + (calm ? 0 : Math.sin(t * 33) * 5);
        aR = 66 + (calm ? 0 : Math.sin(t * 29 + 1) * 5);
      }
      if (f.wave > now) aR = 122 + Math.sin(t * 15) * 26;
      if (gig) {
        aL += 30;
        aR += 30;
      }
      if (!calm) {
        armL.v += dVel * 0.7;
        armR.v += dVel * 0.7;
      }
      stepTo(armL, aL, 220, 13, dt);
      stepTo(armR, aR, 220, 13, dt);
      armLRef.current?.setAttribute("transform", `rotate(${r2(armL.x)} ${SH_L.x} ${SH_L.y})`);
      armRRef.current?.setAttribute("transform", `rotate(${r2(-armR.x)} ${SH_R.x} ${SH_R.y})`);

      // 9. Cloth: the skirt ripples and breathes (deeper with the mic while listening).
      const breathe = 0.5 + Math.sin(t * (calm ? 0.7 : 1.7)) * 0.5 + (act === "listening" ? mic * 2.4 : 0);
      cloth(out, skirtT, swayS, breathe);
      bodyRef.current?.setAttribute("d", out.body);
      if (valleyRef.current) for (const c of valleyRef.current.children) c.setAttribute("d", out.valley);
      if (ridgeRef.current) for (const c of ridgeRef.current.children) c.setAttribute("d", out.ridge);

      // 10. Eyes: the eye moves, the iris moves further, the glints lag (reads as a glossy dome).
      eyesRef.current?.setAttribute("transform", `translate(${r2(look.x * 6)} ${r2(look.y * 4.5)})`);
      const irisT = `translate(${r2(look.x * 3.4)} ${r2(look.y * 3.8)})`;
      const glintT = `translate(${r2(-look.x * 1.4)} ${r2(-look.y * 1.1)})`;
      for (const g of irisRefs.current) g?.setAttribute("transform", irisT);
      for (const g of glintRefs.current) g?.setAttribute("transform", glintT);

      // 11. Antenna: idle sway + spring (boings, syllables), trembling while possessing.
      const curlRot = Math.sin(t * 1.6) * 4 + curl.x - wiggle.x * 0.1 + (act === "acting" && !calm ? Math.sin(t * 38) * 3 : 0);
      curlRef.current?.setAttribute("transform", `rotate(${r2(curlRot)} 100 24)`);
      const glowA =
        act === "acting"
          ? 0.8 + Math.sin(t * 23) * Math.sin(t * 37) * 0.2
          : act === "speaking"
            ? 0.45 + sFast * 0.5
            : act === "listening"
              ? 0.5 + mic * 0.5
              : 0.38 + Math.sin(t * 2.2) * 0.12;
      curlGlowRef.current?.setAttribute("opacity", `${r3(glowA)}`);

      // 12. Possessing: signal rings rise off the antenna, and it crackles.
      const ringWas = ring;
      ring += ((act === "acting" ? 1 : 0) - ring) * (1 - Math.exp(-dt * 6));
      if (ring > 0.005 || ringWas > 0.005) {
        for (let i = 0; i < 3; i++) {
          // Reduced motion: the rings hold still and only pulse.
          const p = calm ? (i + 1) / 4 : (t * 0.9 + i / 3) % 1;
          const a = calm ? 0.55 + Math.sin(t * 2 + i) * 0.3 : Math.sin(p * Math.PI) * 0.95;
          const el = ringRefs.current[i];
          el?.setAttribute("transform", `translate(114 ${r1(-4 - p * 20)}) scale(${r3(0.55 + p * 1.25)})`);
          el?.setAttribute("opacity", `${r3(ring > 0.005 ? ring * a : 0)}`);
        }
      }
      if (crackleRef.current) {
        if (ring > 0.5 && !calm && now > crackleAt) {
          crackleAt = now + 50 + Math.random() * 90;
          const d = zap(118, 2);
          for (const c of crackleRef.current.children) c.setAttribute("d", d);
          crackleRef.current.setAttribute("opacity", Math.random() < 0.25 ? "0" : `${r2(0.6 + Math.random() * 0.4)}`);
        } else if (ring <= 0.5 && ringWas > 0.5) crackleRef.current.setAttribute("opacity", "0");
      }

      // 13. Thinking: three little thought-orbs orbit the antenna (front ones bigger and brighter).
      const thinkWas = think;
      think += ((act === "thinking" ? 1 : 0) - think) * (1 - Math.exp(-dt * 5));
      if (think > 0.005 || thinkWas > 0.005) {
        thinkRef.current?.setAttribute("opacity", `${r3(think > 0.005 ? think : 0)}`);
        for (let i = 0; i < 3; i++) {
          const a = t * (calm ? 0.8 : 2.6) + (i * Math.PI * 2) / 3;
          const depth = (Math.sin(a) + 1) / 2;
          const dot = dotRefs.current[i];
          dot?.setAttribute("cx", `${r1(112 + Math.cos(a) * 34)}`);
          dot?.setAttribute("cy", `${r1(4 + Math.sin(a) * 8)}`);
          dot?.setAttribute("r", `${r2(3.2 + depth * 2.2 - i * 0.3)}`);
          dot?.setAttribute("opacity", `${r2(0.5 + depth * 0.5)}`);
        }
      }

      // 14. Ground shadow: low = tight, dark and crisp; high = wide, light and soft. Squash and
      //     landings spread it.
      const h = clamp((7 - y) / 24, 0, 1);
      const spread = sx * (1 + landPulse * 0.22);
      const cx = 100 + leanX + rot * 0.5;
      umbraRef.current?.setAttribute("transform", `translate(${r1(cx)} 222) scale(${r2(30 * spread * (1 + 0.32 * h))} ${r2(4.8 * (1 + 0.25 * h))})`);
      umbraRef.current?.setAttribute("opacity", `${r3(0.55 - 0.42 * h + landPulse * 0.12)}`);
      penumbraRef.current?.setAttribute("transform", `translate(${r1(cx)} 222) scale(${r2(44 * spread * (1 + 0.7 * h))} ${r2(8.5 * (1 + 0.6 * h))})`);
      penumbraRef.current?.setAttribute("opacity", `${r3(0.2 + 0.06 * h)}`);

      // 15. Lip-sync: the open mouth (with tongue) follows the voice envelope.
      const open = act === "speaking" || speak > 0.04 ? Math.min(1, sFast * 1.5) : 0;
      const isOpen = open > 0.06;
      if (isOpen) mouthOpenRef.current?.setAttribute("transform", `translate(100 130) scale(${r2(6 + open * 3.5)} ${r2(1.5 + open * 9)})`);
      if (isOpen !== mouthOpen) {
        mouthOpen = isOpen;
        mouthOpenRef.current?.setAttribute("opacity", isOpen ? "1" : "0");
        mouthClosedRef.current?.setAttribute("opacity", isOpen ? "0" : "1");
      }

      // 16. Aura and its pool of light on the floor breathe with state.
      const pulse =
        act === "listening"
          ? 0.55 + mic * 0.45
          : act === "thinking"
            ? 0.5 + Math.sin(t * 4) * 0.14
            : act === "speaking"
              ? 0.45 + sFast * 0.4
              : act === "acting"
                ? 0.62 + Math.sin(t * 9) * 0.1
                : 0.38 + Math.sin(t * 1.3) * 0.06;
      auraRef.current?.setAttribute("opacity", `${r3(pulse)}`);
      poolRef.current?.setAttribute("opacity", `${r3(pulse * (0.55 - 0.25 * h))}`);

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [speechLevel, micLevel, gaze, sway]);

  const eye = (side: "L" | "R") => {
    const c = side === "L" ? EYE_L : EYE_R;
    const dir = side === "L" ? 1 : -1;
    const i = side === "L" ? 0 : 1;
    const boost = 1 + (noticed ? 0.1 : 0) + (activity === "listening" ? 0.06 : 0);
    const scale = (side === "R" && e.eyeScaleR ? e.eyeScaleR : e.eyeScale) * boost;
    const ry = RY * scale;
    return (
      <motion.g
        key={side}
        style={{ originX: 0.5, originY: 0.5 }}
        animate={{ scaleY: blink ? 0.08 : 1, scale }}
        transition={{ scaleY: { duration: blink ? 0.06 : 0.09 }, scale: spring.bouncy }}
      >
        <clipPath id={id(`eye-${side}`)}>
          <ellipse cx={c.cx} cy={c.cy} rx={RX} ry={RY} />
        </clipPath>
        <ellipse cx={c.cx} cy={c.cy} rx={RX} ry={RY} fill={url("eye")} />
        <g clipPath={url(`eye-${side}`)}>
          {/* iris (violet ring around the pupil) and the mint bounce light in the bottom of the eye */}
          <g ref={(el) => void (irisRefs.current[i] = el)}>
            <circle cx={c.cx} cy={c.cy + 2.5} r={10} fill={url("iris")} />
          </g>
          <ellipse cx={c.cx} cy={c.cy + RY - 1} rx={RX * 0.85} ry={7.5} fill={url("eyebounce")} />
        </g>
        {/* glints: a big key-light one top-left and a small fill one bottom-right */}
        <g ref={(el) => void (glintRefs.current[i] = el)}>
          <ellipse cx={c.cx - 4.2} cy={c.cy - 7} rx={4.6} ry={5} fill="#fff" />
          <circle cx={c.cx + 4.6} cy={c.cy + 5.4} r={1.9} fill="#fff" opacity={0.85} />
        </g>
        <clipPath id={id(`lid-${side}`)}>
          <ellipse cx={c.cx} cy={c.cy} rx={RX + 0.9} ry={RY + 0.9} />
        </clipPath>
        <g clipPath={url(`lid-${side}`)}>
          {/* upper lid */}
          <motion.rect
            x={c.cx - 24}
            width={48}
            height={44}
            fill={url("skin")}
            style={{ originX: 0.5, originY: 1 }}
            initial={false}
            animate={{ y: c.cy - RY - 44 + e.upper * 2 * RY, rotate: e.tilt * dir }}
            transition={spring.snappy}
          />
          {/* lower lid (smile squint) */}
          <motion.ellipse
            cx={c.cx}
            rx={20}
            ry={15}
            fill={url("skin")}
            initial={false}
            animate={{ cy: c.cy + RY + 15 - e.lower * ry * 1.45 }}
            transition={spring.snappy}
          />
        </g>
      </motion.g>
    );
  };

  const arm = (side: "L" | "R") => {
    // A chunky nub angled out-and-down from the shoulder; the frame loop rotates the group.
    const m = side === "L" ? 1 : -1;
    const cx = 100 - m * 71;
    return (
      <g ref={side === "L" ? armLRef : armRRef}>
        {/* contact shadow where the arm presses on the body */}
        <ellipse cx={cx + m * 3.5} cy={139} rx={13.5} ry={18.5} fill={url("ao")} transform={`rotate(${m * 43} ${cx + m * 3.5} 139)`} />
        <ellipse cx={cx} cy={135} rx={10.5} ry={15.5} fill={url("arm")} transform={`rotate(${m * 43} ${cx} 135)`} />
        <ellipse cx={cx - m * 1.6} cy={128.6} rx={3.4} ry={5.2} fill="#fff" opacity={0.75} transform={`rotate(${m * 43} ${cx - m * 1.6} 128.6)`} />
      </g>
    );
  };

  const glow = GLOW[activity];
  const stopT = { transition: "stop-color 400ms" };

  return (
    <svg
      viewBox="-20 -30 240 260"
      width={size}
      height={(size * 260) / 240}
      className={className}
      onClick={handleClick}
      onPointerEnter={handleEnter}
      style={{ overflow: "visible", cursor: onClick ? "pointer" : undefined }}
      role="img"
      aria-label={`Polty is ${activity}, feeling ${mood}`}
    >
      <defs>
        {/* coloured aura behind the body, tinted by activity */}
        <radialGradient id={id("aura")}>
          <stop offset="0%" stopColor={glow} stopOpacity="0.55" style={stopT} />
          <stop offset="50%" stopColor={glow} stopOpacity="0.2" style={stopT} />
          <stop offset="100%" stopColor={glow} stopOpacity="0" style={stopT} />
        </radialGradient>
        {/* contact shadow: a crisp indigo core and a soft violet penumbra (never grey) */}
        <radialGradient id={id("umbra")}>
          <stop offset="0%" stopColor="#2a1f74" />
          <stop offset="55%" stopColor="#2a1f74" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#2a1f74" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={id("penumbra")}>
          <stop offset="0%" stopColor="#4b3cc0" stopOpacity="0.9" />
          <stop offset="45%" stopColor="#4b3cc0" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#4b3cc0" stopOpacity="0" />
        </radialGradient>
        {/* skin: warm key light top-left rolling off into periwinkle shade bottom-right */}
        <radialGradient id={id("skin")} gradientUnits="userSpaceOnUse" cx="86" cy="76" r="128" fx="70" fy="52">
          <stop offset="0%" stopColor="#fffaf3" />
          <stop offset="16%" stopColor="#fcfaff" />
          <stop offset="38%" stopColor="#f6f3ff" />
          <stop offset="58%" stopColor="#ece7ff" />
          <stop offset="74%" stopColor="#dad2fc" />
          <stop offset="89%" stopColor="#bdb2f7" />
          <stop offset="100%" stopColor="#9f92f0" />
        </radialGradient>
        <linearGradient id={id("rim")} gradientUnits="userSpaceOnUse" x1="128" y1="0" x2="176" y2="0">
          <stop offset="0%" stopColor="#7af0dc" stopOpacity="0" />
          <stop offset="100%" stopColor="#7af0dc" stopOpacity="1" />
        </linearGradient>
        <linearGradient id={id("edge")} gradientUnits="userSpaceOnUse" x1="40" y1="30" x2="150" y2="160">
          <stop offset="0%" stopColor="#8f84ea" stopOpacity="0.55" />
          <stop offset="55%" stopColor="#8f84ea" stopOpacity="0.15" />
          <stop offset="100%" stopColor="#8f84ea" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={id("valley")} gradientUnits="userSpaceOnUse" x1="0" y1="140" x2="0" y2="182">
          <stop offset="0%" stopColor="#6a5bdc" stopOpacity="0" />
          <stop offset="100%" stopColor="#6a5bdc" stopOpacity="0.55" />
        </linearGradient>
        <linearGradient id={id("ridge")} gradientUnits="userSpaceOnUse" x1="0" y1="148" x2="0" y2="186">
          <stop offset="0%" stopColor="#fff" stopOpacity="0" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0.9" />
        </linearGradient>
        <radialGradient id={id("bounce")}>
          <stop offset="0%" stopColor="#5eead4" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#5eead4" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={id("ao")}>
          <stop offset="0%" stopColor="#5a4bd1" stopOpacity="0.5" />
          <stop offset="60%" stopColor="#5a4bd1" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#5a4bd1" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={id("spec")} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#fff" stopOpacity="1" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0.35" />
        </linearGradient>
        <radialGradient id={id("arm")} cx="0.36" cy="0.3" r="0.8">
          <stop offset="0%" stopColor="#fffaf2" />
          <stop offset="50%" stopColor="#f4f1ff" />
          <stop offset="100%" stopColor="#bdb3f6" />
        </radialGradient>
        {/* eyes: deep indigo, a violet iris, mint light bouncing into the bottom */}
        <linearGradient id={id("eye")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0c0922" />
          <stop offset="60%" stopColor="#1a1448" />
          <stop offset="100%" stopColor="#2c2a7c" />
        </linearGradient>
        <radialGradient id={id("iris")}>
          <stop offset="0%" stopColor="#06041a" />
          <stop offset="38%" stopColor="#06041a" />
          <stop offset="50%" stopColor="#3b2bd6" />
          <stop offset="84%" stopColor="#8d7cff" />
          <stop offset="100%" stopColor="#5a4be6" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={id("eyebounce")} cy="0.75">
          <stop offset="0%" stopColor="#6ff2dc" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#6ff2dc" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={id("cheek")}>
          <stop offset="0%" stopColor="#ff4f8e" />
          <stop offset="50%" stopColor="#ff6f9f" stopOpacity="0.6" />
          <stop offset="100%" stopColor="#ff8fb4" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={id("curl")} gradientUnits="userSpaceOnUse" x1="100" y1="26" x2="128" y2="-4">
          <stop offset="0%" stopColor="#2dd4bf" />
          <stop offset="100%" stopColor="#8ff5e4" />
        </linearGradient>
        <radialGradient id={id("curlglow")}>
          <stop offset="0%" stopColor="#2dd4bf" stopOpacity="0.9" />
          <stop offset="45%" stopColor="#2dd4bf" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#2dd4bf" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={id("orb")} cx="0.35" cy="0.3" r="0.75">
          <stop offset="0%" stopColor="#e9e3ff" />
          <stop offset="45%" stopColor="#9b7bff" />
          <stop offset="100%" stopColor="#5b21b6" />
        </radialGradient>
        {/* faint speckle grain (a vector pattern: cheap, no turbulence filter per frame) */}
        <pattern id={id("grain")} width="13" height="13" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="2" r="0.6" fill="#6b5ce0" />
          <circle cx="7.8" cy="1.2" r="0.45" fill="#fff" />
          <circle cx="4.6" cy="6.4" r="0.5" fill="#6b5ce0" />
          <circle cx="10.6" cy="5.1" r="0.55" fill="#fff" />
          <circle cx="2.4" cy="10.4" r="0.45" fill="#fff" />
          <circle cx="8.9" cy="9.7" r="0.6" fill="#6b5ce0" />
          <circle cx="12" cy="12" r="0.35" fill="#6b5ce0" />
        </pattern>
        <linearGradient id={id("fade")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fff" stopOpacity="1" />
          <stop offset="68%" stopColor="#fff" stopOpacity="1" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0.2" />
        </linearGradient>
        <mask id={id("mask")} maskUnits="userSpaceOnUse" x="-20" y="-30" width="240" height="260">
          <rect x="-20" y="-30" width="240" height="260" fill={url("fade")} />
        </mask>
        <clipPath id={id("clip")}>
          <use href={`#${id("body")}`} />
        </clipPath>
      </defs>

      {/* aura */}
      <circle ref={auraRef} cx="100" cy="108" r="114" fill={url("aura")} opacity="0.4" />
      {/* floor: a pool of the aura's light, the soft penumbra, the crisp core */}
      <ellipse ref={poolRef} cx="100" cy="224" rx="74" ry="14" fill={url("aura")} opacity="0.2" />
      <ellipse ref={penumbraRef} rx="1" ry="1" transform="translate(100 222) scale(44 8.5)" fill={url("penumbra")} opacity="0.2" />
      <ellipse ref={umbraRef} rx="1" ry="1" transform="translate(100 222) scale(30 4.8)" fill={url("umbra")} opacity="0.5" />

      <g ref={rigRef}>
        {/* signal rings (emitted while possessing a device) */}
        <g fill="none" stroke={url("curl")} strokeWidth={3.2} strokeLinecap="round">
          {[0, 1, 2].map((i) => (
            <path key={i} ref={(el) => void (ringRefs.current[i] = el)} d="M-12 2 Q0 -10 12 2" opacity="0" />
          ))}
        </g>

        {/* antenna glow, then the signal curl as a little 3D tube: shade, body, highlight */}
        <circle ref={curlGlowRef} cx="114" cy="7" r="32" fill={url("curlglow")} opacity="0.4" />
        <g ref={curlRef} fill="none" strokeLinecap="round">
          <path d={CURL} stroke={MINT_DEEP} strokeWidth={8} />
          <path d={CURL} stroke={url("curl")} strokeWidth={5.4} transform="translate(-0.5 -0.7)" />
          <path d={CURL_HI} stroke="#fff" strokeOpacity={0.9} strokeWidth={1.8} transform="translate(-1.2 -1.1)" />
        </g>
        <g ref={crackleRef} opacity="0" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path stroke="#2dd4bf" strokeOpacity={0.55} strokeWidth={4.5} />
          <path stroke="#f2fffc" strokeWidth={1.6} />
        </g>

        {/* body: base, then shading layers clipped to the silhouette, then the hem fades out */}
        <g mask={url("mask")}>
          <g fill={url("skin")}>
            <path ref={bodyRef} id={id("body")} d={REST.body} />
          </g>
          <g clipPath={url("clip")}>
            <rect x="20" y="10" width="160" height="200" fill={url("grain")} opacity="0.07" />
            {/* soft occlusion where the head rounds into the skirt, and floor bounce light */}
            <ellipse cx="100" cy="190" rx="86" ry="30" fill={url("ao")} opacity="0.35" />
            <ellipse cx="62" cy="182" rx="50" ry="22" fill={url("bounce")} />
            {/* cloth folds: stacked strokes of rising width read as soft painted bands */}
            <g ref={valleyRef} fill="none" stroke={url("valley")} strokeLinecap="round">
              <path d={REST.valley} strokeWidth={14} strokeOpacity={0.3} />
              <path d={REST.valley} strokeWidth={8} strokeOpacity={0.4} />
              <path d={REST.valley} strokeWidth={3.5} strokeOpacity={0.5} />
            </g>
            <g ref={ridgeRef} fill="none" stroke={url("ridge")} strokeLinecap="round">
              <path d={REST.ridge} strokeWidth={10} strokeOpacity={0.35} />
              <path d={REST.ridge} strokeWidth={4.5} strokeOpacity={0.55} />
            </g>
            {/* fresnel edge (definition on light backgrounds) and the mint rim light */}
            <use href={`#${id("body")}`} fill="none" stroke={url("edge")} strokeWidth={4} />
            <use href={`#${id("body")}`} fill="none" stroke={url("rim")} strokeWidth={6} />
            {/* glossy specular */}
            <path d={GLOSS} fill={url("spec")} />
            <circle cx="89" cy="30.5" r="2.6" fill="#fff" />
          </g>
        </g>

        {/* arms */}
        {arm("L")}
        {arm("R")}

        {/* cheeks, each with a tiny glossy highlight */}
        <motion.g initial={false} animate={{ opacity: e.blush }} transition={{ duration: duration.deliberate, ease: ease.standard }}>
          <ellipse cx="55" cy="121" rx="12.5" ry="8" fill={url("cheek")} />
          <ellipse cx="145" cy="121" rx="12.5" ry="8" fill={url("cheek")} />
          <circle cx="51" cy="118" r="1.5" fill="#fff" opacity="0.8" />
          <circle cx="141" cy="118" r="1.5" fill="#fff" opacity="0.8" />
        </motion.g>

        {/* eyes */}
        <g ref={eyesRef}>
          {eye("L")}
          {eye("R")}
        </g>

        {/* mouth: the expression shape (with a tongue when grinning) and the lip-sync mouth */}
        <g ref={mouthClosedRef}>
          <clipPath id={id("mouth")}>
            <use href={`#${id("mouth-path")}`} />
          </clipPath>
          <motion.path
            id={id("mouth-path")}
            d={MOUTHS[e.mouth]}
            initial={false}
            animate={{ d: MOUTHS[e.mouth] }}
            fill={e.mouth === "big" || e.mouth === "o" ? MOUTH_IN : "none"}
            stroke={INK}
            strokeWidth={3.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            transition={{ duration: duration.fast, ease: ease.move }}
          />
          <motion.ellipse
            cx="100"
            cy="135"
            rx="6.5"
            ry="4"
            fill={TONGUE}
            clipPath={url("mouth")}
            initial={false}
            animate={{ opacity: e.mouth === "big" ? 1 : 0 }}
            transition={{ duration: duration.fast }}
          />
        </g>
        <g ref={mouthOpenRef} opacity="0" transform="translate(100 130) scale(6 1.5)">
          <clipPath id={id("mouth-open")}>
            <ellipse rx="1" ry="1" />
          </clipPath>
          <ellipse rx="1" ry="1" fill={MOUTH_IN} />
          <ellipse cy="0.78" rx="0.72" ry="0.48" fill={TONGUE} clipPath={url("mouth-open")} />
        </g>

        {/* thinking: orbs orbiting the antenna (positions written by the frame loop) */}
        <g ref={thinkRef} opacity="0">
          {[0, 1, 2].map((i) => (
            <circle key={i} ref={(el) => void (dotRefs.current[i] = el)} cx="108" cy="6" r="3" fill={url("orb")} />
          ))}
        </g>

        {/* mood accessories */}
        {mood === "sleepy" &&
          [0, 1, 2].map((i) => (
            <motion.text
              key={i}
              x={150 + i * 9}
              y="30"
              fill="#7c6cf0"
              fontSize={15 + i * 5}
              fontWeight="700"
              fontFamily="var(--font-sans)"
              initial={{ opacity: 0 }}
              animate={{ x: [0, 8 + i * 2], y: [0, -24 - i * 6], opacity: [0, 1, 0] }}
              transition={{ duration: 2.6, repeat: Infinity, delay: i * 0.85, ease: "easeOut" }}
            >
              z
            </motion.text>
          ))}
        {(mood === "excited" || mood === "proud") &&
          SPARKLES.map(([x, y, fill], i) => (
            <motion.path
              key={i}
              d={`M${x} ${y - 8} Q${x + 1.2} ${y - 1.2} ${x + 8} ${y} Q${x + 1.2} ${y + 1.2} ${x} ${y + 8} Q${x - 1.2} ${y + 1.2} ${x - 8} ${y} Q${x - 1.2} ${y - 1.2} ${x} ${y - 8} Z`}
              fill={fill}
              initial={{ scale: 0.4, opacity: 0 }}
              animate={{ scale: [0.4, 1.1, 0.5], opacity: [0, 1, 0], rotate: [0, 90] }}
              transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.3, ease: "easeOut" }}
              style={{ originX: 0.5, originY: 0.5 }}
            />
          ))}
        {mood === "surprised" && (
          <motion.text
            x="152"
            y="26"
            fill="#f59e0b"
            stroke="#fff"
            strokeWidth={2.5}
            paintOrder="stroke"
            fontSize="30"
            fontWeight="800"
            fontFamily="var(--font-sans)"
            initial={{ scale: 0.5, opacity: 0, y: 10 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            transition={spring.bouncy}
            style={{ originX: 0.5, originY: 1 }}
          >
            !
          </motion.text>
        )}
      </g>
    </svg>
  );
}

/** Four-point sparkles for excited/proud: position and colour (mint, gold, violet). */
const SPARKLES: [number, number, string][] = [
  [26, 40, "#2dd4bf"],
  [176, 54, "#fbbf24"],
  [160, 6, "#a78bfa"],
  [40, 2, "#fbbf24"],
];

/** Small static glyph of Polty for the logo/avatars: same lighting, a fraction of the layers. */
export function PoltyGlyph({ size = 28, className }: { size?: number; className?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <svg viewBox="0 0 200 220" width={size} height={(size * 220) / 200} className={className} aria-hidden>
      <defs>
        <radialGradient id={`${uid}-g`} gradientUnits="userSpaceOnUse" cx="80" cy="60" r="150" fx="64" fy="42">
          <stop offset="0%" stopColor="#fff7ea" />
          <stop offset="45%" stopColor="#efebff" />
          <stop offset="80%" stopColor="#bfb7f6" />
          <stop offset="100%" stopColor="#968bec" />
        </radialGradient>
        <radialGradient id={`${uid}-i`}>
          <stop offset="0%" stopColor="#06041a" />
          <stop offset="40%" stopColor="#06041a" />
          <stop offset="55%" stopColor="#4a3ae0" />
          <stop offset="90%" stopColor="#8d7cff" />
          <stop offset="100%" stopColor="#1a1448" />
        </radialGradient>
      </defs>
      {/* shifted down so the curl's tip clears the top of the (fixed) viewBox */}
      <g transform="translate(0 11)">
        <path d={CURL} fill="none" stroke={MINT_DEEP} strokeWidth={11} strokeLinecap="round" />
        <path d={CURL} fill="none" stroke="#5eead4" strokeWidth={7} strokeLinecap="round" transform="translate(-0.6 -0.8)" />
        <path d={REST.body} fill={`url(#${uid}-g)`} stroke="#7a6ee6" strokeOpacity={0.55} strokeWidth={5} strokeLinejoin="round" paintOrder="stroke" />
        <path d={GLOSS} fill="#fff" />
        <ellipse cx="55" cy="121" rx="11" ry="7" fill="#ff6f9f" opacity={0.6} />
        <ellipse cx="145" cy="121" rx="11" ry="7" fill="#ff6f9f" opacity={0.6} />
        {[EYE_L, EYE_R].map((c) => (
          <g key={c.cx}>
            <ellipse cx={c.cx} cy={c.cy} rx={14} ry={18.5} fill="#130e36" />
            <circle cx={c.cx + 1} cy={c.cy + 3} r={9.5} fill={`url(#${uid}-i)`} />
            <ellipse cx={c.cx - 4} cy={c.cy - 7} rx={5} ry={5.5} fill="#fff" />
          </g>
        ))}
        <path d={MOUTHS.smile} fill="none" stroke={INK} strokeWidth={4} strokeLinecap="round" />
      </g>
    </svg>
  );
}
