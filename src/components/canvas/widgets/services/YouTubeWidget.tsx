"use client";
import type { WidgetComponentProps } from "../../types";
import { card, col, sub } from "./styles";

interface Video { id: string; title: string; channel?: string | null; url?: string; thumbnail?: string }
interface Props { videos?: Video[]; selected?: string }

export default function YouTubeWidget({ props, update, report }: WidgetComponentProps<Props>) {
  const videos = props.videos ?? [];
  const sel = videos.find((v) => v.id === props.selected) ?? videos[0];
  return (
    <div style={col}>
      {sel && (
        <div style={{ position: "relative", width: "100%", aspectRatio: "16 / 9", borderRadius: 14, overflow: "hidden", background: "#000" }}>
          <iframe
            key={sel.id}
            src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(sel.id)}?autoplay=1&rel=0`}
            title={sel.title}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }}
          />
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
        {videos.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => {
              update({ selected: v.id });
              report({ playing: v.id, title: v.title });
            }}
            style={{ ...card, display: "flex", gap: 10, alignItems: "center", textAlign: "left", cursor: "pointer", padding: 6, outline: v.id === sel?.id ? "2px solid rgba(20,22,26,.35)" : "none" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={v.thumbnail ?? `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`} alt="" style={{ width: 88, height: 50, objectFit: "cover", borderRadius: 8, flexShrink: 0 }} />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", fontWeight: 600, fontSize: 13, lineHeight: 1.25, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.title}</span>
              {v.channel && <span style={sub}>{v.channel}</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
