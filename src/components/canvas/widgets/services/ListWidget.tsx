"use client";
import { motion } from "motion/react";
import { List } from "lucide";
import type { WidgetComponentProps } from "../../types";
import { EmptyState } from "./EmptyState";
import { stagger } from "./styles";

interface Item { title: string; subtitle?: string; url?: string | null; image?: string | null }
interface Props { items?: Item[] }

export default function ListWidget({ props }: WidgetComponentProps<Props>) {
  const items = props.items ?? [];
  if (!items.length) return <EmptyState illustration="search" fallback={List} title="Nothing to show" subtitle="There's nothing in this list yet." />;
  return (
    <ul className="flex min-w-0 flex-col gap-0.5">
      {items.map((it, i) => {
        const body = (
          <div className="flex min-w-0 items-start gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {it.image && <img src={it.image} alt="" className="h-16 w-16 shrink-0 rounded-tile bg-tint object-cover" />}
            <div className="min-w-0 pt-0.5">
              <div className="text-body font-medium text-fg transition-colors duration-150 ease-standard group-hover:text-mint">{it.title}</div>
              {it.subtitle && <div className="mt-0.5 text-body-sm text-fg-2">{it.subtitle}</div>}
            </div>
          </div>
        );
        return (
          <motion.li key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={stagger(i)}>
            {it.url ? (
              <a
                href={it.url}
                target="_blank"
                rel="noopener noreferrer"
                className="group block rounded-tile px-3 py-2.5 transition-colors duration-150 ease-standard hover:bg-tint"
              >
                {body}
              </a>
            ) : (
              <div className="px-3 py-2.5">{body}</div>
            )}
          </motion.li>
        );
      })}
    </ul>
  );
}
