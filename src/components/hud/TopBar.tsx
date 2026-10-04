"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import clsx from "clsx";
import { motion } from "motion/react";
import { Brain, Cpu, KeyRound, RotateCcw, Settings2, Wallet, Zap } from "lucide-react";
import { useGhost } from "@/lib/store";
import { resetSession } from "@/lib/agent/runtime";
import { PoltyGlyph } from "@/components/mascot/Polty";

export function TopBar() {
  const me = useGhost((s) => s.me);
  const budget = useGhost((s) => s.budget);
  const devices = useGhost((s) => s.devices);
  const leases = useGhost((s) => s.leases);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const personal = Object.values(devices).filter((d) => !d.connector_id.startsWith("internal:") && d.online).length;
  const publicCount = Object.values(devices).filter((d) => d.access_type === "public_observation").length;
  const active = Object.values(leases).filter((l) => l.state === "active" && l.ends_at && new Date(l.ends_at).getTime() > now);
  const soonest = active.reduce<number | null>((m, l) => {
    const r = new Date(l.ends_at!).getTime() - now;
    return m === null ? r : Math.min(m, r);
  }, null);
  const remaining = Math.max(0, budget.limit_cents - budget.spent_cents);

  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-40 flex items-start justify-between gap-3 px-4 pt-[max(12px,env(safe-area-inset-top))] sm:px-6">
      <div className="ghost-chip pointer-events-auto flex h-11 items-center gap-2.5 rounded-full pl-2 pr-4">
        <span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-b from-[#2a2f36] to-[#121418] shadow-[inset_0_1px_0_rgb(255_255_255/0.18),0_4px_10px_-4px_rgb(15_23_42/0.5)]">
          <PoltyGlyph size={20} />
        </span>
        <div className="leading-none">
          <div className="font-display text-[14px] font-extrabold tracking-[0.2em] text-ivory sm:text-[15px]">GHOST</div>
          <div className="mt-1 hidden font-mono text-[9px] uppercase tracking-[0.2em] text-mute sm:block">give your agent a body</div>
        </div>
      </div>

      {budget.goal && (
        <div className="ghost-chip pointer-events-auto hidden h-11 max-w-[440px] flex-1 items-center gap-3 rounded-full px-4 md:flex">
          <span className="truncate text-[12.5px] text-ivory">{budget.goal}</span>
          <div className="ml-auto flex items-center gap-2">
            <div className="h-1.5 w-20 overflow-hidden rounded-full bg-ink-4">
              <div className="h-full rounded-full bg-amber transition-all" style={{ width: `${Math.min(100, (budget.spent_cents / Math.max(1, budget.limit_cents)) * 100)}%` }} />
            </div>
            <span className="font-mono text-[11px] text-ivory-dim">${(remaining / 100).toFixed(2)} left</span>
          </div>
        </div>
      )}

      <div className="pointer-events-auto flex shrink-0 items-center gap-1 sm:gap-1.5">
        <BrainToggle />
        <Link href="/devices" aria-label="Connect devices"><Chip compact icon={<Cpu size={12} />} label={`${personal} ${personal === 1 ? "body" : "bodies"}`} title={`Connect devices · ${personal} personal devices online · ${publicCount} public sources`} tone={personal ? "mint" : "mute"} /></Link>
        {active.length > 0 && <Chip icon={<KeyRound size={12} />} label={`${active.length} · ${Math.ceil((soonest ?? 0) / 1000)}s`} title="Active leases · time remaining" tone="mint" pulse />}
        {me && <Chip icon={<Wallet size={12} />} label={`$${(me.balance_cents / 100).toFixed(2)}`} title="Development ledger — test funds, not real money" tone="amber" />}
        <Link href="/owner" className="ghost-chip grid h-9 w-9 place-items-center rounded-full text-ivory-dim transition hover:bg-white/80 hover:text-ivory" title="Owner console" aria-label="Owner console">
          <Settings2 size={15} />
        </Link>
        <button onClick={() => resetSession()} className="ghost-chip hidden h-9 w-9 place-items-center rounded-full text-ivory-dim transition hover:bg-white/80 hover:text-ivory sm:grid" title="New session" aria-label="New session">
          <RotateCcw size={15} />
        </button>
      </div>
    </header>
  );
}

function Chip({ icon, label, title, tone, pulse, compact }: { icon: React.ReactNode; label: string; title: string; tone: "mint" | "amber" | "mute"; pulse?: boolean; compact?: boolean }) {
  return (
    <span
      title={title}
      className={clsx(
        "ghost-chip inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full px-3 font-mono text-[11px] font-medium",
        tone === "mint" ? "text-mint" : tone === "amber" ? "text-amber" : "text-ivory-dim",
      )}
    >
      <span className={clsx(pulse && "animate-pulse")}>{icon}</span>
      {compact ? (
        <>
          <span className="sm:hidden">{label.split(" ")[0]}</span>
          <span className="hidden sm:inline">{label}</span>
        </>
      ) : (
        label
      )}
    </span>
  );
}

/** Which Claude drives Polty: Haiku for snappy replies, Opus for multi-step missions. */
function BrainToggle() {
  const brain = useGhost((s) => s.brain);
  const opts = [
    { id: "fast", label: "Fast", icon: Zap, title: "Fast — Claude Haiku 4.5, quickest replies" },
    { id: "deep", label: "Deep", icon: Brain, title: "Deep — Claude Opus 5.5, best for multi-step tasks" },
  ] as const;
  return (
    <div role="radiogroup" aria-label="Polty's brain" className="ghost-chip relative flex h-9 items-center gap-0.5 rounded-full p-1">
      {opts.map((o) => {
        const on = brain === o.id;
        return (
          <button
            key={o.id}
            role="radio"
            aria-checked={on}
            title={o.title}
            onClick={() => useGhost.getState().set({ brain: o.id })}
            className={clsx(
              "relative z-10 inline-flex h-7 items-center gap-1 rounded-full px-2 font-mono text-[11px] font-medium transition-colors sm:px-2.5",
              on ? "text-ink" : "text-ivory-dim hover:text-ivory",
            )}
          >
            {on && (
              <motion.span
                layoutId="brain-pill"
                className={clsx("absolute inset-0 -z-10 rounded-full shadow-[0_4px_12px_-4px_rgb(15_23_42/0.45)]", o.id === "deep" ? "bg-violet" : "bg-ivory")}
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
              />
            )}
            <o.icon size={12} strokeWidth={2.4} aria-hidden />
            <span className="hidden sm:inline">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
