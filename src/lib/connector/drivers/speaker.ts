/**
 * Speaker driver: speaker.say (speech synthesis, ≤280 chars) and speaker.chime (WebAudio tones).
 * enableSpeaker() must run inside a click handler: it unlocks audio on iOS/Safari.
 * Verification is "acknowledgment": the browser played it; nobody verified it was heard.
 */
import { InvokeError, type CapabilityModule } from "../types";
import { enumArg, numArg, sleep, strArg } from "../util";

export function speakerSupport(): { supported: boolean; reason?: string; speech: boolean } {
  if (typeof window === "undefined") return { supported: false, reason: "not in a browser", speech: false };
  const speech = "speechSynthesis" in window;
  const audio = !!(window.AudioContext ?? (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext);
  if (!speech && !audio) return { supported: false, reason: "No speech or audio output API", speech };
  return { supported: true, speech };
}

const CHIMES = {
  ding: [
    [880, 0, 0.35],
    [1318.5, 0.12, 0.6],
  ],
  success: [
    [523.25, 0, 0.18],
    [659.25, 0.12, 0.18],
    [783.99, 0.24, 0.5],
  ],
  alert: [
    [740, 0, 0.16],
    [740, 0.24, 0.16],
    [740, 0.48, 0.16],
  ],
  boo: [
    [392, 0, 0.5],
    [311.1, 0.25, 0.9],
  ],
} as const satisfies Record<string, readonly (readonly [number, number, number])[]>;

type ChimeName = keyof typeof CHIMES;

export async function enableSpeaker(opts: { label?: string; onSpeak?: (text: string | null) => void } = {}): Promise<CapabilityModule> {
  const s = speakerSupport();
  if (!s.supported) throw new Error(s.reason);
  const AC: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  const ac = AC ? new AC() : null;
  // Unlock inside the user gesture: a silent buffer + an empty utterance.
  if (ac) {
    try {
      await ac.resume();
      const b = ac.createBuffer(1, 1, 22050);
      const src = ac.createBufferSource();
      src.buffer = b;
      src.connect(ac.destination);
      src.start(0);
    } catch {}
  }
  if (s.speech) {
    try {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch {}
  }
  let disposed = false;

  const caps: CapabilityModule["capabilities"] = [];
  if (s.speech) {
    caps.push({
      capability_id: "speaker.say",
      kind: "act",
      semantic_type: "speech.say",
      title: "Say something out loud",
      description:
        "Speak a short text (≤280 characters) through this device's speaker with the browser's text-to-speech. Acknowledgment only: playback is not verified as heard.",
      input_schema: {
        type: "object",
        properties: {
          text: { type: "string", maxLength: 280 },
          rate: { type: "number", minimum: 0.5, maximum: 1.6, default: 1 },
          lang: { type: "string", description: "BCP-47 language, e.g. en-US" },
        },
        required: ["text"],
        additionalProperties: false,
      },
      verification: "acknowledgment",
      concurrency_group: "speaker",
      limits: { rate_per_min: 12 },
      estimated_ms: 4000,
    });
  }
  if (ac) {
    caps.push({
      capability_id: "speaker.chime",
      kind: "act",
      semantic_type: "sound.play",
      title: "Play a chime",
      description: "Play a short (≤1.5 s) chime: ding, success, alert or boo. Acknowledgment only.",
      input_schema: {
        type: "object",
        properties: { tone: { type: "string", enum: Object.keys(CHIMES), default: "ding" } },
        additionalProperties: false,
      },
      verification: "acknowledgment",
      concurrency_group: "speaker",
      estimated_ms: 1200,
    });
  }

  return {
    id: "speaker",
    label: opts.label ?? "Speaker",
    capabilities: caps,
    async handle(capability_id, args, ctx) {
      if (disposed) throw new InvokeError("speaker was turned off by the owner", "failed");
      if (capability_id === "speaker.say") {
        const text = strArg(args, "text", { maxLen: 280, required: true })!.trim();
        const rate = numArg(args, "rate", { min: 0.5, max: 1.6, def: 1 });
        const lang = strArg(args, "lang", { maxLen: 16 });
        const u = new SpeechSynthesisUtterance(text);
        u.rate = rate;
        if (lang) u.lang = lang;
        opts.onSpeak?.(text);
        try {
          speechSynthesis.cancel();
          let started = false;
          const done = new Promise<"ended" | "error">((resolve) => {
            u.onstart = () => (started = true);
            u.onend = () => resolve("ended");
            u.onerror = () => resolve("error");
          });
          speechSynthesis.speak(u);
          // Bounded wait: ~80 ms/char + 2 s, ≤ 20 s, and never past the deadline.
          const budget = Math.min(ctx.remainingMs() - 150, 20_000, 2000 + text.length * 80);
          const notStarted = sleep(Math.min(3000, Math.max(300, budget)), ctx.signal).then(() => (started ? null : ("no-start" as const)));
          const timeout = sleep(Math.max(300, budget), ctx.signal).then(() => "timeout" as const);
          const outcome = await Promise.race([done, notStarted.then((v) => v ?? timeout), timeout]);
          if (outcome !== "ended") speechSynthesis.cancel();
          if (outcome === "error") throw new InvokeError("speech synthesis failed (the browser may need a tap to unlock audio)", "failed");
          if (outcome === "no-start") throw new InvokeError("speech synthesis did not start on this device (no voice available or audio locked)", "failed");
          return {
            value: text,
            captured_at: new Date().toISOString(),
            data: { chars: text.length, finished: outcome === "ended" },
            note:
              outcome === "ended"
                ? "The browser finished speaking. Not verified as heard."
                : "Speech was cut off at the time limit. Not verified as heard.",
          };
        } finally {
          opts.onSpeak?.(null);
        }
      }
      if (capability_id === "speaker.chime") {
        if (!ac) throw new InvokeError("no audio output", "failed");
        const tone: ChimeName = enumArg(args, "tone", Object.keys(CHIMES) as ChimeName[]) ?? "ding";
        if (ac.state === "suspended") await ac.resume().catch(() => {});
        const t0 = ac.currentTime + 0.03;
        let end = 0;
        for (const [freq, at, dur] of CHIMES[tone]) {
          const osc = ac.createOscillator();
          const g = ac.createGain();
          osc.type = "sine";
          osc.frequency.value = freq;
          g.gain.setValueAtTime(0.0001, t0 + at);
          g.gain.exponentialRampToValueAtTime(0.35, t0 + at + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
          osc.connect(g).connect(ac.destination);
          osc.start(t0 + at);
          osc.stop(t0 + at + dur + 0.05);
          end = Math.max(end, at + dur);
        }
        await sleep(end * 1000 + 80, ctx.signal);
        return {
          value: tone,
          captured_at: new Date().toISOString(),
          note: ac.state === "running" ? "Chime played. Not verified as heard." : `Audio context is ${ac.state}; the chime may have been silent.`,
        };
      }
      throw new InvokeError(`unknown capability ${capability_id}`, "rejected");
    },
    dispose() {
      disposed = true;
      try {
        speechSynthesis?.cancel();
      } catch {}
      void ac?.close().catch(() => {});
    },
  };
}
