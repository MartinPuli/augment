"use client";

import clsx from "clsx";
import type { ReactNode } from "react";
import type { IconNode } from "@/components/ui/Icon";
import { Illustration } from "@/components/ui/Illustration";
import type { IllustrationName } from "@/components/ui/illustrations";

/**
 * The one empty / idle state for canvas widgets: a 3D illustration, a serif title, one line of
 * explanation and an optional action. `tone="error"` turns the line coral for failures.
 */
export function EmptyState({
  illustration,
  fallback,
  title,
  subtitle,
  action,
  tone = "neutral",
  size = 56,
  className,
}: {
  illustration: IllustrationName;
  fallback?: IconNode;
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "error";
  size?: number;
  className?: string;
}) {
  return (
    <div className={clsx("flex flex-col items-center px-4 py-6 text-center", className)}>
      <Illustration name={illustration} size={size} fallback={fallback} className="mb-3" />
      <p className="font-serif text-heading text-fg">{title}</p>
      {subtitle && <p className={clsx("mt-1 max-w-[36ch] text-body-sm", tone === "error" ? "text-coral" : "text-fg-3")}>{subtitle}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Shimmering placeholder rows shaped like a list of tiles. */
export function SkeletonRows({ rows = 3, className, rowClassName = "h-12" }: { rows?: number; className?: string; rowClassName?: string }) {
  return (
    <div aria-hidden className={clsx("flex flex-col gap-2", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={clsx("ghost-skeleton rounded-tile", rowClassName)} style={{ opacity: 1 - i * 0.22 }} />
      ))}
    </div>
  );
}
