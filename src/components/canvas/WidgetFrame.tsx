"use client";

import { motion } from "motion/react";
import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import clsx from "clsx";

/**
 * Branded shell for every canvas widget: glass card, HUD corner ticks, a focus ring when Polty is
 * looking at it, an ectoplasm sweep while Polty possesses it, and a materialize/dematerialize
 * transition.
 */
export function WidgetFrame({
  id,
  title,
  icon: Icon,
  badge,
  focused,
  possessed,
  className,
  onClose,
  children,
}: {
  id: string;
  title?: string;
  icon?: LucideIcon;
  badge?: ReactNode;
  focused: boolean;
  possessed: boolean;
  className?: string;
  onClose?: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [focused]);

  return (
    <motion.div
      ref={ref}
      layout
      data-widget-id={id}
      initial={{ opacity: 0, scale: 0.86, y: 24, filter: "blur(14px)" }}
      animate={{ opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }}
      exit={{ opacity: 0, scale: 0.9, y: -10, filter: "blur(12px)", transition: { duration: 0.28 } }}
      transition={{ type: "spring", stiffness: 210, damping: 24, mass: 0.9, layout: { type: "spring", stiffness: 260, damping: 30 } }}
      className={clsx("group relative min-w-0", className)}
    >
      {/* possession sweep */}
      <div
        aria-hidden
        className={clsx(
          "ghost-ring pointer-events-none absolute -inset-[2px] rounded-[26px] transition-opacity duration-500",
          possessed ? "opacity-100" : "opacity-0",
        )}
        style={{
          background:
            "conic-gradient(from var(--sweep, 0deg), transparent 0deg, #a78bfa 24deg, #2dd4bf 62deg, #0f766e 96deg, transparent 130deg, transparent 360deg)",
          animation: possessed ? "ghost-sweep 1.6s linear infinite" : undefined,
        }}
      />
      <div
        className={clsx(
          "ghost-glass relative flex h-full flex-col overflow-hidden rounded-[24px] transition-shadow duration-500",
          focused &&
            "shadow-[inset_0_1px_0_rgb(255_255_255/0.95),0_0_0_1.5px_rgb(15_118_110/0.4),0_0_0_6px_rgb(45_212_191/0.16),0_24px_60px_-20px_rgb(15_23_42/0.3)]",
        )}
      >
        {/* HUD corner ticks */}
        <Corner className="left-2 top-2" />
        <Corner className="right-2 top-2 rotate-90" />
        <Corner className="bottom-2 right-2 rotate-180" />
        <Corner className="bottom-2 left-2 -rotate-90" />

        <header className="flex items-center gap-2.5 px-4 pb-2.5 pt-3.5">
          {Icon && (
            <span
              className={clsx(
                "grid h-7 w-7 place-items-center rounded-[10px] shadow-[inset_0_1px_0_rgb(255_255_255),0_2px_6px_-2px_rgb(15_23_42/0.18)] transition-colors",
                possessed ? "bg-mint text-white" : "bg-white/80 text-ivory-dim",
              )}
            >
              <Icon size={13} strokeWidth={2.2} />
            </span>
          )}
          <h3 className="min-w-0 flex-1 truncate font-display text-[12.5px] font-semibold tracking-[0.04em] text-ivory">{title}</h3>
          {badge}
          {onClose && (
            <button
              onClick={onClose}
              className="grid h-7 w-7 place-items-center rounded-full text-mute opacity-0 transition hover:bg-white/80 hover:text-ivory group-hover:opacity-100 focus-visible:opacity-100"
              aria-label={`Close ${title ?? "widget"}`}
            >
              <X size={13} />
            </button>
          )}
        </header>
        <div className="min-h-0 flex-1 px-4 pb-4">{children}</div>
      </div>
    </motion.div>
  );
}

function Corner({ className }: { className?: string }) {
  return (
    <span aria-hidden className={clsx("pointer-events-none absolute h-2.5 w-2.5 rounded-tl-[3px] border-l border-t border-ivory/15", className)} />
  );
}

export function Badge({ tone = "mute", children, pulse }: { tone?: "mint" | "amber" | "coral" | "violet" | "mute"; children: ReactNode; pulse?: boolean }) {
  const tones: Record<string, string> = {
    mint: "text-mint border-mint/25 bg-mint/10",
    amber: "text-amber border-amber/25 bg-amber/10",
    coral: "text-coral border-coral/25 bg-coral/10",
    violet: "text-violet border-violet/25 bg-violet/10",
    mute: "text-ivory-dim border-line bg-white/60",
  };
  const dot: Record<string, string> = { mint: "bg-mint", amber: "bg-amber", coral: "bg-coral", violet: "bg-violet", mute: "bg-mute" };
  return (
    <span className={clsx("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.12em]", tones[tone])}>
      <span className={clsx("h-1.5 w-1.5 rounded-full", dot[tone], pulse && "animate-pulse")} />
      {children}
    </span>
  );
}
