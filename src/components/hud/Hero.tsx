"use client";

import { AnimatePresence, motion } from "motion/react";
import { useGhost } from "@/lib/store";
import { sendToPolty } from "@/lib/agent/runtime";
import { speaker } from "@/lib/voice/speaker";

const SUGGESTIONS = [
  { text: "Find a live camera on the Bay Bridge and track the trucks", tag: "public camera · YOLO" },
  { text: "Pair my phone so you can see and hear through it", tag: "phone" },
  { text: "What's on my Wi-Fi? Turn the lights purple", tag: "smart home" },
  { text: "Connect my Arduino and wave the servo", tag: "USB serial" },
  { text: "How high is the tide in San Francisco right now?", tag: "NOAA sensor" },
  { text: "Did I leave my keys at the workshop? You can spend up to $1", tag: "lease · test payment" },
];

/** Empty-canvas welcome: the logotype, the promise, and things to try. */
export function Hero() {
  const show = useGhost((s) => s.widgets.length === 0 && s.ui.length === 0);
  return (
    <AnimatePresence>
      {show && (
        <motion.section
          key="hero"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, y: -20, filter: "blur(10px)", transition: { duration: 0.4 } }}
          className="pointer-events-none fixed inset-x-0 top-[39vh] z-20 flex flex-col items-center px-4 text-center"
        >
          {/* soft mist so the type reads over the footage */}
          <div
            aria-hidden
            className="absolute left-1/2 top-[-18vh] -z-10 h-[78vh] w-[min(1100px,140vw)] -translate-x-1/2 bg-[radial-gradient(closest-side,rgb(248_250_248/0.82),rgb(248_250_248/0.55)_45%,rgb(248_250_248/0)_100%)] blur-2xl"
          />
          <motion.h1
            initial={{ opacity: 0, y: 16, letterSpacing: "0.6em" }}
            animate={{ opacity: 1, y: 0, letterSpacing: "0.32em" }}
            transition={{ duration: 1.1, ease: [0.2, 0.7, 0.2, 1] }}
            className="font-display text-[clamp(40px,7vw,84px)] font-extrabold leading-none text-ivory [text-shadow:0_1px_0_rgb(255_255_255/0.6),0_12px_40px_rgb(255_255_255/0.7)]"
          >
            GHOST
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.35, duration: 0.8 }}
            className="mt-3 max-w-[560px] text-balance text-[14px] font-medium leading-relaxed text-ivory-dim sm:mt-4 sm:text-[17px]"
          >
            Your agent knows what to do. <span className="font-semibold text-mint">Polty</span> finds it the eyes, hands and instruments to do it — then gives them back.
          </motion.p>
          <motion.ul
            initial="hidden"
            animate="show"
            variants={{ show: { transition: { staggerChildren: 0.06, delayChildren: 0.6 } } }}
            className="pointer-events-auto mt-7 flex max-w-[880px] flex-wrap justify-center gap-2"
          >
            {SUGGESTIONS.map((s, i) => (
              <motion.li key={s.text} variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }} className={i >= 4 ? "hidden sm:block" : undefined}>
                <button
                  onClick={() => {
                    speaker?.unlock();
                    void sendToPolty(s.text);
                  }}
                  className="ghost-chip group flex items-center gap-2 rounded-[18px] px-3.5 py-1.5 text-left text-[12.5px] font-medium text-ivory transition hover:-translate-y-0.5 hover:bg-white/85 hover:shadow-[inset_0_1px_0_rgb(255_255_255),0_14px_30px_-14px_rgb(15_23_42/0.4)] sm:rounded-full sm:px-4 sm:py-2 sm:text-[13px]"
                >
                  <span>{s.text}</span>
                  <span className="hidden font-mono text-[9.5px] uppercase tracking-[0.14em] text-mute group-hover:text-mint sm:inline">{s.tag}</span>
                </button>
              </motion.li>
            ))}
          </motion.ul>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
