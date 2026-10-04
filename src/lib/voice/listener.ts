"use client";

import { levels, useGhost } from "@/lib/store";

/**
 * Speech input with two engines behind one interface:
 *
 * - "elevenlabs" (preferred, any modern browser): records the microphone with MediaRecorder,
 *   detects the end of an utterance with a simple adaptive voice-activity detector, and
 *   transcribes it server-side through /api/stt (ElevenLabs Scribe). Key never leaves the server.
 * - "webspeech" (fallback): the browser's SpeechRecognition (Google Chrome / Edge only).
 *
 * Modes:
 * - "tap": click to start; sends automatically after a short silence (or click again to send now).
 * - "ptt": hold to talk; sends on release (finish()).
 * - "handsfree": like tap, then the dock restarts listening after Polty finishes speaking.
 */
export type ListenMode = "tap" | "ptt" | "handsfree";
type Engine = "realtime" | "elevenlabs" | "webspeech";

const S = () => useGhost.getState();

/* ------------------------------------------------------------------ */
/* Web Speech typings (not in every TS lib.dom)                        */
/* ------------------------------------------------------------------ */
interface SRResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface SREvent {
  resultIndex: number;
  results: ArrayLike<SRResult>;
}
interface SR {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SREvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type SRCtor = new () => SR;
function srCtor(): SRCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export const speechInputSupported = () =>
  typeof window !== "undefined" && (!!srCtor() || (typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia));

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    if (MediaRecorder.isTypeSupported?.(t)) return t;
  }
  return undefined;
}

class Listener {
  private engine: Engine | null = null;
  private active = false;
  private mode: ListenMode = "tap";
  private onUtterance: ((text: string) => void) | null = null;
  private session = 0;

  // mic graph (shared by both engines for the level meter)
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private raf = 0;

  // elevenlabs engine
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private heardSpeech = false;
  private segmentStart = 0;

  // realtime engine (ElevenLabs Scribe v2 Realtime over WebSocket)
  private rt: {
    ws: WebSocket | null;
    node: AudioWorkletNode | null;
    pending: string[]; // base64 chunks captured before the socket opened
    committed: string[];
    partial: string;
    timers: ReturnType<typeof setTimeout>[];
    finishing: boolean;
  } | null = null;
  private tokenPromise: Promise<{ token: string; language_code: string; keyterms: string[] } | null> | null = null;

  // webspeech engine
  private rec: SR | null = null;
  private finalText = "";
  private interim = "";
  private sendTimer: ReturnType<typeof setTimeout> | null = null;

  get listening() {
    return this.active;
  }

  /** Decide the engine once (ElevenLabs if the server has a key, else Web Speech). */
  async detect(): Promise<Engine> {
    if (this.engine) return this.engine;
    try {
      const r = await fetch("/api/tts");
      const j = await r.json();
      this.engine =
        j.stt === "elevenlabs"
          ? typeof AudioWorkletNode !== "undefined" && typeof WebSocket !== "undefined"
            ? "realtime"
            : typeof MediaRecorder !== "undefined"
              ? "elevenlabs"
              : "webspeech"
          : "webspeech";
      if (this.engine === "realtime") void this.prefetchToken();
    } catch {
      this.engine = "webspeech";
    }
    return this.engine;
  }

  start(mode: ListenMode, onUtterance: (text: string) => void): boolean {
    this.stop();
    const my = ++this.session;
    this.mode = mode;
    this.onUtterance = onUtterance;
    this.active = true;
    // Create the AudioContext synchronously inside the user gesture so it is allowed to run.
    try {
      this.ctx = new AudioContext();
      void this.ctx.resume();
    } catch {
      this.ctx = null;
    }
    S().set({ activity: "listening", caption: { who: "user", text: "Listening…", interim: true }, error: null });
    void (async () => {
      const engine = await this.detect();
      if (my !== this.session) return;
      if (engine === "realtime") await this.startRealtime(my);
      else if (engine === "elevenlabs") await this.startRecorder(my);
      else this.startWebSpeech(my);
    })();
    return true;
  }

  /** Release (push-to-talk) or second tap: send what was heard now. */
  finish() {
    if (!this.active) return;
    if (this.rt) {
      this.rtFinish();
      return;
    }
    if (this.engine === "elevenlabs" && this.recorder) {
      this.endSegment(true);
      return;
    }
    const text = (this.finalText + " " + this.interim).replace(/\s+/g, " ").trim();
    this.stop();
    if (text) this.onUtterance?.(text);
    else S().set({ caption: null });
  }

  /** Stop listening and discard anything unsent. */
  stop() {
    this.session++;
    this.active = false;
    this.rtClose();
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
    if (this.recorder) {
      this.recorder.ondataavailable = null;
      this.recorder.onstop = null;
      try {
        if (this.recorder.state !== "inactive") this.recorder.stop();
      } catch {
        /* ignore */
      }
      this.recorder = null;
    }
    this.releaseMic();
    const g = S();
    if (g.activity === "listening") g.set({ activity: g.running ? "thinking" : "idle" });
    if (g.caption?.who === "user" && g.caption.interim) g.set({ caption: null });
  }

  /** Kept for API compatibility (Web Speech hands-free): drop partial text. */
  pause() {
    this.finalText = "";
    this.interim = "";
    if (this.sendTimer) clearTimeout(this.sendTimer);
  }

  /* ---------------------------- mic + meter ---------------------------- */

  private async openMic(my: number): Promise<MediaStream | null> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (my !== this.session) {
        stream.getTracks().forEach((t) => t.stop());
        return null;
      }
      this.stream = stream;
      return stream;
    } catch (e) {
      const name = e instanceof DOMException ? e.name : "";
      this.fail(
        name === "NotAllowedError"
          ? "Microphone permission denied — allow it in the address bar, or type instead."
          : name === "NotFoundError"
            ? "No microphone found. Plug one in or type instead."
            : `Microphone unavailable (${name || "error"}). You can type instead.`,
      );
      return null;
    }
  }

  private releaseMic() {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.ctx) void this.ctx.close().catch(() => {});
    this.ctx = null;
    levels.mic = 0;
  }

  private fail(message: string) {
    this.stop();
    S().set({ error: message, caption: null });
  }

  /* ---------------------------- Realtime engine ---------------------------- */

  private prefetchToken() {
    this.tokenPromise = fetch("/api/stt-token", { method: "POST" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    return this.tokenPromise;
  }

  private async startRealtime(my: number) {
    const stream = await this.openMic(my);
    if (!stream || my !== this.session) return;
    // 16 kHz context: the browser resamples the mic for us.
    let ctx: AudioContext;
    try {
      if (this.ctx) void this.ctx.close().catch(() => {});
      ctx = new AudioContext({ sampleRate: 16000 });
      this.ctx = ctx;
      void ctx.resume();
    } catch {
      this.engine = "elevenlabs";
      return this.startRecorder(my);
    }
    const formats = [16000, 22050, 24000, 44100, 48000];
    if (!formats.includes(ctx.sampleRate)) {
      this.engine = "elevenlabs";
      return this.startRecorder(my);
    }
    const rt: NonNullable<Listener["rt"]> = { ws: null, node: null, pending: [], committed: [], partial: "", timers: [], finishing: false };
    this.rt = rt;

    // Capture: AudioWorklet -> PCM16 chunks of 100 ms, base64-encoded.
    try {
      const code = `class P extends AudioWorkletProcessor{constructor(){super();this.b=new Int16Array(${Math.round(ctx.sampleRate / 10)});this.n=0}process(i){const c=i[0]&&i[0][0];if(c){for(let k=0;k<c.length;k++){let s=c[k];s=s<-1?-1:s>1?1:s;this.b[this.n++]=s<0?s*32768:s*32767;if(this.n===this.b.length){this.port.postMessage(this.b.slice(0));this.n=0}}}return true}}registerProcessor("ghost-pcm16",P);`;
      const url = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
    } catch {
      this.rt = null;
      this.engine = "elevenlabs";
      return this.startRecorder(my);
    }
    if (my !== this.session) return;
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "ghost-pcm16");
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(node);
    src.connect(analyser);
    rt.node = node;
    node.port.onmessage = (e: MessageEvent<Int16Array>) => {
      if (my !== this.session) return;
      const b64 = int16ToBase64(e.data);
      if (rt.ws?.readyState === WebSocket.OPEN) rt.ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: b64, commit: false, sample_rate: ctx.sampleRate }));
      else if (rt.pending.length < 80) rt.pending.push(b64);
    };

    // Level meter.
    const buf = new Float32Array(analyser.fftSize);
    const tick = () => {
      if (my !== this.session) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      levels.mic = Math.min(1, levels.mic * 0.6 + Math.min(1, Math.sqrt(sum / buf.length) * 9) * 0.4);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);

    // Socket (token was prefetched; fetch the next one in the background).
    const tok = (await (this.tokenPromise ?? this.prefetchToken())) ?? (await this.prefetchToken());
    this.tokenPromise = null;
    void this.prefetchToken();
    if (my !== this.session) return;
    if (!tok?.token) {
      this.rtClose();
      this.engine = "elevenlabs";
      return this.startRecorder(my);
    }
    const qs = new URLSearchParams({
      model_id: "scribe_v2_realtime",
      token: tok.token,
      audio_format: `pcm_${ctx.sampleRate}`,
      commit_strategy: "vad",
      vad_silence_threshold_secs: this.mode === "handsfree" ? "0.6" : "0.55",
    });
    if (tok.language_code) qs.set("language_code", tok.language_code);
    for (const k of tok.keyterms ?? []) qs.append("keyterms", k);
    const ws = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${qs}`);
    rt.ws = ws;
    ws.onopen = () => {
      for (const b64 of rt.pending.splice(0)) ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: b64, commit: false, sample_rate: ctx.sampleRate }));
    };
    ws.onmessage = (ev) => {
      if (my !== this.session) return;
      let m: { message_type?: string; text?: string; error?: string };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.message_type === "partial_transcript") {
        rt.partial = m.text ?? "";
        const text = [...rt.committed, rt.partial].join(" ").trim();
        if (text) S().set({ caption: { who: "user", text, interim: true } });
      } else if (m.message_type === "committed_transcript") {
        const t = (m.text ?? "").trim();
        rt.partial = "";
        if (t) rt.committed.push(t);
        // Tap / hands-free: one utterance per session — deliver as soon as the server commits it.
        if (t && (this.mode !== "ptt" || rt.finishing)) this.rtDeliver(my);
      } else if (m.message_type && /error|exceeded|limited|overflow|exhausted|unaccepted/.test(m.message_type)) {
        const text = [...rt.committed, rt.partial].join(" ").trim();
        if (text) return this.rtDeliver(my);
        this.fail(`Voice transcription error (${m.message_type}${m.error ? `: ${m.error}` : ""}).`);
      }
    };
    ws.onerror = () => {
      if (my !== this.session) return;
      const text = [...rt.committed, rt.partial].join(" ").trim();
      if (text) return this.rtDeliver(my);
      // Fall back to upload-based transcription for this session.
      this.rtClose();
      this.engine = "elevenlabs";
      void this.startRecorder(my);
    };
    // Tap mode: give up politely if nothing is said.
    if (this.mode === "tap") {
      rt.timers.push(
        setTimeout(() => {
          if (my !== this.session || rt.committed.length || rt.partial) return;
          this.stop();
          S().set({ caption: { who: "user", text: "I didn't hear anything — tap the mic and speak." } });
        }, 12_000),
      );
    }
    rt.timers.push(setTimeout(() => my === this.session && this.rtFinish(), 45_000));
  }

  /** Push-to-talk release / second tap: flush and take what we have. */
  private rtFinish() {
    const rt = this.rt;
    if (!rt) return;
    const my = this.session;
    rt.finishing = true;
    try {
      rt.ws?.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: "", commit: true, sample_rate: this.ctx?.sampleRate ?? 16000 }));
    } catch {
      /* socket not open */
    }
    // If the server doesn't commit quickly, use the latest partial.
    rt.timers.push(setTimeout(() => my === this.session && this.rtDeliver(my), 900));
  }

  private rtDeliver(my: number) {
    const rt = this.rt;
    if (!rt || my !== this.session) return;
    const text = [...rt.committed, rt.partial].join(" ").replace(/\s+/g, " ").trim();
    const onUtterance = this.onUtterance;
    this.stop();
    if (text) onUtterance?.(text);
    else S().set({ caption: { who: "user", text: "I couldn't make that out — try again?" } });
  }

  private rtClose() {
    const rt = this.rt;
    if (!rt) return;
    this.rt = null;
    rt.timers.forEach(clearTimeout);
    if (rt.node) {
      rt.node.port.onmessage = null;
      try {
        rt.node.disconnect();
      } catch {
        /* ignore */
      }
    }
    if (rt.ws) {
      rt.ws.onmessage = null;
      rt.ws.onerror = null;
      try {
        rt.ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  /* ---------------------------- ElevenLabs engine ---------------------------- */

  private async startRecorder(my: number) {
    const stream = await this.openMic(my);
    if (!stream || my !== this.session) return;
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
        /* metering/VAD unavailable; push-to-talk still works */
      }
    }
    const analyser = this.ctx?.createAnalyser();
    if (this.ctx && analyser) {
      void this.ctx.resume();
      analyser.fftSize = 1024;
      this.ctx.createMediaStreamSource(stream).connect(analyser);
    }

    const mimeType = pickMime();
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    this.recorder = rec;
    this.chunks = [];
    this.heardSpeech = false;
    this.segmentStart = performance.now();
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) this.chunks.push(e.data);
    };
    rec.start(250);

    // Adaptive VAD: track the noise floor, call it speech when clearly above it.
    const buf = new Float32Array(analyser?.fftSize ?? 1024);
    let floor = 0.008;
    let voicedMs = 0;
    let lastVoice = 0;
    let last = performance.now();
    const silenceMs = this.mode === "handsfree" ? 850 : 1000;
    const tick = () => {
      if (my !== this.session || !this.recorder) return;
      const now = performance.now();
      const dt = now - last;
      last = now;
      let rms = 0;
      if (analyser) {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        rms = Math.sqrt(sum / buf.length);
      }
      levels.mic = Math.min(1, levels.mic * 0.6 + Math.min(1, rms * 9) * 0.4);
      const threshold = Math.max(0.012, floor * 2.8);
      if (rms > threshold) {
        voicedMs += dt;
        lastVoice = now;
        if (voicedMs > 140 && !this.heardSpeech) {
          this.heardSpeech = true;
          S().set({ caption: { who: "user", text: "Listening…", interim: true } });
        }
      } else {
        floor = floor * 0.97 + rms * 0.03;
        voicedMs = Math.max(0, voicedMs - dt * 0.5);
      }
      const elapsed = now - this.segmentStart;
      if (this.mode !== "ptt") {
        if (this.heardSpeech && now - lastVoice > silenceMs) return this.endSegment(false);
        if (!this.heardSpeech && elapsed > 12_000 && this.mode === "tap") {
          this.stop();
          S().set({ caption: { who: "user", text: "I didn't hear anything — tap the mic and speak." } });
          return;
        }
      }
      if (elapsed > 30_000) return this.endSegment(true);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private endSegment(force: boolean) {
    const rec = this.recorder;
    if (!rec) return;
    const my = this.session;
    const heard = this.heardSpeech || (force && performance.now() - this.segmentStart > 500);
    const onUtterance = this.onUtterance;
    const type = rec.mimeType || "audio/webm";
    cancelAnimationFrame(this.raf);
    rec.onstop = () => {
      const blob = new Blob(this.chunks, { type });
      this.chunks = [];
      // Release the mic before transcribing so Polty never hears itself.
      this.recorder = null;
      this.active = false;
      this.releaseMic();
      if (my !== this.session) return;
      if (!heard) {
        S().set({ activity: S().running ? "thinking" : "idle", caption: null });
        return;
      }
      S().set({ activity: "thinking", caption: { who: "user", text: "Transcribing…", interim: true } });
      void transcribe(blob).then(
        (text) => {
          if (text) onUtterance?.(text);
          else S().set({ activity: "idle", caption: { who: "user", text: "I couldn't make that out — try again?" } });
        },
        (err: Error) => {
          S().set({ activity: "idle", caption: null, error: `Speech-to-text failed: ${err.message}` });
        },
      );
    };
    try {
      rec.stop();
    } catch {
      rec.onstop?.(new Event("stop"));
    }
  }

  /* ---------------------------- Web Speech engine ---------------------------- */

  private startWebSpeech(my: number) {
    const C = srCtor();
    if (!C) {
      this.fail("Voice input needs an ElevenLabs key (ELEVENLABS_API_KEY) or Google Chrome. You can type instead.");
      return;
    }
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
      if (text) S().set({ caption: { who: "user", text, interim: true } });
      if (this.mode !== "ptt") this.scheduleSend();
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      const msg =
        e.error === "not-allowed" || e.error === "service-not-allowed"
          ? "Microphone permission denied — allow it in the address bar, or type instead."
          : e.error === "network"
            ? "This browser's speech recognition isn't available (it works in Google Chrome). Add ELEVENLABS_API_KEY for voice in any browser."
            : `Speech recognition error: ${e.error}`;
      this.fail(msg);
    };
    rec.onend = () => {
      if (this.active && my === this.session && this.mode === "handsfree") {
        try {
          rec.start();
        } catch {
          /* already started */
        }
      }
    };
    this.rec = rec;
    try {
      rec.start();
    } catch {
      /* ignore double start */
    }
    // Level meter only (recognition owns its own capture).
    void this.openMic(my).then((stream) => {
      if (!stream || !this.ctx) return;
      const an = this.ctx.createAnalyser();
      an.fftSize = 512;
      this.ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const tick = () => {
        if (my !== this.session) return;
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        levels.mic = Math.min(1, levels.mic * 0.6 + Math.min(1, Math.sqrt(sum / buf.length) * 6) * 0.4);
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    });
  }

  private scheduleSend() {
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.sendTimer = setTimeout(() => {
      const text = this.finalText.replace(/\s+/g, " ").trim();
      if (!text || this.interim.trim()) return;
      this.finalText = "";
      if (this.mode === "tap") this.stop();
      this.onUtterance?.(text);
    }, 900);
  }
}

function int16ToBase64(a: Int16Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function transcribe(blob: Blob): Promise<string> {
  const r = await fetch("/api/stt", { method: "POST", headers: { "Content-Type": blob.type || "audio/webm" }, body: blob });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return String(j.text ?? "").trim();
}

export const listener = typeof window !== "undefined" ? new Listener() : (null as unknown as Listener);
