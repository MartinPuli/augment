"use client";
/**
 * Polty — the GHOST poltergeist. Warm white body with a hairline edge and a soft drop shadow (so it
 * reads on the light page), big dark oval eyes, a teal glow.
 * mood: idle (slow float, blinks), waiting (eyes drift side to side), possessed (wide eyes darting,
 * violet pupils and glow: violet is "the agent acting"), sleeping (closed eyes), sad (droopy).
 */
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useState } from "react";

export type GhostMood = "idle" | "waiting" | "possessed" | "sleeping" | "sad";

/* Illustration palette (the mascot keeps its own colors; tuned for the light page). */
const INK = "#151513";
const GLOW = "#2dd4bf";
const POSSESSED = "#8b5cf6";
const POSSESSED_SOFT = "#a78bfa";

const BODY =
  "M60 6C29 6 12 29 12 60v58c0 4 4 6 7 3l7-7c3-3 7-3 10 0l6 6c3 3 7 3 10 0l6-6c3-3 7-3 10 0l6 6c3 3 7 3 10 0l6-6c3-3 7-3 10 0l7 7c3 3 7 1 7-3V60C108 29 91 6 60 6Z";

export function Ghost({ mood = "idle", size = 160, className }: { mood?: GhostMood; size?: number; className?: string }) {
  const reduce = useReducedMotion();
  // Unique SVG ids, so two Polties on one page never borrow each other's gradient or filter.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const shadeId = `ghost-shade-${uid}`;
  const glowId = `ghost-glow-${uid}`;
  const [look, setLook] = useState({ x: 0, y: 0 });
  const [blink, setBlink] = useState(false);

  useEffect(() => {
    if (reduce) return;
    let t: ReturnType<typeof setTimeout>;
    const loop = () => {
      if (mood === "possessed") setLook({ x: (Math.random() - 0.5) * 10, y: (Math.random() - 0.5) * 6 });
      else if (mood === "waiting") setLook((l) => ({ x: l.x > 0 ? -4 : 4, y: 1 }));
      else setLook({ x: 0, y: 0 });
      t = setTimeout(loop, mood === "possessed" ? 380 + Math.random() * 500 : 1400);
    };
    loop();
    return () => clearTimeout(t);
  }, [mood, reduce]);

  useEffect(() => {
    if (reduce || mood === "sleeping") return;
    let t: ReturnType<typeof setTimeout>;
    const loop = () => {
      setBlink(true);
      setTimeout(() => setBlink(false), 130);
      t = setTimeout(loop, 2600 + Math.random() * 2600);
    };
    t = setTimeout(loop, 1800);
    return () => clearTimeout(t);
  }, [mood, reduce]);

  const possessed = mood === "possessed";
  const eyeRy = mood === "sleeping" ? 1.6 : blink ? 1.2 : possessed ? 15 : mood === "sad" ? 10 : 13;
  const eyeRx = possessed ? 10.5 : 9;
  const glow = possessed ? 0.7 : mood === "sleeping" ? 0.12 : 0.38;

  return (
    <motion.div
      className={className}
      style={{ width: size, height: size * 1.12 }}
      animate={reduce ? undefined : { y: possessed ? [0, -6, 2, -4, 0] : [0, -9, 0], rotate: possessed ? [0, -2.5, 2, -1, 0] : 0 }}
      transition={{ duration: possessed ? 1.1 : 5.5, repeat: Infinity, ease: "easeInOut" }}
      aria-hidden
    >
      <svg viewBox="0 0 120 134" width="100%" height="100%" style={{ overflow: "visible" }}>
        <defs>
          <radialGradient id={shadeId} cx="38%" cy="28%" r="80%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="60%" stopColor="#f8f5ef" />
            <stop offset="100%" stopColor="#e2dbcd" />
          </radialGradient>
          <filter id={glowId} x="-60%" y="-60%" width="220%" height="220%">
            {/* colored halo */}
            <feGaussianBlur in="SourceAlpha" stdDeviation={possessed ? 9 : 7} result="halo-blur" />
            <feFlood floodColor={possessed ? POSSESSED_SOFT : GLOW} floodOpacity={glow} />
            <feComposite in2="halo-blur" operator="in" result="halo" />
            {/* soft drop shadow: gives the white body an edge on a light page */}
            <feGaussianBlur in="SourceAlpha" stdDeviation="4" result="shadow-blur" />
            <feOffset in="shadow-blur" dy="5" result="shadow-offset" />
            <feFlood floodColor={INK} floodOpacity="0.16" />
            <feComposite in2="shadow-offset" operator="in" result="shadow" />
            <feMerge>
              <feMergeNode in="halo" />
              <feMergeNode in="shadow" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <ellipse cx="60" cy="131" rx={possessed ? 30 : 34} ry="3.5" fill={possessed ? POSSESSED : INK} opacity={possessed ? 0.22 : 0.08} />
        <path d={BODY} fill={`url(#${shadeId})`} stroke={INK} strokeOpacity={0.12} strokeWidth={1.2} filter={`url(#${glowId})`} />
        {/* cheeks */}
        <ellipse cx="34" cy="76" rx="6" ry="3.2" fill="#ffa596" opacity={possessed ? 0.0 : 0.34} />
        <ellipse cx="86" cy="76" rx="6" ry="3.2" fill="#ffa596" opacity={possessed ? 0.0 : 0.34} />
        <motion.g animate={{ x: look.x, y: look.y }} transition={{ type: "spring", stiffness: 260, damping: 18 }}>
          {[43, 77].map((cx) => (
            <g key={cx}>
              <motion.ellipse
                cx={cx}
                cy={mood === "sad" ? 60 : 56}
                animate={{ rx: eyeRx, ry: eyeRy }}
                transition={{ duration: 0.12 }}
                fill={INK}
              />
              {mood !== "sleeping" && !blink && (
                <>
                  <circle cx={cx + 3} cy={possessed ? 50 : 51} r={possessed ? 3.4 : 2.6} fill={possessed ? POSSESSED_SOFT : "#ffffff"} opacity={0.95} />
                  {possessed && <circle cx={cx - 2.5} cy={61} r={1.3} fill={POSSESSED_SOFT} opacity={0.7} />}
                </>
              )}
            </g>
          ))}
          {possessed ? (
            <motion.ellipse cx="60" cy="82" rx="5" animate={{ ry: [4, 6, 4] }} transition={{ duration: 0.9, repeat: Infinity }} fill={INK} />
          ) : mood === "sad" ? (
            <path d="M53 86q7-6 14 0" stroke={INK} strokeWidth="2.4" fill="none" strokeLinecap="round" />
          ) : mood === "sleeping" ? (
            <path d="M55 82h10" stroke={INK} strokeWidth="2.2" strokeLinecap="round" />
          ) : (
            <path d="M54 80q6 5 12 0" stroke={INK} strokeWidth="2.4" fill="none" strokeLinecap="round" />
          )}
        </motion.g>
      </svg>
    </motion.div>
  );
}
