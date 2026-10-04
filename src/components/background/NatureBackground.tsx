"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Full-screen, slow nature loop behind everything (light glass sits on top of it).
 *
 * Source order: the local cached copy (`/media/nature.mp4`, fetched by
 * `pnpm exec tsx scripts/fetch-background.ts`), then NEXT_PUBLIC_BG_VIDEO_URL or the default remote
 * file, then a static gradient. Two <video> layers crossfade at the loop point so the clip never
 * visibly jumps. Reduced-motion users get the still poster; playback pauses while the tab is hidden.
 *
 * Footage: "Calm sea with paddleboarder" (dawn) — Mixkit, Mixkit Stock Video Free License
 * (see docs/credits.md).
 */
const REMOTE_VIDEO =
  process.env.NEXT_PUBLIC_BG_VIDEO_URL || "https://assets.mixkit.co/videos/2079/2079-720.mp4";
const REMOTE_POSTER =
  process.env.NEXT_PUBLIC_BG_POSTER_URL || "https://assets.mixkit.co/videos/2079/2079-thumb-720-0.jpg";
const LOCAL_VIDEO = "/media/nature.mp4";
const LOCAL_POSTER = "/media/nature.jpg";
const SOURCES = [LOCAL_VIDEO, REMOTE_VIDEO];
const FADE_S = 1.6;

export function NatureBackground() {
  const a = useRef<HTMLVideoElement>(null);
  const b = useRef<HTMLVideoElement>(null);
  const [srcIdx, setSrcIdx] = useState(0);
  const [front, setFront] = useState<0 | 1>(0);
  const [ready, setReady] = useState(false);
  const [still, setStill] = useState(false);
  const frontRef = useRef<0 | 1>(0);
  const fading = useRef(false);

  // Reduced motion: no video at all, just the poster.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setStill(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const failed = srcIdx >= SOURCES.length;
  const src = failed ? undefined : SOURCES[srcIdx];

  // Crossfade loop + pause when hidden.
  useEffect(() => {
    if (still || failed) return;
    const vids = [a.current, b.current];
    if (!vids[0] || !vids[1]) return;
    const active = () => vids[frontRef.current]!;

    const onTime = () => {
      const v = active();
      if (fading.current || !v.duration || !isFinite(v.duration)) return;
      if (v.duration - v.currentTime > FADE_S + 0.15) return;
      const next = vids[frontRef.current === 0 ? 1 : 0]!;
      fading.current = true;
      next.currentTime = 0;
      void next.play().catch(() => {});
      const nextIdx = frontRef.current === 0 ? 1 : 0;
      frontRef.current = nextIdx;
      setFront(nextIdx);
      window.setTimeout(() => {
        v.pause();
        fading.current = false;
      }, FADE_S * 1000 + 120);
    };
    const onVis = () => {
      if (document.hidden) vids.forEach((v) => v!.pause());
      else void active().play().catch(() => {});
    };
    vids.forEach((v) => v!.addEventListener("timeupdate", onTime));
    document.addEventListener("visibilitychange", onVis);
    const first = active();
    first.muted = true;
    if (!document.hidden) void first.play().catch(() => {});
    return () => {
      vids.forEach((v) => v!.removeEventListener("timeupdate", onTime));
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [still, failed, src]);

  const onError = () => {
    setReady(false);
    setSrcIdx((i) => i + 1);
  };

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="ghost-bg-fallback absolute inset-0" />
      {!failed && (
        <div
          className="ghost-bg-media absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: `url(${LOCAL_POSTER}), url(${REMOTE_POSTER})` }}
        />
      )}
      {!still && !failed && (
        <>
          {[a, b].map((ref, i) => (
            <video
              key={`${src}-${i}`}
              ref={ref}
              src={src}
              autoPlay={i === 0}
              muted
              playsInline
              preload="auto"
              disablePictureInPicture
              onCanPlay={i === 0 ? () => setReady(true) : undefined}
              onError={i === 0 ? onError : undefined}
              className="ghost-bg-media absolute inset-0 h-full w-full object-cover transition-opacity ease-in-out"
              style={{ opacity: ready && front === i ? 1 : 0, transitionDuration: `${i === 0 && !ready ? 900 : FADE_S * 1000}ms` }}
            />
          ))}
        </>
      )}
      <div className="ghost-bg-tint absolute inset-0" />
      <div className="ghost-bg-wash absolute inset-0" />
      <div className="ghost-bg-vignette absolute inset-0" />
    </div>
  );
}
