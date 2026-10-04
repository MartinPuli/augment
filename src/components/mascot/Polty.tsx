"use client";

import { motion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import type { Activity, Mood } from "@/lib/store";

/**
 * Polty — the GHOST poltergeist. A ghost that moves real things.
 *
 * Signature traits: a signal curl on its head (it emits rings when it reaches into a device),
 * a skirt that ripples like cloth and fades into nothing, and big glossy eyes that follow you.
 * Everything high-frequency (skirt, bob, mouth lip-sync, gaze) runs in one rAF loop writing
 * attributes directly; expressions are spring-animated with motion.
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
  neutral: { upper: 0.06, lower: 0, tilt: 0, eyeScale: 1, mouth: "smile", blush: 0.25, headTilt: 0 },
  happy: { upper: 0, lower: 0.5, tilt: 0, eyeScale: 1, mouth: "big", blush: 0.85, headTilt: -3 },
  curious: { upper: 0.04, lower: 0, tilt: 0, eyeScale: 1.08, eyeScaleR: 0.86, mouth: "o", blush: 0.3, headTilt: -9 },
  excited: { upper: 0, lower: 0.22, tilt: 0, eyeScale: 1.18, mouth: "big", blush: 0.9, headTilt: 0 },
  thinking: { upper: 0.22, lower: 0.05, tilt: 6, eyeScale: 0.96, mouth: "wavy", blush: 0.2, headTilt: 6 },
  surprised: { upper: 0, lower: 0, tilt: 0, eyeScale: 1.28, mouth: "o", blush: 0.35, headTilt: 0 },
  sad: { upper: 0.3, lower: 0, tilt: -14, eyeScale: 0.95, mouth: "frown", blush: 0.1, headTilt: 5 },
  determined: { upper: 0.34, lower: 0.08, tilt: 16, eyeScale: 1, mouth: "flat", blush: 0.15, headTilt: 0 },
  mischievous: { upper: 0.42, lower: 0.18, tilt: 4, eyeScale: 1, mouth: "smirk", blush: 0.5, headTilt: -6 },
  proud: { upper: 0.18, lower: 0.38, tilt: 0, eyeScale: 1, mouth: "big", blush: 0.6, headTilt: -5 },
  sleepy: { upper: 0.66, lower: 0.05, tilt: -4, eyeScale: 1, mouth: "o", blush: 0.2, headTilt: 7 },
};

const MOUTHS: Record<Expr["mouth"], string> = {
  smile: "M90 127 Q100 135 110 127",
  big: "M87 124 Q100 142 113 124 Q100 131 87 124 Z",
  flat: "M91 129 L109 129",
  frown: "M90 133 Q100 124 110 133",
  o: "M100 124 m-4.5 4.5 a4.5 5.5 0 1 0 9 0 a4.5 5.5 0 1 0 -9 0",
  smirk: "M91 129 Q103 133 111 123",
  wavy: "M90 129 Q95 125 100 129 T110 129",
};

const GLOW: Record<Activity, string> = {
  idle: "#f4efe4",
  listening: "#5df2b5",
  thinking: "#a99bff",
  speaking: "#f4efe4",
  acting: "#5df2b5",
};

const EYE_L = { cx: 76, cy: 98 };
const EYE_R = { cx: 124, cy: 98 };
const RX = 12.5;
const RY = 17;

function bodyPath(t: number, sway: number, breathe: number) {
  // Head + flanks
  const w = 70 + breathe * 1.5;
  const L = 100 - w;
  const R = 100 + w;
  const top = 22 - breathe * 1.2;
  const shoulder = 96;
  const hem = 172;
  let d = `M${L} ${shoulder} C${L} ${top + 30} ${100 - 40} ${top} 100 ${top} C${100 + 40} ${top} ${R} ${top + 30} ${R} ${shoulder}`;
  // flanks bulge slightly and lean with sway
  d += ` C${R + 1.5} ${130} ${R - 1 + sway * 6} ${150} ${R + sway * 8} ${hem}`;
  // Skirt: five rippling tails from right to left
  const n = 5;
  const span = R - L;
  for (let i = 0; i < n; i++) {
    const x0 = R - (span * i) / n + sway * 8 * (1 - i / n);
    const x1 = R - (span * (i + 1)) / n + sway * 8 * (1 - (i + 1) / n);
    const phase = t * 3.1 + i * 1.25;
    const tip = hem + 18 + Math.sin(phase) * 6 + (i % 2 === 0 ? 4 : 0);
    const notch = hem - 2 + Math.sin(phase + 1.7) * 3;
    const mid = (x0 + x1) / 2 + Math.sin(phase * 0.7) * 2.5 + sway * 4;
    d += ` C${x0 - 3} ${tip - 4} ${mid + 6} ${tip + 2} ${mid} ${tip}`;
    d += ` C${mid - 6} ${tip - 2} ${x1 + 3} ${notch + 6} ${x1} ${i === n - 1 ? hem : notch}`;
  }
  d += ` C${L - 1 + sway * 6} ${150} ${L - 1.5} ${130} ${L} ${shoulder} Z`;
  return d;
}

export function Polty({ mood, activity, speechLevel, micLevel, gaze, size = 160, className, onClick, sway }: PoltyProps) {
  const uid = useId().replace(/:/g, "");
  const bodyRef = useRef<SVGPathElement>(null);
  const shadowRef = useRef<SVGEllipseElement>(null);
  const rigRef = useRef<SVGGElement>(null);
  const eyesRef = useRef<SVGGElement>(null);
  const mouthOpenRef = useRef<SVGEllipseElement>(null);
  const mouthClosedRef = useRef<SVGPathElement>(null);
  const glowRef = useRef<SVGCircleElement>(null);
  const ringsRef = useRef<SVGGElement>(null);
  const [blink, setBlink] = useState(false);
  const e = EXPR[mood] ?? EXPR.neutral;

  // Blink on a natural, irregular rhythm (double-blink sometimes).
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const loop = () => {
      timer = setTimeout(
        () => {
          if (!alive) return;
          setBlink(true);
          setTimeout(() => setBlink(false), 110);
          if (Math.random() < 0.2) {
            setTimeout(() => setBlink(true), 240);
            setTimeout(() => setBlink(false), 350);
          }
          loop();
        },
        2200 + Math.random() * 3800,
      );
    };
    loop();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  // Per-frame animation.
  const stateRef = useRef({ activity, mood });
  stateRef.current = { activity, mood };
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const look = { x: 0, y: 0 };
    let swayS = 0;
    const tick = (now: number) => {
      const t = (now - t0) / 1000;
      const { activity: act } = stateRef.current;
      const speak = speechLevel();
      const mic = micLevel();
      const target = gaze();
      look.x += (target.x - look.x) * 0.12;
      look.y += (target.y - look.y) * 0.12;
      swayS += ((sway?.() ?? 0) - swayS) * 0.08;
      const breathe = Math.sin(t * 1.6) * 0.5 + 0.5 + (act === "listening" ? mic * 2.5 : 0);
      const bob = Math.sin(t * 1.9) * 5 + (act === "speaking" ? speak * -3 : 0);

      bodyRef.current?.setAttribute("d", bodyPath(t, swayS, breathe));
      rigRef.current?.setAttribute("transform", `translate(0 ${bob.toFixed(2)})`);
      shadowRef.current?.setAttribute("rx", (46 - bob * 1.2).toFixed(1));
      shadowRef.current?.setAttribute("opacity", (0.22 - bob * 0.01).toFixed(3));
      eyesRef.current?.setAttribute("transform", `translate(${(look.x * 7).toFixed(2)} ${(look.y * 5).toFixed(2)})`);

      // Lip-sync: open mouth follows the voice envelope.
      const open = act === "speaking" || speak > 0.04 ? Math.min(1, speak * 1.4) : 0;
      if (mouthOpenRef.current) {
        mouthOpenRef.current.setAttribute("ry", (1.5 + open * 9).toFixed(2));
        mouthOpenRef.current.setAttribute("rx", (6 + open * 3.5).toFixed(2));
        mouthOpenRef.current.setAttribute("opacity", open > 0.06 ? "1" : "0");
      }
      mouthClosedRef.current?.setAttribute("opacity", open > 0.06 ? "0" : "1");

      // Glow breathes with state.
      const pulse = act === "listening" ? 0.5 + mic * 0.6 : act === "thinking" ? 0.42 + Math.sin(t * 4) * 0.12 : act === "speaking" ? 0.38 + speak * 0.4 : 0.3;
      glowRef.current?.setAttribute("opacity", pulse.toFixed(3));
      if (ringsRef.current) ringsRef.current.style.opacity = act === "acting" ? "1" : "0";

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [speechLevel, micLevel, gaze, sway]);

  const lid = (side: "L" | "R") => {
    const c = side === "L" ? EYE_L : EYE_R;
    const dir = side === "L" ? 1 : -1;
    const scale = side === "R" && e.eyeScaleR ? e.eyeScaleR : e.eyeScale;
    const ry = RY * scale;
    return (
      <motion.g
        key={side}
        style={{ originX: 0.5, originY: 0.5 }}
        animate={{ scaleY: blink ? 0.08 : 1, scale: scale }}
        transition={{ scaleY: { duration: blink ? 0.06 : 0.09 }, scale: { type: "spring", stiffness: 260, damping: 16 } }}
      >
        <clipPath id={`${uid}-eye-${side}`}>
          <ellipse cx={c.cx} cy={c.cy} rx={RX} ry={RY} />
        </clipPath>
        <ellipse cx={c.cx} cy={c.cy} rx={RX} ry={RY} fill="#0b0c10" />
        {/* glints */}
        <circle cx={c.cx + 4.5} cy={c.cy - 6.5} r={4} fill="#fff" opacity={0.95} />
        <circle cx={c.cx - 3.5} cy={c.cy + 6} r={1.7} fill="#fff" opacity={0.7} />
        <g clipPath={`url(#${uid}-eye-${side})`}>
          {/* upper lid */}
          <motion.rect
            x={c.cx - 24}
            width={48}
            height={44}
            fill={`url(#${uid}-skin)`}
            style={{ originX: 0.5, originY: 1 }}
            initial={false}
            animate={{ y: c.cy - RY - 44 + e.upper * 2 * RY, rotate: e.tilt * dir }}
            transition={{ type: "spring", stiffness: 220, damping: 20 }}
          />
          {/* lower lid (smile squint) */}
          <motion.ellipse
            cx={c.cx}
            rx={20}
            ry={15}
            fill={`url(#${uid}-skin)`}
            initial={false}
            animate={{ cy: c.cy + RY + 15 - e.lower * ry * 1.45 }}
            transition={{ type: "spring", stiffness: 220, damping: 20 }}
          />
        </g>
      </motion.g>
    );
  };

  const glow = GLOW[activity];

  return (
    <motion.svg
      viewBox="-20 -30 240 260"
      width={size}
      height={(size * 260) / 240}
      className={className}
      onClick={onClick}
      style={{ overflow: "visible", cursor: onClick ? "pointer" : undefined }}
      animate={{ rotate: e.headTilt }}
      transition={{ type: "spring", stiffness: 120, damping: 14 }}
      role="img"
      aria-label={`Polty is ${activity}, feeling ${mood}`}
    >
      <defs>
        <radialGradient id={`${uid}-glow`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={glow} stopOpacity="0.55" />
          <stop offset="60%" stopColor={glow} stopOpacity="0.12" />
          <stop offset="100%" stopColor={glow} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${uid}-skin`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fffdf6" />
          <stop offset="55%" stopColor="#f4efe4" />
          <stop offset="100%" stopColor="#e3dccb" />
        </linearGradient>
        <linearGradient id={`${uid}-fade`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fff" stopOpacity="1" />
          <stop offset="68%" stopColor="#fff" stopOpacity="1" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0.15" />
        </linearGradient>
        <mask id={`${uid}-mask`} maskUnits="userSpaceOnUse" x="-20" y="-30" width="240" height="260">
          <rect x="-20" y="-30" width="240" height="260" fill={`url(#${uid}-fade)`} />
        </mask>
        <filter id={`${uid}-soft`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="0.6" />
        </filter>
      </defs>

      {/* aura */}
      <circle ref={glowRef} cx="100" cy="105" r="118" fill={`url(#${uid}-glow)`} opacity="0.3" style={{ transition: "fill 400ms" }} />
      {/* floor shadow */}
      <ellipse ref={shadowRef} cx="100" cy="222" rx="46" ry="6" fill="#000" opacity="0.2" />

      <g ref={rigRef}>
        {/* signal rings (emitted while possessing a device) */}
        <g ref={ringsRef} style={{ transition: "opacity 300ms" }}>
          {[0, 1, 2].map((i) => (
            <motion.path
              key={i}
              d="M86 6 Q100 -8 114 6"
              fill="none"
              stroke="#5df2b5"
              strokeWidth={3}
              strokeLinecap="round"
              initial={{ opacity: 0, y: 0, scale: 0.6 }}
              animate={{ opacity: [0, 0.9, 0], y: [-2, -18 - i * 2], scale: [0.6, 1.5 + i * 0.25] }}
              transition={{ duration: 1.5, repeat: Infinity, delay: i * 0.45, ease: "easeOut" }}
              style={{ originX: 0.5, originY: 1 }}
            />
          ))}
        </g>

        {/* signal curl — Polty's signature antenna of ectoplasm */}
        <motion.path
          d="M100 24 C97 10 108 1 116 6 C123 11 118 21 110 19 C105 18 105 12 109 11"
          fill="none"
          stroke={`url(#${uid}-skin)`}
          strokeWidth={6.5}
          strokeLinecap="round"
          animate={{ rotate: activity === "acting" ? [0, -10, 8, 0] : [0, 5, 0] }}
          transition={{ duration: activity === "acting" ? 0.9 : 3.2, repeat: Infinity, ease: "easeInOut" }}
          style={{ originX: 0.15, originY: 1 }}
        />

        {/* arms */}
        <motion.ellipse
          cx="26"
          cy="128"
          rx="11"
          ry="17"
          fill={`url(#${uid}-skin)`}
          style={{ originX: 0.85, originY: 0.15 }}
          animate={{ rotate: mood === "excited" || mood === "happy" ? [20, -25, 20] : activity === "acting" ? -40 : 18 }}
          transition={mood === "excited" || mood === "happy" ? { duration: 0.7, repeat: Infinity } : { type: "spring", stiffness: 140, damping: 12 }}
        />
        <motion.ellipse
          cx="174"
          cy="128"
          rx="11"
          ry="17"
          fill={`url(#${uid}-skin)`}
          style={{ originX: 0.15, originY: 0.15 }}
          animate={{ rotate: mood === "excited" ? [-20, 25, -20] : mood === "thinking" ? -70 : -18 }}
          transition={mood === "excited" ? { duration: 0.7, repeat: Infinity, delay: 0.2 } : { type: "spring", stiffness: 140, damping: 12 }}
        />

        {/* body */}
        <g mask={`url(#${uid}-mask)`}>
          <path ref={bodyRef} d={bodyPath(0, 0, 0)} fill={`url(#${uid}-skin)`} />
          {/* rim light */}
          <path d="M44 70 C52 44 72 32 92 30" fill="none" stroke="#fff" strokeOpacity="0.8" strokeWidth="5" strokeLinecap="round" filter={`url(#${uid}-soft)`} />
        </g>

        {/* cheeks */}
        <motion.g animate={{ opacity: e.blush }} transition={{ duration: 0.4 }}>
          <ellipse cx="58" cy="120" rx="10" ry="5.5" fill="#ff8a7e" opacity="0.55" />
          <ellipse cx="142" cy="120" rx="10" ry="5.5" fill="#ff8a7e" opacity="0.55" />
        </motion.g>

        {/* eyes */}
        <g ref={eyesRef}>
          {lid("L")}
          {lid("R")}
        </g>

        {/* mouth */}
        <motion.path
          ref={mouthClosedRef}
          d={MOUTHS[e.mouth]}
          initial={false}
          animate={{ d: MOUTHS[e.mouth] }}
          fill={e.mouth === "big" || e.mouth === "o" ? "#0b0c10" : "none"}
          stroke="#0b0c10"
          strokeWidth={3.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          transition={{ duration: 0.25 }}
        />
        <ellipse ref={mouthOpenRef} cx="100" cy="130" rx="6" ry="1.5" fill="#0b0c10" opacity="0" />

        {/* mood accessories */}
        {activity === "thinking" && (
          <g>
            {[0, 1, 2].map((i) => (
              <motion.circle
                key={i}
                r={3.2 - i * 0.6}
                fill="#a99bff"
                initial={{ cx: 168, cy: 30, opacity: 0 }}
                animate={{ cx: [168, 182 + i * 6, 168], cy: [30, 14 - i * 8, 30], opacity: [0, 1, 0] }}
                transition={{ duration: 1.6, repeat: Infinity, delay: i * 0.25 }}
              />
            ))}
          </g>
        )}
        {mood === "sleepy" && (
          <motion.text
            x="160"
            y="30"
            fill="#c9c4b8"
            fontSize="18"
            fontFamily="var(--font-display)"
            animate={{ y: [30, 10], opacity: [0, 1, 0] }}
            transition={{ duration: 2.4, repeat: Infinity }}
          >
            z
          </motion.text>
        )}
        {(mood === "excited" || mood === "proud") &&
          [
            [30, 40],
            [172, 52],
            [160, 8],
          ].map(([x, y], i) => (
            <motion.path
              key={i}
              d={`M${x} ${y - 7} L${x + 2} ${y - 2} L${x + 7} ${y} L${x + 2} ${y + 2} L${x} ${y + 7} L${x - 2} ${y + 2} L${x - 7} ${y} L${x - 2} ${y - 2} Z`}
              fill="#5df2b5"
              animate={{ scale: [0, 1, 0], rotate: [0, 90] }}
              transition={{ duration: 1.3, repeat: Infinity, delay: i * 0.35 }}
              style={{ originX: 0.5, originY: 0.5 }}
            />
          ))}
        {mood === "surprised" && (
          <motion.text x="150" y="26" fill="#ffb547" fontSize="26" fontWeight="800" fontFamily="var(--font-display)" initial={{ scale: 0 }} animate={{ scale: 1 }}>
            !
          </motion.text>
        )}
      </g>
    </motion.svg>
  );
}

/** Small static glyph of Polty for the logo/favicons. */
export function PoltyGlyph({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 200 220" width={size} height={(size * 220) / 200} className={className} aria-hidden>
      <path d={bodyPath(0.4, 0, 0.5)} fill="#f4efe4" />
      <path d="M100 24 C97 10 108 1 116 6 C123 11 118 21 110 19" fill="none" stroke="#f4efe4" strokeWidth="8" strokeLinecap="round" />
      <ellipse cx="76" cy="98" rx="13" ry="18" fill="#0a0b0e" />
      <ellipse cx="124" cy="98" rx="13" ry="18" fill="#0a0b0e" />
      <circle cx="81" cy="91" r="4.5" fill="#fff" />
      <circle cx="129" cy="91" r="4.5" fill="#fff" />
    </svg>
  );
}
