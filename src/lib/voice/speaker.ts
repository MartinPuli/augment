"use client";

import { levels, useGhost } from "@/lib/store";

/**
 * Polty's voice. Sentences are queued as the model streams; each is synthesized as soon as it is
 * queued (prefetch) and played in order. ElevenLabs when configured, otherwise speechSynthesis.
 * Exposes the live output level in `levels.speech` for lip-sync.
 */
class Speaker {
  private queue: { text: string; audio: Promise<Blob | null> }[] = [];
  private playing = false;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private current: HTMLAudioElement | null = null;
  private provider: "elevenlabs" | "browser" | null = null;
  private generation = 0;
  private raf = 0;
  private fakeLevelTimer: ReturnType<typeof setInterval> | null = null;
  private idleResolvers: (() => void)[] = [];
  muted = false;

  async detect() {
    if (this.provider) return this.provider;
    try {
      const r = await fetch("/api/tts");
      const j = await r.json();
      this.provider = j.provider === "elevenlabs" ? "elevenlabs" : "browser";
    } catch {
      this.provider = "browser";
    }
    useGhost.getState().set({ voiceProvider: this.provider });
    return this.provider;
  }

  /** Must be called from a user gesture once, to unlock audio playback. */
  unlock() {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 512;
        this.analyser.connect(this.ctx.destination);
      } catch {
        /* no WebAudio */
      }
    }
    void this.ctx?.resume();
    void this.detect();
  }

  get isSpeaking() {
    return this.playing || this.queue.length > 0;
  }

  enqueue(text: string) {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean || this.muted) return;
    const gen = this.generation;
    const audio = this.provider === "elevenlabs" ? this.synthesize(clean, gen) : Promise.resolve(null);
    this.queue.push({ text: clean, audio });
    if (!this.playing) void this.pump(gen);
  }

  stop() {
    this.generation++;
    this.queue = [];
    if (this.current) {
      this.current.pause();
      this.current.src = "";
      this.current = null;
    }
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    this.playing = false;
    this.endLevel();
    this.flushIdle();
  }

  /** Resolves once everything queued has been spoken. */
  whenIdle(): Promise<void> {
    if (!this.isSpeaking) return Promise.resolve();
    return new Promise((r) => this.idleResolvers.push(r));
  }

  private flushIdle() {
    const rs = this.idleResolvers;
    this.idleResolvers = [];
    rs.forEach((r) => r());
  }

  private async synthesize(text: string, gen: number): Promise<Blob | null> {
    try {
      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok || gen !== this.generation) return null;
      return await r.blob();
    } catch {
      return null;
    }
  }

  private async pump(gen: number) {
    this.playing = true;
    const g = useGhost.getState();
    if (g.activity !== "listening") g.set({ activity: "speaking" });
    while (this.queue.length && gen === this.generation) {
      const item = this.queue.shift()!;
      const blob = await item.audio;
      if (gen !== this.generation) return;
      if (blob) await this.playBlob(blob, gen);
      else await this.speakBrowser(item.text, gen);
    }
    if (gen !== this.generation) return;
    this.playing = false;
    this.endLevel();
    const s = useGhost.getState();
    if (s.activity === "speaking") s.set({ activity: s.running ? "thinking" : "idle" });
    this.flushIdle();
  }

  private playBlob(blob: Blob, gen: number) {
    return new Promise<void>((resolve) => {
      const url = URL.createObjectURL(blob);
      const el = new Audio(url);
      this.current = el;
      if (this.ctx && this.analyser) {
        try {
          const src = this.ctx.createMediaElementSource(el);
          src.connect(this.analyser);
        } catch {
          /* already connected */
        }
      }
      const done = () => {
        URL.revokeObjectURL(url);
        if (this.current === el) this.current = null;
        resolve();
      };
      el.onended = done;
      el.onerror = done;
      el.play()
        .then(() => this.trackLevel(gen))
        .catch(() => done());
    });
  }

  private speakBrowser(text: string, gen: number) {
    return new Promise<void>((resolve) => {
      if (typeof speechSynthesis === "undefined") return resolve();
      const u = new SpeechSynthesisUtterance(text);
      const voices = speechSynthesis.getVoices();
      const preferred =
        voices.find((v) => /Samantha|Google US English|Aria|Jenny/i.test(v.name)) ||
        voices.find((v) => v.lang?.startsWith("en"));
      if (preferred) u.voice = preferred;
      u.rate = 1.04;
      u.pitch = 1.15;
      u.onend = () => {
        this.endLevel();
        resolve();
      };
      u.onerror = () => {
        this.endLevel();
        resolve();
      };
      // speechSynthesis gives no audio samples; animate the mouth with a plausible flutter.
      if (this.fakeLevelTimer) clearInterval(this.fakeLevelTimer);
      this.fakeLevelTimer = setInterval(() => {
        if (gen !== this.generation) return;
        levels.speech = 0.25 + Math.random() * 0.55;
      }, 90);
      speechSynthesis.speak(u);
    });
  }

  private trackLevel(gen: number) {
    if (!this.analyser) return;
    const buf = new Uint8Array(this.analyser.fftSize);
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (gen !== this.generation || !this.current) {
        levels.speech = 0;
        return;
      }
      this.analyser!.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      levels.speech = Math.min(1, levels.speech * 0.5 + Math.min(1, rms * 4.2) * 0.5);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private endLevel() {
    if (this.fakeLevelTimer) clearInterval(this.fakeLevelTimer);
    this.fakeLevelTimer = null;
    cancelAnimationFrame(this.raf);
    levels.speech = 0;
  }
}

export const speaker = typeof window !== "undefined" ? new Speaker() : (null as unknown as Speaker);

/**
 * Incremental sentence splitter for streamed text: feed cleaned text, get back complete sentences.
 */
export class SentenceChunker {
  private emitted = 0;
  push(full: string): string[] {
    const out: string[] = [];
    const re = /[^.!?…\n]+(?:[.!?…]+["')\]]*|\n)(?=\s|$)/g;
    re.lastIndex = this.emitted;
    let m: RegExpExecArray | null;
    while ((m = re.exec(full))) {
      // Require trailing whitespace (so "3.5" or a still-streaming "e.g." doesn't split early).
      const end = m.index + m[0].length;
      if (end >= full.length) break;
      const s = full.slice(this.emitted, end).trim();
      if (s.length > 1) out.push(s);
      this.emitted = end;
    }
    return out;
  }
  flush(full: string): string | null {
    const rest = full.slice(this.emitted).trim();
    this.emitted = full.length;
    return rest.length ? rest : null;
  }
}
