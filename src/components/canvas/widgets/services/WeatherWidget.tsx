"use client";
import { motion } from "motion/react";
import { CloudSun, Sun } from "lucide";
import { Illustration } from "@/components/ui/Illustration";
import type { WidgetComponentProps } from "../../types";
import { EmptyState } from "./EmptyState";
import { stagger } from "./styles";

interface Day { date: string; condition: string | null; max_c: number | null; min_c: number | null; precip_prob_pct: number | null }
interface Props {
  place?: { name?: string };
  current?: { temperature_c?: number | null; feels_like_c?: number | null; condition?: string | null; wind_kmh?: number | null; humidity_pct?: number | null };
  daily?: Day[];
}

const r = (v: number | null | undefined) => (typeof v === "number" ? Math.round(v) : "–");

export default function WeatherWidget({ props }: WidgetComponentProps<Props>) {
  const c = props.current ?? {};
  const daily = props.daily ?? [];
  const hasCurrent = typeof c.temperature_c === "number" || !!c.condition;

  if (!hasCurrent && !daily.length) {
    return (
      <EmptyState
        illustration="weather"
        fallback={CloudSun}
        title="No forecast"
        subtitle={`Weather for ${props.place?.name ?? "this place"} isn't available right now.`}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {hasCurrent && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-4">
            <div className="flex shrink-0 items-start gap-1.5">
              <span className="font-display text-display tabular-nums text-fg">{r(c.temperature_c)}°</span>
              <Illustration name="weather" size={40} fallback={Sun} className="mt-1" />
            </div>
            <div className="min-w-0">
              <p className="font-serif text-heading text-fg">{c.condition ?? "—"}</p>
              {props.place?.name && <p className="truncate text-body-sm text-fg-3">{props.place.name}</p>}
            </div>
          </div>
          <dl className="flex flex-wrap gap-x-4 gap-y-1 text-body-sm">
            <div className="flex gap-1.5">
              <dt className="text-fg-3">Feels like</dt>
              <dd className="tabular-nums text-fg">{r(c.feels_like_c)}°</dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-fg-3">Wind</dt>
              <dd className="tabular-nums text-fg">{r(c.wind_kmh)} km/h</dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-fg-3">Humidity</dt>
              <dd className="tabular-nums text-fg">{r(c.humidity_pct)}%</dd>
            </div>
          </dl>
        </div>
      )}
      {daily.length > 0 && (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-2">
          {daily.map((d, i) => (
            <motion.li
              key={d.date}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={stagger(i)}
              className="flex min-w-0 flex-col items-center gap-1 rounded-tile bg-surface-2 px-2 py-3 text-center"
            >
              <span className="text-caption font-medium text-fg-2">{new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" })}</span>
              <span className="line-clamp-2 min-h-[2.4em] text-label text-fg-3">{d.condition}</span>
              <span className="font-serif text-body tabular-nums">
                <span className="text-fg">{r(d.max_c)}°</span> <span className="text-fg-3">{r(d.min_c)}°</span>
              </span>
              {d.precip_prob_pct != null && <span className="text-label tabular-nums text-fg-3">{d.precip_prob_pct}% rain</span>}
            </motion.li>
          ))}
        </ul>
      )}
    </div>
  );
}
