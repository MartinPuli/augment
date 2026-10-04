/**
 * Microphone driver: audio.level (RMS/peak dBFS over ≤10 s) and audio.record (≤10 s clip upload).
 * Must be enabled from a user gesture (AudioContext unlock on iOS).
 */
import { InvokeError, type CapabilityModule } from "../types";
import { numArg, safeStorage, sleep } from "../util";

const INPUT_KEY = "ghost.microphone.input.v1";
export interface MicrophoneInput { deviceId: string; label: string }

export function rememberedMicrophoneInput(): MicrophoneInput | null {
  try {
    const value = JSON.parse(safeStorage()?.getItem(INPUT_KEY) ?? "null");
    return value && typeof value.deviceId === "string" && typeof value.label === "string" ? value : null;
  } catch { return null; }
}

/** Enumeration never requests permission or starts recording. Labels may initially be hidden. */
export async function listMicrophoneInputs(): Promise<MicrophoneInput[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audioinput" && d.deviceId).map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Audio input ${i + 1}` }));
}

export interface MicrophoneModule extends CapabilityModule {
  readonly stream: MediaStream;
  /** Current instantaneous level in dBFS (for UI meters). */
  levelNow(): number;
}

export function microphoneSupport(): { supported: boolean; reason?: string } {
  if (typeof window === "undefined") return { supported: false, reason: "not in a browser" };
  if (!window.isSecureContext) return { supported: false, reason: "Microphone needs HTTPS (secure context)" };
  if (!navigator.mediaDevices?.getUserMedia) return { supported: false, reason: "This browser has no microphone API" };
  return { supported: true };
}

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {}
  }
  return undefined;
}

const toDb = (x: number) => (x > 0 ? 20 * Math.log10(x) : -120);

export async function enableMicrophone(opts: { label?: string; deviceId?: string } = {}): Promise<MicrophoneModule> {
  const s = microphoneSupport();
  if (!s.supported) throw new Error(s.reason);
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}) },
      video: false,
    });
  } catch (e) {
    if (opts.deviceId && e instanceof DOMException && ["NotFoundError", "OverconstrainedError"].includes(e.name)) {
      throw new Error("The selected microphone is unavailable. Reconnect it through the operating system, refresh inputs, or explicitly choose another microphone.");
    }
    throw e;
  }
  const track = stream.getAudioTracks()[0];
  const inputLabel = track?.label || opts.label || "Microphone";
  const AC: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  let ac: AudioContext;
  try { ac = new AC(); } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    throw e;
  }
  try {
    await ac.resume();
  } catch {}
  const src = ac.createMediaStreamSource(stream);
  const analyser = ac.createAnalyser();
  analyser.fftSize = 2048;
  src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let disposed = false;
  let busy = false;
  const inputEnded = () => !track || track.readyState === "ended";

  const frame = () => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    return { rms: Math.sqrt(sum / buf.length), peak };
  };

  const canRecord = !!pickMime();
  const capabilities: CapabilityModule["capabilities"] = [
    {
      capability_id: "audio.level",
      kind: "measure",
      semantic_type: "sound_level.read",
      title: "Sound level",
      description:
        "Measure loudness at this device for a few seconds. Returns average level in dBFS (relative to digital full scale, not calibrated dB SPL) plus the peak.",
      input_schema: {
        type: "object",
        properties: { seconds: { type: "number", minimum: 0.5, maximum: 10, default: 3 } },
        additionalProperties: false,
      },
      output: { unit: "dBFS" },
      verification: "observation",
      concurrency_group: "microphone",
      estimated_ms: 3200,
    },
  ];
  if (canRecord) {
    capabilities.push({
      capability_id: "audio.record",
      kind: "observe",
      semantic_type: "audio.observe",
      title: "Record a short clip",
      description:
        "Record up to 10 seconds of audio and upload it as an observation. Note: the agent may not be able to interpret audio content directly.",
      input_schema: {
        type: "object",
        properties: { seconds: { type: "number", minimum: 1, maximum: 10, default: 5 } },
        additionalProperties: false,
      },
      output: { media: pickMime()!.split(";")[0] },
      verification: "observation",
      concurrency_group: "microphone",
      limits: { max_payload_bytes: 1_000_000 },
      estimated_ms: 5500,
    });
  }

  // Save only a successfully opened selection. Browser-specific IDs stay on this browser.
  try {
    const deviceId = track?.getSettings().deviceId;
    if (deviceId) safeStorage()?.setItem(INPUT_KEY, JSON.stringify({ deviceId: opts.deviceId || "", label: inputLabel }));
  } catch {}
  return {
    id: "microphone",
    label: opts.label ?? inputLabel,
    connection: { method: "browser-audio-input", input_label: inputLabel },
    capabilities,
    stream,
    levelNow: () => (disposed ? -120 : toDb(frame().rms)),
    async handle(capability_id, args, ctx) {
      if (disposed) throw new InvokeError("microphone was turned off by the owner", "failed");
      if (inputEnded()) throw new InvokeError("microphone disconnected; the owner must reconnect or select an input", "failed");
      if (busy) throw new InvokeError("microphone is busy with another request", "rejected");
      busy = true;
      try {
        if (ac.state === "suspended") await ac.resume().catch(() => {});
        if (capability_id === "audio.level") {
          const seconds = Math.min(numArg(args, "seconds", { min: 0.5, max: 10, def: 3 }), ctx.remainingMs() / 1000 - 0.3);
          if (seconds < 0.3) throw new InvokeError("not enough time before the deadline", "rejected");
          const started = new Date();
          let energy = 0;
          let n = 0;
          let peak = 0;
          let maxRms = 0;
          const end = Date.now() + seconds * 1000;
          while (Date.now() < end) {
            if (disposed || inputEnded()) throw new InvokeError("microphone access stopped during measurement", "failed");
            const f = frame();
            energy += f.rms * f.rms;
            n++;
            if (f.peak > peak) peak = f.peak;
            if (f.rms > maxRms) maxRms = f.rms;
            await sleep(50, ctx.signal);
          }
          const avg = Math.sqrt(energy / Math.max(1, n));
          const avgDb = Math.round(toDb(avg) * 10) / 10;
          return {
            value: avgDb,
            unit: "dBFS",
            captured_at: started.toISOString(),
            data: {
              seconds: Math.round(seconds * 10) / 10,
              peak_dbfs: Math.round(toDb(peak) * 10) / 10,
              loudest_window_dbfs: Math.round(toDb(maxRms) * 10) / 10,
              samples: n,
              input_label: inputLabel,
            },
            note: "dBFS is relative to the microphone's digital full scale (0 = clipping); not calibrated dB SPL. Typical quiet room ≈ -60…-45 dBFS, speech ≈ -35…-20.",
          };
        }
        if (capability_id === "audio.record") {
          const mime = pickMime();
          if (!mime) throw new InvokeError("recording is not supported in this browser", "failed");
          const seconds = Math.min(numArg(args, "seconds", { min: 1, max: 10, def: 5 }), ctx.remainingMs() / 1000 - 1.5);
          if (seconds < 1) throw new InvokeError("not enough time before the deadline", "rejected");
          const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 64_000 });
          const chunks: Blob[] = [];
          rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
          const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
          const started = new Date();
          rec.start(250);
          try {
            await sleep(seconds * 1000, ctx.signal);
          } finally {
            if (rec.state !== "inactive") rec.stop();
          }
          await stopped;
          if (disposed || inputEnded()) throw new InvokeError("microphone access stopped during recording", "failed");
          const blob = new Blob(chunks, { type: mime.split(";")[0] });
          if (!blob.size) throw new InvokeError("recording produced no audio", "failed");
          const observation_id = await ctx.upload(blob, { capturedAt: started, contentType: blob.type });
          return {
            observation_id,
            captured_at: started.toISOString(),
            data: { seconds: Math.round(seconds * 10) / 10, mime: blob.type, bytes: blob.size, input_label: inputLabel },
            note: "Audio clip stored as an observation. The agent may not be able to interpret audio content directly; use audio.level for loudness.",
          };
        }
        throw new InvokeError(`unknown capability ${capability_id}`, "rejected");
      } finally {
        busy = false;
      }
    },
    dispose() {
      disposed = true;
      stream.getTracks().forEach((t) => t.stop());
      try {
        src.disconnect();
      } catch {}
      void ac.close().catch(() => {});
    },
  };
}
