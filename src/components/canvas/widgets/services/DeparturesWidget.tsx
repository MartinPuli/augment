"use client";
import clsx from "clsx";
import { motion } from "motion/react";
import { TrainFront } from "lucide";
import type { WidgetComponentProps } from "../../types";
import { EmptyState } from "./EmptyState";
import { fmtTime, stagger } from "./styles";

interface Dep { destination: string; minutes: number; leaving?: boolean; platform?: string | null; cars?: number | null; hexcolor?: string | null; cancelled?: boolean }
interface Props { station?: string; departures?: Dep[]; updated_at?: string | null }

export default function DeparturesWidget({ props }: WidgetComponentProps<Props>) {
  const deps = (props.departures ?? []).slice(0, 12);
  const updated = props.updated_at ? <p className="px-3 text-caption tabular-nums text-fg-3">Updated {fmtTime(props.updated_at)} · BART</p> : null;

  if (!deps.length) {
    return (
      <div className="flex flex-col gap-2">
        <EmptyState
          illustration="transit"
          fallback={TrainFront}
          title="No departures listed"
          subtitle={props.station ? `Nothing is leaving ${props.station} right now.` : "Nothing is leaving right now."}
        />
        {updated}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex justify-between px-3 text-label font-medium text-fg-3" aria-hidden>
        <span>Destination</span>
        <span>Departs</span>
      </div>
      <ul className="flex flex-col gap-1">
        {deps.map((d, i) => {
          const detail = [d.platform ? `Platform ${d.platform}` : "", d.cars ? `${d.cars} cars` : ""].filter(Boolean).join(" · ");
          return (
            <motion.li
              key={i}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={stagger(i)}
              className={clsx("flex min-w-0 items-center gap-3 rounded-tile bg-surface-2 px-3 py-2.5", d.cancelled && "opacity-60")}
            >
              {/* line color comes from the transit data */}
              <span aria-hidden className={clsx("h-2.5 w-2.5 shrink-0 rounded-full", !d.hexcolor && "bg-fg-3")} style={d.hexcolor ? { background: d.hexcolor } : undefined} />
              <span className="min-w-0 flex-1">
                <span className={clsx("block truncate text-body font-medium text-fg", d.cancelled && "line-through")}>{d.destination}</span>
                {(detail || d.cancelled) && (
                  <span className="block truncate text-caption text-fg-3">
                    {d.cancelled && <span className="font-medium text-coral">Cancelled</span>}
                    {d.cancelled && detail ? " · " : ""}
                    {detail}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-right">
                {d.leaving ? (
                  <span className="font-serif text-heading text-mint">Now</span>
                ) : (
                  <>
                    <span className="font-serif text-heading tabular-nums text-fg">{d.minutes}</span>
                    <span className="ml-1 text-caption text-fg-3">min</span>
                  </>
                )}
              </span>
            </motion.li>
          );
        })}
      </ul>
      {updated}
    </div>
  );
}
