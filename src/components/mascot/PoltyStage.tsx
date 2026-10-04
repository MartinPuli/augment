"use client";

import { AnimatePresence, motion, useMotionValue, useSpring } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { levels, useGhost } from "@/lib/store";
import { Polty } from "./Polty";

/**
 * Flies Polty around the canvas: hero pose on an empty canvas, peeks beside the widget it is
 * talking about, comes close while listening, and stretches an ectoplasm tether into whatever
 * device it is possessing.
 */
export function PoltyStage({ onPoke }: { onPoke?: () => void }) {
  const mood = useGhost((s) => s.mood);
  const activity = useGhost((s) => s.activity);
  const focusId = useGhost((s) => s.focusId);
  const possess = useGhost((s) => s.possess);
  const hero = useGhost((s) => s.widgets.length === 0 && s.ui.length === 0);
  const toolStatus = useGhost((s) => s.toolStatus);

  const size = hero ? 196 : 128;
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 48, damping: 12, mass: 1.1 });
  const sy = useSpring(y, { stiffness: 48, damping: 12, mass: 1.1 });
  const sizeS = useSpring(size, { stiffness: 90, damping: 16 });
  useEffect(() => sizeS.set(size), [size, sizeS]);

  const pointer = useRef({ x: 0, y: 0, t: 0 });
  const gazeRef = useRef({ x: 0, y: 0 });
  const tetherRef = useRef<SVGPathElement>(null);
  const tetherGlowRef = useRef<SVGPathElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const stateRef = useRef({ focusId, activity, hero, possess, size });
  stateRef.current = { focusId, activity, hero, possess, size };

  useEffect(() => {
    const onMove = (e: PointerEvent) => (pointer.current = { x: e.clientX, y: e.clientY, t: performance.now() });
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  // Re-render when a possession expires.
  useEffect(() => {
    if (!possess) return;
    const ms = possess.until - Date.now();
    if (ms <= 0) return;
    const t = setTimeout(() => setNow(Date.now()), ms + 20);
    return () => clearTimeout(t);
  }, [possess]);

  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    x.jump(window.innerWidth / 2);
    y.jump(window.innerHeight * 0.38);
    const tick = (tNow: number) => {
      const t = (tNow - t0) / 1000;
      const { focusId: fid, activity: act, hero: isHero, possess: pos, size: sz } = stateRef.current;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const compact = vw < 760;
      let tx: number;
      let ty: number;
      let look: { x: number; y: number } | null = null;

      const targetId = pos && pos.until > Date.now() && pos.widgetId ? pos.widgetId : fid;
      const el = targetId ? (document.querySelector(`[data-widget-id="${CSS.escape(targetId)}"]`) as HTMLElement | null) : null;
      const r = el?.getBoundingClientRect();

      if (isHero) {
        tx = vw / 2 + Math.sin(t * 0.5) * 14;
        ty = vh * (compact ? 0.24 : 0.25) + Math.sin(t * 0.8) * 6;
      } else if (r && r.width > 0 && r.bottom > 60 && r.top < vh - 80) {
        // Peek over the widget's left edge (the canvas keeps a rail on the left for Polty).
        const fits = r.left > sz * 0.9;
        tx = r.left - (fits ? sz * 0.36 : sz * 0.08);
        tx = Math.min(vw - sz * 0.45, Math.max(sz * 0.45, tx));
        ty = Math.min(vh - 180, Math.max(110, r.top + Math.min(r.height * 0.35, 140)));
        look = { x: Math.max(-1, Math.min(1, ((r.left + r.width / 2 - tx) / 300))), y: Math.max(-1, Math.min(1, (r.top + r.height / 2 - ty) / 300)) };
      } else if (act === "listening") {
        tx = vw / 2 + Math.sin(t * 0.9) * 10;
        ty = vh - (compact ? 230 : 250);
        look = { x: 0, y: 0.25 };
      } else {
        // Home: lower-left corner, lazily wandering.
        tx = (compact ? vw * 0.18 : 120) + Math.sin(t * 0.37) * 26 + Math.sin(t * 0.91) * 8;
        ty = vh - (compact ? 230 : 250) + Math.sin(t * 0.53) * 16;
      }
      x.set(tx);
      y.set(ty);

      if (!look) {
        const p = pointer.current;
        const idleFor = tNow - p.t;
        if (p.t && idleFor < 6000) {
          look = { x: Math.max(-1, Math.min(1, (p.x - sx.get()) / 420)), y: Math.max(-1, Math.min(1, (p.y - sy.get()) / 420)) };
        } else {
          look = { x: Math.sin(t * 0.3) * 0.5, y: Math.sin(t * 0.21) * 0.3 };
        }
      }
      if (act === "thinking") look = { x: 0.55, y: -0.7 };
      gazeRef.current = look;

      // Tether into a possessed widget.
      if (tetherRef.current && tetherGlowRef.current) {
        const pel = pos && pos.until > Date.now() && pos.widgetId ? (document.querySelector(`[data-widget-id="${CSS.escape(pos.widgetId)}"]`) as HTMLElement | null) : null;
        const pr = pel?.getBoundingClientRect();
        if (pr) {
          const px = sx.get();
          const py = sy.get() + sizeS.get() * 0.42;
          const ax = Math.max(pr.left + 24, Math.min(pr.right - 24, px));
          const ay = py < pr.top ? pr.top + 6 : py > pr.bottom ? pr.bottom - 6 : pr.top + pr.height / 2;
          const bx = px < pr.left ? pr.left + 6 : px > pr.right ? pr.right - 6 : ax;
          const endX = px < pr.left || px > pr.right ? bx : ax;
          const endY = px < pr.left || px > pr.right ? Math.max(pr.top + 30, Math.min(pr.bottom - 30, py)) : ay;
          const mx = (px + endX) / 2;
          const sag = 40 + Math.sin(t * 2.2) * 10;
          const d = `M${px.toFixed(1)} ${py.toFixed(1)} C${(px + (mx - px) * 0.3).toFixed(1)} ${(py + sag).toFixed(1)} ${(mx + (endX - mx) * 0.4).toFixed(1)} ${(endY + sag * 0.6).toFixed(1)} ${endX.toFixed(1)} ${endY.toFixed(1)}`;
          tetherRef.current.setAttribute("d", d);
          tetherGlowRef.current.setAttribute("d", d);
          tetherRef.current.style.opacity = "1";
          tetherGlowRef.current.style.opacity = "0.55";
        } else {
          tetherRef.current.style.opacity = "0";
          tetherGlowRef.current.style.opacity = "0";
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [x, y, sx, sy, sizeS]);

  const speechLevel = useCallback(() => levels.speech, []);
  const micLevel = useCallback(() => levels.mic, []);
  const gaze = useCallback(() => gazeRef.current, []);
  const sway = useCallback(() => Math.max(-1, Math.min(1, sx.getVelocity() / 900)), [sx]);

  const possessing = possess && possess.until > now;

  return (
    <div className="pointer-events-none fixed inset-0 z-30">
      <svg className="absolute inset-0 h-full w-full overflow-visible">
        <defs>
          <linearGradient id="tether-grad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#a78bfa" />
            <stop offset="55%" stopColor="#2dd4bf" />
            <stop offset="100%" stopColor="#0f766e" />
          </linearGradient>
          <filter id="tether-blur">
            <feGaussianBlur stdDeviation="6" />
          </filter>
        </defs>
        <path ref={tetherGlowRef} fill="none" stroke="#5eead4" strokeWidth={14} strokeLinecap="round" filter="url(#tether-blur)" style={{ opacity: 0, transition: "opacity 300ms" }} />
        <path
          ref={tetherRef}
          fill="none"
          stroke="url(#tether-grad)"
          strokeWidth={3.5}
          strokeLinecap="round"
          strokeDasharray="2 10"
          style={{ opacity: 0, transition: "opacity 300ms", animation: "tether-flow 0.6s linear infinite" }}
        />
      </svg>
      <style>{`@keyframes tether-flow { to { stroke-dashoffset: -24; } }`}</style>

      <motion.div
        className="absolute left-0 top-0"
        style={{ x: sx, y: sy, translateX: "-50%", translateY: "-50%", width: sizeS, rotate: useSpringRotate(sx) }}
      >
        <div className="pointer-events-auto relative">
          <Polty
            mood={mood}
            activity={activity}
            speechLevel={speechLevel}
            micLevel={micLevel}
            gaze={gaze}
            sway={sway}
            size={size}
            className="h-auto w-full [filter:drop-shadow(0_0_0.75px_rgb(15_23_42/0.4))_drop-shadow(0_4px_8px_rgb(15_23_42/0.14))_drop-shadow(0_20px_30px_rgb(30_41_82/0.2))]"
            onClick={onPoke}
          />
          <AnimatePresence>
            {(possessing || toolStatus) && !hero && (
              <motion.div
                key={possessing ? `p-${possess?.label}` : `t-${toolStatus}`}
                initial={{ opacity: 0, y: 6, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.95 }}
                className="ghost-chip absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap rounded-full px-3 py-1 font-mono text-[11px] font-medium text-ivory"
              >
                <span className={`mr-2 inline-block h-1.5 w-1.5 rounded-full align-middle ${possessing ? "bg-mint animate-pulse" : "bg-violet"}`} />
                {possessing ? `possessing · ${possess?.label}` : toolStatus}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}

/** Lean into the direction of flight. */
function useSpringRotate(sx: ReturnType<typeof useSpring>) {
  const rot = useMotionValue(0);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = sx.getVelocity();
      rot.set(Math.max(-14, Math.min(14, v / 80)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [sx, rot]);
  return useSpring(rot, { stiffness: 120, damping: 18 });
}
