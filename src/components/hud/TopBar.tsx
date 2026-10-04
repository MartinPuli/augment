"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { Brain, KeyRound, Zap } from "lucide";
import { useGhost } from "@/lib/store";
import { Icon, type IconNode } from "@/components/ui/Icon";
import { ease, haptic, spring } from "@/components/ui/motion";

/**
 * Deliberately quiet: only the brain switch is always there (Connectors lives in the voice dock).
 * Access and spending chips appear only while they matter (a lease is counting down, a budget is set).
 */
export function TopBar() {
  const me = useGhost((s) => s.me);
  const budget = useGhost((s) => s.budget);
  const leases = useGhost((s) => s.leases);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const active = Object.values(leases).filter((l) => l.state === "active" && l.ends_at && new Date(l.ends_at).getTime() > now);
  const soonest = active.reduce<number | null>((m, l) => {
    const r = new Date(l.ends_at!).getTime() - now;
    return m === null ? r : Math.min(m, r);
  }, null);
  const remaining = Math.max(0, budget.limit_cents - budget.spent_cents);

  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-40 flex items-start justify-end gap-2 px-3 pt-[max(12px,env(safe-area-inset-top))] sm:px-5 sm:pt-4">
      <AnimatePresence initial={false}>
        {budget.goal && (
          <motion.div
            key="budget"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6, transition: { duration: 0.15 } }}
            transition={{ duration: 0.24, ease: ease.standard }}
            className="ghost-chip pointer-events-auto mr-auto hidden h-10 min-w-0 max-w-[420px] items-center gap-3 rounded-full pl-4 pr-3 md:flex"
            title={`Spending budget · ${me ? `ledger balance $${(me.balance_cents / 100).toFixed(2)} (test funds)` : "test funds"}`}
          >
            <span className="truncate text-body-sm text-fg">{budget.goal}</span>
            <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-tint">
              <span
                className="block h-full rounded-full bg-amber transition-[width] duration-300"
                style={{
                  width: `${Math.min(100, (budget.spent_cents / Math.max(1, budget.limit_cents)) * 100)}%`,
                }}
              />
            </span>
            <span className="shrink-0 text-caption tabular-nums text-fg-2">${(remaining / 100).toFixed(2)} left</span>
          </motion.div>
        )}
        {active.length > 0 && (
          <motion.span
            key="lease"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.15 } }}
            transition={spring.snappy}
            title="Polty is borrowing a device · time left on the lease"
            className="ghost-chip pointer-events-auto inline-flex h-10 items-center gap-1.5 rounded-full px-3.5 text-caption font-medium tabular-nums text-mint"
          >
            <Icon icon={KeyRound} size={13} className="animate-pulse" />
            {active.length > 1 ? `${active.length} · ` : ""}
            {Math.ceil((soonest ?? 0) / 1000)}s
          </motion.span>
        )}
      </AnimatePresence>
      <BrainToggle />
    </header>
  );
}

/** Which Claude drives Polty: Haiku for snappy replies, Opus for multi-step tasks. */
function BrainToggle() {
  const brain = useGhost((s) => s.brain);
  const opts: {
    id: "fast" | "deep";
    label: string;
    icon: IconNode;
    title: string;
  }[] = [
    {
      id: "fast",
      label: "Fast",
      icon: Zap,
      title: "Fast — Claude Haiku 4.5, quickest replies",
    },
    {
      id: "deep",
      label: "Deep",
      icon: Brain,
      title: "Deep — Claude Opus 5.5, best for multi-step tasks",
    },
  ];
  return (
    <div role="radiogroup" aria-label="Polty's brain" className="ghost-chip pointer-events-auto relative flex h-10 items-center gap-0.5 rounded-full p-1">
      {opts.map((o) => {
        const on = brain === o.id;
        return (
          <button
            key={o.id}
            role="radio"
            aria-checked={on}
            title={o.title}
            onClick={() => {
              if (on) return;
              haptic();
              useGhost.getState().set({ brain: o.id });
            }}
            className={clsx(
              "relative z-10 inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-caption font-medium transition-colors duration-150",
              on ? "text-fg-inverse" : "text-fg-2 hover:text-fg",
            )}
          >
            {on && (
              <motion.span
                layoutId="brain-pill"
                className={clsx("absolute inset-0 -z-10 rounded-full shadow-pop", o.id === "deep" ? "bg-violet" : "bg-fg")}
                transition={spring.snappy}
              />
            )}
            <Icon icon={o.icon} size={13} strokeWidth={2.2} />
            <span>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
