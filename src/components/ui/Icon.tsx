"use client";

import { forwardRef } from "react";
import { MorphIcon, type MorphHandle, type MorphIconProps } from "morphicons/react";
import type { IconNode as LucideIconNode } from "lucide";

/**
 * The one icon component. Icons are Lucide *data* (`import { Mic } from "lucide"`), drawn by
 * morphicons: change the `icon` prop and the strokes morph into the new glyph with a spring
 * instead of swapping. Use it for every icon so state changes (mic → waveform → stop, copy →
 * check, open → close) animate for free.
 */
export type IconNode = LucideIconNode;

export interface IconProps extends Omit<MorphIconProps, "icon" | "spring"> {
  icon: IconNode;
  /** smooth (default, no overshoot) · snappy (state toggles) · bouncy (rare delight) */
  spring?: "smooth" | "snappy" | "bouncy";
}

export const Icon = forwardRef<MorphHandle, IconProps>(function Icon({ icon, size = 16, strokeWidth = 1.9, spring = "smooth", ...rest }, ref) {
  return <MorphIcon ref={ref} icon={icon} size={size} strokeWidth={strokeWidth} spring={spring} reducedMotion="user" {...rest} />;
});
