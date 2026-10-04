import { duration, ease } from "@/components/ui/motion";

/** Formats an ISO timestamp for display; "" for anything that isn't a valid date string. */
export function fmtTime(iso: unknown, opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" }): string {
  if (typeof iso !== "string") return "";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString(undefined, opts) : "";
}

/** Motion transition for the n-th row of a list that staggers in on first render. */
export const stagger = (i: number, base = 0) => ({ delay: base + Math.min(i, 12) * 0.04, duration: duration.base, ease: ease.standard });
