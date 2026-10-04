"use client";
import { motion } from "motion/react";
import { Newspaper } from "lucide";
import type { WidgetComponentProps } from "../../types";
import { EmptyState } from "./EmptyState";
import { fmtTime, stagger } from "./styles";

interface Props { items?: { title: string; link?: string | null; source?: string | null; published?: string | null }[] }

export default function NewsWidget({ props }: WidgetComponentProps<Props>) {
  const items = props.items ?? [];
  if (!items.length) return <EmptyState illustration="news" fallback={Newspaper} title="No headlines" subtitle="Nothing new came in for that topic." />;
  return (
    <ul className="flex min-w-0 flex-col gap-0.5">
      {items.map((it, i) => {
        const when = fmtTime(it.published, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
        return (
          <motion.li key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={stagger(i)}>
            <a
              href={it.link ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="group block rounded-tile px-3 py-2.5 transition-colors duration-150 ease-standard hover:bg-tint"
            >
              <span className="block font-serif text-body text-fg transition-colors duration-150 ease-standard group-hover:text-mint">{it.title}</span>
              {(it.source || when) && (
                <span className="mt-1 block truncate text-caption text-fg-3">
                  {it.source && <span className="font-medium text-fg-2">{it.source}</span>}
                  {it.source && when ? " · " : ""}
                  {when && <span className="tabular-nums">{when}</span>}
                </span>
              )}
            </a>
          </motion.li>
        );
      })}
    </ul>
  );
}
