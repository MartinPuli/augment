"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowUp, Square } from "lucide";
import { useGhost } from "@/lib/store";
import { cancelRun, sendToPolty } from "@/lib/agent/runtime";
import { listener, type ListenMode } from "@/lib/voice/listener";
import { speaker } from "@/lib/voice/speaker";
import { Icon, type IconNode } from "@/components/ui/Icon";
import { duration, ease, haptic, spring } from "@/components/ui/motion";
import { VoiceOrb, type OrbTone } from "./VoiceOrb";

/**
 * The voice dock: one microphone in the middle (tap, or hold Space, to talk). Polty answers by voice, so there is no visible transcript: the caption is kept for screen
 * readers only. A Stop button appears only while Polty is working or speaking. To type instead,
 * just start typing anywhere — a field opens above the mic.
 *
 * Its measured height is published as `--dock-h`, which the hero and canvas use to stay clear.
 */
export function VoiceDock() {
  const activity = useGhost((s) => s.activity);
  const caption = useGhost((s) => s.caption);
  const running = useGhost((s) => s.running);
  const handsFree = useGhost((s) => s.handsFree);
  const error = useGhost((s) => s.error);
  const toolStatus = useGhost((s) => s.toolStatus);
  const liveSession = useGhost((s) => (s as { liveSession?: "off" | "connecting" | "live" }).liveSession ?? "off");
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const listening = activity === "listening";
  const busy = running || activity === "speaking" || activity === "thinking" || activity === "acting";

  // Publish the dock height for the layout above it.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty("--dock-h", `${Math.ceil(el.getBoundingClientRect().height)}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const deliver = useCallback((text: string) => {
    void sendToPolty(text);
  }, []);

  const startListening = useCallback(
    (mode: ListenMode) => {
      speaker?.unlock();
      speaker?.stop();
      if (running) cancelRun();
      listener?.start(mode, (t) => {
        if (mode === "handsfree") {
          listener.pause();
          speaker?.stop();
        }
        haptic(10);
        deliver(t);
      });
    },
    [deliver, running],
  );

  const toggleMic = useCallback(() => {
    haptic();
    setTyping(false);
    if (listener?.listening && !useGhost.getState().handsFree) listener.finish();
    else if (listener?.listening) {
      listener.stop();
      useGhost.getState().set({ handsFree: false });
    } else startListening("tap");
  }, [startListening]);

  // Hold Space to talk (when not typing in a field); Escape stops everything.
  useEffect(() => {
    let held = false;
    const isField = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || isField(e.target)) return;
      e.preventDefault();
      held = true;
      if (!listener?.listening) startListening("ptt");
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !held) return;
      held = false;
      if (!useGhost.getState().handsFree) listener?.finish();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        cancelRun();
        listener?.stop();
        setTyping(false);
        return;
      }
      // Type to talk: any printable key outside a field opens the message field with that key.
      if (e.key.length === 1 && e.key !== " " && !e.metaKey && !e.ctrlKey && !e.altKey && !isField(e.target) && !document.querySelector("[role=dialog]")) {
        e.preventDefault();
        setDraft((d) => d + e.key);
        setTyping(true);
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("keydown", esc);
    };
  }, [startListening]);

  // In hands-free mode, resume listening after Polty finishes speaking.
  useEffect(() => {
    if (!handsFree || running || activity !== "idle") return;
    const t = setTimeout(() => {
      if (useGhost.getState().handsFree && !listener?.listening) startListening("handsfree");
    }, 400);
    return () => clearTimeout(t);
  }, [handsFree, running, activity, startListening]);

  const submit = () => {
    const t = draft.trim();
    if (!t) return;
    haptic(10);
    speaker?.unlock();
    setDraft("");
    setTyping(false);
    deliver(t);
  };

  const tone: OrbTone = listening ? "listen" : activity === "speaking" ? "speak" : activity === "thinking" || activity === "acting" ? "think" : "idle";
  const live = liveSession === "live";
  const status = live
    ? listening
      ? "Live · just talk, tap to end"
      : "Live"
    : liveSession === "connecting"
      ? "Connecting…"
      : listening
        ? "Listening · tap to send"
        : activity === "acting"
          ? (toolStatus ?? "Working…")
          : activity === "thinking"
            ? (toolStatus ?? "Thinking…")
            : activity === "speaking"
              ? "Speaking · tap to interrupt"
              : null;

  return (
    <div
      ref={rootRef}
      data-voice-dock
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex flex-col items-center px-3 pb-[max(14px,env(safe-area-inset-bottom))] sm:pb-5"
    >
      {/* soft floor so captions stay legible over canvas content */}
      <div aria-hidden className="absolute inset-x-0 bottom-0 -z-10 h-[130%] bg-gradient-to-t from-[rgb(246_245_241/0.92)] via-[rgb(246_245_241/0.6)] to-transparent" />

      <AnimatePresence>
        {error && (
          <motion.button
            key="error"
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, transition: { duration: duration.fast } }}
            transition={spring.gentle}
            onClick={() => useGhost.getState().set({ error: null })}
            title="Dismiss"
            className="ghost-chip pointer-events-auto absolute bottom-full mb-2 max-w-[min(640px,calc(100vw-24px))] rounded-2xl px-4 py-2 text-left text-body-sm font-medium text-coral"
          >
            {error}
          </motion.button>
        )}
      </AnimatePresence>

      {/* Polty answers by voice: the caption is for screen readers only (and voice tests read it). */}
      <div className="sr-only" aria-live="polite">
        <Caption caption={caption} />
      </div>

      {/* the message field, while typing */}
      <div className="flex w-full max-w-[560px] items-end justify-center">
        <AnimatePresence mode="wait" initial={false}>
          {typing ? (
            <motion.form
              key="type"
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{
                opacity: 0,
                y: 6,
                transition: { duration: duration.fast },
              }}
              transition={spring.gentle}
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
              className="ghost-chip pointer-events-auto flex h-12 w-full items-center gap-2 rounded-full pl-5 pr-1.5 focus-within:ring-2 focus-within:ring-mint/25"
            >
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => !draft.trim() && setTyping(false)}
                placeholder="Ask Polty anything…"
                aria-label="Message Polty"
                className="h-full min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-fg-3"
              />
              <button
                type="submit"
                disabled={!draft.trim()}
                aria-label="Send"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-fg text-fg-inverse shadow-pop transition-[opacity,transform] duration-150 active:scale-90 disabled:opacity-25 disabled:shadow-none"
              >
                <Icon icon={ArrowUp} size={16} strokeWidth={2.2} />
              </button>
            </motion.form>
          ) : null}
        </AnimatePresence>
      </div>

      {/* the microphone, Connectors beside it, Stop only while Polty is busy */}
      <div className={clsx("pointer-events-auto grid grid-cols-[3rem_auto_3rem] items-center gap-5 sm:gap-7", typing && "mt-3")}>
        <div className="grid place-items-center">
          <AnimatePresence>
            {busy && (
              <RoundButton
                key="stop"
                label="Stop"
                icon={Square}
                tone="stop"
                onClick={() => {
                  haptic();
                  cancelRun();
                }}
              />
            )}
          </AnimatePresence>
        </div>
        <VoiceOrb tone={tone} label={listening ? (live ? "End live session" : "Send") : "Talk to Polty"} onPress={toggleMic} />
        <div aria-hidden />
      </div>

      {/* status line */}
      <div className="mt-2.5 flex h-5 items-center justify-center text-caption text-fg-3" aria-live="polite">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={status ?? "hint"}
            initial={{ opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{
              opacity: 0,
              y: -3,
              transition: { duration: duration.instant },
            }}
            transition={{ duration: duration.fast, ease: ease.standard }}
            className="flex items-center gap-1.5 whitespace-nowrap"
          >
            {status ? (
              <>
                <span
                  className={clsx("h-1.5 w-1.5 rounded-full", listening || live ? "animate-pulse bg-mint" : activity === "speaking" ? "bg-violet-glow" : "animate-pulse bg-violet")}
                />
                <span className="max-w-[78vw] truncate">{status}</span>
              </>
            ) : (
              <>
                <span className="sm:hidden">Tap the mic to talk</span>
                <span className="hidden sm:inline">
                  Tap the mic, hold <kbd className="mx-0.5 rounded-md bg-tint px-1.5 py-px font-sans text-micro font-medium text-fg-2">space</kbd>, or just start typing
                </span>
              </>
            )}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}

/** Polty's (or your) latest words — rendered for assistive tech, kept as `p.line-clamp-2`. */
function Caption({ caption }: { caption: { who: "user" | "polty"; text: string; interim?: boolean } | null }) {
  return <p className="line-clamp-2">{caption?.text ?? ""}</p>;
}

/** A quiet round glass button with a tooltip-style label; ≥44px touch target. */
function RoundButton({ label, icon, onClick, tone = "plain", layoutId }: { label: string; icon: IconNode; onClick: () => void; tone?: "plain" | "stop"; layoutId?: string }) {
  return (
    <motion.button
      type="button"
      layoutId={layoutId}
      onClick={onClick}
      aria-label={label}
      title={label}
      initial={layoutId ? false : { opacity: 0, scale: 0.6 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.6, transition: { duration: duration.fast } }}
      whileHover={{ scale: 1.06 }}
      whileTap={{ scale: 0.9 }}
      transition={spring.snappy}
      style={{ borderRadius: 999 }}
      className={clsx(
        "ghost-chip group relative grid h-11 w-11 place-items-center transition-colors duration-150",
        tone === "stop" ? "text-coral" : "text-fg-2 hover:bg-white/90 hover:text-fg",
      )}
    >
      <Icon icon={icon} size={18} strokeWidth={1.9} spring="snappy" />
      <span className="pointer-events-none absolute -top-8 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded-full bg-fg px-2 py-1 text-micro font-medium tracking-normal text-fg-inverse opacity-0 shadow-pop transition-opacity duration-150 group-hover:opacity-100 sm:block">
        {label}
      </span>
    </motion.button>
  );
}
