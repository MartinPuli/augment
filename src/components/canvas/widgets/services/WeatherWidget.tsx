"use client";
import type { WidgetComponentProps } from "../../types";
import { card, col, sub } from "./styles";

interface Day { date: string; condition: string | null; max_c: number | null; min_c: number | null; precip_prob_pct: number | null }
interface Props {
  place?: { name?: string };
  current?: { temperature_c?: number | null; feels_like_c?: number | null; condition?: string | null; wind_kmh?: number | null; humidity_pct?: number | null };
  daily?: Day[];
}

const r = (v: number | null | undefined) => (typeof v === "number" ? Math.round(v) : "–");

export default function WeatherWidget({ props }: WidgetComponentProps<Props>) {
  const c = props.current ?? {};
  return (
    <div style={col}>
      <div style={{ ...card, display: "flex", alignItems: "baseline", gap: 12 }}>
        <div style={{ fontSize: 40, fontWeight: 300, lineHeight: 1 }}>{r(c.temperature_c)}°</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>{c.condition ?? "—"}</div>
          <div style={sub}>
            {props.place?.name} · feels {r(c.feels_like_c)}° · wind {r(c.wind_kmh)} km/h · {r(c.humidity_pct)}% RH
          </div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))", gap: 6 }}>
        {(props.daily ?? []).map((d) => (
          <div key={d.date} style={{ ...card, padding: 8, textAlign: "center" }}>
            <div style={{ fontWeight: 600, fontSize: 12 }}>{new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" })}</div>
            <div style={{ ...sub, fontSize: 11, minHeight: 28 }}>{d.condition}</div>
            <div style={{ fontSize: 13 }}>
              {r(d.max_c)}° <span style={sub}>{r(d.min_c)}°</span>
            </div>
            {d.precip_prob_pct != null && <div style={{ ...sub, fontSize: 11 }}>{d.precip_prob_pct}% rain</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
