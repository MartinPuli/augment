import type { CSSProperties } from "react";

export const ink = "#14161a";
export const slate = "#5b6472";
export const card: CSSProperties = {
  background: "rgba(255,255,255,.55)",
  backdropFilter: "blur(18px)",
  WebkitBackdropFilter: "blur(18px)",
  border: "1px solid rgba(255,255,255,.7)",
  borderRadius: 14,
  padding: "10px 12px",
  color: ink,
};
export const col: CSSProperties = { display: "flex", flexDirection: "column", gap: 8, color: ink, fontSize: 14, minWidth: 0 };
export const sub: CSSProperties = { color: slate, fontSize: 12 };
export const link: CSSProperties = { color: ink, textDecoration: "none" };

export function fmtTime(iso: unknown, opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" }): string {
  if (typeof iso !== "string") return "";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString(undefined, opts) : "";
}
