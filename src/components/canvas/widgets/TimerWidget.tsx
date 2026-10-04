"use client";

import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { Timer } from "lucide";
import { useEffect, useRef, useState } from "react";
import { Illustration } from "@/components/ui/Illustration";
import { haptic, spring } from "@/components/ui/motion";
import type { WidgetComponentProps } from "../types";

export default function TimerWidget({ props }: WidgetComponentProps<{ ends_at?: number; label?: string; done?: boolean }>) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, (props.ends_at ?? now) - now);
  const done = props.done || left === 0;
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);

  // A small tick on phones when the countdown reaches zero (not when it mounts already done).
  const wasDone = useRef(done);
  useEffect(() => {
    if (done && !wasDone.current) haptic([14, 70, 14]);
    wasDone.current = done;
  }, [done]);

  return (
    <div className="flex items-center gap-4">
      <AnimatePresence initial={false}>
        {done && (
          <motion.span key="done" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.8, opacity: 0 }} transition={spring.bouncy} className="shrink-0">
            <Illustration name="timer" size={56} fallback={Timer} />
          </motion.span>
        )}
      </AnimatePresence>
      <div className="flex min-w-0 flex-col gap-1">
        <div className={clsx("font-display text-display tabular-nums transition-colors duration-300 ease-standard", done ? "text-mint" : "text-fg")}>
          {done ? "Done" : `${m}:${String(s).padStart(2, "0")}`}
        </div>
        {props.label && <div className="truncate text-body-sm text-fg-2">{props.label}</div>}
      </div>
    </div>
  );
}
