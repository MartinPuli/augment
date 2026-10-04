/**
 * Camera driver: camera.snapshot (bounded JPEG), camera.stream (WebRTC live video), torch.set.
 * The module only exists after getUserMedia succeeded (permission granted) — a denied or missing
 * camera is never advertised.
 */
import type { CapabilitySpec } from "@/lib/ghost/contracts";
import { InvokeError, type CapabilityModule } from "../types";
import { createStreamResponder, type StreamResponder } from "../webrtc-device";
import { boolArg, enumArg, numArg, withTimeout } from "../util";

export type Facing = "user" | "environment";

export interface CameraModule extends CapabilityModule {
  readonly stream: MediaStream;
  readonly facing: Facing;
  /** True when the current track supports torch (rear camera on Chrome Android). */
  torchSupported(): boolean;
  /** Build a separate module exposing torch.set (null if unsupported). */
  torchModule(): CapabilityModule | null;
  responder: StreamResponder;
  /** Subscribe to stream changes (facing switch). */
  onStreamChange(fn: (s: MediaStream) => void): () => void;
}

const MAX_EDGE = 1280;

export function cameraSupport(): { supported: boolean; reason?: string } {
  if (typeof window === "undefined") return { supported: false, reason: "not in a browser" };
  if (!window.isSecureContext) return { supported: false, reason: "Camera needs HTTPS (secure context)" };
  if (!navigator.mediaDevices?.getUserMedia) return { supported: false, reason: "This browser has no camera API" };
  return { supported: true };
}

async function openCamera(facing: Facing): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 24, max: 30 },
    },
  });
}

/** Request camera permission and build the module. Throws if denied/unavailable. */
export async function enableCamera(opts: {
  facing?: Facing;
  onLive?: (session_id: string, device_id: string, live: boolean) => void;
  label?: string;
} = {}): Promise<CameraModule> {
  const support = cameraSupport();
  if (!support.supported) throw new Error(support.reason);
  let facing: Facing = opts.facing ?? "environment";
  let stream = await openCamera(facing);
  let disposed = false;
  const streamListeners = new Set<(s: MediaStream) => void>();

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("aria-hidden", "true");
  video.style.cssText = "position:fixed;width:2px;height:2px;opacity:0;pointer-events:none;left:-10px;top:-10px;";
  document.body.appendChild(video);
  const attach = async () => {
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      /* autoplay of a muted inline video is allowed; ignore transient errors */
    }
  };
  await attach();

  const track = () => stream.getVideoTracks()[0] ?? null;
  const torchSupported = () => {
    const t = track();
    if (!t || typeof t.getCapabilities !== "function") return false;
    const caps = t.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
    return !!caps.torch;
  };

  const responder = createStreamResponder({
    getTrack: () => (disposed ? null : track()),
    isAllowed: () => !disposed,
    onLive: opts.onLive,
  });

  async function switchFacing(next: Facing) {
    if (next === facing) return;
    if (responder.sessionCount() > 0) throw new InvokeError("camera is streaming live; facing is locked until the stream ends", "rejected");
    const old = stream;
    old.getTracks().forEach((t) => t.stop());
    try {
      stream = await openCamera(next);
      facing = next;
    } catch (e) {
      stream = await openCamera(facing); // restore
      throw new InvokeError(`could not switch to the ${next} camera: ${e instanceof Error ? e.message : e}`, "failed");
    }
    await attach();
    streamListeners.forEach((fn) => fn(stream));
  }

  async function waitForFrame(signal: AbortSignal) {
    const start = Date.now();
    while (video.videoWidth === 0 || video.readyState < 2) {
      if (signal.aborted) throw new InvokeError("aborted", "failed");
      if (Date.now() - start > 4000) throw new InvokeError("camera produced no frame", "failed");
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  const capabilities: CapabilitySpec[] = [
    {
      capability_id: "camera.snapshot",
      kind: "observe",
      semantic_type: "image.observe",
      title: "Take a photo",
      description:
        "Capture a fresh JPEG (max 1280 px edge) from this phone's camera. The photo is the evidence; captured_at is the moment of capture.",
      input_schema: {
        type: "object",
        properties: { facing: { type: "string", enum: ["environment", "user"], description: "Rear (environment) or selfie (user) camera" } },
        additionalProperties: false,
      },
      output: { media: "image/jpeg" },
      verification: "observation",
      concurrency_group: "camera",
      limits: { max_payload_bytes: 2_000_000, rate_per_min: 30 },
      estimated_ms: 900,
    },
    {
      capability_id: "camera.stream",
      kind: "stream",
      semantic_type: "video.stream",
      title: "Live camera",
      description:
        "Start a live WebRTC video feed from this phone's camera to an authorized viewer (signaled through the coordinator). Returns a LiveSource {kind:'webrtc', device_id}. The phone shows that it is being watched.",
      input_schema: {
        type: "object",
        properties: { duration_s: { type: "number", minimum: 5, maximum: 600, default: 120 } },
        additionalProperties: false,
      },
      output: { media: "video/webrtc" },
      verification: "observation",
      concurrency_group: "camera",
      estimated_ms: 300,
    },
  ];

  const mod: CameraModule = {
    id: "camera",
    label: opts.label ?? "Camera",
    capabilities,
    get stream() {
      return stream;
    },
    get facing() {
      return facing;
    },
    responder,
    torchSupported,
    onStreamChange(fn) {
      streamListeners.add(fn);
      return () => streamListeners.delete(fn);
    },
    onSignal: responder.onSignal,
    onRevoke: () => responder.closeAll("lease revoked"),
    async handle(capability_id, args, ctx) {
      if (disposed) throw new InvokeError("camera was turned off by the owner", "failed");
      if (capability_id === "camera.snapshot") {
        const want = enumArg(args, "facing", ["user", "environment"] as const);
        if (want) await switchFacing(want);
        const t = track();
        if (!t || t.readyState !== "live") throw new InvokeError("camera track ended", "failed");
        await waitForFrame(ctx.signal);
        const capturedAt = new Date();
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        const scale = Math.min(1, MAX_EDGE / Math.max(vw, vh));
        const w = Math.round(vw * scale);
        const h = Math.round(vh * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const g = canvas.getContext("2d");
        if (!g) throw new InvokeError("canvas unavailable", "failed");
        g.drawImage(video, 0, 0, w, h);
        const blob = await withTimeout(
          new Promise<Blob>((resolve, reject) =>
            canvas.toBlob((b) => (b ? resolve(b) : reject(new InvokeError("JPEG encoding failed", "failed"))), "image/jpeg", 0.85),
          ),
          5000,
          "JPEG encoding timed out",
        );
        const observation_id = await ctx.upload(blob, { capturedAt, contentType: "image/jpeg" });
        return {
          observation_id,
          captured_at: capturedAt.toISOString(),
          data: { width: w, height: h, facing, bytes: blob.size },
          note: `Fresh photo from the ${facing === "user" ? "front (selfie)" : "rear"} camera.`,
        };
      }
      if (capability_id === "camera.stream") {
        const duration = numArg(args, "duration_s", { min: 5, max: 600, def: 120 });
        const t = track();
        if (!t || t.readyState !== "live") throw new InvokeError("camera track ended", "failed");
        return {
          value: "live",
          data: { live: { kind: "webrtc", device_id: ctx.device_id, title: "Phone camera (live)" }, duration_s: duration, facing },
          captured_at: new Date().toISOString(),
          note: "Live WebRTC stream available: open it with openDeviceStream(device_id). Frames are live, not stored.",
        };
      }
      throw new InvokeError(`unknown capability ${capability_id}`, "rejected");
    },
    torchModule() {
      if (!torchSupported()) return null;
      return {
        id: "torch",
        label: "Torch",
        capabilities: [
          {
            capability_id: "torch.set",
            kind: "act",
            semantic_type: "light.set",
            title: "Phone flashlight",
            description: "Turn this phone's rear flashlight on or off. The browser reports the resulting torch state.",
            input_schema: {
              type: "object",
              properties: { on: { type: "boolean" } },
              required: ["on"],
              additionalProperties: false,
            },
            verification: "reported_state",
            concurrency_group: "torch",
            estimated_ms: 300,
          },
        ],
        async handle(capability_id, args) {
          if (capability_id !== "torch.set") throw new InvokeError(`unknown capability ${capability_id}`, "rejected");
          const on = boolArg(args, "on");
          if (on === undefined) throw new InvokeError(`argument "on" is required`, "rejected");
          const t = track();
          if (!t || t.readyState !== "live") throw new InvokeError("camera track ended (torch needs the rear camera on)", "failed");
          await t.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
          const settings = t.getSettings() as MediaTrackSettings & { torch?: boolean };
          const state = settings.torch ?? on;
          return { value: state, data: { on: state }, captured_at: new Date().toISOString() };
        },
      };
    },
    dispose() {
      disposed = true;
      responder.closeAll("camera turned off");
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      video.remove();
    },
  };
  return mod;
}
