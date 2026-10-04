"use client";
import clsx from "clsx";
import { Play, SquarePlay } from "lucide";
import { Icon } from "@/components/ui/Icon";
import type { WidgetComponentProps } from "../../types";
import { EmptyState } from "./EmptyState";

interface Video { id: string; title: string; channel?: string | null; url?: string; thumbnail?: string }
interface Props { videos?: Video[]; selected?: string }

export default function YouTubeWidget({ props, update, report }: WidgetComponentProps<Props>) {
  const videos = props.videos ?? [];
  const sel = videos.find((v) => v.id === props.selected) ?? videos[0];
  if (!videos.length) return <EmptyState illustration="video" fallback={SquarePlay} title="No videos" subtitle="Nothing came back for that search." />;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {sel && (
        <div className="relative aspect-video w-full overflow-hidden rounded-tile bg-fg shadow-card">
          <iframe
            key={sel.id}
            src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(sel.id)}?autoplay=1&rel=0`}
            title={sel.title}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            className="absolute inset-0 h-full w-full border-0"
          />
        </div>
      )}
      <ul className="ghost-scroll flex max-h-[220px] flex-col gap-0.5 overflow-y-auto">
        {videos.map((v) => {
          const active = v.id === sel?.id;
          return (
            <li key={v.id}>
              <button
                type="button"
                aria-current={active ? "true" : undefined}
                onClick={() => {
                  update({ selected: v.id });
                  report({ playing: v.id, title: v.title });
                }}
                className={clsx(
                  "flex w-full min-w-0 items-center gap-3 rounded-tile p-1.5 pr-3 text-left transition-colors duration-150 ease-standard",
                  active ? "bg-tint" : "hover:bg-tint",
                )}
              >
                <span className="relative h-[50px] w-[88px] shrink-0 overflow-hidden rounded-[10px] bg-tint">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={v.thumbnail ?? `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`} alt="" className="h-full w-full object-cover" />
                  {active && (
                    <span className="absolute inset-0 grid place-items-center bg-fg/45 text-fg-inverse">
                      <Icon icon={Play} size={16} />
                    </span>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body-sm font-medium text-fg">{v.title}</span>
                  {v.channel && <span className="block truncate text-caption text-fg-3">{active ? `Playing · ${v.channel}` : v.channel}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
