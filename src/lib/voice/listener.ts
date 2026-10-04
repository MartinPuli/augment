"use client";

import { levels, useGhost } from "@/lib/store";

/* Minimal typings for the Web Speech API (not in lib.dom for all TS versions). */
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

type Ctor = new () => SpeechRecognitionLike;

function getCtor(): Ctor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: Ctor; webkitSpeechRecognition?: Ctor };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export const speechInputSupported = () => getCtor() !== null;

/**
 * Speech input. Push-to-talk (start/stop) or hands-free (continuous; utterances are sent after
 * a short pause). Also meters the microphone into `levels.mic` so Polty can react to your voice.
 */
class Listener {
  private rec: SpeechRecognitionLike | null = null;
  private active = false;
  private finalText = "";
  private interim = "";
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private onUtterance: ((text: string) => void) | null = null;
  private mode: "ptt" | "handsfree" = "ptt";
  private meter: { stream: MediaStream; ctx: AudioContext; raf: number } | null = null;

  get listening() {
    return this.active;
  }

  start(mode: "ptt" | "handsfree", onUtterance: (text: string) => void): boolean {
    const C = getCtor();
    if (!C) {
      useGhost.getState().set({ error: "Voice input needs Chrome or Edge. You can type instead." });
      return false;
    }
    this.stopRecognition();
    this.mode = mode;
    this.onUtterance = onUtterance;
    this.finalText = "";
    this.interim = "";
    const rec = new C();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      this.interim = interim;
      const text = (this.finalText + " " + interim).replace(/\s+/g, " ").trim();
      if (text) useGhost.getState().set({ caption: { who: "user", text, interim: true } });
      if (this.mode === "handsfree") this.scheduleSend();
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        useGhost.getState().set({ error: "Microphone permission denied. You can type instead." });
        this.active = false;
      }
    };
    rec.onend = () => {
      // Chrome ends sessions periodically; keep hands-free alive.
      if (this.active && this.mode === "handsfree") {
        try {
          rec.start();
        } catch {
          /* already started */
        }
      }
    };
    this.rec = rec;
    this.active = true;
    try {
      rec.start();
    } catch {
      /* ignore double start */
    }
    void this.startMeter();
    const g = useGhost.getState();
    g.set({ activity: "listening", caption: null, error: null });
    return true;
  }

  /** Push-to-talk release: send whatever was heard. */
  finish() {
    if (!this.active) return;
    const text = (this.finalText + " " + this.interim).replace(/\s+/g, " ").trim();
    this.stop();
    if (text) this.onUtterance?.(text);
    else useGhost.getState().set({ caption: null });
  }

  stop() {
    this.active = false;
    this.stopRecognition();
    this.stopMeter();
    const g = useGhost.getState();
    if (g.activity === "listening") g.set({ activity: g.running ? "thinking" : "idle" });
  }

  /** Temporarily ignore input (e.g. while Polty is speaking in hands-free mode). */
  pause() {
    this.finalText = "";
    this.interim = "";
    if (this.sendTimer) clearTimeout(this.sendTimer);
  }

  private scheduleSend() {
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.sendTimer = setTimeout(() => {
      const text = this.finalText.replace(/\s+/g, " ").trim();
      if (!text || this.interim.trim()) return;
      this.finalText = "";
      this.onUtterance?.(text);
    }, 900);
  }

  private stopRecognition() {
    if (this.sendTimer) clearTimeout(this.sendTimer);
    if (this.rec) {
      this.rec.onend = null;
      try {
        this.rec.abort();
      } catch {
        /* ignore */
      }
      this.rec = null;
    }
  }

  private async startMeter() {
    if (this.meter) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      const meter = { stream, ctx, raf: 0 };
      const tick = () => {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        levels.mic = Math.min(1, levels.mic * 0.6 + Math.min(1, Math.sqrt(sum / buf.length) * 6) * 0.4);
        meter.raf = requestAnimationFrame(tick);
      };
      meter.raf = requestAnimationFrame(tick);
      this.meter = meter;
      if (!this.active) this.stopMeter();
    } catch {
      /* metering is cosmetic */
    }
  }

  private stopMeter() {
    if (!this.meter) return;
    cancelAnimationFrame(this.meter.raf);
    this.meter.stream.getTracks().forEach((t) => t.stop());
    void this.meter.ctx.close();
    this.meter = null;
    levels.mic = 0;
  }
}

export const listener = typeof window !== "undefined" ? new Listener() : (null as unknown as Listener);
