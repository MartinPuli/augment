"use client";

import { motion } from "motion/react";
import { X } from "lucide";
import type { ReactNode } from "react";
import clsx from "clsx";
import { Icon, type IconNode } from "@/components/ui/Icon";
import { ease, spring } from "@/components/ui/motion";

/**
 * Shell for every canvas widget: a clean glass card with a serif title, a focus ring while Polty is
 * looking at it, an ectoplasm sweep while Polty possesses it, and a materialize/dematerialize
 * transition. `data-widget-id` is how PoltyStage finds the card to fly to it (and how the canvas
 * brings it into view) — keep it.
 */
export function WidgetFrame({
  id,
  title,
  icon,
  badge,
  focused,
  possessed,
  className,
  onClose,
  children,
}: {
  id: string;
  title?: string;
  icon?: IconNode;
  badge?: ReactNode;
  focused: boolean;
  possessed: boolean;
  className?: string;
  onClose?: () => void;
  children: ReactNode;
}) {
  return (
    <motion.div
      layout
      data-widget-id={id}
      initial={{ opacity: 0, scale: 0.94, y: 18, filter: "blur(10px)" }}
      animate={{ opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }}
      exit={{
        opacity: 0,
        scale: 0.96,
        y: -8,
        filter: "blur(8px)",
        transition: { duration: 0.2, ease: ease.standard },
      }}
      transition={{ ...spring.gentle, layout: spring.gentle }}
      className={clsx("group relative min-w-0", className)}
    >
      {/* possession sweep */}
      <div
        aria-hidden
        className={clsx(
          "ghost-ring pointer-events-none absolute -inset-[2px] rounded-[calc(var(--radius-card)+2px)] transition-opacity duration-500",
          possessed ? "opacity-100" : "opacity-0",
        )}
        style={{
          background: "conic-gradient(from var(--sweep, 0deg), transparent 0deg, #a78bfa 24deg, #2dd4bf 62deg, #0f766e 96deg, transparent 130deg, transparent 360deg)",
          animation: possessed ? "ghost-sweep 1.6s linear infinite" : undefined,
        }}
      />
      <div
        className={clsx(
          "ghost-glass relative flex h-full flex-col overflow-hidden rounded-card transition-shadow duration-300 ease-standard",
          focused && "!shadow-[inset_0_1px_0_rgb(255_255_255/0.9),0_0_0_1.5px_rgb(15_118_110/0.35),0_0_0_6px_rgb(45_212_191/0.14),var(--shadow-float)]",
        )}
      >
        <header className="flex items-center gap-2.5 px-4 pb-2 pt-3.5 sm:px-5 sm:pt-4">
          {icon && (
            <span
              className={clsx("grid h-7 w-7 shrink-0 place-items-center rounded-full transition-colors duration-300", possessed ? "bg-mint text-fg-inverse" : "bg-tint text-fg-2")}
            >
              <Icon icon={icon} size={14} strokeWidth={2} />
            </span>
          )}
          <h3 className="min-w-0 flex-1 truncate font-serif text-heading text-fg">{title}</h3>
          {badge}
          {onClose && (
            <button
              onClick={onClose}
              className="-mr-1.5 grid h-9 w-9 shrink-0 place-items-center rounded-full text-fg-3 transition-[opacity,background-color,color] duration-150 hover:bg-tint hover:text-fg focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
              aria-label={`Close ${title ?? "widget"}`}
            >
              <Icon icon={X} size={15} />
            </button>
          )}
        </header>
        <div className="min-h-0 flex-1 px-4 pb-4 sm:px-5 sm:pb-5">{children}</div>
      </div>
    </motion.div>
  );
}

export function Badge({ tone = "mute", children, pulse }: { tone?: "mint" | "amber" | "coral" | "violet" | "mute"; children: ReactNode; pulse?: boolean }) {
  const tones: Record<string, string> = {
    mint: "text-mint bg-mint/10",
    amber: "text-amber bg-amber/10",
    coral: "text-coral bg-coral/10",
    violet: "text-violet bg-violet/10",
    mute: "text-fg-2 bg-tint",
  };
  const dot: Record<string, string> = {
    mint: "bg-mint",
    amber: "bg-amber",
    coral: "bg-coral",
    violet: "bg-violet",
    mute: "bg-fg-3",
  };
  return (
    <span className={clsx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-label font-medium", tones[tone])}>
      <span className={clsx("h-1.5 w-1.5 rounded-full", dot[tone], pulse && "animate-pulse")} />
      {children}
    </span>
  );
}
