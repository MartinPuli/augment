"use client";
import type { WidgetComponentProps } from "../../types";
import { card, col, link, sub } from "./styles";

interface Item { title: string; subtitle?: string; url?: string | null; image?: string | null }
interface Props { items?: Item[] }

export default function ListWidget({ props }: WidgetComponentProps<Props>) {
  return (
    <div style={{ ...col, gap: 6 }}>
      {(props.items ?? []).map((it, i) => {
        const body = (
          <div style={{ ...card, display: "flex", gap: 10, alignItems: "flex-start" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {it.image && <img src={it.image} alt="" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 10, flexShrink: 0 }} />}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{it.title}</div>
              {it.subtitle && <div style={{ ...sub, fontSize: 13, lineHeight: 1.4 }}>{it.subtitle}</div>}
            </div>
          </div>
        );
        return it.url ? (
          <a key={i} href={it.url} target="_blank" rel="noopener noreferrer" style={link}>
            {body}
          </a>
        ) : (
          <div key={i}>{body}</div>
        );
      })}
      {!props.items?.length && <div style={sub}>Nothing to show.</div>}
    </div>
  );
}
