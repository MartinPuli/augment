"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowUp, Keyboard, Mic, MessagesSquare, Square, Waves } from "lucide-react";
import { levels, useGhost } from "@/lib/store";
import { cancelRun, sendToPolty } from "@/lib/agent/runtime";
import { listener } from "@/lib/voice/listener";
import { speaker } from "@/lib/voice/speaker";

/**
 * The voice dock: tap (or hold Space) to talk, hands-free mode, typed fallback, live captions.
 */
export function VoiceDock() {
  const activity = useGhost((s) => s.activity);
  const caption = useGhost((s) => s.caption);
  const running = useGhost((s) => s.running);
  const handsFree = useGhost((s) => s.handsFree);
  const error = useGhost((s) => s.error);
  const voiceProvider = useGhost((s) => s.voiceProvider);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const listening = activity === "listening";

  const deliver = useCallback((text: string) => {
    void sendToPolty(text);
  }, []);

  const startListening = useCallback(
    (mode: "ptt" | "handsfree") => {
      speaker?.unlock();
      speaker?.stop();
      if (running) cancelRun();
      listener?.start(mode, (t) => {
        if (mode === "handsfree") {
          listener.pause();
          speaker?.stop();
        }
        deliver(t);
      });
    },
    [deliver, running],
  );

  const toggleMic = useCallback(() => {
    if (listener?.listening && !useGhost.getState().handsFree) listener.finish();
    else if (listener?.listening) {
      listener.stop();
      useGhost.getState().set({ handsFree: false });
    } else startListening("ptt");
  }, [startListening]);

  const toggleHandsFree = () => {
    const next = !handsFree;
    useGhost.getState().set({ handsFree: next });
    if (next) startListening("handsfree");
    else listener?.stop();
  };

  // Hold Space to talk (when not typing in a field).
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

  // Mic level ring.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const l = listening ? levels.mic : activity === "speaking" ? levels.speech : 0;
      if (ringRef.current) ringRef.current.style.transform = `scale(${1 + l * 0.55})`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [listening, activity]);

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
    speaker?.unlock();
    setDraft("");
    deliver(t);
  };

  const status = listening ? "Listening" : activity === "thinking" ? "Thinking" : activity === "acting" ? "Working" : activity === "speaking" ? "Speaking" : "Tap or hold space";

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex flex-col items-center gap-2 px-3 pb-[max(14px,env(safe-area-inset-bottom))]">
      <AnimatePresence>
        {error && (
          <motion.button
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            onClick={() => useGhost.getState().set({ error: null })}
            className="pointer-events-auto max-w-[680px] rounded-full border border-coral/40 bg-ink-2/95 px-4 py-1.5 text-[12px] text-coral backdrop-blur"
          >
            {error}
          </motion.button>
        )}
      </AnimatePresence>

      <motion.div layout className="ghost-glass pointer-events-auto flex w-full max-w-[760px] items-center gap-3 rounded-[30px] p-2 pr-3">
        {/* mic */}
        <button
          onClick={toggleMic}
          className="relative grid h-14 w-14 shrink-0 place-items-center rounded-full"
          aria-label={listening ? "Send" : "Talk to Polty"}
        >
          <div
            ref={ringRef}
            className={clsx(
              "absolute inset-0 rounded-full transition-colors duration-300",
              listening ? "bg-mint/25" : activity === "speaking" ? "bg-ivory/15" : activity === "thinking" || activity === "acting" ? "bg-violet/20" : "bg-ink-4",
            )}
          />
          {listening && <span className="absolute inset-0 animate-pulse-ring rounded-full border border-mint/60" />}
          <span
            className={clsx(
              "relative grid h-11 w-11 place-items-center rounded-full transition-colors duration-300",
              listening ? "bg-mint text-ink" : "bg-ivory text-ink",
            )}
          >
            {listening ? <Waves size={19} /> : <Mic size={19} />}
          </span>
        </button>

        {/* caption / input */}
        <div className="min-w-0 flex-1">
          {typing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
              className="flex items-center gap-2"
            >
              <input
                ref={inputRef}
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Ask Polty to find, see, touch or switch something…"
                className="h-11 min-w-0 flex-1 bg-transparent text-[15px] text-ivory outline-none placeholder:text-mute"
              />
              <button type="submit" className="grid h-9 w-9 place-items-center rounded-full bg-ivory text-ink disabled:opacity-30" disabled={!draft.trim()} aria-label="Send">
                <ArrowUp size={16} />
              </button>
            </form>
          ) : (
            <div className="flex h-12 flex-col justify-center">
              <div className="hud-label flex items-center gap-2">
                <span className={clsx("h-1.5 w-1.5 rounded-full", listening ? "bg-mint animate-pulse" : running ? "bg-violet animate-pulse" : "bg-mute")} />
                {status}
                {voiceProvider === "browser" && <span className="text-mute/70">· browser voice</span>}
              </div>
              <AnimatePresence mode="wait">
                <motion.p
                  key={caption ? `${caption.who}-${caption.text.slice(0, 12)}` : "empty"}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.18 }}
                  className={clsx("line-clamp-2 text-[14.5px] leading-snug", caption?.who === "user" ? "text-ivory-dim" : "text-ivory")}
                >
                  {caption ? (caption.who === "user" ? `“${caption.text}”` : caption.text) : <span className="text-mute">Say “Polty, what can you reach?”</span>}
                </motion.p>
              </AnimatePresence>
            </div>
          )}
        </div>

        {/* controls */}
        <div className="flex shrink-0 items-center gap-1">
          {(running || activity === "speaking") && (
            <IconBtn label="Stop" onClick={() => cancelRun()}>
              <Square size={14} fill="currentColor" />
            </IconBtn>
          )}
          <IconBtn label={handsFree ? "Hands-free on" : "Hands-free off"} onClick={toggleHandsFree} active={handsFree}>
            <span className="font-mono text-[10px] font-semibold">HF</span>
          </IconBtn>
          <IconBtn label="Type" onClick={() => setTyping((t) => !t)} active={typing}>
            <Keyboard size={16} />
          </IconBtn>
          <IconBtn label="Conversation" onClick={() => useGhost.getState().set({ drawer: !useGhost.getState().drawer })}>
            <MessagesSquare size={16} />
          </IconBtn>
        </div>
      </motion.div>
    </div>
  );
}

function IconBtn({ children, label, onClick, active }: { children: React.ReactNode; label: string; onClick: () => void; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={clsx(
        "grid h-9 w-9 place-items-center rounded-full transition",
        active ? "bg-mint/15 text-mint" : "text-ivory-dim hover:bg-ink-4 hover:text-ivory",
      )}
    >
      {children}
    </button>
  );
}
