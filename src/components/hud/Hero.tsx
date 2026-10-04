"use client";

import { AnimatePresence, motion } from "motion/react";
import { CalendarDays, Cctv } from "lucide";
import { useGhost } from "@/lib/store";
import { sendToPolty } from "@/lib/agent/runtime";
import { speaker } from "@/lib/voice/speaker";
import { Illustration } from "@/components/ui/Illustration";
import { duration, ease, haptic } from "@/components/ui/motion";
import type { IconNode } from "@/components/ui/Icon";
import type { IllustrationName } from "@/components/ui/illustrations";

const HEADLINE = "Hey, how are you doing today?";

const SUGGESTIONS: {
  label: string;
  prompt: string;
  art: IllustrationName;
  icon: IconNode;
}[] = [
  {
    label: "What does my day look like?",
    prompt: "What does my day look like?",
    art: "calendar",
    icon: CalendarDays,
  },
  {
    label: "Show me the Bay Bridge, live",
    prompt: "Find a live camera on the Bay Bridge and show it to me",
    art: "bridge",
    icon: Cctv,
  },
];

/**
 * Empty-canvas welcome. Polty floats into the reserved slot at the top (PoltyStage measures
 * `data-polty-anchor`), then a conversational greeting, one line of subtext and two suggestions.
 * The section ends where the voice dock begins (`--dock-h`), so the two can never overlap.
 */
export function Hero() {
  const show = useGhost((s) => s.widgets.length === 0 && s.ui.length === 0);
  return (
    <AnimatePresence>
      {show && (
        <motion.section
          key="hero"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{
            opacity: 0,
            y: -16,
            filter: "blur(8px)",
            transition: { duration: duration.base, ease: ease.standard },
          }}
          className="pointer-events-none fixed inset-x-0 top-0 z-20 flex flex-col items-center justify-center px-5 pb-4 pt-[max(64px,calc(env(safe-area-inset-top)+56px))] text-center"
          style={{ bottom: "var(--dock-h)" }}
        >
          {/* soft mist so the type reads over the footage */}
          <div
            aria-hidden
            className="absolute left-1/2 top-1/2 -z-10 h-[80%] w-[min(980px,140vw)] -translate-x-1/2 -translate-y-1/2 bg-[radial-gradient(closest-side,rgb(248_247_243/0.8),rgb(248_247_243/0.5)_50%,rgb(248_247_243/0)_100%)] blur-2xl"
          />

          {/* Polty lands here */}
          <div data-polty-anchor aria-hidden className="mb-3 aspect-[240/260] h-[clamp(84px,19vh,172px)] shrink-0 sm:mb-5" />

          <h1 className="max-w-[16ch] text-balance font-display text-display text-fg sm:max-w-none" aria-label={HEADLINE}>
            {HEADLINE.split(" ").map((w, i) => (
              <motion.span
                key={i}
                aria-hidden
                className="inline-block whitespace-pre"
                initial={{ opacity: 0, y: 12, filter: "blur(8px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                transition={{
                  delay: 0.15 + i * 0.07,
                  duration: duration.celebratory,
                  ease: ease.standard,
                }}
              >
                {i ? ` ${w}` : w}
              </motion.span>
            ))}
          </h1>

          <motion.p
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              delay: 0.55,
              duration: duration.deliberate,
              ease: ease.standard,
            }}
            className="mt-3 text-body-lg text-fg-2 sm:mt-4 sm:text-[1.0625rem]"
          >
            What are you looking for today?
          </motion.p>

          <motion.ul
            initial="hidden"
            animate="show"
            variants={{
              show: {
                transition: { staggerChildren: 0.06, delayChildren: 0.75 },
              },
            }}
            className="pointer-events-auto mt-6 flex w-full max-w-[560px] flex-col items-stretch gap-2 sm:mt-8 sm:flex-row sm:justify-center [@media(max-height:540px)]:hidden"
          >
            {SUGGESTIONS.map((s) => (
              <motion.li
                key={s.label}
                variants={{
                  hidden: { opacity: 0, y: 10 },
                  show: {
                    opacity: 1,
                    y: 0,
                    transition: {
                      duration: duration.deliberate,
                      ease: ease.standard,
                    },
                  },
                }}
              >
                <button
                  onClick={() => {
                    haptic();
                    speaker?.unlock();
                    void sendToPolty(s.prompt);
                  }}
                  className="ghost-chip group flex h-12 w-full items-center gap-2.5 rounded-full pl-1.5 pr-5 text-left text-body-sm font-medium text-fg transition-[transform,background-color,box-shadow] duration-200 ease-standard hover:-translate-y-0.5 hover:bg-white/85 active:scale-[0.97] active:duration-100 sm:w-auto"
                >
                  <span className="grid h-9 w-9 place-items-center rounded-full bg-white/70 transition-transform duration-300 ease-standard group-hover:rotate-[-6deg] group-hover:scale-110">
                    <Illustration name={s.art} size={30} fallback={s.icon} priority />
                  </span>
                  <span className="truncate">{s.label}</span>
                </button>
              </motion.li>
            ))}
          </motion.ul>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
