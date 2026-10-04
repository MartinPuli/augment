"use client";

import Image from "next/image";
import { useState } from "react";
import clsx from "clsx";
import { Icon, type IconNode } from "./Icon";
import type { IllustrationName } from "./illustrations";

/**
 * A 3D icon illustration (Thiings), served from public/illustrations and resized by next/image.
 * Fades in once decoded; until then — or if the file was never fetched — it shows the line-icon
 * `fallback` (or nothing), so a missing asset never leaves a broken image.
 */
export function Illustration({
  name,
  size = 40,
  fallback,
  className,
  priority,
}: {
  name: IllustrationName;
  size?: number;
  fallback?: IconNode;
  className?: string;
  priority?: boolean;
}) {
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  return (
    <span aria-hidden className={clsx("relative inline-grid shrink-0 place-items-center", className)} style={{ width: size, height: size }}>
      {state !== "ready" && fallback && (
        <span className={clsx("col-start-1 row-start-1 text-fg-3 transition-opacity duration-200", state === "loading" ? "opacity-40" : "opacity-100")}>
          <Icon icon={fallback} size={Math.round(size * 0.5)} />
        </span>
      )}
      {state !== "missing" && (
        <Image
          src={`/illustrations/${name}.png`}
          alt=""
          width={size}
          height={size}
          sizes={`${size}px`}
          preload={priority}
          draggable={false}
          onLoad={() => setState("ready")}
          onError={() => setState("missing")}
          className={clsx(
            "col-start-1 row-start-1 h-full w-full select-none object-contain transition-[opacity,transform] duration-300 ease-standard",
            state === "ready" ? "scale-100 opacity-100" : "scale-90 opacity-0",
          )}
        />
      )}
    </span>
  );
}
