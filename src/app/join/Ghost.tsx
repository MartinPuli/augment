"use client";
/**
 * Polty — the GHOST poltergeist. Ivory body, big dark oval eyes, mint glow.
 * mood: idle (slow float, blinks), waiting (eyes drift side to side), possessed (wide eyes darting,
 * mint pupils, stronger glow), sleeping (closed eyes), sad (droopy).
 */
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

export type GhostMood = "idle" | "waiting" | "possessed" | "sleeping" | "sad";

const BODY =
  "M60 6C29 6 12 29 12 60v58c0 4 4 6 7 3l7-7c3-3 7-3 10 0l6 6c3 3 7 3 10 0l6-6c3-3 7-3 10 0l6 6c3 3 7 3 10 0l6-6c3-3 7-3 10 0l7 7c3 3 7 1 7-3V60C108 29 91 6 60 6Z";

export function Ghost({ mood = "idle", size = 160, className }: { mood?: GhostMood; size?: number; className?: string }) {
  const reduce = useReducedMotion();
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
  const glow = possessed ? 0.85 : mood === "sleeping" ? 0.15 : 0.45;

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
          <radialGradient id="ghost-shade" cx="38%" cy="28%" r="80%">
            <stop offset="0%" stopColor="#fffdf7" />
            <stop offset="65%" stopColor="#f4efe4" />
            <stop offset="100%" stopColor="#d9d2c2" />
          </radialGradient>
          <filter id="ghost-glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation={possessed ? 9 : 7} result="b" />
            <feFlood floodColor="#5df2b5" floodOpacity={glow} />
            <feComposite in2="b" operator="in" />
            <feMerge>
              <feMergeNode />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <ellipse cx="60" cy="131" rx={possessed ? 30 : 34} ry="3.5" fill="#5df2b5" opacity={possessed ? 0.35 : 0.18} />
        <path d={BODY} fill="url(#ghost-shade)" filter="url(#ghost-glow)" />
        {/* cheeks */}
        <ellipse cx="34" cy="76" rx="6" ry="3.2" fill="#ffb4a8" opacity={possessed ? 0.0 : 0.28} />
        <ellipse cx="86" cy="76" rx="6" ry="3.2" fill="#ffb4a8" opacity={possessed ? 0.0 : 0.28} />
        <motion.g animate={{ x: look.x, y: look.y }} transition={{ type: "spring", stiffness: 260, damping: 18 }}>
          {[43, 77].map((cx) => (
            <g key={cx}>
              <motion.ellipse
                cx={cx}
                cy={mood === "sad" ? 60 : 56}
                animate={{ rx: eyeRx, ry: eyeRy }}
                transition={{ duration: 0.12 }}
                fill="#0a0b0e"
              />
              {mood !== "sleeping" && !blink && (
                <>
                  <circle cx={cx + 3} cy={possessed ? 50 : 51} r={possessed ? 3.4 : 2.6} fill={possessed ? "#5df2b5" : "#f4efe4"} opacity={0.95} />
                  {possessed && <circle cx={cx - 2.5} cy={61} r={1.3} fill="#5df2b5" opacity={0.6} />}
                </>
              )}
            </g>
          ))}
          {possessed ? (
            <motion.ellipse cx="60" cy="82" rx="5" animate={{ ry: [4, 6, 4] }} transition={{ duration: 0.9, repeat: Infinity }} fill="#0a0b0e" />
          ) : mood === "sad" ? (
            <path d="M53 86q7-6 14 0" stroke="#0a0b0e" strokeWidth="2.4" fill="none" strokeLinecap="round" />
          ) : mood === "sleeping" ? (
            <path d="M55 82h10" stroke="#0a0b0e" strokeWidth="2.2" strokeLinecap="round" />
          ) : (
            <path d="M54 80q6 5 12 0" stroke="#0a0b0e" strokeWidth="2.4" fill="none" strokeLinecap="round" />
          )}
        </motion.g>
      </svg>
    </motion.div>
  );
}
