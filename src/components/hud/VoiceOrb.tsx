"use client";

import { AnimatePresence, motion } from "motion/react";
import { forwardRef, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { AudioLines, Mic } from "lucide";
import { levels } from "@/lib/store";
import { Icon } from "@/components/ui/Icon";
import { spring } from "@/components/ui/motion";

export type OrbTone = "idle" | "listen" | "think" | "speak";

/** Liquid outline colour per state (the orb's core is dark, or teal while listening). */
const TONE_COLOR: Record<OrbTone, string> = {
  idle: "#ffffff",
  listen: "#14b8a6",
  think: "#8b5cf6",
  speak: "#9f8cf6",
};

const N = 72;

/** Closed blob around the origin: a circle whose radius ripples with a few slow harmonics. */
function blobPath(r: number, amp: number, t: number, spin: number) {
  let d = "";
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    const k =
      1 + amp * (0.55 * Math.sin(3 * a + t * 1.7 + spin) + 0.3 * Math.sin(5 * a - t * 2.3) + 0.25 * Math.sin(2 * a + t * 0.9 - spin)) + amp * 0.2 * Math.sin(7 * a + t * 3.1);
    const x = Math.cos(a) * r * k;
    const y = Math.sin(a) * r * k;
    d += `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return `${d}Z`;
}

/**
 * The voice centrepiece: one microphone. Everything else is feedback —
 *   listening: a teal liquid rim that swells with your voice, waveform icon breathing with it;
 *   thinking:  a violet sweep orbits the core (the same ectoplasm as a possessed widget);
 *   speaking:  the rim pulses with Polty's voice.
 * Press feedback fires on pointer-down; one ripple marks the start of every listen.
 */
export const VoiceOrb = forwardRef<HTMLButtonElement, { tone: OrbTone; label: string; onPress: () => void }>(function VoiceOrb({ tone, label, onPress }, ref) {
  const blobRef = useRef<SVGPathElement>(null);
  const glowRef = useRef<SVGPathElement>(null);
  const coreRef = useRef<HTMLSpanElement>(null);
  const iconRef = useRef<HTMLSpanElement>(null);
  const toneRef = useRef(tone);
  useEffect(() => {
    toneRef.current = tone;
  });
  const [burst, setBurst] = useState(0);

  // One ripple each time listening starts.
  const prevTone = useRef(tone);
  useEffect(() => {
    if (tone === "listen" && prevTone.current !== "listen") setBurst((b) => b + 1);
    prevTone.current = tone;
  }, [tone]);

  useEffect(() => {
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let amp = 0;
    let r = 36;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = (now - t0) / 1000;
      const tn = toneRef.current;
      const level = tn === "listen" ? levels.mic : tn === "speak" ? levels.speech : 0;
      amp += (level - amp) * (level > amp ? 0.35 : 0.12);
      const targetR = tn === "idle" ? 37 : tn === "think" ? 41 : 40 + amp * 13;
      r += (targetR - r) * 0.12;
      const wobble = still ? 0 : tn === "idle" ? 0.012 : tn === "think" ? 0.03 : 0.018 + amp * 0.1;
      const spin = tn === "think" ? t * 1.6 : t * 0.4;
      blobRef.current?.setAttribute("d", blobPath(r, wobble, t, spin));
      glowRef.current?.setAttribute("d", blobPath(r * 1.18, wobble * 1.4, t + 0.6, -spin));
      if (glowRef.current) glowRef.current.style.opacity = String(tn === "idle" ? 0 : 0.28 + amp * 0.55);
      if (coreRef.current) coreRef.current.style.transform = `scale(${(1 + (tn === "listen" || tn === "speak" ? amp * 0.07 : 0)).toFixed(3)})`;
      if (iconRef.current) iconRef.current.style.transform = tn === "listen" ? `scaleY(${(0.8 + amp * 0.65).toFixed(3)})` : "";
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const color = TONE_COLOR[tone];
  const listening = tone === "listen";

  return (
    <motion.button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      onClick={onPress}
      whileTap={{ scale: 0.9 }}
      whileHover={{ scale: 1.04 }}
      transition={spring.snappy}
      className="group relative grid h-[68px] w-[68px] shrink-0 touch-manipulation place-items-center rounded-full outline-offset-8"
    >
      {/* liquid rim + glow */}
      <svg
        aria-hidden
        viewBox="-80 -80 160 160"
        className="pointer-events-none absolute left-1/2 top-1/2 h-[160px] w-[160px] -translate-x-1/2 -translate-y-1/2 overflow-visible"
        style={{
          color,
          transition: "color 450ms cubic-bezier(0.23, 1, 0.32, 1)",
        }}
      >
        <defs>
          <radialGradient id="orb-rim" r="0.5">
            <stop offset="0.62" stopColor="currentColor" stopOpacity={tone === "idle" ? 0.75 : 0.55} />
            <stop offset="1" stopColor="currentColor" stopOpacity={tone === "idle" ? 0.95 : 0.16} />
          </radialGradient>
        </defs>
        <path
          ref={glowRef}
          fill="currentColor"
          style={{
            filter: "blur(14px)",
            opacity: 0,
            transition: "opacity 300ms",
          }}
        />
        <path
          ref={blobRef}
          fill="url(#orb-rim)"
          style={{
            filter: tone === "idle" ? "drop-shadow(0 6px 14px rgb(20 20 18 / 0.16))" : undefined,
            transition: "filter 300ms",
          }}
        />
      </svg>

      {/* start-of-listen ripple */}
      <AnimatePresence>
        {burst > 0 && (
          <motion.span
            key={burst}
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-full border-2 border-mint-glow"
            initial={{ scale: 1, opacity: 0.6 }}
            animate={{ scale: 2.3, opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.9, ease: [0.23, 1, 0.32, 1] }}
          />
        )}
      </AnimatePresence>

      {/* thinking sweep */}
      <span
        aria-hidden
        className={clsx("ghost-ring pointer-events-none absolute -inset-[5px] rounded-full transition-opacity duration-300", tone === "think" ? "opacity-100" : "opacity-0")}
        style={{
          padding: 3,
          background: "conic-gradient(from var(--sweep, 0deg), transparent 0deg, #a78bfa 40deg, #2dd4bf 110deg, transparent 170deg, transparent 360deg)",
          animation: tone === "think" ? "ghost-sweep 1.3s linear infinite" : undefined,
        }}
      />

      {/* core */}
      <span ref={coreRef} className="relative grid h-full w-full place-items-center rounded-full shadow-[0_10px_24px_-8px_rgb(20_20_18/0.55)]">
        <span aria-hidden className="absolute inset-0 rounded-full bg-gradient-to-b from-[#34342f] to-[#121211] shadow-[inset_0_1px_0_rgb(255_255_255/0.18)]" />
        <span
          aria-hidden
          className={clsx(
            "absolute inset-0 rounded-full bg-gradient-to-b from-[#1fb5a6] to-[#0d6b63] shadow-[inset_0_1px_0_rgb(255_255_255/0.3)] transition-opacity duration-300",
            listening ? "opacity-100" : "opacity-0",
          )}
        />
        <span ref={iconRef} className="relative text-white transition-transform duration-75">
          <Icon icon={listening ? AudioLines : Mic} size={26} strokeWidth={2.1} spring="snappy" />
        </span>
      </span>
    </motion.button>
  );
});
