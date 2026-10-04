"use client";
import type { WidgetComponentProps } from "../../types";
import { card, col, fmtTime, link, sub } from "./styles";

interface Props { items?: { title: string; link?: string | null; source?: string | null; published?: string | null }[] }

export default function NewsWidget({ props }: WidgetComponentProps<Props>) {
  return (
    <div style={{ ...col, gap: 6 }}>
      {(props.items ?? []).map((it, i) => (
        <a key={i} href={it.link ?? undefined} target="_blank" rel="noopener noreferrer" style={{ ...card, ...link, display: "block" }}>
          <div style={{ fontWeight: 600, lineHeight: 1.3 }}>{it.title}</div>
          <div style={sub}>
            {[it.source, fmtTime(it.published, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })].filter(Boolean).join(" · ")}
          </div>
        </a>
      ))}
      {!props.items?.length && <div style={sub}>No headlines.</div>}
    </div>
  );
}
