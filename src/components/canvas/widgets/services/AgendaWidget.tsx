"use client";
import type { WidgetComponentProps } from "../../types";
import { card, col, fmtTime, sub } from "./styles";

interface Ev { title: string; start: string; end?: string | null; all_day?: boolean; location?: string | null }
interface Props { events?: Ev[]; days?: number }

export default function AgendaWidget({ props }: WidgetComponentProps<Props>) {
  const groups = new Map<string, Ev[]>();
  for (const e of props.events ?? []) {
    const k = new Date(e.start).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  return (
    <div style={col}>
      {[...groups].map(([day, evs]) => (
        <div key={day} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ ...sub, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 }}>{day}</div>
          {evs.map((e, i) => (
            <div key={i} style={{ ...card, display: "flex", gap: 10 }}>
              <div style={{ ...sub, width: 64, flexShrink: 0 }}>{e.all_day ? "All day" : fmtTime(e.start)}</div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{e.title}</div>
                {e.location && <div style={sub}>{e.location}</div>}
              </div>
            </div>
          ))}
        </div>
      ))}
      {!groups.size && <div style={sub}>Nothing scheduled in the next {props.days ?? "few"} days.</div>}
    </div>
  );
}
