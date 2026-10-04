"use client";
import { motion } from "motion/react";
import { CalendarDays, MapPin } from "lucide";
import { Icon } from "@/components/ui/Icon";
import type { WidgetComponentProps } from "../../types";
import { EmptyState } from "./EmptyState";
import { fmtTime, stagger } from "./styles";

interface Ev { title: string; start: string; end?: string | null; all_day?: boolean; location?: string | null }
interface Props { events?: Ev[]; days?: number }

export default function AgendaWidget({ props }: WidgetComponentProps<Props>) {
  const groups = new Map<string, Ev[]>();
  for (const e of props.events ?? []) {
    const k = new Date(e.start).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  if (!groups.size) {
    return <EmptyState illustration="calendar" fallback={CalendarDays} title="Nothing scheduled" subtitle={`Your calendar is clear for the next ${props.days ?? "few"} days.`} />;
  }
  const list = [...groups];
  // running index across days, so the stagger continues from one day to the next
  const offsets = list.map((_, gi) => list.slice(0, gi).reduce((sum, [, evs]) => sum + evs.length, 0));
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {list.map(([day, evs], gi) => (
        <section key={day} className="flex flex-col gap-2">
          <h4 className="text-caption font-medium text-fg-3">{day}</h4>
          <ol className="flex flex-col">
            {evs.map((e, i) => {
              const end = !e.all_day && e.end ? fmtTime(e.end) : "";
              return (
                <motion.li
                  key={i}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={stagger(offsets[gi] + i)}
                  className="group/ev grid grid-cols-[4.75rem_minmax(0,1fr)] gap-3"
                >
                  <div className="pt-px text-right">
                    <span className="block text-body-sm tabular-nums text-fg-2">{e.all_day ? "All day" : fmtTime(e.start)}</span>
                    {end && <span className="block text-caption tabular-nums text-fg-3">{end}</span>}
                  </div>
                  <div className="relative min-w-0 border-l border-line pb-4 pl-4 group-last/ev:pb-0">
                    <span aria-hidden className="absolute -left-[5px] top-1.5 h-[9px] w-[9px] rounded-full border-2 border-fg-3 bg-page" />
                    <p className="font-serif text-body text-fg">{e.title}</p>
                    {e.location && (
                      <p className="mt-0.5 flex min-w-0 items-center gap-1 text-caption text-fg-3">
                        <Icon icon={MapPin} size={12} className="shrink-0" />
                        <span className="truncate">{e.location}</span>
                      </p>
                    )}
                  </div>
                </motion.li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
