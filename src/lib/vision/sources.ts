"use client";
/**
 * Attach a LiveSource to a drawable element. Every source ends up as an element the HUD can
 * drawImage() from and the detector can createImageBitmap() from.
 */
import type { LiveSource } from "@/lib/ghost/contracts";

export type SourceErrorKind = "unavailable" | "permission" | "unsupported" | "error";

export class SourceError extends Error {
  constructor(
    public kind: SourceErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface AttachedSource {
  el: HTMLVideoElement | HTMLImageElement;
  /** Natural frame size (0 until the first frame). */
  size(): { w: number; h: number };
  /** True when there is a frame to draw. */
  hasFrame(): boolean;
  /** Changes whenever a new frame is available (for skipping duplicate detections). */
  frameKey(): number;
  close(): void;
}

export interface AttachOptions {
  onError(err: SourceError): void;
  onLive?(): void;
}

function makeVideo(): HTMLVideoElement {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.autoplay = true;
  v.crossOrigin = "anonymous";
  v.setAttribute("muted", "");
  v.setAttribute("playsinline", "");
  return v;
}

function videoSource(v: HTMLVideoElement, cleanup: () => void, opts: AttachOptions): AttachedSource {
  let frames = 0;
  let closed = false;
  type RVFC = (cb: () => void) => number;
  const maybe = (v as unknown as { requestVideoFrameCallback?: RVFC }).requestVideoFrameCallback;
  const rvfc: RVFC | undefined = typeof maybe === "function" ? maybe.bind(v) : undefined;
  const tick = () => {
    if (closed) return;
    frames++;
    rvfc?.(tick);
  };
  rvfc?.(tick);
  const onPlaying = () => opts.onLive?.();
  v.addEventListener("playing", onPlaying);
  return {
    el: v,
    size: () => ({ w: v.videoWidth, h: v.videoHeight }),
    hasFrame: () => v.readyState >= 2 && v.videoWidth > 0,
    frameKey: () => (rvfc !== undefined ? frames : Math.floor(v.currentTime * 30)),
    close() {
      closed = true;
      v.removeEventListener("playing", onPlaying);
      cleanup();
      try {
        v.pause();
        v.removeAttribute("src");
        v.srcObject = null;
        v.load();
      } catch {}
    },
  };
}

async function attachHls(src: Extract<LiveSource, { kind: "hls" }>, opts: AttachOptions): Promise<AttachedSource> {
  const v = makeVideo();
  const { default: Hls } = await import("hls.js");
  if (Hls.isSupported()) {
    const hls = new Hls({
      liveSyncDurationCount: 2,
      maxBufferLength: 20,
      backBufferLength: 10,
      manifestLoadingMaxRetry: 3,
      levelLoadingMaxRetry: 3,
      fragLoadingMaxRetry: 3,
    });
    let recovers = 0;
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recovers < 2) {
        recovers++;
        hls.recoverMediaError();
        return;
      }
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && recovers < 2 && data.details !== Hls.ErrorDetails.MANIFEST_LOAD_ERROR) {
        recovers++;
        hls.startLoad();
        return;
      }
      const code = (data.response as { code?: number } | undefined)?.code;
      opts.onError(new SourceError("unavailable", `Stream unavailable${code ? ` (HTTP ${code})` : ""}: ${data.details}`));
    });
    hls.loadSource(src.url);
    hls.attachMedia(v);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      v.play().catch(() => {});
    });
    return videoSource(v, () => hls.destroy(), opts);
  }
  if (v.canPlayType("application/vnd.apple.mpegurl")) {
    v.src = src.url;
    const onErr = () => opts.onError(new SourceError("unavailable", "Stream unavailable"));
    v.addEventListener("error", onErr);
    v.play().catch(() => {});
    return videoSource(v, () => v.removeEventListener("error", onErr), opts);
  }
  throw new SourceError("unsupported", "This browser cannot play HLS");
}

function imageSource(img: HTMLImageElement, cleanup: () => void, keyRef: { n: number }): AttachedSource {
  return {
    el: img,
    size: () => ({ w: img.naturalWidth, h: img.naturalHeight }),
    hasFrame: () => img.complete && img.naturalWidth > 0,
    frameKey: () => keyRef.n,
    close: cleanup,
  };
}

function attachMjpeg(src: Extract<LiveSource, { kind: "mjpeg" }>, opts: AttachOptions): AttachedSource {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.decoding = "async";
  const key = { n: 0 };
  // multipart streams don't fire per-frame events: assume a fresh frame every ~66 ms
  const iv = window.setInterval(() => key.n++, 66);
  img.onload = () => opts.onLive?.();
  img.onerror = () => opts.onError(new SourceError("unavailable", "Stream unavailable"));
  img.src = src.url;
  return imageSource(
    img,
    () => {
      window.clearInterval(iv);
      img.onload = img.onerror = null;
      img.src = "";
    },
    key,
  );
}

function attachImagePoll(src: Extract<LiveSource, { kind: "image_poll" }>, opts: AttachOptions): AttachedSource {
  const shown = new Image();
  shown.crossOrigin = "anonymous";
  const key = { n: 0 };
  let closed = false;
  let failures = 0;
  let timer = 0;
  const interval = Math.max(250, src.interval_ms || 2000);
  const load = () => {
    if (closed) return;
    const next = new Image();
    next.crossOrigin = "anonymous";
    const sep = src.url.includes("?") ? "&" : "?";
    next.onload = () => {
      if (closed) return;
      failures = 0;
      shown.src = next.src; // cached -> instant swap
      key.n++;
      if (key.n === 1) opts.onLive?.();
      timer = window.setTimeout(load, interval);
    };
    next.onerror = () => {
      if (closed) return;
      failures++;
      if (failures >= 3 && key.n === 0) opts.onError(new SourceError("unavailable", "Image source unavailable"));
      timer = window.setTimeout(load, Math.min(15000, interval * 2 ** failures));
    };
    next.src = `${src.url}${sep}_t=${Date.now()}`;
  };
  load();
  return imageSource(
    shown,
    () => {
      closed = true;
      window.clearTimeout(timer);
    },
    key,
  );
}

async function attachLocalCamera(src: Extract<LiveSource, { kind: "local_camera" }>, opts: AttachOptions): Promise<AttachedSource> {
  if (!navigator.mediaDevices?.getUserMedia) throw new SourceError("unsupported", "Camera not available in this browser (needs HTTPS or localhost)");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: src.facing ?? "user", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    });
  } catch (e) {
    const name = (e as DOMException).name;
    if (name === "NotAllowedError" || name === "SecurityError") throw new SourceError("permission", "Camera permission denied");
    if (name === "NotFoundError" || name === "OverconstrainedError") throw new SourceError("unavailable", "No camera found");
    throw new SourceError("error", `Camera error: ${(e as Error).message}`);
  }
  const v = makeVideo();
  v.srcObject = stream;
  v.play().catch(() => {});
  stream.getVideoTracks()[0]?.addEventListener("ended", () => opts.onError(new SourceError("unavailable", "Camera stopped")));
  return videoSource(v, () => stream.getTracks().forEach((t) => t.stop()), opts);
}

async function attachWebrtc(src: Extract<LiveSource, { kind: "webrtc" }>, opts: AttachOptions): Promise<AttachedSource> {
  let mod: { openDeviceStream?: (id: string) => Promise<{ stream: MediaStream; close(): void }> };
  try {
    mod = await import(/* turbopackOptional: true */ "@/lib/connector/webrtc");
  } catch (e) {
    throw new SourceError("unsupported", `Live phone video is not available in this build (${(e as Error).message})`);
  }
  if (typeof mod.openDeviceStream !== "function") throw new SourceError("unsupported", "Live phone video is not available in this build");
  let handle: { stream: MediaStream; close(): void };
  try {
    handle = await mod.openDeviceStream(src.device_id);
  } catch (e) {
    throw new SourceError("unavailable", `Phone stream unavailable: ${(e as Error).message}`);
  }
  const v = makeVideo();
  v.srcObject = handle.stream;
  v.play().catch(() => {});
  handle.stream.getVideoTracks()[0]?.addEventListener("ended", () => opts.onError(new SourceError("unavailable", "Phone stream ended")));
  return videoSource(
    v,
    () => {
      try {
        handle.close();
      } catch {}
    },
    opts,
  );
}

export async function attachSource(src: LiveSource, opts: AttachOptions): Promise<AttachedSource> {
  switch (src.kind) {
    case "hls":
      return attachHls(src, opts);
    case "mjpeg":
      return attachMjpeg(src, opts);
    case "image_poll":
      return attachImagePoll(src, opts);
    case "local_camera":
      return attachLocalCamera(src, opts);
    case "webrtc":
      return attachWebrtc(src, opts);
    default:
      throw new SourceError("unsupported", `Unknown source kind ${(src as { kind?: string }).kind}`);
  }
}

export function sourceLabel(src: LiveSource): string {
  switch (src.kind) {
    case "hls":
      return "HLS";
    case "mjpeg":
      return "MJPEG";
    case "image_poll":
      return "STILLS";
    case "local_camera":
      return "WEBCAM";
    case "webrtc":
      return "PHONE";
  }
}
