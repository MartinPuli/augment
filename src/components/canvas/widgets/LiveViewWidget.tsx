"use client";

/**
 * Live view with in-browser object tracking and a virtual follow-cam.
 *
 * props: { source: LiveSource; track?: { enabled?, classes?, follow?: boolean | number, max_zoom? }; title? }
 *
 * Pipeline: source element (HLS / MJPEG / stills / webcam / phone WebRTC) -> ImageBitmap -> detector
 * worker (D-FINE-N on WebGPU/WASM) -> ByteTrack-lite tracker -> follow-cam springs -> canvas HUD.
 */
import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, CameraOff, Crosshair, Loader2, RotateCcw, ScanSearch } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LiveSource } from "@/lib/ghost/contracts";
import { createDetector, type Detector } from "@/lib/vision/detector";
import { FollowCam, type FollowStatus } from "@/lib/vision/follow";
import {
  HUD,
  boxToView,
  drawLockBanner,
  drawMinimap,
  drawOptics,
  drawReticle,
  drawSearching,
  drawTracks,
  drawViewportCorners,
  type ViewXf,
} from "@/lib/vision/hud";
import { normalizeClasses } from "@/lib/vision/labels";
import { DEFAULT_MODEL_ID, getModel } from "@/lib/vision/models";
import { attachSource, sourceLabel, type AttachedSource, SourceError } from "@/lib/vision/sources";
import { Tracker, type Box, type Track } from "@/lib/vision/tracker";
import { fromTile, mergeDetections, planTiles, type Tile } from "@/lib/vision/tiles";
import type { Detection, DetectorBackend } from "@/lib/vision/types";
import type { WidgetComponentProps } from "../types";

export interface LiveViewProps {
  source: LiveSource;
  track?: {
    enabled?: boolean;
    classes?: string[];
    follow?: boolean | number;
    max_zoom?: number;
    /** Optional: detector model id ("dfine-n" default, "yolov10n" AGPL) and backend override. */
    model?: string;
    backend?: "auto" | "webgpu" | "wasm";
  };
  title?: string;
}

type Phase = "connecting" | "live" | "unavailable" | "permission" | "unsupported" | "error";
type ModelPhase = "off" | "loading" | "ready" | "error";

interface Stats {
  fps: number;
  detFps: number;
  inferMs: number;
  backend: DetectorBackend;
  counts: [string, number][];
  status: FollowStatus;
  target: { id: number; label: string; score: number } | null;
  zoom: number;
  frame: { w: number; h: number };
}

const EMPTY_STATS: Stats = {
  fps: 0,
  detFps: 0,
  inferMs: 0,
  backend: "none",
  counts: [],
  status: "off",
  target: null,
  zoom: 1,
  frame: { w: 0, h: 0 },
};

function sourceKey(s: LiveSource | undefined): string {
  return s ? JSON.stringify(s) : "";
}

export default function LiveViewWidget({ props, report, emit, update, focused }: WidgetComponentProps<LiveViewProps>) {
  const source = props.source;
  const srcKey = sourceKey(source);
  const trackOn = Boolean(props.track) && props.track?.enabled !== false;
  const classes = useMemo(() => normalizeClasses(props.track?.classes), [props.track?.classes]);
  const classesKey = classes?.join(",") ?? "";
  const followProp: boolean | number = props.track?.follow ?? (trackOn ? true : false);
  const maxZoom = Math.max(1, Math.min(6, Number(props.track?.max_zoom) || 3));
  const modelId = getModel(props.track?.model ?? DEFAULT_MODEL_ID).id;
  const backendPref = props.track?.backend ?? "auto";
  const title = props.title ?? (source && "title" in source ? source.title : undefined) ?? "Live view";

  const [phaseState, setPhase] = useState<Phase>("connecting");
  const [errorState, setErrorText] = useState<string | null>(null);
  const [modelPhase, setModelPhase] = useState<ModelPhase>(trackOn ? "loading" : "off");
  const [modelProgress, setModelProgress] = useState(0);
  const [modelError, setModelError] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [aspect, setAspect] = useState(16 / 9);
  const [retry, setRetry] = useState(0);
  const phase: Phase = source ? phaseState : "error";
  const errorText = source ? errorState : "No source";

  // reset per-session UI state when the source or detector config changes (render-time reset pattern)
  const sessionKey = `${srcKey}#${retry}`;
  const [prevSession, setPrevSession] = useState(sessionKey);
  if (prevSession !== sessionKey) {
    setPrevSession(sessionKey);
    setPhase("connecting");
    setErrorText(null);
  }
  const detKey = `${trackOn}|${modelId}|${backendPref}`;
  const [prevDetKey, setPrevDetKey] = useState(detKey);
  if (prevDetKey !== detKey) {
    setPrevDetKey(detKey);
    setModelPhase(trackOn ? "loading" : "off");
    setModelProgress(0);
    setModelError(null);
  }

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const srcRef = useRef<AttachedSource | null>(null);
  const detRef = useRef<Detector | null>(null);
  const trackerRef = useRef<Tracker>(new Tracker());
  const followRef = useRef<FollowCam>(new FollowCam({ follow: followProp, classes, maxZoom }));
  const viewRef = useRef<ViewXf>({ crop: { x: 0, y: 0, w: 1, h: 1 }, w: 1, h: 1 });
  const boxesRef = useRef<Map<number, Box>>(new Map());
  const hoverRef = useRef<number | null>(null);
  const lockAnimRef = useRef<{ at: number; text: string; color: string } | null>(null);
  const counters = useRef({ frames: 0, dets: 0, since: 0, inferMs: 0, passes: 1 });
  const liveRef = useRef<Stats>(EMPTY_STATS);
  const reportRef = useRef(report);
  const emitRef = useRef(emit);
  const trackOnRef = useRef(trackOn);
  const classesRef = useRef(classes);
  useEffect(() => {
    reportRef.current = report;
    emitRef.current = emit;
    trackOnRef.current = trackOn;
    classesRef.current = classes;
  });

  // refs mirrored for the loops below
  const phaseRef = useRef(phase);
  const modelPhaseRef = useRef(modelPhase);
  const titleRef = useRef(title);
  const srcKindRef = useRef(source?.kind);
  const modelNameRef = useRef(getModel(modelId).name);
  const errorRef = useRef<string | null>(null);
  useEffect(() => {
    phaseRef.current = phase;
    modelPhaseRef.current = modelPhase;
    titleRef.current = title;
    srcKindRef.current = source?.kind;
    modelNameRef.current = getModel(modelId).name;
    errorRef.current = errorText ?? modelError;
  });

  /* ---------------- source ---------------- */
  useEffect(() => {
    if (!srcKey) return;
    let cancelled = false;
    let attached: AttachedSource | null = null;
    const src = JSON.parse(srcKey) as LiveSource;
    // stills update slowly: keep tracks alive between frames
    const slow = src.kind === "image_poll" ? Math.max(1000, src.interval_ms || 2000) : 0;
    trackerRef.current = new Tracker(slow ? { maxAgeMs: slow * 2.5 + 500, minHits: 1 } : {});
    followRef.current.configure({ lostMs: slow ? slow * 2.5 : 1500 });
    attachSource(src, {
      onError(e) {
        if (cancelled) return;
        setPhase(e.kind === "permission" ? "permission" : e.kind === "unsupported" ? "unsupported" : "unavailable");
        setErrorText(e.message);
      },
      onLive() {
        if (!cancelled) setPhase((p) => (p === "connecting" ? "live" : p));
      },
    })
      .then((a) => {
        if (cancelled) {
          a.close();
          return;
        }
        attached = a;
        srcRef.current = a;
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const se = e instanceof SourceError ? e : new SourceError("error", (e as Error)?.message ?? String(e));
        setPhase(se.kind === "permission" ? "permission" : se.kind === "unsupported" ? "unsupported" : se.kind === "unavailable" ? "unavailable" : "error");
        setErrorText(se.message);
      });
    return () => {
      cancelled = true;
      attached?.close();
      if (srcRef.current === attached) srcRef.current = null;
    };
  }, [srcKey, retry]);

  /* ---------------- detector ---------------- */
  useEffect(() => {
    if (!trackOn) return;
    let cancelled = false;
    const det = createDetector({
      model: modelId,
      backend: backendPref,
      minScore: 0.12,
      onProgress: ({ loaded, total }) => !cancelled && setModelProgress(total ? loaded / total : 0),
    });
    detRef.current = det;
    det.ready.then(
      () => !cancelled && setModelPhase("ready"),
      (e: Error) => {
        if (cancelled) return;
        setModelPhase("error");
        setModelError(e.message);
      },
    );
    return () => {
      cancelled = true;
      det.dispose();
      if (detRef.current === det) detRef.current = null;
    };
  }, [trackOn, modelId, backendPref]);

  /* ---------------- follow config ---------------- */
  useEffect(() => {
    followRef.current.configure({ follow: trackOn ? followProp : false, classes, maxZoom });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackOn, followProp, classesKey, maxZoom]);

  /* ---------------- render + detect loop ---------------- */
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    let raf = 0;
    let last = performance.now();
    let lastKey = -1;
    let lastDetStart = 0;
    let cssW = wrap.clientWidth;
    let cssH = wrap.clientHeight;
    let scratch: HTMLCanvasElement | null = null;
    let lastAspect = 0;
    let disposed = false;
    let cycleBusy = false;
    let lastCrop: Box | null = null;

    const ro = new ResizeObserver(() => {
      cssW = wrap.clientWidth;
      cssH = wrap.clientHeight;
    });
    ro.observe(wrap);

    const grab = async (el: AttachedSource["el"], w: number, h: number): Promise<ImageBitmap> => {
      if (el instanceof HTMLVideoElement) return createImageBitmap(el);
      // MJPEG / stills: snapshot through a canvas (multipart <img> frames aren't reliably bitmappable)
      scratch ??= document.createElement("canvas");
      if (scratch.width !== w || scratch.height !== h) {
        scratch.width = w;
        scratch.height = h;
      }
      scratch.getContext("2d")!.drawImage(el, 0, 0, w, h);
      return createImageBitmap(scratch);
    };
    const grabRegion = async (el: AttachedSource["el"], w: number, h: number, t: Tile): Promise<ImageBitmap> => {
      if (el instanceof HTMLVideoElement) return createImageBitmap(el, t.x, t.y, t.w, t.h);
      if (!scratch || scratch.width !== w || scratch.height !== h) await grab(el, w, h).then((b) => b.close());
      return createImageBitmap(scratch!, t.x, t.y, t.w, t.h);
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dtMs = now - last;
      last = now;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = Math.max(1, Math.round(cssW * dpr));
      const H = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = HUD.ink;
      ctx.fillRect(0, 0, cssW, cssH);

      const src = srcRef.current;
      if (!src || !src.hasFrame()) return;
      const { w: fw, h: fh } = src.size();
      if (!fw || !fh) return;
      if (Math.abs(fw / fh - lastAspect) > 0.01) {
        lastAspect = fw / fh;
        setAspect(lastAspect);
      }
      counters.current.frames++;

      // ---- detection scheduling (one frame in flight; skip duplicates) ----
      const det = detRef.current;
      const key = src.frameKey();
      if (trackOnRef.current && det && det.backend !== "none" && !cycleBusy && key !== lastKey && now - lastDetStart > 50) {
        lastKey = key;
        lastDetStart = now;
        cycleBusy = true;
        const capturedAt = now;
        // full frame + (on fast backends) SAHI-style tiles around the follow-cam crop / two halves
        const tiles = planTiles(fw, fh, lastCrop, {
          perPassMs: det.lastMs,
          budgetMs: 160,
          allow: det.backend === "webgpu" || (det.lastMs > 0 && det.lastMs < 45),
          modelInput: det.input,
        });
        const t0 = performance.now();
        // capture every region from the same displayed frame before any inference starts
        Promise.all([grab(src.el, fw, fh), ...tiles.map((t) => grabRegion(src.el, fw, fh, t))])
          .then(async ([full, ...parts]) => {
            const lists: Detection[][] = [await det.detect(full)];
            for (let i = 0; i < parts.length; i++) {
              if (disposed) {
                parts[i].close();
                continue;
              }
              lists.push(fromTile(await det.detect(parts[i]), tiles[i], fw, fh));
            }
            return mergeDetections(lists);
          })
          .then((dets) => {
            if (disposed) return;
            trackerRef.current.update(dets, capturedAt);
            counters.current.dets++;
            counters.current.inferMs = performance.now() - t0;
            counters.current.passes = tiles.length + 1;
          })
          .catch(() => {})
          .finally(() => {
            cycleBusy = false;
          });
      }

      // ---- tracks + follow ----
      const tracker = trackerRef.current;
      const tracks = trackOnRef.current ? tracker.confirmed() : [];
      const boxes = boxesRef.current;
      boxes.clear();
      for (const t of tracks) boxes.set(t.id, tracker.predict(t, now, 400));
      const follow = followRef.current;
      const f = follow.update(tracks, (t) => boxes.get(t.id) ?? t.box, fw, fh, now, dtMs);
      const target = f.targetId !== null ? tracks.find((t) => t.id === f.targetId) : undefined;
      lastCrop = f.zoom > 1.02 ? f.crop : null;
      if (f.acquired && target) {
        lockAnimRef.current = { at: now, text: `LOCKED · #${target.id} ${target.label}`, color: HUD.mint };
      }

      // ---- draw the follow-cam view ----
      const view: ViewXf = { crop: f.crop, w: cssW, h: cssH };
      viewRef.current = view;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      try {
        ctx.drawImage(src.el, f.crop.x, f.crop.y, f.crop.w, f.crop.h, 0, 0, cssW, cssH);
      } catch {
        return;
      }
      drawOptics(ctx, cssW, cssH);
      if (trackOnRef.current) {
        drawTracks(ctx, { view, tracks, boxes, targetId: f.targetId, now, hoverId: hoverRef.current, classes: classesRef.current });
        const lockT = lockAnimRef.current ? (now - lockAnimRef.current.at) / 1000 : 9;
        if (target) drawReticle(ctx, boxToView(view, boxes.get(target.id) ?? target.box), f.status, now, lockT);
        else if (f.status === "searching" && det?.backend !== "none") drawSearching(ctx, cssW, cssH, now);
        if (lockAnimRef.current) drawLockBanner(ctx, cssW, lockAnimRef.current.text, lockT, lockAnimRef.current.color);
        if (f.status !== "off" || f.zoom > 1.02) {
          const mw = Math.min(180, cssW * 0.26);
          const mh = (mw * fh) / fw;
          drawMinimap(ctx, src.el, fw, fh, f.crop, tracks, boxes, f.targetId, { x: cssW - mw - 14, y: cssH - mh - 14, w: mw, h: mh });
        }
      }
      drawViewportCorners(ctx, cssW, cssH, f.status === "locked" ? HUD.mint : f.status === "searching" ? HUD.amber : f.status === "holding" ? HUD.coral : HUD.ivory);

      // ---- live stats (read by the 4 Hz UI sync + 1 Hz report) ----
      const counts = new Map<string, number>();
      for (const t of tracks) counts.set(t.label, (counts.get(t.label) ?? 0) + 1);
      liveRef.current = {
        ...liveRef.current,
        backend: det?.backend ?? "none",
        counts: [...counts.entries()].sort((a, b) => b[1] - a[1]),
        status: f.status,
        target: target ? { id: target.id, label: target.label, score: target.score } : null,
        zoom: f.zoom,
        frame: { w: fw, h: fh },
      };
      (liveRef.current as Stats & { targetTrack?: Track }).targetTrack = target;
    };
    raf = requestAnimationFrame(frame);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  /* ---------------- UI sync (4 Hz) + agent report (1 Hz) ---------------- */
  useEffect(() => {
    let lastReport = 0;
    counters.current.since = performance.now();
    const iv = window.setInterval(() => {
      const now = performance.now();
      const c = counters.current;
      const secs = Math.max(0.001, (now - c.since) / 1000);
      const fps = c.frames / secs;
      const detFps = c.dets / secs;
      if (secs > 1) {
        c.frames = 0;
        c.dets = 0;
        c.since = now;
      }
      const s: Stats = { ...liveRef.current, fps: secs > 0.2 ? fps : liveRef.current.fps, detFps: secs > 0.2 ? detFps : liveRef.current.detFps, inferMs: c.inferMs };
      liveRef.current = { ...liveRef.current, fps: s.fps, detFps: s.detFps };
      setStats(s);
      if (now - lastReport >= 1000) {
        lastReport = now;
        const tt = (liveRef.current as Stats & { targetTrack?: Track }).targetTrack;
        reportRef.current({
          status: statusWord(phaseRef.current, modelPhaseRef.current),
          source_title: titleRef.current,
          source_kind: srcKindRef.current,
          tracking: trackOnRef.current,
          classes: classesRef.current,
          counts: Object.fromEntries(s.counts),
          total: s.counts.reduce((n, [, v]) => n + v, 0),
          follow_status: s.status,
          target: tt
            ? {
                id: tt.id,
                label: tt.label,
                confidence: Math.round(tt.score * 100) / 100,
                speed_px_s: Math.round(tt.speed),
                tracked_for_s: Math.round((now - tt.firstSeen) / 100) / 10,
              }
            : null,
          zoom: Math.round(s.zoom * 100) / 100,
          fps: Math.round(s.fps),
          detect_fps: Math.round(s.detFps * 10) / 10,
          inference_ms: Math.round(c.inferMs),
          passes_per_cycle: c.passes,
          backend: s.backend,
          model: modelNameRef.current,
          frame: s.frame,
          error: errorRef.current,
          note: "Counts are confirmed tracks in the current frame from in-browser detection; small/distant objects may be missed.",
        });
      }
    }, 250);
    return () => window.clearInterval(iv);
  }, []);

  /* ---------------- interaction ---------------- */
  const hitTest = useCallback((clientX: number, clientY: number): Track | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    const px = clientX - r.left;
    const py = clientY - r.top;
    const view = viewRef.current;
    let best: Track | null = null;
    let bestArea = Infinity;
    for (const t of trackerRef.current.confirmed()) {
      const b = boxToView(view, boxesRef.current.get(t.id) ?? t.box);
      const padX = Math.max(0, (18 - b.w) / 2) + 3;
      const padY = Math.max(0, (18 - b.h) / 2) + 3;
      if (px >= b.x - padX && px <= b.x + b.w + padX && py >= b.y - padY && py <= b.y + b.h + padY) {
        const area = b.w * b.h;
        if (area < bestArea) {
          bestArea = area;
          best = t;
        }
      }
    }
    return best;
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      hoverRef.current = hitTest(e.clientX, e.clientY)?.id ?? null;
      if (canvasRef.current) canvasRef.current.style.cursor = hoverRef.current !== null ? "crosshair" : "default";
    },
    [hitTest],
  );

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      if (!trackOn) return;
      const t = hitTest(e.clientX, e.clientY);
      if (t) {
        followRef.current.lock(t.id);
        lockAnimRef.current = { at: performance.now(), text: `LOCKED · #${t.id} ${t.label}`, color: HUD.mint };
        emitRef.current(`User locked onto #${t.id} (${t.label})`);
        update({ track: { ...(props.track ?? {}), enabled: true, follow: t.id } });
      } else if (followRef.current.currentTarget !== null && typeof followProp === "number") {
        followRef.current.lock(null);
        emitRef.current("User released the lock; auto-follow resumed");
        update({ track: { ...(props.track ?? {}), enabled: true, follow: true } });
      }
    },
    [hitTest, trackOn, followProp, props.track, update],
  );

  /* ---------------- render ---------------- */
  const live = phase === "live" || (phase === "connecting" && stats.frame.w > 0);
  const failed = phase === "unavailable" || phase === "permission" || phase === "unsupported" || phase === "error";
  const modelName = getModel(modelId).name;
  const total = stats.counts.reduce((n, [, v]) => n + v, 0);
  const statusTone = modelPhase !== "ready" ? "text-mute" : stats.status === "locked" ? "text-mint" : stats.status === "holding" ? "text-coral" : stats.status === "searching" ? "text-amber" : "text-mute";

  return (
    <div
      ref={wrapRef}
      className={clsx(
        "relative w-full overflow-hidden rounded-xl border bg-ink select-none",
        focused ? "border-mint/30" : "border-line",
      )}
      style={{ aspectRatio: String(aspect), maxHeight: "72vh" }}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        onPointerMove={onPointerMove}
        onPointerLeave={() => (hoverRef.current = null)}
        onClick={onClick}
        aria-label={`${title} live view${trackOn ? " with object tracking" : ""}`}
      />

      {/* top strip */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 bg-gradient-to-b from-ink/85 via-ink/40 to-transparent px-3 pb-6 pt-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="relative flex h-2 w-2 shrink-0">
            {live && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-coral opacity-60" />}
            <span className={clsx("relative inline-flex h-2 w-2 rounded-full", live ? "bg-coral" : failed ? "bg-mute" : "bg-amber")} />
          </span>
          <span className={clsx("font-mono text-[10px] font-semibold tracking-[0.18em]", live ? "text-ivory" : "text-mute")}>
            {live ? "LIVE" : failed ? "OFFLINE" : "CONNECTING"}
          </span>
          <span className="truncate font-mono text-[11px] text-ivory/90">{title}</span>
          {source && <span className="hud-label hidden shrink-0 sm:inline">{sourceLabel(source)}</span>}
        </div>
        {trackOn && (
          <div className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] tracking-[0.12em] text-ivory-dim">
            <span className="rounded border border-line bg-ink/60 px-1.5 py-0.5 text-violet">{modelName}</span>
            <span className="rounded border border-line bg-ink/60 px-1.5 py-0.5 uppercase">
              {modelPhase === "ready" ? stats.backend : modelPhase === "loading" ? "loading" : modelPhase === "error" ? "no model" : "—"}
            </span>
            <span className="rounded border border-line bg-ink/60 px-1.5 py-0.5 tabular-nums">
              {Math.round(stats.fps)} FPS
              {modelPhase === "ready" && <span className="text-mute"> · DET {stats.detFps.toFixed(1)}</span>}
            </span>
          </div>
        )}
      </div>

      {/* bottom-left: lock status + counts */}
      {trackOn && live && (
        <div className="pointer-events-none absolute bottom-3 left-3 flex max-w-[64%] flex-col gap-1.5">
          <div className={clsx("flex items-center gap-1.5 font-mono text-[10px] tracking-[0.14em]", statusTone)}>
            {stats.status === "locked" ? <Crosshair className="h-3 w-3" /> : <ScanSearch className="h-3 w-3" />}
            <span>
              {modelPhase !== "ready"
                ? modelPhase === "error"
                  ? "TRACKING OFF"
                  : "STANDBY · MODEL LOADING"
                : stats.status === "locked" && stats.target
                ? `LOCKED #${stats.target.id} ${stats.target.label.toUpperCase()}`
                : stats.status === "holding"
                  ? "TARGET OCCLUDED · HOLDING"
                  : stats.status === "searching"
                    ? classes
                      ? `SEARCHING · ${classes.join(" / ").toUpperCase()}`
                      : "SEARCHING"
                    : "TRACKING"}
            </span>
            {stats.zoom > 1.05 && <span className="text-ivory-dim">· {stats.zoom.toFixed(1)}×</span>}
          </div>
          <div className="flex flex-wrap gap-1">
            <span className="rounded bg-ink/70 px-1.5 py-0.5 font-mono text-[10px] tabular-nums tracking-[0.1em] text-ivory">{total} OBJ</span>
            {stats.counts.slice(0, 6).map(([label, n]) => (
              <span
                key={label}
                className={clsx(
                  "rounded px-1.5 py-0.5 font-mono text-[10px] tabular-nums tracking-[0.1em]",
                  !classes || classes.includes(label) ? "bg-ink/70 text-ivory-dim" : "bg-ink/50 text-mute",
                )}
              >
                {label.toUpperCase()} {n}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* model loading */}
      <AnimatePresence>
        {trackOn && modelPhase === "loading" && !failed && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            className="pointer-events-none absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-ink/80 px-3 py-1.5 backdrop-blur"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin text-violet" />
            <span className="font-mono text-[10px] tracking-[0.14em] text-ivory-dim">
              LOADING MODEL… {modelProgress > 0 && modelProgress < 1 ? `${Math.round(modelProgress * 100)}%` : modelProgress >= 1 ? "COMPILING" : ""}
            </span>
            <span className="h-1 w-16 overflow-hidden rounded-full bg-ink-4">
              <span className="block h-full bg-violet transition-[width]" style={{ width: `${Math.round(modelProgress * 100)}%` }} />
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {trackOn && modelPhase === "error" && !failed && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 flex max-w-[80%] -translate-x-1/2 items-center gap-2 rounded-full border border-coral/30 bg-ink/85 px-3 py-1.5">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-coral" />
          <span className="truncate font-mono text-[10px] tracking-[0.1em] text-ivory-dim">Tracking unavailable: {modelError}</span>
        </div>
      )}

      {/* connecting */}
      {phase === "connecting" && stats.frame.w === 0 && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex flex-col items-center gap-3">
            <div className="relative h-12 w-12">
              <span className="absolute inset-0 rounded-full border border-amber/40" />
              <span className="absolute inset-0 animate-spin rounded-full border-t-2 border-amber" />
            </div>
            <span className="hud-label">{source?.kind === "local_camera" ? "Waiting for camera…" : "Connecting to stream…"}</span>
          </div>
        </div>
      )}

      {/* failures */}
      {failed && (
        <div className="absolute inset-0 grid place-items-center bg-ink/85 backdrop-blur-sm">
          <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
            <span className="grid h-11 w-11 place-items-center rounded-full border border-coral/40 bg-coral/10 text-coral">
              {phase === "permission" ? <CameraOff className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5" />}
            </span>
            <div className="font-mono text-[11px] font-semibold tracking-[0.16em] text-coral">
              {phase === "permission" ? "CAMERA PERMISSION DENIED" : phase === "unsupported" ? "NOT SUPPORTED HERE" : "STREAM UNAVAILABLE"}
            </div>
            <p className="text-[12.5px] leading-relaxed text-ivory-dim">
              {phase === "permission"
                ? "Allow camera access for this site in the browser's address bar, then retry."
                : (errorText ?? "The operator's stream did not respond.")}
            </p>
            <button
              type="button"
              onClick={() => setRetry((n) => n + 1)}
              className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-line-strong px-3 py-1 font-mono text-[10px] tracking-[0.14em] text-ivory transition hover:border-mint/50 hover:text-mint"
            >
              <RotateCcw className="h-3 w-3" /> RETRY
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function statusWord(phase: Phase, model: ModelPhase): string {
  if (phase === "unavailable") return "stream_unavailable";
  if (phase === "permission") return "permission_denied";
  if (phase === "unsupported") return "unsupported";
  if (phase === "error") return "error";
  if (phase === "connecting") return "connecting";
  if (model === "loading") return "loading_model";
  if (model === "error") return "live_no_tracking";
  return "live";
}

export { LiveViewWidget };
