"use client";

import { useEffect, useState } from "react";
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
  return (
    <div className="flex flex-col gap-1">
      <div className={`font-display text-4xl font-semibold tabular-nums ${done ? "text-mint" : "text-ivory"}`}>
        {done ? "Done" : `${m}:${String(s).padStart(2, "0")}`}
      </div>
      <div className="text-[13px] text-ivory-dim">{props.label}</div>
    </div>
  );
}
